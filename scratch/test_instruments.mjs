import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import '../src/parts/library.js';
import '../src/mcu/boards.js';
import { Circuit, Board, Part, Wire } from '../src/model.js';
import { Engine } from '../src/sim/engine.js';
import { getDef } from '../src/parts/registry.js';
import { Editor } from '../src/editor.js';

function approx(a, b, tol, msg) {
  assert.ok(Math.abs(a - b) <= tol, `${msg}: expected ${b} ± ${tol}, got ${a}`);
}

function makeMockCtx() {
  return {
    save() {}, restore() {}, translate() {}, rotate() {}, scale() {},
    beginPath() {}, roundRect() {}, fill() {}, stroke() {}, moveTo() {}, lineTo() {},
    arc() {}, closePath() {}, fillRect() {}, strokeRect() {}, fillText() {}, drawImage() {},
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    set lineCap(v) {}, set lineJoin(v) {}, set lineWidth(v) {}, set fillStyle(v) {},
    set strokeStyle(v) {}, set shadowColor(v) {}, set shadowBlur(v) {}, set shadowOffsetY(v) {},
    set font(v) {}, set textAlign(v) {}, set textBaseline(v) {},
  };
}

// ---------------------------------------------------------------------------
// 1. Regulated DC Power Supply (MATRIX MPS-3005L-3)
// ---------------------------------------------------------------------------
{
  console.log('=== Testing Regulated Power Supply (power-supply / MPS-3005L-3) ===');
  const def = getDef('power-supply');

  // 1a. Independent mode + 5V fixed + GND
  const c = new Circuit();
  const psu = new Part('power-supply', 0, 0, 0, { power: true, mode: 'indep', v1: 5, i1: 2, v2: 12, i2: 2 });
  const rM = new Part('resistor', 25, 0, 0, { ohms: 100, watts: 5 });
  const rS = new Part('resistor', 25, 4, 0, { ohms: 100, watts: 5 });
  const rF = new Part('resistor', 25, 8, 0, { ohms: 200, watts: 5 });
  c.parts.push(psu, rM, rS, rF);

  const pp = psu.worldPins(); // 0:S-, 1:SGND, 2:S+, 3:M-, 4:MGND, 5:M+, 6:F-, 7:F+
  const rMp = rM.worldPins(), rSp = rS.worldPins(), rFp = rF.worldPins();
  c.wires.push(
    new Wire(pp[5], rMp[0]), new Wire(pp[3], rMp[1]),
    new Wire(pp[2], rSp[0]), new Wire(pp[0], rSp[1]),
    new Wire(pp[7], rFp[0]), new Wire(pp[6], rFp[1]),
  );

  const eng = new Engine();
  eng.build(c);
  assert.equal(eng.timeDependent, false, 'DC bench supply should not force time-dependent stepping');
  eng.step(0.01);
  assert.equal(eng.converged, true);

  const d = eng.byPart.get(psu.id).device;
  approx(d.measV1, 5.0, 0.05, 'Master CV voltage');
  approx(d.measI1, 0.05, 0.005, 'Master load current (5V/100R)');
  approx(d.measV2, 12.0, 0.05, 'Slave CV voltage');
  approx(d.measI2, 0.12, 0.005, 'Slave load current (12V/100R)');
  approx(d.measV3, 5.0, 0.05, 'Fixed 5V output');
  approx(d.measI3, 0.025, 0.005, 'Fixed 5V load current');
  assert.equal(d.cc1, false);
  assert.equal(d.cc2, false);
  assert.equal(d.overload5, false);

  // 1b. Constant Current (C.C.) limit on Master (10V set, 0.5A limit across 4R load -> 2.0V, 0.5A)
  psu.props.v1 = 10;
  psu.props.i1 = 0.5;
  rM.props.ohms = 4;
  eng.step(0.01);
  assert.equal(eng.converged, true);
  assert.equal(d.cc1, true, 'Master enters CC mode when I > 0.5A');
  approx(d.measI1, 0.5, 0.02, 'Master current clamped to 0.5 A');
  approx(d.measV1, 2.0, 0.08, 'Master terminal voltage drops to I*R = 2.0 V');

  // 1c. Restore Master load (100R -> back to CV), test 5V fixed overload (> 3A)
  rM.props.ohms = 100;
  psu.props.v1 = 12;
  psu.props.i1 = 2;
  rF.props.ohms = 1; // 5V / 1R = 5A > 3A fixed limit
  eng.step(0.01);
  assert.equal(d.cc1, false, 'Master exits CC mode when load reduces');
  approx(d.measV1, 12.0, 0.05, 'Master restores 12V');
  assert.equal(d.overload5, true, 'Fixed 5V reports overload above 3A');
  assert.ok(d.warning && d.warning.includes('5V FIXED'), 'Emits 5V fixed overload warning');

  // 1d. Series Tracking mode (Master 12V + Slave 12V = 24V across MASTER+ to SLAVE-)
  const cs = new Circuit();
  const psuS = new Part('power-supply', 0, 0, 0, { power: true, mode: 'series', v1: 12, i1: 2, v2: 3 });
  const rSer = new Part('resistor', 25, 0, 0, { ohms: 100, watts: 10 });
  cs.parts.push(psuS, rSer);
  const psPins = psuS.worldPins(), rsPins = rSer.worldPins();
  cs.wires.push(new Wire(psPins[5], rsPins[0]), new Wire(psPins[0], rsPins[1])); // MASTER+ to SLAVE-
  const engS = new Engine();
  engS.build(cs);
  engS.step(0.01);
  assert.equal(engS.converged, true);
  const vTotal = engS.voltage(engS.netAt(psPins[5].x, psPins[5].y)) - engS.voltage(engS.netAt(psPins[0].x, psPins[0].y));
  approx(vTotal, 24.0, 0.15, 'Series tracking outputs 2 × Master = 24 V across MASTER+ and SLAVE-');

  // 1e. Parallel Tracking mode (doubles current limit: i1=1A -> 2A limit; 3R load demands 1.67A @ 5V -> no CC; 1R demands 5A -> clamps at 2A)
  const cp = new Circuit();
  const psuP = new Part('power-supply', 0, 0, 0, { power: true, mode: 'parallel', v1: 5, i1: 1 });
  const rPar = new Part('resistor', 25, 0, 0, { ohms: 3, watts: 20 });
  cp.parts.push(psuP, rPar);
  const ppP = psuP.worldPins(), rpP = rPar.worldPins();
  cp.wires.push(new Wire(ppP[5], rpP[0]), new Wire(ppP[3], rpP[1]));
  const engP = new Engine();
  engP.build(cp);
  engP.step(0.01);
  const dP = engP.byPart.get(psuP.id).device;
  assert.equal(dP.cc1, false, 'Parallel mode allows 1.67A with 2×1A = 2A limit');
  approx(dP.measV1, 5.0, 0.15, 'Parallel output stays regulated at 5V');
  rPar.props.ohms = 1;
  engP.step(0.01);
  assert.equal(dP.cc1, true, 'Parallel mode clamps above 2×1A = 2A');
  approx(dP.measV1, 2.0, 0.1, 'Parallel 2A across 1R = 2.0V');

  // 1f. Front-panel controls & draw
  assert.equal(def.control(psu, { x: 0.9, y: -1.6 }), 'inst:power');
  def.click(psu, 'inst:power');
  assert.equal(psu.props.power, false);
  eng.step(0.01);
  approx(d.measV1, 0, 0.05, 'Outputs drop to 0V when power switch is OFF');
  def.click(psu, 'inst:power');
  assert.equal(def.click(psu, 'inst:mode'), true);
  assert.equal(psu.props.mode, 'series');
  const ctx = makeMockCtx();
  for (let rot = 0; rot < 4; rot++) def.draw(ctx, psu, { rot, dev: d, dark: rot % 2 === 1 });
  console.log('[PASS] Regulated Power Supply tests passed.');
}

// ---------------------------------------------------------------------------
// 2. Signal / Function Generator (ESCORT EGC-3235A)
// ---------------------------------------------------------------------------
{
  console.log('=== Testing Signal Generator (funcgen / EGC-3235A) ===');
  const def = getDef('funcgen');

  // Unwired check -> timeDependent === false
  const cu = new Circuit();
  const fgU = new Part('funcgen', 0, 0, 0);
  cu.parts.push(fgU);
  const engU = new Engine();
  engU.build(cu);
  assert.equal(engU.timeDependent, false, 'Unwired function generator must not spin the solver');

  // Wired Sine, Triangle, Square, Offset, -20dB, Duty, Sync Out
  const c = new Circuit();
  const fg = new Part('funcgen', 0, 0, 0, { power: true, wave: 'sine', hz: 10, vpp: 10 });
  const rOut = new Part('resistor', 20, 0, 0, { ohms: 10000, watts: 1 });
  const rSync = new Part('resistor', 20, 4, 0, { ohms: 10000, watts: 1 });
  c.parts.push(fg, rOut, rSync);
  const fp = fg.worldPins(); // 0:EXT, 1:SYNC OUT, 2:SYNC GND, 3:SWEEP, 4:OUT+, 5:OUT-
  const rop = rOut.worldPins(), rsp = rSync.worldPins();
  c.wires.push(
    new Wire(fp[4], rop[0]), new Wire(fp[5], rop[1]),
    new Wire(fp[1], rsp[0]), new Wire(fp[2], rsp[1]),
  );

  const eng = new Engine();
  eng.build(c);
  assert.equal(eng.timeDependent, true, 'Wired function generator sets timeDependent = true');

  const outDiff = () => eng.voltage(eng.netAt(fp[4].x, fp[4].y)) - eng.voltage(eng.netAt(fp[5].x, fp[5].y));
  const syncDiff = () => eng.voltage(eng.netAt(fp[1].x, fp[1].y)) - eng.voltage(eng.netAt(fp[2].x, fp[2].y));

  // Sine 10Hz 10Vpp -> T = 0.1s; quarter period t=0.025s -> +5V, three-quarter t=0.075s -> -5V
  eng.time = 0.025; eng.step(0.001);
  approx(outDiff(), 5.0, 0.1, 'Sine +peak at 1/4 period');
  approx(syncDiff(), 5.0, 0.1, 'TTL SYNC HIGH during first half period');
  eng.time = 0.075; eng.step(0.001);
  approx(outDiff(), -5.0, 0.1, 'Sine -peak at 3/4 period');
  approx(syncDiff(), 0.0, 0.1, 'TTL SYNC LOW during second half period');

  // Triangle 10Hz 10Vpp -> t=0.025s -> +5V, t=0.05s -> 0V, t=0.075s -> -5V
  fg.props.wave = 'tri';
  eng.time = 0.025; eng.step(0.001);
  approx(outDiff(), 5.0, 0.1, 'Triangle +peak');
  eng.time = 0.05; eng.step(0.001);
  approx(outDiff(), 0.0, 0.1, 'Triangle zero crossing');
  eng.time = 0.075; eng.step(0.001);
  approx(outDiff(), -5.0, 0.1, 'Triangle -peak');

  // Square with 25% Symmetry, +2.5V Offset, and -20dB Attenuation (10Vpp -> 1Vpp = ±0.5V + 2.5V -> +3.0V / +2.0V)
  fg.props.wave = 'square';
  fg.props.symOn = true; fg.props.duty = 25;
  fg.props.offsetOn = true; fg.props.offset = 2.5;
  fg.props.att20dB = true;
  eng.time = 0.015; eng.step(0.001); // phi = 0.15 < 0.25 -> HIGH -> +0.5 + 2.5 = 3.0V
  approx(outDiff(), 3.0, 0.08, 'Square HIGH with -20dB and +2.5V DC offset');
  eng.time = 0.035; eng.step(0.001); // phi = 0.35 > 0.25 -> LOW -> -0.5 + 2.5 = 2.0V
  approx(outDiff(), 2.0, 0.08, 'Square LOW at 25% duty with -20dB and +2.5V offset');

  // Interactive click controls & draw
  assert.equal(def.control(fg, { x: 9.2, y: -2.75 }), 'inst:wave:sine');
  def.click(fg, 'inst:wave:sine');
  assert.equal(fg.props.wave, 'sine');
  def.click(fg, 'inst:att20');
  assert.equal(fg.props.att20dB, false);
  const ctx = makeMockCtx();
  const fgDev = eng.byPart.get(fg.id).device;
  for (let rot = 0; rot < 4; rot++) def.draw(ctx, fg, { rot, dev: fgDev, dark: rot % 2 === 1 });
  console.log('[PASS] Signal Generator tests passed.');
}

// ---------------------------------------------------------------------------
// 3. Oscilloscope (UNI-T UT2062B) + End-to-End Integration
// ---------------------------------------------------------------------------
{
  console.log('=== Testing Oscilloscope (oscilloscope / UT2062B) ===');
  const def = getDef('oscilloscope');

  // Unwired Probe Comp check -> timeDependent === false
  const cu = new Circuit();
  const scopeU = new Part('oscilloscope', 0, 0, 0);
  cu.parts.push(scopeU);
  const engU = new Engine();
  engU.build(cu);
  assert.equal(engU.timeDependent, false, 'Oscilloscope with unwired Probe Comp must stay idle');

  // Connect Signal Generator (10Hz, 10Vpp Sine) -> Scope CH1, and Scope COMP 1kHz -> CH2!
  const c = new Circuit();
  const fg = new Part('funcgen', 0, -15, 0, { power: true, wave: 'sine', hz: 10, vpp: 10 });
  const scope = new Part('oscilloscope', 0, 0, 0, { run: true, ch1On: true, ch2On: true, ch1Scale: 2, ch2Scale: 1, timeDiv: 0.05 });
  c.parts.push(fg, scope);
  const fp = fg.worldPins(), sp = scope.worldPins(); // sp: 0:CH1+, 1:CH1G, 2:CH2+, 3:CH2G, 4:EXT, 5:EXTG, 6:COMP, 7:COMPG
  c.wires.push(
    new Wire(fp[4], sp[0]), new Wire(fp[5], sp[1]), // OUT -> CH1
    new Wire(sp[6], sp[2]), // COMP 1kHz -> CH2
  );

  const eng = new Engine();
  eng.build(c);
  assert.equal(eng.timeDependent, true);

  // Step 0.7 seconds at 0.5ms steps so full 0.5s triggered window has complete samples
  for (let i = 0; i < 1400; i++) eng.step(0.0005);

  const sd = eng.byPart.get(scope.id).device;
  const { s1 } = sd.measure();
  assert.equal(s1.valid, true, 'CH1 stats valid');
  approx(s1.vpp, 10.0, 0.3, 'Oscilloscope CH1 measures 10 Vpp sine accurately');
  approx(s1.vavg, 0.0, 0.25, 'Oscilloscope CH1 measures 0 V DC average');
  approx(s1.freq, 10.0, 0.5, 'Oscilloscope CH1 measures 10 Hz frequency');

  // Test RUN/STOP hold
  const countBeforeStop = sd.count;
  const headBeforeStop = sd.head;
  def.click(scope, 'inst:run');
  assert.equal(scope.props.run, false);
  for (let i = 0; i < 20; i++) eng.step(0.0005);
  assert.equal(sd.head, headBeforeStop, 'STOP freezes capture buffer head');
  assert.equal(sd.count, countBeforeStop, 'STOP preserves sample count');
  def.click(scope, 'inst:run');

  // Test Probe Comp CH2 measurement at fast timebase (200 us steps -> 1 kHz wave)
  scope.props.timeDiv = 0.0005; // 5 ms span = 5 cycles of 1 kHz
  for (let i = 0; i < 150; i++) eng.step(0.0001);
  const mFast = sd.measure();
  approx(mFast.s2.vpp, 3.0, 0.2, 'Probe Comp output measures ~3 Vpp on CH2');
  approx(mFast.s2.freq, 1000, 100, 'Probe Comp measures ~1 kHz on CH2');

  // Test AUTO control back on 10Hz CH1
  scope.props.ch1Scale = 10;
  scope.props.timeDiv = 0.5;
  assert.equal(def.control(scope, { x: 23.1, y: -7.45 }), 'inst:auto');
  def.click(scope, 'inst:auto');
  assert.equal(scope.props.ch1Scale, 2, 'AUTO picks 2 V/div for 10 Vpp waveform');

  // Test draw() across rotations + X-Y + Math + AC coupling
  const ctx = makeMockCtx();
  for (const mode of [{ xyMode: false, math: 'off', coupling: 'DC' }, { xyMode: true, math: 'off', coupling: 'DC' }, { xyMode: false, math: 'sub', coupling: 'AC' }]) {
    Object.assign(scope.props, mode);
    for (let rot = 0; rot < 4; rot++) def.draw(ctx, scope, { rot, dev: sd, dark: rot % 2 === 1 });
  }

  // Test combinational circuit with Trainer Board + 7408 + Power Supply + unwired Scope/FuncGen -> timeDependent === false!
  const cCombo = new Circuit();
  cCombo.boards.push(new Board('half', 0, 2));
  const tr = new Part('trainer-board', 0, 0, 0);
  const scIdle = new Part('oscilloscope', 0, 25, 0);
  const fgIdle = new Part('funcgen', 26, 25, 0);
  const psuPower = new Part('power-supply', 18, 25, 0, { power: true, v1: 5 });
  const ic = new Part('ic7408', 5, 12, 0);
  const rLed = new Part('resistor', 35, 12, 0, { ohms: 220 });
  const led = new Part('led', 41, 12, 0, { protect: 'off' });
  cCombo.parts.push(tr, scIdle, fgIdle, psuPower, ic, rLed, led);
  const trP = tr.worldPins(), icP = ic.worldPins(), psuPins = psuPower.worldPins();
  const rLP = rLed.worldPins(), lP = led.worldPins();
  const colPin = (n) => trP.find(q => q.name === n);
  cCombo.wires.push(
    new Wire(psuPins[5], icP[13]), // MASTER 5V -> 7408 VCC
    new Wire(psuPins[3], icP[6]),  // MASTER - -> 7408 GND
    new Wire(colPin('S0'), icP[0]),
    new Wire(colPin('S1'), icP[1]),
    new Wire(icP[2], rLP[0]),
    new Wire(rLP[1], lP[0]),
    new Wire(lP[1], psuPins[3]),
  );
  const engCombo = new Engine();
  engCombo.build(cCombo);
  assert.equal(engCombo.timeDependent, false, 'Combinational circuit with idle instruments stays non-time-dependent (zero slow-mo)');
  tr.props.bits[0] = true; tr.props.bits[1] = true;
  engCombo.step(0.016);
  assert.ok(engCombo.voltage(engCombo.netAt(icP[2].x, icP[2].y)) > 4.5, '7408 AND powered by MPS-3005L-3 outputs HIGH');
  assert.ok(engCombo.byPart.get(led.id).device.cur[0] * 1000 > 10, 'LED returned into MPS-3005L-3 minus terminal lights up cleanly');

  console.log('[PASS] Oscilloscope & Integration tests passed.');
}

// ---------------------------------------------------------------------------
// 4. Lab Integration: MPS-3005L-3 + EGC-3235A + 7493 Counter + UT2062B Scope
// ---------------------------------------------------------------------------
{
  console.log('=== Testing Benchtop Lab Counter Integration (PSU + FuncGen + 7493 + Scope) ===');
  const cLab = new Circuit();
  const psu = new Part('power-supply', 0, 25, 0, { power: true, mode: 'indep', v1: 5 });
  const fg = new Part('funcgen', 20, 25, 0, { power: true, wave: 'square', hz: 10, vpp: 5 });
  const scope = new Part('oscilloscope', 0, 0, 0, { run: true, ch1On: true, ch2On: true, timeDiv: 0.1 });
  const ic93 = new Part('ic7493', 42, 12, 0);
  cLab.parts.push(psu, fg, scope, ic93);

  const pp = psu.worldPins();   // 6:F-, 7:F+
  const fp = fg.worldPins();    // 1:SYNC OUT, 2:SYNC GND
  const sp = scope.worldPins(); // 0:CH1+, 1:CH1G, 2:CH2+
  const q = ic93.worldPins();   // 0:CKB, 1:RO1, 2:RO2, 4:VCC, 7:QC, 8:QB, 9:GND, 10:QD, 11:QA, 13:CKA

  cLab.wires.push(
    new Wire(pp[7], q[4]), new Wire(pp[6], q[9]),      // PSU 5V FIXED -> 7493 VCC/GND
    new Wire(fp[2], pp[6]),                            // Common ground
    new Wire(fp[1], q[13]),                            // EGC-3235A SYNC OUT (10Hz) -> 7493 CKA
    new Wire(q[11], q[0]),                             // QA -> CKB (4-bit ripple counter)
    new Wire(q[1], pp[6]), new Wire(q[2], pp[6]),      // RO1=RO2=GND
    new Wire(fp[1], sp[0]), new Wire(pp[6], sp[1]),    // CH1 probes 10Hz clock
    new Wire(q[11], sp[2]),                            // CH2 probes QA (5Hz ÷2 output)
  );

  const eng = new Engine();
  eng.build(cLab);
  const seen = new Set();
  for (let i = 0; i < 600; i++) {
    eng.step(0.005); // 3.0 seconds total
    const bit = (n) => (eng.voltage(eng.netAt(q[n].x, q[n].y)) > 2 ? 1 : 0);
    seen.add((bit(10) << 3) | (bit(7) << 2) | (bit(8) << 1) | bit(11));
  }
  assert.equal(seen.size, 16, `7493 powered by MPS-3005L-3 & clocked by EGC-3235A visited all 16 states (got ${seen.size})`);
  const sd = eng.byPart.get(scope.id).device;
  const { s1, s2 } = sd.measure();
  approx(s1.freq, 10.0, 0.8, 'UT2062B CH1 measures 10 Hz clock');
  approx(s2.freq, 5.0, 0.5, 'UT2062B CH2 measures 7493 QA ÷2 = 5 Hz');
  console.log('[PASS] Benchtop Lab Counter Integration passed (all 16 states + CH1=10Hz / CH2=5Hz).');
}

// ---------------------------------------------------------------------------
// 5. Analog Bench Tasks: Bipolar ±12V Supply, Diode Rectifier, 1kHz RC LPF
// ---------------------------------------------------------------------------
{
  console.log('=== Testing Analog & Bench Tasks (±12V Bipolar, Rectifier, 1kHz RC Filter, Controls) ===');

  // 5a. Control hit-testing for draggable knobs & PANEL ↗ button
  const psuDef = getDef('power-supply'), fgDef = getDef('funcgen'), scDef = getDef('oscilloscope');
  const p0 = new Part('power-supply', 0, 0, 0);
  const f0 = new Part('funcgen', 0, 0, 0);
  const s0 = new Part('oscilloscope', 0, 0, 0);
  assert.equal(psuDef.control(p0, { x: 14.9, y: -3.7 }), 'knob:v1:0:30');
  assert.equal(psuDef.control(p0, { x: 16.8, y: -9.0 }), 'inst:panel');
  assert.equal(fgDef.control(f0, { x: 3.7, y: -2.55 }), 'knob:hz:0.5:10000:log');
  assert.equal(fgDef.control(f0, { x: 13.5, y: -7.0 }), 'inst:panel');
  assert.equal(scDef.control(s0, { x: 16.9, y: -3.2 }), 'knob:ch1Scale:0:6:vdiv');
  assert.equal(scDef.control(s0, { x: 19.9, y: -3.2 }), 'knob:timeDiv:0:9:tdiv');
  assert.equal(scDef.control(s0, { x: 22.8, y: -10.15 }), 'inst:panel');

  // 5b. Bipolar ±12V split-rail supply (SLAVE+ tied to MASTER- and GND)
  const cb = new Circuit();
  const psuB = new Part('power-supply', 0, 0, 0, { power: true, mode: 'indep', v1: 12, v2: 12 });
  const rPos = new Part('resistor', 25, 0, 0, { ohms: 1000, watts: 2 });
  const rNeg = new Part('resistor', 25, 4, 0, { ohms: 1000, watts: 2 });
  cb.parts.push(psuB, rPos, rNeg);
  const bp = psuB.worldPins(), rp = rPos.worldPins(), rn = rNeg.worldPins();
  cb.wires.push(
    new Wire(bp[2], bp[1]), // SLAVE+ -> GND (0V)
    new Wire(bp[3], bp[1]), // MASTER- -> GND (0V)
    new Wire(bp[5], rp[0]), new Wire(bp[1], rp[1]), // +12V -> rPos -> GND
    new Wire(bp[0], rn[0]), new Wire(bp[1], rn[1]), // -12V -> rNeg -> GND
  );
  const engB = new Engine();
  engB.build(cb);
  engB.step(0.01);
  assert.equal(engB.converged, true);
  approx(engB.voltage(engB.netAt(bp[5].x, bp[5].y)), 12.0, 0.08, 'Bipolar positive rail = +12 V');
  approx(engB.voltage(engB.netAt(bp[0].x, bp[0].y)), -12.0, 0.08, 'Bipolar negative rail = -12 V');

  // 5c. Half-wave diode rectifier (EGC-3235A 50Hz 10Vpp Sine -> Diode -> 1kR -> Scope)
  const cr = new Circuit();
  const fgR = new Part('funcgen', 0, 20, 0, { power: true, wave: 'sine', hz: 50, vpp: 10 });
  const dio = new Part('diode', 20, 20, 0);
  const rLoad = new Part('resistor', 30, 20, 0, { ohms: 1000 });
  const scR = new Part('oscilloscope', 0, 0, 0, { run: true, timeDiv: 0.005 });
  cr.parts.push(fgR, dio, rLoad, scR);
  const fpR = fgR.worldPins(), dp = dio.worldPins(), rlp = rLoad.worldPins(), spR = scR.worldPins();
  cr.wires.push(
    new Wire(fpR[4], dp[0]), new Wire(dp[1], rlp[0]), new Wire(rlp[1], fpR[5]),
    new Wire(fpR[4], spR[0]), new Wire(fpR[5], spR[1]),
    new Wire(rlp[0], spR[2]),
  );
  const engR = new Engine();
  engR.build(cr);
  for (let i = 0; i < 400; i++) engR.step(0.0005); // 200ms (10 cycles at 50Hz)
  const sr = engR.byPart.get(scR.id).device.measure();
  approx(sr.s1.vpp, 10.0, 0.3, 'Rectifier AC input CH1 = 10 Vpp');
  assert.ok(sr.s2.max > 4.0 && sr.s2.min >= -0.05 && sr.s2.vavg > 1.0, `Rectified half-wave output min=${sr.s2.min.toFixed(2)}, max=${sr.s2.max.toFixed(2)}`);

  // 5d. 1 kHz RC Low-Pass Filter (EGC-3235A 1kHz 10Vpp -> 1kR + 100nF -> fc ≈ 1591Hz -> Vpp ≈ 8.4V)
  const crc = new Circuit();
  const fgL = new Part('funcgen', 0, 20, 0, { power: true, wave: 'sine', hz: 1000, vpp: 10 });
  const rL = new Part('resistor', 20, 20, 0, { ohms: 1000 });
  const cL = new Part('capacitor', 30, 20, 0, { uf: 0.1 });
  const scL = new Part('oscilloscope', 0, 0, 0, { run: true, timeDiv: 0.0005 });
  crc.parts.push(fgL, rL, cL, scL);
  const fpL = fgL.worldPins(), rLp = rL.worldPins(), cLp = cL.worldPins(), spL = scL.worldPins();
  crc.wires.push(
    new Wire(fpL[4], rLp[0]), new Wire(rLp[1], cLp[0]), new Wire(cLp[1], fpL[5]),
    new Wire(fpL[4], spL[0]), new Wire(fpL[5], spL[1]),
    new Wire(cLp[0], spL[2]),
  );
  const engL = new Engine();
  engL.build(crc);
  engL.step(0.0001);
  const dtL = engL.suggestDt();
  assert.ok(dtL <= 2.6e-5, `1kHz FuncGen resolves >= 38 samples/cycle (dt=${dtL})`);
  for (let i = 0; i < 400; i++) engL.step(dtL); // 10ms = 10 cycles of 1kHz
  const sl = engL.byPart.get(scL.id).device.measure();
  approx(sl.s1.freq, 1000, 80, '1kHz Sine measured on UT2062B CH1');
  approx(sl.s2.vpp, 8.2, 0.8, '1kHz RC filter output amplitude matches theoretical attenuation');
  console.log('[PASS] Analog & Bench tests passed (±12V, Diode Rectifier, 1kHz RC Filter, Knobs).');
}

// ---------------------------------------------------------------------------
// 6. All 12 Lab Handout Circuits Powered / Clocked / Probed by New Instruments
// ---------------------------------------------------------------------------
{
  console.log('=== Testing All 12 Lab Handout Circuits via MPS-3005L-3 + EGC-3235A + UT2062B ===');
  const labDir = path.resolve(import.meta.dirname, '..', 'Lab Handouts', 'circuits');
  const files = fs.readdirSync(labDir).filter(f => f.endsWith('.json')).sort();
  assert.equal(files.length, 12, 'Should find all 12 Lab circuits');

  for (const file of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(labDir, file), 'utf8'));
    const c = Circuit.fromJSON(raw);

    // Replace +5V (`vcc`), Ground (`gnd`), and any discrete `clock` with bench instruments
    const vccNodes = [], gndNodes = [], clkNodes = [];
    let clkHz = 5;
    c.parts = c.parts.filter(p => {
      if (p.type === 'vcc') { vccNodes.push({ x: p.x, y: p.y }); return false; }
      if (p.type === 'gnd') { gndNodes.push({ x: p.x, y: p.y }); return false; }
      if (p.type === 'clock') { clkHz = p.props.hz || 5; clkNodes.push({ x: p.x, y: p.y }); return false; }
      return true;
    });

    const psu = new Part('power-supply', -30, 0, 0, { power: true, mode: 'indep', v1: 5, i1: 2 });
    const fg = new Part('funcgen', -30, 15, 0, { power: true, wave: 'square', hz: clkHz, vpp: 5 });
    const sc = new Part('oscilloscope', -30, -15, 0, { run: true, timeDiv: 0.05 });
    c.parts.push(psu, fg, sc);

    const pp = psu.worldPins(), fp = fg.worldPins(), sp = sc.worldPins();
    for (const n of vccNodes) c.wires.push(new Wire(pp[5], n));
    for (const n of gndNodes) c.wires.push(new Wire(pp[3], n));
    if (clkNodes.length) {
      c.wires.push(new Wire(fp[2], pp[3]));
      for (const n of clkNodes) c.wires.push(new Wire(fp[1], n));
      c.wires.push(new Wire(clkNodes[0], sp[0]), new Wire(pp[3], sp[1]));
    } else if (file.includes('Lab5_Task1')) {
      sc.props.timeDiv = 0.2; // 2.0s span covers ~2 full ~1Hz astable cycles
      const t555 = c.parts.find(pt => pt.type === 'ne555');
      const tp = t555.worldPins(); // 1:TRIG (cap), 2:OUT
      c.wires.push(new Wire(tp[1], sp[0]), new Wire(pp[3], sp[1]), new Wire(tp[2], sp[2]));
    } else {
      // Probe first IC or output node on UT2062B CH1
      const probeTarget = c.parts.find(pt => pt.type.startsWith('ic') || pt.type === 'ne555');
      if (probeTarget) c.wires.push(new Wire(probeTarget.worldPins()[2] || pp[5], sp[0]), new Wire(pp[3], sp[1]));
    }

    const eng = new Engine();
    eng.build(c);
    const hasOsc = file.includes('Lab5');
    const nSteps = hasOsc ? 600 : 10;
    const stepDt = hasOsc ? 0.005 : 0.016;
    const dPsu = eng.byPart.get(psu.id).device;
    const dSc = eng.byPart.get(sc.id).device;
    let maxI1 = 0;
    for (let i = 0; i < nSteps; i++) {
      eng.step(stepDt);
      assert.equal(eng.converged, true, `${file} step ${i} must converge cleanly`);
      if (dPsu.measI1 > maxI1) maxI1 = dPsu.measI1;
    }
    approx(dPsu.measV1, 5.0, 0.1, `${file} PSU supplies stable 5.0V`);
    assert.ok(maxI1 >= 0.0003, `${file} shows live supply current on MPS-3005L-3 (${(maxI1 * 1000).toFixed(2)} mA)`);
    assert.equal(dPsu.warning, null, `${file} produces zero PSU warnings`);
    assert.ok(dSc.count >= nSteps, `${file} captured ${dSc.count} scope samples`);
    if (file.includes('Lab5_Task1')) {
      const m555 = dSc.measure();
      approx(m555.s1.vpp, 1.67, 0.25, 'NE555 capacitor ramp Vpp = 1/3..2/3 VCC (~1.67V)');
      assert.ok(m555.s2.vpp > 3.5, 'NE555 OUT swings cleanly on CH2');
    }
    console.log(`  [PASS] ${file} -> PSU ${dPsu.measV1.toFixed(2)}V @ ${(maxI1 * 1000).toFixed(1)}mA peak, scope samples=${dSc.count}`);
  }
  console.log('[PASS] All 12 Lab Handout circuits ran cleanly with benchtop instruments!');
}

// ---------------------------------------------------------------------------
// 7. Benchtop Instrument & Breadboard Collision / Overlap Prevention
// ---------------------------------------------------------------------------
{
  console.log('=== Testing Benchtop Instrument & Breadboard Collision Prevention ===');
  if (!globalThis.window) globalThis.window = { addEventListener() {} };
  const c = new Circuit();
  const brd = new Board('half', 0, 0); // x: 0..33, y: 0..20
  c.boards.push(brd);
  const holes = new Map();
  for (const h of brd.holes()) holes.set(`${h.x},${h.y}`, h);

  const mockApp = {
    circuit: c,
    mode: 'build',
    cam: { x: 0, y: 0, z: 1 },
    index: { holes, pins: new Map(), ends: new Map() },
    supplyClash: () => null,
    settings: { get: () => true },
    ui: { hint() {}, toast() {}, inspect() {} },
    redraw() {},
  };
  const ed = new Editor(mockApp, { addEventListener() {} });

  // Overlapping right on top of the breadboard -> blocked
  for (const type of ['oscilloscope', 'funcgen', 'power-supply', 'trainer-board']) {
    const overlap = new Part(type, 5, 5, 0);
    const res = ed.problems([overlap]);
    assert.ok(res.msg && res.msg.includes('breadboard'), `${type} on top of breadboard must be blocked`);
    assert.ok(res.badBoxes.length > 0, `${type} collision reports badBoxes`);
  }

  // Edge-touching the breadboard (pins at y=0, body y1=0.5 overlapping board y=0) -> blocked
  const touchingPsu = new Part('power-supply', 5, 0, 0);
  assert.ok(ed.problems([touchingPsu]).msg, 'Power supply touching breadboard edge at y=0 must be blocked');

  // Placed cleanly above breadboard at y = -2 (body bottom y1 = -1.5, >= 1.5 grid clearance) -> allowed
  const clearPsu = new Part('power-supply', 5, -2, 0);
  const resClear = ed.problems([clearPsu]);
  assert.equal(resClear.msg, null, 'Power supply placed cleanly above breadboard is allowed');
  c.parts.push(clearPsu);

  // Dragging breadboard up onto existing power supply at y=-2 -> blocked
  brd.y = -4;
  const brdMoveRes = ed.problems([], [brd]);
  assert.ok(brdMoveRes.msg && brdMoveRes.msg.includes('breadboard'), 'Dragging breadboard onto instrument must be blocked');
  brd.y = 0;

  // Placing a small component (resistor) on top of an instrument chassis -> blocked
  const sc = new Part('oscilloscope', 0, -15, 0);
  c.parts.push(sc);
  const rOnScope = new Part('resistor', 5, -18, 0);
  assert.ok(ed.problems([rOnScope]).msg && ed.problems([rOnScope]).msg.includes('instrument'), 'Resistor placed on oscilloscope chassis must be blocked');

  // Placing another instrument overlapping an existing instrument -> blocked
  const fgOnPsu = new Part('funcgen', 6, -2, 0);
  assert.ok(ed.problems([fgOnPsu]).msg && ed.problems([fgOnPsu]).msg.includes('overlap'), 'Overlapping instruments must be blocked');

  console.log('[PASS] All benchtop collision & breadboard separation checks passed.');
}

console.log('\nALL INSTRUMENT TESTS PASSED 100%!');

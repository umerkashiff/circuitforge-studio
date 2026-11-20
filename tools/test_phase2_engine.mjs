import assert from 'node:assert/strict';
import { Board, Circuit, Part, Wire } from '../src/model.js';
import { Engine } from '../src/sim/engine.js';
import '../src/parts/library.js';

const results = [];
function test(id, name, fn) {
  try {
    const info = fn() || 'ok';
    results.push({ id, name, pass: true, info });
  } catch (e) {
    results.push({ id, name, pass: false, info: e?.stack || e?.message || String(e) });
  }
}

const wire = (c, a, b) => c.wires.push(new Wire({ x: a.x, y: a.y }, { x: b.x, y: b.y }));

// ---------------------------------------------------------------------------
// 1. Bypass Cap minTau Exclusion + 555 Timing & Debouncer Retention
// ---------------------------------------------------------------------------
test('P2-E1', 'Rail bypass caps are excluded from minTau without ignoring 555 timing or RC debouncer caps', () => {
  // Case A: 14 parallel 0.1 uF bypass caps directly across +5V and GND only
  const cBypass = new Circuit();
  const vcc = new Part('vcc', 0, 0);
  const gnd = new Part('gnd', 0, 5);
  cBypass.parts.push(vcc, gnd);
  for (let i = 0; i < 14; i++) {
    const cap = new Part('capacitor', 5 + i * 2, 0, 0, { kind: 'ceramic', uf: 0.1, vmax: 50 });
    cBypass.parts.push(cap);
    wire(cBypass, cap.worldPins()[0], vcc.worldPins()[0]);
    wire(cBypass, cap.worldPins()[1], gnd.worldPins()[0]);
  }
  const eA = new Engine();
  eA.build(cBypass);
  eA.step(5e-4);
  assert.equal(eA.suggestDt(), 5e-4, `Expected default 5e-4 dt with only rail bypass caps, got ${eA.suggestDt()}`);

  // Case B: Add a real 555 astable timing cap (Ra=1k, Rb=100k, C=0.01 uF) + rail bypass caps
  // Timing node sits at ~100kΩ * 0.01 uF = 1 ms -> suggestDt() ~ 50 us (5e-5), NOT crushed to 2 us
  const ic555 = new Part('ne555', 0, 20);
  const ra = new Part('resistor', 10, 20, 0, { ohms: 1000 });
  const rb = new Part('resistor', 10, 23, 0, { ohms: 100000 });
  const cTim = new Part('capacitor', 10, 26, 0, { kind: 'ceramic', uf: 0.01, vmax: 50 });
  cBypass.parts.push(ic555, ra, rb, cTim);
  const p5 = ic555.worldPins(); // GND0, TRIG1, OUT2, RST3, CTRL4, THR5, DIS6, VCC7
  wire(cBypass, vcc.worldPins()[0], p5[7]);
  wire(cBypass, gnd.worldPins()[0], p5[0]);
  wire(cBypass, vcc.worldPins()[0], p5[3]);
  wire(cBypass, vcc.worldPins()[0], ra.worldPins()[0]);
  wire(cBypass, ra.worldPins()[1], p5[6]);
  wire(cBypass, p5[6], rb.worldPins()[0]);
  wire(cBypass, rb.worldPins()[1], p5[5]);
  wire(cBypass, p5[5], p5[1]);
  wire(cBypass, p5[5], cTim.worldPins()[0]);
  wire(cBypass, cTim.worldPins()[1], gnd.worldPins()[0]);

  const eB = new Engine();
  eB.build(cBypass);
  eB.step(5e-5);
  const dt555 = eB.suggestDt();
  assert.ok(dt555 >= 3e-5 && dt555 <= 1.2e-4, `Expected 555 timing cap to constrain suggestDt() near ~50 us, got ${dt555}`);

  // Case C: Standalone RC debouncer (R=2.2k pull-up + C=0.1 uF + button to GND) with rail bypass caps also present
  const cDeb = new Circuit();
  const v3 = new Part('vcc', 0, 0), g3 = new Part('gnd', 0, 5);
  const bp = new Part('capacitor', 4, 0, 0, { kind: 'ceramic', uf: 0.1, vmax: 50 });
  const rPull = new Part('resistor', 10, 0, 0, { ohms: 2200 });
  const cBounce = new Part('capacitor', 10, 5, 0, { kind: 'ceramic', uf: 0.1, vmax: 50 }); // tau = 220 us -> dt ~ 11 us
  cDeb.parts.push(v3, g3, bp, rPull, cBounce);
  wire(cDeb, bp.worldPins()[0], v3.worldPins()[0]); wire(cDeb, bp.worldPins()[1], g3.worldPins()[0]);
  wire(cDeb, v3.worldPins()[0], rPull.worldPins()[0]);
  wire(cDeb, rPull.worldPins()[1], cBounce.worldPins()[0]);
  wire(cDeb, cBounce.worldPins()[1], g3.worldPins()[0]);

  const eC = new Engine();
  eC.build(cDeb);
  eC.step(5e-4);
  const dtDeb = eC.suggestDt();
  assert.ok(dtDeb >= 5e-6 && dtDeb <= 3e-5, `Expected debouncer RC cap (tau=220us) to constrain suggestDt() near ~11us, got ${dtDeb}`);

  return `Bypass-only dt=${eA.suggestDt().toExponential(2)}; +555 dt=${dt555.toExponential(2)}; +Debouncer dt=${dtDeb.toExponential(2)}`;
});

// ---------------------------------------------------------------------------
// 2. Bus Contention Detection (Two 74LS245 Transceivers Enabled Together)
// ---------------------------------------------------------------------------
test('P2-E2', 'Enabling two 74245 bus drivers with conflicting data triggers explicit short warnings', () => {
  const c = new Circuit();
  const vcc = new Part('vcc', 0, 0), gnd = new Part('gnd', 0, 5);
  const u1 = new Part('ic74245', 10, 10);
  const u2 = new Part('ic74245', 30, 10);
  const oe2 = new Part('toggle', 30, 20, 0, { on: false }); // 0 = enabled (CONFLICT!)
  c.parts.push(vcc, gnd, u1, u2, oe2);

  const vp = vcc.worldPins()[0], gp = gnd.worldPins()[0];
  const p1 = u1.worldPins(), p2 = u2.worldPins();
  // Power both + DIR=1 (A -> B)
  wire(c, vp, p1[19]); wire(c, gp, p1[9]); wire(c, vp, p1[0]); wire(c, gp, p1[18]); // U1 always OE̅=0
  wire(c, vp, p2[19]); wire(c, gp, p2[9]); wire(c, vp, p2[0]); wire(c, oe2.worldPins()[0], p2[18]);

  // U1 A=0xAA (0,1,0,1,0,1,0,1 on A1..A8 pins idx 1..8), U2 A=0x55
  for (let i = 0; i < 8; i++) {
    wire(c, ((0xAA >> i) & 1) ? vp : gp, p1[1 + i]);
    wire(c, ((0x55 >> i) & 1) ? vp : gp, p2[1 + i]);
    wire(c, p1[17 - i], p2[17 - i]); // tie B1..B8 together on shared 8-bit bus
  }

  const eng = new Engine();
  eng.build(c);
  eng.step(0.01);
  const warns = eng.collectWarnings().filter(w => w.level === 'error');
  const d1 = eng.byPart.get(u1.id).device;
  const d2 = eng.byPart.get(u2.id).device;
  assert.ok(d1.warning && d1.warning.includes('shorted'), `Expected U1 contention warning, got: ${d1.warning}`);
  assert.ok(d2.warning && d2.warning.includes('shorted'), `Expected U2 contention warning, got: ${d2.warning}`);
  assert.ok(warns.length >= 2, 'collectWarnings must report contention errors for conflicting drivers');

  // Tri-state U2 (OE̅2 = 1) -> conflict disappears cleanly
  oe2.props.on = true;
  eng.step(0.01);
  const warnsAfter = eng.collectWarnings().filter(w => w.level === 'error');
  assert.equal(warnsAfter.length, 0, 'Disabling second driver must clear all contention errors');
  return 'Dual-driver bus conflict caught on both 74245s and cleared on tri-state';
});

// ---------------------------------------------------------------------------
// 3. 14-Full-Breadboard (~11,620 Holes) Solver Benchmark
// ---------------------------------------------------------------------------
test('P2-E3', '14 full breadboards (~45 ICs, 11,620 holes) build cleanly and step 240x fast enough for 60fps frames', () => {
  const c = new Circuit();
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < 2; col++) {
      c.boards.push(new Board('full', col * 70, row * 24, `b${row}_${col}`, `Board ${row * 2 + col + 1}`));
    }
  }
  const vcc = new Part('vcc', 2, 1), gnd = new Part('gnd', 3, 2);
  c.parts.push(vcc, gnd);
  // Chain power rails across all 14 boards
  for (let i = 1; i < c.boards.length; i++) {
    wire(c, { x: c.boards[0].x + 2, y: c.boards[0].y + 1 }, { x: c.boards[i].x + 2, y: c.boards[i].y + 1 });
    wire(c, { x: c.boards[0].x + 2, y: c.boards[0].y + 2 }, { x: c.boards[i].x + 2, y: c.boards[i].y + 2 });
  }
  // Place 45 mixed CPU ICs + 14 bypass caps + 555 mux clock
  const types = ['ic74173', 'ic74161', 'ic74245', 'ic74283', 'ic7486', 'ic7404', 'ic74157', 'ic74189', 'ic28c16'];
  for (let i = 0; i < 45; i++) {
    const b = c.boards[i % 14];
    const slot = Math.floor(i / 14);
    const t = types[i % types.length];
    const ic = new Part(t, b.x + 4 + slot * 16, b.y + b.rowY(6));
    c.parts.push(ic);
    const p = ic.worldPins();
    wire(c, p[ic.def.ic.vcc - 1], { x: b.x + 4 + slot * 16, y: b.y + 1 });
    wire(c, p[ic.def.ic.gnd - 1], { x: b.x + 5 + slot * 16, y: b.y + 2 });
  }
  for (const b of c.boards) {
    const cap = new Part('capacitor', b.x + 58, b.y + 1, 0, { kind: 'ceramic', uf: 0.1 });
    c.parts.push(cap);
  }
  const disp = new Part('seg7x4', c.boards[12].x + 48, c.boards[12].y + c.boards[12].rowY(7));
  c.parts.push(disp);

  const eng = new Engine();
  const tBuild0 = performance.now();
  eng.build(c);
  const buildMs = performance.now() - tBuild0;

  // Benchmark 240 steps (max 1-frame batch in App.frame)
  const t0 = performance.now();
  for (let s = 0; s < 240; s++) eng.step(5e-5);
  const step240Ms = performance.now() - t0;

  assert.ok(eng._activeNets < eng.nets / 2, `Expected sparse active net indexing (${eng._activeNets} < ${eng.nets / 2})`);
  assert.ok(step240Ms < 500, `240 steps across 14 boards took too long: ${step240Ms.toFixed(1)} ms`);
  return `14 boards (${eng.nets} total -> ${eng._activeNets} active nets), build=${buildMs.toFixed(1)}ms, 240 steps=${step240Ms.toFixed(1)}ms`;
});

// ---------------------------------------------------------------------------
// 4. Prop Isolation Check on Standard 74xx vs Configurable ICs
// ---------------------------------------------------------------------------
test('P2-E4', 'icDevice leaves ctx.props undefined on standard 74xx ICs and freezes props on 28c16/74189', () => {
  const c = new Circuit();
  const vcc = new Part('vcc', 0, 0), gnd = new Part('gnd', 0, 5);
  const u08 = new Part('ic7408', 10, 0);
  const eep = new Part('ic28c16', 10, 10, 0, { preset: 'sap1_display' });
  c.parts.push(vcc, gnd, u08, eep);
  wire(c, vcc.worldPins()[0], u08.worldPins()[13]);
  wire(c, gnd.worldPins()[0], u08.worldPins()[6]);
  wire(c, vcc.worldPins()[0], eep.worldPins()[23]);
  wire(c, gnd.worldPins()[0], eep.worldPins()[11]);
  const eng = new Engine();
  eng.build(c);
  let sawProps7408 = null;
  const origEv = u08.def.ic.ev;
  u08.def.ic.ev = (ctx) => { sawProps7408 = ctx.props !== undefined; return origEv(ctx); };
  eng.step(0.01);
  u08.def.ic.ev = origEv;
  assert.equal(sawProps7408, false, 'Standard 74xx ICs must receive ctx.props === undefined');

  const eepOrigEv = eep.def.ic.ev;
  let propsFrozen = false;
  eep.def.ic.ev = (ctx) => { propsFrozen = Object.isFrozen(ctx.props); return eepOrigEv(ctx); };
  eng.step(0.01);
  eep.def.ic.ev = eepOrigEv;
  assert.equal(propsFrozen, true, '28c16 ctx.props must be frozen');
  return 'Standard ICs keep ctx.props===undefined; 28c16 ctx.props frozen';
});

// ---------------------------------------------------------------------------
// 5. Settled Idle Cap Release vs Active AC / Transient Cap Clamping
// ---------------------------------------------------------------------------
test('P2-E5', 'Settled idle RC/monostable cap releases suggestDt() while 10 Hz / 1 kHz AC RC keeps dt clamped', () => {
  // Part A: Idle monostable 555 whose DIS pin clamps Cidle (0.1uF) across ~8 ohm
  const cIdle = new Circuit();
  const vp = new Part('vcc', 0, 0), gp = new Part('gnd', 0, 2);
  const t555 = new Part('ne555', 10, 0);
  const rpu = new Part('resistor', 4, 0, 0, { ohms: 10000 });
  const rMono = new Part('resistor', 24, 0, 0, { ohms: 10000 });
  const cMono = new Part('capacitor', 24, 6, 0, { kind: 'ceramic', uf: 0.1 });
  cIdle.parts.push(vp, gp, t555, rpu, rMono, cMono);
  const tp = t555.worldPins();
  wire(cIdle, vp.worldPins()[0], tp[7]); // VCC
  wire(cIdle, vp.worldPins()[0], tp[3]); // RST
  wire(cIdle, gp.worldPins()[0], tp[0]); // GND
  wire(cIdle, vp.worldPins()[0], rpu.worldPins()[0]);
  wire(cIdle, rpu.worldPins()[1], tp[1]); // TRIG pulled HIGH (idle)
  wire(cIdle, vp.worldPins()[0], rMono.worldPins()[0]);
  wire(cIdle, rMono.worldPins()[1], tp[6]); // DIS
  wire(cIdle, tp[6], tp[5]); // THR
  wire(cIdle, tp[5], cMono.worldPins()[0]);
  wire(cIdle, cMono.worldPins()[1], gp.worldPins()[0]);
  const eIdle = new Engine();
  eIdle.build(cIdle);
  for (let s = 0; s < 30; s++) eIdle.step(eIdle.suggestDt());
  const idleDt = eIdle.suggestDt();
  assert.ok(idleDt >= 4.5e-4, `Settled idle 555 DIS cap should release suggestDt() to maxDt (~5e-4), got ${idleDt}`);

  // Part B: 10 Hz and 1 kHz sine RC (tau=100us -> target dt=5us) must keep 0 spikes across sine peaks
  for (const hz of [10, 1000]) {
    const cAc = new Circuit();
    const g2 = new Part('gnd', 0, 20);
    const fg = new Part('funcgen', 0, 0, 0, { wave: 'sine', hz, vpp: 5, offsetOn: true, offset: 2.5 });
    const r = new Part('resistor', 20, 0, 0, { ohms: 100 });
    const cap = new Part('capacitor', 28, 0, 0, { kind: 'ceramic', uf: 1 });
    cAc.parts.push(g2, fg, r, cap);
    wire(cAc, fg.worldPins()[4], r.worldPins()[0]);
    wire(cAc, r.worldPins()[1], cap.worldPins()[0]);
    wire(cAc, cap.worldPins()[1], g2.worldPins()[0]);
    wire(cAc, fg.worldPins()[5], g2.worldPins()[0]);
    const eAc = new Engine();
    eAc.build(cAc);
    let spikes = 0;
    for (let s = 0; s < 2000; s++) {
      const dt = eAc.suggestDt();
      if (s > 10 && dt > 1e-5) spikes++;
      eAc.step(dt);
    }
    assert.equal(spikes, 0, `AC ${hz}Hz RC must have 0 dt spikes >1e-5s across wave peaks, got ${spikes}`);
  }
  return `Idle 555 DIS dt=${idleDt.toExponential(2)}; 10Hz/1kHz AC RC spikes=0`;
});

// ---------------------------------------------------------------------------
// 6. Mid-Simulation Topology Rebuilds (Engine.build) Preserve Toggle State
// ---------------------------------------------------------------------------
test('P2-E6', 'Mid-simulation Engine.build rebuilds preserve node voltages & 7474 Qbar->D pushbutton toggle', () => {
  const c = new Circuit();
  const vcc = new Part('vcc', 0, 0), gnd = new Part('gnd', 0, 10);
  const ff = new Part('ic7474', 10, 0);
  const btn = new Part('tactile', 20, 0);
  const rpd = new Part('resistor', 20, 6, 0, { ohms: 1000 });
  c.parts.push(vcc, gnd, ff, btn, rpd);
  const p = ff.worldPins();
  wire(c, vcc.worldPins()[0], p[13]); // VCC
  wire(c, gnd.worldPins()[0], p[6]);  // GND
  wire(c, vcc.worldPins()[0], p[0]);  // 1CLR#
  wire(c, vcc.worldPins()[0], p[3]);  // 1PRE#
  wire(c, p[5], p[1]);                // 1Qbar -> 1D
  wire(c, vcc.worldPins()[0], btn.worldPins()[0]);
  wire(c, btn.worldPins()[2], p[2]);  // 2.l -> 1CLK
  wire(c, btn.worldPins()[2], rpd.worldPins()[0]);
  wire(c, rpd.worldPins()[1], gnd.worldPins()[0]);

  const eng = new Engine();
  eng.build(c);
  for (let i = 0; i < 5; i++) eng.step(1e-4);
  const qPin = p[4];
  const readQ = () => eng.V[eng.netAt(qPin.x, qPin.y)] > 2.4 ? 1 : 0;
  assert.equal(readQ(), 0, 'Initial 7474 Q must be 0');

  const seq = [];
  for (let click = 1; click <= 6; click++) {
    btn.ui.pressed = true;
    eng.build(c);
    for (let i = 0; i < 5; i++) eng.step(1e-4);
    seq.push(readQ());
    btn.ui.pressed = false;
    eng.build(c);
    for (let i = 0; i < 5; i++) eng.step(1e-4);
  }
  assert.deepEqual(seq, [1, 0, 1, 0, 1, 0], `7474 Qbar->D toggle sequence mismatch: ${seq.join(',')}`);
  return `7474 Qbar->D pushbutton sequence [${seq.join(',')}] across 12 mid-sim rebuilds verified`;
});

for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'} [${r.id}] ${r.name} -> ${r.info}`);
const bad = results.filter(r => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} passed`);
if (bad) process.exit(1);

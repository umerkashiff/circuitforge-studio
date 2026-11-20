import assert from 'node:assert/strict';
import { Circuit, Part, Wire } from '../src/model.js';
import { Engine, key } from '../src/sim/engine.js';
import '../src/parts/library.js';
import {
  powerStandaloneBoard,
  buildPowerBusBoard,
  buildClockBoard,
  buildRegBoard,
  buildAluBoard,
  buildRamAddrBoard,
  buildRamCoreBoard,
  buildRamDataBoard,
  buildPcBoard,
  buildOutputBoard,
  buildStepFlagsBoard,
  buildMicrocodeBoard,
  buildControlBarBoard,
} from '../src/examples/sap1_cpu.js';
import { findProblems } from '../src/editor.js';

const results = [];
function test(id, name, fn) {
  try {
    const info = fn() || 'ok';
    results.push({ id, name, pass: true, info });
  } catch (e) {
    results.push({ id, name, pass: false, info: e?.stack || e?.message || String(e) });
  }
}

const _probeCache = new WeakMap();
const ptOf = (v) => (typeof v === 'function' ? v() : v);
const probePt = (v) => {
  if (typeof v !== 'function') return v;
  let p = _probeCache.get(v);
  if (!p) { p = v(); _probeCache.set(v, p); }
  return p;
};
const wire = (c, a, b) => {
  const pa = ptOf(a), pb = ptOf(b);
  c.wires.push(new Wire({ x: pa.x, y: pa.y }, { x: pb.x, y: pb.y }));
};
const vAt = (eng, pt) => {
  const p = probePt(pt);
  const n = eng.netAt(p.x, p.y);
  return n >= 0 ? eng.V[n] : NaN;
};
const lAt = (eng, pt) => (vAt(eng, pt) > 2.5 ? 1 : 0);
const readBits = (eng, pts) => pts.reduce((acc, p, i) => acc | (lAt(eng, p) << i), 0);

function addToggle(c, x, y, pt, on = false) {
  const t = new Part('toggle', x, y, 0, { on });
  c.parts.push(t);
  wire(c, t.worldPins()[0], pt);
  return t;
}
function addToggles(c, x0, y0, pts, val = 0) {
  return pts.map((p, i) => addToggle(c, x0 + i * 2, y0, p, !!((val >> i) & 1)));
}
function setToggles(sws, val) {
  sws.forEach((s, i) => { s.props.on = !!((val >> i) & 1); });
}
function addPullDowns(c, rig, pts, startX, y) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const r = new Part('resistor', startX + i * 2, y, 1, { ohms: 10000 }); // rot=1 vertical (non-overlapping)
    c.parts.push(r);
    wire(c, pts[i], r.worldPins()[0]);
    wire(c, r.worldPins()[1], rig.railPt('bn'));
    out.push(r);
  }
  return out;
}
function pulseClk(swClk, eng, steps = 4) {
  swClk.props.on = false;
  for (let i = 0; i < steps; i++) eng.step(5e-4);
  swClk.props.on = true;
  for (let i = 0; i < steps; i++) eng.step(5e-4);
}
function negEdgeClk(swClk, eng, steps = 4) {
  swClk.props.on = true;
  for (let i = 0; i < steps; i++) eng.step(5e-4);
  swClk.props.on = false;
  for (let i = 0; i < steps; i++) eng.step(5e-4);
}
function linkPower(aMod, bMod) {
  wire(aMod.rig.c, aMod.rig.railPt('tp'), bMod.rig.railPt('tp'));
  wire(aMod.rig.c, aMod.rig.railPt('tn'), bMod.rig.railPt('tn'));
}
function checkZeroErrors(c) {
  const holes = new Map(), pins = new Map(), ends = new Map();
  for (const b of c.boards) for (const hl of b.holes()) holes.set(key(hl.x, hl.y), hl);
  for (const p of c.parts) for (const q of p.worldPins()) {
    const k = key(q.x, q.y);
    if (!pins.has(k)) pins.set(k, []);
    pins.get(k).push({ part: p, i: q.i, name: q.name });
  }
  const app = { circuit: c, index: { holes, pins, ends }, supplyClash: () => null };
  for (const p of c.parts) {
    const res = findProblems(app, [p]);
    assert.equal(res.bad.size, 0, `DRC error on ${p.type}@(${p.x},${p.y}): ${res.msg}`);
    assert.equal(res.badBoxes.length, 0, `Box overlap on ${p.type}: ${res.msg}`);
  }
}

// ---------------------------------------------------------------------------
// SB-1: Clock & Power Bus Boards (L0 + L1)
// ---------------------------------------------------------------------------
test('SB-1', 'L0+L1 Clock Module: astable pulses, manual SPDT debounce pulse, and HLT freezes CLK', () => {
  const c = new Circuit();
  const L0 = buildPowerBusBoard(c, 0, 0);
  const L1 = buildClockBoard(c, 0, 24, { potPos: 0.005 }); // ~200 Hz fast astable
  linkPower(L0, L1);

  const swHlt = addToggle(c, -6, 26, L1.ports.hltIn(), false);
  checkZeroErrors(c);

  const eng = new Engine();
  eng.build(c);

  // 1) Auto mode: count CLK edges over ~40 ms
  let rises = 0, falls = 0, prev = lAt(eng, L1.ports.clkOut);
  for (let i = 0; i < 400; i++) {
    eng.step(1e-4);
    const cur = lAt(eng, L1.ports.clkOut);
    if (!prev && cur) rises++;
    if (prev && !cur) falls++;
    prev = cur;
  }
  assert.ok(rises >= 4 && falls >= 4, `Expected astable clock toggling in Auto mode, got rises=${rises}, falls=${falls}`);

  // 2) Switch SPDT to Manual ('B'), rebuild links, confirm astable doesn't drive CLK, then press stepBtn
  L1.ports.spdt.props.pos = 'B';
  eng.build(c);
  for (let i = 0; i < 60; i++) eng.step(1e-4);
  const idleVal = lAt(eng, L1.ports.clkOut);
  assert.equal(idleVal, 0, 'Manual mode CLK must rest LOW when step button is released');

  L1.ports.stepBtn.ui.pressed = true;
  eng.build(c);
  eng.step(1e-4);
  eng.step(1e-4);
  assert.equal(lAt(eng, L1.ports.clkOut), 1, 'Pressing manual step button produces clean HIGH pulse');
  L1.ports.stepBtn.ui.pressed = false;
  eng.build(c);
  for (let i = 0; i < 30; i++) eng.step(1e-4); // wait out ~1.1ms monostable pulse
  assert.equal(lAt(eng, L1.ports.clkOut), 0, 'Manual monostable pulse returns LOW');

  // 3) HLT=1 freezes CLK at 0 even in Auto mode
  L1.ports.spdt.props.pos = 'A';
  swHlt.props.on = true;
  eng.build(c);
  let hltHigh = 0;
  for (let i = 0; i < 200; i++) {
    eng.step(1e-4);
    if (lAt(eng, L1.ports.clkOut)) hltHigh++;
  }
  assert.equal(hltHigh, 0, 'HLT=1 must freeze CLK at 0V');
  return `Auto rises=${rises}, Manual step pulse + HLT freeze verified`;
});

// ---------------------------------------------------------------------------
// SB-2: Registers (R1/R3 + L5 Reset & IR Lower-4 Bus Mask)
// ---------------------------------------------------------------------------
test('SB-2', '8-bit Register & IR+Reset board: load, hold, tri-state drive, IR 4-bit mask, and Reset button', () => {
  const c = new Circuit();
  const regMod = buildRegBoard(c, 0, 0, {
    label: 'L5+Reset Test', includeReset: true, busMask: 0x0f,
  });
  powerStandaloneBoard(regMod.rig);

  const swD = addToggles(c, 0, 22, regMod.ports.busIn, 0xA5); // binary 1010_0101
  const swLoad = addToggle(c, 20, 22, regMod.ports.loadBar(), false); // active LOW
  const swOe = addToggle(c, 22, 22, regMod.ports.oeBar(), true);      // active LOW (initially disabled)
  const swClk = addToggle(c, 24, 22, regMod.ports.clkIn(), false);
  const swT5Bar = addToggle(c, 26, 22, regMod.ports.reset.t5BarIn(), true);
  addPullDowns(c, regMod.rig, regMod.ports.busOut, 30, 22);
  checkZeroErrors(c);

  const eng = new Engine();
  eng.build(c);
  eng.step(5e-4);

  // Load 0xA5 on rising edge
  pulseClk(swClk, eng);
  assert.equal(readBits(eng, regMod.ports.qPts), 0xA5, 'Register Q should latch 0xA5');
  assert.equal(readBits(eng, regMod.ports.busOut), 0x00, '74245 OE#=1 keeps bus pull-downs at 0x00');

  // Enable OE# -> with busMask=0x0f (IR mode), only lower nibble (0x05) drives bus!
  swOe.props.on = false;
  eng.step(5e-4);
  assert.equal(readBits(eng, regMod.ports.busOut), 0x05, 'IR busMask=0x0f must only drive lower 4 bits onto bus');

  // Hold while LOAD#=1
  swLoad.props.on = true;
  setToggles(swD, 0x3C);
  pulseClk(swClk, eng);
  assert.equal(readBits(eng, regMod.ports.qPts), 0xA5, 'LOAD#=1 must ignore CLK edge');

  // System Reset button clears register, flips RST/RST#, and gates Step_CLR#
  assert.equal(lAt(eng, regMod.ports.reset.rstHigh), 0);
  assert.equal(lAt(eng, regMod.ports.reset.rstBar), 1);
  assert.equal(lAt(eng, regMod.ports.reset.stepClrBar), 1);

  regMod.ports.reset.resetBtn.ui.pressed = true;
  eng.build(c);
  eng.step(5e-4);
  assert.equal(lAt(eng, regMod.ports.reset.rstHigh), 1, 'Reset button sets RST=1');
  assert.equal(lAt(eng, regMod.ports.reset.rstBar), 0, 'Reset button sets RST#=0');
  assert.equal(lAt(eng, regMod.ports.reset.stepClrBar), 0, 'Reset button drives Step_CLR#=0');
  assert.equal(readBits(eng, regMod.ports.qPts), 0x00, 'Reset button asynchronously clears 74173 Q=0');

  regMod.ports.reset.resetBtn.ui.pressed = false;
  eng.build(c);
  eng.step(5e-4);
  swT5Bar.props.on = false;
  eng.step(5e-4);
  assert.equal(lAt(eng, regMod.ports.reset.stepClrBar), 0, 'T5#=0 also drives Step_CLR#=0');
  return '0xA5 latch, IR 0x05 mask, and Reset/T5 combinational clear verified';
});

// ---------------------------------------------------------------------------
// SB-3: ALU (R2) + Flags NOR Tree & Register (R5 flags section)
// ---------------------------------------------------------------------------
test('SB-3', 'ALU & Flags: add (25+71=96), sub (71-25=46), and 0xFF+0x01 sets CY=1 & ZF=1 simultaneously', () => {
  const c = new Circuit();
  const alu = buildAluBoard(c, 0, 0);
  const flg = buildStepFlagsBoard(c, 0, 24);
  linkPower({ rig: alu.rig }, flg);
  powerStandaloneBoard(alu.rig);

  // Connect ALU Sum -> Flags NOR tree, ALU CY -> Flags 1D
  for (let i = 0; i < 8; i++) wire(c, alu.ports.sum[i], flg.ports.aluSumIn[i]);
  wire(c, alu.ports.cy(), flg.ports.cyIn());

  const swA = addToggles(c, 0, 46, alu.ports.aIn, 25);
  const swB = addToggles(c, 20, 46, alu.ports.bIn, 71);
  const swSu = addToggle(c, 40, 46, alu.ports.suIn(), false);
  const swEo = addToggle(c, 42, 46, alu.ports.eoBar(), false);
  const swFi = addToggle(c, 44, 46, flg.ports.fiBarIn(), false);
  const swClk = addToggle(c, 46, 46, flg.ports.flagsClkIn(), false);
  const swClr = addToggle(c, 48, 46, flg.ports.flagsClrIn(), false);
  // Keep unused step inputs driven cleanly
  addToggle(c, 50, 46, flg.ports.clkBarIn(), false);
  addToggle(c, 52, 46, flg.ports.stepClrBarIn(), true);
  addToggle(c, 54, 46, flg.ports.outGateClkIn(), false);
  addToggle(c, 56, 46, flg.ports.outGateOiIn(), false);
  checkZeroErrors(c);

  const eng = new Engine();
  eng.build(c);
  eng.step(5e-4);

  // 1) 25 + 71 = 96, CY=0, ZF=0
  pulseClk(swClk, eng);
  assert.equal(readBits(eng, alu.ports.busOut), 96);
  assert.equal(lAt(eng, flg.ports.cyOut), 0);
  assert.equal(lAt(eng, flg.ports.zfOut), 0);

  // 2) Subtract: 71 - 25 = 46, SU=1 -> CY=1 (no borrow), ZF=0
  setToggles(swA, 71);
  setToggles(swB, 25);
  swSu.props.on = true;
  pulseClk(swClk, eng);
  assert.equal(readBits(eng, alu.ports.busOut), 46);
  assert.equal(lAt(eng, flg.ports.cyOut), 1);
  assert.equal(lAt(eng, flg.ports.zfOut), 0);

  // 3) Critical interaction: 0xFF + 0x01 = 0x00 with CY=1 AND ZF=1 on same rising CLK!
  swSu.props.on = false;
  setToggles(swA, 0xff);
  setToggles(swB, 0x01);
  pulseClk(swClk, eng);
  assert.equal(readBits(eng, alu.ports.sum), 0x00, '0xFF+0x01 ALU sum must wrap to 0x00');
  assert.equal(lAt(eng, flg.ports.cyOut), 1, '0xFF+0x01 must latch CY=1');
  assert.equal(lAt(eng, flg.ports.zfOut), 1, '0xFF+0x01 must latch ZF=1 on same clock edge');

  // Verify CLR clears flags
  swClr.props.on = true; eng.step(5e-4);
  assert.equal(lAt(eng, flg.ports.cyOut), 0);
  assert.equal(lAt(eng, flg.ports.zfOut), 0);
  return 'ADD 25+71=96, SUB 71-25=46, and 0xFF+0x01 (ZF=1 & CY=1) verified';
});

// ---------------------------------------------------------------------------
// SB-4: RAM Subsystem (L2 MAR/Mux + L3 74189x2 + L4 Data Mux/Write Gate)
// ---------------------------------------------------------------------------
test('SB-4', 'RAM boards (L2+L3+L4): preset read, Program DIP write at addr 5, and Run MAR readback onto bus', () => {
  const c = new Circuit();
  const preset = Array(16).fill(0);
  preset[2] = 0x5A;
  const L2 = buildRamAddrBoard(c, 0, 0, { programMode: true, dipAddr: [true, false, true, false] }); // addr 0b0101 = 5!
  const L3 = buildRamCoreBoard(c, 0, 24, { programBytes: preset });
  const L4 = buildRamDataBoard(c, 0, 48);
  powerStandaloneBoard(L2.rig);
  linkPower(L2, L3);
  linkPower(L2, L4);

  // Internal L2 <-> L3 <-> L4 connections
  for (let i = 0; i < 4; i++) wire(c, L2.ports.addrOut[i], L3.ports.addrIn[i]);
  for (let i = 0; i < 8; i++) {
    wire(c, L4.ports.muxDataOut[i], L3.ports.dataIn[i]);
    wire(c, L3.ports.dataOut[i], L4.ports.ramDataIn[i]);
  }
  wire(c, L2.ports.selOut(), L3.ports.selIn());
  wire(c, L2.ports.selOut(), L4.ports.selIn());
  wire(c, L3.ports.selBarOut(), L4.ports.selBarIn());
  wire(c, L4.ports.weBarOut(), L3.ports.weBarIn());

  // External test controls (Shared bus wires on L2.busIn, L4.busIn, L4.busOut)
  const swBus = addToggles(c, 0, 72, L2.ports.busIn, 0x05);
  for (let i = 0; i < 8; i++) {
    const t = new Part('toggle', 20 + i * 2, 72, 0, { on: false });
    if (i < 4) wire(c, swBus[i].worldPins()[0], L4.ports.busIn[i]());
    else { c.parts.push(t); wire(c, t.worldPins()[0], L4.ports.busIn[i]()); }
  }
  const swMi = addToggle(c, 36, 72, L2.ports.miBar(), true);
  const swClk = addToggle(c, 38, 72, L2.ports.clkIn(), false);
  wire(c, swClk.worldPins()[0], L4.ports.clkIn());
  const swClr = addToggle(c, 40, 72, L2.ports.clrIn(), false);
  const swRi = addToggle(c, 42, 72, L4.ports.riIn(), false);
  const swRo = addToggle(c, 44, 72, L4.ports.roBar(), false);
  checkZeroErrors(c);

  // Set DIP8 in L4 to 0x6E (0110_1110 -> LSB first!)
  const valWrite = 0x6E;
  for (let i = 0; i < 8; i++) L4.ports.dip8.props.bits[i] = !!((valWrite >> i) & 1);

  const eng = new Engine();
  eng.build(c);
  eng.step(5e-4);

  // Program mode (SEL=0): confirm initial RAM[5] wasn't glitch-written on power-up, then write 0x6E via writeBtn
  assert.equal(readBits(eng, L4.ports.busOut), 0x00, 'Initial RAM[5] must stay 0x00 before WriteBtn is pressed');
  L4.ports.writeBtn.ui.pressed = true;
  eng.build(c);
  eng.step(5e-4);
  L4.ports.writeBtn.ui.pressed = false;
  eng.build(c);
  eng.step(5e-4);
  assert.equal(readBits(eng, L4.ports.busOut), 0x6E, 'RAM should read back written 0x6E at Program addr 5');

  // Switch SPDT to Run mode (pos='B', SEL=1). Wait: dip4 was 5, MAR is 0 -> preset[0]=0, wait switch addr to 2!
  L2.ports.spdt.props.pos = 'B';
  eng.build(c);
  eng.step(5e-4);
  setToggles(swBus, 2);
  swMi.props.on = false;
  pulseClk(swClk, eng);
  swMi.props.on = true;
  assert.equal(readBits(eng, L4.ports.busOut), 0x5A, 'MAR=2 should read initial preset[2]=0x5A');

  setToggles(swBus, 5);
  swMi.props.on = false;
  pulseClk(swClk, eng);
  swMi.props.on = true;
  assert.equal(readBits(eng, L4.ports.busOut), 0x6E, 'MAR=5 should read Program-written 0x6E');
  return 'Program DIP write (0x6E@5) + Run MAR read (0x5A@2, 0x6E@5) verified';
});

// ---------------------------------------------------------------------------
// SB-5: Program Counter (R0)
// ---------------------------------------------------------------------------
test('SB-5', 'PC Board (R0): CLR# clear, CE increment, J# jump load, and CO# 8-bit bus drive', () => {
  const c = new Circuit();
  const R0 = buildPcBoard(c, 0, 0);
  powerStandaloneBoard(R0.rig);

  const swD = addToggles(c, 0, 22, R0.ports.busIn, 0xB);
  const swClr = addToggle(c, 10, 22, R0.ports.clrBarIn(), true);
  const swClk = addToggle(c, 12, 22, R0.ports.clkIn(), false);
  const swCe = addToggle(c, 14, 22, R0.ports.ceIn(), true);
  const swJ = addToggle(c, 16, 22, R0.ports.jBarIn(), true);
  const swCo = addToggle(c, 18, 22, R0.ports.coBar(), false);
  addPullDowns(c, R0.rig, R0.ports.busOut, 22, 22);
  checkZeroErrors(c);

  const eng = new Engine();
  eng.build(c);
  eng.step(5e-4);
  assert.equal(readBits(eng, R0.ports.busOut), 0);

  // Increment 3 clocks -> PC=3
  pulseClk(swClk, eng); pulseClk(swClk, eng); pulseClk(swClk, eng);
  assert.equal(readBits(eng, R0.ports.busOut), 3);

  // Jump load 0x0B on next rising edge
  swCe.props.on = false; swJ.props.on = false;
  pulseClk(swClk, eng);
  assert.equal(readBits(eng, R0.ports.busOut), 0x0B);

  // Disable CO# -> bus pulled low
  swCo.props.on = true; eng.step(5e-4);
  assert.equal(readBits(eng, R0.ports.busOut), 0x00);

  // Async clear
  swCo.props.on = false; swClr.props.on = false; eng.step(5e-4);
  assert.equal(readBits(eng, R0.ports.busOut), 0x00);
  return 'PC count 0->3, jump->0x0B, CO# tri-state & CLR# clear verified';
});

// ---------------------------------------------------------------------------
// SB-6: Step Counter + Decoder (R5) + Microcode EEPROMs (L6) + Normalizer (R6)
// ---------------------------------------------------------------------------
test('SB-6', 'Step Counter + Microcode EEPROMs + Normalizer: T0..T4 cycle & T5 async reset; LDA/ADI/OAH/JC/JZ signals', () => {
  const c = new Circuit();
  const L6 = buildMicrocodeBoard(c, 0, 0);
  const R5 = buildStepFlagsBoard(c, 0, 24);
  const R6 = buildControlBarBoard(c, 0, 48);
  powerStandaloneBoard(L6.rig);
  linkPower(L6, R5);
  linkPower(L6, R6);

  // Wire R5.stepOut -> L6.stepIn, R5.t5BarOut -> R5.stepClrBarIn, L6.ctrl -> R6.inHubs
  for (let i = 0; i < 3; i++) wire(c, R5.ports.stepOut[i], L6.ports.stepIn[i]);
  wire(c, R5.ports.t5BarOut(), R5.ports.stepClrBarIn());
  for (const sig of Object.keys(R6.ports.inHubs)) wire(c, L6.ports.ctrl[sig](), R6.ports.inHubs[sig]());
  wire(c, R6.ports.clkBarOut(), R5.ports.clkBarIn());

  const swOp = addToggles(c, 0, 72, L6.ports.opIn, 0x1); // LDA
  const swCy = addToggle(c, 10, 72, L6.ports.cyIn(), false);
  const swZf = addToggle(c, 12, 72, L6.ports.zfIn(), false);
  const swClk = addToggle(c, 14, 72, R6.ports.clkIn(), true);
  // Keep unused Flags inputs tied cleanly
  addToggles(c, 20, 72, R5.ports.aluSumIn, 0);
  addToggle(c, 38, 72, R5.ports.cyIn(), false);
  addToggle(c, 40, 72, R5.ports.fiBarIn(), true);
  addToggle(c, 42, 72, R5.ports.flagsClkIn(), false);
  addToggle(c, 44, 72, R5.ports.flagsClrIn(), false);
  addToggle(c, 46, 72, R5.ports.outGateClkIn(), false);
  checkZeroErrors(c);

  const eng = new Engine();
  eng.build(c);
  eng.step(5e-4);

  const readStep = () => readBits(eng, R5.ports.stepOut);
  const sig = R6.ports.outPts;

  // T0 = MI | CO -> active-LOW MI_N=0, CO_N=0
  assert.equal(readStep(), 0);
  assert.equal(lAt(eng, sig.MI_N), 0, 'T0: MI_N should be active (0)');
  assert.equal(lAt(eng, sig.CO_N), 0, 'T0: CO_N should be active (0)');
  assert.equal(lAt(eng, sig.RO_N), 1, 'T0: RO_N inactive (1)');

  // Falling edge of CLK (CLK#=rising) -> T1 = RO | II | CE
  negEdgeClk(swClk, eng);
  assert.equal(readStep(), 1);
  assert.equal(lAt(eng, sig.RO_N), 0, 'T1: RO_N active');
  assert.equal(lAt(eng, sig.II_N), 0, 'T1: II_N active');
  assert.equal(lAt(eng, sig.CE), 1, 'T1: CE active');

  // T2 (LDA = IO | MI)
  negEdgeClk(swClk, eng);
  assert.equal(readStep(), 2);
  assert.equal(lAt(eng, sig.IO_N), 0, 'LDA T2: IO_N active');
  assert.equal(lAt(eng, sig.MI_N), 0, 'LDA T2: MI_N active');

  // Test ADI (0x9) at T2 & T3, then T4, then T5 -> async clear to T0!
  setToggles(swOp, 0x9); eng.step(5e-4);
  assert.equal(lAt(eng, sig.BI_N), 0, 'ADI T2: BI_N active');
  negEdgeClk(swClk, eng);
  assert.equal(readStep(), 3);
  assert.equal(lAt(eng, sig.EO_N), 0, 'ADI T3: EO_N active');
  assert.equal(lAt(eng, sig.AI_N), 0, 'ADI T3: AI_N active');
  assert.equal(lAt(eng, sig.FI_N), 0, 'ADI T3: FI_N active');

  // T4 then next falling edge hits T5 and resets back to T0!
  negEdgeClk(swClk, eng);
  assert.equal(readStep(), 4);
  // Check OAH (0xB) at T4 -> HLT=1
  setToggles(swOp, 0xB); eng.step(5e-4);
  assert.equal(lAt(eng, sig.HLT), 1, 'OAH T4: HLT active');

  negEdgeClk(swClk, eng);
  assert.equal(readStep(), 0, 'T5 must asynchronously reset step counter back to T0');

  // Advance to T2 & check JZ with ZF=0 vs ZF=1
  negEdgeClk(swClk, eng); // T1
  negEdgeClk(swClk, eng); // T2
  setToggles(swOp, 0x8); // JZ
  eng.step(5e-4);
  assert.equal(lAt(eng, sig.J_N), 1, 'JZ with ZF=0 must not assert J#');
  swZf.props.on = true; eng.step(5e-4);
  assert.equal(lAt(eng, sig.J_N), 0, 'JZ with ZF=1 must assert J#=0');
  swZf.props.on = false; swCy.props.on = true; setToggles(swOp, 0x7); // JC
  eng.step(5e-4);
  assert.equal(lAt(eng, sig.J_N), 0, 'JC with CY=1 must assert J#=0');
  return 'Step T0..T4->T0 reset + LDA/ADI/OAH/JC/JZ normalizer polarity verified';
});

// ---------------------------------------------------------------------------
// SB-7: Output Display Module (R4): 74273 + 555 + 74107 + 74139 + 28C16 + seg7x4
// ---------------------------------------------------------------------------
const SEG_MASKS = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f];
function readMultiplexedDigits(eng, dispPart, mux555Steps = 220) {
  const dev = eng.byPart.get(dispPart.id).device;
  const maxCur = [0, 0, 0, 0];
  for (let i = 0; i < mux555Steps; i++) {
    eng.step(2e-4); // total 44ms -> ~30+ mux transitions (~700Hz), scans every digit!
    for (let d = 0; d < 4; d++) {
      let mask = 0;
      for (let s = 0; s < 8; s++) {
        if (dev.cur[d * 8 + s] > 0.002) mask |= (1 << s);
      }
      if (mask) maxCur[d] |= mask;
    }
  }
  return maxCur;
}
function decodeSegMask(m) {
  if (m === 0) return ' ';
  if (m === 0x40) return '-';
  const idx = SEG_MASKS.indexOf(m & 0x7f);
  return idx >= 0 ? String(idx) : `?(${m.toString(16)})`;
}

test('SB-7', 'Output Module (R4): latches 123 unsigned and -45 signed across multiplexed seg7x4', () => {
  const c = new Circuit();
  const R4 = buildOutputBoard(c, 0, 0, { muxUf: 0.01 });
  powerStandaloneBoard(R4.rig);

  const swBus = addToggles(c, 0, 22, R4.ports.busIn, 123);
  const swOutClk = addToggle(c, 18, 22, R4.ports.outClkIn(), false);
  const swClr = addToggle(c, 20, 22, R4.ports.clrBarIn(), true);
  checkZeroErrors(c);

  const eng = new Engine();
  eng.build(c);
  pulseClk(swOutClk, eng);

  const mUnsigned = readMultiplexedDigits(eng, R4.ports.disp);
  const strUnsigned = mUnsigned.map(decodeSegMask).join('');
  assert.equal(strUnsigned, ' 123', `Expected multiplexed ' 123', got '${strUnsigned}'`);

  // Signed -45 (0xD3 = 211)
  R4.ports.signedSw.props.on = true;
  setToggles(swBus, 211);
  pulseClk(swOutClk, eng);
  const mSigned = readMultiplexedDigits(eng, R4.ports.disp);
  const strSigned = mSigned.map(decodeSegMask).join('');
  assert.equal(strSigned, '-045', `Expected multiplexed signed '-045', got '${strSigned}'`);

  // Clear output register -> '000'
  swClr.props.on = false;
  eng.step(5e-4);
  swClr.props.on = true;
  const mClr = readMultiplexedDigits(eng, R4.ports.disp);
  assert.equal(mClr.map(decodeSegMask).join(''), ' 000');
  return `seg7x4 decoded '${strUnsigned}' unsigned, '${strSigned}' signed & CLR#=' 000'`;
});

for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'} [${r.id}] ${r.name} -> ${r.info}`);
}
const bad = results.filter(r => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} passed`);
if (bad) process.exit(1);

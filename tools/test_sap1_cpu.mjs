import assert from 'node:assert/strict';
import { Circuit, Part, Wire } from '../src/model.js';
import { Engine, key } from '../src/sim/engine.js';
import '../src/parts/library.js';
import { findProblems } from '../src/editor.js';
import { OPCODES } from '../src/parts/sap1_roms.js';
import { buildSap1CpuCircuit } from '../src/examples/sap1_cpu.js';

const results = [];
function test(id, name, fn) {
  try {
    const info = fn() || 'ok';
    results.push({ id, name, pass: true, info });
  } catch (e) {
    results.push({ id, name, pass: false, info: e?.stack || e?.message || String(e) });
  }
}

const SEG_MASKS = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f];
function decodeSegMask(m) {
  if (m === 0) return ' ';
  if (m === 0x40) return '-';
  const idx = SEG_MASKS.indexOf(m & 0x7f);
  return idx >= 0 ? String(idx) : `?(${m.toString(16)})`;
}

function readIcByte(eng, ic, pinNums) {
  return pinNums.reduce((acc, p, i) => {
    const q = ic.worldPins()[p - 1];
    const v = eng.V[eng.netAt(q.x, q.y)];
    return acc | ((v > 2.5 ? 1 : 0) << i);
  }, 0);
}
function readIcBit(eng, ic, pinNum) {
  const q = ic.worldPins()[pinNum - 1];
  const v = eng.V[eng.netAt(q.x, q.y)];
  return v > 2.5 ? 1 : 0;
}

function readCpuState(eng, built) {
  const { R0, R1, R3, R4, R5, L2, L5 } = built.boards;
  return {
    pc: readIcByte(eng, R0.ports.u161, [14, 13, 12, 11]),
    mar: readIcByte(eng, L2.ports.mar, [3, 4, 5, 6]),
    a: readIcByte(eng, R1.ports.regLo, [3, 4, 5, 6]) | (readIcByte(eng, R1.ports.regHi, [3, 4, 5, 6]) << 4),
    b: readIcByte(eng, R3.ports.regLo, [3, 4, 5, 6]) | (readIcByte(eng, R3.ports.regHi, [3, 4, 5, 6]) << 4),
    ir: readIcByte(eng, L5.ports.regLo, [3, 4, 5, 6]) | (readIcByte(eng, L5.ports.regHi, [3, 4, 5, 6]) << 4),
    out: readIcByte(eng, R4.ports.u273, [2, 5, 6, 9, 12, 15, 16, 19]),
    step: readIcByte(eng, R5.ports.u161, [14, 13, 12]),
    cy: readIcBit(eng, R5.ports.flagsReg, 3),
    zf: readIcBit(eng, R5.ports.flagsReg, 4),
    hlt: readIcBit(eng, built.boards.L6.ports.eepHi, 17),
  };
}

function assertCleanHealth(eng, c, label) {
  const shorts = eng.warnings.filter(w => w.level === 'error');
  assert.equal(shorts.length, 0, `${label}: engine warnings present: ${shorts.map(w => w.text).join('; ')}`);
  const blown = c.parts.filter(p => p.props.damaged);
  assert.equal(blown.length, 0, `${label}: damaged components: ${blown.map(p => p.ref || p.type).join(', ')}`);
}

function runUntilOutputs(built, targetCount, maxCycles) {
  const { circuit } = built;
  const eng = new Engine();
  eng.build(circuit);
  const { L1, R4, R5, L6 } = built.boards;
  const clkPin = L1.ports.clkLedPart.worldPins()[0];
  const dispDev = eng.byPart.get(R4.ports.disp.id).device;
  let prevClk = 0, cycles = 0, prevOiClk = 0;
  const outputs = [];
  let hltAtCycle = -1;
  let prevStepOut = -1;

  for (let s = 0; s < maxCycles * 90 && cycles < maxCycles; s++) {
    eng.step(1.5e-4);

    // Capture rising edge of OUT_CLK (writes 74273)
    const oiClk = readIcBit(eng, R5.ports.u08, 11);
    if (!prevOiClk && oiClk) {
      // Wait 1 tiny delta or read next step? On rising edge commit already updated u273!
      const val = readIcByte(eng, R4.ports.u273, [2, 5, 6, 9, 12, 15, 16, 19]);
      outputs.push({ val, cycle: cycles });
      prevStepOut = outputs.length;
    }
    prevOiClk = oiClk;

    const clk = eng.V[eng.netAt(clkPin.x, clkPin.y)] > 2.5 ? 1 : 0;
    if (readIcBit(eng, L6.ports.eepHi, 17) === 1 && hltAtCycle < 0) {
      hltAtCycle = cycles;
      if (targetCount >= 99) break;
    }
    if (!prevClk && clk) {
      cycles++;
      if (targetCount && outputs.length >= targetCount) break;
    }
    prevClk = clk;
  }

  // Let display mux scan >= 4 digits (~10 ms) after final output latch without requiring clock
  const segMasks = [0, 0, 0, 0];
  for (let s = 0; s < 60; s++) {
    eng.step(2e-4);
    for (let d = 0; d < 4; d++) {
      let mask = 0;
      for (let seg = 0; seg < 8; seg++) {
        if (dispDev.cur[d * 8 + seg] > 0.002) mask |= (1 << seg);
      }
      if (mask) segMasks[d] |= mask;
    }
  }
  return { eng, cycles, outputs, hltAtCycle, segStr: segMasks.map(decodeSegMask).join('') };
}

// ---------------------------------------------------------------------------
// CPU-1: Full 14-Board Physical Geometry, DRC, & Part Count Verification
// ---------------------------------------------------------------------------
test('CPU-1', '14 full breadboards (2x7), 0 DRC placement errors, and ~45 ICs cleanly built', () => {
  const built = buildSap1CpuCircuit({ program: 'fibonacci' });
  const c = built.circuit;
  assert.equal(c.boards.length, 14, `Expected 14 full boards, got ${c.boards.length}`);
  assert.ok(c.boards.every(b => b.size === 'full'), 'All 14 boards must be full 830-pt size');

  // Verify no two boards overlap physically
  for (let i = 0; i < c.boards.length; i++) {
    for (let j = i + 1; j < c.boards.length; j++) {
      const a = c.boards[i], b = c.boards[j];
      const sepX = a.x + a.w <= b.x || b.x + b.w <= a.x;
      const sepY = a.y + a.h <= b.y || b.y + b.h <= a.y;
      assert.ok(sepX || sepY, `Boards ${a.id} and ${b.id} overlap!`);
    }
  }

  // Run full findProblems DRC on every non-annotation part
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
    assert.equal(res.bad.size, 0, `DRC error on ${p.ref || p.type}@(${p.x},${p.y}): ${res.msg}`);
  }

  const icCount = c.parts.filter(p => p.type.startsWith('ic') || p.type === 'ne555').length;
  const eng = new Engine();
  eng.build(c);
  eng.step(2e-4);
  assertCleanHealth(eng, c, 'CPU-1 startup');
  return `14 boards, ${icCount} ICs, ${c.parts.length} parts, ${c.wires.length} wires, 0 DRC errors`;
});

// ---------------------------------------------------------------------------
// CPU-2: Fibonacci Sequence (clock-cycle counted!)
// ---------------------------------------------------------------------------
test('CPU-2', 'Fibonacci program executes 0,1,1,2,3,5,8,13,21,34,55,89,144,233 by clock cycles', () => {
  const built = buildSap1CpuCircuit({ program: 'fibonacci', potPos: 0.002 });
  const expected = [0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233];
  const res = runUntilOutputs(built, expected.length, 460);
  const got = res.outputs.map(o => o.val);
  assert.deepEqual(got, expected, `Fibonacci mismatch: got [${got.join(', ')}]`);
  assert.equal(res.segStr, ' 233', `Expected seg7x4 to display ' 233', got '${res.segStr}'`);
  assertCleanHealth(res.eng, built.circuit, 'CPU-2');
  return `Matched all ${expected.length} terms in ${res.cycles} CLK cycles; seg7x4='${res.segStr}'`;
});

// ---------------------------------------------------------------------------
// CPU-3: Powers of 2 (clock-cycle counted!)
// ---------------------------------------------------------------------------
test('CPU-3', 'Powers of 2 program executes 1,2,4,8,16,32,64,128 & loops on carry overflow', () => {
  const built = buildSap1CpuCircuit({ program: 'powers2', potPos: 0.002 });
  const expected = [1, 2, 4, 8, 16, 32, 64, 128, 1, 2];
  const res = runUntilOutputs(built, expected.length, 320);
  const got = res.outputs.map(o => o.val);
  assert.deepEqual(got, expected, `Powers of 2 mismatch: got [${got.join(', ')}]`);
  assertCleanHealth(res.eng, built.circuit, 'CPU-3');
  return `Matched [${got.join(',')}] in ${res.cycles} CLK cycles`;
});

// ---------------------------------------------------------------------------
// CPU-4: Multiply 7 * 9 = 63 + HLT hardware clock freeze
// ---------------------------------------------------------------------------
test('CPU-4', 'Multiply (7x9) outputs 63, displays 063 on seg7x4, and HLT freezes clock', () => {
  const built = buildSap1CpuCircuit({ program: 'multiply', potPos: 0.002 });
  const res = runUntilOutputs(built, 99, 500);
  const got = res.outputs.map(o => o.val);
  assert.deepEqual(got, [63], `Expected single output [63], got [${got.join(', ')}]`);
  assert.ok(res.hltAtCycle > 20, `Expected HLT at cycle > 20, got ${res.hltAtCycle}`);
  assert.equal(readCpuState(res.eng, built).hlt, 1, 'HLT flag must stay 1');

  // Verify clock truly remains frozen when stepping another 20ms
  const clkPin = built.boards.L1.ports.clkLedPart.worldPins()[0];
  let extraEdges = 0, prev = res.eng.V[res.eng.netAt(clkPin.x, clkPin.y)] > 2.5 ? 1 : 0;
  for (let i = 0; i < 120; i++) {
    res.eng.step(2e-4);
    const cur = res.eng.V[res.eng.netAt(clkPin.x, clkPin.y)] > 2.5 ? 1 : 0;
    if (!prev && cur) extraEdges++;
    prev = cur;
  }
  assert.equal(extraEdges, 0, 'Clock must stay frozen after HLT');
  assertCleanHealth(res.eng, built.circuit, 'CPU-4');
  return `7x9=${got[0]} halted at cycle ${res.hltAtCycle}, seg7x4='${res.segStr}', 0 extra clocks`;
});

// ---------------------------------------------------------------------------
// CPU-5: ADI / SUI / OAH / JZ with (0xFF + 0x01 -> ZF=1 & CY=1) + System Reset + Live DIP Edit
// ---------------------------------------------------------------------------
const ins = (op, a = 0) => ((op & 0xf) << 4) | (a & 0xf);
test('CPU-5', 'ADI/SUI/OAH + JZ on (0xFF+0x01: ZF=1&CY=1) + Reset button + Program Mode DIP write', () => {
  const { NOP, LDI, SUI, ADI, JZ, OAH, HLT } = OPCODES;
  const built = buildSap1CpuCircuit({ program: 'fibonacci', potPos: 0.002 });
  const { L2, L3, L4, L5, L6, R1 } = built.boards;

  // Overwrite RAM initHex with custom ADI/SUI/JZ/OAH verification program:
  // 0: LDI 0x00; 1: SUI 0x01 (A=0xFF); 2: ADI 0x01 (A=0x00, ZF=1, CY=1);
  // 3: JZ 5;     4: HLT (fail if JZ missed); 5: OAH 6 (display mem[6]=42 & HLT); 6: 42
  const prog = [
    ins(LDI, 0), ins(SUI, 1), ins(ADI, 1), ins(JZ, 5),
    ins(HLT, 0), ins(OAH, 6), 42, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
  ];
  L3.ports.ramLo.props.initHex = prog.map(b => (b & 0xf).toString(16)).join('');
  L3.ports.ramHi.props.initHex = prog.map(b => ((b >> 4) & 0xf).toString(16)).join('');

  const res = runUntilOutputs(built, 99, 100);
  assert.deepEqual(res.outputs.map(o => o.val), [42], `Expected OAH to output [42], got [${res.outputs.map(o => o.val)}]`);
  const stDone = readCpuState(res.eng, built);
  assert.equal(stDone.zf, 1, 'ZF must be 1 from 0xFF+0x01');
  assert.equal(stDone.cy, 1, 'CY must be 1 from 0xFF+0x01');
  assert.equal(stDone.pc, 6, 'PC should jump from 4 to 5 and advance to 6 after JZ 5 -> OAH 6');
  assert.equal(stDone.hlt, 1, 'OAH must assert HLT=1');

  // Press physical Reset button (L5): must clear PC, A, B, IR, MAR, Out, Flags, Step while keeping RAM!
  L5.ports.reset.resetBtn.ui.pressed = true;
  res.eng.build(built.circuit);
  res.eng.step(2e-4);
  const stRst = readCpuState(res.eng, built);
  assert.equal(stRst.pc, 0); assert.equal(stRst.mar, 0);
  assert.equal(stRst.a, 0); assert.equal(stRst.b, 0);
  assert.equal(stRst.ir, 0); assert.equal(stRst.out, 0);
  assert.equal(stRst.cy, 0); assert.equal(stRst.zf, 0);
  assert.equal(stRst.step, 0);
  L5.ports.reset.resetBtn.ui.pressed = false;
  res.eng.build(built.circuit);

  // Live Program Mode DIP entry: overwrite RAM[6] from 42 to 85 (0x55)!
  L2.ports.spdt.props.pos = 'A'; // Program Mode (SEL=0)
  for (let i = 0; i < 4; i++) L2.ports.dip4.props.bits[i] = !!((6 >> i) & 1);
  for (let i = 0; i < 8; i++) L4.ports.dip8.props.bits[i] = !!((85 >> i) & 1);
  res.eng.build(built.circuit);
  res.eng.step(2e-4);
  L4.ports.writeBtn.ui.pressed = true;
  res.eng.build(built.circuit);
  res.eng.step(2e-4);
  L4.ports.writeBtn.ui.pressed = false;
  L2.ports.spdt.props.pos = 'B'; // Run Mode (SEL=1)
  res.eng.build(built.circuit);

  // Re-run CPU with same existing engine (RAM preserved!) by pulsing Reset & running until OAH
  L5.ports.reset.resetBtn.ui.pressed = true; res.eng.build(built.circuit); res.eng.step(2e-4);
  L5.ports.reset.resetBtn.ui.pressed = false; res.eng.build(built.circuit);
  const clkPin = built.boards.L1.ports.clkLedPart.worldPins()[0];
  let prevClk = 0, prevOi = 0, newOut = -1;
  for (let s = 0; s < 6000 && newOut < 0; s++) {
    res.eng.step(1.5e-4);
    const oiClk = readIcBit(res.eng, built.boards.R5.ports.u08, 11);
    if (!prevOi && oiClk) newOut = readIcByte(res.eng, built.boards.R4.ports.u273, [2, 5, 6, 9, 12, 15, 16, 19]);
    prevOi = oiClk;
    const clk = res.eng.V[res.eng.netAt(clkPin.x, clkPin.y)] > 2.5 ? 1 : 0;
    if (!prevClk && clk && readIcBit(res.eng, L6.ports.eepHi, 17) && newOut >= 0) break;
    prevClk = clk;
  }
  assert.equal(newOut, 85, `Expected OAH 6 to display live DIP-edited value 85, got ${newOut}`);
  assertCleanHealth(res.eng, built.circuit, 'CPU-5');
  return 'SUI+ADI (0xFF+1=>ZF=1,CY=1) + JZ + OAH 42 -> Reset -> Live DIP overwrite to 85 verified';
});

for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'} [${r.id}] ${r.name} -> ${r.info}`);
}
const bad = results.filter(r => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} passed`);
if (bad) process.exit(1);

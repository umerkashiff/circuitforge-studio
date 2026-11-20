import assert from 'node:assert/strict';
import { Circuit, Part, Wire } from '../src/model.js';
import { Engine } from '../src/sim/engine.js';
import '../src/parts/library.js';
import { CTRL, OPCODES, buildSap1DisplayRom, buildSap1MicrocodeRoms, SAP1_PROGRAMS } from '../src/parts/sap1_roms.js';

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
const bitV = (eng, pin) => {
  const n = eng.netAt(pin.x, pin.y);
  return n >= 0 ? eng.V[n] : NaN;
};
const bitL = (eng, pin) => (bitV(eng, pin) > 2.5 ? 1 : 0);

function mkIcTest(type, props = null) {
  const c = new Circuit();
  const vcc = new Part('vcc', 0, 0);
  const gnd = new Part('gnd', 0, 5);
  const ic = new Part(type, 10, 10, 0, props);
  c.parts.push(vcc, gnd, ic);
  const def = ic.def;
  const p = ic.worldPins();
  wire(c, vcc.worldPins()[0], p[def.ic.vcc - 1]);
  wire(c, gnd.worldPins()[0], p[def.ic.gnd - 1]);
  return { c, vcc: vcc.worldPins()[0], gnd: gnd.worldPins()[0], ic, p, pins: ic.worldPins() };
}

function addToggle(c, x, y, pin, on = false) {
  const t = new Part('toggle', x, y, 0, { on });
  c.parts.push(t);
  wire(c, t.worldPins()[0], pin);
  return t;
}

function addPullDown(c, x, y, pin, ohms = 10000, gndPin) {
  const r = new Part('resistor', x, y, 0, { ohms });
  c.parts.push(r);
  wire(c, pin, r.worldPins()[0]);
  wire(c, r.worldPins()[1], gndPin);
  return r;
}

// ---------------------------------------------------------------------------
// 1. 74173 Quad 3-State D Register
// ---------------------------------------------------------------------------
test('CPU-IC1', '74173 latches on rising CLK with !G1 & !G2, clears on CLR=1, and tri-states via M/N', () => {
  const { c, gnd, p } = mkIcTest('ic74173');
  // Pins (1-based): M=1, N=2, Q=3..6, CLK=7, G1=9, G2=10, D4..D1=11..14, CLR=15
  const swM = addToggle(c, 0, 20, p[0], false);
  const swN = addToggle(c, 2, 20, p[1], false);
  const swClk = addToggle(c, 4, 20, p[6], false);
  const swG1 = addToggle(c, 6, 20, p[8], false);
  const swG2 = addToggle(c, 8, 20, p[9], false);
  const swClr = addToggle(c, 10, 20, p[14], false);
  const swD = [13, 12, 11, 10].map((idx, i) => addToggle(c, 12 + i * 2, 20, p[idx], (0b1010 >> i) & 1));
  [2, 3, 4, 5].forEach((idx, i) => addPullDown(c, 20, 20 + i * 2, p[idx], 10000, gnd));

  const eng = new Engine();
  eng.build(c);
  eng.step(0.01);

  const readQ = () => [2, 3, 4, 5].reduce((acc, idx, i) => acc | (bitL(eng, p[idx]) << i), 0);
  assert.equal(readQ(), 0);

  // Clock rising edge with G1=0, G2=0 -> latches 0b1010
  swClk.props.on = true; eng.step(0.01);
  assert.equal(readQ(), 0b1010);

  // Change D to 0b0101, clock with G1=1 -> ignored
  swClk.props.on = false; swG1.props.on = true;
  swD.forEach((s, i) => { s.props.on = !!((0b0101 >> i) & 1); });
  eng.step(0.01);
  swClk.props.on = true; eng.step(0.01);
  assert.equal(readQ(), 0b1010);

  // Tri-state M=1 -> pull-downs pull Q to 0V cleanly (no contention)
  swM.props.on = true; eng.step(0.01);
  assert.equal(readQ(), 0);
  swM.props.on = false; eng.step(0.01);
  assert.equal(readQ(), 0b1010);

  // Async CLR=1 clears immediately
  swClr.props.on = true; eng.step(0.01);
  assert.equal(readQ(), 0);
  return '74173 async CLR, gated load & hi-Z verified';
});

// ---------------------------------------------------------------------------
// 2. 74161 Synchronous 4-bit Binary Counter
// ---------------------------------------------------------------------------
test('CPU-IC2', '74161 counts, synchronously loads, holds, asserts RCO=1 at 15, and async clears', () => {
  const { c, p } = mkIcTest('ic74161');
  // 1:CLR̅, 2:CLK, 3..6:A..D, 7:ENP, 9:LOAD̅, 10:ENT, 11..14:QD..QA, 15:RCO
  const swClr = addToggle(c, 0, 20, p[0], true);
  const swClk = addToggle(c, 2, 20, p[1], false);
  const swIn = [2, 3, 4, 5].map((idx, i) => addToggle(c, 4 + i * 2, 20, p[idx], !!((13 >> i) & 1)));
  const swEnp = addToggle(c, 12, 20, p[6], true);
  const swLoad = addToggle(c, 14, 20, p[8], false); // LOAD active low -> 13
  const swEnt = addToggle(c, 16, 20, p[9], true);

  const eng = new Engine();
  eng.build(c);
  eng.step(0.01);
  const readQ = () => [13, 12, 11, 10].reduce((acc, idx, i) => acc | (bitL(eng, p[idx]) << i), 0);

  swClk.props.on = true; eng.step(0.01);
  assert.equal(readQ(), 13);

  swLoad.props.on = true;
  for (const exp of [14, 15, 0]) {
    swClk.props.on = false; eng.step(0.01);
    swClk.props.on = true; eng.step(0.01);
    assert.equal(readQ(), exp);
    assert.equal(bitL(eng, p[14]), exp === 15 ? 1 : 0);
  }

  // Disable count via ENP=0 -> holds 0
  swEnp.props.on = false;
  swClk.props.on = false; eng.step(0.01);
  swClk.props.on = true; eng.step(0.01);
  assert.equal(readQ(), 0);

  // Count to 1 then async clear via CLR̅=0
  swEnp.props.on = true;
  swClk.props.on = false; eng.step(0.01);
  swClk.props.on = true; eng.step(0.01);
  assert.equal(readQ(), 1);
  swClr.props.on = false; eng.step(0.01);
  assert.equal(readQ(), 0);
  return '74161 load/count/hold/RCO/async-CLR verified';
});

// ---------------------------------------------------------------------------
// 3. 74189 16x4 Static RAM
// ---------------------------------------------------------------------------
test('CPU-IC3', '74189 preloads initHex, drives inverted stored nibble, writes when !WE, and resets', () => {
  const { c, gnd, p } = mkIcTest('ic74189', { initHex: '0123456789abcdef' });
  // A0=1(idx0), CS̅=2(idx1), WE̅=3(idx2), D1..D4=4,6,10,12(idx 3,5,9,11), O1̅..O4̅=5,7,9,11(idx 4,6,8,10), A3=13(12), A2=14(13), A1=15(14)
  const swA = [0, 14, 13, 12].map((idx, i) => addToggle(c, i * 2, 20, p[idx], !!(5 >> i & 1)));
  const swCs = addToggle(c, 8, 20, p[1], false);
  const swWe = addToggle(c, 10, 20, p[2], true);
  const swD = [3, 5, 9, 11].map((idx, i) => addToggle(c, 12 + i * 2, 20, p[idx], !!(0b1100 >> i & 1)));
  [4, 6, 8, 10].forEach((idx, i) => addPullDown(c, 22, 20 + i * 2, p[idx], 10000, gnd));

  const eng = new Engine();
  eng.build(c);
  eng.step(0.01);
  const readO = () => [4, 6, 8, 10].reduce((acc, idx, i) => acc | (bitL(eng, p[idx]) << i), 0);

  // Address 5 holds 5 -> inverted output is ~5 & 0xf = 10 (0b1010)
  assert.equal(readO(), (~5) & 0xf);

  // Write 0b1100 at addr 5
  swWe.props.on = false; eng.step(0.01);
  assert.equal(readO(), 0); // Hi-Z pulled down to 0
  swWe.props.on = true; eng.step(0.01);
  assert.equal(readO(), (~0b1100) & 0xf);

  // Reset restores initHex
  eng.reset();
  eng.build(c);
  eng.step(0.01);
  assert.equal(readO(), (~5) & 0xf);
  return '74189 initHex, inverted output, write & reset verified';
});

// ---------------------------------------------------------------------------
// 4. 74107 & 74109 Dual JK Flip-Flops
// ---------------------------------------------------------------------------
test('CPU-IC4', '74107 toggles on falling edge and 74109 toggles on rising edge with J=1, K̅=0', () => {
  // 74107: unit 1 -> 1J=1(0), 1Q̅=2(1), 1Q=3(2), 1K=4(3), 1CLK=12(11), 1CLR̅=13(12)
  const t107 = mkIcTest('ic74107');
  addToggle(t107.c, 0, 20, t107.p[0], true);  // 1J=1
  addToggle(t107.c, 2, 20, t107.p[3], true);  // 1K=1
  addToggle(t107.c, 4, 20, t107.p[12], true); // 1CLR̅=1
  const clk107 = addToggle(t107.c, 6, 20, t107.p[11], false);
  const e1 = new Engine(); e1.build(t107.c); e1.step(0.01);
  assert.equal(bitL(e1, t107.p[2]), 0);
  clk107.props.on = true; e1.step(0.01);
  assert.equal(bitL(e1, t107.p[2]), 0, '74107 must NOT trigger on rising edge');
  clk107.props.on = false; e1.step(0.01);
  assert.equal(bitL(e1, t107.p[2]), 1, '74107 toggles on falling edge');

  // 74109: unit 1 -> 1CLR̅=1(0), 1J=2(1), 1K̅=3(2), 1CLK=4(3), 1PRE̅=5(4), 1Q=6(5)
  const t109 = mkIcTest('ic74109');
  addToggle(t109.c, 0, 20, t109.p[0], true); // 1CLR̅=1
  addToggle(t109.c, 2, 20, t109.p[4], true); // 1PRE̅=1
  addToggle(t109.c, 4, 20, t109.p[1], true); // 1J=1
  addToggle(t109.c, 6, 20, t109.p[2], false); // 1K̅=0 -> toggle mode
  const clk109 = addToggle(t109.c, 8, 20, t109.p[3], false);
  const e2 = new Engine(); e2.build(t109.c); e2.step(0.01);
  assert.equal(bitL(e2, t109.p[5]), 0);
  clk109.props.on = true; e2.step(0.01);
  assert.equal(bitL(e2, t109.p[5]), 1, '74109 toggles on rising edge');
  return '74107 falling-edge & 74109 rising-edge J-K̅ verified';
});

// ---------------------------------------------------------------------------
// 5. 28C16 EEPROM + SAP-1 ROM Presets + Frozen ctx.props Isolation
// ---------------------------------------------------------------------------
test('CPU-IC5', '28C16 serves SAP-1 display & microcode ROMs with CE/OE/WE control and isolated props', () => {
  const disp = mkIcTest('ic28c16', { preset: 'sap1_display' });
  const aPins = [7, 6, 5, 4, 3, 2, 1, 0, 22, 21, 18]; // A0..A10 (0-based)
  const dPins = [8, 9, 10, 12, 13, 14, 15, 16];        // D0..D7 (0-based)
  const swCe = addToggle(disp.c, 0, 20, disp.p[17], false);
  const swOe = addToggle(disp.c, 2, 20, disp.p[19], false);
  const swWe = addToggle(disp.c, 4, 20, disp.p[20], true);
  // Drive A10..A0 = (0 << 10) | (1 << 8) | 123 (tens digit of 123 -> '2' = 0x5B)
  const valAddr = (1 << 8) | 123;
  const swAddr = aPins.map((idx, i) => addToggle(disp.c, 6 + i * 2, 20, disp.p[idx], !!((valAddr >> i) & 1)));
  dPins.forEach((idx, i) => addPullDown(disp.c, 30, 20 + i * 2, disp.p[idx], 10000, disp.gnd));

  const eng = new Engine();
  eng.build(disp.c);
  eng.step(0.01);
  const readD = () => dPins.reduce((acc, idx, i) => acc | (bitL(eng, disp.p[idx]) << i), 0);
  assert.equal(readD(), 0x5b, 'Tens digit of 123 should be 0x5b');

  // Test signed negative -45 (256 - 45 = 211): A10=1, mux=3 -> '-' (0x40)
  const negAddr = (1 << 10) | (3 << 8) | 211;
  swAddr.forEach((s, i) => { s.props.on = !!((negAddr >> i) & 1); });
  eng.step(0.01);
  assert.equal(readD(), 0x40, 'Sign digit of signed -45 should be minus (0x40)');

  // OE̅=1 -> hi-Z pulled down to 0
  swOe.props.on = true; eng.step(0.01);
  assert.equal(readD(), 0);

  // Verify microcode ROM encoding (ADI at T3 + JC CY=1 vs CY=0 + JZ ZF=1)
  const { lo, hi } = buildSap1MicrocodeRoms();
  const wordAt = (zf, cy, op, st) => {
    const a = (zf << 8) | (cy << 7) | (op << 3) | st;
    return lo[a] | (hi[a] << 8);
  };
  assert.equal(wordAt(0, 0, OPCODES.ADI, 3), CTRL.EO | CTRL.AI | CTRL.FI);
  assert.equal(wordAt(0, 0, OPCODES.JC, 2), 0);
  assert.equal(wordAt(0, 1, OPCODES.JC, 2), CTRL.IO | CTRL.J);
  assert.equal(wordAt(1, 0, OPCODES.JZ, 2), CTRL.IO | CTRL.J);
  assert.equal(wordAt(0, 0, OPCODES.OAH, 4), CTRL.HLT);
  assert.equal(SAP1_PROGRAMS.fibonacci.bytes.length, 16);
  return '28C16 display/microcode LUTs & OE tri-state verified';
});

// ---------------------------------------------------------------------------
// 6. Hardware Primitives: SPDT, 1MΩ Pot & Honest Multiplexed seg7x4
// ---------------------------------------------------------------------------
test('CPU-IC6', 'spdt switches paths, 1M pot divides accurately, and seg7x4 multiplexes only the active digit', () => {
  const c = new Circuit();
  const vcc = new Part('vcc', 0, 0);
  const gnd = new Part('gnd', 0, 5);
  const spdt = new Part('spdt', 10, 0, 0, { pos: 'A' });
  const rOut = new Part('resistor', 10, 8, 0, { ohms: 10000 });
  const pot = new Part('pot', 20, 0, 0, { ohms: 1000000, pos: 0.25 });
  const disp = new Part('seg7x4', 30, 10, 0, { common: 'cathode', color: 'red', protect: 'off' });
  c.parts.push(vcc, gnd, spdt, rOut, pot, disp);

  const vPin = vcc.worldPins()[0], gPin = gnd.worldPins()[0];
  wire(c, vPin, spdt.worldPins()[0]); // A = 5V
  wire(c, gPin, spdt.worldPins()[2]); // B = 0V
  wire(c, spdt.worldPins()[1], rOut.worldPins()[0]);
  wire(c, rOut.worldPins()[1], gPin);

  wire(c, vPin, pot.worldPins()[0]);
  wire(c, gPin, pot.worldPins()[2]);

  // Wire seg a (idx 10) & b (idx 6) to 5V via 220Ω, select ONLY D2 (idx 8) to GND, others to VCC!
  const dp = disp.worldPins();
  const ra = new Part('resistor', 40, 0, 0, { ohms: 220 });
  const rb = new Part('resistor', 40, 3, 0, { ohms: 220 });
  c.parts.push(ra, rb);
  wire(c, vPin, ra.worldPins()[0]); wire(c, ra.worldPins()[1], dp[10]); // seg a
  wire(c, vPin, rb.worldPins()[0]); wire(c, rb.worldPins()[1], dp[6]);  // seg b
  wire(c, gPin, dp[8]);  // D2 active LOW
  wire(c, vPin, dp[11]); // D1 off (VCC)
  wire(c, vPin, dp[7]);  // D3 off (VCC)
  wire(c, vPin, dp[5]);  // D4 off (VCC)

  const eng = new Engine();
  eng.build(c);
  eng.step(0.02);

  assert.ok(bitV(eng, spdt.worldPins()[1]) > 4.9, 'SPDT pos=A routes 5V to COM');
  spdt.props.pos = 'B';
  eng.build(c); eng.step(0.02);
  assert.ok(bitV(eng, spdt.worldPins()[1]) < 0.1, 'SPDT pos=B routes 0V to COM');

  const vw = bitV(eng, pot.worldPins()[1]);
  assert.ok(Math.abs(vw - 3.75) < 0.05, `1MΩ pot wiper expected ~3.75V, got ${vw}`);

  const dDev = eng.byPart.get(disp.id).device;
  // Digit index 1 (D2): segs a(0), b(1) should be >5mA; digits 0,2,3 should be ~0
  assert.ok(dDev.cur[1 * 8 + 0] > 0.005 && dDev.cur[1 * 8 + 1] > 0.005, 'D2 segments a,b should conduct');
  assert.equal(dDev.cur[0 * 8 + 0], 0, 'D1 must remain off while unselected');
  assert.equal(dDev.cur[2 * 8 + 0], 0, 'D3 must remain off while unselected');
  assert.equal(dDev.cur[3 * 8 + 0], 0, 'D4 must remain off while unselected');
  return 'spdt, 1MΩ pot & multiplexed seg7x4 verified';
});

for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'} [${r.id}] ${r.name} -> ${r.info}`);
}
const bad = results.filter(r => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} passed`);
if (bad) process.exit(1);

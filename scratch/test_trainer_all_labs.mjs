import assert from 'node:assert/strict';
import '../src/parts/library.js';
import '../src/mcu/boards.js';
import { Circuit, Board, Part, Wire } from '../src/model.js';
import { Engine } from '../src/sim/engine.js';

const results = [];
function record(lab, task, desc, pass, detail) {
  results.push({ lab, task, desc, pass, detail });
  console.log(`${pass ? '[PASS]' : '[FAIL]'} ${lab} - ${task}: ${desc} (${detail})`);
}

function makeTrainerSetup() {
  const c = new Circuit();
  const board = new Board('full', 0, 2);
  const trainer = new Part('trainer-board', 0, 0, 0);
  c.boards.push(board);
  c.parts.push(trainer);

  const pins = trainer.worldPins();
  const rowCursor = new Map();
  function pin(name, preferredRow = null) {
    const matches = pins.filter(p => p.name === name);
    assert.equal(matches.length, 4, `Expected 4 vertically linked sockets for trainer pin '${name}'`);
    if (preferredRow !== null) return matches[preferredRow];
    const idx = rowCursor.get(name) || 0;
    rowCursor.set(name, (idx + 1) % 4);
    return matches[idx];
  }

  function setSwitches(startIdx, count, value) {
    for (let i = 0; i < count; i++) {
      trainer.props.bits[startIdx + i] = Boolean((value >> i) & 1);
    }
  }

  function ledBit(eng, idx) {
    const dev = eng.byPart.get(trainer.id).device;
    return dev.ledLevels[idx] > 0.5 ? 1 : 0;
  }

  function ledBits(eng, indices) {
    let val = 0;
    for (let i = 0; i < indices.length; i++) {
      if (ledBit(eng, indices[i])) val |= (1 << i);
    }
    return val;
  }

  return { c, trainer, pin, setSwitches, ledBit, ledBits };
}

console.log('=====================================================');
console.log('TESTING ALL LABS (1-5) USING LAB TRAINER BOARD');
console.log('=====================================================');

// 1. Lab 1 Task 1: 7483 4-bit Binary Adder (S0..S3 + S4..S7 -> L0..L4)
{
  const { c, pin, setSwitches, ledBits } = makeTrainerSetup();
  const ic7483 = new Part('ic7483', 10, 12);
  c.parts.push(ic7483);
  const p83 = ic7483.worldPins();

  c.wires.push(new Wire(pin('+5V'), p83[4]));  // VCC
  c.wires.push(new Wire(pin('GND'), p83[11])); // GND
  c.wires.push(new Wire(pin('GND'), p83[12])); // Cin = 0

  const aPins = [9, 7, 2, 0];
  const bPins = [10, 6, 3, 15];
  const sPins = [8, 5, 1, 14, 13];
  for (let i = 0; i < 4; i++) {
    c.wires.push(new Wire(pin('S' + i), p83[aPins[i]]));
    c.wires.push(new Wire(pin('S' + (i + 4)), p83[bPins[i]]));
  }
  for (let i = 0; i < 5; i++) {
    c.wires.push(new Wire(p83[sPins[i]], pin('L' + i)));
  }

  const eng = new Engine();
  eng.build(c);
  let pass = true;
  for (let a = 0; a < 16; a += 3) {
    for (let b = 0; b < 16; b += 5) {
      setSwitches(0, 4, a);
      setSwitches(4, 4, b);
      eng.step(0.01);
      const got = ledBits(eng, [0, 1, 2, 3, 4]);
      if (got !== a + b) pass = false;
    }
  }
  record('Lab 1', 'Task 1a/1b', '7483 4-bit Adder via S0..S7 & L0..L4', pass, 'Trainer switches & LEDs match A+B');
}

// 2. Lab 1 Task 2: 7447 BCD to 7-Segment Display via S0..S3
{
  const { c, pin, setSwitches } = makeTrainerSetup();
  const ic7447 = new Part('ic7447', 10, 12);
  const seg7 = new Part('seg7', 28, 12, 0, { common: 'anode', color: 'red' });
  c.parts.push(ic7447, seg7);
  const p47 = ic7447.worldPins();
  const pSeg = seg7.worldPins();

  c.wires.push(new Wire(pin('+5V'), p47[15]));
  c.wires.push(new Wire(pin('GND'), p47[7]));
  c.wires.push(new Wire(pin('+5V'), p47[2])); // LT
  c.wires.push(new Wire(pin('+5V'), p47[3])); // BI
  c.wires.push(new Wire(pin('+5V'), p47[4])); // RBI
  c.wires.push(new Wire(pin('+5V'), pSeg[2])); // Common Anode

  c.wires.push(new Wire(pin('S0'), p47[6]));
  c.wires.push(new Wire(pin('S1'), p47[0]));
  c.wires.push(new Wire(pin('S2'), p47[1]));
  c.wires.push(new Wire(pin('S3'), p47[5]));

  const segMap = [[p47[12], pSeg[6]], [p47[11], pSeg[5]], [p47[10], pSeg[3]], [p47[9], pSeg[1]], [p47[8], pSeg[0]], [p47[14], pSeg[8]], [p47[13], pSeg[9]]];
  for (const [f, t] of segMap) c.wires.push(new Wire(f, t));

  const eng = new Engine();
  eng.build(c);
  const segDev = eng.byPart.get(seg7.id).device;
  let pass = true;
  for (let val = 0; val <= 12; val++) {
    setSwitches(0, 4, val);
    eng.step(0.01);
    let lit = 0;
    for (let i = 0; i < 7; i++) if (segDev.cur[i] > 0.001) lit |= (1 << i);
    if ((lit & 0x7F) === 0) pass = false;
  }
  record('Lab 1', 'Task 2a/2b', '7447 + 7-Seg via S0..S3 & +5V/GND', pass, 'Digits 0..12 driven');
}

// 3. Lab 2 Task 1: Signed & Unsigned Overflow via S0..S7 & L0..L4
{
  const { c, pin, setSwitches, ledBits } = makeTrainerSetup();
  const ic7483 = new Part('ic7483', 10, 12);
  c.parts.push(ic7483);
  const p83 = ic7483.worldPins();
  c.wires.push(new Wire(pin('+5V'), p83[4]), new Wire(pin('GND'), p83[11]), new Wire(pin('GND'), p83[12]));

  const aPins = [9, 7, 2, 0], bPins = [10, 6, 3, 15], sPins = [8, 5, 1, 14, 13];
  for (let i = 0; i < 4; i++) {
    c.wires.push(new Wire(pin('S' + i), p83[aPins[i]]), new Wire(pin('S' + (i + 4)), p83[bPins[i]]));
  }
  for (let i = 0; i < 5; i++) c.wires.push(new Wire(p83[sPins[i]], pin('L' + i)));

  const eng = new Engine();
  eng.build(c);
  const table = [
    [0b0011, 0b0000, false, false],
    [0b0011, 0b0101, false, true],
    [0b0011, 0b0111, false, true],
    [0b1000, 0b0101, false, false],
    [0b1011, 0b0101, true, false],
  ];
  let pass = true;
  for (const [a, b, expU, expS] of table) {
    setSwitches(0, 4, a);
    setSwitches(4, 4, b);
    eng.step(0.01);
    const out = ledBits(eng, [0, 1, 2, 3, 4]);
    const cout = Boolean((out >> 4) & 1);
    const signedOv = (((a >> 3) & 1) === ((b >> 3) & 1)) && (((out >> 3) & 1) !== ((a >> 3) & 1));
    if (cout !== expU || signedOv !== expS) pass = false;
  }
  record('Lab 2', 'Task 1b/1c', 'Signed/Unsigned Overflow via S0..S7 & L0..L4', pass, 'All overflow vectors verified');
}

// 4. Lab 2 Task 2: 2s Complement Subtractor using 7404 + 7483 via S0..S7 & L0..L3
{
  const { c, pin, setSwitches, ledBits } = makeTrainerSetup();
  const ic7404 = new Part('ic7404', 8, 12);
  const ic7483 = new Part('ic7483', 20, 12);
  c.parts.push(ic7404, ic7483);
  const p04 = ic7404.worldPins(), p83 = ic7483.worldPins();

  c.wires.push(new Wire(pin('+5V'), p04[13]), new Wire(pin('GND'), p04[6]));
  c.wires.push(new Wire(pin('+5V'), p83[4]), new Wire(pin('GND'), p83[11]), new Wire(pin('+5V'), p83[12]));

  const aPins = [9, 7, 2, 0], notIns = [0, 2, 4, 8], notOuts = [1, 3, 5, 7], bPins = [10, 6, 3, 15], sPins = [8, 5, 1, 14];
  for (let i = 0; i < 4; i++) {
    c.wires.push(new Wire(pin('S' + i), p83[aPins[i]]));
    c.wires.push(new Wire(pin('S' + (i + 4)), p04[notIns[i]]));
    c.wires.push(new Wire(p04[notOuts[i]], p83[bPins[i]]));
    c.wires.push(new Wire(p83[sPins[i]], pin('L' + i)));
  }

  const eng = new Engine();
  eng.build(c);
  const subTable = [[5, 0, 5], [5, 3, 2], [5, 6, 15], [8, 3, 5], [15, 3, 12]];
  let pass = true;
  for (const [x, y, exp] of subTable) {
    setSwitches(0, 4, x);
    setSwitches(4, 4, y);
    eng.step(0.01);
    if (ledBits(eng, [0, 1, 2, 3]) !== exp) pass = false;
  }
  record('Lab 2', 'Task 2a/2b/2c', '7404 + 7483 Subtractor via S0..S7 & L0..L3', pass, '2s complement subtractions exact');
}

// 5. Lab 3 Task 1: 74151 8:1 MUX via S0..S2, S4..S7 & L0
{
  const { c, pin, trainer, setSwitches, ledBit } = makeTrainerSetup();
  const ic74151 = new Part('ic74151', 12, 12);
  c.parts.push(ic74151);
  const p151 = ic74151.worldPins();

  c.wires.push(new Wire(pin('+5V'), p151[15]), new Wire(pin('GND'), p151[7]), new Wire(pin('GND'), p151[6]));
  c.wires.push(new Wire(pin('S0'), p151[10]), new Wire(pin('S1'), p151[9]), new Wire(pin('S2'), p151[8]));
  c.wires.push(new Wire(pin('GND'), p151[3]), new Wire(pin('GND'), p151[2]), new Wire(pin('+5V'), p151[1]), new Wire(pin('+5V'), p151[0]));
  c.wires.push(new Wire(pin('S4'), p151[14]), new Wire(pin('S5'), p151[13]), new Wire(pin('S6'), p151[12]), new Wire(pin('S7'), p151[11]));
  c.wires.push(new Wire(p151[4], pin('L0')));

  const eng = new Engine();
  eng.build(c);
  trainer.props.bits[4] = false; trainer.props.bits[5] = false;
  trainer.props.bits[6] = true; trainer.props.bits[7] = true;

  const exp = [0, 0, 1, 1, 0, 0, 1, 1];
  let pass = true;
  for (let s = 0; s < 8; s++) {
    setSwitches(0, 3, s);
    eng.step(0.01);
    if (ledBit(eng, 0) !== exp[s]) pass = false;
  }
  record('Lab 3', 'Task 1a/1b', '74151 8:1 MUX via S0..S2, S4..S7 & L0', pass, 'All 8 channels match');
}

// 6. Lab 3 Task 2: 74138 3:8 Demux via S0..S3 & L0..L7
{
  const { c, pin, trainer, setSwitches, ledBit } = makeTrainerSetup();
  const ic74138 = new Part('ic74138', 12, 12);
  c.parts.push(ic74138);
  const p138 = ic74138.worldPins();

  c.wires.push(new Wire(pin('+5V'), p138[15]), new Wire(pin('GND'), p138[7]), new Wire(pin('GND'), p138[4]), new Wire(pin('+5V'), p138[5]));
  c.wires.push(new Wire(pin('S3'), p138[3]));
  c.wires.push(new Wire(pin('S0'), p138[0]), new Wire(pin('S1'), p138[1]), new Wire(pin('S2'), p138[2]));
  const yPins = [14, 13, 12, 11, 10, 9, 8, 6];
  for (let i = 0; i < 8; i++) c.wires.push(new Wire(p138[yPins[i]], pin('L' + i)));

  const eng = new Engine();
  eng.build(c);
  let pass = true;
  for (let cba = 0; cba < 8; cba++) {
    setSwitches(0, 3, cba);
    trainer.props.bits[3] = false; // active-low G2A enabled
    eng.step(0.01);
    for (let i = 0; i < 8; i++) {
      if (ledBit(eng, i) !== (i === cba ? 0 : 1)) pass = false;
    }
    trainer.props.bits[3] = true; // disabled -> all HIGH
    eng.step(0.01);
    for (let i = 0; i < 8; i++) {
      if (ledBit(eng, i) !== 1) pass = false;
    }
  }
  record('Lab 3', 'Task 2a/2b', '74138 Demux via S0..S3 & L0..L7', pass, 'Active-low outputs verified on L0..L7');
}

// 7. Lab 3 Task 3: 74138 + 7408 Minterm Logic via S0..S2 & L0
{
  const { c, pin, setSwitches, ledBit } = makeTrainerSetup();
  const ic74138 = new Part('ic74138', 10, 12);
  const ic7408 = new Part('ic7408', 22, 12);
  c.parts.push(ic74138, ic7408);
  const p138 = ic74138.worldPins(), p08 = ic7408.worldPins();

  c.wires.push(new Wire(pin('+5V'), p138[15]), new Wire(pin('GND'), p138[7]), new Wire(pin('+5V'), p08[13]), new Wire(pin('GND'), p08[6]));
  c.wires.push(new Wire(pin('+5V'), p138[5]), new Wire(pin('GND'), p138[3]), new Wire(pin('GND'), p138[4]));
  c.wires.push(new Wire(pin('S0'), p138[0]), new Wire(pin('S1'), p138[1]), new Wire(pin('S2'), p138[2]));
  c.wires.push(new Wire(p138[14], p08[0]), new Wire(p138[13], p08[1]), new Wire(p138[10], p08[3]), new Wire(p138[9], p08[4]));
  c.wires.push(new Wire(p08[2], p08[8]), new Wire(p08[5], p08[9]), new Wire(p08[7], pin('L0')));

  const eng = new Engine();
  eng.build(c);
  const exp = [0, 0, 1, 1, 0, 0, 1, 1];
  let pass = true;
  for (let cba = 0; cba < 8; cba++) {
    setSwitches(0, 3, cba);
    eng.step(0.01);
    if (ledBit(eng, 0) !== exp[cba]) pass = false;
  }
  record('Lab 3', 'Task 3a/3b/3c', '74138 + 7408 Logic via S0..S2 & L0', pass, 'All 8 minterms match');
}

// 8. Lab 4 Task 1: 7483 + 7486 4-bit Adder/Subtractor via S0..S8 & L0..L3
{
  const { c, pin, trainer, setSwitches, ledBits } = makeTrainerSetup();
  const ic7486 = new Part('ic7486', 8, 12);
  const ic7483 = new Part('ic7483', 20, 12);
  c.parts.push(ic7486, ic7483);
  const p86 = ic7486.worldPins(), p83 = ic7483.worldPins();

  c.wires.push(new Wire(pin('+5V'), p86[13]), new Wire(pin('GND'), p86[6]), new Wire(pin('+5V'), p83[4]), new Wire(pin('GND'), p83[11]));
  c.wires.push(new Wire(pin('S8'), p83[12]));

  const xorIn1 = [0, 3, 9, 12], xorIn2 = [1, 4, 8, 11], xorOut = [2, 5, 7, 10];
  const aPins = [9, 7, 2, 0], bPins = [10, 6, 3, 15], sPins = [8, 5, 1, 14];
  for (let i = 0; i < 4; i++) {
    c.wires.push(new Wire(pin('S' + i), p83[aPins[i]]));
    c.wires.push(new Wire(pin('S' + (i + 4)), p86[xorIn1[i]]));
    c.wires.push(new Wire(pin('S8'), p86[xorIn2[i]]));
    c.wires.push(new Wire(p86[xorOut[i]], p83[bPins[i]]));
    c.wires.push(new Wire(p83[sPins[i]], pin('L' + i)));
  }

  const eng = new Engine();
  eng.build(c);
  const vectors = [[0b0011, 0b0101, 0, 0b1000], [0b0111, 0b0101, 0, 0b1100], [0b0110, 0b1000, 1, 0b1110], [0b0110, 0b1111, 1, 0b0111]];
  let pass = true;
  for (const [x, y, asMode, exp] of vectors) {
    setSwitches(0, 4, x);
    setSwitches(4, 4, y);
    trainer.props.bits[8] = (asMode === 1);
    eng.step(0.01);
    if (ledBits(eng, [0, 1, 2, 3]) !== exp) pass = false;
  }
  record('Lab 4', 'Task 1a/1b', '7483+7486 Adder/Subtractor via S0..S8 & L0..L3', pass, 'Add & Sub modes verified');
}

// 9. Lab 4 Task 2: Simplified SOP (x'z + xz' + yz') using Trainer S7, S7', S8, S9, S9' directly!
{
  const { c, pin, trainer, ledBit } = makeTrainerSetup();
  const ic7408 = new Part('ic7408', 10, 12);
  const ic7432 = new Part('ic7432', 22, 12);
  c.parts.push(ic7408, ic7432);
  const p08 = ic7408.worldPins(), p32 = ic7432.worldPins();

  c.wires.push(new Wire(pin('+5V'), p08[13]), new Wire(pin('GND'), p08[6]), new Wire(pin('+5V'), p32[13]), new Wire(pin('GND'), p32[6]));
  // AND1: x' (S7') * z (S9) -> pin 3 (idx 2)
  c.wires.push(new Wire(pin("S7'"), p08[0]), new Wire(pin('S9'), p08[1]));
  // AND2: x (S7) * z' (S9') -> pin 6 (idx 5)
  c.wires.push(new Wire(pin('S7'), p08[3]), new Wire(pin("S9'"), p08[4]));
  // AND3: y (S8) * z' (S9') -> pin 8 (idx 7)
  c.wires.push(new Wire(pin('S8'), p08[8]), new Wire(pin("S9'"), p08[9]));
  // OR1 + OR2 -> L0
  c.wires.push(new Wire(p08[2], p32[0]), new Wire(p08[5], p32[1]), new Wire(p32[2], p32[3]), new Wire(p08[7], p32[4]), new Wire(p32[5], pin('L0')));

  const eng = new Engine();
  eng.build(c);
  const expF = [0, 1, 1, 1, 1, 0, 1, 0];
  let pass = true;
  for (let xyz = 0; xyz < 8; xyz++) {
    trainer.props.bits[7] = Boolean((xyz >> 2) & 1);
    trainer.props.bits[8] = Boolean((xyz >> 1) & 1);
    trainer.props.bits[9] = Boolean(xyz & 1);
    eng.step(0.01);
    if (ledBit(eng, 0) !== expF[xyz]) pass = false;
  }
  record('Lab 4', 'Task 2a/2b', "Simplified SOP via Trainer S7/S7'/S8/S9/S9' & L0", pass, 'Built-in complements drive all 8 minterms cleanly');
}

// 10. Lab 5 Task 1: 555 Timer Astable powered by Trainer +5V/GND & monitored on L0
{
  const { c, pin, ledBit } = makeTrainerSetup();
  const ic555 = new Part('ne555', 10, 12);
  // Disjoint breadboard columns so leads do not short along vertical 5-hole strips
  const rA = new Part('resistor', 2, 14, 0, { ohms: 50000 });
  const rB = new Part('resistor', 18, 14, 0, { ohms: 50000 });
  const cap = new Part('capacitor', 26, 14, 0, { uf: 10 });
  c.parts.push(ic555, rA, rB, cap);

  const p5 = ic555.worldPins();
  c.wires.push(new Wire(pin('+5V'), p5[7]), new Wire(pin('GND'), p5[0]), new Wire(pin('+5V'), p5[3]));
  c.wires.push(new Wire(pin('+5V'), rA.worldPins()[0]), new Wire(rA.worldPins()[1], p5[6]));
  c.wires.push(new Wire(p5[6], rB.worldPins()[0]), new Wire(rB.worldPins()[1], p5[5]), new Wire(p5[5], p5[1]));
  c.wires.push(new Wire(p5[5], cap.worldPins()[0]), new Wire(cap.worldPins()[1], pin('GND')));
  c.wires.push(new Wire(p5[2], pin('L0')));

  const eng = new Engine();
  eng.build(c);
  let transitions = 0, prev = 0;
  for (let t = 0; t < 3.5; t += 0.005) {
    eng.step(0.005);
    const cur = ledBit(eng, 0);
    if (cur !== prev) { prev = cur; transitions++; }
  }
  record('Lab 5', 'Task 1', '555 Astable powered by Trainer +5V/GND -> L0', transitions >= 4, `${transitions} L0 transitions in 3.5s`);
}

// 11. Lab 5 Task 2a/2b: 7493 4-bit Counter + 7447 clocked by Trainer CLK -> L0..L3
{
  const { c, pin, ledBits } = makeTrainerSetup();
  const ic7493 = new Part('ic7493', 10, 12);
  const ic7447 = new Part('ic7447', 22, 12);
  const seg7 = new Part('seg7', 34, 12, 0, { common: 'anode', color: 'red' });
  c.parts.push(ic7493, ic7447, seg7);

  const p93 = ic7493.worldPins(), p47 = ic7447.worldPins(), pSeg = seg7.worldPins();
  c.wires.push(new Wire(pin('+5V'), p93[4]), new Wire(pin('GND'), p93[9]), new Wire(pin('+5V'), p47[15]), new Wire(pin('GND'), p47[7]), new Wire(pin('+5V'), pSeg[2]));
  c.wires.push(new Wire(pin('+5V'), p47[2]), new Wire(pin('+5V'), p47[3]), new Wire(pin('+5V'), p47[4]));
  c.wires.push(new Wire(pin('GND'), p93[1]), new Wire(pin('GND'), p93[2]));
  c.wires.push(new Wire(p93[11], p93[0]), new Wire(pin('CLK'), p93[13]));
  c.wires.push(new Wire(p93[11], p47[6]), new Wire(p93[8], p47[0]), new Wire(p93[7], p47[1]), new Wire(p93[10], p47[5]));
  c.wires.push(new Wire(p93[11], pin('L0')), new Wire(p93[8], pin('L1')), new Wire(p93[7], pin('L2')), new Wire(p93[10], pin('L3')));

  const segMap = [[p47[12], pSeg[6]], [p47[11], pSeg[5]], [p47[10], pSeg[3]], [p47[9], pSeg[1]], [p47[8], pSeg[0]], [p47[14], pSeg[8]], [p47[13], pSeg[9]]];
  for (const [f, t] of segMap) c.wires.push(new Wire(f, t));

  const eng = new Engine();
  eng.build(c);
  const seen = new Set();
  for (let s = 0; s < 680; s++) {
    eng.step(0.025); // 17 seconds of 1Hz Trainer CLK -> >16 cycles
    seen.add(ledBits(eng, [0, 1, 2, 3]));
  }
  record('Lab 5', 'Task 2a/2b', '7493+7447 clocked by Trainer CLK -> L0..L3', seen.size === 16, `Observed ${seen.size}/16 states on L0..L3`);
}

// 12. Lab 5 Task 2c: 7493 Modulo-10 clocked by Trainer P1 pushbutton -> L0..L3
{
  const { c, pin, trainer, ledBits } = makeTrainerSetup();
  const ic7493 = new Part('ic7493', 10, 12);
  c.parts.push(ic7493);
  const p93 = ic7493.worldPins();

  c.wires.push(new Wire(pin('+5V'), p93[4]), new Wire(pin('GND'), p93[9]));
  c.wires.push(new Wire(p93[11], p93[0]), new Wire(pin('P1'), p93[13]));
  c.wires.push(new Wire(p93[10], p93[1]), new Wire(p93[8], p93[2]));
  c.wires.push(new Wire(p93[11], pin('L0')), new Wire(p93[8], pin('L1')), new Wire(p93[7], pin('L2')), new Wire(p93[10], pin('L3')));

  const eng = new Engine();
  eng.build(c);
  const seq = [];
  eng.step(0.01);
  seq.push(ledBits(eng, [0, 1, 2, 3])); // 0
  for (let pulse = 0; pulse < 11; pulse++) {
    trainer.ui.pressKey = 'p1';
    eng.step(0.01);
    trainer.ui.pressKey = null;
    eng.step(0.01);
    seq.push(ledBits(eng, [0, 1, 2, 3]));
  }
  const expectedSeq = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 1];
  const mod10Pass = JSON.stringify(seq) === JSON.stringify(expectedSeq);
  record('Lab 5', 'Task 2c', '7493 Mod-10 clocked by Trainer P1 -> L0..L3', mod10Pass, `Count sequence: ${seq.join(',')}`);
}

const passed = results.filter(r => r.pass).length;
console.log(`\nTrainer Board Lab Verification: ${passed} / ${results.length} passed`);
assert.equal(passed, 12, 'All 12 lab tasks must pass on the Lab Trainer Board');

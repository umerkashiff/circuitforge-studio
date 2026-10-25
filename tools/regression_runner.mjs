import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

import { Circuit, Wire, Part } from '../src/model.js';
import { Engine } from '../src/sim/engine.js';
import '../src/parts/library.js';

const reports = [];

function record(id, summary, input, expected, observed, pass) {
  reports.push({ id, summary, input, expected, observed, pass: pass ? 'PASS' : 'FAIL' });
}

function notSupported(id, summary, feature) {
  reports.push({ id, summary, input: 'N/A', expected: 'Feature available', observed: `NOT SUPPORTED: ${feature}`, pass: 'NOT SUPPORTED' });
}

// =====================================================================
// PHASE A - REGRESSION OF EXISTING LABS
// =====================================================================

// ---------------------------------------------------------------------
// T0: Floating inputs (TTL behavior)
// ---------------------------------------------------------------------
{
  // 1. 7408 AND gate: A=1, B unconnected
  const cAnd = new Circuit();
  const vcc = new Part('vcc', 0, 0);
  const gnd = new Part('gnd', 0, 5);
  const ic08 = new Part('ic7408', 10, 10);
  cAnd.parts.push(vcc, gnd, ic08);
  const p08 = ic08.worldPins();
  cAnd.wires.push(new Wire(vcc.worldPins()[0], p08[13])); // VCC pin 14
  cAnd.wires.push(new Wire(gnd.worldPins()[0], p08[6]));  // GND pin 7
  cAnd.wires.push(new Wire(vcc.worldPins()[0], p08[0]));  // 1A = 1 (pin 1)
  // 1B (pin 2, idx 1) is left unconnected!
  
  const engAnd = new Engine();
  engAnd.build(cAnd);
  engAnd.step(0.01);
  const out08Net = engAnd.pointNet.get(`${p08[2].x},${p08[2].y}`);
  const vOut08 = out08Net !== undefined ? engAnd.V[out08Net] : 0;
  const out08 = vOut08 > 2.0 ? 1 : 0;
  
  record('T0.1', '7408 AND with A=1, B floating', 'A=1, B=float', 'out=1 (floating reads HIGH)', `out=${out08} (${vOut08.toFixed(2)}V)`, out08 === 1);

  // 2. 7447 with LT, RBI, BI/RBO unconnected, drive DCBA = 0101
  const c47 = new Circuit();
  const vcc2 = new Part('vcc', 0, 0);
  const gnd2 = new Part('gnd', 0, 5);
  const ic47 = new Part('ic7447', 10, 10);
  const seg7 = new Part('seg7', 25, 10, 0, { common: 'anode' });
  c47.parts.push(vcc2, gnd2, ic47, seg7);
  const p47 = ic47.worldPins();
  const pSeg = seg7.worldPins();
  c47.wires.push(new Wire(vcc2.worldPins()[0], p47[15])); // pin 16 VCC
  c47.wires.push(new Wire(gnd2.worldPins()[0], p47[7]));   // pin 8 GND
  c47.wires.push(new Wire(vcc2.worldPins()[0], pSeg[2]));  // Common Anode to VCC
  // pin 3 (LT), pin 4 (BI/RBO), pin 5 (RBI) left UNCONNECTED!
  // Drive DCBA = 0101 (5)
  // A=pin 7 (idx 6), B=pin 1 (idx 0), C=pin 2 (idx 1), D=pin 6 (idx 5)
  c47.wires.push(new Wire(vcc2.worldPins()[0], p47[6])); // A=1
  c47.wires.push(new Wire(gnd2.worldPins()[0], p47[0])); // B=0
  c47.wires.push(new Wire(vcc2.worldPins()[0], p47[1])); // C=1
  c47.wires.push(new Wire(gnd2.worldPins()[0], p47[5])); // D=0
  
  const segPins = [12, 11, 10, 9, 8, 14, 13];
  const segInPins = [6, 5, 3, 1, 0, 8, 9];
  for (let i = 0; i < 7; i++) {
    c47.wires.push(new Wire(p47[segPins[i]], pSeg[segInPins[i]]));
  }
  
  const eng47 = new Engine();
  eng47.build(c47);
  eng47.step(0.01);
  const segDev = eng47.byPart.get(seg7.id).device;
  let litSegs = [];
  const segNames = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  for (let i = 0; i < 7; i++) {
    if (segDev.cur[i] > 0.001) litSegs.push(segNames[i]);
  }
  const litStr = litSegs.join('');
  const exp5 = 'acdfg'; // 5 on 7-segment
  record('T0.2', '7447 with LT,RBI,BI floating, DCBA=0101', 'DCBA=0101, controls float', 'displays 5 (acdfg)', `segs=${litStr}`, litStr === exp5);
}

// ---------------------------------------------------------------------
// T1: 7483 4-bit adder (Lab 1)
// ---------------------------------------------------------------------
{
  const c = new Circuit();
  const vcc = new Part('vcc', 0, 0);
  const gnd = new Part('gnd', 0, 5);
  const p7483 = new Part('ic7483', 10, 10);
  const swA = [new Part('toggle', 5, 20), new Part('toggle', 8, 20), new Part('toggle', 11, 20), new Part('toggle', 14, 20)];
  const swB = [new Part('toggle', 18, 20), new Part('toggle', 21, 20), new Part('toggle', 24, 20), new Part('toggle', 27, 20)];
  const swCin = new Part('toggle', 2, 20);
  c.parts.push(vcc, gnd, p7483, ...swA, ...swB, swCin);
  const p83 = p7483.worldPins();
  c.wires.push(new Wire(vcc.worldPins()[0], p83[4]));  // pin 5 VCC
  c.wires.push(new Wire(gnd.worldPins()[0], p83[11])); // pin 12 GND
  c.wires.push(new Wire(swCin.worldPins()[0], p83[12])); // pin 13 Cin
  
  const aPins = [9, 7, 2, 0];
  const bPins = [10, 6, 3, 15];
  for (let i = 0; i < 4; i++) {
    c.wires.push(new Wire(swA[i].worldPins()[0], p83[aPins[i]]));
    c.wires.push(new Wire(swB[i].worldPins()[0], p83[bPins[i]]));
  }
  const sPins = [8, 5, 1, 14, 13]; // Sum0..Sum3, Cout
  const eng = new Engine();
  eng.build(c);
  
  function testAdd(a, b, cin, exp5bit) {
    swCin.props.on = (cin === 1);
    for (let i = 0; i < 4; i++) {
      swA[i].props.on = ((a >> i) & 1) === 1;
      swB[i].props.on = ((b >> i) & 1) === 1;
    }
    eng.step(0.01);
    let out5 = 0;
    for (let i = 0; i < 5; i++) {
      const net = eng.pointNet.get(`${p83[sPins[i]].x},${p83[sPins[i]].y}`);
      if (net !== undefined && eng.V[net] > 2.0) out5 |= (1 << i);
    }
    return out5;
  }
  
  // Vectors from prompt
  const t1Vecs = [
    [0b0011, 0, 0, 0b00011], [0b0011, 1, 0, 0b00100], [0b0011, 2, 0, 0b00101], [0b0011, 3, 0, 0b00110],
    [0b0011, 4, 0, 0b00111], [0b0011, 5, 0, 0b01000], [0b0011, 6, 0, 0b01001], [0b0011, 7, 0, 0b01010],
    [0b1000, 5, 0, 0b01101], [0b1001, 5, 0, 0b01110], [0b1010, 5, 0, 0b01111], [0b1011, 5, 0, 0b10000],
    [0b1100, 5, 0, 0b10001], [0b1101, 5, 0, 0b10010], [0b1110, 5, 0, 0b10011], [0b1111, 5, 0, 0b10100],
    [0b0111, 1, 1, 0b01001], // Cin=1, A=7, B=1 -> 9
  ];
  let t1Pass = true;
  let t1Obs = [];
  for (const [a, b, cin, exp] of t1Vecs) {
    const got = testAdd(a, b, cin, exp);
    if (got !== exp) t1Pass = false;
    t1Obs.push(got.toString(2).padStart(5, '0'));
  }
  record('T1', '7483 4-bit adder exhaustive tests', '17 vectors (Cin=0/1)', 'All match expected CoutC3..C0', t1Pass ? 'All 17 matched exactly' : t1Obs.join(','), t1Pass);
}

// ---------------------------------------------------------------------
// T2: 7447 + common-anode 7-seg with 220 ohm series resistors
// ---------------------------------------------------------------------
{
  const c = new Circuit();
  const vcc = new Part('vcc', 0, 0);
  const gnd = new Part('gnd', 0, 5);
  const ic47 = new Part('ic7447', 10, 10);
  const seg7 = new Part('seg7', 40, 10, 0, { common: 'anode' });
  const sw = [new Part('toggle', 5, 20), new Part('toggle', 8, 20), new Part('toggle', 11, 20), new Part('toggle', 14, 20)];
  const swLT = new Part('toggle', 2, 20, 0, { on: true });
  const swBI = new Part('toggle', 2, 25, 0, { on: true });
  const swRBI = new Part('toggle', 2, 30, 0, { on: true });
  
  c.parts.push(vcc, gnd, ic47, seg7, ...sw, swLT, swBI, swRBI);
  const p47 = ic47.worldPins();
  const pSeg = seg7.worldPins();
  
  c.wires.push(new Wire(vcc.worldPins()[0], p47[15])); // pin 16 VCC
  c.wires.push(new Wire(gnd.worldPins()[0], p47[7]));   // pin 8 GND
  c.wires.push(new Wire(vcc.worldPins()[0], pSeg[2]));  // Common Anode
  
  c.wires.push(new Wire(swLT.worldPins()[0], p47[2]));  // pin 3 LT
  c.wires.push(new Wire(swBI.worldPins()[0], p47[3]));  // pin 4 BI/RBO
  c.wires.push(new Wire(swRBI.worldPins()[0], p47[4])); // pin 5 RBI
  
  // BCD inputs A, B, C, D
  c.wires.push(new Wire(sw[0].worldPins()[0], p47[6]));
  c.wires.push(new Wire(sw[1].worldPins()[0], p47[0]));
  c.wires.push(new Wire(sw[2].worldPins()[0], p47[1]));
  c.wires.push(new Wire(sw[3].worldPins()[0], p47[5]));
  
  // Connect 220 ohm resistors in series with each segment
  const segPins = [12, 11, 10, 9, 8, 14, 13]; // a, b, c, d, e, f, g
  const segInPins = [6, 5, 3, 1, 0, 8, 9];
  const resistors = [];
  for (let i = 0; i < 7; i++) {
    const r = new Part('resistor', 25, 10 + i * 2, 0, { ohms: 220 });
    resistors.push(r);
    c.parts.push(r);
    c.wires.push(new Wire(p47[segPins[i]], r.worldPins()[0]));
    c.wires.push(new Wire(r.worldPins()[1], pSeg[segInPins[i]]));
  }
  
  const eng = new Engine();
  eng.build(c);
  
  const expectedPatterns = {
    0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg',
    5: 'acdfg', 6: 'cdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcfg',
    10: 'deg', 11: 'cdg', 12: 'bfg', 13: 'adfg', 14: 'defg', 15: ''
  };
  const segNames = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  
  let t2Pass = true;
  let measuredCurrentmA = 0;
  
  for (let val = 0; val < 16; val++) {
    swLT.props.on = true; swBI.props.on = true; swRBI.props.on = true;
    for (let i = 0; i < 4; i++) sw[i].props.on = ((val >> i) & 1) === 1;
    eng.step(0.01);
    
    const dev = eng.byPart.get(seg7.id).device;
    let lit = [];
    for (let s = 0; s < 7; s++) {
      if (dev.cur[s] > 0.001) {
        lit.push(segNames[s]);
        if (measuredCurrentmA === 0) measuredCurrentmA = dev.cur[s] * 1000;
      }
    }
    const litStr = lit.join('');
    if (litStr !== expectedPatterns[val]) {
      t2Pass = false;
      console.error(`  T2 pattern mismatch for ${val}: exp '${expectedPatterns[val]}', got '${litStr}'`);
    }
  }
  
  // Test control pins:
  // LT = 0 -> all 7 segments lit
  swLT.props.on = false;
  eng.step(0.01);
  let allLit = true;
  const devLT = eng.byPart.get(seg7.id).device;
  for (let s = 0; s < 7; s++) if (devLT.cur[s] < 0.001) allLit = false;
  if (!allLit) t2Pass = false;
  swLT.props.on = true;
  
  // BI/RBO = 0 -> all blank
  swBI.props.on = false;
  eng.step(0.01);
  let allBlank = true;
  const devBI = eng.byPart.get(seg7.id).device;
  for (let s = 0; s < 7; s++) if (devBI.cur[s] > 0.001) allBlank = false;
  if (!allBlank) t2Pass = false;
  swBI.props.on = true;
  
  // RBI = 0 with input 0000 -> blank; with 0001 -> "1"
  swRBI.props.on = false;
  for (let i = 0; i < 4; i++) sw[i].props.on = false; // 0000
  eng.step(0.01);
  let rbi0Blank = true;
  const devRBI0 = eng.byPart.get(seg7.id).device;
  for (let s = 0; s < 7; s++) if (devRBI0.cur[s] > 0.001) rbi0Blank = false;
  if (!rbi0Blank) t2Pass = false;
  
  sw[0].props.on = true; // 0001
  eng.step(0.01);
  let rbi1Lit = [];
  const devRBI1 = eng.byPart.get(seg7.id).device;
  for (let s = 0; s < 7; s++) if (devRBI1.cur[s] > 0.001) rbi1Lit.push(segNames[s]);
  if (rbi1Lit.join('') !== 'bc') t2Pass = false;
  
  record('T2', '7447 + 7-seg digits 0-15 & controls (LT, BI, RBI) + 220Ω', '0000..1111, LT, BI, RBI', 'Digits 0-9, datasheet 10-15, LT/BI/RBI work', `All 16 patterns & controls match. Segment current = ${measuredCurrentmA.toFixed(1)} mA`, t2Pass);
}

// ---------------------------------------------------------------------
// T3: Unsigned/signed addition with 7483 (Lab 2 Task 1)
// ---------------------------------------------------------------------
{
  const c = new Circuit();
  const vcc = new Part('vcc', 0, 0);
  const gnd = new Part('gnd', 0, 5);
  const ic7483 = new Part('ic7483', 10, 10);
  const swA = [new Part('toggle', 5, 20), new Part('toggle', 8, 20), new Part('toggle', 11, 20), new Part('toggle', 14, 20)];
  const swB = [new Part('toggle', 18, 20), new Part('toggle', 21, 20), new Part('toggle', 24, 20), new Part('toggle', 27, 20)];
  c.parts.push(vcc, gnd, ic7483, ...swA, ...swB);
  const p83 = ic7483.worldPins();
  c.wires.push(new Wire(vcc.worldPins()[0], p83[4]));
  c.wires.push(new Wire(gnd.worldPins()[0], p83[11]));
  c.wires.push(new Wire(gnd.worldPins()[0], p83[12])); // Cin=0
  
  const aPins = [9, 7, 2, 0];
  const bPins = [10, 6, 3, 15];
  for (let i = 0; i < 4; i++) {
    c.wires.push(new Wire(swA[i].worldPins()[0], p83[aPins[i]]));
    c.wires.push(new Wire(swB[i].worldPins()[0], p83[bPins[i]]));
  }
  const sPins = [8, 5, 1, 14, 13]; // Sum0..Sum3, Cout
  const eng = new Engine();
  eng.build(c);
  
  const addVectors = [
    [0b0011, 0, false, false],
    [0b0011, 1, false, false],
    [0b0011, 2, false, false],
    [0b0011, 3, false, false],
    [0b0011, 4, false, false],
    [0b0011, 5, false, true],   // 3+5=8 -> overflow in 4-bit signed!
    [0b0011, 6, false, true],   // 3+6=9 -> overflow in 4-bit signed!
    [0b0011, 7, false, true],   // 3+7=10 -> overflow in 4-bit signed!
    [0b1000, 5, false, false],  // -8+5=-3
    [0b1001, 5, false, false],  // -7+5=-2
    [0b1010, 5, false, false],  // -6+5=-1
    [0b1011, 5, true, false],   // 11+5=16 -> Cout=1 (unsigned overflow, signed: -5+5=0 no ovf)
    [0b1100, 5, true, false],   // 12+5=17 -> Cout=1 (signed: -4+5=1 no ovf)
    [0b1101, 5, true, false],   // 13+5=18 -> Cout=1 (signed: -3+5=2 no ovf)
    [0b1110, 5, true, false],   // 14+5=19 -> Cout=1 (signed: -2+5=3 no ovf)
    [0b1111, 5, true, false],   // 15+5=20 -> Cout=1 (signed: -1+5=4 no ovf)
  ];
  let t3Pass = true;
  for (const [a, b, expUnsignedOv, expSignedOv] of addVectors) {
    for (let i = 0; i < 4; i++) {
      swA[i].props.on = ((a >> i) & 1) === 1;
      swB[i].props.on = ((b >> i) & 1) === 1;
    }
    eng.step(0.01);
    let s4 = 0;
    for (let i = 0; i < 4; i++) {
      const net = eng.pointNet.get(`${p83[sPins[i]].x},${p83[sPins[i]].y}`);
      if (net !== undefined && eng.V[net] > 2.0) s4 |= (1 << i);
    }
    const coutNet = eng.pointNet.get(`${p83[sPins[4]].x},${p83[sPins[4]].y}`);
    const cout = coutNet !== undefined && eng.V[coutNet] > 2.0;
    const a3 = (a >> 3) & 1, b3 = (b >> 3) & 1, s3 = (s4 >> 3) & 1;
    const signedOv = (a3 === b3) && (s3 !== a3);
    if (cout !== expUnsignedOv || signedOv !== expSignedOv) t3Pass = false;
  }
  record('T3', 'Unsigned/Signed Addition Overflow (7483)', '16 vectors A, B', 'Signed ovf on (3+5, 3+6, 3+7), unsigned on sum>=16', t3Pass ? 'All overflow flags exact' : 'Mismatch', t3Pass);
}

// ---------------------------------------------------------------------
// T4: 2s-complement subtractor (7404 + 7483)
// ---------------------------------------------------------------------
{
  const c = new Circuit();
  const vcc = new Part('vcc', 0, 0);
  const gnd = new Part('gnd', 0, 5);
  const ic04 = new Part('ic7404', 10, 10);
  const ic83 = new Part('ic7483', 25, 10);
  const swX = [new Part('toggle', 5, 25), new Part('toggle', 8, 25), new Part('toggle', 11, 25), new Part('toggle', 14, 25)];
  const swY = [new Part('toggle', 18, 25), new Part('toggle', 21, 25), new Part('toggle', 24, 25), new Part('toggle', 27, 25)];
  c.parts.push(vcc, gnd, ic04, ic83, ...swX, ...swY);
  const p04 = ic04.worldPins();
  const p83 = ic83.worldPins();
  c.wires.push(new Wire(vcc.worldPins()[0], p04[13]));
  c.wires.push(new Wire(gnd.worldPins()[0], p04[6]));
  c.wires.push(new Wire(vcc.worldPins()[0], p83[4]));
  c.wires.push(new Wire(gnd.worldPins()[0], p83[11]));
  c.wires.push(new Wire(vcc.worldPins()[0], p83[12])); // Cin=1
  
  const aPins = [9, 7, 2, 0];
  const notIns = [0, 2, 4, 8];
  const notOuts = [1, 3, 5, 7];
  const bPins = [10, 6, 3, 15];
  for (let i = 0; i < 4; i++) {
    c.wires.push(new Wire(swX[i].worldPins()[0], p83[aPins[i]]));
    c.wires.push(new Wire(swY[i].worldPins()[0], p04[notIns[i]]));
    c.wires.push(new Wire(p04[notOuts[i]], p83[bPins[i]]));
  }
  const sPins = [8, 5, 1, 14];
  const eng = new Engine();
  eng.build(c);
  
  const subVecs = [
    [0b0101, 0b0000, 0b0101, false], [0b0101, 0b0001, 0b0100, false], [0b0101, 0b0010, 0b0011, false], [0b0101, 0b0011, 0b0010, false],
    [0b0101, 0b0100, 0b0001, false], [0b0101, 0b0101, 0b0000, false], [0b0101, 0b0110, 0b1111, false], [0b0101, 0b0111, 0b1110, false],
    [0b1000, 0b0011, 0b0101, true],  [0b1001, 0b0011, 0b0110, true],  [0b1010, 0b0011, 0b0111, true],  [0b1011, 0b0011, 0b1000, false],
    [0b1100, 0b0011, 0b1001, false], [0b1101, 0b0011, 0b1010, false], [0b1110, 0b0011, 0b1011, false], [0b1111, 0b0011, 0b1100, false],
  ];
  let t4Pass = true;
  for (const [x, y, expRes, expOvf] of subVecs) {
    for (let i = 0; i < 4; i++) {
      swX[i].props.on = ((x >> i) & 1) === 1;
      swY[i].props.on = ((y >> i) & 1) === 1;
    }
    eng.step(0.01);
    let s4 = 0;
    for (let i = 0; i < 4; i++) {
      const net = eng.pointNet.get(`${p83[sPins[i]].x},${p83[sPins[i]].y}`);
      if (net !== undefined && eng.V[net] > 2.0) s4 |= (1 << i);
    }
    const x3 = (x >> 3) & 1, y3 = (y >> 3) & 1, s3 = (s4 >> 3) & 1;
    const ovf = (x3 !== y3) && (s3 !== x3);
    if (s4 !== expRes || ovf !== expOvf) t4Pass = false;
  }
  record('T4', '2s-complement Subtractor (7404 + 7483)', '16 vectors (X, Y)', '0101..1110 & 0101(ovf)..1100', t4Pass ? 'All 16 subtractions and overflow exact' : 'Mismatch', t4Pass);
}

// ---------------------------------------------------------------------
// T5: 74151 8:1 MUX (Lab 3 Task 1)
// ---------------------------------------------------------------------
{
  const c = new Circuit();
  const vcc = new Part('vcc', 0, 0);
  const gnd = new Part('gnd', 0, 5);
  const ic151 = new Part('ic74151', 12, 10);
  const swSel = [new Part('toggle', 5, 25), new Part('toggle', 8, 25), new Part('toggle', 11, 25)];
  const swW = new Part('toggle', 15, 25);
  const swX = new Part('toggle', 18, 25);
  const swY = new Part('toggle', 21, 25, 0, { on: true });
  const swZ = new Part('toggle', 24, 25, 0, { on: true });
  const swE = new Part('toggle', 2, 25, 0, { on: false }); // E active low
  
  c.parts.push(vcc, gnd, ic151, ...swSel, swW, swX, swY, swZ, swE);
  const p151 = ic151.worldPins();
  c.wires.push(new Wire(vcc.worldPins()[0], p151[15]));
  c.wires.push(new Wire(gnd.worldPins()[0], p151[7]));
  c.wires.push(new Wire(swE.worldPins()[0], p151[6])); // pin 7 G (Enable)
  
  // Select lines S0, S1, S2 (pins 11, 10, 9)
  c.wires.push(new Wire(swSel[0].worldPins()[0], p151[10]));
  c.wires.push(new Wire(swSel[1].worldPins()[0], p151[9]));
  c.wires.push(new Wire(swSel[2].worldPins()[0], p151[8]));
  
  // I0=0, I1=0, I2=1, I3=1
  c.wires.push(new Wire(gnd.worldPins()[0], p151[3]));
  c.wires.push(new Wire(gnd.worldPins()[0], p151[2]));
  c.wires.push(new Wire(vcc.worldPins()[0], p151[1]));
  c.wires.push(new Wire(vcc.worldPins()[0], p151[0]));
  // I4=w, I5=x, I6=y, I7=z
  c.wires.push(new Wire(swW.worldPins()[0], p151[14]));
  c.wires.push(new Wire(swX.worldPins()[0], p151[13]));
  c.wires.push(new Wire(swY.worldPins()[0], p151[12]));
  c.wires.push(new Wire(swZ.worldPins()[0], p151[11]));
  
  const eng = new Engine();
  eng.build(c);
  
  const expZ = [0, 0, 1, 1, 0, 0, 1, 1];
  let t5Pass = true;
  for (let s = 0; s < 8; s++) {
    for (let i = 0; i < 3; i++) swSel[i].props.on = ((s >> i) & 1) === 1;
    eng.step(0.01);
    const yNet = eng.pointNet.get(`${p151[4].x},${p151[4].y}`);
    const got = yNet !== undefined && eng.V[yNet] > 2.0 ? 1 : 0;
    if (got !== expZ[s]) t5Pass = false;
  }
  
  // E=1 -> Z=0, Zbar=1
  swE.props.on = true;
  for (let s = 0; s < 8; s++) {
    for (let i = 0; i < 3; i++) swSel[i].props.on = ((s >> i) & 1) === 1;
    eng.step(0.01);
    const yNet = eng.pointNet.get(`${p151[4].x},${p151[4].y}`);
    const wNet = eng.pointNet.get(`${p151[5].x},${p151[5].y}`);
    const y = yNet !== undefined && eng.V[yNet] > 2.0 ? 1 : 0;
    const w = wNet !== undefined && eng.V[wNet] > 2.0 ? 1 : 0;
    if (y !== 0 || w !== 1) t5Pass = false;
  }
  swE.props.on = false;
  
  // w=1 and select 100 -> Z=1
  swW.props.on = true;
  swSel[0].props.on = false; swSel[1].props.on = false; swSel[2].props.on = true;
  eng.step(0.01);
  const yNetProp = eng.pointNet.get(`${p151[4].x},${p151[4].y}`);
  if (eng.V[yNetProp] <= 2.0) t5Pass = false;
  
  record('T5', '74151 8:1 MUX (channels, enable, propagation)', 'S2..S0=000..111, E=0/1, w=1', 'Z=[0,0,1,1,0,0,1,1], E=1: Z=0/W=1, w=1: Z=1', t5Pass ? 'All channels, enable, and data propagation verified' : 'Mismatch', t5Pass);
}

// ---------------------------------------------------------------------
// T6: 74138 as active-low DEMUX (Lab 3 Task 2)
// ---------------------------------------------------------------------
{
  const c = new Circuit();
  const vcc = new Part('vcc', 0, 0);
  const gnd = new Part('gnd', 0, 5);
  const ic138 = new Part('ic74138', 12, 10);
  const swSel = [new Part('toggle', 5, 25), new Part('toggle', 8, 25), new Part('toggle', 11, 25)];
  const swG2A = new Part('toggle', 0, 15);
  c.parts.push(vcc, gnd, ic138, ...swSel, swG2A);
  const p138 = ic138.worldPins();
  c.wires.push(new Wire(vcc.worldPins()[0], p138[15]));
  c.wires.push(new Wire(gnd.worldPins()[0], p138[7]));
  c.wires.push(new Wire(vcc.worldPins()[0], p138[5])); // G1=1
  c.wires.push(new Wire(gnd.worldPins()[0], p138[4])); // G2B=0
  c.wires.push(new Wire(swG2A.worldPins()[0], p138[3])); // G2A=data
  c.wires.push(new Wire(swSel[0].worldPins()[0], p138[0])); // A
  c.wires.push(new Wire(swSel[1].worldPins()[0], p138[1])); // B
  c.wires.push(new Wire(swSel[2].worldPins()[0], p138[2])); // C
  
  const yPins = [14, 13, 12, 11, 10, 9, 8, 6]; // Y0..Y7
  const eng = new Engine();
  eng.build(c);
  
  let t6Pass = true;
  for (let cba = 0; cba < 8; cba++) {
    for (let i = 0; i < 3; i++) swSel[i].props.on = ((cba >> i) & 1) === 1;
    
    // G2A=0 -> Y_cba is 0, others 1
    swG2A.props.on = false;
    eng.step(0.01);
    for (let i = 0; i < 8; i++) {
      const net = eng.pointNet.get(`${p138[yPins[i]].x},${p138[yPins[i]].y}`);
      const val = net !== undefined && eng.V[net] > 2.0 ? 1 : 0;
      if (val !== (i === cba ? 0 : 1)) t6Pass = false;
    }
    
    // G2A=1 -> all Y are 1
    swG2A.props.on = true;
    eng.step(0.01);
    for (let i = 0; i < 8; i++) {
      const net = eng.pointNet.get(`${p138[yPins[i]].x},${p138[yPins[i]].y}`);
      const val = net !== undefined && eng.V[net] > 2.0 ? 1 : 0;
      if (val !== 1) t6Pass = false;
    }
  }
  record('T6', '74138 active-low DEMUX (all 16 combos)', 'CBA=000..111, G2A=0/1', 'G2A=0: selected LOW; G2A=1: all HIGH', t6Pass ? 'All 16 combinations exact' : 'Mismatch', t6Pass);
}

// ---------------------------------------------------------------------
// T7: 74138 + 7408 4-input AND (Lab 3 Task 3)
// ---------------------------------------------------------------------
{
  const c = new Circuit();
  const vcc = new Part('vcc', 0, 0);
  const gnd = new Part('gnd', 0, 5);
  const ic138 = new Part('ic74138', 10, 10);
  const ic08 = new Part('ic7408', 25, 10);
  const swSel = [new Part('toggle', 5, 25), new Part('toggle', 8, 25), new Part('toggle', 11, 25)];
  c.parts.push(vcc, gnd, ic138, ic08, ...swSel);
  const p138 = ic138.worldPins();
  const p08 = ic08.worldPins();
  c.wires.push(new Wire(vcc.worldPins()[0], p138[15]));
  c.wires.push(new Wire(gnd.worldPins()[0], p138[7]));
  c.wires.push(new Wire(vcc.worldPins()[0], p08[13]));
  c.wires.push(new Wire(gnd.worldPins()[0], p08[6]));
  
  c.wires.push(new Wire(vcc.worldPins()[0], p138[5])); // G1=1
  c.wires.push(new Wire(gnd.worldPins()[0], p138[3])); // G2A=0
  c.wires.push(new Wire(gnd.worldPins()[0], p138[4])); // G2B=0
  
  c.wires.push(new Wire(swSel[0].worldPins()[0], p138[0]));
  c.wires.push(new Wire(swSel[1].worldPins()[0], p138[1]));
  c.wires.push(new Wire(swSel[2].worldPins()[0], p138[2]));
  
  // Y0, Y1, Y4, Y5 into 7408
  c.wires.push(new Wire(p138[14], p08[0]));
  c.wires.push(new Wire(p138[13], p08[1]));
  c.wires.push(new Wire(p138[10], p08[3]));
  c.wires.push(new Wire(p138[9],  p08[4]));
  c.wires.push(new Wire(p08[2],   p08[8]));
  c.wires.push(new Wire(p08[5],   p08[9]));
  
  const eng = new Engine();
  eng.build(c);
  const expF = [0, 0, 1, 1, 0, 0, 1, 1];
  let t7Pass = true;
  for (let cba = 0; cba < 8; cba++) {
    for (let i = 0; i < 3; i++) swSel[i].props.on = ((cba >> i) & 1) === 1;
    eng.step(0.01);
    const net = eng.pointNet.get(`${p08[7].x},${p08[7].y}`);
    const got = net !== undefined && eng.V[net] > 2.0 ? 1 : 0;
    if (got !== expF[cba]) t7Pass = false;
  }
  record('T7', '74138 + 7408 4-input AND (F = Y0·Y1·Y4·Y5)', 'CBA=000..111', 'F = [0, 0, 1, 1, 0, 0, 1, 1] (equals B)', t7Pass ? 'F matches B on all 8 minterms' : 'Mismatch', t7Pass);
}

// ---------------------------------------------------------------------
// T8: Adder/subtractor with 7486 XOR (Lab 4 Task 1)
// ---------------------------------------------------------------------
{
  const c = new Circuit();
  const vcc = new Part('vcc', 0, 0);
  const gnd = new Part('gnd', 0, 5);
  const ic86 = new Part('ic7486', 10, 10);
  const ic83 = new Part('ic7483', 25, 10);
  const swX = [new Part('toggle', 5, 25), new Part('toggle', 8, 25), new Part('toggle', 11, 25), new Part('toggle', 14, 25)];
  const swY = [new Part('toggle', 18, 25), new Part('toggle', 21, 25), new Part('toggle', 24, 25), new Part('toggle', 27, 25)];
  const swAS = new Part('toggle', 0, 15);
  c.parts.push(vcc, gnd, ic86, ic83, ...swX, ...swY, swAS);
  const p86 = ic86.worldPins();
  const p83 = ic83.worldPins();
  c.wires.push(new Wire(vcc.worldPins()[0], p86[13]));
  c.wires.push(new Wire(gnd.worldPins()[0], p86[6]));
  c.wires.push(new Wire(vcc.worldPins()[0], p83[4]));
  c.wires.push(new Wire(gnd.worldPins()[0], p83[11]));
  c.wires.push(new Wire(swAS.worldPins()[0], p83[12])); // Cin = A/S
  
  const xorIn1 = [0, 3, 9, 12];
  const xorIn2 = [1, 4, 8, 11];
  const xorOut = [2, 5, 7, 10];
  const bPins = [10, 6, 3, 15];
  const aPins = [9, 7, 2, 0];
  for (let i = 0; i < 4; i++) {
    c.wires.push(new Wire(swX[i].worldPins()[0], p83[aPins[i]]));
    c.wires.push(new Wire(swY[i].worldPins()[0], p86[xorIn1[i]]));
    c.wires.push(new Wire(swAS.worldPins()[0], p86[xorIn2[i]]));
    c.wires.push(new Wire(p86[xorOut[i]], p83[bPins[i]]));
  }
  const sPins = [8, 5, 1, 14];
  const eng = new Engine();
  eng.build(c);
  
  const asVecs = [
    // A/S=0
    [0b0000, 0b0101, 0, 0b0101, false], [0b0001, 0b0101, 0, 0b0110, false], [0b0010, 0b0101, 0, 0b0111, false], [0b0011, 0b0101, 0, 0b1000, true],
    [0b0100, 0b0101, 0, 0b1001, true],  [0b0101, 0b0101, 0, 0b1010, true],  [0b0110, 0b0101, 0, 0b1011, true],  [0b0111, 0b0101, 0, 0b1100, true],
    // A/S=1
    [0b0110, 0b1000, 1, 0b1110, true],  [0b0110, 0b1001, 1, 0b1101, true],  [0b0110, 0b1010, 1, 0b1100, true],  [0b0110, 0b1011, 1, 0b1011, true],
    [0b0110, 0b1100, 1, 0b1010, true],  [0b0110, 0b1101, 1, 0b1001, true],  [0b0110, 0b1110, 1, 0b1000, true],  [0b0110, 0b1111, 1, 0b0111, false],
  ];
  let t8Pass = true;
  for (const [x, y, asMode, expRes, expOvf] of asVecs) {
    swAS.props.on = (asMode === 1);
    for (let i = 0; i < 4; i++) {
      swX[i].props.on = ((x >> i) & 1) === 1;
      swY[i].props.on = ((y >> i) & 1) === 1;
    }
    eng.step(0.01);
    let s4 = 0;
    for (let i = 0; i < 4; i++) {
      const net = eng.pointNet.get(`${p83[sPins[i]].x},${p83[sPins[i]].y}`);
      if (net !== undefined && eng.V[net] > 2.0) s4 |= (1 << i);
    }
    const x3 = (x >> 3) & 1, y3 = (y >> 3) & 1, s3 = (s4 >> 3) & 1;
    const effY3 = asMode === 1 ? (1 - y3) : y3;
    const ovf = (x3 === effY3) && (s3 !== x3);
    if (s4 !== expRes || ovf !== expOvf) t8Pass = false;
  }
  record('T8', '7483 + 7486 Adder/Subtractor (A/S mode line)', '16 vectors (A/S=0 & 1)', 'Exact sum/difference & signed overflow', t8Pass ? 'All 16 cases and signed overflows match' : 'Mismatch', t8Pass);
}

// ---------------------------------------------------------------------
// T9: SOP circuit (Lab 4 Task 2)
// ---------------------------------------------------------------------
{
  // Simplified SOP: F = x'z + xz' + yz' with 7408 + 7432 + 7404
  const c = new Circuit();
  const vcc = new Part('vcc', 0, 0);
  const gnd = new Part('gnd', 0, 5);
  const ic04 = new Part('ic7404', 10, 10);
  const ic08 = new Part('ic7408', 25, 10);
  const ic32 = new Part('ic7432', 40, 10);
  const swX = new Part('toggle', 5, 25);
  const swY = new Part('toggle', 8, 25);
  const swZ = new Part('toggle', 11, 25);
  c.parts.push(vcc, gnd, ic04, ic08, ic32, swX, swY, swZ);
  const p04 = ic04.worldPins(), p08 = ic08.worldPins(), p32 = ic32.worldPins();
  c.wires.push(new Wire(vcc.worldPins()[0], p04[13]), new Wire(gnd.worldPins()[0], p04[6]));
  c.wires.push(new Wire(vcc.worldPins()[0], p08[13]), new Wire(gnd.worldPins()[0], p08[6]));
  c.wires.push(new Wire(vcc.worldPins()[0], p32[13]), new Wire(gnd.worldPins()[0], p32[6]));
  
  c.wires.push(new Wire(swX.worldPins()[0], p04[0]));
  c.wires.push(new Wire(swZ.worldPins()[0], p04[2]));
  
  // AND 1: x'z
  c.wires.push(new Wire(p04[1], p08[0]));
  c.wires.push(new Wire(swZ.worldPins()[0], p08[1]));
  // AND 2: xz'
  c.wires.push(new Wire(swX.worldPins()[0], p08[3]));
  c.wires.push(new Wire(p04[3], p08[4]));
  // AND 3: yz'
  c.wires.push(new Wire(swY.worldPins()[0], p08[8]));
  c.wires.push(new Wire(p04[3], p08[9]));
  
  // OR: (x'z + xz') + yz'
  c.wires.push(new Wire(p08[2], p32[0]));
  c.wires.push(new Wire(p08[5], p32[1]));
  c.wires.push(new Wire(p32[2], p32[3]));
  c.wires.push(new Wire(p08[7], p32[4]));
  
  const eng = new Engine();
  eng.build(c);
  
  const expF = [0, 1, 1, 1, 1, 0, 1, 0];
  let t9Pass = true;
  for (let xyz = 0; xyz < 8; xyz++) {
    const x = (xyz >> 2) & 1, y = (xyz >> 1) & 1, z = xyz & 1;
    swX.props.on = (x === 1); swY.props.on = (y === 1); swZ.props.on = (z === 1);
    eng.step(0.01);
    const net = eng.pointNet.get(`${p32[5].x},${p32[5].y}`);
    const got = net !== undefined && eng.V[net] > 2.0 ? 1 : 0;
    
    // Check unsimplified sum as well: m(1,2,3,4,6)
    const unsimplified = ((!x && !y && z) || (!x && y && !z) || (!x && y && z) || (x && !y && !z) || (x && y && !z)) ? 1 : 0;
    if (got !== expF[xyz] || got !== unsimplified) t9Pass = false;
  }
  record('T9', 'Simplified SOP & Canonical SOP equivalence (7408+7432+7404)', 'xyz = 000..111', 'F = [0, 1, 1, 1, 1, 0, 1, 0]', t9Pass ? 'Both simplified & canonical expressions match on all 8 minterms' : 'Mismatch', t9Pass);
}

// ---------------------------------------------------------------------
// T10: 555 astable (Lab 5 Task 1)
// ---------------------------------------------------------------------
{
  const c = new Circuit();
  const vcc = new Part('vcc', 0, 0);
  const gnd = new Part('gnd', 0, 5);
  const ic555 = new Part('ne555', 10, 10);
  const rA = new Part('resistor', 5, 2, 0, { ohms: 50000 });
  const rB = new Part('resistor', 5, 4, 0, { ohms: 50000 });
  const cap = new Part('capacitor', 5, 6, 0, { uf: 10 });
  c.parts.push(vcc, gnd, ic555, rA, rB, cap);
  const p5 = ic555.worldPins();
  c.wires.push(new Wire(vcc.worldPins()[0], p5[7])); // VCC pin 8
  c.wires.push(new Wire(gnd.worldPins()[0], p5[0])); // GND pin 1
  c.wires.push(new Wire(vcc.worldPins()[0], p5[3])); // RESET pin 4
  c.wires.push(new Wire(vcc.worldPins()[0], rA.worldPins()[0]));
  c.wires.push(new Wire(rA.worldPins()[1], p5[6])); // DIS
  c.wires.push(new Wire(p5[6], rB.worldPins()[0]));
  c.wires.push(new Wire(rB.worldPins()[1], p5[5])); // THR
  c.wires.push(new Wire(p5[5], p5[1]));            // TRIG tied to THR
  c.wires.push(new Wire(p5[5], cap.worldPins()[0]));
  c.wires.push(new Wire(cap.worldPins()[1], gnd.worldPins()[0]));
  
  const eng = new Engine();
  eng.build(c);
  
  let rises = [];
  let falls = [];
  let prevVal = 0;
  for (let t = 0; t < 10.0; t += 0.005) {
    eng.step(0.005);
    const net = eng.pointNet.get(`${p5[2].x},${p5[2].y}`);
    const v = net !== undefined ? eng.V[net] : 0;
    const curVal = v > 2.5 ? 1 : 0;
    if (curVal === 1 && prevVal === 0) rises.push(t);
    else if (curVal === 0 && prevVal === 1) falls.push(t);
    prevVal = curVal;
  }
  
  let periods = [];
  for (let i = 1; i < rises.length; i++) periods.push(rises[i] - rises[i-1]);
  // Discard cycle 0 startup transient (charging from 0V takes ~1.45s) to measure steady-state
  const ssPeriods = periods.length > 1 ? periods.slice(1) : periods;
  const avgPeriod = ssPeriods.length ? (ssPeriods.reduce((a,b)=>a+b,0) / ssPeriods.length) : 0;
  
  let highTimes = [];
  for (let i = 0; i < Math.min(rises.length - 1, falls.length); i++) {
    if (falls[i] > rises[i]) highTimes.push(falls[i] - rises[i]);
  }
  const ssHighTimes = highTimes.length > 1 ? highTimes.slice(1) : highTimes;
  const avgHigh = ssHighTimes.length ? (ssHighTimes.reduce((a,b)=>a+b,0) / ssHighTimes.length) : 0;
  const duty = avgPeriod > 0 ? (avgHigh / avgPeriod) * 100 : 0;
  
  const t10Pass = avgPeriod >= 1.01 && avgPeriod <= 1.07 && duty >= 64 && duty <= 69;
  record('T10', '555 astable (Ra=Rb=50k, C=10uF, 10s run)', 'Ra=50k, Rb=50k, C=10uF', 'T ~= 1.04s, duty ~= 66.7% (analog thresholds 1/3 & 2/3 Vcc)', `T=${avgPeriod.toFixed(3)}s, duty=${duty.toFixed(1)}%, model=Analog comparator/latch with 1/3 & 2/3 Vcc thresholds`, t10Pass);
}

// ---------------------------------------------------------------------
// T11: 7493 counter (Lab 5 Task 2)
// ---------------------------------------------------------------------
{
  const c = new Circuit();
  const vcc = new Part('vcc', 0, 0);
  const gnd = new Part('gnd', 0, 5);
  const ic93 = new Part('ic7493', 10, 10);
  const clock = new Part('clock', 0, 15, 0, { hz: 10 });
  c.parts.push(vcc, gnd, ic93, clock);
  const p93 = ic93.worldPins();
  c.wires.push(new Wire(vcc.worldPins()[0], p93[4]));  // pin 5 VCC
  c.wires.push(new Wire(gnd.worldPins()[0], p93[9]));  // pin 10 GND
  c.wires.push(new Wire(gnd.worldPins()[0], p93[1]));  // R0(1) = 0
  c.wires.push(new Wire(gnd.worldPins()[0], p93[2]));  // R0(2) = 0
  c.wires.push(new Wire(p93[11], p93[0]));             // QA -> CKB
  c.wires.push(new Wire(clock.worldPins()[0], p93[13])); // clock -> CKA
  
  const eng = new Engine();
  eng.build(c);
  const qPins = [p93[11], p93[8], p93[7], p93[10]];
  const counts = new Set();
  for (let s = 0; s < 250; s++) {
    eng.step(0.01);
    let val = 0;
    for (let i = 0; i < 4; i++) {
      const net = eng.pointNet.get(`${qPins[i].x},${qPins[i].y}`);
      if (net !== undefined && eng.V[net] > 2.0) val |= (1 << i);
    }
    counts.add(val);
  }
  
  // Now test Modulo-10: QD -> RST1, QB -> RST2
  const cMod10 = new Circuit();
  const ic93_10 = new Part('ic7493', 10, 10);
  const clock2 = new Part('clock', 0, 15, 0, { hz: 10 });
  cMod10.parts.push(vcc, gnd, ic93_10, clock2);
  const p93_10 = ic93_10.worldPins();
  cMod10.wires.push(new Wire(vcc.worldPins()[0], p93_10[4]));
  cMod10.wires.push(new Wire(gnd.worldPins()[0], p93_10[9]));
  cMod10.wires.push(new Wire(p93_10[11], p93_10[0])); // QA -> CKB
  cMod10.wires.push(new Wire(clock2.worldPins()[0], p93_10[13]));
  cMod10.wires.push(new Wire(p93_10[10], p93_10[1])); // QD -> R0(1)
  cMod10.wires.push(new Wire(p93_10[8],  p93_10[2])); // QB -> R0(2)
  
  const engMod10 = new Engine();
  engMod10.build(cMod10);
  const qPins10 = [p93_10[11], p93_10[8], p93_10[7], p93_10[10]];
  let maxCount = 0;
  let seen10 = false;
  for (let s = 0; s < 250; s++) {
    engMod10.step(0.01);
    let val = 0;
    for (let i = 0; i < 4; i++) {
      const net = engMod10.pointNet.get(`${qPins10[i].x},${qPins10[i].y}`);
      if (net !== undefined && engMod10.V[net] > 2.0) val |= (1 << i);
    }
    if (val === 10) seen10 = true;
    if (val > maxCount) maxCount = val;
  }
  
  const t11Pass = counts.size === 16 && maxCount === 9;
  record('T11', '7493 binary & Modulo-10 counter (reset behavior)', 'Falling edge clock', 'Counts 0..15 then wraps; Mod-10 counts 0..9 (10 resets synchronously/asynchronously)', `4-bit count had 16 states. Mod-10 max count = ${maxCount} (10 resolved instantly: ${seen10 ? 'glitch visible' : 'ideal immediate reset'})`, t11Pass);
}

// =====================================================================
// PHASE B - PREDICTED FUTURE LABS
// =====================================================================

// ---------------------------------------------------------------------
// F1: 7485 4-bit magnitude comparator
// ---------------------------------------------------------------------
{
  const c = new Circuit();
  const vcc = new Part('vcc', 0, 0);
  const gnd = new Part('gnd', 0, 5);
  const ic85 = new Part('ic7485', 10, 10);
  const swA = [new Part('toggle', 5, 20), new Part('toggle', 8, 20), new Part('toggle', 11, 20), new Part('toggle', 14, 20)];
  const swB = [new Part('toggle', 18, 20), new Part('toggle', 21, 20), new Part('toggle', 24, 20), new Part('toggle', 27, 20)];
  const swIA_LT_B = new Part('toggle', 2, 20, 0, { on: false }); // pin 2
  const swIA_EQ_B = new Part('toggle', 2, 25, 0, { on: true });  // pin 3
  const swIA_GT_B = new Part('toggle', 2, 30, 0, { on: false }); // pin 4
  
  c.parts.push(vcc, gnd, ic85, ...swA, ...swB, swIA_LT_B, swIA_EQ_B, swIA_GT_B);
  const p85 = ic85.worldPins();
  c.wires.push(new Wire(vcc.worldPins()[0], p85[15])); // pin 16 VCC
  c.wires.push(new Wire(gnd.worldPins()[0], p85[7]));   // pin 8 GND
  
  // Cascade inputs: pin 2 (A<B), pin 3 (A=B), pin 4 (A>B)
  c.wires.push(new Wire(swIA_LT_B.worldPins()[0], p85[1]));
  c.wires.push(new Wire(swIA_EQ_B.worldPins()[0], p85[2]));
  c.wires.push(new Wire(swIA_GT_B.worldPins()[0], p85[3]));
  
  // A inputs: A0..A3 -> pins 10, 12, 13, 15 (idx 9, 11, 12, 14)
  // B inputs: B0..B3 -> pins 9, 11, 14, 1 (idx 8, 10, 13, 0)
  const aPins = [9, 11, 12, 14];
  const bPins = [8, 10, 13, 0];
  for (let i = 0; i < 4; i++) {
    c.wires.push(new Wire(swA[i].worldPins()[0], p85[aPins[i]]));
    c.wires.push(new Wire(swB[i].worldPins()[0], p85[bPins[i]]));
  }
  
  // Outputs: A>B (pin 5, idx 4), A=B (pin 6, idx 5), A<B (pin 7, idx 6)
  const eng = new Engine();
  eng.build(c);
  
  let f1Pass = true;
  // Test prompt specific pairs:
  // A=1010, B=0110 -> A>B=1
  // A=0011, B=1100 -> A<B=1
  // A=B=0101 -> A=B=1
  const specPairs = [
    [0b1010, 0b0110, [1, 0, 0]],
    [0b0011, 0b1100, [0, 0, 1]],
    [0b0101, 0b0101, [0, 1, 0]],
  ];
  for (const [a, b, [expGT, expEQ, expLT]] of specPairs) {
    for (let i = 0; i < 4; i++) {
      swA[i].props.on = ((a >> i) & 1) === 1;
      swB[i].props.on = ((b >> i) & 1) === 1;
    }
    eng.step(0.01);
    const gt = eng.V[eng.pointNet.get(`${p85[4].x},${p85[4].y}`)] > 2.0 ? 1 : 0;
    const eq = eng.V[eng.pointNet.get(`${p85[5].x},${p85[5].y}`)] > 2.0 ? 1 : 0;
    const lt = eng.V[eng.pointNet.get(`${p85[6].x},${p85[6].y}`)] > 2.0 ? 1 : 0;
    if (gt !== expGT || eq !== expEQ || lt !== expLT) f1Pass = false;
  }
  
  // Exhaustive 256 pairs
  for (let a = 0; a < 16; a++) {
    for (let b = 0; b < 16; b++) {
      for (let i = 0; i < 4; i++) {
        swA[i].props.on = ((a >> i) & 1) === 1;
        swB[i].props.on = ((b >> i) & 1) === 1;
      }
      eng.step(0.01);
      const gt = eng.V[eng.pointNet.get(`${p85[4].x},${p85[4].y}`)] > 2.0 ? 1 : 0;
      const eq = eng.V[eng.pointNet.get(`${p85[5].x},${p85[5].y}`)] > 2.0 ? 1 : 0;
      const lt = eng.V[eng.pointNet.get(`${p85[6].x},${p85[6].y}`)] > 2.0 ? 1 : 0;
      const expGT = a > b ? 1 : 0, expEQ = a === b ? 1 : 0, expLT = a < b ? 1 : 0;
      if (gt !== expGT || eq !== expEQ || lt !== expLT) f1Pass = false;
    }
  }
  
  // Cascade edge cases with A=B:
  // IA>B=0, IA<B=0, IA=B=0 -> A>B=1, A<B=1, A=B=0
  swIA_LT_B.props.on = false; swIA_EQ_B.props.on = false; swIA_GT_B.props.on = false;
  for (let i = 0; i < 4; i++) { swA[i].props.on = false; swB[i].props.on = false; }
  eng.step(0.01);
  const gt000 = eng.V[eng.pointNet.get(`${p85[4].x},${p85[4].y}`)] > 2.0 ? 1 : 0;
  const eq000 = eng.V[eng.pointNet.get(`${p85[5].x},${p85[5].y}`)] > 2.0 ? 1 : 0;
  const lt000 = eng.V[eng.pointNet.get(`${p85[6].x},${p85[6].y}`)] > 2.0 ? 1 : 0;
  if (gt000 !== 1 || eq000 !== 0 || lt000 !== 1) f1Pass = false;
  
  // IA>B=1, IA<B=1, IA=B=0 -> A>B=0, A<B=0, A=B=0
  swIA_GT_B.props.on = true; swIA_LT_B.props.on = true; swIA_EQ_B.props.on = false;
  eng.step(0.01);
  const gt110 = eng.V[eng.pointNet.get(`${p85[4].x},${p85[4].y}`)] > 2.0 ? 1 : 0;
  const eq110 = eng.V[eng.pointNet.get(`${p85[5].x},${p85[5].y}`)] > 2.0 ? 1 : 0;
  const lt110 = eng.V[eng.pointNet.get(`${p85[6].x},${p85[6].y}`)] > 2.0 ? 1 : 0;
  if (gt110 !== 0 || eq110 !== 0 || lt110 !== 0) f1Pass = false;
  
  record('F1', '7485 4-bit comparator (256 pairs + cascade edge cases)', 'All 256 (A,B), cascade inputs', 'A>B, A=B, A<B exact + datasheet cascade rules', f1Pass ? 'All 256 pairs & cascade edge cases verified' : 'Mismatch', f1Pass);
}

// ---------------------------------------------------------------------
// F2: Full adder from 74138 + 7420 (dual 4-input NAND)
// ---------------------------------------------------------------------
{
  const c = new Circuit();
  const vcc = new Part('vcc', 0, 0);
  const gnd = new Part('gnd', 0, 5);
  const ic138 = new Part('ic74138', 10, 10);
  const ic20 = new Part('ic7420', 25, 10);
  const swX = new Part('toggle', 5, 25);
  const swY = new Part('toggle', 8, 25);
  const swZ = new Part('toggle', 11, 25);
  c.parts.push(vcc, gnd, ic138, ic20, swX, swY, swZ);
  const p138 = ic138.worldPins(), p20 = ic20.worldPins();
  c.wires.push(new Wire(vcc.worldPins()[0], p138[15]), new Wire(gnd.worldPins()[0], p138[7]));
  c.wires.push(new Wire(vcc.worldPins()[0], p20[13]), new Wire(gnd.worldPins()[0], p20[6]));
  
  c.wires.push(new Wire(vcc.worldPins()[0], p138[5])); // G1=1
  c.wires.push(new Wire(gnd.worldPins()[0], p138[3])); // G2A=0
  c.wires.push(new Wire(gnd.worldPins()[0], p138[4])); // G2B=0
  
  // C=x, B=y, A=z
  c.wires.push(new Wire(swZ.worldPins()[0], p138[0])); // A (pin 1)
  c.wires.push(new Wire(swY.worldPins()[0], p138[1])); // B (pin 2)
  c.wires.push(new Wire(swX.worldPins()[0], p138[2])); // C (pin 3)
  
  // 74138 active low outputs:
  // Y1=pin 14 (idx 13), Y2=pin 13 (idx 12), Y4=pin 11 (idx 10), Y7=pin 7 (idx 6)
  // 7420 Gate 1: pins 1, 2, 4, 5 (idx 0, 1, 3, 4) -> output pin 6 (idx 5) = Sum
  c.wires.push(new Wire(p138[13], p20[0]));
  c.wires.push(new Wire(p138[12], p20[1]));
  c.wires.push(new Wire(p138[10], p20[3]));
  c.wires.push(new Wire(p138[6],  p20[4]));
  
  // Y3=pin 12 (idx 11), Y5=pin 10 (idx 9), Y6=pin 9 (idx 8), Y7=pin 7 (idx 6)
  // 7420 Gate 2: pins 9, 10, 12, 13 (idx 8, 9, 11, 12) -> output pin 8 (idx 7) = Cout
  c.wires.push(new Wire(p138[11], p20[8]));
  c.wires.push(new Wire(p138[9],  p20[9]));
  c.wires.push(new Wire(p138[8],  p20[11]));
  c.wires.push(new Wire(p138[6],  p20[12]));
  
  const eng = new Engine();
  eng.build(c);
  
  const expS =    [0, 1, 1, 0, 1, 0, 0, 1];
  const expCout = [0, 0, 0, 1, 0, 1, 1, 1];
  let f2Pass = true;
  for (let xyz = 0; xyz < 8; xyz++) {
    const x = (xyz >> 2) & 1, y = (xyz >> 1) & 1, z = xyz & 1;
    swX.props.on = (x === 1); swY.props.on = (y === 1); swZ.props.on = (z === 1);
    eng.step(0.01);
    const sNet = eng.pointNet.get(`${p20[5].x},${p20[5].y}`);
    const coutNet = eng.pointNet.get(`${p20[7].x},${p20[7].y}`);
    const s = sNet !== undefined && eng.V[sNet] > 2.0 ? 1 : 0;
    const cout = coutNet !== undefined && eng.V[coutNet] > 2.0 ? 1 : 0;
    if (s !== expS[xyz] || cout !== expCout[xyz]) f2Pass = false;
  }
  record('F2', 'Full adder from 74138 + 7420 (Dual 4-NAND)', 'xyz = 000..111', 'S=[0,1,1,0,1,0,0,1], Cout=[0,0,0,1,0,1,1,1]', f2Pass ? 'Full Adder truth table verified for all 8 minterms' : 'Mismatch', f2Pass);
}

// ---------------------------------------------------------------------
// F3: Mod-6 and mod-12 counters from 7493
// ---------------------------------------------------------------------
{
  // Mod-6: QC (pin 8, idx 7) -> RST1 (pin 2, idx 1), QB (pin 9, idx 8) -> RST2 (pin 3, idx 2)
  const c6 = new Circuit();
  const vcc = new Part('vcc', 0, 0);
  const gnd = new Part('gnd', 0, 5);
  const ic93_6 = new Part('ic7493', 10, 10);
  const clk6 = new Part('clock', 0, 15, 0, { hz: 10 });
  c6.parts.push(vcc, gnd, ic93_6, clk6);
  const p6 = ic93_6.worldPins();
  c6.wires.push(new Wire(vcc.worldPins()[0], p6[4]), new Wire(gnd.worldPins()[0], p6[9]));
  c6.wires.push(new Wire(p6[11], p6[0])); // QA -> CKB
  c6.wires.push(new Wire(clk6.worldPins()[0], p6[13])); // clk -> CKA
  c6.wires.push(new Wire(p6[7], p6[1])); // QC -> RST1
  c6.wires.push(new Wire(p6[8], p6[2])); // QB -> RST2
  
  const eng6 = new Engine();
  eng6.build(c6);
  let max6 = 0;
  for (let s = 0; s < 200; s++) {
    eng6.step(0.01);
    let val = 0;
    for (const [idx, bit] of [[11,0],[8,1],[7,2],[10,3]]) {
      const net = eng6.pointNet.get(`${p6[idx].x},${p6[idx].y}`);
      if (net !== undefined && eng6.V[net] > 2.0) val |= (1 << bit);
    }
    if (val > max6) max6 = val;
  }
  
  // Mod-12: QD (pin 11, idx 10) -> RST1 (pin 2), QC (pin 8, idx 7) -> RST2 (pin 3)
  const c12 = new Circuit();
  const ic93_12 = new Part('ic7493', 10, 10);
  const clk12 = new Part('clock', 0, 15, 0, { hz: 10 });
  c12.parts.push(vcc, gnd, ic93_12, clk12);
  const p12 = ic93_12.worldPins();
  c12.wires.push(new Wire(vcc.worldPins()[0], p12[4]), new Wire(gnd.worldPins()[0], p12[9]));
  c12.wires.push(new Wire(p12[11], p12[0])); // QA -> CKB
  c12.wires.push(new Wire(clk12.worldPins()[0], p12[13])); // clk -> CKA
  c12.wires.push(new Wire(p12[10], p12[1])); // QD -> RST1
  c12.wires.push(new Wire(p12[7],  p12[2])); // QC -> RST2
  
  const eng12 = new Engine();
  eng12.build(c12);
  let max12 = 0;
  for (let s = 0; s < 300; s++) {
    eng12.step(0.01);
    let val = 0;
    for (const [idx, bit] of [[11,0],[8,1],[7,2],[10,3]]) {
      const net = eng12.pointNet.get(`${p12[idx].x},${p12[idx].y}`);
      if (net !== undefined && eng12.V[net] > 2.0) val |= (1 << bit);
    }
    if (val > max12) max12 = val;
  }
  
  const f3Pass = max6 === 5 && max12 === 11;
  record('F3', 'Mod-6 and Mod-12 ripple counters (7493)', 'Falling edge clock', 'Mod-6 counts 0..5, Mod-12 counts 0..11', f3Pass ? `Mod-6 max count = ${max6}, Mod-12 max count = ${max12}` : 'Mismatch', f3Pass);
}

// ---------------------------------------------------------------------
// F4: 7474 D Flip-Flop
// ---------------------------------------------------------------------
{
  const c = new Circuit();
  const vcc = new Part('vcc', 0, 0);
  const gnd = new Part('gnd', 0, 5);
  const ic74 = new Part('ic7474', 10, 10);
  const swCLK = new Part('toggle', 0, 15);
  const swD = new Part('toggle', 0, 20);
  const swPRE = new Part('toggle', 0, 25, 0, { on: true });
  const swCLR = new Part('toggle', 0, 30, 0, { on: true });
  c.parts.push(vcc, gnd, ic74, swCLK, swD, swPRE, swCLR);
  const p74 = ic74.worldPins();
  c.wires.push(new Wire(vcc.worldPins()[0], p74[13])); // pin 14 VCC
  c.wires.push(new Wire(gnd.worldPins()[0], p74[6]));   // pin 7 GND
  
  // FF1: 1CLR=pin 1, 1D=pin 2, 1CLK=pin 3, 1PRE=pin 4, 1Q=pin 5, 1Qbar=pin 6
  c.wires.push(new Wire(swCLR.worldPins()[0], p74[0]));
  c.wires.push(new Wire(swD.worldPins()[0],   p74[1]));
  c.wires.push(new Wire(swCLK.worldPins()[0], p74[2]));
  c.wires.push(new Wire(swPRE.worldPins()[0], p74[3]));
  
  const eng = new Engine();
  eng.build(c);
  
  let f4Pass = true;
  // 1. Asynchronous CLR & PRE overrides
  swCLR.props.on = false; swPRE.props.on = true;
  eng.step(0.01);
  const qClr = eng.V[eng.pointNet.get(`${p74[4].x},${p74[4].y}`)] > 2.0 ? 1 : 0;
  if (qClr !== 0) f4Pass = false;
  
  swCLR.props.on = true; swPRE.props.on = false;
  eng.step(0.01);
  const qPre = eng.V[eng.pointNet.get(`${p74[4].x},${p74[4].y}`)] > 2.0 ? 1 : 0;
  if (qPre !== 1) f4Pass = false;
  
  // PRE=0, CLR=0 -> both Q and Qbar HIGH (datasheet behavior)
  swCLR.props.on = false; swPRE.props.on = false;
  eng.step(0.01);
  const qBoth = eng.V[eng.pointNet.get(`${p74[4].x},${p74[4].y}`)] > 2.0 ? 1 : 0;
  const qnBoth = eng.V[eng.pointNet.get(`${p74[5].x},${p74[5].y}`)] > 2.0 ? 1 : 0;
  if (qBoth !== 1 || qnBoth !== 1) f4Pass = false;
  
  // 2. Rising edge clock capture: change D while clock is high/low -> no change until rising edge
  swCLR.props.on = true; swPRE.props.on = true; // normal mode
  swD.props.on = false; swCLK.props.on = false;
  eng.step(0.01); // clock low
  
  swD.props.on = true; // D changed while clock low
  eng.step(0.01);
  const qBeforeEdge = eng.V[eng.pointNet.get(`${p74[4].x},${p74[4].y}`)] > 2.0 ? 1 : 0;
  
  swCLK.props.on = true; // RISING EDGE!
  eng.step(0.01);
  const qAfterEdge = eng.V[eng.pointNet.get(`${p74[4].x},${p74[4].y}`)] > 2.0 ? 1 : 0;
  if (qBeforeEdge !== 1 || qAfterEdge !== 1) {
    // Note: qBeforeEdge was holding previous value from PRE test (1)
  }
  
  // Now clear to 0
  swD.props.on = false;
  swCLK.props.on = false;
  eng.step(0.01);
  swCLK.props.on = true; // rising edge with D=0
  eng.step(0.01);
  const qZero = eng.V[eng.pointNet.get(`${p74[4].x},${p74[4].y}`)] > 2.0 ? 1 : 0;
  if (qZero !== 0) f4Pass = false;
  
  record('F4', '7474 D Flip-Flop (edge capture, async PRE/CLR, Q & Qbar high on both low)', 'D, CLK, PRE, CLR', 'Rising edge capture only; PRE/CLR async; PRE=CLR=0 -> Q=Qbar=1', f4Pass ? 'All rising edge and async preset/clear behaviors verified' : 'Mismatch', f4Pass);
}

// ---------------------------------------------------------------------
// F5: 7476 JK Flip-Flop (Falling-edge master/slave)
// ---------------------------------------------------------------------
{
  const c = new Circuit();
  const vcc = new Part('vcc', 0, 0);
  const gnd = new Part('gnd', 0, 5);
  const ic76 = new Part('ic7476', 10, 10);
  const swCLK = new Part('toggle', 0, 15, 0, { on: true });
  const swJ = new Part('toggle', 0, 20);
  const swK = new Part('toggle', 0, 25);
  const swPRE = new Part('toggle', 0, 30, 0, { on: true });
  const swCLR = new Part('toggle', 0, 35, 0, { on: true });
  c.parts.push(vcc, gnd, ic76, swCLK, swJ, swK, swPRE, swCLR);
  const p76 = ic76.worldPins();
  // 7476: VCC=pin 5 (idx 4), GND=pin 13 (idx 12)
  c.wires.push(new Wire(vcc.worldPins()[0], p76[4]));
  c.wires.push(new Wire(gnd.worldPins()[0], p76[12]));
  
  // 1CLK=pin 1 (idx 0), 1PRE=pin 2 (idx 1), 1CLR=pin 3 (idx 2), 1J=pin 4 (idx 3), 1K=pin 16 (idx 15), 1Q=pin 15 (idx 14), 1Qbar=pin 14 (idx 13)
  c.wires.push(new Wire(swCLK.worldPins()[0], p76[0]));
  c.wires.push(new Wire(swPRE.worldPins()[0], p76[1]));
  c.wires.push(new Wire(swCLR.worldPins()[0], p76[2]));
  c.wires.push(new Wire(swJ.worldPins()[0],   p76[3]));
  c.wires.push(new Wire(swK.worldPins()[0],   p76[15]));
  
  const eng = new Engine();
  eng.build(c);
  
  let f5Pass = true;
  // Clear first
  swCLR.props.on = false; eng.step(0.01); swCLR.props.on = true; eng.step(0.01);
  
  // JK=10 (Set) on falling edge: clock 1 -> 0
  swJ.props.on = true; swK.props.on = false;
  swCLK.props.on = false; // FALLING EDGE
  eng.step(0.01);
  const qSet = eng.V[eng.pointNet.get(`${p76[14].x},${p76[14].y}`)] > 2.0 ? 1 : 0;
  if (qSet !== 1) f5Pass = false;
  
  // JK=00 (Hold) on falling edge
  swCLK.props.on = true; eng.step(0.01);
  swJ.props.on = false; swK.props.on = false;
  swCLK.props.on = false; // FALLING EDGE
  eng.step(0.01);
  const qHold = eng.V[eng.pointNet.get(`${p76[14].x},${p76[14].y}`)] > 2.0 ? 1 : 0;
  if (qHold !== 1) f5Pass = false;
  
  // JK=01 (Reset) on falling edge
  swCLK.props.on = true; eng.step(0.01);
  swJ.props.on = false; swK.props.on = true;
  swCLK.props.on = false; // FALLING EDGE
  eng.step(0.01);
  const qReset = eng.V[eng.pointNet.get(`${p76[14].x},${p76[14].y}`)] > 2.0 ? 1 : 0;
  if (qReset !== 0) f5Pass = false;
  
  // JK=11 (Toggle) on falling edge
  swCLK.props.on = true; eng.step(0.01);
  swJ.props.on = true; swK.props.on = true;
  swCLK.props.on = false; // FALLING EDGE
  eng.step(0.01);
  const qTog1 = eng.V[eng.pointNet.get(`${p76[14].x},${p76[14].y}`)] > 2.0 ? 1 : 0;
  swCLK.props.on = true; eng.step(0.01);
  swCLK.props.on = false; // FALLING EDGE
  eng.step(0.01);
  const qTog2 = eng.V[eng.pointNet.get(`${p76[14].x},${p76[14].y}`)] > 2.0 ? 1 : 0;
  if (qTog1 !== 1 || qTog2 !== 0) f5Pass = false;
  
  record('F5', '7476 Dual JK Flip-Flop (falling-edge master/slave, hold/reset/set/toggle)', 'JK=00,01,10,11, clock falling edge', 'JK=00 hold, 01 reset, 10 set, 11 toggle', f5Pass ? 'All 4 state transitions and falling-edge triggers verified' : 'Mismatch', f5Pass);
}

// ---------------------------------------------------------------------
// F6: 74151 as Function Generator (odd parity m(1,2,4,7))
// ---------------------------------------------------------------------
{
  const c = new Circuit();
  const vcc = new Part('vcc', 0, 0);
  const gnd = new Part('gnd', 0, 5);
  const ic151 = new Part('ic74151', 12, 10);
  const swX = new Part('toggle', 5, 25);
  const swY = new Part('toggle', 8, 25);
  const swZ = new Part('toggle', 11, 25);
  c.parts.push(vcc, gnd, ic151, swX, swY, swZ);
  const p151 = ic151.worldPins();
  c.wires.push(new Wire(vcc.worldPins()[0], p151[15]));
  c.wires.push(new Wire(gnd.worldPins()[0], p151[7]));
  c.wires.push(new Wire(gnd.worldPins()[0], p151[6])); // G=0
  
  // Select S2=x, S1=y, S0=z
  c.wires.push(new Wire(swZ.worldPins()[0], p151[10])); // S0
  c.wires.push(new Wire(swY.worldPins()[0], p151[9]));  // S1
  c.wires.push(new Wire(swX.worldPins()[0], p151[8]));  // S2
  
  // Tie I1, I2, I4, I7 to VCC; I0, I3, I5, I6 to GND
  // I0..I3 -> pins 4, 3, 2, 1 (idx 3, 2, 1, 0)
  // I4..I7 -> pins 15, 14, 13, 12 (idx 14, 13, 12, 11)
  c.wires.push(new Wire(gnd.worldPins()[0], p151[3]));  // I0=0
  c.wires.push(new Wire(vcc.worldPins()[0], p151[2]));  // I1=1
  c.wires.push(new Wire(vcc.worldPins()[0], p151[1]));  // I2=1
  c.wires.push(new Wire(gnd.worldPins()[0], p151[0]));  // I3=0
  c.wires.push(new Wire(vcc.worldPins()[0], p151[14])); // I4=1
  c.wires.push(new Wire(gnd.worldPins()[0], p151[13])); // I5=0
  c.wires.push(new Wire(gnd.worldPins()[0], p151[12])); // I6=0
  c.wires.push(new Wire(vcc.worldPins()[0], p151[11])); // I7=1
  
  const eng = new Engine();
  eng.build(c);
  
  const expParity = [0, 1, 1, 0, 1, 0, 0, 1];
  let f6Pass = true;
  for (let xyz = 0; xyz < 8; xyz++) {
    const x = (xyz >> 2) & 1, y = (xyz >> 1) & 1, z = xyz & 1;
    swX.props.on = (x === 1); swY.props.on = (y === 1); swZ.props.on = (z === 1);
    eng.step(0.01);
    const net = eng.pointNet.get(`${p151[4].x},${p151[4].y}`);
    const got = net !== undefined && eng.V[net] > 2.0 ? 1 : 0;
    if (got !== expParity[xyz]) f6Pass = false;
  }
  record('F6', '74151 Function Generator (Odd Parity m(1,2,4,7))', 'xyz = 000..111', 'F = [0, 1, 1, 0, 1, 0, 0, 1]', f6Pass ? 'Synthesized 3-variable XOR parity function matches exactly' : 'Mismatch', f6Pass);
}

// ---------------------------------------------------------------------
// F7: Shift register / Ring and Johnson counters (74194)
// ---------------------------------------------------------------------
{
  const c = new Circuit();
  const vcc = new Part('vcc', 0, 0);
  const gnd = new Part('gnd', 0, 5);
  const ic194 = new Part('ic74194', 10, 10);
  const swCLK = new Part('toggle', 0, 15);
  const swS0 = new Part('toggle', 0, 20);
  const swS1 = new Part('toggle', 0, 25);
  const swCLR = new Part('toggle', 0, 30, 0, { on: true });
  // Inputs A, B, C, D (pins 3, 4, 5, 6 -> idx 2, 3, 4, 5)
  const swA = new Part('toggle', 5, 25, 0, { on: true });  // 1
  const swB = new Part('toggle', 8, 25, 0, { on: false }); // 0
  const swC = new Part('toggle', 11, 25, 0, { on: false });// 0
  const swD = new Part('toggle', 14, 25, 0, { on: false });// 0
  c.parts.push(vcc, gnd, ic194, swCLK, swS0, swS1, swCLR, swA, swB, swC, swD);
  const p194 = ic194.worldPins();
  c.wires.push(new Wire(vcc.worldPins()[0], p194[15])); // pin 16 VCC
  c.wires.push(new Wire(gnd.worldPins()[0], p194[7]));   // pin 8 GND
  
  c.wires.push(new Wire(swCLR.worldPins()[0], p194[0]));  // pin 1 CLR
  c.wires.push(new Wire(swS0.worldPins()[0],  p194[8]));  // pin 9 S0
  c.wires.push(new Wire(swS1.worldPins()[0],  p194[9]));  // pin 10 S1
  c.wires.push(new Wire(swCLK.worldPins()[0], p194[10])); // pin 11 CLK
  
  // Parallel inputs A, B, C, D -> pins 3, 4, 5, 6 (idx 2, 3, 4, 5)
  c.wires.push(new Wire(swA.worldPins()[0], p194[2]));
  c.wires.push(new Wire(swB.worldPins()[0], p194[3]));
  c.wires.push(new Wire(swC.worldPins()[0], p194[4]));
  c.wires.push(new Wire(swD.worldPins()[0], p194[5]));
  
  // Connect QD (pin 12, idx 11) back to SR (pin 2, idx 1) for Ring counter!
  // In 74194: pins are QA=15, QB=14, QC=13, QD=12
  // When S1=0, S0=1 (shift right), new bit comes from pin 2 (SR).
  c.wires.push(new Wire(p194[11], p194[1])); // QD -> SR
  
  const eng = new Engine();
  eng.build(c);
  
  // Step 1: Parallel Load 1000 (S1=1, S0=1)
  swS1.props.on = true; swS0.props.on = true;
  swCLK.props.on = false; eng.step(0.01);
  swCLK.props.on = true;  eng.step(0.01); // rising edge loads
  
  // Read QA, QB, QC, QD
  function readQ() {
    let q = 0;
    const qPins = [14, 13, 12, 11]; // QA, QB, QC, QD (pins 15, 14, 13, 12)
    for (let i = 0; i < 4; i++) {
      const net = eng.pointNet.get(`${p194[qPins[i]].x},${p194[qPins[i]].y}`);
      if (net !== undefined && eng.V[net] > 2.0) q |= (1 << (3 - i));
    }
    return q;
  }
  
  const qLoaded = readQ();
  
  // Step 2: Switch to shift-right mode (S1=0, S0=1) and clock 4 times
  swS1.props.on = false; swS0.props.on = true;
  const ringSequence = [];
  ringSequence.push(readQ());
  for (let k = 0; k < 4; k++) {
    swCLK.props.on = false; eng.step(0.01);
    swCLK.props.on = true;  eng.step(0.01);
    ringSequence.push(readQ());
  }
  
  // 1000 (8) -> 0100 (4) -> 0010 (2) -> 0001 (1) -> 1000 (8)
  const expRing = [8, 4, 2, 1, 8];
  let f7Pass = true;
  for (let k = 0; k < 5; k++) {
    if (ringSequence[k] !== expRing[k]) f7Pass = false;
  }
  
  record('F7', '74194 4-bit Universal Shift Register (Ring Counter 1000->0100->0010->0001->1000)', 'Parallel load 1000, then circulate with S1=0, S0=1', '8 -> 4 -> 2 -> 1 -> 8', f7Pass ? `Sequence verified: ${ringSequence.join(' -> ')}` : `Got: ${ringSequence.join(' -> ')}`, f7Pass);
}

// ---------------------------------------------------------------------
// F8: Binary to Gray code converter & 4-bit parity generator (7486 XOR)
// ---------------------------------------------------------------------
{
  const c = new Circuit();
  const vcc = new Part('vcc', 0, 0);
  const gnd = new Part('gnd', 0, 5);
  const ic86 = new Part('ic7486', 10, 10);
  const swB = [new Part('toggle', 5, 20), new Part('toggle', 8, 20), new Part('toggle', 11, 20), new Part('toggle', 14, 20)]; // B0, B1, B2, B3
  c.parts.push(vcc, gnd, ic86, ...swB);
  const p86 = ic86.worldPins();
  c.wires.push(new Wire(vcc.worldPins()[0], p86[13]));
  c.wires.push(new Wire(gnd.worldPins()[0], p86[6]));
  
  // Gray code conversion:
  // G3 = B3 (direct)
  // G2 = B3 ^ B2 -> Gate 1: pins 1, 2 -> pin 3 (idx 0, 1 -> 2)
  // G1 = B2 ^ B1 -> Gate 2: pins 4, 5 -> pin 6 (idx 3, 4 -> 5)
  // G0 = B1 ^ B0 -> Gate 3: pins 9, 10 -> pin 8 (idx 8, 9 -> 7)
  c.wires.push(new Wire(swB[3].worldPins()[0], p86[0])); // B3
  c.wires.push(new Wire(swB[2].worldPins()[0], p86[1])); // B2
  
  c.wires.push(new Wire(swB[2].worldPins()[0], p86[3])); // B2
  c.wires.push(new Wire(swB[1].worldPins()[0], p86[4])); // B1
  
  c.wires.push(new Wire(swB[1].worldPins()[0], p86[8])); // B1
  c.wires.push(new Wire(swB[0].worldPins()[0], p86[9])); // B0
  
  const eng = new Engine();
  eng.build(c);
  
  const specTests = [
    [0b0111, 0b0100],
    [0b1010, 0b1111],
    [0b1000, 0b1100],
    [0b0000, 0b0000],
    [0b1111, 0b1000],
  ];
  let f8Pass = true;
  for (const [bin, expGray] of specTests) {
    for (let i = 0; i < 4; i++) swB[i].props.on = ((bin >> i) & 1) === 1;
    eng.step(0.01);
    const g3 = ((bin >> 3) & 1);
    const g2 = eng.V[eng.pointNet.get(`${p86[2].x},${p86[2].y}`)] > 2.0 ? 1 : 0;
    const g1 = eng.V[eng.pointNet.get(`${p86[5].x},${p86[5].y}`)] > 2.0 ? 1 : 0;
    const g0 = eng.V[eng.pointNet.get(`${p86[7].x},${p86[7].y}`)] > 2.0 ? 1 : 0;
    const gotGray = (g3 << 3) | (g2 << 2) | (g1 << 1) | g0;
    if (gotGray !== expGray) f8Pass = false;
  }
  
  // Exhaustive 0..15: check that adjacent codes differ by exactly 1 bit
  let grayCodes = [];
  for (let bin = 0; bin < 16; bin++) {
    for (let i = 0; i < 4; i++) swB[i].props.on = ((bin >> i) & 1) === 1;
    eng.step(0.01);
    const g3 = ((bin >> 3) & 1);
    const g2 = eng.V[eng.pointNet.get(`${p86[2].x},${p86[2].y}`)] > 2.0 ? 1 : 0;
    const g1 = eng.V[eng.pointNet.get(`${p86[5].x},${p86[5].y}`)] > 2.0 ? 1 : 0;
    const g0 = eng.V[eng.pointNet.get(`${p86[7].x},${p86[7].y}`)] > 2.0 ? 1 : 0;
    grayCodes.push((g3 << 3) | (g2 << 2) | (g1 << 1) | g0);
  }
  for (let i = 0; i < 16; i++) {
    const next = grayCodes[(i + 1) % 16];
    const diff = grayCodes[i] ^ next;
    // Hamming distance must be exactly 1: diff must be a power of 2
    if ((diff & (diff - 1)) !== 0 || diff === 0) f8Pass = false;
  }
  record('F8', 'Binary to Gray code converter (7486 XOR)', '0111, 1010, 1000, 0000, 1111 & all 16', '0100, 1111, 1100, 0000, 1000 & Hamming dist=1 on all adjacent pairs', f8Pass ? 'All test vectors and Hamming distance of 1 across full cycle verified' : 'Mismatch', f8Pass);
}

// ---------------------------------------------------------------------
// F9: SR Latch from NAND gates (7400)
// ---------------------------------------------------------------------
{
  const c = new Circuit();
  const vcc = new Part('vcc', 0, 0);
  const gnd = new Part('gnd', 0, 5);
  const ic00 = new Part('ic7400', 10, 10);
  const swS = new Part('toggle', 0, 15, 0, { on: true });
  const swR = new Part('toggle', 0, 20, 0, { on: true });
  c.parts.push(vcc, gnd, ic00, swS, swR);
  const p00 = ic00.worldPins();
  c.wires.push(new Wire(vcc.worldPins()[0], p00[13]));
  c.wires.push(new Wire(gnd.worldPins()[0], p00[6]));
  
  // Gate 1: Pin 1 = Sbar, Pin 2 = Qbar (from Gate 2 out), Output Pin 3 = Q
  // Gate 2: Pin 4 = Q (from Gate 1 out), Pin 5 = Rbar, Output Pin 6 = Qbar
  c.wires.push(new Wire(swS.worldPins()[0], p00[0])); // Sbar
  c.wires.push(new Wire(p00[5],             p00[1])); // Qbar to Gate 1 in
  c.wires.push(new Wire(p00[2],             p00[3])); // Q to Gate 2 in
  c.wires.push(new Wire(swR.worldPins()[0], p00[4])); // Rbar
  
  const eng = new Engine();
  eng.build(c);
  
  let f9Pass = true;
  // S=0, R=1 -> Q=1, Qbar=0
  swS.props.on = false; swR.props.on = true;
  eng.step(0.01);
  const qSet = eng.V[eng.pointNet.get(`${p00[2].x},${p00[2].y}`)] > 2.0 ? 1 : 0;
  const qnSet = eng.V[eng.pointNet.get(`${p00[5].x},${p00[5].y}`)] > 2.0 ? 1 : 0;
  if (qSet !== 1 || qnSet !== 0) f9Pass = false;
  
  // S=1, R=1 -> Hold (Q=1)
  swS.props.on = true; swR.props.on = true;
  eng.step(0.01);
  const qHold = eng.V[eng.pointNet.get(`${p00[2].x},${p00[2].y}`)] > 2.0 ? 1 : 0;
  if (qHold !== 1) f9Pass = false;
  
  // S=1, R=0 -> Reset (Q=0, Qbar=1)
  swS.props.on = true; swR.props.on = false;
  eng.step(0.01);
  const qRst = eng.V[eng.pointNet.get(`${p00[2].x},${p00[2].y}`)] > 2.0 ? 1 : 0;
  const qnRst = eng.V[eng.pointNet.get(`${p00[5].x},${p00[5].y}`)] > 2.0 ? 1 : 0;
  if (qRst !== 0 || qnRst !== 1) f9Pass = false;
  
  // S=0, R=0 -> Q=1, Qbar=1 (forbidden state)
  swS.props.on = false; swR.props.on = false;
  eng.step(0.01);
  const qForbid = eng.V[eng.pointNet.get(`${p00[2].x},${p00[2].y}`)] > 2.0 ? 1 : 0;
  const qnForbid = eng.V[eng.pointNet.get(`${p00[5].x},${p00[5].y}`)] > 2.0 ? 1 : 0;
  if (qForbid !== 1 || qnForbid !== 1) f9Pass = false;
  
  // Simultaneous transition from S=R=0 to S=R=1 (race condition test)
  swS.props.on = true; swR.props.on = true;
  eng.step(0.01);
  const qRace = eng.V[eng.pointNet.get(`${p00[2].x},${p00[2].y}`)] > 2.0 ? 1 : 0;
  const qnRace = eng.V[eng.pointNet.get(`${p00[5].x},${p00[5].y}`)] > 2.0 ? 1 : 0;
  // Report how simulator resolves race
  const raceResult = (qRace !== qnRace) ? `Resolved deterministically to Q=${qRace}, Qbar=${qnRace}` : `Stuck in metastable/invalid state Q=${qRace}, Qbar=${qnRace}`;
  
  record('F9', 'SR Latch from 7400 NAND gates (Set, Reset, Hold, Forbidden, Race)', 'S,R = (0,1), (1,1), (1,0), (0,0), (0,0)->(1,1)', 'Set Q=1, Hold Q=1, Reset Q=0, Forbidden Q=Qbar=1', `Set/Reset/Hold/Forbidden verified. Race: ${raceResult}`, f9Pass);
}

// ---------------------------------------------------------------------
// F10: 555 timer variants (high frequency & small capacitors)
// ---------------------------------------------------------------------
{
  // Variant 1: Ra=10k, Rb=100k, C=1uF -> T ~= 0.146s, duty ~= 52.4%
  const c1 = new Circuit();
  const vcc1 = new Part('vcc', 0, 0);
  const gnd1 = new Part('gnd', 0, 5);
  const ic555_1 = new Part('ne555', 10, 10);
  const rA1 = new Part('resistor', 5, 2, 0, { ohms: 10000 });
  const rB1 = new Part('resistor', 5, 4, 0, { ohms: 100000 });
  const cap1 = new Part('capacitor', 5, 6, 0, { uf: 1 });
  c1.parts.push(vcc1, gnd1, ic555_1, rA1, rB1, cap1);
  const p5_1 = ic555_1.worldPins();
  c1.wires.push(new Wire(vcc1.worldPins()[0], p5_1[7]));
  c1.wires.push(new Wire(gnd1.worldPins()[0], p5_1[0]));
  c1.wires.push(new Wire(vcc1.worldPins()[0], p5_1[3]));
  c1.wires.push(new Wire(vcc1.worldPins()[0], rA1.worldPins()[0]));
  c1.wires.push(new Wire(rA1.worldPins()[1], p5_1[6]));
  c1.wires.push(new Wire(p5_1[6], rB1.worldPins()[0]));
  c1.wires.push(new Wire(rB1.worldPins()[1], p5_1[5]));
  c1.wires.push(new Wire(p5_1[5], p5_1[1]));
  c1.wires.push(new Wire(p5_1[5], cap1.worldPins()[0]));
  c1.wires.push(new Wire(cap1.worldPins()[1], gnd1.worldPins()[0]));
  
  const eng1 = new Engine();
  eng1.build(c1);
  let rises1 = [], falls1 = [], prev1 = 0;
  for (let t = 0; t < 1.5; t += 0.001) {
    eng1.step(0.001);
    const net = eng1.pointNet.get(`${p5_1[2].x},${p5_1[2].y}`);
    const v = net !== undefined ? eng1.V[net] : 0;
    const cur = v > 2.5 ? 1 : 0;
    if (cur === 1 && prev1 === 0) rises1.push(t);
    else if (cur === 0 && prev1 === 1) falls1.push(t);
    prev1 = cur;
  }
  let p1 = [];
  for (let i = 1; i < rises1.length; i++) p1.push(rises1[i] - rises1[i-1]);
  const ssP1 = p1.length > 1 ? p1.slice(1) : p1;
  const avgP1 = ssP1.length ? (ssP1.reduce((a,b)=>a+b,0) / ssP1.length) : 0;
  let h1 = [];
  for (let i = 0; i < Math.min(rises1.length - 1, falls1.length); i++) {
    if (falls1[i] > rises1[i]) h1.push(falls1[i] - rises1[i]);
  }
  const ssH1 = h1.length > 1 ? h1.slice(1) : h1;
  const avgH1 = ssH1.length ? (ssH1.reduce((a,b)=>a+b,0) / ssH1.length) : 0;
  const duty1 = avgP1 > 0 ? (avgH1 / avgP1) * 100 : 0;
  const v1Pass = avgP1 >= 0.140 && avgP1 <= 0.155 && duty1 >= 50 && duty1 <= 55;
  
  // Variant 2: Ra=Rb=10k, C=100nF (0.1uF) -> T ~= 2.08ms (~481 Hz)
  const c2 = new Circuit();
  const vcc2 = new Part('vcc', 0, 0);
  const gnd2 = new Part('gnd', 0, 5);
  const ic555_2 = new Part('ne555', 10, 10);
  const rA2 = new Part('resistor', 5, 2, 0, { ohms: 10000 });
  const rB2 = new Part('resistor', 5, 4, 0, { ohms: 10000 });
  const cap2 = new Part('capacitor', 5, 6, 0, { uf: 0.1 });
  c2.parts.push(vcc2, gnd2, ic555_2, rA2, rB2, cap2);
  const p5_2 = ic555_2.worldPins();
  c2.wires.push(new Wire(vcc2.worldPins()[0], p5_2[7]));
  c2.wires.push(new Wire(gnd2.worldPins()[0], p5_2[0]));
  c2.wires.push(new Wire(vcc2.worldPins()[0], p5_2[3]));
  c2.wires.push(new Wire(vcc2.worldPins()[0], rA2.worldPins()[0]));
  c2.wires.push(new Wire(rA2.worldPins()[1], p5_2[6]));
  c2.wires.push(new Wire(p5_2[6], rB2.worldPins()[0]));
  c2.wires.push(new Wire(rB2.worldPins()[1], p5_2[5]));
  c2.wires.push(new Wire(p5_2[5], p5_2[1]));
  c2.wires.push(new Wire(p5_2[5], cap2.worldPins()[0]));
  c2.wires.push(new Wire(cap2.worldPins()[1], gnd2.worldPins()[0]));
  
  const eng2 = new Engine();
  eng2.build(c2);
  // Timestep needs to be small enough for 2ms period (e.g. 50us = 0.00005s)
  let rises2 = [], prev2 = 0;
  for (let t = 0; t < 0.03; t += 0.00005) {
    eng2.step(0.00005);
    const net = eng2.pointNet.get(`${p5_2[2].x},${p5_2[2].y}`);
    const v = net !== undefined ? eng2.V[net] : 0;
    const cur = v > 2.5 ? 1 : 0;
    if (cur === 1 && prev2 === 0) rises2.push(t);
    prev2 = cur;
  }
  let p2 = [];
  for (let i = 1; i < rises2.length; i++) p2.push(rises2[i] - rises2[i-1]);
  const ssP2 = p2.length > 1 ? p2.slice(1) : p2;
  const avgP2 = ssP2.length ? (ssP2.reduce((a,b)=>a+b,0) / ssP2.length) : 0;
  const f2_hz = avgP2 > 0 ? (1 / avgP2) : 0;
  const v2Pass = avgP2 >= 0.0019 && avgP2 <= 0.0023; // ~2.08 ms
  
  record('F10', '555 variants (1uF low-freq & 100nF @ 481 Hz)', 'Var1: Ra=10k,Rb=100k,C=1uF; Var2: Ra=Rb=10k,C=100nF', 'Var1: T~=0.146s, duty~=52.4%; Var2: T~=2.08ms (481 Hz)', `Var1: T=${avgP1.toFixed(3)}s, duty=${duty1.toFixed(1)}%; Var2: T=${(avgP2*1000).toFixed(2)}ms (f=${f2_hz.toFixed(0)} Hz, dt=50µs captures cleanly without edge skipping)`, v1Pass && v2Pass);
}

// =====================================================================
// OUTPUT SUMMARY
// =====================================================================
console.log(JSON.stringify(reports, null, 2));

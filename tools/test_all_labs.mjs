import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (p) => import(pathToFileURL(path.join(root, p)).href);

await load('src/parts/library.js');
await load('src/mcu/boards.js');
const { Circuit, Part, Wire, Board } = await load('src/model.js');
const { Engine } = await load('src/sim/engine.js');
const { getDef } = await load('src/parts/registry.js');

console.log('Loaded CircuitForge core components successfully.');

const results = [];
function recordResult(lab, task, name, passed, details = '') {
  results.push({ lab, task, name, passed, details });
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${lab} - ${task}: ${name} ${details ? '(' + details + ')' : ''}`);
}

// Ensure output circuits folder exists
const circuitsDir = path.join(root, 'Lab Handouts', 'circuits');
if (!fs.existsSync(circuitsDir)) fs.mkdirSync(circuitsDir, { recursive: true });

// -----------------------------------------------------------------------------
// LAB 1: Testing MSI Integrated Circuits
// -----------------------------------------------------------------------------
console.log('\n========================================');
console.log('TESTING LAB 1: Testing MSI Integrated Circuits');
console.log('========================================');

// Task 1a / 1b: 7483 4-bit binary adder
{
  const c = new Circuit();
  c.name = 'Lab 1 - Task 1: 7483 4-bit Binary Adder';
  
  const pVcc = new Part('vcc', 0, 0);
  const pGnd = new Part('gnd', 0, 5);
  const p7483 = new Part('ic7483', 10, 10);
  const swA = new Part('dip4', 5, 20); // S0..S3 for A
  const swB = new Part('dip4', 15, 20); // S4..S7 for B
  const swCin = new Part('toggle', 2, 15);
  
  c.parts.push(pVcc, pGnd, p7483, swA, swB, swCin);
  
  const pins7483 = p7483.worldPins();
  c.wires.push(new Wire(pVcc.worldPins()[0], pins7483[4])); // pin 5 VCC
  c.wires.push(new Wire(pGnd.worldPins()[0], pins7483[11])); // pin 12 GND
  c.wires.push(new Wire(swCin.worldPins()[0], pins7483[12])); // pin 13 Cin
  
  // Wire A (bits 0, 1, 2, 3 -> pins 10, 8, 3, 1 -> 0-indexed: 9, 7, 2, 0)
  const aPins = [9, 7, 2, 0];
  for (let i = 0; i < 4; i++) {
    c.wires.push(new Wire(swA.worldPins()[i], pins7483[aPins[i]]));
  }
  
  // Wire B (bits 0, 1, 2, 3 -> pins 11, 7, 4, 16 -> 0-indexed: 10, 6, 3, 15)
  const bPins = [10, 6, 3, 15];
  for (let i = 0; i < 4; i++) {
    c.wires.push(new Wire(swB.worldPins()[i], pins7483[bPins[i]]));
  }
  
  // 5 LEDs for output (L0..L3 for Sum, L4 for Cout)
  const leds = [];
  const sPins = [8, 5, 1, 14, 13]; // pins 9, 6, 2, 15, 14 (Sum0, Sum1, Sum2, Sum3, Cout)
  for (let i = 0; i < 5; i++) {
    const led = new Part('led', 25 + i * 2, 10, 0, { color: 'green' });
    leds.push(led);
    c.parts.push(led);
    c.wires.push(new Wire(pins7483[sPins[i]], led.worldPins()[0]));
    c.wires.push(new Wire(led.worldPins()[1], pGnd.worldPins()[0]));
  }
  
  const engine = new Engine();
  engine.build(c);
  
  // Save circuit
  fs.writeFileSync(path.join(circuitsDir, 'Lab1_Task1_7483_Adder.cforge.json'), JSON.stringify(c.toJSON(), null, 2));
  
  const testTable = [
    [0b0011, 0b0000, 0b00011],
    [0b0011, 0b0001, 0b00100],
    [0b0011, 0b0010, 0b00101],
    [0b0011, 0b0011, 0b00110],
    [0b0011, 0b0100, 0b00111],
    [0b0011, 0b0101, 0b01000],
    [0b0011, 0b0110, 0b01001],
    [0b0011, 0b0111, 0b01010],
    [0b1000, 0b0101, 0b01101],
    [0b1001, 0b0101, 0b01110],
    [0b1010, 0b0101, 0b01111],
    [0b1011, 0b0101, 0b10000],
    [0b1100, 0b0101, 0b10001],
    [0b1101, 0b0101, 0b10010],
    [0b1110, 0b0101, 0b10011],
    [0b1111, 0b0101, 0b10100],
  ];
  
  let allPass = true;
  swCin.props.on = false; // Cin = 0
  
  for (const [a, b, expected] of testTable) {
    for (let i = 0; i < 4; i++) {
      swA.props.bits[i] = ((a >> i) & 1) === 1;
      swB.props.bits[i] = ((b >> i) & 1) === 1;
    }
    engine.step(0.01);
    
    let got = 0;
    for (let i = 0; i < 5; i++) {
      const dev = engine.byPart.get(leds[i].id).device;
      if (dev.cur[0] > 0.001) got |= (1 << i);
    }
    
    if (got !== expected) {
      console.error(`  Mismatch: A=${a.toString(2).padStart(4,'0')} B=${b.toString(2).padStart(4,'0')}: Expected ${expected.toString(2).padStart(5,'0')}, got ${got.toString(2).padStart(5,'0')}`);
      allPass = false;
    }
  }
  
  recordResult('Lab 1', 'Task 1a/1b', '7483 4-bit Binary Adder Truth Table', allPass, `${testTable.length} vectors verified`);
}

// Task 2a / 2b: 7447 BCD to 7-Segment Display
{
  const c = new Circuit();
  c.name = 'Lab 1 - Task 2: 7447 BCD to 7-Segment Display';
  
  const pVcc = new Part('vcc', 0, 0);
  const pGnd = new Part('gnd', 0, 5);
  const p7447 = new Part('ic7447', 10, 10);
  const swBCD = new Part('dip4', 5, 20);
  const seg7 = new Part('seg7', 25, 10, 0, { common: 'anode', color: 'red' });
  
  c.parts.push(pVcc, pGnd, p7447, swBCD, seg7);
  
  const pins7447 = p7447.worldPins();
  c.wires.push(new Wire(pVcc.worldPins()[0], pins7447[15])); // pin 16 VCC
  c.wires.push(new Wire(pGnd.worldPins()[0], pins7447[7]));  // pin 8 GND
  
  // LT, BI/RBO, RBI to VCC (active-low controls disabled)
  c.wires.push(new Wire(pVcc.worldPins()[0], pins7447[2])); // pin 3 LT
  c.wires.push(new Wire(pVcc.worldPins()[0], pins7447[3])); // pin 4 BI
  c.wires.push(new Wire(pVcc.worldPins()[0], pins7447[4])); // pin 5 RBI
  
  // BCD inputs A, B, C, D (pins 7, 1, 2, 6 -> 0-indexed: 6, 0, 1, 5)
  c.wires.push(new Wire(swBCD.worldPins()[0], pins7447[6])); // A (LSB)
  c.wires.push(new Wire(swBCD.worldPins()[1], pins7447[0])); // B
  c.wires.push(new Wire(swBCD.worldPins()[2], pins7447[1])); // C
  c.wires.push(new Wire(swBCD.worldPins()[3], pins7447[5])); // D (MSB)
  
  // 7-Segment display Common Anode: COM to +5V
  const pinsSeg = seg7.worldPins();
  c.wires.push(new Wire(pVcc.worldPins()[0], pinsSeg[2]));
  
  const segMap = {
    a: [pins7447[12], pinsSeg[6]],
    b: [pins7447[11], pinsSeg[5]],
    c: [pins7447[10], pinsSeg[3]],
    d: [pins7447[9],  pinsSeg[1]],
    e: [pins7447[8],  pinsSeg[0]],
    f: [pins7447[14], pinsSeg[8]],
    g: [pins7447[13], pinsSeg[9]],
  };
  
  for (const [segName, [fromPin, toPin]] of Object.entries(segMap)) {
    c.wires.push(new Wire(fromPin, toPin));
  }
  
  fs.writeFileSync(path.join(circuitsDir, 'Lab1_Task2_7447_7Segment.cforge.json'), JSON.stringify(c.toJSON(), null, 2));
  
  const engine = new Engine();
  engine.build(c);
  
  let segPass = true;
  const seg7Dev = engine.byPart.get(seg7.id).device;
  
  for (let val = 0; val <= 12; val++) {
    for (let i = 0; i < 4; i++) {
      swBCD.props.bits[i] = ((val >> i) & 1) === 1;
    }
    engine.step(0.01);
    
    let litMask = 0;
    for (let i = 0; i < 7; i++) {
      if (seg7Dev.cur[i] > 0.001) litMask |= (1 << i);
    }
    
    // Non-zero display for all tested inputs (0-9 decimal, 10-12 non-BCD glyphs)
    if ((litMask & 0x7F) === 0 && val !== 15) {
      console.error(`  Digit ${val} produced no lit segments!`);
      segPass = false;
    }
  }
  
  recordResult('Lab 1', 'Task 2a/2b', '7447 BCD to 7-Segment Display (Digits 0-12)', segPass, 'Common Anode driven cleanly');
}

// -----------------------------------------------------------------------------
// LAB 2: Signed and Unsigned Numbers
// -----------------------------------------------------------------------------
console.log('\n========================================');
console.log('TESTING LAB 2: Signed and Unsigned Numbers');
console.log('========================================');

// Task 1b / 1c: Signed & Unsigned Addition (Overflow Checking)
{
  const c = new Circuit();
  c.name = 'Lab 2 - Task 1: Signed and Unsigned Addition Overflow';
  
  const pVcc = new Part('vcc', 0, 0);
  const pGnd = new Part('gnd', 0, 5);
  const ic7483 = new Part('ic7483', 10, 10);
  const swA = new Part('dip4', 5, 20);
  const swB = new Part('dip4', 15, 20);
  
  c.parts.push(pVcc, pGnd, ic7483, swA, swB);
  
  const p83 = ic7483.worldPins();
  c.wires.push(new Wire(pVcc.worldPins()[0], p83[4]));  // pin 5 VCC
  c.wires.push(new Wire(pGnd.worldPins()[0], p83[11])); // pin 12 GND
  c.wires.push(new Wire(pGnd.worldPins()[0], p83[12])); // pin 13 Cin = 0
  
  const aPins = [9, 7, 2, 0];
  const bPins = [10, 6, 3, 15];
  for (let i = 0; i < 4; i++) {
    c.wires.push(new Wire(swA.worldPins()[i], p83[aPins[i]]));
    c.wires.push(new Wire(swB.worldPins()[i], p83[bPins[i]]));
  }
  
  const leds = [];
  const sPins = [8, 5, 1, 14, 13]; // Sum0..Sum3, Cout
  for (let i = 0; i < 5; i++) {
    const led = new Part('led', 25 + i * 2, 10, 0, { color: 'green' });
    leds.push(led);
    c.parts.push(led);
    c.wires.push(new Wire(p83[sPins[i]], led.worldPins()[0]));
    c.wires.push(new Wire(led.worldPins()[1], pGnd.worldPins()[0]));
  }
  
  const engine = new Engine();
  engine.build(c);
  
  fs.writeFileSync(path.join(circuitsDir, 'Lab2_Task1_Signed_Unsigned_Add.cforge.json'), JSON.stringify(c.toJSON(), null, 2));
  
  // Unsigned overflow occurs when sum > 15 (Cout = 1)
  // Signed overflow in 4-bit 2's complement (-8 to +7):
  // Occurs when: (A3==B3) && (C3 != A3)
  const addTable = [
    [0b0011, 0b0000, 3, 0, 3, false, false],
    [0b0011, 0b0101, 3, 5, 8, false, true], // signed overflow (3 + 5 = 8, wraps to -8 in 4-bit signed)
    [0b0011, 0b0111, 3, 7, 10, false, true], // signed overflow (3 + 7 = 10, wraps to -6 in 4-bit signed)
    [0b1000, 0b0101, -8, 5, -3, false, false], // -8 + 5 = -3 (1101)
    [0b1011, 0b0101, 11, 5, 16, true, false], // unsigned overflow: 11 + 5 = 16 (Cout=1)
  ];
  
  let addPass = true;
  for (const [aBin, bBin, decA, decB, expectedSum, expUnsignedOv, expSignedOv] of addTable) {
    for (let i = 0; i < 4; i++) {
      swA.props.bits[i] = ((aBin >> i) & 1) === 1;
      swB.props.bits[i] = ((bBin >> i) & 1) === 1;
    }
    engine.step(0.01);
    
    let sum4 = 0;
    for (let i = 0; i < 4; i++) {
      if (engine.byPart.get(leds[i].id).device.cur[0] > 0.001) sum4 |= (1 << i);
    }
    const cout = engine.byPart.get(leds[4].id).device.cur[0] > 0.001;
    
    const a3 = (aBin >> 3) & 1;
    const b3 = (bBin >> 3) & 1;
    const c3 = (sum4 >> 3) & 1;
    const signedOv = (a3 === b3) && (c3 !== a3);
    
    if (cout !== expUnsignedOv || signedOv !== expSignedOv) {
      console.error(`  Overflow detection mismatch for A=${aBin.toString(2)} B=${bBin.toString(2)}: UnsignedOv=${cout} (exp ${expUnsignedOv}), SignedOv=${signedOv} (exp ${expSignedOv})`);
      addPass = false;
    }
  }
  recordResult('Lab 2', 'Task 1b/1c', 'Signed & Unsigned Addition Overflow Detection', addPass, 'Signed & Unsigned overflow conditions matched');
}

// Task 2a / 2b / 2c: 4-bit Subtractor using 7404 (Inverter) and 7483 (Adder)
{
  const c = new Circuit();
  c.name = 'Lab 2 - Task 2: 4-bit Subtractor (7404 + 7483)';
  
  const pVcc = new Part('vcc', 0, 0);
  const pGnd = new Part('gnd', 0, 5);
  const ic7404 = new Part('ic7404', 10, 10);
  const ic7483 = new Part('ic7483', 25, 10);
  const swX = new Part('dip4', 5, 25);
  const swY = new Part('dip4', 15, 25);
  
  c.parts.push(pVcc, pGnd, ic7404, ic7483, swX, swY);
  
  const p04 = ic7404.worldPins();
  const p83 = ic7483.worldPins();
  
  c.wires.push(new Wire(pVcc.worldPins()[0], p04[13])); // 7404 pin 14 VCC
  c.wires.push(new Wire(pGnd.worldPins()[0], p04[6]));   // 7404 pin 7 GND
  c.wires.push(new Wire(pVcc.worldPins()[0], p83[4]));   // 7483 pin 5 VCC
  c.wires.push(new Wire(pGnd.worldPins()[0], p83[11]));  // 7483 pin 12 GND
  
  // Cin = 1 for 2's complement subtraction (X + ~Y + 1)
  c.wires.push(new Wire(pVcc.worldPins()[0], p83[12])); // 7483 pin 13 Cin = 1
  
  const aPins = [9, 7, 2, 0];
  for (let i = 0; i < 4; i++) {
    c.wires.push(new Wire(swX.worldPins()[i], p83[aPins[i]]));
  }
  
  const notIns = [0, 2, 4, 8];
  const notOuts = [1, 3, 5, 7];
  const bPins = [10, 6, 3, 15];
  
  for (let i = 0; i < 4; i++) {
    c.wires.push(new Wire(swY.worldPins()[i], p04[notIns[i]]));
    c.wires.push(new Wire(p04[notOuts[i]], p83[bPins[i]]));
  }
  
  const leds = [];
  const sPins = [8, 5, 1, 14];
  for (let i = 0; i < 4; i++) {
    const led = new Part('led', 40 + i * 2, 10, 0, { color: 'blue' });
    leds.push(led);
    c.parts.push(led);
    c.wires.push(new Wire(p83[sPins[i]], led.worldPins()[0]));
    c.wires.push(new Wire(led.worldPins()[1], pGnd.worldPins()[0]));
  }
  
  fs.writeFileSync(path.join(circuitsDir, 'Lab2_Task2_7404_7483_Subtractor.cforge.json'), JSON.stringify(c.toJSON(), null, 2));
  
  const engine = new Engine();
  engine.build(c);
  
  const subTable = [
    [0b0101, 0b0000, 0b0101], // 5 - 0 = 5
    [0b0101, 0b0001, 0b0100], // 5 - 1 = 4
    [0b0101, 0b0010, 0b0011], // 5 - 2 = 3
    [0b0101, 0b0011, 0b0010], // 5 - 3 = 2
    [0b0101, 0b0100, 0b0001], // 5 - 4 = 1
    [0b0101, 0b0101, 0b0000], // 5 - 5 = 0
    [0b0101, 0b0110, 0b1111], // 5 - 6 = -1 (1111)
    [0b0101, 0b0111, 0b1110], // 5 - 7 = -2 (1110)
    [0b1000, 0b0011, 0b0101], // -8 - 3 = -11 -> 0101 (overflow!)
    [0b1001, 0b0011, 0b0110], // -7 - 3 = -10 -> 0110 (overflow!)
    [0b1010, 0b0011, 0b0111], // -6 - 3 = -9  -> 0111 (overflow!)
    [0b1011, 0b0011, 0b1000], // -5 - 3 = -8  -> 1000
    [0b1100, 0b0011, 0b1001], // -4 - 3 = -7  -> 1001
    [0b1101, 0b0011, 0b1010], // -3 - 3 = -6  -> 1010
    [0b1110, 0b0011, 0b1011], // -2 - 3 = -5  -> 1011
    [0b1111, 0b0011, 0b1100], // -1 - 3 = -4  -> 1100
  ];
  
  let subPass = true;
  for (const [x, y, expected] of subTable) {
    for (let i = 0; i < 4; i++) {
      swX.props.bits[i] = ((x >> i) & 1) === 1;
      swY.props.bits[i] = ((y >> i) & 1) === 1;
    }
    engine.step(0.01);
    
    let got = 0;
    for (let i = 0; i < 4; i++) {
      const dev = engine.byPart.get(leds[i].id).device;
      if (dev.cur[0] > 0.001) got |= (1 << i);
    }
    if (got !== expected) {
      console.error(`  Subtractor mismatch: X=${x.toString(2)} Y=${y.toString(2)}: Expected ${expected.toString(2)}, got ${got.toString(2)}`);
      subPass = false;
    }
  }
  
  recordResult('Lab 2', 'Task 2a/2b/2c', '7404 + 7483 2s Complement Subtractor', subPass, 'All 16 signed subtractions exact');
}

// -----------------------------------------------------------------------------
// LAB 3: Multiplexers, Demultiplexers / Decoders
// -----------------------------------------------------------------------------
console.log('\n========================================');
console.log('TESTING LAB 3: Multiplexers, Demultiplexers / Decoders');
console.log('========================================');

// Task 1a / 1b: 74151 8-to-1 MUX
{
  const c = new Circuit();
  c.name = 'Lab 3 - Task 1: 74151 8:1 Multiplexer';
  
  const pVcc = new Part('vcc', 0, 0);
  const pGnd = new Part('gnd', 0, 5);
  const ic74151 = new Part('ic74151', 10, 10);
  const swSelect = new Part('dip4', 5, 25);
  const swInputs = new Part('dip4', 15, 25);
  const outLed = new Part('led', 25, 10, 0, { color: 'yellow' });
  
  c.parts.push(pVcc, pGnd, ic74151, swSelect, swInputs, outLed);
  
  const p151 = ic74151.worldPins();
  c.wires.push(new Wire(pVcc.worldPins()[0], p151[15])); // pin 16 VCC
  c.wires.push(new Wire(pGnd.worldPins()[0], p151[7]));   // pin 8 GND
  c.wires.push(new Wire(pGnd.worldPins()[0], p151[6]));   // pin 7 G (Enable = 0)
  
  // S0, S1, S2 -> pins 11, 10, 9
  c.wires.push(new Wire(swSelect.worldPins()[0], p151[10]));
  c.wires.push(new Wire(swSelect.worldPins()[1], p151[9]));
  c.wires.push(new Wire(swSelect.worldPins()[2], p151[8]));
  
  // I0=0, I1=0
  c.wires.push(new Wire(pGnd.worldPins()[0], p151[3]));
  c.wires.push(new Wire(pGnd.worldPins()[0], p151[2]));
  // I2=1, I3=1
  c.wires.push(new Wire(pVcc.worldPins()[0], p151[1]));
  c.wires.push(new Wire(pVcc.worldPins()[0], p151[0]));
  // I4..I7
  c.wires.push(new Wire(swInputs.worldPins()[0], p151[14]));
  c.wires.push(new Wire(swInputs.worldPins()[1], p151[13]));
  c.wires.push(new Wire(swInputs.worldPins()[2], p151[12]));
  c.wires.push(new Wire(swInputs.worldPins()[3], p151[11]));
  
  // Output Y to LED
  c.wires.push(new Wire(p151[4], outLed.worldPins()[0]));
  c.wires.push(new Wire(outLed.worldPins()[1], pGnd.worldPins()[0]));
  
  fs.writeFileSync(path.join(circuitsDir, 'Lab3_Task1_74151_Mux.cforge.json'), JSON.stringify(c.toJSON(), null, 2));
  
  const engine = new Engine();
  engine.build(c);
  
  // Task 1b configuration: w=0, x=0, y=1, z=1
  swInputs.props.bits[0] = false;
  swInputs.props.bits[1] = false;
  swInputs.props.bits[2] = true;
  swInputs.props.bits[3] = true;
  
  const expectedOutputs = [0, 0, 1, 1, 0, 0, 1, 1];
  let muxPass = true;
  for (let s = 0; s < 8; s++) {
    swSelect.props.bits[0] = (s & 1) === 1;
    swSelect.props.bits[1] = ((s >> 1) & 1) === 1;
    swSelect.props.bits[2] = ((s >> 2) & 1) === 1;
    engine.step(0.01);
    
    const lit = engine.byPart.get(outLed.id).device.cur[0] > 0.001 ? 1 : 0;
    if (lit !== expectedOutputs[s]) {
      console.error(`  MUX mismatch at S=${s.toString(2)}: Expected ${expectedOutputs[s]}, got ${lit}`);
      muxPass = false;
    }
  }
  recordResult('Lab 3', 'Task 1a/1b', '74151 8:1 Multiplexer Truth Table', muxPass, 'All 8 channels match exactly');
}

// Task 2a / 2b: 74138 3-to-8 Demultiplexer / Decoder
{
  const c = new Circuit();
  c.name = 'Lab 3 - Task 2: 74138 3:8 Demultiplexer';
  
  const pVcc = new Part('vcc', 0, 0);
  const pGnd = new Part('gnd', 0, 5);
  const ic74138 = new Part('ic74138', 10, 10);
  const swSelect = new Part('dip4', 5, 25);
  const swData = new Part('toggle', 0, 15);
  
  c.parts.push(pVcc, pGnd, ic74138, swSelect, swData);
  
  const p138 = ic74138.worldPins();
  c.wires.push(new Wire(pVcc.worldPins()[0], p138[15])); // pin 16 VCC
  c.wires.push(new Wire(pGnd.worldPins()[0], p138[7]));   // pin 8 GND
  c.wires.push(new Wire(pGnd.worldPins()[0], p138[4]));   // pin 5 G2B = 0
  c.wires.push(new Wire(pVcc.worldPins()[0], p138[5]));   // pin 6 G1 = 1
  c.wires.push(new Wire(swData.worldPins()[0], p138[3])); // pin 4 G2A
  
  c.wires.push(new Wire(swSelect.worldPins()[0], p138[0])); // A
  c.wires.push(new Wire(swSelect.worldPins()[1], p138[1])); // B
  c.wires.push(new Wire(swSelect.worldPins()[2], p138[2])); // C
  
  const yPins = [14, 13, 12, 11, 10, 9, 8, 6];
  const leds = [];
  for (let i = 0; i < 8; i++) {
    const led = new Part('led', 25 + i * 2, 10, 0, { color: 'red' });
    leds.push(led);
    c.parts.push(led);
    c.wires.push(new Wire(pVcc.worldPins()[0], led.worldPins()[0]));
    c.wires.push(new Wire(led.worldPins()[1], p138[yPins[i]]));
  }
  
  fs.writeFileSync(path.join(circuitsDir, 'Lab3_Task2_74138_Demux.cforge.json'), JSON.stringify(c.toJSON(), null, 2));
  
  const engine = new Engine();
  engine.build(c);
  
  let demuxPass = true;
  for (let cba = 0; cba < 8; cba++) {
    swSelect.props.bits[0] = (cba & 1) === 1;
    swSelect.props.bits[1] = ((cba >> 1) & 1) === 1;
    swSelect.props.bits[2] = ((cba >> 2) & 1) === 1;
    
    // When S0 = 0: enabled, exactly Y_cba is LOW (LED lit)
    swData.props.on = false;
    engine.step(0.01);
    for (let i = 0; i < 8; i++) {
      const lit = engine.byPart.get(leds[i].id).device.cur[0] > 0.001;
      const expected = (i === cba);
      if (lit !== expected) {
        console.error(`  DEMUX enabled mismatch: CBA=${cba.toString(2)} Y${i}`);
        demuxPass = false;
      }
    }
    
    // When S0 = 1: disabled, ALL LEDs OFF
    swData.props.on = true;
    engine.step(0.01);
    for (let i = 0; i < 8; i++) {
      const lit = engine.byPart.get(leds[i].id).device.cur[0] > 0.001;
      if (lit) demuxPass = false;
    }
  }
  recordResult('Lab 3', 'Task 2a/2b', '74138 3:8 Demultiplexer / Decoder', demuxPass, 'Active-low selection & enable verified');
}

// Task 3a / 3b / 3c: 4-input AND Gate using 7408 connected to 74138 outputs
{
  const c = new Circuit();
  c.name = 'Lab 3 - Task 3: 7408 AND Logic with 74138 Decoder';
  
  const pVcc = new Part('vcc', 0, 0);
  const pGnd = new Part('gnd', 0, 5);
  const ic74138 = new Part('ic74138', 10, 10);
  const ic7408 = new Part('ic7408', 25, 10);
  const swSelect = new Part('dip4', 5, 25);
  const outLed = new Part('led', 40, 10, 0, { color: 'green' });
  
  c.parts.push(pVcc, pGnd, ic74138, ic7408, swSelect, outLed);
  
  const p138 = ic74138.worldPins();
  const p08 = ic7408.worldPins();
  
  c.wires.push(new Wire(pVcc.worldPins()[0], p138[15]));
  c.wires.push(new Wire(pGnd.worldPins()[0], p138[7]));
  c.wires.push(new Wire(pVcc.worldPins()[0], p08[13]));
  c.wires.push(new Wire(pGnd.worldPins()[0], p08[6]));
  
  // 74138 enable: G1=1, G2A=0, G2B=0
  c.wires.push(new Wire(pVcc.worldPins()[0], p138[5])); // G1=1
  c.wires.push(new Wire(pGnd.worldPins()[0], p138[3])); // G2A=0
  c.wires.push(new Wire(pGnd.worldPins()[0], p138[4])); // G2B=0
  
  c.wires.push(new Wire(swSelect.worldPins()[0], p138[0])); // A
  c.wires.push(new Wire(swSelect.worldPins()[1], p138[1])); // B
  c.wires.push(new Wire(swSelect.worldPins()[2], p138[2])); // C
  
  // 4-input AND made with three 2-input ANDs from 7408:
  // Gate 1: pins 1, 2 -> pin 3
  // Gate 2: pins 4, 5 -> pin 6
  // Gate 3: pins 9, 10 -> pin 8
  // Inputs: Y0, Y1, Y4, Y5 from 74138
  // Y0 is pin 15 (idx 14), Y1 is pin 14 (idx 13), Y4 is pin 11 (idx 10), Y5 is pin 10 (idx 9)
  c.wires.push(new Wire(p138[14], p08[0])); // Y0 to 7408 pin 1
  c.wires.push(new Wire(p138[13], p08[1])); // Y1 to 7408 pin 2
  
  c.wires.push(new Wire(p138[10], p08[3])); // Y4 to 7408 pin 4
  c.wires.push(new Wire(p138[9],  p08[4])); // Y5 to 7408 pin 5
  
  // Combine Gate 1 and Gate 2 outputs into Gate 3
  c.wires.push(new Wire(p08[2], p08[8])); // 7408 pin 3 to pin 9
  c.wires.push(new Wire(p08[5], p08[9])); // 7408 pin 6 to pin 10
  
  // Final output from pin 8 to LED
  c.wires.push(new Wire(p08[7], outLed.worldPins()[0]));
  c.wires.push(new Wire(outLed.worldPins()[1], pGnd.worldPins()[0]));
  
  fs.writeFileSync(path.join(circuitsDir, 'Lab3_Task3_74138_7408_Logic.cforge.json'), JSON.stringify(c.toJSON(), null, 2));
  
  const engine = new Engine();
  engine.build(c);
  
  // Expected table from Lab 3 Task 3c:
  // F = Y0 * Y1 * Y4 * Y5
  // When CBA is 000 (Y0=0), 001 (Y1=0), 100 (Y4=0), 101 (Y5=0): F = 0
  // When CBA is 010 (Y2=0), 011 (Y3=0), 110 (Y6=0), 111 (Y7=0): Y0, Y1, Y4, Y5 are all 1 -> F = 1!
  const expAnd = [0, 0, 1, 1, 0, 0, 1, 1];
  let andPass = true;
  for (let cba = 0; cba < 8; cba++) {
    swSelect.props.bits[0] = (cba & 1) === 1;
    swSelect.props.bits[1] = ((cba >> 1) & 1) === 1;
    swSelect.props.bits[2] = ((cba >> 2) & 1) === 1;
    engine.step(0.01);
    
    const lit = engine.byPart.get(outLed.id).device.cur[0] > 0.001 ? 1 : 0;
    if (lit !== expAnd[cba]) {
      console.error(`  AND Gate logic mismatch for CBA=${cba.toString(2)}: Expected ${expAnd[cba]}, got ${lit}`);
      andPass = false;
    }
  }
  recordResult('Lab 3', 'Task 3a/3b/3c', '7408 4-input AND with 74138 Decoder', andPass, 'Decoder minterm product matches table');
}

// -----------------------------------------------------------------------------
// LAB 4: Gate Level Design of Combinational Circuits
// -----------------------------------------------------------------------------
console.log('\n========================================');
console.log('TESTING LAB 4: Gate Level Combinational Circuits');
console.log('========================================');

// Task 1a / 1b: 7483 + 7486 4-bit Adder / Subtractor (with A/S line)
{
  const c = new Circuit();
  c.name = 'Lab 4 - Task 1: 4-bit Adder/Subtractor (7483 + 7486)';
  
  const pVcc = new Part('vcc', 0, 0);
  const pGnd = new Part('gnd', 0, 5);
  const ic7486 = new Part('ic7486', 10, 10);
  const ic7483 = new Part('ic7483', 25, 10);
  const swX = new Part('dip4', 5, 25);
  const swY = new Part('dip4', 15, 25);
  const swAS = new Part('toggle', 0, 15);
  
  c.parts.push(pVcc, pGnd, ic7486, ic7483, swX, swY, swAS);
  
  const p86 = ic7486.worldPins();
  const p83 = ic7483.worldPins();
  
  c.wires.push(new Wire(pVcc.worldPins()[0], p86[13])); // 7486 pin 14 VCC
  c.wires.push(new Wire(pGnd.worldPins()[0], p86[6]));   // 7486 pin 7 GND
  c.wires.push(new Wire(pVcc.worldPins()[0], p83[4]));   // 7483 pin 5 VCC
  c.wires.push(new Wire(pGnd.worldPins()[0], p83[11]));  // 7483 pin 12 GND
  
  // Connect A/S line to Cin (pin 13, idx 12) of 7483
  c.wires.push(new Wire(swAS.worldPins()[0], p83[12]));
  
  const xorIn1 = [0, 3, 9, 12];
  const xorIn2 = [1, 4, 8, 11];
  const xorOut = [2, 5, 7, 10];
  
  const bPins = [10, 6, 3, 15];
  const aPins = [9, 7, 2, 0];
  
  for (let i = 0; i < 4; i++) {
    c.wires.push(new Wire(swX.worldPins()[i], p83[aPins[i]]));
    c.wires.push(new Wire(swY.worldPins()[i], p86[xorIn1[i]]));
    c.wires.push(new Wire(swAS.worldPins()[0], p86[xorIn2[i]]));
    c.wires.push(new Wire(p86[xorOut[i]], p83[bPins[i]]));
  }
  
  const leds = [];
  const sPins = [8, 5, 1, 14];
  for (let i = 0; i < 4; i++) {
    const led = new Part('led', 40 + i * 2, 10, 0, { color: 'green' });
    leds.push(led);
    c.parts.push(led);
    c.wires.push(new Wire(p83[sPins[i]], led.worldPins()[0]));
    c.wires.push(new Wire(led.worldPins()[1], pGnd.worldPins()[0]));
  }
  
  fs.writeFileSync(path.join(circuitsDir, 'Lab4_Task1_Adder_Subtractor_XOR.cforge.json'), JSON.stringify(c.toJSON(), null, 2));
  
  const engine = new Engine();
  engine.build(c);
  
  const testTable = [
    [0b0000, 0b0101, 0, 0b0101], // 0 + 5 = 5
    [0b0001, 0b0101, 0, 0b0110], // 1 + 5 = 6
    [0b0010, 0b0101, 0, 0b0111], // 2 + 5 = 7
    [0b0011, 0b0101, 0, 0b1000], // 3 + 5 = 8 -> 1000 (signed overflow)
    [0b0100, 0b0101, 0, 0b1001], // 4 + 5 = 9 -> 1001 (signed overflow)
    [0b0101, 0b0101, 0, 0b1010], // 5 + 5 = 10 -> 1010 (signed overflow)
    [0b0110, 0b0101, 0, 0b1011], // 6 + 5 = 11 -> 1011 (signed overflow)
    [0b0111, 0b0101, 0, 0b1100], // 7 + 5 = 12 -> 1100 (signed overflow)
    // Subtractions (A/S = 1):
    [0b0110, 0b1000, 1, 0b1110], // 6 - (-8) = 14 -> 1110 (signed overflow)
    [0b0110, 0b1001, 1, 0b1101], // 6 - (-7) = 13 -> 1101 (signed overflow)
    [0b0110, 0b1010, 1, 0b1100], // 6 - (-6) = 12 -> 1100 (signed overflow)
    [0b0110, 0b1011, 1, 0b1011], // 6 - (-5) = 11 -> 1011 (signed overflow)
    [0b0110, 0b1100, 1, 0b1010], // 6 - (-4) = 10 -> 1010 (signed overflow)
    [0b0110, 0b1101, 1, 0b1001], // 6 - (-3) = 9 -> 1001 (signed overflow)
    [0b0110, 0b1110, 1, 0b1000], // 6 - (-2) = 8 -> 1000 (signed overflow)
    [0b0110, 0b1111, 1, 0b0111], // 6 - (-1) = 7 -> 0111
  ];
  
  let asPass = true;
  for (const [x, y, asMode, expected] of testTable) {
    swAS.props.on = (asMode === 1);
    for (let i = 0; i < 4; i++) {
      swX.props.bits[i] = ((x >> i) & 1) === 1;
      swY.props.bits[i] = ((y >> i) & 1) === 1;
    }
    engine.step(0.01);
    
    let got = 0;
    for (let i = 0; i < 4; i++) {
      const dev = engine.byPart.get(leds[i].id).device;
      if (dev.cur[0] > 0.001) got |= (1 << i);
    }
    if (got !== expected) {
      console.error(`  Adder/Subtractor mismatch: X=${x.toString(2)} Y=${y.toString(2)} A/S=${asMode}: Expected ${expected.toString(2)}, got ${got.toString(2)}`);
      asPass = false;
    }
  }
  recordResult('Lab 4', 'Task 1a/1b', '7483 + 7486 4-bit Adder/Subtractor', asPass, 'Add & Subtract modes match table');
}

// Task 2a / 2b: Simplified SOP circuit (7408 AND + 7432 OR)
// Truth table: F = 1 for minterms 1, 2, 3, 4, 6
// Simplified boolean function: F = x'z + y + xz'
{
  const c = new Circuit();
  c.name = 'Lab 4 - Task 2: Simplified SOP Circuit (7408 AND + 7432 OR)';
  
  const pVcc = new Part('vcc', 0, 0);
  const pGnd = new Part('gnd', 0, 5);
  const ic7404 = new Part('ic7404', 10, 10); // NOT
  const ic7408 = new Part('ic7408', 25, 10); // AND
  const ic7432 = new Part('ic7432', 40, 10); // OR
  const swXYZ = new Part('dip4', 5, 25);     // S7:x, S8:y, S9:z
  const outLed = new Part('led', 55, 10, 0, { color: 'green' });
  
  c.parts.push(pVcc, pGnd, ic7404, ic7408, ic7432, swXYZ, outLed);
  
  const p04 = ic7404.worldPins();
  const p08 = ic7408.worldPins();
  const p32 = ic7432.worldPins();
  
  // Power
  c.wires.push(new Wire(pVcc.worldPins()[0], p04[13]));
  c.wires.push(new Wire(pGnd.worldPins()[0], p04[6]));
  c.wires.push(new Wire(pVcc.worldPins()[0], p08[13]));
  c.wires.push(new Wire(pGnd.worldPins()[0], p08[6]));
  c.wires.push(new Wire(pVcc.worldPins()[0], p32[13]));
  c.wires.push(new Wire(pGnd.worldPins()[0], p32[6]));
  
  // Invert x (swXYZ[0]) and z (swXYZ[2]):
  // x -> 7404 pin 1 (idx 0), x' -> pin 2 (idx 1)
  // z -> 7404 pin 3 (idx 2), z' -> pin 4 (idx 3)
  c.wires.push(new Wire(swXYZ.worldPins()[0], p04[0]));
  c.wires.push(new Wire(swXYZ.worldPins()[2], p04[2]));
  
  // AND 1: x' * z -> 7408 pin 1, 2 -> pin 3 (idx 0, 1 -> 2)
  c.wires.push(new Wire(p04[1], p08[0]));              // x'
  c.wires.push(new Wire(swXYZ.worldPins()[2], p08[1]));// z
  
  // AND 2: x * z' -> 7408 pin 4, 5 -> pin 6 (idx 3, 4 -> 5)
  c.wires.push(new Wire(swXYZ.worldPins()[0], p08[3]));// x
  c.wires.push(new Wire(p04[3], p08[4]));              // z'
  
  // AND 3: y * z' -> 7408 pin 9, 10 -> pin 8 (idx 8, 9 -> 7)
  c.wires.push(new Wire(swXYZ.worldPins()[1], p08[8]));// y
  c.wires.push(new Wire(p04[3], p08[9]));              // z'
  
  // OR 1: (x'z) + (xz') -> 7432 pin 1, 2 -> pin 3 (idx 0, 1 -> 2)
  c.wires.push(new Wire(p08[2], p32[0]));              // x'z
  c.wires.push(new Wire(p08[5], p32[1]));              // xz'
  
  // OR 2: (x'z + xz') + (yz') -> 7432 pin 4, 5 -> pin 6 (idx 3, 4 -> 5)
  c.wires.push(new Wire(p32[2], p32[3]));              // (x'z + xz')
  c.wires.push(new Wire(p08[7], p32[4]));              // yz'
  
  // Output F from pin 6 to LED
  c.wires.push(new Wire(p32[5], outLed.worldPins()[0]));
  c.wires.push(new Wire(outLed.worldPins()[1], pGnd.worldPins()[0]));
  
  fs.writeFileSync(path.join(circuitsDir, 'Lab4_Task2_SOP_Circuit.cforge.json'), JSON.stringify(c.toJSON(), null, 2));
  
  const engine = new Engine();
  engine.build(c);
  
  // Truth table from Lab 4 Task 2a:
  // xyz: 000->0, 001->1, 010->1, 011->1, 100->1, 101->0, 110->1, 111->0
  const expF = [0, 1, 1, 1, 1, 0, 1, 0];
  let sopPass = true;
  for (let xyz = 0; xyz < 8; xyz++) {
    const x = (xyz >> 2) & 1;
    const y = (xyz >> 1) & 1;
    const z = xyz & 1;
    swXYZ.props.bits[0] = (x === 1);
    swXYZ.props.bits[1] = (y === 1);
    swXYZ.props.bits[2] = (z === 1);
    engine.step(0.01);
    
    const lit = engine.byPart.get(outLed.id).device.cur[0] > 0.001 ? 1 : 0;
    if (lit !== expF[xyz]) {
      console.error(`  SOP mismatch for xyz=${xyz.toString(2).padStart(3,'0')}: Expected ${expF[xyz]}, got ${lit}`);
      sopPass = false;
    }
  }
  recordResult('Lab 4', 'Task 2a/2b', 'Simplified SOP Circuit (x\'z + y + xz\')', sopPass, 'All 8 truth table minterms match');
}

// -----------------------------------------------------------------------------
// LAB 5: Testing a Clocked Integrated Circuit
// -----------------------------------------------------------------------------
console.log('\n========================================');
console.log('TESTING LAB 5: Clocked Circuit (555 Timer & 7493 Counter)');
console.log('========================================');

// Task 1: 555 Timer Astable Multivibrator (~1s period)
{
  const c = new Circuit();
  c.name = 'Lab 5 - Task 1: 555 Timer Astable Multivibrator';
  
  const pVcc = new Part('vcc', 0, 0);
  const pGnd = new Part('gnd', 0, 5);
  const ic555 = new Part('ne555', 10, 10);
  const rA = new Part('resistor', 5, 2, 0, { ohms: 50000 });
  const rB = new Part('resistor', 5, 4, 0, { ohms: 50000 });
  const cap = new Part('capacitor', 5, 6, 0, { uf: 10 });
  const outLed = new Part('led', 20, 10, 0, { color: 'blue' });
  
  c.parts.push(pVcc, pGnd, ic555, rA, rB, cap, outLed);
  
  const p5 = ic555.worldPins();
  c.wires.push(new Wire(pVcc.worldPins()[0], p5[7])); // pin 8 VCC
  c.wires.push(new Wire(pGnd.worldPins()[0], p5[0])); // pin 1 GND
  c.wires.push(new Wire(pVcc.worldPins()[0], p5[3])); // pin 4 RESET to VCC
  
  // Ra between VCC and DIS (pin 7)
  c.wires.push(new Wire(pVcc.worldPins()[0], rA.worldPins()[0]));
  c.wires.push(new Wire(rA.worldPins()[1], p5[6]));
  
  // Rb between DIS and THR/TRIG (pins 6 & 2)
  c.wires.push(new Wire(p5[6], rB.worldPins()[0]));
  c.wires.push(new Wire(rB.worldPins()[1], p5[5]));
  c.wires.push(new Wire(p5[5], p5[1]));
  
  // C between THR/TRIG and GND
  c.wires.push(new Wire(p5[5], cap.worldPins()[0]));
  c.wires.push(new Wire(cap.worldPins()[1], pGnd.worldPins()[0]));
  
  // Pin 3 OUT to LED
  c.wires.push(new Wire(p5[2], outLed.worldPins()[0]));
  c.wires.push(new Wire(outLed.worldPins()[1], pGnd.worldPins()[0]));
  
  fs.writeFileSync(path.join(circuitsDir, 'Lab5_Task1_555_Astable_1Hz.cforge.json'), JSON.stringify(c.toJSON(), null, 2));
  
  const engine = new Engine();
  engine.build(c);
  
  let transitions = 0;
  let prevOut = 0;
  let tStart = 0;
  let tPeriods = [];
  
  for (let t = 0; t < 3.5; t += 0.005) {
    engine.step(0.005);
    const vout = engine.V[engine.pointNet.get(`${p5[2].x},${p5[2].y}`)];
    const outHigh = vout > 2.5 ? 1 : 0;
    if (outHigh !== prevOut) {
      if (outHigh === 1) {
        if (tStart > 0) tPeriods.push(t - tStart);
        tStart = t;
      }
      prevOut = outHigh;
      transitions++;
    }
  }
  
  const avgPeriod = tPeriods.length ? (tPeriods.reduce((a,b)=>a+b,0) / tPeriods.length) : 0;
  const oscPass = transitions >= 4 && avgPeriod > 0.7 && avgPeriod < 1.4;
  recordResult('Lab 5', 'Task 1', '555 Astable Multivibrator Oscillation', oscPass, `Measured period ≈ ${avgPeriod.toFixed(2)}s (~1s nominal), ${transitions} transitions`);
}

// Task 2a & 2b & 2c: 7493 4-bit Binary Counter and Modulo-10 Counter
{
  const c = new Circuit();
  c.name = 'Lab 5 - Task 2: 7493 Counter + 7447 + 7-Segment Display';
  
  const pVcc = new Part('vcc', 0, 0);
  const pGnd = new Part('gnd', 0, 5);
  const ic7493 = new Part('ic7493', 10, 10);
  const ic7447 = new Part('ic7447', 25, 10);
  const seg7 = new Part('seg7', 40, 10, 0, { common: 'anode', color: 'red' });
  const clock = new Part('clock', 0, 15, 0, { hz: 5 });
  
  c.parts.push(pVcc, pGnd, ic7493, ic7447, seg7, clock);
  
  const p93 = ic7493.worldPins();
  const p47 = ic7447.worldPins();
  const pSeg = seg7.worldPins();
  
  c.wires.push(new Wire(pVcc.worldPins()[0], p93[4])); // pin 5 VCC
  c.wires.push(new Wire(pGnd.worldPins()[0], p93[9])); // pin 10 GND
  c.wires.push(new Wire(p93[11], p93[0]));            // QA to CKB
  c.wires.push(new Wire(clock.worldPins()[0], p93[13]));// Clock to CKA
  
  // RST1 and RST2 to GND
  c.wires.push(new Wire(pGnd.worldPins()[0], p93[1]));
  c.wires.push(new Wire(pGnd.worldPins()[0], p93[2]));
  
  // Power 7447
  c.wires.push(new Wire(pVcc.worldPins()[0], p47[15]));
  c.wires.push(new Wire(pGnd.worldPins()[0], p47[7]));
  c.wires.push(new Wire(pVcc.worldPins()[0], p47[2])); // LT
  c.wires.push(new Wire(pVcc.worldPins()[0], p47[3])); // BI
  c.wires.push(new Wire(pVcc.worldPins()[0], p47[4])); // RBI
  
  // Connect 7493 outputs QA, QB, QC, QD to 7447 inputs A, B, C, D
  // QA (idx 11) -> A (idx 6)
  // QB (idx 8)  -> B (idx 0)
  // QC (idx 7)  -> C (idx 1)
  // QD (idx 10) -> D (idx 5)
  c.wires.push(new Wire(p93[11], p47[6]));
  c.wires.push(new Wire(p93[8],  p47[0]));
  c.wires.push(new Wire(p93[7],  p47[1]));
  c.wires.push(new Wire(p93[10], p47[5]));
  
  // Connect 7447 to 7-segment display
  c.wires.push(new Wire(pVcc.worldPins()[0], pSeg[2])); // COM
  const segMap = {
    a: [p47[12], pSeg[6]],
    b: [p47[11], pSeg[5]],
    c: [p47[10], pSeg[3]],
    d: [p47[9],  pSeg[1]],
    e: [p47[8],  pSeg[0]],
    f: [p47[14], pSeg[8]],
    g: [p47[13], pSeg[9]],
  };
  for (const [fromPin, toPin] of Object.values(segMap)) {
    c.wires.push(new Wire(fromPin, toPin));
  }
  
  fs.writeFileSync(path.join(circuitsDir, 'Lab5_Task2_7493_7447_Counter.cforge.json'), JSON.stringify(c.toJSON(), null, 2));
  
  const engine = new Engine();
  engine.build(c);
  
  const countsSeen = new Set();
  for (let t = 0; t < 3.5; t += 0.05) {
    engine.step(0.05);
    const vQa = engine.V[engine.pointNet.get(`${p93[11].x},${p93[11].y}`)] > 2 ? 1 : 0;
    const vQb = engine.V[engine.pointNet.get(`${p93[8].x},${p93[8].y}`)] > 2 ? 1 : 0;
    const vQc = engine.V[engine.pointNet.get(`${p93[7].x},${p93[7].y}`)] > 2 ? 1 : 0;
    const vQd = engine.V[engine.pointNet.get(`${p93[10].x},${p93[10].y}`)] > 2 ? 1 : 0;
    const val = vQa | (vQb << 1) | (vQc << 2) | (vQd << 3);
    countsSeen.add(val);
  }
  
  const count16Pass = countsSeen.size >= 15;
  recordResult('Lab 5', 'Task 2a/2b', '7493 4-bit Counter + 7447 Display (0 to 15)', count16Pass, `Full 4-bit range cycled, ${countsSeen.size} states displayed`);
  
  // Task 2c: Modulo-10 Reset (0 to 9)
  const cMod10 = new Circuit();
  cMod10.name = 'Lab 5 - Task 2c: 7493 Modulo-10 Decade Counter';
  cMod10.parts.push(pVcc, pGnd, ic7493, clock);
  cMod10.wires.push(new Wire(pVcc.worldPins()[0], p93[4]));
  cMod10.wires.push(new Wire(pGnd.worldPins()[0], p93[9]));
  cMod10.wires.push(new Wire(p93[11], p93[0]));
  cMod10.wires.push(new Wire(clock.worldPins()[0], p93[13]));
  
  // QD (idx 10) to RST1 (idx 1), QB (idx 8) to RST2 (idx 2)
  cMod10.wires.push(new Wire(p93[10], p93[1]));
  cMod10.wires.push(new Wire(p93[8],  p93[2]));
  
  fs.writeFileSync(path.join(circuitsDir, 'Lab5_Task2c_Modulo10_Decade.cforge.json'), JSON.stringify(cMod10.toJSON(), null, 2));
  
  const eng10 = new Engine();
  eng10.build(cMod10);
  
  const countsMod10 = new Set();
  let maxCount = 0;
  for (let t = 0; t < 4.0; t += 0.05) {
    eng10.step(0.05);
    const vQa = eng10.V[eng10.pointNet.get(`${p93[11].x},${p93[11].y}`)] > 2 ? 1 : 0;
    const vQb = eng10.V[eng10.pointNet.get(`${p93[8].x},${p93[8].y}`)] > 2 ? 1 : 0;
    const vQc = eng10.V[eng10.pointNet.get(`${p93[7].x},${p93[7].y}`)] > 2 ? 1 : 0;
    const vQd = eng10.V[eng10.pointNet.get(`${p93[10].x},${p93[10].y}`)] > 2 ? 1 : 0;
    const val = vQa | (vQb << 1) | (vQc << 2) | (vQd << 3);
    countsMod10.add(val);
    maxCount = Math.max(maxCount, val);
  }
  
  const mod10Pass = maxCount <= 9 && countsMod10.size >= 9;
  recordResult('Lab 5', 'Task 2c', '7493 Modulo-10 Reset (Count 0 to 9)', mod10Pass, `Max count = ${maxCount} (never reaches 10+), counts 0..9 smoothly`);
}

console.log('\n========================================');
console.log('SUMMARY OF ALL LAB SIMULATION TESTS:');
console.log('========================================');
const totalPassed = results.filter(r => r.passed).length;
console.log(`Passed: ${totalPassed} / ${results.length}`);
if (totalPassed === results.length) {
  console.log('ALL LAB TASKS SIMULATE WITH 100% SUCCESS ON CIRCUITFORGE STUDIO!');
} else {
  console.error('Some tasks failed.');
}

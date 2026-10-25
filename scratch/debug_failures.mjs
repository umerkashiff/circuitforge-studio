import { Circuit, Wire, Part } from '../src/model.js';
import { Engine } from '../src/sim/engine.js';
import '../src/parts/library.js';

// Debug T3
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
  const sPins = [8, 5, 1, 14, 13];
  const eng = new Engine();
  eng.build(c);
  
  const addVectors = [
    [0b0011, 0, false, false],
    [0b0011, 1, false, false],
    [0b0011, 2, false, false],
    [0b0011, 3, false, false],
    [0b0011, 4, false, false],
    [0b0011, 5, false, false],
    [0b0011, 6, false, true],
    [0b0011, 7, false, true],
    [0b1000, 5, false, false],
    [0b1001, 5, false, false],
    [0b1010, 5, false, false],
    [0b1011, 5, true, false],
    [0b1100, 5, true, false],
    [0b1101, 5, true, false],
    [0b1110, 5, true, false],
    [0b1111, 5, true, false],
  ];
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
    if (cout !== expUnsignedOv || signedOv !== expSignedOv) {
      console.log(`T3 mismatch for A=${a.toString(2)} B=${b.toString(2)}: sum=${s4.toString(2)}, cout=${cout} (exp ${expUnsignedOv}), signedOv=${signedOv} (exp ${expSignedOv})`);
    }
  }
}

// Debug F5
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
  c.wires.push(new Wire(vcc.worldPins()[0], p76[4]));
  c.wires.push(new Wire(gnd.worldPins()[0], p76[12]));
  
  c.wires.push(new Wire(swCLK.worldPins()[0], p76[0]));
  c.wires.push(new Wire(swPRE.worldPins()[0], p76[1]));
  c.wires.push(new Wire(swCLR.worldPins()[0], p76[2]));
  c.wires.push(new Wire(swJ.worldPins()[0],   p76[3]));
  c.wires.push(new Wire(swK.worldPins()[0],   p76[15]));
  
  const eng = new Engine();
  eng.build(c);
  
  console.log('F5 Debug:');
  swCLR.props.on = false; eng.step(0.01); swCLR.props.on = true; eng.step(0.01);
  console.log('After clear Q=', eng.V[eng.pointNet.get(`${p76[14].x},${p76[14].y}`)]);
  
  swJ.props.on = true; swK.props.on = false;
  swCLK.props.on = false; eng.step(0.01);
  console.log('After Set (CLK 1->0) Q=', eng.V[eng.pointNet.get(`${p76[14].x},${p76[14].y}`)]);
  
  swCLK.props.on = true; eng.step(0.01);
  swCLK.props.on = false; eng.step(0.01);
  console.log('After CLK toggle Q=', eng.V[eng.pointNet.get(`${p76[14].x},${p76[14].y}`)]);
}

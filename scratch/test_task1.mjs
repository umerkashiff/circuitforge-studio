import { Circuit, Wire, Part } from '../src/model.js';
import { Engine } from '../src/sim/engine.js';
import '../src/parts/library.js';

console.log('--- TEST TASK 1.b: JK Flip-Flop In-Step Verification ---');

// Test 1: F5 Repro - Q must be HIGH in the SAME step as the falling clock edge
{
  const c = new Circuit();
  const vcc = new Part('vcc', 0, 0);
  const gnd = new Part('gnd', 0, 5);
  const ic76 = new Part('ic7476', 10, 10);
  const clk = new Part('toggle', 0, 15, 0, { on: true });
  const j = new Part('toggle', 0, 20, 0, { on: true });
  const k = new Part('toggle', 0, 25, 0, { on: false });
  const pre = new Part('toggle', 0, 30, 0, { on: true });
  const clr = new Part('toggle', 0, 35, 0, { on: true });

  c.parts.push(vcc, gnd, ic76, clk, j, k, pre, clr);
  const p = ic76.worldPins();
  c.wires.push(
    new Wire(vcc.worldPins()[0], p[4]),
    new Wire(gnd.worldPins()[0], p[12]),
    new Wire(clk.worldPins()[0], p[0]),
    new Wire(pre.worldPins()[0], p[1]),
    new Wire(clr.worldPins()[0], p[2]),
    new Wire(j.worldPins()[0],   p[3]),
    new Wire(k.worldPins()[0],   p[15])
  );

  const eng = new Engine();
  eng.build(c);

  // Clear Q to 0
  clr.props.on = false; eng.step(0.01); clr.props.on = true; eng.step(0.01);
  const qCleared = eng.V[eng.pointNet.get(`${p[14].x},${p[14].y}`)] > 2.0 ? 1 : 0;
  console.assert(qCleared === 0, 'Clear must make Q=0');

  // Falling clock edge (1 -> 0) with J=1, K=0 (SET)
  clk.props.on = false;
  eng.step(0.01);

  const qSameStep = eng.V[eng.pointNet.get(`${p[14].x},${p[14].y}`)] > 2.0 ? 1 : 0;
  console.log('1. F5 Repro test: Q in SAME step as falling edge =', qSameStep);
  console.assert(qSameStep === 1, 'Q MUST be HIGH in the SAME step as the falling clock edge!');

  // Test 2: JK=00 hold, 01 reset, 10 set, 11 toggle, each checked in the same step
  // 2a. JK=00 (hold): clock 0->1, then 1->0
  clk.props.on = true; eng.step(0.01);
  j.props.on = false; k.props.on = false;
  clk.props.on = false; eng.step(0.01);
  const qHold = eng.V[eng.pointNet.get(`${p[14].x},${p[14].y}`)] > 2.0 ? 1 : 0;
  console.log('2a. Hold test (JK=00): Q =', qHold);
  console.assert(qHold === 1, 'Hold must keep Q=1');

  // 2b. JK=01 (reset): clock 0->1, then 1->0
  clk.props.on = true; eng.step(0.01);
  j.props.on = false; k.props.on = true;
  clk.props.on = false; eng.step(0.01);
  const qReset = eng.V[eng.pointNet.get(`${p[14].x},${p[14].y}`)] > 2.0 ? 1 : 0;
  console.log('2b. Reset test (JK=01): Q =', qReset);
  console.assert(qReset === 0, 'Reset must make Q=0 in same step');

  // 2c. JK=10 (set): clock 0->1, then 1->0
  clk.props.on = true; eng.step(0.01);
  j.props.on = true; k.props.on = false;
  clk.props.on = false; eng.step(0.01);
  const qSet = eng.V[eng.pointNet.get(`${p[14].x},${p[14].y}`)] > 2.0 ? 1 : 0;
  console.log('2c. Set test (JK=10): Q =', qSet);
  console.assert(qSet === 1, 'Set must make Q=1 in same step');

  // 2d. JK=11 (toggle): clock 0->1, then 1->0
  clk.props.on = true; eng.step(0.01);
  j.props.on = true; k.props.on = true;
  clk.props.on = false; eng.step(0.01);
  const qTog1 = eng.V[eng.pointNet.get(`${p[14].x},${p[14].y}`)] > 2.0 ? 1 : 0;
  console.log('2d. Toggle 1 test (JK=11): Q =', qTog1);
  console.assert(qTog1 === 0, 'Toggle from 1 must make Q=0 in same step');

  clk.props.on = true; eng.step(0.01);
  clk.props.on = false; eng.step(0.01);
  const qTog2 = eng.V[eng.pointNet.get(`${p[14].x},${p[14].y}`)] > 2.0 ? 1 : 0;
  console.log('2e. Toggle 2 test (JK=11): Q =', qTog2);
  console.assert(qTog2 === 1, 'Toggle from 0 must make Q=1 in same step');

  // Test 3: PRE/CLR asynchronous override
  clr.props.on = false; eng.step(0.01);
  const qAsyncClr = eng.V[eng.pointNet.get(`${p[14].x},${p[14].y}`)] > 2.0 ? 1 : 0;
  console.log('3a. Async CLR=0 test: Q =', qAsyncClr);
  console.assert(qAsyncClr === 0, 'Async CLR=0 must force Q=0');
  clr.props.on = true;

  pre.props.on = false; eng.step(0.01);
  const qAsyncPre = eng.V[eng.pointNet.get(`${p[14].x},${p[14].y}`)] > 2.0 ? 1 : 0;
  console.log('3b. Async PRE=0 test: Q =', qAsyncPre);
  console.assert(qAsyncPre === 1, 'Async PRE=0 must force Q=1');
  pre.props.on = true;

  // PRE=0 and CLR=0 -> Q=1, Qbar=1
  pre.props.on = false; clr.props.on = false; eng.step(0.01);
  const qBoth = eng.V[eng.pointNet.get(`${p[14].x},${p[14].y}`)] > 2.0 ? 1 : 0;
  const qnBoth = eng.V[eng.pointNet.get(`${p[13].x},${p[13].y}`)] > 2.0 ? 1 : 0;
  console.log('3c. PRE=0 & CLR=0 test: Q =', qBoth, 'Qbar =', qnBoth);
  console.assert(qBoth === 1 && qnBoth === 1, 'PRE=0 & CLR=0 must make both Q and Qbar HIGH');
}

// Test 4: Two 7476 stages as a toggle chain (J=K=1): Q0 = clk/2, Q1 = clk/4
// Compare counting sequence step by step with 7493 divide chain!
{
  const c = new Circuit();
  const vcc = new Part('vcc', 0, 0);
  const gnd = new Part('gnd', 0, 5);
  const ic76 = new Part('ic7476', 10, 10);
  const ic93 = new Part('ic7493', 25, 10);
  const clk = new Part('toggle', 0, 15, 0, { on: true });

  c.parts.push(vcc, gnd, ic76, ic93, clk);
  const p76 = ic76.worldPins();
  const p93 = ic93.worldPins();

  // Power
  c.wires.push(new Wire(vcc.worldPins()[0], p76[4]), new Wire(gnd.worldPins()[0], p76[12]));
  c.wires.push(new Wire(vcc.worldPins()[0], p93[4]), new Wire(gnd.worldPins()[0], p93[9]));
  c.wires.push(new Wire(gnd.worldPins()[0], p93[1]), new Wire(gnd.worldPins()[0], p93[2])); // 7493 RST1=RST2=0

  // 7476 FF1 (Stage 0):
  // 1CLK=p[0], 1PRE=p[1], 1CLR=p[2], 1J=p[3], 1K=p[15], 1Q=p[14], 1Qbar=p[13]
  c.wires.push(new Wire(clk.worldPins()[0], p76[0])); // clock -> 1CLK
  c.wires.push(new Wire(vcc.worldPins()[0], p76[1])); // 1PRE = 1
  c.wires.push(new Wire(vcc.worldPins()[0], p76[2])); // 1CLR = 1
  c.wires.push(new Wire(vcc.worldPins()[0], p76[3])); // 1J = 1
  c.wires.push(new Wire(vcc.worldPins()[0], p76[15])); // 1K = 1

  // 7476 FF2 (Stage 1): clocked by FF1 1Q (ripple counter, falling edge of 1Q)
  // 2CLK=p[5], 2PRE=p[6], 2CLR=p[7], 2J=p[8], 2Qbar=p[9], 2Q=p[10], 2K=p[11]
  c.wires.push(new Wire(p76[14], p76[5])); // 1Q -> 2CLK
  c.wires.push(new Wire(vcc.worldPins()[0], p76[6])); // 2PRE = 1
  c.wires.push(new Wire(vcc.worldPins()[0], p76[7])); // 2CLR = 1
  c.wires.push(new Wire(vcc.worldPins()[0], p76[8])); // 2J = 1
  c.wires.push(new Wire(vcc.worldPins()[0], p76[11])); // 2K = 1

  // 7493 connection: clock to CKA (p[13]), QA (p[11]) to CKB (p[0])
  c.wires.push(new Wire(clk.worldPins()[0], p93[13])); // clock -> CKA
  c.wires.push(new Wire(p93[11], p93[0]));             // QA -> CKB

  const eng = new Engine();
  eng.build(c);

  console.log('\n4. Toggle Chain (7476) vs Ripple Counter (7493) 2-bit Comparison:');
  let match = true;
  for (let cycle = 0; cycle < 8; cycle++) {
    // Clock High
    clk.props.on = true; eng.step(0.01);
    // Clock Low (Falling Edge)
    clk.props.on = false; eng.step(0.01);

    const q0_76 = eng.V[eng.pointNet.get(`${p76[14].x},${p76[14].y}`)] > 2.0 ? 1 : 0;
    const q1_76 = eng.V[eng.pointNet.get(`${p76[10].x},${p76[10].y}`)] > 2.0 ? 1 : 0;
    const count76 = (q1_76 << 1) | q0_76;

    const qa_93 = eng.V[eng.pointNet.get(`${p93[11].x},${p93[11].y}`)] > 2.0 ? 1 : 0;
    const qb_93 = eng.V[eng.pointNet.get(`${p93[8].x},${p93[8].y}`)] > 2.0 ? 1 : 0;
    const count93 = (qb_93 << 1) | qa_93;

    console.log(`  Clock pulse ${cycle + 1}: 7476 (Q1Q0) = ${q1_76}${q0_76} (${count76}) | 7493 (QBQA) = ${qb_93}${qa_93} (${count93})`);
    if (count76 !== count93) match = false;
  }
  console.assert(match, '7476 2-bit toggle chain must match 7493 divide chain step-for-step!');
}

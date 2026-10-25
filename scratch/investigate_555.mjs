import { Circuit, Wire, Part } from '../src/model.js';
import { Engine } from '../src/sim/engine.js';
import '../src/parts/library.js';

function build555Circuit(raVal = 50000, rbVal = 50000, cUf = 10) {
  const c = new Circuit();
  const vcc = new Part('vcc', 0, 0);
  const gnd = new Part('gnd', 0, 5);
  const ic555 = new Part('ne555', 10, 10);
  const ra = new Part('resistor', 25, 5, 0, { ohms: raVal });
  const rb = new Part('resistor', 25, 12, 0, { ohms: rbVal });
  const cap = new Part('capacitor', 25, 20, 0, { uf: cUf });
  c.parts.push(vcc, gnd, ic555, ra, rb, cap);

  const p5 = ic555.worldPins();
  const pVcc = vcc.worldPins()[0];
  const pGnd = gnd.worldPins()[0];
  const pRa = ra.worldPins();
  const pRb = rb.worldPins();
  const pCap = cap.worldPins();

  c.wires.push(new Wire(pVcc, p5[7])); // VCC -> pin 8
  c.wires.push(new Wire(pVcc, p5[3])); // VCC -> pin 4 (RESET)
  c.wires.push(new Wire(pGnd, p5[0])); // GND -> pin 1
  c.wires.push(new Wire(pGnd, pCap[1])); // GND -> Cap -

  c.wires.push(new Wire(pVcc, pRa[0])); // VCC -> Ra
  c.wires.push(new Wire(pRa[1], p5[6])); // Ra -> pin 7 (DIS)
  c.wires.push(new Wire(p5[6], pRb[0])); // pin 7 -> Rb
  c.wires.push(new Wire(pRb[1], p5[5])); // Rb -> pin 6 (THR)
  c.wires.push(new Wire(p5[5], p5[1])); // pin 6 -> pin 2 (TRIG)
  c.wires.push(new Wire(p5[1], pCap[0])); // pin 2 -> Cap +

  const eng = new Engine();
  eng.build(c);
  return { eng, ic555, cap, p5, pCap };
}

function simulateAndMeasure(dt, totalTime = 12, raVal = 50000, rbVal = 50000, cUf = 10) {
  const { eng, p5 } = build555Circuit(raVal, rbVal, cUf);
  const outNet = eng.pointNet.get(`${p5[2].x},${p5[2].y}`);
  const capNet = eng.pointNet.get(`${p5[1].x},${p5[1].y}`);

  const V_LOW = 5.0 / 3.0;
  const V_HIGH = 10.0 / 3.0;

  let t = 0;
  let prevVc = 0;
  let prevVout = 0;
  let prevT = 0;

  const vcRises = [];
  const vcFalls = [];
  const outRises = [];
  const outFalls = [];

  const steps = Math.ceil(totalTime / dt);

  for (let s = 0; s < steps; s++) {
    eng.step(dt);
    t += dt;
    const vc = eng.V[capNet];
    const vout = eng.V[outNet];

    if (s > 0) {
      if (prevVc < V_LOW && vc >= V_LOW) {
        const frac = (V_LOW - prevVc) / (vc - prevVc);
        vcRises.push(prevT + frac * dt);
      }
      if (prevVc < V_HIGH && vc >= V_HIGH) {
        const frac = (V_HIGH - prevVc) / (vc - prevVc);
        vcFalls.push(prevT + frac * dt);
      }
      if (prevVout < 2.5 && vout >= 2.5) {
        const frac = (2.5 - prevVout) / (vout - prevVout);
        outRises.push(prevT + frac * dt);
      }
      if (prevVout >= 2.5 && vout < 2.5) {
        const frac = (prevVout - 2.5) / (prevVout - vout);
        outFalls.push(prevT + frac * dt);
      }
    }
    prevVc = vc;
    prevVout = vout;
    prevT = t;
  }

  // Steady state: discard cycle 0 (startup)
  const ssRises = outRises.slice(1);
  const periods = [];
  const duties = [];
  const tHighs = [];
  const tLows = [];

  for (let i = 0; i < ssRises.length - 1; i++) {
    const tRise = ssRises[i];
    const nextRise = ssRises[i + 1];
    const fall = outFalls.find(f => f > tRise && f < nextRise);
    if (fall) {
      const p = nextRise - tRise;
      const th = fall - tRise;
      const tl = nextRise - fall;
      periods.push(p);
      tHighs.push(th);
      tLows.push(tl);
      duties.push(th / p);
    }
  }

  const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  return {
    dt,
    periodsCount: periods.length,
    avgPeriod: avg(periods),
    avgDuty: avg(duties),
    avgTHigh: avg(tHighs),
    avgTLow: avg(tLows),
    startupCharge: outFalls[0] - outRises[0],
    startupPeriod: outRises[1] - outRises[0],
    allRises: outRises,
    allFalls: outFalls
  };
}

console.log('=== PART (a) & (b): TIMESTEP SWEEP WITH INTERPOLATION (STEADY STATE >= 5 PERIODS) ===');
const dts = [0.005, 0.002, 0.001, 0.0005, 0.0001];
console.log('| dt (ms) | Cycles | Period (s) | Error vs 1.0395s | Duty (%) | t_high (s) | t_low (s) |');
console.log('|---|---|---|---|---|---|---|');
for (const dt of dts) {
  const res = simulateAndMeasure(dt, 12);
  const err = ((res.avgPeriod - 1.0395) / 1.0395 * 100).toFixed(3);
  console.log(`| ${(dt*1000).toFixed(1).padStart(5)} | ${res.periodsCount} | ${res.avgPeriod.toFixed(6)} | ${err.padStart(6)}% | ${(res.avgDuty*100).toFixed(3)}% | ${res.avgTHigh.toFixed(6)} | ${res.avgTLow.toFixed(6)} |`);
}

console.log('\n=== COMPARISON: STEADY STATE VS RAW UNFILTERED (STARTUP INCLUDED) AT dt=5ms ===');
const rawRes = simulateAndMeasure(0.005, 10);
// Raw without discarding cycle 0:
const rawPeriods = [];
for (let i = 1; i < rawRes.allRises.length; i++) rawPeriods.push(rawRes.allRises[i] - rawRes.allRises[i-1]);
const rawAvgPeriod = rawPeriods.reduce((a,b)=>a+b,0) / rawPeriods.length;
const rawAvgHigh = (rawRes.allFalls.reduce((a,b)=>a+b,0) - rawRes.allRises.slice(0, rawRes.allFalls.length).reduce((a,b)=>a+b,0)) / rawRes.allFalls.length;
console.log(`Startup Cycle 0: t_high = ${rawRes.startupCharge.toFixed(4)}s, Period 0 = ${rawRes.startupPeriod.toFixed(4)}s`);
console.log(`Raw Avg (Startup Included): Period = ${rawAvgPeriod.toFixed(4)}s, Duty = ${(rawAvgHigh/rawAvgPeriod*100).toFixed(2)}% (Matches T10 reported failure!)`);
console.log(`Steady-State Avg (Cycle 0 discarded): Period = ${rawRes.avgPeriod.toFixed(4)}s, Duty = ${(rawRes.avgDuty*100).toFixed(2)}%`);

console.log('\n=== PART (f): RE-RUNNING F10 VARIANTS (WITH TRANSIENT DISCARDED) ===');
// Variant 1: Ra=10k, Rb=100k, C=1uF
const var1 = simulateAndMeasure(0.001, 1.5, 10000, 100000, 1);
console.log(`Variant 1 (Ra=10k, Rb=100k, C=1uF, dt=1ms):`);
console.log(`  Steady-state Period: ${var1.avgPeriod.toFixed(4)}s (Expected nominal ~0.146s)`);
console.log(`  Steady-state Duty:   ${(var1.avgDuty * 100).toFixed(2)}% (Expected ~52.4%)`);
console.log(`  Startup Period was:  ${var1.startupPeriod.toFixed(4)}s`);

// Variant 2: Ra=10k, Rb=10k, C=100nF
const var2 = simulateAndMeasure(0.00005, 0.03, 10000, 10000, 0.1);
console.log(`Variant 2 (Ra=10k, Rb=10k, C=100nF, dt=50µs):`);
console.log(`  Steady-state Period: ${(var2.avgPeriod * 1000).toFixed(4)}ms (f = ${(1/var2.avgPeriod).toFixed(1)} Hz, Expected ~2.08ms / 481 Hz)`);
console.log(`  Steady-state Duty:   ${(var2.avgDuty * 100).toFixed(2)}% (Expected ~66.7%)`);
console.log(`  Startup Period was:  ${(var2.startupPeriod * 1000).toFixed(4)}ms`);


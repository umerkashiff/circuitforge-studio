import assert from 'node:assert/strict';
import { Board, Circuit, Wire, Part } from '../src/model.js';
import { Engine } from '../src/sim/engine.js';
import { parseRailToken, resolvePinIndex } from '../src/ai/builder.js';
import { verifyInstrumentAndLoadLiveness, probeCircuitLedBehavior } from '../src/ai/logic_verify.js';
import { sanitizeEvalCase } from './daily_eval_cases.mjs';
import '../src/parts/library.js';
import '../src/parts/ics.js';
import '../src/mcu/boards.js';

const results = [];
function test(id, name, fn) {
  try {
    const info = fn();
    results.push({ id, name, pass: true, info });
  } catch (e) {
    results.push({ id, name, pass: false, info: e.stack || e.message });
  }
}

const wire = (c, pinA, pinB) => c.wires.push(new Wire({ x: pinA.x, y: pinA.y }, { x: pinB.x, y: pinB.y }));
const netV = (eng, pin) => eng.voltage(eng.netAt(pin.x, pin.y));

test('A1.1', 'Ceramic capacitor ignores reverse polarity whereas electrolytic bursts', () => {
  const mk = (kind) => {
    const c = new Circuit();
    const bat = new Part('battery', 0, 0, 0, { volts: 6 }); // + at (0,0), - at (1,0)
    const cap = new Part('capacitor', 10, 0, 0, { kind, uf: 1, vmax: 16 }); // + at (10,0), - at (11,0)
    c.parts.push(bat, cap);
    // Reverse wire: cap.+ -> bat.-, cap.- -> bat.+
    wire(c, cap.worldPins()[0], bat.worldPins()[1]);
    wire(c, cap.worldPins()[1], bat.worldPins()[0]);
    const eng = new Engine();
    eng.build(c);
    for (let i = 0; i < 40; i++) eng.step(0.01);
    return { cap, dev: eng.byPart.get(cap.id).device };
  };
  const cer = mk('ceramic');
  assert.ok(!cer.cap.props.damaged, 'Ceramic cap should NOT burst on -6V');
  assert.ok(!cer.dev.notes, 'Ceramic cap should have zero polarity warning');
  const el = mk('electrolytic');
  assert.equal(el.cap.props.damaged, 'burst', 'Electrolytic cap bursts when reversed');
  return `Ceramic vc=${cer.dev.vc.toFixed(2)}V intact; Electrolytic burst=${el.cap.props.damaged}`;
});

test('A1.2', 'Inductor models RL time constant (tau = L / R) and steady-state ESR current', () => {
  const c = new Circuit();
  const vcc = new Part('vcc', 0, 0);
  const gnd = new Part('gnd', 0, 10);
  const r = new Part('resistor', 5, 0, 0, { ohms: 9.5 }); // total R = 9.5 + 0.5 ESR = 10 Ω -> tau = 10mH / 10 = 1 ms
  const l = new Part('inductor', 12, 0, 0, { mh: 10, rs: 0.5 });
  c.parts.push(vcc, gnd, r, l);
  wire(c, vcc.worldPins()[0], r.worldPins()[0]);
  wire(c, r.worldPins()[1], l.worldPins()[0]);
  wire(c, l.worldPins()[1], gnd.worldPins()[0]);

  const eng = new Engine();
  eng.build(c);
  const devL = eng.byPart.get(l.id).device;
  assert.equal(eng.hasInd, true);

  // Step 1.0 ms (= 1 tau) in 20us slices -> expected I(1ms) = 0.5 * (1 - e^-1) ≈ 0.316 A
  for (let k = 0; k < 50; k++) eng.step(2e-5);
  const iAtTau = devL.i;
  assert.ok(iAtTau > 0.29 && iAtTau < 0.34, `At t=1ms expected ~0.316A, got ${iAtTau.toFixed(4)}A`);

  // Step to steady state (15 ms) -> expected I_ss = 5 / 10 = 0.500 A
  for (let k = 0; k < 200; k++) eng.step(1e-4);
  assert.ok(Math.abs(devL.i - 0.5) < 0.01, `Steady state expected ~0.500A, got ${devL.i.toFixed(4)}A`);
  return `I(tau)=${(iAtTau * 1000).toFixed(1)}mA, I_ss=${(devL.i * 1000).toFixed(1)}mA`;
});

test('A1.3', 'Inductive flyback clamped cleanly via 1N5819 Schottky freewheeling diode', () => {
  const c = new Circuit();
  const vcc = new Part('vcc', 0, 0);
  const gnd = new Part('gnd', 0, 10);
  const sw = new Part('slide', 4, 0, 0, { on: true });
  const l = new Part('inductor', 10, 0, 0, { mh: 10, rs: 1 });
  const d = new Part('diode', 10, 6, 0, { model: '1N5819' }); // A at (10,6) -> K at (14,6)
  c.parts.push(vcc, gnd, sw, l, d);
  wire(c, vcc.worldPins()[0], sw.worldPins()[0]);
  wire(c, sw.worldPins()[1], l.worldPins()[0]);
  wire(c, l.worldPins()[1], gnd.worldPins()[0]);
  // Reverse parallel catch diode: anode to GND, cathode to L pin 0 (switched node)
  wire(c, d.worldPins()[0], gnd.worldPins()[0]);
  wire(c, d.worldPins()[1], l.worldPins()[0]);

  const eng = new Engine();
  eng.build(c);
  for (let k = 0; k < 100; k++) eng.step(1e-4);
  const devL = eng.byPart.get(l.id).device;
  assert.ok(devL.i > 0.2, `Coil charged to ${(devL.i * 1000).toFixed(1)}mA`);

  // Open switch abruptly -> flyback clamps switched node near -Vf (-0.25..-0.5V) instead of unbounded spike
  sw.props.on = false;
  eng.build(c);
  eng.step(2e-5);
  const vClamp = netV(eng, l.worldPins()[0]);
  assert.ok(Number.isFinite(vClamp) && vClamp > -1.0 && vClamp < -0.1, `Expected Schottky clamp ~ -0.3V, got ${vClamp}`);
  return `Charged I=${devL.i.toFixed(2)}A, flyback clamped Vnode=${vClamp.toFixed(2)}V`;
});

test('A1.4', 'LM741 unity-gain voltage follower solves exact Vout = Vin in 1 pass', () => {
  const c = new Circuit();
  const batHi = new Part('battery', 0, 0, 0, { volts: 9 });
  const batIn = new Part('battery', 0, 8, 0, { volts: 3 });
  const gnd = new Part('gnd', 0, 16);
  const u1 = new Part('lm741', 10, 8);
  c.parts.push(batHi, batIn, gnd, u1);
  const pins = u1.worldPins(); // 0:OFF1, 1:IN-, 2:IN+, 3:V-, 4:OFF2, 5:OUT, 6:V+, 7:NC
  wire(c, batHi.worldPins()[1], gnd.worldPins()[0]);
  wire(c, batIn.worldPins()[1], gnd.worldPins()[0]);
  wire(c, batHi.worldPins()[0], pins[6]); // V+ = 9V
  wire(c, gnd.worldPins()[0], pins[3]);   // V- = 0V
  wire(c, batIn.worldPins()[0], pins[2]); // IN+ = 3.0V
  wire(c, pins[5], pins[1]);              // OUT -> IN-

  const eng = new Engine();
  eng.build(c);
  eng.step(1e-4);
  const vout = netV(eng, pins[5]);
  assert.equal(eng.converged, true, 'Op-amp follower converged cleanly');
  assert.ok(Math.abs(vout - 3.0) < 0.01, `Expected Vout ≈ 3.00 V, got ${vout}`);
  return `Vout = ${vout.toFixed(4)} V (Vin = 3.00 V)`;
});

test('A1.5', 'LM358 dual op-amp solves Ch1 non-inverting 2x and Ch2 inverting -1x simultaneously', () => {
  const c = new Circuit();
  const vpos = new Part('battery', 0, 0, 0, { volts: 9 });
  const vneg = new Part('battery', 0, 5, 0, { volts: 9 });
  const vin1 = new Part('battery', 0, 10, 0, { volts: 1.5 });
  const vin2 = new Part('battery', 0, 15, 0, { volts: 2.0 });
  const gnd = new Part('gnd', 0, 20);
  const u1 = new Part('lm358', 15, 10);
  const r1 = new Part('resistor', 15, 22, 0, { ohms: 10000 });
  const r2 = new Part('resistor', 22, 22, 0, { ohms: 10000 });
  const rin = new Part('resistor', 15, 26, 0, { ohms: 10000 });
  const rf = new Part('resistor', 22, 26, 0, { ohms: 10000 });
  c.parts.push(vpos, vneg, vin1, vin2, gnd, u1, r1, r2, rin, rf);

  const up = u1.worldPins(); // 0:1OUT, 1:1IN-, 2:1IN+, 3:V-, 4:2IN+, 5:2IN-, 6:2OUT, 7:V+
  wire(c, vpos.worldPins()[1], gnd.worldPins()[0]);
  wire(c, vneg.worldPins()[0], gnd.worldPins()[0]); // -9V rail at vneg.minus
  wire(c, vin1.worldPins()[1], gnd.worldPins()[0]);
  wire(c, vin2.worldPins()[1], gnd.worldPins()[0]);
  wire(c, vpos.worldPins()[0], up[7]);    // V+ = +9V
  wire(c, vneg.worldPins()[1], up[3]);    // V- = -9V

  // Ch1 non-inverting 2x: 1IN+ = 1.5V, R1(GND->1IN-), R2(1IN- -> 1OUT)
  wire(c, vin1.worldPins()[0], up[2]);
  wire(c, gnd.worldPins()[0], r1.worldPins()[0]);
  wire(c, r1.worldPins()[1], up[1]);
  wire(c, up[1], r2.worldPins()[0]);
  wire(c, r2.worldPins()[1], up[0]);

  // Ch2 inverting -1x: 2IN+ = GND, Rin(Vin2->2IN-), Rf(2IN- -> 2OUT)
  wire(c, gnd.worldPins()[0], up[4]);
  wire(c, vin2.worldPins()[0], rin.worldPins()[0]);
  wire(c, rin.worldPins()[1], up[5]);
  wire(c, up[5], rf.worldPins()[0]);
  wire(c, rf.worldPins()[1], up[6]);

  const eng = new Engine();
  eng.build(c);
  eng.step(1e-4);
  const v1 = netV(eng, up[0]), v2 = netV(eng, up[6]);
  assert.equal(eng.converged, true);
  assert.ok(Math.abs(v1 - 3.0) < 0.02, `Ch1 2x expected 3.00V, got ${v1}`);
  assert.ok(Math.abs(v2 + 2.0) < 0.02, `Ch2 -1x expected -2.00V, got ${v2}`);
  return `Ch1(2x)=${v1.toFixed(3)}V, Ch2(-1x)=${v2.toFixed(3)}V`;
});

test('A1.6', 'LM393 open-collector comparator sinks LOW when IN+ < IN− and pulls HIGH with pull-up', () => {
  const c = new Circuit();
  const vcc = new Part('vcc', 0, 0);
  const gnd = new Part('gnd', 0, 10);
  const ref = new Part('battery', 4, 4, 0, { volts: 2.5 });
  const sig = new Part('battery', 4, 8, 0, { volts: 1.0 });
  const rpu = new Part('resistor', 12, 0, 0, { ohms: 1000 });
  const comp = new Part('lm393', 18, 6);
  c.parts.push(vcc, gnd, ref, sig, rpu, comp);
  const p = comp.worldPins();
  wire(c, ref.worldPins()[1], gnd.worldPins()[0]);
  wire(c, sig.worldPins()[1], gnd.worldPins()[0]);
  wire(c, vcc.worldPins()[0], p[7]);
  wire(c, gnd.worldPins()[0], p[3]);
  wire(c, ref.worldPins()[0], p[1]); // IN- = 2.5V
  wire(c, sig.worldPins()[0], p[2]); // IN+ = 1.0V (< 2.5V -> sink low)
  wire(c, vcc.worldPins()[0], rpu.worldPins()[0]);
  wire(c, rpu.worldPins()[1], p[0]);

  const eng = new Engine();
  eng.build(c);
  eng.step(1e-4);
  const vLo = netV(eng, p[0]);
  assert.ok(vLo < 0.35, `Expected comparator output LOW < 0.35V, got ${vLo}`);

  sig.props.volts = 4.0;
  eng.build(c);
  eng.step(1e-4);
  const vHi = netV(eng, p[0]);
  assert.ok(vHi > 4.8, `Expected comparator output pull-up HIGH > 4.8V, got ${vHi}`);
  return `Vout(1V)=${vLo.toFixed(2)}V -> Vout(4V)=${vHi.toFixed(2)}V`;
});

test('A1.7', '2N3906 PNP switches high-side load ON when Base pulled LOW and OFF when pulled HIGH', () => {
  const c = new Circuit();
  const vcc = new Part('vcc', 0, 0);
  const gnd = new Part('gnd', 0, 12);
  const q = new Part('pnp', 10, 4, 0, { model: '2N3906', beta: 150 }); // 0:E, 1:B, 2:C
  const rb = new Part('resistor', 6, 8, 0, { ohms: 2200 });
  const rl = new Part('resistor', 16, 4, 0, { ohms: 220 });
  const sw = new Part('slide', 2, 8, 0, { on: true });
  c.parts.push(vcc, gnd, q, rb, rl, sw);
  wire(c, vcc.worldPins()[0], q.worldPins()[0]); // E -> +5V
  wire(c, q.worldPins()[2], rl.worldPins()[0]);  // C -> R_load
  wire(c, rl.worldPins()[1], gnd.worldPins()[0]);
  wire(c, q.worldPins()[1], rb.worldPins()[1]);  // B -> Rb
  wire(c, rb.worldPins()[0], sw.worldPins()[1]);
  wire(c, sw.worldPins()[0], gnd.worldPins()[0]);

  const eng = new Engine();
  eng.build(c);
  eng.step(1e-4);
  const vLoadOn = netV(eng, rl.worldPins()[0]);
  assert.ok(vLoadOn > 4.5, `PNP ON load voltage expected > 4.5V, got ${vLoadOn}`);

  sw.props.on = false;
  eng.build(c);
  eng.step(1e-4);
  const vLoadOff = netV(eng, rl.worldPins()[0]);
  assert.ok(vLoadOff < 0.05, `PNP OFF load voltage expected < 0.05V, got ${vLoadOff}`);
  return `PNP Vload(ON)=${vLoadOn.toFixed(2)}V, Vload(OFF)=${vLoadOff.toFixed(3)}V`;
});

test('A1.8', '2N7000 N-MOSFET and BS250 P-MOSFET obey Vth thresholds on unified G,D,S pinout', () => {
  // NMOS low-side: S=GND, D->R->VCC, G toggle 0..5V
  const cn = new Circuit();
  const vcc = new Part('vcc', 0, 0), gnd = new Part('gnd', 0, 10);
  const sw = new Part('toggle', 4, 4, 0, { on: true });
  const rl = new Part('resistor', 8, 0, 0, { ohms: 100 });
  const nmos = new Part('nmos', 14, 4, 0, { model: '2N7000' }); // 0:G, 1:D, 2:S
  cn.parts.push(vcc, gnd, sw, rl, nmos);
  wire(cn, vcc.worldPins()[0], rl.worldPins()[0]);
  wire(cn, rl.worldPins()[1], nmos.worldPins()[1]);
  wire(cn, nmos.worldPins()[2], gnd.worldPins()[0]);
  wire(cn, sw.worldPins()[0], nmos.worldPins()[0]);
  const en = new Engine(); en.build(cn); en.step(1e-4);
  const vdOn = netV(en, nmos.worldPins()[1]);
  sw.props.on = false; en.build(cn); en.step(1e-4);
  const vdOff = netV(en, nmos.worldPins()[1]);
  assert.ok(vdOn < 0.3 && vdOff > 4.9, `NMOS Vd(on)=${vdOn}, Vd(off)=${vdOff}`);

  // PMOS high-side: S=VCC, D->R->GND, G=0V (ON) vs 5V (OFF)
  const cp = new Circuit();
  const v2 = new Part('vcc', 0, 0), g2 = new Part('gnd', 0, 10);
  const sw2 = new Part('toggle', 4, 4, 0, { on: false });
  const rl2 = new Part('resistor', 8, 8, 0, { ohms: 100 });
  const pmos = new Part('pmos', 14, 4, 0, { model: 'BS250' });
  cp.parts.push(v2, g2, sw2, rl2, pmos);
  wire(cp, v2.worldPins()[0], pmos.worldPins()[2]); // S -> +5V
  wire(cp, pmos.worldPins()[1], rl2.worldPins()[0]);
  wire(cp, rl2.worldPins()[1], g2.worldPins()[0]);
  wire(cp, sw2.worldPins()[0], pmos.worldPins()[0]);
  const ep = new Engine(); ep.build(cp); ep.step(1e-4);
  const pdOn = netV(ep, pmos.worldPins()[1]);
  sw2.props.on = true; ep.build(cp); ep.step(1e-4);
  const pdOff = netV(ep, pmos.worldPins()[1]);
  assert.ok(pdOn > 4.6 && pdOff < 0.05, `PMOS Vd(on)=${pdOn}, Vd(off)=${pdOff}`);
  return `NMOS Vd(${vdOn.toFixed(2)}V/${vdOff.toFixed(2)}V), PMOS Vd(${pdOn.toFixed(2)}V/${pdOff.toFixed(2)}V)`;
});

test('A1.9', 'Zener 5.1 V clamps reverse rail and 1N5819 Schottky shows ~0.25 V forward drop', () => {
  const c = new Circuit();
  const bat = new Part('battery', 0, 0, 0, { volts: 12 });
  const gnd = new Part('gnd', 0, 8);
  const rs = new Part('resistor', 6, 0, 0, { ohms: 470 });
  const dz = new Part('zener', 12, 0, 0, { vz: 5.1 });
  const ds = new Part('diode', 12, 8, 0, { model: '1N5819' });
  const r2 = new Part('resistor', 18, 8, 0, { ohms: 220 });
  c.parts.push(bat, gnd, rs, dz, ds, r2);
  wire(c, bat.worldPins()[1], gnd.worldPins()[0]);
  wire(c, bat.worldPins()[0], rs.worldPins()[0]);
  wire(c, rs.worldPins()[1], dz.worldPins()[1]); // Cathode -> Rs (reverse clamp)
  wire(c, dz.worldPins()[0], gnd.worldPins()[0]);
  wire(c, bat.worldPins()[0], ds.worldPins()[0]); // 1N5819 forward path from 12V via R2
  wire(c, ds.worldPins()[1], r2.worldPins()[0]);
  wire(c, r2.worldPins()[1], gnd.worldPins()[0]);

  const eng = new Engine();
  eng.build(c);
  eng.step(1e-4);
  const vz = netV(eng, dz.worldPins()[1]);
  const vSchottky = 12 - netV(eng, ds.worldPins()[1]);
  assert.ok(vz > 5.05 && vz < 5.35, `Expected Zener clamp ~5.16V, got ${vz}`);
  assert.ok(vSchottky > 0.20 && vSchottky < 0.35, `Expected Schottky Vf ~0.25V, got ${vSchottky}`);
  return `Zener clamp=${vz.toFixed(3)}V, 1N5819 Vf=${vSchottky.toFixed(3)}V`;
});

test('A1.10', 'LM7805 fixed 5V regulator and LM317 adjustable divider regulate accurately', () => {
  const c = new Circuit();
  const bat = new Part('battery', 0, 0, 0, { volts: 9 });
  const gnd = new Part('gnd', 0, 12);
  const u78 = new Part('lm7805', 8, 2, 0, { vreg: 5.0 }); // IN, GND, OUT
  const rload78 = new Part('resistor', 14, 2, 0, { ohms: 100 });
  const u317 = new Part('lm317', 8, 8); // ADJ, OUT, IN
  const r1 = new Part('resistor', 14, 8, 0, { ohms: 240 });
  const r2 = new Part('resistor', 14, 12, 0, { ohms: 720 }); // 1.25 * (1 + 720/240) = 5.00V
  const rl317 = new Part('resistor', 20, 8, 0, { ohms: 100 });
  c.parts.push(bat, gnd, u78, rload78, u317, r1, r2, rl317);

  wire(c, bat.worldPins()[1], gnd.worldPins()[0]);
  // LM7805
  wire(c, bat.worldPins()[0], u78.worldPins()[0]);
  wire(c, gnd.worldPins()[0], u78.worldPins()[1]);
  wire(c, u78.worldPins()[2], rload78.worldPins()[0]);
  wire(c, rload78.worldPins()[1], gnd.worldPins()[0]);
  // LM317
  wire(c, bat.worldPins()[0], u317.worldPins()[2]);
  wire(c, u317.worldPins()[1], r1.worldPins()[0]);
  wire(c, r1.worldPins()[1], u317.worldPins()[0]);
  wire(c, u317.worldPins()[0], r2.worldPins()[0]);
  wire(c, r2.worldPins()[1], gnd.worldPins()[0]);
  wire(c, u317.worldPins()[1], rl317.worldPins()[0]);
  wire(c, rl317.worldPins()[1], gnd.worldPins()[0]);

  const eng = new Engine();
  eng.build(c);
  eng.step(1e-4);
  const v78 = netV(eng, u78.worldPins()[2]);
  const v317 = netV(eng, u317.worldPins()[1]);
  assert.ok(Math.abs(v78 - 5.0) < 0.05, `LM7805 expected ~5.0V, got ${v78}`);
  assert.ok(Math.abs(v317 - 5.0) < 0.08, `LM317 divider expected ~5.0V, got ${v317}`);
  return `LM7805=${v78.toFixed(3)}V, LM317=${v317.toFixed(3)}V`;
});

test('A1.11', 'PC817 optocoupler switches across two completely isolated ground domains', () => {
  const c = new Circuit();
  // Primary 5V isolated domain
  const vcc = new Part('vcc', 0, 0), gnd = new Part('gnd', 0, 4);
  const sw = new Part('slide', 4, 0, 0, { on: true });
  const rIn = new Part('resistor', 8, 0, 0, { ohms: 220 });
  const opto = new Part('pc817', 14, 2); // 0:A, 1:K, 2:E, 3:C
  // Secondary 9V isolated battery domain (NO wire to primary GND)
  const bat = new Part('battery', 24, 0, 0, { volts: 9 });
  const rOut = new Part('resistor', 24, 6, 0, { ohms: 1000 });
  c.parts.push(vcc, gnd, sw, rIn, opto, bat, rOut);

  wire(c, vcc.worldPins()[0], sw.worldPins()[0]);
  wire(c, sw.worldPins()[1], rIn.worldPins()[0]);
  wire(c, rIn.worldPins()[1], opto.worldPins()[0]);
  wire(c, opto.worldPins()[1], gnd.worldPins()[0]);

  wire(c, bat.worldPins()[1], opto.worldPins()[2]); // Secondary E -> bat-
  wire(c, bat.worldPins()[0], rOut.worldPins()[0]);
  wire(c, rOut.worldPins()[1], opto.worldPins()[3]); // C -> load -> bat+

  const eng = new Engine();
  eng.build(c);
  eng.step(1e-4);
  const vceOn = netV(eng, opto.worldPins()[3]) - netV(eng, opto.worldPins()[2]);
  assert.ok(vceOn < 0.4, `Expected isolated secondary pulled low (<0.4V), got ${vceOn}`);

  sw.props.on = false;
  eng.build(c);
  eng.step(1e-4);
  const vceOff = netV(eng, opto.worldPins()[3]) - netV(eng, opto.worldPins()[2]);
  assert.ok(vceOff > 8.8, `Expected isolated secondary open (~9V), got ${vceOff}`);
  return `Isolated Vce(ON)=${vceOn.toFixed(2)}V, Vce(OFF)=${vceOff.toFixed(2)}V`;
});

test('A1.12', 'Multimeter measures differential DCV, inline mA shunt, unpowered OHM/CONT & blocks LIVE V', () => {
  // 1) DCV & LIVE V! block
  const c1 = new Circuit();
  const vcc = new Part('vcc', 0, 0), gnd = new Part('gnd', 0, 10);
  const r1 = new Part('resistor', 6, 0, 0, { ohms: 1000 });
  const r2 = new Part('resistor', 12, 0, 0, { ohms: 1000 });
  const dmm = new Part('multimeter', 6, 8, 0, { mode: 'dcv' });
  c1.parts.push(vcc, gnd, r1, r2, dmm);
  wire(c1, vcc.worldPins()[0], r1.worldPins()[0]);
  wire(c1, r1.worldPins()[1], r2.worldPins()[0]);
  wire(c1, r2.worldPins()[1], gnd.worldPins()[0]);
  wire(c1, dmm.worldPins()[0], vcc.worldPins()[0]); // + = 5V
  wire(c1, dmm.worldPins()[1], r1.worldPins()[1]);  // - = 2.5V -> diff = 2.50 V
  const e1 = new Engine(); e1.build(c1); e1.step(1e-4);
  const dev1 = e1.byPart.get(dmm.id).device;
  const dcvVal = dev1.value;
  assert.ok(Math.abs(dcvVal - 2.5) < 0.01, `DCV expected 2.50V, got ${dcvVal}`);

  dmm.props.mode = 'ohm';
  e1.step(1e-4);
  assert.equal(dev1.liveBlocked, true, 'OHM on energized circuit triggers LIVE V safety block');
  assert.equal(dev1.display, 'LIVE V!');

  // 2) DCA inline branch current: 5V -> 99.9Ω -> DMM(0.1Ω) -> GND = 50.0 mA
  const c2 = new Circuit();
  const v2 = new Part('vcc', 0, 0), g2 = new Part('gnd', 0, 10);
  const ra = new Part('resistor', 6, 0, 0, { ohms: 99.9 });
  const dm2 = new Part('multimeter', 6, 8, 0, { mode: 'dca' });
  c2.parts.push(v2, g2, ra, dm2);
  wire(c2, v2.worldPins()[0], ra.worldPins()[0]);
  wire(c2, ra.worldPins()[1], dm2.worldPins()[0]);
  wire(c2, dm2.worldPins()[1], g2.worldPins()[0]);
  const e2 = new Engine(); e2.build(c2); e2.step(1e-4);
  const dev2 = e2.byPart.get(dm2.id).device;
  assert.ok(Math.abs(dev2.value - 0.05) < 0.001, `DCA expected 50mA, got ${dev2.value}`);

  // 3) Unpowered parallel resistance 1k || 1k (+ parallel ceramic cap ignored at DC!) = 500 Ω & continuity beep < 50 Ω
  const c3 = new Circuit();
  const rx1 = new Part('resistor', 0, 0, 0, { ohms: 1000 });
  const rx2 = new Part('resistor', 0, 4, 0, { ohms: 1000 });
  const cap = new Part('capacitor', 0, 8, 0, { kind: 'ceramic', uf: 100 });
  const dm3 = new Part('multimeter', 10, 4, 0, { mode: 'ohm' });
  c3.parts.push(rx1, rx2, cap, dm3);
  wire(c3, rx1.worldPins()[0], rx2.worldPins()[0]);
  wire(c3, rx1.worldPins()[1], rx2.worldPins()[1]);
  wire(c3, rx1.worldPins()[0], cap.worldPins()[0]);
  wire(c3, rx1.worldPins()[1], cap.worldPins()[1]);
  wire(c3, dm3.worldPins()[0], rx1.worldPins()[0]);
  wire(c3, dm3.worldPins()[1], rx1.worldPins()[1]);
  const e3 = new Engine(); e3.build(c3); e3.step(5e-4);
  const dev3 = e3.byPart.get(dm3.id).device;
  assert.ok(Math.abs(dev3.value - 500) < 1, `OHM expected 500Ω (ignoring 100uF cap), got ${dev3.value}`);

  dm3.props.mode = 'cont';
  rx1.props.ohms = 22; rx2.props.ohms = 1e6;
  e3.build(c3); e3.step(5e-4);
  assert.equal(e3.byPart.get(dm3.id).device.beep, true, 'Continuity beep triggers < 50 Ω');
  return `DCV=${dcvVal.toFixed(2)}V, LIVE blocked OK, DCA=${(dev2.value * 1000).toFixed(1)}mA, OHM=500Ω, CONT beep=true`;
});

test('A1.13', 'Breadboard-mounted LM358 + LM393 start up & converge in 1 step with silent unused Ch2', () => {
  const c = new Circuit();
  c.boards.push(new Board('half', 0, 0));
  const vcc = new Part('vcc', 2, -2), gnd = new Part('gnd', 4, -2);
  const bat = new Part('battery', 8, -4, 0, { volts: 10 });
  const rDiv1 = new Part('resistor', 2, 14, 0, { ohms: 10000 }); // cols 2, 6 bottom
  const rDiv2 = new Part('resistor', 6, 15, 0, { ohms: 10000 }); // cols 6, 10 bottom
  const u358 = new Part('lm358', 11, 11);                        // cols 11..14 (rows 8, 11)
  const rFb1 = new Part('resistor', 15, 5, 0, { ohms: 10000 });  // cols 15, 19 top (separated by center gap)
  const rFb2 = new Part('resistor', 15, 14, 0, { ohms: 10000 }); // cols 15, 19 bottom
  const u393 = new Part('lm393', 20, 11);                        // cols 20..23 (rows 8, 11)
  const rPu = new Part('resistor', 24, 6, 0, { ohms: 330 });     // cols 24, 28 top
  const led = new Part('led', 28, 13, 0, { color: 'green', protect: 'off' }); // cols 28, 29 bottom
  c.parts.push(vcc, gnd, bat, rDiv1, rDiv2, u358, rFb1, rFb2, u393, rPu, led);

  wire(c, vcc.worldPins()[0], rDiv1.worldPins()[0]);
  wire(c, rDiv2.worldPins()[1], gnd.worldPins()[0]);
  wire(c, bat.worldPins()[1], gnd.worldPins()[0]);
  wire(c, bat.worldPins()[0], u358.worldPins()[7]); // +10V -> 358 V+
  wire(c, gnd.worldPins()[0], u358.worldPins()[3]); // GND  -> 358 V-
  wire(c, rDiv1.worldPins()[1], u358.worldPins()[2]); // 2.5V -> 358 1IN+
  wire(c, gnd.worldPins()[0], rFb1.worldPins()[1]);   // col 19 top -> GND
  wire(c, u358.worldPins()[1], rFb1.worldPins()[0]);  // 358 1IN- -> rFb1.0
  wire(c, u358.worldPins()[1], rFb2.worldPins()[0]);  // 358 1IN- -> rFb2.0
  wire(c, rFb2.worldPins()[1], u358.worldPins()[0]);  // col 19 bottom -> 358 1OUT

  wire(c, vcc.worldPins()[0], u393.worldPins()[7]);
  wire(c, gnd.worldPins()[0], u393.worldPins()[3]);
  wire(c, u358.worldPins()[0], u393.worldPins()[2]);
  wire(c, rDiv1.worldPins()[1], u393.worldPins()[1]);
  wire(c, vcc.worldPins()[0], rPu.worldPins()[0]);
  wire(c, rPu.worldPins()[1], u393.worldPins()[0]);
  wire(c, u393.worldPins()[0], led.worldPins()[0]);
  wire(c, led.worldPins()[1], gnd.worldPins()[0]);

  const eng = new Engine();
  eng.build(c);
  eng.step(1e-4);
  const vAmp = netV(eng, u358.worldPins()[0]);
  const ledDev = eng.byPart.get(led.id).device;
  const d358 = eng.byPart.get(u358.id).device;
  const d393 = eng.byPart.get(u393.id).device;
  assert.equal(eng.converged, true, 'Breadboard LM358 + LM393 must converge cleanly from cold start');
  assert.ok(Math.abs(vAmp - 5.0) < 0.05, `LM358 2x amp expected ~5.00V, got ${vAmp}`);
  assert.ok(ledDev.cur[0] > 0.005, `LED via LM393 must light (>5mA), got ${(ledDev.cur[0] * 1000).toFixed(2)}mA`);
  assert.equal(d358.notes, null, 'Healthy LM358 has no orange warnings');
  assert.equal(d393.notes, null, 'Healthy LM393 with unused Ch2 has no orange warnings');
  assert.ok(!d393.infos || !d393.infos.some(s => /Ch2/.test(s)), 'Unused breadboard LM393 Ch2 stays silent');
  return `Cold-start converged: LM358=${vAmp.toFixed(3)}V, LED=${(ledDev.cur[0] * 1000).toFixed(1)}mA, 0 false warnings`;
});

test('A1.14', '2N7000 low-side NMOS wakes series LED cleanly without floating-drain deadlock', () => {
  const c = new Circuit();
  const vcc = new Part('vcc', 0, 0), gnd = new Part('gnd', 0, 10);
  const sw = new Part('toggle', 4, 0, 0, { on: false });
  const r = new Part('resistor', 8, 0, 0, { ohms: 220 });
  const led = new Part('led', 14, 0, 0, { color: 'red', protect: 'off' });
  const q = new Part('nmos', 16, 4, 0, { model: '2N7000' }); // G, D, S
  c.parts.push(vcc, gnd, sw, r, led, q);
  wire(c, vcc.worldPins()[0], r.worldPins()[0]);
  wire(c, r.worldPins()[1], led.worldPins()[0]);
  wire(c, led.worldPins()[1], q.worldPins()[1]);
  wire(c, q.worldPins()[2], gnd.worldPins()[0]);
  wire(c, sw.worldPins()[0], q.worldPins()[0]);

  const eng = new Engine();
  eng.build(c);
  eng.step(1e-4);
  const ledDev = eng.byPart.get(led.id).device;
  assert.ok(ledDev.cur[0] < 1e-4, 'LED off when NMOS Gate LOW');

  const ledStats = probeCircuitLedBehavior(eng, c);
  assert.ok(ledStats[0].peakMa > 10, `NMOS LED must wake up when Gate HIGH (>10mA), got ${ledStats[0].peakMa.toFixed(2)}mA`);
  return `NMOS Gate toggle woke series LED to ${ledStats[0].peakMa.toFixed(2)} mA`;
});

test('A1.15', '100Hz FuncGen rectifier + scope avoids 0.00 Vpp aliasing; pins & composite rails resolve', () => {
  // 1) 100Hz funcgen half-wave rectifier verified via verifyInstrumentAndLoadLiveness
  const c = new Circuit();
  const gnd = new Part('gnd', 0, 10);
  const fg = new Part('funcgen', 4, 8, 0, { power: true, wave: 'sine', hz: 100, vpp: 10 });
  const d = new Part('diode', 20, 4, 0, { model: '1N4007' });
  const r = new Part('resistor', 26, 4, 0, { ohms: 1000 });
  const sc = new Part('oscilloscope', 34, 8);
  c.parts.push(gnd, fg, d, r, sc);
  wire(c, fg.worldPins()[4], d.worldPins()[0]); // OUT+ -> D.A
  wire(c, d.worldPins()[1], r.worldPins()[0]);  // D.K -> R
  wire(c, r.worldPins()[1], gnd.worldPins()[0]);
  wire(c, fg.worldPins()[5], gnd.worldPins()[0]); // OUT- -> GND
  wire(c, d.worldPins()[1], sc.worldPins()[0]); // CH1+ -> output
  wire(c, gnd.worldPins()[0], sc.worldPins()[1]); // CH1 GND -> GND
  const eng = new Engine();
  eng.build(c);
  const errs = verifyInstrumentAndLoadLiveness(eng, c);
  assert.deepEqual(errs, [], `100Hz FuncGen scope check must pass without 0.00 Vpp aliasing: ${errs}`);

  // 2) Pin hint echo "MASTER +(#6)" & composite "+/VCC" rails
  const psu = new Part('power-supply', 0, 0);
  assert.equal(resolvePinIndex(psu, 'MASTER +(#6)'), 5);
  assert.equal(parseRailToken('+/VCC')?.rail, '+');
  assert.equal(parseRailToken('−/GND')?.rail, '−');
  return '100Hz scope captured cleanly (0 errors); MASTER +(#6) & +/VCC resolved';
});

test('A1.16', 'Slow ~0.72Hz 555 -> 7493 -> 74138 visits all 8 LED states in probeCircuitLedBehavior', () => {
  const c = new Circuit();
  const vcc = new Part('vcc', 0, 0), gnd = new Part('gnd', 0, 2);
  const u555 = new Part('ne555', 4, 4);
  const r1 = new Part('resistor', 4, 10, 0, { ohms: 1000 });
  const r2 = new Part('resistor', 10, 10, 0, { ohms: 100000 });
  const cap = new Part('capacitor', 16, 10, 0, { uf: 10 });
  const u93 = new Part('ic7493', 20, 4);
  const u138 = new Part('ic74138', 32, 4);
  c.parts.push(vcc, gnd, u555, r1, r2, cap, u93, u138);

  const vp = vcc.worldPins()[0], gp = gnd.worldPins()[0];
  const p5 = u555.worldPins(); // GND0 TRIG1 OUT2 RESET3 CTRL4 THR5 DIS6 VCC7
  wire(c, vp, p5[7]); wire(c, vp, p5[3]); wire(c, gp, p5[0]);
  wire(c, p5[5], p5[1]); // THR-TRIG
  wire(c, vp, r1.worldPins()[0]); wire(c, r1.worldPins()[1], p5[6]);
  wire(c, p5[6], r2.worldPins()[0]); wire(c, r2.worldPins()[1], p5[5]);
  wire(c, p5[5], cap.worldPins()[0]); wire(c, cap.worldPins()[1], gp);

  const p93 = u93.worldPins(); // CKB0 R01(1) R02(2) NC3 VCC4 NC5 NC6 QC7 QB8 GND9 QD10 QA11 NC12 CKA13
  wire(c, vp, p93[4]); wire(c, gp, p93[9]);
  wire(c, gp, p93[1]); wire(c, gp, p93[2]);
  wire(c, p5[2], p93[13]); // OUT -> CKA
  wire(c, p93[11], p93[0]); // QA -> CKB

  const p138 = u138.worldPins(); // A0 B1 C2 G2A3 G2B4 G1_5 Y7_6 GND7 Y6_8..Y0_14 VCC15
  wire(c, vp, p138[15]); wire(c, gp, p138[7]);
  wire(c, vp, p138[5]); wire(c, gp, p138[3]); wire(c, gp, p138[4]);
  wire(c, p93[11], p138[0]); wire(c, p93[8], p138[1]); wire(c, p93[7], p138[2]);

  const yIndices = [14, 13, 12, 11, 10, 9, 8, 6];
  for (let i = 0; i < 8; i++) {
    const rLed = new Part('resistor', 4 + i * 5, 16, 0, { ohms: 220 });
    const led = new Part('led', 4 + i * 5, 19, 0, { color: 'red', protect: 'off' });
    c.parts.push(rLed, led);
    wire(c, vp, rLed.worldPins()[0]);
    wire(c, rLed.worldPins()[1], led.worldPins()[0]);
    wire(c, led.worldPins()[1], p138[yIndices[i]]);
  }

  const eng = new Engine();
  eng.build(c);
  const stats = probeCircuitLedBehavior(eng, c);
  assert.equal(stats.length, 8);
  const litCount = stats.filter(s => s.litOnce).length;
  assert.equal(litCount, 8, `Expected all 8 decoder LEDs to light across 0.72Hz 555 cycles, got ${litCount}/8`);
  return `All ${litCount}/8 decoder LEDs visited & lit across slow ~0.72Hz 555 + 7493 + 74138`;
});

test('A1.17', 'sanitizeEvalCase fixes legacy saved curriculum/autoreg oracles without mutating fixed wild/reg cases', () => {
  const c7 = sanitizeEvalCase({
    id: 'autoreg_idea_mwl354p0_7',
    prompt: 'How can I use a 7490 decade counter to drive a 7-segment display? I want to count from 0 to 9.',
    oracle: { minParts: 3, requireTypes: [['ic7490'], ['ic7447'], ['seg7'], ['led']], check: 'seg7_active' },
  });
  assert.deepEqual(c7.oracle.requireTypes, [['ic7490'], ['ic7447'], ['seg7']]);

  const c11 = sanitizeEvalCase({
    id: 'autoreg_idea_mwl354p0_11',
    prompt: 'I need a simple tool to check logic levels (high/low) on a digital circuit. Can you design a basic logic probe using LEDs?',
    oracle: { minParts: 3, requireTypes: [['ic7400'], ['led']], check: 'led_multi' },
  });
  assert.deepEqual(c11.oracle.requireTypes, [['led']]);

  const zener = sanitizeEvalCase({
    id: 'idea_mwmwtu2e_1',
    prompt: 'I need to test how a zener diode regulates voltage under varying load conditions. Can you set up a DC supply with a series resistor, zener, and load resistor?',
    oracle: { minParts: 3, requireTypes: [['power-supply'], ['zener'], ['resistor'], ['multimeter']], check: 'scope_ac' },
  });
  assert.equal(zener.oracle.check, 'built_clean');
  assert.deepEqual(zener.oracle.requireTypes, [['power-supply', 'battery', 'vcc'], ['zener'], ['resistor']]);

  const wild = sanitizeEvalCase({
    id: 'wild_74138_decoder_bar',
    prompt: 'build a 74138 3-to-8 decoder demo',
    oracle: { minParts: 12, requireTypes: [['ic74138'], ['led']], check: 'led_multi', minActiveLeds: 4 },
  });
  assert.equal(wild.oracle.check, 'led_multi');
  assert.deepEqual(wild.oracle.requireTypes, [['ic74138'], ['led']]);

  // Additional edge cases from 2nd 2026-11-19 run
  const bat = sanitizeEvalCase({
    id: 'idea_mwnd6cwb_1',
    prompt: 'I need a transistor circuit where the output follows the input voltage with high input impedance. Let\'s use an NPN transistor in a common collector configuration.',
    oracle: { minParts: 3, requireTypes: [['battery'], ['npn'], ['resistor']], check: 'built_clean' },
  });
  assert.deepEqual(bat.oracle.requireTypes, [['battery', 'vcc', 'power-supply'], ['npn'], ['resistor']]);

  const lm317 = sanitizeEvalCase({
    id: 'idea_mwnd6cwb_5',
    prompt: 'Design a regulated power supply circuit using an LM317 adjustable voltage regulator along with resistors and a potentiometer to tune the output voltage.',
    oracle: { minParts: 3, requireTypes: [['lm317'], ['pot'], ['capacitor'], ['multimeter']], check: 'dmm_valid' },
  });
  assert.equal(lm317.oracle.check, 'built_clean');
  assert.deepEqual(lm317.oracle.requireTypes, [['lm317'], ['pot']]);

  const unoGnd = sanitizeEvalCase({
    id: 'idea_mwnd6cwb_7',
    prompt: 'Set up an Arduino Uno to interface with a sensor module and print telemetry data, using an LED indicator to show successful readings.',
    oracle: { minParts: 3, requireTypes: [['uno'], ['gnd'], ['led']], check: 'led_active' },
  });
  assert.ok(unoGnd.oracle.requireTypes[1].includes('uno'));

  const ring = sanitizeEvalCase({
    id: 'autoreg_idea_mwmwtu2e_4',
    prompt: 'Can you build a ring oscillator using a couple of NAND gates from a 7400 IC and monitor the output clock pulse?',
    oracle: { minParts: 3, requireTypes: [['ic7400'], ['resistor'], ['led']], check: 'led_active' },
  });
  assert.equal(ring.oracle.check, 'built_clean');
  assert.deepEqual(ring.oracle.requireTypes, [['ic7400']]);
  return 'Legacy idea/autoreg oracles normalized safely; pinned wild/reg unchanged';
});

test('A1.18', '7402 NOR SR latch with individual tactile buttons illuminates both Q and Qbar LEDs cleanly', () => {
  const c = new Circuit();
  const vcc = new Part('vcc', 0, 0), gnd = new Part('gnd', 0, 2);
  const u02 = new Part('ic7402', 6, 4); // 1Y(0) 1A(1) 1B(2) 2Y(3) 2A(4) 2B(5) GND(6) ... VCC(13)
  const swS = new Part('tactile', 20, 4); // 1.l(0) 2.l(2)
  const swR = new Part('tactile', 26, 4);
  const rPd1 = new Part('resistor', 20, 10, 0, { ohms: 10000 });
  const rPd2 = new Part('resistor', 26, 10, 0, { ohms: 10000 });
  const rL1 = new Part('resistor', 6, 12, 0, { ohms: 220 });
  const rL2 = new Part('resistor', 12, 12, 0, { ohms: 220 });
  const l1 = new Part('led', 6, 15, 0, { color: 'red', protect: 'off' });
  const l2 = new Part('led', 12, 15, 0, { color: 'green', protect: 'off' });
  c.parts.push(vcc, gnd, u02, swS, swR, rPd1, rPd2, rL1, rL2, l1, l2);

  const vp = vcc.worldPins()[0], gp = gnd.worldPins()[0];
  const p = u02.worldPins();
  wire(c, vp, p[13]); wire(c, gp, p[6]);
  // Buttons: + -> 1.l, 2.l -> pulldown -> GND
  wire(c, vp, swS.worldPins()[0]); wire(c, swS.worldPins()[2], rPd1.worldPins()[0]); wire(c, rPd1.worldPins()[1], gp);
  wire(c, vp, swR.worldPins()[0]); wire(c, swR.worldPins()[2], rPd2.worldPins()[0]); wire(c, rPd2.worldPins()[1], gp);
  // NOR cross-coupling: S -> 1A, 1B <- 2Y(Q), 1Y(Qbar) -> 2B, R -> 2A
  wire(c, swS.worldPins()[2], p[1]); wire(c, p[3], p[2]);
  wire(c, p[0], p[5]); wire(c, swR.worldPins()[2], p[4]);
  // Unused NOR gates grounded
  wire(c, gp, p[7]); wire(c, gp, p[8]); wire(c, gp, p[10]); wire(c, gp, p[11]);
  // LEDs on Q (2Y) and Qbar (1Y)
  wire(c, p[0], rL1.worldPins()[0]); wire(c, rL1.worldPins()[1], l1.worldPins()[0]); wire(c, l1.worldPins()[1], gp);
  wire(c, p[3], rL2.worldPins()[0]); wire(c, rL2.worldPins()[1], l2.worldPins()[0]); wire(c, l2.worldPins()[1], gp);

  const eng = new Engine();
  eng.build(c);
  const stats = probeCircuitLedBehavior(eng, c);
  assert.equal(stats.filter(s => s.litOnce).length, 2, `Expected both NOR SR latch LEDs to light, got ${JSON.stringify(stats.map(s => s.peakMa))}`);
  return `7402 NOR SR latch illuminated Q & Qbar individually (${stats.map(s => s.peakMa.toFixed(1) + 'mA').join(', ')})`;
});

test('A1.19', 'Slide switches + 74138 decoder and manual-button 74193 counter probe all LEDs cleanly', () => {
  // 1) 3 slide switches + pull-downs -> 74138 active-LOW 8 LEDs
  const c1 = new Circuit();
  const vcc1 = new Part('vcc', 0, 0), gnd1 = new Part('gnd', 0, 2);
  const u138 = new Part('ic74138', 16, 4);
  c1.parts.push(vcc1, gnd1, u138);
  const vp1 = vcc1.worldPins()[0], gp1 = gnd1.worldPins()[0], p1 = u138.worldPins();
  wire(c1, vp1, p1[15]); wire(c1, gp1, p1[7]);
  wire(c1, vp1, p1[5]); wire(c1, gp1, p1[3]); wire(c1, gp1, p1[4]);
  for (let i = 0; i < 3; i++) {
    const sw = new Part('slide', 2 + i * 4, 4);
    const pd = new Part('resistor', 2 + i * 5, 8, 1, { ohms: 10000 });
    c1.parts.push(sw, pd);
    wire(c1, vp1, sw.worldPins()[0]);
    wire(c1, sw.worldPins()[1], p1[i]);
    wire(c1, sw.worldPins()[1], pd.worldPins()[0]);
    wire(c1, pd.worldPins()[1], gp1);
  }
  const yIdx = [14, 13, 12, 11, 10, 9, 8, 6];
  for (let i = 0; i < 8; i++) {
    const r = new Part('resistor', 2 + i * 5, 14, 1, { ohms: 220 });
    const l = new Part('led', 2 + i * 5, 20, 0, { color: 'red', protect: 'off' });
    c1.parts.push(r, l);
    wire(c1, vp1, r.worldPins()[0]); wire(c1, r.worldPins()[1], l.worldPins()[0]); wire(c1, l.worldPins()[1], p1[yIdx[i]]);
  }
  const eng1 = new Engine();
  eng1.build(c1);
  const s1 = probeCircuitLedBehavior(eng1, c1);
  assert.equal(s1.filter(s => s.litOnce).length, 8, `Expected all 8/8 74138 LEDs via slide switches, got ${s1.filter(s => s.litOnce).length}/8`);

  // 2) Pushbutton-clocked 74193 4-bit counter -> 4 binary LEDs (plus "5V FIXED +8" pin check)
  const c2 = new Circuit();
  const vcc2 = new Part('vcc', 0, 0), gnd2 = new Part('gnd', 0, 2);
  const u93 = new Part('ic74193', 10, 4); // B0 QB1 QA2 DOWN3 UP4 QC5 QD6 GND7 D8 C9 LOAD10 CO11 BO12 CLR13 A14 VCC15
  const btn = new Part('tactile', 24, 4);
  const pd = new Part('resistor', 24, 10, 0, { ohms: 10000 });
  c2.parts.push(vcc2, gnd2, u93, btn, pd);
  const vp2 = vcc2.worldPins()[0], gp2 = gnd2.worldPins()[0], p2 = u93.worldPins();
  wire(c2, vp2, p2[15]); wire(c2, gp2, p2[7]);
  wire(c2, vp2, p2[3]); wire(c2, vp2, p2[10]); wire(c2, gp2, p2[13]); // DOWN=1, LOAD=1, CLR=0
  wire(c2, vp2, btn.worldPins()[0]); wire(c2, btn.worldPins()[2], p2[4]);
  wire(c2, btn.worldPins()[2], pd.worldPins()[0]); wire(c2, pd.worldPins()[1], gp2);
  for (const [k, idx] of [2, 1, 5, 6].entries()) {
    const r = new Part('resistor', 4 + k * 5, 14, 1, { ohms: 220 });
    const l = new Part('led', 4 + k * 5, 20, 0, { color: 'green', protect: 'off' });
    c2.parts.push(r, l);
    wire(c2, p2[idx], r.worldPins()[0]); wire(c2, r.worldPins()[1], l.worldPins()[0]); wire(c2, l.worldPins()[1], gp2);
  }
  const eng2 = new Engine();
  eng2.build(c2);
  const s2 = probeCircuitLedBehavior(eng2, c2);
  assert.equal(s2.filter(s => s.litOnce).length, 4, `Expected all 4/4 binary counter LEDs via pushbutton, got ${s2.filter(s => s.litOnce).length}/4`);

  assert.equal(resolvePinIndex(new Part('power-supply', 0, 0), '5V FIXED +8'), 7);
  return `Slide+74138 lit ${s1.filter(s => s.litOnce).length}/8, button+74193 lit ${s2.filter(s => s.litOnce).length}/4, "5V FIXED +8" resolved`;
});

let failed = 0;
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'} [${r.id}] ${r.name} -> ${r.info}`);
  if (!r.pass) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);

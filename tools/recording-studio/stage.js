/**
 * CircuitForge Studio — Zero-Chrome Headless Recording & Asset Director
 *
 * Directly imports CircuitForge's REAL Renderer, MNA Engine, Parts Library,
 * Router (tidy), and SAP-1 CPU builder to produce:
 *   - True alpha-transparent HiDPI hardware part sprites
 *   - Pure-#000 or transparent frameless choreographed hardware scenes
 *   - Deterministic MNA physics stepping + world-space cubic-eased camera tours
 */

import { P, Circuit, Board, Part, Wire } from '../../src/model.js';
import { Engine, key } from '../../src/sim/engine.js';
import { tidy } from '../../src/sim/router.js';
import { Renderer } from '../../src/view/renderer.js';
import { ensureDesignators } from '../../src/export/designators.js';
import { buildSap1CpuCircuit } from '../../src/examples/sap1_cpu.js';
import '../../src/parts/library.js';
import '../../src/mcu/boards.js';

const R = '#e5484d', K = '#2b2d31', B = '#0a84ff', G = '#30a46c', Y = '#f5c400', O = '#ff8a00', W = '#f2f2f7';

const canvas = document.getElementById('stage-cv');

class StudioApp {
  constructor() {
    this.circuit = new Circuit();
    this.engine = new Engine();
    this.cam = { x: 0, y: 0, z: 1 };
    this.mode = 'sim';
    this.effects = [];
    this.checks = [];
    this.index = { holes: new Map(), pins: new Map(), ends: new Map() };
    this.editor = { hoverNet: -1, selection: new Set(), drawOverlay() {} };
    this.settings = {
      get: (k) => {
        if (k === 'accent') return '#0a84ff';
        if (k === 'chipText') return 1;
        if (k === 'labelMode') return 'off';
        if (k === 'showVoltages') return true;
        return null;
      },
    };
    this.renderer = new Renderer(this, canvas);
    this.renderer.resize();
  }

  reindex() {
    const holes = new Map(), pins = new Map(), ends = new Map();
    for (const b of this.circuit.boards) for (const hl of b.holes()) holes.set(key(hl.x, hl.y), hl);
    for (const p of this.circuit.parts) for (const q of p.worldPins()) {
      const k = key(q.x, q.y);
      if (!pins.has(k)) pins.set(k, []);
      pins.get(k).push({ part: p, i: q.i, name: q.name });
    }
    for (const w of this.circuit.wires) for (const e of [w.a, w.b]) {
      const k = key(e.x, e.y);
      if (!ends.has(k)) ends.set(k, []);
      ends.get(k).push(e);
    }
    this.index = { holes, pins, ends };
    this.engine.build(this.circuit);
  }

  attachOffboardWires() {
    const c = this.circuit;
    for (const w of c.wires) {
      for (const e of [w.a, w.b]) {
        const onHole = c.boards.some((b) => b.holes().some((hl) => hl.x === e.x && hl.y === e.y));
        if (onHole) continue;
        for (const p of c.parts) {
          const q = p.worldPins().find((q) => q.x === e.x && q.y === e.y);
          if (q) { e.pin = { part: p.id, i: q.i }; break; }
        }
      }
    }
  }

  pinWorld(part, nameOrIdx) {
    const pins = part.worldPins();
    if (typeof nameOrIdx === 'number') return pins[nameOrIdx];
    const q = pins.find((p) => p.name === nameOrIdx);
    if (!q) throw new Error(`Pin "${nameOrIdx}" not found on ${part.type} (${pins.map((p) => p.name).join(', ')})`);
    return q;
  }

  wirePins(pA, pinA, pB, pinB, color) {
    const a = pA ? this.pinWorld(pA, pinA) : { x: pinA[0], y: pinA[1] };
    const b = pB ? this.pinWorld(pB, pinB) : { x: pinB[0], y: pinB[1] };
    const wa = { x: a.x, y: a.y };
    const wb = { x: b.x, y: b.y };
    if (pA) wa.pin = { part: pA.id, i: a.i };
    if (pB) wb.pin = { part: pB.id, i: b.i };
    this.circuit.wires.push(new Wire(wa, wb, color));
  }

  sceneBounds() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const b of this.circuit.boards) {
      x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
    }
    for (const p of this.circuit.parts) {
      const bb = p.bounds();
      x0 = Math.min(x0, bb.x0); y0 = Math.min(y0, bb.y0);
      x1 = Math.max(x1, bb.x1); y1 = Math.max(y1, bb.y1);
    }
    return { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
  }

  fitZoom(padPx = 36) {
    const bb = this.sceneBounds();
    const wPx = Math.max(1, this.renderer.w - padPx * 2);
    const hPx = Math.max(1, this.renderer.h - padPx * 2);
    const z = Math.min(wPx / (bb.w * P), hPx / (bb.h * P));
    return { cx: bb.cx, cy: bb.cy, z };
  }

  setCamera(cx, cy, z) {
    this.cam = {
      z,
      x: this.renderer.w / 2 - cx * P * z,
      y: this.renderer.h / 2 - cy * P * z,
    };
  }

  stepSim(seconds, maxSteps = 5000) {
    let rem = seconds;
    let steps = 0;
    while (rem > 1e-9 && steps < maxSteps) {
      const dt = Math.min(rem, this.engine.suggestDt ? this.engine.suggestDt() : 1e-4);
      this.engine.step(dt);
      rem -= dt;
      steps++;
    }
  }

  drawScene(opts = {}) {
    this.renderer.draw({
      cam: this.cam,
      dark: opts.dark ?? true,
      w: this.renderer.w,
      h: this.renderer.h,
      dpr: this.renderer.dpr,
      background: opts.background ?? '#000000',
      drawGrid: opts.drawGrid ?? false,
      hideSelection: true,
      live: opts.live ?? true,
      labelMode: opts.labelMode ?? 'off',
      drawWarnings: false,
    });
  }
}

const app = new StudioApp();

function buildScene(name) {
  const c = new Circuit();
  app.circuit = c;
  let meta = {};

  if (name === 'sap1-powers') {
    const built = buildSap1CpuCircuit({ program: 'powers2', potPos: 0.012 });
    app.circuit = built.circuit || built;
    ensureDesignators(app.circuit);
    app.reindex();
    tidy(app, app.circuit.wires);
    app.reindex();
    app.engine.reset();
    // Locate key SAP-1 hardware landmarks in world grid coords!
    const seg = app.circuit.parts.find((p) => p.type === 'seg7x4');
    const bClock = app.circuit.boards[0];
    const bAlu = app.circuit.boards[5];
    meta = {
      seg: seg ? { cx: (seg.bounds().x0 + seg.bounds().x1) / 2 - 4, cy: (seg.bounds().y0 + seg.bounds().y1) / 2 } : null,
      clock: bClock ? { cx: bClock.x + bClock.w * 0.45, cy: bClock.y + bClock.h * 0.5 } : null,
      alu: bAlu ? { cx: bAlu.x + bAlu.w * 0.5, cy: bAlu.y + bAlu.h * 0.5 } : null,
    };
  } else if (name === 'scope-rectifier') {
    c.name = 'Scope & Rectifier';
    c.boards.push(new Board('half', 10, 14));
    const fg = new Part('funcgen', 0, 11, 0, { power: true, wave: 'sine', hz: 25, vpp: 8, offsetOn: false, offset: 0 });
    const sc = new Part('oscilloscope', 22, 11, 0, {
      run: true, ch1On: true, ch2On: true, ch1Scale: 2, ch2Scale: 2, ch1Pos: 0.5, ch2Pos: -1.5,
      timeDiv: 0.01, coupling: 'DC', trigSrc: 'CH1', trigLevel: 0.2, measure: true,
    });
    const d1 = new Part('diode', 17, 19, 0, {});
    const r1 = new Part('resistor', 23, 21, 0, { ohms: 1000 });
    const c1 = new Part('capacitor', 22, 24, 0, { uf: 10, vmax: 25 });
    const led = new Part('led', 29, 20, 0, { color: 'cyan' });
    const rLed = new Part('resistor', 28, 25, 0, { ohms: 330 });
    c.parts.push(fg, sc, d1, r1, c1, led, rLed);
    // Board rails & rectifier circuit:
    // fg OUT+ -> col 17 (diode anode), fg OUT- -> bottom GND rail (y=32)
    app.wirePins(fg, 'OUT+', null, [17, 18], Y);
    app.wirePins(fg, 'OUT−', null, [14, 32], K);
    // Diode cathode (col 21) -> jumper to col 23 (R1 + C1+)
    c.wires.push(new Wire({ x: 21, y: 19 }, { x: 23, y: 19 }, O));
    // C1+ at col 22 -> tie to col 23; C1- at col 23? Let's tie C1+ to 23 and C1- to GND rail
    // Capacitor spans 1 col (pins at x,y and x+1,y) -> c1 at (22,24) has + at (22,24) and - at (23,24)!
    // Let's keep pins clean on separate columns:
    c1.x = 25; c1.y = 25;
    r1.x = 21; r1.y = 25;
    // Diode cathode at x=21 (cols 17..21), R1 from 21..25 (y=25 -> row f..j: bottom half of board is y=25..29!)
    // Wait: board at y=14 has top rails y=15,16; top half a..e y=18..22; trench y=23..24; bottom half f..j y=25..29; bottom rails y=31,32!
    d1.x = 16; d1.y = 20; // anode 16, cathode 20 (top half)
    r1.x = 20; r1.y = 21; // 20..24 (top half)
    c1.x = 24; c1.y = 26; // + at 24, - at 25 (bottom half)
    rLed.x = 28; rLed.y = 21; // 28..32 (top half)
    led.x = 32; led.y = 26; // anode 32, cathode 33 (bottom half)
    c.wires.length = 0;
    app.wirePins(fg, 'OUT+', null, [16, 18], Y);
    app.wirePins(fg, 'OUT−', null, [15, 32], K);
    c.wires.push(new Wire({ x: 20, y: 20 }, { x: 20, y: 21 }, O)); // D1 cathode -> R1 left
    c.wires.push(new Wire({ x: 24, y: 22 }, { x: 24, y: 25 }, G)); // R1 right -> C1+
    c.wires.push(new Wire({ x: 25, y: 28 }, { x: 25, y: 32 }, K)); // C1- -> GND rail
    c.wires.push(new Wire({ x: 24, y: 20 }, { x: 28, y: 20 }, G)); // Filtered node -> rLed
    c.wires.push(new Wire({ x: 32, y: 22 }, { x: 32, y: 25 }, G)); // rLed -> LED anode
    c.wires.push(new Wire({ x: 33, y: 28 }, { x: 33, y: 32 }, K)); // LED cathode -> GND rail
    // Scope probes: CH1 -> raw sine (col 16), CH2 -> rectified+filtered output (col 24)
    app.wirePins(sc, 'CH1+', null, [16, 19], Y);
    app.wirePins(sc, 'CH1 GND', null, [36, 32], K);
    app.wirePins(sc, 'CH2+', null, [24, 18], B);
    app.attachOffboardWires();
    ensureDesignators(c);
    app.reindex();
    tidy(app, c.wires);
    app.reindex();
    // Pre-warm scope buffer so waves fill the full CRT from frame 0!
    app.stepSim(0.18);
    const scb = sc.bounds();
    meta = {
      scopeScreen: { cx: scb.x0 + (scb.x1 - scb.x0) * 0.34, cy: scb.y0 + (scb.y1 - scb.y0) * 0.44 },
      funcGen: { cx: (fg.bounds().x0 + fg.bounds().x1) / 2, cy: (fg.bounds().y0 + fg.bounds().y1) / 2 },
      board: { cx: 25, cy: 23 },
    };
  } else if (name === 'bench-dmm-psu') {
    c.name = 'Bench PSU & DMM';
    c.boards.push(new Board('half', 8, 13));
    const psu = new Part('power-supply', 0, 10, 0, { power: true, mode: 'indep', v1: 5.0, i1: 2.0, v2: 12.0, i2: 2.0 });
    const dmm = new Part('multimeter', 28, 10, 0, { mode: 'dcv', hold: false });
    // Voltage divider + 3 LEDs on board (y=13 -> rails 14,15 and 30,31; top half 17..21, bot half 24..28)
    const rTop = new Part('resistor', 14, 19, 0, { ohms: 1000 });
    const rBot = new Part('resistor', 18, 25, 0, { ohms: 1000 });
    const rL1 = new Part('resistor', 24, 19, 0, { ohms: 330 });
    const l1 = new Part('led', 29, 19, 0, { color: 'green' });
    const rL2 = new Part('resistor', 24, 25, 0, { ohms: 330 });
    const l2 = new Part('led', 29, 25, 0, { color: 'blue' });
    c.parts.push(psu, dmm, rTop, rBot, rL1, l1, rL2, l2);
    app.wirePins(psu, 'MASTER +', null, [12, 14], R);
    app.wirePins(psu, 'MASTER −', null, [12, 15], K);
    c.wires.push(
      new Wire({ x: 35, y: 14 }, { x: 35, y: 30 }, R),
      new Wire({ x: 36, y: 15 }, { x: 36, y: 31 }, K),
      new Wire({ x: 14, y: 14 }, { x: 14, y: 17 }, R),
      new Wire({ x: 18, y: 21 }, { x: 18, y: 24 }, O),
      new Wire({ x: 22, y: 28 }, { x: 22, y: 31 }, K),
      new Wire({ x: 24, y: 14 }, { x: 24, y: 17 }, R),
      new Wire({ x: 28, y: 18 }, { x: 29, y: 18 }, G),
      new Wire({ x: 30, y: 21 }, { x: 30, y: 31 }, K),
      new Wire({ x: 24, y: 30 }, { x: 24, y: 28 }, R),
      new Wire({ x: 28, y: 26 }, { x: 29, y: 26 }, B),
      new Wire({ x: 30, y: 28 }, { x: 30, y: 31 }, K),
    );
    app.wirePins(dmm, '+', null, [18, 17], R);
    app.wirePins(dmm, '−', null, [22, 15], K);
    app.attachOffboardWires();
    ensureDesignators(c);
    app.reindex();
    tidy(app, c.wires);
    app.reindex();
    app.stepSim(0.05);
    meta = {
      psu: { cx: (psu.bounds().x0 + psu.bounds().x1) / 2, cy: (psu.bounds().y0 + psu.bounds().y1) / 2 },
      dmm: { cx: (dmm.bounds().x0 + dmm.bounds().x1) / 2, cy: (dmm.bounds().y0 + dmm.bounds().y1) / 2 },
      board: { cx: 23, cy: 22 },
      psuIdx: 0,
    };
  } else if (name === 'ttl-counter') {
    c.name = 'Binary Counter';
    c.boards.push(new Board('half', 0, 0));
    const parts = [
      ['vcc', 3, -3], ['gnd', 5, -3], ['clock', 9, -2, 0, { hz: 4 }],
      ['ic7493', 10, 11], ['bargraph', 20, 11, 0, { color: 'yellow' }],
      ['resistor', 20, 14, 1, { ohms: 330 }], ['resistor', 21, 14, 1, { ohms: 330 }],
      ['resistor', 22, 14, 1, { ohms: 330 }], ['resistor', 23, 14, 1, { ohms: 330 }],
    ];
    const wires = [
      [3, -3, 3, 1, R], [5, -3, 5, 2, K], [31, 1, 31, 17, R], [30, 2, 30, 18, K],
      [14, 15, 14, 17, R], [14, 4, 14, 2, K], [11, 15, 11, 18, K], [12, 15, 12, 18, K],
      [12, 5, 10, 14, O], [9, -2, 10, 6, B],
      [12, 7, 23, 7, G], [15, 6, 22, 6, G], [16, 5, 21, 5, G], [13, 4, 20, 4, G],
    ];
    for (const [t, x, y, rot = 0, props] of parts) c.parts.push(new Part(t, x, y, rot, props));
    for (const [x1, y1, x2, y2, col] of wires) c.wires.push(new Wire({ x: x1, y: y1 }, { x: x2, y: y2 }, col));
    app.attachOffboardWires();
    ensureDesignators(c);
    app.reindex();
    tidy(app, c.wires);
    app.reindex();
    meta = { ic: { cx: 13.5, cy: 10 }, bar: { cx: 22.5, cy: 10 } };
  } else if (name === 'ne555-blinker') {
    c.name = '555 Blinker';
    c.boards.push(new Board('half', 0, 0));
    const parts = [
      ['vcc', 3, -3], ['gnd', 5, -3], ['ne555', 6, 11],
      ['resistor', 7, 5, 3, { ohms: 1000 }], ['resistor', 7, 6, 0, { ohms: 10000 }],
      ['capacitor', 7, 14, 2, { uf: 15 }], ['resistor', 8, 12, 0, { ohms: 220 }],
      ['led', 12, 13, 0, { color: 'green' }],
    ];
    const wires = [
      [3, -3, 3, 1, R], [5, -3, 5, 2, K], [31, 1, 31, 17, R], [30, 2, 30, 18, K],
      [6, 4, 6, 1, R], [9, 14, 9, 17, R], [6, 15, 6, 18, K],
      [11, 4, 8, 4, B], [7, 13, 8, 7, Y], [13, 15, 13, 18, K],
    ];
    for (const [t, x, y, rot = 0, props] of parts) c.parts.push(new Part(t, x, y, rot, props));
    for (const [x1, y1, x2, y2, col] of wires) c.wires.push(new Wire({ x: x1, y: y1 }, { x: x2, y: y2 }, col));
    app.attachOffboardWires();
    ensureDesignators(c);
    app.reindex();
    tidy(app, c.wires);
    app.reindex();
    meta = { focus: { cx: 10.5, cy: 10.5 } };
  } else if (name === 'opamp-comparator') {
    c.name = 'LM358 Comparator';
    c.boards.push(new Board('half', 0, 0));
    // Half board: top rails 1,2; top half 4..8; bottom half 11..15; bot rails 17,18
    // LM358 at (12, 11): bottom row pins 1..4 at (12..15, 11): 1OUT, 1IN-, 1IN+, GND; top row pins 8..5 at (12..15, 8): VCC, 2OUT, 2IN-, 2IN+
    const vcc = new Part('vcc', 3, -3);
    const gnd = new Part('gnd', 5, -3);
    const pot = new Part('pot', 6, 13, 0, { pos: 0.15, ohms: 10000 }); // pins at (6,13), (7,13), (8,13)
    const op = new Part('lm358', 12, 11);
    const rRef1 = new Part('resistor', 18, 6, 0, { ohms: 10000 }); // 18..22
    const rRef2 = new Part('resistor', 22, 6, 0, { ohms: 10000 }); // 22..26
    const rOut = new Part('resistor', 19, 13, 0, { ohms: 220 }); // 19..23
    const led = new Part('led', 24, 13, 0, { color: 'green' }); // 24..25
    c.parts.push(vcc, gnd, pot, op, rRef1, rRef2, rOut, led);
    const wires = [
      [3, -3, 3, 1, R], [5, -3, 5, 2, K], [31, 1, 31, 17, R], [30, 2, 30, 18, K],
      // LM358 power: pin 8 (12,8) -> +5V, pin 4 (15,11) -> GND
      [12, 4, 12, 1, R], [15, 15, 15, 18, K],
      // Pot outer pins: (6,13) -> GND, (8,13) -> +5V so higher % -> higher voltage; wiper (7,13) -> 1IN+ (14,11)
      [6, 15, 6, 18, K], [8, 15, 8, 17, R], [7, 14, 14, 14, Y],
      // 2.5V Ref divider: 18 -> +5V, 26 -> GND, midpoint 22 -> 1IN- (13,11)
      [18, 4, 18, 1, R], [26, 4, 26, 2, K], [22, 8, 13, 12, B],
      // 1OUT (12,11) -> rOut (19,13) -> LED anode (24,13) -> cathode (25,13) -> GND
      [12, 13, 19, 13, G], [23, 14, 24, 14, G], [25, 15, 25, 18, K],
    ];
    for (const [x1, y1, x2, y2, col] of wires) c.wires.push(new Wire({ x: x1, y: y1 }, { x: x2, y: y2 }, col));
    app.attachOffboardWires();
    ensureDesignators(c);
    app.reindex();
    tidy(app, c.wires);
    app.reindex();
    meta = { potIdx: 2, focus: { cx: 15.5, cy: 11 } };
  } else if (name === 'and-gate-live') {
    c.name = 'AND Gate';
    c.boards.push(new Board('half', 0, 0));
    const parts = [
      ['vcc', 3, -3], ['gnd', 6, -3], ['ic7408', 10, 11],
      ['toggle', 7, 22, 2, { on: false }], ['toggle', 13, 22, 2, { on: false }],
      ['resistor', 20, 13, 0, { ohms: 220 }], ['led', 24, 12, 0, { color: 'red' }],
    ];
    const wires = [
      [3, -3, 3, 1, R], [6, -3, 6, 2, K], [28, 1, 28, 17, R], [29, 2, 29, 18, K],
      [10, 1, 10, 7, R], [16, 2, 16, 12, K], [7, 22, 10, 15, B], [13, 22, 11, 15, Y],
      [12, 14, 20, 14, G], [25, 15, 25, 18, K],
    ];
    for (const [t, x, y, rot = 0, props] of parts) c.parts.push(new Part(t, x, y, rot, props));
    for (const [x1, y1, x2, y2, col] of wires) c.wires.push(new Wire({ x: x1, y: y1 }, { x: x2, y: y2 }, col));
    app.attachOffboardWires();
    ensureDesignators(c);
    app.reindex();
    tidy(app, c.wires);
    app.reindex();
    meta = { swAIdx: 3, swBIdx: 4, focus: { cx: 15.5, cy: 13 } };
  }

  return { fit: app.fitZoom(34), bounds: app.sceneBounds(), meta };
}

window.DIRECTOR = {
  resize(w, h) {
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    app.renderer.w = w;
    app.renderer.h = h;
    app.renderer.dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * app.renderer.dpr);
    canvas.height = Math.round(h * app.renderer.dpr);
  },

  renderPartSprite(type, props = {}, size = 240, pad = 22) {
    this.resize(size, size);
    const c = new Circuit();
    const part = new Part(type, 0, 0, 0, props);
    c.parts.push(part);
    app.circuit = c;
    app.reindex();
    app.stepSim(0.02, 200);
    const bb = part.bounds();
    const bw = Math.max(1, bb.x1 - bb.x0);
    const bh = Math.max(1, bb.y1 - bb.y0);
    const z = Math.min((size - pad * 2) / (bw * P), (size - pad * 2) / (bh * P));
    app.setCamera((bb.x0 + bb.x1) / 2, (bb.y0 + bb.y1) / 2, z);
    app.drawScene({ background: 'transparent', drawGrid: false, live: true, labelMode: 'off', dark: true });
    return { ok: true, bw, bh, z };
  },

  loadScene(name) {
    return buildScene(name);
  },

  setPartProp(idx, prop, value) {
    const p = app.circuit.parts[idx];
    if (!p) return false;
    p.props[prop] = value;
    return true;
  },

  renderFrame({ cx, cy, zoom, stepSec = 0, background = '#000000', drawGrid = false, labelMode = 'off', live = true }) {
    if (stepSec > 0) app.stepSim(stepSec);
    app.setCamera(cx, cy, zoom);
    app.drawScene({ background, drawGrid, labelMode, live, dark: true });
  },
};

window.__DIRECTOR_READY = true;

import './parts/library.js';
import './mcu/boards.js';
import { Circuit, Board, Part, Wire, P, newId } from './model.js';
import { Engine, key } from './sim/engine.js';
import { Renderer, WIRE_COLORS } from './view/renderer.js';
import { Editor } from './editor.js';
import { UI } from './ui.js';
import { getDef } from './parts/registry.js';
import { Settings } from './settings.js';

const STORE = 'cf.v2.circuit';
const PROBE_COLORS = ['#ff9f0a', '#30d158', '#0a84ff', '#ff375f', '#bf5af2', '#64d2ff', '#ffd60a', '#ac8e68'];

class History {
  constructor(limit = 120) { this.stack = []; this.i = -1; this.limit = limit; }
  push(s) {
    if (this.stack[this.i] === s) return;
    this.stack = this.stack.slice(0, this.i + 1);
    this.stack.push(s);
    if (this.stack.length > this.limit) this.stack.shift();
    this.i = this.stack.length - 1;
  }
  canUndo() { return this.i > 0; }
  canRedo() { return this.i < this.stack.length - 1; }
  undo() { return this.canUndo() ? this.stack[--this.i] : null; }
  redo() { return this.canRedo() ? this.stack[++this.i] : null; }
}

// Compact example circuits: parts [type, x, y, rot, props], wires [x1, y1, x2, y2, color]
const R = '#e5484d', K = '#2b2d31', B = '#0a84ff', G = '#30a46c', Y = '#f5c400', O = '#ff8a00';
const EXAMPLES = [
  {
    name: 'AND Gate', sub: '7408 + two switches + LED',
    parts: [['vcc', 3, -3], ['gnd', 6, -3], ['ic7408', 10, 11], ['toggle', 7, 22, 2], ['toggle', 13, 22, 2],
      ['resistor', 20, 13, 0, { ohms: 220 }], ['led', 24, 12, 0, { color: 'red' }]],
    wires: [[3, -3, 3, 1, R], [6, -3, 6, 2, K], [28, 1, 28, 17, R], [29, 2, 29, 18, K],
      [10, 1, 10, 7, R], [16, 2, 16, 12, K], [7, 22, 10, 15, B], [13, 22, 11, 15, Y], [12, 14, 20, 14, G], [25, 15, 25, 18, K]],
  },
  {
    name: '555 Blinker', sub: 'Astable timer flashing an LED',
    parts: [['vcc', 3, -3], ['gnd', 5, -3], ['ne555', 6, 11], ['resistor', 7, 5, 3, { ohms: 1000 }], ['resistor', 7, 6, 0, { ohms: 10000 }],
      ['capacitor', 7, 14, 2, { uf: 47 }], ['resistor', 8, 12, 0, { ohms: 220 }], ['led', 12, 13, 0, { color: 'green' }]],
    wires: [[3, -3, 3, 1, R], [5, -3, 5, 2, K], [31, 1, 31, 17, R], [30, 2, 30, 18, K],
      [6, 4, 6, 1, R], [9, 14, 9, 17, R], [6, 15, 6, 18, K], [11, 4, 8, 4, B], [7, 13, 8, 7, Y], [13, 15, 13, 18, K]],
  },
  {
    name: 'Binary Counter', sub: 'Clock → 7493 → LED bar',
    parts: [['vcc', 3, -3], ['gnd', 5, -3], ['clock', 9, -2, 0, { hz: 2 }], ['ic7493', 10, 11], ['bargraph', 20, 11, 0, { color: 'yellow' }],
      ['resistor', 20, 14, 1, { ohms: 330 }], ['resistor', 21, 14, 1, { ohms: 330 }], ['resistor', 22, 14, 1, { ohms: 330 }], ['resistor', 23, 14, 1, { ohms: 330 }]],
    wires: [[3, -3, 3, 1, R], [5, -3, 5, 2, K], [31, 1, 31, 17, R], [30, 2, 30, 18, K],
      [14, 15, 14, 17, R], [14, 4, 14, 2, K], [11, 15, 11, 18, K], [12, 15, 12, 18, K], [12, 5, 10, 14, O], [9, -2, 10, 6, B],
      [12, 7, 23, 7, G], [15, 6, 22, 6, G], [16, 5, 21, 5, G], [13, 4, 20, 4, G]],
  },
];

class App {
  constructor() {
    this.canvas = document.getElementById('canvas');
    this.cam = { x: 0, y: 0, z: 1 };
    this.circuit = new Circuit();
    this.engine = new Engine();
    this.mode = 'build';          // 'build' | 'sim'
    this.paused = false;
    this.settings = new Settings(this);
    this.speed = this.settings.get('defaultSpeed');
    this.autoRoute = this.settings.get('autoRoute');
    this.effects = [];
    this.checks = [];
    this.wireColor = WIRE_COLORS[2].hex;
    this.autoColor = this.settings.get('autoColor');
    this.history = new History();
    this.samples = new Map();
    this.examples = EXAMPLES;
    this.index = { holes: new Map(), pins: new Map(), ends: new Map() };
    this.dirty = true;

    this.settings.apply();

    this.audio = new Sound(this.settings);
    document.body.dataset.mode = this.mode;
    this.renderer = new Renderer(this, this.canvas);
    this.editor = new Editor(this, this.canvas);
    this.ui = new UI(this);

    const urlParams = new URLSearchParams(window.location.search);
    const forceReset = urlParams.has('reset') || urlParams.has('new');

    if (forceReset || !this.restore()) {
      if (forceReset) {
        try {
          localStorage.removeItem(STORE);
          localStorage.removeItem(STORE + '.state');
        } catch {}
      }
      this.newCircuit();
    }
    this.resize();
    if (!this._restoredCam) {
      this.fit();
    } else {
      this.ui.syncToolbar();
      this.redraw();
    }
    window.addEventListener('resize', () => this.resize());
    new ResizeObserver(() => this.resize()).observe(this.canvas.parentElement);
    window.addEventListener('beforeunload', () => this.save());
    this.last = performance.now();
    requestAnimationFrame((t) => this.frame(t));
    setInterval(() => { this.ui.renderIssues(); this.ui.updatePins(); this.ui.updateBoardLive(); }, 250);
  }

  // ------------------------------------------------------------- document --
  reindex(fast = false) {
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
    this.computeNetKinds();
    if (!fast) this.computeChecks();
    this.redraw();
  }

  get running() { return this.mode === 'sim' && !this.paused; }

  // ---------------------------------------------------------- safety checks --
  /** Which supplies feed each net: net -> [{kind, part}] */
  computeNetKinds() {
    const kinds = new Map();
    for (const p of this.circuit.parts) {
      const def = getDef(p.type);
      if (!def.supply) continue;
      const e = this.engine.byPart.get(p.id);
      if (!e) continue;
      for (const s of def.supply(p)) {
        const n = e.pinNets[s.i];
        if (n < 0) continue;
        if (!kinds.has(n)) kinds.set(n, []);
        kinds.get(n).push({ kind: s.kind, part: p.id });
      }
    }
    this.netKinds = kinds;
  }
  clash(a, b) {
    const [ta, va] = a.split(':'), [tb, vb] = b.split(':');
    if ((ta === 'V' && tb === 'G') || (ta === 'G' && tb === 'V')) return `That would short the ${ta === 'V' ? va : vb} V supply straight to ground.`;
    if (ta === 'V' && tb === 'V' && va !== vb) return `That would connect the ${va} V and ${vb} V supplies together.`;
    if ((ta === 'B+' && tb === 'B-') || (ta === 'B-' && tb === 'B+')) { if (va === vb) return 'That would short the battery’s + and − together.'; }
    return null;
  }
  /** Placing a supply pin of `kind` at (x, y): does it clash with what that net already carries? */
  supplyClash(x, y, kind, ignoreIds) {
    const n = this.engine.netAt(x, y);
    if (n < 0) return null;
    for (const o of this.netKinds.get(n) || []) {
      if (ignoreIds.has(o.part)) continue;
      const why = this.clash(kind, o.kind);
      if (why) return why;
    }
    return null;
  }
  /** Joining the nets at two points with a wire: would that short supplies? */
  shortReason(a, b, ignoreWire = null) {
    const na = this.engine.netAt(a.x, a.y), nb = this.engine.netAt(b.x, b.y);
    if (na < 0 || nb < 0 || na === nb) return null;
    for (const x of this.netKinds.get(na) || []) for (const y of this.netKinds.get(nb) || []) {
      const why = this.clash(x.kind, y.kind);
      if (why) return why.replace('That would', 'That wire would');
    }
    return null;
  }
  /** Static wiring checks that don't need the simulation. */
  computeChecks() {
    const c = this.circuit, e = this.engine, out = [];
    const pinCount = new Map();
    for (const [, ent] of e.byPart) for (const n of ent.pinNets) if (n >= 0) pinCount.set(n, (pinCount.get(n) || 0) + 1);
    for (const w of c.wires) {
      const n = e.netAt(w.a.x, w.a.y);
      if (!pinCount.get(n)) out.push({ level: 'warn', wire: w, text: 'This wire isn’t connected to any part.' });
      const ha = this.index.holes.get(key(w.a.x, w.a.y)), hb = this.index.holes.get(key(w.b.x, w.b.y));
      if (ha && hb && ha.strip === hb.strip) out.push({ level: 'warn', wire: w, text: `Wire joins ${ha.label} to ${hb.label} — they’re already connected.` });
    }
    for (const p of c.parts) {
      const def = getDef(p.type);
      const ent = e.byPart.get(p.id);
      if (!ent || !ent.pinNets.length || def.cat === 'Notes') continue;
      const lonely = ent.pinNets.every(n => (pinCount.get(n) || 0) <= 1 && !c.wires.some(w => e.netAt(w.a.x, w.a.y) === n));
      if (lonely) out.push({ level: 'note', part: p, text: `${def.short || def.name} isn’t connected to anything yet.` });
    }
    this.checks = out;
  }
  allIssues() {
    const sim = this.mode === 'sim' ? this.engine.warnings : [];
    const damaged = this.mode === 'sim' ? [] : this.circuit.parts.filter(p => p.props.damaged).map(p => ({ level: 'error', part: p, text: `${getDef(p.type).name} is ${p.props.damaged === 'burst' ? 'burst' : 'burned out'} — replace it.` }));
    return [...sim, ...damaged, ...this.checks];
  }
  commit(label) {
    this.circuit.syncWires();
    this.reindex();
    this.history.push(JSON.stringify(this.circuit));
    this.save();
    this.ui.inspect();
    this.ui.syncToolbar();
    this.ui.renderProbes();
  }
  /** Interactive state changed (switch flipped, button pressed) — not an undo step. */
  stateChanged(topology) {
    if (topology) this.computeNetKinds();
    if (topology) this.engine.build(this.circuit);
    clearTimeout(this._saveT);
    this._saveT = setTimeout(() => this.save(), 400);
    this.redraw();
  }
  load(json, keepHistory = false) {
    this.circuit = Circuit.fromJSON(typeof json === 'string' ? JSON.parse(json) : json);
    this.editor.selection.clear();
    this.editor.mode = null;
    this.samples.clear();
    this.reindex();
    if (!keepHistory) { this.history = new History(); this.history.push(JSON.stringify(this.circuit)); }
    this.save();
    this.ui.inspect();
    this.ui.syncToolbar();
    this.ui.renderProbes();
  }
  undo() { const s = this.history.undo(); if (s) this.load(s, true); }
  redo() { const s = this.history.redo(); if (s) this.load(s, true); }
  save() {
    try {
      localStorage.setItem(STORE, JSON.stringify(this.circuit));
      this.saveCamera();
    } catch { /* storage full or blocked */ }
  }
  saveCamera() {
    try {
      if (this.cam && Number.isFinite(this.cam.x) && Number.isFinite(this.cam.y) && Number.isFinite(this.cam.z)) {
        localStorage.setItem(STORE + '.state', JSON.stringify({
          cam: { x: this.cam.x, y: this.cam.y, z: this.cam.z },
          mode: this.mode,
          speed: this.speed,
        }));
      }
    } catch { /* storage blocked */ }
  }
  restore() {
    try {
      const s = localStorage.getItem(STORE);
      if (!s) return false;
      this.load(s);
      const stateStr = localStorage.getItem(STORE + '.state');
      if (stateStr) {
        const state = JSON.parse(stateStr);
        if (state.cam && Number.isFinite(state.cam.x) && Number.isFinite(state.cam.y) && Number.isFinite(state.cam.z)) {
          this.cam.x = state.cam.x;
          this.cam.y = state.cam.y;
          this.cam.z = state.cam.z;
          this._restoredCam = true;
        }
        if (state.mode && (state.mode === 'build' || state.mode === 'sim')) {
          this.setMode(state.mode);
        }
        if (state.speed) {
          this.speed = state.speed;
        }
      }
      return true;
    } catch { return false; }
  }
  newCircuit() {
    const c = new Circuit();
    c.boards.push(new Board('half', 0, 0));
    this.load(c.toJSON());
    this.engine.reset();
    this._restoredCam = false;
    this.fit();
    this.save();
  }
  loadExample(ex, quiet) {
    const c = new Circuit();
    c.name = ex.name;
    c.boards.push(new Board('half', 0, 0));
    for (const [t, x, y, rot = 0, props] of ex.parts) c.parts.push(new Part(t, x, y, rot, props));
    for (const [x1, y1, x2, y2, col] of ex.wires) c.wires.push(new Wire({ x: x1, y: y1 }, { x: x2, y: y2 }, col));
    // attach wire ends that sit on off-board pins
    for (const w of c.wires) for (const e of [w.a, w.b]) {
      const onHole = c.boards.some(b => b.holes().some(hl => hl.x === e.x && hl.y === e.y));
      if (onHole) continue;
      for (const p of c.parts) { const q = p.worldPins().find(q => q.x === e.x && q.y === e.y); if (q) { e.pin = { part: p.id, i: q.i }; break; } }
    }
    this.load(c.toJSON());
    this.engine.reset();
    if (!quiet) { this.fit(); this.ui.toast(`Loaded “${ex.name}”`); }
  }

  saveFile() {
    const blob = new Blob([JSON.stringify(this.circuit, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (this.circuit.name || 'circuit').replace(/[^\w\- ]+/g, '').trim() + '.cforge.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  openFile() {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json,.cforge,application/json';
    inp.onchange = async () => {
      const f = inp.files[0];
      if (!f) return;
      try {
        const o = JSON.parse(await f.text());
        if (!o.boards && !o.parts) throw new Error('not a circuit');
        this.load(o); this.engine.reset(); this.fit();
        this.ui.toast(`Opened “${this.circuit.name}”`);
      } catch { this.ui.toast('That file isn’t a CircuitForge v2 circuit.'); }
    };
    inp.click();
  }
  exportPNG() {
    this.renderer.draw();
    const a = document.createElement('a');
    a.href = this.canvas.toDataURL('image/png');
    a.download = (this.circuit.name || 'circuit') + '.png';
    a.click();
  }

  // ------------------------------------------------------------- probes --
  addProbe(x, y, name) {
    const c = this.circuit;
    if (c.probes.some(p => p.x === x && p.y === y)) { this.ui.toggleAnalyzer(true); return; }
    if (c.probes.length >= 8) { this.ui.toast('The analyzer has 8 channels — remove one first.'); return; }
    let label = name;
    if (!label) {
      const pt = this.editor.describe(x, y);
      label = pt && pt.pins.length ? `${getDef(pt.pins[0].part.type).short || getDef(pt.pins[0].part.type).name} ${pt.pins[0].name}` : pt && pt.hole ? pt.hole.label : `${x},${y}`;
    }
    const used = new Set(c.probes.map(p => p.color));
    c.probes.push({ id: newId('pr'), x, y, name: label, color: PROBE_COLORS.find(col => !used.has(col)) || PROBE_COLORS[0] });
    this.commit('Add probe');
    this.ui.toggleAnalyzer(true);
  }
  removeProbe(id) {
    this.circuit.probes = this.circuit.probes.filter(p => p.id !== id);
    this.samples.delete(id);
    this.commit('Remove probe');
  }
  sample() {
    const probes = this.circuit.probes;
    if (!probes.length) return;
    const t = this.engine.time;
    for (const p of probes) {
      let buf = this.samples.get(p.id);
      if (!buf) { buf = { t: [], v: [] }; this.samples.set(p.id, buf); }
      const v = this.engine.voltage(this.engine.netAt(p.x, p.y));
      const n = buf.v.length;
      // store only changes (plus a heartbeat) to keep buffers small
      if (n && Math.abs((buf.v[n - 1] || 0) - (v || 0)) < 0.05 && Number.isNaN(buf.v[n - 1]) === Number.isNaN(v) && t - buf.t[n - 1] < 0.25) continue;
      buf.t.push(t); buf.v.push(v);
      if (buf.t.length > 6000) { buf.t.splice(0, 1000); buf.v.splice(0, 1000); }
    }
  }

  // ---------------------------------------------------------- simulation --
  setMode(mode) {
    if (mode === this.mode) return;
    this.editor.cancel();
    this.mode = mode;
    this.paused = false;
    if (mode === 'sim') {
      this.engine.reset();
      this.engine.build(this.circuit);
      this.samples.clear();
      this.editor.selection.clear();
    } else {
      for (const p of this.circuit.parts) p.ui = {};
      this.engine.build(this.circuit);
      this.audio.stopTone();
    }
    document.body.dataset.mode = mode;
    this.ui.syncToolbar();
    this.ui.inspect();
    this.redraw();
  }
  togglePause() { if (this.mode !== 'sim') return this.setMode('sim'); this.paused = !this.paused; this.ui.syncToolbar(); }
  toggleRun() { this.setMode(this.mode === 'sim' ? 'build' : 'sim'); }
  toggleAutoRoute() {
    this.settings.set('autoRoute', !this.autoRoute);
    this.ui.toast(this.autoRoute ? 'New wires route themselves neatly (hold ⇧ for a straight wire)' : 'New wires are straight (hold ⇧ to auto-route)');
    this.ui.syncToolbar();
  }
  audioUnlock() { this.audio.unlock(); }
  /** Devices report damage once; turn it into smoke, sound and an undo step. */
  handleEvents() {
    for (const d of this.engine.devices) {
      if (!d.event) continue;
      const ev = d.event; d.event = null;
      const b = d.part.bounds();
      this.effects.push({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2, t0: performance.now(), kind: ev.kind });
      this.audio.pop(ev.kind === 'burst' ? 1 : 0.5);
      this.ui.toast('💥 ' + ev.text);
      this.history.push(JSON.stringify(this.circuit));
      this.save();
      this.engine.build(this.circuit);
      this.ui.inspect();
    }
  }
  resetSim() {
    if (this.mode !== 'sim') return this.setMode('sim');
    this.engine.reset();
    this.samples.clear();
    for (const p of this.circuit.parts) p.ui = {};
    this.engine.build(this.circuit);
    this.ui.toast('Power cycled — all chips and capacitors reset.');
    this.redraw();
  }
  frame(now) {
    const real = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (this.effects.length) { this.effects = this.effects.filter(f => now - f.t0 < 3000); this.dirty = true; }
    if (this.running) {
      const target = real * this.speed;
      const e = this.engine;
      if (e.timeDependent) {
        const dt = 0.0005;
        const n = Math.min(240, Math.max(1, Math.round(target / dt)));
        for (let i = 0; i < n; i++) { e.step(target / n); this.sample(); }
      } else {
        e.step(target || 0.016);
        this.sample();
      }
      e.collectWarnings();
      this.handleEvents();
      this.ui.simClock();
      this.ui.pumpSerial();
      // buzzers
      let hz = 0;
      for (const d of e.devices) {
        if (d.audible && d.cur[0] > 0.004) hz = hz || 2300;
        if (d.rt && d.rt.tones && d.rt.tones.size && d.rt.toneHz) hz = d.rt.toneHz;
      }
      const buzzing = e.devices.some(d => d.audible && d.cur[0] > 0.004);
      if (buzzing) this.audio.tone(hz || 2300); else this.audio.stopTone();
      this.dirty = true;
    } else if (this.mode !== 'sim') this.audio.stopTone();
    if (this.dirty) {
      this.dirty = false;
      this.renderer.draw();
      this.ui.drawAnalyzer();
    }
    requestAnimationFrame((t) => this.frame(t));
  }

  // ---------------------------------------------------------------- view --
  redraw() { this.dirty = true; }
  resize() { this.renderer.resize(); this.redraw(); }
  zoomAt(sx, sy, z) {
    z = Math.min(4, Math.max(0.25, z));
    const c = this.cam;
    c.x = sx - (sx - c.x) * (z / c.z);
    c.y = sy - (sy - c.y) * (z / c.z);
    c.z = z;
    this.ui.syncToolbar();
    this.redraw();
    this.saveCamera();
  }
  /** Pan so the given bounds (or wire) are centred, keeping the zoom. */
  focusOn(b, wire) {
    if (!b && wire) { const pts = wire.path(); b = { x0: Math.min(...pts.map(p => p.x)), x1: Math.max(...pts.map(p => p.x)), y0: Math.min(...pts.map(p => p.y)), y1: Math.max(...pts.map(p => p.y)) }; }
    if (!b) return;
    this.cam.x = this.renderer.w / 2 - ((b.x0 + b.x1) / 2) * P * this.cam.z;
    this.cam.y = this.renderer.h / 2 - ((b.y0 + b.y1) / 2) * P * this.cam.z;
    this.redraw();
  }
  zoomBy(f) { this.zoomAt(this.renderer.w / 2, this.renderer.h / 2, this.cam.z * f); }
  fit() {
    const c = this.circuit;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const grow = (a, b, cc, d) => { x0 = Math.min(x0, a); y0 = Math.min(y0, b); x1 = Math.max(x1, cc); y1 = Math.max(y1, d); };
    for (const b of c.boards) grow(b.x, b.y, b.x + b.w, b.y + b.h);
    for (const p of c.parts) { const b = p.bounds(); grow(b.x0, b.y0, b.x1, b.y1); }
    for (const w of c.wires) for (const q of w.path()) grow(q.x, q.y, q.x, q.y);
    if (!Number.isFinite(x0)) { x0 = 0; y0 = 0; x1 = 30; y1 = 20; }
    const W = this.renderer.w || 800, H = this.renderer.h || 600, pad = 48;
    const z = Math.min(2, Math.max(0.3, Math.min((W - pad * 2) / ((x1 - x0) * P), (H - pad * 2) / ((y1 - y0) * P))));
    this.cam.z = z;
    this.cam.x = W / 2 - ((x0 + x1) / 2) * P * z;
    this.cam.y = H / 2 - ((y0 + y1) / 2) * P * z;
    this.ui.syncToolbar();
    this.redraw();
  }
  toggleTheme() {
    this.settings.set('theme', this.settings.resolvedTheme() === 'dark' ? 'light' : 'dark');
    this.redraw();
  }
  setWireColor(i) {
    const c = WIRE_COLORS[i];
    if (!c) return;
    this.wireColor = c.hex;
    const sel = this.editor.selected().wires;
    if (sel.length) { for (const w of sel) w.color = c.hex; this.commit('Wire color'); }
    this.ui.syncToolbar();
  }
}

class Sound {
  constructor(settings) { this.settings = settings; this.ctx = null; this.osc = null; }
  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { this.ctx = null; }
  }
  tone(hz) {
    if (!this.ctx || !this.settings.get('sound')) { this.stopTone(); return; }
    if (!this.osc) {
      this.osc = this.ctx.createOscillator(); this.gain = this.ctx.createGain();
      this.osc.type = 'square'; this.gain.gain.value = 0.05 * this.settings.get('volume');
      this.osc.connect(this.gain).connect(this.ctx.destination); this.osc.start();
    }
    this.osc.frequency.setTargetAtTime(Math.min(8000, hz), this.ctx.currentTime, 0.01);
  }
  stopTone() { if (this.osc) { this.osc.stop(); this.osc.disconnect(); this.osc = null; } }
  pop(strength) {
    if (!this.ctx || !this.settings.get('sound')) return;
    const n = this.ctx.sampleRate * 0.25, buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate), ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) ch[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 4);
    const src = this.ctx.createBufferSource(), g = this.ctx.createGain();
    g.gain.value = 0.5 * strength * this.settings.get('volume'); src.buffer = buf; src.connect(g).connect(this.ctx.destination); src.start();
  }
}

window.app = new App();

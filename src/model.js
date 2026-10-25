/**
 * Circuit document model. All coordinates are integer grid units
 * (one unit = one 0.1" breadboard pitch); the view multiplies by P.
 */
import { getDef } from './parts/registry.js';

export const P = 20; // pixels per grid unit at 100% zoom

let nextId = 1;
export const newId = (prefix) => prefix + (nextId++);
export function bumpIds(id) {
  const n = parseInt(String(id).replace(/\D/g, ''), 10);
  if (n >= nextId) nextId = n + 1;
}

export const BOARD_SIZES = {
  mini: { label: 'Mini · 170 points', cols: 17, rails: false },
  half: { label: 'Half · 400 points', cols: 30, rails: true },
  full: { label: 'Full · 830 points', cols: 63, rails: true },
};
export const ROW_LETTERS = 'abcdefghij';

export class Board {
  constructor(size = 'half', x = 0, y = 0, id = newId('b')) {
    this.id = id; this.size = size; this.x = x; this.y = y;
    this._cache = null;
  }
  get cols() { return BOARD_SIZES[this.size].cols; }
  get rails() { return BOARD_SIZES[this.size].rails; }
  get w() { return this.cols + 3; }
  get h() { return this.rails ? 20 : 15; }
  /** y offsets (relative) of the ten terminal rows a..j */
  rowY(r) { const top = this.rails ? 4 : 2; return top + r + (r >= 5 ? 2 : 0); }
  railY() { return this.rails ? { tp: 1, tn: 2, bp: 17, bn: 18 } : null; }
  holes() {
    const k = `${this.x},${this.y},${this.size}`;
    if (this._cache && this._cache.k === k) return this._cache.list;
    const list = [];
    for (let c = 0; c < this.cols; c++) {
      const x = this.x + 2 + c;
      for (let r = 0; r < 10; r++) {
        list.push({ x, y: this.y + this.rowY(r), strip: `${this.id}:${c}:${r < 5 ? 't' : 'b'}`,
          label: `${ROW_LETTERS[r]}${c + 1}`, rail: null, col: c, row: r });
      }
      const ry = this.railY();
      if (ry) {
        for (const [name, y] of Object.entries(ry)) {
          list.push({ x, y: this.y + y, strip: `${this.id}:${name}`, rail: name[1] === 'p' ? '+' : '−',
            label: `${name[0] === 't' ? 'Top' : 'Bottom'} ${name[1] === 'p' ? '+' : '−'} rail`, col: c, row: -1 });
        }
      }
    }
    this._cache = { k, list };
    return list;
  }
  contains(x, y) { return x >= this.x && x <= this.x + this.w && y >= this.y && y <= this.y + this.h; }
  toJSON() { return { id: this.id, size: this.size, x: this.x, y: this.y }; }
}

const ROT = [[1, 0, 0, 1], [0, -1, 1, 0], [-1, 0, 0, -1], [0, 1, -1, 0]];
export function rotPt(x, y, rot) {
  const m = ROT[((rot % 4) + 4) % 4];
  return { x: m[0] * x + m[1] * y, y: m[2] * x + m[3] * y };
}

export class Part {
  constructor(type, x = 0, y = 0, rot = 0, props = null, id = newId('p')) {
    this.id = id; this.type = type; this.x = x; this.y = y; this.rot = rot;
    const def = getDef(type);
    this.props = Object.assign({}, structuredClone(def.defaults || {}), props || {});
    this.ui = {}; // transient interaction state (pressed buttons etc.)
  }
  get def() { return getDef(this.type); }
  localPins() { return this.def.pins(this.props); }
  worldPins() {
    return this.localPins().map((p, i) => {
      const r = rotPt(p.x, p.y, this.rot);
      return { x: this.x + r.x, y: this.y + r.y, name: p.name, i };
    });
  }
  toLocal(wx, wy) { return rotPt(wx - this.x, wy - this.y, 4 - this.rot); }
  /** World-space bounding box (grid units, may be fractional). */
  bounds() {
    const b = this.def.bounds(this.props);
    const pts = [rotPt(b[0], b[1], this.rot), rotPt(b[2], b[1], this.rot), rotPt(b[0], b[3], this.rot), rotPt(b[2], b[3], this.rot)];
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    return { x0: this.x + Math.min(...xs), y0: this.y + Math.min(...ys), x1: this.x + Math.max(...xs), y1: this.y + Math.max(...ys) };
  }
  hit(wx, wy) {
    const l = this.toLocal(wx, wy);
    const b = this.def.bounds(this.props);
    return l.x >= b[0] && l.x <= b[2] && l.y >= b[1] && l.y <= b[3];
  }
  toJSON() { return { id: this.id, type: this.type, x: this.x, y: this.y, rot: this.rot, props: this.props }; }
}

/** Wire end: fixed grid point, optionally attached to a part pin (follows the part). */
export class Wire {
  constructor(a, b, color = '#e5484d', pts = [], id = newId('w')) {
    this.id = id; this.a = { ...a }; this.b = { ...b }; this.color = color; this.pts = pts.map(p => ({ ...p }));
  }
  path() { return [this.a, ...this.pts, this.b]; }
  toJSON() { return { id: this.id, a: this.a, b: this.b, color: this.color, pts: this.pts }; }
}

export class Circuit {
  constructor() {
    this.name = 'Untitled Circuit';
    this.boards = [];
    this.parts = [];
    this.wires = [];
    this.probes = []; // { id, x, y, name, color }
  }
  partById(id) { return this.parts.find(p => p.id === id); }
  /** Keep wire ends that are attached to pins in sync after parts move. */
  syncWires() {
    for (const w of this.wires) {
      for (const end of [w.a, w.b]) {
        if (!end.pin) continue;
        const p = this.partById(end.pin.part);
        if (!p) { delete end.pin; continue; }
        const wp = p.worldPins()[end.pin.i];
        if (wp) { end.x = wp.x; end.y = wp.y; } else delete end.pin;
      }
    }
  }
  toJSON() {
    return { app: 'circuitforge', version: 2, name: this.name,
      boards: this.boards.map(b => b.toJSON()), parts: this.parts.map(p => p.toJSON()),
      wires: this.wires.map(w => w.toJSON()), probes: this.probes };
  }
  static fromJSON(o) {
    const c = new Circuit();
    c.name = o.name || 'Untitled Circuit';
    for (const b of o.boards || []) { c.boards.push(new Board(b.size, b.x, b.y, b.id)); bumpIds(b.id); }
    for (const p of o.parts || []) {
      if (!getDef(p.type, true)) continue;
      c.parts.push(new Part(p.type, p.x, p.y, p.rot, p.props, p.id)); bumpIds(p.id);
    }
    for (const w of o.wires || []) { c.wires.push(new Wire(w.a, w.b, w.color, w.pts, w.id)); bumpIds(w.id); }
    c.probes = (o.probes || []).map(p => ({ ...p }));
    for (const p of c.probes) bumpIds(p.id);
    c.syncWires();
    return c;
  }
}

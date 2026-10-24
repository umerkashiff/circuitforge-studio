/**
 * Pointer & keyboard interaction.
 *
 * BUILD mode
 *  Drag from any hole or pin ............ draw a wire (auto-routed; hold ⇧ for a straight jumper)
 *  Click a hole, click…, click a hole ... wire with your own bends
 *  Drag a part .......................... move it (⌥-drag duplicates)
 *  Drag on empty canvas ................. box-select
 *  Drag the ⠿ grip of a breadboard ...... move the board with everything on it
 *  Select a wire, drag its ends/bends ... re-route; drag the wire body to add a bend
 * SIMULATE mode — the circuit is locked; click switches, hold buttons, turn knobs, drag to pan.
 * Both: scroll / two-finger drag pans, pinch or ⌘-scroll zooms, Space-drag pans.
 */
import { P, Part, Wire, Board } from './model.js';
import { getDef } from './parts/registry.js';
import { key } from './sim/engine.js';
import { route, tidy } from './sim/router.js';
import { WIRE_COLORS } from './view/renderer.js';

const TAU = Math.PI * 2;
const DRAG_PX = 4;
export const COLOR_KEYS = { r: 0, b: 1, k: 1, u: 2, g: 3, y: 4, o: 5, p: 6, w: 7 };

function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l = dx * dx + dy * dy;
  let t = l ? ((px - ax) * dx + (py - ay) * dy) / l : 0;
  t = Math.max(0, Math.min(1, t));
  const x = ax + t * dx - px, y = ay + t * dy - py;
  return Math.sqrt(x * x + y * y);
}

export class Editor {
  constructor(app, canvas) {
    this.app = app;
    this.cv = canvas;
    this.selection = new Set();
    this.mode = null;
    this.mx = 0; this.my = 0;
    this.hover = null;
    this.hoverNet = -1;
    this.hoverPart = null;
    this.space = false;
    this.shift = false;
    this.clipboard = null;
    this.bind();
  }

  get sim() { return this.app.mode === 'sim'; }

  // ------------------------------------------------------------- geometry --
  toWorld(cx, cy) {
    const r = this.cv.getBoundingClientRect();
    const c = this.app.cam;
    return { x: (cx - r.left - c.x) / (c.z * P), y: (cy - r.top - c.y) / (c.z * P) };
  }
  get hitR() { return Math.max(0.36, 8 / (P * this.app.cam.z)); }

  pointAt(wx, wy, ignoreWireEnd = null) {
    const gx = Math.round(wx), gy = Math.round(wy);
    if (Math.hypot(wx - gx, wy - gy) > this.hitR) return null;
    return this.describe(gx, gy, ignoreWireEnd);
  }
  describe(gx, gy, ignoreWireEnd = null) {
    const ix = this.app.index;
    const k = key(gx, gy);
    const hole = ix.holes.get(k) || null;
    const pins = ix.pins.get(k) || [];
    const ends = (ix.ends.get(k) || []).filter(e => e !== ignoreWireEnd);
    if (!hole && !pins.length && !ends.length) return null;
    return { x: gx, y: gy, hole, pins, ends };
  }
  topPartAt(wx, wy) {
    const parts = this.app.circuit.parts;
    for (let i = parts.length - 1; i >= 0; i--) if (parts[i].hit(wx, wy)) return parts[i];
    return null;
  }
  wireAt(wx, wy, minR = 0.25) {
    const ws = this.app.circuit.wires;
    const r = Math.max(minR, (minR * 24) / (P * this.app.cam.z));
    for (let i = ws.length - 1; i >= 0; i--) {
      const pts = ws[i].path();
      for (let k = 0; k < pts.length - 1; k++) {
        if (segDist(wx, wy, pts[k].x, pts[k].y, pts[k + 1].x, pts[k + 1].y) < r) return { wire: ws[i], seg: k };
      }
    }
    return null;
  }
  gripAt(wx, wy) {
    for (const b of this.app.circuit.boards) {
      if (Math.abs(wx - (b.x + 0.53)) < 1.2 && Math.abs(wy - (b.y + 0.65)) < 1.2) return b;
    }
    return null;
  }
  boardAt(wx, wy) {
    for (const b of this.app.circuit.boards) {
      if (b.contains(wx, wy)) return b;
    }
    return null;
  }

  // --------------------------------------------------------------- events --
  bind() {
    const cv = this.cv;
    cv.addEventListener('pointerdown', (e) => this.down(e));
    window.addEventListener('pointermove', (e) => this.move(e));
    window.addEventListener('pointerup', (e) => this.up(e));
    window.addEventListener('pointercancel', (e) => this.up(e));
    window.addEventListener('blur', () => { this.ctrl = false; this.shift = false; if (this.mode && this.mode.kind === 'drag') this.endDrag(); });
    cv.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    cv.addEventListener('contextmenu', (e) => { e.preventDefault(); this.context(e); });
    cv.addEventListener('dblclick', (e) => this.dblclick(e));
    cv.addEventListener('pointerleave', () => { this.hover = null; this.hoverNet = -1; this.hoverPart = null; this.app.ui.tip(null); this.app.redraw(); });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Control' || e.key === 'Meta') { this.ctrl = true; this.cursor(); }
      this.key(e);
    });
    window.addEventListener('keyup', (e) => {
      if (e.key === 'Control' || e.key === 'Meta') { this.ctrl = false; this.cursor(); }
      if (e.key === 'Shift') this.shift = false;
    });
  }

  cursor(c) {
    if (c) { this.cv.style.cursor = c; return; }
    const m = this.mode;
    if (this.ctrl) this.cv.style.cursor = 'grab';
    else if (m && m.kind === 'place') this.cv.style.cursor = 'copy';
    else if (m && m.kind === 'wire') this.cv.style.cursor = 'crosshair';
    else this.cv.style.cursor = 'default';
  }

  locked() { this.app.ui.toast('You’re in Simulate mode — press ⌘↵ or click Build to edit.'); }

  down(e) {
    this.app.ui.closeMenus();
    this.app.audioUnlock();
    if (this.mode && this.mode.kind !== 'place' && this.mode.kind !== 'wire') this.up(e);
    const w = this.toWorld(e.clientX, e.clientY);
    this.mx = w.x; this.my = w.y;
    this.shift = e.shiftKey;
    this.downAt = { sx: e.clientX, sy: e.clientY, wx: w.x, wy: w.y };
    this.moved = false;
    const panMode = () => { this.mode = { kind: 'pan', cx: this.app.cam.x, cy: this.app.cam.y }; this.cursor('grabbing'); };

    if (e.button === 0 && (e.ctrlKey || e.metaKey)) { panMode(); return; }
    if (e.button !== 0) return;
    const m = this.mode;
    if (m && m.kind === 'place') { this.place(e.altKey || e.shiftKey); return; }
    if (m && m.kind === 'wire') { this.wireClick(); return; }

    if (!this.sim) {
      for (const id of this.selection) {
        const wire = this.app.circuit.wires.find(x => x.id === id);
        if (!wire) continue;
        for (const end of ['a', 'b']) {
          if (Math.hypot(wire[end].x - w.x, wire[end].y - w.y) < this.hitR) { this.mode = { kind: 'wireEnd', wire, end, orig: { ...wire[end] } }; return; }
        }
        for (let i = 0; i < wire.pts.length; i++) {
          if (Math.hypot(wire.pts[i].x - w.x, wire.pts[i].y - w.y) < this.hitR) { this.mode = { kind: 'bend', wire, i, orig: { ...wire.pts[i] } }; return; }
        }
      }
    }

    const grip = !this.sim && this.gripAt(w.x, w.y);
    if (grip) { this.select([grip.id], e.shiftKey); this.mode = { kind: 'partDown', board: grip }; return; }

    const part = this.topPartAt(w.x, w.y);
    const pt = this.pointAt(w.x, w.y);
    const ptIsPinOfPart = pt && part && pt.pins.some(p => p.part === part);
    const over = !part && pt ? this.wireAt(w.x, w.y, 0.2) : null;
    if (over && !pt.ends.some(x => x === over.wire.a || x === over.wire.b)) {
      this.select([over.wire.id], e.shiftKey);
      if (this.sim) panMode(); else this.mode = { kind: 'wireBody', ...over };
      return;
    }
    if (pt && (!part || ptIsPinOfPart) && !this.sim) { this.mode = { kind: 'wireStart', from: pt }; return; }
    if (part) {
      const def = getDef(part.type);
      const ctrl = def.control ? def.control(part, part.toLocal(w.x, w.y)) : null;
      if (ctrl === 'press') { part.ui.pressed = true; this.app.stateChanged(true); }
      if (ctrl === 'knob') { this.mode = { kind: 'knob', part, v0: part.props.pos }; return; }
      if (!this.selection.has(part.id) && !ctrl) this.select([part.id], e.shiftKey);
      this.mode = { kind: 'partDown', part, ctrl, shift: e.shiftKey, alt: e.altKey };
      return;
    }
    const hw = this.wireAt(w.x, w.y);
    if (hw) {
      this.select([hw.wire.id], e.shiftKey);
      if (this.sim) panMode(); else this.mode = { kind: 'wireBody', ...hw };
      return;
    }
    const board = !this.sim && this.boardAt(w.x, w.y);
    if (board) { this.select([board.id], e.shiftKey); this.mode = { kind: 'partDown', board }; return; }
    if (!e.shiftKey) this.select([]);
    if (this.sim) { panMode(); return; }
    this.mode = { kind: 'marquee', x0: w.x, y0: w.y, x1: w.x, y1: w.y, add: e.shiftKey, base: new Set(this.selection) };
  }

  move(e) {
    const w = this.toWorld(e.clientX, e.clientY);
    this.mx = w.x; this.my = w.y;
    this.shift = e.shiftKey;
    const m = this.mode;
    if (this.downAt && !this.moved && Math.hypot(e.clientX - this.downAt.sx, e.clientY - this.downAt.sy) > DRAG_PX) this.moved = true;

    if (m && m.kind === 'pan') {
      this.app.cam.x = m.cx + (e.clientX - this.downAt.sx);
      this.app.cam.y = m.cy + (e.clientY - this.downAt.sy);
      this.app.redraw();
      return;
    }
    if (m && m.kind === 'knob') {
      const dy = (this.downAt.sy - e.clientY) + (e.clientX - this.downAt.sx);
      m.part.props.pos = Math.max(0, Math.min(1, m.v0 + dy / 160));
      this.app.stateChanged(false);
      return;
    }
    if (m && this.moved) {
      if (m.kind === 'wireStart') this.mode = { kind: 'wire', from: m.from, pts: [], dragged: true };
      else if (m.kind === 'partDown') {
        if (m.ctrl === 'press') { m.part.ui.pressed = false; this.app.stateChanged(true); }
        if (this.sim) { this.mode = { kind: 'pan', cx: this.app.cam.x - (e.clientX - this.downAt.sx), cy: this.app.cam.y - (e.clientY - this.downAt.sy) }; return this.move(e); }
        if (m.part && !this.selection.has(m.part.id)) this.select([m.part.id], m.shift);
        if (m.alt && this.copy()) { this.paste(0, true); }
        this.beginDrag();
      } else if (m.kind === 'wireBody') {
        const wire = m.wire;
        wire.pts.splice(m.seg, 0, { x: Math.round(w.x * 2) / 2, y: Math.round(w.y * 2) / 2 });
        this.mode = { kind: 'bend', wire, i: m.seg, inserted: true };
      }
    }
    const mm = this.mode;
    if (mm) {
      if (mm.kind === 'place') { this.positionGhost(); this.liveProblemHint([mm.ghost].filter(Boolean)); }
      else if (mm.kind === 'drag') this.dragTo(w);
      else if (mm.kind === 'wireEnd') {
        const pt = this.pointAt(w.x, w.y, mm.wire[mm.end]);
        mm.wire[mm.end].x = pt ? pt.x : w.x; mm.wire[mm.end].y = pt ? pt.y : w.y;
      } else if (mm.kind === 'bend') {
        mm.wire.pts[mm.i] = { x: Math.round(w.x * 2) / 2, y: Math.round(w.y * 2) / 2 };
      } else if (mm.kind === 'marquee') {
        mm.x1 = w.x; mm.y1 = w.y;
        this.marqueeSelect(mm);
      }
    }
    if (!mm || mm.kind === 'wire' || mm.kind === 'place' || mm.kind === 'wireEnd') this.updateHover(e);
    this.app.redraw();
  }

  up(e) {
    const m = this.mode;
    if (!m) return;
    const w = this.toWorld(e.clientX, e.clientY);
    switch (m.kind) {
      case 'pan':
        this.app.saveCamera();
        this.mode = null;
        break;
      case 'knob': case 'wireBody': case 'marquee': this.mode = null; break;
      case 'wireStart':
        this.mode = { kind: 'wire', from: m.from, pts: [] };
        this.app.ui.hint('Click to add bends · click a hole or pin to finish · Esc to cancel');
        break;
      case 'wire':
        if (m.dragged) {
          const pt = this.pointAt(w.x, w.y);
          if (pt && !(pt.x === m.from.x && pt.y === m.from.y)) this.finishWire(pt);
          else if (!pt) { m.dragged = false; m.pts.push({ x: Math.round(w.x), y: Math.round(w.y) }); this.app.ui.hint('Click to add bends · click a hole or pin to finish · Esc to cancel'); }
          else this.cancel();
        }
        break;
      case 'partDown':
        if (m.ctrl === 'press') { m.part.ui.pressed = false; this.app.stateChanged(true); }
        else if (m.ctrl) {
          const def = getDef(m.part.type);
          if (def.click && def.click(m.part, m.ctrl)) this.app.stateChanged(!!def.links);
        }
        this.mode = null;
        break;
      case 'drag': this.endDrag(); break;
      case 'wireEnd': {
        const pt = this.pointAt(w.x, w.y, m.wire[m.end]);
        const other = m.end === 'a' ? m.wire.b : m.wire.a;
        const why = pt && this.app.shortReason(pt, other, m.wire);
        if (pt && !why) { m.wire[m.end] = this.endFor(pt); this.app.commit('Move wire end'); }
        else { m.wire[m.end] = m.orig; if (why) this.app.ui.toast(why); }
        this.mode = null;
        break;
      }
      case 'bend': {
        const wire = m.wire, pts = wire.path(), i = m.i + 1;
        const a = pts[i - 1], b = pts[i], c = pts[i + 1];
        if (Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) < 0.05) wire.pts.splice(m.i, 1);
        this.app.commit('Bend wire');
        this.mode = null;
        break;
      }
    }
    this.downAt = null;
    this.cursor();
    this.app.redraw();
  }

  wheel(e) {
    e.preventDefault();
    const cam = this.app.cam;
    // knob under the cursor turns with the wheel
    const w = this.toWorld(e.clientX, e.clientY);
    const part = this.topPartAt(w.x, w.y);
    if (part && getDef(part.type).control && getDef(part.type).control(part, part.toLocal(w.x, w.y)) === 'knob' && !e.ctrlKey) {
      part.props.pos = Math.max(0, Math.min(1, part.props.pos - e.deltaY / 600));
      this.app.stateChanged(false);
      return;
    }
    // Trackpad / wheel ONLY zooms; does not move canvas
    const r = this.cv.getBoundingClientRect();
    const dy = e.deltaY !== 0 ? e.deltaY : e.deltaX;
    const f = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.002));
    this.app.zoomAt(e.clientX - r.left, e.clientY - r.top, cam.z * f);
    this.app.redraw();
    this.app.saveCamera();
  }

  dblclick(e) {
    const w = this.toWorld(e.clientX, e.clientY);
    if (!this.sim) {
      for (const id of this.selection) {
        const wire = this.app.circuit.wires.find(x => x.id === id);
        if (!wire) continue;
        const i = wire.pts.findIndex(p => Math.hypot(p.x - w.x, p.y - w.y) < this.hitR);
        if (i >= 0) { wire.pts.splice(i, 1); this.app.commit('Remove bend'); return; }
      }
    }
    const part = this.topPartAt(w.x, w.y);
    if (part) {
      this.select([part.id]);
      if (getDef(part.type).mcu) this.app.ui.openCode(part); else this.app.ui.focusFirstField();
    }
  }

  updateHover(e) {
    const m = this.mode;
    const ignore = m && m.kind === 'wireEnd' ? m.wire[m.end] : null;
    let pt = this.pointAt(this.mx, this.my, ignore);
    const part = !m ? this.topPartAt(this.mx, this.my) : null;
    if (pt && part && !pt.pins.some(p => p.part === part)) pt = null;
    this.hover = pt;
    this.hoverPart = part && getDef(part.type).ic ? part : (pt && pt.pins.length && getDef(pt.pins[0].part.type).ic ? pt.pins[0].part : null);
    const sim = this.app.engine;
    this.hoverNet = pt ? sim.netAt(pt.x, pt.y) : -1;
    if (pt && (!m || m.kind !== 'place') && this.app.settings.get('tooltips')) this.app.ui.tip(this.tipFor(pt), e.clientX, e.clientY);
    else this.app.ui.tip(null);
  }

  tipFor(pt) {
    const lines = [];
    if (pt.hole) lines.push(pt.hole.rail ? pt.hole.label : `Hole ${pt.hole.label}`);
    for (const p of pt.pins) {
      const def = getDef(p.part.type);
      lines.push(`${def.short || def.name} · ${def.ic ? 'pin ' + (p.i + 1) + ' ' : ''}${p.name}`);
    }
    if (!pt.hole && !pt.pins.length) lines.push('Wire junction');
    const sim = this.app.engine;
    const v = sim.voltage(sim.netAt(pt.x, pt.y));
    let state = '';
    if (this.sim) state = Number.isNaN(v) ? 'not powered (floating)' : `${v.toFixed(2)} V · ${v >= 2 ? 'HIGH' : v <= 0.8 ? 'LOW' : 'in between'}`;
    return { lines, state, level: Number.isNaN(v) ? 'float' : v >= 2 ? 'high' : v <= 0.8 ? 'low' : 'mid' };
  }

  // ------------------------------------------------------------ selection --
  select(ids, add = false) {
    if (!add) this.selection.clear();
    for (const id of ids) {
      if (add && this.selection.has(id)) this.selection.delete(id); else this.selection.add(id);
    }
    this.app.ui.inspect();
    this.app.redraw();
  }
  marqueeSelect(m) {
    const x0 = Math.min(m.x0, m.x1), x1 = Math.max(m.x0, m.x1), y0 = Math.min(m.y0, m.y1), y1 = Math.max(m.y0, m.y1);
    const sel = new Set(m.add ? m.base : []);
    const c = this.app.circuit;
    for (const p of c.parts) { const b = p.bounds(); if (b.x1 >= x0 && b.x0 <= x1 && b.y1 >= y0 && b.y0 <= y1) sel.add(p.id); }
    for (const w of c.wires) if (w.path().some(q => q.x >= x0 && q.x <= x1 && q.y >= y0 && q.y <= y1)) sel.add(w.id);
    for (const b of c.boards) if (b.x >= x0 && b.x + b.w <= x1 && b.y >= y0 && b.y + b.h <= y1) sel.add(b.id);
    this.selection = sel;
    this.app.ui.inspect();
  }
  selected() {
    const c = this.app.circuit, s = this.selection;
    return { parts: c.parts.filter(p => s.has(p.id)), wires: c.wires.filter(w => s.has(w.id)), boards: c.boards.filter(b => s.has(b.id)) };
  }

  // ------------------------------------------------------------ validation --
  /**
   * Why `parts` can't sit where they are, per pin. Checks: landing on another
   * part's pin, shorting two of its own pins through one breadboard strip,
   * and wiring a supply pin straight into ground (or another supply).
   */
  problems(parts) {
    const app = this.app, ix = app.index;
    const ids = new Set(parts.map(p => p.id));
    const bad = new Map();
    let msg = null;
    const flag = (k, why) => { if (!bad.has(k)) bad.set(k, why); if (!msg) msg = why; };
    for (const p of parts) {
      const def = getDef(p.type);
      const pins = p.worldPins();
      const allowed = new Set((def.links ? def.links(p) : []).map(([i, j]) => i < j ? `${i}-${j}` : `${j}-${i}`));
      const strips = new Map();
      for (const q of pins) {
        const k = key(q.x, q.y);
        if ((ix.pins.get(k) || []).some(o => !ids.has(o.part.id))) flag(k, 'Those holes are taken by another part.');
        const hole = ix.holes.get(k);
        if (hole) {
          const prev = strips.get(hole.strip);
          if (prev !== undefined && !allowed.has(prev < q.i ? `${prev}-${q.i}` : `${q.i}-${prev}`) && !def.allowSharedStrip) {
            const a = pins[prev].name, b = q.name;
            flag(k, def.ic ? `Pins ${prev + 1} (${a}) and ${q.i + 1} (${b}) would be shorted in one row — place the chip across the centre gap.`
              : `${a} and ${b} would be shorted together in the same row.`);
            flag(key(pins[prev].x, pins[prev].y), msg);
          } else strips.set(hole.strip, q.i);
        }
      }
      for (const s of (def.supply ? def.supply(p) : [])) {
        const q = pins[s.i];
        const why = app.supplyClash(q.x, q.y, s.kind, ids);
        if (why) flag(key(q.x, q.y), why);
      }
    }
    return { bad, msg };
  }
  liveProblemHint(parts) {
    const { msg } = this.problems(parts);
    if (msg) this.app.ui.hint('⚠︎ ' + msg);
    else if (this.mode && this.mode.kind === 'place') this.app.ui.hint('Click to place · E to rotate · Esc to cancel');
    else this.app.ui.hint(null);
  }

  // ----------------------------------------------------------------- drag --
  beginDrag() {
    const c = this.app.circuit;
    const { parts, wires, boards } = this.selected();
    const moving = new Set(parts.map(p => p.id));
    for (const b of boards) {
      const holes = new Set(b.holes().map(h => key(h.x, h.y)));
      for (const p of c.parts) if (p.worldPins().some(q => holes.has(key(q.x, q.y)))) moving.add(p.id);
      for (const w of c.wires) if (holes.has(key(w.a.x, w.a.y)) || holes.has(key(w.b.x, w.b.y))) { if (!wires.includes(w)) wires.push(w); }
    }
    const movingParts = c.parts.filter(p => moving.has(p.id));
    const wireOrig = new Map();
    const boardHoles = new Set();
    for (const b of boards) for (const h of b.holes()) boardHoles.add(key(h.x, h.y));
    for (const w of c.wires) {
      const selected = wires.includes(w);
      const endMoves = (e) => (e.pin ? moving.has(e.pin.part) : selected && (boardHoles.has(key(e.x, e.y)) || boards.length === 0 || !this.app.index.holes.has(key(e.x, e.y))));
      const am = endMoves(w.a), bm = endMoves(w.b);
      if (am || bm || selected) wireOrig.set(w, { a: { ...w.a }, b: { ...w.b }, pts: w.pts.map(p => ({ ...p })), am, bm, bends: (am && bm) || selected });
    }
    this.mode = { kind: 'drag', parts: movingParts, boards, orig: movingParts.map(p => ({ p, x: p.x, y: p.y })), borig: boards.map(b => ({ b, x: b.x, y: b.y })), wireOrig, dx: 0, dy: 0 };
    this.cursor('grabbing');
  }
  dragTo(w) {
    const m = this.mode;
    const dx = Math.round(w.x - this.downAt.wx), dy = Math.round(w.y - this.downAt.wy);
    if (dx === m.dx && dy === m.dy) return;
    m.dx = dx; m.dy = dy;
    for (const o of m.orig) { o.p.x = o.x + dx; o.p.y = o.y + dy; }
    for (const o of m.borig) { o.b.x = o.x + dx; o.b.y = o.y + dy; }
    for (const [wire, o] of m.wireOrig) {
      if (o.am) { wire.a.x = o.a.x + dx; wire.a.y = o.a.y + dy; }
      if (o.bm) { wire.b.x = o.b.x + dx; wire.b.y = o.b.y + dy; }
      if (o.bends) wire.pts = o.pts.map(p => ({ x: p.x + dx, y: p.y + dy }));
    }
    this.app.circuit.syncWires();
    this.app.reindex(true);
    if (!m.boards.length) this.liveProblemHint(m.parts);
  }
  endDrag() {
    const m = this.mode;
    this.mode = null;
    this.app.ui.hint(null);
    if (!m.dx && !m.dy) { this.app.reindex(); return; }
    const { msg } = m.boards.length ? this.problems(m.parts) : this.problems(m.parts);
    if (msg) {
      for (const o of m.orig) { o.p.x = o.x; o.p.y = o.y; }
      for (const o of m.borig) { o.b.x = o.x; o.b.y = o.y; }
      for (const [wire, o] of m.wireOrig) { wire.a = o.a; wire.b = o.b; wire.pts = o.pts; }
      this.app.circuit.syncWires();
      this.app.reindex();
      this.app.ui.toast(msg + ' Move cancelled.');
      return;
    }
    this.app.commit(m.boards.length ? 'Move board' : 'Move');
  }

  // ---------------------------------------------------------------- wires --
  wireClick() {
    const m = this.mode;
    const pt = this.pointAt(this.mx, this.my);
    if (pt) {
      if (pt.x === m.from.x && pt.y === m.from.y && !m.pts.length) { this.cancel(); return; }
      this.finishWire(pt);
      return;
    }
    m.pts.push({ x: Math.round(this.mx), y: Math.round(this.my) });
    this.app.redraw();
  }
  endFor(pt) {
    const end = { x: pt.x, y: pt.y };
    if (!pt.hole && pt.pins.length) end.pin = { part: pt.pins[0].part.id, i: pt.pins[0].i };
    return end;
  }
  autoColor(a, b) {
    if (!this.app.autoColor) return this.app.wireColor;
    const kind = (pt) => {
      if (!pt) return null;
      if (pt.hole && pt.hole.rail) return pt.hole.rail;
      for (const p of pt.pins || []) {
        const n = (p.name || '').toUpperCase();
        if (['VCC', 'VDD', '+5V', '5V', '3V3', '+'].includes(n)) return '+';
        if (['GND', 'VSS', '−'].includes(n)) return '−';
      }
      return null;
    };
    const k = kind(a) || kind(b);
    if (k === '+') return '#e5484d';
    if (k === '−') return '#2b2d31';
    return this.app.wireColor;
  }
  finishWire(pt) {
    const m = this.mode;
    const a = this.endFor(m.from), b = this.endFor(pt);
    this.mode = null;
    this.app.ui.hint(null);
    this.cursor();
    if (a.x === b.x && a.y === b.y) return;
    const why = this.app.shortReason(m.from, pt);
    if (why) { this.app.ui.toast(why); this.app.redraw(); return; }
    let pts = m.pts.filter((p, i, arr) => !(i > 0 && p.x === arr[i - 1].x && p.y === arr[i - 1].y));
    if (!pts.length && this.app.autoRoute !== this.shift) pts = route(this.app, a, b);
    this.app.circuit.wires.push(new Wire(a, b, this.autoColor(m.from, pt), pts));
    this.app.commit('Add wire');
  }
  tidyWires() {
    if (this.sim) return this.locked();
    const sel = this.selected().wires;
    const list = sel.length ? sel : this.app.circuit.wires;
    if (!list.length) return;
    tidy(this.app, list);
    this.app.commit('Tidy wires');
    this.app.ui.toast(`Tidied ${list.length} wire${list.length === 1 ? '' : 's'}`);
  }

  // ------------------------------------------------------------ placement --
  startPlace(spec) {
    this.cancel();
    if (this.sim) this.app.setMode('build');
    this.select([]);
    if (spec.board) this.mode = { kind: 'place', board: new Board(spec.board, 0, 0) };
    else this.mode = { kind: 'place', ghost: new Part(spec.type, 0, 0, 0, spec.props ? JSON.parse(JSON.stringify(spec.props)) : null, 'ghost') };
    this.app.ui.hint('Click to place · E to rotate · Esc to cancel');
    this.positionGhost();
    this.cursor();
    this.app.redraw();
  }
  positionGhost() {
    const m = this.mode;
    if (!m || m.kind !== 'place') return;
    if (m.board) { m.board.x = Math.round(this.mx - m.board.w / 2); m.board.y = Math.round(this.my - m.board.h / 2); return; }
    const g = m.ghost;
    g.x = 0; g.y = 0;
    const b = g.bounds();
    g.x = Math.round(this.mx - (b.x0 + b.x1) / 2);
    g.y = Math.round(this.my - (b.y0 + b.y1) / 2);
  }
  place(keep) {
    const m = this.mode;
    if (m.board) {
      const b = new Board(m.board.size, m.board.x, m.board.y);
      this.app.circuit.boards.push(b);
      this.mode = null;
      this.app.commit('Add breadboard');
      this.app.ui.hint(null);
      this.select([b.id]);
      return;
    }
    const { msg } = this.problems([m.ghost]);
    if (msg) { this.app.ui.toast(msg); return; }
    const g = m.ghost;
    const p = new Part(g.type, g.x, g.y, g.rot, JSON.parse(JSON.stringify(g.props)));
    this.app.circuit.parts.push(p);
    this.app.commit('Add ' + getDef(p.type).name);
    if (!keep) { this.mode = null; this.app.ui.hint(null); this.select([p.id]); }
    this.cursor();
  }
  cancel() {
    const m = this.mode;
    if (!m) return;
    if (m.kind === 'drag') this.endDrag();
    this.mode = null;
    this.app.ui.hint(null);
    this.cursor();
    this.app.redraw();
  }

  // ------------------------------------------------------------- commands --
  rotateSelection(dir = 1) {
    const m = this.mode;
    if (m && m.kind === 'place' && m.ghost) { m.ghost.rot = (m.ghost.rot + dir + 4) % 4; this.positionGhost(); this.liveProblemHint([m.ghost]); this.app.redraw(); return; }
    if (this.sim) return this.locked();
    const { parts } = this.selected();
    if (!parts.length) return;
    const before = parts.map(p => ({ p, x: p.x, y: p.y, rot: p.rot }));
    for (const p of parts) {
      const b0 = p.bounds();
      const cx = (b0.x0 + b0.x1) / 2, cy = (b0.y0 + b0.y1) / 2;
      p.rot = (p.rot + dir + 4) % 4;
      const b1 = p.bounds();
      p.x += Math.round(cx - (b1.x0 + b1.x1) / 2); p.y += Math.round(cy - (b1.y0 + b1.y1) / 2);
    }
    this.app.circuit.syncWires();
    this.app.reindex(true);
    const { msg } = this.problems(parts);
    if (msg) {
      for (const o of before) { o.p.x = o.x; o.p.y = o.y; o.p.rot = o.rot; }
      this.app.circuit.syncWires();
      this.app.reindex();
      this.app.ui.toast(msg);
      return;
    }
    this.app.commit('Rotate');
  }
  deleteSelection() {
    if (this.sim) return this.locked();
    const c = this.app.circuit, s = this.selection;
    if (!s.size) return;
    if (this.app.settings.get('confirmDelete') && !confirm(`Delete ${s.size} item${s.size > 1 ? 's' : ''}?`)) return;
    const delParts = new Set(c.parts.filter(p => s.has(p.id)).map(p => p.id));
    c.parts = c.parts.filter(p => !s.has(p.id));
    c.boards = c.boards.filter(b => !s.has(b.id));
    c.wires = c.wires.filter(w => !s.has(w.id) && !(w.a.pin && delParts.has(w.a.pin.part)) && !(w.b.pin && delParts.has(w.b.pin.part)));
    s.clear();
    this.app.commit('Delete');
  }
  copy() {
    const { parts, wires, boards } = this.selected();
    if (!parts.length && !wires.length && !boards.length) return false;
    this.clipboard = JSON.stringify({ parts: parts.map(p => p.toJSON()), wires: wires.map(w => w.toJSON()), boards: boards.map(b => b.toJSON()) });
    return true;
  }
  paste(offset = 2, inPlace = false) {
    if (!this.clipboard) return;
    if (this.sim) return this.locked();
    const o = JSON.parse(this.clipboard);
    const c = this.app.circuit;
    const idMap = new Map(), ids = [];
    for (const b of o.boards) { const nb = new Board(b.size, b.x + offset, b.y + offset * 11); c.boards.push(nb); ids.push(nb.id); }
    for (const p of o.parts) { const np = new Part(p.type, p.x + offset, p.y + offset, p.rot, p.props); idMap.set(p.id, np.id); c.parts.push(np); ids.push(np.id); }
    for (const w of o.wires) {
      const shift = (e) => { const n = { x: e.x + offset, y: e.y + offset }; if (e.pin && idMap.has(e.pin.part)) n.pin = { part: idMap.get(e.pin.part), i: e.pin.i }; return n; };
      const nw = new Wire(shift(w.a), shift(w.b), w.color, w.pts.map(p => ({ x: p.x + offset, y: p.y + offset })));
      c.wires.push(nw); ids.push(nw.id);
    }
    c.syncWires();
    if (inPlace) { this.app.reindex(); this.selection = new Set(ids); return; }
    const newParts = c.parts.filter(p => ids.includes(p.id));
    this.app.reindex();
    let tries = 0;
    while (this.problems(newParts).msg && tries++ < 30) { for (const p of newParts) { p.x += 1; p.y += 1; } c.syncWires(); this.app.reindex(); }
    this.app.commit('Paste');
    this.select(ids);
  }
  nudge(dx, dy) {
    if (this.sim) return this.locked();
    const { parts } = this.selected();
    if (!parts.length) return;
    for (const p of parts) { p.x += dx; p.y += dy; }
    this.app.circuit.syncWires();
    this.app.reindex(true);
    if (this.problems(parts).msg) { for (const p of parts) { p.x -= dx; p.y -= dy; } this.app.circuit.syncWires(); this.app.reindex(); return; }
    this.app.commit('Nudge');
  }

  key(e) {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (e.key === 'Shift') this.shift = true;
    if (mod) {
      if (k === 'z') { e.preventDefault(); e.shiftKey ? this.app.redo() : this.app.undo(); }
      else if (k === 'y') { e.preventDefault(); this.app.redo(); }
      else if (k === 'c') this.copy();
      else if (k === 'x') { if (this.copy()) this.deleteSelection(); }
      else if (k === 'v') this.paste();
      else if (k === 'd') { e.preventDefault(); if (this.copy()) this.paste(); }
      else if (k === 'a') { e.preventDefault(); const c = this.app.circuit; this.select([...c.parts, ...c.wires].map(x => x.id)); }
      else if (k === 's') { e.preventDefault(); this.app.saveFile(); }
      else if (k === 'o') { e.preventDefault(); this.app.openFile(); }
      else if (k === ',') { e.preventDefault(); this.app.ui.showSettings(); }
      else if (k === 'enter') { e.preventDefault(); this.app.setMode(this.sim ? 'build' : 'sim'); }
      else if (k === '0') { e.preventDefault(); this.app.fit(); }
      else if (k === '=' || k === '+') { e.preventDefault(); this.app.zoomBy(1.2); }
      else if (k === '-') { e.preventDefault(); this.app.zoomBy(1 / 1.2); }
      return;
    }
    if (e.altKey) return;
    if (k === 'escape') { if (this.mode) this.cancel(); else this.select([]); this.app.ui.closeMenus(); return; }
    if (k === 'backspace' || k === 'delete') {
      if (this.mode && this.mode.kind === 'wire') { if (this.mode.pts.length) this.mode.pts.pop(); else this.cancel(); this.app.redraw(); return; }
      e.preventDefault(); this.deleteSelection(); return;
    }
    if (k === 'e') { this.rotateSelection(e.shiftKey ? -1 : 1); return; }
    if (k === 't') { if (e.shiftKey) this.app.toggleAutoRoute(); else this.tidyWires(); return; }
    if (k === 'l') { this.app.ui.toggleAnalyzer(); return; }
    if (k === 'f') { this.app.fit(); return; }
    if (k === '?' || (k === '/' && e.shiftKey)) { this.app.ui.showShortcuts(); return; }
    if (k === '.') { if (this.sim) this.app.togglePause(); return; }
    if (k === 'enter') { const p = this.selected().parts[0]; if (p && getDef(p.type).mcu) this.app.ui.openCode(p); return; }
    if (k === '=' || k === '+') { this.app.zoomBy(1.2); return; }
    if (k === '-') { this.app.zoomBy(1 / 1.2); return; }
    const arrows = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, -1], arrowdown: [0, 1] };
    if (arrows[k]) { e.preventDefault(); const [dx, dy] = arrows[k], f = e.shiftKey ? 5 : 1; this.nudge(dx * f, dy * f); return; }
    if (k >= '1' && k <= '8') { this.app.setWireColor(+k - 1); return; }
    if (k in COLOR_KEYS) { this.app.setWireColor(COLOR_KEYS[k]); this.app.ui.toast(`${WIRE_COLORS[COLOR_KEYS[k]].name} wire`); }
  }

  context(e) {
    const w = this.toWorld(e.clientX, e.clientY);
    if (this.mode && this.mode.kind === 'wire') { this.mode.pts.push({ x: Math.round(w.x), y: Math.round(w.y) }); this.app.redraw(); return; }
    if (this.mode) { this.cancel(); return; }
    const items = [];
    const pt = this.pointAt(w.x, w.y);
    const part = this.topPartAt(w.x, w.y);
    const hw = !part && this.wireAt(w.x, w.y);
    const board = !part && !hw && this.boardAt(w.x, w.y);
    if (part && !this.selection.has(part.id)) this.select([part.id]);
    else if (hw && !this.selection.has(hw.wire.id)) this.select([hw.wire.id]);
    else if (board && !this.selection.has(board.id)) this.select([board.id]);
    if (pt) items.push({ label: 'Add Probe to Analyzer', action: () => this.app.addProbe(pt.x, pt.y) });
    if (part && getDef(part.type).mcu) items.push({ label: 'Edit Code…', key: '↵', action: () => this.app.ui.openCode(part) });
    if (this.selection.size && !this.sim) {
      if (items.length) items.push('-');
      const { wires, boards } = this.selected();
      if (wires.length) items.push({ label: 'Tidy Wire' + (wires.length > 1 ? 's' : ''), key: 'T', action: () => this.tidyWires() });
      if (!boards.length) items.push({ label: 'Rotate', key: 'E', action: () => this.rotateSelection() });
      items.push({ label: 'Duplicate', key: '⌘D', action: () => { this.copy(); this.paste(); } });
      items.push({ label: 'Copy', key: '⌘C', action: () => this.copy() });
      items.push('-');
      items.push({ label: 'Delete' + (boards.length ? ' Board' : ''), key: '⌫', danger: true, action: () => this.deleteSelection() });
    } else if (!this.sim) {
      if (this.clipboard) items.push({ label: 'Paste', key: '⌘V', action: () => this.paste() });
      if (this.app.circuit.wires.length) items.push({ label: 'Tidy All Wires', key: 'T', action: () => this.tidyWires() });
    }
    if (items.length) this.app.ui.menu(items, e.clientX, e.clientY);
  }

  // -------------------------------------------------------------- overlay --
  drawOverlay(g, env) {
    const m = this.mode;
    const R = this.app.renderer;
    const z = this.app.cam.z;
    if (!this.sim) for (const id of this.selection) {
      const wire = this.app.circuit.wires.find(x => x.id === id);
      if (!wire) continue;
      for (const p of wire.path()) {
        g.fillStyle = '#fff'; g.strokeStyle = R.accent; g.lineWidth = 1.6 / z;
        g.beginPath(); g.arc(p.x * P, p.y * P, 4.5 / Math.min(z, 1.5), 0, TAU); g.fill(); g.stroke();
      }
    }
    if (m && m.kind === 'wire') {
      const end = this.hover ? { x: this.hover.x, y: this.hover.y } : { x: this.mx, y: this.my };
      let pts = [m.from, ...m.pts, end];
      if (!m.pts.length && this.hover && this.app.autoRoute !== this.shift) pts = [m.from, ...route(this.app, m.from, end), end];
      R.drawWire(pts, this.autoColor(m.from, this.hover), false, null, 0.75);
    }
    if (m && m.kind === 'place') {
      if (m.board) { g.globalAlpha = 0.6; R.drawBoard(m.board, env.dark, true, -1); g.globalAlpha = 1; }
      else { g.globalAlpha = 0.75; env.dev = null; R.drawPart(m.ghost, env, false); g.globalAlpha = 1; this.drawLanding(g, [m.ghost]); }
    }
    if (m && m.kind === 'drag' && this.app.settings.get('landingMarks')) this.drawLanding(g, m.parts);
    if (m && m.kind === 'marquee') {
      const x = Math.min(m.x0, m.x1) * P, y = Math.min(m.y0, m.y1) * P;
      const w = Math.abs(m.x1 - m.x0) * P, h = Math.abs(m.y1 - m.y0) * P;
      g.fillStyle = R.accentA(0.08); g.strokeStyle = R.accentA(0.8); g.lineWidth = 1 / z;
      g.beginPath(); g.roundRect(x, y, w, h, 3 / z); g.fill(); g.stroke();
    }
    if (!m && this.hoverPart && this.app.settings.get('pinHalo')) this.drawPinHalo(g, this.hoverPart);
    if (this.hover && (!m || m.kind === 'wire' || m.kind === 'wireEnd')) {
      g.strokeStyle = R.accent; g.lineWidth = 2 / Math.max(z, 1);
      g.beginPath(); g.arc(this.hover.x * P, this.hover.y * P, 6.5, 0, TAU); g.stroke();
    }
  }
  /** Pin names around a hovered chip, in constant screen size so they stay readable. */
  drawPinHalo(g, part) {
    const z = this.app.cam.z;
    const b = part.bounds();
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    const fs = 10.5 / z;
    g.font = `600 ${fs}px "SF Mono", ui-monospace, Menlo, monospace`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    for (const q of part.worldPins()) {
      const dx = q.x - cx, dy = q.y - cy;
      const horiz = Math.abs(dx) / (b.x1 - b.x0) > Math.abs(dy) / (b.y1 - b.y0);
      const off = 0.75 + 0.35 / z;
      const tx = (q.x + (horiz ? Math.sign(dx) * off * 1.4 : 0)) * P;
      const ty = (q.y + (horiz ? 0 : Math.sign(dy) * off)) * P;
      const label = `${q.i + 1} ${q.name}`;
      const tw = g.measureText(label).width + 8 / z, th = fs + 5 / z;
      g.save();
      if (!horiz) { g.translate(tx, ty); g.rotate(-Math.PI / 2); g.translate(-tx, -ty); }
      const n = /^(VCC|VDD)$/.test(q.name) ? '#e5484d' : /^(GND|VSS)$/.test(q.name) ? '#1d1d1f' : 'rgba(29,29,31,0.88)';
      g.fillStyle = n;
      g.beginPath(); g.roundRect(tx - tw / 2, ty - th / 2, tw, th, 4 / z); g.fill();
      g.fillStyle = '#fff'; g.fillText(label, tx, ty + 0.5 / z);
      g.restore();
    }
  }
  drawLanding(g, parts) {
    const ix = this.app.index;
    const { bad } = this.problems(parts);
    for (const p of parts) {
      for (const q of p.worldPins()) {
        const k = key(q.x, q.y);
        g.fillStyle = bad.has(k) ? '#ff3b30' : ix.holes.has(k) ? '#34c759' : 'rgba(142,142,147,0.9)';
        g.beginPath(); g.arc(q.x * P, q.y * P, 3.6, 0, TAU); g.fill();
      }
    }
  }
}

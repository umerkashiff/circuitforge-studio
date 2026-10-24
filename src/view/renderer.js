import { P, ROW_LETTERS } from '../model.js';
import { getDef } from '../parts/registry.js';

const TAU = Math.PI * 2;

export const WIRE_COLORS = [
  { name: 'Red', hex: '#e5484d' }, { name: 'Black', hex: '#2b2d31' }, { name: 'Blue', hex: '#0a84ff' },
  { name: 'Green', hex: '#30a46c' }, { name: 'Yellow', hex: '#f5c400' }, { name: 'Orange', hex: '#ff8a00' },
  { name: 'Purple', hex: '#8e4ec6' }, { name: 'White', hex: '#f2f2f7' },
];

function shadeHex(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [n >> 16, (n >> 8) & 255, n & 255].map(c => Math.round(f < 0 ? c * (1 + f) : c + (255 - c) * f));
  return `rgb(${ch.join(',')})`;
}

export class Renderer {
  constructor(app, canvas) {
    this.app = app;
    this.cv = canvas;
    this.g = canvas.getContext('2d');
    this.dpr = 1;
  }

  resize() {
    const r = this.cv.parentElement.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.w = r.width; this.h = r.height;
    this.cv.width = Math.round(r.width * this.dpr);
    this.cv.height = Math.round(r.height * this.dpr);
    this.cv.style.width = r.width + 'px';
    this.cv.style.height = r.height + 'px';
  }

  get accent() { return this.app.settings.get('accent'); }
  accentA(a) { const n = parseInt(this.accent.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; }
  get theme() { return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'; }

  draw() {
    const { g, app } = this;
    const cam = app.cam, dark = this.theme === 'dark';
    const css = getComputedStyle(document.documentElement);
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = css.getPropertyValue('--canvas').trim() || '#f2f2f4';
    g.fillRect(0, 0, this.w, this.h);
    this.drawGrid(dark);

    g.setTransform(this.dpr * cam.z, 0, 0, this.dpr * cam.z, this.dpr * cam.x, this.dpr * cam.y);
    const c = app.circuit, ed = app.editor, sim = app.engine;
    const hoverNet = ed.hoverNet;
    for (const b of c.boards) this.drawBoard(b, dark, ed.selection.has(b.id), hoverNet);
    if (hoverNet >= 0) this.drawNetHighlight(hoverNet);

    const live = app.mode === 'sim';
    const env = { rot: 0, dev: null, dark, showPinLabels: cam.z > 1.25, chipText: app.settings.get('chipText') };
    for (const p of c.parts) {
      const entry = sim.byPart.get(p.id);
      env.dev = live && entry ? entry.device : null;
      this.drawPart(p, env, ed.selection.has(p.id));
    }
    for (const w of c.wires) this.drawWire(w.path(), w.color, ed.selection.has(w.id), w);
    this.drawWarnings();
    this.drawEffects();
    ed.drawOverlay(g, env);
  }

  drawEffects() {
    const g = this.g, now = performance.now();
    for (const f of this.app.effects) {
      const t = (now - f.t0) / 1000;
      const x = f.x * P, y = f.y * P;
      if (t < 0.25) { // flash
        const r = 10 + t * 160;
        const gr = g.createRadialGradient(x, y, 0, x, y, r);
        gr.addColorStop(0, `rgba(255,220,120,${0.9 * (1 - t / 0.25)})`); gr.addColorStop(1, 'rgba(255,120,40,0)');
        g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      }
      for (let i = 0; i < 9; i++) { // smoke puffs drifting up
        const k = t - i * 0.12;
        if (k < 0 || k > 2.6) continue;
        const px = x + Math.sin(i * 2.3 + k * 2) * (6 + k * 8), py = y - k * 38 - i * 2;
        const r = 5 + k * 9;
        g.fillStyle = `rgba(110,110,115,${0.38 * (1 - k / 2.6)})`;
        g.beginPath(); g.arc(px, py, r, 0, Math.PI * 2); g.fill();
      }
    }
  }

  drawGrid(dark) {
    const { g, app } = this;
    const s = P * app.cam.z;
    const mode = app.settings.get('canvas');
    if (s < 7 || mode === 'plain') return;
    if (mode === 'grid') {
      g.strokeStyle = dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'; g.lineWidth = 1;
      const gx = ((app.cam.x % s) + s) % s, gy = ((app.cam.y % s) + s) % s;
      g.beginPath();
      for (let x = gx; x < this.w; x += s) { g.moveTo(Math.round(x) + 0.5, 0); g.lineTo(Math.round(x) + 0.5, this.h); }
      for (let y = gy; y < this.h; y += s) { g.moveTo(0, Math.round(y) + 0.5); g.lineTo(this.w, Math.round(y) + 0.5); }
      g.stroke();
      return;
    }
    g.fillStyle = dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.07)';
    const ox = ((app.cam.x % s) + s) % s, oy = ((app.cam.y % s) + s) % s;
    const r = Math.min(1.2, s / 16);
    for (let x = ox; x < this.w; x += s) for (let y = oy; y < this.h; y += s) g.fillRect(x - r / 2, y - r / 2, r, r);
  }

  drawBoard(b, dark, selected, hoverNet) {
    const g = this.g;
    const x = b.x * P, y = b.y * P, w = b.w * P, h = b.h * P;
    g.save();
    g.shadowColor = 'rgba(20,25,35,0.16)'; g.shadowBlur = 24; g.shadowOffsetY = 8;
    g.beginPath(); g.roundRect(x, y, w, h, 10);
    const bc = this.app.settings.get('boardColor');
    const blackBoard = bc === '#2a2c31';
    g.fillStyle = bc === '#fbfbfc' && dark ? '#e9e9ec' : bc; g.fill();
    g.restore();
    g.strokeStyle = selected ? this.accent : 'rgba(0,0,0,0.08)'; g.lineWidth = selected ? 2 : 1;
    g.beginPath(); g.roundRect(x, y, w, h, 10); g.stroke();

    // centre channel
    const cy = (b.y + b.rowY(4) + 1.5) * P;
    g.fillStyle = blackBoard ? '#1f2024' : 'rgba(0,0,0,0.055)';
    g.fillRect(x + 6, cy - P * 0.55, w - 12, P * 1.1);

    // rails
    const ry = b.railY();
    const hx0 = (b.x + 1.5) * P, hx1 = (b.x + b.cols + 1.5) * P;
    if (ry) {
      for (const [k, yy] of Object.entries(ry)) {
        const pos = k[1] === 'p';
        const lineY = (b.y + yy + (k[0] === 't' ? (pos ? -0.62 : 0.62) : (pos ? -0.62 : 0.62))) * P;
        g.strokeStyle = pos ? 'rgba(229,72,77,0.75)' : 'rgba(10,132,255,0.75)';
        g.lineWidth = 1.6;
        g.beginPath(); g.moveTo(hx0, lineY); g.lineTo(hx1, lineY); g.stroke();
        g.font = `700 11px -apple-system, "SF Pro Text", Inter, sans-serif`;
        g.fillStyle = pos ? '#d93036' : '#0a6fdf'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(pos ? '+' : '−', x + P * 0.8, (b.y + yy) * P);
        g.fillText(pos ? '+' : '−', x + w - P * 0.8, (b.y + yy) * P);
      }
    }
    // labels
    g.font = `600 8.5px "SF Mono", ui-monospace, Menlo, monospace`;
    g.fillStyle = '#9a9aa2'; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let r = 0; r < 10; r++) {
      const yy = (b.y + b.rowY(r)) * P;
      g.fillText(ROW_LETTERS[r], x + P * 0.85, yy);
      g.fillText(ROW_LETTERS[r], x + w - P * 0.85, yy);
    }
    for (let c = 0; c < b.cols; c++) {
      if (c !== 0 && (c + 1) % 5) continue;
      const xx = (b.x + 2 + c) * P;
      g.fillText(String(c + 1), xx, (b.y + b.rowY(0) - 0.85) * P);
      g.fillText(String(c + 1), xx, (b.y + b.rowY(9) + 0.85) * P);
    }
    if (this.app.mode === 'sim' && this.app.settings.get('wireStyle') !== 'off') this.tintLiveStrips(b);
    // holes
    const sim = this.app.engine;
    const running = this.app.running;
    for (const hole of b.holes()) {
      const hx = hole.x * P, hy = hole.y * P;
      g.fillStyle = blackBoard ? '#55575e' : dark ? '#3a3b40' : '#4a4c52';
      g.fillRect(hx - 2.6, hy - 2.6, 5.2, 5.2);
      g.fillStyle = blackBoard ? '#0b0b0c' : dark ? '#16171a' : '#26282c';
      g.fillRect(hx - 1.8, hy - 1.6, 3.6, 3.6);
    }
    // grip handle (drag the whole board from here)
    const gx = x + 8, gy = y + 8;
    g.fillStyle = selected ? this.accent : '#c7c7cc';
    for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) {
      g.beginPath(); g.arc(gx + j * 5, gy + i * 5, 1.4, 0, TAU); g.fill();
    }
  }

  drawNetHighlight(net) {
    const g = this.g, sim = this.app.engine;
    g.fillStyle = this.accentA(0.22);
    for (const [k, n] of sim.pointNet) {
      if (n !== net) continue;
      const [x, y] = k.split(',').map(Number);
      g.beginPath(); g.arc(x * P, y * P, 6, 0, TAU); g.fill();
    }
  }

  drawPart(p, env, selected) {
    const g = this.g, def = getDef(p.type);
    g.save();
    g.translate(p.x * P, p.y * P);
    g.rotate(p.rot * Math.PI / 2);
    env.rot = p.rot;
    try { def.draw(g, p, env); } catch (e) { console.error(e); }
    g.restore();
    if (selected) {
      const bb = p.bounds();
      g.save();
      g.strokeStyle = this.accent; g.lineWidth = 1.5 / this.app.cam.z;
      g.setLineDash([]);
      g.beginPath(); g.roundRect(bb.x0 * P - 4, bb.y0 * P - 4, (bb.x1 - bb.x0) * P + 8, (bb.y1 - bb.y0) * P + 8, 6); g.stroke();
      g.fillStyle = this.accentA(0.06); g.fill();
      g.restore();
    }
  }

  /** Jumper wire with rounded bends, shading and metal tips. */
  drawWire(pts, color, selected, wire, alpha = 1) {
    const g = this.g;
    if (pts.length < 2) return;
    g.save();
    g.globalAlpha = alpha;
    g.lineCap = 'round'; g.lineJoin = 'round';
    const path = () => {
      g.beginPath();
      g.moveTo(pts[0].x * P, pts[0].y * P);
      for (let i = 1; i < pts.length - 1; i++) {
        const a = pts[i - 1], b = pts[i], c = pts[i + 1];
        const r = Math.min(8, Math.hypot(b.x - a.x, b.y - a.y) * P / 2, Math.hypot(c.x - b.x, c.y - b.y) * P / 2);
        g.arcTo(b.x * P, b.y * P, c.x * P, c.y * P, Math.max(0.5, r));
      }
      g.lineTo(pts[pts.length - 1].x * P, pts[pts.length - 1].y * P);
    };
    const sim = this.app.engine;
    const ww = this.app.settings.get('wireWidth');
    const style = wire && this.app.mode === 'sim' ? this.app.settings.get('wireStyle') : 'off';
    let state = null;
    if (style !== 'off') {
      const v = sim.voltage(sim.netAt(pts[0].x, pts[0].y));
      state = Number.isNaN(v) ? 'float' : v >= 2 ? 'high' : v <= 0.8 ? 'low' : 'mid';
    }
    if (style === 'recolor') {
      // Paint the wire by its electrical state; the jumper colour stays as a thin edge.
      const STATE = { high: '#ff453a', low: '#0a84ff', mid: '#ff9f0a', float: '#8e8e93' };
      if (state === 'float') g.globalAlpha = alpha * 0.45;
      path();
      if (selected) { g.strokeStyle = this.accentA(0.35); g.lineWidth = 12 * ww; g.stroke(); }
      if (state === 'high' || state === 'mid') {
        const a = state === 'mid' ? 0.3 + 0.25 * Math.sin(performance.now() / 120) : 0.3;   // in-between pulses: two outputs fighting
        g.strokeStyle = state === 'high' ? `rgba(255,69,58,${a})` : `rgba(255,159,10,${a})`; g.lineWidth = 11 * ww; g.stroke();
      }
      g.strokeStyle = color; g.lineWidth = 6.5 * ww; g.stroke();
      g.strokeStyle = STATE[state]; g.lineWidth = 4 * ww; g.stroke();
      if (state === 'float') { g.strokeStyle = 'rgba(255,255,255,0.95)'; g.lineWidth = 1.4; g.setLineDash([3, 4]); path(); g.stroke(); g.setLineDash([]); }
      else { g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 1.1; g.save(); g.translate(-0.6, -0.9); path(); g.stroke(); g.restore(); }
      this.drawWireEnds(pts, state, alpha);
      g.restore();
      return;
    }
    if (state === 'float') g.globalAlpha = alpha * 0.4;
    path();
    if (selected) { g.strokeStyle = this.accentA(0.35); g.lineWidth = 11 * ww; g.stroke(); }
    if (state === 'high' || state === 'mid') {
      g.strokeStyle = state === 'high' ? 'rgba(255,69,58,0.32)' : 'rgba(255,159,10,0.45)'; g.lineWidth = 10 * ww; g.stroke();
    }
    g.shadowColor = 'rgba(0,0,0,0.25)'; g.shadowBlur = 4; g.shadowOffsetY = 2;
    g.strokeStyle = shadeHex(color, -0.35); g.lineWidth = 5.4 * ww; g.stroke();
    g.shadowColor = 'transparent';
    g.strokeStyle = color; g.lineWidth = 4 * ww; g.stroke();
    if (state && state !== 'float') {
      g.strokeStyle = state === 'high' ? '#ff6b61' : state === 'low' ? '#64d2ff' : '#ffb340'; g.lineWidth = 1.6;
      g.setLineDash(state === 'mid' ? [3, 3] : []); path(); g.stroke(); g.setLineDash([]);
    } else if (state === 'float') {
      g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 1.4; g.setLineDash([2, 4]); path(); g.stroke(); g.setLineDash([]);
    } else {
      g.strokeStyle = 'rgba(255,255,255,0.33)'; g.lineWidth = 1.2;
      g.save(); g.translate(-0.6, -0.9); path(); g.stroke(); g.restore();
    }

    this.drawWireEnds(pts, state, alpha);
    g.restore();
  }

  /** Metal tips, plus a "no power" badge on floating wires in Simulate mode. */
  drawWireEnds(pts, state, alpha) {
    const g = this.g;
    for (const e of [pts[0], pts[pts.length - 1]]) {
      g.fillStyle = '#aeb4bd';
      g.beginPath(); g.arc(e.x * P, e.y * P, 2.8, 0, TAU); g.fill();
    }
    if (state === 'float') {
      const m = Math.floor((pts.length - 1) / 2);
      const x = ((pts[m].x + pts[m + 1].x) / 2) * P, y = ((pts[m].y + pts[m + 1].y) / 2) * P;
      g.globalAlpha = alpha;
      g.fillStyle = '#8e8e93'; g.beginPath(); g.arc(x, y, 6.5, 0, TAU); g.fill();
      g.fillStyle = '#fff'; g.font = '700 9px -apple-system, Inter, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('∅', x, y + 0.5);
    }
  }

  /** Faint red/blue band behind every breadboard strip that belongs to a live net. */
  tintLiveStrips(b) {
    const g = this.g, sim = this.app.engine;
    const strips = new Map();
    for (const h of b.holes()) {
      const s = strips.get(h.strip);
      if (!s) strips.set(h.strip, { x0: h.x, y0: h.y, x1: h.x, y1: h.y });
      else { s.x0 = Math.min(s.x0, h.x); s.x1 = Math.max(s.x1, h.x); s.y0 = Math.min(s.y0, h.y); s.y1 = Math.max(s.y1, h.y); }
    }
    for (const s of strips.values()) {
      const v = sim.voltage(sim.netAt(s.x0, s.y0));
      if (Number.isNaN(v)) continue;
      g.fillStyle = v >= 2 ? 'rgba(255,69,58,0.11)' : v <= 0.8 ? 'rgba(10,132,255,0.09)' : 'rgba(255,159,10,0.14)';
      g.beginPath(); g.roundRect((s.x0 - 0.42) * P, (s.y0 - 0.42) * P, (s.x1 - s.x0 + 0.84) * P, (s.y1 - s.y0 + 0.84) * P, 5); g.fill();
    }
  }

  drawWarnings() {
    const g = this.g, z = this.app.cam.z;
    const seen = new Set();
    const badge = (x, y, color) => {
      const r = 7 / Math.min(1, z);
      g.fillStyle = color; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
      g.strokeStyle = '#fff'; g.lineWidth = 1.5 / Math.min(1, z); g.stroke();
      g.fillStyle = '#fff'; g.font = `800 ${10 / Math.min(1, z)}px -apple-system, Inter, sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('!', x, y + 0.5);
    };
    for (const w of this.app.allIssues()) {
      if (w.level === 'note') continue;
      const color = w.level === 'error' ? '#ff3b30' : '#ff9f0a';
      if (w.part) {
        const k = w.part.id + w.level; if (seen.has(k)) continue; seen.add(k);
        const bb = w.part.bounds();
        badge(bb.x1 * P, bb.y0 * P, color);
      } else if (w.wire) {
        const pts = w.wire.path(), m = Math.floor((pts.length - 1) / 2);
        badge((pts[m].x + pts[m + 1].x) / 2 * P, (pts[m].y + pts[m + 1].y) / 2 * P, color);
      }
    }
  }
}

/**
 * Orthogonal wire router (A* on a half-pitch lattice).
 *
 * Wires prefer the channels *between* breadboard holes, avoid part bodies and
 * other parts' pins, avoid running on top of other wires, and keep the number
 * of bends low. Returns the bend points between the two endpoints.
 */
import { key } from './engine.js';

const STEP = 1, TURN = 2.2, HOLE = 0.7, BODY = 40, PIN = 25, OVERLAP = 9, CROSS = 1.2;
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];

class Heap {
  constructor() { this.a = []; }
  push(n, f) {
    const a = this.a; a.push([f, n]);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top[1];
  }
  get size() { return this.a.length; }
}

/** Lattice-edge keys used by a polyline (coordinates in half-pitch units). */
function rasterize(pts, edges, nodes) {
  for (let k = 0; k < pts.length - 1; k++) {
    let x = Math.round(pts[k].x * 2), y = Math.round(pts[k].y * 2);
    const x1 = Math.round(pts[k + 1].x * 2), y1 = Math.round(pts[k + 1].y * 2);
    if (x !== x1 && y !== y1) continue; // diagonal jumpers don't block lanes
    const dx = Math.sign(x1 - x), dy = Math.sign(y1 - y);
    while (x !== x1 || y !== y1) {
      const nx = x + dx, ny = y + dy;
      edges.add(x < nx || y < ny ? `${x},${y},${nx},${ny}` : `${nx},${ny},${x},${y}`);
      nodes.add(`${x},${y}`);
      x = nx; y = ny;
    }
    nodes.add(`${x},${y}`);
  }
}

export function route(app, a, b, ignoreWire = null, others = null) {
  const c = app.circuit;
  const ax = Math.round(a.x * 2), ay = Math.round(a.y * 2), bx = Math.round(b.x * 2), by = Math.round(b.y * 2);
  const M = 14;
  const x0 = Math.min(ax, bx) - M, x1 = Math.max(ax, bx) + M, y0 = Math.min(ay, by) - M, y1 = Math.max(ay, by) + M;
  const W = x1 - x0 + 1, H = y1 - y0 + 1;
  const cost = new Float32Array(W * H);
  const at = (x, y) => (y - y0) * W + (x - x0);

  // part bodies
  for (const p of c.parts) {
    const bb = p.bounds();
    const sx0 = Math.ceil((bb.x0 + 0.2) * 2), sx1 = Math.floor((bb.x1 - 0.2) * 2);
    const sy0 = Math.ceil((bb.y0 + 0.2) * 2), sy1 = Math.floor((bb.y1 - 0.2) * 2);
    for (let y = Math.max(sy0, y0); y <= Math.min(sy1, y1); y++) for (let x = Math.max(sx0, x0); x <= Math.min(sx1, x1); x++) cost[at(x, y)] += BODY;
    for (const q of p.worldPins()) {
      const qx = q.x * 2, qy = q.y * 2;
      if (qx >= x0 && qx <= x1 && qy >= y0 && qy <= y1) cost[at(qx, qy)] += PIN;
    }
  }
  // holes: prefer the channels between them
  for (const [k] of app.index.holes) {
    const [hx, hy] = k.split(',').map(Number);
    const X = hx * 2, Y = hy * 2;
    if (X >= x0 && X <= x1 && Y >= y0 && Y <= y1) cost[at(X, Y)] += HOLE;
  }
  // other wires
  const edges = new Set(), nodes = new Set();
  for (const w of others || c.wires) if (w !== ignoreWire) rasterize(w.path(), edges, nodes);

  cost[at(ax, ay)] = 0; cost[at(bx, by)] = 0;

  // A* over (cell, incoming direction)
  const N = W * H * 5;
  const g = new Float32Array(N).fill(Infinity);
  const from = new Int32Array(N).fill(-1);
  const heap = new Heap();
  const s0 = at(ax, ay) * 5 + 4;
  g[s0] = 0;
  heap.push(s0, Math.abs(ax - bx) + Math.abs(ay - by));
  const goal = at(bx, by);
  let end = -1, guard = 0;
  while (heap.size && guard++ < 200000) {
    const s = heap.pop();
    const cell = (s / 5) | 0, d = s % 5;
    if (cell === goal) { end = s; break; }
    const cx = (cell % W) + x0, cy = ((cell / W) | 0) + y0;
    for (let nd = 0; nd < 4; nd++) {
      if (d !== 4 && (nd + 2) % 4 === d) continue; // no U-turns
      const nx = cx + DIRS[nd][0], ny = cy + DIRS[nd][1];
      if (nx < x0 || nx > x1 || ny < y0 || ny > y1) continue;
      const nc = at(nx, ny);
      const ek = cx < nx || cy < ny ? `${cx},${cy},${nx},${ny}` : `${nx},${ny},${cx},${cy}`;
      let step = STEP + cost[nc] + (d !== 4 && d !== nd ? TURN : 0);
      if (edges.has(ek)) step += OVERLAP;
      else if (nodes.has(`${nx},${ny}`)) step += CROSS;
      const ns = nc * 5 + nd;
      const ng = g[s] + step;
      if (ng < g[ns]) {
        g[ns] = ng; from[ns] = s;
        heap.push(ns, ng + Math.abs(nx - bx) + Math.abs(ny - by));
      }
    }
  }
  if (end < 0) return [];
  // walk back and keep only the corners
  const cells = [];
  for (let s = end; s >= 0; s = from[s]) cells.push((s / 5) | 0);
  cells.reverse();
  const pts = cells.map(cell => ({ x: ((cell % W) + x0) / 2, y: (((cell / W) | 0) + y0) / 2 }));
  const out = [];
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i - 1], q = pts[i], r = pts[i + 1];
    if ((q.x - p.x) * (r.y - q.y) !== (q.y - p.y) * (r.x - q.x)) out.push(q);
  }
  return out;
}

/** Re-route wires one by one (shortest first) so later wires avoid earlier ones. */
export function tidy(app, wires) {
  const len = (w) => Math.abs(w.a.x - w.b.x) + Math.abs(w.a.y - w.b.y);
  const list = [...wires].sort((p, q) => len(p) - len(q));
  const placed = app.circuit.wires.filter(w => !list.includes(w));
  for (const w of list) {
    w.pts = route(app, w.a, w.b, w, placed);
    placed.push(w);
  }
}

export { key };

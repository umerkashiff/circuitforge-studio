/**
 * Circuit engine.
 *
 * Connectivity: every connectable thing (breadboard hole, part pin, wire end)
 * sits on an integer grid point. Points are merged into nets with union-find:
 * board strips join their holes, wires join their two ends, parts may join
 * pins internally (closed switches, common pins).
 *
 * Electrical solve: each net is a node in a nodal-analysis system. Devices
 * stamp conductances, current sources and Norton voltage sources (to the
 * implicit 0 V ground reference). The system is split into independent
 * islands and each island is solved with dense Gaussian elimination, which
 * keeps every solve tiny. Digital parts read net voltages through logic
 * thresholds and drive their outputs back as Norton sources; the loop repeats
 * until nothing changes.
 */

import { getDef } from '../parts/registry.js';

export const LEAK = 1e-9;          // tiny conductance to ground on every node
const EDGE_MIN = 1e-7;             // conductances above this count as "connected"
const MAX_ITERS = 24;

class UnionFind {
  constructor() { this.p = new Map(); }
  find(a) {
    const p = this.p;
    if (!p.has(a)) { p.set(a, a); return a; }
    let r = a;
    while (p.get(r) !== r) r = p.get(r);
    while (p.get(a) !== r) { const n = p.get(a); p.set(a, r); a = n; }
    return r;
  }
  union(a, b) {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.p.set(rb, ra);
  }
}

export const key = (x, y) => x + ',' + y;

/** Stamp collector handed to devices. Net index -1 means "not connected". */
class Stamps {
  constructor() { this.reset(); }
  reset() {
    this.g = [];      // [a, b, g]   conductance between nets (b = -2 for ground)
    this.i = [];      // [a, b, i]   current i flowing a -> b through the device
    this.anchors = [];
    this.roots = [];  // nets directly tied to a voltage source
  }
  G(a, b, g) { if (a >= 0 && b >= 0 && a !== b) this.g.push(a, b, g); }
  I(a, b, i) { if (a >= 0 || b >= 0) this.i.push(a, b, i); }
  /** Norton source from ground: drives net a towards V through resistance R. */
  src(a, V, R) {
    if (a < 0) return;
    const g = 1 / R;
    this.g.push(a, -2, g);
    this.i.push(-2, a, V * g);
    this.roots.push(a);
  }
  /** Two-terminal source (battery, diode drop): Va - Vb -> V through R. */
  vdrop(a, b, V, R) {
    const g = 1 / R;
    this.G(a, b, g);
    this.I(a, b, -V * g);
  }
  anchor(a) { if (a >= 0) this.anchors.push(a); }
}

function gaussSolve(A, z, n) {
  for (let c = 0; c < n; c++) {
    let piv = c, best = Math.abs(A[c * n + c]);
    for (let r = c + 1; r < n; r++) {
      const v = Math.abs(A[r * n + c]);
      if (v > best) { best = v; piv = r; }
    }
    if (best < 1e-300) continue;
    if (piv !== c) {
      for (let k = 0; k < n; k++) {
        const t = A[c * n + k]; A[c * n + k] = A[piv * n + k]; A[piv * n + k] = t;
      }
      const t = z[c]; z[c] = z[piv]; z[piv] = t;
    }
    const d = A[c * n + c];
    for (let r = c + 1; r < n; r++) {
      const f = A[r * n + c] / d;
      if (f === 0) continue;
      for (let k = c; k < n; k++) A[r * n + k] -= f * A[c * n + k];
      z[r] -= f * z[c];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = z[r];
    for (let k = r + 1; k < n; k++) s -= A[r * n + k] * x[k];
    const d = A[r * n + r];
    x[r] = Math.abs(d) < 1e-300 ? 0 : s / d;
  }
  return x;
}

export class Engine {
  constructor() {
    this.time = 0;
    this.nets = 0;
    this.V = new Float64Array(0);
    this.defined = new Uint8Array(0);
    this.pointNet = new Map();     // point key -> net index
    this.devices = [];
    this.byPart = new Map();       // part id -> { device, pinNets }
    this.warnings = [];
    this.timeDependent = false;
    this.S = new Stamps();
    this.converged = true;
  }

  /** Rebuild nets and devices from the circuit. Keeps per-part sim state. */
  build(circuit) {
    const uf = new UnionFind();
    const prevState = new Map();
    for (const [id, e] of this.byPart) if (e.device) prevState.set(id, e.device);

    for (const b of circuit.boards) {
      for (const h of b.holes()) uf.union(key(h.x, h.y), h.strip);
    }
    for (const w of circuit.wires) uf.union(key(w.a.x, w.a.y), key(w.b.x, w.b.y));

    const partPins = [];
    for (const p of circuit.parts) {
      const def = getDef(p.type);
      const pins = p.worldPins();
      partPins.push([p, def, pins]);
      for (const pin of pins) uf.find(key(pin.x, pin.y));
      const links = def.links ? def.links(p) : null;
      if (links) for (const [i, j] of links) uf.union(key(pins[i].x, pins[i].y), key(pins[j].x, pins[j].y));
    }

    // Number nets for every point that matters (pins, wire ends, holes).
    const rootIdx = new Map();
    const pointNet = new Map();
    const idxOf = (k) => {
      const r = uf.find(k);
      let n = rootIdx.get(r);
      if (n === undefined) { n = rootIdx.size; rootIdx.set(r, n); }
      pointNet.set(k, n);
      return n;
    };
    for (const b of circuit.boards) for (const h of b.holes()) idxOf(key(h.x, h.y));
    for (const w of circuit.wires) { idxOf(key(w.a.x, w.a.y)); idxOf(key(w.b.x, w.b.y)); }

    this.devices = [];
    this.byPart = new Map();
    this.timeDependent = false;
    this.resistorNets = new Set();   // nets touching a resistor — lets LEDs tell "no resistor" from "resistor too small"
    for (const [p, def, pins] of partPins) {
      const pinNets = pins.map(pin => idxOf(key(pin.x, pin.y)));
      if (p.type === 'resistor' || p.type === 'pot') for (const n of pinNets) this.resistorNets.add(n);
      let device = null;
      if (def.device) {
        device = def.device(p, pinNets);
        const old = prevState.get(p.id);
        if (old && old.type === p.type && device.adopt) device.adopt(old);
        device.type = p.type;
        device.part = p;
        if (device.timeDependent) this.timeDependent = true;
        this.devices.push(device);
      }
      this.byPart.set(p.id, { device, pinNets });
    }

    this.pointNet = pointNet;
    this.nets = rootIdx.size;
    const oldV = this.V;
    this.V = new Float64Array(this.nets).fill(NaN);
    this.defined = new Uint8Array(this.nets);
    if (oldV.length === this.V.length) this.V.set(oldV);
  }

  netAt(x, y) {
    const n = this.pointNet.get(key(x, y));
    return n === undefined ? -1 : n;
  }

  voltage(net) { return net >= 0 ? this.V[net] : NaN; }

  reset() {
    this.time = 0;
    for (const d of this.devices) if (d.reset) d.reset();
    this.V.fill(NaN);
  }

  solve() {
    const S = this.S;
    S.reset();
    const V = this.V;
    for (const d of this.devices) if (d.stamp) d.stamp(S, V, this);

    const n = this.nets;
    // Total conductance at each net; capacitors use it to estimate their RC time constant.
    const gsum = new Float64Array(n);
    for (let k = 0; k < S.g.length; k += 3) { gsum[S.g[k]] += S.g[k + 2]; if (S.g[k + 1] >= 0) gsum[S.g[k + 1]] += S.g[k + 2]; }
    this.gsum = gsum;
    // Islands: union nets joined by real conductances.
    const parent = new Int32Array(n);
    for (let k = 0; k < n; k++) parent[k] = k;
    const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    const touched = new Uint8Array(n);
    const g = S.g;
    for (let k = 0; k < g.length; k += 3) {
      const a = g[k], b = g[k + 1];
      touched[a] = 1;
      if (b >= 0) {
        touched[b] = 1;
        const ra = find(a), rb = find(b);
        if (ra !== rb) parent[rb] = ra;
      }
    }
    const isRoot = new Uint8Array(n);
    for (const r of S.roots) isRoot[find(r)] = 1;

    // Group nodes by island.
    const groups = new Map();
    for (let k = 0; k < n; k++) {
      if (!touched[k]) continue;
      const r = find(k);
      let arr = groups.get(r);
      if (!arr) { arr = []; groups.set(r, arr); }
      arr.push(k);
    }
    const local = new Int32Array(n).fill(-1);
    const islandOf = new Int32Array(n).fill(-1);
    const mats = new Map();
    for (const [r, nodes] of groups) {
      const m = nodes.length;
      nodes.forEach((node, i) => { local[node] = i; islandOf[node] = r; });
      const A = new Float64Array(m * m);
      for (let i = 0; i < m; i++) A[i * m + i] = LEAK;
      mats.set(r, { nodes, A, z: new Float64Array(m), m });
    }
    for (const a of S.anchors) {
      const r = islandOf[a];
      if (r < 0 || isRoot[r]) continue;
      const M = mats.get(r);
      M.A[local[a] * M.m + local[a]] += 1e-3;
    }
    for (let k = 0; k < g.length; k += 3) {
      const a = g[k], b = g[k + 1], c = g[k + 2];
      const M = mats.get(islandOf[a]);
      const ia = local[a];
      M.A[ia * M.m + ia] += c;
      if (b >= 0) {
        const ib = local[b];
        M.A[ib * M.m + ib] += c;
        M.A[ia * M.m + ib] -= c;
        M.A[ib * M.m + ia] -= c;
      }
    }
    const cur = S.i;
    for (let k = 0; k < cur.length; k += 3) {
      const a = cur[k], b = cur[k + 1], i = cur[k + 2];
      if (a >= 0 && islandOf[a] >= 0) { const M = mats.get(islandOf[a]); M.z[local[a]] -= i; }
      if (b >= 0 && islandOf[b] >= 0) { const M = mats.get(islandOf[b]); M.z[local[b]] += i; }
    }

    const defined = this.defined;
    defined.fill(0);
    V.fill(NaN);
    for (const [r, M] of mats) {
      const x = gaussSolve(M.A, M.z, M.m);
      // An island is "defined" only if real conductances reach a source.
      for (let i = 0; i < M.m; i++) V[M.nodes[i]] = x[i];
    }
    // Defined = reachable from a source through non-negligible conductances.
    const strong = new Int32Array(n);
    for (let k = 0; k < n; k++) strong[k] = k;
    const sfind = (a) => { while (strong[a] !== a) { strong[a] = strong[strong[a]]; a = strong[a]; } return a; };
    for (let k = 0; k < g.length; k += 3) {
      const a = g[k], b = g[k + 1];
      if (b >= 0 && g[k + 2] > EDGE_MIN) {
        const ra = sfind(a), rb = sfind(b);
        if (ra !== rb) strong[rb] = ra;
      }
    }
    const live = new Uint8Array(n);
    for (const r of S.roots) live[sfind(r)] = 1;
    for (const a of S.anchors) live[sfind(a)] = 1;
    for (let k = 0; k < n; k++) {
      if (touched[k] && live[sfind(k)]) defined[k] = 1;
      else V[k] = NaN;
    }
  }

  /** Advance simulated time by dt seconds. */
  step(dt) {
    this.dt = dt;
    this.minTau = Infinity;
    this.maxHz = 0;
    for (const d of this.devices) if (d.begin) d.begin(this);
    let iters = 0;
    this.converged = false;
    while (iters++ < MAX_ITERS) {
      this.solve();
      let changed = false;
      // Settle diodes/LEDs first. A diode that hasn't switched off yet can briefly hold a
      // falling wire at an in-between voltage; if a chip read it now it could latch a level
      // that never really existed (e.g. a 7493 resetting at 8 instead of 10).
      for (const d of this.devices) if (d.analog && d.update && d.update(this.V, this)) changed = true;
      if (changed) continue;
      for (const d of this.devices) if (!d.analog && d.update && d.update(this.V, this)) changed = true;
      if (!changed) { this.converged = true; break; }
    }
    // Giving up leaves V from a solve made *before* the last update() changed some
    // states (e.g. an LED switching on). Solve once more so commit() reads voltages
    // that match the current states — otherwise an LED can report hundreds of mA.
    if (!this.converged) this.solve();
    for (const d of this.devices) if (d.commit) d.commit(this.V, dt, this);
    this.time += dt;
  }

  /** Time step that resolves the fastest RC constant and clock in the circuit. */
  suggestDt() {
    let dt = 5e-4;
    if (Number.isFinite(this.minTau)) dt = Math.min(dt, this.minTau / 20);
    if (this.maxHz > 0) dt = Math.min(dt, 1 / (40 * this.maxHz));
    return Math.max(2e-6, dt);
  }

  collectWarnings() {
    const out = [];
    for (const d of this.devices) {
      if (d.warning) out.push({ level: 'error', part: d.part, text: d.warning });
      if (d.notes) for (const t of d.notes) out.push({ level: 'warn', part: d.part, text: t });
      if (d.infos) for (const t of d.infos) out.push({ level: 'note', part: d.part, text: t });
    }
    if (!this.converged) out.push({ level: 'warn', part: null, text: 'Circuit is oscillating — a feedback loop never settles.' });
    this.warnings = out;
    return out;
  }
}

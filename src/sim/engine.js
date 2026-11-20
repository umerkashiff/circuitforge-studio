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

/** Stamp collector handed to devices. Net index -1 means "not connected", -2 means reference ground (0 V). */
class Stamps {
  constructor() { this.reset(); }
  reset() {
    this.g = [];      // [a, b, g]   conductance between nets (b = -2 for ground)
    this.pg = [];     // [a, b, g]   DC-passive conductance edges used by ohmmeter probe
    this.i = [];      // [a, b, i]   current i flowing a -> b through the device
    this.vc = [];     // [outP, outN, ctrlP, ctrlN, gm] dependent VCCS entries (outP -> outN)
    this.cg = [];     // [a, b, g]   transient capacitor conductances (excluded from static dcG)
    this.sg = [];     // [net, g]    low-impedance supply source conductances (R <= 2 Ω)
    this.anchors = [];
    this.roots = [];  // nets directly tied to a voltage source
  }
  G(a, b, g, dcPassive = true) {
    if (a >= 0 && b >= 0 && a !== b) {
      this.g.push(a, b, g);
      if (dcPassive) this.pg.push(a, b, g);
    }
  }
  /** Transient capacitor companion conductance (excluded from DC passive & other-cap sum). */
  cap(a, b, g) {
    if (a >= 0 && b >= 0 && a !== b) {
      this.g.push(a, b, g);
      this.cg.push(a, b, g);
    }
  }
  /** Record a DC-passive conductance for ohmmeter probing without altering active MNA stamps. */
  P(a, b, g) {
    if (a >= 0 && b >= 0 && a !== b) this.pg.push(a, b, g);
  }
  I(a, b, i) { if (a >= 0 || b >= 0) this.i.push(a, b, i); }
  /** Voltage-controlled current source: pushes I = gm * (V[ctrlP] - V[ctrlN]) from outP -> outN. */
  vccs(outP, outN, ctrlP, ctrlN, gm) {
    if ((outP < 0 && outP !== -2) || (outN < 0 && outN !== -2)) return;
    if ((ctrlP < 0 && ctrlP !== -2) || (ctrlN < 0 && ctrlN !== -2)) return;
    if (outP === outN || ctrlP === ctrlN || !gm) return;
    this.vc.push(outP, outN, ctrlP, ctrlN, gm);
  }
  /** Norton source from ground: drives net a towards V through resistance R. */
  src(a, V, R) {
    if (a < 0) return;
    const g = 1 / R;
    this.g.push(a, -2, g);
    this.i.push(-2, a, V * g);
    this.roots.push(a);
    if (R <= 2) this.sg.push(a, g);
  }
  /** Two-terminal source (battery, diode drop): Va - Vb -> V through R. */
  vdrop(a, b, V, R) {
    const g = 1 / R;
    this.G(a, b, g, false);
    this.I(a, b, -V * g);
  }
  anchor(a) { if (a >= 0) this.anchors.push(a); }
}

function gaussSolve(A, z, n, xOut) {
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
  const x = xOut && xOut.length >= n ? xOut : new Float64Array(n);
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
    this._i2cBuses = new Map();
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

    // Number active nets (wires + part pins) densely first so solve() skips unused board strips.
    const rootIdx = new Map();
    const pointNet = new Map();
    const idxOf = (k) => {
      const r = uf.find(k);
      let n = rootIdx.get(r);
      if (n === undefined) { n = rootIdx.size; rootIdx.set(r, n); }
      pointNet.set(k, n);
      return n;
    };
    for (const w of circuit.wires) { idxOf(key(w.a.x, w.a.y)); idxOf(key(w.b.x, w.b.y)); }

    this.devices = [];
    this.byPart = new Map();
    this.timeDependent = false;
    this.hasMcu = false;
    this.hasCap = false;
    this.hasInd = false;
    this.resistorNets = new Set();   // nets touching a resistor — lets LEDs tell "no resistor" from "resistor too small"

    // Track nets with wire endpoints or shared across >1 part so optional clocks (e.g. trainer CLK) don't idle-spin the solver.
    this._wireNets = new Set();
    for (const w of circuit.wires) {
      const na = pointNet.get(key(w.a.x, w.a.y));
      const nb = pointNet.get(key(w.b.x, w.b.y));
      if (na !== undefined) this._wireNets.add(na);
      if (nb !== undefined) this._wireNets.add(nb);
    }
    this._netPartCount = new Map();
    const allPartPinNets = partPins.map(([, , pins]) => pins.map(pin => idxOf(key(pin.x, pin.y))));
    this._activeNets = rootIdx.size;
    for (const b of circuit.boards) for (const h of b.holes()) idxOf(key(h.x, h.y));
    for (const pinNets of allPartPinNets) {
      const seen = new Set(pinNets);
      for (const net of seen) this._netPartCount.set(net, (this._netPartCount.get(net) || 0) + 1);
    }

    for (let idx = 0; idx < partPins.length; idx++) {
      const [p, def] = partPins[idx];
      const pinNets = allPartPinNets[idx];
      if (p.type === 'resistor' || p.type === 'pot') for (const n of pinNets) this.resistorNets.add(n);
      let device = null;
      if (def.device) {
        device = def.device(p, pinNets, this);
        const old = prevState.get(p.id);
        if (old && old.type === p.type && device.adopt) device.adopt(old);
        device.type = p.type;
        device.part = p;
        if (p.type === 'capacitor') this.hasCap = true;
        if (p.type === 'inductor') this.hasInd = true;
        if (device.rt !== undefined) this.hasMcu = true;
        if (device.timeDependent) this.timeDependent = true;
        this.devices.push(device);
      }
      this.byPart.set(p.id, { device, pinNets });
    }

    this.pointNet = pointNet;
    this.nets = rootIdx.size;
    const n = this.nets;
    const m = Math.max(1, this._activeNets);
    this._buf = {
      n: this._activeNets,
      gsum: new Float64Array(m),
      capG: new Float64Array(m),
      rootG: new Float64Array(m),
      parent: new Int32Array(m),
      touched: new Uint8Array(m),
      isRoot: new Uint8Array(m),
      local: new Int32Array(m),
      islandOf: new Int32Array(m),
      strong: new Int32Array(m),
      live: new Uint8Array(m),
      diag1: new Float64Array(m),
      rhs1: new Float64Array(m),
      groupHead: new Int32Array(m),
      groupNext: new Int32Array(m),
      groupSize: new Int32Array(m),
      rootSlot: new Int32Array(m),
      pool: [],
    };
    const oldV = this.V;
    this.V = new Float64Array(n).fill(NaN);
    this.defined = new Uint8Array(n);
    if (oldV.length === this.V.length) this.V.set(oldV);
    this.solve();
    for (const d of this.devices) if (d.update) d.update(this.V, this);
  }

  /** True when a wire or another part connects to this net (unused trainer pins won't spin slow-mo). */
  isNetConnected(net) {
    if (net < 0) return false;
    if (this._wireNets && this._wireNets.has(net)) return true;
    return !!this._netPartCount && (this._netPartCount.get(net) || 0) > 1;
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

    const n = this._activeNets;
    const B = this._buf;
    // Total conductance, capacitor conductance & stiff source conductance at each net.
    const gsum = B.gsum; gsum.fill(0);
    const capG = B.capG; capG.fill(0);
    const rootG = B.rootG; rootG.fill(0);
    const g = S.g;
    for (let k = 0; k < g.length; k += 3) { gsum[g[k]] += g[k + 2]; if (g[k + 1] >= 0) gsum[g[k + 1]] += g[k + 2]; }
    const cg = S.cg;
    for (let k = 0; k < cg.length; k += 3) { capG[cg[k]] += cg[k + 2]; capG[cg[k + 1]] += cg[k + 2]; }
    const sg = S.sg;
    for (let k = 0; k < sg.length; k += 2) rootG[sg[k]] += sg[k + 1];
    this.gsum = gsum;
    this.capG = capG;
    this.rootG = rootG;
    // Islands: union nets joined by real conductances.
    const parent = B.parent;
    const touched = B.touched; touched.fill(0);
    const isRoot = B.isRoot; isRoot.fill(0);
    const groupHead = B.groupHead; groupHead.fill(-1);
    const groupSize = B.groupSize; groupSize.fill(0);
    for (let k = 0; k < n; k++) parent[k] = k;
    const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    for (let k = 0; k < g.length; k += 3) {
      const a = g[k], b = g[k + 1];
      touched[a] = 1;
      if (b >= 0) {
        touched[b] = 1;
        const ra = find(a), rb = find(b);
        if (ra !== rb) parent[rb] = ra;
      }
    }
    const vc = S.vc;
    for (let k = 0; k < vc.length; k += 5) {
      const a = vc[k], b = vc[k + 1], cp = vc[k + 2], cn = vc[k + 3];
      let first = -1;
      if (a >= 0) { touched[a] = 1; first = find(a); }
      if (b >= 0) { touched[b] = 1; if (first < 0) first = find(b); else { const r = find(b); if (r !== first) parent[r] = first; } }
      if (cp >= 0) { touched[cp] = 1; if (first < 0) first = find(cp); else { const r = find(cp); if (r !== first) parent[r] = first; } }
      if (cn >= 0) { touched[cn] = 1; if (first < 0) first = find(cn); else { const r = find(cn); if (r !== first) parent[r] = first; } }
    }
    for (const r of S.roots) isRoot[find(r)] = 1;

    // Group touched nodes by island using zero-alloc linked list.
    const groupNext = B.groupNext;
    const local = B.local; local.fill(-1);
    const islandOf = B.islandOf; islandOf.fill(-1);
    const diag1 = B.diag1, rhs1 = B.rhs1;
    let multiCount = 0;
    for (let k = 0; k < n; k++) {
      if (!touched[k]) continue;
      const r = find(k);
      groupNext[k] = groupHead[r];
      groupHead[r] = k;
      groupSize[r]++;
    }

    const pool = B.pool;
    const rootSlot = B.rootSlot; rootSlot.fill(-1);
    let poolIdx = 0;
    for (let r = 0; r < n; r++) {
      const m = groupSize[r];
      if (!m) continue;
      if (m === 1) {
        const node = groupHead[r];
        islandOf[node] = -2;
        diag1[node] = LEAK;
        rhs1[node] = 0;
        continue;
      }
      multiCount++;
      let slot = pool[poolIdx];
      if (!slot) { slot = { nodes: [], A: new Float64Array(m * m), z: new Float64Array(m), x: new Float64Array(m), m: 0 }; pool[poolIdx] = slot; }
      if (slot.A.length < m * m) slot.A = new Float64Array(m * m);
      if (slot.z.length < m) { slot.z = new Float64Array(m); slot.x = new Float64Array(m); }
      slot.m = m;
      slot.nodes.length = m;
      const A = slot.A, z = slot.z;
      A.fill(0, 0, m * m);
      z.fill(0, 0, m);
      let i = 0;
      for (let node = groupHead[r]; node !== -1; node = groupNext[node]) {
        local[node] = i;
        islandOf[node] = r;
        slot.nodes[i] = node;
        A[i * m + i] = LEAK;
        i++;
      }
      rootSlot[r] = poolIdx;
      poolIdx++;
    }

    for (const a of S.anchors) {
      const r = islandOf[a];
      if (r === -1) continue;
      if (r === -2) { if (!isRoot[a]) diag1[a] += 1e-3; continue; }
      if (isRoot[r]) continue;
      const M = pool[rootSlot[r]];
      M.A[local[a] * M.m + local[a]] += 1e-3;
    }
    for (let k = 0; k < g.length; k += 3) {
      const a = g[k], b = g[k + 1], c = g[k + 2];
      const ra = islandOf[a];
      if (ra === -2) { diag1[a] += c; continue; }
      const M = pool[rootSlot[ra]];
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
      if (a >= 0) {
        const ra = islandOf[a];
        if (ra === -2) rhs1[a] -= i;
        else if (ra >= 0) pool[rootSlot[ra]].z[local[a]] -= i;
      }
      if (b >= 0) {
        const rb = islandOf[b];
        if (rb === -2) rhs1[b] += i;
        else if (rb >= 0) pool[rootSlot[rb]].z[local[b]] += i;
      }
    }
    for (let k = 0; k < vc.length; k += 5) {
      const a = vc[k], b = vc[k + 1], cp = vc[k + 2], cn = vc[k + 3], gm = vc[k + 4];
      const ref = a >= 0 ? a : b >= 0 ? b : cp >= 0 ? cp : cn;
      if (ref < 0) continue;
      const r = islandOf[ref];
      if (r === -2) {
        if (a >= 0) {
          if (cp === a) diag1[a] += gm;
          if (cn === a) diag1[a] -= gm;
        }
        if (b >= 0) {
          if (cp === b) diag1[b] -= gm;
          if (cn === b) diag1[b] += gm;
        }
        continue;
      }
      const M = pool[rootSlot[r]];
      const m = M.m, A = M.A;
      const ia = a >= 0 ? local[a] : -1, ib = b >= 0 ? local[b] : -1;
      const icp = cp >= 0 ? local[cp] : -1, icn = cn >= 0 ? local[cn] : -1;
      if (ia >= 0) {
        if (icp >= 0) A[ia * m + icp] += gm;
        if (icn >= 0) A[ia * m + icn] -= gm;
      }
      if (ib >= 0) {
        if (icp >= 0) A[ib * m + icp] -= gm;
        if (icn >= 0) A[ib * m + icn] += gm;
      }
    }

    const defined = this.defined;
    for (let k = 0; k < n; k++) { defined[k] = 0; V[k] = NaN; }
    for (let k = 0; k < n; k++) {
      if (islandOf[k] === -2) V[k] = diag1[k] < 1e-300 ? 0 : rhs1[k] / diag1[k];
    }
    for (let p = 0; p < multiCount; p++) {
      const M = pool[p];
      const x = gaussSolve(M.A, M.z, M.m, M.x);
      // An island is "defined" only if real conductances reach a source.
      for (let i = 0; i < M.m; i++) V[M.nodes[i]] = x[i];
    }
    // Defined = reachable from a source through non-negligible conductances.
    const strong = B.strong;
    for (let k = 0; k < n; k++) strong[k] = k;
    const sfind = (a) => { while (strong[a] !== a) { strong[a] = strong[strong[a]]; a = strong[a]; } return a; };
    for (let k = 0; k < g.length; k += 3) {
      const a = g[k], b = g[k + 1];
      if (b >= 0 && g[k + 2] > EDGE_MIN) {
        const ra = sfind(a), rb = sfind(b);
        if (ra !== rb) strong[rb] = ra;
      }
    }
    const live = B.live; live.fill(0);
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

  /** Time step that resolves the fastest RC/RL constant and clock in the circuit. */
  suggestDt() {
    let dt = (this.hasMcu || this.hasCap || this.hasInd) ? 5e-4 : 5e-3;
    if (Number.isFinite(this.minTau)) dt = Math.min(dt, this.minTau / 20);
    if (this.maxHz > 0) dt = Math.min(dt, 1 / (40 * this.maxHz));
    return Math.max(2e-6, dt);
  }

  /**
   * Measure equivalent DC passive resistance between netA and netB using recorded S.pg edges.
   * Refuses if either probed net carries > 0.35 V relative to ground or each other.
   */
  measureOhms(netA, netB) {
    if (netA < 0 || netB < 0) return { live: false, ohms: Infinity };
    const va = this.V[netA], vb = this.V[netB];
    const liveA = Number.isFinite(va) && Math.abs(va) > 0.35;
    const liveB = Number.isFinite(vb) && Math.abs(vb) > 0.35;
    const diff = (Number.isFinite(va) && Number.isFinite(vb)) ? Math.abs(va - vb) : 0;
    if (liveA || liveB || diff > 0.35) return { live: true, ohms: NaN };
    if (netA === netB) return { live: false, ohms: 0 };

    const pg = this.S.pg;
    const adj = new Map();
    const edges = [];
    for (let k = 0; k < pg.length; k += 3) {
      const a = pg[k], b = pg[k + 1], g = pg[k + 2];
      if (a < 0 || b < 0 || a === b || !(g > 1e-8)) continue;
      edges.push(a, b, g);
      let la = adj.get(a); if (!la) { la = []; adj.set(a, la); } la.push(b);
      let lb = adj.get(b); if (!lb) { lb = []; adj.set(b, lb); } lb.push(a);
    }
    const idxMap = new Map([[netA, 0]]);
    const queue = [netA];
    for (let h = 0; h < queue.length; h++) {
      const nbrs = adj.get(queue[h]);
      if (!nbrs) continue;
      for (const v of nbrs) {
        if (!idxMap.has(v)) { idxMap.set(v, queue.length); queue.push(v); }
      }
    }
    if (!idxMap.has(netB)) return { live: false, ohms: Infinity };

    const m = queue.length;
    const A = new Float64Array(m * m);
    const z = new Float64Array(m);
    const x = new Float64Array(m);
    for (let i = 0; i < m; i++) A[i * m + i] = 1e-14;
    for (let k = 0; k < edges.length; k += 3) {
      const ia = idxMap.get(edges[k]), ib = idxMap.get(edges[k + 1]);
      if (ia === undefined || ib === undefined) continue;
      const g = edges[k + 2];
      A[ia * m + ia] += g;
      A[ib * m + ib] += g;
      A[ia * m + ib] -= g;
      A[ib * m + ia] -= g;
    }
    // Pin V[netB] = 0 and inject +1 A at netA so V[netA] equals R_eq directly.
    const ib = idxMap.get(netB);
    for (let j = 0; j < m; j++) A[ib * m + j] = 0;
    A[ib * m + ib] = 1;
    z[0] = 1;
    gaussSolve(A, z, m, x);
    const r = x[0];
    return { live: false, ohms: (Number.isFinite(r) && r >= 0) ? r : Infinity };
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

/**
 * Electrical behaviour of every part. A device gets the net index of each
 * pin (-1 = unconnected) and implements some of:
 *   stamp(S, V, engine)  add conductances / sources for this iteration
 *   update(V, engine)    re-evaluate internal state, return true if it changed
 *   begin(engine)        start of a time step
 *   commit(V, dt)        end of a time step (store capacitor charge, edges…)
 *   reset()              power cycle
 */

const R_SUPPLY = 0.05;   // bench supply / ground
const R_LOGIC = 25;      // TTL push-pull output
const R_SOURCE = 30;     // switch / clock modules
const OPEN = 1e-9;

const ok = (v) => !Number.isNaN(v);

// ---------------------------------------------------------------------------
export function supply(nets, volts) {
  return {
    current: 0,
    stamp(S) { S.src(nets[0], volts, R_SUPPLY); },
    commit(V) {
      const v = V[nets[0]];
      this.current = ok(v) ? (volts - v) / R_SUPPLY : 0;
      this.warning = Math.abs(this.current) > 2 ? 'Short circuit on the supply — it is wired straight to another supply or ground.' : null;
    },
  };
}

export function battery(nets, part) {
  const Rint = 0.4;
  return {
    current: 0,
    stamp(S) { S.vdrop(nets[0], nets[1], part.props.volts, Rint); S.anchor(nets[1]); },
    commit(V) {
      const a = V[nets[0]], c = V[nets[1]];
      this.current = ok(a) && ok(c) ? (part.props.volts - (a - c)) / Rint : 0;
      this.warning = Math.abs(this.current) > 3 ? 'Battery is short-circuited.' : null;
    },
  };
}

/** Self-powered logic source: drives 5 V or 0 V. `level()` decides which. */
export function logicSource(net, level) {
  return { stamp(S, V, e) { S.src(net, level(e) ? 5 : 0, R_SOURCE); } };
}

/** Resistor with a power rating: sustained overload chars it and it fails open. */
export function resistor(nets, part) {
  return {
    heat: 0,
    adopt(o) { this.heat = o.heat || 0; },
    stamp(S) { if (!part.props.damaged) S.G(nets[0], nets[1], 1 / Math.max(part.props.ohms, 1e-3)); },
    commit(V, dt) {
      if (part.props.damaged) { this.warning = 'Resistor burned out (open circuit). Replace it from the inspector.'; return; }
      const a = V[nets[0]], c = V[nets[1]];
      const watts = ok(a) && ok(c) ? (a - c) ** 2 / Math.max(part.props.ohms, 1e-3) : 0;
      this.watts = watts;
      const rating = part.props.watts || 0.25;
      if (watts > rating * 1.5) this.heat += dt * watts / rating; else this.heat = Math.max(0, this.heat - dt);
      this.notes = watts > rating ? [`Running hot: ${watts.toFixed(2)} W on a ${rating} W resistor.`] : null;
      if (this.heat > 0.8) {
        part.props.damaged = 'burnt';
        this.event = { kind: 'burnt', text: `Resistor burned out — ${watts.toFixed(1)} W through a ${rating} W part.` };
      }
    },
  };
}

/** Electrolytic capacitor: bursts on sustained over-voltage or reverse polarity. */
export function capacitor(nets, part) {
  return {
    timeDependent: true,
    vc: 0, stress: 0,
    reset() { this.vc = 0; this.stress = 0; },
    adopt(o) { this.vc = o.vc; this.stress = o.stress || 0; },
    stamp(S, V, e) {
      if (part.props.damaged) return;
      const geq = (part.props.uf * 1e-6) / e.dt;
      S.G(nets[0], nets[1], geq);
      S.I(nets[0], nets[1], -geq * this.vc);
    },
    commit(V, dt) {
      if (part.props.damaged) { this.warning = 'Capacitor has burst (open circuit). Replace it from the inspector.'; return; }
      const a = V[nets[0]], c = V[nets[1]];
      if (ok(a) && ok(c)) this.vc = a - c;
      const rating = part.props.vmax || 16;
      const over = this.vc > rating * 1.1, rev = this.vc < -1.5;
      if (over || rev) this.stress += dt; else this.stress = Math.max(0, this.stress - dt * 0.5);
      this.warning = null;
      this.notes = this.vc < -0.3 ? ['Capacitor is backwards — the − stripe must go to the lower voltage.'] : this.vc > rating * 0.9 ? [`${this.vc.toFixed(1)} V is close to the ${rating} V rating.`] : null;
      if (this.stress > 0.25) {
        part.props.damaged = 'burst';
        this.event = { kind: 'burst', text: rev ? 'Capacitor burst — it was wired backwards.' : `Capacitor burst — ${this.vc.toFixed(1)} V across a ${rating} V part.` };
      }
    },
  };
}

/**
 * Piece-wise linear diode set. pairs: [[anodeNet, cathodeNet, Vf, Rs], …]
 * Exposes per-element current (A) and `blown` for LEDs.
 */
export function diodes(pairs, opts = {}) {
  const n = pairs.length;
  return {
    on: new Uint8Array(n),
    cur: new Float64Array(n),
    blown: new Uint8Array(n),
    avg: new Float64Array(n),
    reset() { this.on.fill(0); this.cur.fill(0); if (!opts.part) this.blown.fill(0); },
    adopt(o) { if (o.blown && o.blown.length === n) this.blown.set(o.blown); if (o.avg && o.avg.length === n) this.avg.set(o.avg); },
    stamp(S) {
      for (let k = 0; k < n; k++) {
        const [a, c, vf, rs] = pairs[k];
        if (this.blown[k]) continue;
        if (this.on[k]) S.vdrop(a, c, vf, rs); else S.G(a, c, OPEN);
      }
    },
    update(V) {
      let changed = false;
      for (let k = 0; k < n; k++) {
        const [a, c, vf, rs] = pairs[k];
        const va = a >= 0 ? V[a] : NaN, vc = c >= 0 ? V[c] : NaN;
        let on = 0;
        if (ok(va) && ok(vc)) {
          const vd = va - vc;
          on = this.on[k] ? ((vd - vf) / rs > -1e-7 ? 1 : 0) : (vd > vf + 1e-6 ? 1 : 0);
        }
        if (on !== this.on[k]) { this.on[k] = on; changed = true; }
      }
      return changed;
    },
    commit(V, dt) {
      if (opts.part && opts.part.props.damaged) this.blown.fill(1);
      const notes = [];
      for (let k = 0; k < n; k++) {
        const [a, c, vf, rs] = pairs[k];
        const va = a >= 0 ? V[a] : NaN, vc = c >= 0 ? V[c] : NaN;
        if (!this.on[k] || this.blown[k]) {
          this.cur[k] = 0;
          if (opts.led && !this.blown[k] && ok(va) && ok(vc) && vc - va > 1) notes.push('LED is backwards — the long leg (anode) must go to the higher voltage.');
        } else {
          const i = (va - vc - vf) / rs;
          this.cur[k] = Math.max(0, i);
          if (opts.maxA && i > opts.maxA) {
            this.blown[k] = 1;
            if (opts.part) { opts.part.props.damaged = 'blown'; this.event = { kind: 'blown', text: opts.blownText }; }
          } else if (opts.led && i > 0.03) notes.push(`No current-limiting resistor? ${(i * 1000).toFixed(0)} mA is above the 20 mA rating.`);
        }
        // smoothed current for drawing (PWM looks dim instead of flickering)
        const t = Math.min(1, (dt || 0.016) / 0.03);
        this.avg[k] += (this.cur[k] - this.avg[k]) * t;
      }
      this.warning = this.blown.some(Boolean) ? (opts.blownText || 'Burned out.') : null;
      this.notes = notes.length ? [...new Set(notes)] : null;
    },
  };
}

// ---------------------------------------------------------------------------
/** Generic digital IC driven by a datasheet model (see parts/ics.js). */
export function icDevice(ic, nets) {
  const N = ic.n;
  const net = (p) => nets[p - 1];
  const d = {
    powered: false,
    vh: 5, vl: 0,
    s: ic.init ? ic.init() : [],
    committed: ic.init ? ic.init() : [],
    lvl: new Int8Array(N + 1),
    prev: new Int8Array(N + 1).fill(-1),
    seen: new Uint8Array(N + 1),
    out: new Array(N + 1).fill(undefined),   // undefined = not an output this round
    mode: new Array(N + 1).fill('pp'),
    floatingInputs: [],
    reset() { this.s = ic.init ? ic.init() : []; this.committed = this.s.slice(); this.prev.fill(-1); this.out.fill(undefined); },
    adopt(o) { this.s = o.committed.slice(); this.committed = o.committed.slice(); this.prev.set(o.prev); },
    begin() { this.s = this.committed.slice(); this.seen.fill(0); },
    stamp(S, V) {
      if (!this.powered) return;
      for (let p = 1; p <= N; p++) {
        const v = this.out[p];
        if (v === undefined || v === null || net(p) < 0) continue;
        const m = this.mode[p];
        if (m === 'oc') { if (v === 0) S.src(net(p), this.vl, 15); }
        else if (m === 'pu') S.src(net(p), v ? this.vh : this.vl, v ? 2000 : R_LOGIC);
        else S.src(net(p), v ? this.vh : this.vl, R_LOGIC);
      }
    },
    level(p, V) {
      const v = net(p) >= 0 ? V[net(p)] : NaN;
      if (!ok(v)) return ic.cmos ? 0 : 1;       // floating TTL input reads HIGH
      const rel = v - this.vl;
      if (ic.cmos) return rel > (this.vh - this.vl) / 2 ? 1 : 0;
      if (rel >= 2.0) return 1;
      if (rel <= 0.8) return 0;
      return this.prev[p] >= 0 ? this.prev[p] : 1;
    },
    update(V) {
      const vcc = net(ic.vcc) >= 0 ? V[net(ic.vcc)] : NaN;
      const gnd = net(ic.gnd) >= 0 ? V[net(ic.gnd)] : NaN;
      const powered = ok(vcc) && ok(gnd) && vcc - gnd >= (ic.cmos ? 3 : 4.0);
      let changed = powered !== this.powered;
      this.powered = powered;
      if (powered) { this.vh = vcc; this.vl = gnd; }
      const old = this.out.slice();
      this.out.fill(undefined);
      if (powered) {
        for (let p = 1; p <= N; p++) this.lvl[p] = this.level(p, V);
        ic.ev(ctx);
      }
      for (let p = 1; p <= N; p++) if (old[p] !== this.out[p]) { changed = true; break; }
      return changed;
    },
    commit(V) {
      if (!this.powered) { this.prev.fill(-1); this.warning = this.anyConnected() ? `No power — pin ${ic.vcc} (${ic.cmos ? 'VDD' : 'VCC'}) needs +5 V and pin ${ic.gnd} (${ic.cmos ? 'VSS' : 'GND'}) needs ground.` : null; return; }
      this.committed = this.s.slice();
      for (let p = 1; p <= N; p++) this.prev[p] = this.lvl[p];
      this.warning = null;
      const floating = [], fights = [];
      for (let p = 1; p <= N; p++) {
        if (p === ic.vcc || p === ic.gnd || ic.pins[p - 1] === 'NC') continue;
        const v = net(p) >= 0 ? V[net(p)] : NaN;
        const o = this.out[p];
        if (o === undefined) { if (!ok(v)) floating.push(p); continue; }
        if (o === null || this.mode[p] !== 'pp' || !ok(v)) continue;
        if (Math.abs(v - (o ? this.vh : this.vl)) > 1.5) fights.push(p);
      }
      if (fights.length) this.warning = `Output pin${fights.length > 1 ? 's' : ''} ${fights.join(', ')} ${fights.length > 1 ? 'are' : 'is'} shorted to another output or a supply.`;
      this.infos = floating.length ? [`Input pin${floating.length > 1 ? 's' : ''} ${floating.join(', ')} ${floating.length > 1 ? 'are' : 'is'} floating (${ic.cmos ? 'reads unpredictably' : 'TTL reads HIGH'}). Tie unused inputs to + or −.`] : null;
    },
    anyConnected() { return nets.some(n => n >= 0); },
  };
  const ctx = {
    get s() { return d.s; },
    i: (p) => d.lvl[p],
    rise(p) {
      if (d.seen[p] || d.prev[p] !== 0 || d.lvl[p] !== 1) return false;
      d.seen[p] = 1; return true;
    },
    fall(p) {
      if (d.seen[p] || d.prev[p] !== 1 || d.lvl[p] !== 0) return false;
      d.seen[p] = 1; return true;
    },
    o(p, v) { d.out[p] = v; d.mode[p] = 'pp'; },
    oc(p, v) { d.out[p] = v; d.mode[p] = 'oc'; },
    pu(p, v) { d.out[p] = v; d.mode[p] = 'pu'; },
  };
  return d;
}

/** NE555: GND1 TRIG2 OUT3 RESET4 CTRL5 THR6 DIS7 VCC8 — real comparator/latch model. */
export function timer555(nets) {
  const [gnd, trig, out, rst, ctrl, thr, dis, vcc] = nets;
  return {
    latch: 0, powered: false, vh: 5, vl: 0,
    reset() { this.latch = 0; },
    adopt(o) { this.latch = o.latch; },
    stamp(S) {
      if (!this.powered) return;
      if (vcc >= 0 && ctrl >= 0) S.G(vcc, ctrl, 1 / 5000);
      if (ctrl >= 0 && gnd >= 0) S.G(ctrl, gnd, 1 / 10000);
      S.src(out, this.latch ? this.vh - 0.2 : this.vl, 10);
      if (!this.latch && dis >= 0 && gnd >= 0) S.G(dis, gnd, 1 / 8);
    },
    update(V) {
      const vh = vcc >= 0 ? V[vcc] : NaN, vl = gnd >= 0 ? V[gnd] : NaN;
      const powered = ok(vh) && ok(vl) && vh - vl >= 4.5;
      let changed = powered !== this.powered;
      this.powered = powered;
      if (!powered) return changed;
      this.vh = vh; this.vl = vl;
      const span = vh - vl;
      let vref = ctrl >= 0 && ok(V[ctrl]) ? V[ctrl] - vl : span * 2 / 3;
      const vt = trig >= 0 && ok(V[trig]) ? V[trig] - vl : span;
      const vth = thr >= 0 && ok(V[thr]) ? V[thr] - vl : 0;
      const vr = rst >= 0 && ok(V[rst]) ? V[rst] - vl : span;
      let next = this.latch;
      if (vr < 0.7) next = 0;
      else if (vt < vref / 2) next = 1;
      else if (vth > vref) next = 0;
      if (next !== this.latch) { this.latch = next; changed = true; }
      return changed;
    },
    commit() {
      this.warning = !this.powered && nets.some(n => n >= 0) ? 'No power — pin 8 (VCC) needs +5 V and pin 1 (GND) needs ground.' : null;
    },
  };
}

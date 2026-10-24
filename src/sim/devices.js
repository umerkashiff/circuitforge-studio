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
const BURN_TIME = 0.05;  // overload must last this long (s) before a part is destroyed

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
    i: 0,
    commit(V, dt, e) {
      if (part.props.damaged) { this.warning = 'Capacitor has burst (open circuit). Replace it from the inspector.'; this.i = 0; return; }
      const a = V[nets[0]], c = V[nets[1]];
      const C = part.props.uf * 1e-6;
      const prev = this.vc;
      if (ok(a) && ok(c)) this.vc = a - c;
      this.i = (C * (this.vc - prev)) / dt;   // > 0 while + side is charging up
      if (e && e.gsum && nets[0] >= 0 && nets[1] >= 0) {
        const geq = C / dt;
        const ga = e.gsum[nets[0]] - geq, gb = e.gsum[nets[1]] - geq;
        const r = (ga > 1e-9 ? 1 / ga : 1e9) + (gb > 1e-9 ? 1 / gb : 1e9);
        e.minTau = Math.min(e.minTau, C * r);
      }
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
  const hasR = (e, k) => !!e && !!e.resistorNets && (e.resistorNets.has(pairs[k][0]) || e.resistorNets.has(pairs[k][1]));
  return {
    analog: true,                                  // engine settles these before chips read logic levels
    rsEff: Float64Array.from(pairs, p => p[3]),   // Rs plus the trainer-board resistor when one applies
    on: new Uint8Array(n),
    cur: new Float64Array(n),
    blown: new Uint8Array(n),
    avg: new Float64Array(n),
    over: new Float64Array(n),   // seconds spent above maxA
    reset() { this.on.fill(0); this.cur.fill(0); if (!opts.part) this.blown.fill(0); },
    adopt(o) { if (o.blown && o.blown.length === n) this.blown.set(o.blown); if (o.avg && o.avg.length === n) this.avg.set(o.avg); },
    stamp(S, V, e) {
      for (let k = 0; k < n; k++) {
        const [a, c, vf, rs] = pairs[k];
        // A protected LED gets the trainer board's resistor only if you didn't wire one yourself.
        this.rsEff[k] = rs + (opts.protect && !hasR(e, k) ? opts.protectR : 0);
        if (this.blown[k]) continue;
        if (this.on[k]) S.vdrop(a, c, vf, this.rsEff[k]); else S.G(a, c, OPEN);
      }
    },
    update(V) {
      let changed = false;
      for (let k = 0; k < n; k++) {
        const [a, c, vf] = pairs[k];
        const rs = this.rsEff[k];
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
    commit(V, dt, e) {
      if (opts.part && opts.part.props.damaged) this.blown.fill(1);
      const notes = [];
      for (let k = 0; k < n; k++) {
        const [a, c, vf] = pairs[k];
        const rs = this.rsEff[k];
        const va = a >= 0 ? V[a] : NaN, vc = c >= 0 ? V[c] : NaN;
        if (!this.on[k] || this.blown[k]) {
          this.cur[k] = 0;
          this.over[k] = Math.max(0, this.over[k] - dt);
          if (opts.led && !this.blown[k] && ok(va) && ok(vc) && vc - va > 1) notes.push('LED is backwards — the long leg (anode) must go to the higher voltage.');
        } else {
          const i = Math.max(0, (va - vc - vf) / rs);
          this.cur[k] = i;
          if (opts.maxA && !opts.protect) {
            // A single bad step must never destroy a part: only sustained overload burns it.
            this.over[k] = i > opts.maxA ? this.over[k] + dt : Math.max(0, this.over[k] - dt);
            if (this.over[k] > BURN_TIME) {
              this.blown[k] = 1;
              this.burnText = `${opts.name || 'LED'} burned out — it carried ${(i * 1000).toFixed(0)} mA (rated 20 mA). `
                + (hasR(e, k) ? 'The series resistor is too small: use 220 Ω or more.' : 'Add a 220 Ω – 1 kΩ resistor in series.');
              if (opts.part) { opts.part.props.damaged = 'blown'; this.event = { kind: 'blown', text: this.burnText }; }
            } else if (opts.led && i > 0.03) notes.push(`${(i * 1000).toFixed(0)} mA is above the 20 mA rating — ${hasR(e, k) ? 'use a bigger resistor' : 'add a series resistor'}.`);
          }
        }
        // smoothed current for drawing (PWM looks dim instead of flickering)
        const t = Math.min(1, (dt || 0.016) / 0.03);
        this.avg[k] += (this.cur[k] - this.avg[k]) * t;
      }
      this.warning = this.blown.some(Boolean) ? (this.burnText || opts.blownText || 'Burned out.') : null;
      this.notes = notes.length ? [...new Set(notes)] : null;
      this.infos = opts.protect && this.cur.some(x => x > 0) && !pairs.some((_, k) => hasR(e, k))
        ? ['Protected LED (built-in 330 Ω). A real LED without a series resistor would burn out — see Settings → Simulation.'] : null;
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
    latch: 0, powered: false, vh: 5, vl: 0, decided: false,
    reset() { this.latch = 0; },
    adopt(o) { this.latch = o.latch; },
    // The latch may flip at most once per time step. Re-deciding inside the
    // convergence loop made it chatter (discharge on → THR falls → set → discharge
    // off → THR rises → reset …) and the step never converged.
    begin() { this.decided = false; },
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
      if (next !== this.latch && !this.decided) { this.latch = next; this.decided = true; changed = true; }
      return changed;
    },
    commit(V, dt, e) {
      this.warning = !this.powered && nets.some(n => n >= 0) ? 'No power — pin 8 (VCC) needs +5 V and pin 1 (GND) needs ground.' : null;
      this.notes = this.infos = null;
      if (!this.powered) return;
      // Measure the real output period and duty cycle so the inspector can show them.
      const t = e ? e.time : 0;
      if (this.latch !== this.lastLatch) {
        if (this.latch === 1) {
          if (this.lastRise !== undefined) { this.period = t - this.lastRise; this.duty = (this.highTime || 0) / this.period; }
          this.lastRise = t;
        } else if (this.lastRise !== undefined) this.highTime = t - this.lastRise;
        this.lastLatch = this.latch;
      }
      if (!this.latch && dis >= 0 && gnd >= 0 && ok(V[dis]) && ok(V[gnd])) {
        const idis = (V[dis] - V[gnd]) / 8;
        if (idis > 0.05) this.notes = [`Discharge pin 7 is sinking ${(idis * 1000).toFixed(0)} mA (a 555 handles about 50 mA): Ra is too small — datasheets recommend Ra ≥ 1 kΩ. Frequency ≈ 1.44 / ((Ra + 2·Rb)·C).`];
      }
      if (this.period && t - this.lastRise < 3 * this.period + 0.5) {
        const f = 1 / this.period, p = this.period;
        const ps = p >= 1 ? p.toFixed(2) + ' s' : p >= 1e-3 ? (p * 1e3).toFixed(1) + ' ms' : (p * 1e6).toFixed(0) + ' µs';
        this.infos = [`Output period ${ps} (${f < 10 ? f.toFixed(2) : f.toFixed(0)} Hz), ${Math.round(this.duty * 100)}% high${f > 25 ? ' — too fast to see: an LED will just look steadily on.' : '.'}`];
      }
    },
  };
}

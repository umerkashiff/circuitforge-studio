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

/** Capacitor: electrolytic bursts on reverse polarity/over-voltage; ceramic/film is non-polarized. */
export function capacitor(nets, part) {
  return {
    timeDependent: true,
    vc: 0, stress: 0,
    reset() { this.vc = 0; this.stress = 0; },
    adopt(o) { this.vc = o.vc; this.stress = o.stress || 0; },
    stamp(S, V, e) {
      if (part.props.damaged) return;
      const geq = (part.props.uf * 1e-6) / e.dt;
      S.G(nets[0], nets[1], geq, false);
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
      const polarized = part.props.kind !== 'ceramic';
      const rating = part.props.vmax || (polarized ? 16 : 50);
      const vstress = polarized ? this.vc : Math.abs(this.vc);
      const over = vstress > rating * 1.1, rev = polarized && this.vc < -1.5;
      if (over || rev) this.stress += dt; else this.stress = Math.max(0, this.stress - dt * 0.5);
      this.warning = null;
      this.notes = (polarized && this.vc < -0.3)
        ? ['Capacitor is backwards — the − stripe must go to the lower voltage.']
        : vstress > rating * 0.9
          ? [`${Math.abs(this.vc).toFixed(1)} V is close to the ${rating} V rating.`]
          : null;
      if (this.stress > 0.25) {
        part.props.damaged = 'burst';
        this.event = { kind: 'burst', text: rev ? 'Capacitor burst — it was wired backwards.' : `Capacitor burst — ${Math.abs(this.vc).toFixed(1)} V across a ${rating} V part.` };
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
      if (net(ic.vcc) >= 0 && net(ic.gnd) >= 0) S.G(net(ic.vcc), net(ic.gnd), 1 / 1250);
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

/**
 * NPN BJT transistor (e.g. 2N3904).
 * Pins: [emitterNet, baseNet, collectorNet]
 */
export function bjtNpn(nets, part) {
  const beta = part.props.beta || 150;
  const Vbe_on = 0.68;
  const Rbe = 40;
  const Vce_sat = 0.15;
  const Rsat = 12;

  return {
    analog: true,
    state: 'off',
    ib: 0,
    ic: 0,
    vbe: 0,
    vce: 0,
    reset() { this.state = 'off'; this.ib = 0; this.ic = 0; },
    adopt(o) { this.state = o.state || 'off'; this.ib = o.ib || 0; this.ic = o.ic || 0; },
    stamp(S) {
      const [e, b, c] = nets;
      if (this.state === 'off') {
        S.G(b, e, OPEN, false);
        S.G(c, e, OPEN, false);
      } else if (this.state === 'sat') {
        S.vdrop(b, e, Vbe_on, Rbe);
        S.vdrop(c, e, Vce_sat, Rsat);
      } else {
        S.vdrop(b, e, Vbe_on, Rbe);
        const geff = Math.max(1e-4, Math.min(0.2, (beta * Math.max(1e-5, this.ib)) / Math.max(0.15, this.vce || 1)));
        S.G(c, e, geff, false);
      }
    },
    update(V) {
      const [e, b, c] = nets;
      const ve = e >= 0 && ok(V[e]) ? V[e] : 0;
      const vb = b >= 0 && ok(V[b]) ? V[b] : 0;
      const vc = c >= 0 && ok(V[c]) ? V[c] : 0;

      const vbe = vb - ve;
      const vce = vc - ve;
      this.vbe = vbe;
      this.vce = vce;

      let newState = 'off';
      if (vbe > Vbe_on - 0.05 && vce > -0.2) {
        this.ib = Math.max(0, (vbe - Vbe_on) / Rbe);
        const ic_avail = Math.max(0, (vce - Vce_sat) / Rsat);
        if (vce <= Vce_sat || beta * this.ib >= ic_avail) {
          newState = 'sat';
          this.ic = ic_avail;
        } else {
          newState = 'active';
          this.ic = beta * this.ib;
        }
      } else {
        this.ib = 0;
        this.ic = 0;
      }

      if (newState !== this.state) {
        this.state = newState;
        return true;
      }
      return false;
    },
    commit(V) {
      const [e, b, c] = nets;
      const ve = e >= 0 && ok(V[e]) ? V[e] : 0;
      const vb = b >= 0 && ok(V[b]) ? V[b] : 0;
      const vc = c >= 0 && ok(V[c]) ? V[c] : 0;
      this.vbe = vb - ve;
      this.vce = vc - ve;
      if (this.state === 'off') {
        this.notes = this.vbe < 0.2 ? null : [`Cut-off: Vbe = ${this.vbe.toFixed(2)} V (needs ≥ 0.65 V to conduct)`];
      } else if (this.state === 'sat') {
        this.notes = [`Saturated: Vbe = ${this.vbe.toFixed(2)} V, Vce = ${this.vce.toFixed(2)} V, Ic ≈ ${(this.ic * 1000).toFixed(1)} mA`];
      } else {
        this.notes = [`Active: Vbe = ${this.vbe.toFixed(2)} V, Vce = ${this.vce.toFixed(2)} V, Ib ≈ ${(this.ib * 1000).toFixed(2)} mA, Ic ≈ ${(this.ic * 1000).toFixed(1)} mA`];
      }
    },
  };
}

/**
 * N-channel JFET (e.g. 2N5484).
 * Pins: [drainNet, sourceNet, gateNet]
 */
export function jfetN(nets, part) {
  const vp = part.props.vp || -2.5;
  const idss = part.props.idss || 0.005;
  const rds_on = part.props.rdson || 150;

  return {
    analog: true,
    state: 'on',
    id: 0,
    vds: 0,
    vgs: 0,
    reset() { this.state = 'on'; this.id = 0; },
    adopt(o) { this.state = o.state || 'on'; this.id = o.id || 0; },
    stamp(S) {
      const [d, s, g] = nets;
      S.G(g, s, OPEN, false);
      if (this.state === 'off') {
        S.G(d, s, OPEN, false);
      } else if (this.state === 'linear') {
        S.G(d, s, 1 / rds_on, false);
      } else {
        const geff = Math.max(1e-5, Math.min(0.1, this.id / Math.max(0.15, this.vds || 1)));
        S.G(d, s, geff, false);
      }
    },
    update(V) {
      const [d, s, g] = nets;
      const vd = d >= 0 && ok(V[d]) ? V[d] : 0;
      const vs = s >= 0 && ok(V[s]) ? V[s] : 0;
      const vg = g >= 0 && ok(V[g]) ? V[g] : 0;

      const vgs = vg - vs;
      const vds = vd - vs;
      this.vds = vds;
      this.vgs = vgs;

      let newState = 'off';
      if (vgs <= vp) {
        newState = 'off';
        this.id = 0;
      } else if (vds >= 0) {
        const k = Math.max(0, 1 - vgs / vp);
        const id_sat = idss * k * k;
        if (vds < Math.max(0.05, vgs - vp)) {
          newState = 'linear';
          this.id = Math.min(id_sat, vds / rds_on);
        } else {
          newState = 'sat';
          this.id = id_sat;
        }
      }

      if (newState !== this.state) {
        this.state = newState;
        return true;
      }
      return false;
    },
    commit(V) {
      const [d, s, g] = nets;
      const vd = d >= 0 && ok(V[d]) ? V[d] : 0;
      const vs = s >= 0 && ok(V[s]) ? V[s] : 0;
      const vg = g >= 0 && ok(V[g]) ? V[g] : 0;
      this.vgs = vg - vs;
      this.vds = vd - vs;
      this.notes = [`Vgs = ${this.vgs.toFixed(2)} V, Vds = ${this.vds.toFixed(2)} V, Id ≈ ${(this.id * 1000).toFixed(1)} mA (${this.state.toUpperCase()})`];
    },
  };
}

/**
 * HD44780 16x2 Parallel Character LCD Display.
 * Pins: 0:VSS, 1:VDD, 2:V0, 3:RS, 4:RW, 5:E, 6..13:D0..D7, 14:A, 15:K
 */
export function lcd16x2(nets, part) {
  const [vss, vdd, v0, rs, rw, e, d0, d1, d2, d3, d4, d5, d6, d7, blA, blK] = nets;
  const dPins = [d0, d1, d2, d3, d4, d5, d6, d7];

  return {
    powered: false,
    backlight: false,
    lines: ['', ''],
    addr: 0,
    nibble: null,
    prevE: 0,
    reset() { this.lines = ['', '']; this.addr = 0; this.nibble = null; this.prevE = 0; },
    stamp(S) {
      if (blA >= 0 && blK >= 0) S.vdrop(blA, blK, 2.8, 150);
    },
    update(V) {
      const v_vdd = vdd >= 0 && ok(V[vdd]) ? V[vdd] : 0;
      const v_vss = vss >= 0 && ok(V[vss]) ? V[vss] : 0;
      const powered = (v_vdd - v_vss) >= 4.0;
      let changed = powered !== this.powered;
      this.powered = powered;

      const v_a = blA >= 0 && ok(V[blA]) ? V[blA] : 0;
      const v_k = blK >= 0 && ok(V[blK]) ? V[blK] : 0;
      this.backlight = powered || (v_a - v_k) >= 2.0;

      if (!powered) return changed;

      const currE = (e >= 0 && ok(V[e]) && (V[e] - v_vss) >= 2.0) ? 1 : 0;
      // Clock on falling edge of E
      if (this.prevE === 1 && currE === 0) {
        const isRs = rs >= 0 && ok(V[rs]) && (V[rs] - v_vss) >= 2.0;
        const readBus = () => {
          let val = 0;
          for (let i = 0; i < 8; i++) {
            const p = dPins[i];
            if (p >= 0 && ok(V[p]) && (V[p] - v_vss) >= 2.0) val |= (1 << i);
          }
          return val;
        };

        const bus = readBus();
        const highNibble = (bus >> 4) & 0x0F;

        if (this.nibble === null && (bus & 0x0F) === 0 && dPins.slice(0, 4).every(p => p < 0)) {
          // 4-bit mode: upper nibble first
          this.nibble = highNibble;
        } else {
          let byte = bus;
          if (this.nibble !== null) {
            byte = (this.nibble << 4) | highNibble;
            this.nibble = null;
          }

          if (!isRs) {
            // Command
            if (byte === 0x01) {
              this.lines = ['', ''];
              this.addr = 0;
              changed = true;
            } else if (byte === 0x02) {
              this.addr = 0;
            } else if (byte >= 0x80) {
              const a = byte & 0x7F;
              this.addr = a < 0x40 ? a : 16 + (a - 0x40);
            }
          } else {
            // Data character
            const row = this.addr >= 16 ? 1 : 0;
            const col = this.addr % 16;
            const ch = (byte >= 32 && byte <= 126) ? String.fromCharCode(byte) : ' ';
            let str = (this.lines[row] || '').padEnd(16, ' ');
            str = str.slice(0, col) + ch + str.slice(col + 1);
            this.lines[row] = str;
            this.addr = (this.addr + 1) % 32;
            changed = true;
          }
        }
      }
      this.prevE = currE;
      return changed;
    },
    commit() {
      if (!this.powered) {
        this.warning = nets.some(n => n >= 0) ? 'No power — pin 2 (VDD) needs +5 V and pin 1 (VSS) needs ground.' : null;
      } else {
        this.warning = null;
      }
    },
  };
}

/**
 * Reactive Inductor (Backward Euler companion model with winding ESR Rs).
 * Pins: [aNet, bNet] — positive current `i` flows a -> b.
 */
export function inductor(nets, part) {
  return {
    timeDependent: true,
    i: 0,
    vl: 0,
    reset() { this.i = 0; this.vl = 0; },
    adopt(o) { this.i = o.i || 0; this.vl = o.vl || 0; },
    stamp(S, V, e) {
      const L = (part.props.mh || 10) * 1e-3;
      const rs = part.props.rs || 0.5;
      const dt = Math.max(1e-7, e.dt || 5e-4);
      const geq = dt / (L + rs * dt);
      const ieq = (L / (L + rs * dt)) * this.i;
      S.G(nets[0], nets[1], geq, false);
      S.I(nets[0], nets[1], ieq);
      S.P(nets[0], nets[1], 1 / rs);
    },
    commit(V, dt, e) {
      const a = V[nets[0]], b = V[nets[1]];
      const L = (part.props.mh || 10) * 1e-3;
      const rs = part.props.rs || 0.5;
      const geq = dt / (L + rs * dt);
      const k = L / (L + rs * dt);
      this.vl = (ok(a) && ok(b)) ? a - b : 0;
      this.i = k * this.i + geq * this.vl;
      if (e && e.gsum && nets[0] >= 0 && nets[1] >= 0) {
        const ga = e.gsum[nets[0]] - geq, gb = e.gsum[nets[1]] - geq;
        const r = rs + (ga > 1e-9 ? 1 / ga : 1e9) + (gb > 1e-9 ? 1 / gb : 1e9);
        if (r > 0) e.minTau = Math.min(e.minTau, L / r);
      }
      this.warning = null;
      this.notes = Math.abs(this.i) > 2.0 ? [`High coil current (${this.i.toFixed(2)} A).`] : null;
      this.infos = Math.abs(this.vl) > 24 ? [`Inductive kickback: ${this.vl.toFixed(1)} V across coil — add a flyback diode to clamp voltage.`] : null;
    },
  };
}

/**
 * Zener diode with three piece-wise regions: forward (0.72 V), off, or reverse breakdown (-Vz).
 * Pins: [anodeNet, cathodeNet]
 */
export function zener(nets, part) {
  const vf = 0.72, rf = 10, rz = 4;
  return {
    analog: true,
    state: 'off',
    i: 0,
    vd: 0,
    reset() { this.state = 'off'; this.i = 0; this.vd = 0; },
    adopt(o) { this.state = o.state || 'off'; this.i = o.i || 0; this.vd = o.vd || 0; },
    stamp(S) {
      const [a, c] = nets;
      const vz = part.props.vz || 5.1;
      if (this.state === 'fwd') S.vdrop(a, c, vf, rf);
      else if (this.state === 'zener') S.vdrop(c, a, vz, rz);
      else S.G(a, c, OPEN, false);
    },
    update(V) {
      const [a, c] = nets;
      const vz = part.props.vz || 5.1;
      const wired = a >= 0 && c >= 0 && ok(V[a]) && ok(V[c]);
      const vd = wired ? V[a] - V[c] : 0;
      this.vd = vd;
      let next = 'off';
      if (wired) {
        if (this.state === 'fwd' ? (vd - vf) / rf > 5e-7 : vd > vf) next = 'fwd';
        else if (this.state === 'zener' ? -(vd + vz) / rz > 5e-7 : vd < -vz) next = 'zener';
      }
      if (next !== this.state) { this.state = next; return true; }
      return false;
    },
    commit(V) {
      const [a, c] = nets;
      const vz = part.props.vz || 5.1;
      const wired = a >= 0 && c >= 0 && ok(V[a]) && ok(V[c]);
      this.vd = wired ? V[a] - V[c] : 0;
      this.i = !wired ? 0
        : this.state === 'fwd' ? (this.vd - vf) / rf
        : this.state === 'zener' ? (this.vd + vz) / rz
        : 0;
      const p = Math.abs(this.i * this.vd);
      const pmax = part.props.pmax || 0.5;
      this.warning = p > pmax * 1.5 ? `Zener overheating (${p.toFixed(2)} W > ${pmax} W) — add a series resistor.` : null;
      this.notes = null;
      this.infos = this.state === 'zener'
        ? [`Zener clamping at Vz = ${(-this.vd).toFixed(2)} V (Iz ≈ ${(-this.i * 1000).toFixed(1)} mA)`]
        : this.state === 'fwd'
          ? [`Forward conducting: ${(this.i * 1000).toFixed(1)} mA`]
          : null;
    },
  };
}

/**
 * PNP BJT (e.g. 2N3906, BC557). Pins: [emitterNet, baseNet, collectorNet].
 */
export function bjtPnp(nets, part) {
  const beta = part.props.beta || 150;
  const Veb_on = 0.68, Rbe = 40, Vec_sat = 0.15, Rsat = 12;
  return {
    analog: true,
    state: 'off',
    ib: 0,
    ic: 0,
    veb: 0,
    vec: 0,
    reset() { this.state = 'off'; this.ib = 0; this.ic = 0; },
    adopt(o) { this.state = o.state || 'off'; this.ib = o.ib || 0; this.ic = o.ic || 0; },
    stamp(S) {
      const [e, b, c] = nets;
      if (this.state === 'off') {
        S.G(e, b, OPEN, false);
        S.G(e, c, OPEN, false);
      } else if (this.state === 'sat') {
        S.vdrop(e, b, Veb_on, Rbe);
        S.vdrop(e, c, Vec_sat, Rsat);
      } else {
        S.vdrop(e, b, Veb_on, Rbe);
        const geff = Math.max(OPEN, Math.min(0.2, (beta * Math.max(0, this.ib)) / Math.max(0.15, this.vec || 1)));
        S.G(e, c, geff, false);
      }
    },
    update(V) {
      const [e, b, c] = nets;
      const eOk = e >= 0 && ok(V[e]), bOk = b >= 0 && ok(V[b]), cOk = c >= 0 && ok(V[c]);
      const ve = eOk ? V[e] : 0;
      const vb = bOk ? V[b] : ve;
      const vc = cOk ? V[c] : ve;
      const veb = (eOk && bOk) ? ve - vb : 0;
      const vec = (eOk && cOk) ? ve - vc : 0;
      this.veb = veb; this.vec = vec;
      let next = 'off';
      const ibCalc = Math.max(0, (veb - Veb_on) / Rbe);
      const minOnVeb = this.state === 'off' ? Veb_on - 0.03 : Veb_on - 0.05;
      const hasDrive = this.state === 'off' ? (veb > minOnVeb) : (veb > minOnVeb && ibCalc >= 5e-7);
      if (hasDrive && vec > -0.2) {
        this.ib = ibCalc;
        const ic_avail = Math.max(0, (vec - Vec_sat) / Rsat);
        if (vec <= Vec_sat || beta * this.ib >= ic_avail) { next = 'sat'; this.ic = ic_avail; }
        else { next = 'active'; this.ic = beta * this.ib; }
      } else {
        this.ib = 0; this.ic = 0;
      }
      if (next !== this.state) { this.state = next; return true; }
      return false;
    },
    commit(V) {
      const [e, b, c] = nets;
      const ve = e >= 0 && ok(V[e]) ? V[e] : 0;
      const vb = b >= 0 && ok(V[b]) ? V[b] : 0;
      const vc = c >= 0 && ok(V[c]) ? V[c] : 0;
      this.veb = ve - vb; this.vec = ve - vc;
      if (this.state === 'off') {
        this.notes = this.veb < 0.2 ? null : [`Cut-off: Veb = ${this.veb.toFixed(2)} V (needs ≥ 0.65 V to conduct)`];
      } else if (this.state === 'sat') {
        this.notes = [`Saturated: Veb = ${this.veb.toFixed(2)} V, Vec = ${this.vec.toFixed(2)} V, Ic ≈ ${(this.ic * 1000).toFixed(1)} mA`];
      } else {
        this.notes = [`Active: Veb = ${this.veb.toFixed(2)} V, Vec = ${this.vec.toFixed(2)} V, Ib ≈ ${(this.ib * 1000).toFixed(2)} mA, Ic ≈ ${(this.ic * 1000).toFixed(1)} mA`];
      }
    },
  };
}

/**
 * Enhancement-mode MOSFET (NMOS / PMOS) with insulated gate and intrinsic body diode.
 * Unified pinout: [gateNet, drainNet, sourceNet].
 */
export function mosfet(nets, part, isPmos = false) {
  return {
    analog: true,
    state: 'off',
    bodyOn: false,
    id: 0,
    vgs: 0,
    vds: 0,
    ron: 1,
    reset() { this.state = 'off'; this.bodyOn = false; this.id = 0; },
    adopt(o) { this.state = o.state || 'off'; this.bodyOn = !!o.bodyOn; this.id = o.id || 0; },
    stamp(S) {
      const [g, d, s] = nets;
      const vth = Math.abs(part.props.vth || (isPmos ? 2.2 : 2.0));
      const kp = part.props.kp || 0.25;
      const rdson = part.props.rdson || 1.8;
      S.G(g, s, OPEN, false);
      S.G(g, d, OPEN, false);
      if (this.bodyOn) S.vdrop(isPmos ? d : s, isPmos ? s : d, 0.72, 1.0);
      if (this.state === 'off') {
        S.G(d, s, OPEN, false);
      } else if (this.state === 'linear') {
        const vov = Math.max(0.05, (isPmos ? -this.vgs : this.vgs) - vth);
        this.ron = rdson + 1 / (kp * vov);
        S.G(d, s, 1 / this.ron, false);
      } else {
        const vdsMag = Math.max(0.1, isPmos ? -this.vds : this.vds);
        const geff = Math.min(1 / rdson, Math.max(1e-5, this.id / vdsMag));
        S.G(d, s, geff, false);
      }
    },
    update(V) {
      const [g, d, s] = nets;
      const gOk = g >= 0 && ok(V[g]), dOk = d >= 0 && ok(V[d]), sOk = s >= 0 && ok(V[s]);
      const vs = sOk ? V[s] : 0;
      const vg = gOk ? V[g] : vs;
      const vd = dOk ? V[d] : vs;
      const vth = Math.abs(part.props.vth || (isPmos ? 2.2 : 2.0));
      const kp = part.props.kp || 0.25;
      const rdson = part.props.rdson || 1.8;
      this.vgs = (gOk && sOk) ? vg - vs : 0;
      this.vds = (dOk && sOk) ? vd - vs : 0;

      const vdrive = (gOk && sOk) ? (isPmos ? (vs - vg) : (vg - vs)) : 0;
      const vdrop = (dOk && sOk) ? (isPmos ? (vs - vd) : (vd - vs)) : 0;
      const vbody = (dOk && sOk) ? (isPmos ? (vd - vs) : (vs - vd)) : 0;
      const nextBody = vbody > (this.bodyOn ? 0.65 : 0.72);

      let next = 'off', idNew = 0;
      const vov = vdrive - vth;
      if (vov > 0 && vdrop > 0) {
        if (vdrop < vov) {
          next = 'linear';
          const ron = rdson + 1 / (kp * vov);
          idNew = vdrop / ron;
        } else {
          next = 'sat';
          idNew = Math.min(vdrop / rdson, 0.5 * kp * vov * vov);
        }
      }
      const idChanged = next === 'sat' && Math.abs(idNew - this.id) / Math.max(1e-4, this.id) > 0.05;
      const changed = next !== this.state || nextBody !== this.bodyOn || idChanged;
      this.state = next;
      this.bodyOn = nextBody;
      this.id = idNew;
      return changed;
    },
    commit(V) {
      const [g, d, s] = nets;
      const vg = g >= 0 && ok(V[g]) ? V[g] : 0;
      const vd = d >= 0 && ok(V[d]) ? V[d] : 0;
      const vs = s >= 0 && ok(V[s]) ? V[s] : 0;
      this.vgs = vg - vs;
      this.vds = vd - vs;
      if (this.state === 'linear') this.id = (isPmos ? -this.vds : this.vds) / this.ron;
      else if (this.state === 'off') this.id = 0;
      const vth = Math.abs(part.props.vth || (isPmos ? 2.2 : 2.0));
      this.notes = this.state === 'off'
        ? [`Cut-off: Vgs = ${this.vgs.toFixed(2)} V (threshold ${isPmos ? '-' : ''}${vth.toFixed(1)} V)`]
        : [`${this.state === 'linear' ? 'Triode' : 'Saturation'}: Vgs = ${this.vgs.toFixed(2)} V, Vds = ${this.vds.toFixed(2)} V, Id ≈ ${(this.id * 1000).toFixed(1)} mA`];
    },
  };
}

/**
 * Operational Amplifier IC (LM741 single or LM358 dual in DIP-8).
 * Stamps linear VCCS directly into MNA matrices so negative feedback converges in 1 pass.
 */
export function opamp(nets, part, count = 1) {
  const is741 = count === 1;
  const vpIdx = is741 ? 6 : 7;
  const vnIdx = 3;
  const channels = is741
    ? [{ inN: 1, inP: 2, out: 5 }]
    : [{ inP: 2, inN: 1, out: 0 }, { inP: 4, inN: 5, out: 6 }];
  const minSupply = is741 ? 4.5 : 3.0;
  const headHi = is741 ? 1.2 : 1.3;
  const headLo = is741 ? 1.2 : 0.05;
  const Aol = 4000, Rout = 50, Gout = 1 / Rout, gm = Aol * Gout;

  const chStates = channels.map(() => ({ mode: 'linear', vout: 0 }));
  return {
    analog: true,
    powered: false,
    chStates,
    reset() { this.powered = false; for (const c of chStates) { c.mode = 'linear'; c.vout = 0; } },
    adopt(o) {
      if (o && o.chStates) {
        for (let i = 0; i < Math.min(chStates.length, o.chStates.length); i++) {
          chStates[i].mode = o.chStates[i].mode || 'linear';
          chStates[i].vout = o.chStates[i].vout || 0;
        }
      }
    },
    stamp(S, V, e) {
      const vp = nets[vpIdx], vn = nets[vnIdx];
      const v_vp = vp >= 0 && ok(V[vp]) ? V[vp] : NaN;
      const v_vn = vn >= 0 && ok(V[vn]) ? V[vn] : NaN;
      const pwr = ok(v_vp) && ok(v_vn) && (v_vp - v_vn) >= minSupply;

      for (let i = 0; i < channels.length; i++) {
        const ch = channels[i];
        const inP = nets[ch.inP], inN = nets[ch.inN], out = nets[ch.out];
        const connected = !e || e.isNetConnected(inP) || e.isNetConnected(inN) || e.isNetConnected(out);
        if (!pwr || !connected || inP < 0 || inN < 0 || out < 0) {
          if (out >= 0 && vn >= 0) S.G(out, vn, OPEN, false);
          continue;
        }
        S.G(inP, vn, 1e-7, false);
        S.G(inN, vn, 1e-7, false);
        const span = v_vp - v_vn;
        const st = chStates[i].mode;
        if (st === 'sat_high') {
          S.vdrop(out, vn, Math.max(headLo, span - headHi), Rout);
        } else if (st === 'sat_low') {
          S.vdrop(out, vn, headLo, Rout);
        } else {
          const vMidOff = 0.5 * (span + headLo - headHi);
          S.vdrop(out, vn, vMidOff, Rout);
          S.vccs(vn, out, inP, inN, gm);
        }
      }
    },
    update(V, e) {
      const vp = nets[vpIdx], vn = nets[vnIdx];
      const v_vp = vp >= 0 && ok(V[vp]) ? V[vp] : NaN;
      const v_vn = vn >= 0 && ok(V[vn]) ? V[vn] : NaN;
      const pwr = ok(v_vp) && ok(v_vn) && (v_vp - v_vn) >= minSupply;
      const wasPowered = this.powered;
      let changed = pwr !== wasPowered;
      this.powered = pwr;

      if (!pwr) {
        for (const st of chStates) {
          if (st.mode !== 'linear') { st.mode = 'linear'; changed = true; }
          st.vout = 0;
        }
        return changed;
      }

      // First iteration after becoming powered must start in 'linear' so gaussSolve finds the true feedback point.
      if (!wasPowered) {
        for (const st of chStates) {
          if (st.mode !== 'linear') st.mode = 'linear';
          st.vout = 0;
        }
        return true;
      }

      const hiRail = v_vp - headHi, loRail = v_vn + headLo;
      const vMidOff = 0.5 * ((v_vp - v_vn) + headLo - headHi);
      for (let i = 0; i < channels.length; i++) {
        const ch = channels[i], st = chStates[i];
        const inP = nets[ch.inP], inN = nets[ch.inN], out = nets[ch.out];
        const connected = !e || e.isNetConnected(inP) || e.isNetConnected(inN) || e.isNetConnected(out);
        if (!connected || inP < 0 || inN < 0 || out < 0) {
          if (st.mode !== 'linear') { st.mode = 'linear'; changed = true; }
          continue;
        }
        const vpIn = ok(V[inP]) ? V[inP] : v_vn;
        const vnIn = ok(V[inN]) ? V[inN] : v_vn;
        const vOut = ok(V[out]) ? V[out] : v_vn + vMidOff;
        st.vout = vOut;
        const vLin = v_vn + vMidOff + Aol * (vpIn - vnIn);
        let next = st.mode;
        if (st.mode === 'linear') {
          if (vOut > hiRail + 0.01) next = 'sat_high';
          else if (vOut < loRail - 0.01) next = 'sat_low';
        } else if (st.mode === 'sat_high') {
          if (vLin < hiRail - 0.05) next = 'linear';
        } else {
          if (vLin > loRail + 0.05) next = 'linear';
        }
        if (next !== st.mode) { st.mode = next; changed = true; }
      }
      return changed;
    },
    commit(V, dt, e) {
      this.warning = null;
      this.notes = null;
      this.infos = null;
      const anyWired = e
        ? nets.some(n => e.isNetConnected(n))
        : nets.some(n => n >= 0);
      if (!this.powered) {
        this.notes = anyWired ? [`Not powered — connect V+ (pin ${vpIdx + 1}) and V− (pin 4), ≥ ${minSupply} V apart.`] : null;
        return;
      }
      const infos = [];
      for (let i = 0; i < channels.length; i++) {
        const ch = channels[i];
        const inP = nets[ch.inP], inN = nets[ch.inN], out = nets[ch.out];
        const connected = !e || e.isNetConnected(inP) || e.isNetConnected(inN) || e.isNetConnected(out);
        if (connected && out >= 0 && ok(V[out])) {
          chStates[i].vout = V[out];
          infos.push(`${channels.length > 1 ? `Ch${i + 1}: ` : ''}Vout = ${V[out].toFixed(2)} V (${chStates[i].mode})`);
        }
      }
      this.infos = infos.length ? infos : null;
    },
  };
}

/**
 * Dual Open-Collector Comparator (LM393 DIP-8).
 * Pulls output low (to GND/V- through ~18 Ω) when IN+ < IN−; open-circuit when IN+ > IN−.
 */
export function comparator(nets) {
  const vpIdx = 7, vnIdx = 3;
  const channels = [{ inP: 2, inN: 1, out: 0 }, { inP: 4, inN: 5, out: 6 }];
  const low = new Uint8Array(2);
  return {
    analog: true,
    powered: false,
    low,
    reset() { this.powered = false; low.fill(0); },
    adopt(o) { if (o && o.low) low.set(o.low); },
    stamp(S) {
      const vn = nets[vnIdx];
      for (let i = 0; i < 2; i++) {
        const ch = channels[i];
        const inP = nets[ch.inP], inN = nets[ch.inN], out = nets[ch.out];
        if (inP >= 0 && vn >= 0) S.G(inP, vn, OPEN, false);
        if (inN >= 0 && vn >= 0) S.G(inN, vn, OPEN, false);
        if (this.powered && out >= 0 && vn >= 0 && low[i]) S.vdrop(out, vn, 0.12, 18);
        else if (out >= 0 && vn >= 0) S.G(out, vn, OPEN, false);
      }
    },
    update(V, e) {
      const vp = nets[vpIdx], vn = nets[vnIdx];
      const pwr = vp >= 0 && vn >= 0 && ok(V[vp]) && ok(V[vn]) && (V[vp] - V[vn]) >= 2.0;
      let changed = pwr !== this.powered;
      this.powered = pwr;
      for (let i = 0; i < 2; i++) {
        const ch = channels[i];
        const inP = nets[ch.inP], inN = nets[ch.inN], out = nets[ch.out];
        const connected = !e || ((e.isNetConnected(inP) || e.isNetConnected(inN)) && e.isNetConnected(out));
        let next = 0;
        if (pwr && connected && inP >= 0 && inN >= 0 && out >= 0 && ok(V[inP]) && ok(V[inN])) {
          const diff = V[inP] - V[inN];
          next = diff < (low[i] ? 0.0025 : -0.0025) ? 1 : 0;
        }
        if (next !== low[i]) { low[i] = next; changed = true; }
      }
      return changed;
    },
    commit(V, dt, e) {
      this.warning = null;
      this.notes = null;
      this.infos = null;
      const anyWired = e ? nets.some(n => e.isNetConnected(n)) : nets.some(n => n >= 0);
      if (!this.powered) {
        this.notes = anyWired ? ['Not powered — connect pin 8 (VCC) and pin 4 (GND).'] : null;
        return;
      }
      const infos = [];
      for (let i = 0; i < 2; i++) {
        const ch = channels[i];
        const out = nets[ch.out], inP = nets[ch.inP], inN = nets[ch.inN];
        const chWired = e
          ? (e.isNetConnected(out) && (e.isNetConnected(inP) || e.isNetConnected(inN)))
          : (out >= 0 && (inP >= 0 || inN >= 0));
        if (chWired) {
          infos.push(`Ch${i + 1}: ${low[i] ? 'LOW (sinking to GND)' : 'HIGH-Z (open collector)'}`);
          if (!low[i] && (!ok(V[out]) || (e && !e.resistorNets.has(out)))) {
            infos.push(`LM393 Ch${i + 1} has an open-collector output — add a pull-up resistor to VCC if output cannot rise.`);
          }
        }
      }
      this.infos = infos.length ? infos : null;
    },
  };
}

/**
 * Linear Voltage Regulator:
 * - 'lm7805': pins [IN, GND, OUT], fixed Vreg (default 5.0 V) with 2.0 V dropout & input current mirror.
 * - 'lm317':  pins [ADJ, OUT, IN], adjustable Vout - Vadj = 1.25 V via MNA VCCS error amplifier.
 */
export function regulator(nets, part) {
  const is317 = part.type === 'lm317';
  return {
    analog: true,
    active: false,
    dropout: false,
    vtarget: 0,
    iload: 0,
    vout: 0,
    reset() { this.active = false; this.dropout = false; this.vtarget = 0; this.iload = 0; this.vout = 0; },
    adopt(o) { this.active = !!o.active; this.dropout = !!o.dropout; this.vtarget = o.vtarget || 0; this.iload = o.iload || 0; },
    stamp(S) {
      if (!is317) {
        const [vin, gnd, vout] = nets;
        if (!this.active || vin < 0 || gnd < 0 || vout < 0) return;
        S.vdrop(vout, gnd, this.vtarget, 0.08);
        S.I(vin, gnd, 0.005 + Math.max(0, Math.min(1.5, this.iload)));
      } else {
        const [adj, vout, vin] = nets;
        if (!this.active || vin < 0 || vout < 0) return;
        const gm = 12.5; // Rout = 0.08 Ω
        if (this.dropout || adj < 0) {
          S.vdrop(vin, vout, 2.0, 0.15);
        } else {
          S.vccs(vin, vout, adj, vout, gm);
          S.I(vin, vout, gm * 1.25);
          S.I(vin, adj, 50e-6);
        }
      }
    },
    update(V) {
      if (!is317) {
        const [vin, gnd, vout] = nets;
        const vreg = part.props.vreg || 5.0;
        const vi = vin >= 0 && ok(V[vin]) ? V[vin] : NaN;
        const vg = gnd >= 0 && ok(V[gnd]) ? V[gnd] : NaN;
        const head = (ok(vi) && ok(vg)) ? (vi - vg - 2.0) : -1;
        const nextActive = vin >= 0 && gnd >= 0 && vout >= 0 && head > 0.3;
        const nextVt = nextActive ? Math.min(vreg, head) : 0;
        const vo = vout >= 0 && ok(V[vout]) ? V[vout] : (vg + nextVt);
        const nextI = nextActive ? Math.max(0, Math.min(1.5, (vg + nextVt - vo) / 0.08)) : 0;
        const nextDrop = nextActive && head < vreg - 0.05;
        const changed = nextActive !== this.active || Math.abs(nextVt - this.vtarget) > 0.01 || Math.abs(nextI - this.iload) > 0.002;
        this.active = nextActive; this.vtarget = nextVt; this.iload = nextI; this.dropout = nextDrop;
        return changed;
      } else {
        const [adj, vout, vin] = nets;
        const vi = vin >= 0 && ok(V[vin]) ? V[vin] : NaN;
        const va = adj >= 0 && ok(V[adj]) ? V[adj] : 0;
        const head = ok(vi) ? (vi - va - 2.0) : -1;
        const nextActive = vin >= 0 && vout >= 0 && ok(vi) && head > 0.2;
        const nextDrop = adj < 0 || head < (this.dropout ? 1.30 : 1.25);
        const changed = nextActive !== this.active || nextDrop !== this.dropout;
        this.active = nextActive; this.dropout = nextDrop;
        return changed;
      }
    },
    commit(V) {
      if (!is317) {
        const [vin, gnd, vout] = nets;
        const vi = vin >= 0 && ok(V[vin]) ? V[vin] : NaN;
        const vg = gnd >= 0 && ok(V[gnd]) ? V[gnd] : 0;
        const vo = vout >= 0 && ok(V[vout]) ? V[vout] : NaN;
        this.vout = ok(vo) ? vo - vg : 0;
        this.warning = null;
        this.notes = !this.active
          ? (vin >= 0 && vout >= 0 ? [`In dropout/off — needs Vin > ${((part.props.vreg || 5.0) + 2).toFixed(1)} V relative to GND.`] : null)
          : this.dropout
            ? [`Low headroom (Vin−GND=${(vi - vg).toFixed(2)} V): Vout drops to ${this.vout.toFixed(2)} V.`]
            : null;
        this.infos = (this.active && !this.dropout)
          ? [`Regulating ${(part.props.vreg || 5.0).toFixed(1)} V (Iout ≈ ${(this.iload * 1000).toFixed(1)} mA)`]
          : null;
      } else {
        const [adj, vout, vin] = nets;
        const vo = vout >= 0 && ok(V[vout]) ? V[vout] : NaN;
        const va = adj >= 0 && ok(V[adj]) ? V[adj] : 0;
        this.vout = ok(vo) ? vo : 0;
        this.warning = null;
        this.notes = !this.active
          ? (vin >= 0 && vout >= 0 ? ['LM317 off — connect IN ≥ 3.3 V above ADJ.'] : null)
          : this.dropout ? [`LM317 in dropout: Vout = ${this.vout.toFixed(2)} V`] : null;
        this.infos = (this.active && !this.dropout)
          ? [`Vout = ${this.vout.toFixed(2)} V (Vout−Vadj = ${(this.vout - va).toFixed(2)} V)`]
          : null;
      }
    },
  };
}

/**
 * Optocoupler (PC817, DIP-4). Pins: [A, K, E, C].
 * Input IR LED triggers electrically isolated output NPN phototransistor without crossing ground domains.
 */
export function optocoupler(nets, part) {
  const vf = 1.2, rf = 15, vceSat = 0.15, rsat = 12;
  return {
    analog: true,
    ledOn: false,
    outState: 'off',
    ifwd: 0,
    ic: 0,
    vce: 0,
    reset() { this.ledOn = false; this.outState = 'off'; this.ifwd = 0; this.ic = 0; },
    adopt(o) { this.ledOn = !!o.ledOn; this.outState = o.outState || 'off'; this.ifwd = o.ifwd || 0; this.ic = o.ic || 0; },
    stamp(S) {
      const [a, k, e, c] = nets;
      if (this.ledOn) S.vdrop(a, k, vf, rf); else S.G(a, k, OPEN, false);
      if (this.outState === 'off') S.G(c, e, OPEN, false);
      else if (this.outState === 'sat') S.vdrop(c, e, vceSat, rsat);
      else {
        const ctr = part.props.ctr || 1.0;
        const geff = Math.max(OPEN, Math.min(0.1, (ctr * Math.max(0, this.ifwd)) / Math.max(0.15, this.vce || 1)));
        S.G(c, e, geff, false);
      }
    },
    update(V) {
      const [a, k, e, c] = nets;
      const ctr = part.props.ctr || 1.0;
      const vd = (a >= 0 && k >= 0 && ok(V[a]) && ok(V[k])) ? (V[a] - V[k]) : 0;
      const ifwdCalc = (vd - vf) / rf;
      const nextLed = this.ledOn ? (ifwdCalc > 5e-7) : (vd > vf);
      this.ifwd = nextLed ? Math.max(0, ifwdCalc) : 0;

      let nextOut = 'off', icNew = 0;
      const vce = (c >= 0 && e >= 0 && ok(V[c]) && ok(V[e])) ? (V[c] - V[e]) : 0;
      this.vce = vce;
      if (nextLed && vce > -0.2) {
        const icTarget = ctr * this.ifwd;
        const icAvail = Math.max(0, (vce - vceSat) / rsat);
        if (vce <= vceSat || icTarget >= icAvail) { nextOut = 'sat'; icNew = icAvail; }
        else { nextOut = 'active'; icNew = icTarget; }
      }
      const changed = nextLed !== this.ledOn || nextOut !== this.outState;
      this.ledOn = nextLed;
      this.outState = nextOut;
      this.ic = icNew;
      return changed;
    },
    commit() {
      this.warning = this.ifwd > 0.06 ? `PC817 input LED over-current (${(this.ifwd * 1000).toFixed(1)} mA > 60 mA) — add a series resistor.` : null;
      this.notes = this.ledOn
        ? [`Isolated link ON: If = ${(this.ifwd * 1000).toFixed(1)} mA → output ${this.outState} (Ic ≈ ${(this.ic * 1000).toFixed(1)} mA)`]
        : null;
    },
  };
}

function formatDmmDisplay(mode, val, liveBlocked) {
  if (liveBlocked) return 'LIVE V!';
  if (mode === 'dcv') {
    if (!Number.isFinite(val)) return '---- V';
    return Math.abs(val) < 1 ? `${(val * 1000).toFixed(1)} mV` : `${val.toFixed(2)} V`;
  }
  if (mode === 'dca') {
    if (!Number.isFinite(val)) return '---- mA';
    return Math.abs(val) >= 1 ? `${val.toFixed(2)} A` : `${(val * 1000).toFixed(1)} mA`;
  }
  if (!Number.isFinite(val)) return 'OL';
  if (val < 999.95) return `${val.toFixed(1)} Ω`;
  if (val < 999950) return `${(val / 1e3).toFixed(2)} kΩ`;
  return `${(val / 1e6).toFixed(2)} MΩ`;
}

/**
 * Handheld Digital Multimeter (DMM). Pins: [RED (+), BLK (COM)].
 * Supports differential DCV (10 MΩ), inline DCA (0.1 Ω shunt), unpowered OHM, and < 50 Ω Continuity Beep.
 */
export function multimeter(nets, part) {
  return {
    mode: part.props.mode || 'dcv',
    value: NaN,
    display: '---- V',
    liveBlocked: false,
    beep: false,
    reset() {
      this.mode = part.props.mode || 'dcv';
      this.value = NaN;
      this.display = formatDmmDisplay(this.mode, NaN, false);
      this.liveBlocked = false;
      this.beep = false;
    },
    adopt(o) {
      if (o) {
        this.value = o.value;
        this.display = o.display || this.display;
        this.liveBlocked = !!o.liveBlocked;
        this.beep = !!o.beep;
      }
    },
    stamp(S) {
      const [p, n] = nets;
      const mode = part.props.mode || 'dcv';
      if (mode === 'dcv') S.G(p, n, 1e-7, false);
      else if (mode === 'dca') S.G(p, n, 1 / 0.1, false);
      else S.G(p, n, OPEN, false);
    },
    commit(V, dt, e) {
      const [p, n] = nets;
      const mode = part.props.mode || 'dcv';
      this.mode = mode;
      if (part.props.hold) {
        this.beep = false;
        return;
      }
      this.warning = null;
      this.liveBlocked = false;
      this.beep = false;
      const bothOk = p >= 0 && n >= 0 && ok(V[p]) && ok(V[n]);
      if (mode === 'dcv') {
        this.value = bothOk ? (V[p] - V[n]) : NaN;
      } else if (mode === 'dca') {
        this.value = bothOk ? (V[p] - V[n]) / 0.1 : NaN;
        if (Number.isFinite(this.value) && Math.abs(this.value) > 2.0) {
          this.warning = `DMM over-current (${Math.abs(this.value).toFixed(2)} A > 2 A fused limit).`;
        }
      } else {
        const res = e && e.measureOhms ? e.measureOhms(p, n) : { live: false, ohms: Infinity };
        if (res.live) {
          this.liveBlocked = true;
          this.value = NaN;
          this.warning = 'Disconnect circuit power before measuring resistance / continuity (LIVE V!).';
        } else {
          this.value = res.ohms;
          this.beep = mode === 'cont' && Number.isFinite(res.ohms) && res.ohms < 50;
        }
      }
      this.display = formatDmmDisplay(mode, this.value, this.liveBlocked);
      this.notes = null;
      this.infos = this.liveBlocked ? null : [`DMM (${mode.toUpperCase()}): ${this.display}`];
    },
  };
}



/**
 * Microcontroller device: runs a compiled sketch in simulated time and
 * drives/reads the board's pins through the circuit engine.
 */
import { compile, SketchError } from './transpile.js';

const ok = (v) => !Number.isNaN(v);
const R_OUT = 25, R_PULL = 40000;
const PWM_PERIOD = 0.01;        // simulated PWM period (s) — slow enough to resolve with 0.5 ms steps
const TICK_BUDGET = 60;         // loop() iterations / cooperative yields per step

// Arduino String helpers on JS strings
for (const [k, fn] of Object.entries({
  toInt() { return parseInt(this, 10) || 0; },
  toFloat() { return parseFloat(this) || 0; },
  toDouble() { return parseFloat(this) || 0; },
  c_str() { return String(this); },
  equals(s) { return String(this) === String(s); },
  equalsIgnoreCase(s) { return String(this).toLowerCase() === String(s).toLowerCase(); },
  compareTo(s) { return String(this) < s ? -1 : String(this) > s ? 1 : 0; },
})) if (!String.prototype[k]) Object.defineProperty(String.prototype, k, { value: fn, enumerable: false });

function fmtNum(v, f) {
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v !== 'number') return String(v);
  if (f === 16 || f === 2 || f === 8) return (v >>> 0).toString(f).toUpperCase();
  if (typeof f === 'number' && f !== 10) return v.toFixed(f);
  if (f === 10) return String(Math.trunc(v));
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}
function printf(fmt, ...args) {
  let i = 0;
  return String(fmt).replace(/%([-0 +#]*)(\d*)(?:\.(\d+))?(l{0,2}|h{0,2})([diufsxXcp%])/g, (m, fl, w, prec, _l, t) => {
    if (t === '%') return '%';
    const a = args[i++];
    let s;
    if (t === 'd' || t === 'i' || t === 'u') s = String(Math.trunc(a));
    else if (t === 'f') s = Number(a).toFixed(prec ? +prec : 6);
    else if (t === 'x') s = (a >>> 0).toString(16);
    else if (t === 'X') s = (a >>> 0).toString(16).toUpperCase();
    else if (t === 'c') s = typeof a === 'number' ? String.fromCharCode(a) : String(a);
    else s = String(a);
    if (w && s.length < +w) s = (fl.includes('-') ? s.padEnd(+w) : s.padStart(+w, fl.includes('0') ? '0' : ' '));
    return s;
  });
}

export function mcuDevice(board, part, nets) {
  const d = {
    timeDependent: true,
    board,
    nets,
    rt: null,
    reset() { this.rt = null; },
    adopt(o) { if (o.rt && o.rt.src === part.props.code && o.rt.boardType === board.type) { this.rt = o.rt; this.rt.dev = this; } },
    ensure(engine) {
      if (!this.rt) this.rt = makeRuntime(board, part, this, engine);
      return this.rt;
    },
    begin(engine) {
      const rt = this.ensure(engine);
      rt.run(engine);
    },
    stamp(S, V, engine) {
      const rt = this.rt;
      for (let i = 0; i < board.pins.length; i++) {
        const pin = board.pins[i], net = nets[i];
        if (net < 0) continue;
        if (pin.kind === '5V') S.src(net, 5, 0.1);
        else if (pin.kind === '3V3') S.src(net, 3.3, 0.2);
        else if (pin.kind === 'GND') S.src(net, 0, 0.05);
        else if (pin.kind === 'io' && rt) {
          const g = pin.gpio;
          const m = rt.modes.get(g);
          if (m === 'out') S.src(net, rt.level(g, engine.time) ? board.vcc : 0, R_OUT);
          else if (m === 'pu') S.src(net, board.vcc, R_PULL);
          else if (m === 'pd') S.src(net, 0, R_PULL);
        }
      }
    },
    commit() {
      const rt = this.rt;
      this.warning = rt && rt.error ? 'Sketch stopped: ' + rt.error : null;
      this.notes = rt && rt.notes.length ? rt.notes : null;
    },
  };
  return d;
}

function makeRuntime(board, part, dev, engine) {
  const pinsByGpio = new Map();
  board.pins.forEach((p, i) => { if (p.kind === 'io') { if (!pinsByGpio.has(p.gpio)) pinsByGpio.set(p.gpio, []); pinsByGpio.get(p.gpio).push(i); } });
  const rt = {
    src: part.props.code,
    boardType: board.type,
    dev,
    modes: new Map(), outs: new Map(), pwm: new Map(), tones: new Map(), ledc: new Map(), ledcRes: new Map(),
    rgb: null,
    boot: engine.time, now: engine.time, wake: 0,
    gen: null, error: null, errorLine: null, notes: [],
    serial: [], serialIn: '', baud: 0,
    written: new Set(),
    lastLevels: new Map(), isr: [],
    wifiAt: null,
    level(g, t) {
      const tone = this.tones.get(g);
      if (tone) return Math.floor(t * tone * 2) % 2;
      const duty = this.pwm.get(g);
      if (duty !== undefined) return duty >= 1 ? 1 : duty <= 0 ? 0 : ((t % PWM_PERIOD) / PWM_PERIOD < duty ? 1 : 0);
      return this.outs.get(g) || 0;
    },
    volts(g) {
      const idx = pinsByGpio.get(g);
      if (!idx) return NaN;
      const n = this.dev.nets[idx[0]];
      return n >= 0 ? engine.V[n] : NaN;
    },
    print(s, color) {
      const last = this.serial[this.serial.length - 1];
      if (!color && last && !last.color && !last.done) last.text += s;
      else this.serial.push({ text: s, color });
      if (s.endsWith('\n') && this.serial.length) this.serial[this.serial.length - 1].done = true;
      if (this.serial.length > 600) this.serial.splice(0, 100);
      this.serialVersion = (this.serialVersion || 0) + 1;
    },
    fail(e) {
      this.error = e instanceof SketchError ? e.message : (e && e.message) || String(e);
      const m = /<anonymous>:(\d+):\d+/.exec((e && e.stack) || '');
      this.errorLine = e && e.line ? e.line : m ? +m[1] - 3 : null;
      this.print(`\n⚠︎ ${this.error}${this.errorLine ? ` (line ${this.errorLine})` : ''}\n`, 'err');
      this.gen = null;
    },
    run(eng) {
      this.now = eng.time;
      this.written.clear();
      if (!this.gen) return;
      // interrupts
      for (const h of this.isr) {
        const lv = this.read(h.pin);
        const prev = h.prev;
        h.prev = lv;
        if (prev === undefined || prev === lv) continue;
        if (h.mode === 'CHANGE' || (h.mode === 'RISING' && lv) || (h.mode === 'FALLING' && !lv)) {
          try { const it = h.fn(); for (let n = 0; n < 100000 && !it.next().done; n++); } catch (e) { this.fail(e); return; }
        }
      }
      if (this.toneEnd && this.now > this.toneEnd) { this.tones.clear(); this.toneEnd = 0; this.toneHz = 0; }
      if (this.now < this.wake) return;
      let ticks = 0;
      try {
        for (;;) {
          const r = this.gen.next();
          if (r.done) { this.gen = null; return; }
          const v = r.value;
          if (v > 0) { this.wake = this.now + v / 1000; return; }
          if (++ticks >= TICK_BUDGET) return;
        }
      } catch (e) { this.fail(e); }
    },
    read(g) {
      const v = this.volts(g);
      const m = this.modes.get(g);
      if (m === 'out') return this.level(g, this.now);
      if (!ok(v)) return m === 'pu' ? 1 : m === 'pd' ? 0 : (this.lastLevels.get(g) || 0);
      const lv = v > board.vcc * 0.6 ? 1 : v < board.vcc * 0.3 ? 0 : (this.lastLevels.get(g) || 0);
      this.lastLevels.set(g, lv);
      return lv;
    },
  };

  const C = board.consts;
  const pinOf = (p) => (typeof p === 'number' ? p : C[p] ?? p);
  const check = (g, what) => {
    if (!pinsByGpio.has(g) && g !== board.rgbPin && g !== board.ledPin) {
      const n = `Pin ${g} doesn’t exist on the ${board.short} (used in ${what}).`;
      if (!rt.notes.includes(n)) rt.notes.push(n);
    }
    if (board.reserved && board.reserved[g] && !rt.notes.includes(board.reserved[g])) rt.notes.push(board.reserved[g]);
  };
  const serialObj = (name) => ({
    begin(b) { rt.baud = b || 9600; },
    end() {},
    print(v, f) { rt.print(fmtNum(v, f)); return 1; },
    println(v, f) { rt.print((v === undefined ? '' : fmtNum(v, f)) + '\n'); return 1; },
    printf(fmt, ...a) { rt.print(printf(fmt, ...a)); return 1; },
    write(v) { rt.print(typeof v === 'number' ? String.fromCharCode(v) : String(v)); return 1; },
    flush() {},
    available() { return rt.serialIn.length; },
    read() { if (!rt.serialIn.length) return -1; const c = rt.serialIn.charCodeAt(0); rt.serialIn = rt.serialIn.slice(1); return c; },
    peek() { return rt.serialIn.length ? rt.serialIn.charCodeAt(0) : -1; },
    readString() { const s = rt.serialIn; rt.serialIn = ''; return s; },
    readStringUntil(c) { const ch = typeof c === 'number' ? String.fromCharCode(c) : c; const i = rt.serialIn.indexOf(ch); const s = i < 0 ? rt.serialIn : rt.serialIn.slice(0, i); rt.serialIn = i < 0 ? '' : rt.serialIn.slice(i + 1); return s; },
    parseInt() { const m = /-?\d+/.exec(rt.serialIn); if (!m) return 0; rt.serialIn = rt.serialIn.slice(m.index + m[0].length); return +m[0]; },
    parseFloat() { const m = /-?\d+(\.\d+)?/.exec(rt.serialIn); if (!m) return 0; rt.serialIn = rt.serialIn.slice(m.index + m[0].length); return +m[0]; },
    setTimeout() {},
    toString() { return name; },
  });

  const api = {
    __n: 0,
    __i: (v) => (typeof v === 'number' ? Math.trunc(v) : typeof v === 'boolean' ? +v : v),
    __u8: (v) => (Math.trunc(v) & 255),
    __arr: function mk(n, ...rest) { return Array.from({ length: n }, () => (rest.length ? mk(...rest) : 0)); },
    __sizeof: (a) => (Array.isArray(a) ? a.length : typeof a === 'string' ? a.length + 1 : 1),
    HIGH: 1, LOW: 0, INPUT: 0, OUTPUT: 1, INPUT_PULLUP: 2, INPUT_PULLDOWN: 3, MSBFIRST: 1, LSBFIRST: 0,
    DEC: 10, HEX: 16, BIN: 2, OCT: 8, CHANGE: 'CHANGE', RISING: 'RISING', FALLING: 'FALLING',
    PI: Math.PI, HALF_PI: Math.PI / 2, TWO_PI: Math.PI * 2, DEG_TO_RAD: Math.PI / 180, RAD_TO_DEG: 180 / Math.PI, EULER: Math.E,
    WL_CONNECTED: 3, WL_DISCONNECTED: 6, WIFI_STA: 1, WIFI_AP: 2,
    LED_BUILTIN: board.ledPin, RGB_BUILTIN: board.rgbPin ?? board.ledPin,
    ...C,
    pinMode(p, m) {
      const g = pinOf(p); check(g, 'pinMode');
      rt.modes.set(g, m === 1 ? 'out' : m === 2 ? 'pu' : m === 3 ? 'pd' : 'in');
      rt.pwm.delete(g);
    },
    *digitalWrite(p, v) {
      const g = pinOf(p);
      const val = v ? 1 : 0;
      if (g === board.rgbPin) { rt.rgb = val ? [255, 255, 255] : [0, 0, 0]; return; }
      if (!rt.modes.has(g)) rt.modes.set(g, 'out'); // Arduino: writes to an INPUT toggle the pull-up; treat as output for clarity
      if (rt.modes.get(g) === 'in' || rt.modes.get(g) === 'pu') { rt.modes.set(g, val ? 'pu' : 'in'); return; }
      // a second change of the same pin within one step would be invisible to the circuit: wait a step
      if (rt.written.has(g) && rt.outs.get(g) !== val) yield 0.0005;
      rt.pwm.delete(g); rt.tones.delete(g);
      rt.outs.set(g, val);
      rt.written.add(g);
    },
    digitalRead(p) { return rt.read(pinOf(p)); },
    analogRead(p) {
      let g = pinOf(p);
      if (board.analogAlias && board.analogAlias[g] !== undefined) g = board.analogAlias[g];
      const v = rt.volts(g);
      const max = (1 << (rt.adcBits || board.adcBits)) - 1;
      if (!ok(v)) return Math.round(Math.random() * max * 0.25);
      return Math.max(0, Math.min(max, Math.round((v / board.adcRef) * max)));
    },
    analogReadResolution(b) { rt.adcBits = b; },
    analogWriteResolution(b) { rt.pwmBits = b; },
    *analogWrite(p, v) {
      const g = pinOf(p);
      if (g === board.rgbPin) { const k = Math.max(0, Math.min(255, v)); rt.rgb = [k, k, k]; return; }
      rt.modes.set(g, 'out');
      rt.pwm.set(g, Math.max(0, Math.min(1, v / ((1 << (rt.pwmBits || 8)) - 1))));
    },
    *delay(ms) { yield Math.max(0.0005, +ms || 0); },
    *delayMicroseconds(us) { yield Math.max(0.0005, (+us || 0) / 1000); },
    millis: () => Math.floor((rt.now - rt.boot) * 1000),
    micros: () => Math.floor((rt.now - rt.boot) * 1e6),
    map: (x, a, b, c, e) => Math.trunc(((x - a) * (e - c)) / (b - a) + c),
    constrain: (x, a, b) => Math.min(Math.max(x, a), b),
    min: Math.min, max: Math.max, abs: Math.abs, sq: (x) => x * x, sqrt: Math.sqrt, pow: Math.pow,
    sin: Math.sin, cos: Math.cos, tan: Math.tan, floor: Math.floor, ceil: Math.ceil, round: Math.round,
    fabs: Math.abs, log: Math.log, exp: Math.exp, atan2: Math.atan2, isnan: Number.isNaN, isinf: (x) => !Number.isFinite(x),
    random: (a, b) => (b === undefined ? Math.floor(Math.random() * a) : Math.floor(a + Math.random() * (b - a))),
    randomSeed() {},
    bitRead: (v, n) => (v >> n) & 1, bitSet: (v, n) => v | (1 << n), bitClear: (v, n) => v & ~(1 << n),
    bitWrite: (v, n, b) => (b ? v | (1 << n) : v & ~(1 << n)), bit: (n) => 1 << n,
    highByte: (v) => (v >> 8) & 255, lowByte: (v) => v & 255,
    Serial: serialObj('Serial'), Serial1: serialObj('Serial1'), Serial2: serialObj('Serial2'),
    *tone(p, f, dur) {
      const g = pinOf(p); rt.modes.set(g, 'out'); rt.tones.set(g, Math.max(1, f)); rt.toneHz = f;
      if (dur) { rt.toneEnd = rt.now + dur / 1000; }
    },
    *noTone(p) { rt.tones.delete(pinOf(p)); rt.toneHz = 0; },
    *pulseIn() { return 0; },
    *shiftOut(dp, cp, order, val) {
      for (let i = 0; i < 8; i++) {
        const bitv = order === 0 ? (val >> i) & 1 : (val >> (7 - i)) & 1;
        yield* api.digitalWrite(dp, bitv);
        yield* api.digitalWrite(cp, 1);
        yield* api.digitalWrite(cp, 0);
      }
    },
    shiftIn() { return 0; },
    ledcSetup(ch, f, res) { rt.ledcRes.set('ch' + ch, res || 8); return f; },
    ledcAttachPin(p, ch) { rt.ledc.set(ch, pinOf(p)); rt.ledcRes.set(pinOf(p), rt.ledcRes.get('ch' + ch) || 8); },
    ledcAttach(p, f, res) { rt.ledcRes.set(pinOf(p), res || 8); return true; },
    *ledcWrite(pc, duty) {
      const g = rt.ledc.has(pc) ? rt.ledc.get(pc) : pinOf(pc);
      const res = rt.ledcRes.get(g) || 8;
      rt.modes.set(g, 'out');
      rt.pwm.set(g, Math.max(0, Math.min(1, duty / ((1 << res) - 1))));
    },
    *neopixelWrite(p, r, g, b) { rt.rgb = [r, g, b]; },
    *rgbLedWrite(p, r, g, b) { rt.rgb = [r, g, b]; },
    touchRead: () => 62, hallRead: () => 0, temperatureRead: () => 41.5,
    yield() {}, interrupts() {}, noInterrupts() {},
    digitalPinToInterrupt: (p) => pinOf(p),
    attachInterrupt(p, fn, mode) { rt.isr = rt.isr.filter(h => h.pin !== pinOf(p)); rt.isr.push({ pin: pinOf(p), fn, mode, prev: undefined }); },
    detachInterrupt(p) { rt.isr = rt.isr.filter(h => h.pin !== pinOf(p)); },
    WiFi: {
      begin(ssid) { rt.wifiAt = rt.now; rt.print(`[sim] Wi-Fi connecting to “${ssid}”… (network is simulated)\n`, 'info'); },
      status: () => (rt.wifiAt !== null && rt.now - rt.wifiAt > 1.5 ? 3 : 6),
      localIP: () => '192.168.1.42', macAddress: () => '24:6F:28:AA:BB:CC', RSSI: () => -54,
      mode() {}, disconnect() { rt.wifiAt = null; }, setHostname() {}, softAP() { return true; }, softAPIP: () => '192.168.4.1',
    },
    ESP: {
      getFreeHeap: () => board.heap || 0, getHeapSize: () => board.heap || 0,
      getPsramSize: () => board.psram || 0, getFreePsram: () => board.psram || 0,
      getFlashChipSize: () => board.flash || 0, getChipModel: () => board.chip, getCpuFreqMHz: () => board.mhz,
      getChipCores: () => board.cores || 1, restart() { rt.restart = true; },
    },
    String: Object.assign((v, f) => (v === undefined ? '' : typeof v === 'number' && f !== undefined ? fmtNum(v, f) : globalThis.String(v)), {}),
  };

  try {
    const pinNames = Object.keys(C);
    const { factory } = compile(part.props.code || '', pinNames);
    const { setup, loop } = factory(api);
    rt.gen = (function* main() {
      yield* setup();
      for (;;) { yield* loop(); yield 0; }
    })();
  } catch (e) {
    rt.fail(e);
  }
  return rt;
}

/**
 * Microcontroller device: runs a compiled sketch in simulated time and
 * drives/reads the board's pins through the circuit engine.
 */
import { compile, SketchError } from './transpile.js';
import { I2CBus } from '../sim/i2c.js';

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
      if (board.vcc === 3.3 && (board.type === 'esp32' || board.type === 'esp32s3')) {
        for (const [g] of pinsByGpio) {
          const v = this.volts(g);
          if (v > 3.6) {
            const warn = `Warning: Pin ${g} voltage (${v.toFixed(1)}V) exceeds 3.3V logic level without level shifter.`;
            if (!this.notes.includes(warn)) this.notes.push(warn);
          }
        }
      }
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

  const C = board.consts || {};
  const pinOf = (p) => {
    if (typeof p === 'number') return p;
    if (C[p] !== undefined) return C[p];
    if (typeof p === 'string') {
      const base = p.split(/[/:]/)[0];
      if (C[base] !== undefined) return C[base];
      const m = /^[DA](\d+)$/i.exec(base);
      if (m) {
        const num = +m[1];
        if (base[0].toUpperCase() === 'A') return C[base.toUpperCase()] ?? (14 + num);
        return num;
      }
    }
    return p;
  };
  const check = (g, what) => {
    if (!pinsByGpio.has(g) && g !== board.rgbPin && g !== board.ledPin) {
      const n = `Pin ${g} doesn’t exist on the ${board.short} (used in ${what}).`;
      if (!rt.notes.includes(n)) rt.notes.push(n);
    }
    if (board.type === 'esp32' && [34, 35, 36, 39].includes(g) && what === 'pinMode(OUTPUT)') {
      const n = `GPIO ${g} is input-only on the ESP32 and cannot be set as OUTPUT.`;
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

  const getWirePins = () => {
    let sdaGpio = board.consts && board.consts.SDA !== undefined ? board.consts.SDA : (board.type === 'esp32' ? 21 : board.type === 'esp32s3' ? 8 : board.type === 'bluepill' ? 23 : 18);
    let sclGpio = board.consts && board.consts.SCL !== undefined ? board.consts.SCL : (board.type === 'esp32' ? 22 : board.type === 'esp32s3' ? 9 : board.type === 'bluepill' ? 22 : 19);
    const sdaIndices = pinsByGpio.get(sdaGpio) || [];
    const sclIndices = pinsByGpio.get(sclGpio) || [];
    let sdaNet = -1, sclNet = -1;
    for (const idx of sdaIndices) {
      if (dev.nets[idx] >= 0) { sdaNet = dev.nets[idx]; break; }
    }
    for (const idx of sclIndices) {
      if (dev.nets[idx] >= 0) { sclNet = dev.nets[idx]; break; }
    }
    if (sdaNet < 0 && sdaIndices.length) sdaNet = dev.nets[sdaIndices[0]];
    if (sclNet < 0 && sclIndices.length) sclNet = dev.nets[sclIndices[0]];
    return { sdaGpio, sclGpio, sdaNet, sclNet };
  };

  const wireObj = {
    begin(addr) {
      const { sdaGpio, sclGpio } = getWirePins();
      api.pinMode(sdaGpio, 2); // INPUT_PULLUP
      api.pinMode(sclGpio, 2); // INPUT_PULLUP
      rt.i2cTx = null;
      rt.i2cRx = [];
    },
    beginTransmission(addr) {
      rt.i2cTx = { addr, bytes: [] };
    },
    write(val) {
      if (!rt.i2cTx) return 0;
      if (typeof val === 'number') {
        rt.i2cTx.bytes.push(val & 0xFF);
        return 1;
      }
      if (typeof val === 'string') {
        for (let i = 0; i < val.length; i++) rt.i2cTx.bytes.push(val.charCodeAt(i) & 0xFF);
        return val.length;
      }
      if (Array.isArray(val) || (val && typeof val.length === 'number')) {
        for (let i = 0; i < val.length; i++) rt.i2cTx.bytes.push(val[i] & 0xFF);
        return val.length;
      }
      return 0;
    },
    endTransmission(sendStop = true) {
      if (!rt.i2cTx) return 4;
      const { sdaNet, sclNet } = getWirePins();
      if (sdaNet < 0 || sclNet < 0) return 4;
      const bus = I2CBus.getBus(engine, sdaNet, sclNet);
      const code = bus.write(rt.i2cTx.addr, rt.i2cTx.bytes);
      rt.i2cTx = null;
      return code;
    },
    requestFrom(addr, quantity, sendStop = true) {
      const { sdaNet, sclNet } = getWirePins();
      if (sdaNet < 0 || sclNet < 0) return 0;
      const bus = I2CBus.getBus(engine, sdaNet, sclNet);
      const data = bus.read(addr, quantity);
      rt.i2cRx = data ? [...data] : [];
      return rt.i2cRx.length;
    },
    available() {
      return rt.i2cRx ? rt.i2cRx.length : 0;
    },
    read() {
      if (!rt.i2cRx || !rt.i2cRx.length) return -1;
      return rt.i2cRx.shift();
    },
    peek() {
      if (!rt.i2cRx || !rt.i2cRx.length) return -1;
      return rt.i2cRx[0];
    },
    setClock(freq) {
      rt.i2cClock = freq;
    }
  };

  const spiObj = {
    begin() {},
    beginTransaction(settings) {},
    endTransaction() {},
    transfer(val) {
      for (const d of engine.devices) {
        if (d && d.spiTransfer && d.csNet >= 0 && ok(engine.V[d.csNet]) && engine.V[d.csNet] < 1.5) {
          return d.spiTransfer(val & 0xFF);
        }
      }
      return 0;
    },
    transfer16(val) {
      const msb = spiObj.transfer((val >> 8) & 0xFF);
      const lsb = spiObj.transfer(val & 0xFF);
      return (msb << 8) | lsb;
    }
  };

  const GLYPHS_5X7 = {
    ' ': [0, 0, 0, 0, 0], '!': [0, 0, 0x5F, 0, 0], '"': [0, 0x07, 0, 0x07, 0],
    '#': [0x14, 0x7F, 0x14, 0x7F, 0x14], '$': [0x24, 0x2A, 0x7F, 0x2A, 0x12], '%': [0x23, 0x13, 0x08, 0x64, 0x62],
    '&': [0x36, 0x49, 0x55, 0x22, 0x50], '\'': [0, 0x05, 0x03, 0, 0], '(': [0, 0x1C, 0x22, 0x41, 0],
    ')': [0, 0x41, 0x22, 0x1C, 0], '*': [0x14, 0x08, 0x3E, 0x08, 0x14], '+': [0x08, 0x08, 0x3E, 0x08, 0x08],
    ',': [0, 0x50, 0x30, 0, 0], '-': [0x08, 0x08, 0x08, 0x08, 0x08], '.': [0, 0x60, 0x60, 0, 0],
    '/': [0x20, 0x10, 0x08, 0x04, 0x02], '0': [0x3E, 0x51, 0x49, 0x45, 0x3E], '1': [0x00, 0x42, 0x7F, 0x40, 0x00],
    '2': [0x42, 0x61, 0x51, 0x49, 0x46], '3': [0x21, 0x41, 0x45, 0x4B, 0x31], '4': [0x18, 0x14, 0x12, 0x7F, 0x10],
    '5': [0x27, 0x45, 0x45, 0x45, 0x39], '6': [0x3C, 0x4A, 0x49, 0x49, 0x30], '7': [0x01, 0x71, 0x09, 0x05, 0x03],
    '8': [0x36, 0x49, 0x49, 0x49, 0x36], '9': [0x06, 0x49, 0x49, 0x29, 0x1E], ':': [0, 0x36, 0x36, 0, 0],
    ';': [0, 0x56, 0x36, 0, 0], '<': [0x08, 0x14, 0x22, 0x41, 0x00], '=': [0x14, 0x14, 0x14, 0x14, 0x14],
    '>': [0x00, 0x41, 0x22, 0x14, 0x08], '?': [0x02, 0x01, 0x51, 0x09, 0x06], '@': [0x32, 0x49, 0x79, 0x41, 0x3E],
    'A': [0x7E, 0x11, 0x11, 0x11, 0x7E], 'B': [0x7F, 0x49, 0x49, 0x49, 0x36], 'C': [0x3E, 0x41, 0x41, 0x41, 0x22],
    'D': [0x7F, 0x41, 0x41, 0x22, 0x1C], 'E': [0x7F, 0x49, 0x49, 0x49, 0x41], 'F': [0x7F, 0x09, 0x09, 0x09, 0x01],
    'G': [0x3E, 0x41, 0x49, 0x49, 0x7A], 'H': [0x7F, 0x08, 0x08, 0x08, 0x7F], 'I': [0x00, 0x41, 0x7F, 0x41, 0x00],
    'J': [0x20, 0x40, 0x41, 0x3F, 0x01], 'K': [0x7F, 0x08, 0x14, 0x22, 0x41], 'L': [0x7F, 0x40, 0x40, 0x40, 0x40],
    'M': [0x7F, 0x02, 0x0C, 0x02, 0x7F], 'N': [0x7F, 0x04, 0x08, 0x10, 0x7F], 'O': [0x3E, 0x41, 0x41, 0x41, 0x3E],
    'P': [0x7F, 0x09, 0x09, 0x09, 0x06], 'Q': [0x3E, 0x41, 0x51, 0x21, 0x5E], 'R': [0x7F, 0x09, 0x19, 0x29, 0x46],
    'S': [0x46, 0x49, 0x49, 0x49, 0x31], 'T': [0x01, 0x01, 0x7F, 0x01, 0x01], 'U': [0x3F, 0x40, 0x40, 0x40, 0x3F],
    'V': [0x1F, 0x20, 0x40, 0x20, 0x1F], 'W': [0x7F, 0x20, 0x18, 0x20, 0x7F], 'X': [0x63, 0x14, 0x08, 0x14, 0x63],
    'Y': [0x07, 0x08, 0x70, 0x08, 0x07], 'Z': [0x61, 0x51, 0x49, 0x45, 0x43], 'a': [0x20, 0x54, 0x54, 0x54, 0x78],
    'b': [0x7F, 0x48, 0x44, 0x44, 0x38], 'c': [0x38, 0x44, 0x44, 0x44, 0x20], 'd': [0x38, 0x44, 0x44, 0x48, 0x7F],
    'e': [0x38, 0x54, 0x54, 0x54, 0x18], 'f': [0x08, 0x7E, 0x09, 0x01, 0x02], 'g': [0x0C, 0x52, 0x52, 0x52, 0x3E],
    'h': [0x7F, 0x08, 0x04, 0x04, 0x78], 'i': [0x00, 0x44, 0x7D, 0x40, 0x00], 'j': [0x20, 0x40, 0x44, 0x3D, 0x00],
    'k': [0x7F, 0x10, 0x28, 0x44, 0x00], 'l': [0x00, 0x41, 0x7F, 0x40, 0x00], 'm': [0x7C, 0x04, 0x18, 0x04, 0x78],
    'n': [0x7C, 0x08, 0x04, 0x04, 0x78], 'o': [0x38, 0x44, 0x44, 0x44, 0x38], 'p': [0x7C, 0x14, 0x14, 0x14, 0x08],
    'q': [0x08, 0x14, 0x14, 0x18, 0x7C], 'r': [0x7C, 0x08, 0x04, 0x04, 0x08], 's': [0x48, 0x54, 0x54, 0x54, 0x20],
    't': [0x04, 0x3F, 0x44, 0x40, 0x20], 'u': [0x3C, 0x40, 0x40, 0x20, 0x7C], 'v': [0x1C, 0x20, 0x40, 0x20, 0x1C],
    'w': [0x3C, 0x40, 0x30, 0x40, 0x3C], 'x': [0x44, 0x28, 0x10, 0x28, 0x44], 'y': [0x0C, 0x50, 0x50, 0x50, 0x3C],
    'z': [0x44, 0x64, 0x54, 0x4C, 0x44],
  };

  class Adafruit_SSD1306 {
    constructor(w = 128, h = 64, wireInstance = null, rst = -1) {
      this.width = w;
      this.height = h;
      this.wire = wireInstance || wireObj;
      this.addr = 0x3C;
      this.buffer = new Uint8Array((w * h) / 8);
      this.cursorX = 0;
      this.cursorY = 0;
      this.textSize = 1;
      this.textColor = 1;
    }
    begin(vccstate = 2, i2caddr = 0x3C) {
      this.addr = i2caddr;
      if (this.wire && this.wire.begin) this.wire.begin();
      this.wire.beginTransmission(this.addr);
      this.wire.write([0x00, 0xAE, 0xD5, 0x80, 0xA8, this.height - 1, 0xD3, 0x00, 0x40, 0x8D, 0x14, 0x20, 0x00, 0xA1, 0xC8, 0xDA, 0x12, 0x81, 0xCF, 0xD9, 0xF1, 0xDB, 0x40, 0xA4, 0xA6, 0xAF]);
      this.wire.endTransmission();
      return true;
    }
    clearDisplay() {
      this.buffer.fill(0);
    }
    drawPixel(x, y, color = 1) {
      if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
      const idx = Math.floor(y / 8) * this.width + x;
      const bit = 1 << (y & 7);
      if (color) this.buffer[idx] |= bit;
      else this.buffer[idx] &= ~bit;
    }
    drawLine(x0, y0, x1, y1, color = 1) {
      x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
      const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
      const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
      let err = dx - dy;
      while (true) {
        this.drawPixel(x0, y0, color);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 > -dy) { err -= dy; x0 += sx; }
        if (e2 < dx) { err += dx; y0 += sy; }
      }
    }
    drawRect(x, y, w, h, color = 1) {
      this.drawLine(x, y, x + w - 1, y, color);
      this.drawLine(x, y + h - 1, x + w - 1, y + h - 1, color);
      this.drawLine(x, y, x, y + h - 1, color);
      this.drawLine(x + w - 1, y, x + w - 1, y + h - 1, color);
    }
    fillRect(x, y, w, h, color = 1) {
      for (let i = 0; i < w; i++) this.drawLine(x + i, y, x + i, y + h - 1, color);
    }
    setTextSize(s) { this.textSize = Math.max(1, s); }
    setTextColor(c) { this.textColor = c; }
    setCursor(x, y) { this.cursorX = x; this.cursorY = y; }
    print(str) {
      const s = String(str);
      for (let i = 0; i < s.length; i++) this.write(s.charCodeAt(i));
    }
    println(str = '') {
      this.print(str);
      this.cursorX = 0;
      this.cursorY += this.textSize * 8;
    }
    write(c) {
      if (c === 10) {
        this.cursorX = 0;
        this.cursorY += this.textSize * 8;
        return 1;
      }
      const ch = typeof c === 'number' ? String.fromCharCode(c) : String(c);
      const pattern = GLYPHS_5X7[ch] || [0x7F, 0x41, 0x41, 0x41, 0x7F];
      for (let i = 0; i < 5; i++) {
        let line = pattern[i];
        for (let j = 0; j < 8; j++, line >>= 1) {
          if (line & 1) {
            if (this.textSize === 1) this.drawPixel(this.cursorX + i, this.cursorY + j, this.textColor);
            else this.fillRect(this.cursorX + i * this.textSize, this.cursorY + j * this.textSize, this.textSize, this.textSize, this.textColor);
          }
        }
      }
      this.cursorX += this.textSize * 6;
      return 1;
    }
    display() {
      this.wire.beginTransmission(this.addr);
      this.wire.write([0x00, 0x21, 0, this.width - 1, 0x22, 0, (this.height / 8) - 1]);
      this.wire.endTransmission();

      const chunkSize = 32;
      for (let i = 0; i < this.buffer.length; i += chunkSize) {
        this.wire.beginTransmission(this.addr);
        this.wire.write(0x40);
        const slice = this.buffer.slice(i, i + chunkSize);
        for (let j = 0; j < slice.length; j++) this.wire.write(slice[j]);
        this.wire.endTransmission();
      }
    }
  }

  class LiquidCrystal_I2C {
    constructor(addr = 0x27, cols = 16, rows = 2) {
      this.addr = addr;
      this.cols = cols;
      this.rows = rows;
      this.wire = wireObj;
      this.backlightVal = 0x08;
    }
    init() { this.begin(this.cols, this.rows); }
    begin(cols, rows) {
      this.cols = cols; this.rows = rows;
      if (this.wire && this.wire.begin) this.wire.begin();
      this.send(0x03, 0);
      this.send(0x03, 0);
      this.send(0x03, 0);
      this.send(0x02, 0);
      this.command(0x28);
      this.command(0x0C);
      this.clear();
      this.command(0x06);
    }
    clear() { this.command(0x01); }
    home() { this.command(0x02); }
    setCursor(col, row) {
      const rowOffsets = [0x00, 0x40, 0x14, 0x54];
      this.command(0x80 | (col + (rowOffsets[row] || 0)));
    }
    print(val) {
      const s = String(val);
      for (let i = 0; i < s.length; i++) this.write(s.charCodeAt(i));
    }
    println(val = '') { this.print(val); }
    write(ch) {
      const code = typeof ch === 'number' ? ch : String(ch).charCodeAt(0);
      this.send(code, 1);
      return 1;
    }
    backlight() { this.backlightVal = 0x08; this.expanderWrite(0); }
    noBacklight() { this.backlightVal = 0x00; this.expanderWrite(0); }
    command(cmd) { this.send(cmd, 0); }
    send(val, mode) {
      const highNib = val & 0xF0;
      const lowNib = (val << 4) & 0xF0;
      this.write4bits(highNib | mode);
      this.write4bits(lowNib | mode);
    }
    write4bits(val) {
      this.expanderWrite(val);
      this.pulseEnable(val);
    }
    expanderWrite(data) {
      this.wire.beginTransmission(this.addr);
      this.wire.write(data | this.backlightVal);
      this.wire.endTransmission();
    }
    pulseEnable(data) {
      this.expanderWrite(data | 0x04);
      this.expanderWrite(data & ~0x04);
    }
    createChar(location, charmap) {
      location &= 0x7;
      this.command(0x40 | (location << 3));
      for (let i = 0; i < 8; i++) this.write(charmap[i]);
    }
  }

  const api = {
    Wire: wireObj,
    SPI: spiObj,
    Adafruit_SSD1306,
    LiquidCrystal_I2C,
    LiquidCrystal: LiquidCrystal_I2C,
    SSD1306_SWITCHCAPVCC: 2,
    SSD1306_WHITE: 1,
    SSD1306_BLACK: 0,
    SSD1306_INVERSE: 2,
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
      const g = pinOf(p); check(g, m === 1 ? 'pinMode(OUTPUT)' : 'pinMode');
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

  rt.api = api;

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

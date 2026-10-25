/**
 * Arduino sketch (C/C++ subset) → JavaScript generator functions.
 *
 * Every user function becomes `function*`, and calls that may pause
 * (delay, digitalWrite, shiftOut, user functions) become `yield*`, so the
 * simulator can run a sketch step by step in simulated time. Loops get a
 * cooperative yield so `while (true) {}` can't freeze the page.
 *
 * Supported: globals, functions, int/float/bool/char/String/byte/long/…,
 * arrays (incl. 2-D initialisers), #define constants and simple macros,
 * casts, static locals, sizeof on arrays, char literals, integer
 * truncation for int-typed variables. Not supported: classes/structs,
 * pointers, templates, references as out-params.
 */

const TYPES = new Set(['void', 'int', 'long', 'short', 'float', 'double', 'char', 'bool', 'boolean', 'byte', 'word', 'String',
  'unsigned', 'signed', 'const', 'static', 'volatile', 'auto', 'size_t', 'uint8_t', 'int8_t', 'uint16_t', 'int16_t',
  'uint32_t', 'int32_t', 'uint64_t', 'int64_t', 'register', 'inline', 'constexpr']);
const INT_TYPES = new Set(['int', 'long', 'short', 'byte', 'word', 'size_t', 'uint8_t', 'int8_t', 'uint16_t', 'int16_t', 'uint32_t', 'int32_t', 'uint64_t', 'int64_t', 'unsigned', 'signed', 'char']);
export const PAUSING = new Set(['delay', 'delayMicroseconds', 'digitalWrite', 'shiftOut', 'analogWrite', 'tone', 'noTone', 'ledcWrite', 'neopixelWrite', 'rgbLedWrite', 'pulseIn']);
export const SHIM_CLASSES = new Set(['Servo', 'Adafruit_SSD1306', 'LiquidCrystal_I2C', 'LiquidCrystal', 'Adafruit_NeoPixel', 'DHT']);

export class SketchError extends Error {
  constructor(msg, line) { super(msg); this.line = line; }
}

function tokenize(src) {
  const toks = [];
  let i = 0, line = 1;
  const push = (t, v) => toks.push({ t, v, line });
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { push('ws', '\n'); line++; i++; continue; }
    if (/\s/.test(c)) { let j = i; while (j < src.length && /[ \t\r\f\v]/.test(src[j])) j++; push('ws', src.slice(i, j)); i = j; continue; }
    if (src.startsWith('//', i)) { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (src.startsWith('/*', i)) {
      const j = src.indexOf('*/', i + 2);
      const body = src.slice(i, j < 0 ? src.length : j + 2);
      for (const ch of body) if (ch === '\n') { push('ws', '\n'); line++; }
      i = j < 0 ? src.length : j + 2; continue;
    }
    if (c === '#') {
      let j = i; while (j < src.length && src[j] !== '\n') { if (src[j] === '\\' && src[j + 1] === '\n') j++; j++; }
      push('pp', src.slice(i, j)); i = j; continue;
    }
    if (c === '"') {
      let j = i + 1; while (j < src.length && src[j] !== '"') { if (src[j] === '\\') j++; if (src[j] === '\n') break; j++; }
      push('str', src.slice(i, j + 1)); i = j + 1; continue;
    }
    if (c === '\'') {
      let j = i + 1; while (j < src.length && src[j] !== '\'') { if (src[j] === '\\') j++; j++; }
      const body = src.slice(i + 1, j);
      let code;
      try { code = JSON.parse('"' + body.replace(/"/g, '\\"') + '"').charCodeAt(0); } catch { code = body.charCodeAt(0); }
      push('num', String(code)); i = j + 1; continue;
    }
    const num = /^(0[xX][0-9a-fA-F]+|0[bB][01]+|B[01]{1,8}(?![\w])|\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)[uUlLfF]*/.exec(src.slice(i, i + 40));
    if (num && !(c === 'B' && /\w/.test(src[i - 1] || ''))) {
      let v = num[1];
      if (/^B[01]/.test(v)) v = '0b' + v.slice(1);
      push('num', v); i += num[0].length; continue;
    }
    const id = /^[A-Za-z_]\w*/.exec(src.slice(i, i + 80));
    if (id) { push('id', id[0]); i += id[0].length; continue; }
    const op = /^(<<=|>>=|::|->|\+\+|--|<<|>>|<=|>=|==|!=|&&|\|\||\+=|-=|\*=|\/=|%=|&=|\|=|\^=|[{}()[\];,.?:~!%^&*+\-=<>/|])/.exec(src.slice(i, i + 3));
    if (op) { push('op', op[0]); i += op[0].length; continue; }
    throw new SketchError(`Unexpected character “${c}”`, line);
  }
  return toks;
}

export function transpile(src) {
  const all = tokenize(src);
  const sig = [];           // significant tokens (with index into `all`)
  all.forEach((t, i) => { if (t.t !== 'ws') sig.push(i); });
  const T = (k) => (k >= 0 && k < sig.length ? all[sig[k]] : { t: 'eof', v: '', line: 0 });

  for (let k = 0; k < sig.length; k++) {
    const v = T(k).v;
    if ((v === 'class' || v === 'struct' || v === 'template') && T(k).t === 'id') throw new SketchError(`“${v}” isn’t supported in the simulator yet — use plain functions and variables.`, T(k).line);
  }

  // pre-scan user function names: TYPE… NAME ( … ) {
  const userFns = new Set();
  for (let k = 0; k < sig.length; k++) {
    if (T(k).t === 'id' && TYPES.has(T(k).v)) {
      let j = k; while (T(j).t === 'id' && TYPES.has(T(j).v)) j++;
      while (T(j).v === '*' || T(j).v === '&') j++;
      if (T(j).t === 'id' && T(j + 1).v === '(') {
        let d = 0, m = j + 1;
        for (; m < sig.length; m++) { if (T(m).v === '(') d++; else if (T(m).v === ')') { d--; if (d === 0) break; } }
        if (T(m + 1).v === '{' || T(m + 1).v === ';') userFns.add(T(j).v);
      }
    }
  }

  const out = [];
  const hoisted = [];
  let sink = out;
  const emit = (s) => sink.push(s);
  const intVars = new Set();
  const byteVars = new Set();
  // closers: pending text to emit when the paren/expression at `depth` ends
  const closers = [];
  let paren = 0, brace = 0;
  const parenKw = [];          // keyword that opened each '('
  let lastClosedKw = null;
  let fnDepth = -1;            // brace depth of current function body
  let statementStart = true;
  let forInit = false;

  // Emit whitespace tokens between significant tokens a..b (exclusive) to keep line numbers.
  const ws = (from, to) => { for (let i = from; i < to; i++) if (all[i].t === 'ws') emit(all[i].v === '\n' ? '\n' : ' '); };

  const flushClosers = (kind) => {
    // kind: ';' ',' or ')' — close any expression wrappers opened at this paren depth
    while (closers.length && closers[closers.length - 1].paren === paren && closers[closers.length - 1].expr) {
      emit(closers.pop().text);
    }
  };

  let k = 0;
  let prevIdx = -1;
  /** Consume the current significant token (emitting the whitespace before it). */
  // C needs ';' where JavaScript would silently insert one — catch it like a compiler would.
  let lastTok = null, inInit = false;
  const NOEND = new Set(['else', 'do', 'return', 'case', 'default', 'goto', 'new', 'typeof', ...TYPES]);
  const ends = (t) => t && (t.t === 'num' || t.t === 'str' || (t.t === 'id' && !NOEND.has(t.v)) || t.v === ')' || t.v === ']' || t.v === '++' || t.v === '--');
  const starts = (t) => t.t === 'id' || t.t === 'num' || t.t === 'str';
  const next = () => {
    const idx = sig[k];
    const t = all[idx];
    if (t && lastTok && !inInit && paren === 0 && ends(lastTok) && !(lastTok.v === ')' && /^(if|while|for|switch)$/.test(lastClosedKw || ''))) {
      if ((t.line > lastTok.line && starts(t)) || t.v === '}') throw new SketchError(`Missing “;” at the end of line ${lastTok.line}.`, lastTok.line);
    }
    lastTok = t && t.t === 'pp' ? null : t;
    ws(prevIdx + 1, idx); prevIdx = idx; k++; return t;
  };
  const peek = (o = 0) => T(k + o);

  function parseDecl() {
    let j = k;
    const types = [];
    while (T(j).t === 'id' && TYPES.has(T(j).v)) types.push(T(j++).v);
    while (T(j).v === '*' || T(j).v === '&') j++;
    if (!types.length || T(j).t !== 'id') return false;
    const isConst = types.includes('const') || types.includes('constexpr');
    const isStatic = types.includes('static') && fnDepth >= 0;
    const isFloat = types.includes('float') || types.includes('double');
    const isInt = !isFloat && types.some(t => INT_TYPES.has(t));
    const isByte = types.some(t => t === 'byte' || t === 'uint8_t');
    if (T(j + 1).v === '(' && brace === 0) {
      while (k < j) next();
      const name = next().v;
      next(); // (
      const params = [];
      let cur = [], d = 1;
      for (;;) {
        const t = next();
        if (t.t === 'eof' || t.v === undefined) throw new SketchError('Unclosed parameter list.', t.line);
        if (t.v === '(') d++;
        if (t.v === ')') { d--; if (d === 0) break; }
        if (t.v === ',' && d === 1) { params.push(cur); cur = []; continue; }
        cur.push(t);
      }
      if (cur.length) params.push(cur);
      const names = params.map(ps => {
        const eq = ps.findIndex(x => x.v === '=');
        const head = eq >= 0 ? ps.slice(0, eq) : ps;
        const ids = head.filter(x => x.t === 'id' && !TYPES.has(x.v));
        const nm = ids.length ? ids[ids.length - 1].v : null;
        return nm && eq >= 0 ? nm + ' = ' + ps.slice(eq + 1).map(x => x.v).join(' ') : nm;
      }).filter(Boolean);
      if (peek().v === ';') { next(); statementStart = true; return true; } // prototype
      emit(`function* ${name}(${names.join(', ')})`);
      pendingFnBody = true;
      return true;
    }
    while (k < j) next();
    if (isStatic) sink = hoisted;
    emit(isConst ? 'const ' : 'let ');
    for (;;) {
      const name = next().v;
      emit(name);
      intVars.delete(name); byteVars.delete(name);
      const dims = [];
      while (peek().v === '[') {
        next();
        const parts = [];
        while (peek().v !== ']' && peek().t !== 'eof') parts.push(next().v);
        next();
        dims.push(parts.join('') || '0');
      }
      if (!dims.length && isInt) intVars.add(name);
      if (!dims.length && isByte) byteVars.add(name);
      if (peek().v === '=') {
        next();
        emit(' = ');
        if (peek().v === '{') {
          inInit = true;
          let d = 0;
          for (;;) {
            const t = next();
            if (t.v === '{') { d++; emit('['); } else if (t.v === '}') { d--; emit(']'); if (d === 0) break; } else emit(t.v);
          }
          inInit = false;
        } else if (dims.length && peek().t === 'str') {
          emit(next().v);
        } else {
          const w = isByte && !dims.length ? '__u8(' : isInt && !dims.length ? '__i(' : null;
          if (w) { emit(w); closers.push({ paren, expr: true, text: ')' }); }
          return 'expr';
        }
      } else if (dims.length) {
        emit(` = __arr(${dims.join(', ')})`);
      } else if (!isConst) {
        emit(types.includes('String') ? ' = ""' : ' = 0');
      }
      if (peek().v === ',') { next(); emit(', '); continue; }
      break;
    }
    return 'done';
  }

  let pendingFnBody = false;
  while (k < sig.length) {
    const t = peek();
    if (t.t === 'pp') {
      next();
      const m = /^#\s*define\s+(\w+)(\(([^)]*)\))?\s*(.*)$/s.exec(t.v.replace(/\\\n/g, ' '));
      if (m) {
        if (m[2]) emit(`const ${m[1]} = (${m[3]}) => (${m[4] || 'undefined'});`);
        else emit(`const ${m[1]} = ${m[4] ? m[4].replace(/(\d+)[uUlL]+\b/g, '$1') : 'true'};`);
      }
      statementStart = true; continue;
    }
    if (statementStart && t.t === 'id' && SHIM_CLASSES.has(t.v)) {
      statementStart = false;
      const cls = next().v;
      const varName = next().v;
      let args = [];
      if (peek().v === '(') {
        next(); // (
        let d = 1;
        let cur = [];
        for (;;) {
          const tok = next();
          if (tok.t === 'eof' || tok.v === undefined) throw new SketchError('Unclosed argument list.', tok.line);
          if (tok.v === '(') d++;
          if (tok.v === ')') { d--; if (d === 0) break; }
          if (tok.v === '&' && peek().t === 'id') continue;
          cur.push(tok.v);
        }
        args = cur;
      }
      if (peek().v === ';') next();
      emit(`const ${varName} = new ${cls}(${args.join(' ')});`);
      statementStart = true;
      continue;
    }
    if (statementStart && t.t === 'id' && TYPES.has(t.v) && !(t.v === 'void' && peek(1).v === ')')) {
      statementStart = false;
      if (parseDecl()) continue;
    }
    statementStart = false;

    // casts: (int)x → ~~x, (float)x → +x
    if (t.v === '(' && peek(1).t === 'id' && TYPES.has(peek(1).v) && (peek(2).v === ')' || (TYPES.has(peek(2).v) && peek(3).v === ')'))) {
      const typ = peek(1).v;
      while (peek().v !== ')') next();
      next();
      emit(INT_TYPES.has(typ) ? '~~' : '+');
      continue;
    }

    const tok = next();
    const v = tok.v;
    if (tok.t === 'id') {
      const nx = peek().v;
      const prevOut = out[out.length - 1];
      if ((userFns.has(v) || PAUSING.has(v)) && nx === '(' && prevOut !== '.') {
        emit(`(yield* ${v}`);
        closers.push({ paren: paren + 1, call: true, text: ')' });
      } else if (v === 'sizeof') emit('__sizeof');
      else if (v === 'NULL' || v === 'nullptr') emit('null');
      else if (v === 'length' && prevOut === '.' && nx === '(' && peek(1).v === ')') { emit('length'); next(); next(); }
      else if ((intVars.has(v) || byteVars.has(v)) && /^([+\-*/%&|^]|<<|>>)?=$/.test(nx) && prevOut !== '.') {
        next();
        const op = nx.slice(0, -1);
        const w = byteVars.has(v) ? '__u8' : '__i';
        emit(`${v} = ${w}(${op ? `${v} ${op} (` : ''}`);
        closers.push({ paren, expr: true, text: op ? '))' : ')' });
      } else emit(v);
      if (v === 'for') forInit = true;
      continue;
    }
    switch (v) {
      case '(':
        paren++;
        parenKw.push(T(k - 2).v);
        emit('(');
        if (forInit && parenKw[parenKw.length - 1] === 'for') { statementStart = true; forInit = false; }
        break;
      case ')':
        flushClosers(')');
        paren--;
        lastClosedKw = parenKw.pop();
        emit(')');
        if (closers.length && closers[closers.length - 1].paren === paren + 1 && closers[closers.length - 1].call) emit(closers.pop().text);
        break;
      case ';': flushClosers(';'); emit(';'); statementStart = true; if (sink !== out) sink = out; break;
      case ',': flushClosers(','); emit(','); break;
      case '{': {
        brace++;
        emit('{');
        if (pendingFnBody) { fnDepth = brace; pendingFnBody = false; }
        const prev = T(k - 2).v;
        if ((prev === ')' && (lastClosedKw === 'for' || lastClosedKw === 'while')) || prev === 'do') emit('if(++__api.__n>4000){__api.__n=0;yield 0;}');
        statementStart = true;
        break;
      }
      case '}':
        flushClosers(';');
        if (brace === fnDepth) fnDepth = -1;
        brace--; emit('}'); statementStart = true;
        break;
      case '->': case '::': emit('.'); break;
      default: emit(v);
    }
  }
  ws(prevIdx + 1, all.length);
  if (brace !== 0) throw new SketchError(brace > 0 ? 'Missing “}” — a { was never closed.' : 'Extra “}” in the sketch.', all.length ? all[all.length - 1].line : 1);
  if (paren !== 0) throw new SketchError('Unbalanced parentheses.', 1);
  return { js: out.join(''), hoisted: hoisted.join(''), fns: userFns };
}

export const API_NAMES = [
  'pinMode', 'digitalWrite', 'digitalRead', 'analogRead', 'analogWrite', 'analogReadResolution', 'analogWriteResolution',
  'delay', 'delayMicroseconds', 'millis', 'micros', 'map', 'constrain', 'min', 'max', 'abs', 'sq', 'sqrt', 'pow', 'sin', 'cos', 'tan',
  'floor', 'ceil', 'round', 'random', 'randomSeed', 'Serial', 'Serial1', 'Serial2', 'tone', 'noTone', 'pulseIn', 'shiftOut', 'shiftIn',
  'bitRead', 'bitWrite', 'bitSet', 'bitClear', 'bit', 'highByte', 'lowByte', 'ledcAttach', 'ledcAttachPin', 'ledcSetup', 'ledcWrite',
  'neopixelWrite', 'rgbLedWrite', 'touchRead', 'hallRead', 'temperatureRead', 'WiFi', 'yield', 'interrupts', 'noInterrupts',
  'attachInterrupt', 'detachInterrupt', 'digitalPinToInterrupt', 'isnan', 'isinf', 'fabs', 'log', 'exp', 'atan2',
  'HIGH', 'LOW', 'INPUT', 'OUTPUT', 'INPUT_PULLUP', 'INPUT_PULLDOWN', 'LED_BUILTIN', 'RGB_BUILTIN', 'MSBFIRST', 'LSBFIRST',
  'DEC', 'HEX', 'BIN', 'OCT', 'CHANGE', 'RISING', 'FALLING', 'PI', 'HALF_PI', 'TWO_PI', 'DEG_TO_RAD', 'RAD_TO_DEG', 'EULER',
  'WL_CONNECTED', 'WL_DISCONNECTED', 'WIFI_STA', 'WIFI_AP', 'ESP', 'String', 'Wire', 'SPI',
  'Adafruit_SSD1306', 'LiquidCrystal_I2C', 'LiquidCrystal',
  'SSD1306_SWITCHCAPVCC', 'SSD1306_WHITE', 'SSD1306_BLACK', 'SSD1306_INVERSE',
  '__i', '__u8', '__arr', '__sizeof', '__api', 'true', 'false',
];

/** Compile to a factory: (api) => ({ setup, loop }) generator functions. */
export function compile(src, pinNames) {
  const { js, hoisted, fns } = transpile(src);
  if (!fns.has('setup') || !fns.has('loop')) throw new SketchError('A sketch needs both void setup() and void loop().', 1);
  const names = [...new Set([...API_NAMES.filter(n => n !== 'true' && n !== 'false' && n !== '__api' && n !== 'String'), ...pinNames])];
  const prologue = `const {${names.join(',')}} = __api;` + hoisted.replace(/\n/g, ' ');
  const body = `${prologue}\n${js}\n;return { setup, loop };`;
  try {
    // eslint-disable-next-line no-new-func
    return { factory: new Function('__api', body), js: body };
  } catch (e) {
    throw new SketchError('Syntax error: ' + e.message, null);
  }
}

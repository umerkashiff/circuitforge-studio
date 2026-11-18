/**
 * Deterministic Netlist-to-Breadboard Builder & Verifier for CircuitForge AI.
 * Translates symbolic AI circuit specs (part types, props, pin connections) into
 * collision-free breadboard layouts, orthogonal A* wires, and verified simulations.
 */
import { Board, Part, Wire, P } from '../model.js';
import { getDef, allDefs } from '../parts/registry.js';
import { Engine, key } from '../sim/engine.js';
import { route, tidy } from '../sim/router.js';
import { WIRE_COLORS } from '../view/renderer.js';
import { nextRef, ensureDesignators } from '../export/designators.js';
import {
  verifyPromptConstraints,
  verifyFloatingIcInputs,
  verifyOutputContention,
  verifyBooleanBehavior,
  verifySequentialClockLiveness,
  verifyCombinationalSwitchLiveness,
  verifyStaticLedPattern,
  verifyActiveLedHealth,
  verifyMcuSketchPinCrossCheck,
  verifyInstrumentAndLoadLiveness,
} from './logic_verify.js';

const SIGNAL_COLORS = ['#0a84ff', '#30a46c', '#ff8a00', '#8e4ec6', '#06b6d4', '#f5c400', '#d946ef', '#65a30d'];
const PASSIVE_BODY_TYPES = new Set(['resistor', 'diode', 'inductor', 'capacitor']);
const holeBoardId = (hl) => (hl?.strip ? String(hl.strip).split(':')[0] : null);
const PROBE_COLORS = ['#ff9f0a', '#30d158', '#0a84ff', '#ff375f', '#bf5af2', '#64d2ff', '#ffd60a', '#ac8e68'];

const KNOWN_PROP_KEYS = ['code', 'sketch', 'program', 'ohms', 'resistance', 'value', 'watts', 'uf', 'capacitance', 'vmax', 'color', 'protect', 'hz', 'duty', 'vpp', 'wave', 'offset', 'power', 'common', 'on', 'label', 'run', 'ch1On', 'ch2On', 'ch1Scale', 'ch2Scale', 'timeDiv', 'coupling', 'trigSrc', 'trigLevel'];

/** Normalize malformed LLM part specs (e.g. string items, `part`/`component` instead of `type`, or top-level `ohms`/`code`). */
export function normalizePartSpec(raw = {}) {
  if (typeof raw === 'string') {
    const s = raw.trim();
    const colon = s.indexOf(':');
    if (colon > 0) return { ref: s.slice(0, colon).trim(), type: s.slice(colon + 1).trim(), props: {} };
    return { ref: '', type: s, props: {} };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ref: '', type: '', props: {}, _invalid: true };
  }
  const props = { ...(raw.props || {}) };
  for (const k of KNOWN_PROP_KEYS) {
    if (raw[k] !== undefined && props[k] === undefined) props[k] = raw[k];
  }
  const type = raw.type ?? raw.part ?? raw.component ?? raw.kind ?? raw.device ?? raw.model ?? raw.name ?? '';
  const ref = raw.ref ?? raw.id ?? raw.name ?? '';
  const row = Number.isInteger(raw.row) ? raw.row : (Number.isInteger(props.row) ? props.row : undefined);
  const col = Number.isInteger(raw.col) ? raw.col : (Number.isInteger(props.col) ? props.col : undefined);
  delete props.row;
  delete props.col;
  return { ...raw, ref, type: type == null ? '' : String(type), props, ...(row !== undefined ? { row } : {}), ...(col !== undefined ? { col } : {}) };
}

/** Normalize common AI part type synonyms to registered part types. */
export function resolvePartType(rawType, rawProps = {}) {
  const props = { ...(rawProps || {}) };
  if (props.sketch !== undefined && props.code === undefined) { props.code = props.sketch; delete props.sketch; }
  if (props.program !== undefined && props.code === undefined) { props.code = props.program; delete props.program; }
  if (props.resistance !== undefined && props.ohms === undefined) { props.ohms = +props.resistance || props.resistance; delete props.resistance; }
  if (props.value !== undefined && props.ohms === undefined && String(rawType).toLowerCase().includes('res')) { props.ohms = parseFloat(props.value) || 220; }
  if (props.capacitance !== undefined && props.uf === undefined) { props.uf = +props.capacitance || props.capacitance; delete props.capacitance; }

  const s = String(rawType || '').trim();
  if (!s) return null;
  if (getDef(s, true)) return { type: s, props };

  const low = s.toLowerCase().replace(/\s+/g, ' ');
  if (/^(?:555|ne-?555|lm-?555|ic-?555|timer\s*555|555\s*timer|555\s*oscil+\w*)$/.test(low)) return { type: 'ne555', props: { ...props } };
  if (/^(?:dip-?8|8[-\s]*dip\s*switch|dip\s*switch\s*8|dip\s*switch)$/.test(low)) return { type: 'dip8', props: { ...props } };
  if (/^(?:dip-?4|4[-\s]*dip\s*switch|dip\s*switch\s*4)$/.test(low)) return { type: 'dip4', props: { ...props } };
  if (/^(?:r|resis?t[eo]rs?)$/.test(low)) return { type: 'resistor', props: { ...props } };
  if (/^(?:c|caps?|capacitors?|capcitors?|condensators?|condensers?)$/.test(low)) return { type: 'capacitor', props: { ...props } };
  if (/^(?:l|inductors?|coils?|chokes?)$/.test(low)) return { type: 'inductor', props: { ...props } };
  if (/^(?:potentiometers?|potnetiometers?|potentiomters?|trimpots?|variable\s*resistors?|rheostats?|vr|pot)$/.test(low)) return { type: 'pot', props: { ...props } };
  if (/^(?:buzzers?|piezos?|peizos?|piezo\s*buzzers?|peizo\s*buzzers?|peizo\s*sounders?|piezo\s*sounders?|sounders?|beepers?|peizo\s*beepers?|piezo\s*beepers?|speakers?|horns?)$/.test(low)) return { type: 'buzzer', props: { ...props } };
  if (/^(?:tactile|tact|tact\s*buttons?|tactile\s*buttons?|tactile\s*switch|momentary\s*switch|push\s*buttons?|pushbuttons?|wokwi-pushbutton)$/.test(low)) return { type: 'tactile', props: { ...props } };
  if (/^(?:npn|bjt|npn\s*bjt|transistors?|npn\s*transistors?|2n3904|2n2222|bc547)(?:\s+(?:npn|bjt|transistor))?$/.test(low)) {
    const out = { ...props };
    if (/2n3904/.test(low)) out.model = '2N3904';
    else if (/2n2222/.test(low)) out.model = '2N2222';
    else if (/bc547/.test(low)) out.model = 'BC547';
    return { type: 'npn', props: out };
  }
  if (/^(?:bargraph|bar\s*graph|led\s*bar|led\s*array|8[-\s]*led\s*bar|8[-\s]*segment\s*bar(?:\s*led)?(?:\s*array)?)$/.test(low)) return { type: 'bargraph', props: { ...props } };
  if (low === 'diode' || low === 'diodes' || low === '1n4148' || low === '1n4001' || low === '1n4007' || low === 'rectifier') {
    const out = { ...props };
    if (low.startsWith('1n')) out.model = low.toUpperCase();
    return { type: 'diode', props: out };
  }
  if (/^(red|green|yellow|blue|white)\s*leds?$/.test(low)) {
    const col = low.split(' ')[0];
    return { type: 'led', props: { color: col, ...props } };
  }
  if (low === 'scope' || low === 'cro' || low === 'ut2062b') return { type: 'oscilloscope', props: { ...props } };
  if (low === 'signal generator' || low === 'function generator' || low === 'func gen' || low === 'egc-3235a' || low === 'egc3235a') return { type: 'funcgen', props: { ...props } };
  if (low === 'psu' || low === 'power supply' || low === 'mps-3005l-3') return { type: 'power-supply', props: { ...props } };
  if (low === 'arduino' || low === 'arduino uno' || low === 'uno r3' || low === 'board-arduino-uno' || low === 'atmega328' || low === 'atmega328p') return { type: 'uno', props: { ...props } };
  if (low === 'arduino nano') return { type: 'nano', props: { ...props } };
  if (low === 'esp-32' || low === 'esp32 devkit' || low === 'esp32 devkit v1') return { type: 'esp32', props: { ...props } };
  if (low === 'esp-32-s3' || low === 'esp32 s3') return { type: 'esp32s3', props: { ...props } };
  if (low === 'stm32' || low === 'stm32 blue pill') return { type: 'bluepill', props: { ...props } };
  if (low === '5v' || low === '+5v' || low === '+5 v supply') return { type: 'vcc', props: { ...props } };
  if (low === 'ground' || low === '0v') return { type: 'gnd', props: { ...props } };

  // Strip 74LS / 74HC / CD prefixes for IC types
  const icNorm = low.replace(/^74(ls|hc|hct|f|ac|act)?/, '74').replace(/^cd/, '').replace(/[^a-z0-9]/g, '');
  if (getDef('ic' + icNorm, true)) return { type: 'ic' + icNorm, props: { ...props } };
  if (getDef(icNorm, true)) return { type: icNorm, props: { ...props } };

  // Match against registered names / short labels
  for (const d of allDefs()) {
    if (d.name.toLowerCase() === low || (d.short && d.short.toLowerCase() === low)) {
      return { type: d.type, props: { ...props } };
    }
  }
  return null;
}

const normRawPin = (s) => String(s || '').trim().replace(/[−–—]/g, '-').toUpperCase();
const normPin = (s) => normRawPin(s).replace(/\u0305/g, '');
const squashPin = (s) => normPin(s).replace(/[^A-Z0-9]/g, '');

function extractInvertedStem(targetRaw) {
  const s = targetRaw.trim();
  if (/\u0305/.test(s)) return squashPin(s);
  let m = /^[/!~](.+)$/.exec(s);
  if (m) return squashPin(m[1]);
  m = /^(.+?)(?:_?BAR|_?NOT|N|['′~])$/.exec(s);
  if (m && m[1].length >= 1) return squashPin(m[1]);
  return null;
}

/** Resolve a symbolic pin identifier (name, inverted bar, CMOS VDD/VSS, alias, or 1-based number) on a Part. */
export function resolvePinIndex(part, rawPin) {
  const pins = part.worldPins();
  const targetRawPre = normRawPin(rawPin);
  // Tolerate "1:1.l" or "3:OUT" copied from 1-based Valid pins hints
  const colonPrefix = /^(\d+):(.+)$/.exec(targetRawPre);
  if (colonPrefix) {
    const bySuffix = resolvePinIndex(part, colonPrefix[2]);
    if (bySuffix >= 0) return bySuffix;
    const nIdx = parseInt(colonPrefix[1], 10) - 1;
    if (nIdx >= 0 && nIdx < pins.length) return nIdx;
  }
  const targetRaw = targetRawPre;
  const target = normPin(rawPin);
  if (!target) return -1;

  // 1a. Exact match preserving overline \u0305 so 1Q and 1Q̅ never collide
  for (let i = 0; i < pins.length; i++) {
    if (normRawPin(pins[i].name) === targetRaw) return i;
  }

  // 1b. Inverted / barred pin matching (e.g. 1Q_BAR, /1Q, 1QN, 1Q', Q1_BAR -> 1Q̅ or Q̅1)
  const invStem = extractInvertedStem(targetRaw);
  if (invStem) {
    for (let i = 0; i < pins.length; i++) {
      if (!/\u0305/.test(pins[i].name)) continue;
      const pinStem = squashPin(pins[i].name);
      const swappedPinStem = pinStem.replace(/^([A-Z]+)(\d+)$/, '$2$1');
      if (pinStem === invStem || swappedPinStem === invStem || pinStem.replace(/^(\d+)([A-Z]+)$/, '$2$1') === invStem) {
        return i;
      }
    }
  }

  // 1c. Exact match ignoring \u0305 only on non-barred pins (and handle bare leading '/' active-low control names like /CLR -> CLR)
  const targetNoSlash = target.replace(/^[/!~]/, '');
  for (let i = 0; i < pins.length; i++) {
    if (/\u0305/.test(pins[i].name)) continue;
    const pn = normPin(pins[i].name);
    if (pn === target || pn === targetNoSlash) return i;
  }

  // 1d. Universal power pin mapping (VCC <-> VDD, GND <-> VSS) for CMOS & TTL ICs
  if (target === 'VCC' || target === 'VDD' || target === '+5V' || target === '5V') {
    const idx = pins.findIndex(p => { const n = normPin(p.name); return n === 'VCC' || n === 'VDD'; });
    if (idx >= 0) return idx;
  }
  if (target === 'GND' || target === 'VSS' || target === '0V') {
    const idx = pins.findIndex(p => { const n = normPin(p.name); return n === 'GND' || n === 'VSS'; });
    if (idx >= 0) return idx;
  }

  // 2. Match either half of slash-combined labels (e.g., D13/SCK -> D13 or SCK)
  for (let i = 0; i < pins.length; i++) {
    if (/\u0305/.test(pins[i].name)) continue;
    const parts = normPin(pins[i].name).split('/');
    if (parts.includes(target) || parts.includes(targetNoSlash)) return i;
  }
  // 3. Semantic pin aliases per part type
  const aliasMap = {
    led: { A: 0, ANODE: 0, '+': 0, POS: 0, K: 1, CATHODE: 1, '-': 1, NEG: 1 },
    diode: { A: 0, ANODE: 0, '+': 0, K: 1, CATHODE: 1, '-': 1 },
    capacitor: { '+': 0, POS: 0, A: 0, '-': 1, NEG: 1, K: 1, GND: 1 },
    battery: { '+': 0, POS: 0, VCC: 0, '-': 1, NEG: 1, GND: 1 },
    buzzer: { '+': 0, POS: 0, '-': 1, NEG: 1, GND: 1 },
    resistor: { A: 0, '1': 0, B: 1, '2': 1 },
    inductor: { A: 0, '1': 0, B: 1, '2': 1 },
    pot: { A: 0, '1': 0, W: 1, WIPER: 1, OUT: 1, '2': 1, B: 2, '3': 2 },
    'wokwi-slide-potentiometer': { A: 0, '1': 0, W: 1, WIPER: 1, OUT: 1, B: 2 },
    npn: { E: 0, EMITTER: 0, B: 1, BASE: 1, C: 2, COLLECTOR: 2 },
    jfet: { D: 0, DRAIN: 0, S: 1, SOURCE: 1, G: 2, GATE: 2 },
    oscilloscope: { CH1: 0, 'CH1+': 0, 'CH1-': 1, GND1: 1, CH1_GND: 1, CH2: 2, 'CH2+': 2, 'CH2-': 3, GND2: 3, CH2_GND: 3, TRIG: 4, EXT: 4 },
    funcgen: { OUT: 4, 'OUT+': 4, SIG: 4, '+': 4, 'OUT-': 5, GND: 5, '-': 5, SYNC: 1 },
    'power-supply': {
      'V1+': 5, '+V1': 5, 'MASTER+': 5, 'MASTER +': 5,
      GND: 4, 'MASTER GND': 4, 'V1-': 3, 'MASTER-': 3,
      '+5V': 7, '5V+': 7, '5V FIXED +': 7, '5V-': 6, '5V GND': 6,
      'V2+': 2, '+V2': 2, 'SLAVE+': 2, 'V2-': 0, 'SLAVE-': 0,
    },
    vcc: { VCC: 0, '5V': 0, '+5V': 0, '+': 0, OUT: 0 },
    gnd: { GND: 0, '-': 0, '0V': 0 },
    toggle: { OUT: 0, '1': 0 },
    button: { OUT: 0, '1': 0 },
    tactile: { '1L': 0, '1.L': 0, L1: 0, '1R': 1, '1.R': 1, R1: 1, '2L': 2, '2.L': 2, L2: 2, '2R': 3, '2.R': 3, R2: 3, A: 0, IN: 0, '1': 0, B: 2, OUT: 2, '2': 2 },
    clock: { CLK: 0, OUT: 0, '1': 0 },
    seg7: { CC: 2, CA: 2, COM1: 2, COM2: 7, GND: 2, VCC: 2 },
    ic7447: { BI: 3, RBO: 3, '/LT': 2, '/RBI': 4, '/RBO': 3 },
    ic7448: { BI: 3, RBO: 3, '/LT': 2, '/RBI': 4, '/RBO': 3 },
    ic7483: { CIN: 12, C_IN: 12, COUT: 13, C_OUT: 13, S1: 8, SUM1: 8, S2: 5, SUM2: 5, S3: 1, SUM3: 1, S4: 14, SUM4: 14, C1: 8, C2: 5, C3: 1, C4_SUM: 14 },
    ic74283: { CIN: 6, C_IN: 6, COUT: 8, C_OUT: 8, S1: 3, SUM1: 3, S2: 0, SUM2: 0, S3: 12, SUM3: 12, S4: 9, SUM4: 9, C1: 3, C2: 0, C3: 12, C4_SUM: 9 },
    ic7485: { AGT: 4, AEQ: 5, ALT: 6, 'A>B': 4, 'A=B': 5, 'A<B': 6, GT: 4, EQ: 5, LT: 6, 'IA>B': 3, 'IA=B': 2, 'IA<B': 1 },
    ic74138: { A0: 0, S0: 0, A1: 1, S1: 1, A2: 2, S2: 2, E1: 3, E2: 4, E3: 5, G2A_BAR: 3, G2B_BAR: 4 },
    ic74238: { A0: 0, S0: 0, A1: 1, S1: 1, A2: 2, S2: 2, E1: 3, E2: 4, E3: 5, G2A_BAR: 3, G2B_BAR: 4 },
    ic74151: { I0: 3, I1: 2, I2: 1, I3: 0, I4: 15, I5: 14, I6: 13, I7: 12, S0: 10, S1: 9, S2: 8, E: 6, EN: 6, Z: 4, Q: 4, Y_BAR: 5, W: 5 },
    ic7493: { CLKA: 13, CLKB: 0, CK0: 13, CK1: 0, RST1: 1, RST2: 2, R1: 1, R2: 2, MR1: 1, MR2: 2 },
    ic7490: { CLKA: 13, CLKB: 0, RST1: 1, RST2: 2, R1: 1, R2: 2, MR1: 1, MR2: 2, MS1: 5, MS2: 6 },
    ic74595: { Q0: 14, Q1: 0, Q2: 1, Q3: 2, Q4: 3, Q5: 4, Q6: 5, Q7: 6, DS: 13, DATA: 13, SHCP: 10, SH_CP: 10, STCP: 11, ST_CP: 11, MR: 9, OE_BAR: 12, MR_BAR: 9, "QH'": 8, Q7S: 8, SQH: 8 },
    ic4017: { CP0: 13, CP: 13, MR: 14, RESET: 14, R: 14, CE: 12, EN: 12, CLKEN: 12, CARRY: 11, COUT: 11 },
  };
  const map = aliasMap[part.type];
  if (map && target in map && map[target] < pins.length) return map[target];

  // 4. Arduino digital/analog alias (D0..D13 -> 0..13 or vice versa)
  if (/^D\d+$/.test(target)) {
    const bare = target.slice(1);
    const idx = pins.findIndex(p => normPin(p.name) === bare);
    if (idx >= 0) return idx;
  } else if (/^\d+$/.test(target)) {
    const dName = 'D' + target;
    const idx = pins.findIndex(p => normPin(p.name) === dName);
    if (idx >= 0) return idx;
  }

  // 5. Fallback 1-based physical pin index ("1".."N")
  if (/^\d+$/.test(target)) {
    const n = parseInt(target, 10) - 1;
    if (n >= 0 && n < pins.length) return n;
  }

  // 5b. Unambiguous digit<->letter swap (e.g. A1 -> 1A, B2 -> 2B, CLK1 -> 1CLK on gates/FFs)
  const swapA = /^([A-Z]+)(\d+)$/.exec(targetNoSlash);
  const swapB = /^(\d+)([A-Z]+)$/.exec(targetNoSlash);
  const swapped = swapA ? (swapA[2] + swapA[1]) : swapB ? (swapB[2] + swapB[1]) : null;
  if (swapped) {
    const hits = [];
    for (let i = 0; i < pins.length; i++) {
      if (!/\u0305/.test(pins[i].name) && squashPin(pins[i].name) === swapped) hits.push(i);
    }
    if (hits.length === 1) return hits[0];
  }

  // 6. Forgiving fuzzy match: ignore punctuation, accept long names (DISCHARGE, THRESHOLD, OUTPUT, GROUND, CONTROL)
  //    and 1-letter non-digit typos (DISC -> DIS) without colliding with barred Q̅ or differing numbered pins
  const t = squashPin(targetNoSlash);
  if (t.length >= 2) {
    const eligible = pins.map((p, idx) => ({ n: squashPin(p.name), idx, bar: /\u0305/.test(p.name) })).filter(o => !o.bar);
    const exactSq = eligible.find(o => o.n === t);
    if (exactSq) return exactSq.idx;
    const pref = eligible.filter(o => o.n.length >= 2 && (t.startsWith(o.n) || o.n.startsWith(t)) && t.replace(/\D/g, '') === o.n.replace(/\D/g, ''));
    if (pref.length === 1) return pref[0].idx;
    const lev1 = (a, b) => {
      if (Math.abs(a.length - b.length) > 1) return false;
      if (a.replace(/[A-Z]/g, '') !== b.replace(/[A-Z]/g, '')) return false; // Never blur numbered pins like D1 vs D2
      let i2 = 0, j = 0, diff = 0;
      while (i2 < a.length && j < b.length) {
        if (a[i2] === b[j]) { i2++; j++; continue; }
        if (++diff > 1) return false;
        if (a.length > b.length) i2++; else if (a.length < b.length) j++; else { i2++; j++; }
      }
      return diff + (a.length - i2) + (b.length - j) <= 1;
    };
    const near = eligible.filter(o => o.n.length >= 3 && lev1(t, o.n));
    if (near.length === 1) return near[0].idx;
  }
  return -1;
}

export function parseRailToken(tok) {
  const s = String(tok || '').trim().toUpperCase().replace(/−/g, '-');
  if (s === '+' || s === '+5V' || s === '5V' || s === 'VCC' || s === 'VDD' || s === 'RAIL+' || s === 'TOP+' || s === 'BOT+') {
    return { rail: '+', half: s.startsWith('BOT') ? 'b' : s.startsWith('TOP') ? 't' : 'auto' };
  }
  if (s === '-' || s === 'GND' || s === '0V' || s === 'VSS' || s === 'RAIL-' || s === 'TOP-' || s === 'BOT-') {
    return { rail: '−', half: s.startsWith('BOT') ? 'b' : s.startsWith('TOP') ? 't' : 'auto' };
  }
  return null;
}

function boxesIntersect(a, b, pad = 0.25) {
  return (a.x0 - pad) < b.x1 && (a.x1 + pad) > b.x0 && (a.y0 - pad) < b.y1 && (a.y1 + pad) > b.y0;
}

function canPlaceCandidate(app, cand) {
  const cb = cand.bounds();
  const candPassive = PASSIVE_BODY_TYPES.has(cand.type);
  for (const existing of app.circuit.parts) {
    const pad = (candPassive || PASSIVE_BODY_TYPES.has(existing.type)) ? 0.35 : 0.25;
    if (boxesIntersect(cb, existing.bounds(), pad)) return false;
  }
  const ix = app.index;
  const candStrips = new Set();
  for (const q of cand.worldPins()) {
    const hl = ix.holes.get(key(q.x, q.y));
    if (hl && !hl.rail) candStrips.add(hl.strip);
  }
  if (candStrips.size) {
    for (const [, hl] of ix.holes) {
      if (!candStrips.has(hl.strip)) continue;
      const k = key(hl.x, hl.y);
      if ((ix.pins.get(k)?.length) || (ix.ends.get(k)?.length)) return false;
    }
  }
  const { msg } = app.editor.problems([cand]);
  return !msg;
}

function getBoardState(board, state) {
  if (!board) {
    return { icCol: state.icCol ?? 3, usedColsTop: state.usedColsTop, usedColsBot: state.usedColsBot };
  }
  if (!state.byBoard) state.byBoard = new Map();
  let bs = state.byBoard.get(board.id);
  if (!bs) {
    const isPrimary = state.byBoard.size === 0;
    bs = {
      icCol: state.icStart ?? 3,
      usedColsTop: isPrimary && state.usedColsTop ? state.usedColsTop : new Set(),
      usedColsBot: isPrimary && state.usedColsBot ? state.usedColsBot : new Set(),
    };
    state.byBoard.set(board.id, bs);
  }
  return bs;
}

/** Record every strip column spanned by `part`'s pins & body (including interior passive columns). */
function trackPlacedPart(app, part, state) {
  if (!part || !app.circuit.boards.length) return;
  const def = getDef(part.type);
  const pins = part.worldPins();
  for (const b of app.circuit.boards) {
    const bs = getBoardState(b, state);
    const topCols = [];
    const botCols = [];
    for (const q of pins) {
      const hl = app.index.holes.get(key(q.x, q.y));
      if (!hl || hl.rail || holeBoardId(hl) !== b.id) continue;
      if (hl.row < 5) topCols.push(hl.col);
      else botCols.push(hl.col);
    }
    if (topCols.length) {
      const c0 = Math.min(...topCols), c1 = Math.max(...topCols);
      for (let c = c0; c <= c1; c++) bs.usedColsTop.add(c);
    }
    if (botCols.length) {
      const c0 = Math.min(...botCols), c1 = Math.max(...botCols);
      for (let c = c0; c <= c1; c++) bs.usedColsBot.add(c);
    }
    if ((def.ic || def.mcu) && (topCols.length || botCols.length)) {
      const maxCol = Math.max(...topCols, ...botCols);
      bs.icCol = Math.max(bs.icCol, maxCol + (state.icGap ?? 3));
    }
  }
}

function colsAroundPrefer(startCol, endCol, preferCol) {
  const cols = [];
  for (let c = startCol; c <= endCol; c++) cols.push(c);
  if (Number.isFinite(preferCol)) {
    cols.sort((a, b) => Math.abs(a - preferCol) - Math.abs(b - preferCol) || a - b);
  }
  return cols;
}

function addOverflowBreadboard(app, state) {
  const b0 = app.circuit.boards[0];
  const baseX = b0 ? b0.x : 0;
  const maxY = app.circuit.boards.reduce((m, b) => Math.max(m, b.y + b.h), 0);
  const maxX = app.circuit.boards.reduce((m, b) => Math.max(m, b.x + b.w), 0);
  const cands = [];
  for (let ny = maxY + 4; ny <= maxY + 84; ny += 24) cands.push([baseX, ny]);
  cands.push([maxX + 4, b0 ? b0.y : 0]);
  for (const [nx, ny] of cands) {
    const nb = new Board('half', nx, ny);
    const { msg } = app.editor.problems([], [nb]);
    const hitsPart = app.circuit.parts.some(p => boxesIntersect({ x0: nb.x, y0: nb.y, x1: nb.x + nb.w, y1: nb.y + nb.h }, p.bounds(), 0.25));
    if (!msg && !hitsPart) {
      app.circuit.boards.push(nb);
      getBoardState(nb, state);
      app.reindex(true);
      return nb;
    }
  }
  return null;
}

/** Deterministic breadboard & benchtop allocator for a single Part across one or more boards. */
export function placePartSmart(app, spec, state) {
  const resolved = resolvePartType(spec.type, spec.props || {});
  if (!resolved) throw new Error(`Unknown component type "${spec.type}"`);

  const def = getDef(resolved.type);
  const b0 = app.circuit.boards[0];
  const cols0 = b0 ? b0.cols : 30;
  const bx0 = b0 ? b0.x : 0;
  const by0 = b0 ? b0.y : 0;
  const preferCol = Number.isFinite(spec._preferCol) ? spec._preferCol : null;

  const tryAt = (x, y, rot = 0) => {
    const ref = nextRef(app.circuit, resolved.type, spec.ref);
    const p = new Part(resolved.type, Math.round(x), Math.round(y), rot, resolved.props, undefined, ref);
    if (!canPlaceCandidate(app, p)) return null;
    app.circuit.parts.push(p);
    app.reindex(true);
    trackPlacedPart(app, p, state);
    return p;
  };

  // 1. Explicit location override if supplied safely (silently falls through to auto-nudge on collision)
  if (Number.isFinite(spec.x) && Number.isFinite(spec.y)) {
    const hit = tryAt(spec.x, spec.y, spec.rot || 0);
    if (hit) return hit;
  }

  // 1b. Explicit 2D visual grid coordinates (e.g. row/col for 3x3 LED shapes/matrices beside breadboard)
  if (Number.isInteger(spec.row) && Number.isInteger(spec.col) && spec.row >= 0 && spec.col >= 0 && spec.row < 8 && spec.col < 8) {
    const dx = 3;
    const dy = 4;
    if (!state.gridOrigin) {
      const maxR = state.gridMaxRow ?? spec.row;
      const maxC = state.gridMaxCol ?? spec.col;
      const sample = new Part(resolved.type, 0, 0, 0, resolved.props);
      const sb = sample.bounds();
      const bw = b0 ? b0.w : 33;
      const bh = b0 ? b0.h : 20;
      const anchors = [
        [bx0 + bw + 5, by0 + 5],
        [bx0 + 4, by0 + bh + 6],
        [bx0 - (maxC + 1) * dx - 4, by0 + 5],
        [bx0 + 4, by0 - 5 - maxR * dy],
      ];
      for (const [ax, ay] of anchors) {
        const gridBox = { x0: ax + sb.x0 - 0.5, y0: ay + sb.y0 - 0.5, x1: ax + maxC * dx + sb.x1 + 0.5, y1: ay + maxR * dy + sb.y1 + 0.5 };
        const boardBox = b0 ? { x0: b0.x, y0: b0.y, x1: b0.x + b0.w, y1: b0.y + b0.h } : null;
        const hitsBoard = boardBox && boxesIntersect(gridBox, boardBox, 0.25);
        const hitsPart = app.circuit.parts.some(p => boxesIntersect(gridBox, p.bounds(), 0.25));
        if (!hitsBoard && !hitsPart) {
          state.gridOrigin = { x: Math.round(ax), y: Math.round(ay) };
          break;
        }
      }
      if (!state.gridOrigin) state.gridOrigin = { x: Math.round(bx0 + bw + 5), y: Math.round(by0 + 5) };
    }
    const gx = state.gridOrigin.x + spec.col * dx;
    const gy = state.gridOrigin.y + spec.row * dy;
    const hit = tryAt(gx, gy, 0);
    if (hit) return hit;
  }

  // 2. Benchtop Instruments & Trainer Board: neat horizontal shelf above breadboard
  if (def.cat === 'Instruments' || resolved.type === 'trainer-board') {
    const sample = new Part(resolved.type, 0, 0, 0, resolved.props);
    const sb = sample.bounds();
    for (let x = state.instX; x < bx0 + 120; x += 2) {
      const placed = tryAt(x - Math.floor(sb.x0), by0 - 4, 0);
      if (placed) {
        state.instX = Math.ceil(placed.bounds().x1) + 2;
        return placed;
      }
    }
  }

  // 3. Large standalone Arduino Uno: clean benchtop placement beside breadboard
  if (resolved.type === 'uno') {
    for (const [cx, cy] of [
      [bx0 - 31, by0],
      [bx0 + (b0 ? b0.w : 33) + 3, by0],
      [bx0, by0 + (b0 ? b0.h : 20) + 4],
    ]) {
      const placed = tryAt(cx, cy, 0);
      if (placed) return placed;
    }
  }

  // 4. Single-pin power & input modules (vcc, gnd, toggle, button, clock, battery)
  if (resolved.type === 'vcc' || resolved.type === 'gnd') {
    const xs = resolved.type === 'vcc' ? [3, 6, 9, 12, 15, 18, 21] : [6, 3, 9, 12, 15, 18, 21];
    for (const b of (app.circuit.boards.length ? app.circuit.boards : [null])) {
      const bx = b ? b.x : bx0, by = b ? b.y : by0, bh = b ? b.h : 20;
      for (const ox of xs) { const placed = tryAt(bx + ox, by - 3, 0); if (placed) return placed; }
      for (const ox of xs) { const placed = tryAt(bx + ox, by + bh + 3, 2); if (placed) return placed; }
    }
  }
  if (resolved.type === 'toggle' || resolved.type === 'button' || resolved.type === 'clock' || resolved.type === 'battery') {
    for (const b of (app.circuit.boards.length ? app.circuit.boards : [null])) {
      const bx = b ? b.x : bx0, by = b ? b.y : by0, bh = b ? b.h : 20, cols = b ? b.cols : cols0;
      const yBottom = by + bh + 2;
      const yTop = by - 2;
      const candidates = resolved.type === 'clock' ? [yTop, yBottom] : [yBottom, yTop];
      for (const cy of candidates) {
        const rot = cy === yBottom ? 2 : 0;
        for (let c = 4; c <= cols + 2; c += 3) {
          const placed = tryAt(bx + c, cy, rot);
          if (placed) return placed;
        }
      }
    }
  }

  const placeOnBoard = (b) => {
    const bs = getBoardState(b, state);
    const cols = b ? b.cols : 30;
    const bx = b ? b.x : 0;
    const by = b ? b.y : 0;

    // 5. DIP ICs, trench-straddling displays/relays, and breadboard-mounted MCU dev boards
    if (def.ic || def.mcu || resolved.type === 'seg7' || resolved.type === 'tactile' || resolved.type === 'wokwi-relay-module') {
      const sample = new Part(resolved.type, 0, 0, 0, resolved.props);
      const localPins = sample.localPins();
      const minY = Math.min(...localPins.map(q => q.y));
      const span = Math.max(...localPins.map(q => q.x)) + 1;
      let targetY = by + (b ? b.rowY(5) : 11);
      if (b && minY <= -9) targetY = by + b.rowY(8); // esp32/esp32s3 (row a + row i)
      else if (b && minY === -7) targetY = by + b.rowY(7); // seg7 (row c + row h)
      else if (b && minY <= -5) targetY = by + b.rowY(6); // nano/bluepill (row c + row g)

      const startBase = state.icStart ?? 3;
      const icGap = state.icGap ?? 3;
      for (let pass = 0; pass < 2; pass++) {
        const startCol = pass === 0 ? bs.icCol : 0;
        const endCol = pass === 0 ? cols - span : Math.min(bs.icCol - 1, cols - span);
        for (let col = startCol; col <= endCol; col++) {
          const placed = tryAt(bx + 2 + col, targetY, 0);
          if (placed) {
            if (pass === 0) bs.icCol = Math.max(startBase, col + span + icGap);
            return placed;
          }
        }
      }
      return null;
    }

    // 6. Horizontal 4-unit 2-pin passives (resistor, diode, inductor): lock ALL 5 body columns [col..col+4]
    if (resolved.type === 'resistor' || resolved.type === 'diode' || resolved.type === 'inductor') {
      const rowOrder = b ? [b.rowY(6), b.rowY(7), b.rowY(1), b.rowY(2), b.rowY(8), b.rowY(3), b.rowY(5), b.rowY(4)] : [12, 13, 5, 6, 14, 7];
      for (const col of colsAroundPrefer(0, cols - 5, preferCol != null ? preferCol - 2 : null)) {
        for (const ry of rowOrder) {
          const isTop = b ? ry < b.rowY(5) : ry < 9;
          const used = isTop ? bs.usedColsTop : bs.usedColsBot;
          let conflict = false;
          for (let k = col; k <= col + 4; k++) if (used.has(k)) { conflict = true; break; }
          if (conflict) continue;
          const placed = tryAt(bx + 2 + col, by + ry, 0);
          if (placed) return placed;
        }
      }
      // Vertical bridge across empty trench columns (e->g and d->f = 4 units, strictly valid holes)
      if (b) {
        for (const col of colsAroundPrefer(0, cols - 1, preferCol)) {
          if (bs.usedColsTop.has(col) || bs.usedColsBot.has(col)) continue;
          for (const ry of [b.rowY(4), b.rowY(3)]) {
            const placed = tryAt(bx + 2 + col, by + ry, 1);
            if (placed) return placed;
          }
        }
      }
      return null;
    }

    // 7. Tall / upward-extending breadboard parts (LED, capacitor, pot, npn, jfet, buzzer, OLED, LCD, 7seg, etc.)
    const sample = new Part(resolved.type, 0, 0, 0, resolved.props);
    const sb = sample.bounds();
    const bodyHeight = Math.abs(sb.y0);
    const localXs = sample.localPins().map(q => q.x);
    const pinSpan = (localXs.length ? Math.max(...localXs) : 1) + 1;

    const preferredRows = bodyHeight > 3.5 && b
      ? [b.rowY(0), b.rowY(9)]
      : b
        ? [b.rowY(7), b.rowY(6), b.rowY(2), b.rowY(1), b.rowY(8), b.rowY(9)]
        : [13, 12, 6, 5, 14, 15];

    for (const col of colsAroundPrefer(0, cols - pinSpan, preferCol)) {
      for (const ry of preferredRows) {
        const isTop = b ? ry < b.rowY(5) : ry < 9;
        const used = isTop ? bs.usedColsTop : bs.usedColsBot;
        let conflict = false;
        for (let k = col; k < col + pinSpan; k++) if (used.has(k)) { conflict = true; break; }
        if (conflict) continue;
        const placed = tryAt(bx + 2 + col, by + ry, 0);
        if (placed) return placed;
      }
    }
    return null;
  };

  for (const b of (app.circuit.boards.length ? app.circuit.boards : [null])) {
    const placed = placeOnBoard(b);
    if (placed) return placed;
  }

  // Auto-expand to an overflow breadboard when current board(s) are crowded
  const extraBoard = app.circuit.boards.length ? addOverflowBreadboard(app, state) : null;
  if (extraBoard) {
    const placed = placeOnBoard(extraBoard);
    if (placed) return placed;
  }

  // 8. Emergency off-board shelf fallback (only if overflow board itself cannot be placed)
  const sample = new Part(resolved.type, 0, 0, 0, resolved.props);
  const localXs = sample.localPins().map(q => q.x);
  const pinSpan = (localXs.length ? Math.max(...localXs) : 1) + 1;
  const stepX = Math.max(3, pinSpan + 1);
  const bh = b0 ? b0.h : 20;
  for (let rowIdx = 0; rowIdx < 5; rowIdx++) {
    const oy = by0 + bh + 5 + rowIdx * 4;
    for (let ox = bx0 + 2; ox <= bx0 + cols0 - pinSpan + 4; ox += stepX) {
      const placed = tryAt(ox, oy, 0);
      if (placed) return placed;
    }
  }
  for (let ox = bx0 + 2; ox <= bx0 + cols0 - pinSpan + 4; ox += stepX) {
    const placed = tryAt(ox, by0 - 5, 0);
    if (placed) return placed;
  }

  throw new Error(`Could not find a collision-free placement for ${spec.ref || resolved.type} (${resolved.type})`);
}

function findHoleByLabel(app, label) {
  const target = String(label || '').trim().toLowerCase();
  if (!/^[a-j]\d+$/.test(target)) return null;
  for (const [, hl] of app.index.holes) {
    if (!hl.rail && hl.label.toLowerCase() === target) return hl;
  }
  return null;
}

function freeHolesOnStrip(app, strip, preferRow = 2) {
  const ix = app.index;
  const list = [];
  for (const [, hl] of ix.holes) {
    if (hl.rail || hl.strip !== strip) continue;
    const k = key(hl.x, hl.y);
    if (!(ix.pins.get(k)?.length) && !(ix.ends.get(k)?.length)) list.push(hl);
  }
  list.sort((a, b) => Math.abs(a.row - preferRow) - Math.abs(b.row - preferRow));
  return list;
}

/** Find an empty breadboard hole in the same 5-hole strip as `hole`. */
export function freeHoleOnStrip(app, hole) {
  const free = freeHolesOnStrip(app, hole.strip, hole.row);
  if (free.length) return { x: free[0].x, y: free[0].y };
  const ix = app.index;
  const stripHoles = [];
  for (const [, hl] of ix.holes) if (hl.strip === hole.strip) stripHoles.push(hl);
  stripHoles.sort((a, b) => Math.abs(a.row - hole.row) - Math.abs(b.row - hole.row));
  for (const hl of stripHoles) {
    const k = key(hl.x, hl.y);
    if (!(ix.pins.get(k)?.length)) return { x: hl.x, y: hl.y };
  }
  return null;
}

function findEmptyTieStrip(app, nearHole, state) {
  const ix = app.index;
  const nearBoardId = holeBoardId(nearHole);
  const stripMap = new Map();
  for (const [, hl] of ix.holes) {
    if (hl.rail) continue;
    let s = stripMap.get(hl.strip);
    if (!s) {
      s = { strip: hl.strip, board: holeBoardId(hl), col: hl.col, isTop: hl.row < 5, holes: [] };
      stripMap.set(hl.strip, s);
    }
    s.holes.push(hl);
  }
  const cands = [];
  for (const s of stripMap.values()) {
    if (s.holes.length < 5) continue;
    const allEmpty = s.holes.every(hl => {
      const k = key(hl.x, hl.y);
      return !(ix.pins.get(k)?.length) && !(ix.ends.get(k)?.length);
    });
    if (!allEmpty) continue;
    const b = app.circuit.boards.find(br => br.id === s.board);
    const bs = b && state ? getBoardState(b, state) : null;
    const colLocked = bs ? (s.isTop ? bs.usedColsTop.has(s.col) : bs.usedColsBot.has(s.col)) : false;
    s.holes.sort((p, q) => p.row - q.row);
    const dx = Math.abs(s.holes[0].x - nearHole.x);
    const sameBoard = s.board === nearBoardId ? 0 : 1;
    cands.push({ ...s, colLocked, sameBoard, dx });
  }
  cands.sort((a, b) => (a.colLocked ? 1 : 0) - (b.colLocked ? 1 : 0) || a.sameBoard - b.sameBoard || a.dx - b.dx);
  return cands[0] || null;
}

/**
 * Guarantee single-occupancy hole allocation on 5-hole strips: when a strip fills up,
 * bridge via a dedicated spare tie-strip hub (and reuse existing hub strips on the same net).
 */
function allocateTieStripHole(app, hole, wireCtx) {
  if (!wireCtx) return freeHoleOnStrip(app, hole);
  const netId = app.engine.netAt(hole.x, hole.y);
  if (netId >= 0 && wireCtx.hubStrips?.size) {
    for (const hubStrip of wireCtx.hubStrips) {
      const freeHub = freeHolesOnStrip(app, hubStrip, hole.row);
      if (!freeHub.length) continue;
      if (app.engine.netAt(freeHub[0].x, freeHub[0].y) === netId) {
        return { x: freeHub[0].x, y: freeHub[0].y };
      }
    }
  }
  const free = freeHolesOnStrip(app, hole.strip, hole.row);
  if (free.length) return { x: free[0].x, y: free[0].y };

  // Strip has 0 empty holes: evacuate 1 non-pin wire end onto a new tie-strip hub & bridge cleanly
  const ix = app.index;
  const hub = findEmptyTieStrip(app, hole, wireCtx.state);
  if (hub) {
    const stripHoles = [];
    for (const [, hl] of ix.holes) if (hl.strip === hole.strip) stripHoles.push(hl);
    stripHoles.sort((a, b) => Math.abs(a.row - hole.row) - Math.abs(b.row - hole.row));
    for (const hl of stripHoles) {
      const k = key(hl.x, hl.y);
      const ends = ix.ends.get(k);
      if ((ix.pins.get(k)?.length) || !ends || ends.length !== 1) continue;
      const oldEnd = ends[0];
      const oldWire = app.circuit.wires.find(w => w.a === oldEnd || w.b === oldEnd);
      if (!oldWire) continue;

      const h0 = hub.holes[0], h1 = hub.holes[1], h2 = hub.holes[2];
      oldEnd.x = h1.x;
      oldEnd.y = h1.y;
      delete oldEnd.pin;
      wireCtx.wiresToTidy?.push(oldWire);

      const bridgeCol = oldWire.color || '#0a84ff';
      const bridge = new Wire({ x: hl.x, y: hl.y }, { x: h0.x, y: h0.y }, bridgeCol, route(app, hl, h0));
      app.circuit.wires.push(bridge);
      wireCtx.addedWires?.push(bridge);
      wireCtx.wireSpecs?.push({
        aTok: hl.label, bTok: h0.label,
        a: { ...bridge.a }, b: { ...bridge.b },
        color: bridgeCol, aRail: null, bRail: null, bridge: true,
      });
      wireCtx.hubStrips?.add(hub.strip);
      const hb = app.circuit.boards.find(br => br.id === hub.board);
      if (hb && wireCtx.state) {
        const bs = getBoardState(hb, wireCtx.state);
        if (hub.isTop) bs.usedColsTop.add(hub.col);
        else bs.usedColsBot.add(hub.col);
      }
      app.reindex(true);
      return { x: h2.x, y: h2.y };
    }
  }
  return freeHoleOnStrip(app, hole);
}

export function closestRailHole(app, railChar, half, preferX, preferY, boardOnly = null) {
  const railBoards = boardOnly
    ? (boardOnly.rails ? [boardOnly] : [])
    : app.circuit.boards.filter(b => b && b.rails);
  if (!railBoards.length) return null;
  const sortedBoards = [...railBoards].sort((a, b) => Math.abs((a.y + a.h / 2) - preferY) - Math.abs((b.y + b.h / 2) - preferY));
  const ix = app.index;

  for (const b of sortedBoards) {
    const ry = b.railY();
    const topY = b.y + (railChar === '+' ? ry.tp : ry.tn);
    const botY = b.y + (railChar === '+' ? ry.bp : ry.bn);
    const chooseTop = half === 't' ? true : half === 'b' ? false : (preferY <= b.y + 9);
    const primaryY = chooseTop ? topY : botY;
    const secondaryY = chooseTop ? botY : topY;

    for (const y of [primaryY, secondaryY]) {
      const cands = [];
      for (let c = 0; c < b.cols; c++) {
        const x = b.x + 2 + c;
        const k = key(x, y);
        if (!(ix.pins.get(k)?.length) && !(ix.ends.get(k)?.length)) {
          cands.push({ x, y, dist: Math.abs(x - preferX) });
        }
      }
      if (cands.length) {
        cands.sort((p, q) => p.dist - q.dist);
        return { x: cands[0].x, y: cands[0].y, boardId: b.id, usedTop: y === topY, usedBot: y === botY };
      }
    }
  }
  const fb = sortedBoards[0];
  const ry = fb.railY();
  const topY = fb.y + (railChar === '+' ? ry.tp : ry.tn);
  const botY = fb.y + (railChar === '+' ? ry.bp : ry.bn);
  const chooseTop = half === 't' ? true : half === 'b' ? false : (preferY <= fb.y + 9);
  return { x: Math.round(Math.max(fb.x + 2, Math.min(fb.x + 1 + fb.cols, preferX))), y: chooseTop ? topY : botY, boardId: fb.id, usedTop: chooseTop, usedBot: !chooseTop };
}

function lookupRefPart(app, refMap, ref) {
  const exact = refMap.get(ref) || refMap.get(ref.toUpperCase()) || app.circuit.partById(ref);
  if (exact) return exact;
  const singleton = (pred) => {
    const matches = app.circuit.parts.filter(pred);
    return matches.length === 1 ? matches[0] : null;
  };
  if (/^(?:V\d*|VCC\d*|5V|PLUS)$/i.test(ref)) return singleton(p => p.type === 'vcc');
  if (/^(?:G\d*|GND\d*|MINUS)$/i.test(ref)) return singleton(p => p.type === 'gnd');
  if (/^(?:CLK\d*|CLOCK\d*)$/i.test(ref)) return singleton(p => p.type === 'clock');
  if (/^(?:DIP\d*|SW\d*)$/i.test(ref)) return singleton(p => p.type === 'dip8' || p.type === 'dip4');
  return null;
}

/** Resolve an endpoint string (`"U1.VCC"`, `"p3.OUT"`, `"+"`, `"-"`, `"d10"`) to wire end coordinates. */
export function resolveEndpoint(app, token, refMap, otherHint = null, wireCtx = null) {
  const raw = String(token || '').trim();
  const railSpec = parseRailToken(raw);
  if (railSpec) {
    const hx = otherHint?.x ?? (app.circuit.boards[0] ? app.circuit.boards[0].x + 2 : 2);
    const hy = otherHint?.y ?? 0;
    const rh = closestRailHole(app, railSpec.rail, railSpec.half, hx, hy);
    return rh ? { end: { x: rh.x, y: rh.y }, rail: railSpec.rail, boardId: rh.boardId, usedTop: rh.usedTop, usedBot: rh.usedBot } : null;
  }

  const holeByLabel = findHoleByLabel(app, raw);
  if (holeByLabel) {
    const fh = allocateTieStripHole(app, holeByLabel, wireCtx) || { x: holeByLabel.x, y: holeByLabel.y };
    return { end: fh, rail: null };
  }

  const dot = raw.indexOf('.');
  if (dot > 0) {
    const ref = raw.slice(0, dot).trim();
    const pinName = raw.slice(dot + 1).replace(/@.+$/, '').trim();
    const part = lookupRefPart(app, refMap, ref);
    if (!part) {
      const seen = new Map();
      for (const [k, pt] of refMap) if (pt?.id && k !== pt.id && !seen.has(pt.id)) seen.set(pt.id, `${k}(${pt.type})`);
      const known = [...seen.values()].slice(0, 12).join(', ');
      const vccHint = /^(?:V\d*|VCC\d*|G\d*|GND\d*)$/i.test(ref) ? ' — include {"ref":"V1","type":"vcc"} and {"ref":"G1","type":"gnd"} in "parts"!' : '';
      throw new Error(`Unknown part reference "${ref}" in connection "${raw}"${vccHint}${known ? `. Declared parts: [${known}]` : ''}`);
    }
    const pi = resolvePinIndex(part, pinName);
    if (pi < 0) {
      const validPins = part.worldPins().map((p, i) => `${p.name}(#${i + 1})`).join(', ');
      throw new Error(`Unknown pin "${pinName}" on part "${ref}" (${part.type}). Valid pins: [${validPins}]`);
    }
    const wp = part.worldPins()[pi];
    const hole = app.index.holes.get(key(wp.x, wp.y));
    if (hole) {
      const bid = holeBoardId(hole);
      const fh = hole.rail ? freeRailOnHole(app, hole) : allocateTieStripHole(app, hole, wireCtx);
      const hb = app.circuit.boards.find(br => br.id === bid) || app.circuit.boards[0];
      const by = hb ? hb.y : 0;
      if (fh) return { end: fh, rail: hole.rail || null, boardId: bid, usedTop: hole.y <= by + 5, usedBot: hole.y >= by + 16 };
    }
    return { end: { x: wp.x, y: wp.y, pin: { part: part.id, i: wp.i } }, rail: null };
  }

  // Bare 1-pin part ref (e.g. "VCC" -> VCC's pin 0)
  const part = lookupRefPart(app, refMap, raw);
  if (part && part.worldPins().length === 1) {
    const wp = part.worldPins()[0];
    return { end: { x: wp.x, y: wp.y, pin: { part: part.id, i: 0 } }, rail: null };
  }

  throw new Error(`Invalid connection endpoint "${raw}"`);
}

function freeRailOnHole(app, hole) {
  const b = app.circuit.boards.find(br => br.id === holeBoardId(hole)) || app.circuit.boards[0];
  if (!b) return null;
  const r = closestRailHole(app, hole.rail, hole.y <= b.y + 5 ? 't' : 'b', hole.x, hole.y, b);
  return r ? { x: r.x, y: r.y } : null;
}

function inspectPartPinTarget(app, tok, refMap) {
  const raw = String(tok || '').trim();
  if (!raw || parseRailToken(raw) || findHoleByLabel(app, raw)) return null;
  const dot = raw.indexOf('.');
  if (dot <= 0) return null;
  const ref = raw.slice(0, dot).trim();
  const pinName = raw.slice(dot + 1).replace(/@.+$/, '').trim();
  const part = lookupRefPart(app, refMap, ref);
  if (!part) return null;
  const pi = resolvePinIndex(part, pinName);
  if (pi < 0) return null;
  const wp = part.worldPins()[pi];
  const hole = app.index.holes.get(key(wp.x, wp.y)) || null;
  const net = app.engine.netAt(wp.x, wp.y);

  let isSingleDriverInput = false;
  if (!PASSIVE_BODY_TYPES.has(part.type) && !['vcc', 'gnd', 'toggle', 'button', 'clock', 'battery', 'power-supply', 'funcgen', 'oscilloscope', 'pot', 'wokwi-slide-potentiometer'].includes(part.type)) {
    if (part.type === 'led' || part.type === 'buzzer') {
      isSingleDriverInput = true;
    } else if (!/^(?:VCC|VDD|GND|VSS|5V|3V3|VIN|COM\d*)$/i.test(wp.name)) {
      isSingleDriverInput = !/^(?:(?:\d+)?[YQ]|OUT\d*|C4|CO|CARRY|RBO|BO|S\d+|Q\d+|SEG[A-G]|DP|A>B|A=B|A<B|QH'?)$/i.test(wp.name);
    }
  }

  let stripPinCount = 0;
  let stripWireCount = 0;
  if (hole && !hole.rail) {
    for (const [, hl] of app.index.holes) {
      if (hl.strip !== hole.strip) continue;
      const k = key(hl.x, hl.y);
      stripPinCount += app.index.pins.get(k)?.length || 0;
      stripWireCount += app.index.ends.get(k)?.length || 0;
    }
  } else {
    stripPinCount = app.index.pins.get(key(wp.x, wp.y))?.length || 1;
    stripWireCount = app.index.ends.get(key(wp.x, wp.y))?.length || 0;
  }

  return { part, wp, hole, net, isSingleDriverInput, singlePinStrip: stripPinCount <= 1, stripWireCount };
}

function wireEndMatchesTarget(app, endPt, target) {
  if (!endPt || !target) return false;
  if (endPt.x === target.wp.x && endPt.y === target.wp.y) return true;
  if (endPt.pin && endPt.pin.part === target.part.id && endPt.pin.i === target.wp.i) return true;
  if (target.singlePinStrip && target.hole && !target.hole.rail) {
    const eh = app.index.holes.get(key(endPt.x, endPt.y));
    return Boolean(eh && !eh.rail && eh.strip === target.hole.strip);
  }
  return false;
}

function endpointNetHint(app, tok, refMap) {
  const rail = parseRailToken(tok);
  if (rail) {
    for (const [, hl] of app.index.holes) {
      if (hl.rail === rail.rail) {
        const n = app.engine.netAt(hl.x, hl.y);
        if (n >= 0 && app.engine.isNetConnected(n)) return n;
      }
    }
    return -2;
  }
  const t = inspectPartPinTarget(app, tok, refMap);
  if (t) return t.net;
  const bare = lookupRefPart(app, refMap, String(tok || '').trim());
  if (bare && bare.worldPins().length === 1) {
    const q = bare.worldPins()[0];
    return app.engine.netAt(q.x, q.y);
  }
  return -1;
}

function endpointIsActiveDriver(app, tok, refMap) {
  if (parseRailToken(tok)) return true;
  const raw = String(tok || '').trim();
  const dot = raw.indexOf('.');
  if (dot <= 0) {
    const bare = lookupRefPart(app, refMap, raw);
    return Boolean(bare && ['vcc', 'gnd', 'toggle', 'button', 'clock'].includes(bare.type));
  }
  const ref = raw.slice(0, dot).trim();
  const pinName = raw.slice(dot + 1).replace(/@.+$/, '').trim();
  const part = lookupRefPart(app, refMap, ref);
  if (!part) return false;
  if (['vcc', 'gnd', 'toggle', 'button', 'clock', 'dip4', 'dip8', 'funcgen', 'power-supply', 'battery'].includes(part.type)) return true;
  if (PASSIVE_BODY_TYPES.has(part.type) || ['oscilloscope', 'pot', 'wokwi-slide-potentiometer'].includes(part.type)) return false;
  const pi = resolvePinIndex(part, pinName);
  if (pi < 0) return false;
  const wp = part.worldPins()[pi];
  return /^(?:(?:\d+)?[YQ]|OUT\d*|C4|CO|CARRY|RBO|BO|S\d+|Q\d+|SEG[A-G]|DP|A>B|A=B|A<B|QH'?)$/i.test(wp.name);
}

function pruneConflictingDriverWires(app, aTok, bTok, refMap, preExistingWires, removedWires) {
  if (!preExistingWires.size) return;
  const tA = inspectPartPinTarget(app, aTok, refMap);
  const tB = inspectPartPinTarget(app, bTok, refMap);
  const checkReplace = (target, otherTok, otherTarget) => {
    if (!target || !target.isSingleDriverInput || target.stripWireCount === 0) return;
    // Never prune existing wires when attaching instruments (e.g. oscilloscope), bypass caps, or unwired single-driver inputs
    if (otherTarget && otherTarget.isSingleDriverInput && otherTarget.stripWireCount === 0) return;
    if (otherTarget && ['oscilloscope', 'capacitor', 'inductor', 'pot', 'wokwi-slide-potentiometer'].includes(otherTarget.part.type)) return;
    const isDirectDriver = endpointIsActiveDriver(app, otherTok, refMap);
    const isLedSeriesPassive = (target.part.type === 'led' || target.part.type === 'buzzer') && otherTarget && (otherTarget.part.type === 'resistor' || otherTarget.part.type === 'diode');
    if (!isDirectDriver && !isLedSeriesPassive) return;
    const otherNet = endpointNetHint(app, otherTok, refMap);
    if (target.net >= 0 && otherNet >= 0 && target.net === otherNet) return;

    let pruned = false;
    app.circuit.wires = app.circuit.wires.filter((w) => {
      if (!preExistingWires.has(w)) return true;
      const hitsTarget = wireEndMatchesTarget(app, w.a, target) || wireEndMatchesTarget(app, w.b, target);
      if (!hitsTarget) return true;
      removedWires.push({ id: w.id, a: { ...w.a }, b: { ...w.b } });
      pruned = true;
      return false;
    });
    if (pruned) app.reindex(true);
  };
  checkReplace(tA, bTok, tB);
  checkReplace(tB, aTok, tA);
}

function wireLatticeEdges(pathPts) {
  const edges = new Set();
  for (let k = 0; k < pathPts.length - 1; k++) {
    let x = Math.round(pathPts[k].x * 2), y = Math.round(pathPts[k].y * 2);
    const x1 = Math.round(pathPts[k + 1].x * 2), y1 = Math.round(pathPts[k + 1].y * 2);
    if (x !== x1 && y !== y1) continue;
    const dx = Math.sign(x1 - x), dy = Math.sign(y1 - y);
    while (x !== x1 || y !== y1) {
      const nx = x + dx, ny = y + dy;
      edges.add(x < nx || y < ny ? `${x},${y},${nx},${ny}` : `${nx},${ny},${x},${y}`);
      x = nx; y = ny;
    }
  }
  return edges;
}

function wireCrossesAnyBox(w, boxes) {
  if (!boxes.length) return false;
  const pts = w.path();
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i], q = pts[i + 1];
    const x0 = Math.min(p.x, q.x), x1 = Math.max(p.x, q.x);
    const y0 = Math.min(p.y, q.y), y1 = Math.max(p.y, q.y);
    for (const bb of boxes) {
      if (x1 > bb.x0 + 0.15 && x0 < bb.x1 - 0.15 && y1 > bb.y0 + 0.15 && y0 < bb.y1 - 0.15) return true;
    }
  }
  return false;
}

function normalizeFlatConnections(rawConns) {
  const flat = [];
  for (const item of (rawConns || [])) {
    if (Array.isArray(item) && item.length >= 2) {
      for (let k = 0; k < item.length - 1; k++) flat.push([item[k], item[k + 1]]);
    } else if (item && typeof item === 'object') {
      const a = item.from ?? item.a ?? item[0];
      const b = item.to ?? item.b ?? item[1];
      if (a && Array.isArray(b)) {
        for (const dest of b) if (dest) flat.push([a, dest]);
      } else if (a && b) {
        flat.push([a, b]);
      }
    }
  }
  return flat;
}

function tokenRefName(tok) {
  const raw = String(tok || '').trim();
  if (!raw || parseRailToken(raw)) return null;
  const dot = raw.indexOf('.');
  return (dot > 0 ? raw.slice(0, dot) : raw).trim().toUpperCase();
}

export function pickWireColor(aTok, bTok, aRail, bRail, sigIdx, netColorCtx = null) {
  if (aRail === '+' || bRail === '+') return '#e5484d';
  if (aRail === '−' || bRail === '−') return '#2b2d31';
  const hi = (t) => /\b(vcc|vdd|\+5v|5v|3v3|\+)\b/i.test(String(t));
  const lo = (t) => /\b(gnd|vss|0v|−|-)\b/i.test(String(t));
  if (hi(aTok) || hi(bTok)) return '#e5484d';
  if (lo(aTok) || lo(bTok)) return '#2b2d31';

  if (netColorCtx) {
    const { na = -1, nb = -1, netColors, existingWires, engine } = netColorCtx;
    const findNetColor = (net) => {
      if (net < 0) return null;
      if (netColors?.has(net)) return netColors.get(net);
      if (existingWires && engine) {
        for (const w of existingWires) {
          if (w.color === '#e5484d' || w.color === '#2b2d31') continue;
          const wn = engine.netAt(w.a.x, w.a.y);
          if (wn === net && w.color) return w.color;
        }
      }
      return null;
    };
    const reused = findNetColor(na) || findNetColor(nb);
    if (reused) {
      if (netColors) {
        if (na >= 0) netColors.set(na, reused);
        if (nb >= 0) netColors.set(nb, reused);
      }
      return reused;
    }
    const isClk = /\b(clk\d*|clock|ck[ab]?|osc|trig)\b/i.test(`${aTok} ${bTok}`);
    const chosen = isClk && !netColorCtx.usedClockColor
      ? ((netColorCtx.usedClockColor = true), '#f5c400')
      : SIGNAL_COLORS[sigIdx % SIGNAL_COLORS.length];
    if (netColors) {
      if (na >= 0) netColors.set(na, chosen);
      if (nb >= 0) netColors.set(nb, chosen);
    }
    return chosen;
  }
  return SIGNAL_COLORS[sigIdx % SIGNAL_COLORS.length];
}

/** Run headless DRC, logic/constraint verification & 50 ms simulation check on current app.circuit without touching history. */
export function verifyCircuitHealth(app, refById = null, { prompt = '', incremental = false, allowIncomplete = false, strictHealth = false } = {}) {
  const skipCompleteChecks = allowIncomplete || (incremental && !strictHealth);
  app.reindex(false);
  const errors = [];
  const warnings = [];

  const prob = app.editor.problems(app.circuit.parts, app.circuit.boards);
  if (prob.msg) errors.push(prob.msg);

  for (const iss of app.allIssues()) {
    if (iss.level === 'error') errors.push(iss.text);
    else if (iss.level === 'warn') warnings.push(iss.text);
  }

  if (!allowIncomplete) {
    for (const cErr of verifyPromptConstraints(prompt, app.circuit, refById)) errors.push(cErr);
  }

  // Short headless simulation pass (also compiles any MCU sketches via runtime)
  const sim = new Engine();
  sim.build(app.circuit);
  const supplyNets = new Set();
  for (const p of app.circuit.parts) {
    const def = getDef(p.type);
    const ent = sim.byPart.get(p.id);
    if (!def.supply || !ent) continue;
    for (const s of def.supply(p)) {
      const n = ent.pinNets[s.i];
      if (n >= 0) supplyNets.add(n);
    }
  }
  const hasVccPart = app.circuit.parts.some(p => p.type === 'vcc' || p.type === 'battery' || p.type === 'power-supply' || getDef(p.type).mcu || p.type === 'trainer-board');
  const hasGndPart = app.circuit.parts.some(p => p.type === 'gnd' || p.type === 'battery' || p.type === 'power-supply' || getDef(p.type).mcu || p.type === 'trainer-board');
  const needsSupply = app.circuit.parts.some(p => ['led', 'buzzer', 'seg7', 'bargraph', 'ne555', 'board-ssd1306', 'wokwi-lcd1602'].includes(p.type) || getDef(p.type).ic);
  if (!skipCompleteChecks && needsSupply && (!hasVccPart || !hasGndPart)) {
    const missingBoth = !hasVccPart && !hasGndPart ? 'BOTH "vcc" (wired to "+") AND "gnd" (wired to "-")' : (!hasVccPart ? '"vcc" wired to "+"' : '"gnd" wired to "-"');
    errors.push(`Breadboard has NO power supply! Add ${missingBoth} so the LEDs/components have power.`);
  }
  for (const p of app.circuit.parts) {
    const ent = sim.byPart.get(p.id);
    if (!ent) continue;
    const tag = refById?.get(p.id) || p.id;
    if (p.type === 'toggle' || p.type === 'button' || p.type === 'clock') {
      const n = ent.pinNets?.[0] ?? -1;
      if (n >= 0 && supplyNets.has(n)) {
        errors.push(`${getDef(p.type).short || p.type} (ref "${tag}") OUT is a 1-pin active HIGH/LOW driver; do NOT wire it directly to +5V or GND (wire "${tag}.OUT" directly to its destination input).`);
      }
    } else if (p.type === 'dip4' || p.type === 'dip8') {
      for (let i = 0; i < ent.pinNets.length; i++) {
        const n = ent.pinNets[i];
        if (n >= 0 && supplyNets.has(n)) {
          errors.push(`${getDef(p.type).name} (ref "${tag}") S${i + 1} is an active 5V/0V output switch; do NOT wire it directly to +5V or GND (wire "${tag}.S${i + 1}" directly to your load or gate).`);
        }
      }
    } else if (p.type === 'vcc' || p.type === 'gnd') {
      if (!allowIncomplete) {
        const n = ent.pinNets?.[0] ?? -1;
        if (n >= 0 && !sim.isNetConnected(n)) {
          const rail = p.type === 'vcc' ? '+' : '-';
          errors.push(`${p.type} ("${tag}") is placed but unconnected — wire "${tag}.1" to "${rail}" so the breadboard rail has power.`);
        }
      }
    } else if (p.type === 'ne555') {
      const nCtrl = ent.pinNets?.[4] ?? -1;
      const nDis = ent.pinNets?.[6] ?? -1;
      if (nCtrl >= 0 && supplyNets.has(nCtrl)) {
        errors.push(`ne555 ("${tag}") CTRL (pin 5) must NOT be wired directly to +5V or GND (leave unconnected or decouple via capacitor to GND).`);
      }
      if (nDis >= 0 && supplyNets.has(nDis)) {
        errors.push(`ne555 ("${tag}") DIS (pin 7) must NOT be wired directly to +5V or GND (connect R1 from + to DIS and R2 from DIS to THR).`);
      }
      if (!allowIncomplete) {
        for (const [idx, nm] of [[1, 'TRIG'], [5, 'THR']]) {
          const pn = ent.pinNets?.[idx] ?? -1;
          if (pn >= 0 && !sim.isNetConnected(pn)) {
            errors.push(`ne555 ("${tag}") ${nm} pin is unconnected — for astable tie THR->TRIG, R1(+->DIS), R2(DIS->THR), C(THR->-), RESET->+; for monostable tie DIS->THR->C->-, R(+->DIS), input->TRIG, RESET->+.`);
          }
        }
      }
    } else if (p.type === 'tactile') {
      if (!allowIncomplete && ent.pinNets.length === 4) {
        const side1 = sim.isNetConnected(ent.pinNets[0]) || sim.isNetConnected(ent.pinNets[1]);
        const side2 = sim.isNetConnected(ent.pinNets[2]) || sim.isNetConnected(ent.pinNets[3]);
        if ((side1 && !side2) || (side2 && !side1)) {
          errors.push(`tactile button ("${tag}") only connects to one internally-bridged side (1.l/1.r OR 2.l/2.r) so pressing it cannot switch — wire one terminal to "${tag}.1.l" and the switched terminal to "${tag}.2.l".`);
        }
      }
    } else if (p.type === 'resistor' || p.type === 'led' || p.type === 'diode' || p.type === 'capacitor' || p.type === 'inductor') {
      if (!allowIncomplete) {
        const wPins = p.worldPins();
        if (ent.pinNets.length === 2 && wPins.length === 2) {
          const c0 = sim.isNetConnected(ent.pinNets[0]);
          const c1 = sim.isNetConnected(ent.pinNets[1]);
          if (c0 !== c1) {
            const openName = c0 ? wPins[1].name : wPins[0].name;
            errors.push(`${getDef(p.type).short || p.type} ("${tag}") has one open/unconnected pin ("${openName}") — connect "${tag}.${openName}" to complete the circuit.`);
          }
        }
      }
    }
  }
  for (const d of sim.devices) {
    if (d.rt?.error) errors.push(`${getDef(d.part.type).name} sketch error${d.rt.errorLine ? ` (line ${d.rt.errorLine})` : ''}: ${d.rt.error}`);
  }
  const dt = Math.min(0.005, sim.suggestDt ? sim.suggestDt() : 0.005);
  for (let i = 0; i < 12; i++) sim.step(dt);
  for (const w of sim.collectWarnings()) {
    if (w.level === 'error') {
      if (/no power/i.test(w.text) && w.part) {
        if (!allowIncomplete) {
          const tag = refById?.get(w.part.id) || w.part.id;
          const missing = `${!hasVccPart ? ' Missing "vcc" part wired to "+".' : ''}${!hasGndPart ? ' Missing "gnd" part wired to "-".' : ''}`;
          errors.push(`IC "${tag}" (${w.part.type}): ${w.text}.${missing} Ensure "V1.1"->"+", "G1.1"->"-", "${tag}.VCC"->"+", "${tag}.GND"->"-"`);
        }
      } else {
        errors.push(w.text);
      }
    } else if (w.level === 'warn') warnings.push(w.text);
  }
  for (const d of sim.devices) {
    if (d.rt?.error) errors.push(`${getDef(d.part.type).name} runtime error: ${d.rt.error}`);
    if (d.rt?.notes?.length) {
      for (const note of d.rt.notes) {
        if (/doesn’t exist|input-only/i.test(note)) errors.push(`${getDef(d.part.type).name}: ${note}`);
        else warnings.push(note);
      }
    }
  }
  if (!skipCompleteChecks) {
    for (const p of app.circuit.parts) {
      if (!getDef(p.type).mcu) continue;
      const ent = sim.byPart.get(p.id);
      const anyConnected = Boolean(ent?.pinNets?.some(n => sim.isNetConnected(n)));
      if (!anyConnected) {
        const tag = refById?.get(p.id) || p.id;
        errors.push(`MCU "${tag}" (${p.type}) has 0 wired pins! If modifying code on an existing board, set "clearExisting":false and use "updates":[{"id":"${tag}","props":{"code":"..."}}] instead of replacing the circuit.`);
      }
    }
  }

  if (!errors.length) {
    for (const cErr of verifyOutputContention(sim, app.circuit, refById)) errors.push(cErr);
    if (!skipCompleteChecks) {
      for (const fErr of verifyFloatingIcInputs(sim, app.circuit, refById)) errors.push(fErr);
    }
  }
  if (!errors.length && !skipCompleteChecks) {
    for (const bErr of verifyBooleanBehavior(prompt, sim, app.circuit, refById)) errors.push(bErr);
    for (const cErr of verifyCombinationalSwitchLiveness(sim, app.circuit)) errors.push(cErr);
    for (const sErr of verifySequentialClockLiveness(sim, app.circuit, refById)) errors.push(sErr);
    for (const pErr of verifyStaticLedPattern(prompt, sim, app.circuit)) errors.push(pErr);
    for (const lErr of verifyActiveLedHealth(prompt, sim, app.circuit, refById, { requireWiredAll: strictHealth })) errors.push(lErr);
    for (const mErr of verifyMcuSketchPinCrossCheck(sim, app.circuit, refById)) errors.push(mErr);
    for (const iErr of verifyInstrumentAndLoadLiveness(sim, app.circuit, refById)) errors.push(iErr);
  }

  return { ok: errors.length === 0, errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

function wireEndMatchesToken(app, endPt, rawTok, refMap) {
  const raw = String(rawTok || '').trim();
  if (!raw) return false;
  const endHole = app.index.holes.get(key(endPt.x, endPt.y));

  const railSpec = parseRailToken(raw);
  if (railSpec) {
    if (!endHole || endHole.rail !== railSpec.rail) return false;
    const b = app.circuit.boards[0];
    if (b && railSpec.half !== 'auto') {
      const isTop = endHole.y <= b.y + 5;
      if ((railSpec.half === 't') !== isTop) return false;
    }
    return true;
  }

  const holeTok = findHoleByLabel(app, raw);
  if (holeTok) {
    return (endPt.x === holeTok.x && endPt.y === holeTok.y) || (endHole && endHole.strip === holeTok.strip);
  }

  const atStripped = raw.replace(/@.+$/, '').trim();
  const dot = atStripped.indexOf('.');
  if (dot > 0) {
    const ref = atStripped.slice(0, dot).trim();
    const pinName = atStripped.slice(dot + 1).trim();
    const part = refMap.get(ref) || refMap.get(ref.toUpperCase()) || app.circuit.partById(ref);
    if (!part) return false;
    const pi = resolvePinIndex(part, pinName);
    if (pi < 0) return false;
    const wp = part.worldPins()[pi];
    if (endPt.x === wp.x && endPt.y === wp.y) return true;
    if (endPt.pin && endPt.pin.part === part.id && endPt.pin.i === wp.i) return true;
    const pinHole = app.index.holes.get(key(wp.x, wp.y));
    return Boolean(endHole && pinHole && endHole.strip === pinHole.strip);
  }

  const part = refMap.get(atStripped) || refMap.get(atStripped.toUpperCase()) || app.circuit.partById(atStripped);
  if (part && part.worldPins().length === 1) {
    const wp = part.worldPins()[0];
    const pinHole = app.index.holes.get(key(wp.x, wp.y));
    return (endPt.x === wp.x && endPt.y === wp.y) || Boolean(endHole && pinHole && endHole.strip === pinHole.strip);
  }
  return false;
}

const SCOPE_TIMEDIVS = [0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5];

/**
 * 0ms Universal Archetype Auto-Healers (no API retries wasted):
 * 1) Internally-bridged switch pins (e.g. tactile 1.l+1.r -> 1.l+2.l)
 * 2) Unwired oscilloscope GND ref & mismatched timeDiv scaling
 * 3) Standalone reverse-biased LED strip swap (when Anode/Cathode wires sit in clean strips)
 */
function autoHealObviousWiring({ app, plan, refById, wirePair, addedWires, wireCtx, skippedNotes }) {
  if (plan?.autoHeal === false) return;
  app.reindex(true);

  const stripOf = (x, y) => {
    const h = app.index.holes.get(key(x, y));
    return h && !h.rail ? h.strip : null;
  };
  const endMatchesPin = (end, wp, pStrip) =>
    (end.x === wp.x && end.y === wp.y) || (pStrip && stripOf(end.x, end.y) === pStrip);

  // Archetype 1: Non-static internally-linked pins (tactile switches wired across only one linked pair)
  for (const p of app.circuit.parts) {
    const def = getDef(p.type);
    if (!def.links || def.staticLinks) continue;
    const links = def.links(p);
    if (!links?.length) continue;
    const wPins = p.worldPins();
    const nPins = wPins.length;
    const parent = Array.from({ length: nPins }, (_, i) => i);
    const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    for (const [a, b] of links) {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    }
    const groups = new Map();
    for (let i = 0; i < nPins; i++) {
      const r = find(i);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(i);
    }
    if (groups.size < 2) continue;

    const pinStrips = wPins.map(wp => stripOf(wp.x, wp.y));
    const groupWires = new Map([...groups.keys()].map(g => [g, []]));
    for (const w of app.circuit.wires) {
      for (let i = 0; i < nPins; i++) {
        if (endMatchesPin(w.a, wPins[i], pinStrips[i])) groupWires.get(find(i)).push({ w, endKey: 'a', pinIdx: i });
        else if (endMatchesPin(w.b, wPins[i], pinStrips[i])) groupWires.get(find(i)).push({ w, endKey: 'b', pinIdx: i });
      }
    }
    const activeGroups = [...groupWires.entries()].filter(([, list]) => list.length > 0);
    const emptyGroups = [...groupWires.entries()].filter(([, list]) => list.length === 0).map(([g]) => g);
    if (activeGroups.length === 1 && activeGroups[0][1].length >= 2 && emptyGroups.length >= 1) {
      const hit = activeGroups[0][1][activeGroups[0][1].length - 1];
      const targetIdx = groups.get(emptyGroups[0])[0];
      const targetWp = wPins[targetIdx];
      const otherEnd = hit.endKey === 'a' ? hit.w.b : hit.w.a;
      const targetHole = app.index.holes.get(key(targetWp.x, targetWp.y));
      const newEnd = (targetHole && !targetHole.rail ? allocateTieStripHole(app, targetHole, wireCtx) : null)
        || { x: targetWp.x, y: targetWp.y, pin: { part: p.id, i: targetIdx } };
      if (!app.shortReason(otherEnd, newEnd)) {
        hit.w[hit.endKey] = newEnd;
        hit.w.pts = route(app, hit.w.a, hit.w.b);
        app.reindex(true);
        const tag = refById?.get(p.id) || p.id;
        skippedNotes.push(`Auto-healed ${tag}: moved ${wPins[hit.pinIdx].name} wire to switched pin ${targetWp.name}.`);
      }
    }
  }

  // Archetype 5: Auto-ground oscilloscope & auto-range timeDiv to signal frequency
  const hasGndRail = app.circuit.parts.some(p => p.type === 'gnd' || p.type === 'battery' || p.type === 'power-supply' || getDef(p.type).mcu);
  let estHz = 0;
  for (const src of app.circuit.parts) {
    if (src.type === 'funcgen' || src.type === 'clock') {
      const f = +(src.props?.hz || src.props?.frequency || 0);
      if (f > 0) estHz = estHz ? Math.min(estHz, f) : f;
    } else if (src.type === 'ne555') {
      const ent = app.engine.byPart.get(src.id);
      const nDis = ent?.pinNets?.[6] ?? -1, nThr = ent?.pinNets?.[5] ?? -1, nGnd = ent?.pinNets?.[0] ?? -1;
      let rSum = 0, cSum = 0;
      for (const rp of app.circuit.parts) {
        const re = app.engine.byPart.get(rp.id);
        if (!re) continue;
        if (rp.type === 'resistor') {
          const on555 = re.pinNets.some(n => n >= 0 && (n === nDis || n === nThr));
          if (on555) rSum += Math.max(100, +(rp.props?.ohms || 1000));
        } else if (rp.type === 'capacitor') {
          const onThr = re.pinNets.some(n => n >= 0 && n === nThr);
          if (onThr) cSum += Math.max(1e-12, (+(rp.props?.uf || 1)) * 1e-6);
        }
      }
      if (rSum > 0 && cSum > 0 && nThr >= 0 && nThr !== nGnd) {
        const f555 = 1.44 / (rSum * cSum);
        if (f555 > 0.05 && f555 < 100000) estHz = estHz ? Math.min(estHz, f555) : f555;
      }
    }
  }
  for (const sc of app.circuit.parts) {
    if (sc.type !== 'oscilloscope') continue;
    const ent = app.engine.byPart.get(sc.id);
    if (!ent) continue;
    const chWired = app.engine.isNetConnected(ent.pinNets[0]) || app.engine.isNetConnected(ent.pinNets[2]);
    if (chWired && hasGndRail) {
      const gndNet = ent.pinNets[1];
      const hasSupplyGnd = (app.netKinds.get(gndNet) || []).some(k => String(k.kind).startsWith('G') || String(k.kind).startsWith('B-'));
      const gndPins = new Set([1, 3, 5, 7].map(i => sc.worldPins()[i]).map(q => key(q.x, q.y)));
      const anyGndWire = app.circuit.wires.some(w =>
        app.engine.netAt(w.a.x, w.a.y) === gndNet && (!gndPins.has(key(w.a.x, w.a.y)) || !gndPins.has(key(w.b.x, w.b.y)))
      );
      if (!hasSupplyGnd && !anyGndWire) {
        try {
          wirePair(`${refById?.get(sc.id) || sc.id}.CH1 GND`, '-');
          skippedNotes.push(`Auto-grounded ${refById?.get(sc.id) || sc.id}.CH1 GND to "-".`);
        } catch { /* ignore if incompatible */ }
      }
    }
    if (estHz > 0) {
      const curSpan = (+(sc.props?.timeDiv || 0.05)) * 10;
      if (curSpan < 1.2 / estHz || curSpan > 80 / estHz) {
        const idealTD = 0.25 / estHz;
        const bestTD = SCOPE_TIMEDIVS.reduce((b, x) => (Math.abs(x - idealTD) < Math.abs(b - idealTD) ? x : b), SCOPE_TIMEDIVS[6]);
        sc.props.timeDiv = bestTD;
      }
    }
  }

  // Archetype 2: Reverse-biased standalone LED polarity swap in clean breadboard strips
  const hasMcu = app.circuit.parts.some(p => getDef(p.type).mcu);
  const leds = app.circuit.parts.filter(p => p.type === 'led');
  if (!hasMcu && leds.length > 0 && leds.length < 4) {
    const simCheck = new Engine();
    simCheck.build(app.circuit);
    for (let s = 0; s < 4; s++) simCheck.step(0.005);
    for (const led of leds) {
      const ent = simCheck.byPart.get(led.id);
      if (!ent) continue;
      const nA = ent.pinNets[0], nK = ent.pinNets[1];
      if (nA < 0 || nK < 0 || nA === nK) continue;
      const vA = simCheck.voltage(nA), vK = simCheck.voltage(nK);
      const curA = Math.abs(ent.device?.cur?.[0] || 0);
      if (curA < 1e-6 && Number.isFinite(vA) && Number.isFinite(vK) && vK > vA + 1.5) {
        const wps = led.worldPins();
        const sA = stripOf(wps[0].x, wps[0].y);
        const sK = stripOf(wps[1].x, wps[1].y);
        if (!sA || !sK || sA === sK) continue;
        const pinInStrip = (s) => app.circuit.parts.some(op => op.id !== led.id && op.worldPins().some(q => stripOf(q.x, q.y) === s));
        if (pinInStrip(sA) || pinInStrip(sK)) continue;

        const moveEnd = (w, endKey, targetStrip, targetWp) => {
          const hl = app.index.holes.get(key(targetWp.x, targetWp.y));
          w[endKey] = (hl ? allocateTieStripHole(app, hl, wireCtx) : null) || { x: targetWp.x, y: targetWp.y };
        };
        const touched = [];
        for (const w of app.circuit.wires) {
          for (const ek of ['a', 'b']) {
            const st = stripOf(w[ek].x, w[ek].y);
            if (st === sA) touched.push({ w, ek, toStrip: sK, toWp: wps[1], orig: { ...w[ek] }, origPts: w.pts.map(pt => ({ ...pt })) });
            else if (st === sK) touched.push({ w, ek, toStrip: sA, toWp: wps[0], orig: { ...w[ek] }, origPts: w.pts.map(pt => ({ ...pt })) });
          }
        }
        if (touched.length < 2) continue;
        for (const t of touched) { t.w[t.ek] = { x: -999, y: -999 }; }
        app.reindex(true);
        for (const t of touched) moveEnd(t.w, t.ek, t.toStrip, t.toWp);
        for (const t of touched) t.w.pts = route(app, t.w.a, t.w.b);
        app.reindex(true);

        const ver = new Engine();
        ver.build(app.circuit);
        for (let s = 0; s < 4; s++) ver.step(0.005);
        const ve = ver.byPart.get(led.id);
        const nvA = ver.voltage(ve.pinNets[0]), nvK = ver.voltage(ve.pinNets[1]);
        const nCur = Math.abs(ve.device?.cur?.[0] || 0);
        if (nCur > 0.0001 || (Number.isFinite(nvA) && Number.isFinite(nvK) && nvA > nvK)) {
          skippedNotes.push(`Auto-healed ${refById?.get(led.id) || led.id}: swapped reverse-biased Anode/Cathode wires.`);
        } else {
          for (const t of touched) { t.w[t.ek] = t.orig; t.w.pts = t.origPts; }
          app.reindex(true);
        }
      }
    }
  }
}

/**
 * Apply a structured AI build/edit plan to `app.circuit`.
 * Allocates components deterministically, routes clean wires, configures MCUs/probes,
 * verifies circuit health headlessly, and rolls back safely on unrecoverable errors.
 */
export function applyAiBuildPlan(app, plan, { commit = true, startSim = true, prompt = '', allowIncomplete = false, initialRefMap = null, strictHealth = false } = {}) {
  const backup = JSON.stringify(app.circuit);
  const prevMode = app.mode;
  const refMap = new Map();
  if (initialRefMap) {
    for (const [k, v] of initialRefMap) {
      const livePart = v?.id ? (app.circuit.partById(v.id) || v) : null;
      if (livePart) refMap.set(k, livePart);
    }
  }

  try {
    const rawParts = Array.isArray(plan.parts) ? plan.parts.map(normalizePartSpec) : [];
    const clear = plan.clearExisting !== false && rawParts.length > 0;
    let estIcCount = 0;
    let estIcSpanCols = 0;
    for (const sp of rawParts) {
      const r = resolvePartType(sp.type, sp.props);
      if (r && getDef(r.type).ic) { estIcCount++; estIcSpanCols += Math.ceil(getDef(r.type).ic.n / 2); }
    }
    if (clear) {
      let estCols = 0;
      for (const sp of rawParts) {
        const res = resolvePartType(sp.type, sp.props);
        if (!res) continue;
        const d = getDef(res.type);
        if (d.ic) estCols += (d.ic.n / 2) + 3;
        else if (d.mcu && res.type !== 'uno') estCols += 20;
        else if (res.type === 'resistor' || res.type === 'diode') estCols += 3;
        else if (d.cat !== 'Instruments') estCols += 2;
      }
      const needsRails = (plan.connections || []).some(([a, b]) => parseRailToken(a) || parseRailToken(b));
      let boardSize = plan.board || 'half';
      if (boardSize === 'mini' && needsRails) boardSize = 'half';
      if (boardSize === 'half' && (estCols > 26 || estIcCount >= 4)) boardSize = 'full';

      app.circuit.boards = [new Board(boardSize, 0, 0)];
      app.circuit.parts = [];
      app.circuit.wires = [];
      app.circuit.probes = [];
      app.samples.clear();
      app.reindex(true);
    } else if (!app.circuit.boards.length) {
      app.circuit.boards.push(new Board(plan.board || 'half', 0, 0));
      app.reindex(true);
    }

    // Existing parts become directly addressable by ID or Designator
    for (const p of app.circuit.parts) {
      refMap.set(p.id, p);
      if (p.ref) { refMap.set(p.ref, p); refMap.set(p.ref.toUpperCase(), p); }
    }

    // Apply part deletions (including manual hole wires directly attached to deleted pins)
    if (Array.isArray(plan.remove) && plan.remove.length) {
      const rm = new Set(plan.remove);
      const rmPinKeys = new Set();
      for (const p of app.circuit.parts) {
        if (!rm.has(p.id)) continue;
        for (const q of p.worldPins()) rmPinKeys.add(key(q.x, q.y));
      }
      app.circuit.parts = app.circuit.parts.filter(p => !rm.has(p.id));
      app.circuit.wires = app.circuit.wires.filter(w =>
        !(w.a.pin && rm.has(w.a.pin.part)) && !(w.b.pin && rm.has(w.b.pin.part)) &&
        !rmPinKeys.has(key(w.a.x, w.a.y)) && !rmPinKeys.has(key(w.b.x, w.b.y))
      );
      app.reindex(true);
    }

    // Apply surgical wire removals by wire ID ("w3") or endpoint pair (["p1.K", "+"])
    const removedWires = [];
    if (Array.isArray(plan.removeWires) && plan.removeWires.length) {
      const rmIds = new Set();
      const rmPairs = [];
      for (const item of plan.removeWires) {
        if (typeof item === 'string') rmIds.add(item.trim());
        else if (Array.isArray(item) && item.length >= 2) rmPairs.push([item[0], item[1]]);
        else if (item && typeof item === 'object') {
          if (item.id) rmIds.add(String(item.id).trim());
          else if ((item.from ?? item.a) && (item.to ?? item.b)) rmPairs.push([item.from ?? item.a, item.to ?? item.b]);
        }
      }
      app.circuit.wires = app.circuit.wires.filter((w) => {
        const hitId = rmIds.has(w.id);
        const hitPair = rmPairs.some(([tokA, tokB]) =>
          (wireEndMatchesToken(app, w.a, tokA, refMap) && wireEndMatchesToken(app, w.b, tokB, refMap)) ||
          (wireEndMatchesToken(app, w.a, tokB, refMap) && wireEndMatchesToken(app, w.b, tokA, refMap))
        );
        if (hitId || hitPair) {
          removedWires.push({ id: w.id, a: { ...w.a }, b: { ...w.b } });
          return false;
        }
        return true;
      });
      if (removedWires.length) app.reindex(true);
    }

    // Apply property/code updates on existing parts
    const updatedSpecs = [];
    if (Array.isArray(plan.updates)) {
      for (const u of plan.updates) {
        const targetId = u?.id ?? u?.ref;
        const p = refMap.get(targetId) || app.circuit.partById(targetId);
        if (!p) continue;
        const rawProps = u.props && typeof u.props === 'object' ? u.props : normalizePartSpec(u).props;
        if (!rawProps || !Object.keys(rawProps).length) continue;
        const norm = resolvePartType(p.type, rawProps)?.props || rawProps;
        Object.assign(p.props, norm);
        delete p.props.damaged;
        updatedSpecs.push({ partId: p.id, props: norm, name: getDef(p.type).name });
      }
      if (updatedSpecs.length) app.reindex(true);
    }

    // Track breadboard allocation state (seeding all boards & full body spans)
    const preExistingWires = new Set(clear ? [] : app.circuit.wires);
    const b0 = app.circuit.boards[0];
    // Auto-assign 2D row/col grid coordinates if prompt asks for a square/NxM LED array and LLM omitted row/col
    const ledSpecsNoGrid = rawParts.filter(s => {
      const rt = resolvePartType(s.type, s.props)?.type;
      return rt === 'led' && !(Number.isInteger(s.row) && Number.isInteger(s.col));
    });
    if (ledSpecsNoGrid.length >= 4 && ledSpecsNoGrid.length <= 25 && /\b(\d+\s*[x×]\s*\d+|square|grid|matrix)\b/i.test(prompt)) {
      const mGrid = /\b(\d+)\s*[x×]\s*(\d+)\b/i.exec(prompt);
      let gCols = mGrid ? parseInt(mGrid[2], 10) : Math.round(Math.sqrt(ledSpecsNoGrid.length));
      if (gCols >= 2 && gCols <= 6 && (!mGrid || parseInt(mGrid[1], 10) * gCols === ledSpecsNoGrid.length) && (mGrid || gCols * gCols === ledSpecsNoGrid.length)) {
        ledSpecsNoGrid.forEach((sp, idx) => {
          sp.row = Math.floor(idx / gCols);
          sp.col = idx % gCols;
        });
      }
    }
    const totalIcs = clear ? estIcCount : (estIcCount + app.circuit.parts.filter(p => getDef(p.type).ic).length);
    const icGap = totalIcs >= 8 || estIcSpanCols > 48 ? 1 : (totalIcs >= 6 || estIcSpanCols > 32 ? 2 : 3);
    const icStart = icGap < 3 ? 1 : 3;
    const gridRows = rawParts.filter(s => Number.isInteger(s.row) && Number.isInteger(s.col));
    const layoutState = {
      icCol: icStart,
      icStart,
      icGap,
      instX: b0 ? b0.x : 0,
      usedColsTop: new Set(),
      usedColsBot: new Set(),
      byBoard: new Map(),
      gridOrigin: null,
      gridMaxRow: gridRows.length ? Math.max(...gridRows.map(s => s.row)) : 0,
      gridMaxCol: gridRows.length ? Math.max(...gridRows.map(s => s.col)) : 0,
    };
    for (const brd of app.circuit.boards) getBoardState(brd, layoutState);
    if (!clear) {
      for (const p of app.circuit.parts) {
        const def = getDef(p.type);
        if (def.cat === 'Instruments' || p.type === 'trainer-board') {
          layoutState.instX = Math.max(layoutState.instX, Math.ceil(p.bounds().x1) + 2);
        }
        trackPlacedPart(app, p, layoutState);
      }
    }

    const flatConnections = normalizeFlatConnections(plan.connections);
    const neighborRefs = new Map();
    const linkRefs = (rA, rB) => {
      if (!rA || !rB || rA === rB) return;
      if (!neighborRefs.has(rA)) neighborRefs.set(rA, new Set());
      if (!neighborRefs.has(rB)) neighborRefs.set(rB, new Set());
      neighborRefs.get(rA).add(rB);
      neighborRefs.get(rB).add(rA);
    };
    for (const [aTok, bTok] of flatConnections) linkRefs(tokenRefName(aTok), tokenRefName(bTok));

    // Order placement: Instruments/Power first -> ICs/MCUs -> Flat passives -> Output/remaining parts
    const partSpecs = [...rawParts];
    const priority = (sp) => {
      const r = resolvePartType(sp.type, sp.props);
      if (!r) return 5;
      const d = getDef(r.type);
      if (d.cat === 'Instruments' || r.type === 'trainer-board') return 0;
      if (r.type === 'vcc' || r.type === 'gnd' || r.type === 'uno') return 1;
      if (d.ic || d.mcu) return 2;
      if (r.type === 'resistor' || r.type === 'diode' || r.type === 'inductor') return 3;
      return 4;
    };
    partSpecs.sort((a, b) => priority(a) - priority(b));

    const placedSpecs = [];
    const newlyPlacedParts = [];
    for (const sp of partSpecs) {
      if (!sp || sp._invalid || !String(sp.type || '').trim()) {
        throw new Error('Invalid entry in "parts" array — each part must be { "ref": "U1", "type": "<valid_type>", "props": {} }');
      }
      // Skip already-placed refs/IDs during incremental or multi-stage builds
      if (!clear && sp.ref && (app.circuit.partById(sp.ref) || refMap.has(sp.ref) || refMap.has(String(sp.ref).toUpperCase()))) continue;

      let preferCol = null;
      const keyRef = sp.ref ? String(sp.ref).toUpperCase() : null;
      if (keyRef && neighborRefs.has(keyRef)) {
        const cols = [];
        for (const nbr of neighborRefs.get(keyRef)) {
          const np = refMap.get(nbr);
          if (!np) continue;
          for (const q of np.worldPins()) {
            const hl = app.index.holes.get(key(q.x, q.y));
            if (hl && !hl.rail) { cols.push(hl.col); break; }
          }
        }
        if (cols.length) preferCol = Math.round(cols.reduce((s, c) => s + c, 0) / cols.length);
      }

      const placed = placePartSmart(app, { ...sp, _preferCol: preferCol }, layoutState);
      newlyPlacedParts.push(placed);
      if (sp.ref) {
        refMap.set(sp.ref, placed);
        refMap.set(String(sp.ref).toUpperCase(), placed);
      }
      refMap.set(placed.id, placed);
      placedSpecs.push({
        ref: sp.ref || placed.id,
        partId: placed.id,
        type: placed.type,
        name: getDef(placed.type).name,
        props: sp.props || {},
        x: placed.x,
        y: placed.y,
        rot: placed.rot,
      });
    }

    // Track per-board rail taps (top/bottom + and -) for automatic rail bridging
    const railTapByBoard = new Map();
    const markRailTap = (boardId, railChar, isTop, isBot) => {
      if (!boardId) return;
      let t = railTapByBoard.get(boardId);
      if (!t) { t = { tp: false, bp: false, tn: false, bn: false }; railTapByBoard.set(boardId, t); }
      if (railChar === '+') { if (isTop) t.tp = true; if (isBot) t.bp = true; }
      if (railChar === '−') { if (isTop) t.tn = true; if (isBot) t.bn = true; }
    };
    if (!clear) {
      const scanPt = (pt) => {
        const hl = app.index.holes.get(key(pt.x, pt.y));
        if (!hl || !hl.rail) return;
        const brd = app.circuit.boards.find(b => b.id === holeBoardId(hl));
        if (!brd) return;
        const ry = brd.railY();
        markRailTap(brd.id, hl.rail, pt.y === brd.y + ry.tp || pt.y === brd.y + ry.tn, pt.y === brd.y + ry.bp || pt.y === brd.y + ry.bn);
      };
      for (const w of app.circuit.wires) { scanPt(w.a); scanPt(w.b); }
      for (const p of app.circuit.parts) for (const q of p.worldPins()) scanPt(q);
    }

    const addedWires = [];
    const wireSpecs = [];
    const wireCtx = { state: layoutState, hubStrips: new Set(), addedWires, wireSpecs, wiresToTidy: [] };
    const netColorCtx = { netColors: new Map(), existingWires: app.circuit.wires, engine: app.engine, usedClockColor: false };
    let sigIdx = 0;

    const skippedNotes = [];
    const isNe555Ctrl = (tok) => {
      const m = /^([^.\s]+)\.(.+)$/.exec(String(tok || '').trim());
      if (!m) return false;
      const part = refMap.get(m[1]) || refMap.get(m[1].toUpperCase()) || app.circuit.partById(m[1]);
      return Boolean(part && part.type === 'ne555' && resolvePinIndex(part, m[2].replace(/@.+$/, '')) === 4);
    };

    const wirePair = (aTok, bTok) => {
      if (!clear) {
        pruneConflictingDriverWires(app, aTok, bTok, refMap, preExistingWires, removedWires);
      }

      const aRail = parseRailToken(aTok);
      const bRail = parseRailToken(bTok);

      let resA, resB;
      if (aRail && !bRail) {
        resB = resolveEndpoint(app, bTok, refMap, null, wireCtx);
        resA = resolveEndpoint(app, aTok, refMap, resB?.end, wireCtx);
      } else {
        resA = resolveEndpoint(app, aTok, refMap, null, wireCtx);
        resB = resolveEndpoint(app, bTok, refMap, resA?.end, wireCtx);
      }
      if (!resA || !resB) return;

      if (resA.rail) markRailTap(resA.boardId || b0?.id, resA.rail, resA.usedTop, resA.usedBot);
      if (resB.rail) markRailTap(resB.boardId || b0?.id, resB.rail, resB.usedTop, resB.usedBot);

      const na = app.engine.netAt(resA.end.x, resA.end.y);
      const nb = app.engine.netAt(resB.end.x, resB.end.y);
      if (na >= 0 && na === nb) return; // Already electrically connected on same strip/rail!

      const why = app.shortReason(resA.end, resB.end);
      if (why) throw new Error(`${aTok} → ${bTok}: ${why}`);

      const col = pickWireColor(aTok, bTok, resA.rail, resB.rail, sigIdx++, { ...netColorCtx, na, nb });
      netColorCtx.usedClockColor = netColorCtx.usedClockColor || col === '#f5c400';
      const pts = route(app, resA.end, resB.end);
      const w = new Wire(resA.end, resB.end, col, pts);
      app.circuit.wires.push(w);
      addedWires.push(w);
      wireSpecs.push({ aTok, bTok, a: { ...w.a }, b: { ...w.b }, color: col, aRail: resA.rail, bRail: resB.rail });
      app.reindex(true);
    };

    for (const pair of flatConnections) {
      const [aTok, bTok] = pair;
      // A 555 CTRL pin tied straight to a rail breaks oscillation; leave it floating like a real astable.
      if ((isNe555Ctrl(aTok) && parseRailToken(bTok)) || (isNe555Ctrl(bTok) && parseRailToken(aTok))) {
        skippedNotes.push('Skipped wiring 555 CTRL (pin 5) straight to a rail — left open so it can oscillate.');
        continue;
      }
      wirePair(aTok, bTok);
    }

    const refById = new Map();
    for (const [k, part] of refMap) {
      if (part?.id && !refById.has(part.id) && k !== part.id) refById.set(part.id, k);
    }
    for (const sp of placedSpecs) refById.set(sp.partId, sp.ref);

    // Auto-wire omitted/unchained IC VCC/VDD -> "+" and GND/VSS -> "-" only when rails already carry active power & ground
    const bBridge = app.circuit.boards[0];
    if (plan.autoPower !== false && bBridge && bBridge.rails) {
      const netHasSupply = (n, tags) => {
        if (n < 0) return false;
        const ks = app.netKinds.get(n) || [];
        return ks.some(k => tags.includes(String(k.kind || '').split(':')[0]));
      };
      const railHasSupply = (railChar, tags) => {
        for (const [, hl] of app.index.holes) {
          if (hl.rail !== railChar) continue;
          if (netHasSupply(app.engine.netAt(hl.x, hl.y), tags)) return true;
        }
        return false;
      };
      if (railHasSupply('+', ['V', 'B+']) && railHasSupply('−', ['G', 'B-'])) {
        for (const p of app.circuit.parts) {
          if (!getDef(p.type).ic) continue;
          const tag = refById.get(p.id) || p.id;
          for (const wp of p.worldPins()) {
            const isV = /^(VCC|VDD)$/i.test(wp.name);
            const isG = /^(GND|VSS)$/i.test(wp.name);
            if (!isV && !isG) continue;
            const n = app.engine.netAt(wp.x, wp.y);
            if (n >= 0 && !(app.netKinds.get(n)?.length)) {
              wirePair(`${tag}.${wp.name}`, isG ? '-' : '+');
            }
          }
        }
      }
    }

    // Bridge top and bottom rails per board AND chain overflow boards' power rails to primary board
    const bridgeRailEndpoints = (rxA, rxB, railChar, colHex, labelTop, labelBot) => {
      if (!rxA || !rxB) return false;
      const na = app.engine.netAt(rxA.x, rxA.y);
      const nb = app.engine.netAt(rxB.x, rxB.y);
      if (na >= 0 && na === nb) return true;
      const w = new Wire({ x: rxA.x, y: rxA.y }, { x: rxB.x, y: rxB.y }, colHex, route(app, rxA, rxB));
      app.circuit.wires.push(w);
      addedWires.push(w);
      wireSpecs.push({ aTok: labelTop, bTok: labelBot, a: { ...w.a }, b: { ...w.b }, color: colHex, aRail: railChar, bRail: railChar, bridge: true });
      app.reindex(true);
      return true;
    };

    const bridgePerBoardRails = () => {
      for (const brd of app.circuit.boards) {
        if (!brd.rails) continue;
        const t = railTapByBoard.get(brd.id);
        if (t?.tp && t?.bp) {
          bridgeRailEndpoints(
            closestRailHole(app, '+', 't', brd.x + brd.cols, brd.y, brd),
            closestRailHole(app, '+', 'b', brd.x + brd.cols, brd.y + brd.h, brd),
            '+', '#e5484d', 'top+', 'bot+'
          );
        }
        if (t?.tn && t?.bn) {
          bridgeRailEndpoints(
            closestRailHole(app, '−', 't', brd.x + brd.cols, brd.y, brd),
            closestRailHole(app, '−', 'b', brd.x + brd.cols, brd.y + brd.h, brd),
            '−', '#2b2d31', 'top-', 'bot-'
          );
        }
      }
    };

    if (bBridge && bBridge.rails && app.circuit.boards.length > 1) {
      for (let bi = 1; bi < app.circuit.boards.length; bi++) {
        const ob = app.circuit.boards[bi];
        if (!ob.rails) continue;
        if (bridgeRailEndpoints(
          closestRailHole(app, '+', 'b', bBridge.x + bBridge.cols, bBridge.y + bBridge.h, bBridge),
          closestRailHole(app, '+', 't', ob.x + ob.cols, ob.y, ob),
          '+', '#e5484d', '+', `board${bi + 1}+`
        )) {
          markRailTap(bBridge.id, '+', false, true);
          markRailTap(ob.id, '+', true, false);
        }
        if (bridgeRailEndpoints(
          closestRailHole(app, '−', 'b', bBridge.x + bBridge.cols, bBridge.y + bBridge.h, bBridge),
          closestRailHole(app, '−', 't', ob.x + ob.cols, ob.y, ob),
          '−', '#2b2d31', '-', `board${bi + 1}-`
        )) {
          markRailTap(bBridge.id, '−', false, true);
          markRailTap(ob.id, '−', true, false);
        }
      }
    }

    bridgePerBoardRails();

    if (!allowIncomplete && strictHealth && plan.autoHeal !== false) {
      autoHealObviousWiring({ app, plan, refById, wirePair, addedWires, wireCtx, skippedNotes });
      bridgePerBoardRails();
    }

    // Strip any dangling orphan wires left behind after conflict replacements or deletions
    if (!clear && !allowIncomplete && (removedWires.length > 0 || (Array.isArray(plan.remove) && plan.remove.length > 0))) {
      for (let pass = 0; pass < 3; pass++) {
        app.reindex(true);
        const stripStats = new Map();
        for (const [, hl] of app.index.holes) {
          if (hl.rail) continue;
          let st = stripStats.get(hl.strip);
          if (!st) { st = { pins: 0, ends: 0 }; stripStats.set(hl.strip, st); }
          const k = key(hl.x, hl.y);
          st.pins += app.index.pins.get(k)?.length || 0;
          st.ends += app.index.ends.get(k)?.length || 0;
        }
        const netPins = new Map();
        for (const [, ent] of app.engine.byPart) for (const n of ent.pinNets) if (n >= 0) netPins.set(n, (netPins.get(n) || 0) + 1);
        let stripped = false;
        app.circuit.wires = app.circuit.wires.filter((w) => {
          const n = app.engine.netAt(w.a.x, w.a.y);
          const ha = app.index.holes.get(key(w.a.x, w.a.y));
          const hb = app.index.holes.get(key(w.b.x, w.b.y));
          const deadEndA = ha && !ha.rail && stripStats.get(ha.strip)?.pins === 0 && stripStats.get(ha.strip)?.ends === 1;
          const deadEndB = hb && !hb.rail && stripStats.get(hb.strip)?.pins === 0 && stripStats.get(hb.strip)?.ends === 1;
          if (!netPins.get(n) || deadEndA || deadEndB) {
            removedWires.push({ id: w.id, a: { ...w.a }, b: { ...w.b } });
            stripped = true;
            return false;
          }
          return true;
        });
        if (!stripped) break;
      }
      app.reindex(true);
    }

    // On follow-ups, re-route existing wires that cross newly placed parts or overlap new lanes
    const toTidy = [...new Set([...addedWires, ...wireCtx.wiresToTidy])];
    if (!clear && app.circuit.wires.length) {
      const newBoxes = newlyPlacedParts.map(p => p.bounds());
      const newEdges = new Set();
      for (const aw of addedWires) for (const ek of wireLatticeEdges(aw.path())) newEdges.add(ek);
      for (const w of app.circuit.wires) {
        if (toTidy.includes(w)) continue;
        if (wireCrossesAnyBox(w, newBoxes)) { toTidy.push(w); continue; }
        if (newEdges.size) {
          for (const ek of wireLatticeEdges(w.path())) {
            if (newEdges.has(ek)) { toTidy.push(w); break; }
          }
        }
      }
    }
    if (toTidy.length) {
      tidy(app, toTidy);
    }

    // Optional Logic Analyzer probes
    if (Array.isArray(plan.probes)) {
      for (const pr of plan.probes) {
        if (app.circuit.probes.length >= 8) break;
        try {
          const r = resolveEndpoint(app, pr.at, refMap, null);
          if (!r) continue;
          const used = new Set(app.circuit.probes.map(q => q.color));
          app.circuit.probes.push({
            id: 'pr' + Math.random().toString(36).slice(2, 7),
            x: r.end.x,
            y: r.end.y,
            name: pr.name || pr.at,
            analog: Boolean(pr.analog),
            color: PROBE_COLORS.find(c => !used.has(c)) || PROBE_COLORS[0],
          });
        } catch { /* ignore invalid optional probe */ }
      }
    }

    ensureDesignators(app.circuit);
    const health = verifyCircuitHealth(app, refById, { prompt, incremental: !clear || allowIncomplete, allowIncomplete, strictHealth });
    if (!health.ok) {
      app.load(backup, true);
      app.setMode(prevMode);
      return { ok: false, errors: health.errors, warnings: health.warnings };
    }

    if (commit) {
      app.commit('AI Build');
      if (app.circuit.probes.length && app.ui?.toggleAnalyzer) app.ui.toggleAnalyzer(true);
      if (startSim && app.mode !== 'sim') app.setMode('sim');
      app.fit();
    }

    return {
      ok: true,
      warnings: [...new Set([...health.warnings, ...skippedNotes])],
      refMap,
      boardSize: app.circuit.boards[0]?.size || 'half',
      placedParts: placedSpecs,
      wireSpecs,
      removedWires,
      updatedSpecs,
      partsAdded: placedSpecs.length,
      wiresAdded: addedWires.length,
      wiresRemoved: removedWires.length,
      updatedCount: updatedSpecs.length,
    };
  } catch (err) {
    app.load(backup, true);
    app.setMode(prevMode);
    return { ok: false, errors: [err?.message || String(err)], warnings: [] };
  }
}

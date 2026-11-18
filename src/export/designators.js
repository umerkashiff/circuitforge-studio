/**
 * Canonical Reference Designators (R1, C1, U1, LED1...), Part Value Formatters,
 * and Electrical Net Label resolution. Shared across Canvas overlays, Schematics,
 * BOM, Wiring tables, Logic Analyzer probes, and AI Copilot.
 */
import { getDef } from '../parts/registry.js';

export const ANNOTATION_TYPES = new Set(['label', 'callout', 'zone', 'netlabel']);

export function isAnnotationType(type) {
  return ANNOTATION_TYPES.has(type);
}

const REF_PREFIX = {
  resistor: 'R',
  pot: 'RV',
  'wokwi-slide-potentiometer': 'RV',
  capacitor: 'C',
  inductor: 'L',
  diode: 'D',
  zener: 'D',
  npn: 'Q',
  pnp: 'Q',
  jfet: 'Q',
  nmos: 'Q',
  pmos: 'Q',
  led: 'LED',
  'wokwi-rgb-led': 'LED',
  seg7: 'DS',
  bargraph: 'DS',
  lcd16x2: 'DS',
  'board-ssd1306': 'DS',
  'wokwi-sh1107': 'DS',
  'wokwi-lcd1602': 'DS',
  'wokwi-lcd2004': 'DS',
  buzzer: 'BZ',
  'wokwi-relay-module': 'K',
  toggle: 'SW',
  button: 'SW',
  slide: 'SW',
  tactile: 'SW',
  dip4: 'SW',
  dip8: 'SW',
  'wokwi-analog-joystick': 'SW',
  clock: 'CLK',
  vcc: 'VCC',
  gnd: 'GND',
  battery: 'BT',
  'power-supply': 'PSU',
  funcgen: 'FG',
  oscilloscope: 'OSC',
  multimeter: 'DMM',
  'wokwi-logic-analyzer': 'LA',
  'trainer-board': 'TB',
  ne555: 'U',
  pc817: 'U',
  lm7805: 'U',
  lm317: 'U',
  lm741: 'U',
  lm358: 'U',
  lm393: 'U',
  uno: 'U',
  nano: 'U',
  esp32: 'U',
  esp32s3: 'U',
  bluepill: 'U',
  'wokwi-mpu6050': 'U',
  'wokwi-ds1307': 'U',
  'wokwi-bmp180': 'U',
};

export function refPrefixFor(type) {
  if (!type || ANNOTATION_TYPES.has(type)) return null;
  if (REF_PREFIX[type]) return REF_PREFIX[type];
  if (type.startsWith('ic')) return 'U';
  const def = getDef(type, true);
  if (def && (def.ic || def.mcu)) return 'U';
  return 'X';
}

export function cleanRef(raw) {
  return String(raw || '').trim().replace(/\s+/g, '');
}

export function isDuplicateRef(circuit, candidate, excludeId = null) {
  const c = cleanRef(candidate).toUpperCase();
  if (!c) return false;
  return (circuit.parts || []).some(p => p.id !== excludeId && p.ref && p.ref.toUpperCase() === c);
}

/**
 * Pick next available unique reference designator for `type`.
 * Honors `preferredRef` (e.g. from AI Copilot) when valid and free.
 */
export function nextRef(circuit, type, preferredRef = '') {
  const prefix = refPrefixFor(type);
  if (!prefix) return '';
  const used = new Set();
  for (const p of circuit.parts || []) {
    if (p.ref) used.add(p.ref.toUpperCase());
  }
  const pref = cleanRef(preferredRef);
  if (pref && /^[A-Za-z][A-Za-z0-9_.\-]{0,14}$/.test(pref) && !used.has(pref.toUpperCase())) {
    return pref;
  }
  let n = 1;
  while (used.has((prefix + n).toUpperCase())) n++;
  return prefix + n;
}

/** Deterministically populate missing or duplicate designators without altering valid refs. */
export function ensureDesignators(circuit) {
  const used = new Set();
  for (const p of circuit.parts || []) {
    if (isAnnotationType(p.type)) { p.ref = ''; continue; }
    const cur = cleanRef(p.ref);
    if (cur && !used.has(cur.toUpperCase())) {
      p.ref = cur;
      used.add(cur.toUpperCase());
    } else {
      p.ref = '';
    }
  }
  for (const p of circuit.parts || []) {
    if (isAnnotationType(p.type) || p.ref) continue;
    const prefix = refPrefixFor(p.type) || 'X';
    let n = 1;
    while (used.has((prefix + n).toUpperCase())) n++;
    p.ref = prefix + n;
    used.add(p.ref.toUpperCase());
  }
  return circuit;
}

/**
 * Re-number all electrical parts cleanly top-to-bottom, left-to-right.
 * Returns number of parts whose ref changed.
 */
export function reannotateCircuit(circuit) {
  const before = new Map((circuit.parts || []).map(p => [p.id, p.ref || '']));
  const electrical = (circuit.parts || []).filter(p => !isAnnotationType(p.type));
  for (const p of circuit.parts || []) {
    if (isAnnotationType(p.type)) p.ref = '';
  }

  electrical.sort((a, b) => {
    const ba = a.bounds ? a.bounds() : { x0: a.x, y0: a.y, x1: a.x, y1: a.y };
    const bb = b.bounds ? b.bounds() : { x0: b.x, y0: b.y, x1: b.x, y1: b.y };
    const rowA = Math.round(((ba.y0 + ba.y1) * 0.5) / 4);
    const rowB = Math.round(((bb.y0 + bb.y1) * 0.5) / 4);
    if (rowA !== rowB) return rowA - rowB;
    if (ba.x0 !== bb.x0) return ba.x0 - bb.x0;
    return a.y - b.y || a.x - b.x;
  });

  const counters = new Map();
  for (const p of electrical) {
    const prefix = refPrefixFor(p.type) || 'X';
    const n = (counters.get(prefix) || 0) + 1;
    counters.set(prefix, n);
    p.ref = prefix + n;
  }

  let changed = 0;
  for (const p of circuit.parts || []) {
    if ((before.get(p.id) || '') !== (p.ref || '')) changed++;
  }
  return changed;
}

export function fmtEng(v, unit, sig = 3) {
  const n = +v;
  if (!Number.isFinite(n)) return String(v ?? '');
  if (n >= 1e6) return +(n / 1e6).toPrecision(sig) + ' M' + unit;
  if (n >= 1e3) return +(n / 1e3).toPrecision(sig) + ' k' + unit;
  if (n >= 1 || n === 0) return +n.toPrecision(sig) + ' ' + unit;
  if (n >= 1e-3) return +(n * 1e3).toPrecision(sig) + ' m' + unit;
  if (n >= 1e-6) return +(n * 1e6).toPrecision(sig) + ' µ' + unit;
  return +(n * 1e9).toPrecision(sig) + ' n' + unit;
}

function fmtCapUf(uf) {
  const u = +uf;
  if (!Number.isFinite(u)) return '';
  if (u >= 1000) return +(u / 1000).toPrecision(3) + ' mF';
  if (u >= 1) return +u.toPrecision(3) + ' µF';
  if (u >= 0.001) return Math.round(u * 1000) + ' nF';
  return Math.round(u * 1e6) + ' pF';
}

/** Concise engineering value / part number for canvas overlays, schematics & BOM. */
export function formatPartValue(part) {
  if (!part) return '';
  const p = part.props || {};
  const t = part.type;
  const def = getDef(t, true);
  if (t === 'resistor') return fmtEng(p.ohms ?? 220, 'Ω');
  if (t === 'pot' || t === 'wokwi-slide-potentiometer') return fmtEng(p.ohms ?? 10000, 'Ω');
  if (t === 'capacitor') return fmtCapUf(p.uf ?? 10) + (p.kind === 'ceramic' ? ' NP' : '');
  if (t === 'inductor') {
    const mh = +(p.mh ?? 10);
    return mh < 1 ? `${Math.round(mh * 1000)} µH` : `${mh} mH`;
  }
  if (t === 'diode') return p.model || '1N4148';
  if (t === 'zener') return `${p.vz ?? 5.1} V`;
  if (t === 'npn') return p.model || '2N3904';
  if (t === 'pnp') return p.model || '2N3906';
  if (t === 'jfet') return p.model || '2N5484';
  if (t === 'nmos') return p.model || '2N7000';
  if (t === 'pmos') return p.model || 'BS250';
  if (t === 'lm7805') return `${(+p.vreg || 5).toFixed(1)} V`;
  if (t === 'lm317') return 'LM317';
  if (t === 'pc817') return 'PC817';
  if (t === 'lm741') return 'LM741';
  if (t === 'lm358') return 'LM358';
  if (t === 'lm393') return 'LM393';
  if (t === 'multimeter') {
    const m = p.mode || 'dcv';
    return m === 'dca' ? 'DC mA' : m === 'ohm' ? 'OHM' : m === 'cont' ? 'CONT' : 'DC V';
  }
  if (t === 'led') {
    const col = String(p.color || 'red');
    return col.charAt(0).toUpperCase() + col.slice(1) + ' LED';
  }
  if (t === 'wokwi-rgb-led') return p.common === 'anode' ? 'RGB (CA)' : 'RGB (CC)';
  if (t === 'seg7') return p.common === 'anode' ? '7-Seg CA' : '7-Seg CC';
  if (t === 'bargraph') return '8× LED Bar';
  if (t === 'buzzer') return 'Buzzer';
  if (t === 'clock') {
    const hz = +(p.frequency || p.hz || 1);
    return hz >= 1000 ? `${+(hz / 1000).toPrecision(3)} kHz` : `${hz} Hz`;
  }
  if (t === 'battery') return `${p.volts ?? 9} V`;
  if (t === 'vcc') return '+5 V';
  if (t === 'gnd') return 'GND';
  if (t === 'toggle' || t === 'button') return p.label || (t === 'toggle' ? 'Switch' : 'Button');
  if (t === 'slide') return 'SPST';
  if (t === 'tactile') return 'Pushbtn';
  if (t === 'dip4') return 'DIP ×4';
  if (t === 'dip8') return 'DIP ×8';
  if (t === 'ne555') return 'NE555';
  if (def && def.ic) return def.ic.id;
  if (def && def.mcu) return def.short || def.name;
  const fmtHex = (addr, fb) => '0x' + String(addr || fb).replace(/^0x/i, '').toUpperCase();
  if (t === 'board-ssd1306' || t === 'wokwi-sh1107') return `OLED ${fmtHex(p.i2cAddress, '0x3c')}`;
  if (t === 'wokwi-lcd1602' || t === 'wokwi-lcd2004') return `LCD ${fmtHex(p.i2cAddress, '0x27')}`;
  if (t === 'lcd16x2') return 'LCD 16×2';
  if (t === 'wokwi-mpu6050') return `MPU6050 ${fmtHex(p.i2cAddress, '0x68')}`;
  if (t === 'wokwi-ds1307') return 'DS1307 RTC';
  if (t === 'wokwi-bmp180') return 'BMP180';
  if (t === 'wokwi-relay-module') return 'Relay 5V';
  if (t === 'wokwi-analog-joystick') return 'Joystick';
  if (t === 'wokwi-logic-analyzer') return '8-Ch LA';
  return def ? (def.short || def.name) : t;
}

/** Display string combining RefDes and compact value according to label mode. */
export function formatPartOverlayText(part, mode = 'refs') {
  if (!part || !part.ref || mode === 'off') return '';
  if (mode === 'refs') return part.ref;
  const val = formatPartValue(part);
  // Skip redundant repeats like VCC (+5 V) or GND (GND) or CLK1
  if (part.type === 'vcc' || part.type === 'gnd') return part.ref;
  if (!val || val.toUpperCase() === part.ref.toUpperCase()) return part.ref;
  return `${part.ref} · ${val}`;
}

/**
 * Resolve explicit user net names (`netlabel` parts first, then `wire.label`)
 * mapped by `engine.netAt(x, y)` index.
 */
export function buildNetLabelMap(circuit, engine) {
  const map = new Map();
  if (!circuit || !engine) return map;
  for (const p of circuit.parts || []) {
    if (p.type !== 'netlabel') continue;
    const txt = String(p.props?.text || '').trim();
    if (!txt) continue;
    const n = engine.netAt(p.x, p.y);
    if (n >= 0 && !map.has(n)) map.set(n, txt);
  }
  for (const w of circuit.wires || []) {
    const lbl = String(w.label || '').trim();
    if (!lbl) continue;
    const n = engine.netAt(w.a.x, w.a.y);
    if (n >= 0 && !map.has(n)) map.set(n, lbl);
  }
  return map;
}

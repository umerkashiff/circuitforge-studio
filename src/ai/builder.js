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

const SIGNAL_COLORS = ['#0a84ff', '#30a46c', '#ff8a00', '#8e4ec6', '#f5c400', '#ffffff'];
const PROBE_COLORS = ['#ff9f0a', '#30d158', '#0a84ff', '#ff375f', '#bf5af2', '#64d2ff', '#ffd60a', '#ac8e68'];

const KNOWN_PROP_KEYS = ['code', 'sketch', 'program', 'ohms', 'resistance', 'value', 'watts', 'uf', 'capacitance', 'vmax', 'color', 'protect', 'hz', 'duty', 'vpp', 'wave', 'offset', 'power', 'common', 'on', 'label', 'run', 'ch1On', 'ch2On', 'ch1Scale', 'ch2Scale', 'timeDiv', 'coupling', 'trigSrc', 'trigLevel'];

/** Normalize malformed LLM part specs (e.g. `part`/`component` instead of `type`, or top-level `ohms`/`code`). */
export function normalizePartSpec(raw = {}) {
  if (!raw || typeof raw !== 'object') return raw;
  const props = { ...(raw.props || {}) };
  for (const k of KNOWN_PROP_KEYS) {
    if (raw[k] !== undefined && props[k] === undefined) props[k] = raw[k];
  }
  const type = raw.type ?? raw.part ?? raw.component ?? raw.kind ?? raw.device ?? raw.model ?? raw.name ?? '';
  const ref = raw.ref ?? raw.id ?? raw.name ?? '';
  return { ...raw, ref, type, props };
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
  if (low === '555' || low === 'ne-555' || low === 'lm555' || low === '555 timer') return { type: 'ne555', props: { ...props } };
  if (low === 'resistor' || low === 'r') return { type: 'resistor', props: { ...props } };
  if (low === 'capacitor' || low === 'cap' || low === 'c') return { type: 'capacitor', props: { ...props } };
  if (low === 'inductor' || low === 'l') return { type: 'inductor', props: { ...props } };
  if (low === 'diode' || low === '1n4148' || low === '1n4001' || low === '1n4007') {
    const out = { ...props };
    if (low.startsWith('1n')) out.model = low.toUpperCase();
    return { type: 'diode', props: out };
  }
  if (/^(red|green|yellow|blue|white)\s*led$/.test(low)) {
    const col = low.split(' ')[0];
    return { type: 'led', props: { color: col, ...props } };
  }
  if (low === 'scope' || low === 'ut2062b') return { type: 'oscilloscope', props: { ...props } };
  if (low === 'signal generator' || low === 'function generator' || low === 'egc-3235a' || low === 'egc3235a') return { type: 'funcgen', props: { ...props } };
  if (low === 'psu' || low === 'power supply' || low === 'mps-3005l-3') return { type: 'power-supply', props: { ...props } };
  if (low === 'arduino' || low === 'arduino uno' || low === 'uno r3') return { type: 'uno', props: { ...props } };
  if (low === 'arduino nano') return { type: 'nano', props: { ...props } };
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

const normPin = (s) => String(s || '').trim().replace(/−/g, '-').replace(/\u0305/g, '').toUpperCase();

/** Resolve a symbolic pin identifier (name, alias, or 1-based number) on a Part. */
export function resolvePinIndex(part, rawPin) {
  const pins = part.worldPins();
  const target = normPin(rawPin);
  if (!target) return -1;

  // 1. Exact case-insensitive match
  for (let i = 0; i < pins.length; i++) {
    if (normPin(pins[i].name) === target) return i;
  }
  // 2. Match either half of slash-combined labels (e.g., D13/SCK -> D13 or SCK)
  for (let i = 0; i < pins.length; i++) {
    const parts = normPin(pins[i].name).split('/');
    if (parts.includes(target)) return i;
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
    clock: { CLK: 0, OUT: 0, '1': 0 },
    seg7: { CC: 2, CA: 2, COM1: 2, COM2: 7, GND: 2, VCC: 2 },
    ic7447: { BI: 3, RBO: 3, '/LT': 2, '/RBI': 4, '/RBO': 3 },
    ic7448: { BI: 3, RBO: 3, '/LT': 2, '/RBI': 4, '/RBO': 3 },
    ic7483: { CIN: 12, C_IN: 12, COUT: 13, C_OUT: 13, S1: 8, SUM1: 8, S2: 5, SUM2: 5, S3: 1, SUM3: 1, S4: 14, SUM4: 14, C1: 8, C2: 5, C3: 1, C4_SUM: 14 },
    ic74151: { I0: 3, I1: 2, I2: 1, I3: 0, I4: 15, I5: 14, I6: 13, I7: 12, S0: 10, S1: 9, S2: 8, E: 6, EN: 6, Z: 4, Q: 4, Y_BAR: 5, W: 5 },
    ic7493: { CLKA: 13, CLKB: 0, 'CK0': 13, 'CK1': 0, RST1: 1, RST2: 2, R1: 1, R2: 2, MR1: 1, MR2: 2 },
    ic7490: { CLKA: 13, CLKB: 0, RST1: 1, RST2: 2, R1: 1, R2: 2 },
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
  for (const existing of app.circuit.parts) {
    if (boxesIntersect(cb, existing.bounds(), 0.25)) return false;
  }
  const { msg } = app.editor.problems([cand]);
  return !msg;
}

/** Deterministic breadboard & benchtop allocator for a single Part. */
export function placePartSmart(app, spec, state) {
  const resolved = resolvePartType(spec.type, spec.props || {});
  if (!resolved) throw new Error(`Unknown component type "${spec.type}"`);

  const def = getDef(resolved.type);
  const b = app.circuit.boards[0];
  const cols = b ? b.cols : 30;
  const bx = b ? b.x : 0;
  const by = b ? b.y : 0;

  const tryAt = (x, y, rot = 0) => {
    const p = new Part(resolved.type, Math.round(x), Math.round(y), rot, resolved.props);
    if (!canPlaceCandidate(app, p)) return null;
    app.circuit.parts.push(p);
    app.reindex(true);
    return p;
  };

  // 1. Explicit location override if supplied safely
  if (Number.isFinite(spec.x) && Number.isFinite(spec.y)) {
    const hit = tryAt(spec.x, spec.y, spec.rot || 0);
    if (hit) return hit;
  }

  // 2. Benchtop Instruments & Trainer Board: neat horizontal shelf above breadboard
  if (def.cat === 'Instruments' || resolved.type === 'trainer-board') {
    const sample = new Part(resolved.type, 0, 0, 0, resolved.props);
    const sb = sample.bounds();
    const w = Math.ceil(sb.x1 - sb.x0);
    for (let x = state.instX; x < bx + 120; x += 2) {
      const placed = tryAt(x - Math.floor(sb.x0), by - 4, 0);
      if (placed) {
        state.instX = Math.ceil(placed.bounds().x1) + 2;
        return placed;
      }
    }
  }

  // 3. Large standalone Arduino Uno: clean benchtop placement beside breadboard
  if (resolved.type === 'uno') {
    for (const [cx, cy] of [
      [bx - 31, by],
      [bx + (b ? b.w : 33) + 3, by],
      [bx, by + (b ? b.h : 20) + 4],
    ]) {
      const placed = tryAt(cx, cy, 0);
      if (placed) return placed;
    }
  }

  // 4. Single-pin power & input modules (vcc, gnd, toggle, button, clock, battery)
  if (resolved.type === 'vcc' || resolved.type === 'gnd') {
    const xs = resolved.type === 'vcc' ? [3, 6, 9, 12, 15] : [6, 3, 9, 12, 15];
    for (const ox of xs) { const placed = tryAt(bx + ox, by - 3, 0); if (placed) return placed; }
    for (const ox of xs) { const placed = tryAt(bx + ox, by + (b ? b.h : 20) + 3, 2); if (placed) return placed; }
  }
  if (resolved.type === 'toggle' || resolved.type === 'button' || resolved.type === 'clock' || resolved.type === 'battery') {
    const yBottom = by + (b ? b.h : 20) + 2;
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

    for (let pass = 0; pass < 2; pass++) {
      const startCol = pass === 0 ? state.icCol : 1;
      const endCol = pass === 0 ? cols - span : Math.min(state.icCol - 1, cols - span);
      for (let col = startCol; col <= endCol; col++) {
        const placed = tryAt(bx + 2 + col, targetY, 0);
        if (placed) {
          for (let k = col; k < col + span; k++) {
            state.usedColsTop.add(k);
            state.usedColsBot.add(k);
          }
          if (pass === 0) state.icCol = col + span + 3;
          return placed;
        }
      }
    }
  }

  // 6. Horizontal 4-unit 2-pin passives (resistor, diode, inductor): keep strips clean
  if (resolved.type === 'resistor' || resolved.type === 'diode' || resolved.type === 'inductor') {
    // Try horizontal on bottom half rows g/h/i or top half rows b/c across unused columns first, then any valid free holes
    const rowOrder = b ? [b.rowY(6), b.rowY(7), b.rowY(1), b.rowY(2), b.rowY(8), b.rowY(3), b.rowY(5), b.rowY(4)] : [12, 13, 5, 6, 14, 7];
    for (let pass = 0; pass < 2; pass++) {
      for (let col = 0; col <= cols - 5; col++) {
        for (const ry of rowOrder) {
          const isTop = b ? ry < b.rowY(5) : ry < 9;
          const used = isTop ? state.usedColsTop : state.usedColsBot;
          if (pass === 0 && (used.has(col) || used.has(col + 4))) continue;
          const placed = tryAt(bx + 2 + col, by + ry, 0);
          if (placed) {
            used.add(col);
            used.add(col + 4);
            return placed;
          }
        }
      }
    }
    // Vertical bridge across the trench (e -> i / c -> g = 4 units)
    if (b) {
      for (const ry of [b.rowY(4), b.rowY(2)]) {
        for (let col = 0; col < cols; col++) {
          const placed = tryAt(bx + 2 + col, by + ry, 1);
          if (placed) return placed;
        }
      }
    }
  }

  // 7. Tall / upward-extending breadboard parts (LED, capacitor, pot, npn, jfet, buzzer, OLED, LCD, 7seg, etc.)
  const sample = new Part(resolved.type, 0, 0, 0, resolved.props);
  const sb = sample.bounds();
  const bodyHeight = Math.abs(sb.y0);
  const localXs = sample.localPins().map(q => q.x);
  const pinSpan = (localXs.length ? Math.max(...localXs) : 1) + 1;

  // Very tall display modules (7seg, lcd16x2, oled) fit cleanly on row a pointing above board or row j
  const preferredRows = bodyHeight > 3.5 && b
    ? [b.rowY(0), b.rowY(9)]
    : b
      ? [b.rowY(7), b.rowY(6), b.rowY(2), b.rowY(1), b.rowY(8), b.rowY(9)]
      : [13, 12, 6, 5, 14, 15];

  for (let pass = 0; pass < 2; pass++) {
    for (let col = 0; col + pinSpan <= cols; col++) {
      for (const ry of preferredRows) {
        const isTop = b ? ry < b.rowY(5) : ry < 9;
        const used = isTop ? state.usedColsTop : state.usedColsBot;
        if (pass === 0) {
          let conflict = false;
          for (let k = col; k < col + pinSpan; k++) if (used.has(k)) { conflict = true; break; }
          if (conflict) continue;
        }
        const placed = tryAt(bx + 2 + col, by + ry, 0);
        if (placed) {
          for (let k = col; k < col + pinSpan; k++) used.add(k);
          return placed;
        }
      }
    }
  }

  // 8. Off-board fallback below/above breadboard
  for (let x = bx + 2; x < bx + 80; x += 3) {
    const placed = tryAt(x, by + (b ? b.h : 20) + 5, 0) || tryAt(x, by - 5, 0);
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

/** Find an empty breadboard hole in the same 5-hole strip as `hole`. */
export function freeHoleOnStrip(app, hole) {
  const ix = app.index;
  const stripHoles = [];
  for (const [, hl] of ix.holes) {
    if (hl.strip === hole.strip) stripHoles.push(hl);
  }
  // Prefer holes closer to center trench or outer rows not occupied by pins or wire ends
  stripHoles.sort((a, b) => Math.abs(a.row - hole.row) - Math.abs(b.row - hole.row));
  for (const hl of stripHoles) {
    const k = key(hl.x, hl.y);
    if (!(ix.pins.get(k)?.length) && !(ix.ends.get(k)?.length)) {
      return { x: hl.x, y: hl.y };
    }
  }
  // Allow sharing a hole without a physical component leg if all 5 are tight
  for (const hl of stripHoles) {
    const k = key(hl.x, hl.y);
    if (!(ix.pins.get(k)?.length)) return { x: hl.x, y: hl.y };
  }
  return null;
}

export function closestRailHole(app, railChar, half, preferX, preferY) {
  const b = app.circuit.boards[0];
  if (!b || !b.rails) return null;
  const ix = app.index;
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
      return { x: cands[0].x, y: cands[0].y, usedTop: y === topY, usedBot: y === botY };
    }
  }
  return { x: Math.round(Math.max(b.x + 2, Math.min(b.x + 1 + b.cols, preferX))), y: primaryY, usedTop: chooseTop, usedBot: !chooseTop };
}

/** Resolve an endpoint string (`"U1.VCC"`, `"p3.OUT"`, `"+"`, `"-"`, `"d10"`) to wire end coordinates. */
export function resolveEndpoint(app, token, refMap, otherHint = null) {
  const raw = String(token || '').trim();
  const railSpec = parseRailToken(raw);
  if (railSpec) {
    const hx = otherHint?.x ?? (app.circuit.boards[0] ? app.circuit.boards[0].x + 2 : 2);
    const hy = otherHint?.y ?? 0;
    const rh = closestRailHole(app, railSpec.rail, railSpec.half, hx, hy);
    return rh ? { end: { x: rh.x, y: rh.y }, rail: railSpec.rail, usedTop: rh.usedTop, usedBot: rh.usedBot } : null;
  }

  const holeByLabel = findHoleByLabel(app, raw);
  if (holeByLabel) {
    const fh = freeHoleOnStrip(app, holeByLabel) || { x: holeByLabel.x, y: holeByLabel.y };
    return { end: fh, rail: null };
  }

  const dot = raw.indexOf('.');
  if (dot > 0) {
    const ref = raw.slice(0, dot).trim();
    const pinName = raw.slice(dot + 1).replace(/@.+$/, '').trim();
    const part = refMap.get(ref) || refMap.get(ref.toUpperCase()) || app.circuit.partById(ref);
    if (!part) throw new Error(`Unknown part reference "${ref}" in connection "${raw}"`);
    const pi = resolvePinIndex(part, pinName);
    if (pi < 0) {
      const validPins = part.worldPins().map((p, i) => `${i + 1}:${p.name}`).join(', ');
      throw new Error(`Unknown pin "${pinName}" on part "${ref}" (${part.type}). Valid pins: [${validPins}]`);
    }
    const wp = part.worldPins()[pi];
    const hole = app.index.holes.get(key(wp.x, wp.y));
    if (hole) {
      const fh = hole.rail ? freeRailOnHole(app, hole) : freeHoleOnStrip(app, hole);
      if (fh) return { end: fh, rail: hole.rail || null, usedTop: hole.y <= (app.circuit.boards[0]?.y || 0) + 5, usedBot: hole.y >= (app.circuit.boards[0]?.y || 0) + 16 };
    }
    return { end: { x: wp.x, y: wp.y, pin: { part: part.id, i: wp.i } }, rail: null };
  }

  // Bare 1-pin part ref (e.g. "VCC" -> VCC's pin 0)
  const part = refMap.get(raw) || refMap.get(raw.toUpperCase()) || app.circuit.partById(raw);
  if (part && part.worldPins().length === 1) {
    const wp = part.worldPins()[0];
    return { end: { x: wp.x, y: wp.y, pin: { part: part.id, i: 0 } }, rail: null };
  }

  throw new Error(`Invalid connection endpoint "${raw}"`);
}

function freeRailOnHole(app, hole) {
  const b = app.circuit.boards[0];
  if (!b) return null;
  const r = closestRailHole(app, hole.rail, hole.y <= b.y + 5 ? 't' : 'b', hole.x, hole.y);
  return r ? { x: r.x, y: r.y } : null;
}

export function pickWireColor(aTok, bTok, aRail, bRail, sigIdx) {
  if (aRail === '+' || bRail === '+') return '#e5484d';
  if (aRail === '−' || bRail === '−') return '#2b2d31';
  const hi = (t) => /\b(vcc|vdd|\+5v|5v|3v3|\+)\b/i.test(String(t));
  const lo = (t) => /\b(gnd|vss|0v|−|-)\b/i.test(String(t));
  if (hi(aTok) || hi(bTok)) return '#e5484d';
  if (lo(aTok) || lo(bTok)) return '#2b2d31';
  return SIGNAL_COLORS[sigIdx % SIGNAL_COLORS.length];
}

/** Run headless DRC + 50 ms simulation check on current app.circuit without touching history. */
export function verifyCircuitHealth(app, refById = null) {
  app.reindex(false);
  const errors = [];
  const warnings = [];

  const prob = app.editor.problems(app.circuit.parts, app.circuit.boards);
  if (prob.msg) errors.push(prob.msg);

  for (const iss of app.allIssues()) {
    if (iss.level === 'error') errors.push(iss.text);
    else if (iss.level === 'warn') warnings.push(iss.text);
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
  const hasVccPart = app.circuit.parts.some(p => p.type === 'vcc' || p.type === 'power-supply' || getDef(p.type).mcu || p.type === 'trainer-board');
  const hasGndPart = app.circuit.parts.some(p => p.type === 'gnd' || p.type === 'power-supply' || getDef(p.type).mcu || p.type === 'trainer-board');
  for (const p of app.circuit.parts) {
    const ent = sim.byPart.get(p.id);
    if (!ent) continue;
    const tag = refById?.get(p.id) || p.id;
    if (p.type === 'toggle' || p.type === 'button' || p.type === 'clock') {
      const n = ent.pinNets?.[0] ?? -1;
      if (n >= 0 && supplyNets.has(n)) {
        errors.push(`${getDef(p.type).short || p.type} (ref "${tag}") OUT is a 1-pin active HIGH/LOW driver; do NOT wire it directly to +5V or GND (wire "${tag}.OUT" directly to its destination input).`);
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
    } else if (p.type === 'resistor' || p.type === 'led' || p.type === 'diode' || p.type === 'capacitor' || p.type === 'inductor') {
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
  for (const d of sim.devices) {
    if (d.rt?.error) errors.push(`${getDef(d.part.type).name} sketch error${d.rt.errorLine ? ` (line ${d.rt.errorLine})` : ''}: ${d.rt.error}`);
  }
  const dt = Math.min(0.005, sim.suggestDt ? sim.suggestDt() : 0.005);
  for (let i = 0; i < 12; i++) sim.step(dt);
  for (const w of sim.collectWarnings()) {
    if (w.level === 'error') {
      if (/no power/i.test(w.text) && w.part) {
        const tag = refById?.get(w.part.id) || w.part.id;
        const missing = `${!hasVccPart ? ' Missing "vcc" part wired to "+".' : ''}${!hasGndPart ? ' Missing "gnd" part wired to "-".' : ''}`;
        errors.push(`IC "${tag}" (${w.part.type}): ${w.text}.${missing} Ensure "V1.1"->"+", "G1.1"->"-", "${tag}.VCC"->"+", "${tag}.GND"->"-"`);
      } else {
        errors.push(w.text);
      }
    } else if (w.level === 'warn') warnings.push(w.text);
  }
  for (const d of sim.devices) {
    if (d.rt?.error) errors.push(`${getDef(d.part.type).name} runtime error: ${d.rt.error}`);
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

/**
 * Apply a structured AI build/edit plan to `app.circuit`.
 * Allocates components deterministically, routes clean wires, configures MCUs/probes,
 * verifies circuit health headlessly, and rolls back safely on unrecoverable errors.
 */
export function applyAiBuildPlan(app, plan, { commit = true, startSim = true } = {}) {
  const backup = JSON.stringify(app.circuit);
  const prevMode = app.mode;
  const refMap = new Map();

  try {
    const rawParts = Array.isArray(plan.parts) ? plan.parts.map(normalizePartSpec) : [];
    const clear = plan.clearExisting !== false && rawParts.length > 0;
    if (clear) {
      const wantParts = rawParts;
      let estCols = 0;
      for (const sp of wantParts) {
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
      if (boardSize === 'half' && estCols > 26) boardSize = 'full';

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

    // Existing parts become directly addressable by ID
    for (const p of app.circuit.parts) refMap.set(p.id, p);

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

    // Track breadboard allocation state (seeding existing occupied strips)
    const b0 = app.circuit.boards[0];
    const layoutState = {
      icCol: 3,
      instX: b0 ? b0.x : 0,
      usedColsTop: new Set(),
      usedColsBot: new Set(),
    };
    if (b0 && !clear) {
      for (const p of app.circuit.parts) {
        const def = getDef(p.type);
        if (def.cat === 'Instruments' || p.type === 'trainer-board') {
          layoutState.instX = Math.max(layoutState.instX, Math.ceil(p.bounds().x1) + 2);
        }
        for (const q of p.worldPins()) {
          const hl = app.index.holes.get(key(q.x, q.y));
          if (hl && !hl.rail) {
            if (hl.row < 5) layoutState.usedColsTop.add(hl.col);
            else layoutState.usedColsBot.add(hl.col);
            if (def.ic || def.mcu) layoutState.icCol = Math.max(layoutState.icCol, hl.col + 3);
          }
        }
      }
    }

    // Order placement: Instruments/Power first -> ICs/MCUs -> Flat 4-pin passives -> Remaining parts
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
    for (const sp of partSpecs) {
      // Skip accidentally echoed existing part IDs during incremental builds
      if (!clear && sp.ref && app.circuit.partById(sp.ref)) continue;
      const placed = placePartSmart(app, sp, layoutState);
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

    // Track rail bridge needs (top rail <-> bottom rail), including pre-existing rail connections
    let topPlusUsed = false, botPlusUsed = false;
    let topMinusUsed = false, botMinusUsed = false;
    if (b0 && b0.rails && !clear) {
      const ry0 = b0.railY();
      const scanPt = (pt) => {
        if (pt.y === b0.y + ry0.tp) topPlusUsed = true;
        else if (pt.y === b0.y + ry0.bp) botPlusUsed = true;
        else if (pt.y === b0.y + ry0.tn) topMinusUsed = true;
        else if (pt.y === b0.y + ry0.bn) botMinusUsed = true;
      };
      for (const w of app.circuit.wires) { scanPt(w.a); scanPt(w.b); }
      for (const p of app.circuit.parts) for (const q of p.worldPins()) scanPt(q);
    }
    const addedWires = [];
    const wireSpecs = [];
    let sigIdx = 0;

    // Normalize connection specs: allow 2-element pairs, chained arrays [a,b,c,...], or {from,to}/{a,b} objects
    const flatConnections = [];
    for (const item of (plan.connections || [])) {
      if (Array.isArray(item) && item.length >= 2) {
        for (let k = 0; k < item.length - 1; k++) flatConnections.push([item[k], item[k + 1]]);
      } else if (item && typeof item === 'object') {
        const a = item.from ?? item.a ?? item[0];
        const b = item.to ?? item.b ?? item[1];
        if (a && b) flatConnections.push([a, b]);
      }
    }

    for (const pair of flatConnections) {
      const [aTok, bTok] = pair;
      const aRail = parseRailToken(aTok);
      const bRail = parseRailToken(bTok);

      let resA, resB;
      if (aRail && !bRail) {
        resB = resolveEndpoint(app, bTok, refMap, null);
        resA = resolveEndpoint(app, aTok, refMap, resB?.end);
      } else {
        resA = resolveEndpoint(app, aTok, refMap, null);
        resB = resolveEndpoint(app, bTok, refMap, resA?.end);
      }
      if (!resA || !resB) continue;

      if (resA.rail === '+') { if (resA.usedTop) topPlusUsed = true; if (resA.usedBot) botPlusUsed = true; }
      if (resB.rail === '+') { if (resB.usedTop) topPlusUsed = true; if (resB.usedBot) botPlusUsed = true; }
      if (resA.rail === '−') { if (resA.usedTop) topMinusUsed = true; if (resA.usedBot) botMinusUsed = true; }
      if (resB.rail === '−') { if (resB.usedTop) topMinusUsed = true; if (resB.usedBot) botMinusUsed = true; }

      const na = app.engine.netAt(resA.end.x, resA.end.y);
      const nb = app.engine.netAt(resB.end.x, resB.end.y);
      if (na >= 0 && na === nb) continue; // Already electrically connected on same strip/rail!

      const why = app.shortReason(resA.end, resB.end);
      if (why) throw new Error(`${aTok} → ${bTok}: ${why}`);

      const col = pickWireColor(aTok, bTok, resA.rail, resB.rail, sigIdx++);
      const pts = route(app, resA.end, resB.end);
      const w = new Wire(resA.end, resB.end, col, pts);
      app.circuit.wires.push(w);
      addedWires.push(w);
      wireSpecs.push({ aTok, bTok, a: { ...w.a }, b: { ...w.b }, color: col, aRail: resA.rail, bRail: resB.rail });
      app.reindex(true);
    }

    // Bridge top and bottom power rails automatically if both halves were tapped
    const bBridge = app.circuit.boards[0];
    if (bBridge && bBridge.rails) {
      const bridgeRail = (railChar, colHex, labelTop, labelBot) => {
        const rxA = closestRailHole(app, railChar, 't', bBridge.x + bBridge.cols, 0);
        const rxB = closestRailHole(app, railChar, 'b', bBridge.x + bBridge.cols, bBridge.h);
        if (!rxA || !rxB) return;
        const na = app.engine.netAt(rxA.x, rxA.y);
        const nb = app.engine.netAt(rxB.x, rxB.y);
        if (na >= 0 && na === nb) return;
        const w = new Wire({ x: rxA.x, y: rxA.y }, { x: rxB.x, y: rxB.y }, colHex, route(app, rxA, rxB));
        app.circuit.wires.push(w);
        addedWires.push(w);
        wireSpecs.push({ aTok: labelTop, bTok: labelBot, a: { ...w.a }, b: { ...w.b }, color: colHex, aRail: railChar, bRail: railChar, bridge: true });
        app.reindex(true);
      };
      if (topPlusUsed && botPlusUsed) bridgeRail('+', '#e5484d', 'top+', 'bot+');
      if (topMinusUsed && botMinusUsed) bridgeRail('−', '#2b2d31', 'top-', 'bot-');
    }

    if (addedWires.length) {
      tidy(app, addedWires);
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

    const refById = new Map();
    for (const sp of placedSpecs) refById.set(sp.partId, sp.ref);
    const health = verifyCircuitHealth(app, refById);
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
      warnings: health.warnings,
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

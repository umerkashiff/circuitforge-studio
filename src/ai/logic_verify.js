/**
 * Deterministic Logic, Constraint & IC-Input Verifier for CircuitForge AI.
 * Catches LLM omissions before accepting a circuit:
 *  - Gate-family constraints (e.g. "using ONLY NAND gates", "NOR gates only")
 *  - Floating IC control/input pins (used gate inputs, adder C0, FF D/J/K, decoder/mux enables)
 *  - Combinational Boolean truth-table verification across switch states
 *  - Clocked sequential flip-flop/counter liveness checks
 */
import { getDef } from '../parts/registry.js';
import { computeScopeWindow, measureChannelStats } from '../parts/library.js';
import { Engine } from '../sim/engine.js';

const NAND_TYPES = new Set(['ic7400', 'ic7410', 'ic7420', 'ic7430']);
const NOR_TYPES = new Set(['ic7402', 'ic7427']);
const LOGIC_GATE_TYPES = new Set([
  'ic7400', 'ic7402', 'ic7404', 'ic7408', 'ic7410', 'ic7411',
  'ic7414', 'ic7420', 'ic7421', 'ic7427', 'ic7430', 'ic7432',
  'ic7486', 'ic74266',
]);

// Subunit [inputIndices, outputIndex] map (0-based, matching src/parts/ics.js)
const GATE_SUBUNITS = {
  ic7400: [[[0, 1], 2], [[3, 4], 5], [[8, 9], 7], [[11, 12], 10]],
  ic7408: [[[0, 1], 2], [[3, 4], 5], [[8, 9], 7], [[11, 12], 10]],
  ic7432: [[[0, 1], 2], [[3, 4], 5], [[8, 9], 7], [[11, 12], 10]],
  ic7486: [[[0, 1], 2], [[3, 4], 5], [[8, 9], 7], [[11, 12], 10]],
  ic7402: [[[1, 2], 0], [[4, 5], 3], [[7, 8], 9], [[10, 11], 12]],
  ic74266: [[[0, 1], 2], [[4, 5], 3], [[7, 8], 9], [[11, 12], 10]],
  ic7404: [[[0], 1], [[2], 3], [[4], 5], [[8], 7], [[10], 9], [[12], 11]],
  ic7414: [[[0], 1], [[2], 3], [[4], 5], [[8], 7], [[10], 9], [[12], 11]],
  ic7410: [[[0, 1, 12], 11], [[2, 3, 4], 5], [[8, 9, 10], 7]],
  ic7411: [[[0, 1, 12], 11], [[2, 3, 4], 5], [[8, 9, 10], 7]],
  ic7427: [[[0, 1, 12], 11], [[2, 3, 4], 5], [[8, 9, 10], 7]],
  ic7420: [[[0, 1, 3, 4], 5], [[8, 9, 11, 12], 7]],
  ic7421: [[[0, 1, 3, 4], 5], [[8, 9, 11, 12], 7]],
  ic7430: [[[0, 1, 2, 3, 4, 5, 10, 11], 7]],
};

const SEQUENTIAL_OR_ANALOG_RE = /\b(clock|flip[-\s]?flop|latch|counter|decade|divide|freq|hz|blink|flash|timer|555|7474|7473|7476|7490|7493|4013|4017|74193|74595|arduino|uno|nano|esp32|stm32|7[-\s]?seg|seg7|7447|7448|adder|7483|74283|comparator|7485)\b/i;

/** Extract explicit gate-family or chip exclusion constraints from user prompt. */
export function extractGateConstraints(prompt = '') {
  const raw = String(prompt || '');
  if (!raw.trim()) return {};
  // Remove negative exclusions before checking positive gate-type mentions
  const strippedNeg = raw
    .replace(/\((?:[^)]*\b(?:no|not|without|instead\s+of|avoid)\b[^)]*)\)/gi, ' ')
    .replace(/\b(?:no|not|without|avoid|instead\s+of)\s+[a-z0-9\/\s,-]*\b(?:gates?|chips?|ics?|74\d+|and|or|not|xor|nor|xnor)\b/gi, ' ');

  const mentionsOtherGates = /\b(ic?7402|ic?7404|ic?7408|ic?7411|ic?7414|ic?7421|ic?7427|ic?7432|ic?7486|ic?74266|and\s+gates?|or\s+gates?|not\s+gates?|xor\s+gates?|xnor\s+gates?|nor\s+gates?|inverters?)\b/i.test(strippedNeg);
  const mentionsNand = /\b(nand|7400|7410|7420|7430)\b/i.test(raw);
  const explicitOnlyNand = /\b(?:nand[-\s]+only|only\s+(?:use\s+|with\s+)?(?:(?:7400|7410|7420|7430)\s+)?nand(?:\s+gates?)?|(?:using|with)\s+(?:only|just)\s+(?:(?:7400|7410|7420|7430)\s+)?nand(?:\s+gates?)?|only\s+7400)\b/i.test(raw);

  const mentionsNonNorGates = /\b(ic?7400|ic?7404|ic?7408|ic?7410|ic?7411|ic?7414|ic?7420|ic?7421|ic?7430|ic?7432|ic?7486|ic?74266|and\s+gates?|or\s+gates?|not\s+gates?|xor\s+gates?|xnor\s+gates?|nand\s+gates?|inverters?)\b/i.test(strippedNeg);
  const explicitOnlyNor = /\b(?:nor[-\s]+only|only\s+(?:use\s+|with\s+)?(?:(?:7402|7427)\s+)?nor(?:\s+gates?)?|(?:using|with)\s+(?:only|just)\s+(?:(?:7402|7427)\s+)?nor(?:\s+gates?)?|only\s+7402)\b/i.test(raw);

  const nandOnly = explicitOnlyNand || (mentionsNand && /\busing\s+(?:a\s+|the\s+)?nand\s+gates?\b|\bwith\s+nand\s+gates?\b/i.test(raw) && !mentionsOtherGates);
  const norOnly = !nandOnly && (explicitOnlyNor || (/\b(nor|7402|7427)\b/i.test(raw) && /\b(?:using|with)\s+(?:a\s+|the\s+)?nor\s+gates?\b/i.test(raw) && !mentionsNonNorGates));

  const nandChipM = raw.match(/\b(\d+)\s*(?:ic\s*7400|7400|nand)\s*(?:chips?|ics?)\b/i);
  const minNandChips = nandChipM ? parseInt(nandChipM[1], 10) : 0;
  const ledM = raw.match(/(?:with|using|place|build|add|make|and)\s+(\d+)\s*leds?(?!\s*(?:matrix|grid|x\d))\b/i);
  const minLeds = ledM ? parseInt(ledM[1], 10) : 0;

  return {
    nandOnly,
    norOnly,
    minNandChips: minNandChips >= 2 && minNandChips <= 16 ? minNandChips : 0,
    minLeds: minLeds >= 2 && minLeds <= 25 ? minLeds : 0,
  };
}

/** Verify built parts satisfy user gate-family & explicit component-count constraints. */
export function verifyPromptConstraints(prompt, circuit, refById = null) {
  const errors = [];
  const { nandOnly, norOnly, minNandChips, minLeds } = extractGateConstraints(prompt);
  if (nandOnly) {
    for (const p of circuit.parts) {
      if (LOGIC_GATE_TYPES.has(p.type) && !NAND_TYPES.has(p.type)) {
        const tag = refById?.get(p.id) || p.id;
        errors.push(`Constraint failed: user asked for NAND gates ONLY, so remove "${tag}" (${p.type}) and implement its logic with ic7400/ic7410/ic7420 NAND gates.`);
      }
    }
  } else if (norOnly) {
    for (const p of circuit.parts) {
      if (LOGIC_GATE_TYPES.has(p.type) && !NOR_TYPES.has(p.type)) {
        const tag = refById?.get(p.id) || p.id;
        errors.push(`Constraint failed: user asked for NOR gates ONLY, so remove "${tag}" (${p.type}) and implement its logic with ic7402/ic7427 NOR gates.`);
      }
    }
  }
  if (minNandChips) {
    const haveNand = circuit.parts.filter(p => NAND_TYPES.has(p.type)).length;
    if (haveNand < minNandChips) {
      errors.push(`Constraint failed: user asked for ${minNandChips} NAND chips, but only ${haveNand} NAND IC(s) placed — add the remaining ${minNandChips - haveNand} ic7400 chip(s) and wire them.`);
    }
  }
  if (minLeds && !circuit.parts.some(p => ['board-ssd1306', 'wokwi-lcd1602', 'lcd16x2'].includes(p.type))) {
    const haveLed = circuit.parts.filter(p => p.type === 'led').length;
    if (haveLed < minLeds) {
      errors.push(`Constraint failed: user asked for ${minLeds} LEDs, but only ${haveLed} LED(s) placed — add the remaining ${minLeds - haveLed} LED(s) with 220Ω resistors.`);
    }
  }
  return errors;
}

/** Parse a Boolean expression AST safely (variables A..F, X..Z) or return null if invalid. */
export function parseBooleanExpr(rawExpr) {
  let s = String(rawExpr || '').trim();
  if (!s) return null;
  s = s
    .replace(/\\overline\s*\{([A-Za-z0-9])\}/g, "$1'")
    .replace(/\\bar\s*\{([A-Za-z0-9])\}/g, "$1'")
    .replace(/\\cdot/g, '*')
    .replace(/\\oplus/g, '^')
    .replace(/([A-Za-z])\u0305/g, "$1'")
    .replace(/[−–]/g, '-')
    .replace(/⊕/g, '^')
    .replace(/[·•×]/g, '*')
    .replace(/[’′`]/g, "'");

  const tokens = [];
  let i = 0;
  const wordOps = new Map([
    ['AND', 'AND'], ['OR', 'OR'], ['XOR', 'XOR'],
    ['XNOR', 'XNOR'], ['NAND', 'NAND'], ['NOR', 'NOR'], ['NOT', 'NOT'],
  ]);

  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '(' || ch === ')' || ch === "'" || ch === '^' || ch === '+' || ch === '*' || ch === '&' || ch === '|' || ch === '!' || ch === '~') {
      if ((ch === '&' && s[i + 1] === '&') || (ch === '|' && s[i + 1] === '|')) i++;
      if (ch === '(') tokens.push({ t: 'LP' });
      else if (ch === ')') tokens.push({ t: 'RP' });
      else if (ch === "'") tokens.push({ t: 'POST_NOT' });
      else if (ch === '!' || ch === '~') tokens.push({ t: 'NOT' });
      else if (ch === '^') tokens.push({ t: 'XOR' });
      else if (ch === '+' || ch === '|') tokens.push({ t: 'OR' });
      else if (ch === '*' || ch === '&') tokens.push({ t: 'AND' });
      i++;
      continue;
    }
    if (ch === '0' || ch === '1') {
      if (/\d|[A-Za-z]/.test(s[i + 1] || '')) return null; // Reject 5V, 7400, 10k, etc.
      tokens.push({ t: 'CONST', v: ch === '1' ? 1 : 0 });
      i++;
      continue;
    }
    if (/\d/.test(ch)) return null;
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
      const word = s.slice(i, j);
      const up = word.toUpperCase();
      if (wordOps.has(up)) {
        tokens.push({ t: wordOps.get(up) });
      } else if (/^[A-FW-Z]+$/.test(up) && up.length <= 4 && !/^(IN|OR|ON|TO|OF|IF|IS|AS|BY|AT|BE)$/.test(up)) {
        for (const c of up) tokens.push({ t: 'VAR', v: c });
      } else {
        return null;
      }
      i = j;
      continue;
    }
    return null;
  }

  if (!tokens.length) return null;
  let pos = 0;
  const peek = () => tokens[pos] || null;
  const consume = () => tokens[pos++];

  const startsAtom = (tok) => tok && (tok.t === 'VAR' || tok.t === 'CONST' || tok.t === 'LP' || tok.t === 'NOT');

  function parseOr() {
    let left = parseGateMid();
    while (peek()?.t === 'OR') {
      consume();
      left = { op: 'OR', l: left, r: parseGateMid() };
    }
    return left;
  }
  function parseGateMid() {
    let left = parseXor();
    while (peek()?.t === 'NAND' || peek()?.t === 'NOR') {
      const op = consume().t;
      left = { op, l: left, r: parseXor() };
    }
    return left;
  }
  function parseXor() {
    let left = parseAnd();
    while (peek()?.t === 'XOR' || peek()?.t === 'XNOR') {
      const op = consume().t;
      left = { op, l: left, r: parseAnd() };
    }
    return left;
  }
  function parseAnd() {
    let left = parseUnary();
    while (true) {
      if (peek()?.t === 'AND') {
        consume();
        left = { op: 'AND', l: left, r: parseUnary() };
      } else if (startsAtom(peek())) {
        left = { op: 'AND', l: left, r: parseUnary() };
      } else break;
    }
    return left;
  }
  function parseUnary() {
    if (peek()?.t === 'NOT') {
      consume();
      return { op: 'NOT', x: parseUnary() };
    }
    let node = parsePrimary();
    while (peek()?.t === 'POST_NOT') {
      consume();
      node = { op: 'NOT', x: node };
    }
    return node;
  }
  function parsePrimary() {
    const tk = peek();
    if (!tk) throw new Error('eof');
    if (tk.t === 'VAR') { consume(); return { op: 'VAR', v: tk.v }; }
    if (tk.t === 'CONST') { consume(); return { op: 'CONST', v: tk.v }; }
    if (tk.t === 'LP') {
      consume();
      const inner = parseOr();
      if (consume()?.t !== 'RP') throw new Error('paren');
      return inner;
    }
    throw new Error('badtok');
  }

  let ast;
  try {
    ast = parseOr();
    if (pos !== tokens.length) return null;
  } catch {
    return null;
  }

  const vars = new Set();
  const collect = (n) => {
    if (!n) return;
    if (n.op === 'VAR') vars.add(n.v);
    if (n.l) collect(n.l);
    if (n.r) collect(n.r);
    if (n.x) collect(n.x);
  };
  collect(ast);
  const varList = [...vars].sort();
  if (varList.length < 2 || varList.length > 4) return null;
  return { ast, vars: varList, raw: rawExpr.trim() };
}

export function evalBooleanAst(node, env) {
  switch (node.op) {
    case 'VAR': return env[node.v] ? 1 : 0;
    case 'CONST': return node.v ? 1 : 0;
    case 'NOT': return evalBooleanAst(node.x, env) ? 0 : 1;
    case 'AND': return (evalBooleanAst(node.l, env) && evalBooleanAst(node.r, env)) ? 1 : 0;
    case 'OR': return (evalBooleanAst(node.l, env) || evalBooleanAst(node.r, env)) ? 1 : 0;
    case 'XOR': return (evalBooleanAst(node.l, env) ^ evalBooleanAst(node.r, env)) ? 1 : 0;
    case 'XNOR': return (evalBooleanAst(node.l, env) ^ evalBooleanAst(node.r, env)) ? 0 : 1;
    case 'NAND': return (evalBooleanAst(node.l, env) && evalBooleanAst(node.r, env)) ? 0 : 1;
    case 'NOR': return (evalBooleanAst(node.l, env) || evalBooleanAst(node.r, env)) ? 0 : 1;
    default: return 0;
  }
}

/** Extract an explicit combinational Boolean function (e.g. `F = A'B + AC'`, `Y = (A + B) * C`) from prompt. */
export function extractBooleanSpec(prompt = '') {
  const txt = String(prompt || '');
  if (!txt || SEQUENTIAL_OR_ANALOG_RE.test(txt)) return null;

  const eqRe = /(?:^|[\s,;(])(?:[FYZQ]|OUT|[FYZQ]\s*\([A-Ea-e,\s]+\))\s*=\s*([^\n.;,!?]{2,90})/gi;
  let m;
  while ((m = eqRe.exec(txt))) {
    let rhs = m[1]
      .replace(/\s+(?:using|with|via|by|from|on|in|for|where|so|that|and\s+(?:toggle|dip|switch|led|resistor|only)|only)\b.*$/i, '')
      .trim();
    if (!rhs) continue;
    // Must contain at least one Boolean operator, parenthesis, complement mark, or multi-var product
    if (!/['’′\u0305!~*&|+^·⊕()]|\b(?:AND|OR|XOR|XNOR|NAND|NOR|NOT)\b|[A-F]{2,}/i.test(rhs)) continue;
    const parsed = parseBooleanExpr(rhs);
    if (parsed) return { exprText: `${m[0].split('=')[0].trim()} = ${rhs}`, ...parsed };
  }
  return null;
}

/** Check floating inputs on active gate subunits, adders, flip-flops & decoder/mux enables. */
export function verifyFloatingIcInputs(sim, circuit, refById = null) {
  const errors = [];
  for (const p of circuit.parts) {
    const ent = sim.byPart.get(p.id);
    if (!ent) continue;
    const pins = p.worldPins();
    const tag = refById?.get(p.id) || p.id;
    const conn = (idx) => idx >= 0 && idx < ent.pinNets.length && sim.isNetConnected(ent.pinNets[idx]);

    const subs = GATE_SUBUNITS[p.type];
    if (subs) {
      for (let gIdx = 0; gIdx < subs.length; gIdx++) {
        const [ins, out] = subs[gIdx];
        const anyIn = ins.some(conn);
        const outConn = conn(out);
        if (!anyIn && !outConn) continue;
        const openIns = ins.filter(idx => !conn(idx)).map(idx => pins[idx]?.name).filter(Boolean);
        if (openIns.length) {
          errors.push(`${p.type} ("${tag}") gate ${gIdx + 1}: input pin${openIns.length > 1 ? 's' : ''} ${openIns.join(', ')} floating while gate is in use! Wire ${openIns.join(', ')} to a signal (or tie unused gate input appropriately, e.g. to "+" or ${pins[ins[0]].name} on NAND/AND).`);
        }
      }
      continue;
    }

    if (p.type === 'ic7483' || p.type === 'ic74283') {
      const c0Idx = p.type === 'ic7483' ? 12 : 6;
      const ioUsed = pins.some((q, idx) => idx !== c0Idx && q.name !== 'VCC' && q.name !== 'GND' && q.name !== 'C4' && conn(idx));
      if (ioUsed && !conn(c0Idx)) {
        errors.push(`${p.type} ("${tag}") carry-in C0 is floating (TTL reads HIGH = +1!). Wire "${tag}.C0" to "-" for addition (or "+"/mode signal for subtraction).`);
      }
    } else if (p.type === 'ic7474' || p.type === 'ic4013') {
      const units = p.type === 'ic7474'
        ? [[1, 1, 2, 4, 5], [2, 11, 10, 8, 7]]
        : [[1, 4, 2, 0, 1], [2, 8, 10, 12, 11]];
      for (const [u, dIdx, ckIdx, qIdx, qnIdx] of units) {
        if ((conn(ckIdx) || conn(qIdx) || conn(qnIdx)) && !conn(dIdx)) {
          const dName = pins[dIdx].name;
          const qnName = pins[qnIdx].name;
          errors.push(`${p.type} ("${tag}") unit ${u}: ${dName} data input is unconnected! Connect "${tag}.${dName}" (e.g. "${tag}.${qnName}" to "${tag}.${dName}" for divide-by-2 toggle).`);
        }
      }
    } else if (p.type === 'ic7473' || p.type === 'ic7476' || p.type === 'ic74112') {
      const units = p.type === 'ic7473'
        ? [[1, 13, 2, 0, 11, 12], [2, 6, 9, 4, 8, 7]]
        : p.type === 'ic7476'
          ? [[1, 3, 15, 0, 14, 13], [2, 8, 11, 5, 10, 9]]
          : [[1, 2, 1, 0, 4, 5], [2, 10, 11, 12, 8, 6]];
      for (const [u, jIdx, kIdx, ckIdx, qIdx, qnIdx] of units) {
        if ((conn(ckIdx) || conn(qIdx) || conn(qnIdx)) && !conn(jIdx) && !conn(kIdx)) {
          errors.push(`${p.type} ("${tag}") unit ${u}: ${pins[jIdx].name} and ${pins[kIdx].name} inputs are unconnected — wire both (e.g. to "+" for JK toggle).`);
        }
      }
    } else if (p.type === 'ic74138' || p.type === 'ic74238') {
      const used = pins.some((q, idx) => (idx < 3 || (idx >= 6 && idx <= 14 && idx !== 7)) && conn(idx));
      if (used && (!conn(3) || !conn(4) || !conn(5))) {
        const miss = [3, 4, 5].filter(i => !conn(i)).map(i => pins[i].name);
        errors.push(`${p.type} ("${tag}") enable pin(s) ${miss.join(', ')} floating (TTL floating G2A/G2B disables outputs!). Wire G1->"+", G2A->"-", G2B->"-".`);
      }
    } else if (p.type === 'ic74151' || p.type === 'ic74157' || p.type === 'ic74158') {
      const gIdx = p.type === 'ic74151' ? 6 : 14;
      const used = pins.some((q, idx) => idx !== gIdx && q.name !== 'VCC' && q.name !== 'GND' && conn(idx));
      if (used && !conn(gIdx)) {
        errors.push(`${p.type} ("${tag}") strobe G is floating (TTL reads HIGH and disables output). Wire "${tag}.G" to "-".`);
      }
    } else if (p.type === 'ic74139' || p.type === 'ic74153') {
      const u1Used = [1, 2, 3, 4, 5, 6].some(conn);
      const u2Used = [8, 9, 10, 11, 12, 13].some(conn);
      if (u1Used && !conn(0)) errors.push(`${p.type} ("${tag}") 1G enable is floating — wire "${tag}.1G" to "-".`);
      if (u2Used && !conn(14)) errors.push(`${p.type} ("${tag}") 2G enable is floating — wire "${tag}.2G" to "-".`);
    } else if (p.type === 'ic7493' || p.type === 'ic7490') {
      const nR1 = ent.pinNets?.[1] ?? -1;
      const nR2 = ent.pinNets?.[2] ?? -1;
      const vR1 = nR1 >= 0 ? sim.voltage(nR1) : NaN;
      const vR2 = nR2 >= 0 ? sim.voltage(nR2) : NaN;
      if (vR1 >= 3.0 && vR2 >= 3.0 && sim.netAt !== null) {
        const usedClkOrOut = conn(0) || conn(13) || conn(11) || conn(8) || conn(7) || conn(10);
        if (usedClkOrOut) {
          errors.push(`${p.type} ("${tag}") active-HIGH reset pins R0(1) and R0(2) are BOTH HIGH — this freezes the counter at 0 forever! Wire R0(1) and R0(2) to "-" to count (or decode count bits).`);
        }
      }
    } else if (p.type === 'ic4017') {
      const nInh = ent.pinNets?.[12] ?? -1;
      const nRst = ent.pinNets?.[14] ?? -1;
      const vInh = nInh >= 0 ? sim.voltage(nInh) : NaN;
      const vRst = nRst >= 0 ? sim.voltage(nRst) : NaN;
      if (conn(13) && vRst >= 3.0) {
        errors.push(`ic4017 ("${tag}") active-HIGH RST is tied HIGH — freezes outputs at Q0! Wire "${tag}.RST" to "-".`);
      } else if (conn(13) && vInh >= 3.0) {
        errors.push(`ic4017 ("${tag}") INH (clock inhibit) is tied HIGH — blocks counting! Wire "${tag}.INH" to "-".`);
      }
    } else if (p.type === 'ic74595') {
      const usedShift = conn(10) || conn(11) || conn(13);
      const nClr = ent.pinNets?.[9] ?? -1;
      const nOe = ent.pinNets?.[12] ?? -1;
      const vClr = nClr >= 0 ? sim.voltage(nClr) : NaN;
      const vOe = nOe >= 0 ? sim.voltage(nOe) : NaN;
      if (usedShift && conn(9) && vClr <= 0.8) {
        errors.push(`ic74595 ("${tag}") active-LOW SRCLR is tied LOW — clears shift register continuously! Wire "${tag}.SRCLR" to "+".`);
      } else if (usedShift && conn(12) && vOe >= 3.0) {
        errors.push(`ic74595 ("${tag}") active-LOW OE is tied HIGH — outputs remain tri-stated! Wire "${tag}.OE" to "-".`);
      }
    }
  }
  return errors;
}

/** Verify combinational Boolean circuits against all input switch combinations in simulation. */
export function verifyBooleanBehavior(prompt, sim, circuit, refById = null) {
  const spec = extractBooleanSpec(prompt);
  if (!spec) return [];

  // Do not evaluate if circuit has clocked/timer/MCU parts
  const hasDynamic = circuit.parts.some(p => {
    const def = getDef(p.type);
    return def.mcu || p.type === 'clock' || p.type === 'funcgen' || p.type === 'ne555' ||
      ['ic7474', 'ic7473', 'ic7476', 'ic74112', 'ic4013', 'ic7490', 'ic7493', 'ic4017', 'ic74193', 'ic74194', 'ic74165', 'ic74595'].includes(p.type);
  });
  if (hasDynamic) return [];

  const wiredLeds = circuit.parts.filter(p => {
    if (p.type !== 'led') return false;
    const ent = sim.byPart.get(p.id);
    return ent && sim.isNetConnected(ent.pinNets[0]) && sim.isNetConnected(ent.pinNets[1]);
  });
  if (wiredLeds.length !== 1) return [];
  const led = wiredLeds[0];

  // Collect controllable binary switch inputs (dip4/dip8 channels OR toggles)
  const dips = circuit.parts.filter(p => (p.type === 'dip4' || p.type === 'dip8'));
  const toggles = circuit.parts.filter(p => {
    if (p.type !== 'toggle') return false;
    const ent = sim.byPart.get(p.id);
    return ent && sim.isNetConnected(ent.pinNets[0]);
  });

  const bindings = []; // Array<{ name, set(bool) }>
  const vars = spec.vars;

  if (dips.length === 1 && toggles.length === 0) {
    const dip = dips[0];
    const ent = sim.byPart.get(dip.id);
    const activeBits = [];
    for (let i = 0; i < ent.pinNets.length; i++) {
      if (sim.isNetConnected(ent.pinNets[i])) activeBits.push(i);
    }
    if (activeBits.length !== vars.length) {
      return [
        `Boolean logic verification failed for ${spec.exprText}: expected ${vars.length} active DIP switch channels for (${vars.join(', ')}), got ${activeBits.length}. Wire all ${vars.length} switch inputs so every truth-table row can be tested.`,
      ];
    }
    for (let k = 0; k < vars.length; k++) {
      const bitIdx = activeBits[k];
      bindings.push({
        name: vars[k],
        set: (v) => { dip.props.bits[bitIdx] = v; },
      });
    }
  } else if (dips.length === 0 && toggles.length > 0) {
    if (toggles.length !== vars.length) {
      return [
        `Boolean logic verification failed for ${spec.exprText}: expected ${vars.length} wired toggle switches for (${vars.join(', ')}), got ${toggles.length}. Add/wire all ${vars.length} input toggles (${vars.join(', ')}).`,
      ];
    }
    // Prefer matching toggle label/ref to variable letter when unambiguous
    const used = new Set();
    for (const vName of vars) {
      let match = toggles.find(t => !used.has(t.id) && String(t.props?.label || '').trim().toUpperCase() === vName);
      if (!match && refById) {
        match = toggles.find(t => !used.has(t.id) && String(refById.get(t.id) || '').trim().toUpperCase() === vName);
      }
      if (!match) {
        bindings.length = 0;
        break;
      }
      used.add(match.id);
      bindings.push({ name: vName, set: (v) => { match.props.on = v; } });
    }
    if (bindings.length !== vars.length) {
      for (let k = 0; k < vars.length; k++) {
        const sw = toggles[k];
        bindings.push({ name: vars[k], set: (v) => { sw.props.on = v; } });
      }
    }
  } else {
    return [];
  }

  // Save original switch states to restore cleanly after verification
  const savedDipBits = dips.map(d => d.props.bits.slice());
  const savedToggleStates = toggles.map(t => Boolean(t.props.on));

  const mismatches = [];
  const rows = 1 << vars.length;
  try {
    for (let mask = 0; mask < rows; mask++) {
      const env = {};
      for (let k = 0; k < vars.length; k++) {
        const val = Boolean((mask >> (vars.length - 1 - k)) & 1);
        env[vars[k]] = val ? 1 : 0;
        bindings[k].set(val);
      }
      for (let s = 0; s < 4; s++) sim.step(0.005);
      const ledDev = sim.byPart.get(led.id)?.device;
      const curA = ledDev?.cur?.[0] || 0;
      const got = curA > 0.0005 ? 1 : 0;
      const exp = evalBooleanAst(spec.ast, env);
      if (got !== exp) {
        const assign = vars.map(v => `${v}=${env[v]}`).join(', ');
        mismatches.push(`when (${assign}): expected ${exp}, got LED ${got ? 'ON (1)' : 'OFF (0)'}`);
      }
    }
  } finally {
    dips.forEach((d, idx) => { d.props.bits = savedDipBits[idx]; });
    toggles.forEach((t, idx) => { t.props.on = savedToggleStates[idx]; });
    for (let s = 0; s < 3; s++) sim.step(0.005);
  }

  if (mismatches.length) {
    return [
      `Boolean logic verification failed for ${spec.exprText}: ${mismatches.slice(0, 4).join('; ')}. Double-check your gate algebra, inversions, and wire connections so the output LED matches all ${rows} truth-table rows.`,
    ];
  }
  return [];
}

/** Detect multiple push-pull / active logic outputs wired onto the same net even when initially equal. */
export function verifyOutputContention(sim, circuit, refById = null) {
  const driversByNet = new Map();
  const addDriver = (net, label) => {
    if (net < 0) return;
    if (!driversByNet.has(net)) driversByNet.set(net, []);
    driversByNet.get(net).push(label);
  };

  for (const p of circuit.parts) {
    const ent = sim.byPart.get(p.id);
    if (!ent) continue;
    const tag = refById?.get(p.id) || p.id;
    const pins = p.worldPins();
    if (p.type === 'toggle' || p.type === 'button' || p.type === 'clock') {
      addDriver(ent.pinNets[0], `${tag}.${pins[0]?.name || 'OUT'}`);
    } else if (p.type === 'dip4' || p.type === 'dip8') {
      for (let i = 0; i < ent.pinNets.length; i++) {
        addDriver(ent.pinNets[i], `${tag}.${pins[i]?.name || ('S' + (i + 1))}`);
      }
    } else if (p.type === 'ne555') {
      addDriver(ent.pinNets[2], `${tag}.OUT`);
    } else if (ent.device && Array.isArray(ent.device.out)) {
      const d = ent.device;
      for (let pinNum = 1; pinNum < d.out.length; pinNum++) {
        if (d.out[pinNum] !== undefined && d.out[pinNum] !== null && d.mode?.[pinNum] === 'pp') {
          addDriver(ent.pinNets[pinNum - 1], `${tag}.${pins[pinNum - 1]?.name || pinNum}`);
        }
      }
    }
  }

  const errors = [];
  for (const [, drivers] of driversByNet) {
    if (drivers.length >= 2) {
      errors.push(`Shorted outputs / driver contention: ${drivers.join(' and ')} are both driving the same node — never wire two outputs directly together.`);
    }
  }
  return errors;
}

const COUNTER_SEQ_TYPES = new Set(['ic4017', 'ic7490', 'ic7493', 'ic74193', 'ic74194', 'ic74165', 'ic74595']);
const ALL_SEQ_TYPES = new Set(['ic7474', 'ic7473', 'ic7476', 'ic74112', 'ic4013', ...COUNTER_SEQ_TYPES]);

/** Probe peak/min currents and voltages across DC, switch states, and clock/counter/555 cycles. */
export function probeCircuitLedBehavior(sim, circuit) {
  const leds = circuit.parts.filter(p => p.type === 'led');
  if (!leds.length) return [];

  const stats = leds.map((p) => {
    const ent = sim.byPart.get(p.id);
    const nA = ent?.pinNets?.[0] ?? -1;
    const nK = ent?.pinNets?.[1] ?? -1;
    const open = !ent || !sim.isNetConnected(nA) || !sim.isNetConnected(nK);
    const shorted = !open && nA >= 0 && nA === nK;
    const blown = Boolean(ent?.device?.blown?.[0]);
    const mA = Math.abs((ent?.device?.cur?.[0] || 0) * 1000);
    return {
      id: p.id,
      part: p,
      nA,
      nK,
      open,
      shorted,
      blown,
      peakMa: mA,
      minMa: mA,
      vA: nA >= 0 ? sim.voltage(nA) : NaN,
      vK: nK >= 0 ? sim.voltage(nK) : NaN,
      maxRevBias: 0,
      revVa: NaN,
      revVk: NaN,
    };
  });

  const sampleLeds = (eng = sim) => {
    for (const s of stats) {
      const ent = eng.byPart.get(s.id);
      if (ent?.device?.blown?.[0]) s.blown = true;
      const mA = (ent?.device?.cur?.[0] || 0) * 1000;
      if (mA > s.peakMa) s.peakMa = mA;
      if (mA < s.minMa) s.minMa = mA;
      const nA = ent?.pinNets?.[0] ?? -1;
      const nK = ent?.pinNets?.[1] ?? -1;
      if (nA >= 0) s.vA = eng.voltage(nA);
      if (nK >= 0) s.vK = eng.voltage(nK);
      if (Number.isFinite(s.vA) && Number.isFinite(s.vK) && (s.vK - s.vA) > s.maxRevBias) {
        s.maxRevBias = s.vK - s.vA;
        s.revVa = s.vA;
        s.revVk = s.vK;
      }
    }
  };

  const clocks = circuit.parts.filter(p => p.type === 'clock');
  const hasMcu = circuit.parts.some(p => getDef(p.type).mcu);
  const has555 = circuit.parts.some(p => p.type === 'ne555');
  const hasCounter = circuit.parts.some(p => COUNTER_SEQ_TYPES.has(p.type));
  const dips = circuit.parts.filter(p => p.type === 'dip4' || p.type === 'dip8');
  const toggles = circuit.parts.filter(p => {
    if (p.type !== 'toggle') return false;
    const ent = sim.byPart.get(p.id);
    return ent && sim.isNetConnected(ent.pinNets[0]);
  });
  const pots = circuit.parts.filter(p => p.type === 'pot' || p.type === 'wokwi-slide-potentiometer');
  const tactiles = circuit.parts.filter(p => p.type === 'tactile');

  const setters = [];
  for (const dip of dips) {
    const ent = sim.byPart.get(dip.id);
    if (!ent) continue;
    for (let i = 0; i < ent.pinNets.length; i++) {
      if (sim.isNetConnected(ent.pinNets[i])) setters.push(v => { dip.props.bits[i] = v; });
    }
  }
  for (const sw of toggles) setters.push(v => { sw.props.on = v; });

  const savedDipBits = dips.map(d => d.props.bits.slice());
  const savedToggles = toggles.map(t => Boolean(t.props.on));
  const savedPots = pots.map(p => p.props.pos);
  const savedTactiles = tactiles.map(t => Boolean(t.ui?.pressed));

  const sweepPots = (eng) => {
    if (!pots.length) return;
    for (const pos of [0.05, 0.95]) {
      pots.forEach(p => { p.props.pos = pos; });
      for (let i = 0; i < 6; i++) eng.step(0.005);
      sampleLeds(eng);
    }
  };

  const estimate555Hz = () => {
    const t555 = circuit.parts.find(p => p.type === 'ne555');
    if (t555) {
      const ent = sim.byPart.get(t555.id);
      const nTrig = ent?.pinNets?.[1] ?? -1;
      const nThr = ent?.pinNets?.[5] ?? -1;
      const nDis = ent?.pinNets?.[6] ?? -1;
      const nGnd = ent?.pinNets?.[0] ?? -1;
      let rSum = 0, cSum = 0;
      for (const rp of circuit.parts) {
        const re = sim.byPart.get(rp.id);
        if (!re) continue;
        if (rp.type === 'resistor') {
          const onDis = re.pinNets.some(n => n >= 0 && n === nDis);
          const onThr = re.pinNets.some(n => n >= 0 && (n === nThr || n === nTrig));
          if (onDis || onThr) rSum += (onThr ? 2 : 1) * Math.max(100, +(rp.props?.ohms || 1000));
        } else if (rp.type === 'capacitor') {
          const onThr = re.pinNets.some(n => n >= 0 && (n === nThr || n === nTrig));
          if (onThr) cSum += Math.max(1e-12, (+(rp.props?.uf || 1)) * 1e-6);
        }
      }
      if (rSum > 0 && cSum > 0 && nThr >= 0 && nThr !== nGnd) {
        const f = 1.44 / (rSum * cSum);
        if (f > 0.05 && f < 100000) return Math.min(200, Math.max(0.25, f));
      }
    }
    const maxCapUf = Math.max(0, ...circuit.parts.filter(p => p.type === 'capacitor').map(p => +p.props?.uf || 0));
    return maxCapUf >= 100 ? 0.4 : maxCapUf >= 47 ? 0.8 : maxCapUf >= 10 ? 1.2 : 2;
  };

  const runClockWindow = (cycles) => {
    const hzList = clocks.map(c => Math.max(0.25, Math.min(200, +(c.props.frequency || c.props.hz || 1))));
    const est555Hz = has555 && !hzList.length ? estimate555Hz() : 2;
    const minHz = hzList.length ? Math.min(...hzList) : est555Hz;
    const maxClockHz = hzList.length ? Math.max(...hzList) : est555Hz;
    const stepMax = Math.min(0.025, 1 / (Math.max(maxClockHz, 2) * 8));
    const maxSpanSec = hasCounter ? 24 : 12;
    const totalSpan = Math.min(maxSpanSec, cycles / Math.max(minHz, 0.35));
    const steps = Math.min(2400, Math.max(24, Math.ceil(totalSpan / stepMax)));
    const dt = totalSpan / steps;
    for (let i = 0; i < steps; i++) {
      sim.step(dt);
      sampleLeds();
    }
  };

  try {
    const seqCycles = hasCounter ? 14 : 3;
    if (clocks.length || has555 || hasCounter) {
      if (setters.length) {
        // Test dynamic behavior with switches ON and OFF so gated clock/counter LEDs are exercised
        setters.forEach(fn => fn(true));
        runClockWindow(seqCycles);
        setters.forEach(fn => fn(false));
        runClockWindow(2);
      } else {
        runClockWindow(seqCycles);
      }
      if (tactiles.length) {
        tactiles.forEach(t => { t.ui = { ...(t.ui || {}), pressed: true }; });
        sim.build(circuit);
        runClockWindow(seqCycles);
      }
      if (pots.length) sweepPots(sim);
    } else if (setters.length) {
      const pats = [];
      if (setters.length <= 4) {
        for (let m = 0; m < (1 << setters.length); m++) pats.push(setters.map((_, k) => Boolean((m >> k) & 1)));
      } else {
        pats.push(setters.map(() => false), setters.map(() => true));
        for (let k = 0; k < Math.min(setters.length, 8); k++) pats.push(setters.map((_, j) => j === k));
      }
      for (const pat of pats) {
        pat.forEach((v, k) => setters[k](v));
        for (let i = 0; i < 4; i++) sim.step(0.005);
        sampleLeds();
      }
    } else if (hasMcu) {
      for (let i = 0; i < 180; i++) {
        sim.step(0.025);
        sampleLeds();
      }
    } else {
      for (let i = 0; i < 8; i++) sim.step(0.005);
      sampleLeds();
      sweepPots(sim);
      if (tactiles.length) {
        tactiles.forEach(t => { t.ui = { ...(t.ui || {}), pressed: true }; });
        const pressSim = new Engine();
        pressSim.build(circuit);
        for (let i = 0; i < 6; i++) pressSim.step(0.005);
        sampleLeds(pressSim);
        sweepPots(pressSim);
      }
    }
  } finally {
    dips.forEach((d, idx) => { d.props.bits = savedDipBits[idx]; });
    toggles.forEach((t, idx) => { t.props.on = savedToggles[idx]; });
    pots.forEach((p, idx) => { p.props.pos = savedPots[idx]; });
    tactiles.forEach((t, idx) => { t.ui = { ...(t.ui || {}), pressed: savedTactiles[idx] }; });
    if (setters.length || pots.length) for (let i = 0; i < 3; i++) sim.step(0.005);
  }

  return stats.map(s => ({
    ...s,
    litOnce: s.peakMa >= 0.35 && !s.blown,
    toggles: s.peakMa >= 0.35 && s.minMa < 0.2,
  }));
}

/** Verify un-gated clocked flip-flop / counter circuits actually transition (catch stuck PRE/CLR/Q feedback). */
export function verifySequentialClockLiveness(sim, circuit, refById = null) {
  const clocks = circuit.parts.filter(p => p.type === 'clock' || p.type === 'ne555');
  if (!clocks.length) return [];
  const hasSwitches = circuit.parts.some(p => ['toggle', 'button', 'dip4', 'dip8', 'slide'].includes(p.type));
  if (hasSwitches) return [];

  const seqParts = circuit.parts.filter(p => ALL_SEQ_TYPES.has(p.type));
  if (!seqParts.length) return [];

  const probed = probeCircuitLedBehavior(sim, circuit).filter(s => !s.open);
  if (!probed.length) return [];

  const allStuck = probed.every(s => !s.toggles);
  if (!allStuck) return [];

  const stuckDesc = seqParts.map(p => `${p.type} ("${refById?.get(p.id) || p.id}")`).join(', ');
  const isFf = seqParts.some(p => ['ic7474', 'ic7473', 'ic7476', 'ic74112', 'ic4013'].includes(p.type));
  return [
    isFf
      ? `Clocked flip-flop ${stuckDesc} output LED stayed stuck (${probed[0].litOnce ? 'always ON' : 'always OFF'}) over 2.5+ clock cycles! Check: for 7474 divide-by-2, tie 1Q̅ (inverted output) -> 1D, and tie active-low 1PRE and 1CLR to "+".`
      : `Clocked counter ${stuckDesc} LED output(s) never toggled over 2.5+ clock cycles! Check clock pin, active-high/low resets (tie 7490/7493 R0(1)/R0(2) or 4017 RST to "-"), and power pins.`,
  ];
}

/** Verify combinational switch + logic-IC builds aren't dead/constant across switch states. */
export function verifyCombinationalSwitchLiveness(sim, circuit) {
  const hasDynamic = circuit.parts.some(p => {
    const def = getDef(p.type);
    return def.mcu || p.type === 'clock' || p.type === 'funcgen' || p.type === 'ne555' ||
      ['ic7474', 'ic7473', 'ic7476', 'ic74112', 'ic4013', 'ic7490', 'ic7493', 'ic4017', 'ic74193', 'ic74194', 'ic74165', 'ic74595'].includes(p.type);
  });
  if (hasDynamic) return [];

  const hasLogicIc = circuit.parts.some(p => LOGIC_GATE_TYPES.has(p.type) || ['ic7483', 'ic74283', 'ic7485', 'ic74138', 'ic74238', 'ic74139', 'ic74151', 'ic74153', 'ic74157', 'ic74158'].includes(p.type));
  if (!hasLogicIc) return [];

  const leds = circuit.parts.filter(p => {
    if (p.type !== 'led') return false;
    const ent = sim.byPart.get(p.id);
    return ent && sim.isNetConnected(ent.pinNets[0]) && sim.isNetConnected(ent.pinNets[1]);
  });
  if (!leds.length) return [];

  const dips = circuit.parts.filter(p => p.type === 'dip4' || p.type === 'dip8');
  const toggles = circuit.parts.filter(p => {
    if (p.type !== 'toggle') return false;
    const ent = sim.byPart.get(p.id);
    return ent && sim.isNetConnected(ent.pinNets[0]);
  });

  const setters = [];
  for (const dip of dips) {
    const ent = sim.byPart.get(dip.id);
    for (let i = 0; i < ent.pinNets.length; i++) {
      if (sim.isNetConnected(ent.pinNets[i])) setters.push(v => { dip.props.bits[i] = v; });
    }
  }
  for (const sw of toggles) setters.push(v => { sw.props.on = v; });
  if (!setters.length) return [];

  const savedDipBits = dips.map(d => d.props.bits.slice());
  const savedToggles = toggles.map(t => Boolean(t.props.on));
  const ledSeen = leds.map(() => ({ hi: false, lo: false }));

  const patterns = [];
  if (setters.length <= 4) {
    const nRows = 1 << setters.length;
    for (let m = 0; m < nRows; m++) patterns.push(setters.map((_, k) => Boolean((m >> k) & 1)));
  } else {
    patterns.push(setters.map(() => false), setters.map(() => true));
    patterns.push(setters.map((_, k) => k % 2 === 0), setters.map((_, k) => k % 2 === 1));
    patterns.push(setters.map((_, k) => k < setters.length / 2), setters.map((_, k) => k >= setters.length / 2));
    for (let k = 0; k < Math.min(setters.length, 8); k++) {
      patterns.push(setters.map((_, j) => j === k));
    }
  }

  try {
    for (const pat of patterns) {
      pat.forEach((v, k) => setters[k](v));
      for (let s = 0; s < 4; s++) sim.step(0.005);
      for (let k = 0; k < leds.length; k++) {
        const mA = (sim.byPart.get(leds[k].id)?.device?.cur?.[0] || 0) * 1000;
        if (mA > 0.5) ledSeen[k].hi = true; else ledSeen[k].lo = true;
      }
    }
  } finally {
    dips.forEach((d, idx) => { d.props.bits = savedDipBits[idx]; });
    toggles.forEach((t, idx) => { t.props.on = savedToggles[idx]; });
    for (let s = 0; s < 3; s++) sim.step(0.005);
  }

  const allDead = ledSeen.every(s => !(s.hi && s.lo));
  if (allDead) {
    return [`Combinational logic check failed: output LED(s) stayed stuck (${ledSeen[0].hi ? 'always ON' : 'always OFF'}) across all ${patterns.length} tested switch input patterns! Verify gate/IC wiring and active-low/high polarities.`];
  }
  return [];
}

/** Verify static LED circuits actually light up and pattern/shape prompts don't light 100% identically. */
export function verifyStaticLedPattern(prompt, sim, circuit) {
  const txt = String(prompt || '');
  const hasDynamic = circuit.parts.some(p => ['toggle', 'button', 'tactile', 'slide', 'pot', 'wokwi-slide-potentiometer', 'dip4', 'dip8', 'clock', 'ne555', 'uno', 'nano', 'esp32', 'esp32s3', 'bluepill'].includes(p.type));
  if (hasDynamic) return [];
  const wiredLeds = circuit.parts.filter(p => {
    if (p.type !== 'led') return false;
    const ent = sim.byPart.get(p.id);
    return ent && sim.isNetConnected(ent.pinNets[0]) && sim.isNetConnected(ent.pinNets[1]);
  });
  if (wiredLeds.length < 1) return [];

  let lit = 0;
  for (const led of wiredLeds) {
    const mA = (sim.byPart.get(led.id)?.device?.cur?.[0] || 0) * 1000;
    if (mA > 0.5) lit++;
  }
  if (lit === 0) {
    return [`None of the ${wiredLeds.length} wired LED(s) lit up (all 0 mA)! Check that "vcc"->"+", "gnd"->"-", and LED Anodes reach "+" (via resistor) and Cathodes reach "-".`];
  }
  const allLeds = circuit.parts.filter(p => p.type === 'led');
  if (allLeds.length >= 4 && lit === allLeds.length && /\b(smiley|smile|face|heart|arrow|cross|checker|shape|pattern|unlit|off)\b/i.test(txt)) {
    return [`Visual LED pattern check failed: all ${allLeds.length}/${allLeds.length} LEDs are lit! Wire ONLY active pattern pixels to + (via 220Ω resistors) and tie unlit background LEDs to "-" so the shape actually appears.`];
  }
  return [];
}

/** Verify EVERY active output LED actually illuminates (>=0.35 mA) across DC, switch, clock, and MCU cycles. */
export function verifyActiveLedHealth(prompt, sim, circuit, refById = null, { requireWiredAll = false } = {}) {
  const hasMcu = circuit.parts.some(p => getDef(p.type).mcu);
  const hasInputSwitch = circuit.parts.some(p => ['button', 'tactile', 'pot', 'wokwi-analog-joystick', 'wokwi-mpu6050'].includes(p.type));
  const txt = String(prompt || '');
  const leds = circuit.parts.filter(p => p.type === 'led');
  if (!leds.length) return [];

  // Static visual shape/matrix patterns deliberately tie unlit pixels both pins to GND ("-")
  const isVisualMatrix = leds.length >= 4 && !hasMcu && !circuit.parts.some(p => ['clock', 'ne555', 'ic7493', 'ic7490', 'ic4017'].includes(p.type)) &&
    (leds.some(p => p.props?.row !== undefined) || /\b(\d+\s*[x×]\s*\d+|square|matrix|grid|smiley|smile|face|heart|arrow|cross|letter)\b/i.test(txt));
  if (isVisualMatrix) return [];

  const skipLiveness = hasMcu && hasInputSwitch;
  const probed = skipLiveness
    ? leds.map((p) => {
        const ent = sim.byPart.get(p.id);
        const nA = ent?.pinNets?.[0] ?? -1;
        const nK = ent?.pinNets?.[1] ?? -1;
        const open = !ent || !sim.isNetConnected(nA) || !sim.isNetConnected(nK);
        return { id: p.id, open, shorted: !open && nA >= 0 && nA === nK, blown: Boolean(ent?.device?.blown?.[0]), litOnce: true };
      })
    : probeCircuitLedBehavior(sim, circuit);
  const errors = [];
  for (const s of probed) {
    const tag = refById?.get(s.id) || s.id;
    if (s.open) {
      if (requireWiredAll) {
        errors.push(`LED "${tag}" has an unconnected pin — wire Anode (via 220–470Ω resistor) to its driver/signal and Cathode to "-".`);
      }
      continue;
    }
    if (s.shorted) {
      errors.push(`LED "${tag}" Anode and Cathode are shorted onto the same breadboard strip/net — separate Anode and Cathode onto different strips and connect Cathode to "-".`);
    } else if (s.blown) {
      errors.push(`LED "${tag}" is damaged by excess current — place a 220–470Ω current-limiting resistor in series.`);
    } else if (!skipLiveness && !s.litOnce) {
      const isRev = (s.maxRevBias > 0.5 && Number.isFinite(s.revVa) && Number.isFinite(s.revVk))
        || (Number.isFinite(s.vA) && Number.isFinite(s.vK) && s.vK > s.vA + 0.5);
      const vaNum = (s.maxRevBias > 0.5 && Number.isFinite(s.revVa)) ? s.revVa : s.vA;
      const vkNum = (s.maxRevBias > 0.5 && Number.isFinite(s.revVk)) ? s.revVk : s.vK;
      const vA = Number.isFinite(vaNum) ? `${vaNum.toFixed(2)}V` : 'NC';
      const vK = Number.isFinite(vkNum) ? `${vkNum.toFixed(2)}V` : 'NC';
      if (isRev) {
        errors.push(`LED "${tag}" is reverse-biased and never lights (Anode=${vA} < Cathode=${vK}) — swap Anode/Cathode or tie Cathode to "-".`);
      } else {
        errors.push(`LED "${tag}" never turned ON (peak ${s.peakMa.toFixed(2)} mA; Anode=${vA}, Cathode=${vK}) — fix its resistor/driver wiring, check counter/gate inputs, and ensure series resistance is 220–470Ω.`);
      }
    }
  }
  return errors;
}

/**
 * Archetype 3: Cross-check configured Arduino/MCU sketch GPIOs (rt.modes) against physically wired board pins.
 */
export function verifyMcuSketchPinCrossCheck(sim, circuit, refById = null) {
  const errors = [];
  for (const p of circuit.parts) {
    const def = getDef(p.type);
    if (!def.mcu || !def.board) continue;
    const ent = sim.byPart.get(p.id);
    const rt = ent?.device?.rt;
    if (!rt?.modes?.size) continue;
    // Only cross-check once at least one board pin is actually wired (0-pin MCUs are handled separately)
    if (!ent.pinNets?.some(n => sim.isNetConnected(n))) continue;

    const tag = refById?.get(p.id) || p.id;
    const gpioToIdx = new Map();
    def.board.pins.forEach((bp, idx) => {
      if (bp.kind !== 'io') return;
      if (!gpioToIdx.has(bp.gpio)) gpioToIdx.set(bp.gpio, []);
      gpioToIdx.get(bp.gpio).push(idx);
    });

    const missing = [];
    for (const gpio of rt.modes.keys()) {
      if (gpio === def.board.ledPin || gpio === def.board.rgbPin) continue;
      const idxs = gpioToIdx.get(gpio);
      if (!idxs) continue; // invalid pin already reported via rt.notes
      if (!idxs.some(i => sim.isNetConnected(ent.pinNets[i]))) {
        const pinName = def.board.pins[idxs[0]]?.name || `GPIO${gpio}`;
        missing.push(pinName);
      }
    }
    if (missing.length) {
      errors.push(
        `MCU "${tag}" sketch configures pin(s) ${missing.slice(0, 6).join(', ')}, which are unwired on the board — wire "${tag}.${missing[0]}" to your peripheral or match the pin numbers in props.code.`,
      );
    }
  }
  return errors;
}

/**
 * Archetype 5: Verify placed instruments & multi-segment loads (oscilloscope, seg7, bargraph, buzzer) actually receive signals.
 */
export function verifyInstrumentAndLoadLiveness(sim, circuit, refById = null) {
  const errors = [];
  const hasSwitches = circuit.parts.some(p => ['toggle', 'button', 'tactile', 'slide', 'pot', 'wokwi-slide-potentiometer', 'dip4', 'dip8', 'wokwi-analog-joystick', 'wokwi-mpu6050'].includes(p.type));
  const hasDynamic = circuit.parts.some(p => getDef(p.type).mcu || ['clock', 'funcgen', 'ne555'].includes(p.type));
  const scopes = circuit.parts.filter(p => p.type === 'oscilloscope');
  const buzzers = circuit.parts.filter(p => p.type === 'buzzer');
  const segs = circuit.parts.filter(p => p.type === 'seg7');
  const bars = circuit.parts.filter(p => p.type === 'bargraph');

  for (const sc of scopes) {
    const ent = sim.byPart.get(sc.id);
    if (!ent) continue;
    const tag = refById?.get(sc.id) || sc.id;
    const c1 = sim.isNetConnected(ent.pinNets[0]);
    const c2 = sim.isNetConnected(ent.pinNets[2]);
    if (!c1 && !c2) {
      errors.push(`Oscilloscope "${tag}" CH1+ and CH2+ probes are both unconnected — connect "${tag}.CH1+" to the signal node and "${tag}.CH1 GND" to "-".`);
    }
  }

  for (const bz of buzzers) {
    const ent = sim.byPart.get(bz.id);
    if (!ent) continue;
    const tag = refById?.get(bz.id) || bz.id;
    const n0 = ent.pinNets?.[0] ?? -1;
    const n1 = ent.pinNets?.[1] ?? -1;
    const c0 = sim.isNetConnected(n0);
    const c1 = sim.isNetConnected(n1);
    if (c0 !== c1) {
      errors.push(`buzzer ("${tag}") has an unconnected pin — wire "${tag}.+" to driver/signal and "${tag}.-" to "-".`);
    } else if (c0 && n0 >= 0 && n0 === n1) {
      errors.push(`buzzer ("${tag}") "+" and "-" pins are shorted on the same net — separate them.`);
    }
  }

  if (errors.length) return errors;

  // Step dynamic simulator with sub-stepping above Nyquist so 50/100/200/1k Hz waves never alias to 0.00 Vpp
  const needDynamicWindow = !hasSwitches && hasDynamic && (scopes.length || buzzers.length || segs.length || bars.length);
  const maxSpan = scopes.length ? Math.min(1.5, Math.max(0.6, Math.max(...scopes.map(s => (s.props?.timeDiv || 0.05) * 10)))) : 0.6;
  const srcHzList = circuit.parts
    .filter(p => p.type === 'funcgen' || p.type === 'clock')
    .map(p => +p.props?.hz || +p.props?.frequency || 10);
  const maxSrcHz = srcHzList.length ? Math.max(...srcHzList) : 0;
  const minSrcHz = srcHzList.length ? Math.min(...srcHzList) : 0;
  const hasSlowLogic = circuit.parts.some(p => getDef(p.type).mcu || p.type === 'ne555') || (minSrcHz > 0 && minSrcHz < 15);
  const buzMaxDv = new Map();
  let segPeakMa = 0;
  let barPeakMa = 0;

  if (needDynamicWindow || segs.length || bars.length) {
    const useAcWindow = needDynamicWindow && maxSrcHz >= 15 && !hasSlowLogic;
    const dt = useAcWindow
      ? Math.max(2e-5, Math.min(0.002, 1 / (20 * maxSrcHz)))
      : (needDynamicWindow && maxSrcHz >= 15 ? Math.max(5e-5, Math.min(0.005, 1 / (16 * maxSrcHz))) : 0.01);
    const totalT = useAcWindow
      ? Math.min(maxSpan, Math.max(0.04, 8 / Math.max(15, minSrcHz || maxSrcHz)))
      : (needDynamicWindow ? maxSpan : 0.06);
    const steps = Math.min(640, Math.max(useAcWindow ? 80 : (needDynamicWindow ? 60 : 6), Math.ceil(totalT / dt)));
    const stepSize = totalT / steps;
    for (let s = 0; s < steps; s++) {
      sim.step(stepSize);
      for (const bz of buzzers) {
        const ent = sim.byPart.get(bz.id);
        const v0 = ent?.pinNets?.[0] >= 0 ? sim.voltage(ent.pinNets[0]) : NaN;
        const v1 = ent?.pinNets?.[1] >= 0 ? sim.voltage(ent.pinNets[1]) : NaN;
        if (Number.isFinite(v0) && Number.isFinite(v1)) {
          buzMaxDv.set(bz.id, Math.max(buzMaxDv.get(bz.id) || 0, Math.abs(v0 - v1)));
        }
      }
      for (const sg of segs) {
        const cur = sim.byPart.get(sg.id)?.device?.cur;
        if (cur) for (const c of cur) segPeakMa = Math.max(segPeakMa, Math.abs(c) * 1000);
      }
      for (const bg of bars) {
        const cur = sim.byPart.get(bg.id)?.device?.cur;
        if (cur) for (const c of cur) barPeakMa = Math.max(barPeakMa, Math.abs(c) * 1000);
      }
    }
  }

  for (const sg of segs) {
    const ent = sim.byPart.get(sg.id);
    const notes = ent?.device?.notes;
    if (notes?.length) {
      errors.push(`7-segment "${refById?.get(sg.id) || sg.id}": ${notes[0]}`);
    } else if (!hasSwitches && segPeakMa < 0.35 && ent?.pinNets?.some(n => sim.isNetConnected(n))) {
      errors.push(`7-segment "${refById?.get(sg.id) || sg.id}" stayed unlit (peak ${segPeakMa.toFixed(1)} mA) — verify COM polarity (anode vs cathode), 7447/7448 wiring, and power.`);
    }
  }
  for (const bg of bars) {
    const ent = sim.byPart.get(bg.id);
    if (!hasSwitches && barPeakMa < 0.35 && ent?.pinNets?.some(n => sim.isNetConnected(n))) {
      errors.push(`bargraph "${refById?.get(bg.id) || bg.id}" stayed unlit (peak ${barPeakMa.toFixed(1)} mA) — verify A1..A8 anodes go to outputs and K1..K8 cathodes reach "-" through 220Ω resistors.`);
    }
  }
  if (!hasSwitches && hasDynamic) {
    for (const sc of scopes) {
      const d = sim.byPart.get(sc.id)?.device;
      if (!d) continue;
      const win = computeScopeWindow(d, Math.max(0.0001, +sc.props?.timeDiv || 0.05));
      const st1 = win ? measureChannelStats(d, d.buf1, win) : null;
      const st2 = win ? measureChannelStats(d, d.buf2, win) : null;
      const vpp = Math.max(st1?.valid ? st1.vpp : 0, st2?.valid ? st2.vpp : 0);
      if (vpp <= 0.05) {
        const tag = refById?.get(sc.id) || sc.id;
        errors.push(`Oscilloscope "${tag}" CH1/CH2 captured 0.00 Vpp on dynamic circuit — probe an oscillating signal net (e.g. U1.OUT / filter node) with "${tag}.CH1+" and ensure "${tag}.CH1 GND" connects to "-".`);
      }
    }
    for (const bz of buzzers) {
      const peakDv = buzMaxDv.get(bz.id) || 0;
      if (peakDv < 0.25) {
        const tag = refById?.get(bz.id) || bz.id;
        errors.push(`buzzer "${tag}" remained silent (peak |dV|=${peakDv.toFixed(2)} V) — verify "+" connects to active driver/timer output and "-" connects to GND.`);
      }
    }
  }
  return errors;
}

/**
 * Canonical Netlist, Bill of Materials (BOM), Pin-to-Pin Wiring Guide,
 * and Analog SPICE Netlist Serializer for CircuitForge Studio.
 * Single source of truth reusing Engine Union-Find electrical connectivity.
 */
import { Engine, key } from '../sim/engine.js';
import { getDef } from '../parts/registry.js';
import { WIRE_COLORS } from '../view/renderer.js';
import {
  isAnnotationType,
  ensureDesignators,
  formatPartValue,
  buildNetLabelMap,
} from './designators.js';

function csvCell(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function buildHoleMap(circuit, index = null) {
  if (index && index.holes) return index.holes;
  const map = new Map();
  for (const b of circuit.boards || []) {
    for (const h of b.holes()) map.set(key(h.x, h.y), h);
  }
  return map;
}

function resolveColorName(hex) {
  const h = String(hex || '').toLowerCase();
  const hit = WIRE_COLORS.find(c => c.hex.toLowerCase() === h);
  return hit ? hit.name : (hex || 'Custom');
}

function packageLabel(part, def) {
  if (!def) return part.type;
  if (def.ic) return `DIP-${def.ic.n}`;
  if (part.type === 'ne555') return 'DIP-8';
  if (def.mcu) return 'Module';
  if (part.type === 'resistor' || part.type === 'diode' || part.type === 'inductor') return 'Axial THT';
  if (part.type === 'capacitor' || part.type === 'led') return 'Radial THT';
  if (part.type === 'npn' || part.type === 'jfet') return 'TO-92';
  if (part.type === 'tactile') return '4-pin THT';
  if (def.cat === 'Instruments') return 'Benchtop';
  return 'THT';
}

function describePoint(x, y, holeMap, pinByPoint, boardNames) {
  const k = key(x, y);
  const hl = holeMap.get(k);
  const pins = pinByPoint.get(k) || [];
  let holeDesc = 'Off-board';
  if (hl) {
    const bId = hl.strip.split(':')[0];
    const bTag = boardNames.size > 1 && boardNames.get(bId) ? `${boardNames.get(bId)}:` : '';
    holeDesc = bTag + hl.label;
  }
  const pinDescs = pins.map(p => `${p.ref}.${p.name}`);
  return { holeDesc, pinDescs, text: pinDescs.length ? `${pinDescs.join(' / ')} (${holeDesc})` : holeDesc };
}

/**
 * Extract canonical circuit connectivity, BOM, wiring lists & instrumentation snapshots.
 */
export function extractCircuitData(circuit, engine = null, index = null) {
  ensureDesignators(circuit);
  let eng = engine;
  if (!eng || eng.pointNet.size === 0 && ((circuit.parts?.length || 0) > 0 || (circuit.boards?.length || 0) > 0)) {
    eng = new Engine();
    eng.build(circuit);
  }
  const holeMap = buildHoleMap(circuit, index);
  const userNetLabels = buildNetLabelMap(circuit, eng);

  const boardNames = new Map();
  (circuit.boards || []).forEach((b, i) => boardNames.set(b.id, b.label || `Board ${i + 1}`));

  const electricalParts = (circuit.parts || []).filter(p => !isAnnotationType(p.type));
  const pinByPoint = new Map();
  const netPinList = new Map();
  const netHoleSet = new Map();
  const netHasWire = new Set();

  for (const w of circuit.wires || []) {
    const na = eng.netAt(w.a.x, w.a.y), nb = eng.netAt(w.b.x, w.b.y);
    if (na >= 0) netHasWire.add(na);
    if (nb >= 0) netHasWire.add(nb);
    for (const end of [w.a, w.b]) {
      const n = eng.netAt(end.x, end.y);
      const hl = holeMap.get(key(end.x, end.y));
      if (n >= 0 && hl) {
        if (!netHoleSet.has(n)) netHoleSet.set(n, new Set());
        netHoleSet.get(n).add(hl.label);
      }
    }
  }

  for (const p of electricalParts) {
    const def = getDef(p.type, true);
    for (const q of p.worldPins()) {
      const n = eng.netAt(q.x, q.y);
      const k = key(q.x, q.y);
      const hl = holeMap.get(k);
      const entry = { part: p, ref: p.ref || p.id, pinIndex: q.i, pinNum: q.i + 1, name: q.name, x: q.x, y: q.y, net: n, hole: hl ? hl.label : null, rail: hl ? hl.rail : null };
      if (!pinByPoint.has(k)) pinByPoint.set(k, []);
      pinByPoint.get(k).push(entry);
      if (n >= 0) {
        if (!netPinList.has(n)) netPinList.set(n, []);
        netPinList.get(n).push(entry);
        if (hl) {
          if (!netHoleSet.has(n)) netHoleSet.set(n, new Set());
          netHoleSet.get(n).add(hl.label);
        }
      }
    }
  }

  // Gather active nets (participating in wiring, multi-pin strips, supplies, or user net labels)
  const activeNetIds = new Set();
  for (const [n, pins] of netPinList) {
    if (pins.length > 1 || netHasWire.has(n) || userNetLabels.has(n) || pins.some(p => p.part.type === 'vcc' || p.part.type === 'gnd' || p.rail)) {
      activeNetIds.add(n);
    }
  }
  for (const n of netHasWire) activeNetIds.add(n);
  for (const n of userNetLabels.keys()) activeNetIds.add(n);

  // Assign deterministic semantic net names
  const netInfoById = new Map();
  const usedNames = new Set();
  const claimName = (preferred) => {
    let base = preferred;
    let candidate = base, k = 2;
    while (usedNames.has(candidate.toUpperCase())) candidate = `${base}_${k++}`;
    usedNames.add(candidate.toUpperCase());
    return candidate;
  };

  // Pass 1: explicit user net labels
  for (const n of [...activeNetIds].sort((a, b) => a - b)) {
    if (userNetLabels.has(n)) {
      netInfoById.set(n, { id: n, name: claimName(userNetLabels.get(n)), userNamed: true });
    }
  }
  // Pass 2: power / ground / clock semantic names
  for (const n of [...activeNetIds].sort((a, b) => a - b)) {
    if (netInfoById.has(n)) continue;
    const pins = netPinList.get(n) || [];
    let kind = 'signal', suggested = '';
    const hasGnd = pins.some(p => p.part.type === 'gnd' || p.rail === '−' || /^(GND|VSS)$/i.test(p.name));
    const hasVcc5 = pins.some(p => p.part.type === 'vcc' || p.name === '+5V' || p.name === '5V');
    const hasVcc33 = pins.some(p => p.name === '3V3');
    const batPlus = pins.find(p => p.part.type === 'battery' && p.pinIndex === 0);
    const batMinus = pins.find(p => p.part.type === 'battery' && p.pinIndex === 1);
    const railPos = pins.some(p => p.rail === '+');

    if (hasGnd || batMinus) { kind = 'gnd'; suggested = 'GND'; }
    else if (hasVcc5) { kind = 'power'; suggested = '+5V'; }
    else if (hasVcc33) { kind = 'power'; suggested = '+3.3V'; }
    else if (batPlus) { kind = 'power'; suggested = `+${batPlus.part.props?.volts ?? 9}V`; }
    else if (railPos) { kind = 'power'; suggested = 'VCC'; }
    else if (pins.length === 1 && pins[0].part.type === 'clock') { suggested = 'CLK'; }
    else {
      const clkPin = pins.find(p => p.part.type === 'clock');
      if (clkPin && pins.length <= 4) suggested = 'CLK';
    }

    if (suggested) {
      netInfoById.set(n, { id: n, name: claimName(suggested), kind, userNamed: false });
    }
  }
  // Pass 3: deterministic N001.. for remaining signal nets
  let netSeq = 1;
  for (const n of [...activeNetIds].sort((a, b) => a - b)) {
    if (netInfoById.has(n)) continue;
    let cname = '';
    do { cname = 'N' + String(netSeq++).padStart(3, '0'); } while (usedNames.has(cname));
    usedNames.add(cname);
    netInfoById.set(n, { id: n, name: cname, kind: 'signal', userNamed: false });
  }

  const nets = [];
  for (const n of [...activeNetIds].sort((a, b) => a - b)) {
    const info = netInfoById.get(n);
    const pins = netPinList.get(n) || [];
    const holes = [...(netHoleSet.get(n) || [])];
    const v = eng.voltage(n);
    const state = Number.isNaN(v) ? 'FLOAT' : v >= 2 ? 'HIGH' : v <= 0.8 ? 'LOW' : 'MID';
    nets.push({
      id: n,
      name: info.name,
      kind: info.kind || (info.name === 'GND' ? 'gnd' : /^[+V]/.test(info.name) ? 'power' : 'signal'),
      voltage: Number.isNaN(v) ? null : +v.toFixed(3),
      state,
      pins: pins.map(p => ({ ref: p.ref, pin: p.name, num: p.pinNum, hole: p.hole })),
      holes,
    });
  }

  // Enrich part pin descriptors with resolved net name + voltage
  const parts = electricalParts.map((p) => {
    const def = getDef(p.type, true);
    const pins = p.worldPins().map((q) => {
      const n = eng.netAt(q.x, q.y);
      const hl = holeMap.get(key(q.x, q.y));
      const v = n >= 0 ? eng.voltage(n) : NaN;
      return {
        i: q.i,
        num: q.i + 1,
        name: q.name,
        x: q.x,
        y: q.y,
        hole: hl ? hl.label : null,
        net: n,
        netName: n >= 0 && netInfoById.has(n) ? netInfoById.get(n).name : '',
        voltage: Number.isNaN(v) ? null : +v.toFixed(3),
      };
    });
    return {
      id: p.id,
      ref: p.ref || p.id,
      type: p.type,
      name: def ? (def.ic ? `${def.ic.id} (${def.title || def.name})` : def.name) : p.type,
      shortName: def ? (def.short || def.name) : p.type,
      value: formatPartValue(p),
      package: packageLabel(p, def),
      x: p.x,
      y: p.y,
      rot: p.rot,
      props: { ...p.props },
      pins,
    };
  });

  // BOM aggregation
  const bomMap = new Map();
  for (const p of parts) {
    const k = `${p.type}|${p.value}|${p.package}`;
    let grp = bomMap.get(k);
    if (!grp) {
      grp = { refs: [], component: p.shortName, value: p.value, package: p.package, qty: 0 };
      bomMap.set(k, grp);
    }
    grp.refs.push(p.ref);
    grp.qty++;
  }
  const bom = [...bomMap.values()].map((g, i) => ({ item: i + 1, ...g, refs: g.refs.join(', ') }));

  // Wiring tables
  const wiringByWire = (circuit.wires || []).map((w, i) => {
    const from = describePoint(w.a.x, w.a.y, holeMap, pinByPoint, boardNames);
    const to = describePoint(w.b.x, w.b.y, holeMap, pinByPoint, boardNames);
    const n = eng.netAt(w.a.x, w.a.y);
    return {
      id: w.id,
      num: i + 1,
      label: w.label || '',
      colorHex: w.color,
      colorName: resolveColorName(w.color),
      fromDesc: from.text,
      fromHole: from.holeDesc,
      toDesc: to.text,
      toHole: to.holeDesc,
      netName: n >= 0 && netInfoById.has(n) ? netInfoById.get(n).name : '',
    };
  });

  const wiringByNet = nets.filter(n => n.pins.length > 0 || n.holes.length > 0);
  const mcuSketches = electricalParts
    .filter(p => getDef(p.type, true)?.mcu && p.props?.code)
    .map(p => ({ ref: p.ref || p.id, board: getDef(p.type).name, type: p.type, code: p.props.code }));

  const scopes = electricalParts
    .filter(p => p.type === 'oscilloscope')
    .map(p => ({ ref: p.ref || p.id, part: p, dev: eng.byPart.get(p.id)?.device || null }));

  const probes = (circuit.probes || []).map(pr => {
    const n = eng.netAt(pr.x, pr.y);
    return { ...pr, netName: n >= 0 && netInfoById.has(n) ? netInfoById.get(n).name : '' };
  });

  return {
    name: circuit.name || 'Untitled Circuit',
    meta: { ...(circuit.meta || { author: '', project: '', revision: '1.0', notes: '' }) },
    boards: (circuit.boards || []).map((b, i) => ({ id: b.id, name: b.label || `Board ${i + 1}`, size: b.size, cols: b.cols })),
    parts,
    nets,
    bom,
    wiringByWire,
    wiringByNet,
    mcuSketches,
    scopes,
    probes,
    wireCount: (circuit.wires || []).length,
    partCount: parts.length,
  };
}

export function toBomCSV(data) {
  const rows = [['Item', 'Designators', 'Component', 'Value / Spec', 'Package', 'Qty']];
  for (const r of data.bom) rows.push([r.item, r.refs, r.component, r.value, r.package, r.qty]);
  return rows.map(r => r.map(csvCell).join(',')).join('\n') + '\n';
}

export function toBomMarkdown(data) {
  const out = [
    '| Item | Designators | Component | Value / Spec | Package | Qty |',
    '|---:|---|---|---|---|---:|',
  ];
  for (const r of data.bom) {
    out.push(`| ${r.item} | ${r.refs} | ${r.component} | ${r.value} | ${r.package} | ${r.qty} |`);
  }
  return out.join('\n') + '\n';
}

export function toWiringCSV(data) {
  const rows = [['Wire #', 'Signal', 'Color', 'Net', 'From', 'To']];
  for (const w of data.wiringByWire) {
    rows.push([w.num, w.label || '', w.colorName, w.netName, w.fromDesc, w.toDesc]);
  }
  return rows.map(r => r.map(csvCell).join(',')).join('\n') + '\n';
}

export function toWiringMarkdown(data) {
  const lines = ['### Point-to-Point Wire List', ''];
  if (!data.wiringByWire.length) {
    lines.push('_No discrete jumper wires._', '');
  } else {
    lines.push('| # | Color | Signal | Net | From | To |', '|---:|---|---|---|---|---|');
    for (const w of data.wiringByWire) {
      lines.push(`| ${w.num} | ${w.colorName} | ${w.label || '—'} | \`${w.netName || '—'}\` | ${w.fromDesc} | ${w.toDesc} |`);
    }
    lines.push('');
  }
  lines.push('### Net Connectivity Table', '', '| Net | Pins Connected | Breadboard Holes |', '|---|---|---|');
  for (const n of data.wiringByNet) {
    const pins = n.pins.map(p => `${p.ref}.${p.pin}`).join(', ') || '—';
    const holes = n.holes.slice(0, 12).join(', ') + (n.holes.length > 12 ? ` (+${n.holes.length - 12})` : '') || '—';
    lines.push(`| \`${n.name}\` | ${pins} | ${holes} |`);
  }
  return lines.join('\n') + '\n';
}

export function toNetlistJSON(data) {
  return JSON.stringify({
    app: 'CircuitForge Studio',
    circuit: data.name,
    meta: data.meta,
    boards: data.boards,
    parts: data.parts.map(p => ({
      ref: p.ref, type: p.type, value: p.value, package: p.package,
      pins: p.pins.map(q => ({ num: q.num, name: q.name, hole: q.hole, net: q.netName || 'NC' })),
    })),
    nets: data.nets.map(n => ({
      name: n.name, kind: n.kind,
      nodes: n.pins.map(p => `${p.ref}.${p.pin}`),
      holes: n.holes,
    })),
    wires: data.wiringByWire,
  }, null, 2) + '\n';
}

/** Generate standard SPICE netlist for analog/passive parts (node 0 = GND). */
export function toSpiceNetlist(data) {
  const sanitize = (name) => {
    if (!name || name.toUpperCase() === 'GND') return '0';
    return name.replace(/[^A-Za-z0-9_+]/g, '_');
  };
  const nodeOf = (part, idx) => {
    const p = part.pins[idx];
    return p && p.netName ? sanitize(p.netName) : `NC_${part.ref}_${idx + 1}`;
  };

  const lines = [
    `* ${data.name} — Generated by CircuitForge Studio`,
    `* Reference GND net mapped to SPICE node 0`,
    '',
  ];
  const unmodeled = [];
  for (const p of data.parts) {
    const pr = p.props || {};
    if (p.type === 'resistor') {
      lines.push(`${p.ref} ${nodeOf(p, 0)} ${nodeOf(p, 1)} ${pr.ohms ?? 220}`);
    } else if (p.type === 'capacitor') {
      lines.push(`${p.ref} ${nodeOf(p, 0)} ${nodeOf(p, 1)} ${pr.uf ?? 10}u`);
    } else if (p.type === 'inductor') {
      lines.push(`${p.ref} ${nodeOf(p, 0)} ${nodeOf(p, 1)} ${pr.mh ?? 10}m`);
    } else if (p.type === 'diode') {
      lines.push(`D_${p.ref} ${nodeOf(p, 0)} ${nodeOf(p, 1)} D${pr.model || '1N4148'}`);
    } else if (p.type === 'led') {
      lines.push(`D_${p.ref} ${nodeOf(p, 0)} ${nodeOf(p, 1)} LED_${String(pr.color || 'red').toUpperCase()}`);
    } else if (p.type === 'npn') {
      // part pins: 0=E, 1=B, 2=C -> SPICE Qname C B E model
      lines.push(`Q_${p.ref} ${nodeOf(p, 2)} ${nodeOf(p, 1)} ${nodeOf(p, 0)} Q${pr.model || '2N3904'}`);
    } else if (p.type === 'jfet') {
      // part pins: 0=D, 1=S, 2=G -> SPICE Jname D G S model
      lines.push(`J_${p.ref} ${nodeOf(p, 0)} ${nodeOf(p, 2)} ${nodeOf(p, 1)} J${pr.model || '2N5484'}`);
    } else if (p.type === 'pot' || p.type === 'wokwi-slide-potentiometer') {
      const rTot = +(pr.ohms ?? 10000), k = Math.max(0.001, Math.min(0.999, +(pr.pos ?? 0.5)));
      lines.push(`${p.ref}A ${nodeOf(p, 0)} ${nodeOf(p, 1)} ${(rTot * k).toFixed(2)}`);
      lines.push(`${p.ref}B ${nodeOf(p, 1)} ${nodeOf(p, 2)} ${(rTot * (1 - k)).toFixed(2)}`);
    } else if (p.type === 'vcc') {
      lines.push(`V_${p.ref} ${nodeOf(p, 0)} 0 DC 5`);
    } else if (p.type === 'battery') {
      lines.push(`V_${p.ref} ${nodeOf(p, 0)} ${nodeOf(p, 1)} DC ${pr.volts ?? 9}`);
    } else if (p.type === 'clock') {
      const hz = +(pr.frequency || pr.hz || 1);
      const per = 1 / hz, pw = per * ((+(pr.duty ?? 50)) / 100);
      lines.push(`V_${p.ref} ${nodeOf(p, 0)} 0 PULSE(0 5 0 10n 10n ${pw.toExponential(3)} ${per.toExponential(3)})`);
    } else if (p.type !== 'gnd') {
      unmodeled.push(`${p.ref} (${p.shortName})`);
    }
  }
  if (unmodeled.length) {
    lines.push('', `* Digital/IC/MCU/Instrument components (export SVG Schematic for full representation):`);
    for (const u of unmodeled) lines.push(`*   ${u}`);
  }
  lines.push('.end', '');
  return lines.join('\n');
}

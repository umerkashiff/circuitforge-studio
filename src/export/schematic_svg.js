/**
 * Pure Vector SVG Schematic Generator (IEEE/ANSI + IEC/DIN 60617)
 * Produces self-contained, print-sharp SVG schematics from computeSchematicLayout(),
 * with 4 visual themes (Classic Print, Engineering Color, Dark Blueprint, Live Sim),
 * ANSI zone border, IEEE Title Block, solder dots, and wire crossing hops.
 */
import { SCH_GRID } from './symbols.js';
import { computeSchematicLayout } from './schematic_layout.js';
import { triggerDownload, safeFileBase, canvasToBlob } from './breadboard_export.js';
import { svgStringToPngBlob } from './waveform_export.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const THEMES = {
  print: {
    bg: '#ffffff', fill: '#ffffff', stroke: '#111827', wire: '#111827',
    pin: '#111827', pinNum: '#4b5563', pinText: '#111827',
    ref: '#111827', label: '#111827', sub: '#374151',
    net: '#111827', power: '#111827', gnd: '#111827', grid: 'rgba(0,0,0,0.06)',
    frame: '#111827', footBg: '#f9fafb',
  },
  color: {
    bg: '#ffffff', fill: '#ffffea', stroke: '#840000', wire: '#007000',
    pin: '#840000', pinNum: '#6b7280', pinText: '#1e293b',
    ref: '#0284c7', label: '#840000', sub: '#0369a1',
    net: '#0f4c81', power: '#b91c1c', gnd: '#1d4ed8', grid: 'rgba(15,23,42,0.055)',
    frame: '#64748b', footBg: '#f8fafc',
  },
  blueprint: {
    bg: '#0c1b2e', fill: '#122640', stroke: '#e0f2fe', wire: '#7dd3fc',
    pin: '#bae6fd', pinNum: '#93c5fd', pinText: '#f0f9ff',
    ref: '#fde047', label: '#ffffff', sub: '#7dd3fc',
    net: '#38bdf8', power: '#fda4af', gnd: '#7dd3fc', grid: 'rgba(125,211,252,0.12)',
    frame: 'rgba(125,211,252,0.55)', footBg: '#091525',
  },
  live: {
    bg: '#ffffff', fill: '#f8fafc', stroke: '#1e293b', wire: '#475569',
    pin: '#334155', pinNum: '#64748b', pinText: '#0f172a',
    ref: '#0f172a', label: '#0f172a', sub: '#475569',
    net: '#0369a1', power: '#e53935', gnd: '#0284c7', grid: 'rgba(15,23,42,0.055)',
    frame: '#64748b', footBg: '#f8fafc',
  },
};

function liveWireColor(netMeta, pal) {
  if (!netMeta || netMeta.voltage === null || netMeta.voltage === undefined) return '#94a3b8';
  if (netMeta.voltage >= 2.0) return '#e53935';
  if (netMeta.voltage <= 0.8) return '#0284c7';
  return '#f59e0b';
}

function drawPowerPortSVG(pp, pal) {
  const { x, y, side, kind, netName } = pp;
  const col = kind === 'gnd' ? (pal.gnd || pal.power) : pal.power;
  const out = [];
  if (kind === 'gnd') {
    // Anchor wire elbow so all GND earth symbols stand upright downward
    let gx = x, gy = y;
    if (side === 'B') { gy = y + 14; out.push(`<line x1="${x}" y1="${y}" x2="${x}" y2="${gy}" stroke="${col}" stroke-width="1.6"/>`); }
    else if (side === 'T') { gx = x + 12; gy = y - 8; out.push(`<polyline points="${x},${y} ${x},${y - 14} ${gx},${y - 14} ${gx},${gy}" fill="none" stroke="${col}" stroke-width="1.6"/>`); }
    else if (side === 'L') { gx = x - 12; gy = y + 10; out.push(`<polyline points="${x},${y} ${gx},${y} ${gx},${gy}" fill="none" stroke="${col}" stroke-width="1.6"/>`); }
    else { gx = x + 12; gy = y + 10; out.push(`<polyline points="${x},${y} ${gx},${y} ${gx},${gy}" fill="none" stroke="${col}" stroke-width="1.6"/>`); }
    out.push(`<line x1="${gx - 8}" y1="${gy}" x2="${gx + 8}" y2="${gy}" stroke="${col}" stroke-width="1.8"/>`);
    out.push(`<line x1="${gx - 5}" y1="${gy + 4}" x2="${gx + 5}" y2="${gy + 4}" stroke="${col}" stroke-width="1.6"/>`);
    out.push(`<line x1="${gx - 2}" y1="${gy + 8}" x2="${gx + 2}" y2="${gy + 8}" stroke="${col}" stroke-width="1.4"/>`);
    out.push(`<text x="${gx}" y="${gy + 19}" font-size="8.5" font-weight="700" text-anchor="middle" fill="${col}">${esc(netName)}</text>`);
  } else {
    let vx = x, vy = y;
    if (side === 'T') { vy = y - 14; out.push(`<line x1="${x}" y1="${y}" x2="${x}" y2="${vy}" stroke="${col}" stroke-width="1.6"/>`); }
    else if (side === 'B') { vx = x + 12; vy = y + 8; out.push(`<polyline points="${x},${y} ${x},${y + 14} ${vx},${y + 14} ${vx},${vy}" fill="none" stroke="${col}" stroke-width="1.6"/>`); }
    else if (side === 'L') { vx = x - 12; vy = y - 10; out.push(`<polyline points="${x},${y} ${vx},${y} ${vx},${vy}" fill="none" stroke="${col}" stroke-width="1.6"/>`); }
    else { vx = x + 12; vy = y - 10; out.push(`<polyline points="${x},${y} ${vx},${y} ${vx},${vy}" fill="none" stroke="${col}" stroke-width="1.6"/>`); }
    out.push(`<line x1="${vx - 7}" y1="${vy}" x2="${vx + 7}" y2="${vy}" stroke="${col}" stroke-width="2"/>`);
    out.push(`<text x="${vx}" y="${vy - 5}" font-size="9" font-weight="700" text-anchor="middle" fill="${col}">${esc(netName)}</text>`);
  }
  return out.join('\n');
}

function drawNetFlagSVG(nf, pal) {
  const { x, y, side, netName } = nf;
  const txt = String(netName || 'SIG');
  const fw = Math.max(28, txt.length * 6.5 + 14);
  const leftDir = side === 'L';
  const dir = leftDir ? -1 : 1;
  const xTip = x + dir * 8;
  const pts = [
    `${xTip},${y}`,
    `${xTip + dir * 7},${y - 8}`,
    `${xTip + dir * (7 + fw)},${y - 8}`,
    `${xTip + dir * (7 + fw)},${y + 8}`,
    `${xTip + dir * 7},${y + 8}`,
  ].join(' ');
  const tx = xTip + dir * (7 + fw / 2);
  return [
    `<line x1="${x}" y1="${y}" x2="${xTip}" y2="${y}" stroke="${pal.wire}" stroke-width="1.6"/>`,
    `<polygon points="${pts}" fill="${pal.bg}" stroke="${pal.net}" stroke-width="1.4"/>`,
    `<text x="${tx}" y="${y + 3.2}" font-size="8.5" font-weight="700" font-family="'SF Mono', ui-monospace, monospace" text-anchor="middle" fill="${pal.net}">${esc(txt)}</text>`,
  ].join('\n');
}

/**
 * Generate pure vector SVG string and full geometry layout for any circuit.
 */
export function renderSchematicSVG(circuit, engine = null, index = null, opts = {}) {
  const {
    standard = 'ieee',       // 'ieee' | 'iec'
    viewMode = 'functional', // 'functional' | 'package'
    theme = 'color',         // 'print' | 'color' | 'blueprint' | 'live'
    powerStyle = 'symbols',  // 'symbols' | 'rails'
    hideUnwired = true,
    showPinNumbers = true,
    showNetLabels = true,
    showValues = true,
    showGrid = false,
    showFrame = true,
    showTitleBlock = true,
    crossingHops = true,
    useNetFlags = true,
  } = opts;

  const pal = THEMES[theme] || THEMES.color;
  const layout = computeSchematicLayout(circuit, engine, index, {
    viewMode, powerStyle, hideUnwired, showValues, useNetFlags, crossingHops,
  });
  const netMetaMap = new Map(layout.data.nets.map(n => [n.id, n]));

  const noteLines = [...layout.unusedNotes];
  const prunedSyms = layout.symbols.filter(s => s.prunedCount > 0);
  if (prunedSyms.length) {
    noteLines.push(`Note: Unwired pins hidden on ${prunedSyms.map(s => s.ref).join(', ')} (toggle in options)`);
  }
  const notesH = noteLines.length ? noteLines.length * 14 + 12 : 0;

  const pad = 44;
  const cb = layout.bounds;
  const minW = showTitleBlock ? 680 : 360;
  const minH = 340;
  const innerW = Math.max(minW, Math.ceil(cb.w + pad * 2));
  const diagramH = Math.max(minH, Math.ceil(cb.h + pad * 2));
  const innerH = diagramH + notesH;
  const framePad = showFrame ? 18 : 0;
  const footH = showTitleBlock ? 64 : 0;
  const totalW = innerW + framePad * 2;
  const totalH = innerH + framePad * 2 + footH;

  // Center schematic graph strictly above dedicated notes strip
  const offX = framePad + (innerW - cb.w) / 2 - cb.x0;
  const offY = framePad + (diagramH - cb.h) / 2 - cb.y0;

  // Group crossing hop coordinates per horizontal net
  const hopsByNetY = new Map();
  for (const cr of layout.crossings) {
    const k = `${cr.hNetId}|${cr.y}`;
    if (!hopsByNetY.has(k)) hopsByNetY.set(k, []);
    hopsByNetY.get(k).push(cr.x);
  }

  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalW} ${totalH}" width="${totalW}" height="${totalH}" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Text', Inter, sans-serif">`,
    `  <style>text{stroke:none;}</style>`,
    `  <rect width="${totalW}" height="${totalH}" fill="${pal.bg}"/>`,
  ];

  // Optional 20px schematic lattice grid
  if (showGrid) {
    out.push(`  <defs><pattern id="sch-grid" width="${SCH_GRID}" height="${SCH_GRID}" patternUnits="userSpaceOnUse"><path d="M ${SCH_GRID} 0 L 0 0 0 ${SCH_GRID}" fill="none" stroke="${pal.grid}" stroke-width="1"/></pattern></defs>`);
    out.push(`  <rect x="${framePad}" y="${framePad}" width="${innerW}" height="${innerH}" fill="url(#sch-grid)"/>`);
  }

  // Main schematic graph group translated cleanly
  out.push(`  <g class="sch-world" transform="translate(${offX.toFixed(1)}, ${offY.toFixed(1)})">`);

  // Collision obstacles for net / voltage labels
  const obsRects = [
    ...layout.symbols.map(s => ({ x0: s.x - 6, y0: s.y - 18, x1: s.x + s.w + 6, y1: s.y + s.h + 14 })),
    ...layout.powerPorts.map(pp => ({ x0: pp.x - 24, y0: pp.y - 34, x1: pp.x + 24, y1: pp.y + 36 })),
    ...layout.netFlags.map(nf => ({ x0: nf.x - 45, y0: nf.y - 14, x1: nf.x + 45, y1: nf.y + 14 })),
  ];
  const allWireSegs = layout.segmentsByNet.flatMap(sn => sn.segs.map(s => ({ ...s, netId: sn.netId })));
  const hitArea = (a, b) => {
    const x0 = Math.max(a.x0, b.x0), y0 = Math.max(a.y0, b.y0), x1 = Math.min(a.x1, b.x1), y1 = Math.min(a.y1, b.y1);
    return x1 > x0 && y1 > y0 ? (x1 - x0) * (y1 - y0) : 0;
  };
  const placeNetBadge = (segs, netId, lblTxt) => {
    const bw = Math.max(24, lblTxt.length * 5.6 + 8), bh = 13;
    const sorted = [...segs].sort((a, b) => Math.hypot(b.x2 - b.x1, b.y2 - b.y1) - Math.hypot(a.x2 - a.x1, a.y2 - a.y1));
    const cands = [];
    for (let si = 0; si < Math.min(4, sorted.length); si++) {
      const s = sorted[si];
      const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
      if (len < 16) continue;
      for (const t of [0.5, 0.34, 0.66, 0.2, 0.8]) {
        const px = s.x1 + (s.x2 - s.x1) * t;
        const py = s.y1 + (s.y2 - s.y1) * t;
        const tPen = si * 12 + Math.abs(t - 0.5) * 8;
        if (s.horiz) {
          cands.push({ x: px, y: py - 7, ty: py - 10, anchor: 'middle', bias: tPen });
          cands.push({ x: px, y: py + 11, ty: py + 8, anchor: 'middle', bias: tPen + 2 });
        } else {
          cands.push({ x: px + 6, y: py + 3, ty: py, anchor: 'start', bias: tPen + 3 });
          cands.push({ x: px - 6, y: py + 3, ty: py, anchor: 'end', bias: tPen + 3.5 });
        }
      }
    }
    if (!cands.length && sorted[0]) {
      const s = sorted[0];
      cands.push({ x: (s.x1 + s.x2) / 2, y: (s.y1 + s.y2) / 2 - 7, ty: (s.y1 + s.y2) / 2 - 10, anchor: 'middle', bias: 0 });
    }
    let best = cands[0], bestScore = Infinity;
    for (const c of cands) {
      const rx0 = c.anchor === 'start' ? c.x - 2 : c.anchor === 'end' ? c.x - bw + 2 : c.x - bw / 2;
      const rect = { x0: rx0, y0: c.ty - bh / 2, x1: rx0 + bw, y1: c.ty + bh / 2 };
      let score = c.bias;
      for (const o of obsRects) { const ov = hitArea(rect, o); if (ov > 0) score += 2000 + ov * 25; }
      for (const ws of allWireSegs) {
        if (ws.netId === netId) continue;
        const wr = { x0: Math.min(ws.x1, ws.x2) - 2, y0: Math.min(ws.y1, ws.y2) - 2, x1: Math.max(ws.x1, ws.x2) + 2, y1: Math.max(ws.y1, ws.y2) + 2 };
        const ov = hitArea(rect, wr);
        if (ov > 0) score += 450 + ov * 8;
      }
      if (score < bestScore) { bestScore = score; best = { ...c, rect }; }
    }
    if (best) obsRects.push(best.rect);
    return best;
  };

  // 1. Wires with optional live voltages & crossing hops
  out.push('    <g class="sch-wires">');
  for (const segNet of layout.segmentsByNet) {
    const nm = netMetaMap.get(segNet.netId);
    const isGndSeg = segNet.kind === 'gnd';
    const isPwrSeg = segNet.kind === 'power';
    const strokeCol = theme === 'live'
      ? liveWireColor(nm, pal)
      : isGndSeg ? (pal.gnd || pal.wire) : isPwrSeg ? (pal.power || pal.wire) : pal.wire;
    const isFloat = theme === 'live' && (nm?.voltage === null || nm?.voltage === undefined);
    const dash = isFloat ? ' stroke-dasharray="4,3"' : '';
    for (const s of segNet.segs) {
      if (s.horiz) {
        const lx0 = Math.min(s.x1, s.x2), lx1 = Math.max(s.x1, s.x2);
        const xs = (hopsByNetY.get(`${segNet.netId}|${s.y1}`) || [])
          .filter(cx => cx > lx0 + 5 && cx < lx1 - 5)
          .sort((a, b) => a - b);
        if (!xs.length) {
          out.push(`      <line x1="${s.x1}" y1="${s.y1}" x2="${s.x2}" y2="${s.y2}" stroke="${strokeCol}" stroke-width="1.8" stroke-linecap="round"${dash}/>`);
        } else {
          let d = `M ${lx0} ${s.y1}`;
          for (const cx of xs) {
            d += ` L ${cx - 5} ${s.y1} A 5 5 0 0 1 ${cx + 5} ${s.y1}`;
          }
          d += ` L ${lx1} ${s.y1}`;
          out.push(`      <path d="${d}" fill="none" stroke="${strokeCol}" stroke-width="1.8" stroke-linecap="round"${dash}/>`);
        }
      } else {
        out.push(`      <line x1="${s.x1}" y1="${s.y1}" x2="${s.x2}" y2="${s.y2}" stroke="${strokeCol}" stroke-width="1.8" stroke-linecap="round"${dash}/>`);
      }
    }

    // Net / Voltage label placed through collision filter (skip redundant power trunk labels)
    const skipPowerTxt = segNet.kind === 'power' || segNet.kind === 'gnd';
    const userShow = !skipPowerTxt && showNetLabels && nm && (nm.userNamed || /^(CLK|SDA|SCL)/i.test(nm.name));
    const liveShow = !skipPowerTxt && theme === 'live' && nm && nm.voltage !== null && nm.voltage !== undefined;
    if ((userShow || liveShow) && segNet.segs.length) {
      const lblTxt = userShow && liveShow ? `${nm.name} (${nm.voltage.toFixed(1)}V)` : userShow ? nm.name : `${nm.voltage.toFixed(2)}V`;
      const pos = placeNetBadge(segNet.segs, segNet.netId, lblTxt);
      if (pos) {
        const r = pos.rect;
        out.push(`      <rect x="${r.x0.toFixed(1)}" y="${r.y0.toFixed(1)}" width="${(r.x1 - r.x0).toFixed(1)}" height="${(r.y1 - r.y0).toFixed(1)}" rx="2.5" fill="${pal.bg}" fill-opacity="0.9"/>`);
        out.push(`      <text x="${pos.x.toFixed(1)}" y="${pos.y.toFixed(1)}" font-size="8.5" font-weight="700" font-family="'SF Mono', ui-monospace, monospace" text-anchor="${pos.anchor}" fill="${theme === 'live' ? strokeCol : pal.net}">${esc(lblTxt)}</text>`);
      }
    }
  }
  out.push('    </g>');

  // 2. Solder junction dots
  out.push('    <g class="sch-junctions">');
  for (const j of layout.junctions) {
    const nm = netMetaMap.get(j.netId);
    const col = theme === 'live' ? liveWireColor(nm, pal) : j.kind === 'gnd' ? (pal.gnd || pal.wire) : j.kind === 'power' ? (pal.power || pal.wire) : pal.wire;
    out.push(`      <circle cx="${j.x}" cy="${j.y}" r="3.4" fill="${col}"/>`);
  }
  out.push('    </g>');

  // 3. Power ports & high-fanout Net Flags
  out.push('    <g class="sch-ports">');
  for (const pp of layout.powerPorts) out.push('      ' + drawPowerPortSVG(pp, pal));
  for (const nf of layout.netFlags) out.push('      ' + drawNetFlagSVG(nf, pal));
  out.push('    </g>');

  // 4. Component symbols (carrying data attributes for live drag-to-nudge in Export Studio)
  out.push('    <g class="sch-symbols">');
  for (const s of layout.symbols) {
    out.push(`      <g class="sch-symbol" data-sch-id="${esc(s.schId)}" data-part-id="${esc(s.partId)}" data-unit="${esc(s.unit || '')}" data-sx="${s.x}" data-sy="${s.y}" transform="translate(${s.x}, ${s.y})">`);
    out.push(`        <rect x="-4" y="-8" width="${s.w + 8}" height="${s.h + 16}" fill="transparent" class="sch-hit"/>`);
    out.push(s.renderSVG(standard, pal, showPinNumbers).split('\n').map(l => '        ' + l).join('\n'));
    out.push('      </g>');
  }
  out.push('    </g>');
  out.push('  </g>');

  // 5. Dedicated sheet footer notes band (never overlaps schematic symbols/rails)
  if (noteLines.length) {
    const nyBase = framePad + diagramH + 6;
    noteLines.forEach((ln, idx) => {
      out.push(`  <text x="${framePad + 12}" y="${nyBase + idx * 14}" font-size="9.5" fill="${pal.sub}">${esc(ln)}</text>`);
    });
  }

  // 6. Optional IEEE / ISO engineering border + zone grid + Title Block
  if (showFrame) {
    const fh = innerH + footH;
    out.push(`  <rect x="${framePad}" y="${framePad}" width="${innerW}" height="${fh}" fill="none" stroke="${pal.frame}" stroke-width="1.3"/>`);
    const zoneCols = ['1', '2', '3', '4', '5', '6'];
    zoneCols.forEach((lbl, i) => {
      const zx = framePad + ((i + 0.5) / zoneCols.length) * innerW;
      out.push(`  <text x="${zx.toFixed(1)}" y="${framePad - 5}" font-size="8.5" font-weight="700" text-anchor="middle" fill="${pal.sub}">${lbl}</text>`);
      if (i > 0) {
        const bx = framePad + (i / zoneCols.length) * innerW;
        out.push(`  <line x1="${bx.toFixed(1)}" y1="${framePad - 4}" x2="${bx.toFixed(1)}" y2="${framePad}" stroke="${pal.frame}" stroke-width="1"/>`);
      }
    });
    const zoneRows = ['A', 'B', 'C', 'D'];
    zoneRows.forEach((lbl, i) => {
      const zy = framePad + ((i + 0.5) / zoneRows.length) * innerH;
      out.push(`  <text x="${framePad - 8}" y="${(zy + 3).toFixed(1)}" font-size="8.5" font-weight="700" text-anchor="middle" fill="${pal.sub}">${lbl}</text>`);
      if (i > 0) {
        const by = framePad + (i / zoneRows.length) * innerH;
        out.push(`  <line x1="${framePad - 4}" y1="${by.toFixed(1)}" x2="${framePad}" y2="${by.toFixed(1)}" stroke="${pal.frame}" stroke-width="1"/>`);
      }
    });
  }

  if (showTitleBlock) {
    const fy = framePad + innerH;
    const tbW = Math.min(360, innerW);
    const tx = framePad + innerW - tbW;
    const meta = layout.data.meta || {};
    const dateStr = new Date().toISOString().slice(0, 10);
    const stdLbl = `${standard.toUpperCase()} · ${viewMode === 'package' ? 'DIP Package' : 'Functional'}`;
    out.push(`  <rect x="${framePad}" y="${fy}" width="${innerW}" height="${footH}" fill="${pal.footBg}"/>`);
    out.push(`  <line x1="${framePad}" y1="${fy}" x2="${framePad + innerW}" y2="${fy}" stroke="${pal.frame}" stroke-width="1"/>`);
    out.push(`  <line x1="${tx}" y1="${fy}" x2="${tx}" y2="${fy + footH}" stroke="${pal.frame}" stroke-width="1"/>`);
    out.push(`  <line x1="${tx}" y1="${fy + 30}" x2="${framePad + innerW}" y2="${fy + 30}" stroke="${pal.frame}" stroke-width="1"/>`);
    out.push(`  <line x1="${framePad + innerW - 115}" y1="${fy + 30}" x2="${framePad + innerW - 115}" y2="${fy + footH}" stroke="${pal.frame}" stroke-width="1"/>`);

    if (theme === 'live') {
      const keyCols = [['#e53935', 'HIGH'], ['#0284c7', 'LOW'], ['#f59e0b', 'MID'], ['#94a3b8', 'FLOAT']];
      let kx = framePad + 14;
      out.push(`  <text x="${kx}" y="${fy + 20}" font-size="9" font-weight="700" fill="${pal.sub}">LIVE NODE VOLTAGES</text>`);
      for (const [c, t] of keyCols) {
        out.push(`  <rect x="${kx}" y="${fy + 35}" width="12" height="4" rx="2" fill="${c}"/>`);
        out.push(`  <text x="${kx + 16}" y="${fy + 40}" font-size="9.5" font-weight="600" fill="${pal.stroke}">${t}</text>`);
        kx += 26 + t.length * 6;
      }
    } else {
      out.push(`  <text x="${framePad + 14}" y="${fy + 24}" font-size="9.5" font-weight="700" fill="${pal.sub}">SCHEMATIC · ${esc(stdLbl)}</text>`);
      out.push(`  <text x="${framePad + 14}" y="${fy + 44}" font-size="9.5" fill="${pal.sub}">${layout.data.partCount} parts · ${layout.data.nets.length} nets · Sheet 1/1</text>`);
    }

    const sub = [meta.project, meta.author ? `By ${meta.author}` : ''].filter(Boolean).join(' · ') || 'CircuitForge Studio';
    const rawName = String(layout.data.name || 'Untitled Circuit');
    const dispName = rawName.length > 38 ? rawName.slice(0, 36) + '…' : rawName;
    const dispSub = sub.length > 36 ? sub.slice(0, 34) + '…' : sub;
    out.push(`  <text x="${tx + 12}" y="${fy + 20}" font-size="12.5" font-weight="700" fill="${pal.stroke}">${esc(dispName)}</text>`);
    out.push(`  <text x="${tx + 12}" y="${fy + 48}" font-size="10" fill="${pal.sub}">${esc(dispSub)}</text>`);
    out.push(`  <text x="${framePad + innerW - 105}" y="${fy + 44}" font-size="9" font-family="'SF Mono', ui-monospace, monospace" fill="${pal.sub}">Rev ${esc(meta.revision || '1.0')}</text>`);
    out.push(`  <text x="${framePad + innerW - 105}" y="${fy + 56}" font-size="9" font-family="'SF Mono', ui-monospace, monospace" fill="${pal.sub}">${dateStr}</text>`);
  }

  out.push('</svg>');
  return { svg: out.join('\n'), width: totalW, height: totalH, offX, offY, layout, data: layout.data };
}

export function exportSchematicSVG(app, opts = {}) {
  const { svg } = renderSchematicSVG(app.circuit, app.engine, app.index, opts);
  triggerDownload(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }), `${safeFileBase(app.circuit.name)}-schematic.svg`);
  return svg;
}

export async function exportSchematicPNG(app, opts = {}) {
  const { svg } = renderSchematicSVG(app.circuit, app.engine, app.index, opts);
  const blob = await svgStringToPngBlob(svg, opts.scale || 3);
  triggerDownload(blob, `${safeFileBase(app.circuit.name)}-schematic.png`);
  return blob;
}

export async function copySchematicPNG(app, opts = {}) {
  const { svg } = renderSchematicSVG(app.circuit, app.engine, app.index, opts);
  const blob = await svgStringToPngBlob(svg, opts.scale || 2);
  if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
    throw new Error('Clipboard image copy is not supported in this browser.');
  }
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

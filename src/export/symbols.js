/**
 * Dual-Standard Vector SVG Schematic Symbol Library (IEEE/ANSI + IEC/DIN 60617).
 * Every pin coordinate sits strictly on multiples of GRID = 20 px for clean Manhattan routing.
 */
import { IC_LIST, IC_SCHEMATIC } from '../parts/ics.js';
import { getDef } from '../parts/registry.js';
import { formatPartValue } from './designators.js';

export const SCH_GRID = 20;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function isPowerPinName(name) {
  return /^(VCC|VDD|V\+|5V|\+5V|3V3|VIN|VBUS|AVCC|IOREF|GND|VSS|AGND|DGND|−|SLAVE −|MASTER −|5V FIXED −|SLAVE GND|MASTER GND|COMP GND|TRIG GND|CH1 GND|CH2 GND|SYNC GND|OUT−|SLAVE \+|MASTER \+|5V FIXED \+)$/i.test(String(name || '').trim());
}

function isPosSupplyPinName(name) {
  return /^(VCC|VDD|V\+|5V|\+5V|3V3|VIN|VBUS|AVCC|IOREF|SLAVE \+|MASTER \+|5V FIXED \+)$/i.test(String(name || '').trim());
}

function isGndPinName(name) {
  return /^(GND|VSS|AGND|DGND|−|SLAVE −|MASTER −|5V FIXED −|SLAVE GND|MASTER GND|COMP GND|TRIG GND|CH1 GND|CH2 GND|SYNC GND|OUT−)$/i.test(String(name || '').trim());
}

function collapseLinkedPins(partPins) {
  const byGroup = new Map();
  partPins.forEach((p, idx) => {
    const src = { ...p, partPinIndex: idx, isPower: isPowerPinName(p.name) };
    const gk = p.linkGroup ?? idx;
    if (!byGroup.has(gk)) byGroup.set(gk, []);
    byGroup.get(gk).push(src);
  });
  const out = [];
  for (const grp of byGroup.values()) {
    grp.sort((a, b) => (b.wired ? 1 : 0) - (a.wired ? 1 : 0) || a.name.length - b.name.length || a.partPinIndex - b.partPinIndex);
    const chosen = { ...grp[0] };
    if (grp.length > 1 && grp.every(g => /GND$/i.test(String(g.name || '').trim()))) {
      chosen.name = 'GND';
      chosen.hideNum = true;
    } else if (grp.length > 1 && grp.every(g => g.name === chosen.name)) {
      chosen.hideNum = true;
    }
    out.push(chosen);
  }
  return out;
}

function pinSideMeta(partEntry, opts, icPins, leftIdx, rightIdx, topIdx = [], botIdx = [], boxTitle = '') {
  const wBoxPins = Math.max(leftIdx.length, rightIdx.length);
  const wHorizPins = Math.max(topIdx.length, botIdx.length);
  const stepY = 20;
  const stepX = 40;
  const padTop = topIdx.length ? 40 : 20;
  const padBot = botIdx.length ? 40 : 20;
  const h = Math.max((topIdx.length || botIdx.length) ? 100 : 60, padTop + Math.max(0, wBoxPins - 1) * stepY + padBot);
  const lLen = Math.max(0, ...leftIdx.map(i => (icPins[i]?.name || '').length));
  const rLen = Math.max(0, ...rightIdx.map(i => (icPins[i]?.name || '').length));
  const titleW = boxTitle ? String(boxTitle).length * 6.2 + 24 : 56;
  const topStartX = Math.max(60, Math.ceil((28 + lLen * 6.5) / 20) * 20);
  const minWForPins = Math.max(100, wHorizPins ? topStartX + (wHorizPins - 1) * stepX + 44 + rLen * 6.5 : 100);
  const sideReq = (leftIdx.length && rightIdx.length)
    ? (lLen + rLen) * 6.5 + 48 + titleW
    : Math.max(6, lLen, rLen) * 6.5 + 44 + titleW * 0.7;
  const w = Math.ceil(Math.max(minWForPins, sideReq) / 20) * 20;

  const pins = [];
  leftIdx.forEach((pi, k) => {
    const src = icPins[pi]; if (!src) return;
    pins.push({ partPinIndex: pi, num: src.num, name: src.name, lx: 0, ly: padTop + k * stepY, side: 'L', stub: 20, clock: src.clock, inverted: src.inverted, net: src.net, netName: src.netName, voltage: src.voltage, isPower: isPowerPinName(src.name) });
  });
  rightIdx.forEach((pi, k) => {
    const src = icPins[pi]; if (!src) return;
    pins.push({ partPinIndex: pi, num: src.num, name: src.name, lx: w, ly: padTop + k * stepY, side: 'R', stub: 20, clock: src.clock, inverted: src.inverted, net: src.net, netName: src.netName, voltage: src.voltage, isPower: isPowerPinName(src.name) });
  });
  topIdx.forEach((pi, k) => {
    const src = icPins[pi]; if (!src) return;
    pins.push({ partPinIndex: pi, num: src.num, name: src.name, lx: topStartX + k * stepX, ly: 0, side: 'T', stub: 20, clock: src.clock, inverted: src.inverted, net: src.net, netName: src.netName, voltage: src.voltage, isPower: isPowerPinName(src.name) });
  });
  botIdx.forEach((pi, k) => {
    const src = icPins[pi]; if (!src) return;
    pins.push({ partPinIndex: pi, num: src.num, name: src.name, lx: topStartX + k * stepX, ly: h, side: 'B', stub: 20, clock: src.clock, inverted: src.inverted, net: src.net, netName: src.netName, voltage: src.voltage, isPower: isPowerPinName(src.name) });
  });
  return { w, h, pins };
}

function drawGenericBox(sym, pal, std, showPinNumbers, title, notch = false) {
  const x0 = sym.pins.some(p => p.side === 'L') ? 16 : 4;
  const x1 = sym.pins.some(p => p.side === 'R') ? sym.w - 16 : sym.w - 4;
  const y0 = sym.pins.some(p => p.side === 'T') ? 16 : 4;
  const y1 = sym.pins.some(p => p.side === 'B') ? sym.h - 16 : sym.h - 4;
  const out = [
    `<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" rx="3" fill="${pal.fill}" stroke="${pal.stroke}" stroke-width="1.8"/>`,
  ];
  if (notch) {
    const mx = (x0 + x1) / 2;
    out.push(`<path d="M ${mx - 7} ${y0} A 7 7 0 0 0 ${mx + 7} ${y0}" fill="none" stroke="${pal.stroke}" stroke-width="1.3"/>`);
  }
  const lNameMax = Math.max(0, ...sym.pins.filter(p => p.side === 'L').map(p => String(p.name || '').length));
  const rNameMax = Math.max(0, ...sym.pins.filter(p => p.side === 'R').map(p => String(p.name || '').length));
  const titleX = (x0 + (lNameMax ? lNameMax * 5.6 + 8 : 0) + x1 - (rNameMax ? rNameMax * 5.6 + 8 : 0)) / 2;
  out.push(`<text x="${titleX.toFixed(1)}" y="${(y0 + y1) / 2 + 3.5}" font-size="10" font-weight="700" text-anchor="middle" fill="${pal.label}">${esc(title)}</text>`);
  out.push(`<text x="${x0}" y="${y0 - 5}" font-size="10.5" font-weight="700" fill="${pal.ref}">${esc(sym.ref)}</text>`);
  if (sym.showValue && sym.value && sym.value !== title) {
    out.push(`<text x="${x1}" y="${y0 - 5}" font-size="9.5" text-anchor="end" fill="${pal.sub}">${esc(sym.value)}</text>`);
  }
  for (const p of sym.pins) {
    const ix = p.side === 'L' ? x0 : p.side === 'R' ? x1 : p.lx;
    const iy = p.side === 'T' ? y0 : p.side === 'B' ? y1 : p.ly;
    const bx = p.inverted && (p.side === 'L' || p.side === 'R') ? ix + (p.side === 'L' ? -3.5 : 3.5) : ix;
    out.push(`<line x1="${p.lx}" y1="${p.ly}" x2="${bx}" y2="${iy}" stroke="${pal.pin}" stroke-width="1.6"/>`);
    if (p.inverted && (p.side === 'L' || p.side === 'R')) {
      out.push(`<circle cx="${bx}" cy="${iy}" r="3.5" fill="${pal.bg}" stroke="${pal.stroke}" stroke-width="1.4"/>`);
    }
    if (p.clock && p.side === 'L') {
      out.push(`<polyline points="${x0},${iy - 4} ${x0 + 6},${iy} ${x0},${iy + 4}" fill="none" stroke="${pal.stroke}" stroke-width="1.2"/>`);
    }
    if (showPinNumbers && !p.hideNum) {
      if (p.side === 'L') out.push(`<text x="${x0 - 4}" y="${iy - 4}" font-size="8.5" text-anchor="end" font-family="'SF Mono', ui-monospace, monospace" fill="${pal.pinNum}">${p.num}</text>`);
      else if (p.side === 'R') out.push(`<text x="${x1 + 4}" y="${iy - 4}" font-size="8.5" text-anchor="start" font-family="'SF Mono', ui-monospace, monospace" fill="${pal.pinNum}">${p.num}</text>`);
      else if (p.side === 'T') out.push(`<text x="${ix + 4}" y="${y0 - 4}" font-size="8.5" font-family="'SF Mono', ui-monospace, monospace" fill="${pal.pinNum}">${p.num}</text>`);
      else out.push(`<text x="${ix + 4}" y="${y1 + 10}" font-size="8.5" font-family="'SF Mono', ui-monospace, monospace" fill="${pal.pinNum}">${p.num}</text>`);
    }
    const nm = String(p.name || '');
    if (p.side === 'L') out.push(`<text x="${x0 + (p.clock ? 9 : 5)}" y="${iy + 3.2}" font-size="8.5" font-weight="600" fill="${pal.pinText}">${esc(nm)}</text>`);
    else if (p.side === 'R') out.push(`<text x="${x1 - 5}" y="${iy + 3.2}" font-size="8.5" font-weight="600" text-anchor="end" fill="${pal.pinText}">${esc(nm)}</text>`);
    else if (p.side === 'T') out.push(`<text x="${ix}" y="${y0 + 11}" font-size="8" font-weight="600" text-anchor="middle" fill="${pal.pinText}">${esc(nm)}</text>`);
    else out.push(`<text x="${ix}" y="${y1 - 5}" font-size="8" font-weight="600" text-anchor="middle" fill="${pal.pinText}">${esc(nm)}</text>`);
  }
  return out.join('\n');
}

function drawGateSymbol(sym, pal, std, showPinNumbers, kind, schmitt = false, oc = false, activeLowEn = false) {
  const ins = sym.pins.filter(p => p.role === 'in');
  const outP = sym.pins.find(p => p.role === 'out');
  const enP = sym.pins.find(p => p.role === 'en');
  const invOut = kind === 'nand' || kind === 'nor' || kind === 'xnor' || kind === 'not';
  const gx0 = 22, gx1 = 74, gy0 = 8, gy1 = sym.h - 8;
  const cy = outP.ly;
  const parts = [];

  if (std === 'iec') {
    parts.push(`<rect x="${gx0}" y="${gy0}" width="${gx1 - gx0}" height="${gy1 - gy0}" fill="${pal.fill}" stroke="${pal.stroke}" stroke-width="1.8"/>`);
    const qGlyph = kind === 'and' || kind === 'nand' ? '&amp;' : kind === 'or' || kind === 'nor' ? '≥1' : kind === 'xor' || kind === 'xnor' ? '=1' : kind === 'buf' ? '1' : '1';
    parts.push(`<text x="${(gx0 + gx1) / 2}" y="${cy + 4}" font-size="13" font-weight="700" text-anchor="middle" fill="${pal.stroke}">${qGlyph}</text>`);
  } else {
    if (kind === 'not' || kind === 'buf') {
      parts.push(`<polygon points="${gx0},${gy0 + 2} ${gx0},${gy1 - 2} ${gx1},${cy}" fill="${pal.fill}" stroke="${pal.stroke}" stroke-width="1.8" stroke-linejoin="round"/>`);
    } else if (kind === 'and' || kind === 'nand') {
      const midX = gx0 + 28, r = (gy1 - gy0) / 2;
      parts.push(`<path d="M ${gx0} ${gy0} L ${midX} ${gy0} A ${r} ${r} 0 0 1 ${midX} ${gy1} L ${gx0} ${gy1} Z" fill="${pal.fill}" stroke="${pal.stroke}" stroke-width="1.8" stroke-linejoin="round"/>`);
    } else {
      const hSpan = gy1 - gy0;
      const bodyX0 = (kind === 'xor' || kind === 'xnor') ? gx0 + 6 : gx0;
      parts.push(`<path d="M ${bodyX0} ${gy0} Q ${bodyX0 + 16} ${gy0} ${gx1} ${cy} Q ${bodyX0 + 16} ${gy1} ${bodyX0} ${gy1} Q ${bodyX0 + 12} ${cy} ${bodyX0} ${gy0} Z" fill="${pal.fill}" stroke="${pal.stroke}" stroke-width="1.8" stroke-linejoin="round"/>`);
      if (kind === 'xor' || kind === 'xnor') {
        parts.push(`<path d="M ${gx0} ${gy0 + 2} Q ${gx0 + 12} ${cy} ${gx0} ${gy1 - 2}" fill="none" stroke="${pal.stroke}" stroke-width="1.8" stroke-linecap="round"/>`);
      }
      void hSpan;
    }
  }

  if (schmitt) {
    const sx = gx0 + 11, sy = cy;
    parts.push(`<path d="M ${sx - 5} ${sy + 4} L ${sx} ${sy + 4} L ${sx + 2} ${sy - 4} L ${sx + 7} ${sy - 4} M ${sx - 1} ${sy + 4} L ${sx + 3} ${sy + 4} L ${sx + 5} ${sy - 4}" fill="none" stroke="${pal.stroke}" stroke-width="1.2"/>`);
  }
  if (oc) {
    const ox = gx1 - 12, oy = cy;
    parts.push(`<polygon points="${ox},${oy - 4} ${ox + 4},${oy} ${ox},${oy + 4} ${ox - 4},${oy}" fill="none" stroke="${pal.stroke}" stroke-width="1.1"/>`);
    parts.push(`<line x1="${ox - 4}" y1="${oy + 5}" x2="${ox + 4}" y2="${oy + 5}" stroke="${pal.stroke}" stroke-width="1.1"/>`);
  }

  for (const inp of ins) {
    const reachX = (kind === 'or' || kind === 'nor' || kind === 'xor' || kind === 'xnor') && std === 'ieee' ? gx0 + 8 : gx0;
    parts.push(`<line x1="${inp.lx}" y1="${inp.ly}" x2="${reachX}" y2="${inp.ly}" stroke="${pal.pin}" stroke-width="1.6"/>`);
    if (showPinNumbers) parts.push(`<text x="${gx0 - 5}" y="${inp.ly - 4}" font-size="8.5" text-anchor="end" font-family="'SF Mono', ui-monospace, monospace" fill="${pal.pinNum}">${inp.num}</text>`);
  }

  const outStart = invOut ? gx1 + 8 : gx1;
  if (invOut) {
    parts.push(`<circle cx="${gx1 + 4}" cy="${cy}" r="4" fill="${pal.bg}" stroke="${pal.stroke}" stroke-width="1.6"/>`);
  }
  parts.push(`<line x1="${outStart}" y1="${cy}" x2="${outP.lx}" y2="${cy}" stroke="${pal.pin}" stroke-width="1.6"/>`);
  if (showPinNumbers) parts.push(`<text x="${outStart + 5}" y="${cy - 4}" font-size="8.5" font-family="'SF Mono', ui-monospace, monospace" fill="${pal.pinNum}">${outP.num}</text>`);

  if (enP) {
    const eyTop = gy0 + 4;
    if (activeLowEn) {
      parts.push(`<circle cx="${enP.lx}" cy="${eyTop - 1}" r="3.5" fill="${pal.bg}" stroke="${pal.stroke}" stroke-width="1.4"/>`);
      parts.push(`<line x1="${enP.lx}" y1="${enP.ly}" x2="${enP.lx}" y2="${eyTop - 4.5}" stroke="${pal.pin}" stroke-width="1.6"/>`);
    } else {
      parts.push(`<line x1="${enP.lx}" y1="${enP.ly}" x2="${enP.lx}" y2="${eyTop + 4}" stroke="${pal.pin}" stroke-width="1.6"/>`);
    }
    if (showPinNumbers) parts.push(`<text x="${enP.lx + 5}" y="${enP.ly + 11}" font-size="8.5" font-family="'SF Mono', ui-monospace, monospace" fill="${pal.pinNum}">${enP.num}</text>`);
  }

  if (enP) {
    parts.push(`<text x="${gx1 - 2}" y="${gy0 - 5}" font-size="10.5" font-weight="700" text-anchor="end" fill="${pal.ref}">${esc(sym.ref)}</text>`);
  } else {
    parts.push(`<text x="${(gx0 + gx1) / 2}" y="${gy0 - 5}" font-size="10.5" font-weight="700" text-anchor="middle" fill="${pal.ref}">${esc(sym.ref)}</text>`);
  }
  if (sym.showValue && sym.value) {
    parts.push(`<text x="${(gx0 + gx1) / 2}" y="${gy1 + 11}" font-size="9" text-anchor="middle" fill="${pal.sub}">${esc(sym.value)}</text>`);
  }
  return parts.join('\n');
}

function buildGateUnitSpec(partEntry, unitIdx, ic, meta, u, opts) {
  const nIns = u.ins.length;
  const h = Math.max(40, (nIns === 1 ? 2 : nIns + 1) * 20);
  const w = 100;
  const midY = Math.round(h / 40) * 20 || 20;
  const pins = [];
  if (nIns === 1) {
    const pIn = partEntry.pins[u.ins[0] - 1];
    pins.push({ partPinIndex: u.ins[0] - 1, num: pIn.num, name: pIn.name, lx: 0, ly: 20, side: 'L', role: 'in', net: pIn.net, netName: pIn.netName, voltage: pIn.voltage, isPower: false });
  } else {
    const slots = nIns === 2 ? [20, 60] : Array.from({ length: nIns }, (_, i) => 20 + i * 20);
    const realH = nIns === 2 ? 80 : (nIns + 1) * 20;
    u.ins.forEach((pNum, i) => {
      const pIn = partEntry.pins[pNum - 1];
      pins.push({ partPinIndex: pNum - 1, num: pIn.num, name: pIn.name, lx: 0, ly: slots[i], side: 'L', role: 'in', net: pIn.net, netName: pIn.netName, voltage: pIn.voltage, isPower: false });
    });
    const outY = nIns === 2 ? 40 : Math.round(realH / 40) * 20;
    const pOut = partEntry.pins[u.out - 1];
    pins.push({ partPinIndex: u.out - 1, num: pOut.num, name: pOut.name, lx: w, ly: outY, side: 'R', role: 'out', net: pOut.net, netName: pOut.netName, voltage: pOut.voltage, isPower: false });
    const unitLetter = String.fromCharCode(65 + unitIdx);
    return {
      schId: `${partEntry.id}:U${unitLetter}`,
      partId: partEntry.id,
      unit: unitLetter,
      ref: `${partEntry.ref}${meta.units.length > 1 ? unitLetter : ''}`,
      value: ic.id,
      type: partEntry.type,
      w,
      h: realH,
      pins,
      showValue: opts.showValues !== false,
      bodyBox: { x0: 18, y0: 4, x1: w - 18, y1: realH - 4 },
      renderSVG: (std, pal, showNums) => drawGateSymbol({ ref: `${partEntry.ref}${meta.units.length > 1 ? unitLetter : ''}`, value: ic.id, w, h: realH, pins, showValue: opts.showValues !== false }, pal, std, showNums, meta.kind, meta.schmitt, meta.oc, meta.activeLowEn),
    };
  }
  const pOut = partEntry.pins[u.out - 1];
  pins.push({ partPinIndex: u.out - 1, num: pOut.num, name: pOut.name, lx: w, ly: 20, side: 'R', role: 'out', net: pOut.net, netName: pOut.netName, voltage: pOut.voltage, isPower: false });
  if (u.en) {
    const pEn = partEntry.pins[u.en - 1];
    pins.push({ partPinIndex: u.en - 1, num: pEn.num, name: pEn.name, lx: 40, ly: 0, side: 'T', role: 'en', net: pEn.net, netName: pEn.netName, voltage: pEn.voltage, isPower: false });
  }
  const unitLetter = String.fromCharCode(65 + unitIdx);
  const fullRef = `${partEntry.ref}${meta.units.length > 1 ? unitLetter : ''}`;
  return {
    schId: `${partEntry.id}:U${unitLetter}`,
    partId: partEntry.id,
    unit: unitLetter,
    ref: fullRef,
    value: ic.id,
    type: partEntry.type,
    w,
    h,
    pins,
    showValue: opts.showValues !== false,
    bodyBox: { x0: 18, y0: 4, x1: w - 18, y1: h - 4 },
    renderSVG: (std, pal, showNums) => drawGateSymbol({ ref: fullRef, value: ic.id, w, h, pins, showValue: opts.showValues !== false }, pal, std, showNums, meta.kind, meta.schmitt, meta.oc, meta.activeLowEn),
  };
}

function buildFlipFlopUnitSpec(partEntry, unitIdx, ic, meta, u, opts) {
  const leftNums = [], rightNums = [], topNums = [], botNums = [];
  if (meta.kind === 'latch_sr') {
    for (const sPin of u.s) leftNums.push(sPin);
    leftNums.push(u.r);
    rightNums.push(u.q);
  } else if (meta.kind === 'ff_d') {
    leftNums.push(u.d, u.clk);
    rightNums.push(u.q);
    if (u.qn) rightNums.push(u.qn);
    if (u.pre) topNums.push(u.pre);
    if (u.clr) botNums.push(u.clr);
  } else {
    leftNums.push(u.j, u.clk, u.k);
    rightNums.push(u.q);
    if (u.qn) rightNums.push(u.qn);
    if (u.pre) topNums.push(u.pre);
    if (u.clr) botNums.push(u.clr);
  }
  const enriched = partEntry.pins.map((p, idx) => ({
    ...p,
    clock: idx + 1 === u.clk,
    inverted: (u.inv && idx + 1 !== u.q) || ((meta.clkFall || u.clkFall) && idx + 1 === u.clk) || (u.preInv && idx + 1 === u.pre) || (u.clrInv && idx + 1 === u.clr) || idx + 1 === u.qn,
  }));
  const unitLetter = String.fromCharCode(65 + unitIdx);
  const fullRef = `${partEntry.ref}${meta.units.length > 1 ? unitLetter : ''}`;
  const box = pinSideMeta(partEntry, opts, enriched, leftNums.map(n => n - 1), rightNums.map(n => n - 1), topNums.map(n => n - 1), botNums.map(n => n - 1));
  return {
    schId: `${partEntry.id}:U${unitLetter}`,
    partId: partEntry.id,
    unit: unitLetter,
    ref: fullRef,
    value: ic.id,
    type: partEntry.type,
    w: box.w,
    h: box.h,
    pins: box.pins,
    showValue: opts.showValues !== false,
    bodyBox: { x0: 14, y0: 4, x1: box.w - 14, y1: box.h - 4 },
    renderSVG(std, pal, showNums) {
      return drawGenericBox({ ref: fullRef, value: ic.id, w: box.w, h: box.h, pins: box.pins, showValue: opts.showValues !== false }, pal, std, showNums, `${ic.id} ${ic.name}`);
    },
  };
}

/**
 * Expand electrical parts into list of schematic symbols (supporting multi-unit gate splitting).
 */
export function buildSchematicSymbols(data, opts = {}) {
  const { viewMode = 'functional', hideUnwired = true, showValues = true } = opts;
  const showValue = showValues !== false;
  const symbols = [];
  const unusedNotes = [];

  for (const part of data.parts) {
    if (part.type === 'vcc' || part.type === 'gnd') {
      // Standalone vcc/gnd parts act as power source symbols or fallback single-pin flags
      symbols.push({
        schId: part.id,
        partId: part.id,
        unit: null,
        isSupplyOrigin: true,
        ref: part.ref,
        value: part.value,
        type: part.type,
        w: 60,
        h: 40,
        pins: [{ ...part.pins[0], partPinIndex: 0, lx: 60, ly: 20, side: 'R', isPower: true }],
        bodyBox: { x0: 4, y0: 4, x1: 44, y1: 36 },
        renderSVG(std, pal) {
          return drawGenericBox({ ref: part.ref, value: part.value, w: 60, h: 40, pins: [{ ...part.pins[0], name: '', lx: 60, ly: 20, side: 'R', hideNum: true }], showValue: false }, pal, std, false, part.value);
        },
      });
      continue;
    }

    const def = getDef(part.type, true);

    // 1. Multi-unit DIP ICs in functional mode
    if (viewMode === 'functional' && def?.ic) {
      const ic = IC_LIST.find(x => 'ic' + x.id === part.type);
      const meta = ic && IC_SCHEMATIC[ic.id];
      if (meta && meta.units) {
        const isUnitUsed = (u) => {
          const allP = [...(u.ins || []), ...(u.s || []), u.out, u.en, u.d, u.j, u.k, u.clk, u.pre, u.clr, u.q, u.qn, u.r].filter(Boolean);
          return allP.some(pNum => {
            const pin = part.pins[pNum - 1];
            return pin && (pin.wired ?? (pin.netName && pin.net >= 0));
          });
        };
        let activeUnits = meta.units.map((u, i) => ({ u, i })).filter(({ u }) => isUnitUsed(u));
        const unused = meta.units.map((u, i) => ({ u, i })).filter(({ u }) => !isUnitUsed(u));
        if (!activeUnits.length) activeUnits = [{ u: meta.units[0], i: 0 }];
        else if (unused.length && meta.units.length > 1) {
          unusedNotes.push(`Unused ${part.ref} (${ic.id}): ${unused.map(x => part.ref + String.fromCharCode(65 + x.i)).join(', ')}`);
        }
        if (ic.vcc || ic.gnd) {
          const pwrBits = [];
          const vp = ic.vcc ? part.pins[ic.vcc - 1] : null;
          const gp = ic.gnd ? part.pins[ic.gnd - 1] : null;
          if (vp?.wired) pwrBits.push(`VCC=${ic.vcc} (${vp.netName || '+5V'})`);
          if (gp?.wired) pwrBits.push(`GND=${ic.gnd} (${gp.netName || 'GND'})`);
          if (pwrBits.length) unusedNotes.push(`Power ${part.ref} (${ic.id}): ${pwrBits.join(', ')}`);
        }
        for (const { u, i } of activeUnits) {
          if (['and', 'nand', 'or', 'nor', 'xor', 'xnor', 'not', 'buf'].includes(meta.kind)) {
            symbols.push(buildGateUnitSpec(part, i, ic, meta, u, opts));
          } else {
            symbols.push(buildFlipFlopUnitSpec(part, i, ic, meta, u, opts));
          }
        }
        continue;
      }
      if (part.type === 'lm741' || part.type === 'lm358' || part.type === 'lm393') {
        const isComp = part.type === 'lm393';
        const isDual = part.type !== 'lm741';
        const vpIdx = isDual ? 7 : 6, vnIdx = 3;
        const unitDefs = isDual
          ? [{ inP: 2, inN: 1, out: 0 }, { inP: 4, inN: 5, out: 6 }]
          : [{ inP: 2, inN: 1, out: 5 }];
        const isWiredPin = (idx) => {
          const pin = part.pins[idx];
          return !!(pin && (pin.wired ?? (pin.netName && pin.net >= 0)));
        };
        let activeUnits = unitDefs.map((u, i) => ({ u, i })).filter(({ u }) => isWiredPin(u.inP) || isWiredPin(u.inN) || isWiredPin(u.out));
        const unused = unitDefs.map((u, i) => ({ u, i })).filter(({ u }) => !isWiredPin(u.inP) && !isWiredPin(u.inN) && !isWiredPin(u.out));
        if (!activeUnits.length) activeUnits = [{ u: unitDefs[0], i: 0 }];
        else if (unused.length && isDual) {
          unusedNotes.push(`Unused ${part.ref} (${part.shortName}): ${unused.map(x => part.ref + String.fromCharCode(65 + x.i)).join(', ')}`);
        }
        for (const { u, i } of activeUnits) {
          const unitRef = isDual ? `${part.ref}${String.fromCharCode(65 + i)}` : part.ref;
          const pins = [
            { ...part.pins[u.inP], partPinIndex: u.inP, lx: 0, ly: 20, side: 'L', isPower: false },
            { ...part.pins[u.inN], partPinIndex: u.inN, lx: 0, ly: 60, side: 'L', isPower: false },
            { ...part.pins[u.out], partPinIndex: u.out, lx: 100, ly: 40, side: 'R', isPower: false },
          ];
          const attachPower = i === 0;
          if (attachPower && (!opts.hideUnwired || isWiredPin(vpIdx))) {
            pins.push({ ...part.pins[vpIdx], partPinIndex: vpIdx, lx: 40, ly: 0, side: 'T', isPower: true });
          }
          if (attachPower && (!opts.hideUnwired || isWiredPin(vnIdx))) {
            pins.push({ ...part.pins[vnIdx], partPinIndex: vnIdx, lx: 40, ly: 80, side: 'B', isPower: true });
          }
          symbols.push({
            schId: `${part.id}:u${i}`, partId: part.id, unit: i, ref: unitRef, value: part.shortName, type: part.type,
            w: 100, h: 80, pins, showValue, bodyBox: { x0: 18, y0: 10, x1: 82, y1: 70 },
            renderSVG(std, pal, showNums) {
              const out = [
                `<polygon points="20,12 80,40 20,68" fill="${pal.fill}" stroke="${pal.stroke}" stroke-width="1.8" stroke-linejoin="round"/>`,
                `<line x1="0" y1="20" x2="20" y2="20" stroke="${pal.pin}" stroke-width="1.6"/>`,
                `<line x1="0" y1="60" x2="20" y2="60" stroke="${pal.pin}" stroke-width="1.6"/>`,
                `<line x1="80" y1="40" x2="100" y2="40" stroke="${pal.pin}" stroke-width="1.6"/>`,
                `<text x="27" y="24" font-size="11" font-weight="800" fill="${pal.stroke}">+</text>`,
                `<text x="27" y="63" font-size="12" font-weight="800" fill="${pal.stroke}">−</text>`,
                `<text x="64" y="19" font-size="10.5" font-weight="700" fill="${pal.ref}">${esc(unitRef)}</text>`,
                showValue ? `<text x="64" y="67" font-size="9" fill="${pal.sub}">${esc(part.shortName)}</text>` : '',
              ];
              if (isComp) {
                // IEEE open-collector diamond + pull-down underline bar
                out.push(`<polygon points="62,36 66,40 62,44 58,40" fill="none" stroke="${pal.stroke}" stroke-width="1.3"/>`);
                out.push(`<line x1="58" y1="46" x2="66" y2="46" stroke="${pal.stroke}" stroke-width="1.3"/>`);
              }
              if (showNums) {
                out.push(`<text x="12" y="16" font-size="8.5" fill="${pal.sub}">${part.pins[u.inP].num}</text>`);
                out.push(`<text x="12" y="56" font-size="8.5" fill="${pal.sub}">${part.pins[u.inN].num}</text>`);
                out.push(`<text x="86" y="36" font-size="8.5" fill="${pal.sub}">${part.pins[u.out].num}</text>`);
              }
              if (attachPower) {
                if (!opts.hideUnwired || isWiredPin(vpIdx)) {
                  out.push(`<line x1="40" y1="0" x2="40" y2="21.3" stroke="${pal.pin}" stroke-width="1.4"/>`);
                  out.push(`<text x="45" y="12" font-size="8.5" fill="${pal.sub}">${part.pins[vpIdx].num}</text>`);
                }
                if (!opts.hideUnwired || isWiredPin(vnIdx)) {
                  out.push(`<line x1="40" y1="58.7" x2="40" y2="80" stroke="${pal.pin}" stroke-width="1.4"/>`);
                  out.push(`<text x="45" y="75" font-size="8.5" fill="${pal.sub}">${part.pins[vnIdx].num}</text>`);
                }
              }
              return out.join('\n');
            },
          });
        }
        continue;
      }
      if (meta && meta.kind === 'msi') {
        const neg = new Set(meta.negated || []);
        const clk = new Set(meta.clocks || []);
        const enriched = part.pins.map((p, idx) => ({ ...p, clock: clk.has(idx + 1), inverted: neg.has(idx + 1) }));
        const top = ic.vcc ? [ic.vcc - 1] : [];
        const bot = ic.gnd ? [ic.gnd - 1] : [];
        const box = pinSideMeta(part, opts, enriched, meta.left.map(n => n - 1), meta.right.map(n => n - 1), top, bot, `${ic.id} ${ic.name}`);
        symbols.push({
          schId: part.id, partId: part.id, unit: null, ref: part.ref, value: ic.id, type: part.type,
          w: box.w, h: box.h, pins: box.pins, showValue, bodyBox: { x0: 14, y0: 4, x1: box.w - 14, y1: box.h - 4 },
          renderSVG: (std, pal, showNums) => drawGenericBox({ ref: part.ref, value: ic.id, w: box.w, h: box.h, pins: box.pins, showValue }, pal, std, showNums, `${ic.id} ${ic.name}`, false),
        });
        continue;
      }
    }

    // 2. Physical DIP Package view for ICs and 555
    if ((def?.ic || part.type === 'ne555') && viewMode === 'package') {
      const n = part.pins.length, half = n / 2;
      const leftIdx = Array.from({ length: half }, (_, i) => i);
      const rightIdx = Array.from({ length: half }, (_, i) => n - 1 - i);
      const title = part.type === 'ne555' ? 'NE555' : (def?.ic?.id || part.shortName);
      const box = pinSideMeta(part, opts, part.pins, leftIdx, rightIdx, [], [], title);
      symbols.push({
        schId: part.id, partId: part.id, unit: null, ref: part.ref, value: part.value, type: part.type,
        w: box.w, h: box.h, pins: box.pins, showValue, bodyBox: { x0: 14, y0: 4, x1: box.w - 14, y1: box.h - 4 },
        renderSVG: (std, pal, showNums) => drawGenericBox({ ref: part.ref, value: part.value, w: box.w, h: box.h, pins: box.pins, showValue }, pal, std, showNums, title, true),
      });
      continue;
    }

    // 3. Functional NE555 Timer (textbook layout)
    if (part.type === 'ne555') {
      // part.pins indices (0-based): 0:GND(1), 1:TRIG(2), 2:OUT(3), 3:RESET(4), 4:CTRL(5), 5:THR(6), 6:DIS(7), 7:VCC(8)
      const enriched = part.pins.map((p, i) => ({ ...p, inverted: i === 3 }));
      const box = pinSideMeta(part, opts, enriched, [6, 5, 1, 4], [2], [7, 3], [0]);
      symbols.push({
        schId: part.id, partId: part.id, unit: null, ref: part.ref, value: 'NE555', type: part.type,
        w: box.w, h: box.h, pins: box.pins, showValue: false, bodyBox: { x0: 14, y0: 14, x1: box.w - 14, y1: box.h - 14 },
        renderSVG: (std, pal, showNums) => drawGenericBox({ ref: part.ref, value: 'NE555', w: box.w, h: box.h, pins: box.pins, showValue: false }, pal, std, showNums, 'NE555'),
      });
      continue;
    }

    // 4. Discrete 2-pin components (w=80, h=40, pins L(0,20), R(80,20))
    if (['resistor', 'capacitor', 'inductor', 'diode', 'zener', 'led', 'slide', 'buzzer', 'battery'].includes(part.type)) {
      const w = 80, h = 40;
      const pins = [
        { ...part.pins[0], partPinIndex: 0, lx: 0, ly: 20, side: 'L', isPower: part.type === 'battery' ? false : isPowerPinName(part.pins[0].name) },
        { ...part.pins[1], partPinIndex: 1, lx: 80, ly: 20, side: 'R', isPower: part.type === 'battery' ? false : isPowerPinName(part.pins[1].name) },
      ];
      symbols.push({
        schId: part.id, partId: part.id, unit: null, ref: part.ref, value: part.value, type: part.type,
        w, h, pins, showValue, bodyBox: { x0: 12, y0: 4, x1: 68, y1: 36 },
        renderSVG(std, pal) {
          const t = part.type;
          const out = [];
          const refY = t === 'led' ? 1 : 5, valY = t === 'battery' ? 42 : 39;
          out.push(`<text x="40" y="${refY}" font-size="10.5" font-weight="700" text-anchor="middle" fill="${pal.ref}">${esc(part.ref)}</text>`);
          if (showValue && part.value) out.push(`<text x="40" y="${valY}" font-size="9.5" text-anchor="middle" fill="${pal.sub}">${esc(part.value)}</text>`);

          if (t === 'resistor') {
            if (std === 'iec') {
              out.push(`<line x1="0" y1="20" x2="22" y2="20" stroke="${pal.pin}" stroke-width="1.6"/>`);
              out.push(`<rect x="22" y="13" width="36" height="14" fill="${pal.fill}" stroke="${pal.stroke}" stroke-width="1.8"/>`);
              out.push(`<line x1="58" y1="20" x2="80" y2="20" stroke="${pal.pin}" stroke-width="1.6"/>`);
            } else {
              out.push(`<path d="M 0 20 L 20 20 L 23 13 L 29 27 L 35 13 L 41 27 L 47 13 L 53 27 L 57 20 L 80 20" fill="none" stroke="${pal.stroke}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>`);
            }
          } else if (t === 'capacitor') {
            if (part.props?.kind === 'ceramic') {
              out.push(`<line x1="0" y1="20" x2="37" y2="20" stroke="${pal.pin}" stroke-width="1.6"/>`);
              out.push(`<line x1="37" y1="10" x2="37" y2="30" stroke="${pal.stroke}" stroke-width="2.2"/>`);
              out.push(`<line x1="43" y1="10" x2="43" y2="30" stroke="${pal.stroke}" stroke-width="2.2"/>`);
              out.push(`<line x1="43" y1="20" x2="80" y2="20" stroke="${pal.pin}" stroke-width="1.6"/>`);
            } else {
              out.push(`<line x1="0" y1="20" x2="36" y2="20" stroke="${pal.pin}" stroke-width="1.6"/>`);
              out.push(`<line x1="36" y1="10" x2="36" y2="30" stroke="${pal.stroke}" stroke-width="2.2"/>`);
              out.push(`<text x="27" y="13" font-size="10" font-weight="700" fill="${pal.stroke}">+</text>`);
              if (std === 'iec') out.push(`<rect x="42" y="10" width="4" height="20" fill="${pal.stroke}"/>`);
              else out.push(`<path d="M 46 10 Q 40 20 46 30" fill="none" stroke="${pal.stroke}" stroke-width="2.2"/>`);
              out.push(`<line x1="44" y1="20" x2="80" y2="20" stroke="${pal.pin}" stroke-width="1.6"/>`);
            }
          } else if (t === 'inductor') {
            if (std === 'iec') {
              out.push(`<line x1="0" y1="20" x2="22" y2="20" stroke="${pal.pin}" stroke-width="1.6"/>`);
              out.push(`<rect x="22" y="14" width="36" height="12" fill="${pal.stroke}"/>`);
              out.push(`<line x1="58" y1="20" x2="80" y2="20" stroke="${pal.pin}" stroke-width="1.6"/>`);
            } else {
              out.push(`<path d="M 0 20 L 20 20 A 5 5 0 0 1 30 20 A 5 5 0 0 1 40 20 A 5 5 0 0 1 50 20 A 5 5 0 0 1 60 20 L 80 20" fill="none" stroke="${pal.stroke}" stroke-width="1.8"/>`);
            }
          } else if (t === 'diode' || t === 'zener' || t === 'led') {
            const fill = t === 'led' ? '#ffedd5' : pal.fill;
            const model = part.props?.model || '';
            const isSchottky = t === 'diode' && (model === '1N5819' || model === 'BAT85');
            out.push(`<line x1="0" y1="20" x2="31" y2="20" stroke="${pal.pin}" stroke-width="1.6"/>`);
            out.push(`<polygon points="31,11 31,29 49,20" fill="${fill}" stroke="${pal.stroke}" stroke-width="1.8" stroke-linejoin="round"/>`);
            out.push(`<line x1="49" y1="11" x2="49" y2="29" stroke="${pal.stroke}" stroke-width="2.2"/>`);
            if (t === 'zener') {
              out.push(`<path d="M 53 8 L 49 11 L 49 29 L 45 32" fill="none" stroke="${pal.stroke}" stroke-width="1.8" stroke-linecap="round"/>`);
            } else if (isSchottky) {
              out.push(`<path d="M 53 15 L 53 11 L 49 11 M 45 25 L 45 29 L 49 29" fill="none" stroke="${pal.stroke}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`);
            }
            out.push(`<line x1="49" y1="20" x2="80" y2="20" stroke="${pal.pin}" stroke-width="1.6"/>`);
            if (t === 'led') {
              out.push(`<path d="M 46 11 L 52 5 M 52 5 L 48 6 M 52 5 L 51 9 M 52 14 L 58 8 M 58 8 L 54 9 M 58 8 L 57 12" fill="none" stroke="${pal.stroke}" stroke-width="1.3" stroke-linecap="round"/>`);
            }
          } else if (t === 'slide') {
            out.push(`<line x1="0" y1="20" x2="26" y2="20" stroke="${pal.pin}" stroke-width="1.6"/>`);
            out.push(`<circle cx="28" cy="20" r="2.2" fill="${pal.bg}" stroke="${pal.stroke}" stroke-width="1.5"/>`);
            out.push(`<line x1="30" y1="19" x2="50" y2="11" stroke="${pal.stroke}" stroke-width="1.8" stroke-linecap="round"/>`);
            out.push(`<circle cx="52" cy="20" r="2.2" fill="${pal.bg}" stroke="${pal.stroke}" stroke-width="1.5"/>`);
            out.push(`<line x1="54" y1="20" x2="80" y2="20" stroke="${pal.pin}" stroke-width="1.6"/>`);
          } else if (t === 'buzzer') {
            out.push(`<line x1="0" y1="20" x2="26" y2="20" stroke="${pal.pin}" stroke-width="1.6"/>`);
            out.push(`<circle cx="40" cy="20" r="11" fill="${pal.fill}" stroke="${pal.stroke}" stroke-width="1.8"/>`);
            out.push(`<text x="20" y="14" font-size="9" font-weight="700" fill="${pal.stroke}">+</text>`);
            out.push(`<text x="40" y="23" font-size="9" font-weight="700" text-anchor="middle" fill="${pal.stroke}">BZ</text>`);
            out.push(`<line x1="51" y1="20" x2="80" y2="20" stroke="${pal.pin}" stroke-width="1.6"/>`);
          } else if (t === 'battery') {
            out.push(`<line x1="0" y1="20" x2="35" y2="20" stroke="${pal.pin}" stroke-width="1.6"/>`);
            out.push(`<line x1="35" y1="9" x2="35" y2="31" stroke="${pal.stroke}" stroke-width="2.2"/>`);
            out.push(`<line x1="41" y1="14" x2="41" y2="26" stroke="${pal.stroke}" stroke-width="2.8"/>`);
            out.push(`<line x1="47" y1="9" x2="47" y2="31" stroke="${pal.stroke}" stroke-width="1.8"/>`);
            out.push(`<line x1="53" y1="14" x2="53" y2="26" stroke="${pal.stroke}" stroke-width="2.8"/>`);
            out.push(`<line x1="53" y1="20" x2="80" y2="20" stroke="${pal.pin}" stroke-width="1.6"/>`);
            out.push(`<text x="25" y="14" font-size="10" font-weight="700" fill="${pal.stroke}">+</text>`);
          }
          return out.join('\n');
        },
      });
      continue;
    }

    // 5. Potentiometers (`pot` / `wokwi-slide-potentiometer`) -> vertical divider w/ Right wiper
    if (part.type === 'pot' || part.type === 'wokwi-slide-potentiometer') {
      const w = 80, h = 80;
      const pins = [
        { ...part.pins[0], partPinIndex: 0, lx: 40, ly: 0, side: 'T', isPower: false },
        { ...part.pins[1], partPinIndex: 1, lx: 80, ly: 40, side: 'R', isPower: false },
        { ...part.pins[2], partPinIndex: 2, lx: 40, ly: 80, side: 'B', isPower: false },
      ];
      symbols.push({
        schId: part.id, partId: part.id, unit: null, ref: part.ref, value: part.value, type: part.type,
        w, h, pins, showValue, bodyBox: { x0: 16, y0: 14, x1: 64, y1: 66 },
        renderSVG(std, pal) {
          const out = [
            `<text x="12" y="34" font-size="10.5" font-weight="700" fill="${pal.ref}">${esc(part.ref)}</text>`,
            showValue ? `<text x="12" y="48" font-size="9.5" fill="${pal.sub}">${esc(part.value)}</text>` : '',
          ];
          if (std === 'iec') {
            out.push(`<line x1="40" y1="0" x2="40" y2="20" stroke="${pal.pin}" stroke-width="1.6"/>`);
            out.push(`<rect x="33" y="20" width="14" height="40" fill="${pal.fill}" stroke="${pal.stroke}" stroke-width="1.8"/>`);
            out.push(`<line x1="40" y1="60" x2="40" y2="80" stroke="${pal.pin}" stroke-width="1.6"/>`);
          } else {
            out.push(`<path d="M 40 0 L 40 20 L 47 23 L 33 29 L 47 35 L 33 41 L 47 47 L 33 53 L 40 57 L 40 80" fill="none" stroke="${pal.stroke}" stroke-width="1.8" stroke-linejoin="round"/>`);
          }
          // Wiper arrow from Right (80, 40) to resistor side (48, 40)
          out.push(`<line x1="80" y1="40" x2="48" y2="40" stroke="${pal.pin}" stroke-width="1.6"/>`);
          out.push(`<polygon points="47,40 54,36 54,44" fill="${pal.stroke}"/>`);
          return out.join('\n');
        },
      });
      continue;
    }

    // 6. Transistors (`npn`, `pnp`, `jfet`, `nmos`, `pmos`) -> Gate/Base L(0,40), Top(60,0), Bottom(60,80)
    if (part.type === 'npn' || part.type === 'pnp' || part.type === 'jfet' || part.type === 'nmos' || part.type === 'pmos') {
      const w = 80, h = 80;
      const isBjt = part.type === 'npn' || part.type === 'pnp';
      const isMos = part.type === 'nmos' || part.type === 'pmos';
      let ctrlIdx, topIdx, botIdx;
      if (isBjt) {
        ctrlIdx = 1; // B
        topIdx = part.type === 'pnp' ? 0 : 2; // PNP E on top, NPN C on top
        botIdx = part.type === 'pnp' ? 2 : 0;
      } else if (isMos) {
        ctrlIdx = 0; // G
        topIdx = part.type === 'pmos' ? 2 : 1; // PMOS S on top, NMOS D on top
        botIdx = part.type === 'pmos' ? 1 : 2;
      } else {
        ctrlIdx = 2; topIdx = 0; botIdx = 1; // jfet
      }
      const pins = [
        { ...part.pins[ctrlIdx], partPinIndex: ctrlIdx, lx: 0, ly: 40, side: 'L', isPower: false },
        { ...part.pins[topIdx], partPinIndex: topIdx, lx: 60, ly: 0, side: 'T', isPower: false },
        { ...part.pins[botIdx], partPinIndex: botIdx, lx: 60, ly: 80, side: 'B', isPower: false },
      ];
      symbols.push({
        schId: part.id, partId: part.id, unit: null, ref: part.ref, value: part.value, type: part.type,
        w, h, pins, showValue, bodyBox: { x0: 18, y0: 14, x1: 68, y1: 66 },
        renderSVG(std, pal) {
          const out = [`<circle cx="44" cy="40" r="21" fill="${pal.fill}" stroke="${pal.stroke}" stroke-width="1.6"/>`];
          if (isBjt) {
            out.push(`<line x1="0" y1="40" x2="36" y2="40" stroke="${pal.pin}" stroke-width="1.6"/>`);
            out.push(`<line x1="36" y1="26" x2="36" y2="54" stroke="${pal.stroke}" stroke-width="2.4"/>`);
            out.push(`<line x1="60" y1="0" x2="60" y2="20" stroke="${pal.pin}" stroke-width="1.6"/>`);
            out.push(`<line x1="60" y1="60" x2="60" y2="80" stroke="${pal.pin}" stroke-width="1.6"/>`);
            out.push(`<line x1="36" y1="34" x2="60" y2="20" stroke="${pal.stroke}" stroke-width="1.8"/>`);
            out.push(`<line x1="36" y1="46" x2="60" y2="60" stroke="${pal.stroke}" stroke-width="1.8"/>`);
            if (part.type === 'pnp') {
              // Arrow points inward from top Emitter toward Base
              out.push(`<polygon points="41,31 49,30 46,23" fill="${pal.stroke}"/>`);
            } else {
              // Arrow points outward toward bottom Emitter
              out.push(`<polygon points="57,58 49,57 53,51" fill="${pal.stroke}"/>`);
            }
          } else if (isMos) {
            out.push(`<line x1="0" y1="40" x2="32" y2="40" stroke="${pal.pin}" stroke-width="1.6"/>`);
            out.push(`<line x1="32" y1="24" x2="32" y2="56" stroke="${pal.stroke}" stroke-width="2"/>`);
            out.push(`<line x1="38" y1="21" x2="38" y2="29" stroke="${pal.stroke}" stroke-width="2"/>`);
            out.push(`<line x1="38" y1="36" x2="38" y2="44" stroke="${pal.stroke}" stroke-width="2"/>`);
            out.push(`<line x1="38" y1="51" x2="38" y2="59" stroke="${pal.stroke}" stroke-width="2"/>`);
            out.push(`<line x1="60" y1="0" x2="60" y2="25" stroke="${pal.pin}" stroke-width="1.6"/>`);
            out.push(`<line x1="38" y1="25" x2="60" y2="25" stroke="${pal.stroke}" stroke-width="1.6"/>`);
            out.push(`<line x1="60" y1="80" x2="60" y2="55" stroke="${pal.pin}" stroke-width="1.6"/>`);
            out.push(`<line x1="38" y1="55" x2="60" y2="55" stroke="${pal.stroke}" stroke-width="1.6"/>`);
            if (part.type === 'nmos') {
              out.push(`<line x1="38" y1="40" x2="54" y2="40" stroke="${pal.stroke}" stroke-width="1.5"/>`);
              out.push(`<line x1="54" y1="40" x2="54" y2="55" stroke="${pal.stroke}" stroke-width="1.5"/>`);
              out.push(`<polygon points="39,40 46,36 46,44" fill="${pal.stroke}"/>`);
            } else {
              out.push(`<line x1="38" y1="40" x2="54" y2="40" stroke="${pal.stroke}" stroke-width="1.5"/>`);
              out.push(`<line x1="54" y1="40" x2="54" y2="25" stroke="${pal.stroke}" stroke-width="1.5"/>`);
              out.push(`<polygon points="52,40 45,36 45,44" fill="${pal.stroke}"/>`);
            }
          } else {
            out.push(`<line x1="0" y1="40" x2="36" y2="40" stroke="${pal.pin}" stroke-width="1.6"/>`);
            out.push(`<line x1="36" y1="26" x2="36" y2="54" stroke="${pal.stroke}" stroke-width="2.4"/>`);
            out.push(`<line x1="60" y1="0" x2="60" y2="20" stroke="${pal.pin}" stroke-width="1.6"/>`);
            out.push(`<line x1="60" y1="60" x2="60" y2="80" stroke="${pal.pin}" stroke-width="1.6"/>`);
            out.push(`<line x1="36" y1="30" x2="60" y2="30" stroke="${pal.stroke}" stroke-width="1.8"/>`);
            out.push(`<line x1="60" y1="20" x2="60" y2="30" stroke="${pal.stroke}" stroke-width="1.8"/>`);
            out.push(`<line x1="36" y1="50" x2="60" y2="50" stroke="${pal.stroke}" stroke-width="1.8"/>`);
            out.push(`<line x1="60" y1="50" x2="60" y2="60" stroke="${pal.stroke}" stroke-width="1.8"/>`);
            out.push(`<polygon points="35,40 27,36 27,44" fill="${pal.stroke}"/>`);
          }
          out.push(`<text x="16" y="16" font-size="10.5" font-weight="700" text-anchor="end" fill="${pal.ref}">${esc(part.ref)}</text>`);
          if (showValue) out.push(`<text x="16" y="68" font-size="9.5" text-anchor="end" fill="${pal.sub}">${esc(part.value)}</text>`);
          return out.join('\n');
        },
      });
      continue;
    }

    // 6b. Optocoupler (`pc817`) in functional mode: LED left + isolated phototransistor right
    if (part.type === 'pc817' && viewMode === 'functional') {
      const pins = [
        { ...part.pins[0], partPinIndex: 0, lx: 0, ly: 20, side: 'L', isPower: false },
        { ...part.pins[1], partPinIndex: 1, lx: 0, ly: 40, side: 'L', isPower: false },
        { ...part.pins[3], partPinIndex: 3, lx: 100, ly: 20, side: 'R', isPower: false },
        { ...part.pins[2], partPinIndex: 2, lx: 100, ly: 40, side: 'R', isPower: false },
      ];
      symbols.push({
        schId: part.id, partId: part.id, unit: null, ref: part.ref, value: 'PC817', type: part.type,
        w: 100, h: 60, pins, showValue, bodyBox: { x0: 14, y0: 4, x1: 86, y1: 56 },
        renderSVG(std, pal, showNums) {
          const out = [
            `<rect x="16" y="6" width="68" height="48" rx="4" fill="${pal.fill}" stroke="${pal.stroke}" stroke-width="1.6"/>`,
            `<line x1="50" y1="10" x2="50" y2="50" stroke="${pal.sub}" stroke-width="1.1" stroke-dasharray="3,3"/>`,
            // Left IR LED
            `<line x1="0" y1="20" x2="31" y2="20" stroke="${pal.pin}" stroke-width="1.6"/>`,
            `<line x1="31" y1="20" x2="31" y2="24" stroke="${pal.stroke}" stroke-width="1.5"/>`,
            `<polygon points="24,24 38,24 31,34" fill="#ffedd5" stroke="${pal.stroke}" stroke-width="1.4"/>`,
            `<line x1="24" y1="34" x2="38" y2="34" stroke="${pal.stroke}" stroke-width="1.8"/>`,
            `<line x1="31" y1="34" x2="31" y2="40" stroke="${pal.stroke}" stroke-width="1.5"/>`,
            `<line x1="0" y1="40" x2="31" y2="40" stroke="${pal.pin}" stroke-width="1.6"/>`,
            // Optical photon arrows
            `<line x1="41" y1="25" x2="56" y2="25" stroke="${pal.stroke}" stroke-width="1.3"/><polygon points="58,25 53,22.5 53,27.5" fill="${pal.stroke}"/>`,
            `<line x1="41" y1="34" x2="56" y2="34" stroke="${pal.stroke}" stroke-width="1.3"/><polygon points="58,34 53,31.5 53,36.5" fill="${pal.stroke}"/>`,
            // Right phototransistor
            `<line x1="65" y1="20" x2="65" y2="40" stroke="${pal.stroke}" stroke-width="2.2"/>`,
            `<line x1="65" y1="26" x2="77" y2="20" stroke="${pal.stroke}" stroke-width="1.5"/>`,
            `<line x1="77" y1="20" x2="100" y2="20" stroke="${pal.pin}" stroke-width="1.6"/>`,
            `<line x1="65" y1="34" x2="77" y2="40" stroke="${pal.stroke}" stroke-width="1.5"/>`,
            `<line x1="77" y1="40" x2="100" y2="40" stroke="${pal.pin}" stroke-width="1.6"/>`,
            `<polygon points="75,39 69,39 72,34" fill="${pal.stroke}"/>`,
            `<text x="50" y="3" font-size="10.5" font-weight="700" text-anchor="middle" fill="${pal.ref}">${esc(part.ref)}</text>`,
            showValue ? `<text x="50" y="65" font-size="9.5" text-anchor="middle" fill="${pal.sub}">PC817</text>` : '',
          ];
          if (showNums) {
            out.push(`<text x="10" y="16" font-size="8.5" fill="${pal.sub}">1</text>`);
            out.push(`<text x="10" y="36" font-size="8.5" fill="${pal.sub}">2</text>`);
            out.push(`<text x="90" y="16" font-size="8.5" text-anchor="end" fill="${pal.sub}">4</text>`);
            out.push(`<text x="90" y="36" font-size="8.5" text-anchor="end" fill="${pal.sub}">3</text>`);
          }
          return out.join('\n');
        },
      });
      continue;
    }

    // 6c. 3-pin Linear Regulators (`lm7805`, `lm317`)
    if (part.type === 'lm7805' || part.type === 'lm317') {
      const is317 = part.type === 'lm317';
      const inIdx = is317 ? 2 : 0, botIdx = is317 ? 0 : 1, outIdx = is317 ? 1 : 2;
      const pins = [
        { ...part.pins[inIdx], partPinIndex: inIdx, lx: 0, ly: 40, side: 'L', isPower: false },
        { ...part.pins[outIdx], partPinIndex: outIdx, lx: 120, ly: 40, side: 'R', isPower: false },
        { ...part.pins[botIdx], partPinIndex: botIdx, lx: 60, ly: 80, side: 'B', isPower: false },
      ];
      symbols.push({
        schId: part.id, partId: part.id, unit: null, ref: part.ref, value: part.value, type: part.type,
        w: 120, h: 80, pins, showValue, bodyBox: { x0: 20, y0: 14, x1: 100, y1: 62 },
        renderSVG(std, pal) {
          return [
            `<rect x="20" y="16" width="80" height="44" rx="4" fill="${pal.fill}" stroke="${pal.stroke}" stroke-width="1.8"/>`,
            `<line x1="0" y1="40" x2="20" y2="40" stroke="${pal.pin}" stroke-width="1.6"/>`,
            `<line x1="100" y1="40" x2="120" y2="40" stroke="${pal.pin}" stroke-width="1.6"/>`,
            `<line x1="60" y1="60" x2="60" y2="80" stroke="${pal.pin}" stroke-width="1.6"/>`,
            `<text x="26" y="43" font-size="9.5" font-weight="700" fill="${pal.stroke}">IN</text>`,
            `<text x="94" y="43" font-size="9.5" font-weight="700" text-anchor="end" fill="${pal.stroke}">OUT</text>`,
            `<text x="60" y="55" font-size="9" font-weight="700" text-anchor="middle" fill="${pal.stroke}">${is317 ? 'ADJ' : 'GND'}</text>`,
            `<text x="60" y="11" font-size="10.5" font-weight="700" text-anchor="middle" fill="${pal.ref}">${esc(part.ref)}</text>`,
            `<text x="60" y="34" font-size="10.5" font-weight="800" text-anchor="middle" fill="${pal.stroke}">${is317 ? 'LM317' : esc(part.value)}</text>`,
          ].join('\n');
        },
      });
      continue;
    }

    // 7. Tactile 4-pin Pushbutton -> collapse bridged sides (1.l/1.r & 2.l/2.r) into a crisp 2-pin NO pushbutton symbol
    if (part.type === 'tactile') {
      const collapsed = collapseLinkedPins(part.pins);
      const pL = collapsed[0] || { ...part.pins[0], partPinIndex: 0 };
      const pR = collapsed[1] || collapsed[0] || { ...part.pins[2], partPinIndex: 2 };
      const pins = [
        { ...pL, lx: 0, ly: 20, side: 'L', isPower: false },
        { ...pR, lx: 80, ly: 20, side: 'R', isPower: false },
      ];
      symbols.push({
        schId: part.id, partId: part.id, unit: null, ref: part.ref, value: part.value, type: part.type,
        w: 80, h: 40, pins, showValue, bodyBox: { x0: 18, y0: 4, x1: 62, y1: 36 },
        renderSVG(std, pal) {
          return [
            `<text x="40" y="4" font-size="10.5" font-weight="700" text-anchor="middle" fill="${pal.ref}">${esc(part.ref)}</text>`,
            `<line x1="0" y1="20" x2="26" y2="20" stroke="${pal.pin}" stroke-width="1.6"/>`,
            `<circle cx="28" cy="20" r="2.2" fill="${pal.bg}" stroke="${pal.stroke}" stroke-width="1.5"/>`,
            `<line x1="54" y1="20" x2="80" y2="20" stroke="${pal.pin}" stroke-width="1.6"/>`,
            `<circle cx="52" cy="20" r="2.2" fill="${pal.bg}" stroke="${pal.stroke}" stroke-width="1.5"/>`,
            `<line x1="27" y1="15" x2="53" y2="15" stroke="${pal.stroke}" stroke-width="1.8" stroke-linecap="round"/>`,
            `<line x1="40" y1="9" x2="40" y2="15" stroke="${pal.stroke}" stroke-width="1.4"/>`,
            `<line x1="34" y1="9" x2="46" y2="9" stroke="${pal.stroke}" stroke-width="1.8" stroke-linecap="round"/>`,
          ].join('\n');
        },
      });
      continue;
    }

    // 8. 1-pin digital sources (`toggle`, `button`, `clock`) -> standard IEEE/IEC switch, pushbutton & square-wave clock symbols
    if (part.type === 'toggle' || part.type === 'button' || part.type === 'clock') {
      const w = 80, h = 40;
      const pins = [{ ...part.pins[0], partPinIndex: 0, lx: 80, ly: 20, side: 'R', isPower: false }];
      const userLbl = String(part.props?.label || '').trim();
      symbols.push({
        schId: part.id, partId: part.id, unit: null, ref: part.ref, value: part.value, type: part.type,
        w, h, pins, showValue, bodyBox: { x0: 14, y0: 4, x1: 64, y1: 36 },
        renderSVG(std, pal) {
          const out = [`<text x="40" y="4" font-size="10.5" font-weight="700" text-anchor="middle" fill="${pal.ref}">${esc(part.ref)}</text>`];
          if (part.type === 'clock') {
            out.push(`<circle cx="36" cy="20" r="13" fill="${pal.fill}" stroke="${pal.stroke}" stroke-width="1.8"/>`);
            out.push(`<path d="M 27 24 L 30 24 L 30 16 L 36 16 L 36 24 L 41 24 L 41 16 L 45 16" fill="none" stroke="${pal.stroke}" stroke-width="1.5" stroke-linecap="square" stroke-linejoin="miter"/>`);
            out.push(`<line x1="49" y1="20" x2="80" y2="20" stroke="${pal.pin}" stroke-width="1.6"/>`);
            const hzLbl = part.value || `${part.props?.hz || 1} Hz`;
            if (showValue) out.push(`<text x="36" y="40" font-size="9" text-anchor="middle" fill="${pal.sub}">${esc(hzLbl)}</text>`);
          } else if (part.type === 'toggle') {
            const on = !!part.props?.on;
            out.push(`<text x="17" y="15" font-size="8" font-weight="700" text-anchor="end" fill="${pal.sub}">1</text>`);
            out.push(`<text x="17" y="30" font-size="8" font-weight="700" text-anchor="end" fill="${pal.sub}">0</text>`);
            out.push(`<line x1="19" y1="12" x2="27" y2="12" stroke="${pal.stroke}" stroke-width="1.3"/>`);
            out.push(`<line x1="19" y1="28" x2="27" y2="28" stroke="${pal.stroke}" stroke-width="1.3"/>`);
            out.push(`<circle cx="29" cy="12" r="2.2" fill="${pal.bg}" stroke="${pal.stroke}" stroke-width="1.5"/>`);
            out.push(`<circle cx="29" cy="28" r="2.2" fill="${pal.bg}" stroke="${pal.stroke}" stroke-width="1.5"/>`);
            out.push(`<line x1="54" y1="20" x2="31" y2="${on ? 12.5 : 27.5}" stroke="${pal.stroke}" stroke-width="2" stroke-linecap="round"/>`);
            out.push(`<circle cx="55" cy="20" r="2.3" fill="${pal.bg}" stroke="${pal.stroke}" stroke-width="1.5"/>`);
            out.push(`<line x1="57" y1="20" x2="80" y2="20" stroke="${pal.pin}" stroke-width="1.6"/>`);
            if (userLbl) out.push(`<text x="40" y="39" font-size="9" text-anchor="middle" fill="${pal.sub}">${esc(userLbl)}</text>`);
          } else {
            out.push(`<line x1="18" y1="12" x2="18" y2="28" stroke="${pal.stroke}" stroke-width="1.8" stroke-linecap="round"/>`);
            out.push(`<line x1="18" y1="20" x2="27" y2="20" stroke="${pal.stroke}" stroke-width="1.4"/>`);
            out.push(`<circle cx="29" cy="20" r="2.2" fill="${pal.bg}" stroke="${pal.stroke}" stroke-width="1.5"/>`);
            out.push(`<circle cx="52" cy="20" r="2.2" fill="${pal.bg}" stroke="${pal.stroke}" stroke-width="1.5"/>`);
            out.push(`<line x1="54" y1="20" x2="80" y2="20" stroke="${pal.pin}" stroke-width="1.6"/>`);
            out.push(`<line x1="28" y1="15" x2="53" y2="15" stroke="${pal.stroke}" stroke-width="1.8" stroke-linecap="round"/>`);
            out.push(`<line x1="40.5" y1="9" x2="40.5" y2="15" stroke="${pal.stroke}" stroke-width="1.4"/>`);
            out.push(`<line x1="34.5" y1="9" x2="46.5" y2="9" stroke="${pal.stroke}" stroke-width="1.8" stroke-linecap="round"/>`);
            if (userLbl) out.push(`<text x="40" y="39" font-size="9" text-anchor="middle" fill="${pal.sub}">${esc(userLbl)}</text>`);
          }
          return out.join('\n');
        },
      });
      continue;
    }

    // 9. Relay Module (`IN, VCC, GND` left -> `COM, NO, NC` right)
    if (part.type === 'wokwi-relay-module') {
      const box = pinSideMeta(part, opts, part.pins, [0, 1, 2], [3, 4, 5]);
      symbols.push({
        schId: part.id, partId: part.id, unit: null, ref: part.ref, value: part.value, type: part.type,
        w: box.w, h: box.h, pins: box.pins, showValue, bodyBox: { x0: 14, y0: 4, x1: box.w - 14, y1: box.h - 4 },
        renderSVG: (std, pal, showNums) => drawGenericBox({ ref: part.ref, value: part.value, w: box.w, h: box.h, pins: box.pins, showValue }, pal, std, showNums, 'RELAY SPDT'),
      });
      continue;
    }

    // 10. LED Bar Graph -> Paired Left Anodes (A1..A8) & Right Cathodes (K1..K8) with internal LED symbols
    if (part.type === 'bargraph') {
      const pairs = [];
      for (let i = 0; i < 8; i++) {
        const a = { ...part.pins[i], partPinIndex: i, isPower: false };
        const k = { ...part.pins[8 + i], partPinIndex: 8 + i, isPower: false };
        if (!hideUnwired || a.wired || k.wired) pairs.push({ a, k });
      }
      const active = pairs.length ? pairs : [0, 1, 2, 3].map(i => ({
        a: { ...part.pins[i], partPinIndex: i, isPower: false },
        k: { ...part.pins[8 + i], partPinIndex: 8 + i, isPower: false },
      }));
      const w = 120, h = Math.max(80, (active.length + 1) * 20);
      const pins = [];
      active.forEach((pr, rowIdx) => {
        const ly = 20 + rowIdx * 20;
        pins.push({ ...pr.a, lx: 0, ly, side: 'L' });
        pins.push({ ...pr.k, lx: w, ly, side: 'R' });
      });
      symbols.push({
        schId: part.id, partId: part.id, unit: null, ref: part.ref, value: part.value, type: part.type,
        w, h, pins, showValue, prunedCount: Math.max(0, 16 - active.length * 2),
        bodyBox: { x0: 14, y0: 4, x1: w - 14, y1: h - 4 },
        renderSVG(std, pal, showNums) {
          const out = [
            `<rect x="16" y="4" width="${w - 32}" height="${h - 8}" rx="3" fill="${pal.fill}" stroke="${pal.stroke}" stroke-width="1.8"/>`,
            `<text x="16" y="-1" font-size="10.5" font-weight="700" fill="${pal.ref}">${esc(part.ref)}</text>`,
            showValue ? `<text x="${w - 16}" y="-1" font-size="9.5" text-anchor="end" fill="${pal.sub}">${esc(part.value)}</text>` : '',
          ];
          active.forEach((pr, rowIdx) => {
            const ly = 20 + rowIdx * 20;
            out.push(`<line x1="0" y1="${ly}" x2="16" y2="${ly}" stroke="${pal.pin}" stroke-width="1.6"/>`);
            out.push(`<line x1="${w - 16}" y1="${ly}" x2="${w}" y2="${ly}" stroke="${pal.pin}" stroke-width="1.6"/>`);
            if (showNums) {
              out.push(`<text x="12" y="${ly - 4}" font-size="8.5" text-anchor="end" font-family="'SF Mono', ui-monospace, monospace" fill="${pal.pinNum}">${pr.a.num}</text>`);
              out.push(`<text x="${w - 12}" y="${ly - 4}" font-size="8.5" font-family="'SF Mono', ui-monospace, monospace" fill="${pal.pinNum}">${pr.k.num}</text>`);
            }
            out.push(`<text x="20" y="${ly + 3}" font-size="8" font-weight="600" fill="${pal.pinText}">${esc(pr.a.name)}</text>`);
            out.push(`<text x="${w - 20}" y="${ly + 3}" font-size="8" font-weight="600" text-anchor="end" fill="${pal.pinText}">${esc(pr.k.name)}</text>`);
            out.push(`<line x1="36" y1="${ly}" x2="54" y2="${ly}" stroke="${pal.stroke}" stroke-width="1.3"/>`);
            out.push(`<polygon points="54,${ly - 5} 54,${ly + 5} 66,${ly}" fill="#ffedd5" stroke="${pal.stroke}" stroke-width="1.4" stroke-linejoin="round"/>`);
            out.push(`<line x1="66" y1="${ly - 5}" x2="66" y2="${ly + 5}" stroke="${pal.stroke}" stroke-width="1.6"/>`);
            out.push(`<line x1="66" y1="${ly}" x2="84" y2="${ly}" stroke="${pal.stroke}" stroke-width="1.3"/>`);
          });
          return out.join('\n');
        },
      });
      continue;
    }

    // 11. RGB LED -> R/G/B Left -> COM Right
    if (part.type === 'wokwi-rgb-led') {
      const box = pinSideMeta(part, opts, part.pins, [0, 2, 3], [1], [], [], 'RGB LED');
      symbols.push({
        schId: part.id, partId: part.id, unit: null, ref: part.ref, value: part.value, type: part.type,
        w: box.w, h: box.h, pins: box.pins, showValue, bodyBox: { x0: 14, y0: 4, x1: box.w - 14, y1: box.h - 4 },
        renderSVG: (std, pal, showNums) => drawGenericBox({ ref: part.ref, value: part.value, w: box.w, h: box.h, pins: box.pins, showValue }, pal, std, showNums, 'RGB LED'),
      });
      continue;
    }

    // 11b. SPDT Slide Switch (`spdt`) -> 3-pin A / B / COM toggle symbol
    if (part.type === 'spdt') {
      const bPos = part.props?.pos === 'B';
      const pA = part.pins[0] || { name: 'A', num: '1' };
      const pCom = part.pins[1] || { name: 'COM', num: '2' };
      const pB = part.pins[2] || { name: 'B', num: '3' };
      const pins = [
        { ...pA, side: 'L', partPinIndex: 0, lx: 0, ly: 20, isPower: false },
        { ...pB, side: 'L', partPinIndex: 2, lx: 0, ly: 40, isPower: false },
        { ...pCom, side: 'R', partPinIndex: 1, lx: 80, ly: 20, isPower: false },
      ];
      symbols.push({
        schId: part.id, partId: part.id, unit: null, ref: part.ref, value: bPos ? 'B' : 'A', type: part.type,
        w: 80, h: 60, pins, showValue: false, prunedCount: 0,
        bodyBox: { x0: 18, y0: 8, x1: 62, y1: 48 },
        renderSVG(std, pal, showNums) {
          const out = [
            `<line x1="0" y1="20" x2="26" y2="20" stroke="${pal.pin}" stroke-width="1.6"/>`,
            `<line x1="0" y1="40" x2="26" y2="40" stroke="${pal.pin}" stroke-width="1.6"/>`,
            `<line x1="54" y1="20" x2="80" y2="20" stroke="${pal.pin}" stroke-width="1.6"/>`,
            `<circle cx="28" cy="20" r="2.2" fill="${pal.bg}" stroke="${pal.stroke}" stroke-width="1.5"/>`,
            `<circle cx="28" cy="40" r="2.2" fill="${pal.bg}" stroke="${pal.stroke}" stroke-width="1.5"/>`,
            `<circle cx="52" cy="20" r="2.2" fill="${pal.bg}" stroke="${pal.stroke}" stroke-width="1.5"/>`,
            `<line x1="50" y1="20" x2="29" y2="${bPos ? 40 : 20}" stroke="${pal.stroke}" stroke-width="2" stroke-linecap="round"/>`,
            `<text x="40" y="7" font-size="10" font-weight="700" text-anchor="middle" fill="${pal.ref}">${esc(part.ref)}</text>`,
          ];
          if (showNums) {
            out.push(`<text x="11" y="16" font-size="8" font-family="'SF Mono', monospace" fill="${pal.pinNum}">1</text>`);
            out.push(`<text x="11" y="36" font-size="8" font-family="'SF Mono', monospace" fill="${pal.pinNum}">3</text>`);
            out.push(`<text x="69" y="16" font-size="8" text-anchor="end" font-family="'SF Mono', monospace" fill="${pal.pinNum}">2</text>`);
          }
          return out.join('\n');
        },
      });
      continue;
    }

    // 12a. 4-Digit Multiplexed 7-Segment Display (`seg7x4`)
    if (part.type === 'seg7x4') {
      const isAnode = part.props?.common === 'anode';
      const segOrder = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'DP'];
      const digOrder = ['D1', 'D2', 'D3', 'D4'];
      const all = part.pins.map((p, idx) => ({ ...p, partPinIndex: idx, isPower: false }));
      const sigPins = all
        .filter(p => !/^D[1-4]$/i.test(p.name) && (!hideUnwired || p.wired))
        .sort((a, b) => segOrder.indexOf(a.name) - segOrder.indexOf(b.name));
      const digPins = all
        .filter(p => /^D[1-4]$/i.test(p.name) && (!hideUnwired || p.wired))
        .sort((a, b) => digOrder.indexOf(a.name) - digOrder.indexOf(b.name));
      const finalSig = sigPins.length ? sigPins : all.filter(p => !/^D[1-4]$/i.test(p.name));
      const finalDig = digPins.length ? digPins : all.filter(p => /^D[1-4]$/i.test(p.name));
      const cand = [...finalSig, ...finalDig];
      const leftIdx = finalSig.map((_, i) => i);
      const topIdx = isAnode ? finalDig.map((_, i) => finalSig.length + i) : [];
      const botIdx = isAnode ? [] : finalDig.map((_, i) => finalSig.length + i);
      const box = pinSideMeta(part, opts, cand, leftIdx, [], topIdx, botIdx, '7-SEG×4');
      const remapped = box.pins.map(bp => ({ ...bp, partPinIndex: cand[bp.partPinIndex].partPinIndex }));
      symbols.push({
        schId: part.id, partId: part.id, unit: null, ref: part.ref, value: part.value, type: part.type,
        w: box.w, h: box.h, pins: remapped, showValue, prunedCount: Math.max(0, part.pins.length - cand.length),
        bodyBox: { x0: 14, y0: 4, x1: box.w - 14, y1: box.h - 4 },
        renderSVG: (std, pal, showNums) => drawGenericBox({ ref: part.ref, value: part.value, w: box.w, h: box.h, pins: remapped, showValue }, pal, std, showNums, '7-SEG×4'),
      });
      continue;
    }

    // 12. 7-Segment Display -> collapsed single COM Top/Bottom + ordered segment inputs Left
    if (part.type === 'seg7') {
      const collapsed = collapseLinkedPins(part.pins);
      const isAnode = part.props?.common === 'anode';
      const segOrder = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'DP'];
      const sigPins = collapsed
        .filter(p => !/^COM$/i.test(p.name) && (!hideUnwired || p.wired))
        .sort((a, b) => segOrder.indexOf(a.name) - segOrder.indexOf(b.name));
      const comPins = collapsed.filter(p => /^COM$/i.test(p.name));
      const finalSig = sigPins.length ? sigPins : collapsed.filter(p => !/^COM$/i.test(p.name));
      const cand = [...finalSig, ...comPins];
      const leftIdx = finalSig.map((_, i) => i);
      const topIdx = isAnode ? comPins.map((_, i) => finalSig.length + i) : [];
      const botIdx = isAnode ? [] : comPins.map((_, i) => finalSig.length + i);
      const box = pinSideMeta(part, opts, cand, leftIdx, [], topIdx, botIdx, '7-SEG');
      const remapped = box.pins.map(bp => ({ ...bp, partPinIndex: cand[bp.partPinIndex].partPinIndex, hideNum: cand[bp.partPinIndex].hideNum }));
      symbols.push({
        schId: part.id, partId: part.id, unit: null, ref: part.ref, value: part.value, type: part.type,
        w: box.w, h: box.h, pins: remapped, showValue, prunedCount: Math.max(0, part.pins.length - cand.length),
        bodyBox: { x0: 14, y0: 4, x1: box.w - 14, y1: box.h - 4 },
        renderSVG: (std, pal, showNums) => drawGenericBox({ ref: part.ref, value: part.value, w: box.w, h: box.h, pins: remapped, showValue }, pal, std, showNums, '7-SEG'),
      });
      continue;
    }

    // 13. DIP Switch Arrays (`dip4`, `dip8`) -> drive outputs on Right with switch glyphs
    if (part.type === 'dip4' || part.type === 'dip8') {
      const all = part.pins.map((p, idx) => ({ ...p, partPinIndex: idx, isPower: false }));
      const wired = hideUnwired ? all.filter(p => p.wired) : all;
      const cand = wired.length ? wired : all;
      const rightList = cand.map((_, i) => i);
      const box = pinSideMeta(part, opts, cand, [], rightList, [], [], part.shortName);
      const remapped = box.pins.map(bp => ({ ...bp, partPinIndex: cand[bp.partPinIndex].partPinIndex }));
      symbols.push({
        schId: part.id, partId: part.id, unit: null, ref: part.ref, value: part.value, type: part.type,
        w: box.w, h: box.h, pins: remapped, showValue, prunedCount: part.pins.length - cand.length,
        bodyBox: { x0: 14, y0: 4, x1: box.w - 14, y1: box.h - 4 },
        renderSVG: (std, pal, showNums) => drawGenericBox({ ref: part.ref, value: part.value, w: box.w, h: box.h, pins: remapped, showValue }, pal, std, showNums, part.shortName),
      });
      continue;
    }

    // 14. Multi-pin modules, MCUs, Displays, Trainer, Benchtop Instruments
    // Collapse redundant internally-linked header sockets first (e.g. 4x Trainer strips, tied Scope/PSU/FG GNDs)
    const collapsedPins = collapseLinkedPins(part.pins);
    let candPins = collapsedPins;
    if (hideUnwired && (part.type === 'trainer-board' || def?.cat === 'Instruments' || candPins.length >= 6)) {
      const connected = candPins.filter(p => p.wired);
      if (connected.length > 0) candPins = connected;
      else if (part.type === 'trainer-board') {
        const previewNames = new Set(['L0', 'S0', 'CLK', '+5V', 'GND']);
        candPins = candPins.filter(p => previewNames.has(p.name));
      } else {
        candPins = candPins.slice(0, Math.min(8, candPins.length));
      }
    }

    // Semantic pin classification: Supply (+V) -> Top, Ground (GND/-) -> Bottom, Signal -> Left/Right by function
    const topList = [], botList = [], sigIndices = [];
    candPins.forEach((p, i) => {
      if (isPosSupplyPinName(p.name) && topList.length < 4) topList.push(i);
      else if (isGndPinName(p.name) && botList.length < 4) botList.push(i);
      else sigIndices.push(i);
    });

    let leftList = [], rightList = [];
    const isSensorOrSource = def?.cat === 'Inputs' || part.type === 'trainer-board' || part.type === 'power-supply' || part.type === 'funcgen';
    const isDisplayOrSink = def?.cat === 'Outputs' || part.type === 'oscilloscope' || part.type === 'multimeter' || part.type === 'wokwi-logic-analyzer';
    if (part.type === 'funcgen') {
      for (const i of sigIndices) {
        if (/^(EXT|SWEEP)/i.test(candPins[i].name)) leftList.push(i);
        else rightList.push(i);
      }
    } else if (part.type === 'trainer-board') {
      rightList = [...sigIndices];
    } else if (def?.mcu) {
      for (const i of sigIndices) {
        const nm = String(candPins[i].name || '');
        if (/^(RST|RESET|AREF|RX|BOOT|EN|A\d)/i.test(nm)) leftList.push(i);
        else rightList.push(i);
      }
      if (rightList.length > 10 && leftList.length < 3) {
        const half = Math.ceil(sigIndices.length / 2);
        leftList = sigIndices.slice(0, half);
        rightList = sigIndices.slice(half);
      }
    } else if (isSensorOrSource) {
      rightList = [...sigIndices];
    } else if (isDisplayOrSink) {
      leftList = [...sigIndices];
    } else {
      const half = Math.ceil(sigIndices.length / 2);
      leftList = sigIndices.slice(0, half);
      rightList = sigIndices.slice(half);
    }

    const title = part.shortName;
    const box = pinSideMeta(part, opts, candPins, leftList, rightList, topList, botList, title);
    const remappedPins = box.pins.map(bp => ({
      ...bp,
      partPinIndex: candPins[bp.partPinIndex].partPinIndex,
      hideNum: candPins[bp.partPinIndex].hideNum,
    }));
    symbols.push({
      schId: part.id,
      partId: part.id,
      unit: null,
      ref: part.ref,
      value: part.value,
      type: part.type,
      w: box.w,
      h: box.h,
      pins: remappedPins,
      showValue,
      prunedCount: Math.max(0, collapsedPins.length - candPins.length),
      bodyBox: { x0: 14, y0: 4, x1: box.w - 14, y1: box.h - 4 },
      renderSVG: (std, pal, showNums) => drawGenericBox({ ref: part.ref, value: part.value, w: box.w, h: box.h, pins: remappedPins, showValue }, pal, std, showNums, title),
    });
  }

  return { symbols, unusedNotes };
}

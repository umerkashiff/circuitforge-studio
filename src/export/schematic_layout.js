/**
 * Topological Signal-Flow Auto-Layout & Manhattan A* Router for Vector Schematics.
 * Works purely on integer lattice coordinates (GRID = 20 px) with zero DOM dependencies.
 */
import { extractCircuitData } from './netlist.js';
import { SCH_GRID, buildSchematicSymbols } from './symbols.js';
import { getDef } from '../parts/registry.js';

const G = SCH_GRID; // 20 px
const BODY_COST = 2000;
const PIN_KEEPOUT = 60;
const SAME_NET_OVERLAP = 0;
const OTHER_WIRE_EDGE = 260;
const OTHER_WIRE_CROSS = 14;
const TURN_COST = 6;
const ADJ_LANE = 5;

const SOURCE_TYPES = new Set([
  'toggle', 'button', 'clock', 'dip4', 'dip8', 'slide', 'tactile',
  'pot', 'wokwi-slide-potentiometer', 'wokwi-analog-joystick',
  'funcgen', 'battery', 'power-supply', 'trainer-board',
  'wokwi-mpu6050', 'wokwi-ds1307', 'wokwi-bmp180',
]);
const SINK_TYPES = new Set([
  'led', 'wokwi-rgb-led', 'seg7', 'bargraph', 'buzzer',
  'lcd16x2', 'board-ssd1306', 'wokwi-sh1107', 'wokwi-lcd1602', 'wokwi-lcd2004',
  'oscilloscope', 'wokwi-logic-analyzer', 'wokwi-relay-module',
]);

class MinHeap {
  constructor() { this.a = []; }
  push(v, f) {
    const a = this.a; a.push([f, v]);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top[1];
  }
  get size() { return this.a.length; }
}

function snapG(px) { return Math.round(px / G) * G; }

function readSavedSch(part, unit) {
  if (!part || !part.sch) return null;
  if (unit && part.sch.units && part.sch.units[unit]) return part.sch.units[unit];
  if (!unit && Number.isFinite(part.sch.x) && Number.isFinite(part.sch.y)) return part.sch;
  return null;
}

function isPowerKind(netName, kind) {
  if (kind === 'power' || kind === 'gnd') return true;
  return /^(GND|VCC|\+5V|\+3\.3V|\+\d+V)$/i.test(String(netName || ''));
}

function assignColumns(symbols, edgesBySym, dataPartsById) {
  const col = new Map();
  const q = [];
  for (const s of symbols) {
    if (SOURCE_TYPES.has(s.type) || s.type === 'vcc' || s.type === 'gnd') {
      col.set(s.schId, 0);
      q.push(s.schId);
    }
  }
  // If no explicit sources (e.g. standalone gate or passive divider), seed left-most breadboard part as col 0
  if (!q.length && symbols.length) {
    const sorted = [...symbols].sort((a, b) => (dataPartsById.get(a.partId)?.x || 0) - (dataPartsById.get(b.partId)?.x || 0));
    col.set(sorted[0].schId, 0);
    q.push(sorted[0].schId);
  }

  // BFS propagation along directed/signal neighbors with hop cap to stay cycle-safe
  let head = 0;
  while (head < q.length) {
    const id = q[head++];
    const c = col.get(id);
    for (const nbr of edgesBySym.get(id) || []) {
      if (SINK_TYPES.has(nbr.sym.type)) continue; // place sinks in final layer later
      const step = nbr.dir === 1 ? 1 : (nbr.dir === 0 ? 1 : 0);
      if (!col.has(nbr.id) && step >= 0) {
        col.set(nbr.id, Math.min(8, c + step));
        q.push(nbr.id);
      } else if (nbr.dir === 1 && (col.get(nbr.id) || 0) < c + 1 && c < 7) {
        // Nudge purely downstream non-cyclic consumer forward one stage
        if (!SOURCE_TYPES.has(nbr.sym.type)) {
          col.set(nbr.id, c + 1);
          q.push(nbr.id);
        }
      }
    }
  }

  for (const s of symbols) {
    if (!col.has(s.schId) && !SINK_TYPES.has(s.type)) col.set(s.schId, 1);
  }
  const maxMid = symbols.filter(s => !SINK_TYPES.has(s.type)).reduce((m, s) => Math.max(m, col.get(s.schId) ?? 0), 0);
  const sinkCol = maxMid + 1;
  for (const s of symbols) {
    if (SINK_TYPES.has(s.type)) col.set(s.schId, sinkCol);
  }
  return col;
}

function routeOrthogonal(grid, sx, sy, sDir, gx, gy, gDir, sameNetEdges, sameNetNodes, otherEdges, otherNodes) {
  const { x0, y0, W, H, cost } = grid;
  const at = (x, y) => (y - y0) * W + (x - x0);
  const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  if (sx < x0 || sx >= x0 + W || sy < y0 || sy >= y0 + H || gx < x0 || gx >= x0 + W || gy < y0 || gy >= y0 + H) {
    return [{ x: sx * G, y: sy * G }, { x: gx * G, y: sy * G }, { x: gx * G, y: gy * G }];
  }
  const N = W * H * 5;
  const gScore = new Float32Array(N).fill(Infinity);
  const from = new Int32Array(N).fill(-1);
  const heap = new MinHeap();
  const sIdx = at(sx, sy) * 5 + 4;
  gScore[sIdx] = 0;
  heap.push(sIdx, Math.abs(sx - gx) + Math.abs(sy - gy));
  const goalCell = at(gx, gy);
  let endState = -1, guard = 0;

  while (heap.size && guard++ < 120000) {
    const s = heap.pop();
    const cell = (s / 5) | 0, d = s % 5;
    if (cell === goalCell) { endState = s; break; }
    const cx = (cell % W) + x0, cy = ((cell / W) | 0) + y0;

    for (let nd = 0; nd < 4; nd++) {
      if (d !== 4 && (nd + 2) % 4 === d) continue;
      const nx = cx + DIRS[nd][0], ny = cy + DIRS[nd][1];
      if (nx < x0 || nx >= x0 + W || ny < y0 || ny >= y0 + H) continue;
      const nc = at(nx, ny);
      const ek = cx < nx || cy < ny ? `${cx},${cy},${nx},${ny}` : `${nx},${ny},${cx},${cy}`;
      const isEndpointCell = (nx === gx && ny === gy) || (cx === sx && cy === sy);
      let step = 1 + (isEndpointCell ? 0 : cost[nc]);
      if (d !== 4 && d !== nd) step += TURN_COST;
      // Nudge initial step out along pin's natural facing direction
      if (d === 4 && sDir >= 0 && nd !== sDir) step += 10;
      if (nx === gx && ny === gy && gDir >= 0 && (nd + 2) % 4 !== gDir) step += 4;

      if (sameNetEdges.has(ek)) step = 0.25;
      else if (otherEdges.has(ek)) step += OTHER_WIRE_EDGE;
      else if (otherNodes.has(`${nx},${ny}`)) step += OTHER_WIRE_CROSS;

      const ns = nc * 5 + nd;
      const ng = gScore[s] + step;
      if (ng < gScore[ns]) {
        gScore[ns] = ng;
        from[ns] = s;
        heap.push(ns, ng + Math.abs(nx - gx) + Math.abs(ny - gy));
      }
    }
  }

  if (endState < 0) {
    // Clean orthogonal L/Z fallback
    const midX = Math.round((sx + gx) / 2);
    return [{ x: sx * G, y: sy * G }, { x: midX * G, y: sy * G }, { x: midX * G, y: gy * G }, { x: gx * G, y: gy * G }];
  }

  const cells = [];
  for (let s = endState; s >= 0; s = from[s]) cells.push((s / 5) | 0);
  cells.reverse();
  const fullPts = cells.map(c => ({ x: ((c % W) + x0) * G, y: (((c / W) | 0) + y0) * G }));
  const corners = [fullPts[0]];
  for (let i = 1; i < fullPts.length - 1; i++) {
    const a = fullPts[i - 1], b = fullPts[i], c = fullPts[i + 1];
    if ((b.x - a.x) * (c.y - b.y) !== (b.y - a.y) * (c.x - b.x)) corners.push(b);
  }
  corners.push(fullPts[fullPts.length - 1]);
  return corners;
}

const SIDE_DIR = { R: 0, B: 1, L: 2, T: 3 };

/**
 * Compute full vector schematic layout: positioned symbols, local power/net flags,
 * Manhattan wire polylines, junction solder dots, and crossing hop locations.
 */
export function computeSchematicLayout(circuit, engine = null, index = null, opts = {}) {
  const {
    viewMode = 'functional',
    powerStyle = 'symbols', // 'symbols' | 'rails'
    hideUnwired = true,
    showValues = true,
    useNetFlags = true,
    crossingHops = true,
  } = opts;

  const data = extractCircuitData(circuit, engine, index);
  const netMetaMap = new Map(data.nets.map(n => [n.id, n]));
  const partOrigMap = new Map((circuit.parts || []).map(p => [p.id, p]));
  const dataPartMap = new Map(data.parts.map(p => [p.id, p]));

  const { symbols: rawSymbols, unusedNotes } = buildSchematicSymbols(data, { viewMode, hideUnwired, showValues });

  // Identify connected pin lists per net across expanded symbols
  const symById = new Map();
  for (const s of rawSymbols) symById.set(s.schId, s);

  // Filter standalone vcc/gnd origin blocks when using power symbols cleanly if their net already attaches elsewhere
  const netPinOccurrences = new Map();
  for (const s of rawSymbols) {
    for (const p of s.pins) {
      if (p.net < 0 || !p.netName) continue;
      if (!netPinOccurrences.has(p.net)) netPinOccurrences.set(p.net, []);
      netPinOccurrences.get(p.net).push({ sym: s, pin: p });
    }
  }

  const symbols = rawSymbols.filter((s) => {
    if (!s.isSupplyOrigin || powerStyle !== 'symbols') return true;
    const n = s.pins[0]?.net;
    const occ = netPinOccurrences.get(n) || [];
    // Omit bare VCC1/GND1 supply block whenever another component uses that power net cleanly via power symbols
    return occ.length <= 1;
  });

  // Build bipartite adjacency between remaining symbols on non-power nets (plus rail->load for column depth)
  const edgesBySym = new Map();
  for (const s of symbols) edgesBySym.set(s.schId, []);
  const symPinNets = new Map();
  for (const s of symbols) {
    for (const p of s.pins) {
      if (p.net < 0 || !p.netName) continue;
      if (!symPinNets.has(p.net)) symPinNets.set(p.net, []);
      symPinNets.get(p.net).push({ sym: s, pin: p });
    }
  }

  const netKind = (netId) => {
    const nm = netMetaMap.get(netId);
    return isPowerKind(nm?.name, nm?.kind) ? (nm?.kind === 'gnd' || nm?.name === 'GND' ? 'gnd' : 'power') : 'signal';
  };

  for (const [netId, list] of symPinNets) {
    if (netKind(netId) !== 'signal' || list.length < 2) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        if (a.sym === b.sym) continue;
        const aOut = a.pin.side === 'R' || SOURCE_TYPES.has(a.sym.type);
        const bOut = b.pin.side === 'R' || SOURCE_TYPES.has(b.sym.type);
        let dirAB = 0;
        if (aOut && !bOut) dirAB = 1;
        else if (bOut && !aOut) dirAB = -1;
        edgesBySym.get(a.sym.schId).push({ id: b.sym.schId, sym: b.sym, dir: dirAB });
        edgesBySym.get(b.sym.schId).push({ id: a.sym.schId, sym: a.sym, dir: -dirAB });
      }
    }
  }

  // Assign columns and perform 3 passes of barycenter sorting within each column
  const colOf = assignColumns(symbols, edgesBySym, dataPartMap);
  const colsMap = new Map();
  for (const s of symbols) {
    const c = colOf.get(s.schId) ?? 0;
    if (!colsMap.has(c)) colsMap.set(c, []);
    colsMap.get(c).push(s);
  }
  const colKeys = [...colsMap.keys()].sort((a, b) => a - b);

  // Initial vertical seed sorted by breadboard Y so original physical grouping stays natural
  const orderIndex = new Map();
  for (const c of colKeys) {
    const arr = colsMap.get(c);
    arr.sort((a, b) => (dataPartMap.get(a.partId)?.y || 0) - (dataPartMap.get(b.partId)?.y || 0) || (a.unit || '').localeCompare(b.unit || ''));
    arr.forEach((s, idx) => orderIndex.set(s.schId, idx));
  }

  for (let sweep = 0; sweep < 3; sweep++) {
    for (const c of colKeys) {
      const arr = colsMap.get(c);
      arr.sort((a, b) => {
        const score = (s) => {
          const nbrs = edgesBySym.get(s.schId) || [];
          if (!nbrs.length) return orderIndex.get(s.schId) || 0;
          return nbrs.reduce((acc, n) => acc + (orderIndex.get(n.id) ?? 0), 0) / nbrs.length;
        };
        return score(a) - score(b);
      });
      arr.forEach((s, idx) => orderIndex.set(s.schId, idx));
    }
  }

  // Position columns & rows on GRID = 20 preserving clear margins for local power ports, flags & labels
  const symPortsMeta = new Map();
  for (const s of symbols) {
    const info = { L: false, R: false, T: false, B: false, lf: false, rf: false };
    for (const p of s.pins) {
      if (p.net < 0 || !p.netName) continue;
      const k = netKind(p.net);
      if (powerStyle === 'symbols' && (k === 'power' || k === 'gnd')) info[p.side] = true;
      else if (powerStyle !== 'rails' && useNetFlags) {
        const list = symPinNets.get(p.net) || [];
        const netCols = new Set(list.map(it => colOf.get(it.sym.schId)));
        if (list.length >= 5 && netCols.size >= 3) {
          if (p.side === 'L') info.lf = true;
          if (p.side === 'R') info.rf = true;
        }
      }
    }
    symPortsMeta.set(s.schId, info);
  }

  let curX = 140;
  const startY = powerStyle === 'rails' ? 140 : 100;
  for (const c of colKeys) {
    const arr = colsMap.get(c);
    const maxW = Math.max(80, ...arr.map(s => s.w));
    const maxLeft = Math.max(40, ...arr.map(s => (symPortsMeta.get(s.schId)?.lf ? 80 : symPortsMeta.get(s.schId)?.L ? 60 : 20)));
    const maxRight = Math.max(40, ...arr.map(s => (symPortsMeta.get(s.schId)?.rf ? 80 : symPortsMeta.get(s.schId)?.R ? 60 : 20)));
    if (c !== colKeys[0]) curX += Math.max(40, maxLeft - 20);
    let curY = startY;
    for (const s of arr) {
      const pm = symPortsMeta.get(s.schId);
      const topExtra = pm.T ? 60 : s.pins.some(p => p.side === 'T') ? 40 : 20;
      const botExtra = pm.B ? 60 : s.pins.some(p => p.side === 'B') ? 40 : 20;
      curY += topExtra;
      s.x = snapG(curX + (maxW - s.w) / 2);
      s.y = snapG(curY);
      const orig = partOrigMap.get(s.partId);
      const saved = readSavedSch(orig, s.unit);
      if (saved) {
        s.x = snapG(saved.x);
        s.y = snapG(saved.y);
        s._pinned = true;
      }
      curY += s.h + botExtra + 20;
    }
    curX += snapG(maxW + Math.max(120, 80 + maxRight));
  }

  // Push non-pinned symbols gently clear if a pinned manual drag overlaps a neighbor
  const padBox = (s) => ({ x0: s.x - 20, y0: s.y - 20, x1: s.x + s.w + 20, y1: s.y + s.h + 20 });
  const hitsBox = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
  const sortedForPush = [...symbols].sort((a, b) => (b._pinned ? 1 : 0) - (a._pinned ? 1 : 0) || a.y - b.y || a.x - b.x);
  const placedBoxes = [];
  for (const s of sortedForPush) {
    if (!s._pinned) {
      let guard = 0;
      while (placedBoxes.some(b => hitsBox(padBox(s), b)) && guard++ < 40) {
        s.y = snapG(s.y + 40);
      }
    }
    placedBoxes.push(padBox(s));
  }

  // Build world pin coords + classify nets into routed vs consolidated powerSymbols vs netFlags
  const symWorldPin = (s, p) => ({ ...p, x: s.x + p.lx, y: s.y + p.ly, sym: s });
  const routedNetList = [];
  const rawPowerPins = [];
  const netFlags = [];

  for (const [netId, list] of symPinNets) {
    const nm = netMetaMap.get(netId);
    const name = nm?.name || `N${netId}`;
    const kind = netKind(netId);
    const netCols = new Set(list.map(it => colOf.get(it.sym.schId)));

    // 1. Power / GND symbols mode -> gather for per-side consolidation
    if (powerStyle === 'symbols' && (kind === 'power' || kind === 'gnd')) {
      for (const it of list) {
        const wp = symWorldPin(it.sym, it.pin);
        rawPowerPins.push({
          netId, netName: name, kind,
          x: wp.x, y: wp.y, side: wp.side,
          schId: it.sym.schId,
        });
      }
      continue;
    }

    // 2. High-fanout clock / bus conversion to matching Net Flags when beneficial
    if (powerStyle !== 'rails' && useNetFlags && kind === 'signal' && list.length >= 5 && netCols.size >= 3) {
      for (const it of list) {
        const wp = symWorldPin(it.sym, it.pin);
        netFlags.push({ netId, netName: name, x: wp.x, y: wp.y, side: wp.side, schId: it.sym.schId });
      }
      continue;
    }

    routedNetList.push({ netId, name, kind, pins: list.map(it => symWorldPin(it.sym, it.pin)) });
  }

  // Consolidate adjacent same-side, same-net power/GND pins on each symbol via clean trunk bus + 1 shared symbol!
  const powerPorts = [];
  const powerTrunks = [];
  const powerGroupMap = new Map();
  for (const rp of rawPowerPins) {
    const gk = `${rp.schId}|${rp.side}|${rp.netId}`;
    if (!powerGroupMap.has(gk)) powerGroupMap.set(gk, []);
    powerGroupMap.get(gk).push(rp);
  }
  for (const group of powerGroupMap.values()) {
    if (group.length === 1) {
      powerPorts.push(group[0]);
      continue;
    }
    const { netId, netName, kind, side, schId } = group[0];
    if (side === 'L' || side === 'R') {
      const dir = side === 'L' ? -20 : 20;
      const trunkX = snapG(group[0].x + dir);
      const ys = group.map(p => p.y).sort((a, b) => a - b);
      for (const p of group) powerTrunks.push({ netId, kind, netName, pts: [{ x: p.x, y: p.y }, { x: trunkX, y: p.y }] });
      powerTrunks.push({ netId, kind, netName, pts: [{ x: trunkX, y: ys[0] }, { x: trunkX, y: ys[ys.length - 1] }] });
      const portY = kind === 'gnd' ? ys[ys.length - 1] : ys[0];
      powerPorts.push({ netId, netName, kind, x: trunkX, y: portY, side, schId });
    } else {
      const dir = side === 'T' ? -20 : 20;
      const trunkY = snapG(group[0].y + dir);
      const xs = group.map(p => p.x).sort((a, b) => a - b);
      for (const p of group) powerTrunks.push({ netId, kind, netName, pts: [{ x: p.x, y: p.y }, { x: p.x, y: trunkY }] });
      powerTrunks.push({ netId, kind, netName, pts: [{ x: xs[0], y: trunkY }, { x: xs[xs.length - 1], y: trunkY }] });
      const portX = snapG((xs[0] + xs[xs.length - 1]) / 2);
      powerPorts.push({ netId, netName, kind, x: portX, y: trunkY, side, schId });
    }
  }

  // Compute grid routing domain tightly wrapping all symbols + power ports + generous gutter
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const s of symbols) {
    bx0 = Math.min(bx0, s.x - 120); by0 = Math.min(by0, s.y - 120);
    bx1 = Math.max(bx1, s.x + s.w + 120); by1 = Math.max(by1, s.y + s.h + 120);
  }
  for (const pp of powerPorts) {
    bx0 = Math.min(bx0, pp.x - 60); by0 = Math.min(by0, pp.y - 60);
    bx1 = Math.max(bx1, pp.x + 60); by1 = Math.max(by1, pp.y + 60);
  }
  if (!Number.isFinite(bx0)) { bx0 = 0; by0 = 0; bx1 = 480; by1 = 320; }
  const gx0 = Math.floor(bx0 / G), gy0 = Math.floor(by0 / G);
  const gx1 = Math.ceil(bx1 / G), gy1 = Math.ceil(by1 / G);
  const gW = gx1 - gx0 + 1, gH = gy1 - gy0 + 1;
  const cost = new Float32Array(gW * gH);
  const at = (x, y) => (y - gy0) * gW + (x - gx0);
  const paintCostRect = (x0Px, y0Px, x1Px, y1Px, val) => {
    const cx0 = Math.max(gx0, Math.ceil(x0Px / G)), cx1 = Math.min(gx1, Math.floor(x1Px / G));
    const cy0 = Math.max(gy0, Math.ceil(y0Px / G)), cy1 = Math.min(gy1, Math.floor(y1Px / G));
    for (let y = cy0; y <= cy1; y++) for (let x = cx0; x <= cx1; x++) cost[at(x, y)] += val;
  };

  for (const s of symbols) {
    const b = s.bodyBox || { x0: 10, y0: 4, x1: s.w - 10, y1: s.h - 4 };
    paintCostRect(s.x + b.x0, s.y + b.y0 - 16, s.x + b.x1, s.y + b.y1, BODY_COST);
  }
  // Keep signal wires clear of power port geometry/text & net flag boxes
  for (const pp of powerPorts) {
    if (pp.kind === 'gnd') paintCostRect(pp.x - 16, pp.y + 4, pp.x + 16, pp.y + 36, BODY_COST * 0.45);
    else paintCostRect(pp.x - 16, pp.y - 36, pp.x + 16, pp.y - 4, BODY_COST * 0.45);
  }
  for (const nf of netFlags) {
    const dir = nf.side === 'L' ? -1 : 1;
    paintCostRect(Math.min(nf.x, nf.x + dir * 60), nf.y - 12, Math.max(nf.x, nf.x + dir * 60), nf.y + 12, BODY_COST * 0.45);
  }
  // Pin entry points must always stay strictly routable
  for (const s of symbols) {
    for (const p of s.pins) {
      const px = Math.round((s.x + p.lx) / G), py = Math.round((s.y + p.ly) / G);
      if (px >= gx0 && px <= gx1 && py >= gy0 && py <= gy1) cost[at(px, py)] = 0;
    }
  }

  const grid = { x0: gx0, y0: gy0, W: gW, H: gH, cost };
  const otherEdges = new Set(), otherNodes = new Set();
  const routes = [];

  // Handle Power Rails mode cleanly: explicit top +V bus line and bottom GND bus line
  const topRailY = snapG(by0 + 40);
  const botRailY = snapG(by1 - 40);

  const registerPolylineEdges = (pts, edgeSet, nodeSet) => {
    for (let k = 0; k < pts.length - 1; k++) {
      let x = Math.round(pts[k].x / G), y = Math.round(pts[k].y / G);
      const x1 = Math.round(pts[k + 1].x / G), y1 = Math.round(pts[k + 1].y / G);
      const dx = Math.sign(x1 - x), dy = Math.sign(y1 - y);
      while (x !== x1 || y !== y1) {
        const nx = x + dx, ny = y + dy;
        edgeSet.add(x < nx || y < ny ? `${x},${y},${nx},${ny}` : `${nx},${ny},${x},${y}`);
        nodeSet.add(`${x},${y}`);
        x = nx; y = ny;
      }
      nodeSet.add(`${x},${y}`);
    }
  };

  // Paint consolidated power trunks onto adjacent edge deterrent before signal nets route
  for (const pt of powerTrunks) {
    registerPolylineEdges(pt.pts, otherEdges, otherNodes);
  }

  // Route short nets first so local loops stay tight and parallel buses spread cleanly into adjacent channels
  const netSpan = (rn) => {
    const xs = rn.pins.map(p => p.x), ys = rn.pins.map(p => p.y);
    return (Math.max(...xs) - Math.min(...xs)) + (Math.max(...ys) - Math.min(...ys));
  };
  const orderedNets = [...routedNetList].sort((a, b) => netSpan(a) - netSpan(b) || a.pins.length - b.pins.length);

  for (const rnet of orderedNets) {
    if (rnet.pins.length < 2) continue;
    if (powerStyle === 'rails' && (rnet.kind === 'power' || rnet.kind === 'gnd')) {
      const ry = rnet.kind === 'gnd' ? botRailY : topRailY;
      const goalY = Math.round(ry / G);
      const gDir = rnet.kind === 'gnd' ? 3 : 1;
      const sameNetEdges = new Set(), sameNetNodes = new Set();
      const railXs = [];
      const polylines = [];
      for (const p of rnet.pins) {
        const px = Math.round(p.x / G), py = Math.round(p.y / G);
        if (py === goalY) { railXs.push(p.x); continue; }
        const pts = routeOrthogonal(
          grid,
          px, py, SIDE_DIR[p.side] ?? -1,
          px, goalY, gDir,
          sameNetEdges, sameNetNodes, otherEdges, otherNodes,
        );
        polylines.push(pts);
        registerPolylineEdges(pts, sameNetEdges, sameNetNodes);
        const endPt = pts[pts.length - 1];
        if (endPt) railXs.push(endPt.x);
      }
      if (railXs.length >= 2) {
        const minX = Math.min(...railXs);
        const maxX = Math.max(...railXs);
        if (maxX > minX) {
          const bar = [{ x: minX, y: ry }, { x: maxX, y: ry }];
          polylines.unshift(bar);
          registerPolylineEdges(bar, sameNetEdges, sameNetNodes);
        }
      }
      for (const ek of sameNetEdges) otherEdges.add(ek);
      for (const nk of sameNetNodes) otherNodes.add(nk);
      routes.push({ ...rnet, polylines });
      continue;
    }

    const polylines = [];
    const sameNetEdges = new Set(), sameNetNodes = new Set();
    // Deterministic nearest-neighbor tree across all connected pins of the net
    const connected = [rnet.pins[0]];
    const remaining = rnet.pins.slice(1);
    while (remaining.length) {
      let bestPair = null, bestDist = Infinity, remIdx = 0;
      for (let ri = 0; ri < remaining.length; ri++) {
        const cand = remaining[ri];
        for (const tgt of connected) {
          const d = Math.abs(cand.x - tgt.x) + Math.abs(cand.y - tgt.y);
          if (d < bestDist) { bestDist = d; bestPair = { a: cand, b: tgt }; remIdx = ri; }
        }
      }
      const nextPin = remaining.splice(remIdx, 1)[0];
      const { a, b } = bestPair;
      const pts = routeOrthogonal(
        grid,
        Math.round(a.x / G), Math.round(a.y / G), SIDE_DIR[a.side] ?? -1,
        Math.round(b.x / G), Math.round(b.y / G), SIDE_DIR[b.side] ?? -1,
        sameNetEdges, sameNetNodes, otherEdges, otherNodes,
      );
      polylines.push(pts);
      registerPolylineEdges(pts, sameNetEdges, sameNetNodes);
      connected.push(nextPin);
    }

    for (const ek of sameNetEdges) otherEdges.add(ek);
    for (const nk of sameNetNodes) otherNodes.add(nk);
    // Lightly discourage parallel signal tracks from running right beside an existing wire corner
    for (const poly of polylines) {
      for (let k = 0; k < poly.length - 1; k++) {
        const ax = Math.round(poly[k].x / G), ay = Math.round(poly[k].y / G);
        const bx = Math.round(poly[k + 1].x / G), by = Math.round(poly[k + 1].y / G);
        if (ax === bx) {
          const yLo = Math.min(ay, by), yHi = Math.max(ay, by);
          for (let y = yLo; y <= yHi; y++) {
            for (const dx of [-1, 1]) {
              const nx = ax + dx;
              if (nx >= gx0 && nx <= gx1 && y >= gy0 && y <= gy1 && cost[at(nx, y)] < BODY_COST) cost[at(nx, y)] += ADJ_LANE;
            }
          }
        }
      }
    }
    routes.push({ ...rnet, polylines });
  }

  // Add trunk junctions where multiple consolidated power pins tie together
  const segSourceRoutes = [...routes];
  if (powerTrunks.length) {
    const trunkMap = new Map();
    for (const tr of powerTrunks) {
      if (!trunkMap.has(tr.netId)) trunkMap.set(tr.netId, { netId: tr.netId, name: tr.netName, kind: tr.kind, polylines: [] });
      trunkMap.get(tr.netId).polylines.push(tr.pts);
    }
    for (const r of trunkMap.values()) segSourceRoutes.push(r);
  }

  // Compute Solder Junction Dots (where >=3 distinct segments meet on the same net) & Crossing Hops
  const segmentsByNet = [];
  const junctions = [];
  for (const r of segSourceRoutes) {
    const segs = [];
    const ptDegree = new Map();
    const bump = (x, y) => {
      const k = `${x},${y}`;
      ptDegree.set(k, (ptDegree.get(k) || 0) + 1);
    };
    for (const poly of r.polylines) {
      for (let i = 0; i < poly.length - 1; i++) {
        const a = poly[i], b = poly[i + 1];
        if (a.x === b.x && a.y === b.y) continue;
        segs.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, horiz: a.y === b.y, vert: a.x === b.x });
        bump(a.x, a.y);
        bump(b.x, b.y);
      }
    }
    // Check T-junctions where a vertex lands strictly in the middle of another segment on the same net
    for (const s of segs) {
      for (const ep of [[s.x1, s.y1], [s.x2, s.y2]]) {
        for (const o of segs) {
          if (o === s) continue;
          if (o.horiz && ep[1] === o.y1 && ep[0] > Math.min(o.x1, o.x2) && ep[0] < Math.max(o.x1, o.x2)) bump(ep[0], ep[1]);
          if (o.vert && ep[0] === o.x1 && ep[1] > Math.min(o.y1, o.y2) && ep[1] < Math.max(o.y1, o.y2)) bump(ep[0], ep[1]);
        }
      }
    }
    for (const [k, deg] of ptDegree) {
      if (deg >= 3) {
        const [x, y] = k.split(',').map(Number);
        junctions.push({ netId: r.netId, kind: r.kind, netName: r.name, x, y });
      }
    }
    segmentsByNet.push({ netId: r.netId, name: r.name, kind: r.kind, segs });
  }

  const crossings = [];
  if (crossingHops) {
    for (let i = 0; i < segmentsByNet.length; i++) {
      for (let j = i + 1; j < segmentsByNet.length; j++) {
        const A = segmentsByNet[i], B = segmentsByNet[j];
        for (const s1 of A.segs) {
          for (const s2 of B.segs) {
            let hSeg = null, vSeg = null;
            if (s1.horiz && s2.vert) { hSeg = s1; vSeg = s2; }
            else if (s2.horiz && s1.vert) { hSeg = s2; vSeg = s1; }
            if (!hSeg) continue;
            const hx0 = Math.min(hSeg.x1, hSeg.x2), hx1 = Math.max(hSeg.x1, hSeg.x2);
            const vy0 = Math.min(vSeg.y1, vSeg.y2), vy1 = Math.max(vSeg.y1, vSeg.y2);
            if (vSeg.x1 > hx0 + 6 && vSeg.x1 < hx1 - 6 && hSeg.y1 > vy0 + 6 && hSeg.y1 < vy1 - 6) {
              crossings.push({ x: vSeg.x1, y: hSeg.y1, hNetId: (hSeg === s1 ? A : B).netId });
            }
          }
        }
      }
    }
  }

  // Tight schematic content bounds
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (ax, ay, bx, by) => {
    minX = Math.min(minX, ax); minY = Math.min(minY, ay);
    maxX = Math.max(maxX, bx); maxY = Math.max(maxY, by);
  };
  for (const s of symbols) grow(s.x - 16, s.y - 24, s.x + s.w + 16, s.y + s.h + 24);
  for (const r of routes) for (const poly of r.polylines) for (const pt of poly) grow(pt.x - 10, pt.y - 10, pt.x + 10, pt.y + 10);
  for (const pp of powerPorts) grow(pp.x - 24, pp.y - 34, pp.x + 24, pp.y + 38);
  for (const tr of powerTrunks) for (const pt of tr.pts) grow(pt.x - 10, pt.y - 10, pt.x + 10, pt.y + 10);
  for (const nf of netFlags) grow(nf.x - 50, nf.y - 15, nf.x + 50, nf.y + 15);
  if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = 480; maxY = 300; }

  return {
    data,
    symbols,
    unusedNotes,
    powerPorts,
    powerTrunks,
    netFlags,
    routes,
    segmentsByNet,
    junctions,
    crossings,
    bounds: { x0: minX, y0: minY, x1: maxX, y1: maxY, w: maxX - minX, h: maxY - minY },
  };
}

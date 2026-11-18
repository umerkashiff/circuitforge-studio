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

  // Position columns & rows on GRID = 20 with generous routing gutters
  let curX = 120;
  const startY = powerStyle === 'rails' ? 140 : 100;
  for (const c of colKeys) {
    const arr = colsMap.get(c);
    const maxW = Math.max(80, ...arr.map(s => s.w));
    let curY = startY;
    for (const s of arr) {
      const topExtra = s.pins.some(p => p.side === 'T') ? 40 : 20;
      const botExtra = s.pins.some(p => p.side === 'B') ? 40 : 20;
      curY += topExtra;
      s.x = snapG(curX + (maxW - s.w) / 2);
      s.y = snapG(curY);
      // Honor persisted interactive schematic nudge if saved
      const orig = partOrigMap.get(s.partId);
      const saved = readSavedSch(orig, s.unit);
      if (saved) {
        s.x = snapG(saved.x);
        s.y = snapG(saved.y);
      }
      curY += s.h + botExtra + 20;
    }
    curX += snapG(maxW + 120);
  }

  // Build world pin coords + classify nets into routed vs powerSymbols vs netFlags
  const symWorldPin = (s, p) => ({ ...p, x: s.x + p.lx, y: s.y + p.ly, sym: s });
  const routedNetList = [];
  const powerPorts = [];
  const netFlags = [];

  for (const [netId, list] of symPinNets) {
    const nm = netMetaMap.get(netId);
    const name = nm?.name || `N${netId}`;
    const kind = netKind(netId);
    const netCols = new Set(list.map(it => colOf.get(it.sym.schId)));

    // 1. Power / GND symbols mode -> crisp local VCC/GND stubs right on each connected pin
    if (powerStyle === 'symbols' && (kind === 'power' || kind === 'gnd')) {
      for (const it of list) {
        const wp = symWorldPin(it.sym, it.pin);
        powerPorts.push({
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

  // Compute grid routing domain tightly wrapping all symbols + 8-cell gutter
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const s of symbols) {
    bx0 = Math.min(bx0, s.x - 100); by0 = Math.min(by0, s.y - 100);
    bx1 = Math.max(bx1, s.x + s.w + 100); by1 = Math.max(by1, s.y + s.h + 100);
  }
  if (!Number.isFinite(bx0)) { bx0 = 0; by0 = 0; bx1 = 480; by1 = 320; }
  const gx0 = Math.floor(bx0 / G), gy0 = Math.floor(by0 / G);
  const gx1 = Math.ceil(bx1 / G), gy1 = Math.ceil(by1 / G);
  const gW = gx1 - gx0 + 1, gH = gy1 - gy0 + 1;
  const cost = new Float32Array(gW * gH);
  const at = (x, y) => (y - gy0) * gW + (x - gx0);

  for (const s of symbols) {
    const b = s.bodyBox || { x0: 10, y0: 4, x1: s.w - 10, y1: s.h - 4 };
    const sx0 = Math.ceil((s.x + b.x0) / G), sx1 = Math.floor((s.x + b.x1) / G);
    const sy0 = Math.ceil((s.y + b.y0) / G), sy1 = Math.floor((s.y + b.y1) / G);
    for (let y = Math.max(gy0, sy0); y <= Math.min(gy1, sy1); y++) {
      for (let x = Math.max(gx0, sx0); x <= Math.min(gx1, sx1); x++) cost[at(x, y)] += BODY_COST;
    }
    // Pin entry points must always stay routable
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

  for (const rnet of routedNetList) {
    if (rnet.pins.length < 2) continue;
    if (powerStyle === 'rails' && (rnet.kind === 'power' || rnet.kind === 'gnd')) {
      const ry = rnet.kind === 'gnd' ? botRailY : topRailY;
      const minX = Math.min(...rnet.pins.map(p => p.x));
      const maxX = Math.max(...rnet.pins.map(p => p.x));
      const polylines = [];
      if (maxX > minX) polylines.push([{ x: minX, y: ry }, { x: maxX, y: ry }]);
      for (const p of rnet.pins) {
        if (p.y !== ry) polylines.push([{ x: p.x, y: p.y }, { x: p.x, y: ry }]);
      }
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
    routes.push({ ...rnet, polylines });
  }

  // Compute Solder Junction Dots (where >=3 distinct segments meet on the same net) & Crossing Hops
  const segmentsByNet = [];
  const junctions = [];
  for (const r of routes) {
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
  for (const pp of powerPorts) grow(pp.x - 24, pp.y - 30, pp.x + 24, pp.y + 30);
  for (const nf of netFlags) grow(nf.x - 45, nf.y - 15, nf.x + 45, nf.y + 15);
  if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = 480; maxY = 300; }

  return {
    data,
    symbols,
    unusedNotes,
    powerPorts,
    netFlags,
    routes,
    segmentsByNet,
    junctions,
    crossings,
    bounds: { x0: minX, y0: minY, x1: maxX, y1: maxY, w: maxX - minX, h: maxY - minY },
  };
}

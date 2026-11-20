/**
 * Marek Borik's COMP 400 / Ben Eater SAP-1 8-bit Breadboard CPU (14 Full Breadboards).
 * Modular board builders allow standalone per-board verification before full CPU integration.
 */
import { Board, Circuit, Part, Wire } from '../model.js';
import { ensureDesignators } from '../export/designators.js';
import { SAP1_PROGRAMS, nibblesToHex } from '../parts/sap1_roms.js';

const R = '#e5484d', K = '#2b2d31', B = '#0a84ff', G = '#30a46c', Y = '#f5c400', O = '#ff8a00', P = '#8e4ec6', W = '#f2f2f7';
const ptVal = (v) => (typeof v === 'function' ? v() : v);
function wireList(rig, aList, bList, color = G) {
  for (let i = 0; i < Math.min(aList.length, bList.length); i++) {
    rig.wire(ptVal(aList[i]), ptVal(bList[i]), color);
  }
}

const TRANSCEIVER_A = [2, 3, 4, 5, 6, 7, 8, 9];
const TRANSCEIVER_B = [18, 17, 16, 15, 14, 13, 12, 11];
const REG173_D = [14, 13, 12, 11];
const REG173_Q = [3, 4, 5, 6];
const MUX157_A = [2, 5, 11, 14];
const MUX157_B = [3, 6, 10, 13];
const MUX157_Y = [4, 7, 9, 12];
const ADDER_A = [5, 3, 14, 12];
const ADDER_B = [6, 2, 15, 11];
const ADDER_S = [4, 1, 13, 10];
const REG273_D = [3, 4, 7, 8, 13, 14, 17, 18];
const REG273_Q = [2, 5, 6, 9, 12, 15, 16, 19];
const ROM_A = [8, 7, 6, 5, 4, 3, 2, 1, 23, 22, 19];
const ROM_D = [9, 10, 11, 13, 14, 15, 16, 17];
const SEG7X4_SEGS = [11, 7, 4, 2, 1, 10, 5, 3]; // a, b, c, d, e, f, g, DP
const SEG7X4_DIGS = [12, 9, 8, 6];             // D1..D4 (leftmost..rightmost)

export class BoardRig {
  constructor(circuit, board) {
    this.c = circuit;
    this.b = board;
    this.used = new Set();
    this._railPtr = { tp: 0, tn: 0, bp: 0, bn: 0 };
  }
  _k(x, y) { return x + ',' + y; }
  markUsed(x, y) { this.used.add(this._k(x, y)); }
  isUsed(x, y) { return this.used.has(this._k(x, y)); }
  addPart(type, x, y, rot = 0, props = null, ref = '') {
    const p = new Part(type, x, y, rot, props, undefined, ref);
    for (const q of p.worldPins()) {
      if (!p.def.allowSharedPin && this.isUsed(q.x, q.y)) {
        throw new Error(`Hole collision adding ${type} at (${q.x},${q.y}) on ${this.b.id}`);
      }
    }
    for (const q of p.worldPins()) {
      if (!p.def.allowSharedPin) this.markUsed(q.x, q.y);
    }
    this.c.parts.push(p);
    return p;
  }
  wire(a, b, color = G, label = '') {
    const w = new Wire({ x: a.x, y: a.y }, { x: b.x, y: b.y }, color, [], undefined, label);
    this.c.wires.push(w);
    return w;
  }
  stripPt(col, bank) {
    const bx = this.b.x + 2, by = this.b.y;
    const ys = bank === 't' ? [4, 3, 2, 1, 0] : [5, 6, 7, 8, 9];
    for (const r of ys) {
      const x = bx + col, y = by + this.b.rowY(r);
      if (!this.isUsed(x, y)) { this.markUsed(x, y); return { x, y }; }
    }
    throw new Error(`No free hole in col ${col} bank ${bank} on ${this.b.id}`);
  }
  freeCount(col, bank) {
    const bx = this.b.x + 2, by = this.b.y;
    const ys = bank === 't' ? [4, 3, 2, 1, 0] : [5, 6, 7, 8, 9];
    let n = 0;
    for (const r of ys) if (!this.isUsed(bx + col, by + this.b.rowY(r))) n++;
    return n;
  }
  railPt(kind, preferCol = null) {
    const bx = this.b.x + 2, y = this.b.y + this.b.railY()[kind];
    if (preferCol !== null) {
      const c = Math.max(0, Math.min(this.b.cols - 1, preferCol));
      const x = bx + c;
      if (!this.isUsed(x, y)) { this.markUsed(x, y); return { x, y }; }
      for (let d = 1; d < this.b.cols; d++) {
        if (c + d < this.b.cols && !this.isUsed(bx + c + d, y)) { this.markUsed(bx + c + d, y); return { x: bx + c + d, y }; }
        if (c - d >= 0 && !this.isUsed(bx + c - d, y)) { this.markUsed(bx + c - d, y); return { x: bx + c - d, y }; }
      }
    }
    while (this._railPtr[kind] < this.b.cols) {
      const c = this._railPtr[kind]++;
      const x = bx + c;
      if (!this.isUsed(x, y)) { this.markUsed(x, y); return { x, y }; }
    }
    throw new Error(`No free rail hole ${kind} on ${this.b.id}`);
  }
  pinStrip(part, pinNum) {
    const q = part.worldPins()[pinNum - 1];
    const bank = q.y <= this.b.y + this.b.rowY(4) ? 't' : 'b';
    const col = q.x - (this.b.x + 2);
    return { col, bank };
  }
  pinHole(part, pinNum) {
    const s = this.pinStrip(part, pinNum);
    return this.stripPt(s.col, s.bank);
  }
  tiePinToRail(part, pinNum, kind) {
    const s = this.pinStrip(part, pinNum);
    const p1 = this.stripPt(s.col, s.bank);
    const rKind = kind === '+' ? (s.bank === 't' ? 'tp' : 'bp') : (s.bank === 't' ? 'tn' : 'bn');
    const p2 = this.railPt(rKind, s.col);
    return this.wire(p1, p2, kind === '+' ? R : K);
  }
  placeDip(type, c0, props = null, addDecouple = true) {
    const bx = this.b.x + 2, by = this.b.y;
    const p = this.addPart(type, bx + c0, by + this.b.rowY(5), 0, props);
    this.tiePinToRail(p, p.def.ic.vcc, '+');
    this.tiePinToRail(p, p.def.ic.gnd, '-');
    if (addDecouple) this.addBypassCap(c0);
    return p;
  }
  addBypassCap(col) {
    const bx = this.b.x + 2, by = this.b.y;
    for (let c = Math.max(0, col); c < this.b.cols; c++) {
      const x = bx + c;
      if (!this.isUsed(x, by + 1) && !this.isUsed(x, by + 2)) {
        return this.addPart('capacitor', x, by + 1, 1, { kind: 'ceramic', uf: 0.1, vmax: 50 });
      }
    }
    return null;
  }
  addBridgeRails() {
    this.wire(this.railPt('tp', 0), this.railPt('bp', 0), R);
    this.wire(this.railPt('tn', 0), this.railPt('bn', 0), K);
  }
  addLed(col, color = 'red', activeLow = false, ohms = 220) {
    const bx = this.b.x + 2, by = this.b.y;
    if (activeLow) {
      this.addPart('led', bx + col, by + this.b.rowY(2), 0, { color, protect: 'off' });
      this.addPart('resistor', bx + col, by + 1, 1, { ohms });
      return this.stripPt(col + 1, 't');
    }
    this.addPart('led', bx + col, by + this.b.rowY(7), 0, { color, protect: 'off' });
    this.addPart('resistor', bx + col + 1, by + this.b.rowY(8), 1, { ohms });
    return this.stripPt(col, 'b');
  }
  addPullUpRow(startCol, count, ohms = 1000) {
    const bx = this.b.x + 2, by = this.b.y;
    const pts = [];
    for (let i = 0; i < count; i++) {
      const c = startCol + i;
      this.addPart('resistor', bx + c, by + 1, 1, { ohms });
      pts.push(this.stripPt(c, 't'));
    }
    return pts;
  }
  addNetLabel(pt, text, color = B) {
    this.c.parts.push(new Part('netlabel', pt.x, pt.y, 0, { text, color }));
    return pt;
  }
  /** Fanout hub on two paired strips (or advancing columns) so multiple destinations never overflow 5 holes. */
  makeHub(startCol, bank = 't', color = Y, maxCols = 4) {
    let curCol = startCol;
    const limit = startCol + maxCols;
    return () => {
      if (this.freeCount(curCol, bank) <= 1) {
        if (curCol + 1 >= limit) throw new Error(`Hub capacity exceeded near col ${startCol} on ${this.b.id}`);
        this.wire(this.stripPt(curCol, bank), this.stripPt(curCol + 1, bank), color);
        curCol++;
      }
      return this.stripPt(curCol, bank);
    };
  }
}

export function powerStandaloneBoard(rig) {
  const bx = rig.b.x + 2, by = rig.b.y;
  const vcc = rig.addPart('vcc', bx, by - 2);
  const gnd = rig.addPart('gnd', bx + 2, by - 2);
  rig.wire(vcc.worldPins()[0], rig.railPt('tp', 2), R);
  rig.wire(gnd.worldPins()[0], rig.railPt('tn', 3), K);
  return { vcc, gnd };
}

// ===========================================================================
// BOARD L0: Power Entry, Bulk Filter, 10kΩ Bus Pull-Downs & 8-bit Bus LEDs
// ===========================================================================
export function buildPowerBusBoard(c, ox = 0, oy = 0, id = 'b_l0') {
  const b = new Board('full', ox, oy, id, 'L0 · Power & 8-Bit Bus');
  c.boards.push(b);
  const rig = new BoardRig(c, b);
  const bx = b.x + 2, by = b.y;
  rig.addBridgeRails();

  const vcc = rig.addPart('vcc', bx + 2, by - 2);
  const gnd = rig.addPart('gnd', bx + 4, by - 2);
  rig.wire(vcc.worldPins()[0], rig.railPt('tp', 2), R);
  rig.wire(gnd.worldPins()[0], rig.railPt('tn', 4), K);
  rig.addPart('capacitor', bx + 6, by + 1, 1, { kind: 'electrolytic', uf: 100, vmax: 16 });
  rig.addBypassCap(8);

  const busTaps = [];
  for (let i = 0; i < 8; i++) {
    const col = 9 + i * 6; // cols 9..56 -> 5 hub cols (17 taps) per bus bit
    rig.addPart('resistor', bx + col, by + 2, 1, { ohms: 10000 }); // pull-down tn -> row c(6) 't'
    const ledSig = rig.addLed(col, 'red', false, 220);
    rig.wire(rig.stripPt(col, 't'), ledSig, B);
    const labelPt = rig.stripPt(col, 't');
    rig.addNetLabel(labelPt, `BUS${i}`, B);
    rig.wire(labelPt, rig.stripPt(col + 1, 't'), B);
    busTaps.push(rig.makeHub(col + 1, 't', B, 5));
  }
  return { b, rig, ports: { vcc, gnd, busTaps } };
}

// ===========================================================================
// BOARD L1: Clock Module (Marek pp. 3-4)
// ===========================================================================
export function buildClockBoard(c, ox = 0, oy = 0, opts = {}, id = 'b_l1') {
  const b = new Board('full', ox, oy, id, 'L1 · Clock Module');
  c.boards.push(b);
  const rig = new BoardRig(c, b);
  const bx = b.x + 2, by = b.y;
  rig.addBridgeRails();

  // 1) Astable 555 (#1 at c=5..8): Ra=1k, pot(1M) + 1k -> Rb, 1uF timing cap
  const tAst = rig.placeDip('ne555', 5);
  rig.tiePinToRail(tAst, 4, '+');
  rig.addPart('resistor', bx + 4, by + 1, 1, { ohms: 1000 }); // Ra: tp(1) -> row b(5) @ c=4
  rig.wire(rig.stripPt(4, 't'), rig.pinHole(tAst, 7), Y);
  const pot = rig.addPart('pot', bx, by + b.rowY(0), 0, { ohms: 1000000, pos: opts.potPos ?? 0.015 });
  rig.wire(rig.pinHole(tAst, 7), rig.stripPt(0, 't'), Y); // DIS -> pot.0
  rig.addPart('resistor', bx + 10, by + b.rowY(0), 0, { ohms: 1000 }); // Rb: c=10..14 row a 't'
  rig.wire(rig.stripPt(1, 't'), rig.stripPt(10, 't'), Y); // wiper -> Rb.a
  rig.wire(rig.pinHole(tAst, 6), rig.pinHole(tAst, 2), O); // THR == TRIG
  rig.wire(rig.stripPt(14, 't'), rig.pinHole(tAst, 6), Y);
  rig.addPart('capacitor', bx + 14, by + b.rowY(9), 0, { kind: 'electrolytic', uf: opts.astUf ?? 1, vmax: 16 });
  rig.wire(rig.stripPt(14, 't'), rig.stripPt(14, 'b'), O);
  rig.wire(rig.stripPt(15, 'b'), rig.railPt('bn', 15), K);
  // CTRL filtering cap (0.47uF on col 10..11 'b')
  rig.addPart('capacitor', bx + 10, by + b.rowY(9), 0, { kind: 'ceramic', uf: 0.47, vmax: 50 });
  rig.wire(rig.pinHole(tAst, 5), rig.stripPt(10, 'b'), B);
  rig.wire(rig.stripPt(11, 'b'), rig.railPt('bn', 11), K);
  const autoLed = rig.addLed(0, 'yellow', false, 220);
  rig.wire(rig.pinHole(tAst, 3), autoLed, Y);

  // 2) Manual Step Pushbutton (c=17..19 straddle) + Monostable Debounce 555 (#2 at c=22..25)
  const stepBtn = rig.addPart('tactile', bx + 17, by + b.rowY(5), 0);
  rig.wire(rig.stripPt(17, 'b'), rig.railPt('bn', 17), K);
  rig.addPart('resistor', bx + 19, by + 1, 1, { ohms: 10000 }); // 10k pull-up on c=19 't'
  const tMan = rig.placeDip('ne555', 22);
  rig.tiePinToRail(tMan, 4, '+');
  rig.wire(rig.stripPt(19, 't'), rig.pinHole(tMan, 2), G);
  rig.addPart('resistor', bx + 20, by + 1, 1, { ohms: 10000 }); // monostable R on c=20 't'
  rig.wire(rig.stripPt(20, 't'), rig.pinHole(tMan, 6), O);
  rig.wire(rig.pinHole(tMan, 7), rig.pinHole(tMan, 6), O);
  rig.addPart('capacitor', bx + 20, by + b.rowY(9), 0, { kind: 'ceramic', uf: 0.1, vmax: 50 });
  rig.wire(rig.pinHole(tMan, 6), rig.stripPt(20, 'b'), O);
  rig.wire(rig.stripPt(21, 'b'), rig.railPt('bn', 21), K);

  // 3) Auto/Manual SPDT Selector (c=27..29 row c) + Bistable Debounce 555 (#3 at c=31..34)
  const spdt = rig.addPart('spdt', bx + 27, by + b.rowY(2), 0, { pos: opts.manual ? 'B' : 'A' });
  rig.wire(rig.stripPt(28, 't'), rig.railPt('tn', 28), K);
  rig.addPart('resistor', bx + 27, by + 1, 1, { ohms: 10000 });
  rig.addPart('resistor', bx + 29, by + 1, 1, { ohms: 10000 });
  const tSel = rig.placeDip('ne555', 31);
  rig.tiePinToRail(tSel, 6, '-');
  rig.wire(rig.stripPt(27, 't'), rig.pinHole(tSel, 2), B); // A=Auto -> TRIG
  rig.wire(rig.stripPt(29, 't'), rig.pinHole(tSel, 4), W); // B=Manual -> RESET

  // 4) Clock Gating: 7404 (c=36), 7408 (c=44), 7432 (c=52)
  const u04 = rig.placeDip('ic7404', 36);
  const u08 = rig.placeDip('ic7408', 44);
  const u32 = rig.placeDip('ic7432', 52);
  for (const p of [5, 9, 11, 13]) rig.tiePinToRail(u04, p, '-');
  for (const p of [12, 13]) rig.tiePinToRail(u08, p, '-');
  for (const p of [4, 5, 9, 10, 12, 13]) rig.tiePinToRail(u32, p, '-');

  rig.wire(rig.pinHole(tSel, 3), rig.pinHole(u04, 1), P);
  rig.wire(rig.pinHole(tSel, 3), rig.pinHole(u08, 1), P);
  rig.wire(rig.pinHole(tAst, 3), rig.pinHole(u08, 2), Y);
  rig.wire(rig.pinHole(u04, 2), rig.pinHole(u08, 4), P);
  rig.wire(rig.pinHole(tMan, 3), rig.pinHole(u08, 5), G);
  rig.wire(rig.pinHole(u08, 3), rig.pinHole(u32, 1), O);
  rig.wire(rig.pinHole(u08, 6), rig.pinHole(u32, 2), O);
  rig.wire(rig.pinHole(u32, 3), rig.pinHole(u08, 9), B);
  rig.wire(rig.pinHole(u04, 4), rig.pinHole(u08, 10), R);

  const clkLed = rig.addLed(59, 'blue', false, 220);
  const clkLedPart = c.parts[c.parts.length - 2];
  rig.wire(rig.pinHole(u08, 8), clkLed, B);
  const clkOut = rig.makeHub(59, 't', B, 4); // bank 't' cols 59..62 (14 holes free for 9 CLK targets)
  const clkPt = clkOut();
  rig.wire(rig.pinHole(u08, 8), clkPt, B);
  rig.addNetLabel(clkPt, 'CLK', B);

  const hltIn = () => rig.pinHole(u04, 3);
  return { b, rig, ports: { pot, stepBtn, spdt, tAst, tMan, tSel, clkOut, hltIn, clkLedPart } };
}

// ===========================================================================
// BOARD R1 / R3 / L5: 8-bit Register + 74245 Transceiver (+ Optional System Reset)
// ===========================================================================
export function buildRegBoard(c, ox = 0, oy = 0, opts = {}, id = 'b_reg') {
  const label = opts.label || '8-Bit Register';
  const b = new Board('full', ox, oy, id, label);
  c.boards.push(b);
  const rig = new BoardRig(c, b);
  const bx = b.x + 2, by = b.y;
  rig.addBridgeRails();

  let rstPorts = null;
  const xStart = opts.includeReset ? 16 : 6;
  if (opts.includeReset) {
    // Tactile Reset button (c=0..2 straddle) + 10k pull-down -> 7400 (c=6) generating RST, RST_N, Step_CLR_N
    const resetBtn = rig.addPart('tactile', bx + 0, by + b.rowY(5), 0);
    rig.wire(rig.stripPt(0, 't'), rig.railPt('tp', 1), R); // pressed connects 5V -> c=2
    rig.addPart('resistor', bx + 3, by + b.rowY(8), 1, { ohms: 10000 });
    rig.wire(rig.stripPt(2, 'b'), rig.stripPt(3, 'b'), R);
    const rstHub = rig.makeHub(4, 't', R, 2);
    const rstPt = rstHub();
    rig.wire(rig.stripPt(2, 't'), rstPt, R);
    rig.addNetLabel(rstPt, 'RST', R);

    const u00 = rig.placeDip('ic7400', 6);
    rig.tiePinToRail(u00, 12, '-'); rig.tiePinToRail(u00, 13, '-'); // Gate 4 unused
    rig.wire(rstHub(), rig.pinHole(u00, 1), R);
    rig.wire(rig.pinHole(u00, 1), rig.pinHole(u00, 2), R);
    const rstBarHub = rig.makeHub(13, 't', K, 2);
    const rstBarPt = rstBarHub();
    rig.wire(rig.pinHole(u00, 3), rstBarPt, K);
    rig.addNetLabel(rstBarPt, 'RST̅', K);

    // Step counter async clear combiner: stepClrBar = AND(rstBar, t5Bar) = !NAND(rstBar, t5Bar)
    rig.wire(rstBarHub(), rig.pinHole(u00, 4), K);
    rig.wire(rig.pinHole(u00, 6), rig.pinHole(u00, 9), K);
    rig.wire(rig.pinHole(u00, 6), rig.pinHole(u00, 10), K);
    rstPorts = {
      resetBtn,
      rstHigh: rstHub,
      rstBar: rstBarHub,
      t5BarIn: () => rig.pinHole(u00, 5),
      stepClrBar: () => rig.pinHole(u00, 8),
    };
  }

  const u245 = rig.placeDip('ic74245', xStart);
  rig.tiePinToRail(u245, 1, '+'); // DIR = 1 (A -> B)
  if (opts.neverDriveBus) rig.tiePinToRail(u245, 19, '+');

  const regLo = rig.placeDip('ic74173', xStart + 11);
  const regHi = rig.placeDip('ic74173', xStart + 20);
  for (const reg of [regLo, regHi]) {
    rig.tiePinToRail(reg, 1, '-'); rig.tiePinToRail(reg, 2, '-'); // M=0, N=0 always visible on LEDs
    rig.wire(rig.pinHole(reg, 9), rig.pinHole(reg, 10), P);     // tie G1̅ & G2̅
  }

  // Q -> 74245 A + LEDs
  const ledStart = xStart + 30;
  const qPts = [];
  const busMask = opts.busMask ?? 0xff;
  const ledColors = opts.ledColors || Array(8).fill('red');
  for (let i = 0; i < 8; i++) {
    const reg = i < 4 ? regLo : regHi;
    const qPin = REG173_Q[i % 4];
    const ledSig = rig.addLed(ledStart + i * 2, ledColors[i], false, 220);
    rig.wire(rig.pinHole(reg, qPin), ledSig, ledColors[i] === 'blue' ? B : ledColors[i] === 'yellow' ? Y : R);
    if ((busMask >> i) & 1) rig.wire(rig.pinHole(reg, qPin), rig.pinHole(u245, TRANSCEIVER_A[i]), G);
    else rig.tiePinToRail(u245, TRANSCEIVER_A[i], '-');
    qPts.push(() => rig.pinHole(reg, qPin));
  }

  // Tie CLK, CLR, LOAD̅ across Lo and Hi 74173
  rig.wire(rig.pinHole(regLo, 7), rig.pinHole(regHi, 7), B);
  rig.wire(rig.pinHole(regLo, 9), rig.pinHole(regHi, 9), P);
  rig.wire(rig.pinHole(regLo, 15), rig.pinHole(regHi, 15), R);
  if (rstPorts) {
    rig.wire(rstPorts.rstHigh(), rig.pinHole(regLo, 15), R);
  }

  const busInPts = Array.from({ length: 8 }, (_, i) => () => rig.pinHole(i < 4 ? regLo : regHi, REG173_D[i % 4]));
  const busOutPts = Array.from({ length: 8 }, (_, i) => () => rig.pinHole(u245, TRANSCEIVER_B[i]));
  return {
    b, rig,
    ports: {
      regLo, regHi, u245,
      qPts,
      busIn: busInPts,
      busOut: busOutPts,
      loadBar: () => rig.pinHole(regLo, 9),
      oeBar: () => rig.pinHole(u245, 19),
      clkIn: () => rig.pinHole(regLo, 7),
      clrIn: () => rig.pinHole(regLo, 15),
      reset: rstPorts,
    },
  };
}

// ===========================================================================
// BOARD R2: ALU (2x 7486 XOR, 2x 74283 Adder, 74245, Sum LEDs, pp. 6-8)
// ===========================================================================
export function buildAluBoard(c, ox = 0, oy = 0, id = 'b_r2') {
  const b = new Board('full', ox, oy, id, 'R2 · 8-bit ALU');
  c.boards.push(b);
  const rig = new BoardRig(c, b);
  rig.addBridgeRails();

  const xorLo = rig.placeDip('ic7486', 1);
  const xorHi = rig.placeDip('ic7486', 9);
  const addLo = rig.placeDip('ic74283', 17);
  const addHi = rig.placeDip('ic74283', 26);
  const u245 = rig.placeDip('ic74245', 35);
  rig.tiePinToRail(u245, 1, '+');

  const xorPairs = [[1, 2, 3], [4, 5, 6], [9, 10, 8], [12, 13, 11]];
  const bInPts = [], aInPts = [], sumPts = [];
  // Chain SU through XOR control pins & addLo.C0 (pin 7)
  rig.wire(rig.pinHole(xorLo, 1), rig.pinHole(xorLo, 4), O);
  rig.wire(rig.pinHole(xorLo, 4), rig.pinHole(xorLo, 9), O);
  rig.wire(rig.pinHole(xorLo, 9), rig.pinHole(xorLo, 12), O);
  rig.wire(rig.pinHole(xorLo, 12), rig.pinHole(xorHi, 1), O);
  rig.wire(rig.pinHole(xorHi, 1), rig.pinHole(xorHi, 4), O);
  rig.wire(rig.pinHole(xorHi, 4), rig.pinHole(xorHi, 9), O);
  rig.wire(rig.pinHole(xorHi, 9), rig.pinHole(xorHi, 12), O);
  rig.wire(rig.pinHole(xorHi, 12), rig.pinHole(addLo, 7), O); // Carry-in = SU

  rig.wire(rig.pinHole(addLo, 9), rig.pinHole(addHi, 7), Y); // Ripple Carry lo->hi

  for (let i = 0; i < 8; i++) {
    const xorIc = i < 4 ? xorLo : xorHi;
    const addIc = i < 4 ? addLo : addHi;
    const [, bPin, yPin] = xorPairs[i % 4];
    const bit = i % 4;
    bInPts.push(() => rig.pinHole(xorIc, bPin));
    aInPts.push(() => rig.pinHole(addIc, ADDER_A[bit]));
    rig.wire(rig.pinHole(xorIc, yPin), rig.pinHole(addIc, ADDER_B[bit]), G);

    const sPin = ADDER_S[bit];
    rig.wire(rig.pinHole(addIc, sPin), rig.pinHole(u245, TRANSCEIVER_A[i]), G);
    const ledSig = rig.addLed(46 + i * 2, 'red', false, 220);
    rig.wire(rig.pinHole(addIc, sPin), ledSig, R);
    sumPts.push(() => rig.pinHole(addIc, sPin));
  }

  return {
    b, rig,
    ports: {
      aIn: aInPts,
      bIn: bInPts,
      sum: sumPts,
      cy: () => rig.pinHole(addHi, 9),
      suIn: () => rig.pinHole(xorLo, 1),
      eoBar: () => rig.pinHole(u245, 19),
      busOut: Array.from({ length: 8 }, (_, i) => () => rig.pinHole(u245, TRANSCEIVER_B[i])),
      u245, addLo, addHi,
    },
  };
}

// ===========================================================================
// BOARDS L2, L3, L4: MAR & Addr Mux, RAM Core (74189x2), Data Mux & Write Gate
// ===========================================================================
export function buildRamAddrBoard(c, ox = 0, oy = 0, opts = {}, id = 'b_l2') {
  const b = new Board('full', ox, oy, id, 'L2 · MAR & Addr Selector');
  c.boards.push(b);
  const rig = new BoardRig(c, b);
  const bx = b.x + 2, by = b.y;
  rig.addBridgeRails();

  const progLed = rig.addLed(1, 'red', true, 220);  // active LOW when SEL=0 (Program)
  const runLed = rig.addLed(3, 'green', false, 220); // active HIGH when SEL=1 (Run)
  const spdt = rig.addPart('spdt', bx + 6, by + b.rowY(2), 0, { pos: opts.programMode ? 'A' : 'B' });
  rig.wire(rig.stripPt(6, 't'), rig.railPt('tn', 6), K); // A -> GND (Program SEL=0)
  rig.wire(rig.stripPt(8, 't'), rig.railPt('tp', 8), R); // B -> VCC (Run SEL=1)
  const selHub = rig.makeHub(9, 't', Y, 2);
  const selLabelPt = selHub();
  rig.wire(rig.stripPt(7, 't'), selLabelPt, Y);
  rig.wire(selHub(), progLed, R);
  rig.wire(selHub(), runLed, G);
  rig.addNetLabel(selLabelPt, 'SEL', Y);

  const dip4 = rig.addPart('dip4', bx + 12, by + b.rowY(5), 0, { bits: opts.dipAddr || [false, false, false, false] });
  const ups4 = rig.addPullUpRow(12, 4, 1000);
  const mar = rig.placeDip('ic74173', 18);
  rig.tiePinToRail(mar, 1, '-'); rig.tiePinToRail(mar, 2, '-');
  rig.wire(rig.pinHole(mar, 9), rig.pinHole(mar, 10), P);

  const mux = rig.placeDip('ic74157', 27);
  rig.tiePinToRail(mux, 15, '-'); // G̅ = 0
  rig.wire(selHub(), rig.pinHole(mux, 1), Y); // S=0 -> A (dip4), S=1 -> B (MAR)

  const addrOut = [];
  for (let i = 0; i < 4; i++) {
    rig.wire(ups4[i], rig.stripPt(12 + i, 'b'), O);
    rig.wire(rig.stripPt(12 + i, 'b'), rig.pinHole(mux, MUX157_A[i]), O);
    rig.wire(rig.pinHole(mar, REG173_Q[i]), rig.pinHole(mux, MUX157_B[i]), G);
    const ledSig = rig.addLed(37 + i * 2, 'yellow', false, 220);
    rig.wire(rig.pinHole(mux, MUX157_Y[i]), ledSig, Y);
    addrOut.push(() => rig.pinHole(mux, MUX157_Y[i]));
  }

  return {
    b, rig,
    ports: {
      spdt, dip4, mar, mux,
      selOut: selHub,
      addrOut,
      busIn: Array.from({ length: 4 }, (_, i) => () => rig.pinHole(mar, REG173_D[i])),
      miBar: () => rig.pinHole(mar, 9),
      clkIn: () => rig.pinHole(mar, 7),
      clrIn: () => rig.pinHole(mar, 15),
    },
  };
}

export function buildRamCoreBoard(c, ox = 0, oy = 0, opts = {}, id = 'b_l3') {
  const b = new Board('full', ox, oy, id, 'L3 · Static RAM (74LS189 ×2)');
  c.boards.push(b);
  const rig = new BoardRig(c, b);
  rig.addBridgeRails();

  const bytes = opts.programBytes || Array(16).fill(0);
  const initLo = opts.initHexLo ?? nibblesToHex(bytes, false);
  const initHi = opts.initHexHi ?? nibblesToHex(bytes, true);
  const ramLo = rig.placeDip('ic74189', 2, { initHex: initLo });
  const ramHi = rig.placeDip('ic74189', 12, { initHex: initHi });
  rig.tiePinToRail(ramLo, 2, '-'); rig.tiePinToRail(ramHi, 2, '-'); // CS̅=0
  rig.wire(rig.pinHole(ramLo, 3), rig.pinHole(ramHi, 3), O); // WE̅ shared

  const addrPins = [1, 15, 14, 13];
  for (const ap of addrPins) rig.wire(rig.pinHole(ramLo, ap), rig.pinHole(ramHi, ap), Y);

  const invLo = rig.placeDip('ic7404', 22);
  const invHi = rig.placeDip('ic7404', 31);
  // invLo gates 1..4: RAM lo O̅; invLo gate 5 (pin 11->10): inverts SEL->SEL̅; gate 6 grounded
  rig.tiePinToRail(invLo, 13, '-');
  rig.tiePinToRail(invHi, 11, '-'); rig.tiePinToRail(invHi, 13, '-');

  const invMaps = [[1, 2], [3, 4], [5, 6], [9, 8]];
  const ramO = [5, 7, 9, 11];
  const ramD = [4, 6, 10, 12];
  const dataOut = [], dataIn = [];
  for (let i = 0; i < 8; i++) {
    const ram = i < 4 ? ramLo : ramHi;
    const inv = i < 4 ? invLo : invHi;
    const [aP, yP] = invMaps[i % 4];
    rig.wire(rig.pinHole(ram, ramO[i % 4]), rig.pinHole(inv, aP), G);
    const ledSig = rig.addLed(40 + i * 2, 'red', false, 220);
    rig.wire(rig.pinHole(inv, yP), ledSig, R);
    dataOut.push(() => rig.pinHole(inv, yP));
    dataIn.push(() => rig.pinHole(ram, ramD[i % 4]));
  }

  return {
    b, rig,
    ports: {
      ramLo, ramHi,
      addrIn: addrPins.map(p => () => rig.pinHole(ramLo, p)),
      dataIn,
      dataOut,
      weBarIn: () => rig.pinHole(ramLo, 3),
      selIn: () => rig.pinHole(invLo, 11),
      selBarOut: () => rig.pinHole(invLo, 10),
    },
  };
}

export function buildRamDataBoard(c, ox = 0, oy = 0, id = 'b_l4') {
  const b = new Board('full', ox, oy, id, 'L4 · RAM Data Mux & Bus Driver');
  c.boards.push(b);
  const rig = new BoardRig(c, b);
  const bx = b.x + 2, by = b.y;
  rig.addBridgeRails();

  const dip8 = rig.addPart('dip8', bx + 1, by + b.rowY(5), 0, { bits: Array(8).fill(false) });
  const ups8 = rig.addPullUpRow(1, 8, 1000);
  const muxLo = rig.placeDip('ic74157', 11);
  const muxHi = rig.placeDip('ic74157', 20);
  rig.tiePinToRail(muxLo, 15, '-'); rig.tiePinToRail(muxHi, 15, '-');
  rig.wire(rig.pinHole(muxLo, 1), rig.pinHole(muxHi, 1), Y);

  for (let i = 0; i < 8; i++) {
    const mux = i < 4 ? muxLo : muxHi;
    rig.wire(ups8[i], rig.stripPt(1 + i, 'b'), O);
    rig.wire(rig.stripPt(1 + i, 'b'), rig.pinHole(mux, MUX157_A[i % 4]), O);
  }

  // Write Pushbutton (c=30..32 straddle) + 7400 (c=35) write gate:
  // WE̅ = AND(NAND(CLK, RI), NAND(SEL̅, WriteBtn)) -> active LOW during either Run(CLK&RI) or Program(WriteBtn)
  const writeBtn = rig.addPart('tactile', bx + 30, by + b.rowY(5), 0);
  rig.wire(rig.stripPt(30, 't'), rig.railPt('tp', 30), R);
  rig.addPart('resistor', bx + 33, by + b.rowY(8), 1, { ohms: 10000 });
  rig.wire(rig.stripPt(32, 'b'), rig.stripPt(33, 'b'), O);

  const u00 = rig.placeDip('ic7400', 35);
  rig.wire(rig.stripPt(32, 't'), rig.pinHole(u00, 4), O);   // G2.2A = WriteBtn
  rig.wire(rig.pinHole(u00, 3), rig.pinHole(u00, 9), P);    // G3.3A = run_bar
  rig.wire(rig.pinHole(u00, 6), rig.pinHole(u00, 10), P);   // G3.3B = prog_bar
  rig.wire(rig.pinHole(u00, 8), rig.pinHole(u00, 12), P);   // G4 inverter
  rig.wire(rig.pinHole(u00, 8), rig.pinHole(u00, 13), P);

  const u245 = rig.placeDip('ic74245', 44);
  rig.tiePinToRail(u245, 1, '+');

  return {
    b, rig,
    ports: {
      dip8, writeBtn, u245,
      selIn: () => rig.pinHole(muxLo, 1),
      busIn: Array.from({ length: 8 }, (_, i) => () => rig.pinHole(i < 4 ? muxLo : muxHi, MUX157_B[i % 4])),
      muxDataOut: Array.from({ length: 8 }, (_, i) => () => rig.pinHole(i < 4 ? muxLo : muxHi, MUX157_Y[i % 4])),
      clkIn: () => rig.pinHole(u00, 1),
      riIn: () => rig.pinHole(u00, 2),
      selBarIn: () => rig.pinHole(u00, 5),
      weBarOut: () => rig.pinHole(u00, 11),
      ramDataIn: Array.from({ length: 8 }, (_, i) => () => rig.pinHole(u245, TRANSCEIVER_A[i])),
      roBar: () => rig.pinHole(u245, 19),
      busOut: Array.from({ length: 8 }, (_, i) => () => rig.pinHole(u245, TRANSCEIVER_B[i])),
    },
  };
}

// ===========================================================================
// BOARD R0: Program Counter (74161 + 74245, Marek p. 12)
// ===========================================================================
export function buildPcBoard(c, ox = 0, oy = 0, id = 'b_r0') {
  const b = new Board('full', ox, oy, id, 'R0 · Program Counter');
  c.boards.push(b);
  const rig = new BoardRig(c, b);
  rig.addBridgeRails();

  const u161 = rig.placeDip('ic74161', 4);
  rig.wire(rig.pinHole(u161, 7), rig.pinHole(u161, 10), G); // ENP == ENT = CE
  const u245 = rig.placeDip('ic74245', 15);
  rig.tiePinToRail(u245, 1, '+');

  const qPins = [14, 13, 12, 11];
  const dPins = [3, 4, 5, 6];
  for (let i = 0; i < 4; i++) {
    rig.wire(rig.pinHole(u161, qPins[i]), rig.pinHole(u245, TRANSCEIVER_A[i]), G);
    const ledSig = rig.addLed(28 + i * 2, 'green', false, 220);
    rig.wire(rig.pinHole(u161, qPins[i]), ledSig, G);
    rig.tiePinToRail(u245, TRANSCEIVER_A[4 + i], '-'); // upper 4 bits 0
  }

  return {
    b, rig,
    ports: {
      u161, u245,
      busIn: dPins.map(p => () => rig.pinHole(u161, p)),
      busOut: Array.from({ length: 8 }, (_, i) => () => rig.pinHole(u245, TRANSCEIVER_B[i])),
      qOut: qPins.map(p => () => rig.pinHole(u161, p)),
      clrBarIn: () => rig.pinHole(u161, 1),
      clkIn: () => rig.pinHole(u161, 2),
      ceIn: () => rig.pinHole(u161, 7),
      jBarIn: () => rig.pinHole(u161, 9),
      coBar: () => rig.pinHole(u245, 19),
    },
  };
}

// ===========================================================================
// BOARD R4: Output Module (555 + 74107 + 74139 + 74273 + 28C16 + seg7x4, pp. 12-13)
// ===========================================================================
export function buildOutputBoard(c, ox = 0, oy = 0, opts = {}, id = 'b_r4') {
  const b = new Board('full', ox, oy, id, 'R4 · Output Display');
  c.boards.push(b);
  const rig = new BoardRig(c, b);
  const bx = b.x + 2, by = b.y;
  rig.addBridgeRails();

  const signedSw = rig.addPart('toggle', bx, by + b.rowY(9), 2, { label: 'SIGNED', on: !!opts.signed });

  // Multiplex 555 (Ra=1k, Rb=100k, C=0.01uF -> ~716 Hz)
  const tMux = rig.placeDip('ne555', 2);
  rig.tiePinToRail(tMux, 4, '+');
  rig.addPart('resistor', bx + 1, by + 1, 1, { ohms: 1000 }); // Ra: tp(1)->row b c=1
  rig.wire(rig.stripPt(1, 't'), rig.pinHole(tMux, 7), Y);
  rig.addPart('resistor', bx + 3, by + b.rowY(0), 0, { ohms: 100000 }); // Rb: row a c=3(DIS)..7 -> c=7..THR
  rig.wire(rig.stripPt(7, 't'), rig.pinHole(tMux, 6), Y);
  rig.wire(rig.pinHole(tMux, 6), rig.pinHole(tMux, 2), O);
  rig.addPart('capacitor', bx + 6, by + b.rowY(9), 0, { kind: 'ceramic', uf: opts.muxUf ?? 0.01, vmax: 50 });
  rig.wire(rig.stripPt(6, 'b'), rig.pinHole(tMux, 6), O);
  rig.wire(rig.stripPt(7, 'b'), rig.railPt('bn', 7), K);

  // 74107 2-bit falling-edge counter (c=9..15)
  const u107 = rig.placeDip('ic74107', 9);
  for (const p of [1, 4, 13, 8, 11, 10]) rig.tiePinToRail(u107, p, '+');
  rig.wire(rig.pinHole(tMux, 3), rig.pinHole(u107, 12), B); // 1CLK = 555 OUT
  rig.wire(rig.pinHole(u107, 3), rig.pinHole(u107, 9), B);  // 2CLK = 1Q

  // 74139 2-to-4 cathode decoder (c=17..24)
  const u139 = rig.placeDip('ic74139', 17);
  rig.tiePinToRail(u139, 1, '-');  // 1G̅ = 0
  rig.tiePinToRail(u139, 15, '+'); rig.tiePinToRail(u139, 14, '-'); rig.tiePinToRail(u139, 13, '-');
  rig.wire(rig.pinHole(u107, 3), rig.pinHole(u139, 2), Y); // 1A = 1Q
  rig.wire(rig.pinHole(u107, 5), rig.pinHole(u139, 3), Y); // 1B = 2Q

  // 74273 Octal Out Reg (c=26..35)
  const u273 = rig.placeDip('ic74273', 26);

  // 28C16 Display LUT EEPROM (c=37..48)
  const eep = rig.placeDip('ic28c16', 37, { preset: 'sap1_display', rom: '' });
  rig.tiePinToRail(eep, 18, '-'); // CE̅=0
  rig.tiePinToRail(eep, 20, '-'); // OE̅=0
  rig.tiePinToRail(eep, 21, '+'); // WE̅=1
  rig.wire(signedSw.worldPins()[0], rig.pinHole(eep, 19), P); // A10 = Signed switch
  rig.wire(rig.pinHole(u107, 3), rig.pinHole(eep, 23), Y);   // A8 = mux0
  rig.wire(rig.pinHole(u107, 5), rig.pinHole(eep, 22), Y);   // A9 = mux1
  for (let i = 0; i < 8; i++) rig.wire(rig.pinHole(u273, REG273_Q[i]), rig.pinHole(eep, ROM_A[i]), G);

  // 7x 220Ω vertical segment resistors across center notch on cols 50..56 (row d->f) + seg7x4 at c=57..62 (row h)
  const disp = rig.addPart('seg7x4', bx + 57, by + b.rowY(7), 0, { common: 'cathode', color: 'red', protect: 'off' });
  for (let i = 0; i < 7; i++) {
    const col = 49 + i;
    rig.addPart('resistor', bx + col, by + b.rowY(3), 1, { ohms: 220 }); // d(7) -> f(11)
    rig.wire(rig.pinHole(eep, ROM_D[i]), rig.stripPt(col, 't'), G);
    rig.wire(rig.stripPt(col, 'b'), rig.pinHole(disp, SEG7X4_SEGS[i]), G);
  }
  // Connect D4 (mux=0, 1Y0̅=pin4), D3 (1Y1̅=pin5), D2 (1Y2̅=pin6), D1 (1Y3̅=pin7)
  const yCathodes = [4, 5, 6, 7];
  const digPins = [6, 8, 9, 12]; // D4, D3, D2, D1 (1-based)
  for (let d = 0; d < 4; d++) rig.wire(rig.pinHole(u139, yCathodes[d]), rig.pinHole(disp, digPins[d]), O);

  return {
    b, rig,
    ports: {
      signedSw, tMux, u107, u139, u273, eep, disp,
      busIn: REG273_D.map(p => () => rig.pinHole(u273, p)),
      outClkIn: () => rig.pinHole(u273, 11),
      clrBarIn: () => rig.pinHole(u273, 1),
    },
  };
}

// ===========================================================================
// BOARD R5: Step Counter (74161+74138) & Flags Register (7402+7408+74173)
// ===========================================================================
export function buildStepFlagsBoard(c, ox = 0, oy = 0, id = 'b_r5') {
  const b = new Board('full', ox, oy, id, 'R5 · Step Counter & Flags');
  c.boards.push(b);
  const rig = new BoardRig(c, b);
  rig.addBridgeRails();

  const u161 = rig.placeDip('ic74161', 1);
  rig.tiePinToRail(u161, 7, '+'); rig.tiePinToRail(u161, 10, '+'); rig.tiePinToRail(u161, 9, '+');
  for (const p of [3, 4, 5, 6]) rig.tiePinToRail(u161, p, '-');

  const u138 = rig.placeDip('ic74138', 10);
  rig.tiePinToRail(u138, 6, '+'); rig.tiePinToRail(u138, 4, '-'); rig.tiePinToRail(u138, 5, '-');
  rig.wire(rig.pinHole(u161, 14), rig.pinHole(u138, 1), Y); // A = T0
  rig.wire(rig.pinHole(u161, 13), rig.pinHole(u138, 2), Y); // B = T1
  rig.wire(rig.pinHole(u161, 12), rig.pinHole(u138, 3), Y); // C = T2

  const decLeds = [15, 14, 13, 12, 11]; // Y0̅..Y4̅ -> active-LOW Green Step LEDs at cols 19..28
  for (let s = 0; s < 5; s++) {
    const ledSig = rig.addLed(19 + s * 2, 'green', true, 220);
    rig.wire(rig.pinHole(u138, decLeds[s]), ledSig, G);
  }

  // Flags 8-input NOR (7402 @ c=30 + 7408 @ c=38; 4th AND computes OUT_CLK = AND(CLK, OI))
  const u02 = rig.placeDip('ic7402', 30);
  const u08 = rig.placeDip('ic7408', 38);
  rig.wire(rig.pinHole(u02, 1), rig.pinHole(u08, 1), P);
  rig.wire(rig.pinHole(u02, 4), rig.pinHole(u08, 2), P);
  rig.wire(rig.pinHole(u02, 10), rig.pinHole(u08, 4), P);
  rig.wire(rig.pinHole(u02, 13), rig.pinHole(u08, 5), P);
  rig.wire(rig.pinHole(u08, 3), rig.pinHole(u08, 9), P);
  rig.wire(rig.pinHole(u08, 6), rig.pinHole(u08, 10), P);

  const flagsReg = rig.placeDip('ic74173', 46);
  rig.tiePinToRail(flagsReg, 1, '-'); rig.tiePinToRail(flagsReg, 2, '-');
  rig.wire(rig.pinHole(flagsReg, 9), rig.pinHole(flagsReg, 10), P);
  rig.tiePinToRail(flagsReg, 12, '-'); rig.tiePinToRail(flagsReg, 11, '-'); // 3D,4D unused
  rig.wire(rig.pinHole(u08, 8), rig.pinHole(flagsReg, 13), P); // 2D = ZF_raw

  const cyLed = rig.addLed(55, 'yellow', false, 220);
  const zfLed = rig.addLed(57, 'green', false, 220);
  rig.wire(rig.pinHole(flagsReg, 3), cyLed, Y);
  rig.wire(rig.pinHole(flagsReg, 4), zfLed, G);

  const sumPins = [2, 3, 5, 6, 8, 9, 11, 12]; // 7402 NOR inputs 1A,1B .. 4A,4B
  return {
    b, rig,
    ports: {
      u161, u138, flagsReg, u02, u08,
      stepOut: [14, 13, 12].map(p => () => rig.pinHole(u161, p)),
      t5BarOut: () => rig.pinHole(u138, 10),
      stepClrBarIn: () => rig.pinHole(u161, 1),
      clkBarIn: () => rig.pinHole(u161, 2),
      aluSumIn: sumPins.map(p => () => rig.pinHole(u02, p)),
      cyIn: () => rig.pinHole(flagsReg, 14),
      fiBarIn: () => rig.pinHole(flagsReg, 9),
      flagsClkIn: () => rig.pinHole(flagsReg, 7),
      flagsClrIn: () => rig.pinHole(flagsReg, 15),
      cyOut: () => rig.pinHole(flagsReg, 3),
      zfOut: () => rig.pinHole(flagsReg, 4),
      outGateClkIn: () => rig.pinHole(u08, 12),
      outGateOiIn: () => rig.pinHole(u08, 13),
      outClkOut: () => rig.pinHole(u08, 11),
    },
  };
}

// ===========================================================================
// BOARD L6: Microcode EEPROMs (2x 28C16, pp. 15-16)
// ===========================================================================
export function buildMicrocodeBoard(c, ox = 0, oy = 0, id = 'b_l6') {
  const b = new Board('full', ox, oy, id, 'L6 · Microcode EEPROMs');
  c.boards.push(b);
  const rig = new BoardRig(c, b);
  rig.addBridgeRails();

  const eepHi = rig.placeDip('ic28c16', 4, { preset: 'sap1_ucode_hi', rom: '' });
  const eepLo = rig.placeDip('ic28c16', 24, { preset: 'sap1_ucode_lo', rom: '' });
  for (const eep of [eepHi, eepLo]) {
    rig.tiePinToRail(eep, 18, '-'); // CE̅=0
    rig.tiePinToRail(eep, 20, '-'); // OE̅=0
    rig.tiePinToRail(eep, 21, '+'); // WE̅=1
    rig.tiePinToRail(eep, 22, '-'); // A9=0
    rig.tiePinToRail(eep, 19, '-'); // A10=0
  }
  // Tie shared A0..A8 [pins 8,7,6,5,4,3,2,1,23] between eepHi and eepLo
  const addrPins9 = ROM_A.slice(0, 9);
  for (const ap of addrPins9) rig.wire(rig.pinHole(eepHi, ap), rig.pinHole(eepLo, ap), Y);

  // D0..D7 outputs on each EEPROM -> 16 normalized active-HIGH control signals
  // eepHi D7..D0: HLT, MI, RI, RO, II, IO, AI, AO
  // eepLo D7..D0: EO, SU, BI, OI, CE, CO, J, FI
  const ctrlHubs = {};
  const hiNames = ['AO', 'AI', 'IO', 'II', 'RO', 'RI', 'MI', 'HLT']; // D0..D7
  const loNames = ['FI', 'J', 'CO', 'CE', 'OI', 'BI', 'SU', 'EO'];  // D0..D7
  for (let i = 0; i < 8; i++) {
    ctrlHubs[hiNames[i]] = () => rig.pinHole(eepHi, ROM_D[i]);
    ctrlHubs[loNames[i]] = () => rig.pinHole(eepLo, ROM_D[i]);
  }
  return {
    b, rig,
    ports: {
      eepHi, eepLo,
      stepIn: [0, 1, 2].map(i => () => rig.pinHole(eepHi, ROM_A[i])),
      opIn: [3, 4, 5, 6].map(i => () => rig.pinHole(eepHi, ROM_A[i])),
      cyIn: () => rig.pinHole(eepHi, ROM_A[7]),
      zfIn: () => rig.pinHole(eepHi, ROM_A[8]),
      ctrl: ctrlHubs,
    },
  };
}

// ===========================================================================
// BOARD R6: Signal Normalizer (2x 7404 -> 11 Active-Low) + 16 Blue Status LEDs
// ===========================================================================
export function buildControlBarBoard(c, ox = 0, oy = 0, id = 'b_r6') {
  const b = new Board('full', ox, oy, id, 'R6 · Control Normalizer & LEDs');
  c.boards.push(b);
  const rig = new BoardRig(c, b);
  rig.addBridgeRails();

  const invA = rig.placeDip('ic7404', 1); // 6 inverters: MI, RO, II, IO, AI, AO
  const invB = rig.placeDip('ic7404', 9); // 5 inverters: EO, BI, CO, J, FI + 6th: CLK -> CLK̅
  const gatesA = [[1, 2], [3, 4], [5, 6], [9, 8], [11, 10], [13, 12]];
  const invSignals = ['MI', 'RO', 'II', 'IO', 'AI', 'AO', 'EO', 'BI', 'CO', 'J', 'FI'];
  const barOrder = ['HLT', 'MI', 'RI', 'RO', 'II', 'IO', 'AI', 'AO', 'EO', 'SU', 'BI', 'OI', 'CE', 'CO', 'J', 'FI'];

  const inHubs = {}, outPts = {};
  const invMap = {};
  for (let i = 0; i < 6; i++) invMap[invSignals[i]] = { ic: invA, a: gatesA[i][0], y: gatesA[i][1] };
  for (let i = 0; i < 5; i++) invMap[invSignals[6 + i]] = { ic: invB, a: gatesA[i][0], y: gatesA[i][1] };

  for (let idx = 0; idx < barOrder.length; idx++) {
    const sig = barOrder[idx];
    const col = 18 + idx * 2; // 18..48 -> 32 cols + LEDs
    const ledSig = rig.addLed(col, 'blue', false, 220);
    rig.addNetLabel(ledSig, sig, B);
    if (invMap[sig]) {
      const m = invMap[sig];
      rig.wire(ledSig, rig.pinHole(m.ic, m.a), B);
      inHubs[sig] = () => rig.pinHole(m.ic, m.a);
      outPts[sig + '_N'] = () => rig.pinHole(m.ic, m.y);
      rig.addNetLabel(m.ic.worldPins()[m.y - 1], `${sig}\u0305`, P);
    } else {
      // Active HIGH pass-through hub (HLT, RI, SU, OI, CE)
      const h = rig.makeHub(50 + Object.keys(outPts).filter(k => !k.endsWith('_N')).length * 2, 't', B, 2);
      rig.wire(h(), ledSig, B);
      inHubs[sig] = h;
      outPts[sig] = h;
    }
  }
  // 6th gate on invB: CLK -> CLK̅
  return {
    b, rig,
    ports: {
      inHubs, outPts,
      clkIn: () => rig.pinHole(invB, 13),
      clkBarOut: () => rig.pinHole(invB, 12),
    },
  };
}

// ===========================================================================
// FULL 14-BOARD SAP-1 CPU ASSEMBLY
// ===========================================================================
export function buildSap1CpuCircuit(opts = {}) {
  const progKey = opts.program || 'fibonacci';
  const prog = SAP1_PROGRAMS[progKey] || SAP1_PROGRAMS.fibonacci;
  const c = new Circuit();
  c.name = `8-Bit Breadboard CPU (${prog.name.split(' (')[0]})`;
  c.meta = {
    project: 'COMP 400 · 8-Bit Turing-Complete CPU (SAP-1)',
    author: 'Marek Borik / Ben Eater Architecture',
    revision: '1.0',
    notes: `Program loaded: ${prog.name}. Toggle SPDT SEL on L2 for Program Mode DIP editing.`,
  };

  const DX = 74, DY = 24;
  // Left Column (7 full boards): L0..L6
  const L0 = buildPowerBusBoard(c, 0, 0 * DY, 'b_l0');
  const L1 = buildClockBoard(c, 0, 1 * DY, { potPos: opts.potPos ?? 0.015 }, 'b_l1');
  const L2 = buildRamAddrBoard(c, 0, 2 * DY, {}, 'b_l2');
  const L3 = buildRamCoreBoard(c, 0, 3 * DY, { programBytes: prog.bytes }, 'b_l3');
  const L4 = buildRamDataBoard(c, 0, 4 * DY, 'b_l4');
  const L5 = buildRegBoard(c, 0, 5 * DY, {
    label: 'L5 · Instruction Reg & Reset', busMask: 0x0f, includeReset: true,
    ledColors: ['yellow', 'yellow', 'yellow', 'yellow', 'blue', 'blue', 'blue', 'blue'],
  }, 'b_l5');
  const L6 = buildMicrocodeBoard(c, 0, 6 * DY, 'b_l6');

  // Right Column (7 full boards): R0..R6
  const R0 = buildPcBoard(c, DX, 0 * DY, 'b_r0');
  const R1 = buildRegBoard(c, DX, 1 * DY, { label: 'R1 · A Register' }, 'b_r1');
  const R2 = buildAluBoard(c, DX, 2 * DY, 'b_r2');
  const R3 = buildRegBoard(c, DX, 3 * DY, { label: 'R3 · B Register', neverDriveBus: true }, 'b_r3');
  const R4 = buildOutputBoard(c, DX, 4 * DY, { signed: !!opts.signed }, 'b_r4');
  const R5 = buildStepFlagsBoard(c, DX, 5 * DY, 'b_r5');
  const R6 = buildControlBarBoard(c, DX, 6 * DY, 'b_r6');

  // Distribute +5V / GND rails across all 14 boards cleanly
  const masterPos = L0.rig.railPt('tp', 60);
  const masterNeg = L0.rig.railPt('tn', 61);
  for (const mod of [L1, L2, L3, L4, L5, L6, R0, R1, R2, R3, R4, R5, R6]) {
    L0.rig.wire(masterPos, mod.rig.railPt('tp', 62), R);
    L0.rig.wire(masterNeg, mod.rig.railPt('tn', 61), K);
  }

  // 1) Connect 8-bit Common Data Bus across all 7 bus-attached stages
  const busTap = (i) => L0.ports.busTaps[i]();
  for (let i = 0; i < 8; i++) {
    L0.rig.wire(busTap(i), L4.ports.busIn[i](), B);
    L0.rig.wire(busTap(i), L4.ports.busOut[i](), B);
    L0.rig.wire(busTap(i), L5.ports.busIn[i](), B);
    L0.rig.wire(busTap(i), L5.ports.busOut[i](), B);
    L0.rig.wire(busTap(i), R0.ports.busOut[i](), B);
    L0.rig.wire(busTap(i), R1.ports.busIn[i](), B);
    L0.rig.wire(busTap(i), R1.ports.busOut[i](), B);
    L0.rig.wire(busTap(i), R2.ports.busOut[i](), B);
    L0.rig.wire(busTap(i), R3.ports.busIn[i](), B);
    L0.rig.wire(busTap(i), R4.ports.busIn[i](), B);
    if (i < 4) {
      L0.rig.wire(busTap(i), L2.ports.busIn[i](), B);
      L0.rig.wire(busTap(i), R0.ports.busIn[i](), B);
    }
  }

  // 2) Internal Module Data Paths (MAR->RAM, A/B->ALU->Flags, IR->Microcode)
  wireList(L2.rig, L2.ports.addrOut, L3.ports.addrIn, Y);
  wireList(L4.rig, L4.ports.muxDataOut, L3.ports.dataIn, G);
  wireList(L3.rig, L3.ports.dataOut, L4.ports.ramDataIn, G);
  L2.rig.wire(L2.ports.selOut(), L3.ports.selIn(), Y);
  L2.rig.wire(L2.ports.selOut(), L4.ports.selIn(), Y);
  L3.rig.wire(L3.ports.selBarOut(), L4.ports.selBarIn(), Y);
  L4.rig.wire(L4.ports.weBarOut(), L3.ports.weBarIn(), O);

  wireList(R1.rig, R1.ports.qPts.map(fn => fn()), R2.ports.aIn.map(fn => fn()), G);
  wireList(R3.rig, R3.ports.qPts.map(fn => fn()), R2.ports.bIn.map(fn => fn()), G);
  wireList(R2.rig, R2.ports.sum.map(fn => fn()), R5.ports.aluSumIn.map(fn => fn()), P);
  R2.rig.wire(R2.ports.cy(), R5.ports.cyIn(), Y);

  // IR top 4 bits -> Microcode A3..A6; Step T0..T2 -> Microcode A0..A2; Flags -> A7..A8
  wireList(L5.rig, [4, 5, 6, 7].map(i => L5.ports.qPts[i]()), L6.ports.opIn.map(fn => fn()), B);
  wireList(R5.rig, R5.ports.stepOut.map(fn => fn()), L6.ports.stepIn.map(fn => fn()), G);
  R5.rig.wire(R5.ports.cyOut(), L6.ports.cyIn(), Y);
  R5.rig.wire(R5.ports.zfOut(), L6.ports.zfIn(), G);

  // 3) Clock & Reset Distribution
  const clk = L1.ports.clkOut;
  L1.rig.wire(clk(), L2.ports.clkIn(), B);
  L1.rig.wire(clk(), L4.ports.clkIn(), B);
  L1.rig.wire(clk(), L5.ports.clkIn(), B);
  L1.rig.wire(clk(), R0.ports.clkIn(), B);
  L1.rig.wire(clk(), R1.ports.clkIn(), B);
  L1.rig.wire(clk(), R3.ports.clkIn(), B);
  L1.rig.wire(clk(), R5.ports.flagsClkIn(), B);
  L1.rig.wire(clk(), R5.ports.outGateClkIn(), B);
  L1.rig.wire(clk(), R6.ports.clkIn(), B);
  R6.rig.wire(R6.ports.clkBarOut(), R5.ports.clkBarIn(), W);

  const rstHigh = L5.ports.reset.rstHigh;
  const rstBar = L5.ports.reset.rstBar;
  L5.rig.wire(rstHigh(), L2.ports.clrIn(), R);
  L5.rig.wire(rstHigh(), R1.ports.clrIn(), R);
  L5.rig.wire(rstHigh(), R3.ports.clrIn(), R);
  L5.rig.wire(rstHigh(), R5.ports.flagsClrIn(), R);
  L5.rig.wire(rstBar(), R0.ports.clrBarIn(), K);
  L5.rig.wire(rstBar(), R4.ports.clrBarIn(), K);
  R5.rig.wire(R5.ports.t5BarOut(), L5.ports.reset.t5BarIn(), K);
  L5.rig.wire(L5.ports.reset.stepClrBar(), R5.ports.stepClrBarIn(), K);

  // 4) Microcode EEPROM Outputs -> Control Normalizer -> Targets
  for (const sig of Object.keys(R6.ports.inHubs)) {
    L6.rig.wire(L6.ports.ctrl[sig](), R6.ports.inHubs[sig](), Y);
  }
  const ctrl = R6.ports.outPts;
  R6.rig.wire(ctrl.HLT(), L1.ports.hltIn(), R);
  R6.rig.wire(ctrl.MI_N(), L2.ports.miBar(), P);
  R6.rig.wire(ctrl.RI(), L4.ports.riIn(), P);
  R6.rig.wire(ctrl.RO_N(), L4.ports.roBar(), P);
  R6.rig.wire(ctrl.II_N(), L5.ports.loadBar(), P);
  R6.rig.wire(ctrl.IO_N(), L5.ports.oeBar(), P);
  R6.rig.wire(ctrl.AI_N(), R1.ports.loadBar(), P);
  R6.rig.wire(ctrl.AO_N(), R1.ports.oeBar(), P);
  R6.rig.wire(ctrl.EO_N(), R2.ports.eoBar(), P);
  R6.rig.wire(ctrl.SU(), R2.ports.suIn(), O);
  R6.rig.wire(ctrl.BI_N(), R3.ports.loadBar(), P);
  R6.rig.wire(ctrl.OI(), R5.ports.outGateOiIn(), P);
  R5.rig.wire(R5.ports.outClkOut(), R4.ports.outClkIn(), B);
  R6.rig.wire(ctrl.CE(), R0.ports.ceIn(), P);
  R6.rig.wire(ctrl.CO_N(), R0.ports.coBar(), P);
  R6.rig.wire(ctrl.J_N(), R0.ports.jBarIn(), P);
  R6.rig.wire(ctrl.FI_N(), R5.ports.fiBarIn(), P);

  // Functional Zone annotations behind the 14 breadboards (purely visual grouping notes)
  const addZone = (b, text, color) => c.parts.push(new Part('zone', b.x - 1, b.y - 1.5, 0, {
    text, w: b.w + 2, h: b.h + 2.5, color,
  }));
  addZone(L0.b, 'Power & 8-Bit Bus', '#0a84ff');
  addZone(L1.b, 'Clock Module (LM555 ×3)', '#ff9f0a');
  addZone(L2.b, 'RAM Address & Prog/Run Selector', '#8e4ec6');
  addZone(L3.b, '16-Byte Static RAM (74LS189)', '#8e4ec6');
  addZone(L4.b, 'RAM Data Mux & Write Gate', '#8e4ec6');
  addZone(L5.b, 'Instruction Reg & System Reset', '#0a84ff');
  addZone(L6.b, 'Control Microcode EEPROMs (28C16)', '#30a46c');
  addZone(R0.b, 'Program Counter (74LS161)', '#30a46c');
  addZone(R1.b, 'A Register (74LS173 ×2)', '#e5484d');
  addZone(R2.b, '8-Bit ALU (74LS283 + 74LS86)', '#e5484d');
  addZone(R3.b, 'B Register (74LS173 ×2)', '#e5484d');
  addZone(R4.b, 'Output Display (28C16 + 7-Seg ×4)', '#ff9f0a');
  addZone(R5.b, 'Step Counter & Flags (ZF, CY)', '#30a46c');
  addZone(R6.b, 'Normalized Control Signal Bar', '#0a84ff');

  ensureDesignators(c);
  return {
    circuit: c,
    boards: { L0, L1, L2, L3, L4, L5, L6, R0, R1, R2, R3, R4, R5, R6 },
  };
}

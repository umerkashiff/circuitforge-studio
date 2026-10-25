/**
 * 74xx / 40xx integrated circuits. Pinouts and behaviour follow the
 * TI / Fairchild datasheets. Each `ev(c)` reads inputs with c.i(pin) (0/1),
 * detects clock edges with c.rise(pin) / c.fall(pin) (once per time step),
 * keeps memory in c.s, and drives outputs with c.o(pin, v) — v = 0, 1 or null
 * for high-impedance. c.oc() is open-collector (only pulls low).
 */

const b = (v) => (v ? 1 : 0);
const L = (s) => s.split(' ');

// ---- shared pin maps -------------------------------------------------------
const QUAD = L('1A 1B 1Y 2A 2B 2Y GND 3Y 3A 3B 4Y 4A 4B VCC');
const QUAD_MAP = [[1, 2, 3], [4, 5, 6], [9, 10, 8], [12, 13, 11]];
const HEX = L('1A 1Y 2A 2Y 3A 3Y GND 4Y 4A 5Y 5A 6Y 6A VCC');
const HEX_MAP = [[1, 2], [3, 4], [5, 6], [9, 8], [11, 10], [13, 12]];
const TRI = L('1A 1B 2A 2B 2C 2Y GND 3Y 3A 3B 3C 1Y 1C VCC');
const TRI_MAP = [[[1, 2, 13], 12], [[3, 4, 5], 6], [[9, 10, 11], 8]];
const DUAL4 = L('1A 1B NC 1C 1D 1Y GND 2Y 2A 2B NC 2C 2D VCC');
const DUAL4_MAP = [[[1, 2, 4, 5], 6], [[9, 10, 12, 13], 8]];

const quad = (fn, map = QUAD_MAP) => (c) => { for (const [x, y, q] of map) c.o(q, fn(c.i(x), c.i(y))); };
const multi = (fn, map) => (c) => { for (const [ins, q] of map) c.o(q, fn(ins.map(p => c.i(p)))); };
const and = (a) => b(a.every(Boolean));
const or = (a) => b(a.some(Boolean));

function jk(c, s, k, edge, J, K, pre, clr) {
  const p = pre ? c.i(pre) : 1, r = clr ? c.i(clr) : 1;
  if (!p || !r) { s[k] = !p ? 1 : 0; return !p && !r; }
  if (edge) {
    const j = c.i(J), kk = c.i(K);
    if (j && kk) s[k] ^= 1; else if (j) s[k] = 1; else if (kk) s[k] = 0;
  }
  return false;
}
function outQ(c, q, both, Q, Qn) { c.o(Q, both ? 1 : q); c.o(Qn, both ? 1 : 1 - q); }
const bits = (c, pins) => pins.reduce((acc, p, i) => acc | (c.i(p) << i), 0);
const outBits = (c, pins, v) => pins.forEach((p, i) => c.o(p, (v >> i) & 1));

// 7-segment patterns (bit0=a … bit6=g) as printed in the 7447/7448 datasheet
const SEG7 = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7c, 0x07, 0x7f, 0x67, 0x58, 0x4c, 0x62, 0x69, 0x78, 0x00];
function bcd7(c, activeLow) {
  const segPins = [13, 12, 11, 10, 9, 15, 14];
  const v = bits(c, [7, 1, 2, 6]);
  let pat = SEG7[v];
  if (!c.i(4)) pat = 0;              // BI/RBO
  else if (!c.i(3)) pat = 0x7f;      // lamp test
  else if (!c.i(5) && v === 0) pat = 0; // ripple blanking
  segPins.forEach((p, i) => {
    const on = (pat >> i) & 1;
    if (activeLow) c.oc(p, on ? 0 : 1); else c.pu(p, on);
  });
}

const IC_LIST = [
  // ---------------- Gates ----------------
  { id: '7400', name: 'NAND', title: 'Quad 2-input NAND', cat: 'Logic Gates', pins: QUAD, ev: quad((x, y) => b(!(x && y))) },
  { id: '7402', name: 'NOR', title: 'Quad 2-input NOR', cat: 'Logic Gates',
    pins: L('1Y 1A 1B 2Y 2A 2B GND 3A 3B 3Y 4A 4B 4Y VCC'),
    ev: quad((x, y) => b(!(x || y)), [[2, 3, 1], [5, 6, 4], [8, 9, 10], [11, 12, 13]]) },
  { id: '7404', name: 'NOT', title: 'Hex inverter', cat: 'Logic Gates', pins: HEX,
    ev: (c) => { for (const [a, y] of HEX_MAP) c.o(y, 1 - c.i(a)); } },
  { id: '7408', name: 'AND', title: 'Quad 2-input AND', cat: 'Logic Gates', pins: QUAD, ev: quad((x, y) => b(x && y)) },
  { id: '7410', name: 'NAND3', title: 'Triple 3-input NAND', cat: 'Logic Gates', pins: TRI, ev: multi(a => 1 - and(a), TRI_MAP) },
  { id: '7411', name: 'AND3', title: 'Triple 3-input AND', cat: 'Logic Gates', pins: TRI, ev: multi(and, TRI_MAP) },
  { id: '7414', name: 'NOT ST', title: 'Hex Schmitt-trigger inverter', cat: 'Logic Gates', pins: HEX, schmitt: true,
    ev: (c) => { for (const [a, y] of HEX_MAP) c.o(y, 1 - c.i(a)); } },
  { id: '7420', name: 'NAND4', title: 'Dual 4-input NAND', cat: 'Logic Gates', pins: DUAL4, ev: multi(a => 1 - and(a), DUAL4_MAP) },
  { id: '7421', name: 'AND4', title: 'Dual 4-input AND', cat: 'Logic Gates', pins: DUAL4, ev: multi(and, DUAL4_MAP) },
  { id: '7427', name: 'NOR3', title: 'Triple 3-input NOR', cat: 'Logic Gates', pins: TRI, ev: multi(a => 1 - or(a), TRI_MAP) },
  { id: '7430', name: 'NAND8', title: '8-input NAND', cat: 'Logic Gates', pins: L('A B C D E F GND Y NC NC G H NC VCC'),
    ev: multi(a => 1 - and(a), [[[1, 2, 3, 4, 5, 6, 11, 12], 8]]) },
  { id: '7432', name: 'OR', title: 'Quad 2-input OR', cat: 'Logic Gates', pins: QUAD, ev: quad((x, y) => b(x || y)) },
  { id: '7486', name: 'XOR', title: 'Quad 2-input XOR', cat: 'Logic Gates', pins: QUAD, ev: quad((x, y) => x ^ y) },
  { id: '74266', name: 'XNOR', title: 'Quad 2-input XNOR (open collector)', cat: 'Logic Gates',
    pins: L('1A 1B 1Y 2Y 2A 2B GND 3A 3B 3Y 4Y 4A 4B VCC'),
    ev: (c) => { for (const [x, y, q] of [[1, 2, 3], [5, 6, 4], [8, 9, 10], [12, 13, 11]]) c.oc(q, 1 - (c.i(x) ^ c.i(y))); } },

  // ---------------- Arithmetic ----------------
  { id: '7483', name: 'ADD4', title: '4-bit binary full adder', cat: 'Arithmetic', vcc: 5, gnd: 12,
    pins: L('A4 Σ3 A3 B3 VCC Σ2 B2 A2 Σ1 A1 B1 GND C0 C4 Σ4 B4'),
    ev: (c) => { const s = bits(c, [10, 8, 3, 1]) + bits(c, [11, 7, 4, 16]) + c.i(13); outBits(c, [9, 6, 2, 15, 14], s); } },
  { id: '74283', name: 'ADD4', title: '4-bit binary full adder, fast carry', cat: 'Arithmetic',
    pins: L('Σ2 B2 A2 Σ1 A1 B1 C0 GND C4 Σ4 B4 A4 Σ3 A3 B3 VCC'),
    ev: (c) => { const s = bits(c, [5, 3, 14, 12]) + bits(c, [6, 2, 15, 11]) + c.i(7); outBits(c, [4, 1, 13, 10, 9], s); } },
  { id: '7485', name: 'CMP4', title: '4-bit magnitude comparator', cat: 'Arithmetic',
    pins: L('B3 A<Bi A=Bi A>Bi A>Bo A=Bo A<Bo GND B0 A0 B1 A1 A2 B2 A3 VCC'),
    ev: (c) => {
      const A = bits(c, [10, 12, 13, 15]), B = bits(c, [9, 11, 14, 1]);
      let gt, eq, lt;
      if (A > B) [gt, eq, lt] = [1, 0, 0];
      else if (A < B) [gt, eq, lt] = [0, 0, 1];
      else if (c.i(3)) [gt, eq, lt] = [0, 1, 0];
      else if (c.i(4) && c.i(2)) [gt, eq, lt] = [0, 0, 0];
      else if (!c.i(4) && !c.i(2)) [gt, eq, lt] = [1, 0, 1];
      else [gt, eq, lt] = [c.i(4), 0, c.i(2)];
      c.o(5, gt); c.o(6, eq); c.o(7, lt);
    } },

  // ---------------- Decoders / Mux ----------------
  { id: '74138', name: 'DEC 3:8', title: '3-to-8 decoder, active-low outputs', cat: 'Decoders & Mux',
    pins: L('A B C G2A G2B G1 Y7 GND Y6 Y5 Y4 Y3 Y2 Y1 Y0 VCC'),
    ev: (c) => { const en = c.i(6) && !c.i(4) && !c.i(5), k = bits(c, [1, 2, 3]);
      [15, 14, 13, 12, 11, 10, 9, 7].forEach((p, i) => c.o(p, b(!(en && k === i)))); } },
  { id: '74238', name: 'DEC 3:8', title: '3-to-8 decoder, active-high outputs', cat: 'Decoders & Mux',
    pins: L('A B C G2A G2B G1 Y7 GND Y6 Y5 Y4 Y3 Y2 Y1 Y0 VCC'),
    ev: (c) => { const en = c.i(6) && !c.i(4) && !c.i(5), k = bits(c, [1, 2, 3]);
      [15, 14, 13, 12, 11, 10, 9, 7].forEach((p, i) => c.o(p, b(en && k === i))); } },
  { id: '74139', name: 'DEC 2:4', title: 'Dual 2-to-4 decoder', cat: 'Decoders & Mux',
    pins: L('1G 1A 1B 1Y0 1Y1 1Y2 1Y3 GND 2Y3 2Y2 2Y1 2Y0 2B 2A 2G VCC'),
    ev: (c) => {
      const k1 = bits(c, [2, 3]), k2 = bits(c, [14, 13]);
      [4, 5, 6, 7].forEach((p, i) => c.o(p, b(!(!c.i(1) && k1 === i))));
      [12, 11, 10, 9].forEach((p, i) => c.o(p, b(!(!c.i(15) && k2 === i))));
    } },
  { id: '74148', name: 'ENC 8:3', title: '8-to-3 priority encoder', cat: 'Decoders & Mux',
    pins: L('4 5 6 7 EI A2 A1 GND A0 0 1 2 3 GS EO VCC'),
    ev: (c) => {
      const ins = [10, 11, 12, 13, 1, 2, 3, 4];
      if (c.i(5)) { [9, 7, 6, 14, 15].forEach(p => c.o(p, 1)); return; }
      let k = -1; for (let n = 7; n >= 0; n--) if (!c.i(ins[n])) { k = n; break; }
      if (k < 0) { outBits(c, [9, 7, 6], 7); c.o(14, 1); c.o(15, 0); return; }
      outBits(c, [9, 7, 6], 7 - k); c.o(14, 0); c.o(15, 1);
    } },
  { id: '74151', name: 'MUX 8:1', title: '8-to-1 data selector', cat: 'Decoders & Mux',
    pins: L('D3 D2 D1 D0 Y W G GND C B A D7 D6 D5 D4 VCC'),
    ev: (c) => { const D = [4, 3, 2, 1, 15, 14, 13, 12]; const y = c.i(7) ? 0 : c.i(D[bits(c, [11, 10, 9])]); c.o(5, y); c.o(6, 1 - y); } },
  { id: '74153', name: 'MUX 4:1', title: 'Dual 4-to-1 data selector', cat: 'Decoders & Mux',
    pins: L('1G B 1C3 1C2 1C1 1C0 1Y GND 2Y 2C0 2C1 2C2 2C3 A 2G VCC'),
    ev: (c) => { const k = bits(c, [14, 2]);
      c.o(7, c.i(1) ? 0 : c.i([6, 5, 4, 3][k])); c.o(9, c.i(15) ? 0 : c.i([10, 11, 12, 13][k])); } },
  { id: '74157', name: 'MUX 2:1', title: 'Quad 2-to-1 data selector', cat: 'Decoders & Mux',
    pins: L('S 1A 1B 1Y 2A 2B 2Y GND 3Y 3B 3A 4Y 4B 4A G VCC'),
    ev: (c) => { for (const [a, bb, y] of [[2, 3, 4], [5, 6, 7], [11, 10, 9], [14, 13, 12]]) c.o(y, c.i(15) ? 0 : c.i(c.i(1) ? bb : a)); } },
  { id: '74158', name: 'MUX 2:1 INV', title: 'Quad 2-to-1 selector, inverting', cat: 'Decoders & Mux',
    pins: L('S 1A 1B 1Y 2A 2B 2Y GND 3Y 3B 3A 4Y 4B 4A G VCC'),
    ev: (c) => { for (const [a, bb, y] of [[2, 3, 4], [5, 6, 7], [11, 10, 9], [14, 13, 12]]) c.o(y, c.i(15) ? 1 : 1 - c.i(c.i(1) ? bb : a)); } },
  { id: '7447', name: 'BCD→7SEG', title: 'BCD to 7-segment, active-low (common anode)', cat: 'Decoders & Mux',
    pins: L('B C LT BI/RBO RBI D A GND e d c b a g f VCC'), ev: (c) => bcd7(c, true) },
  { id: '7448', name: 'BCD→7SEG', title: 'BCD to 7-segment, active-high (common cathode)', cat: 'Decoders & Mux',
    pins: L('B C LT BI/RBO RBI D A GND e d c b a g f VCC'), ev: (c) => bcd7(c, false) },

  // ---------------- Flip-flops & latches ----------------
  { id: '7474', name: 'D FF', title: 'Dual D flip-flop, rising edge', cat: 'Flip-Flops',
    pins: L('1CLR 1D 1CLK 1PRE 1Q 1Q̅ GND 2Q̅ 2Q 2PRE 2CLK 2D 2CLR VCC'), init: () => [0, 0],
    ev: (c) => {
      for (const [k, clr, d, ck, pre, q, qn] of [[0, 1, 2, 3, 4, 5, 6], [1, 13, 12, 11, 10, 9, 8]]) {
        const e = c.rise(ck); const p = c.i(pre), r = c.i(clr);
        if (!p || !r) c.s[k] = !p ? 1 : 0; else if (e) c.s[k] = c.i(d);
        outQ(c, c.s[k], !p && !r, q, qn);
      }
    } },
  { id: '7473', name: 'JK FF', title: 'Dual JK flip-flop with clear, falling edge', cat: 'Flip-Flops', vcc: 4, gnd: 11,
    pins: L('1CLK 1CLR 1K VCC 2CLK 2CLR 2J 2Q̅ 2Q 2K GND 1Q 1Q̅ 1J'), init: () => [0, 0],
    ev: (c) => {
      const b0 = jk(c, c.s, 0, c.fall(1), 14, 3, null, 2);
      outQ(c, c.s[0], b0, 12, 13);
      const b1 = jk(c, c.s, 1, c.fall(5), 7, 10, null, 6);
      outQ(c, c.s[1], b1, 9, 8);
    } },
  { id: '7476', name: 'JK FF', title: 'Dual JK flip-flop, falling edge', cat: 'Flip-Flops', vcc: 5, gnd: 13,
    pins: L('1CLK 1PRE 1CLR 1J VCC 2CLK 2PRE 2CLR 2J 2Q̅ 2Q 2K GND 1Q̅ 1Q 1K'), init: () => [0, 0],
    ev: (c) => {
      const b0 = jk(c, c.s, 0, c.fall(1), 4, 16, 2, 3);
      outQ(c, c.s[0], b0, 15, 14);
      const b1 = jk(c, c.s, 1, c.fall(6), 9, 12, 7, 8);
      outQ(c, c.s[1], b1, 11, 10);
    } },
  { id: '74112', name: 'JK FF', title: 'Dual JK flip-flop, falling edge', cat: 'Flip-Flops',
    pins: L('1CLK 1K 1J 1PRE 1Q 1Q̅ 2Q̅ GND 2Q 2PRE 2J 2K 2CLK 2CLR 1CLR VCC'), init: () => [0, 0],
    ev: (c) => {
      const b0 = jk(c, c.s, 0, c.fall(1), 3, 2, 4, 15);
      outQ(c, c.s[0], b0, 5, 6);
      const b1 = jk(c, c.s, 1, c.fall(13), 11, 12, 10, 14);
      outQ(c, c.s[1], b1, 9, 7);
    } },
  { id: '74175', name: '4× D FF', title: 'Quad D flip-flop with clear', cat: 'Flip-Flops',
    pins: L('CLR 1Q 1Q̅ 1D 2D 2Q̅ 2Q GND CLK 3Q 3Q̅ 3D 4D 4Q̅ 4Q VCC'), init: () => [0],
    ev: (c) => {
      const e = c.rise(9);
      if (!c.i(1)) c.s[0] = 0; else if (e) c.s[0] = bits(c, [4, 5, 12, 13]);
      [[2, 3], [7, 6], [10, 11], [15, 14]].forEach(([q, qn], i) => { const v = (c.s[0] >> i) & 1; c.o(q, v); c.o(qn, 1 - v); });
    } },
  { id: '74273', name: '8× D FF', title: 'Octal D flip-flop with clear', cat: 'Flip-Flops',
    pins: L('CLR 1Q 1D 2D 2Q 3Q 3D 4D 4Q GND CLK 5Q 5D 6D 6Q 7Q 7D 8D 8Q VCC'), init: () => [0],
    ev: (c) => {
      const e = c.rise(11);
      if (!c.i(1)) c.s[0] = 0; else if (e) c.s[0] = bits(c, [3, 4, 7, 8, 13, 14, 17, 18]);
      outBits(c, [2, 5, 6, 9, 12, 15, 16, 19], c.s[0]);
    } },
  { id: '74574', name: '8× D FF 3S', title: 'Octal D flip-flop, 3-state', cat: 'Flip-Flops',
    pins: L('OE D1 D2 D3 D4 D5 D6 D7 D8 GND CLK Q8 Q7 Q6 Q5 Q4 Q3 Q2 Q1 VCC'), init: () => [0],
    ev: (c) => {
      if (c.rise(11)) c.s[0] = bits(c, [2, 3, 4, 5, 6, 7, 8, 9]);
      const Q = [19, 18, 17, 16, 15, 14, 13, 12];
      if (c.i(1)) Q.forEach(p => c.o(p, null)); else outBits(c, Q, c.s[0]);
    } },
  { id: '74373', name: '8× LATCH', title: 'Octal transparent latch, 3-state', cat: 'Flip-Flops',
    pins: L('OE 1Q 1D 2D 2Q 3Q 3D 4D 4Q GND LE 5Q 5D 6D 6Q 7Q 7D 8D 8Q VCC'), init: () => [0],
    ev: (c) => {
      if (c.i(11)) c.s[0] = bits(c, [3, 4, 7, 8, 13, 14, 17, 18]);
      const Q = [2, 5, 6, 9, 12, 15, 16, 19];
      if (c.i(1)) Q.forEach(p => c.o(p, null)); else outBits(c, Q, c.s[0]);
    } },
  { id: '74279', name: '4× S̅R̅', title: 'Quad S̅-R̅ latch', cat: 'Flip-Flops', vcc: 16, gnd: 8,
    pins: L('1R 1S1 1S2 1Q 2R 2S 2Q GND 3Q 3R 3S1 3S2 4Q 4R 4S VCC'), init: () => [0, 0, 0, 0],
    ev: (c) => {
      const L4 = [[[2, 3], 1, 4], [[6], 5, 7], [[11, 12], 10, 9], [[15], 14, 13]];
      L4.forEach(([S, R, Q], k) => {
        if (S.some(p => !c.i(p))) c.s[k] = 1; else if (!c.i(R)) c.s[k] = 0;
        c.o(Q, c.s[k]);
      });
    } },
  { id: '4013', name: 'D FF', title: 'Dual D flip-flop (CMOS), rising edge', cat: 'Flip-Flops', cmos: true,
    pins: L('Q1 Q̅1 CLK1 R1 D1 S1 VSS S2 D2 R2 CLK2 Q̅2 Q2 VDD'), init: () => [0, 0],
    ev: (c) => {
      for (const [k, q, qn, ck, r, d, s] of [[0, 1, 2, 3, 4, 5, 6], [1, 13, 12, 11, 10, 9, 8]]) {
        const e = c.rise(ck), S = c.i(s), R = c.i(r);
        if (S || R) c.s[k] = S ? 1 : 0; else if (e) c.s[k] = c.i(d);
        outQ(c, c.s[k], S && R, q, qn);
      }
    } },

  // ---------------- Counters & shift registers ----------------
  { id: '7490', name: 'DECADE', title: 'Decade counter (÷2 and ÷5)', cat: 'Counters', vcc: 5, gnd: 10,
    pins: L('CKB R0(1) R0(2) NC VCC R9(1) R9(2) QC QB GND QD QA NC CKA'), init: () => [0, 0],
    ev: (c) => {
      const ea = c.fall(14), eb = c.fall(1);
      if (c.i(6) && c.i(7)) { c.s[0] = 1; c.s[1] = 4; }
      else if (c.i(2) && c.i(3)) { c.s[0] = 0; c.s[1] = 0; }
      else { if (ea) c.s[0] ^= 1; if (eb) c.s[1] = (c.s[1] + 1) % 5; }
      c.o(12, c.s[0]); c.o(9, c.s[1] & 1); c.o(8, (c.s[1] >> 1) & 1); c.o(11, (c.s[1] >> 2) & 1);
    } },
  { id: '7493', name: 'BINARY', title: '4-bit binary ripple counter', cat: 'Counters', vcc: 5, gnd: 10,
    pins: L('CKB R0(1) R0(2) NC VCC NC NC QC QB GND QD QA NC CKA'), init: () => [0, 0],
    ev: (c) => {
      const ea = c.fall(14), eb = c.fall(1);
      if (c.i(2) && c.i(3)) { c.s[0] = 0; c.s[1] = 0; }
      else { if (ea) c.s[0] ^= 1; if (eb) c.s[1] = (c.s[1] + 1) & 7; }
      c.o(12, c.s[0]); c.o(9, c.s[1] & 1); c.o(8, (c.s[1] >> 1) & 1); c.o(11, (c.s[1] >> 2) & 1);
    } },
  { id: '74193', name: 'UP/DOWN', title: 'Synchronous 4-bit up/down counter', cat: 'Counters',
    pins: L('B QB QA DOWN UP QC QD GND D C LOAD CO BO CLR A VCC'), init: () => [0],
    ev: (c) => {
      const up = c.rise(5), dn = c.rise(4);
      if (c.i(14)) c.s[0] = 0;
      else if (!c.i(11)) c.s[0] = bits(c, [15, 1, 10, 9]);
      else if (up && c.i(4)) c.s[0] = (c.s[0] + 1) & 15;
      else if (dn && c.i(5)) c.s[0] = (c.s[0] + 15) & 15;
      outBits(c, [3, 2, 6, 7], c.s[0]);
      c.o(12, b(!(c.s[0] === 15 && !c.i(5)))); c.o(13, b(!(c.s[0] === 0 && !c.i(4))));
    } },
  { id: '4017', name: 'DECADE', title: 'Decade counter, 10 decoded outputs (CMOS)', cat: 'Counters', cmos: true,
    pins: L('Q5 Q1 Q0 Q2 Q6 Q7 Q3 VSS Q8 Q4 Q9 CO INH CLK RST VDD'), init: () => [0],
    ev: (c) => {
      const e = c.rise(14);
      if (c.i(15)) c.s[0] = 0; else if (e && !c.i(13)) c.s[0] = (c.s[0] + 1) % 10;
      [3, 2, 4, 7, 10, 1, 5, 6, 9, 11].forEach((p, i) => c.o(p, b(c.s[0] === i)));
      c.o(12, b(c.s[0] < 5));
    } },
  { id: '74194', name: 'SHIFT 4', title: '4-bit universal shift register', cat: 'Counters',
    pins: L('CLR SR A B C D SL GND S0 S1 CLK QD QC QB QA VCC'), init: () => [0],
    ev: (c) => {
      const e = c.rise(11);
      if (!c.i(1)) c.s[0] = 0;
      else if (e) {
        const m = c.i(9) | (c.i(10) << 1), q = c.s[0];
        if (m === 3) c.s[0] = bits(c, [3, 4, 5, 6]);
        else if (m === 1) c.s[0] = ((q << 1) & 14) | c.i(2);
        else if (m === 2) c.s[0] = (q >> 1) | (c.i(7) << 3);
      }
      outBits(c, [15, 14, 13, 12], c.s[0]);
    } },
  { id: '74165', name: 'PISO 8', title: '8-bit parallel-in serial-out shift register', cat: 'Counters',
    pins: L('SH/LD CLK E F G H Q̅H GND QH SER A B C D INH VCC'), init: () => [0],
    ev: (c) => {
      const e = c.rise(2);
      if (!c.i(1)) c.s[0] = bits(c, [11, 12, 13, 14, 3, 4, 5, 6]);
      else if (e && !c.i(15)) c.s[0] = ((c.s[0] << 1) & 0xfe) | c.i(10);
      const h = (c.s[0] >> 7) & 1; c.o(9, h); c.o(7, 1 - h);
    } },
  { id: '74595', name: 'SIPO 8', title: '8-bit shift register with output latch', cat: 'Counters',
    pins: L('QB QC QD QE QF QG QH GND QH′ SRCLR SRCLK RCLK OE SER QA VCC'), init: () => [0, 0],
    ev: (c) => {
      const er = c.rise(12), es = c.rise(11);
      if (er) c.s[1] = c.s[0];
      if (!c.i(10)) c.s[0] = 0; else if (es) c.s[0] = ((c.s[0] << 1) & 0xfe) | c.i(14);
      const Q = [15, 1, 2, 3, 4, 5, 6, 7];
      if (c.i(13)) Q.forEach(p => c.o(p, null)); else outBits(c, Q, c.s[1]);
      c.o(9, (c.s[0] >> 7) & 1);
    } },

  // ---------------- Buffers ----------------
  { id: '74125', name: 'BUF 3S', title: 'Quad 3-state buffer, active-low enable', cat: 'Buffers',
    pins: L('1OE 1A 1Y 2OE 2A 2Y GND 3Y 3A 3OE 4Y 4A 4OE VCC'),
    ev: (c) => { for (const [oe, a, y] of [[1, 2, 3], [4, 5, 6], [10, 9, 8], [13, 12, 11]]) c.o(y, c.i(oe) ? null : c.i(a)); } },
  { id: '74126', name: 'BUF 3S', title: 'Quad 3-state buffer, active-high enable', cat: 'Buffers',
    pins: L('1OE 1A 1Y 2OE 2A 2Y GND 3Y 3A 3OE 4Y 4A 4OE VCC'),
    ev: (c) => { for (const [oe, a, y] of [[1, 2, 3], [4, 5, 6], [10, 9, 8], [13, 12, 11]]) c.o(y, c.i(oe) ? c.i(a) : null); } },
  { id: '74240', name: 'INV 8', title: 'Octal inverting buffer, 3-state', cat: 'Buffers',
    pins: L('1OE 1A1 2Y4 1A2 2Y3 1A3 2Y2 1A4 2Y1 GND 2A1 1Y4 2A2 1Y3 2A3 1Y2 2A4 1Y1 2OE VCC'),
    ev: (c) => oct244(c, true) },
  { id: '74244', name: 'BUF 8', title: 'Octal buffer, 3-state', cat: 'Buffers',
    pins: L('1OE 1A1 2Y4 1A2 2Y3 1A3 2Y2 1A4 2Y1 GND 2A1 1Y4 2A2 1Y3 2A3 1Y2 2A4 1Y1 2OE VCC'),
    ev: (c) => oct244(c, false) },
  { id: '74245', name: 'XCVR 8', title: 'Octal bus transceiver, 3-state', cat: 'Buffers',
    pins: L('DIR A1 A2 A3 A4 A5 A6 A7 A8 GND B8 B7 B6 B5 B4 B3 B2 B1 OE VCC'),
    ev: (c) => {
      const A = [2, 3, 4, 5, 6, 7, 8, 9], B = [18, 17, 16, 15, 14, 13, 12, 11];
      const en = !c.i(19), dir = c.i(1);
      for (let k = 0; k < 8; k++) {
        if (en && dir) { c.o(B[k], c.i(A[k])); c.o(A[k], null); }
        else if (en) { c.o(A[k], c.i(B[k])); c.o(B[k], null); }
        else { c.o(A[k], null); c.o(B[k], null); }
      }
    } },
  { id: '74541', name: 'BUF 8', title: 'Octal buffer, flow-through, 3-state', cat: 'Buffers',
    pins: L('OE1 A1 A2 A3 A4 A5 A6 A7 A8 GND Y8 Y7 Y6 Y5 Y4 Y3 Y2 Y1 OE2 VCC'),
    ev: (c) => { const en = !c.i(1) && !c.i(19); const Y = [18, 17, 16, 15, 14, 13, 12, 11];
      [2, 3, 4, 5, 6, 7, 8, 9].forEach((a, k) => c.o(Y[k], en ? c.i(a) : null)); } },
];

function oct244(c, inv) {
  const g1 = [[2, 18], [4, 16], [6, 14], [8, 12]], g2 = [[11, 9], [13, 7], [15, 5], [17, 3]];
  for (const [oe, grp] of [[1, g1], [19, g2]]) {
    for (const [a, y] of grp) c.o(y, c.i(oe) ? null : (inv ? 1 - c.i(a) : c.i(a)));
  }
}

for (const ic of IC_LIST) {
  const n = ic.pins.length;
  ic.n = n;
  ic.vcc = ic.vcc || n;
  ic.gnd = ic.gnd || n / 2;
}

export { IC_LIST };

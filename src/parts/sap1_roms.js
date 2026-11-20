/**
 * Precomputed 2K x 8 EEPROM images & 16-byte sample RAM programs
 * for Marek Borik's COMP 400 / Ben Eater SAP-1 8-bit Breadboard CPU.
 */

// 7-segment active-high bitmask: bit0=a, bit1=b, bit2=c, bit3=d, bit4=e, bit5=f, bit6=g, bit7=DP
const DIGIT_SEG7 = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f];
const SEG_MINUS = 0x40; // segment g

// 16-bit control word bits matching Marek p. 15 signal bar (1 = ACTIVE in normalized logic)
export const CTRL = {
  FI:  1 << 0,
  J:   1 << 1,
  CO:  1 << 2,
  CE:  1 << 3,
  OI:  1 << 4,
  BI:  1 << 5,
  SU:  1 << 6,
  EO:  1 << 7,
  AO:  1 << 8,
  AI:  1 << 9,
  IO:  1 << 10,
  II:  1 << 11,
  RO:  1 << 12,
  RI:  1 << 13,
  MI:  1 << 14,
  HLT: 1 << 15,
};

export const OPCODES = {
  NOP: 0x0,
  LDA: 0x1,
  ADD: 0x2,
  SUB: 0x3,
  STA: 0x4,
  LDI: 0x5,
  JMP: 0x6,
  JC:  0x7,
  JZ:  0x8,
  ADI: 0x9,
  SUI: 0xA,
  OAH: 0xB,
  OUT: 0xE,
  HLT: 0xF,
};

/**
 * Output Module 28C16 (2K x 8) EEPROM image.
 * Address bits: A10 = signed (1 = [-128..127], 0 = [0..255]), A9..A8 = digit mux (0=ones, 1=tens, 2=hundreds, 3=sign),
 * A7..A0 = 8-bit binary value. Output bits: D0..D7 = a..g, DP.
 */
export function buildSap1DisplayRom() {
  const rom = new Uint8Array(2048);
  for (let signed = 0; signed <= 1; signed++) {
    for (let val = 0; val < 256; val++) {
      const neg = signed && val >= 128;
      const mag = neg ? 256 - val : val;
      const d0 = mag % 10;
      const d1 = Math.floor(mag / 10) % 10;
      const d2 = Math.floor(mag / 100) % 10;
      const base = (signed << 10) | val;
      rom[base | (0 << 8)] = DIGIT_SEG7[d0];
      rom[base | (1 << 8)] = DIGIT_SEG7[d1];
      rom[base | (2 << 8)] = DIGIT_SEG7[d2];
      rom[base | (3 << 8)] = neg ? SEG_MINUS : 0x00;
    }
  }
  return rom;
}

const { HLT, MI, RI, RO, II, IO, AI, AO, EO, SU, BI, OI, CE, CO, J, FI } = CTRL;

const UCODE_BASE = [
  /* 0000 NOP */ [MI | CO, RO | II | CE, 0,       0,            0],
  /* 0001 LDA */ [MI | CO, RO | II | CE, IO | MI, RO | AI,      0],
  /* 0010 ADD */ [MI | CO, RO | II | CE, IO | MI, RO | BI,      EO | AI | FI],
  /* 0011 SUB */ [MI | CO, RO | II | CE, IO | MI, RO | BI,      EO | AI | SU | FI],
  /* 0100 STA */ [MI | CO, RO | II | CE, IO | MI, AO | RI,      0],
  /* 0101 LDI */ [MI | CO, RO | II | CE, IO | AI, 0,            0],
  /* 0110 JMP */ [MI | CO, RO | II | CE, IO | J,  0,            0],
  /* 0111 JC  */ [MI | CO, RO | II | CE, 0,       0,            0],
  /* 1000 JZ  */ [MI | CO, RO | II | CE, 0,       0,            0],
  /* 1001 ADI */ [MI | CO, RO | II | CE, IO | BI, EO | AI | FI, 0],
  /* 1010 SUI */ [MI | CO, RO | II | CE, IO | BI, EO | AI | SU | FI, 0],
  /* 1011 OAH */ [MI | CO, RO | II | CE, IO | MI, RO | OI,      HLT],
  /* 1100 --- */ [MI | CO, RO | II | CE, 0,       0,            0],
  /* 1101 --- */ [MI | CO, RO | II | CE, 0,       0,            0],
  /* 1110 OUT */ [MI | CO, RO | II | CE, AO | OI, 0,            0],
  /* 1111 HLT */ [MI | CO, RO | II | CE, HLT,     0,            0],
];

/**
 * Control Logic 28C16 pair (2K x 8 each, normalized active-HIGH outputs).
 * Address lines: A2..A0 = step (0..4), A6..A3 = opcode (0..15), A7 = CY, A8 = ZF.
 * `lo` drives D7..D0 = [EO, SU, BI, OI, CE, CO, J, FI].
 * `hi` drives D7..D0 = [HLT, MI, RI, RO, II, IO, AI, AO].
 */
export function buildSap1MicrocodeRoms() {
  const lo = new Uint8Array(2048);
  const hi = new Uint8Array(2048);
  for (let zf = 0; zf <= 1; zf++) {
    for (let cy = 0; cy <= 1; cy++) {
      for (let op = 0; op < 16; op++) {
        for (let step = 0; step < 8; step++) {
          let w = step < 5 ? UCODE_BASE[op][step] : 0;
          if (op === OPCODES.JC && cy && step === 2) w = IO | J;
          if (op === OPCODES.JZ && zf && step === 2) w = IO | J;
          const addr = (zf << 8) | (cy << 7) | (op << 3) | step;
          lo[addr] = w & 0xff;
          hi[addr] = (w >> 8) & 0xff;
        }
      }
    }
  }
  return { lo, hi };
}

let cachedRoms = null;
function roms() {
  if (!cachedRoms) {
    const mc = buildSap1MicrocodeRoms();
    cachedRoms = {
      sap1_display: buildSap1DisplayRom(),
      sap1_ucode_lo: mc.lo,
      sap1_ucode_hi: mc.hi,
    };
  }
  return cachedRoms;
}

export function hexToBytes(hex, len) {
  const out = new Uint8Array(len);
  const clean = String(hex || '').replace(/[^0-9a-fA-F]/g, '');
  const n = Math.min(len, Math.floor(clean.length / 2));
  for (let i = 0; i < n; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(arr) {
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

export function hexToNibbles(hex) {
  const out = new Uint8Array(16);
  const clean = String(hex || '').replace(/[^0-9a-fA-F]/g, '');
  for (let i = 0; i < Math.min(16, clean.length); i++) out[i] = parseInt(clean[i], 16) & 0xf;
  return out;
}

export function nibblesToHex(bytes, high = false) {
  return Array.from(bytes.slice(0, 16), b => ((high ? (b >> 4) : b) & 0xf).toString(16)).join('');
}

export function resolve28c16Rom(props) {
  const preset = props?.preset || 'blank';
  const r = roms();
  if (r[preset]) return r[preset];
  return hexToBytes(props?.rom, 2048);
}

const ins = (op, arg = 0) => ((op & 0xf) << 4) | (arg & 0xf);
const { NOP, LDA, ADD, SUB, STA, LDI, JMP, JC, JZ, ADI, SUI, OAH, OUT, HLT: HLT_OP } = OPCODES;

/** Marek report pp. 18-19 sample programs packed into 16 bytes of RAM. */
export const SAP1_PROGRAMS = {
  fibonacci: {
    name: 'Fibonacci Sequence (Marek p. 18)',
    bytes: [
      ins(LDI, 1),   // 0: A = 1
      ins(STA, 14),  // 1: mem[14] = 1
      ins(LDI, 0),   // 2: A = 0
      ins(STA, 15),  // 3: mem[15] = 0
      ins(OUT, 0),   // 4: display A
      ins(LDA, 14),  // 5: A = mem[14]
      ins(ADD, 15),  // 6: A = A + mem[15]
      ins(STA, 14),  // 7: mem[14] = A
      ins(OUT, 0),   // 8: display A
      ins(LDA, 15),  // 9: A = mem[15]
      ins(ADD, 14),  // 10: A = A + mem[14]
      ins(JC, 0),    // 11: overflow -> restart
      ins(JMP, 3),   // 12: loop storing new A in mem[15]
      ins(HLT_OP, 0),// 13
      0x00,          // 14
      0x00,          // 15
    ],
  },
  powers2: {
    name: 'Powers of 2 (Marek p. 19)',
    bytes: [
      ins(LDI, 1),   // 0: A = 1
      ins(STA, 15),  // 1: mem[15] = 1
      ins(LDA, 15),  // 2: A = mem[15]
      ins(OUT, 0),   // 3: display A
      ins(ADD, 15),  // 4: A = 2 * mem[15]
      ins(JC, 0),    // 5: overflow (>128 -> 256) -> restart
      ins(JMP, 1),   // 6: store doubled A & continue
      0, 0, 0, 0, 0, 0, 0, 0, 0,
    ],
  },
  multiply: {
    name: 'Multiply X * Y (Marek p. 19: 7 * 9 = 63)',
    bytes: [
      ins(LDA, 14),  // 0: A = X (counter)
      ins(SUB, 12),  // 1: A = X - 1 (CY=1 if X>=1, CY=0 if X==0 underflow)
      ins(JC, 6),    // 2: if X>=1 continue loop
      ins(LDA, 13),  // 3: product accumulator
      ins(OUT, 0),   // 4: output result
      ins(HLT_OP, 0),// 5: halt
      ins(STA, 14),  // 6: X = X - 1
      ins(LDA, 13),  // 7: A = acc
      ins(ADD, 15),  // 8: acc += Y
      ins(STA, 13),  // 9: save acc
      ins(JMP, 0),   // 10: repeat
      ins(NOP, 0),   // 11
      1,             // 12: ONE
      0,             // 13: ZERO / product accumulator
      7,             // 14: X
      9,             // 15: Y
    ],
  },
};

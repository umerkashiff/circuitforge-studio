/**
 * I2C Peripheral Device Models for CircuitForge.
 *
 * Implements:
 * 1. SSD1306 (128x64) and SH1107 (128x128) OLED displays.
 * 2. LCD1602 and LCD2004 with PCF8574 backpack.
 * 3. MPU6050 6-axis Gyroscope & Accelerometer.
 * 4. DS1307 Real-Time Clock with NVRAM.
 * 5. BMP180 Barometric Pressure & Temperature Sensor.
 */

import { I2CBus } from './i2c.js';

const ok = (v) => !Number.isNaN(v);

// ============================================================================
// 1. SSD1306 / SH1107 OLED Display
// ============================================================================
export function oledDevice(part, nets, options = {}) {
  const [gnd, vcc, scl, sda] = nets;
  const width = options.width || 128;
  const height = options.height || 64;
  const isSH1107 = options.sh1107 || false;
  const totalPages = height / 8;
  const buffer = new Uint8Array((width * height) / 8);

  const d = {
    type: options.type || 'ssd1306',
    part,
    powered: false,
    addr: part.props.i2cAddress ? (typeof part.props.i2cAddress === 'string' ? parseInt(part.props.i2cAddress, 16) : part.props.i2cAddress) : 0x3C,
    width,
    height,
    buffer,
    colStart: 0,
    colEnd: width - 1,
    pageStart: 0,
    pageEnd: totalPages - 1,
    col: 0,
    page: 0,
    addressingMode: 0, // 0: Horizontal, 1: Vertical, 2: Page
    contrast: 0x7F,
    inverse: false,
    entireOn: false,
    displayOn: true,
    warning: null,

    reset() {
      this.buffer.fill(0);
      this.col = 0;
      this.page = 0;
      this.addressingMode = 0;
      this.inverse = false;
      this.displayOn = true;
    },

    adopt(old) {
      if (old.buffer && old.buffer.length === this.buffer.length) {
        this.buffer.set(old.buffer);
        this.col = old.col;
        this.page = old.page;
        this.addressingMode = old.addressingMode;
        this.inverse = old.inverse;
        this.displayOn = old.displayOn;
      }
    },

    executeCommand(cmd) {
      // Basic SSD1306 / SH1107 commands
      if (cmd >= 0x00 && cmd <= 0x0F) {
        // Lower column start
        this.col = (this.col & 0xF0) | (cmd & 0x0F);
      } else if (cmd >= 0x10 && cmd <= 0x1F) {
        // Higher column start
        this.col = (this.col & 0x0F) | ((cmd & 0x0F) << 4);
      } else if (cmd >= 0xB0 && cmd <= 0xB7) {
        // Page start address
        this.page = cmd & 0x07;
      } else if (cmd === 0xA4) {
        this.entireOn = false;
      } else if (cmd === 0xA5) {
        this.entireOn = true;
      } else if (cmd === 0xA6) {
        this.inverse = false;
      } else if (cmd === 0xA7) {
        this.inverse = true;
      } else if (cmd === 0xAE) {
        this.displayOn = false;
      } else if (cmd === 0xAF) {
        this.displayOn = true;
      }
    },

    i2cWrite(bytes) {
      if (!this.powered) return false;
      let i = 0;
      while (i < bytes.length) {
        const ctrl = bytes[i++];
        const isData = (ctrl & 0x40) !== 0;
        const cont = (ctrl & 0x80) !== 0;

        if (!cont) {
          // Remainder of transmission has same mode
          while (i < bytes.length) {
            const b = bytes[i++];
            if (isData) this.writeDataByte(b);
            else this.handleCommandStream(b);
          }
          break;
        } else {
          // Single byte follows
          if (i < bytes.length) {
            const b = bytes[i++];
            if (isData) this.writeDataByte(b);
            else this.handleCommandStream(b);
          }
        }
      }
      return { ack: true };
    },

    _pendingCmd: null,
    _cmdArgs: [],

    handleCommandStream(b) {
      if (this._pendingCmd !== null) {
        this._cmdArgs.push(b);
        if (this._pendingCmd === 0x20 && this._cmdArgs.length === 1) {
          // Addressing mode
          this.addressingMode = this._cmdArgs[0] & 0x03;
          this._pendingCmd = null;
          this._cmdArgs = [];
        } else if (this._pendingCmd === 0x21 && this._cmdArgs.length === 2) {
          // Column address
          this.colStart = this._cmdArgs[0];
          this.colEnd = this._cmdArgs[1];
          this.col = this.colStart;
          this._pendingCmd = null;
          this._cmdArgs = [];
        } else if (this._pendingCmd === 0x22 && this._cmdArgs.length === 2) {
          // Page address
          this.pageStart = this._cmdArgs[0];
          this.pageEnd = this._cmdArgs[1];
          this.page = this.pageStart;
          this._pendingCmd = null;
          this._cmdArgs = [];
        } else if (this._pendingCmd === 0x81 && this._cmdArgs.length === 1) {
          // Contrast
          this.contrast = this._cmdArgs[0];
          this._pendingCmd = null;
          this._cmdArgs = [];
        } else if (this._pendingCmd !== 0x21 && this._pendingCmd !== 0x22 && this._cmdArgs.length >= 1) {
          // Other 2-byte commands (1 argument)
          this._pendingCmd = null;
          this._cmdArgs = [];
        }
      } else {
        if (b === 0x20 || b === 0x21 || b === 0x22 || b === 0x81 || b === 0xD3 || b === 0xD5 || b === 0xA8 || b === 0x8D) {
          this._pendingCmd = b;
          this._cmdArgs = [];
        } else {
          this.executeCommand(b);
        }
      }
    },

    writeDataByte(b) {
      const idx = this.page * this.width + this.col;
      if (idx >= 0 && idx < this.buffer.length) {
        this.buffer[idx] = b;
      }
      if (this.addressingMode === 0) {
        // Horizontal
        this.col++;
        if (this.col > this.colEnd) {
          this.col = this.colStart;
          this.page++;
          if (this.page > this.pageEnd) this.page = this.pageStart;
        }
      } else if (this.addressingMode === 1) {
        // Vertical
        this.page++;
        if (this.page > this.pageEnd) {
          this.page = this.pageStart;
          this.col++;
          if (this.col > this.colEnd) this.col = this.colStart;
        }
      } else {
        // Page mode
        this.col++;
        if (this.col > this.colEnd) this.col = this.colStart;
      }
    },

    i2cRead() {
      return [0x00];
    },

    stamp(S, V, engine) {
      if (sda >= 0 && scl >= 0) {
        const bus = I2CBus.getBus(engine, sda, scl);
        bus.register(this.addr, this);
      }
    },

    update(V) {
      const v_vcc = vcc >= 0 && ok(V[vcc]) ? V[vcc] : 0;
      const v_gnd = gnd >= 0 && ok(V[gnd]) ? V[gnd] : 0;
      const powered = (v_vcc - v_gnd) >= 2.5;
      const changed = powered !== this.powered;
      this.powered = powered;
      return changed;
    },

    commit() {
      if (!this.powered && (vcc >= 0 || gnd >= 0)) {
        this.warning = 'OLED has no power: VCC needs +3.3V or +5V and GND needs 0V.';
      } else if (this.warning && this.warning.startsWith('OLED has no power')) {
        this.warning = null;
      }
    },
  };

  return d;
}

// ============================================================================
// 2. LCD1602 / LCD2004 with PCF8574 Backpack
// ============================================================================
export function pcf8574LcdDevice(part, nets, options = {}) {
  const [gnd, vcc, sda, scl] = nets;
  const cols = options.cols || 16;
  const rows = options.rows || 2;
  const lines = Array(rows).fill('');
  const ddram = new Uint8Array(128).fill(32); // Space
  const cgram = new Uint8Array(64).fill(0);

  const d = {
    type: options.type || 'pcf8574-lcd',
    part,
    powered: false,
    addr: part.props.i2cAddress ? (typeof part.props.i2cAddress === 'string' ? parseInt(part.props.i2cAddress, 16) : part.props.i2cAddress) : 0x27,
    cols,
    rows,
    lines,
    ddram,
    cgram,
    backlight: true,
    displayOn: true,
    cursorOn: false,
    blinkOn: false,
    highNibble: null,
    prevE: 0,
    ddramAddr: 0,
    cgramAddr: 0,
    isCgram: false,
    warning: null,

    reset() {
      this.lines.fill('');
      this.ddram.fill(32);
      this.cgram.fill(0);
      this.backlight = true;
      this.highNibble = null;
      this.prevE = 0;
      this.ddramAddr = 0;
      this.isCgram = false;
    },

    adopt(old) {
      if (old.lines) {
        for (let r = 0; r < rows; r++) this.lines[r] = old.lines[r] || '';
        this.ddram.set(old.ddram);
        this.cgram.set(old.cgram);
        this.backlight = old.backlight;
        this.displayOn = old.displayOn;
      }
    },

    i2cWrite(bytes) {
      if (!this.powered) return false;
      for (const b of bytes) {
        // Bit 0: RS, Bit 1: RW, Bit 2: E, Bit 3: Backlight, Bit 4..7: Data
        const rs = (b & 0x01) !== 0;
        const e = (b & 0x04) !== 0;
        this.backlight = (b & 0x08) !== 0;
        const nibble = (b >> 4) & 0x0F;

        // Falling edge of Enable latches nibble
        if (this.prevE === 1 && !e) {
          if (this.highNibble === null) {
            // Check for 4-bit initialization sequence (0x03, 0x02)
            if (nibble === 0x03 || nibble === 0x02) {
              // Reset / function set
            }
            this.highNibble = nibble;
          } else {
            const byte = (this.highNibble << 4) | nibble;
            this.highNibble = null;
            this.processByte(byte, rs);
          }
        }
        this.prevE = e ? 1 : 0;
      }
      return { ack: true };
    },

    processByte(byte, rs) {
      if (!rs) {
        // Command
        if (byte === 0x01) {
          // Clear Display
          this.ddram.fill(32);
          this.ddramAddr = 0;
          this.isCgram = false;
        } else if (byte === 0x02) {
          // Return Home
          this.ddramAddr = 0;
          this.isCgram = false;
        } else if (byte >= 0x08 && byte <= 0x0F) {
          // Display ON/OFF Control
          this.displayOn = (byte & 0x04) !== 0;
          this.cursorOn = (byte & 0x02) !== 0;
          this.blinkOn = (byte & 0x01) !== 0;
        } else if (byte >= 0x40 && byte <= 0x7F) {
          // Set CGRAM Address
          this.cgramAddr = byte & 0x3F;
          this.isCgram = true;
        } else if (byte >= 0x80) {
          // Set DDRAM Address
          this.ddramAddr = byte & 0x7F;
          this.isCgram = false;
        }
      } else {
        // Data
        if (this.isCgram) {
          this.cgram[this.cgramAddr & 0x3F] = byte;
          this.cgramAddr = (this.cgramAddr + 1) & 0x3F;
        } else {
          const addr = this.ddramAddr & 0x7F;
          if (addr < 128) this.ddram[addr] = byte;
          this.ddramAddr = (this.ddramAddr + 1) & 0x7F;
        }
      }
      this.syncLines();
    },

    syncLines() {
      // Row start addresses:
      // 16x2: Row 0: 0x00, Row 1: 0x40
      // 20x4: Row 0: 0x00, Row 1: 0x40, Row 2: 0x14, Row 3: 0x54
      const rowStarts = this.rows === 4 ? [0x00, 0x40, 0x14, 0x54] : [0x00, 0x40];
      for (let r = 0; r < this.rows; r++) {
        const start = rowStarts[r];
        let str = '';
        for (let c = 0; c < this.cols; c++) {
          const ch = this.ddram[start + c] || 32;
          if (ch < 8) {
            str += String.fromCharCode(0x2588); // Custom char placeholder
          } else if (ch >= 32 && ch <= 126) {
            str += String.fromCharCode(ch);
          } else {
            str += ' ';
          }
        }
        this.lines[r] = str;
      }
    },

    i2cRead() {
      return [0x00];
    },

    stamp(S, V, engine) {
      if (sda >= 0 && scl >= 0) {
        const bus = I2CBus.getBus(engine, sda, scl);
        bus.register(this.addr, this);
      }
    },

    update(V) {
      const v_vcc = vcc >= 0 && ok(V[vcc]) ? V[vcc] : 0;
      const v_gnd = gnd >= 0 && ok(V[gnd]) ? V[gnd] : 0;
      const powered = (v_vcc - v_gnd) >= 3.0;
      const changed = powered !== this.powered;
      this.powered = powered;
      return changed;
    },

    commit() {
      if (!this.powered && (vcc >= 0 || gnd >= 0)) {
        this.warning = 'LCD has no power: VCC needs +5V and GND needs 0V.';
      } else if (this.warning && this.warning.startsWith('LCD has no power')) {
        this.warning = null;
      }
    },
  };

  return d;
}

// ============================================================================
// 3. MPU6050 6-Axis Accelerometer & Gyroscope
// ============================================================================
export function mpu6050Device(part, nets) {
  const [vcc, gnd, scl, sda, xda, xcl, ad0, intPin] = nets;

  const d = {
    type: 'mpu6050',
    part,
    powered: false,
    addr: part.props.i2cAddress ? (typeof part.props.i2cAddress === 'string' ? parseInt(part.props.i2cAddress, 16) : part.props.i2cAddress) : 0x68,
    pwrMgmt1: 0x40, // Default sleep mode
    regPtr: 0x75,
    intActive: false,
    warning: null,

    reset() {
      this.pwrMgmt1 = 0x40;
      this.regPtr = 0x75;
      this.intActive = false;
    },

    i2cWrite(bytes) {
      if (!this.powered) return false;
      if (bytes.length === 0) return { ack: true };
      this.regPtr = bytes[0];
      if (bytes.length > 1) {
        let r = this.regPtr;
        for (let i = 1; i < bytes.length; i++) {
          const val = bytes[i];
          if (r === 0x6B) this.pwrMgmt1 = val;
          r++;
        }
      }
      return { ack: true };
    },

    i2cRead(qty) {
      if (!this.powered) return Array(qty).fill(0xFF);
      const out = [];
      let r = this.regPtr;

      const ax = Math.round((part.props.accelX !== undefined ? part.props.accelX : 0.0) * 16384);
      const ay = Math.round((part.props.accelY !== undefined ? part.props.accelY : 0.0) * 16384);
      const az = Math.round((part.props.accelZ !== undefined ? part.props.accelZ : 1.0) * 16384);
      const temp = Math.round(((part.props.temperature || 25.0) - 36.53) * 340 + 521);
      const gx = Math.round((part.props.gyroX !== undefined ? part.props.gyroX : 0.0) * 131);
      const gy = Math.round((part.props.gyroY !== undefined ? part.props.gyroY : 0.0) * 131);
      const gz = Math.round((part.props.gyroZ !== undefined ? part.props.gyroZ : 0.0) * 131);

      const regMap = {
        0x3B: (ax >> 8) & 0xFF, 0x3C: ax & 0xFF,
        0x3D: (ay >> 8) & 0xFF, 0x3E: ay & 0xFF,
        0x3F: (az >> 8) & 0xFF, 0x40: az & 0xFF,
        0x41: (temp >> 8) & 0xFF, 0x42: temp & 0xFF,
        0x43: (gx >> 8) & 0xFF, 0x44: gx & 0xFF,
        0x45: (gy >> 8) & 0xFF, 0x46: gy & 0xFF,
        0x47: (gz >> 8) & 0xFF, 0x48: gz & 0xFF,
        0x3A: (part.props.freefall || part.props.motion) ? 0x40 : 0x00,
        0x6B: this.pwrMgmt1,
        0x75: 0x68,
      };

      for (let k = 0; k < qty; k++) {
        out.push(regMap[r] !== undefined ? regMap[r] : 0x00);
        r++;
      }
      this.regPtr = r;
      return out;
    },

    stamp(S, V, engine) {
      if (sda >= 0 && scl >= 0) {
        const bus = I2CBus.getBus(engine, sda, scl);
        bus.register(this.addr, this);
      }
      // Interrupt pin drive
      if (intPin >= 0 && (part.props.freefall || part.props.motion)) {
        S.src(intPin, 3.3, 50);
      }
    },

    update(V) {
      const v_vcc = vcc >= 0 && ok(V[vcc]) ? V[vcc] : 0;
      const v_gnd = gnd >= 0 && ok(V[gnd]) ? V[gnd] : 0;
      const powered = (v_vcc - v_gnd) >= 2.3;
      const changed = powered !== this.powered;
      this.powered = powered;
      return changed;
    },
  };

  return d;
}

// ============================================================================
// 4. DS1307 Real-Time Clock with NVRAM
// ============================================================================
export function ds1307Device(part, nets) {
  const [vcc, gnd, sda, scl, sqw] = nets;
  const nvram = new Uint8Array(56).fill(0);

  const dec2bcd = (val) => Math.trunc(val / 10) * 16 + (val % 10);
  const bcd2dec = (val) => (val >> 4) * 10 + (val & 0x0F);

  const d = {
    type: 'ds1307',
    part,
    powered: false,
    addr: 0x68,
    nvram,
    regPtr: 0x00,
    ch: 0, // Clock halt (0 = running)
    sqwe: 0,
    timeOffset: 0,
    warning: null,

    reset() {
      this.regPtr = 0x00;
      this.ch = 0;
    },

    adopt(old) {
      if (old.nvram) this.nvram.set(old.nvram);
      this.timeOffset = old.timeOffset || 0;
    },

    i2cWrite(bytes) {
      if (bytes.length === 0) return { ack: true };
      this.regPtr = bytes[0];
      let r = this.regPtr;
      for (let i = 1; i < bytes.length; i++) {
        const val = bytes[i];
        if (r === 0x00) this.ch = (val & 0x80) !== 0 ? 1 : 0;
        else if (r === 0x07) this.sqwe = (val & 0x10) !== 0 ? 1 : 0;
        else if (r >= 0x08 && r <= 0x3F) this.nvram[r - 0x08] = val;
        r++;
      }
      return { ack: true };
    },

    i2cRead(qty) {
      const out = [];
      let now;
      if (part.props.mode === 'wall') {
        now = new Date();
      } else {
        const base = new Date(Date.UTC(2026, 9, 25, 12, 0, 0)).getTime();
        now = new Date(base + (d.engine ? d.engine.time * 1000 : 0) + this.timeOffset);
      }

      const sec = dec2bcd(now.getUTCSeconds()) | (this.ch ? 0x80 : 0);
      const min = dec2bcd(now.getUTCMinutes());
      const hr = dec2bcd(now.getUTCHours());
      const day = dec2bcd(now.getUTCDay() + 1);
      const date = dec2bcd(now.getUTCDate());
      const month = dec2bcd(now.getUTCMonth() + 1);
      const year = dec2bcd(now.getUTCFullYear() % 100);

      const regs = [sec, min, hr, day, date, month, year, this.sqwe ? 0x10 : 0x00];

      let r = this.regPtr;
      for (let k = 0; k < qty; k++) {
        if (r < 8) out.push(regs[r]);
        else if (r >= 0x08 && r <= 0x3F) out.push(this.nvram[r - 0x08]);
        else out.push(0);
        r++;
      }
      this.regPtr = r;
      return out;
    },

    stamp(S, V, engine) {
      this.engine = engine;
      if (sda >= 0 && scl >= 0) {
        const bus = I2CBus.getBus(engine, sda, scl);
        bus.register(this.addr, this);
      }
      if (sqw >= 0 && this.sqwe) {
        const high = (Math.floor(engine.time * 2) % 2) === 0;
        S.src(sqw, high ? 5 : 0, 100);
      }
    },

    update(V) {
      const v_vcc = vcc >= 0 && ok(V[vcc]) ? V[vcc] : 0;
      const v_gnd = gnd >= 0 && ok(V[gnd]) ? V[gnd] : 0;
      const powered = (v_vcc - v_gnd) >= 2.0; // Works on battery backup
      const changed = powered !== this.powered;
      this.powered = powered;
      return changed;
    },
  };

  return d;
}

// ============================================================================
// 5. BMP180 Barometric Pressure & Temperature Sensor
// ============================================================================
export function bmp180Device(part, nets) {
  const [vcc, gnd, scl, sda] = nets;

  // Standard Bosch factory calibration coefficients
  const calib = {
    AC1: 408,
    AC2: -72,
    AC3: -14383,
    AC4: 32741,
    AC5: 32757,
    AC6: 23153,
    B1: 6190,
    B2: 4,
    MB: -32768,
    MC: -8711,
    MD: 2868,
  };

  const d = {
    type: 'bmp180',
    part,
    powered: false,
    addr: 0x77,
    regPtr: 0xD0,
    ctrlMeas: 0x00,
    measStart: 0,
    measMode: null, // 'temp' or 'press'
    oss: 0,
    warning: null,

    reset() {
      this.regPtr = 0xD0;
      this.ctrlMeas = 0x00;
      this.measMode = null;
    },

    computeUncompensated() {
      const T_degC = part.props.temperature !== undefined ? part.props.temperature : 25.0;
      const P_Pa = part.props.pressure !== undefined ? part.props.pressure : 101325;

      const B5 = Math.round(T_degC * 160);
      const a = 1;
      const b = calib.MD - B5;
      const c = calib.MC * 2048 - B5 * calib.MD;
      const X1 = (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
      const UT = Math.round(calib.AC6 + (X1 * 32768) / calib.AC5);

      // Inverse of Bosch pressure compensation formula
      const B6 = B5 - 4000;
      let X1_p = (calib.B2 * ((B6 * B6) >> 12)) >> 11;
      let X2_p = (calib.AC2 * B6) >> 11;
      let X3_p = X1_p + X2_p;
      const B3 = (((calib.AC1 * 4 + X3_p) << this.oss) + 2) >> 2;
      X1_p = (calib.AC3 * B6) >> 13;
      X2_p = (calib.B1 * ((B6 * B6) >> 12)) >> 16;
      X3_p = ((X1_p + X2_p) + 2) >> 2;
      const B4 = (calib.AC4 * (X3_p + 32768)) >> 15;
      const B7 = (P_Pa * B4) / 2;
      const UP = Math.round(B7 / (50000 >> this.oss) + B3);

      return { UT: UT & 0xFFFF, UP: Math.max(0, UP) };
    },

    i2cWrite(bytes) {
      if (!this.powered) return false;
      if (bytes.length === 0) return { ack: true };
      this.regPtr = bytes[0];
      if (bytes.length > 1) {
        if (this.regPtr === 0xF4) {
          this.ctrlMeas = bytes[1];
          if (bytes[1] === 0x2E) {
            this.measMode = 'temp';
            this.oss = 0;
          } else if ((bytes[1] & 0x20) !== 0) {
            this.measMode = 'press';
            this.oss = (bytes[1] >> 6) & 0x03;
          }
        }
      }
      return { ack: true };
    },

    i2cRead(qty) {
      if (!this.powered) return Array(qty).fill(0xFF);
      const out = [];
      const calibKeys = ['AC1', 'AC2', 'AC3', 'AC4', 'AC5', 'AC6', 'B1', 'B2', 'MB', 'MC', 'MD'];
      const { UT, UP } = this.computeUncompensated();

      let r = this.regPtr;
      for (let i = 0; i < qty; i++) {
        if (r === 0xD0) {
          out.push(0x55); // Chip ID
        } else if (r >= 0xAA && r <= 0xBF) {
          const idx = Math.floor((r - 0xAA) / 2);
          const isLow = (r & 1) === 1;
          const k = calibKeys[idx];
          const val = calib[k];
          out.push(isLow ? (val & 0xFF) : ((val >> 8) & 0xFF));
        } else if (r === 0xF6) {
          // MSB
          out.push(this.measMode === 'temp' ? ((UT >> 8) & 0xFF) : ((UP >> 8) & 0xFF));
        } else if (r === 0xF7) {
          // LSB
          out.push(this.measMode === 'temp' ? (UT & 0xFF) : (UP & 0xFF));
        } else if (r === 0xF8) {
          // XLSB
          out.push(0x00);
        } else {
          out.push(0x00);
        }
        r++;
      }
      this.regPtr = r;
      return out;
    },

    stamp(S, V, engine) {
      if (sda >= 0 && scl >= 0) {
        const bus = I2CBus.getBus(engine, sda, scl);
        bus.register(this.addr, this);
      }
    },

    update(V) {
      const v_vcc = vcc >= 0 && ok(V[vcc]) ? V[vcc] : 0;
      const v_gnd = gnd >= 0 && ok(V[gnd]) ? V[gnd] : 0;
      const powered = (v_vcc - v_gnd) >= 1.8;
      const changed = powered !== this.powered;
      this.powered = powered;
      return changed;
    },
  };

  return d;
}

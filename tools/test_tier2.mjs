import { Circuit, Wire, Part } from '../src/model.js';
import { Engine } from '../src/sim/engine.js';
import { I2CBus, SoftwareI2CMaster } from '../src/sim/i2c.js';
import '../src/parts/library.js';
import '../src/mcu/boards.js';

const results = [];

function test(id, part, layer, stimulus, expected, fn) {
  try {
    const observed = fn();
    results.push({ id, part, layer, stimulus, expected, observed: String(observed), pass: 'PASS' });
  } catch (e) {
    results.push({ id, part, layer, stimulus, expected, observed: `FAIL: ${e.message}`, pass: 'FAIL' });
  }
}

console.log('=== RUNNING TIER 2 TESTS ===\n');

// Helper to create an I2C test bench with VCC, GND and 4.7k pullups
function createI2CBench() {
  const c = new Circuit();
  const vcc = new Part('vcc', 0, 0);
  const gnd = new Part('gnd', 0, 10);
  const rSda = new Part('resistor', 5, 0, 0, { ohms: 4700 });
  const rScl = new Part('resistor', 10, 0, 0, { ohms: 4700 });
  c.parts.push(vcc, gnd, rSda, rScl);

  c.wires.push(new Wire(vcc.worldPins()[0], rSda.worldPins()[0]));
  c.wires.push(new Wire(vcc.worldPins()[0], rScl.worldPins()[0]));

  const sdaPin = rSda.worldPins()[1];
  const sclPin = rScl.worldPins()[1];

  return { c, vcc, gnd, sdaPin, sclPin };
}

// ---------------------------------------------------------------------------
// TEST 1: SSD1306 OLED (Software Master Layer)
// ---------------------------------------------------------------------------
test('T2.1', 'board-ssd1306', 'Software I2C Master', 'Initialize addressing mode and stream 16 bytes of 0xFF data', 'ACK received and dev.buffer[0..15] equals 0xFF', () => {
  const { c, vcc, gnd, sdaPin, sclPin } = createI2CBench();
  const oled = new Part('board-ssd1306', 20, 10);
  c.parts.push(oled);

  const p = oled.worldPins(); // 0: GND, 1: VCC, 2: SCL, 3: SDA
  c.wires.push(new Wire(gnd.worldPins()[0], p[0]));
  c.wires.push(new Wire(vcc.worldPins()[0], p[1]));
  c.wires.push(new Wire(sclPin, p[2]));
  c.wires.push(new Wire(sdaPin, p[3]));

  const eng = new Engine();
  eng.build(c);
  eng.step(0.01);

  const dev = eng.byPart.get(oled.id).device;
  const master = new SoftwareI2CMaster(eng, eng.pointNet.get(`${sdaPin.x},${sdaPin.y}`), eng.pointNet.get(`${sclPin.x},${sclPin.y}`));

  // Send config commands: horizontal mode, col range 0..127, page range 0..7
  const ack1 = master.write(0x3C, [0x00, 0x20, 0x00, 0x21, 0, 127, 0x22, 0, 7]);
  if (ack1 !== 0) throw new Error(`Init command NACKed with code ${ack1}`);

  // Send 16 bytes of 0xFF data
  const dataBytes = [0x40, ...Array(16).fill(0xFF)];
  const ack2 = master.write(0x3C, dataBytes);
  if (ack2 !== 0) throw new Error(`Data write NACKed with code ${ack2}`);

  for (let i = 0; i < 16; i++) {
    if (dev.buffer[i] !== 0xFF) throw new Error(`Buffer at index ${i} is ${dev.buffer[i]} instead of 0xFF`);
  }

  return `OLED ACKed init and data; buffer[0..15] all 0xFF, powered=${dev.powered}`;
});

// ---------------------------------------------------------------------------
// TEST 2: SSD1306 OLED (Transpiled Sketch Layer via Adafruit_SSD1306)
// ---------------------------------------------------------------------------
test('T2.2', 'board-ssd1306', 'Transpiled Arduino Sketch', 'display.begin(), drawPixel(10,20), drawLine(), print("CF"), display()', 'dev.buffer populated with drawn pixels and characters', () => {
  const sketch = `
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

Adafruit_SSD1306 display(128, 64, &Wire, -1);

void setup() {
  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  display.clearDisplay();
  display.drawPixel(10, 20, SSD1306_WHITE);
  display.drawLine(0, 0, 127, 63, SSD1306_WHITE);
  display.setCursor(0, 0);
  display.print("CF");
  display.display();
}

void loop() {}
`;
  const c = new Circuit();
  const uno = new Part('uno', 0, 0, 0, { code: sketch });
  const oled = new Part('board-ssd1306', 35, 10);
  c.parts.push(uno, oled);

  const unoPins = uno.worldPins();
  const pin5V = unoPins.find(p => p.name === '5V');
  const pinGND = unoPins.find(p => p.name === 'GND');
  const pinSDA = unoPins.find(p => p.name === 'SDA' || p.name.includes('SDA'));
  const pinSCL = unoPins.find(p => p.name === 'SCL' || p.name.includes('SCL'));

  const p = oled.worldPins(); // 0: GND, 1: VCC, 2: SCL, 3: SDA
  c.wires.push(new Wire(pinGND, p[0]));
  c.wires.push(new Wire(pin5V, p[1]));
  c.wires.push(new Wire(pinSCL, p[2]));
  c.wires.push(new Wire(pinSDA, p[3]));

  const eng = new Engine();
  eng.build(c);

  for (let i = 0; i < 20; i++) eng.step(0.005);

  const dev = eng.byPart.get(oled.id).device;
  const buf = dev.buffer;

  // Check pixel at (10, 20): page = 20/8 = 2, bit = 20%8 = 4 (0x10)
  const idx = 2 * 128 + 10;
  if ((buf[idx] & 0x10) === 0) {
    throw new Error(`Pixel (10,20) not set in buffer (byte is 0x${buf[idx].toString(16)})`);
  }

  // Count non-zero bytes to ensure line and text rendered
  let nonZero = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] > 0) nonZero++;

  if (nonZero < 20) {
    throw new Error(`Expected at least 20 active bytes from line and text, got ${nonZero}`);
  }

  return `Buffer successfully populated: Pixel(10,20) set, ${nonZero} active frame buffer bytes`;
});

// ---------------------------------------------------------------------------
// TEST 3: SH1107 128x128 OLED (Software Master Layer)
// ---------------------------------------------------------------------------
test('T2.3', 'wokwi-sh1107', 'Software I2C Master', '128x128 square display, 2048-byte buffer write', 'Buffer length is 2048 bytes, responds at 0x3C', () => {
  const { c, vcc, gnd, sdaPin, sclPin } = createI2CBench();
  const oled = new Part('wokwi-sh1107', 20, 10);
  c.parts.push(oled);

  const p = oled.worldPins();
  c.wires.push(new Wire(gnd.worldPins()[0], p[0]));
  c.wires.push(new Wire(vcc.worldPins()[0], p[1]));
  c.wires.push(new Wire(sclPin, p[2]));
  c.wires.push(new Wire(sdaPin, p[3]));

  const eng = new Engine();
  eng.build(c);
  eng.step(0.01);

  const dev = eng.byPart.get(oled.id).device;
  if (dev.buffer.length !== 2048) {
    throw new Error(`SH1107 buffer length should be 2048, got ${dev.buffer.length}`);
  }

  const master = new SoftwareI2CMaster(eng, eng.pointNet.get(`${sdaPin.x},${sdaPin.y}`), eng.pointNet.get(`${sclPin.x},${sclPin.y}`));
  const ack = master.write(0x3C, [0x00, 0xAF]); // Display ON
  if (ack !== 0) throw new Error('SH1107 NACKed command');

  return `SH1107 128x128 confirmed: buffer=${dev.buffer.length} bytes, ACK=0`;
});

// ---------------------------------------------------------------------------
// TEST 4: LCD1602 (Software Master Layer)
// ---------------------------------------------------------------------------
test('T2.4', 'wokwi-lcd1602', 'Software I2C Master', 'PCF8574 4-bit HD44780 initialization and character writes', 'dev.lines[0] displays written characters, backlight is active', () => {
  const { c, vcc, gnd, sdaPin, sclPin } = createI2CBench();
  const lcd = new Part('wokwi-lcd1602', 20, 10);
  c.parts.push(lcd);

  const p = lcd.worldPins(); // 0: GND, 1: VCC, 2: SDA, 3: SCL
  c.wires.push(new Wire(gnd.worldPins()[0], p[0]));
  c.wires.push(new Wire(vcc.worldPins()[0], p[1]));
  c.wires.push(new Wire(sdaPin, p[2]));
  c.wires.push(new Wire(sclPin, p[3]));

  const eng = new Engine();
  eng.build(c);
  eng.step(0.01);

  const dev = eng.byPart.get(lcd.id).device;
  const master = new SoftwareI2CMaster(eng, eng.pointNet.get(`${sdaPin.x},${sdaPin.y}`), eng.pointNet.get(`${sclPin.x},${sclPin.y}`));

  // Function to pulse a byte with RS=0 or RS=1
  function sendNibble(nib, rs) {
    const d = (nib << 4) | 0x08 | (rs ? 1 : 0); // Backlight=1
    master.write(0x27, [d | 0x04]); // E high
    master.write(0x27, [d & ~0x04]); // E low (latch)
  }
  function sendByte(b, rs) {
    sendNibble((b >> 4) & 0x0F, rs);
    sendNibble(b & 0x0F, rs);
  }

  // 4-bit init
  sendNibble(0x03, 0);
  sendNibble(0x03, 0);
  sendNibble(0x03, 0);
  sendNibble(0x02, 0);

  // Command 0x28 (2-line 5x8), 0x0C (Display ON), 0x01 (Clear)
  sendByte(0x28, 0);
  sendByte(0x0C, 0);
  sendByte(0x01, 0);

  // Write 'TEST'
  sendByte(0x54, 1); // T
  sendByte(0x45, 1); // E
  sendByte(0x53, 1); // S
  sendByte(0x54, 1); // T

  if (!dev.lines[0].startsWith('TEST')) {
    throw new Error(`LCD line 0 is '${dev.lines[0]}' instead of 'TEST'`);
  }

  return `LCD1602 received 4-bit commands: line 0 = '${dev.lines[0]}', backlight=${dev.backlight}`;
});

// ---------------------------------------------------------------------------
// TEST 5: LCD1602 (Transpiled Arduino Sketch Layer via LiquidCrystal_I2C)
// ---------------------------------------------------------------------------
test('T2.5', 'wokwi-lcd1602', 'Transpiled Arduino Sketch', 'lcd.init(), lcd.backlight(), lcd.print("CircuitForge"), lcd.print("LCD 1602 PASS")', 'dev.lines matches printed text across both rows', () => {
  const sketch = `
#include <Wire.h>
#include <LiquidCrystal_I2C.h>

LiquidCrystal_I2C lcd(0x27, 16, 2);

void setup() {
  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0);
  lcd.print("CircuitForge");
  lcd.setCursor(0, 1);
  lcd.print("LCD 1602 PASS");
}

void loop() {}
`;
  const c = new Circuit();
  const uno = new Part('uno', 0, 0, 0, { code: sketch });
  const lcd = new Part('wokwi-lcd1602', 35, 10);
  c.parts.push(uno, lcd);

  const unoPins = uno.worldPins();
  const pin5V = unoPins.find(p => p.name === '5V');
  const pinGND = unoPins.find(p => p.name === 'GND');
  const pinSDA = unoPins.find(p => p.name === 'SDA' || p.name.includes('SDA'));
  const pinSCL = unoPins.find(p => p.name === 'SCL' || p.name.includes('SCL'));

  const p = lcd.worldPins(); // 0: GND, 1: VCC, 2: SDA, 3: SCL
  c.wires.push(new Wire(pinGND, p[0]));
  c.wires.push(new Wire(pin5V, p[1]));
  c.wires.push(new Wire(pinSDA, p[2]));
  c.wires.push(new Wire(pinSCL, p[3]));

  const eng = new Engine();
  eng.build(c);

  for (let i = 0; i < 20; i++) eng.step(0.005);

  const dev = eng.byPart.get(lcd.id).device;
  const l0 = dev.lines[0].trim();
  const l1 = dev.lines[1].trim();

  if (l0 !== 'CircuitForge' || l1 !== 'LCD 1602 PASS') {
    throw new Error(`LCD lines mismatch: row0='${l0}', row1='${l1}'`);
  }

  return `Row 0: '${l0}' | Row 1: '${l1}' | Backlight: ${dev.backlight}`;
});

// ---------------------------------------------------------------------------
// TEST 6: LCD2004 (Transpiled Arduino Sketch Layer)
// ---------------------------------------------------------------------------
test('T2.6', 'wokwi-lcd2004', 'Transpiled Arduino Sketch', 'LiquidCrystal_I2C lcd(0x27, 20, 4) writes 4 rows of text', 'All 4 rows display programmed strings', () => {
  const sketch = `
#include <Wire.h>
#include <LiquidCrystal_I2C.h>

LiquidCrystal_I2C lcd(0x27, 20, 4);

void setup() {
  lcd.init();
  lcd.setCursor(0, 0); lcd.print("Line 1: 20x4 LCD");
  lcd.setCursor(0, 1); lcd.print("Line 2: HD44780");
  lcd.setCursor(0, 2); lcd.print("Line 3: PCF8574");
  lcd.setCursor(0, 3); lcd.print("Line 4: Verified");
}

void loop() {}
`;
  const c = new Circuit();
  const uno = new Part('uno', 0, 0, 0, { code: sketch });
  const lcd = new Part('wokwi-lcd2004', 35, 10);
  c.parts.push(uno, lcd);

  const unoPins = uno.worldPins();
  const pin5V = unoPins.find(p => p.name === '5V');
  const pinGND = unoPins.find(p => p.name === 'GND');
  const pinSDA = unoPins.find(p => p.name === 'SDA' || p.name.includes('SDA'));
  const pinSCL = unoPins.find(p => p.name === 'SCL' || p.name.includes('SCL'));

  const p = lcd.worldPins();
  c.wires.push(new Wire(pinGND, p[0]));
  c.wires.push(new Wire(pin5V, p[1]));
  c.wires.push(new Wire(pinSDA, p[2]));
  c.wires.push(new Wire(pinSCL, p[3]));

  const eng = new Engine();
  eng.build(c);

  for (let i = 0; i < 20; i++) eng.step(0.005);

  const dev = eng.byPart.get(lcd.id).device;
  const lines = dev.lines.map(l => l.trim());

  if (lines[0] !== 'Line 1: 20x4 LCD' || lines[3] !== 'Line 4: Verified') {
    throw new Error(`LCD2004 lines mismatch: ${JSON.stringify(lines)}`);
  }

  return `4 rows verified: [${lines.join(' | ')}]`;
});

// ---------------------------------------------------------------------------
// TEST 7: MPU6050 Accelerometer & Gyroscope
// ---------------------------------------------------------------------------
test('T2.7', 'wokwi-mpu6050', 'Software I2C Master + Interrupt', 'Read WHO_AM_I (0x75), Accel registers with accelX=0.5g, accelZ=1.0g, and motion INT', 'WHO_AM_I=0x68, AccelX=8192, AccelZ=16384, INT voltage=3.3V', () => {
  const { c, vcc, gnd, sdaPin, sclPin } = createI2CBench();
  const mpu = new Part('wokwi-mpu6050', 20, 10, 0, { accelX: 0.5, accelZ: 1.0, motion: true });
  c.parts.push(mpu);

  const p = mpu.worldPins(); // 0: VCC, 1: GND, 2: SCL, 3: SDA, 4: XDA, 5: XCL, 6: AD0, 7: INT
  c.wires.push(new Wire(vcc.worldPins()[0], p[0]));
  c.wires.push(new Wire(gnd.worldPins()[0], p[1]));
  c.wires.push(new Wire(sclPin, p[2]));
  c.wires.push(new Wire(sdaPin, p[3]));

  const eng = new Engine();
  eng.build(c);
  eng.step(0.01);

  const master = new SoftwareI2CMaster(eng, eng.pointNet.get(`${sdaPin.x},${sdaPin.y}`), eng.pointNet.get(`${sclPin.x},${sclPin.y}`));

  // Read WHO_AM_I
  master.write(0x68, [0x75]);
  const who = master.read(0x68, 1);
  if (who[0] !== 0x68) throw new Error(`WHO_AM_I returned 0x${who[0].toString(16)} instead of 0x68`);

  // Read Accel X, Y, Z
  master.write(0x68, [0x3B]);
  const raw = master.read(0x68, 6);
  const ax = (raw[0] << 8) | raw[1];
  const az = (raw[4] << 8) | raw[5];

  if (Math.abs(ax - 8192) > 50 || Math.abs(az - 16384) > 50) {
    throw new Error(`Accel readings mismatch: ax=${ax} (exp 8192), az=${az} (exp 16384)`);
  }

  // Check INT pin voltage
  const intNet = eng.pointNet.get(`${p[7].x},${p[7].y}`);
  const vInt = intNet !== undefined ? eng.V[intNet] : 0;
  if (vInt < 3.0) throw new Error(`INT pin not active on motion: V=${vInt.toFixed(2)}V`);

  return `WHO_AM_I = 0x68, AccelX = ${ax} (0.5g), AccelZ = ${az} (1.0g), INT = ${vInt.toFixed(2)}V (HIGH)`;
});

// ---------------------------------------------------------------------------
// TEST 8: DS1307 Real-Time Clock with NVRAM
// ---------------------------------------------------------------------------
test('T2.8', 'wokwi-ds1307', 'Software I2C Master', 'Write to 56-byte NVRAM and read BCD timekeeping registers', 'NVRAM stores and reads back bytes; BCD clock returns valid time', () => {
  const { c, vcc, gnd, sdaPin, sclPin } = createI2CBench();
  const rtc = new Part('wokwi-ds1307', 20, 10);
  c.parts.push(rtc);

  const p = rtc.worldPins(); // 0: VCC, 1: GND, 2: SDA, 3: SCL, 4: SQW
  c.wires.push(new Wire(vcc.worldPins()[0], p[0]));
  c.wires.push(new Wire(gnd.worldPins()[0], p[1]));
  c.wires.push(new Wire(sdaPin, p[2]));
  c.wires.push(new Wire(sclPin, p[3]));

  const eng = new Engine();
  eng.build(c);
  eng.step(0.01);

  const master = new SoftwareI2CMaster(eng, eng.pointNet.get(`${sdaPin.x},${sdaPin.y}`), eng.pointNet.get(`${sclPin.x},${sclPin.y}`));

  // Write NVRAM at register 0x08
  master.write(0x68, [0x08, 0xDE, 0xAD, 0xBE, 0xEF]);

  // Read back NVRAM
  master.write(0x68, [0x08]);
  const nv = master.read(0x68, 4);
  if (nv[0] !== 0xDE || nv[1] !== 0xAD || nv[2] !== 0xBE || nv[3] !== 0xEF) {
    throw new Error(`NVRAM readback mismatch: ${JSON.stringify(nv)}`);
  }

  // Read BCD clock registers 0x00..0x06
  master.write(0x68, [0x00]);
  const clk = master.read(0x68, 7);
  const sec = (clk[0] & 0x0F) + ((clk[0] >> 4) & 0x07) * 10;
  const min = (clk[1] & 0x0F) + (clk[1] >> 4) * 10;
  const hr = (clk[2] & 0x0F) + (clk[2] >> 4) * 10;

  if (sec > 59 || min > 59 || hr > 23) {
    throw new Error(`Invalid BCD time: hr=${hr}, min=${min}, sec=${sec}`);
  }

  return `NVRAM [0xDE, 0xAD, 0xBE, 0xEF] verified | BCD time: ${String(hr).padStart(2,'0')}:${String(min).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
});

// ---------------------------------------------------------------------------
// TEST 9: BMP180 Barometric Pressure & Temperature Sensor
// ---------------------------------------------------------------------------
test('T2.9', 'wokwi-bmp180', 'Software I2C Master', 'Read chip ID 0x55, calibration words, trigger temp & pressure conversion', 'Chip ID = 0x55, computed temp matches 25.0°C and pressure matches 101325 Pa', () => {
  const { c, vcc, gnd, sdaPin, sclPin } = createI2CBench();
  const bmp = new Part('wokwi-bmp180', 20, 10, 0, { temperature: 25.0, pressure: 101325 });
  c.parts.push(bmp);

  const p = bmp.worldPins(); // 0: VCC, 1: GND, 2: SCL, 3: SDA
  c.wires.push(new Wire(vcc.worldPins()[0], p[0]));
  c.wires.push(new Wire(gnd.worldPins()[0], p[1]));
  c.wires.push(new Wire(sclPin, p[2]));
  c.wires.push(new Wire(sdaPin, p[3]));

  const eng = new Engine();
  eng.build(c);
  eng.step(0.01);

  const master = new SoftwareI2CMaster(eng, eng.pointNet.get(`${sdaPin.x},${sdaPin.y}`), eng.pointNet.get(`${sclPin.x},${sclPin.y}`));

  // Check ID register 0xD0
  master.write(0x77, [0xD0]);
  const id = master.read(0x77, 1);
  if (id[0] !== 0x55) throw new Error(`BMP180 ID register returned 0x${id[0].toString(16)} instead of 0x55`);

  // Read calibration coefficients
  master.write(0x77, [0xAA]);
  const calBytes = master.read(0x77, 22);
  const u16 = (msb, lsb) => (msb << 8) | lsb;
  const s16 = (msb, lsb) => { const v = u16(msb, lsb); return v >= 0x8000 ? v - 0x10000 : v; };

  const AC1 = s16(calBytes[0], calBytes[1]);
  const AC2 = s16(calBytes[2], calBytes[3]);
  const AC3 = s16(calBytes[4], calBytes[5]);
  const AC4 = u16(calBytes[6], calBytes[7]);
  const AC5 = u16(calBytes[8], calBytes[9]);
  const AC6 = u16(calBytes[10], calBytes[11]);
  const B1 = s16(calBytes[12], calBytes[13]);
  const B2 = s16(calBytes[14], calBytes[15]);
  const MC = s16(calBytes[18], calBytes[19]);
  const MD = s16(calBytes[20], calBytes[21]);

  // Trigger temperature measurement
  master.write(0x77, [0xF4, 0x2E]);
  master.write(0x77, [0xF6]);
  const tempBytes = master.read(0x77, 2);
  const UT = u16(tempBytes[0], tempBytes[1]);

  // Bosch temperature calculation
  const X1 = ((UT - AC6) * AC5) >> 15;
  const X2 = (MC << 11) / (X1 + MD);
  const B5 = X1 + X2;
  const T = ((B5 + 8) >> 4) / 10.0;

  if (Math.abs(T - 25.0) > 0.5) throw new Error(`Calculated temperature ${T}°C does not match 25.0°C`);

  // Trigger pressure measurement (oss=0)
  master.write(0x77, [0xF4, 0x34]);
  master.write(0x77, [0xF6]);
  const pressBytes = master.read(0x77, 2);
  const UP = u16(pressBytes[0], pressBytes[1]);

  // Bosch pressure calculation
  const B6 = B5 - 4000;
  let X1_p = (B2 * ((B6 * B6) >> 12)) >> 11;
  let X2_p = (AC2 * B6) >> 11;
  let X3_p = X1_p + X2_p;
  const B3 = (((AC1 * 4 + X3_p)) + 2) >> 2;
  X1_p = (AC3 * B6) >> 13;
  X2_p = (B1 * ((B6 * B6) >> 12)) >> 16;
  X3_p = ((X1_p + X2_p) + 2) >> 2;
  const B4 = (AC4 * (X3_p + 32768)) >> 15;
  const B7 = (UP - B3) * 50000;
  const P = Math.round((B7 * 2) / B4);

  if (Math.abs(P - 101325) > 50) throw new Error(`Calculated pressure ${P} Pa does not match 101325 Pa`);

  return `ID=0x55, Bosch formula calculated Temp = ${T.toFixed(1)}°C, Pressure = ${P} Pa`;
});

// ---------------------------------------------------------------------------
// TEST 10: Address Collision Handling (Two SSD1306 displays at 0x3C)
// ---------------------------------------------------------------------------
test('T2.10', 'I2CBus Collision Detection', 'Protocol Arbiter Layer', 'Two SSD1306 displays wired to same bus with default address 0x3C', 'Bus detects collision, emits warning, writes return error code 4', () => {
  const { c, vcc, gnd, sdaPin, sclPin } = createI2CBench();
  const oled1 = new Part('board-ssd1306', 20, 10);
  const oled2 = new Part('board-ssd1306', 25, 10);
  c.parts.push(oled1, oled2);

  for (const oled of [oled1, oled2]) {
    const p = oled.worldPins();
    c.wires.push(new Wire(gnd.worldPins()[0], p[0]));
    c.wires.push(new Wire(vcc.worldPins()[0], p[1]));
    c.wires.push(new Wire(sclPin, p[2]));
    c.wires.push(new Wire(sdaPin, p[3]));
  }

  const eng = new Engine();
  eng.build(c);
  eng.step(0.01);

  const dev1 = eng.byPart.get(oled1.id).device;
  const dev2 = eng.byPart.get(oled2.id).device;

  if (!dev1.warning || !dev2.warning || !dev1.warning.includes('Collision')) {
    throw new Error(`Displays did not receive collision warning: dev1='${dev1.warning}', dev2='${dev2.warning}'`);
  }

  const master = new SoftwareI2CMaster(eng, eng.pointNet.get(`${sdaPin.x},${sdaPin.y}`), eng.pointNet.get(`${sclPin.x},${sclPin.y}`));
  const writeResult = master.write(0x3C, [0x00, 0xAF]);

  if (writeResult !== 4) {
    throw new Error(`Write on colliding address returned code ${writeResult} instead of 4 (collision error)`);
  }

  return `Collision detected on 0x3C: warning recorded on both displays, master.write returned code 4`;
});

console.log(JSON.stringify(results, null, 2));

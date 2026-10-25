/**
 * Microcontroller boards. Pin rows sit on the 0.1" grid so the
 * breadboard-friendly modules straddle the centre gap like the real thing.
 */
import { register } from '../parts/registry.js';
import { mcuDevice } from './runtime.js';

const U = 20, TAU = Math.PI * 2;
const MONO = '"SF Mono", ui-monospace, "JetBrains Mono", Menlo, monospace';
const SANS = '-apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, sans-serif';

/** "D13:13" → io pin, "GND"/"5V"/"3V3" → power, anything else → no-connect */
function parsePin(spec, x, y) {
  const [label, g] = spec.split(':');
  if (g !== undefined) return { x, y, name: label, kind: 'io', gpio: +g };
  const kind = label === 'GND' || label === 'G' ? 'GND' : label === '5V' || label === 'VBUS' ? '5V' : label === '3V3' || label === '3.3' ? '3V3' : 'nc';
  return { x, y, name: label, kind };
}

function ledDot(g, x, y, color, on, r = 3) {
  if (on) {
    const gr = g.createRadialGradient(x, y, 0, x, y, r * 5);
    gr.addColorStop(0, color.replace('rgb', 'rgba').replace(')', ',0.7)'));
    gr.addColorStop(1, color.replace('rgb', 'rgba').replace(')', ',0)'));
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, r * 5, 0, TAU); g.fill();
  }
  g.fillStyle = on ? color : 'rgba(255,255,255,0.18)';
  g.beginPath(); g.roundRect(x - r, y - r * 0.7, r * 2, r * 1.4, 1); g.fill();
}

function label(g, env, s, x, y, upward, color) {
  g.save();
  g.translate(x, y);
  const flip = env.rot === 2 || env.rot === 3;
  g.rotate(flip ? Math.PI / 2 : -Math.PI / 2);
  g.font = `700 7px ${MONO}`;
  g.fillStyle = color; g.textBaseline = 'middle';
  g.textAlign = upward !== flip ? 'left' : 'right';
  g.fillText(s, 0, 0);
  g.restore();
}
function text(g, env, s, x, y, size, color, weight = 700, font = SANS) {
  g.save(); g.translate(x, y);
  if (env.rot === 2) g.rotate(Math.PI);
  else if (env.rot === 1) g.rotate(-Math.PI / 2);
  else if (env.rot === 3) g.rotate(Math.PI / 2);
  g.font = `${weight} ${size}px ${font}`; g.fillStyle = color; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(s, 0, 0); g.restore();
}
const pinColor = (p) => (p.kind === '5V' || p.kind === '3V3' ? '#ff9b94' : p.kind === 'GND' ? '#d1d5db' : p.kind === 'nc' ? '#9aa3af' : '#ffffff');

function ledState(env, board) {
  const rt = env.dev && env.dev.rt;
  if (!rt) return { power: !!env.dev, led: 0, rgb: null };
  let led = 0;
  const g = board.ledPin;
  if (rt.modes.get(g) === 'out') led = rt.pwm.has(g) ? rt.pwm.get(g) : rt.outs.get(g) || 0;
  if (board.ledActiveLow) led = rt.modes.get(g) === 'out' ? 1 - led : 0;
  return { power: true, led, rgb: rt.rgb };
}

// ------------------------------------------------------------- modules ---
function moduleBoard(b) {
  const top = b.top.map((s, i) => parsePin(s, i, -b.S));
  const bottom = b.bottom.map((s, i) => parsePin(s, i, 0));
  const pins = [...bottom, ...top];
  const n = Math.max(b.top.length, b.bottom.length);
  const board = { ...b, pins, n };
  register({
    type: b.type, name: b.name, short: b.short, title: b.title, cat: 'Microcontrollers', desc: b.desc,
    mcu: board, board,
    defaults: { code: b.code },
    pins: () => pins.map(p => ({ x: p.x, y: p.y, name: p.name })),
    bounds: () => [-1.9, -b.S - 0.6, n - 0.4 + (b.antenna ? 1.2 : 0), 0.6],
    supply: () => pins.map((p, i) => (p.kind === '5V' ? { i, kind: 'V:5' } : p.kind === '3V3' ? { i, kind: 'V:3.3' } : p.kind === 'GND' ? { i, kind: 'G' } : null)).filter(Boolean),
    draw(g, part, env) {
      const S = b.S;
      const x0 = -0.75 * U, x1 = (n - 0.25) * U + (b.antenna ? 1.2 * U : 0), y0 = (-S - 0.55) * U, y1 = 0.55 * U;
      g.shadowColor = 'rgba(0,0,0,0.3)'; g.shadowBlur = 10; g.shadowOffsetY = 4;
      g.beginPath(); g.roundRect(x0, y0, x1 - x0, y1 - y0, 5); g.fillStyle = b.pcb; g.fill();
      g.shadowColor = 'transparent';
      g.strokeStyle = 'rgba(255,255,255,0.08)'; g.lineWidth = 1; g.stroke();
      // USB connector
      const cy = (-S / 2) * U;
      g.fillStyle = '#c9ced6';
      g.beginPath(); g.roundRect(-1.9 * U, cy - (b.usbW || 0.75) * U, 1.6 * U, (b.usbW || 0.75) * 2 * U, 2); g.fill();
      g.fillStyle = '#8b929c'; g.fillRect(-1.8 * U, cy - 3, 1.2 * U, 6);
      if (b.usb2) { g.fillStyle = '#c9ced6'; g.beginPath(); g.roundRect(-1.9 * U, cy + 1.3 * U, 1.6 * U, 1.2 * U, 2); g.fill(); g.beginPath(); g.roundRect(-1.9 * U, cy - 2.5 * U, 1.6 * U, 1.2 * U, 2); g.fill(); }
      b.art(g, env, part, n, S);
      // header pins + labels
      for (const p of pins) {
        g.fillStyle = '#1b1b1d'; g.fillRect(p.x * U - 7, p.y * U - 7, 14, 14);
        g.fillStyle = '#d4af37'; g.fillRect(p.x * U - 3.2, p.y * U - 3.2, 6.4, 6.4);
        label(g, env, p.name, p.x * U, (p.y === 0 ? -0.62 : -S + 0.62) * U, p.y === 0, pinColor(p));
      }
      const st = ledState(env, board);
      if (b.ledAt) ledDot(g, b.ledAt[0] * U, b.ledAt[1] * U, b.ledColor || 'rgb(255,190,40)', st.led > 0.05);
      if (b.pwrAt) ledDot(g, b.pwrAt[0] * U, b.pwrAt[1] * U, 'rgb(255,60,50)', st.power);
      if (b.rgbAt) {
        const c = st.rgb && (st.rgb[0] + st.rgb[1] + st.rgb[2] > 0) ? `rgb(${st.rgb.map(v => Math.round(80 + 175 * Math.min(1, v / 255))).join(',')})` : null;
        const [rx, ry] = [b.rgbAt[0] * U, b.rgbAt[1] * U];
        if (c) { const gr = g.createRadialGradient(rx, ry, 0, rx, ry, 30); gr.addColorStop(0, c.replace('rgb', 'rgba').replace(')', ',0.75)')); gr.addColorStop(1, c.replace('rgb', 'rgba').replace(')', ',0)')); g.fillStyle = gr; g.beginPath(); g.arc(rx, ry, 30, 0, TAU); g.fill(); }
        g.fillStyle = '#f2f2f2'; g.fillRect(rx - 5, ry - 5, 10, 10);
        g.fillStyle = c || '#d9d9d9'; g.beginPath(); g.arc(rx, ry, 3.6, 0, TAU); g.fill();
      }
      if (env.dev && env.dev.rt && env.dev.rt.error) {
        g.fillStyle = '#ff3b30'; g.beginPath(); g.arc(x1 - 10, y0 + 10, 6, 0, TAU); g.fill();
      }
    },
    device: (part, nets) => mcuDevice(board, part, nets),
  });
  return board;
}

function chip(g, env, cx, cy, w, h, name, sub, rotDeg = 0) {
  g.save(); g.translate(cx, cy); g.rotate(rotDeg * Math.PI / 180);
  g.fillStyle = '#111214'; g.beginPath(); g.roundRect(-w / 2, -h / 2, w, h, 2); g.fill();
  g.strokeStyle = '#9aa1ab'; g.lineWidth = 1;
  for (let i = -w / 2 + 3; i < w / 2 - 2; i += 3) { g.beginPath(); g.moveTo(i, -h / 2); g.lineTo(i, -h / 2 - 2.5); g.moveTo(i, h / 2); g.lineTo(i, h / 2 + 2.5); g.stroke(); }
  g.restore();
  text(g, env, name, cx, cy - (sub ? 3 : 0), 6, '#e5e7eb', 700, MONO);
  if (sub) text(g, env, sub, cx, cy + 5, 5, '#9aa0aa', 600, MONO);
}
function wroom(g, env, x, y, w, h, title) {
  g.fillStyle = '#1f2937'; g.beginPath(); g.roundRect(x, y, w, h, 3); g.fill();
  // metal can
  g.fillStyle = 'linear';
  const gr = g.createLinearGradient(x, y, x + w, y + h); gr.addColorStop(0, '#d6dae0'); gr.addColorStop(1, '#9ea5af');
  g.fillStyle = gr; g.beginPath(); g.roundRect(x + 3, y + 3, w * 0.72, h - 6, 2); g.fill();
  text(g, env, title, x + 3 + w * 0.36, y + h / 2 - 5, 8, '#30343b', 800);
  text(g, env, 'WROOM', x + 3 + w * 0.36, y + h / 2 + 6, 6, '#4b5058', 700);
  // antenna trace
  g.strokeStyle = '#d4af37'; g.lineWidth = 1.5;
  const ax = x + w * 0.78, aw = w * 0.18;
  g.beginPath();
  for (let i = 0; i < 6; i++) { const yy = y + 6 + i * (h - 12) / 5; g.lineTo(ax + (i % 2 ? aw : 0), yy); g.lineTo(ax + (i % 2 ? 0 : aw), yy); }
  g.stroke();
}

const BLINK = (who) => `// Blink — the "Hello, world!" of microcontrollers.
// Press ⌘S (or Upload) after editing.

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(115200);
  Serial.println("Hello from the ${who}!");
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(500);
  digitalWrite(LED_BUILTIN, LOW);
  delay(500);
}
`;

const UNO_CONSTS = {
  A0: 14, A1: 15, A2: 16, A3: 17, A4: 18, A5: 19, A6: 20, A7: 21,
  SDA: 18, SCL: 19,
  MOSI: 11, MISO: 12, SCK: 13, SS: 10,
};

// ---- Arduino Nano ----------------------------------------------------------
moduleBoard({
  type: 'nano', name: 'Arduino Nano', short: 'Nano', title: 'ATmega328P · 5 V',
  desc: 'Classic breadboard Arduino. Straddle the centre gap: pins on rows d and h.',
  specs: [['MCU', 'ATmega328P, 16 MHz'], ['Memory', '32 KB flash · 2 KB SRAM'], ['Logic', '5 V'], ['I/O', '14 digital (6 PWM) · 8 analog (10-bit)'], ['Built-in LED', 'D13']],
  S: 6, pcb: '#1d5fae', vcc: 5, adcBits: 10, adcRef: 5, ledPin: 13, consts: UNO_CONSTS, heap: 2048, chip: 'ATmega328P', mhz: 16,
  bottom: ['D12/MISO:12', 'D11/MOSI:11', 'D10/SS:10', 'D9:9', 'D8:8', 'D7:7', 'D6:6', 'D5:5', 'D4:4', 'D3:3', 'D2:2', 'GND', 'RST', 'RX0:0', 'TX1:1'],
  top: ['D13/SCK:13', '3V3', 'REF', 'A0:14', 'A1:15', 'A2:16', 'A3:17', 'A4/SDA:18', 'A5/SCL:19', 'A6:20', 'A7:21', '5V', 'RST', 'GND', 'VIN'],
  ledAt: [1.2, -4.2], pwrAt: [1.2, -1.8],
  art(g, env, part, n, S) {
    chip(g, env, 7 * U, -3 * U, 2.4 * U, 2.4 * U, 'ATMEGA', '328P', 45);
    g.fillStyle = '#f5f5f7'; g.beginPath(); g.roundRect(10.4 * U, -3.5 * U, U, U, 2); g.fill();
    text(g, env, 'NANO', 12.6 * U, -3 * U, 9, 'rgba(255,255,255,0.8)', 800);
  },
  code: BLINK('Arduino Nano'),
  ex: { led: 13, btn: 2, pwm: 9, adc: 'A0', p1: 2, p2: 3, p3: 4, data: 11, clock: 12, latch: 8 },
});

// ---- ESP32 DevKit V1 (cheapest) ---------------------------------------------
moduleBoard({
  type: 'esp32', name: 'ESP32 DevKit V1', short: 'ESP32', title: 'ESP32-WROOM-32 · 3.3 V',
  desc: 'The cheapest Wi-Fi + Bluetooth board (30-pin DOIT DevKit V1). Spans 10 rows: put the pins on rows a and i (or b and j).',
  specs: [['MCU', 'ESP32-D0WD, dual-core 240 MHz'], ['Memory', '4 MB flash · 520 KB SRAM'], ['Radio', 'Wi-Fi 4 + Bluetooth 4.2/BLE'], ['Logic', '3.3 V (not 5 V tolerant)'], ['ADC', '12-bit, GPIO 32–39 best'], ['Built-in LED', 'GPIO 2']],
  S: 10, pcb: '#1c1c1e', vcc: 3.3, adcBits: 12, adcRef: 3.3, ledPin: 2, antenna: true, ledColor: 'rgb(60,140,255)',
  consts: {
    A0: 36, A3: 39, A4: 32, A5: 33, A6: 34, A7: 35,
    A10: 4, A11: 0, A12: 2, A13: 15, A14: 13, A15: 12, A16: 14, A17: 27, A18: 25, A19: 26,
    T0: 4, SDA: 21, SCL: 22, MOSI: 23, MISO: 19, SCK: 18, SS: 5, TX: 1, RX: 3
  },
  heap: 290000, flash: 4194304, chip: 'ESP32-D0WD-V3', mhz: 240, cores: 2,
  reserved: { 6: 'GPIO 6–11 are wired to the flash chip — don’t use them.' },
  top: ['VIN', 'GND', 'D13:13', 'D12:12', 'D14:14', 'D27:27', 'D26:26', 'D25:25', 'D33:33', 'D32:32', 'D35[IN]:35', 'D34[IN]:34', 'VN[IN]:39', 'VP[IN]:36', 'EN'],
  bottom: ['3V3', 'GND', 'D15:15', 'D2:2', 'D4:4', 'RX2:16', 'TX2:17', 'D5/SS:5', 'D18/SCK:18', 'D19/MISO:19', 'D21/SDA:21', 'RX0:3', 'TX0:1', 'D22/SCL:22', 'D23/MOSI:23'],
  ledAt: [1.5, -6.6], pwrAt: [1.5, -3.6],
  art(g, env, part, n, S) {
    wroom(g, env, 6.6 * U, (-S + 1.9) * U, 9.2 * U, (S - 3.8) * U, 'ESP32');
    for (const [lbl, yy] of [['EN', -7.6], ['BOOT', -2.4]]) {
      g.fillStyle = '#2a2b2f'; g.fillRect(0.7 * U, yy * U - 6, 12, 12); g.fillStyle = '#9aa0aa'; g.beginPath(); g.arc(0.7 * U + 6, yy * U, 3.5, 0, TAU); g.fill();
      text(g, env, lbl, 3 * U, yy * U, 6, '#9aa0aa', 700, MONO);
    }
    chip(g, env, 4 * U, -5 * U, 1.6 * U, 1.6 * U, 'CP2102', '');
  },
  code: BLINK('ESP32'),
  ex: { led: 2, btn: 4, pwm: 18, adc: 34, p1: 25, p2: 26, p3: 27, data: 23, clock: 18, latch: 5 },
});

// ---- ESP32-S3-DevKitC-1 N16R8 (best for Edge AI) ----------------------------
moduleBoard({
  type: 'esp32s3', name: 'ESP32-S3 DevKitC-1', short: 'ESP32-S3', title: 'N16R8 · 16 MB flash · 8 MB PSRAM',
  desc: 'Best all-rounder for Edge AI: vector instructions for TensorFlow Lite Micro / ESP-NN, 8 MB PSRAM for models. RGB LED on GPIO 48.',
  specs: [['MCU', 'ESP32-S3, dual-core Xtensa LX7 240 MHz + AI vector ext.'], ['Memory', '16 MB flash · 8 MB octal PSRAM · 512 KB SRAM'], ['Radio', 'Wi-Fi 4 + Bluetooth 5 (LE)'], ['USB', 'Native USB-OTG + USB-UART'], ['Logic', '3.3 V'], ['Built-in LED', 'RGB (WS2812) on GPIO 48'], ['Edge AI', 'TFLite Micro, ESP-DL, Edge Impulse']],
  S: 10, pcb: '#141416', vcc: 3.3, adcBits: 12, adcRef: 3.3, ledPin: 48, rgbPin: 48, antenna: true, usb2: true,
  consts: { A0: 1, A1: 2, A2: 3, A3: 4, A4: 5, A5: 6, A6: 7, A7: 8, A8: 9, A9: 10, SDA: 8, SCL: 9, MOSI: 11, MISO: 13, SCK: 12, SS: 10, TX: 43, RX: 44 },
  heap: 327680, psram: 8388608, flash: 16777216, chip: 'ESP32-S3', mhz: 240, cores: 2,
  reserved: { 35: 'GPIO 35–37 are used by the octal PSRAM on N16R8 boards — pick other pins.', 36: 'GPIO 35–37 are used by the octal PSRAM on N16R8 boards — pick other pins.', 37: 'GPIO 35–37 are used by the octal PSRAM on N16R8 boards — pick other pins.' },
  top: ['GND', '5V', '14:14', '13:13', '12:12', '11:11', '10:10', '9/SCL:9', '46:46', '3:3', '8/SDA:8', '18:18', '17:17', '16:16', '15:15', '7:7', '6:6', '5:5', '4:4', 'RST', '3V3', '3V3'],
  bottom: ['GND', 'GND', '19:19', '20:20', '21:21', '47:47', '48:48', '45:45', '0:0', '35:35', '36:36', '37:37', '38:38', '39:39', '40:40', '41:41', '42:42', '2:2', '1:1', 'RX:44', 'TX:43', 'GND'],
  rgbAt: [3.4, -5], pwrAt: [1.4, -3.4],
  art(g, env, part, n, S) {
    wroom(g, env, 11.5 * U, (-S + 1.9) * U, 10.5 * U, (S - 3.8) * U, 'ESP32-S3');
    text(g, env, 'N16R8', 9.4 * U, -2.6 * U, 7, '#9aa0aa', 700, MONO);
    for (const [lbl, yy] of [['BOOT', -7.6], ['RST', -2.4]]) {
      g.fillStyle = '#2a2b2f'; g.fillRect(6 * U, yy * U - 6, 12, 12); g.fillStyle = '#c7c7cc'; g.beginPath(); g.arc(6 * U + 6, yy * U, 3.5, 0, TAU); g.fill();
      text(g, env, lbl, 8.2 * U, yy * U, 6, '#9aa0aa', 700, MONO);
    }
  },
  code: `// ESP32-S3 RGB blink — the on-board LED is a WS2812 on GPIO 48.
void setup() {
  Serial.begin(115200);
  Serial.printf("ESP32-S3 · %d MB PSRAM free for your models\\n", ESP.getPsramSize() / 1048576);
}

void loop() {
  neopixelWrite(RGB_BUILTIN, 64, 0, 0);   // red
  delay(400);
  neopixelWrite(RGB_BUILTIN, 0, 64, 0);   // green
  delay(400);
  neopixelWrite(RGB_BUILTIN, 0, 0, 64);   // blue
  delay(400);
}
`,
  ex: { led: 4, btn: 5, pwm: 6, adc: 1, p1: 4, p2: 5, p3: 6, data: 11, clock: 12, latch: 10 },
});

// ---- STM32 Blue Pill --------------------------------------------------------
const STM = {};
['A', 'B', 'C'].forEach((port, pi) => { for (let i = 0; i < 16; i++) STM[`P${port}${i}`] = pi * 16 + i; });
STM.SDA = STM.PB7;
STM.SCL = STM.PB6;
STM.MOSI = STM.PA7;
STM.MISO = STM.PA6;
STM.SCK = STM.PA5;
STM.SS = STM.PA4;

moduleBoard({
  type: 'bluepill', name: 'STM32 Blue Pill', short: 'Blue Pill', title: 'STM32F103C8T6 · 3.3 V',
  desc: 'Cheap 72 MHz ARM Cortex-M3 board. Straddle the centre gap: pins on rows d and h. LED on PC13 is active-LOW.',
  specs: [['MCU', 'STM32F103C8T6, Cortex-M3 72 MHz'], ['Memory', '64 KB flash · 20 KB SRAM'], ['Logic', '3.3 V (most pins 5 V tolerant)'], ['ADC', '12-bit on PA0–PA7, PB0, PB1'], ['Built-in LED', 'PC13 (on when LOW)']],
  S: 6, pcb: '#1b4fa8', vcc: 3.3, adcBits: 12, adcRef: 3.3, ledPin: STM.PC13, ledActiveLow: true, ledColor: 'rgb(60,220,90)',
  consts: STM, heap: 20480, chip: 'STM32F103C8T6', mhz: 72,
  top: ['PB12:28', 'PB13:29', 'PB14:30', 'PB15:31', 'PA8:8', 'PA9:9', 'PA10:10', 'PA11:11', 'PA12:12', 'PA15:15', 'PB3:19', 'PB4:20', 'PB5:21', 'PB6/SCL:22', 'PB7/SDA:23', 'PB8:24', 'PB9:25', '5V', 'GND', '3V3'],
  bottom: ['GND', 'GND', '3V3', 'RST', 'PB11:27', 'PB10:26', 'PB1:17', 'PB0:16', 'PA7/MOSI:7', 'PA6/MISO:6', 'PA5/SCK:5', 'PA4/SS:4', 'PA3:3', 'PA2:2', 'PA1:1', 'PA0:0', 'PC15:47', 'PC14:46', 'PC13:45', 'VB'],
  ledAt: [17.6, -3.8], pwrAt: [17.6, -2.2],
  art(g, env, part, n, S) {
    chip(g, env, 9 * U, -3 * U, 2.6 * U, 2.6 * U, 'STM32', 'F103C8T6', 45);
    for (const xx of [3, 4]) { g.fillStyle = '#111'; g.fillRect(xx * U - 4, -4.3 * U, 8, 0.9 * U * 2); g.fillStyle = '#f5c400'; g.fillRect(xx * U - 4, -4.3 * U, 8, 0.9 * U); }
    g.fillStyle = '#f5f5f7'; g.beginPath(); g.roundRect(13.5 * U, -3.5 * U, U, U, 2); g.fill();
    g.fillStyle = '#c0c6ce'; g.beginPath(); g.roundRect(5.4 * U, -2.6 * U, 1.1 * U, 0.6 * U, 3); g.fill();
  },
  code: `// Blue Pill blink — the PC13 LED lights when the pin is LOW.
void setup() {
  pinMode(PC13, OUTPUT);
  Serial.begin(115200);
  Serial.println("Hello from the STM32 Blue Pill!");
}

void loop() {
  digitalWrite(PC13, LOW);    // LED on
  delay(300);
  digitalWrite(PC13, HIGH);   // LED off
  delay(300);
}
`,
  ex: { led: 'PB12', btn: 'PB13', pwm: 'PA8', adc: 'PA0', p1: 'PB12', p2: 'PB13', p3: 'PB14', data: 'PB15', clock: 'PA8', latch: 'PA9' },
});

// ---- Arduino Uno R3 ---------------------------------------------------------
{
  const pins = [];
  const topRow = [['SCL:19', 9], ['SDA:18', 10], ['AREF', 11], ['GND', 12], ['D13/SCK:13', 13], ['D12/MISO:12', 14], ['D11/MOSI:11', 15], ['D10/SS:10', 16], ['D9:9', 17], ['D8:8', 18],
    ['D7:7', 20], ['D6:6', 21], ['D5:5', 22], ['D4:4', 23], ['D3:3', 24], ['D2:2', 25], ['TX1:1', 26], ['RX0:0', 27]];
  const botRow = [['IOREF', 11], ['RESET', 12], ['3V3', 13], ['5V', 14], ['GND', 15], ['GND', 16], ['VIN', 17], ['A0:14', 19], ['A1:15', 20], ['A2:16', 21], ['A3:17', 22], ['A4/SDA:18', 23], ['A5/SCL:19', 24]];
  for (const [s, x] of topRow) pins.push(parsePin(s, x, 1));
  for (const [s, x] of botRow) pins.push(parsePin(s, x, 20));
  const board = { type: 'uno', name: 'Arduino Uno R3', short: 'Uno', vcc: 5, adcBits: 10, adcRef: 5, ledPin: 13, consts: UNO_CONSTS, pins, heap: 2048, chip: 'ATmega328P', mhz: 16,
    specs: [['MCU', 'ATmega328P, 16 MHz'], ['Memory', '32 KB flash · 2 KB SRAM'], ['Logic', '5 V'], ['I/O', '14 digital (6 PWM) · 6 analog (10-bit)'], ['Built-in LED', 'D13']],
    ex: { led: 13, btn: 2, pwm: 9, adc: 'A0', p1: 2, p2: 3, p3: 4, data: 11, clock: 12, latch: 8 } };
  register({
    type: 'uno', name: 'Arduino Uno R3', short: 'Uno', title: 'ATmega328P · 5 V', cat: 'Microcontrollers',
    desc: 'The classic. Wire from its header sockets to the breadboard; 5V and GND pins can power your circuit.',
    mcu: board, board,
    defaults: { code: BLINK('Arduino Uno') },
    pins: () => pins.map(p => ({ x: p.x, y: p.y, name: p.name })),
    bounds: () => [-1.6, 0, 28.6, 21],
    supply: () => pins.map((p, i) => (p.kind === '5V' ? { i, kind: 'V:5' } : p.kind === '3V3' ? { i, kind: 'V:3.3' } : p.kind === 'GND' ? { i, kind: 'G' } : null)).filter(Boolean),
    draw(g, part, env) {
      g.shadowColor = 'rgba(0,0,0,0.3)'; g.shadowBlur = 12; g.shadowOffsetY = 5;
      g.beginPath(); g.roundRect(0, 0, 28.5 * U, 21 * U, 10); g.fillStyle = '#00838f'; g.fill();
      g.shadowColor = 'transparent';
      // USB-B + barrel jack
      g.fillStyle = '#c9ced6'; g.beginPath(); g.roundRect(-1.6 * U, 2.6 * U, 5.6 * U, 4.6 * U, 3); g.fill();
      g.fillStyle = '#9ea5af'; g.fillRect(-1.6 * U, 3.6 * U, 1.2 * U, 2.6 * U);
      g.fillStyle = '#1b1c1f'; g.beginPath(); g.roundRect(-0.8 * U, 14 * U, 5 * U, 4.6 * U, 3); g.fill();
      // headers
      g.fillStyle = '#18191b';
      g.beginPath(); g.roundRect(8.5 * U, 0.45 * U, 10 * U, 1.1 * U, 2); g.fill();
      g.beginPath(); g.roundRect(19.5 * U, 0.45 * U, 8 * U, 1.1 * U, 2); g.fill();
      g.beginPath(); g.roundRect(9.5 * U, 19.45 * U, 8 * U, 1.1 * U, 2); g.fill();
      g.beginPath(); g.roundRect(18.5 * U, 19.45 * U, 6 * U, 1.1 * U, 2); g.fill();
      for (const p of pins) {
        g.fillStyle = '#050505'; g.fillRect(p.x * U - 3.5, p.y * U - 3.5, 7, 7);
        text(g, env, p.name, p.x * U, (p.y === 1 ? 2.3 : 18.7) * U, 6.5, pinColor(p), 700, MONO);
      }
      chip(g, env, 19 * U, 13.5 * U, 13 * U, 2.6 * U, 'ATMEGA328P-PU', '');
      text(g, env, 'UNO', 9 * U, 9.5 * U, 26, 'rgba(255,255,255,0.9)', 800);
      text(g, env, 'DIGITAL (PWM ~)', 19 * U, 3.4 * U, 7, 'rgba(255,255,255,0.7)', 700);
      text(g, env, 'POWER', 14 * U, 17.3 * U, 7, 'rgba(255,255,255,0.7)', 700);
      text(g, env, 'ANALOG IN', 21.5 * U, 17.3 * U, 7, 'rgba(255,255,255,0.7)', 700);
      g.fillStyle = '#d1d5db'; g.beginPath(); g.roundRect(4.6 * U, 0.5 * U, 1.4 * U, 1.4 * U, 3); g.fill();
      g.fillStyle = '#e5484d'; g.beginPath(); g.arc(5.3 * U, 1.2 * U, 0.45 * U, 0, TAU); g.fill();
      const st = ledState(env, board);
      ledDot(g, 13 * U, 4.6 * U, 'rgb(255,190,40)', st.led > 0.05); text(g, env, 'L', 14 * U, 4.6 * U, 6, '#fff', 700);
      ledDot(g, 26.2 * U, 6.5 * U, 'rgb(80,230,90)', st.power); text(g, env, 'ON', 26.2 * U, 7.6 * U, 6, '#fff', 700);
      if (env.dev && env.dev.rt && env.dev.rt.error) { g.fillStyle = '#ff3b30'; g.beginPath(); g.arc(27.6 * U, 1 * U, 6, 0, TAU); g.fill(); }
    },
    device: (part, nets) => mcuDevice(board, part, nets),
  });
}

/** Example sketches, specialised to each board's pins. */
export function examples(board, blink) {
  const e = board.ex || {};
  const q = (v) => (typeof v === 'string' ? v : String(v));
  return [
    { name: board.rgbPin ? 'RGB blink' : 'Blink', code: blink },
    { name: 'Button → LED', code: `// Button on pin ${q(e.btn)} (to GND), LED + resistor on pin ${q(e.led)}.
const int BUTTON = ${q(e.btn)};
const int LED = ${q(e.led)};

void setup() {
  pinMode(BUTTON, INPUT_PULLUP);   // pressed = LOW
  pinMode(LED, OUTPUT);
}

void loop() {
  bool pressed = digitalRead(BUTTON) == LOW;
  digitalWrite(LED, pressed ? HIGH : LOW);
}
` },
    { name: 'Fade (PWM)', code: `// Fade an LED on PWM pin ${q(e.pwm)} up and down.
const int LED = ${q(e.pwm)};

void setup() {
  pinMode(LED, OUTPUT);
}

void loop() {
  for (int b = 0; b <= 255; b += 5) { analogWrite(LED, b); delay(20); }
  for (int b = 255; b >= 0; b -= 5) { analogWrite(LED, b); delay(20); }
}
` },
    { name: 'Read a potentiometer', code: `// Potentiometer wiper on ${q(e.adc)}, outer pins to ${board.vcc} V and GND.
void setup() {
  Serial.begin(115200);
}

void loop() {
  int raw = analogRead(${q(e.adc)});
  float volts = raw * ${board.adcRef} / ${(1 << board.adcBits) - 1}.0;
  Serial.print("raw = ");
  Serial.print(raw);
  Serial.print("   volts = ");
  Serial.println(volts);
  delay(250);
}
` },
    { name: 'Traffic light', code: `// Red, yellow and green LEDs (each with a resistor) on pins ${q(e.p1)}, ${q(e.p2)}, ${q(e.p3)}.
const int RED = ${q(e.p1)}, YELLOW = ${q(e.p2)}, GREEN = ${q(e.p3)};

void light(int r, int y, int g, int ms) {
  digitalWrite(RED, r);
  digitalWrite(YELLOW, y);
  digitalWrite(GREEN, g);
  delay(ms);
}

void setup() {
  pinMode(RED, OUTPUT);
  pinMode(YELLOW, OUTPUT);
  pinMode(GREEN, OUTPUT);
}

void loop() {
  light(HIGH, LOW, LOW, 2000);
  light(HIGH, HIGH, LOW, 600);
  light(LOW, LOW, HIGH, 2000);
  light(LOW, HIGH, LOW, 800);
}
` },
    { name: '74HC595 shift register', code: `// Drive 8 LEDs through a 74595: SER←${q(e.data)}, SRCLK←${q(e.clock)}, RCLK←${q(e.latch)}.
const int DATA = ${q(e.data)}, CLOCK = ${q(e.clock)}, LATCH = ${q(e.latch)};

void setup() {
  pinMode(DATA, OUTPUT);
  pinMode(CLOCK, OUTPUT);
  pinMode(LATCH, OUTPUT);
}

void loop() {
  for (int i = 0; i < 256; i++) {
    digitalWrite(LATCH, LOW);
    shiftOut(DATA, CLOCK, MSBFIRST, i);
    digitalWrite(LATCH, HIGH);
    delay(200);
  }
}
` },
    { name: 'Serial echo', code: `// Type in the Serial Monitor; the board answers.
void setup() {
  Serial.begin(115200);
  Serial.println("Type something and press Send.");
}

void loop() {
  if (Serial.available() > 0) {
    String line = Serial.readStringUntil('\\n');
    Serial.print("You said: ");
    Serial.println(line);
  }
}
` },
  ];
}

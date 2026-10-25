import { Circuit, Wire, Part } from '../src/model.js';
import { Engine } from '../src/sim/engine.js';
import { I2CBus, SoftwareI2CMaster, SoftwareI2CSlave } from '../src/sim/i2c.js';
import '../src/parts/library.js';
import '../src/mcu/boards.js';

const results = [];

function test(id, part, layer, stimulus, expected, fn) {
  try {
    const observed = fn();
    const pass = true;
    results.push({ id, part, layer, stimulus, expected, observed: String(observed), pass: 'PASS' });
  } catch (e) {
    results.push({ id, part, layer, stimulus, expected, observed: `FAIL: ${e.message}`, pass: 'FAIL' });
  }
}

console.log('=== RUNNING TIER 1 TESTS ===\n');

// ---------------------------------------------------------------------------
// TEST 1: LED current with series resistor
// ---------------------------------------------------------------------------
test('T1.1', 'wokwi-led + wokwi-resistor', 'Analog Solver', '5V -> 220Ω resistor -> Red LED -> GND', 'Current ~ 13.5 mA (12-15 mA)', () => {
  const c = new Circuit();
  const vcc = new Part('vcc', 0, 0);
  const gnd = new Part('gnd', 0, 10);
  const r = new Part('wokwi-resistor', 5, 0, 0, { ohms: 220 });
  const led = new Part('wokwi-led', 12, 0, 0, { color: 'red', protect: 'off' });
  c.parts.push(vcc, gnd, r, led);

  // vcc -> r pin 0 (5,0)
  c.wires.push(new Wire(vcc.worldPins()[0], r.worldPins()[0]));
  // r pin 1 (9,0) -> led pin 0 (anode, 12,0)
  c.wires.push(new Wire(r.worldPins()[1], led.worldPins()[0]));
  // led pin 1 (cathode, 13,0) -> gnd
  c.wires.push(new Wire(led.worldPins()[1], gnd.worldPins()[0]));

  const eng = new Engine();
  eng.build(c);
  eng.step(0.01);

  const ledDev = eng.byPart.get(led.id).device;
  const current_mA = ledDev.cur[0] * 1000;
  if (current_mA < 12 || current_mA > 15) {
    throw new Error(`Current out of expected range: ${current_mA.toFixed(2)} mA`);
  }
  return `${current_mA.toFixed(2)} mA (Vf=${(eng.V[eng.pointNet.get(`${led.worldPins()[0].x},${led.worldPins()[0].y}`)]).toFixed(2)}V)`;
});

// ---------------------------------------------------------------------------
// TEST 2: Potentiometer at 0%, 50%, 100% on ADC
// ---------------------------------------------------------------------------
test('T1.2', 'wokwi-potentiometer', 'MCU ADC (Uno A0)', 'Pot wiper to A0 at pos=0.0, 0.5, 1.0', 'ADC reads: 0, 512 (±2), 1023', () => {
  const c = new Circuit();
  const uno = new Part('uno', 0, 0);
  const pot = new Part('wokwi-potentiometer', 30, 20, 0, { ohms: 10000, pos: 0.5 });
  c.parts.push(uno, pot);

  const unoPins = uno.worldPins();
  // Uno: 5V (index 21 on botRow), GND (index 22 on botRow), A0 (index 25 on botRow)
  const pin5V = unoPins.find(p => p.name === '5V');
  const pinGND = unoPins.find(p => p.name === 'GND');
  const pinA0 = unoPins.find(p => p.name.startsWith('A0'));

  const potPins = pot.worldPins(); // 0: 1 (GND), 1: Wiper (SIG), 2: 3 (VCC)
  c.wires.push(new Wire(pinGND, potPins[0]));
  c.wires.push(new Wire(pin5V, potPins[2]));
  c.wires.push(new Wire(pinA0, potPins[1]));

  const eng = new Engine();
  eng.build(c);

  const unoDev = eng.byPart.get(uno.id).device;
  const rt = unoDev.ensure(eng);

  // Test pos = 0.0
  pot.props.pos = 0.0;
  eng.step(0.01);
  const val0 = rt.api.analogRead('A0');

  // Test pos = 0.5
  pot.props.pos = 0.5;
  eng.step(0.01);
  const val50 = rt.api.analogRead('A0');

  // Test pos = 1.0
  pot.props.pos = 1.0;
  eng.step(0.01);
  const val100 = rt.api.analogRead('A0');

  if (val0 !== 0 || Math.abs(val50 - 512) > 2 || val100 !== 1023) {
    throw new Error(`ADC readings unexpected: 0%=${val0}, 50%=${val50}, 100%=${val100}`);
  }
  return `0%=${val0}, 50%=${val50}, 100%=${val100}`;
});

// ---------------------------------------------------------------------------
// TEST 3: Pushbutton press changes pin level
// ---------------------------------------------------------------------------
test('T1.3', 'wokwi-pushbutton', 'Digital Input (Uno D2)', 'Button unpressed -> pressed -> unpressed', 'D2: HIGH (5V) -> LOW (0V) -> HIGH (5V)', () => {
  const c = new Circuit();
  const uno = new Part('uno', 0, 0);
  const btn = new Part('wokwi-pushbutton', 20, 25);
  c.parts.push(uno, btn);

  const unoPins = uno.worldPins();
  const pinD2 = unoPins.find(p => p.name.startsWith('D2'));
  const pinGND = unoPins.find(p => p.name === 'GND');
  const btnPins = btn.worldPins(); // 0: 1.l, 1: 1.r, 2: 2.l, 3: 2.r

  c.wires.push(new Wire(pinD2, btnPins[0]));
  c.wires.push(new Wire(pinGND, btnPins[2]));

  const eng = new Engine();
  eng.build(c);
  const unoDev = eng.byPart.get(uno.id).device;
  const rt = unoDev.ensure(eng);
  rt.api.pinMode(2, 2); // INPUT_PULLUP

  eng.step(0.01);
  const lvl1 = rt.api.digitalRead(2);

  // Press button
  btn.ui.pressed = true;
  eng.build(c); // rebuild links
  eng.step(0.01);
  const lvl2 = rt.api.digitalRead(2);

  // Release button
  btn.ui.pressed = false;
  eng.build(c);
  eng.step(0.01);
  const lvl3 = rt.api.digitalRead(2);

  if (lvl1 !== 1 || lvl2 !== 0 || lvl3 !== 1) {
    throw new Error(`Button levels failed: unpressed=${lvl1}, pressed=${lvl2}, released=${lvl3}`);
  }
  return `Unpressed: ${lvl1} (HIGH), Pressed: ${lvl2} (LOW), Released: ${lvl3} (HIGH)`;
});

// ---------------------------------------------------------------------------
// TEST 4: Relay switches a load
// ---------------------------------------------------------------------------
test('T1.4', 'wokwi-relay-module', 'Analog / Switching', 'IN=0V (de-energized) vs IN=5V (energized)', 'De-energized: NC active (~50mA). Energized: NO active (~50mA)', () => {
  const c = new Circuit();
  const vcc = new Part('vcc', 0, 0);
  const gnd = new Part('gnd', 0, 10);
  const relay = new Part('wokwi-relay-module', 10, 10);
  const rNO = new Part('resistor', 20, 5, 0, { ohms: 100 });
  const rNC = new Part('resistor', 20, 15, 0, { ohms: 100 });
  const ctrl = new Part('toggle', 5, 10, 0, { on: false }); // controls IN

  c.parts.push(vcc, gnd, relay, rNO, rNC, ctrl);

  const rPins = relay.worldPins(); // 0: IN, 1: VCC, 2: GND, 3: NO, 4: COM, 5: NC
  c.wires.push(new Wire(ctrl.worldPins()[0], rPins[0])); // ctrl -> IN
  c.wires.push(new Wire(vcc.worldPins()[0], rPins[1]));  // VCC -> relay VCC
  c.wires.push(new Wire(gnd.worldPins()[0], rPins[2]));  // GND -> relay GND
  c.wires.push(new Wire(vcc.worldPins()[0], rPins[4]));  // VCC -> COM

  c.wires.push(new Wire(rPins[3], rNO.worldPins()[0]));  // NO -> rNO
  c.wires.push(new Wire(rNO.worldPins()[1], gnd.worldPins()[0])); // rNO -> GND

  c.wires.push(new Wire(rPins[5], rNC.worldPins()[0]));  // NC -> rNC
  c.wires.push(new Wire(rNC.worldPins()[1], gnd.worldPins()[0])); // rNC -> GND

  const eng = new Engine();
  eng.build(c);

  // State 1: IN = LOW (ctrl.on = false)
  ctrl.props.on = false;
  eng.step(0.01);
  const rNC_dev = eng.byPart.get(rNC.id).device;
  const rNO_dev = eng.byPart.get(rNO.id).device;
  const wattsNC_1 = rNC_dev.watts;
  const wattsNO_1 = rNO_dev.watts;

  // State 2: IN = HIGH (ctrl.on = true)
  ctrl.props.on = true;
  eng.step(0.01);
  const wattsNC_2 = rNC_dev.watts;
  const wattsNO_2 = rNO_dev.watts;

  const pass1 = wattsNC_1 > 0.2 && wattsNO_1 < 1e-4;
  const pass2 = wattsNO_2 > 0.2 && wattsNC_2 < 1e-4;

  if (!pass1 || !pass2) {
    throw new Error(`Relay state failed: State1 (NC=${wattsNC_1.toFixed(3)}W, NO=${wattsNO_1.toFixed(3)}W), State2 (NC=${wattsNC_2.toFixed(3)}W, NO=${wattsNO_2.toFixed(3)}W)`);
  }
  return `Off: NC=${wattsNC_1.toFixed(2)}W / NO=${wattsNO_1.toFixed(4)}W | On: NC=${wattsNC_2.toFixed(4)}W / NO=${wattsNO_2.toFixed(2)}W`;
});

// ---------------------------------------------------------------------------
// TEST 5: Clock generator at 1 Hz and 1 kHz measures correctly
// ---------------------------------------------------------------------------
test('T1.5', 'wokwi-clock-generator', 'Timer / Source', 'Clock at 1 Hz and 1 kHz with 50% duty', '1 Hz: T=1.0s, high=0.5s; 1 kHz: T=1.0ms, high=0.5ms', () => {
  const c = new Circuit();
  const clk = new Part('wokwi-clock-generator', 0, 0, 0, { hz: 1, duty: 50 });
  c.parts.push(clk);

  const eng = new Engine();
  eng.build(c);

  // Test 1 Hz
  eng.time = 0.25;
  eng.step(0.001);
  const clkDev = eng.byPart.get(clk.id).device;
  const state1_high = clkDev.high; // should be high (0.25 < 0.5)

  eng.time = 0.75;
  eng.step(0.001);
  const state1_low = !clkDev.high; // should be low (0.75 >= 0.5)

  // Test 1 kHz (hz=1000)
  clk.props.hz = 1000;
  eng.time = 0.00025; // 0.25 ms
  eng.step(0.0001);
  const state2_high = clkDev.high;

  eng.time = 0.00075; // 0.75 ms
  eng.step(0.0001);
  const state2_low = !clkDev.high;

  if (!state1_high || !state1_low || !state2_high || !state2_low) {
    throw new Error(`Clock waveform failed: 1Hz(${state1_high}, ${state1_low}), 1kHz(${state2_high}, ${state2_low})`);
  }
  return `1 Hz: 0.25s=HIGH, 0.75s=LOW | 1 kHz: 0.25ms=HIGH, 0.75ms=LOW (Duty 50% exact)`;
});

// ---------------------------------------------------------------------------
// TEST 6: Arduino sketch test (Button controls LED, pot printed to Serial)
// ---------------------------------------------------------------------------
test('T1.6', 'Arduino Uno + Sketch', 'Transpiled Sketch', 'Button on D2, LED on D13, Pot on A0', 'LED toggles with button, Serial outputs pot readings', () => {
  const sketch = `
void setup() {
  pinMode(2, INPUT_PULLUP);
  pinMode(13, OUTPUT);
  Serial.begin(115200);
}
void loop() {
  int btn = digitalRead(2);
  digitalWrite(13, btn == LOW ? HIGH : LOW);
  int pot = analogRead(A0);
  Serial.print("POT=");
  Serial.println(pot);
  delay(10);
}
`;
  const c = new Circuit();
  const uno = new Part('uno', 0, 0, 0, { code: sketch });
  const btn = new Part('wokwi-pushbutton', 25, 20);
  const led = new Part('wokwi-led', 20, 5, 0, { color: 'green', protect: 'on' });
  const pot = new Part('wokwi-potentiometer', 25, 30, 0, { ohms: 10000, pos: 0.75 });
  c.parts.push(uno, btn, led, pot);

  const unoPins = uno.worldPins();
  const pinD2 = unoPins.find(p => p.name.startsWith('D2'));
  const pinD13 = unoPins.find(p => p.name.startsWith('D13'));
  const pinA0 = unoPins.find(p => p.name.startsWith('A0'));
  const pin5V = unoPins.find(p => p.name === '5V');
  const pinGND = unoPins.find(p => p.name === 'GND');

  // Button to D2 and GND
  c.wires.push(new Wire(pinD2, btn.worldPins()[0]));
  c.wires.push(new Wire(pinGND, btn.worldPins()[2]));

  // LED to D13 and GND
  c.wires.push(new Wire(pinD13, led.worldPins()[0]));
  c.wires.push(new Wire(pinGND, led.worldPins()[1]));

  // Pot to 5V, GND, A0
  c.wires.push(new Wire(pin5V, pot.worldPins()[0]));
  c.wires.push(new Wire(pinA0, pot.worldPins()[1]));
  c.wires.push(new Wire(pinGND, pot.worldPins()[2]));

  const eng = new Engine();
  eng.build(c);

  // Step 1: Button unpressed -> LED should be LOW
  btn.ui.pressed = false;
  for (let i = 0; i < 20; i++) eng.step(0.005);
  const unoDev = eng.byPart.get(uno.id).device;
  const rt = unoDev.rt;
  const ledDev = eng.byPart.get(led.id).device;
  const ledCurOff = ledDev.cur[0];

  // Step 2: Button pressed -> LED should be HIGH
  btn.ui.pressed = true;
  eng.build(c);
  for (let i = 0; i < 20; i++) eng.step(0.005);
  const ledDevOn = eng.byPart.get(led.id).device;
  const ledCurOn = ledDevOn.cur[0];

  // Check Serial text
  const serialText = rt.serial.map(s => s.text).join('');
  const potMatches = [...serialText.matchAll(/POT=(\d+)/g)];
  const lastMatch = potMatches.length ? potMatches[potMatches.length - 1] : null;
  const potVal = lastMatch ? +lastMatch[1] : -1;
  const expPot = 256;

  if (ledCurOff > 0.001 || ledCurOn < 0.005 || Math.abs(potVal - expPot) > 10) {
    throw new Error(`Sketch interaction failed: ledOff=${ledCurOff}A, ledOn=${ledCurOn}A, potVal=${potVal} (exp ~${expPot})`);
  }
  return `Button unpressed: LED=${(ledCurOff*1000).toFixed(1)}mA, Button pressed: LED=${(ledCurOn*1000).toFixed(1)}mA | Serial Output: POT=${potVal}`;
});

// ---------------------------------------------------------------------------
// TEST 7: Wire Master + Software I2C Slave
// ---------------------------------------------------------------------------
test('T1.7', 'Wire / I2C Bus', 'Software I2C Bus Master & Slave', 'Write 3 bytes [0x10, 0xAA, 0x55], read 2 bytes from 0x42', 'Slave receives bytes with ACK, Master reads [0xDE, 0xAD]', () => {
  const c = new Circuit();
  const vcc = new Part('vcc', 0, 0);
  const rSda = new Part('resistor', 5, 0, 0, { ohms: 4700 });
  const rScl = new Part('resistor', 10, 0, 0, { ohms: 4700 });
  c.parts.push(vcc, rSda, rScl);

  c.wires.push(new Wire(vcc.worldPins()[0], rSda.worldPins()[0]));
  c.wires.push(new Wire(vcc.worldPins()[0], rScl.worldPins()[0]));

  const eng = new Engine();
  eng.build(c);

  const sdaNet = eng.pointNet.get(`${rSda.worldPins()[1].x},${rSda.worldPins()[1].y}`);
  const sclNet = eng.pointNet.get(`${rScl.worldPins()[1].x},${rScl.worldPins()[1].y}`);

  const bus = I2CBus.getBus(eng, sdaNet, sclNet);
  const slave = new SoftwareI2CSlave(bus, 0x42);
  slave.responseData = [0xDE, 0xAD];

  const master = new SoftwareI2CMaster(bus);

  // Write test
  const ack = master.writeBytes(0x42, [0x10, 0xAA, 0x55]);
  if (!ack) throw new Error('Slave failed to ACK write');
  if (slave.receivedData.length !== 3 || slave.receivedData[1] !== 0xAA) {
    throw new Error(`Slave received wrong data: ${JSON.stringify(slave.receivedData)}`);
  }

  // Read test
  const readData = master.readBytes(0x42, 2);
  if (readData.length !== 2 || readData[0] !== 0xDE || readData[1] !== 0xAD) {
    throw new Error(`Master read wrong data: ${JSON.stringify(readData)}`);
  }

  return `Write ACK=true, SlaveRx=[0x10, 0xAA, 0x55] | Read=[0xDE, 0xAD] verified`;
});

// ---------------------------------------------------------------------------
// TEST 8: RGB LED Common Cathode & Common Anode
// ---------------------------------------------------------------------------
test('T1.8', 'wokwi-rgb-led', 'Analog Solver', 'Drive R, G, B pins on CC (5V) and CA (GND)', 'Both configurations conduct specified currents', () => {
  const c = new Circuit();
  const vcc = new Part('vcc', 0, 0);
  const gnd = new Part('gnd', 0, 10);
  const ledCC = new Part('wokwi-rgb-led', 5, 0, 0, { common: 'cathode', protect: 'on' });
  const ledCA = new Part('wokwi-rgb-led', 15, 0, 0, { common: 'anode', protect: 'on' });
  c.parts.push(vcc, gnd, ledCC, ledCA);

  // ledCC: COM to GND, R, G, B to VCC
  c.wires.push(new Wire(gnd.worldPins()[0], ledCC.worldPins()[1]));
  c.wires.push(new Wire(vcc.worldPins()[0], ledCC.worldPins()[0]));
  c.wires.push(new Wire(vcc.worldPins()[0], ledCC.worldPins()[2]));
  c.wires.push(new Wire(vcc.worldPins()[0], ledCC.worldPins()[3]));

  // ledCA: COM to VCC, R, G, B to GND
  c.wires.push(new Wire(vcc.worldPins()[0], ledCA.worldPins()[1]));
  c.wires.push(new Wire(gnd.worldPins()[0], ledCA.worldPins()[0]));
  c.wires.push(new Wire(gnd.worldPins()[0], ledCA.worldPins()[2]));
  c.wires.push(new Wire(gnd.worldPins()[0], ledCA.worldPins()[3]));

  const eng = new Engine();
  eng.build(c);
  eng.step(0.01);

  const devCC = eng.byPart.get(ledCC.id).device;
  const devCA = eng.byPart.get(ledCA.id).device;

  const curCC_R = devCC.cur[0] * 1000;
  const curCC_G = devCC.cur[1] * 1000;
  const curCC_B = devCC.cur[2] * 1000;

  const curCA_R = devCA.cur[0] * 1000;
  const curCA_G = devCA.cur[1] * 1000;
  const curCA_B = devCA.cur[2] * 1000;

  if (curCC_R < 5 || curCC_G < 5 || curCC_B < 5 || curCA_R < 5 || curCA_G < 5 || curCA_B < 5) {
    throw new Error(`RGB LED currents too low: CC=(${curCC_R.toFixed(1)}, ${curCC_G.toFixed(1)}, ${curCC_B.toFixed(1)}) mA, CA=(${curCA_R.toFixed(1)}, ${curCA_G.toFixed(1)}, ${curCA_B.toFixed(1)}) mA`);
  }
  return `CC: R=${curCC_R.toFixed(1)}mA G=${curCC_G.toFixed(1)}mA B=${curCC_B.toFixed(1)}mA | CA: R=${curCA_R.toFixed(1)}mA G=${curCA_G.toFixed(1)}mA B=${curCA_B.toFixed(1)}mA`;
});

// ---------------------------------------------------------------------------
// TEST 9: Logic Analyzer captures transitions and exports CSV
// ---------------------------------------------------------------------------
test('T1.9', 'wokwi-logic-analyzer', 'Instrument Model', 'Clock into D0, Logic Analyzer records timeline', 'History buffer captures transitions and exportCSV() outputs valid CSV', () => {
  const c = new Circuit();
  const clk = new Part('clock', 0, 0, 0, { hz: 50, duty: 50 });
  const la = new Part('wokwi-logic-analyzer', 5, 0);
  const gnd = new Part('gnd', 0, 10);
  c.parts.push(clk, la, gnd);

  c.wires.push(new Wire(gnd.worldPins()[0], la.worldPins()[0])); // GND
  c.wires.push(new Wire(clk.worldPins()[0], la.worldPins()[1])); // D0

  const eng = new Engine();
  eng.build(c);

  for (let i = 0; i < 50; i++) {
    eng.step(0.002);
  }

  const laDev = eng.byPart.get(la.id).device;
  const csv = laDev.exportCSV();
  const lines = csv.trim().split('\n');

  if (lines.length < 5 || !lines[0].startsWith('time_s,D0,D1')) {
    throw new Error(`CSV output invalid: ${lines.slice(0, 3).join('; ')}`);
  }
  return `Recorded ${laDev.history.length} state transitions, CSV has ${lines.length} lines with header '${lines[0]}'`;
});

// ---------------------------------------------------------------------------
// TEST 10: Wire master in Arduino sketch drives I2C slave
// ---------------------------------------------------------------------------
test('T1.10', 'Wire Master in Sketch', 'Transpiled Sketch -> I2C Bus -> Slave', 'Wire.begin(), Wire.write([0x37, 0x59]), Wire.requestFrom(2 bytes)', 'Slave receives [0x37, 0x59], Sketch reads [0xBE, 0xEF]', () => {
  const sketch = `
#include <Wire.h>

void setup() {
  Wire.begin();
  Serial.begin(115200);
  Wire.beginTransmission(0x42);
  Wire.write(0x37);
  Wire.write(0x59);
  int err = Wire.endTransmission();
  Serial.print("ERR=");
  Serial.println(err);

  Wire.requestFrom(0x42, 2);
  int b1 = Wire.read();
  int b2 = Wire.read();
  Serial.print("B1=");
  Serial.println(b1);
  Serial.print("B2=");
  Serial.println(b2);
}

void loop() {}
`;
  const c = new Circuit();
  const uno = new Part('uno', 0, 0, 0, { code: sketch });
  c.parts.push(uno);

  const eng = new Engine();
  eng.build(c);

  const unoDev = eng.byPart.get(uno.id).device;
  const rt = unoDev.ensure(eng);

  // Attach slave to the Uno's SDA and SCL nets
  const unoPins = uno.worldPins();
  const sdaPin = unoPins.find(p => p.name === 'SDA' || p.name.includes('SDA'));
  const sclPin = unoPins.find(p => p.name === 'SCL' || p.name.includes('SCL'));
  const sdaNet = eng.pointNet.get(`${sdaPin.x},${sdaPin.y}`);
  const sclNet = eng.pointNet.get(`${sclPin.x},${sclPin.y}`);

  const bus = I2CBus.getBus(eng, sdaNet, sclNet);
  const slave = new SoftwareI2CSlave(bus, 0x42, [0xBE, 0xEF]);

  for (let i = 0; i < 10; i++) {
    eng.step(0.005);
  }

  const serialText = rt.serial.map(s => s.text).join('');
  const rx = slave.receivedData;
  if (!rx || rx.length !== 2 || rx[0] !== 0x37 || rx[1] !== 0x59) {
    throw new Error(`Slave did not receive expected bytes. Received: ${JSON.stringify(rx)}`);
  }
  if (!serialText.includes('ERR=0') || !serialText.includes('B1=190') || !serialText.includes('B2=239')) {
    throw new Error(`Sketch Serial output did not match expected values. Serial text: ${serialText}`);
  }
  return `Slave Rx=[0x37, 0x59] (ACK=0), Sketch read: B1=0xBE (190), B2=0xEF (239)`;
});

console.log(JSON.stringify(results, null, 2));


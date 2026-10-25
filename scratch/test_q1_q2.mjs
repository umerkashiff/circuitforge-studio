import { compile } from '../src/mcu/transpile.js';
import { mcuDevice } from '../src/mcu/runtime.js';
import { Circuit, Wire, Part } from '../src/model.js';
import { Engine } from '../src/sim/engine.js';
import '../src/mcu/boards.js';
import '../src/parts/library.js';
import { getDef } from '../src/parts/registry.js';

console.log('=== INVESTIGATING Q1: DELAY CLAMP & SUB-STEP TIMESTAMPS ===');

const q1Sketch = `
int p = 13;
unsigned long t_before = 0;
unsigned long t_after = 0;

void setup() {
  pinMode(p, OUTPUT);
}

void loop() {
  t_before = micros();
  digitalWrite(p, HIGH);
  delayMicroseconds(10);
  digitalWrite(p, LOW);
  t_after = micros();
  delay(100);
}
`;

{
  const c = new Circuit();
  const vcc = new Part('vcc', 0, 0);
  const gnd = new Part('gnd', 0, 5);
  const mcu = new Part('uno', 10, 10, 0, { code: q1Sketch });
  c.parts.push(vcc, gnd, mcu);
  const eng = new Engine();
  eng.build(c);

  const def = getDef('uno');
  const d = eng.devices.find(dev => dev.board && dev.board.type === 'uno');
  
  // Find pin 13 net
  const p13Net = d.nets[def.board.pins.findIndex(p => p.gpio === 13)];
  console.log('Pin 13 net:', p13Net);

  let highStartTime = null;
  let highEndTime = null;
  let prevV = 0;

  // Let's step with dt = 0.0005 (0.5 ms)
  const dt = 0.0005;
  for (let s = 0; s < 50; s++) {
    eng.step(dt);
    const v = eng.V[p13Net];
    const t = eng.time;
    if (prevV < 2.5 && v >= 2.5) {
      highStartTime = t;
      console.log(`[Pulse Rising] at sim time t = ${(t * 1000).toFixed(3)} ms, V = ${v.toFixed(2)} V`);
    }
    if (prevV >= 2.5 && v < 2.5) {
      highEndTime = t;
      console.log(`[Pulse Falling] at sim time t = ${(t * 1000).toFixed(3)} ms, V = ${v.toFixed(2)} V`);
    }
    prevV = v;
  }

  if (highStartTime !== null && highEndTime !== null) {
    console.log(`Measured HIGH pulse width on net: ${((highEndTime - highStartTime) * 1000).toFixed(3)} ms (${((highEndTime - highStartTime) * 1e6).toFixed(0)} µs)`);
  } else {
    console.log('Pulse width: could not capture clean start and end');
  }

  // Inspect runtime internal values for t_before and t_after if accessible
  console.log('Runtime now:', d.rt.now);
}

console.log('\n=== INVESTIGATING Q2: LIBRARY OBJECT DECLARATIONS ===');

const decls = [
  ['Servo myservo', 'Servo myservo; void setup() {} void loop() {}'],
  ['Adafruit_SSD1306 display(128, 64, &Wire, -1)', 'Adafruit_SSD1306 display(128, 64, &Wire, -1); void setup() {} void loop() {}'],
  ['LiquidCrystal_I2C lcd(0x27, 16, 2)', 'LiquidCrystal_I2C lcd(0x27, 16, 2); void setup() {} void loop() {}'],
  ['Adafruit_NeoPixel strip(...)', 'Adafruit_NeoPixel strip(8, 6, NEO_GRB + NEO_KHZ800); void setup() {} void loop() {}'],
  ['DHT dht(2, DHT22)', 'DHT dht(2, DHT22); void setup() {} void loop() {}'],
  ['myservo.write(90)', 'void setup() { myservo.write(90); } void loop() {}'],
  ['display.print("hi")', 'void setup() { display.print("hi"); } void loop() {}'],
];

for (const [name, code] of decls) {
  try {
    const res = compile(code, ['A0', 'A1', 'A2', 'A3', 'A4', 'A5']);
    console.log(`[Transpile] ${name}: PASS`);
  } catch (e) {
    console.log(`[Transpile] ${name}: FAIL -> ${e.message}`);
  }
}

import { compile } from '../src/mcu/transpile.js';
import { mcuDevice } from '../src/mcu/runtime.js';
import { Circuit, Wire, Part } from '../src/model.js';
import { Engine } from '../src/sim/engine.js';
import '../src/mcu/boards.js';
import '../src/parts/library.js';
import { getDef } from '../src/parts/registry.js';

// Smoke sketches to test:
const S1 = `
int ledPin = 13;
unsigned long prevMillis = 0;
const long interval = 50;
int ledState = LOW;

void setup() {
  pinMode(ledPin, OUTPUT);
}

void loop() {
  unsigned long currentMillis = millis();
  if (currentMillis - prevMillis >= interval) {
    prevMillis = currentMillis;
    ledState = (ledState == LOW) ? HIGH : LOW;
    digitalWrite(ledPin, ledState);
  }
}
`;

const S2 = `
struct Point {
  int x;
  int y;
};

class Counter {
public:
  int count;
  void inc() { count++; }
};

int arr[3] = {1, 2, 3};

void setup() {
  Point p;
  p.x = 10;
  Counter c;
  c.count = 5;
  c.inc();
}

void loop() {
}
`;

const S3 = `
#include <Wire.h>

void setup() {
  Wire.begin();
  Wire.beginTransmission(0x3C);
  Wire.write(0x00);
  Wire.endTransmission();
}

void loop() {
}
`;

const S4 = `
const byte ledPin = 13;
const byte interruptPin = 2;
volatile byte state = LOW;

void blink() {
  state = !state;
}

void setup() {
  pinMode(ledPin, OUTPUT);
  pinMode(interruptPin, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(interruptPin), blink, CHANGE);
}

void loop() {
  digitalWrite(ledPin, state);
}
`;

const S5 = `
int sensorPin = A0;
int sensorValue = 0;

void setup() {
  Serial.begin(9600);
}

void loop() {
  sensorValue = analogRead(sensorPin);
  Serial.println(sensorValue);
  delay(10);
}
`;

function testSketch(name, code, boardType = 'uno', runSteps = 20) {
  console.log(`\nTesting ${name}:`);
  const def = getDef(boardType);
  const pinNames = Object.keys(def.board.consts || {});
  
  let compiled = null;
  let compileErr = null;
  try {
    compiled = compile(code, pinNames);
    console.log(`  [Transpile] Success`);
  } catch (e) {
    compileErr = e;
    console.log(`  [Transpile] FAIL: ${e.message} (line ${e.line || '?'})`);
  }

  if (!compiled) return { pass: false, error: compileErr ? compileErr.message : 'Compile failed' };

  // Try running in engine
  try {
    const c = new Circuit();
    const vcc = new Part('vcc', 0, 0);
    const gnd = new Part('gnd', 0, 5);
    const mcu = new Part(boardType, 10, 10, 0, { code });
    c.parts.push(vcc, gnd, mcu);
    const eng = new Engine();
    eng.build(c);
    
    // Find device
    const d = eng.devices.find(dev => dev.board && dev.board.type === boardType);
    if (!d) throw new Error('MCU device not created');
    
    // Run simulation steps
    for (let i = 0; i < runSteps; i++) {
      eng.step(0.005);
    }
    
    if (d.rt && d.rt.error) {
      console.log(`  [Runtime] FAIL: ${d.rt.error}`);
      return { pass: false, error: d.rt.error };
    }
    console.log(`  [Runtime] Success (stepped ${runSteps} times, time = ${eng.time.toFixed(3)}s)`);
    if (d.rt && d.rt.serial && d.rt.serial.length) {
      console.log(`  [Serial Output]:`, d.rt.serial.map(s => s.text).join('').trim());
    }
    return { pass: true, rt: d.rt };
  } catch (e) {
    console.log(`  [Execution] FAIL: ${e.message}`);
    return { pass: false, error: e.message };
  }
}

console.log('=== RUNNING SMOKE SKETCHES S1 - S5 ===');
const r1 = testSketch('S1 (millis blink)', S1);
const r2 = testSketch('S2 (struct, class, array)', S2);
const r3 = testSketch('S3 (Wire.h transmission)', S3);
const r4 = testSketch('S4 (attachInterrupt button)', S4);
const r5 = testSketch('S5 (analogRead potentiometer)', S5);

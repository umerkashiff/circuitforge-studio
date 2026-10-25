import { Circuit, Wire, Part } from '../src/model.js';
import '../src/parts/library.js';
import '../src/mcu/boards.js';
import { Engine } from '../src/sim/engine.js';

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

c.wires.push(new Wire(pinD2, btn.worldPins()[0]));
c.wires.push(new Wire(pinGND, btn.worldPins()[2]));
c.wires.push(new Wire(pinD13, led.worldPins()[0]));
c.wires.push(new Wire(pinGND, led.worldPins()[1]));
c.wires.push(new Wire(pin5V, pot.worldPins()[0]));
c.wires.push(new Wire(pinA0, pot.worldPins()[1]));
c.wires.push(new Wire(pinGND, pot.worldPins()[2]));

const eng = new Engine();
eng.build(c);

console.log('--- BEFORE RUN ---');
console.log('Uno pinA0 net:', eng.pointNet.get(`${pinA0.x},${pinA0.y}`));
console.log('Pot wiper net:', eng.pointNet.get(`${pot.worldPins()[1].x},${pot.worldPins()[1].y}`));
console.log('5V net:', eng.pointNet.get(`${pin5V.x},${pin5V.y}`));
console.log('GND net:', eng.pointNet.get(`${pinGND.x},${pinGND.y}`));

for (let i = 0; i < 20; i++) {
  eng.step(0.005);
}

const unoDev = eng.byPart.get(uno.id).device;
const rt = unoDev.rt;
console.log('--- AFTER 20 STEPS (UNPRESSED) ---');
console.log('rt.outs:', Array.from(rt.outs.entries()));
const ledDev = eng.byPart.get(led.id).device;
console.log('led off cur:', ledDev.cur[0]);

console.log('--- PRESSING BUTTON ---');
btn.ui.pressed = true;
eng.build(c);
for (let i = 0; i < 20; i++) eng.step(0.005);
const unoDev2 = eng.byPart.get(uno.id).device;
const rt2 = unoDev2.rt;
console.log('rt2.outs:', Array.from(rt2.outs.entries()));
const ledDev2 = eng.byPart.get(led.id).device;
console.log('led on cur:', ledDev2.cur[0]);
console.log('V at D13:', eng.V[eng.pointNet.get(`${pinD13.x},${pinD13.y}`)]);


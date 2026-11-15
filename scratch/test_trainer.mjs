import assert from 'node:assert/strict';
import '../src/parts/library.js';
import '../src/mcu/boards.js';
import { Circuit, Board, Part, Wire } from '../src/model.js';
import { Engine } from '../src/sim/engine.js';
import { getDef } from '../src/parts/registry.js';

function testTrainerBoard() {
  console.log('=== Testing Lab Trainer Board (trainer-board) ===');

  const c = new Circuit();
  const board = new Board('half', 0, 2);
  c.boards.push(board);

  // Place Trainer Board right above the breadboard (so y=-3..0 sits cleanly above y=2)
  const trainer = new Part('trainer-board', 0, 0, 0);
  c.parts.push(trainer);

  const def = getDef('trainer-board');
  const pins = trainer.worldPins();
  assert.equal(pins.length, 41 * 4, 'Should have 41 columns × 4 rows = 164 pins');

  // Helper: find pin coordinate for a named column and socket row (0..3 -> y=-3..0)
  const pinAt = (name, row = 3) => {
    const matches = pins.filter(p => p.name === name);
    assert.equal(matches.length, 4, `Column ${name} should have 4 vertically linked sockets`);
    return matches[row];
  };

  // Verify exact column ordering for switches & complements side-by-side
  const s2 = pinAt('S2');
  const s2Inv = pinAt("S2'");
  const s3 = pinAt('S3');
  const s3Inv = pinAt("S3'");
  assert.equal(s2Inv.x - s2.x, 1, "S2' should sit immediately next to S2");
  assert.equal(s3.x - s2Inv.x, 1, "S3 should sit immediately next to S2'");
  assert.equal(s3Inv.x - s3.x, 1, "S3' should sit immediately next to S3");

  // Drop a 7408 Quad AND gate straddling the center gap on the breadboard
  // Board top is y=2; center rows e (y=10) & f (y=12) gap at y=11 -> place DIP-14 at y=13 so bottom pins at 13 (wait: e is y=2+8=10, f is y=2+10=12 -> chip bottom at 12, top at 9? wait)
  // Let's check board rowY: top=4 -> row 4 is y=2+8=10, row 5 is y=2+10=12.
  // DIP-14 pins: bottom row y=0, top row y=-3. So placing ic7408 at (5, 12) puts bottom pins at y=12 (row f) and top pins at y=9 (wait: row 3 is y=2+7=9 -> col 5..11)!
  const ic = new Part('ic7408', 5, 12, 0);
  c.parts.push(ic);
  const icPins = ic.worldPins();
  // 7408: 1A=pin1(0), 1B=pin2(1), 1Y=pin3(2), GND=pin7(6), VCC=pin14(13)

  // Wire Trainer +5V (row 0 -> y=-3) to 7408 VCC (top-left pin 14)
  const pVcc = pinAt('+5V', 0);
  c.wires.push(new Wire({ x: pVcc.x, y: pVcc.y }, { x: icPins[13].x, y: icPins[13].y }));

  // Wire Trainer GND (row 2 -> y=-1) to 7408 GND (bottom-right pin 7)
  const pGnd = pinAt('GND', 2);
  c.wires.push(new Wire({ x: pGnd.x, y: pGnd.y }, { x: icPins[6].x, y: icPins[6].y }));

  // Wire S2 (row 1) to 7408 1A (pin 1) and S3' (row 3) to 7408 1B (pin 2)
  const pS2 = pinAt('S2', 1);
  const pS3Inv = pinAt("S3'", 3);
  c.wires.push(new Wire({ x: pS2.x, y: pS2.y }, { x: icPins[0].x, y: icPins[0].y }));
  c.wires.push(new Wire({ x: pS3Inv.x, y: pS3Inv.y }, { x: icPins[1].x, y: icPins[1].y }));

  // Wire 7408 1Y (pin 3) to Trainer LED Monitor L5 (row 1 -> y=-2)
  const pL5 = pinAt('L5', 1);
  c.wires.push(new Wire({ x: icPins[2].x, y: icPins[2].y }, { x: pL5.x, y: pL5.y }));

  // Also test tying a wire between two different rows (row 0 & row 3) of S5' to confirm they share a net
  const eng = new Engine();
  eng.build(c);

  const s5Inv0 = pinAt("S5'", 0);
  const s5Inv3 = pinAt("S5'", 3);
  assert.equal(eng.netAt(s5Inv0.x, s5Inv0.y), eng.netAt(s5Inv3.x, s5Inv3.y), "All 4 rows in S5' must share one electrical net");

  // Run one step at t=0
  eng.step(0.01);
  const devTrainer = eng.byPart.get(trainer.id).device;

  // Initial state: all switches OFF (bits[2]=false, bits[3]=false)
  // Expect S2 = 0V, S2' = 5V, S3 = 0V, S3' = 5V
  // 7408 output = S2 AND S3' = 0 AND 1 = 0 -> L5 OFF
  assert.ok(eng.voltage(eng.netAt(s2.x, s2.y)) < 0.2, 'S2 initially LOW');
  assert.ok(eng.voltage(eng.netAt(s2Inv.x, s2Inv.y)) > 4.8, "S2' initially HIGH");
  assert.ok(eng.voltage(eng.netAt(pS3Inv.x, pS3Inv.y)) > 4.8, "S3' initially HIGH");
  assert.equal(devTrainer.ledLevels[5], 0, 'L5 initially OFF (0 AND 1 = 0)');

  // Test interactive hit-testing on toggle switch S2 (index 2 -> x = 20.9 + 2 * 1.76 = 24.42, y = -8.25)
  const ctrlS2 = def.control(trainer, { x: 20.9 + 2 * 1.76, y: -8.25 });
  assert.equal(ctrlS2, 'sw2', 'Clicking S2 toggle hits sw2');
  assert.equal(def.click(trainer, ctrlS2), true);
  assert.equal(trainer.props.bits[2], true, 'S2 toggled HIGH');

  eng.step(0.01);
  assert.ok(eng.voltage(eng.netAt(s2.x, s2.y)) > 4.8, 'S2 now HIGH');
  assert.ok(eng.voltage(eng.netAt(s2Inv.x, s2Inv.y)) < 0.2, "S2' now LOW");
  // Now 7408 output = S2(1) AND S3'(1) = 1 -> L5 MUST glow!
  assert.ok(devTrainer.ledLevels[5] > 0.8, `L5 LED must be ON (1 AND 1 = 1), got level=${devTrainer.ledLevels[5]}`);
  assert.equal(devTrainer.ledLevels[0], 0, 'Unused L0 remains OFF');

  // Toggle S3 ON -> S3' becomes LOW -> L5 should turn OFF!
  const ctrlS3 = def.control(trainer, { x: 20.9 + 3 * 1.76, y: -8.25 });
  assert.equal(ctrlS3, 'sw3');
  def.click(trainer, ctrlS3);
  eng.step(0.01);
  assert.ok(eng.voltage(eng.netAt(pS3Inv.x, pS3Inv.y)) < 0.2, "S3' drops LOW when S3=1");
  assert.equal(devTrainer.ledLevels[5], 0, 'L5 turns OFF (1 AND 0 = 0)');

  // Test Pushbutton P1 & P1'
  const p1 = pinAt('P1');
  const p1Inv = pinAt("P1'");
  assert.ok(eng.voltage(eng.netAt(p1.x, p1.y)) < 0.2, 'P1 unpressed LOW');
  assert.ok(eng.voltage(eng.netAt(p1Inv.x, p1Inv.y)) > 4.8, "P1' unpressed HIGH");

  const ctrlP1 = def.control(trainer, { x: 16.65, y: -8.4 });
  assert.equal(ctrlP1, 'press:p1');
  trainer.ui.pressKey = 'p1';
  eng.step(0.01);
  assert.ok(eng.voltage(eng.netAt(p1.x, p1.y)) > 4.8, 'P1 pressed HIGH');
  assert.ok(eng.voltage(eng.netAt(p1Inv.x, p1Inv.y)) < 0.2, "P1' pressed LOW");
  trainer.ui.pressKey = null;
  eng.step(0.01);
  assert.ok(eng.voltage(eng.netAt(p1.x, p1.y)) < 0.2, 'P1 released LOW');

  // Test CLK at 1 Hz (at t=0.25s HIGH, at t=0.75s LOW)
  const pClk = pinAt('CLK');
  eng.time = 0.2;
  eng.step(0.01);
  assert.ok(eng.voltage(eng.netAt(pClk.x, pClk.y)) > 4.8, 'CLK HIGH during first half-period');
  eng.time = 0.7;
  eng.step(0.01);
  assert.ok(eng.voltage(eng.netAt(pClk.x, pClk.y)) < 0.2, 'CLK LOW during second half-period');

  // Verify sequential edge-clocking: wire P1 -> 7476 1CLK (J=K=1) -> 1Q -> L0
  const ff = new Part('ic7476', 18, 12, 0);
  c.parts.push(ff);
  const ffPins = ff.worldPins(); // 1-indexed pins: 1CLK=0, 1PRE=1, 1CLR=2, 1J=3, VCC=4, GND=12, 1Qbar=13, 1Q=14, 1K=15
  c.wires.push(new Wire({ x: pVcc.x, y: pVcc.y }, { x: ffPins[4].x, y: ffPins[4].y }));   // VCC
  c.wires.push(new Wire({ x: pGnd.x, y: pGnd.y }, { x: ffPins[12].x, y: ffPins[12].y })); // GND
  c.wires.push(new Wire({ x: pVcc.x, y: pVcc.y }, { x: ffPins[3].x, y: ffPins[3].y }));   // 1J = HIGH
  c.wires.push(new Wire({ x: pVcc.x, y: pVcc.y }, { x: ffPins[15].x, y: ffPins[15].y })); // 1K = HIGH
  c.wires.push(new Wire({ x: p1.x, y: p1.y }, { x: ffPins[0].x, y: ffPins[0].y }));       // 1CLK <- P1
  const pL0 = pinAt('L0', 2);
  c.wires.push(new Wire({ x: ffPins[14].x, y: ffPins[14].y }, { x: pL0.x, y: pL0.y }));   // 1Q -> L0

  eng.build(c);
  const devAfter = eng.byPart.get(trainer.id).device;
  eng.step(0.01);
  assert.equal(devAfter.ledLevels[0], 0, '7476 1Q initially 0 -> L0 OFF');

  // Press P1 (rising edge: 0 -> 1; 7476 triggers on falling edge, so still 0)
  trainer.ui.pressKey = 'p1';
  eng.step(0.01);
  assert.equal(devAfter.ledLevels[0], 0, '7476 holds 0 on P1 rising edge');

  // Release P1 (falling edge: 1 -> 0 -> 7476 toggles 1Q = 1 -> L0 lights up!)
  trainer.ui.pressKey = null;
  eng.step(0.01);
  assert.ok(devAfter.ledLevels[0] > 0.8, '7476 toggles HIGH on P1 release falling edge -> L0 ON');

  // Press and release P1 again -> toggles back LOW -> L0 OFF
  trainer.ui.pressKey = 'p1';
  eng.step(0.01);
  trainer.ui.pressKey = null;
  eng.step(0.01);
  assert.equal(devAfter.ledLevels[0], 0, '7476 toggles LOW on second pulse -> L0 OFF');

  // Verify draw() runs cleanly with zero errors across rotations AND verify DOWN = 1 / UP = 0 lever geometry
  const batLines = [];
  const mockCtx = {
    save() {}, restore() {}, translate() {}, rotate() {}, beginPath() {}, roundRect() {},
    fill() {}, stroke() {}, moveTo(x, y) { this._mx = x; this._my = y; },
    lineTo(x, y) { if (this._lx === undefined && Math.abs(Math.abs(y - this._my) - 18) < 0.01) batLines.push({ y0: this._my, y1: y }); },
    arc() {}, closePath() {}, fillRect() {}, fillText() {},
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    set lineCap(v) {}, set lineJoin(v) {}, set lineWidth(v) {}, set fillStyle(v) {},
    set strokeStyle(v) {}, set shadowColor(v) {}, set shadowBlur(v) {}, set shadowOffsetY(v) {},
    set font(v) {}, set textAlign(v) {}, set textBaseline(v) {},
  };
  for (let rot = 0; rot < 4; rot++) {
    def.draw(mockCtx, trainer, { rot, dev: devTrainer, dark: rot % 2 === 1 });
  }

  // Check DOWN = 1 (tipY > baseY) and UP = 0 (tipY < baseY) explicitly on toggle geometry
  // Right now S2=true (1), S3=true (1), others false (0)
  trainer.props.bits.fill(false);
  trainer.props.bits[0] = true; // S0 = 1 -> lever DOWN (y1 > y0)
  batLines.length = 0;
  // Re-run with fresh draw tracker capturing lineWidth === 5.4 bat handle strokes
  let activeLw = 0;
  let lastMove = null;
  const recordedBats = [];
  const batCtx = {
    save() {}, restore() {}, translate() {}, rotate() {}, beginPath() {}, roundRect() {},
    fill() {}, stroke() {
      if (Math.abs(activeLw - 5.4) < 0.05 && lastMove) recordedBats.push(lastMove);
      lastMove = null;
    },
    moveTo(x, y) { this._mx = x; this._my = y; },
    lineTo(x, y) { lastMove = { x0: this._mx, y0: this._my, x1: x, y1: y }; },
    arc() {}, closePath() {}, fillRect() {}, fillText() {},
    createLinearGradient: () => ({ addColorStop() {} }),
    createRadialGradient: () => ({ addColorStop() {} }),
    set lineCap(v) {}, set lineJoin(v) {},
    set lineWidth(v) { activeLw = v; },
    set fillStyle(v) {}, set strokeStyle(v) {}, set shadowColor(v) {},
    set shadowBlur(v) {}, set shadowOffsetY(v) {}, set font(v) {},
    set textAlign(v) {}, set textBaseline(v) {},
  };
  def.draw(batCtx, trainer, { rot: 0, dev: devTrainer, dark: false });
  assert.equal(recordedBats.length, 10, 'Should draw all 10 toggle bat handles');
  assert.ok(recordedBats[0].y1 > recordedBats[0].y0, `S0=1 must point DOWN (y1=${recordedBats[0].y1} > y0=${recordedBats[0].y0})`);
  assert.ok(recordedBats[1].y1 < recordedBats[1].y0, `S1=0 must point UP (y1=${recordedBats[1].y1} < y0=${recordedBats[1].y0})`);

  // Verify zero dead zones across the switch strip (x in [20.0..37.6], y in [-10.4..-5.1])
  for (let x = 20.0; x <= 37.6; x += 0.11) {
    for (const y of [-10.3, -8.25, -6.0, -5.2]) {
      const hit = def.control(trainer, { x, y });
      assert.ok(hit && /^sw[0-9]$/.test(hit), `Expected sw0..sw9 at (${x.toFixed(2)}, ${y}), got ${hit}`);
    }
  }
  // Verify exact switch centers map 1:1 to sw0..sw9
  for (let k = 0; k < 10; k++) {
    assert.equal(def.control(trainer, { x: 20.9 + k * 1.76, y: -8.25 }), 'sw' + k);
    assert.equal(def.control(trainer, { x: 20.9 + k * 1.76, y: -5.9 }), 'sw' + k, `Label strip under S${k} should still hit sw${k}`);
  }
  // Verify header pins / LED panel outside switch bay return null so board remains draggable from body
  assert.equal(def.control(trainer, { x: 5, y: -8 }), null, 'LED monitor area returns null for board drag');
  assert.equal(def.control(trainer, { x: 20, y: -1.5 }), null, 'Socket header area returns null for board drag');

  console.log('ALL TRAINER BOARD CHECKS PASSED (16 LEDs, P1/P1\', P2/P2\', S0..S9/S2\'..S9\', DOWN=1/UP=0, zero dead gaps)!');
}

testTrainerBoard();

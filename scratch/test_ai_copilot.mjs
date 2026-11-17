import assert from 'node:assert/strict';
import '../src/parts/library.js';
import '../src/mcu/boards.js';
import { Circuit, Board, Part, Wire } from '../src/model.js';
import { Engine, key } from '../src/sim/engine.js';
import { findProblems } from '../src/editor.js';
import { filterAndSortModels, extractJsonObject, salvageTruncatedBuildJson, callGroq, splitKeys, fetchModels, detectKeyProvider, isGeminiModel } from '../src/ai/client.js';
import { buildPartsCatalogPrompt, buildSystemPrompt, serializeCircuitState } from '../src/ai/context.js';
import { applyAiBuildPlan, resolvePartType, resolvePinIndex } from '../src/ai/builder.js';
import { parseBooleanExpr, evalBooleanAst, extractGateConstraints, extractBooleanSpec } from '../src/ai/logic_verify.js';
import { AiCopilot } from '../src/ai/copilot.js';
import { AiGuide } from '../src/ai/guide.js';
import { getDef } from '../src/parts/registry.js';

function createHeadlessApp() {
  const app = {
    circuit: new Circuit(),
    engine: new Engine(),
    mode: 'build',
    paused: false,
    checks: [],
    samples: new Map(),
    netKinds: new Map(),
    index: { holes: new Map(), pins: new Map(), ends: new Map() },
    settings: { get: () => true, set: () => {} },
    historyStack: [],
    ui: { inspect() {}, syncToolbar() {}, renderProbes() {}, toggleAnalyzer: null, toast() {} },
    redraw() {},
    save() {},
    fit() {},
    load(json) {
      this.circuit = Circuit.fromJSON(typeof json === 'string' ? JSON.parse(json) : json);
      this.reindex();
    },
    reindex(fast = false) {
      const holes = new Map(), pins = new Map(), ends = new Map();
      for (const b of this.circuit.boards) for (const hl of b.holes()) holes.set(key(hl.x, hl.y), hl);
      for (const p of this.circuit.parts) for (const q of p.worldPins()) {
        const k = key(q.x, q.y);
        if (!pins.has(k)) pins.set(k, []);
        pins.get(k).push({ part: p, i: q.i, name: q.name });
      }
      for (const w of this.circuit.wires) for (const e of [w.a, w.b]) {
        const k = key(e.x, e.y);
        if (!ends.has(k)) ends.set(k, []);
        ends.get(k).push(e);
      }
      this.index = { holes, pins, ends };
      this.engine.build(this.circuit);
      this.computeNetKinds();
      if (!fast) this.computeChecks();
    },
    computeNetKinds() {
      const kinds = new Map();
      for (const p of this.circuit.parts) {
        const def = getDef(p.type);
        if (!def.supply) continue;
        const e = this.engine.byPart.get(p.id);
        if (!e) continue;
        for (const s of def.supply(p)) {
          const n = e.pinNets[s.i];
          if (n < 0) continue;
          if (!kinds.has(n)) kinds.set(n, []);
          kinds.get(n).push({ kind: s.kind, part: p.id });
        }
      }
      this.netKinds = kinds;
    },
    clash(a, b) {
      const [ta, va] = a.split(':'), [tb, vb] = b.split(':');
      if ((ta === 'V' && tb === 'G') || (ta === 'G' && tb === 'V')) return `Short ${va || vb}V supply to ground.`;
      if (ta === 'V' && tb === 'V' && va !== vb) return `Connect ${va}V and ${vb}V together.`;
      if ((ta === 'B+' && tb === 'B-') || (ta === 'B-' && tb === 'B+')) { if (va === vb) return 'Battery + and - shorted.'; }
      return null;
    },
    supplyClash(x, y, kind, ignoreIds) {
      const n = this.engine.netAt(x, y);
      if (n < 0) return null;
      for (const o of this.netKinds.get(n) || []) {
        if (ignoreIds.has(o.part)) continue;
        const why = this.clash(kind, o.kind);
        if (why) return why;
      }
      return null;
    },
    shortReason(a, b) {
      const na = this.engine.netAt(a.x, a.y), nb = this.engine.netAt(b.x, b.y);
      if (na < 0 || nb < 0 || na === nb) return null;
      for (const x of this.netKinds.get(na) || []) for (const y of this.netKinds.get(nb) || []) {
        const why = this.clash(x.kind, y.kind);
        if (why) return why;
      }
      return null;
    },
    computeChecks() {
      const c = this.circuit, e = this.engine, out = [];
      const pinCount = new Map();
      for (const [, ent] of e.byPart) for (const n of ent.pinNets) if (n >= 0) pinCount.set(n, (pinCount.get(n) || 0) + 1);
      for (const w of c.wires) {
        const n = e.netAt(w.a.x, w.a.y);
        if (!pinCount.get(n)) out.push({ level: 'warn', wire: w, text: 'Floating wire.' });
      }
      this.checks = out;
    },
    allIssues() {
      const sim = this.mode === 'sim' ? this.engine.warnings : [];
      return [...sim, ...this.checks];
    },
    commit(label) {
      this.circuit.syncWires();
      this.reindex();
      this.historyStack.push(label);
      this.aiGuide?.onCircuitChanged();
    },
    setMode(m) {
      this.mode = m;
      this.engine.reset();
      this.engine.build(this.circuit);
    },
  };
  app.editor = { problems: (parts, boards = []) => findProblems(app, parts, boards) };
  app.aiGuide = new AiGuide(app);
  app.circuit.boards.push(new Board('half', 0, 0));
  app.reindex();
  return app;
}

console.log('1. Testing Groq client model filtering, JSON parsing & decommissioned model fallback...');
const sorted = filterAndSortModels([
  { id: 'whisper-large-v3' },
  { id: 'canopylabs/orpheus-v1-english' },
  { id: 'meta-llama/llama-prompt-guard-2-22m' },
  { id: 'openai/gpt-oss-20b' },
  { id: 'qwen/qwen3.8-27b' },
  { id: 'openai/gpt-oss-120b' },
]);
assert.deepEqual(sorted.map(m => m.id), ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b']);

const parsed1 = extractJsonObject('<think>let me calculate R=220</think>\n```json\n{"intent":"analyze","reply":"OK"}\n```');
assert.equal(parsed1.intent, 'analyze');
assert.equal(parsed1.reply, 'OK');

const parsedTypo = extractJsonObject('{"intent":"build","connections",":",[["V1.1","+"]]}');
assert.equal(parsedTypo.connections[0][0], 'V1.1');

let otpmTries = 0;
const otpmFetch = async (_url, opts) => {
  otpmTries++;
  const b = JSON.parse(opts.body);
  if (otpmTries === 1) {
    assert.equal(b.max_completion_tokens, 920);
    return {
      ok: false,
      status: 429,
      json: async () => ({ error: { message: 'Request too large for model `qwen/qwen3.8-27b` on output tokens per minute (OTPM): Limit 1000, Used 300, Requested 920.' } }),
    };
  }
  assert.equal(b.max_completion_tokens, 660);
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"intent":"analyze","reply":"Shrunk"}' } }] }) };
};
const shrunkRes = await callGroq({ apiKey: 'gsk_test', model: 'qwen/qwen3.8-27b', messages: [{ role: 'user', content: 'hi' }], availableModels: [{ id: 'qwen/qwen3.8-27b' }], fetchFn: otpmFetch });
assert.equal(shrunkRes.parsed.reply, 'Shrunk');

let calls = 0;
const mockFetch = async (_url, opts) => {
  calls++;
  const body = JSON.parse(opts.body);
  if (body.model === 'llama-3.3-70b-versatile') {
    return {
      ok: false,
      status: 400,
      json: async () => ({ error: { code: 'model_decommissioned', message: 'Model has been decommissioned' } }),
    };
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({ intent: 'analyze', reply: 'Switched!' }) } }] }),
  };
};
const fallbackRes = await callGroq({
  apiKey: 'gsk_test',
  model: 'llama-3.3-70b-versatile',
  messages: [{ role: 'user', content: 'hi' }],
  fetchFn: mockFetch,
});
assert.equal(calls, 2);
assert.equal(fallbackRes.modelUsed, 'openai/gpt-oss-120b');
assert.equal(fallbackRes.switchedFrom, 'llama-3.3-70b-versatile');
console.log('   [PASS] Groq client tests passed.');

console.log('2. Testing Catalog prompt & Circuit serializer...');
const cat = buildPartsCatalogPrompt();
assert.match(cat, /ne555/);
assert.match(cat, /ic7408/);
assert.match(cat, /oscilloscope/);
assert.match(cat, /funcgen/);
assert.match(cat, /power-supply/);
assert.match(cat, /uno/);

console.log('3. Testing 555 Astable Blinker + Oscilloscope AI Build & Closed-Loop Simulation...');
const app = createHeadlessApp();
const res555 = applyAiBuildPlan(app, {
  clearExisting: true,
  board: 'half',
  parts: [
    { ref: 'VCC', type: '5V' },
    { ref: 'GND', type: 'ground' },
    { ref: 'U1', type: '555' },
    { ref: 'R1', type: 'resistor', props: { ohms: 1000 } },
    { ref: 'R2', type: 'resistor', props: { ohms: 10000 } },
    { ref: 'C1', type: 'capacitor', props: { uf: 4.7 } },
    { ref: 'R3', type: 'resistor', props: { ohms: 330 } },
    { ref: 'D1', type: 'green led' },
    { ref: 'SC', type: 'oscilloscope', props: { timeDiv: 0.05, ch1Scale: 2 } },
  ],
  connections: [
    ['VCC.+5V', '+'],
    ['GND.GND', '-'],
    ['U1.VCC', '+'],
    ['U1.RESET', '+'],
    ['U1.GND', '-'],
    ['R1.1', '+'],
    ['R1.2', 'U1.DIS'],
    ['R2.1', 'U1.DIS'],
    ['R2.2', 'U1.THR'],
    ['U1.TRIG', 'U1.THR'],
    ['C1.+', 'U1.THR'],
    ['C1.-', '-'],
    ['U1.OUT', 'R3.1'],
    ['R3.2', 'D1.A'],
    ['D1.K', '-'],
    ['SC.CH1', 'U1.OUT'],
    ['SC.CH1-', '-'],
  ],
});
assert.equal(res555.ok, true, 'Expected 555 build to pass: ' + JSON.stringify(res555.errors));
assert.equal(app.editor.problems(app.circuit.parts, app.circuit.boards).msg, null);
// Step simulator 0.25s and verify oscillation + scope readings
for (let i = 0; i < 120; i++) app.engine.step(0.002);
const state555 = serializeCircuitState(app);
const scEntry = state555.parts.find(p => p.type === 'oscilloscope');
assert.ok(scEntry?.readings?.ch1 && scEntry.readings.ch1 !== 'no signal', 'Expected valid scope CH1 reading');
assert.ok(scEntry.readings.ch1.vpp > 2.5, `Expected oscillating scope Vpp > 2.5V, got ${scEntry.readings.ch1.vpp}`);
console.log(`   [PASS] 555 Astable + Scope passed (CH1 Vpp=${scEntry.readings.ch1.vpp}V, f=${scEntry.readings.ch1.freqHz}Hz).`);

console.log('4. Testing 7408 AND Gate Truth Table AI Build...');
const res7408 = applyAiBuildPlan(app, {
  clearExisting: true,
  parts: [
    { ref: 'VCC', type: 'vcc' },
    { ref: 'GND', type: 'gnd' },
    { ref: 'U1', type: '74LS08' },
    { ref: 'SW1', type: 'toggle', props: { on: false } },
    { ref: 'SW2', type: 'toggle', props: { on: false } },
    { ref: 'R1', type: 'resistor', props: { ohms: 220 } },
    { ref: 'D1', type: 'led', props: { color: 'red' } },
  ],
  connections: [
    ['VCC.+5V', '+'],
    ['GND.GND', '-'],
    ['U1.VCC', '+'],
    ['U1.GND', '-'],
    ['SW1.OUT', 'U1.1A'],
    ['SW2.OUT', 'U1.1B'],
    ['U1.1Y', 'R1.1'],
    ['R1.2', 'D1.A'],
    ['D1.K', '-'],
  ],
});
assert.equal(res7408.ok, true, 'Expected 7408 build to pass: ' + JSON.stringify(res7408.errors));
const sw1 = res7408.refMap.get('SW1');
const sw2 = res7408.refMap.get('SW2');
const led = res7408.refMap.get('D1');
app.engine.step(0.005);
const ledCur = () => Math.abs(app.engine.byPart.get(led.id).device.cur[0]);
assert.ok(ledCur() < 1e-4, '0 & 0 should leave LED OFF');
sw1.props.on = true;
app.engine.step(0.005);
assert.ok(ledCur() < 1e-4, '1 & 0 should leave LED OFF');
sw2.props.on = true;
app.engine.step(0.005);
assert.ok(ledCur() > 0.003, `1 & 1 should light LED (>3mA), got ${ledCur()}`);
console.log(`   [PASS] 7408 AND gate truth table verified (LED ON current=${(ledCur() * 1000).toFixed(2)} mA).`);

console.log('5. Testing Arduino Uno AI Build + Code Compilation + Output...');
const resUno = applyAiBuildPlan(app, {
  clearExisting: true,
  parts: [
    {
      ref: 'M1',
      type: 'uno',
      props: {
        code: `
void setup() {
  pinMode(13, OUTPUT);
  digitalWrite(13, HIGH);
  Serial.begin(115200);
  Serial.println("AI_UNO_READY");
}
void loop() { delay(500); }
`,
      },
    },
    { ref: 'R1', type: 'resistor', props: { ohms: 220 } },
    { ref: 'D1', type: 'led', props: { color: 'blue' } },
  ],
  connections: [
    ['M1.D13', 'R1.1'],
    ['R1.2', 'D1.A'],
    ['D1.K', 'M1.GND'],
  ],
});
assert.equal(resUno.ok, true, 'Expected Uno build to pass: ' + JSON.stringify(resUno.errors));
app.engine.step(0.01);
const unoState = serializeCircuitState(app);
const unoMcu = unoState.parts.find(p => p.type === 'uno');
assert.match(unoMcu.mcu.serial, /AI_UNO_READY/);
console.log('   [PASS] Arduino Uno build, sketch compile & serial execution passed.');

console.log('6. Testing Failure Rejection & Clean Rollback...');
const partsBeforeBad = app.circuit.parts.length;
const badRes = applyAiBuildPlan(app, {
  clearExisting: true,
  parts: [
    { ref: 'VCC', type: 'vcc' },
    { ref: 'GND', type: 'gnd' },
    { ref: 'U1', type: 'ic7408' },
  ],
  connections: [
    ['VCC.+5V', '+'],
    ['GND.GND', '-'],
    ['U1.VCC', '+'],
    ['U1.GND', '+'], // Deliberate power-rail clash!
  ],
});
assert.equal(badRes.ok, false);
assert.ok(badRes.errors.length > 0);
assert.equal(app.circuit.parts.length, partsBeforeBad, 'Circuit must roll back cleanly on failure');
console.log('   [PASS] Rejected invalid circuit and preserved workspace.');

console.log('7. Testing Interactive Smart Guide Mode (Strip/Column Equivalence & Auto-Advance)...');
const guidePlan = {
  clearExisting: true,
  board: 'half',
  parts: [
    { ref: 'VCC', type: 'vcc' },
    { ref: 'GND', type: 'gnd' },
    { ref: 'U1', type: 'ic7408' },
  ],
  connections: [
    ['VCC.+5V', '+'],
    ['GND.GND', '-'],
    ['U1.VCC', '+'],
    ['U1.GND', '-'],
  ],
};
const gStart = app.aiGuide.start(guidePlan, '7408 Power Guide');
assert.equal(gStart.ok, true);
assert.equal(app.aiGuide.getState().doneCount, 0);

// Complete VCC & GND with Do Step For Me
app.aiGuide.doCurrentStep(); // VCC
app.aiGuide.doCurrentStep(); // GND
assert.equal(app.aiGuide.activeStep.ref, 'U1');

// User manually places ic7408 at an ALTERNATE column (x=15 instead of target col!)
const userChip = new Part('ic7408', 15, 11, 0);
app.circuit.parts.push(userChip);
app.commit('User places IC elsewhere');
assert.equal(app.aiGuide.activeStep.kind, 'wire', 'Guide must bind U1 to alternate column and advance to wiring!');

// Wire VCC.+5V -> + via Do Step
app.aiGuide.doCurrentStep();
// Wire GND.GND -> - via Do Step
app.aiGuide.doCurrentStep();
// Now activeStep should be U1.VCC -> +
assert.equal(app.aiGuide.activeStep.aTok, 'U1.VCC');

// User manually wires hole in U1.VCC's strip (x=15, y=6 [row c instead of e]) to col 25 of Top + rail (y=1)!
app.circuit.wires.push(new Wire({ x: 15, y: 6 }, { x: 27, y: 1 }, '#e5484d'));
app.commit('User wires alternate strip hole to alternate rail hole');
assert.equal(app.aiGuide.activeStep.aTok, 'U1.GND', 'Strip/rail electrical equivalence must auto-advance U1.VCC -> +!');

app.aiGuide.doAllSteps();
assert.equal(app.aiGuide.getState().finished, true);
console.log('   [PASS] Smart Guide Mode passed (alternate placement + strip/rail auto-advance + complete).');

console.log('8. Testing Live-Discovered Safeguards (Chained Wires, Spec Aliases, Toggle/555 DRC, Valid Pins Hint)...');
const flexRes = applyAiBuildPlan(app, {
  clearExisting: true,
  board: 'half',
  parts: [
    { id: 'V1', part: 'vcc' },
    { id: 'G1', component: 'gnd' },
    { ref: 'SW1', type: 'toggle' },
    { ref: 'R1', type: 'resistor', resistance: 220 },
    { ref: 'D1', type: 'led', color: 'green' },
    { ref: 'C1', type: 'capacitor', capacitance: 0.1 },
  ],
  connections: [
    ['V1.1', '+'],
    ['G1.1', '-'],
    ['SW1.OUT', 'R1.1'],
    ['R1.2', 'D1.A', 'C1.+'],
    { from: 'D1.K', to: '-' },
    { from: 'C1.-', to: '-' },
  ],
});
assert.equal(flexRes.ok, true, 'Malformed part keys + chained connections must normalize cleanly: ' + JSON.stringify(flexRes.errors));

const toggleClash = applyAiBuildPlan(app, {
  clearExisting: true,
  board: 'half',
  parts: [{ ref: 'V1', type: 'vcc' }, { ref: 'G1', type: 'gnd' }, { ref: 'SW_BAD', type: 'toggle' }],
  connections: [['V1.1', '+'], ['G1.1', '-'], ['SW_BAD.OUT', '+']],
});
assert.equal(toggleClash.ok, false);
assert.match(toggleClash.errors.join(' '), /SW_BAD/);

const badPinRes = applyAiBuildPlan(app, {
  clearExisting: true,
  board: 'half',
  parts: [{ ref: 'U2', type: 'ic7486' }],
  connections: [['U2.7A', '+']],
});
assert.equal(badPinRes.ok, false);
assert.match(badPinRes.errors.join(' '), /Valid pins:.*1A/);
console.log('   [PASS] Regression safeguards passed.');

console.log('9. Testing Full Incomplete-Board Awareness, Surgical removeWires & Incremental Guide...');
// Build a broken/partial board using ic7408 + wrong resistor value (47 ohm) + backwards LED wire
const initBroken = applyAiBuildPlan(app, {
  clearExisting: true,
  board: 'half',
  parts: [
    { ref: 'V1', type: 'vcc' },
    { ref: 'G1', type: 'gnd' },
    { ref: 'U1', type: 'ic7408' },
    { ref: 'R1', type: 'resistor', props: { ohms: 47 } },
    { ref: 'D1', type: 'led', props: { color: 'red' } },
  ],
  connections: [
    ['V1.1', '+'],
    ['G1.1', '-'],
    ['U1.VCC', '+'],
    ['U1.GND', '-'],
  ],
});
assert.equal(initBroken.ok, true);
const r1Id = app.circuit.parts.find(p => p.type === 'resistor').id;
const d1Id = app.circuit.parts.find(p => p.type === 'led').id;
const u1Id = app.circuit.parts.find(p => p.type === 'ic7408').id;
// Add a wrong manual wire directly across D1 Cathode -> +5V
const wrongW = new Wire(
  { x: app.circuit.partById(d1Id).worldPins()[1].x, y: 12 },
  { x: 5, y: 1 },
  '#e5484d',
);
app.circuit.wires.push(wrongW);
app.commit('Add wrong LED cathode wire');

app.editor.selection = new Set([r1Id]);
const partialSnap = serializeCircuitState(app);
assert.ok(Array.isArray(partialSnap.wires) && partialSnap.wires.some(s => s.includes(wrongW.id)), 'Serializer must expose wire IDs & endpoints');
const u1Snap = partialSnap.parts.find(p => p.id === u1Id);
assert.ok(Array.isArray(u1Snap.unwired) && u1Snap.unwired.includes('1Y'), 'Serializer must list unwired pins on incomplete ICs');
assert.deepEqual(partialSnap.selected, [r1Id]);

// Incremental guide: remove wrong wire, update resistor to 220, keep U1/V1/G1, add missing wiring!
const incGuide = app.aiGuide.start({
  clearExisting: false,
  removeWires: [[`${d1Id}.K`, '+']],
  updates: [{ id: r1Id, props: { resistance: 220 } }],
  parts: [],
  connections: [[`${u1Id}.1Y`, `${r1Id}.1`], [`${r1Id}.2`, `${d1Id}.A`], [`${d1Id}.K`, '-']],
}, 'Finish & Fix Gate Output');
assert.equal(incGuide.ok, true, 'Incremental guide with removeWires + updates must succeed: ' + JSON.stringify(incGuide.errors));
const gSteps = app.aiGuide.getState().steps;
assert.equal(gSteps[0].kind, 'removeWire');
assert.equal(gSteps[1].kind, 'update');

app.aiGuide.doCurrentStep(); // removes wrongW
assert.equal(app.circuit.wires.some(w => w.id === wrongW.id), false);
app.aiGuide.doCurrentStep(); // updates R1 -> 220
assert.equal(app.circuit.partById(r1Id).props.ohms, 220);
app.aiGuide.doAllSteps();
assert.equal(app.aiGuide.getState().finished, true);
assert.ok(app.circuit.partById(u1Id), 'Original ic7408 must be preserved');
console.log('   [PASS] Incomplete-board awareness, surgical wire repair & incremental Guide passed.');

console.log('10. Testing Multi-Key Failover, Fuzzy 555/DIP8 Safeguards & Instant User Message Hook...');
assert.deepEqual(splitKeys('gsk_a, gsk_b\ngsk_c;gsk_d'), ['gsk_a', 'gsk_b', 'gsk_c', 'gsk_d']);

const mkTrace = [];
const multiKeyRes = await callGroq({
  apiKey: 'gsk_dead1, gsk_live2',
  model: 'openai/gpt-oss-120b',
  messages: [{ role: 'user', content: 'hi' }],
  fetchFn: async (_u, opts) => {
    const k = opts.headers.Authorization.replace('Bearer ', '');
    const b = JSON.parse(opts.body);
    mkTrace.push(`${k}:${b.model}`);
    if (k === 'gsk_dead1') {
      return { ok: false, status: 429, json: async () => ({ error: { message: 'tokens per day (TPD) exceeded, try again in 15m' } }) };
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"intent":"analyze","reply":"Key2 works!"}' } }] }) };
  },
});
assert.deepEqual(mkTrace, ['gsk_dead1:openai/gpt-oss-120b', 'gsk_live2:openai/gpt-oss-120b']);
assert.equal(multiKeyRes.modelUsed, 'openai/gpt-oss-120b');

const tmp555 = new Part('ne555', 5, 11, 0);
assert.equal(resolvePinIndex(tmp555, 'DISC'), 6, 'Fuzzy pin resolver must map DISC -> DIS (pin 7)');
const dipClash = applyAiBuildPlan(app, {
  clearExisting: true,
  board: 'half',
  parts: [{ ref: 'V1', type: 'vcc' }, { ref: 'G1', type: 'gnd' }, { ref: 'D1', type: 'dip8' }],
  connections: [['V1.1', '+'], ['G1.1', '-'], ['D1.S1', '+']],
});
assert.equal(dipClash.ok, false);
assert.match(dipClash.errors.join(' '), /DIP Switch/);

// Verify user message appears synchronously via onChange before async API completes
let savedModel = 'openai/gpt-oss-120b';
const copApp = {
  ...app,
  settings: { get: (k) => (k === 'groqKey' ? 'gsk_mock' : k === 'aiModel' ? savedModel : 'auto'), set: (k, v) => { if (k === 'aiModel') savedModel = v; } },
};
const cop = new AiCopilot(copApp);
cop.hasServerKey = true;
let echoedImmediately = false;
cop.onChange = () => {
  if (cop.busy && cop.messages.length === 1 && cop.messages[0].text === 'instant check') echoedImmediately = true;
};
try { await cop.ask('instant check'); } catch { /* expected in offline mock */ }
assert.equal(echoedImmediately, true, 'User message & busy state must emit before API finishes');
console.log('   [PASS] Multi-key failover, fuzzy pins, DIP8 clash check & instant message hook passed.');

console.log('11. Testing Universal Pin Disambiguation, IC Floating DRC, Output Contention & Boolean Verifier...');
const tmp74 = new Part('ic7474', 5, 11, 0);
assert.equal(resolvePinIndex(tmp74, '1Q'), 4, '1Q must stay index 4');
assert.equal(resolvePinIndex(tmp74, '1Q̅'), 5, '1Q̅ must map to index 5');
assert.equal(resolvePinIndex(tmp74, '1Q_BAR'), 5, '1Q_BAR must map to inverted output index 5');
assert.equal(resolvePinIndex(tmp74, '/1Q'), 5, '/1Q must map to inverted output index 5');
assert.equal(resolvePinIndex(tmp74, '1QN'), 5, '1QN must map to inverted output index 5');
assert.equal(resolvePinIndex(tmp74, 'D1'), 1, 'Digit-letter swap D1 -> 1D');
assert.equal(resolvePinIndex(tmp74, 'CLK1'), 2, 'Digit-letter swap CLK1 -> 1CLK');

const tmp4017 = new Part('ic4017', 5, 11, 0);
assert.equal(resolvePinIndex(tmp4017, 'VCC'), 15, 'CMOS ic4017 VCC -> VDD');
assert.equal(resolvePinIndex(tmp4017, 'GND'), 7, 'CMOS ic4017 GND -> VSS');
assert.equal(resolvePinIndex(tmp4017, 'MR'), 14, 'ic4017 MR -> RST');

const tmp283 = new Part('ic74283', 5, 11, 0);
assert.equal(resolvePinIndex(tmp283, 'S1'), 3, 'ic74283 S1 -> Σ1');
assert.equal(resolvePinIndex(tmp283, 'CIN'), 6, 'ic74283 CIN -> C0');
const tmp595 = new Part('ic74595', 5, 11, 0);
assert.equal(resolvePinIndex(tmp595, 'DS'), 13, 'ic74595 DS -> SER');
assert.equal(resolvePinIndex(tmp595, 'SHCP'), 10, 'ic74595 SHCP -> SRCLK');
assert.equal(resolvePinIndex(tmp595, 'STCP'), 11, 'ic74595 STCP -> RCLK');
const tmp7400 = new Part('ic7400', 5, 11, 0);
assert.equal(resolvePinIndex(tmp7400, 'A1'), 0, 'ic7400 A1 -> 1A');
assert.equal(resolvePinIndex(tmp7400, 'Y1'), 2, 'ic7400 Y1 -> 1Y');

// Malformed parts guard
const badPartEntry = applyAiBuildPlan(app, { clearExisting: true, board: 'half', parts: [123], connections: [] });
assert.equal(badPartEntry.ok, false);
assert.doesNotMatch(badPartEntry.errors.join(' '), /Unknown component type "undefined"/);

// Constraint & Boolean parsing checks
assert.equal(extractGateConstraints("build F = A'B + AC' using ONLY 7400 NAND gates (no AND/OR/NOT chips)").nandOnly, true);
assert.equal(extractGateConstraints('build using NAND gates and XOR gates').nandOnly, false);
const bSpec = extractBooleanSpec('we have to make Y = (A + B) * C using NAND gates only');
assert.ok(bSpec && bSpec.vars.join(',') === 'A,B,C');
assert.equal(evalBooleanAst(bSpec.ast, { A: 0, B: 0, C: 1 }), 0);
assert.equal(evalBooleanAst(bSpec.ast, { A: 0, B: 1, C: 1 }), 1);

// NAND-only constraint rejection when non-NAND gate placed
const nonNandRes = applyAiBuildPlan(app, {
  clearExisting: true,
  board: 'half',
  parts: [{ ref: 'V1', type: 'vcc' }, { ref: 'G1', type: 'gnd' }, { ref: 'U1', type: 'ic7408' }, { ref: 'A', type: 'toggle' }, { ref: 'B', type: 'toggle' }, { ref: 'R1', type: 'resistor', props: { ohms: 220 } }, { ref: 'L1', type: 'led' }],
  connections: [['V1.1', '+'], ['G1.1', '-'], ['U1.VCC', '+'], ['U1.GND', '-'], ['A.OUT', 'U1.1A'], ['B.OUT', 'U1.1B'], ['U1.1Y', 'R1.1'], ['R1.2', 'L1.A'], ['L1.K', '-']],
}, { prompt: 'make F = A * B using NAND gates only' });
assert.equal(nonNandRes.ok, false);
assert.match(nonNandRes.errors.join(' '), /NAND gates ONLY/);

// Floating gate input & output contention check
const halfGateRes = applyAiBuildPlan(app, {
  clearExisting: true,
  board: 'half',
  parts: [{ ref: 'V1', type: 'vcc' }, { ref: 'G1', type: 'gnd' }, { ref: 'U1', type: 'ic7400' }, { ref: 'A', type: 'toggle' }, { ref: 'R1', type: 'resistor', props: { ohms: 220 } }, { ref: 'L1', type: 'led' }],
  connections: [['V1.1', '+'], ['G1.1', '-'], ['U1.VCC', '+'], ['U1.GND', '-'], ['A.OUT', 'U1.1A'], ['U1.1Y', 'R1.1'], ['R1.2', 'L1.A'], ['L1.K', '-']],
});
assert.equal(halfGateRes.ok, false);
assert.match(halfGateRes.errors.join(' '), /1B floating/);

const shortedOutRes = applyAiBuildPlan(app, {
  clearExisting: true,
  board: 'half',
  parts: [{ ref: 'V1', type: 'vcc' }, { ref: 'G1', type: 'gnd' }, { ref: 'U1', type: 'ic7486' }, { ref: 'U2', type: 'ic7408' }, { ref: 'A', type: 'toggle' }, { ref: 'B', type: 'toggle' }, { ref: 'R1', type: 'resistor', props: { ohms: 220 } }, { ref: 'L1', type: 'led' }],
  connections: [['V1.1', '+'], ['G1.1', '-'], ['U1.VCC', '+'], ['U1.GND', '-'], ['U2.VCC', '+'], ['U2.GND', '-'], ['A.OUT', 'U1.1A'], ['B.OUT', 'U1.1B'], ['U1.1Y', 'U2.1A'], ['A.OUT', 'U2.1A'], ['B.OUT', 'U2.1B'], ['U2.1Y', 'R1.1'], ['R1.2', 'L1.A'], ['L1.K', '-']],
});
assert.equal(shortedOutRes.ok, false);
assert.match(shortedOutRes.errors.join(' '), /driver contention/i);

// Boolean truth-table rejection on wrong logic vs pass on correct logic
const wrongBool = applyAiBuildPlan(app, {
  clearExisting: true,
  board: 'half',
  parts: [{ ref: 'V1', type: 'vcc' }, { ref: 'G1', type: 'gnd' }, { ref: 'U1', type: 'ic7400' }, { ref: 'D1', type: 'dip4' }, { ref: 'R1', type: 'resistor', props: { ohms: 220 } }, { ref: 'L1', type: 'led' }],
  connections: [['V1.1', '+'], ['G1.1', '-'], ['U1.VCC', '+'], ['U1.GND', '-'], ['D1.S1', 'U1.1A'], ['D1.S2', 'U1.1B'], ['U1.1Y', 'U1.2A'], ['D1.S3', 'U1.2B'], ['U1.2Y', 'R1.1'], ['R1.2', 'L1.A'], ['L1.K', '-']],
}, { prompt: 'make Y = (A + B) * C using NAND gates only' });
assert.equal(wrongBool.ok, false);
assert.match(wrongBool.errors.join(' '), /Boolean logic verification failed/);

// 7474 floating 1D rejection vs working 1Q̅ -> 1D divide-by-2 acceptance
const stuck7474 = applyAiBuildPlan(app, {
  clearExisting: true,
  board: 'half',
  parts: [{ ref: 'V1', type: 'vcc' }, { ref: 'G1', type: 'gnd' }, { ref: 'U1', type: 'ic7474' }, { ref: 'CLK', type: 'clock', props: { hz: 5 } }, { ref: 'R1', type: 'resistor', props: { ohms: 220 } }, { ref: 'L1', type: 'led' }],
  connections: [['V1.1', '+'], ['G1.1', '-'], ['U1.VCC', '+'], ['U1.GND', '-'], ['CLK.CLK', 'U1.1CLK'], ['U1.1Q', 'U1.1D'], ['U1.1PRE', '+'], ['U1.1CLR', '+'], ['U1.1Q', 'R1.1'], ['R1.2', 'L1.A'], ['L1.K', '-']],
});
assert.equal(stuck7474.ok, false);
assert.match(stuck7474.errors.join(' '), /stayed stuck/);

const good7474 = applyAiBuildPlan(app, {
  clearExisting: true,
  board: 'half',
  parts: [{ ref: 'V1', type: 'vcc' }, { ref: 'G1', type: 'gnd' }, { ref: 'U1', type: 'ic7474' }, { ref: 'CLK', type: 'clock', props: { hz: 5 } }, { ref: 'R1', type: 'resistor', props: { ohms: 220 } }, { ref: 'L1', type: 'led' }],
  connections: [['V1.1', '+'], ['G1.1', '-'], ['U1.VCC', '+'], ['U1.GND', '-'], ['CLK.CLK', 'U1.1CLK'], ['U1.1Q_BAR', 'U1.1D'], ['U1.1PRE', '+'], ['U1.1CLR', '+'], ['U1.1Q', 'R1.1'], ['R1.2', 'L1.A'], ['L1.K', '-']],
});
assert.equal(good7474.ok, true, 'Working 7474 divide-by-2 must pass: ' + JSON.stringify(good7474.errors));

// Contradiction / dead combinational output detection (A & ~A always 0)
const deadCombo = applyAiBuildPlan(app, {
  clearExisting: true,
  board: 'half',
  parts: [{ ref: 'V1', type: 'vcc' }, { ref: 'G1', type: 'gnd' }, { ref: 'U1', type: 'ic7404' }, { ref: 'U2', type: 'ic7408' }, { ref: 'A', type: 'toggle' }, { ref: 'R1', type: 'resistor', props: { ohms: 220 } }, { ref: 'L1', type: 'led' }],
  connections: [['V1.1', '+'], ['G1.1', '-'], ['U1.VCC', '+'], ['U1.GND', '-'], ['U2.VCC', '+'], ['U2.GND', '-'], ['A.OUT', 'U1.1A'], ['A.OUT', 'U2.1A'], ['U1.1Y', 'U2.1B'], ['U2.1Y', 'R1.1'], ['R1.2', 'L1.A'], ['L1.K', '-']],
});
assert.equal(deadCombo.ok, false);
assert.match(deadCombo.errors.join(' '), /Combinational logic check failed/);
console.log('   [PASS] Universal pin disambiguation, IC floating DRC, output contention, Boolean & 7474 liveness checks passed.');

console.log('12. Testing Unloaded 555 Load Removal & Off-Topic Chat in Build Mode...');
// Build a 555 astable + LED, then remove LED + its series resistor so ne555.OUT is legitimately open
const astBuild = applyAiBuildPlan(app, {
  clearExisting: true,
  board: 'half',
  parts: [
    { ref: 'V1', type: 'vcc' }, { ref: 'G1', type: 'gnd' }, { ref: 'U1', type: 'ne555' },
    { ref: 'R1', type: 'resistor', props: { ohms: 10000 } }, { ref: 'R2', type: 'resistor', props: { ohms: 47000 } },
    { ref: 'C1', type: 'capacitor', props: { uf: 10 } },
    { ref: 'R3', type: 'resistor', props: { ohms: 330 } }, { ref: 'D1', type: 'led' },
  ],
  connections: [
    ['V1.1', '+'], ['G1.1', '-'], ['U1.VCC', '+'], ['U1.GND', '-'], ['U1.RESET', '+'],
    ['R1.1', '+'], ['R1.2', 'U1.DIS'], ['R2.1', 'U1.DIS'], ['R2.2', 'U1.THR'],
    ['U1.TRIG', 'U1.THR'], ['C1.1', 'U1.THR'], ['C1.2', '-'],
    ['U1.OUT', 'R3.1'], ['R3.2', 'D1.A'], ['D1.K', '-'],
  ],
});
assert.equal(astBuild.ok, true);
const r3RealId = astBuild.placedParts.find(p => p.ref === 'R3').partId;
const d1RealId = astBuild.placedParts.find(p => p.ref === 'D1').partId;
const rmLedRes = applyAiBuildPlan(app, {
  clearExisting: false,
  remove: [d1RealId, r3RealId],
  connections: [],
});
assert.equal(rmLedRes.ok, true, 'Removing LED & its resistor leaving ne555.OUT open must pass: ' + JSON.stringify(rmLedRes.errors));

// Off-topic prompt in Build mode on non-empty board must NOT trigger forced build retry or errors
const origFetchSave = globalThis.fetch;
let chatCalls = 0;
globalThis.fetch = async () => {
  chatCalls++;
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"intent":"analyze","reply":"I am an electronics assistant — ask me about circuits!"}' } }] }) };
};
try {
  const chatCop = new AiCopilot(copApp);
  chatCop.hasServerKey = true;
  const chatRes = await chatCop.ask('hello there', 'build');
  assert.equal(chatCalls, 1, 'Off-topic/greeting in Build mode must NOT fire forced build follow-up');
  assert.equal(chatRes.intent, 'analyze');
  assert.equal(chatRes.meta?.build, null);
} finally {
  globalThis.fetch = origFetchSave;
}
console.log('   [PASS] Unloaded 555 removal & non-circuit chat in Build mode passed.');

console.log('13. Testing Display Catalog Match, 7493 Stuck-Reset DRC, Truncation Retry & Clean Non-JSON Reply...');
const dispCat = buildPartsCatalogPrompt('9x9 leds in a square displaying my name Umer');
assert.match(dispCat, /board-ssd1306/);
assert.match(dispCat, /uno/);

const badReset7493 = applyAiBuildPlan(app, {
  clearExisting: true,
  board: 'half',
  parts: [{ ref: 'V1', type: 'vcc' }, { ref: 'G1', type: 'gnd' }, { ref: 'U1', type: 'ic7493' }, { ref: 'CLK', type: 'clock' }],
  connections: [['V1.1', '+'], ['G1.1', '-'], ['U1.VCC', '+'], ['U1.GND', '-'], ['CLK.CLK', 'U1.CKA'], ['U1.R0(1)', '+'], ['U1.R0(2)', '+']],
});
assert.equal(badReset7493.ok, false);
assert.match(badReset7493.errors.join(' '), /active-HIGH reset/);

// Verify truncated initial response triggers compactRetry AND missing reply never dumps raw JSON into UI
const origFetch13 = globalThis.fetch;
let truncCalls = 0;
globalThis.fetch = async () => {
  truncCalls++;
  if (truncCalls === 1) {
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '{"intent":"build","parts":[{"ref":"V1","type":"vcc"' } }] }),
    };
  }
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{
        finish_reason: 'stop',
        message: {
          content: JSON.stringify({
            intent: 'build',
            plan: 'Built clean LED circuit via compact retry.',
            clearExisting: true,
            board: 'half',
            parts: [{ ref: 'V1', type: 'vcc' }, { ref: 'G1', type: 'gnd' }, { ref: 'R1', type: 'resistor', props: { ohms: 220 } }, { ref: 'D1', type: 'led' }],
            connections: [['V1.1', '+'], ['G1.1', '-'], ['+', 'R1.1'], ['R1.2', 'D1.A'], ['D1.K', '-']],
          }),
        },
      }],
    }),
  };
};
try {
  const { app: fresh13 } = createHeadlessApp ? { app: createHeadlessApp() } : { app: copApp };
  fresh13.settings = { get: (k) => (k === 'groqKey' ? 'gsk_mock' : k === 'aiModel' ? 'openai/gpt-oss-120b' : 'auto'), set: () => {} };
  const cop13 = new AiCopilot(fresh13);
  cop13.hasServerKey = true;
  const r13 = await cop13.ask('build simple led circuit', 'build');
  assert.equal(truncCalls, 2, 'Truncated raw JSON must fire compactRetry');
  assert.equal(r13.meta?.build?.ok, true);
  assert.equal(r13.meta?.selfFixed, true);
  assert.doesNotMatch(r13.text, /^\{.*"intent":/);
  assert.equal(r13.text, 'Built clean LED circuit via compact retry.');
} finally {
  globalThis.fetch = origFetch13;
}
console.log('   [PASS] Display catalog, 7493 reset DRC, truncation compactRetry & non-JSON reply passed.');

console.log('14. Testing 2D LED Grid Layout (row/col) & Static Pattern Verification...');
const allLitSmiley = applyAiBuildPlan(app, {
  clearExisting: true,
  board: 'half',
  parts: [
    { ref: 'V1', type: 'vcc' }, { ref: 'G1', type: 'gnd' },
    ...[0, 1, 2].flatMap(r => [0, 1, 2].map(c => ({ ref: `D${r}${c}`, type: 'led', row: r, col: c }))),
    ...[0, 1, 2].flatMap(r => [0, 1, 2].map(c => ({ ref: `R${r}${c}`, type: 'resistor', props: { ohms: 220 } }))),
  ],
  connections: [
    ['V1.1', '+'], ['G1.1', '-'],
    ...[0, 1, 2].flatMap(r => [0, 1, 2].flatMap(c => [['+', `R${r}${c}.1`], [`R${r}${c}.2`, `D${r}${c}.A`], [`D${r}${c}.K`, '-']])),
  ],
}, { prompt: 'place 9 leds in a square (3x3) like a smiley face' });
assert.equal(allLitSmiley.ok, false, 'All 9 LEDs glowing must fail visual smiley pattern check');
assert.match(allLitSmiley.errors.join(' '), /Visual LED pattern check failed/);

// Real 3x3 smiley (eyes (0,0)/(0,2), mouth (2,0)/(2,1)/(2,2) lit; rest unlit tied to GND)
const litSet = new Set(['0,0', '0,2', '2,0', '2,1', '2,2']);
const connsSmiley = [['V1.1', '+'], ['G1.1', '-']];
const partsSmiley = [{ ref: 'V1', type: 'vcc' }, { ref: 'G1', type: 'gnd' }];
for (let r = 0; r < 3; r++) {
  for (let c = 0; c < 3; c++) {
    partsSmiley.push({ ref: `D${r}${c}`, type: 'led', row: r, col: c });
    if (litSet.has(`${r},${c}`)) {
      partsSmiley.push({ ref: `R${r}${c}`, type: 'resistor', props: { ohms: 220 } });
      connsSmiley.push(['+', `R${r}${c}.1`], [`R${r}${c}.2`, `D${r}${c}.A`], [`D${r}${c}.K`, '-']);
    } else {
      connsSmiley.push([`D${r}${c}.A`, '-'], [`D${r}${c}.K`, '-']);
    }
  }
}
const realSmiley = applyAiBuildPlan(app, { clearExisting: true, board: 'half', parts: partsSmiley, connections: connsSmiley }, { prompt: 'place 9 leds in a square (3x3) like a smiley face' });
assert.equal(realSmiley.ok, true, 'Smiley 3x3 pattern must succeed: ' + JSON.stringify(realSmiley.errors));
const gridLeds = realSmiley.placedParts.filter(p => p.type === 'led');
assert.equal(new Set(gridLeds.map(p => p.x)).size, 3, 'Must occupy 3 distinct X columns in 3x3 square');
assert.equal(new Set(gridLeds.map(p => p.y)).size, 3, 'Must occupy 3 distinct Y rows in 3x3 square');
console.log('   [PASS] 2D 3x3 LED grid placement & static smiley pattern check passed.');

console.log('15. Testing Unpowered LED Rejection, 5x5 Auto-Grid Fallback & Large-Circuit TPM Cap...');
// Unpowered LED array (missing vcc/gnd parts) must be rejected cleanly
const noPowerLeds = applyAiBuildPlan(app, {
  clearExisting: true,
  board: 'half',
  parts: [{ ref: 'D1', type: 'led' }, { ref: 'R1', type: 'resistor', props: { ohms: 220 } }],
  connections: [['+', 'R1.1'], ['R1.2', 'D1.A'], ['D1.K', '-']],
}, { prompt: 'i meant leds not oled' });
assert.equal(noPowerLeds.ok, false, 'Circuit with LEDs and missing VCC/GND parts must fail');
assert.match(noPowerLeds.errors.join(' '), /NO power supply/);

// Powered 5x5 square where LLM omitted row/col must auto-grid into 5x5 and pass when smiley LEDs lit
const lit5 = new Set(['1,1', '1,3', '3,0', '3,4', '4,1', '4,2', '4,3']);
const p5 = [{ ref: 'V1', type: 'vcc' }, { ref: 'G1', type: 'gnd' }];
const c5 = [['V1.1', '+'], ['G1.1', '-']];
for (let r = 0; r < 5; r++) {
  for (let c = 0; c < 5; c++) {
    p5.push({ ref: `L${r}${c}`, type: 'led' });
    if (lit5.has(`${r},${c}`)) {
      p5.push({ ref: `R${r}${c}`, type: 'resistor', props: { ohms: 220 } });
      c5.push(['+', `R${r}${c}.1`], [`R${r}${c}.2`, `L${r}${c}.A`], [`L${r}${c}.K`, '-']);
    } else {
      c5.push([`L${r}${c}.A`, '-'], [`L${r}${c}.K`, '-']);
    }
  }
}
const auto5x5 = applyAiBuildPlan(app, { clearExisting: true, board: 'full', parts: p5, connections: c5 }, { prompt: 'place leds in a square 5x5 smiley face' });
assert.equal(auto5x5.ok, true, 'Auto-gridded 5x5 smiley must succeed: ' + JSON.stringify(auto5x5.errors));
const leds5 = auto5x5.placedParts.filter(p => p.type === 'led');
assert.equal(new Set(leds5.map(p => p.x)).size, 5, '5x5 must auto-arrange across 5 distinct X cols');
assert.equal(new Set(leds5.map(p => p.y)).size, 5, '5x5 must auto-arrange across 5 distinct Y rows');

// Serializing a huge 5x5 (34 parts + 25+ wires) board must fit cleanly inside 4800 chars (never TPM 9271!)
const hugeSnap = JSON.stringify(serializeCircuitState(app));
assert.ok(hugeSnap.length <= 4850, `Large board snapshot too large (${hugeSnap.length} chars) — risks Groq 8k TPM overflow`);
console.log(`   [PASS] Unpowered rejection, 5x5 auto-grid & large-board serialization cap (${hugeSnap.length} chars) passed.`);

console.log('16. Testing Compact System Prompt, Truncated JSON Salvage, Per-Model TPM Recovery, autoPower & 7-IC Auto Multi-Stage Execution...');
// 16a. Compact system prompt size (< 4000 chars for 7-NAND prompt vs ~6757 previously)
const sys7 = buildSystemPrompt({ mode: 'build', query: 'build the most complex circuit you can build with 7 nand chips and 10 leds' });
assert.ok(sys7.length < 4000, `System prompt should stay compact (<4000 chars), got ${sys7.length}`);
assert.match(sys7, /- ic7400\(IC\):/);
assert.doesNotMatch(sys7, /- ic74266\(IC\):/);

// 16b. salvageTruncatedBuildJson recovers complete objects/connections while skipping incomplete Test 13 snippet
assert.equal(salvageTruncatedBuildJson('{"intent":"build","parts":[{"ref":"V1","type":"vcc"'), null);
const salvaged7 = salvageTruncatedBuildJson('{"intent":"build","board":"full","parts":[{"ref":"V1","type":"vcc"},{"ref":"G1","type":"gnd"},{"ref":"U1","type":"ic7400"}],"connections":[["V1.1","+"],["G1.1","-"],["U1.1A"');
assert.ok(salvaged7 && salvaged7._salvaged === true && salvaged7.more === true);
assert.equal(salvaged7.parts.length, 3);
assert.equal(salvaged7.connections.length, 2);

// 16c. Per-model transient TPM wait retries 120b instead of demoting to qwen/20b
let tpmTries = 0;
const tpmHoldFetch = async (_url, opts) => {
  tpmTries++;
  const b = JSON.parse(opts.body);
  assert.equal(b.model, 'openai/gpt-oss-120b', 'Transient TPM must wait & retry 120b instead of dropping to weaker model');
  if (tpmTries === 1) {
    return {
      ok: false,
      status: 429,
      json: async () => ({ error: { message: 'Rate limit reached on tokens per minute (TPM): Limit 8000, Used 7000, Requested 3000. Please try again in 200ms.' } }),
    };
  }
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"intent":"analyze","reply":"Held 120b"}' } }] }) };
};
const heldRes = await callGroq({
  apiKey: 'gsk_tpmtest',
  model: 'openai/gpt-oss-120b',
  messages: [{ role: 'user', content: 'hi' }],
  availableModels: [{ id: 'openai/gpt-oss-120b' }, { id: 'qwen/qwen3.8-27b' }, { id: 'openai/gpt-oss-20b' }],
  fetchFn: tpmHoldFetch,
});
assert.equal(heldRes.modelUsed, 'openai/gpt-oss-120b');
assert.equal(heldRes.parsed.reply, 'Held 120b');

// 16d + 16e. End-to-end 7 NAND chips (U1..U7) + 10 LEDs built cleanly via automatic 2-stage flow & autoPower (NO manual phase 2!)
const stage1Parts = [
  { ref: 'V1', type: 'vcc' }, { ref: 'G1', type: 'gnd' }, { ref: 'CLK', type: 'clock', props: { freq: 2 } },
  ...Array.from({ length: 7 }, (_, i) => ({ ref: `U${i + 1}`, type: 'ic7400' })),
];
const stage1Conns = [['V1.1', '+'], ['G1.1', '-'], ['CLK.OUT', 'U1.1A'], ['CLK.OUT', 'U1.1B']];
for (let i = 1; i <= 7; i++) {
  if (i > 1) stage1Conns.push([`U${i - 1}.1Y`, `U${i}.1A`], [`U${i - 1}.1Y`, `U${i}.1B`]);
  stage1Conns.push(['-', `U${i}.2A`, `U${i}.2B`, `U${i}.3A`, `U${i}.3B`, `U${i}.4A`, `U${i}.4B`]);
}
const stage2Parts = [];
const stage2Conns = [];
for (let j = 1; j <= 10; j++) {
  stage2Parts.push({ ref: `R${j}`, type: 'resistor', props: { ohms: 220 } });
  stage2Parts.push({ ref: `D${j}`, type: 'led' });
  const drvIc = ((j - 1) % 7) + 1;
  stage2Conns.push([`U${drvIc}.1Y`, `R${j}.1`], [`R${j}.2`, `D${j}.A`], [`D${j}.K`, '-']);
}
const origFetch16 = globalThis.fetch;
let multiCalls = 0;
globalThis.fetch = async () => {
  multiCalls++;
  if (multiCalls === 1) {
    return { ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ intent: 'build', plan: 'Stage 1: 7-chip NAND chain', reply: 'Placed 7 NAND chips.', more: true, clearExisting: true, board: 'full', parts: stage1Parts, connections: stage1Conns }) } }] }) };
  }
  return { ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ intent: 'build', reply: 'Finished wiring 10 LEDs across the 7 NAND stages.', more: false, clearExisting: false, parts: stage2Parts, connections: stage2Conns }) } }] }) };
};
try {
  const app16 = createHeadlessApp();
  app16.settings = { get: (k) => (k === 'groqKey' ? 'gsk_mock' : k === 'aiModel' ? 'openai/gpt-oss-120b' : 'auto'), set: () => {} };
  const cop16 = new AiCopilot(app16);
  cop16.hasServerKey = true;
  const r16 = await cop16.ask('build the most complex circuit you can build with 7 nand chips and 10 leds', 'build');
  assert.equal(multiCalls, 2, 'Auto multi-stage loop must fetch Stage 2 automatically without asking user');
  assert.equal(r16.meta?.build?.ok, true, '7 NAND chips + 10 LEDs must verify cleanly: ' + JSON.stringify(r16.meta?.build?.errors));
  assert.equal(app16.circuit.parts.filter(p => p.type === 'ic7400').length, 7);
  assert.equal(app16.circuit.parts.filter(p => p.type === 'led').length, 10);
  // Check autoPower + 7 ICs cleanly powered (0 simulation errors)
  assert.equal(app16.allIssues().filter(i => i.level === 'error').length, 0);
} finally {
  globalThis.fetch = origFetch16;
}
// 16f. Verify undersized NAND/LED count is caught by verifyPromptConstraints
const underRes = applyAiBuildPlan(app, {
  clearExisting: true,
  parts: [{ ref: 'V1', type: 'vcc' }, { ref: 'G1', type: 'gnd' }, { ref: 'CLK', type: 'clock' }, { ref: 'U1', type: 'ic7400' }, { ref: 'R1', type: 'resistor', props: { ohms: 220 } }, { ref: 'D1', type: 'led' }],
  connections: [['V1.1', '+'], ['G1.1', '-'], ['CLK.OUT', 'U1.1A'], ['CLK.OUT', 'U1.1B'], ['U1.1Y', 'R1.1'], ['R1.2', 'D1.A'], ['D1.K', '-'], ['-', 'U1.2A', 'U1.2B', 'U1.3A', 'U1.3B', 'U1.4A', 'U1.4B']],
}, { prompt: 'build with 7 nand chips and 10 leds' });
assert.equal(underRes.ok, false, 'Must reject circuit missing requested 7 NAND chips and 10 LEDs');
assert.match(underRes.errors.join(' '), /7 NAND chips/);

// 16g. Singleton power/clock/DIP ref typo fallback (VCC1 -> unique V1 vcc)
const aliasRes = applyAiBuildPlan(app, {
  clearExisting: true,
  parts: [{ ref: 'V1', type: 'vcc' }, { ref: 'G1', type: 'gnd' }, { ref: 'R1', type: 'resistor', props: { ohms: 220 } }, { ref: 'D1', type: 'led' }],
  connections: [['VCC1.+5V', '+'], ['GND1.GND', '-'], ['+', 'R1.1'], ['R1.2', 'D1.A'], ['D1.K', '-']],
});
assert.equal(aliasRes.ok, true, 'Singleton power ref typo VCC1/GND1 must resolve cleanly: ' + JSON.stringify(aliasRes.errors));
console.log('   [PASS] Compact prompt, JSON salvage, TPM wait hold, autoPower & 7-NAND+10-LED multi-stage tests passed.');

console.log('17. Testing Multi-Provider Gemini + Groq Routing, 503 Recovery, Mixed Key Isolation & Proxy Check...');
assert.equal(detectKeyProvider('AQ.Ab8TestToken'), 'gemini');
assert.equal(detectKeyProvider('AIzaSyTestKey123'), 'gemini');
assert.equal(detectKeyProvider('gsk_TestGroqKey123'), 'groq');
assert.equal(isGeminiModel('models/gemini-3.5-flash-lite'), true);
assert.equal(isGeminiModel('openai/gpt-oss-120b'), false);

// 17a. Gemini models/ prefix stripped, TTS/image/robotics filtered, 3.5-flash-lite prioritized
const sortedGem = filterAndSortModels([
  { id: 'models/gemini-2.5-flash-preview-tts' },
  { id: 'models/gemini-3.1-flash-image' },
  { id: 'models/gemini-2.5-flash-lite' },
  { id: 'models/gemini-3.5-flash-lite' },
  { id: 'models/gemini-robotics-er-2-preview' },
]);
assert.deepEqual(sortedGem.map(m => m.id), ['gemini-3.5-flash-lite', 'gemini-2.5-flash-lite']);

// 17b. fetchModels merges mixed Gemini + Groq keys against exact provider endpoints
const mixedFetches = [];
const mixedFetchFn = async (url, opts) => {
  mixedFetches.push({ url, auth: opts?.headers?.Authorization });
  if (String(url).includes('generativelanguage.googleapis.com')) {
    assert.equal(opts.headers.Authorization, 'Bearer AQ.gemTest');
    return { ok: true, status: 200, json: async () => ({ data: [{ id: 'models/gemini-3.5-flash-lite' }, { id: 'models/gemini-2.5-flash-lite' }] }) };
  }
  assert.equal(opts.headers.Authorization, 'Bearer gsk_groqTest');
  return { ok: true, status: 200, json: async () => ({ data: [{ id: 'openai/gpt-oss-120b' }] }) };
};
const mfRes = await fetchModels('AQ.gemTest, gsk_groqTest', mixedFetchFn);
assert.equal(mixedFetches.length, 2);
assert.deepEqual(mfRes.models.map(m => m.id), ['gemini-3.5-flash-lite', 'gemini-2.5-flash-lite', 'openai/gpt-oss-120b']);

// 17c. Gemini 503 high-demand pauses & falls back cleanly to gemini-2.5-flash-lite using 8192 max tokens and matching Gemini key
const gemCalls = [];
const gemFallbackFetch = async (url, opts) => {
  const b = JSON.parse(opts.body);
  gemCalls.push({ url, auth: opts.headers.Authorization, model: b.model, max: b.max_completion_tokens });
  assert.ok(String(url).startsWith('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'));
  assert.equal(opts.headers.Authorization, 'Bearer AQ.gemKeyOnly');
  assert.equal(b.max_completion_tokens, 8192, 'Gemini must use 8192 budget instead of Groq 8k cap');
  if (b.model === 'gemini-3.5-flash-lite') {
    return { ok: false, status: 503, json: async () => ([{ error: { code: 503, message: 'high demand' } }]) };
  }
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"intent":"analyze","reply":"Served via 2.5 Flash Lite"}' } }] }) };
};
const gemFb = await callGroq({
  apiKey: 'AQ.gemKeyOnly, gsk_unusedGroq',
  model: 'gemini-3.5-flash-lite',
  messages: [{ role: 'user', content: 'hi' }],
  availableModels: [{ id: 'gemini-3.5-flash-lite' }, { id: 'gemini-2.5-flash-lite' }],
  fetchFn: gemFallbackFetch,
});
assert.equal(gemFb.modelUsed, 'gemini-2.5-flash-lite');
assert.equal(gemFb.switchedFrom, 'gemini-3.5-flash-lite');
assert.equal(gemFb.parsed.reply, 'Served via 2.5 Flash Lite');
assert.equal(gemCalls.length, 3, '2 tries on 3.5-flash-lite (initial + 503 retry), then fallback to 2.5-flash-lite');
console.log('   [PASS] Multi-provider Gemini + Groq routing, 503 recovery & key isolation passed.');

console.log('\nALL AI COPILOT AUTOMATED TESTS PASSED 100%!');

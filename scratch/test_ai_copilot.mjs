import assert from 'node:assert/strict';
import '../src/parts/library.js';
import '../src/mcu/boards.js';
import { Circuit, Board, Part, Wire } from '../src/model.js';
import { Engine, key } from '../src/sim/engine.js';
import { findProblems } from '../src/editor.js';
import { filterAndSortModels, extractJsonObject, callGroq, splitKeys } from '../src/ai/client.js';
import { buildPartsCatalogPrompt, serializeCircuitState } from '../src/ai/context.js';
import { applyAiBuildPlan, resolvePartType, resolvePinIndex } from '../src/ai/builder.js';
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

console.log('\nALL AI COPILOT AUTOMATED TESTS PASSED 100%!');

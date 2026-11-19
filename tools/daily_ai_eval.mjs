#!/usr/bin/env node
/**
 * Autonomous Daily AI Copilot Eval, Curriculum & Dataset Pipeline.
 * - Executes auto_regression (re-testing past failures until fixed), pinned regressions,
 *   1-call/day LLM curriculum inventions, rotating wild builds, typo mutations, and combinatorial circuits.
 * - Budgeted cleanly by exact HTTP calls (default: 300/day), tokens, and runtime cap,
 *   persisting cursors, auto-regressions, and simulator-verified fine-tune JSONL across days.
 */

import fs from 'node:fs';
import path from 'node:path';
import '../src/parts/library.js';
import '../src/parts/ics.js';
import '../src/mcu/boards.js';
import { Circuit } from '../src/model.js';
import { Engine, key } from '../src/sim/engine.js';
import { findProblems } from '../src/editor.js';
import { fetchModels, isGeminiModel, splitKeys } from '../src/ai/client.js';
import { serializeCircuitState } from '../src/ai/context.js';
import { AiCopilot } from '../src/ai/copilot.js';
import { AiGuide } from '../src/ai/guide.js';
import { getDef } from '../src/parts/registry.js';
import { generateDailyNewIdeas, selectDailyQueue } from './daily_eval_cases.mjs';

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    resetCursors: false,
    maxCalls: +(process.env.MAX_CALLS || 300),
    maxTokens: +(process.env.MAX_TOKENS || 1500000),
    maxMinutes: +(process.env.MAX_MINUTES || 25),
    delayMs: +(process.env.DELAY_MS || 1500),
    outDir: process.env.OUT_DIR || 'eval-logs',
    skipScopes: process.env.SKIP_SCOPES ?? 'oled,esp32,i2c_display',
    model: process.env.AI_MODEL || 'gemini-3.5-flash-lite',
    dateStr: new Date().toISOString().slice(0, 10),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--reset-cursors') opts.resetCursors = true;
    else if (a.startsWith('--max-calls=')) opts.maxCalls = +a.split('=')[1];
    else if (a === '--max-calls') opts.maxCalls = +next();
    else if (a.startsWith('--max-tokens=')) opts.maxTokens = +a.split('=')[1];
    else if (a === '--max-tokens') opts.maxTokens = +next();
    else if (a.startsWith('--max-minutes=')) opts.maxMinutes = +a.split('=')[1];
    else if (a === '--max-minutes') opts.maxMinutes = +next();
    else if (a.startsWith('--delay-ms=')) opts.delayMs = +a.split('=')[1];
    else if (a === '--delay-ms') opts.delayMs = +next();
    else if (a.startsWith('--out-dir=')) opts.outDir = a.split('=')[1];
    else if (a === '--out-dir') opts.outDir = next();
    else if (a.startsWith('--skip-scopes=')) opts.skipScopes = a.split('=')[1];
    else if (a === '--skip-scopes') opts.skipScopes = next();
    else if (a.startsWith('--model=')) opts.model = a.split('=')[1];
    else if (a === '--model') opts.model = next();
  }
  return opts;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function createHeadlessApp({ apiKey, model }) {
  let activeModel = model;
  const app = {
    circuit: new Circuit(),
    engine: new Engine(),
    mode: 'build',
    paused: false,
    checks: [],
    samples: new Map(),
    netKinds: new Map(),
    index: { holes: new Map(), pins: new Map(), ends: new Map() },
    settings: {
      get: (k) => (k === 'geminiKey' ? apiKey : k === 'aiModel' ? activeModel : k === 'aiMode' ? 'build' : true),
      set: (k, v) => { if (k === 'aiModel') activeModel = v; },
    },
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
  app.editor = { selection: new Set(), problems: (parts, boards = []) => findProblems(app, parts, boards) };
  app.aiGuide = new AiGuide(app);
  return app;
}

/** Measure layout collisions and verify live simulator functional behavior against case oracle. */
function evaluateCircuit(app, tc) {
  let ov = 0, dbl = 0;
  for (let i = 0; i < app.circuit.parts.length; i++) {
    const ba = app.circuit.parts[i].bounds();
    for (let j = i + 1; j < app.circuit.parts.length; j++) {
      const bb = app.circuit.parts[j].bounds();
      if (ba.x0 < bb.x1 && ba.x1 > bb.x0 && ba.y0 < bb.y1 && ba.y1 > bb.y0) ov++;
    }
  }
  for (const [, hl] of app.index.holes) {
    if (hl.rail) continue;
    const k = key(hl.x, hl.y);
    if ((app.index.pins.get(k)?.length || 0) + (app.index.ends.get(k)?.length || 0) > 1) dbl++;
  }

  app.setMode('sim');
  const buzRange = new Map();
  let seg7PeakMa = 0;
  let barPeakMa = 0;
  let barActiveSegs = 0;

  const srcHzList = app.circuit.parts
    .filter(p => p.type === 'funcgen' || p.type === 'clock')
    .map(p => +p.props?.hz || +p.props?.frequency || 10);
  const maxSrcHz = srcHzList.length ? Math.max(...srcHzList) : 0;
  const minSrcHz = srcHzList.length ? Math.min(...srcHzList) : 0;
  const hasSlow = app.circuit.parts.some(p => p.type === 'ne555' || p.type === 'uno' || p.type === 'nano' || p.type === 'esp32' || p.type === 'esp32s3' || p.type === 'bluepill')
    || (minSrcHz > 0 && minSrcHz < 15);
  const useAcWindow = maxSrcHz >= 15 && !hasSlow;
  const evalSteps = useAcWindow
    ? Math.min(480, Math.max(96, Math.ceil((8 / Math.max(15, minSrcHz || maxSrcHz)) / Math.max(2e-5, Math.min(0.002, 1 / (20 * maxSrcHz))))))
    : (maxSrcHz >= 15 ? 360 : 120);
  const evalDt = useAcWindow
    ? Math.max(2e-5, Math.min(0.002, 1 / (20 * maxSrcHz)))
    : (maxSrcHz >= 15 ? (1.2 / evalSteps) : 0.01);

  for (let s = 0; s < evalSteps; s++) {
    app.engine.step(evalDt);
    for (const p of app.circuit.parts) {
      const ent = app.engine.byPart.get(p.id);
      if (!ent) continue;
      if (p.type === 'buzzer') {
        const v0 = ent.pinNets?.[0] >= 0 ? app.engine.voltage(ent.pinNets[0]) : NaN;
        const v1 = ent.pinNets?.[1] >= 0 ? app.engine.voltage(ent.pinNets[1]) : NaN;
        if (Number.isFinite(v0) && Number.isFinite(v1)) {
          const dv = v0 - v1;
          const prev = buzRange.get(p.id) || { min: dv, max: dv };
          prev.min = Math.min(prev.min, dv);
          prev.max = Math.max(prev.max, dv);
          buzRange.set(p.id, prev);
        }
      } else if (p.type === 'seg7' && ent.device?.cur) {
        for (const c of ent.device.cur) seg7PeakMa = Math.max(seg7PeakMa, Math.abs(c) * 1000);
      } else if (p.type === 'bargraph' && ent.device?.cur) {
        let active = 0;
        for (const c of ent.device.cur) {
          const ma = Math.abs(c) * 1000;
          barPeakMa = Math.max(barPeakMa, ma);
          if (ma > 0.5) active++;
        }
        barActiveSegs = Math.max(barActiveSegs, active);
      }
    }
  }

  const st = serializeCircuitState(app);
  const partTypes = new Set(app.circuit.parts.map(p => p.type));
  const oracle = tc.oracle || {};
  const silentReasons = [];

  if (oracle.minParts && app.circuit.parts.length < oracle.minParts) {
    silentReasons.push(`too few parts (${app.circuit.parts.length} < ${oracle.minParts})`);
  }
  for (const anyOf of oracle.requireTypes || []) {
    if (!anyOf.some(t => partTypes.has(t))) {
      silentReasons.push(`missing expected type (${anyOf.join('|')})`);
    }
  }

  const mcuErrs = [];
  for (const p of app.circuit.parts) {
    const rt = app.engine.byPart.get(p.id)?.device?.rt;
    if (rt?.error) mcuErrs.push(`${p.id}: ${rt.error}`);
  }
  if (mcuErrs.length) silentReasons.push(`MCU runtime error: ${mcuErrs[0]}`);

  const activeLeds = st.parts.filter(x => x.type === 'led' && (x.led?.st === 'LIT' || x.led?.st === 'BLINKING' || (x.led?.peak_mA || 0) > 0.5));
  const scopeParts = st.parts.filter(x => x.type === 'oscilloscope');

  switch (oracle.check) {
    case 'scope_ac': {
      const hasWave = scopeParts.some(sp => {
        const c1 = typeof sp.readings?.ch1 === 'object' ? sp.readings.ch1.vpp : 0;
        const c2 = typeof sp.readings?.ch2 === 'object' ? sp.readings.ch2.vpp : 0;
        return c1 > 0.1 || c2 > 0.1;
      });
      if (!hasWave) silentReasons.push('oscilloscope captured flat/no AC waveform (vpp <= 0.1V)');
      break;
    }
    case 'buzzer_active': {
      const active = [...buzRange.values()].some(r => Math.max(Math.abs(r.min), Math.abs(r.max), r.max - r.min) > 0.25);
      if (!active) silentReasons.push('buzzer stayed silent / unconnected (dV <= 0.25V)');
      break;
    }
    case 'led_active': {
      if (activeLeds.length < 1) silentReasons.push('0 LEDs lit or toggled across circuit');
      break;
    }
    case 'led_multi': {
      const need = oracle.minActiveLeds || 2;
      if (activeLeds.length < need) silentReasons.push(`only ${activeLeds.length}/${need} LEDs active`);
      break;
    }
    case 'seg7_active': {
      if (seg7PeakMa < 0.5) silentReasons.push(`7-segment display inactive (peak ${seg7PeakMa.toFixed(1)}mA)`);
      break;
    }
    case 'bargraph_active': {
      if (barPeakMa < 0.5 || barActiveSegs < 1) silentReasons.push(`bargraph inactive (peak ${barPeakMa.toFixed(1)}mA)`);
      break;
    }
    case 'mcu_run': {
      const mcus = app.circuit.parts.map(p => app.engine.byPart.get(p.id)?.device?.rt).filter(Boolean);
      if (!mcus.length || mcus.every(rt => (rt.modes?.size || 0) === 0 && !rt.serial?.length)) {
        silentReasons.push('MCU sketch configured 0 pins and produced no output');
      }
      break;
    }
    case 'dmm_valid': {
      const dmms = st.parts.filter(x => x.type === 'multimeter');
      const good = dmms.some(d => d.readings && !d.readings.liveBlocked && d.readings.display && !/^(----|-+ |OL$)/.test(d.readings.display));
      if (!good) silentReasons.push('multimeter produced no valid finite reading (---- / OL / LIVE V!)');
      break;
    }
    case 'built_clean':
      break;
  }

  return {
    ov,
    dbl,
    silentReasons,
    telemetry: {
      parts: app.circuit.parts.length,
      wires: app.circuit.wires.length,
      boards: app.circuit.boards.length,
      types: app.circuit.parts.map(p => p.type),
      activeLeds: activeLeds.length,
      totalLeds: st.parts.filter(x => x.type === 'led').length,
      buzzerRanges: [...buzRange.values()].map(r => `${r.min.toFixed(2)}..${r.max.toFixed(2)}V`),
      scopes: scopeParts.map(sp => sp.readings),
      seg7PeakMa: +seg7PeakMa.toFixed(1),
      barPeakMa: +barPeakMa.toFixed(1),
    },
  };
}

export function normalizeErrorSignature(msg = '') {
  return String(msg || 'Unknown error')
    .replace(/\r?\n.*/s, '')
    .replace(/"[A-Za-z]+\d+"/g, '"<ref>"')
    .replace(/\b([A-Z]{1,3})\d+\b/g, '$1*')
    .replace(/-?\d+(?:\.\d+)?\s*(?:mA|V|Hz|Ω|ohm|ms|s)\b/gi, '<val>')
    .replace(/\b\d+\b/g, '#')
    .trim()
    .slice(0, 140);
}

function readJsonSafe(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function countLinesSafe(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  const txt = fs.readFileSync(filePath, 'utf8');
  return txt ? txt.split('\n').filter(Boolean).length : 0;
}

function loadState(statePath, reset) {
  const empty = {
    cursors: { wild: 0, mutation: 0, combinatorial: 0 },
    history: [],
    signatures: {},
  };
  if (reset) return empty;
  const raw = readJsonSafe(statePath, null);
  if (!raw) return empty;
  return {
    cursors: {
      wild: +(raw?.cursors?.wild || 0),
      mutation: +(raw?.cursors?.mutation || 0),
      combinatorial: +(raw?.cursors?.combinatorial || 0),
    },
    history: Array.isArray(raw?.history) ? raw.history.slice(-60) : [],
    signatures: typeof raw?.signatures === 'object' && raw?.signatures ? raw.signatures : {},
  };
}

function renderDigest({ opts, state, autoReg, newIdeasCount, fineTuneAdded, fineTuneTotal, graduatedToday, records, budget, stopReason }) {
  const counts = { PASS: 0, T1_BUILD_FAIL: 0, T2_SILENT_DEAD: 0, T3_LAYOUT_DEBT: 0, T4_API_INFRA: 0 };
  const byBucket = {};
  const todaySigs = new Map();

  for (const r of records) {
    counts[r.tier] = (counts[r.tier] || 0) + 1;
    const bk = byBucket[r.bucket] || (byBucket[r.bucket] = { total: 0, pass: 0 });
    bk.total++;
    if (r.tier === 'PASS') bk.pass++;
    if (r.tier !== 'PASS' && r.tier !== 'T4_API_INFRA' && r.signature) {
      const entry = todaySigs.get(r.signature) || { sig: r.signature, tier: r.tier, count: 0, sampleId: r.id, samplePrompt: r.prompt };
      entry.count++;
      todaySigs.set(r.signature, entry);
    }
  }

  const total = records.length;
  const nonInfra = total - counts.T4_API_INFRA;
  const passPct = nonInfra ? ((counts.PASS / nonInfra) * 100).toFixed(1) : '0.0';

  const lines = [
    `# CircuitForge Daily AI Eval — ${opts.dateStr}${opts.dryRun ? ' (DRY RUN)' : ''}`,
    '',
    `- **Stop Reason**: ${stopReason}`,
    `- **Model**: \`${opts.model}\` | **Skipped Scopes**: \`${opts.skipScopes || 'none'}\``,
    `- **Cases Executed**: **${total}** | **Clean Pass (excl. infra)**: **${counts.PASS}/${nonInfra} (${passPct}%)**`,
    `- **HTTP Calls Used**: **${budget.httpCalls} / ${opts.maxCalls}** (429: ${budget.api429}, 503: ${budget.api503}, timeouts: ${budget.apiTimeouts})`,
    `- **Tokens Used**: **${budget.totalTokens.toLocaleString()}** (${budget.promptTokens.toLocaleString()} in + ${budget.completionTokens.toLocaleString()} out)`,
    `- **Auto-Regressions Fixed Today**: **${graduatedToday.length}** | **Active Auto-Regressions Remaining**: **${autoReg.active.length}**`,
    `- **New Curriculum Ideas Invented**: **${newIdeasCount}** | **Verified Fine-Tune Rows**: **+${fineTuneAdded} (Total: ${fineTuneTotal})**`,
    `- **Next Cursors**: \`wild=${state.cursors.wild}\`, \`mutation=${state.cursors.mutation}\`, \`combinatorial=${state.cursors.combinatorial}\``,
    '',
    '## Tier Breakdown',
    '| Tier | Count | Meaning |',
    '|---|---:|---|',
    `| PASS | ${counts.PASS} | Built, verified, ov=0 & dbl=0, functional oracle passed |`,
    `| T1_BUILD_FAIL | ${counts.T1_BUILD_FAIL} | Rejected by validator/DRC/LED/pin resolver |`,
    `| T2_SILENT_DEAD | ${counts.T2_SILENT_DEAD} | Built ok=true, but simulator oracle stayed flat/dead/missing |`,
    `| T3_LAYOUT_DEBT | ${counts.T3_LAYOUT_DEBT} | Functionally active, but overlaps (ov>0) or double-pins (dbl>0) |`,
    `| T4_API_INFRA | ${counts.T4_API_INFRA} | Failed strictly due to 429/503/timeout exhaustion |`,
    '',
    '## Bucket Pass Rates',
    '| Bucket | Clean Pass / Attempted | Rate |',
    '|---|---:|---:|',
    ...Object.entries(byBucket).map(([b, s]) => `| ${b} | ${s.pass} / ${s.total} | ${((s.pass / Math.max(1, s.total)) * 100).toFixed(1)}% |`),
    '',
  ];

  if (graduatedToday.length) {
    lines.push('## Auto-Regressions Resolved Today');
    for (const g of graduatedToday) lines.push(`- \`${g.id}\` (${g.signature || 'fixed'})`);
    lines.push('');
  }

  const rankedToday = [...todaySigs.values()].sort((a, b) => b.count - a.count).slice(0, 15);
  lines.push('## Top Actionable Failure Signatures Today');
  if (!rankedToday.length) {
    lines.push('_None — 0 actionable failures today!_');
  } else {
    lines.push('| Hits | Tier | Signature | Example Case |');
    lines.push('|---:|---|---|---|');
    for (const s of rankedToday) {
      lines.push(`| ${s.count} | ${s.tier} | ${s.sig.replace(/\|/g, '/')} | \`${s.sampleId}\`: ${s.samplePrompt.slice(0, 75).replace(/\|/g, '/')}… |`);
    }
  }

  const allTime = Object.entries(state.signatures || {})
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10);
  if (allTime.length) {
    lines.push('', '## Cumulative Top Bugs Across Days (from `state.json`)');
    lines.push('| Total Hits | Tier | Signature | First Seen | Last Seen |');
    lines.push('|---:|---|---|---|---|');
    for (const [sig, info] of allTime) {
      lines.push(`| ${info.count} | ${info.tier} | ${sig.replace(/\|/g, '/')} | ${info.firstSeen} | ${info.lastSeen} |`);
    }
  }

  return lines.join('\n') + '\n';
}

async function run() {
  const opts = parseArgs(process.argv.slice(2));
  const rawKeys = [process.env.GEM_KEY, process.env.AI_API_KEY, process.env.GEMINI_API_KEY].filter(Boolean).join(',');
  const hasKey = splitKeys(rawKeys).length > 0;
  if (!opts.dryRun && !hasKey) {
    console.error('No API key found (set GEM_KEY, GEMINI_API_KEY, or AI_API_KEY), or pass --dry-run.');
    process.exit(1);
  }

  fs.mkdirSync(path.join(opts.outDir, 'runs'), { recursive: true });
  const statePath = path.join(opts.outDir, 'state.json');
  const autoRegPath = path.join(opts.outDir, 'auto_regression.json');
  const ideasPath = path.join(opts.outDir, 'generated_ideas.json');
  const fineTunePath = path.join(opts.outDir, 'verified_finetune.jsonl');

  const state = loadState(statePath, opts.resetCursors);
  const autoReg = opts.resetCursors
    ? { active: [], resolved: [] }
    : readJsonSafe(autoRegPath, { active: [], resolved: [] });
  if (!Array.isArray(autoReg.active)) autoReg.active = [];
  if (!Array.isArray(autoReg.resolved)) autoReg.resolved = [];

  let storedIdeas = readJsonSafe(ideasPath, []);
  if (!Array.isArray(storedIdeas)) storedIdeas = [];

  const budget = {
    httpCalls: 0,
    modelListCalls: 0,
    api429: 0,
    api503: 0,
    apiTimeouts: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    lastStatus: 0,
  };

  let lastCallWasInfra = false;
  let lastValidAssistantText = '';
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const isInference = String(url).includes('chat/completions');
    if (isInference) {
      if (budget.httpCalls >= opts.maxCalls + 8) {
        lastCallWasInfra = true;
        throw new Error(`Hard daily call safety limit reached (${budget.httpCalls}/${opts.maxCalls})`);
      }
      budget.httpCalls++;
    } else {
      budget.modelListCalls++;
    }
    try {
      const res = await origFetch(url, init);
      budget.lastStatus = res.status;
      if (isInference) {
        if (res.status === 429) budget.api429++;
        else if (res.status === 503) budget.api503++;
        else if (res.ok) {
          try {
            const clone = await res.clone().json();
            const msgTxt = clone?.choices?.[0]?.message?.content;
            if (typeof msgTxt === 'string' && msgTxt.trim()) lastValidAssistantText = msgTxt.trim();
            const u = clone?.usage;
            if (u) {
              budget.promptTokens += +(u.prompt_tokens || 0);
              budget.completionTokens += +(u.completion_tokens || 0);
              budget.totalTokens = budget.promptTokens + budget.completionTokens;
            }
          } catch {}
        }
        if (!res.ok) lastCallWasInfra = true;
        else lastCallWasInfra = false;
      }
      return res;
    } catch (err) {
      if (isInference) {
        if (err?.name === 'TimeoutError' || err?.name === 'AbortError' || /timeout|aborted/i.test(String(err?.message))) {
          budget.apiTimeouts++;
        }
        lastCallWasInfra = true;
      }
      throw err;
    }
  };

  let cachedModels = null;
  const skipList = opts.skipScopes.split(',').map(s => s.trim()).filter(Boolean);

  if (!opts.dryRun) {
    if (!isGeminiModel(opts.model)) {
      opts.model = 'gemini-3.5-flash-lite';
    }
    const fm = await fetchModels(rawKeys);
    cachedModels = fm?.models?.length ? fm.models : null;
  }

  // 1-call/day LLM Curriculum Inventor: adds ~12 fresh circuits if budget allows (>= 25 calls)
  let newIdeas = [];
  if (opts.dryRun) {
    newIdeas = [{
      id: `idea_dry_${opts.dateStr.replace(/-/g, '')}`,
      bucket: 'curriculum',
      name: '555 PWM Motor/LED Flasher (Dry Idea)',
      prompt: 'build a 555 pwm led flasher with 1n4148 steering diodes, potentiometer, capacitor and red led',
      scopes: [],
      oracle: { minParts: 6, requireTypes: [['ne555'], ['led']], check: 'led_active' },
      createdAt: opts.dateStr,
    }];
  } else if (opts.maxCalls >= 25) {
    try {
      newIdeas = await generateDailyNewIdeas({
        apiKey: rawKeys,
        model: cachedModels?.[0]?.id || opts.model,
        availableModels: cachedModels,
        existingIdeas: storedIdeas,
        skipScopes: skipList,
        count: 12,
      });
      if (newIdeas.length) {
        storedIdeas = [...storedIdeas, ...newIdeas].slice(-500);
        fs.writeFileSync(ideasPath, JSON.stringify(storedIdeas, null, 2) + '\n', 'utf8');
      }
    } catch (e) {
      console.warn('Curriculum inventor skipped today:', e?.message || e);
    }
  }

  const { queue, sizes } = selectDailyQueue({
    state,
    autoRegressions: autoReg.active,
    newCurriculumIdeas: newIdeas,
    skipScopes: skipList,
    targetPrompts: Math.max(opts.maxCalls, 60),
  });
  console.log(
    `Loaded daily queue: ${queue.length} cases (autoReg=${sizes.autoRegression}, reg=${sizes.regression}, curriculum=${newIdeas.length}, wild=${sizes.wild}, comb=${sizes.combinatorial}, mut=${sizes.mutation}), maxCalls=${opts.maxCalls}, dryRun=${opts.dryRun}`,
  );

  const startMs = Date.now();
  const records = [];
  const graduatedToday = [];
  const fineTuneLines = [];
  let consecutiveInfra = 0;
  let stopReason = 'completed queue';

  for (let qi = 0; qi < queue.length; qi++) {
    if (budget.httpCalls >= opts.maxCalls) { stopReason = `reached daily call cap (${opts.maxCalls})`; break; }
    if (budget.totalTokens >= opts.maxTokens) { stopReason = `reached daily token cap (${opts.maxTokens})`; break; }
    if ((Date.now() - startMs) / 60000 >= opts.maxMinutes) { stopReason = `reached time budget (${opts.maxMinutes}m)`; break; }

    const tc = queue[qi];
    const turns = tc.turns || [tc.prompt];
    const promptLabel = turns.join(' => ');
    const callsBefore = budget.httpCalls;
    const t0 = Date.now();
    lastCallWasInfra = false;
    lastValidAssistantText = '';

    let tier = 'PASS';
    let errs = [];
    let modelUsed = opts.model;
    let evalOut = null;
    let rawReply = '';

    if (opts.dryRun) {
      budget.httpCalls += turns.length;
      budget.promptTokens += 1800 * turns.length;
      budget.completionTokens += 650 * turns.length;
      budget.totalTokens = budget.promptTokens + budget.completionTokens;
      if (tc.bucket === 'auto_regression') {
        tier = 'PASS'; // Simulate fixed bug graduating!
      } else if (tc.id.includes('guitar_fuzz')) {
        tier = 'T2_SILENT_DEAD';
        errs = ['oscilloscope captured flat/no AC waveform (vpp <= 0.1V)'];
      } else if (qi % 23 === 19) {
        tier = 'T1_BUILD_FAIL';
        errs = ['LED "LED1" is reverse-biased (Anode=1.2V < Cathode=4.3V)'];
      } else {
        lastValidAssistantText = JSON.stringify({ intent: 'build', reply: 'Built circuit.', parts: [{ ref: 'V1', type: 'vcc' }], connections: [['V1.1', '+']] });
      }
    } else {
      const app = createHeadlessApp({ apiKey: rawKeys, model: opts.model });
      const cop = new AiCopilot(app);
      if (cachedModels) {
        cop.models = cachedModels;
        if (!cachedModels.some(m => m.id === cop.model)) app.settings.set('aiModel', cachedModels[0].id);
      } else {
        await cop.refreshModels();
      }

      let lastMsg = null;
      let thrown = null;
      for (const turn of turns) {
        try {
          lastMsg = await cop.ask(turn, 'build');
        } catch (e) {
          thrown = e;
          break;
        }
        if (lastMsg && lastMsg.intent === 'build' && !lastMsg.meta?.build?.ok) break;
      }

      modelUsed = lastMsg?.meta?.modelUsed || cop.lastModelUsed || opts.model;
      rawReply = String(lastMsg?.text || '');

      if (thrown) {
        const msgStr = String(thrown?.message || thrown);
        const infraErr = lastCallWasInfra || (thrown?.status >= 400) || /401|402|403|429|500|502|503|504|rate limit|quota|limit|expired|revoked|timeout|high demand|hard daily call/i.test(msgStr);
        tier = infraErr ? 'T4_API_INFRA' : 'T1_BUILD_FAIL';
        errs = [msgStr];
      } else if (!lastMsg?.meta?.build?.ok) {
        const bErrs = lastMsg?.meta?.build?.errors?.length ? lastMsg.meta.build.errors : [rawReply || 'Build failed'];
        const infraErr = lastCallWasInfra && /401|402|403|429|500|502|503|504|rate limit|quota|limit|timeout|high demand/i.test(bErrs.join(' '));
        tier = infraErr ? 'T4_API_INFRA' : 'T1_BUILD_FAIL';
        errs = bErrs;
      } else {
        evalOut = evaluateCircuit(app, tc);
        if (evalOut.silentReasons.length) {
          tier = 'T2_SILENT_DEAD';
          errs = evalOut.silentReasons;
        } else if (evalOut.ov > 0 || evalOut.dbl > 0) {
          tier = 'T3_LAYOUT_DEBT';
          errs = [`Layout debt: ov=${evalOut.ov}, dbl=${evalOut.dbl}`];
        } else {
          tier = 'PASS';
        }
      }
    }

    const callsUsed = budget.httpCalls - callsBefore;
    const elapsedSec = +((Date.now() - t0) / 1000).toFixed(1);
    const sig = errs.length ? normalizeErrorSignature(errs[0]) : '';

    if (tier === 'T4_API_INFRA') {
      consecutiveInfra++;
    } else {
      consecutiveInfra = 0;
      if (tc.bucket === 'wild' || tc.bucket === 'mutation' || tc.bucket === 'combinatorial') {
        state.cursors[tc.bucket] = (state.cursors[tc.bucket] || 0) + 1;
      }
    }

    // Export simulator-verified single-turn builds as training JSONL for free fine-tuning
    if (tier === 'PASS' && turns.length === 1 && lastValidAssistantText && lastValidAssistantText.startsWith('{')) {
      fineTuneLines.push(JSON.stringify({
        messages: [
          { role: 'user', content: turns[0] },
          { role: 'assistant', content: lastValidAssistantText },
        ],
      }));
    }

    // Update auto_regression.json (graduate fixed regressions, promote new distinct failures)
    if (tc.bucket === 'auto_regression' && tier === 'PASS') {
      const idx = autoReg.active.findIndex(x => x.id === tc.id);
      if (idx >= 0) {
        const [item] = autoReg.active.splice(idx, 1);
        const resItem = { id: item.id, signature: item.signature, resolvedAt: opts.dateStr };
        autoReg.resolved.push(resItem);
        graduatedToday.push(resItem);
      }
    } else if (
      (tier === 'T1_BUILD_FAIL' || tier === 'T2_SILENT_DEAD') &&
      tc.bucket !== 'auto_regression' &&
      turns.length === 1 &&
      sig
    ) {
      const sameSigCount = autoReg.active.filter(x => x.signature === sig).length;
      const alreadyTracked = autoReg.active.some(x => x.prompt === turns[0]);
      if (!alreadyTracked && sameSigCount < 2 && autoReg.active.length < 60) {
        autoReg.active.push({
          id: `autoreg_${tc.id}`,
          name: tc.name,
          prompt: turns[0],
          scopes: tc.scopes || [],
          oracle: tc.oracle || {},
          signature: sig,
          tier,
          firstFailed: opts.dateStr,
          lastFailed: opts.dateStr,
        });
      }
    }

    const record = {
      ts: new Date().toISOString(),
      id: tc.id,
      bucket: tc.bucket,
      name: tc.name,
      tier,
      signature: sig,
      callsUsed,
      elapsedSec,
      modelUsed,
      prompt: promptLabel,
      ...(tier !== 'PASS' ? { errors: errs.slice(0, 5), telemetry: evalOut?.telemetry || null, replySnippet: rawReply.slice(0, 220) } : {}),
    };
    records.push(record);
    console.log(`[${qi + 1}/${queue.length}] ${tc.id} (${tc.bucket}) -> ${tier} (${elapsedSec}s, +${callsUsed} calls, total=${budget.httpCalls}/${opts.maxCalls})${sig ? ` | ${sig}` : ''}`);

    if (sig && tier !== 'T4_API_INFRA') {
      const prev = state.signatures[sig] || { tier, count: 0, firstSeen: opts.dateStr, lastSeen: opts.dateStr, sampleId: tc.id };
      prev.count++;
      prev.lastSeen = opts.dateStr;
      prev.tier = tier;
      state.signatures[sig] = prev;
    }

    if (budget.lastStatus === 401 || budget.lastStatus === 402 || budget.lastStatus === 403) {
      stopReason = `auth/billing error (HTTP ${budget.lastStatus}) — stopping immediately`;
      break;
    }
    if (consecutiveInfra >= 2) {
      stopReason = '2 consecutive cases exhausted all models (API quota/infra) — stopping for today';
      break;
    }
    if (/Hard daily call safety limit reached/i.test(errs.join(' '))) {
      stopReason = `reached hard daily call safety cap (${opts.maxCalls})`;
      break;
    }

    if (!opts.dryRun && opts.delayMs > 0 && budget.httpCalls < opts.maxCalls && qi + 1 < queue.length) {
      await sleep(opts.delayMs);
    }
  }

  state.history.push({
    date: opts.dateStr,
    dryRun: opts.dryRun,
    cases: records.length,
    pass: records.filter(r => r.tier === 'PASS').length,
    httpCalls: budget.httpCalls,
    totalTokens: budget.totalTokens,
    graduated: graduatedToday.length,
    stopReason,
  });

  if (fineTuneLines.length) {
    fs.appendFileSync(fineTunePath, fineTuneLines.join('\n') + '\n', 'utf8');
  }
  const fineTuneTotal = countLinesSafe(fineTunePath);

  const runLogPath = path.join(opts.outDir, 'runs', `${opts.dateStr}.jsonl`);
  fs.appendFileSync(runLogPath, records.map(r => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''), 'utf8');
  fs.writeFileSync(autoRegPath, JSON.stringify({ active: autoReg.active, resolved: autoReg.resolved.slice(-200) }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');

  const digestMd = renderDigest({
    opts,
    state,
    autoReg,
    newIdeasCount: newIdeas.length,
    fineTuneAdded: fineTuneLines.length,
    fineTuneTotal,
    graduatedToday,
    records,
    budget,
    stopReason,
  });
  fs.writeFileSync(path.join(opts.outDir, 'DAILY_DIGEST.md'), digestMd, 'utf8');

  console.log(`\nFinished: ${stopReason}. Saved ${records.length} records to ${runLogPath}, +${fineTuneLines.length} fine-tune rows (total=${fineTuneTotal}), ${autoReg.active.length} active auto-regressions.`);
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('daily_ai_eval.mjs')) {
  run().catch((e) => { console.error(e); process.exit(1); });
}

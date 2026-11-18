/**
 * High-level AI Copilot coordinator: manages chat history, model discovery,
 * prompt execution, closed-loop simulator verification retries, and Guide Mode launch.
 */
import { checkServerKey, fetchModels, callGemini, PREFERRED_GEMINI_MODELS, isGeminiModel, salvageTruncatedBuildJson } from './client.js';
import { buildSystemPrompt, serializeCircuitState } from './context.js';
import { applyAiBuildPlan } from './builder.js';
import { createSandbox } from './guide.js';
import { extractGateConstraints } from './logic_verify.js';

export class AiCopilot {
  constructor(app) {
    this.app = app;
    this.messages = []; // UI display messages: { id, role, text, intent, meta, ts }
    this.history = [];  // LLM turn pairs: { role: 'user'|'assistant', content }
    this.models = PREFERRED_GEMINI_MODELS.map(id => ({ id, fallback: true }));
    this.hasServerKey = false;
    this.busy = false;
    this.statusText = '';
    this.onChange = null;
    this.lastModelUsed = null;
  }

  _setStatus(text = '') {
    this.statusText = text;
    try { this.onChange?.(); } catch { /* UI hook */ }
  }

  get apiKey() {
    return (this.app.settings.get('geminiKey') || '').trim();
  }

  get model() {
    const saved = (this.app.settings.get('aiModel') || '').trim();
    return isGeminiModel(saved) ? saved : PREFERRED_GEMINI_MODELS[0];
  }

  get mode() {
    return this.app.settings.get('aiMode') || 'auto';
  }

  get hasAuth() {
    return Boolean(this.apiKey) || this.hasServerKey;
  }

  async init() {
    this.hasServerKey = await checkServerKey();
    await this.refreshModels();
  }

  async refreshModels() {
    if (!this.hasAuth) {
      this.models = PREFERRED_GEMINI_MODELS.map(id => ({ id, fallback: true }));
      return this.models;
    }
    const res = await fetchModels(this.apiKey);
    this.models = res.models;
    if (this.models.length && !this.models.some(m => m.id === this.model)) {
      this.app.settings.set('aiModel', this.models[0].id);
    }
    return this.models;
  }

  clearChat() {
    this.messages = [];
    this.history = [];
    this.app.aiGuide?.stop();
  }

  /** Send a user prompt through Gemini, apply Build or Guide actions if requested, and self-verify. */
  async ask(promptText, modeOverride = null) {
    const prompt = String(promptText || '').trim();
    if (!prompt || this.busy) return null;

    if (!this.hasAuth) {
      this.hasServerKey = await checkServerKey();
      if (!this.hasAuth) {
        throw new Error('Add a free Google AI Studio (Gemini) API key using the 🔑 button above to start.');
      }
    }

    const activeMode = modeOverride || this.mode;
    this.busy = true;
    const userMsg = { id: 'm' + Date.now(), role: 'user', text: prompt, mode: activeMode };
    this.messages.push(userMsg);
    try { this.onChange?.(); } catch { /* UI hook */ }

    try {
      const snapshotObj = serializeCircuitState(this.app);
      const snapshot = JSON.stringify(snapshotObj);
      const recentHistory = snapshot.length > 3500 ? this.history.slice(-2) : this.history.slice(-6);
      const prevUserText = this.messages.slice(0, -1).reverse().find(m => m.role === 'user')?.text || '';
      const verifyPrompt = (prompt.length < 65 && /\b(meant|instead|not oled|not arduino|lit|square|shape|smiley)\b/i.test(prompt) && prevUserText)
        ? `${prevUserText}\n${prompt}`
        : prompt;
      const queryContext = `${prompt} ${recentHistory.map(m => m.content).join(' ')}`;
      const systemPrompt = buildSystemPrompt({ mode: activeMode, query: queryContext, app: this.app });
      const userPayload = `CIRCUIT_STATE:\n${snapshot}\n\nUSER_REQUEST:\n${prompt}`;

      const llmMessages = [
        { role: 'system', content: systemPrompt },
        ...recentHistory,
        { role: 'user', content: userPayload },
      ];

      const waitHook = ({ model, waitMs, reason }) => this._setStatus(`${reason === 'high demand' ? 'High demand' : 'Rate limit'} — retrying ${model} in ${Math.max(1, Math.round(waitMs / 1000))}s…`);
      const isLogicPuzzle = /\b(boolean|k[-\s]?map|karnaugh|minterm|sop|pos|truth\s*table|demorgan)\b/i.test(prompt)
        && !/\b(\d+\s+(?:nand|nor|chips?|ics?|leds?)|phases?|stages?|most\s+complex)\b/i.test(prompt);
      const explicitAction = activeMode === 'build' || activeMode === 'guide';
      const hardwareRequest = /\b(build|make|create|wire|connect|add|remove|delete|fix|repair|update|change|modify|guide|walk|step|555|ne555|led|resistor|capacitor|gate|nand|nor|and|or|xor|adder|mux|decoder|encoder|counter|flip|arduino|uno|nano|esp32|scope|oscilloscope|funcgen|psu|circuit|boolean|truth|lab|pin|breadboard|ic|chip|switch|oled|lcd|display|matrix|name|text)\b/i.test(prompt);
      const initialReasoning = ((explicitAction || hardwareRequest) && !isLogicPuzzle) ? 'low' : null;

      this._setStatus(`Thinking (${this.model.split('/').pop()})…`);
      let res = await callGemini({
        apiKey: this.apiKey,
        model: this.model,
        messages: llmMessages,
        jsonMode: true,
        reasoningEffort: initialReasoning,
        availableModels: this.models,
        onWait: waitHook,
      });

      this.lastModelUsed = res.modelUsed;
      if (res.decommissioned && res.switchedFrom && this.models.some(m => m.id === res.modelUsed)) {
        this.app.settings.set('aiModel', res.modelUsed);
      }

      let selfFixed = false;

      // Recover truncated JSON via partial salvage (if >=2 complete items) OR compact multi-stage retry
      if (res.truncated && (explicitAction || hardwareRequest || res.parsed?.intent === 'build' || res.parsed?.intent === 'guide') && !this._hasBuildOperations(res.parsed)) {
        const salvaged = salvageTruncatedBuildJson(res.rawText);
        if (salvaged && this._hasBuildOperations(salvaged)) {
          res = { ...res, parsed: salvaged };
          selfFixed = true;
        } else {
          this._setStatus('Response hit limit — retrying compact staged build…');
          const compactRetry = await this._tryFollowUp(
            res, llmMessages,
            'Your previous JSON was cut off before finishing! Output MINIFIED SINGLE-LINE STRICT JSON with brief <=12-word "reply" and NO "steps". For large circuits (>10 parts or >18 wires), output ONLY Stage 1 and set "more":true! If >25 discrete LEDs or displaying text, use `uno` + `board-ssd1306` OLED.',
            { reasoningEffort: 'low', onWait: waitHook },
          );
          if (compactRetry) {
            res = compactRetry;
            const crSalvaged = !res.parsed && res.truncated ? salvageTruncatedBuildJson(res.rawText) : null;
            if (crSalvaged && this._hasBuildOperations(crSalvaged)) {
              res = { ...res, parsed: crSalvaged };
              selfFixed = true;
            } else if (compactRetry.parsed && this._hasBuildOperations(compactRetry.parsed)) {
              selfFixed = true;
            }
          }
        }
      }

      if (!res.parsed && res.truncated) {
        const sameModel120b = /^openai\/gpt-oss-120b/i.test(res.modelUsed);
        const msgText = res.partialReply
          ? `${res.partialReply}\n\n*(Response hit the token limit${sameModel120b ? '' : ' — try switching to openai/gpt-oss-120b'} or split into smaller steps.)*`
          : `Circuit generation hit the output token limit on \`${res.modelUsed}\` before finishing. ${sameModel120b ? 'Try asking for a smaller step or using `uno` + `board-ssd1306` OLED for matrices/text.' : 'Switch to `openai/gpt-oss-120b` or break it into smaller steps.'}`;
        const aiMsg = {
          id: 'a' + Date.now(),
          role: 'assistant',
          intent: 'analyze',
          text: msgText,
          meta: { modelUsed: res.modelUsed, switchedFrom: res.switchedFrom, truncated: true },
        };
        this.messages.push(aiMsg);
        return aiMsg;
      }

      let parsed = res.parsed || { intent: 'analyze', reply: res.rawText };
      let effectiveIntent = this._resolveIntent(parsed, activeMode);

      let buildSummary = null;
      let guideSummary = null;

      // Only retry for missing JSON build arrays when the model declared build/guide OR the prompt actually requests hardware work
      const modelDeclaredOps = parsed.intent === 'build' || parsed.intent === 'guide';
      const refuses = /sorry|cannot|can't|comply|clarify|understand|off[- ]topic|non[- ]circuit|assist with electronics|circuitforge ai|not possible|cannot fit/i.test(String(parsed.reply || ''));
      const wantsOps = modelDeclaredOps || (explicitAction && hardwareRequest && !refuses);
      if (wantsOps && !this._hasBuildOperations(parsed)) {
        const retryMode = explicitAction ? activeMode : effectiveIntent;
        this._setStatus('Completing circuit wiring specification…');
        const opsRetry = await this._tryFollowUp(
          res, llmMessages,
          `You chose intent="${retryMode}" but omitted "parts" and "connections" arrays! Output STRICT JSON including "parts" and "connections" arrays (if large, emit Stage 1 with "more":true).`,
          { onWait: waitHook },
        );
        if (opsRetry) {
          res = opsRetry;
          const orSalvaged = !res.parsed && res.truncated ? salvageTruncatedBuildJson(res.rawText) : null;
          if (orSalvaged && this._hasBuildOperations(orSalvaged)) {
            res = { ...res, parsed: orSalvaged };
            parsed = orSalvaged;
            effectiveIntent = this._resolveIntent(parsed, activeMode);
            selfFixed = true;
          } else if (opsRetry.parsed) {
            parsed = opsRetry.parsed;
            effectiveIntent = this._resolveIntent(parsed, activeMode);
            if (this._hasBuildOperations(parsed)) selfFixed = true;
          }
        }
      }

      if (res.truncated && wantsOps && !parsed?.connections?.length && !parsed?.updates?.length && !parsed?.remove?.length && !parsed?.parts?.length) {
        const sameModel120b = /^openai\/gpt-oss-120b/i.test(res.modelUsed);
        const tip = sameModel120b
          ? 'Ask to build one section at a time (or use `uno` + `board-ssd1306` OLED for grids/text).'
          : 'Switch to `openai/gpt-oss-120b` or ask to build one section at a time.';
        const aiMsg = {
          id: 'a' + Date.now(),
          role: 'assistant',
          intent: 'analyze',
          text: `Circuit generation hit the output token limit on \`${res.modelUsed}\` before finishing wiring. ${tip}`,
          meta: { modelUsed: res.modelUsed, switchedFrom: res.switchedFrom, truncated: true, selfFixed: false },
        };
        this.messages.push(aiMsg);
        return aiMsg;
      }

      const MAX_REPAIRS = 2;
      if ((effectiveIntent === 'build' || effectiveIntent === 'guide') && this._hasBuildOperations(parsed)) {
        if (parsed.more || parsed._salvaged) {
          const staged = await this._executeMultiStagePlan({
            res,
            parsed,
            effectiveIntent,
            systemPrompt,
            prompt,
            verifyPrompt,
            onWait: waitHook,
          });
          res = staged.res;
          parsed = staged.parsed;
          if (staged.selfFixed) selfFixed = true;
          if (effectiveIntent === 'build') buildSummary = staged.summary;
          else guideSummary = staged.summary;
        } else if (effectiveIntent === 'build') {
          this._setStatus('Verifying & simulating circuit…');
          buildSummary = applyAiBuildPlan(this.app, parsed, { commit: true, startSim: true, prompt: verifyPrompt, strictHealth: true });
          for (let attempt = 0; attempt < MAX_REPAIRS && !buildSummary.ok && buildSummary.errors?.length; attempt++) {
            this._setStatus(`Auto-fixing circuit (${attempt + 1}/${MAX_REPAIRS})…`);
            const powerHint = buildSummary.errors.some(e => /no power|vcc|gnd/i.test(e))
              ? '\nHint: Breadboard "+"/"-" rails need BOTH a "vcc" part wired to "+" AND a "gnd" part wired to "-".'
              : '';
            const fixPrompt = `Your previous circuit JSON failed CircuitForge verification:\nErrors:\n- ${buildSummary.errors.join('\n- ')}${powerHint}\n\nFix ONLY these problems. Since the board wasn't changed yet, output COMPLETE MINIFIED STRICT JSON including BOTH all "parts" and matching "connections" using EXACT declared refs and pin names. If large, split using "more":true for Stage 1.`;
            const retry = await this._tryFollowUp(res, llmMessages, fixPrompt, { onWait: waitHook });
            if (!retry) break;
            res = retry;
            const nextParsed = retry.parsed || (retry.truncated ? salvageTruncatedBuildJson(retry.rawText) : null);
            if (!nextParsed) continue;
            parsed = nextParsed;
            if (parsed.more || parsed._salvaged) {
              const staged = await this._executeMultiStagePlan({ res, parsed, effectiveIntent, systemPrompt, prompt, verifyPrompt, onWait: waitHook });
              res = staged.res;
              parsed = staged.parsed;
              buildSummary = staged.summary;
              selfFixed = true;
              break;
            }
            buildSummary = applyAiBuildPlan(this.app, parsed, { commit: true, startSim: true, prompt: verifyPrompt, strictHealth: true });
            if (buildSummary.ok) selfFixed = true;
          }
        } else {
          this._setStatus('Verifying guided steps…');
          const title = parsed.title || prompt.slice(0, 48);
          guideSummary = this.app.aiGuide.start(parsed, title, { prompt: verifyPrompt, strictHealth: true });
          for (let attempt = 0; attempt < MAX_REPAIRS && !guideSummary.ok && guideSummary.errors?.length; attempt++) {
            this._setStatus(`Auto-fixing guided steps (${attempt + 1}/${MAX_REPAIRS})…`);
            const fixPrompt = `Your previous guided circuit JSON failed verification:\nErrors:\n- ${guideSummary.errors.join('\n- ')}\n\nFix ONLY these problems using EXACT pin names from the schemas and output MINIFIED STRICT JSON.`;
            const retry = await this._tryFollowUp(res, llmMessages, fixPrompt, { onWait: waitHook });
            if (!retry) break;
            res = retry;
            if (!retry.parsed) continue;
            parsed = retry.parsed;
            guideSummary = this.app.aiGuide.start(parsed, title, { prompt: verifyPrompt, strictHealth: true });
            if (guideSummary.ok) selfFixed = true;
          }
        }
      }

      const failedAction = (buildSummary && !buildSummary.ok) || (guideSummary && !guideSummary.ok);
      if (failedAction) {
        const errs = (buildSummary?.errors || guideSummary?.errors || []).slice(0, 2).join('; ');
        parsed = { ...parsed, reply: `I couldn't produce a circuit that passes verification (${errs}). Nothing on your board was changed. Try rephrasing or breaking it into smaller steps, or pick a different model.` };
      }

      const safeReply = String(parsed.reply || '').trim()
        || (buildSummary?.ok ? (parsed.plan || 'Updated the circuit.') : guideSummary?.ok ? (parsed.plan || 'Started guided steps.') : (parsed.plan || (res.parsed ? 'Completed.' : res.rawText)));

      // Persist compact conversation context (including what edits/guides were applied so follow-ups know)
      const actionNote = buildSummary?.ok
        ? ` [Canvas update: +${buildSummary.partsAdded} parts, +${buildSummary.wiresAdded} wires, -${buildSummary.wiresRemoved || 0} wires, ${buildSummary.updatedCount || 0} updates]`
        : guideSummary?.ok
          ? ` [Started Guide: ${guideSummary.stepCount} steps]`
          : '';
      if (!failedAction) {
        this.history.push({ role: 'user', content: prompt.slice(0, 600) });
        this.history.push({ role: 'assistant', content: `${safeReply.slice(0, 450)}${actionNote}` });
      }

      const aiMsg = {
        id: 'a' + Date.now(),
        role: 'assistant',
        intent: effectiveIntent,
        text: safeReply,
        meta: {
          modelUsed: res.modelUsed,
          switchedFrom: res.switchedFrom,
          selfFixed,
          build: buildSummary,
          guide: guideSummary,
        },
      };
      this.messages.push(aiMsg);
      return aiMsg;
    } finally {
      this.busy = false;
      this.statusText = '';
    }
  }

  _formatStageDelta(sbx, refMap, prompt, stage) {
    const rev = new Map();
    for (const [k, part] of refMap) {
      if (part?.id && !rev.has(part.id) && k !== part.id) rev.set(part.id, k);
    }
    const { minNandChips, minLeds } = extractGateConstraints(prompt);
    const haveNand = sbx.circuit.parts.filter(p => /^ic74(00|10|20|30)$/.test(p.type)).length;
    const haveLed = sbx.circuit.parts.filter(p => p.type === 'led').length;
    const missingNotes = [];
    if (minNandChips && haveNand < minNandChips) missingNotes.push(`add remaining ${minNandChips - haveNand} ic7400 (have ${haveNand}/${minNandChips})`);
    if (minLeds && haveLed < minLeds) missingNotes.push(`add remaining ${minLeds - haveLed} LEDs + 220Ω resistors (have ${haveLed}/${minLeds})`);

    const partLines = sbx.circuit.parts.map((p) => {
      const ref = rev.get(p.id) || p.id;
      const open = [];
      for (const wp of p.worldPins()) {
        if (/^(VCC|VDD|GND|VSS|NC)$/i.test(wp.name)) continue;
        const n = sbx.engine.netAt(wp.x, wp.y);
        if (n < 0 || !sbx.engine.isNetConnected(n)) open.push(wp.name);
      }
      return open.length ? `${ref}(${p.type})[open:${open.slice(0, 10).join(',')}${open.length > 10 ? ',…' : ''}]` : `${ref}(${p.type})`;
    });
    const tail = stage >= 4
      ? `FINAL STAGE ${stage + 1}: Add any missing parts, finish ALL remaining open pins/LEDs/gates using exact refs above, tie unused IC inputs to "-" or "+", keep "clearExisting":false, and set "more":false.`
      : `Continue Stage ${stage + 1}: output ONLY NEW missing parts + next connections using exact refs above, "clearExisting":false, concise "reply", omit "steps". Set "more":true if >18 wires remain, else set "more":false once ALL requested chips/LEDs are placed & wired and unused IC inputs tied to "-" or "+".`;
    const missingLine = missingNotes.length ? `\nMISSING GOAL PARTS: ${missingNotes.join('; ')}!` : '';
    return `GOAL: ${prompt.slice(0, 260)}${missingLine}\nSTAGED_PARTS (${sbx.circuit.parts.length} parts, ${sbx.circuit.wires.length} wires): ${partLines.join('; ')}\n${tail}`;
  }

  async _executeMultiStagePlan({ res: initRes, parsed: initParsed, effectiveIntent, systemPrompt, prompt, verifyPrompt, onWait }) {
    const MAX_STAGES = 5;
    const sbx = createSandbox(this.app);
    const startedFresh = initParsed.clearExisting !== false && Array.isArray(initParsed.parts) && initParsed.parts.length > 0;
    if (!startedFresh) {
      sbx.load(JSON.stringify(this.app.circuit));
    }

    const initialSummary = String(initParsed.plan || initParsed.reply || '').trim();
    let bestReply = String(initParsed.reply || '').trim();
    let curRes = initRes;
    let curPlan = initParsed;
    let stageRefMap = new Map();
    let selfFixed = Boolean(initParsed._salvaged);
    const agg = {
      ok: true,
      boardSize: initParsed.board || 'full',
      placedParts: [],
      wireSpecs: [],
      removedWires: [],
      updatedSpecs: [],
      aiSteps: [],
      warnings: [],
      partsAdded: 0,
      wiresAdded: 0,
      wiresRemoved: 0,
      updatedCount: 0,
    };

    const mergeStage = (sr, planObj) => {
      stageRefMap = sr.refMap || stageRefMap;
      agg.boardSize = sr.boardSize || agg.boardSize;
      agg.placedParts.push(...(sr.placedParts || []));
      agg.wireSpecs.push(...(sr.wireSpecs || []));
      agg.removedWires.push(...(sr.removedWires || []));
      agg.updatedSpecs.push(...(sr.updatedSpecs || []));
      if (Array.isArray(planObj?.steps)) agg.aiSteps.push(...planObj.steps);
      const rTxt = String(planObj?.reply || '').trim();
      if (rTxt && !/^(adding|power|initial|removed|fixed|stage \d+)/i.test(rTxt)) bestReply = rTxt;
      agg.warnings = [...new Set([...agg.warnings, ...(sr.warnings || [])])];
      agg.partsAdded += sr.partsAdded || 0;
      agg.wiresAdded += sr.wiresAdded || 0;
      agg.wiresRemoved += sr.wiresRemoved || 0;
      agg.updatedCount += sr.updatedCount || 0;
    };

    for (let stage = 1; stage <= MAX_STAGES; stage++) {
      if (stage >= 2) curPlan = { ...curPlan, clearExisting: false };
      let stageMore = Boolean(curPlan.more) && stage < MAX_STAGES;
      this._setStatus(`Building stage ${stage}${agg.partsAdded ? ` (${agg.partsAdded} parts, ${agg.wiresAdded} wires)` : ''}…`);

      let stageRes = applyAiBuildPlan(sbx, curPlan, {
        commit: false,
        startSim: false,
        prompt: verifyPrompt,
        allowIncomplete: stageMore,
        strictHealth: !stageMore,
        initialRefMap: stageRefMap,
      });

      for (let rep = 0; rep < 2 && !stageRes.ok && stageRes.errors?.length; rep++) {
        this._setStatus(`Auto-fixing stage ${stage} (${rep + 1}/2)…`);
        const deltaSummary = this._formatStageDelta(sbx, stageRefMap, prompt, stage - 1);
        const errList = stageRes.errors.join('\n- ');
        const emptyBoardNote = sbx.circuit.parts.length === 0
          ? ' Note: board is currently empty (0 parts) — include ALL referenced parts in "parts" AND matching "connections" (for <=20 wires, finish completely with "more":false; otherwise put ALL parts in Stage 1!).'
          : ` Keep "clearExisting":false${stageMore ? ' (set "more":false once complete)' : ' and "more":false'}.`;
        const fixMsgs = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: deltaSummary },
          ...(curRes.rawText ? [{ role: 'assistant', content: String(curRes.rawText).slice(0, 2200) }] : []),
          { role: 'user', content: `Stage ${stage} failed verification:\n- ${errList}\n\nFix ONLY these issues using exact declared refs and pin names.${emptyBoardNote} Output MINIFIED STRICT JSON.` },
        ];
        const fixRes = await callGemini({
          apiKey: this.apiKey,
          model: curRes.modelUsed,
          messages: fixMsgs,
          jsonMode: true,
          reasoningEffort: 'low',
          availableModels: this.models,
          onWait,
        });
        curRes = fixRes;
        const fixParsed = fixRes.parsed || (fixRes.truncated ? salvageTruncatedBuildJson(fixRes.rawText) : null);
        if (!fixParsed) continue;
        curPlan = stage >= 2 ? { ...fixParsed, clearExisting: false } : fixParsed;
        stageMore = Boolean(curPlan.more) && stage < MAX_STAGES;
        stageRes = applyAiBuildPlan(sbx, curPlan, {
          commit: false,
          startSim: false,
          prompt: verifyPrompt,
          allowIncomplete: stageMore,
          strictHealth: !stageMore,
          initialRefMap: stageRefMap,
        });
        if (stageRes.ok) selfFixed = true;
      }

      if (!stageRes.ok) {
        return { res: curRes, parsed: curPlan, summary: stageRes, selfFixed };
      }

      mergeStage(stageRes, curPlan);
      const madeNoChanges = stage >= 2 && (stageRes.partsAdded || 0) === 0 && (stageRes.wiresAdded || 0) === 0 && (stageRes.wiresRemoved || 0) === 0 && (stageRes.updatedCount || 0) === 0;
      if (!stageMore) {
        break;
      }
      if (madeNoChanges && stage >= 3) {
        curPlan = { ...curPlan, more: false };
        stageRes = applyAiBuildPlan(sbx, { clearExisting: false, parts: [], connections: [], more: false }, { commit: false, startSim: false, prompt: verifyPrompt, allowIncomplete: false, strictHealth: true, initialRefMap: stageRefMap });
        if (stageRes.ok) break;
      }

      // Fetch next stage using ultra-compact delta state (stays comfortably inside 8k TPM)
      const nextMsgs = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: this._formatStageDelta(sbx, stageRefMap, prompt, stage) },
      ];
      let nextRes;
      try {
        nextRes = await callGemini({
          apiKey: this.apiKey,
          model: curRes.modelUsed,
          messages: nextMsgs,
          jsonMode: true,
          reasoningEffort: 'low',
          availableModels: this.models,
          onWait,
        });
      } catch (err) {
        return { res: curRes, parsed: curPlan, summary: { ok: false, errors: [err?.message || String(err)] }, selfFixed };
      }
      curRes = nextRes;
      let nextParsed = nextRes.parsed || (nextRes.truncated ? salvageTruncatedBuildJson(nextRes.rawText) : null);
      if (!nextParsed) {
        return { res: curRes, parsed: curPlan, summary: { ok: false, errors: [`Stage ${stage + 1} hit output limit before producing valid JSON.`] }, selfFixed };
      }
      if (!this._hasBuildOperations(nextParsed)) {
        curPlan = { ...nextParsed, clearExisting: false, parts: [], connections: [], more: false };
      } else {
        curPlan = nextParsed;
      }
    }

    const finalReply = (bestReply && bestReply.length >= 20 && !/^(adding|power|initial|removed|fixed|stage \d+)/i.test(bestReply))
      ? bestReply
      : (initialSummary || `Built verified circuit (${agg.partsAdded} parts, ${agg.wiresAdded} wires).`);
    curPlan = { ...curPlan, reply: finalReply, plan: initialSummary || curPlan.plan };
    if (initRes.modelUsed && curRes.modelUsed && curRes.modelUsed !== initRes.modelUsed && !curRes.switchedFrom) {
      curRes = { ...curRes, switchedFrom: initRes.modelUsed };
    }

    if (effectiveIntent === 'build') {
      this._setStatus('Finalizing & starting simulation…');
      this.app.load(JSON.stringify(sbx.circuit), true);
      this.app.commit('AI Build');
      if (this.app.circuit.probes.length && this.app.ui?.toggleAnalyzer) this.app.ui.toggleAnalyzer(true);
      if (this.app.mode !== 'sim') this.app.setMode('sim');
      this.app.fit();
      return { res: curRes, parsed: curPlan, summary: agg, selfFixed };
    }

    const title = initParsed.title || prompt.slice(0, 48);
    const gSum = this.app.aiGuide.startFromVerified(agg, title, { clearExisting: startedFresh, aiDescs: agg.aiSteps });
    return { res: curRes, parsed: curPlan, summary: gSum, selfFixed };
  }

  async _tryFollowUp(res, llmMessages, userContent, extraOpts = {}) {
    try {
      return await callGemini({
        apiKey: this.apiKey,
        model: res.modelUsed,
        messages: [
          ...llmMessages,
          { role: 'assistant', content: String(res.rawText || '') },
          { role: 'user', content: userContent },
        ],
        jsonMode: true,
        availableModels: this.models,
        ...extraOpts,
      });
    } catch {
      return null;
    }
  }

  _hasBuildOperations(p) {
    return Boolean(
      (Array.isArray(p?.parts) && p.parts.length > 0) ||
      (Array.isArray(p?.connections) && p.connections.length > 0) ||
      (Array.isArray(p?.removeWires) && p.removeWires.length > 0) ||
      (Array.isArray(p?.updates) && p.updates.length > 0) ||
      (Array.isArray(p?.remove) && p.remove.length > 0)
    );
  }

  _resolveIntent(parsed, activeMode) {
    const raw = String(parsed?.intent || '').toLowerCase();
    const hasOps = this._hasBuildOperations(parsed);
    if ((activeMode === 'build' || activeMode === 'guide') && (hasOps || raw === 'build' || raw === 'guide')) {
      return activeMode;
    }
    if ((raw === 'build' || raw === 'guide') && !hasOps) return 'analyze';
    if (raw === 'build' || raw === 'guide' || raw === 'analyze') return raw;
    return hasOps ? 'build' : 'analyze';
  }
}

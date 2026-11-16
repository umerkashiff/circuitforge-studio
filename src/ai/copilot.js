/**
 * High-level AI Copilot coordinator: manages chat history, model discovery,
 * prompt execution, closed-loop simulator verification retries, and Guide Mode launch.
 */
import { checkServerKey, fetchModels, callGroq, PREFERRED_MODELS } from './client.js';
import { buildSystemPrompt, serializeCircuitState } from './context.js';
import { applyAiBuildPlan } from './builder.js';

export class AiCopilot {
  constructor(app) {
    this.app = app;
    this.messages = []; // UI display messages: { id, role, text, intent, meta, ts }
    this.history = [];  // LLM turn pairs: { role: 'user'|'assistant', content }
    this.models = PREFERRED_MODELS.map(id => ({ id, fallback: true }));
    this.hasServerKey = false;
    this.busy = false;
    this.onChange = null;
    this.lastModelUsed = null;
  }

  get apiKey() {
    return (this.app.settings.get('groqKey') || '').trim();
  }

  get model() {
    return (this.app.settings.get('aiModel') || PREFERRED_MODELS[0]).trim();
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
      this.models = PREFERRED_MODELS.map(id => ({ id, fallback: true }));
      return this.models;
    }
    const res = await fetchModels(this.apiKey);
    this.models = res.models;
    // Keep saved selection if still active; otherwise adopt top preferred active model
    if (res.live && this.models.length && !this.models.some(m => m.id === this.model)) {
      this.app.settings.set('aiModel', this.models[0].id);
    }
    return this.models;
  }

  clearChat() {
    this.messages = [];
    this.history = [];
    this.app.aiGuide?.stop();
  }

  /** Send a user prompt through Groq, apply Build or Guide actions if requested, and self-verify. */
  async ask(promptText, modeOverride = null) {
    const prompt = String(promptText || '').trim();
    if (!prompt || this.busy) return null;

    if (!this.hasAuth) {
      this.hasServerKey = await checkServerKey();
      if (!this.hasAuth) {
        throw new Error('Add your free Groq API key (gsk_...) using the 🔑 button above to start.');
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

      let res = await callGroq({
        apiKey: this.apiKey,
        model: this.model,
        messages: llmMessages,
        jsonMode: true,
        availableModels: this.models,
      });

      this.lastModelUsed = res.modelUsed;
      if (res.decommissioned && res.switchedFrom && this.models.some(m => m.id === res.modelUsed)) {
        this.app.settings.set('aiModel', res.modelUsed);
      }

      let selfFixed = false;
      const explicitAction = activeMode === 'build' || activeMode === 'guide';
      const hardwareRequest = /\b(build|make|create|wire|connect|add|remove|delete|fix|repair|update|change|modify|guide|walk|step|555|ne555|led|resistor|capacitor|gate|nand|nor|and|or|xor|adder|mux|decoder|encoder|counter|flip|arduino|uno|nano|esp32|scope|oscilloscope|funcgen|psu|circuit|boolean|truth|lab|pin|breadboard|ic|chip|switch|oled|lcd|display|matrix|name|text)\b/i.test(prompt);

      // Recover truncated JSON responses first (including truncated rawText where parsed was null!)
      if (res.truncated && (explicitAction || hardwareRequest || res.parsed?.intent === 'build' || res.parsed?.intent === 'guide') && !this._hasBuildOperations(res.parsed)) {
        const compactRetry = await this._tryFollowUp(
          res, llmMessages,
          'Your previous JSON was cut off before finishing! Output MINIFIED SINGLE-LINE STRICT JSON with NO "steps" or empty fields, brief 1-sentence "reply", all "parts", and all "connections". If an array of discrete LEDs/parts (>16 LEDs or text display) would not fit a 63-col breadboard cleanly, use `uno` + `board-ssd1306` OLED (or `wokwi-lcd1602`) instead!',
          { reasoningEffort: 'low' },
        );
        if (compactRetry) {
          res = compactRetry;
          if (compactRetry.parsed && this._hasBuildOperations(compactRetry.parsed)) selfFixed = true;
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
        const opsRetry = await this._tryFollowUp(
          res, llmMessages,
          `You chose intent="${retryMode}" but omitted "parts" and "connections" arrays! Output the complete STRICT JSON including all "parts" and 2-element "connections" arrays (and "steps" if guide).`,
        );
        if (opsRetry) {
          res = opsRetry;
          if (opsRetry.parsed) {
            parsed = opsRetry.parsed;
            effectiveIntent = this._resolveIntent(parsed, activeMode);
            if (this._hasBuildOperations(parsed)) selfFixed = true;
          }
        }
      }

      if (res.truncated && wantsOps && !parsed?.connections?.length && !parsed?.updates?.length && !parsed?.remove?.length) {
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
      if (effectiveIntent === 'build' && this._hasBuildOperations(parsed)) {
        buildSummary = applyAiBuildPlan(this.app, parsed, { commit: true, startSim: true, prompt: verifyPrompt });
        for (let attempt = 0; attempt < MAX_REPAIRS && !buildSummary.ok && buildSummary.errors?.length; attempt++) {
          const powerHint = buildSummary.errors.some(e => /no power|vcc|gnd/i.test(e))
            ? '\nHint: Breadboard "+"/"-" rails need BOTH a "vcc" part wired to "+" AND a "gnd" part wired to "-", and every IC VCC->"+" and GND->"-".'
            : '';
          const fixPrompt = `Your previous circuit JSON failed CircuitForge verification:\nErrors:\n- ${buildSummary.errors.join('\n- ')}${powerHint}\n\nFix ONLY these problems using EXACT pin names from the schemas and output complete STRICT JSON objects (all parts as {"ref","type","props"} + connections).`;
          const retry = await this._tryFollowUp(res, llmMessages, fixPrompt);
          if (!retry) break;
          res = retry;
          if (!retry.parsed) continue;
          parsed = retry.parsed;
          buildSummary = applyAiBuildPlan(this.app, parsed, { commit: true, startSim: true, prompt: verifyPrompt });
          if (buildSummary.ok) selfFixed = true;
        }
      } else if (effectiveIntent === 'guide' && this._hasBuildOperations(parsed)) {
        const title = parsed.title || prompt.slice(0, 48);
        guideSummary = this.app.aiGuide.start(parsed, title, { prompt: verifyPrompt });
        for (let attempt = 0; attempt < MAX_REPAIRS && !guideSummary.ok && guideSummary.errors?.length; attempt++) {
          const fixPrompt = `Your previous guided circuit JSON failed verification:\nErrors:\n- ${guideSummary.errors.join('\n- ')}\n\nFix ONLY these problems using EXACT pin names from the schemas and output complete STRICT JSON objects (parts as {"ref","type","props"}, connections, steps).`;
          const retry = await this._tryFollowUp(res, llmMessages, fixPrompt);
          if (!retry) break;
          res = retry;
          if (!retry.parsed) continue;
          parsed = retry.parsed;
          guideSummary = this.app.aiGuide.start(parsed, title, { prompt: verifyPrompt });
          if (guideSummary.ok) selfFixed = true;
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
    }
  }

  async _tryFollowUp(res, llmMessages, userContent, extraOpts = {}) {
    try {
      return await callGroq({
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

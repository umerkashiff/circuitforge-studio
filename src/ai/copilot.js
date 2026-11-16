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
      const recentHistory = this.history.slice(-6);
      const queryContext = `${prompt} ${recentHistory.map(m => m.content).join(' ')}`;
      const systemPrompt = buildSystemPrompt({ mode: activeMode, query: queryContext, app: this.app });
      const snapshot = JSON.stringify(serializeCircuitState(this.app));
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

      if (!res.parsed && res.truncated) {
        const msgText = res.partialReply
          ? `${res.partialReply}\n\n*(Response hit the token limit — try splitting into smaller steps or switching model.)*`
          : 'Response hit the output token limit before finishing. Try a simpler request or build one section at a time.';
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
      let selfFixed = false;

      // If caller forced build/guide mode (or model declared it) but omitted parts/connections, retry once asking for JSON build arrays
      const explicitAction = activeMode === 'build' || activeMode === 'guide';
      const wantsOps = explicitAction || parsed.intent === 'build' || parsed.intent === 'guide';
      const refuses = /sorry|cannot|can't|comply|clarify|understand/i.test(String(parsed.reply || ''));
      if (wantsOps && !this._hasBuildOperations(parsed) && !(explicitAction && refuses && !this.app.circuit.parts.length)) {
        const opsRetry = await this._tryFollowUp(
          res, llmMessages,
          `You chose intent="${effectiveIntent}" but omitted "parts" and "connections" arrays! Output the complete STRICT JSON including all "parts" and 2-element "connections" arrays (and "steps" if guide).`,
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
        const compactRetry = await this._tryFollowUp(
          res, llmMessages,
          'Your previous JSON was cut off before finishing "connections". Output MINIFIED SINGLE-LINE JSON with NO "steps" or empty fields, brief 1-sentence "reply", all "parts", and all "connections".',
        );
        if (compactRetry) {
          res = compactRetry;
          if (compactRetry.parsed) {
            parsed = compactRetry.parsed;
            effectiveIntent = this._resolveIntent(parsed, activeMode);
            if (compactRetry.parsed.connections?.length) selfFixed = true;
          }
        }
        // Still truncated with 0 connections -> do NOT place unwired parts cleanly
        if (!parsed?.connections?.length && !parsed?.updates?.length && !parsed?.remove?.length) {
          const tip = /^qwen\/qwen3/i.test(res.modelUsed)
            ? 'Switch to `openai/gpt-oss-120b` or ask me to build it in two smaller steps (e.g., switches & ICs first, then outputs).'
            : 'Ask me to build it in two smaller steps (e.g., inputs & ICs first, then outputs & wiring).';
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
      }

      const MAX_REPAIRS = 2;
      if (effectiveIntent === 'build' && this._hasBuildOperations(parsed)) {
        buildSummary = applyAiBuildPlan(this.app, parsed, { commit: true, startSim: true });
        for (let attempt = 0; attempt < MAX_REPAIRS && !buildSummary.ok && buildSummary.errors?.length; attempt++) {
          const powerHint = buildSummary.errors.some(e => /no power|vcc|gnd/i.test(e))
            ? '\nHint: Breadboard "+"/"-" rails need BOTH a "vcc" part wired to "+" AND a "gnd" part wired to "-", and every IC VCC->"+" and GND->"-".'
            : '';
          const fixPrompt = `Your previous circuit JSON failed CircuitForge DRC / simulation verification:\nErrors:\n- ${buildSummary.errors.join('\n- ')}${powerHint}\n\nFix ONLY these problems using EXACT pin names from the schemas and output the complete corrected STRICT JSON (all parts + connections).`;
          const retry = await this._tryFollowUp(res, llmMessages, fixPrompt);
          if (!retry) break;
          res = retry;
          if (!retry.parsed) continue;
          parsed = retry.parsed;
          buildSummary = applyAiBuildPlan(this.app, parsed, { commit: true, startSim: true });
          if (buildSummary.ok) selfFixed = true;
        }
      } else if (effectiveIntent === 'guide' && this._hasBuildOperations(parsed)) {
        const title = parsed.title || prompt.slice(0, 48);
        guideSummary = this.app.aiGuide.start(parsed, title);
        for (let attempt = 0; attempt < MAX_REPAIRS && !guideSummary.ok && guideSummary.errors?.length; attempt++) {
          const fixPrompt = `Your previous guided circuit JSON failed verification:\nErrors:\n- ${guideSummary.errors.join('\n- ')}\n\nFix ONLY these problems using EXACT pin names from the schemas and output the complete corrected STRICT JSON (parts, connections, steps).`;
          const retry = await this._tryFollowUp(res, llmMessages, fixPrompt);
          if (!retry) break;
          res = retry;
          if (!retry.parsed) continue;
          parsed = retry.parsed;
          guideSummary = this.app.aiGuide.start(parsed, title);
          if (guideSummary.ok) selfFixed = true;
        }
      }

      const failedAction = (buildSummary && !buildSummary.ok) || (guideSummary && !guideSummary.ok);
      if (failedAction) {
        const errs = (buildSummary?.errors || guideSummary?.errors || []).slice(0, 2).join('; ');
        parsed = { ...parsed, reply: `I couldn't produce a circuit that passes verification (${errs}). Nothing on your board was changed. Try rephrasing or breaking it into smaller steps, or pick a different model.` };
      }

      // Persist compact conversation context (including what edits/guides were applied so follow-ups know)
      const actionNote = buildSummary?.ok
        ? ` [Canvas update: +${buildSummary.partsAdded} parts, +${buildSummary.wiresAdded} wires, -${buildSummary.wiresRemoved || 0} wires, ${buildSummary.updatedCount || 0} updates]`
        : guideSummary?.ok
          ? ` [Started Guide: ${guideSummary.stepCount} steps]`
          : '';
      if (!failedAction) {
        this.history.push({ role: 'user', content: prompt.slice(0, 600) });
        this.history.push({ role: 'assistant', content: `${String(parsed.reply || res.rawText).slice(0, 450)}${actionNote}` });
      }

      const aiMsg = {
        id: 'a' + Date.now(),
        role: 'assistant',
        intent: effectiveIntent,
        text: parsed.reply || res.rawText,
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

  async _tryFollowUp(res, llmMessages, userContent) {
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
    if (activeMode === 'build' || activeMode === 'guide') return activeMode;
    const raw = String(parsed?.intent || '').toLowerCase();
    const hasOps = this._hasBuildOperations(parsed);
    if ((raw === 'build' || raw === 'guide') && !hasOps) return 'analyze';
    if (raw === 'build' || raw === 'guide' || raw === 'analyze') return raw;
    return hasOps ? 'build' : 'analyze';
  }
}

/**
 * Multi-provider AI client for CircuitForge Copilot (Google Gemini OpenAI-compat + Groq).
 * Supports hybrid authentication (BYOK keys in localStorage or Vercel /api/ai proxy),
 * live model discovery, 503/TPM recovery, truncated JSON salvage, and automatic fallback.
 */

const GROQ_BASE = 'https://api.groq.com/openai/v1';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';

export const PREFERRED_MODELS = [
  'openai/gpt-oss-120b',
  'qwen/qwen3.8-27b',
  'openai/gpt-oss-20b',
];

export const PREFERRED_GEMINI_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-2.5-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-3.8-flash',
  'gemini-3.5-flash',
  'gemini-2.5-flash',
  'gemini-4-hydrogen',
];

const NON_CHAT_RE = /(whisper|orpheus|prompt-guard|safeguard|tts|embed|moderation|rerank|distil-whisper|playai|-image|nano-banana|lyria|transcribe|robotics|computer-use|veo|imagen|aqa)/i;

export function detectKeyProvider(key = '') {
  const k = String(key || '').trim();
  if (/^(AIza|AQ\.)/.test(k)) return 'gemini';
  if (k) return 'groq';
  return '';
}

export function isGeminiModel(id = '') {
  return /^(?:models\/)?(?:gemini|nano-banana)/i.test(String(id || '').trim());
}

export function normalizeModelId(id = '') {
  return String(id || '').trim().replace(/^models\//, '');
}

export function isChatModelId(id) {
  const norm = normalizeModelId(id);
  return norm.length > 0 && !NON_CHAT_RE.test(norm);
}

export function filterAndSortModels(rawList = []) {
  const byId = new Map();
  for (const item of rawList) {
    const rawId = typeof item === 'string' ? item : item?.id;
    const id = normalizeModelId(rawId);
    if (!isChatModelId(id)) continue;
    if (!byId.has(id)) {
      byId.set(id, typeof item === 'object' && item ? { ...item, id } : { id });
    }
  }
  const combinedPref = [...PREFERRED_GEMINI_MODELS, ...PREFERRED_MODELS];
  const rank = (id) => {
    const idx = combinedPref.indexOf(id);
    return idx >= 0 ? idx : combinedPref.length + 100;
  };
  return [...byId.values()].sort((a, b) => {
    const ra = rank(a.id), rb = rank(b.id);
    if (ra !== rb) return ra - rb;
    return a.id.localeCompare(b.id);
  });
}

export async function checkServerKey(fetchFn = fetch) {
  try {
    const res = await fetchFn('/api/ai?check=1', { method: 'GET' });
    if (!res.ok) return false;
    const data = await res.json();
    return Boolean(data && data.hasServerKey);
  } catch {
    return false;
  }
}

const cooldownUntil = new Map();

export function splitKeys(raw = '') {
  return String(raw || '').split(/[\s,;]+/).map(k => k.trim()).filter(Boolean);
}

export async function fetchModels(apiKey = '', fetchFn = fetch) {
  const keys = splitKeys(apiKey);
  const tryKeys = keys.length ? keys : [''];
  const defaultPref = keys.some(k => detectKeyProvider(k) === 'gemini')
    ? PREFERRED_GEMINI_MODELS.slice(0, 3)
    : PREFERRED_MODELS;
  const fallback = defaultPref.map(id => ({ id, owned_by: 'fallback', fallback: true }));
  let lastStatus = 0;
  const collected = [];
  const fetchedProviders = new Set();

  for (const cleanKey of tryKeys) {
    const prov = cleanKey ? detectKeyProvider(cleanKey) : 'proxy';
    if (fetchedProviders.has(prov)) continue;
    try {
      const base = prov === 'gemini' ? GEMINI_BASE : GROQ_BASE;
      const res = cleanKey
        ? await fetchFn(`${base}/models`, { method: 'GET', headers: { Authorization: `Bearer ${cleanKey}` } })
        : await fetchFn('/api/ai?models=1', { method: 'GET' });
      lastStatus = res.status;
      if (!res.ok) continue;
      const payload = await res.json();
      const rawData = payload?.data || payload?.models || [];
      if (Array.isArray(rawData) && rawData.length) {
        collected.push(...rawData);
        fetchedProviders.add(prov);
      }
    } catch { /* try next key */ }
  }

  const sorted = filterAndSortModels(collected);
  return {
    models: sorted.length ? sorted : fallback,
    live: sorted.length > 0,
    status: lastStatus || (sorted.length ? 200 : 0),
  };
}

export function extractJsonObject(text) {
  if (typeof text !== 'string') return null;
  let cleaned = text.trim();
  if (!cleaned) return null;

  // Strip reasoning tags emitted by some models (e.g. <think>...</think>)
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  // Direct parse attempt
  try { return JSON.parse(cleaned); } catch { /* continue */ }

  // Repair rare LLM typo like `"connections",":",` -> `"connections":`
  const repaired = cleaned.replace(/",\s*":",\s*/g, '": ');
  if (repaired !== cleaned) {
    try { return JSON.parse(repaired); } catch { /* continue */ }
    cleaned = repaired;
  }

  // Fenced markdown block extraction
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence && fence[1]) {
    try { return JSON.parse(fence[1].trim()); } catch { /* continue */ }
  }

  // First balanced JSON object scan
  const start = cleaned.indexOf('{');
  if (start >= 0) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(cleaned.slice(start, i + 1)); } catch { break; }
        }
      }
    }
  }
  return null;
}

export function extractPartialReply(text) {
  if (typeof text !== 'string') return '';
  const m = text.match(/"reply"\s*:\s*"((?:\\.|[^"\\])*)/);
  if (!m) return '';
  try { return JSON.parse('"' + m[1] + '"'); } catch { return m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"'); }
}

function collectClosedJsonItems(sliceText, openChar, closeChar) {
  const items = [];
  let inStr = false, esc = false, depth = 0, itemStart = -1;
  for (let i = 0; i < sliceText.length; i++) {
    const ch = sliceText[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (depth === 0) {
      if (ch === ']') break;
      if (ch === openChar) { depth = 1; itemStart = i; }
      continue;
    }
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0 && itemStart >= 0) {
        try { items.push(JSON.parse(sliceText.slice(itemStart, i + 1))); } catch { /* ignore incomplete item */ }
        itemStart = -1;
      }
    }
  }
  return items;
}

function extractClosedArrayField(text, fieldName, openChar, closeChar) {
  const re = new RegExp(`"${fieldName}"\\s*:\\s*\\[`);
  const m = re.exec(text);
  if (!m) return [];
  return collectClosedJsonItems(text.slice(m.index + m[0].length), openChar, closeChar);
}

/** Recover complete parts & connections from truncated build JSON instead of discarding them. */
export function salvageTruncatedBuildJson(text) {
  if (typeof text !== 'string') return null;
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (!cleaned) return null;
  const full = extractJsonObject(cleaned);
  if (full) return full;

  const intentMatch = cleaned.match(/"intent"\s*:\s*"(build|guide|analyze)"/i);
  const intent = intentMatch ? intentMatch[1].toLowerCase() : 'build';
  if (intent === 'analyze') return null;

  const parts = extractClosedArrayField(cleaned, 'parts', '{', '}');
  const connections = extractClosedArrayField(cleaned, 'connections', '[', ']');
  const removeWires = extractClosedArrayField(cleaned, 'removeWires', '[', ']');
  const updates = extractClosedArrayField(cleaned, 'updates', '{', '}');
  if (parts.length < 2 && connections.length < 2 && !(parts.length >= 1 && connections.length >= 1)) {
    return null;
  }

  const readStrField = (key) => {
    const m = cleaned.match(new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`));
    if (!m) return '';
    try { return JSON.parse('"' + m[1] + '"'); } catch { return m[1]; }
  };
  const boardM = cleaned.match(/"board"\s*:\s*"(mini|half|full)"/i);
  const clearFalse = /"clearExisting"\s*:\s*false\b/i.test(cleaned);
  return {
    intent,
    plan: readStrField('plan'),
    reply: readStrField('reply') || extractPartialReply(cleaned),
    more: true,
    clearExisting: !clearFalse,
    board: boardM ? boardM[1].toLowerCase() : 'half',
    parts,
    connections,
    removeWires,
    updates,
    _salvaged: true,
  };
}

function extractErrObj(errPayload) {
  const root = Array.isArray(errPayload) ? errPayload[0] : errPayload;
  return root?.error || root || null;
}

export function isModelDecommissionedError(status, errPayload) {
  if (status !== 400 && status !== 403 && status !== 404 && status !== 422) return false;
  const err = extractErrObj(errPayload);
  const code = String(err?.code || '').toLowerCase();
  const msg = String(err?.message || '').toLowerCase();
  return (
    code.includes('decommissioned') ||
    code.includes('model_not_found') ||
    msg.includes('decommissioned') ||
    msg.includes('does not exist') ||
    msg.includes('model not found') ||
    msg.includes('requires terms') ||
    msg.includes('accept the terms') ||
    msg.includes('not supported') ||
    msg.includes('no longer available')
  );
}

function isResponseFormatError(status, errPayload) {
  if (status !== 400 && status !== 422) return false;
  const err = extractErrObj(errPayload);
  const code = String(err?.code || '').toLowerCase();
  const msg = String(err?.message || '').toLowerCase();
  return (
    code.includes('json_validate_failed') ||
    msg.includes('failed to validate json') ||
    msg.includes('failed to generate json') ||
    msg.includes('failed_generation') ||
    typeof err?.failed_generation === 'string' ||
    msg.includes('response_format') ||
    msg.includes('json_object')
  );
}

function parseRetryDelayMs(errPayload) {
  const err = extractErrObj(errPayload);
  const msg = String(err?.message || '');
  if (/tokens per day|\bTPD\b|\bRPD\b|PerDay|\b\d+\s*(?:h(?:ours?|rs?)?|min(?:utes?)?|m(?![s\w])|m(?=\d))/i.test(msg)) return Infinity;
  const m = msg.match(/(?:try again|retry)\s+in\s+(\d+(?:\.\d+)?)\s*(ms|s)/i);
  if (!m) return 0;
  const ms = m[2].toLowerCase() === 'ms' ? parseFloat(m[1]) : parseFloat(m[1]) * 1000;
  if (!Number.isFinite(ms)) return 0;
  return ms > 12500 ? Infinity : Math.min(12500, Math.ceil(ms) + 300);
}

function parseOtpBudgetRemaining(errPayload) {
  const err = extractErrObj(errPayload);
  const msg = String(err?.message || '');
  const m = msg.match(/on output tokens per minute \(OTPM\):\s*Limit\s*(\d+),\s*Used\s*(\d+)/i);
  if (!m) return null;
  const limit = parseInt(m[1], 10), used = parseInt(m[2], 10);
  return Math.max(0, limit - used - 40);
}

async function sendCompletion({ cleanKey, baseUrl = GROQ_BASE, body, fetchFn }) {
  const url = cleanKey ? `${baseUrl}/chat/completions` : '/api/ai';
  const headers = { 'Content-Type': 'application/json' };
  if (cleanKey) headers.Authorization = `Bearer ${cleanKey}`;
  const res = await fetchFn(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  let payload = null;
  try { payload = await res.json(); } catch { payload = null; }
  return { ok: res.ok, status: res.status, payload };
}

export async function callGroq({
  apiKey = '',
  model = PREFERRED_MODELS[0],
  messages,
  jsonMode = true,
  temperature = 0.2,
  maxTokens = null,
  reasoningEffort = null,
  availableModels = null,
  onWait = null,
  fetchFn = fetch,
}) {
  const parsedKeys = splitKeys(apiKey);
  const keyList = parsedKeys.length ? parsedKeys : [''];
  const proxyMode = keyList[0] === '';
  const hasGeminiKey = keyList.some(k => detectKeyProvider(k) === 'gemini');
  const hasGroqKey = keyList.some(k => detectKeyProvider(k) === 'groq');

  const liveIds = (availableModels || []).filter(m => !m.fallback).map(m => normalizeModelId(typeof m === 'string' ? m : m.id)).filter(isChatModelId);
  const defaultOrder = hasGeminiKey ? [...PREFERRED_GEMINI_MODELS, ...PREFERRED_MODELS] : PREFERRED_MODELS;
  const baseOrder = liveIds.length ? liveIds : defaultOrder;
  const tried = new Set();
  const candidates = [
    ...(model ? [normalizeModelId(model)] : []),
    ...(hasGeminiKey ? PREFERRED_GEMINI_MODELS.filter(id => !liveIds.length || liveIds.includes(id)) : []),
    ...(hasGroqKey || proxyMode ? PREFERRED_MODELS.filter(id => !liveIds.length || liveIds.includes(id)) : []),
    ...baseOrder,
  ].filter(id => {
    if (!id || tried.has(id)) return false;
    tried.add(id);
    if (!proxyMode) {
      const needsGemini = isGeminiModel(id);
      if (needsGemini && !hasGeminiKey && id !== normalizeModelId(model)) return false;
      if (!needsGemini && !hasGroqKey && id !== normalizeModelId(model)) return false;
    }
    return true;
  }).slice(0, 6);

  if (!candidates.length) candidates.push(hasGeminiKey ? PREFERRED_GEMINI_MODELS[0] : PREFERRED_MODELS[0]);

  const totalChars = (messages || []).reduce((acc, m) => acc + String(m?.content || '').length + 24, 0);
  const estInputTokens = Math.ceil(totalChars / 2.2) + 180;
  const groqAdaptiveMax = maxTokens !== null
    ? maxTokens
    : Math.min(3500, Math.max(350, 7700 - estInputTokens));

  let lastErr = null;
  let lastRateLimitErr = null;
  let requestedDecommissioned = false;
  const requestedModel = normalizeModelId(model);
  const now = Date.now();

  const buildBody = (activeModel, modelMax) => {
    const body = { model: activeModel, messages, temperature, max_completion_tokens: modelMax };
    if (/^openai\/gpt-oss-20b/i.test(activeModel)) body.reasoning_effort = 'low';
    else if (reasoningEffort && /^openai\/gpt-oss-/i.test(activeModel)) body.reasoning_effort = reasoningEffort;
    if (jsonMode) body.response_format = { type: 'json_object' };
    return body;
  };

  const makeResult = (activeModel, rawText, parsed, truncated, usage = null, partialReply = '') => ({
    modelUsed: activeModel,
    switchedFrom: activeModel !== requestedModel ? requestedModel : null,
    decommissioned: requestedDecommissioned && activeModel !== requestedModel,
    rawText,
    parsed,
    truncated,
    partialReply,
    usage,
  });

  // Model-first across matching provider keys; wait out transient TPM / 503 blips before downgrading!
  for (let i = 0; i < candidates.length; i++) {
    const activeModel = candidates[i];
    const isGemini = isGeminiModel(activeModel);
    const baseUrl = isGemini ? GEMINI_BASE : GROQ_BASE;
    if (i > 0 && /allam-2-7b/i.test(activeModel) && estInputTokens > 1200) continue;

    const matchingKeys = proxyMode
      ? ['']
      : keyList.filter(k => (isGemini ? detectKeyProvider(k) === 'gemini' : detectKeyProvider(k) === 'groq'));
    if (!matchingKeys.length) continue;

    const uncooledKeys = matchingKeys.filter(k => (cooldownUntil.get(`${k}|${activeModel}`) || 0) <= now);
    const activeKeys = uncooledKeys.length ? uncooledKeys : matchingKeys;
    const defaultModelMax = isGemini
      ? (maxTokens !== null ? maxTokens : 8192)
      : (/^qwen\/qwen3/i.test(activeModel) ? Math.min(groqAdaptiveMax, 920) : groqAdaptiveMax);

    let modelTpmErr = null;
    let modelTpmKey = '';
    let modelTpmWaitMs = Infinity;
    let modelTpmMaxTokens = defaultModelMax;

    for (const cleanKey of activeKeys) {
      let modelMax = defaultModelMax;
      const baseBody = buildBody(activeModel, modelMax);
      let attempt = await sendCompletion({ cleanKey, baseUrl, body: baseBody, fetchFn });

      if (attempt.status === 502 || attempt.status === 503 || attempt.status === 504) {
        try { onWait?.({ model: activeModel, waitMs: 2200, reason: 'high demand' }); } catch { /* ignore */ }
        await new Promise(r => setTimeout(r, 2200));
        attempt = await sendCompletion({ cleanKey, baseUrl, body: baseBody, fetchFn });
      }

      if (!attempt.ok && attempt.status === 400 && baseBody.reasoning_effort !== undefined
        && /reasoning_effort/i.test(String(extractErrObj(attempt.payload)?.message || ''))) {
        const stripped = { ...baseBody };
        delete stripped.reasoning_effort;
        attempt = await sendCompletion({ cleanKey, baseUrl, body: stripped, fetchFn });
      }

      if (!attempt.ok && jsonMode && isResponseFormatError(attempt.status, attempt.payload)) {
        const failedGen = extractErrObj(attempt.payload)?.failed_generation;
        if (typeof failedGen === 'string' && failedGen.trim()) {
          const salvaged = extractJsonObject(failedGen);
          if (salvaged) return makeResult(activeModel, failedGen, salvaged, false);
          if (maxTokens !== null && maxTokens <= 250) {
            return makeResult(activeModel, failedGen, null, true, null, extractPartialReply(failedGen));
          }
        }
        const retryBody = { ...baseBody };
        delete retryBody.response_format;
        attempt = await sendCompletion({ cleanKey, baseUrl, body: retryBody, fetchFn });
      }

      if (attempt.ok) {
        const choice = attempt.payload?.choices?.[0];
        const rawText = String(choice?.message?.content || '');
        const truncated = choice?.finish_reason === 'length';
        const parsed = jsonMode ? extractJsonObject(rawText) : null;
        if (jsonMode && !truncated && !parsed && maxTokens === null) {
          const repairRes = await sendCompletion({
            cleanKey,
            baseUrl,
            body: {
              model: activeModel,
              messages: [...messages, { role: 'assistant', content: rawText.slice(0, 800) }, { role: 'user', content: 'Your previous response had invalid JSON syntax. Output ONLY a single strictly valid JSON object matching the schema.' }],
              temperature,
              max_completion_tokens: modelMax,
              ...(baseBody.reasoning_effort ? { reasoning_effort: baseBody.reasoning_effort } : {}),
            },
            fetchFn,
          });
          if (repairRes.ok) {
            const rc = repairRes.payload?.choices?.[0];
            const rText = String(rc?.message?.content || '');
            const rParsed = extractJsonObject(rText);
            if (rParsed) {
              return makeResult(activeModel, rText, rParsed, rc?.finish_reason === 'length', repairRes.payload?.usage || attempt.payload?.usage || null);
            }
          }
        }
        return makeResult(activeModel, rawText, parsed, truncated, attempt.payload?.usage || null, !parsed && truncated ? extractPartialReply(rawText) : '');
      }

      const errObj = extractErrObj(attempt.payload);
      const msg = errObj?.message || `${isGemini ? 'Gemini' : 'Groq'} HTTP ${attempt.status}`;
      lastErr = new Error(msg);
      lastErr.status = attempt.status;
      lastErr.code = errObj?.code || '';

      if (isModelDecommissionedError(attempt.status, attempt.payload)) {
        if (activeModel === requestedModel) requestedDecommissioned = true;
        modelTpmErr = null;
        break;
      }
      if (attempt.status === 401 || attempt.status === 403) {
        if (cleanKey) cooldownUntil.set(`${cleanKey}|${activeModel}`, now + 15 * 60_000);
        continue;
      }
      if (attempt.status === 429) {
        const otpmAvail = parseOtpBudgetRemaining(attempt.payload);
        if (otpmAvail !== null && otpmAvail >= 450 && otpmAvail < modelMax) {
          modelMax = otpmAvail;
          const shrunkRes = await sendCompletion({ cleanKey, baseUrl, body: { ...baseBody, max_completion_tokens: modelMax }, fetchFn });
          if (shrunkRes.ok) {
            const choice = shrunkRes.payload?.choices?.[0];
            const rawText = String(choice?.message?.content || '');
            const truncated = choice?.finish_reason === 'length';
            return makeResult(activeModel, rawText, jsonMode ? extractJsonObject(rawText) : null, truncated, shrunkRes.payload?.usage || null);
          }
        }

        if (!lastRateLimitErr) lastRateLimitErr = lastErr;
        const d = parseRetryDelayMs(attempt.payload);
        if (d === Infinity) {
          if (cleanKey) cooldownUntil.set(`${cleanKey}|${activeModel}`, now + 15 * 60_000);
        } else if (d < modelTpmWaitMs) {
          modelTpmErr = lastErr;
          modelTpmKey = cleanKey;
          modelTpmWaitMs = d;
          modelTpmMaxTokens = modelMax;
        }
        continue;
      }
      if (attempt.status === 413 || attempt.status === 502 || attempt.status === 503 || attempt.status === 504) continue;
      throw lastErr;
    }

    // Pause-and-retry transient TPM right on this model before falling back
    if (modelTpmErr && modelTpmWaitMs < Infinity) {
      const waitMs = Math.max(1500, Math.min(12500, modelTpmWaitMs || 3000));
      try { onWait?.({ model: activeModel, waitMs }); } catch { /* ignore callback errors */ }
      await new Promise(r => setTimeout(r, waitMs));
      const retryBody = buildBody(activeModel, modelTpmMaxTokens);
      const retryRes = await sendCompletion({ cleanKey: modelTpmKey, baseUrl, body: retryBody, fetchFn });
      if (retryRes.ok) {
        const choice = retryRes.payload?.choices?.[0];
        const rawText = String(choice?.message?.content || '');
        const truncated = choice?.finish_reason === 'length';
        return makeResult(activeModel, rawText, jsonMode ? extractJsonObject(rawText) : null, truncated, retryRes.payload?.usage || null, !truncated ? '' : extractPartialReply(rawText));
      }
      if (retryRes.status === 429) {
        const rErrObj = extractErrObj(retryRes.payload);
        const rMsg = rErrObj?.message || `${isGemini ? 'Gemini' : 'Groq'} HTTP ${retryRes.status}`;
        lastErr = new Error(rMsg);
        lastErr.status = 429;
        lastRateLimitErr = lastErr;
      }
    }
  }

  throw lastRateLimitErr || lastErr || new Error('All candidate AI models failed.');
}

export const callAi = callGroq;

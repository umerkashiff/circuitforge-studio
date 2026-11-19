/**
 * Gemini AI client for CircuitForge Copilot (Google Gemini OpenAI-compat endpoint).
 * Supports hybrid authentication (BYOK keys in localStorage or Vercel /api/ai proxy),
 * live model discovery, 503/rate-limit recovery, truncated JSON salvage, and automatic fallback.
 */

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';

export const PREFERRED_GEMINI_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-2.5-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-3.8-flash',
  'gemini-3.5-flash',
  'gemini-2.5-flash',
  'gemini-4-hydrogen',
];

export const PREFERRED_MODELS = PREFERRED_GEMINI_MODELS;

const NON_CHAT_RE = /(tts|embed|moderation|rerank|-image|nano-banana|lyria|transcribe|robotics|computer-use|veo|imagen|aqa)/i;

export function isGeminiModel(id = '') {
  return /^(?:models\/)?gemini/i.test(String(id || '').trim());
}

export function normalizeModelId(id = '') {
  return String(id || '').trim().replace(/^models\//, '');
}

export function isChatModelId(id) {
  const norm = normalizeModelId(id);
  return norm.length > 0 && isGeminiModel(norm) && !NON_CHAT_RE.test(norm);
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
  const rank = (id) => {
    const idx = PREFERRED_GEMINI_MODELS.indexOf(id);
    return idx >= 0 ? idx : PREFERRED_GEMINI_MODELS.length + 100;
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
  const fallback = PREFERRED_GEMINI_MODELS.slice(0, 3).map(id => ({ id, owned_by: 'fallback', fallback: true }));
  let lastStatus = 0;
  const collected = [];

  for (const cleanKey of tryKeys) {
    try {
      const res = cleanKey
        ? await fetchFn(`${GEMINI_BASE}/models`, { method: 'GET', headers: { Authorization: `Bearer ${cleanKey}` } })
        : await fetchFn('/api/ai?models=1', { method: 'GET' });
      lastStatus = res.status;
      if (!res.ok) continue;
      const payload = await res.json();
      const rawData = payload?.data || payload?.models || [];
      if (Array.isArray(rawData) && rawData.length) {
        collected.push(...rawData);
        break;
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

  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  try { return JSON.parse(cleaned); } catch { /* continue */ }

  const repaired = cleaned.replace(/",\s*":",\s*/g, '": ');
  if (repaired !== cleaned) {
    try { return JSON.parse(repaired); } catch { /* continue */ }
    cleaned = repaired;
  }

  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence && fence[1]) {
    try { return JSON.parse(fence[1].trim()); } catch { /* continue */ }
  }

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
    msg.includes('response_format') ||
    msg.includes('json_object')
  );
}

function isHardQuotaError(errPayload) {
  const err = extractErrObj(errPayload);
  const code = String(err?.code || '').toLowerCase();
  const status = String(err?.status || '').toLowerCase();
  const msg = String(err?.message || '');
  return (
    /exceeded your current quota|billing details|quota exceeded|\bTPD\b|\bRPD\b|PerDay/i.test(msg) ||
    code.includes('insufficient_quota') ||
    status === 'resource_exhausted' && !/(?:try again|retry)\s+in\s+\d+(?:\.\d+)?\s*(ms|s)/i.test(msg)
  );
}

function parseRetryDelayMs(errPayload) {
  if (isHardQuotaError(errPayload)) return Infinity;
  const err = extractErrObj(errPayload);
  const msg = String(err?.message || '');
  if (/tokens per day|\bTPD\b|\bRPD\b|PerDay|\b\d+\s*(?:h(?:ours?|rs?)?|min(?:utes?)?|m(?![s\w])|m(?=\d))/i.test(msg)) return Infinity;
  const m = msg.match(/(?:try again|retry)\s+in\s+(\d+(?:\.\d+)?)\s*(ms|s)/i);
  if (!m) return 0;
  const ms = m[2].toLowerCase() === 'ms' ? parseFloat(m[1]) : parseFloat(m[1]) * 1000;
  if (!Number.isFinite(ms)) return 0;
  return ms > 12500 ? Infinity : Math.min(12500, Math.ceil(ms) + 300);
}

async function sendCompletion({ cleanKey, body, fetchFn, timeoutMs = 45000 }) {
  const url = cleanKey ? `${GEMINI_BASE}/chat/completions` : '/api/ai';
  const headers = { 'Content-Type': 'application/json' };
  if (cleanKey) headers.Authorization = `Bearer ${cleanKey}`;
  const opts = { method: 'POST', headers, body: JSON.stringify(body) };
  if (timeoutMs > 0 && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    opts.signal = AbortSignal.timeout(timeoutMs);
  }
  let res;
  try {
    res = await fetchFn(url, opts);
  } catch (err) {
    return {
      ok: false,
      status: err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 504 : 503,
      payload: { error: { message: err?.message || 'Network request failed' } },
    };
  }
  let payload = null;
  try { payload = await res.json(); } catch { payload = null; }
  return { ok: res.ok, status: res.status, payload };
}

export async function callGemini({
  apiKey = '',
  model = PREFERRED_GEMINI_MODELS[0],
  messages,
  jsonMode = true,
  temperature = 0.2,
  maxTokens = null,
  availableModels = null,
  onWait = null,
  fetchFn = fetch,
}) {
  const parsedKeys = splitKeys(apiKey);
  const keyList = parsedKeys.length ? parsedKeys : [''];

  const liveIds = (availableModels || []).filter(m => !m.fallback).map(m => normalizeModelId(typeof m === 'string' ? m : m.id)).filter(isChatModelId);
  const baseOrder = liveIds.length ? liveIds : PREFERRED_GEMINI_MODELS;
  const tried = new Set();
  const candidates = [
    ...(model && isGeminiModel(model) ? [normalizeModelId(model)] : []),
    ...PREFERRED_GEMINI_MODELS.filter(id => !liveIds.length || liveIds.includes(id)),
    ...baseOrder,
  ].filter(id => {
    if (!id || tried.has(id)) return false;
    tried.add(id);
    return true;
  }).slice(0, 6);

  if (!candidates.length) candidates.push(PREFERRED_GEMINI_MODELS[0]);

  let lastErr = null;
  let lastRateLimitErr = null;
  let requestedDecommissioned = false;
  const requestedModel = normalizeModelId(model);
  const now = Date.now();
  const defaultModelMax = maxTokens !== null ? maxTokens : 8192;

  const buildBody = (activeModel, modelMax) => {
    const body = { model: activeModel, messages, temperature, max_completion_tokens: modelMax };
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

  for (let i = 0; i < candidates.length; i++) {
    const activeModel = candidates[i];
    const uncooledKeys = keyList.filter(k =>
      (cooldownUntil.get(k) || 0) <= now &&
      (cooldownUntil.get(`${k}|${activeModel}`) || 0) <= now
    );
    const activeKeys = uncooledKeys.length ? uncooledKeys : keyList;

    let modelTpmErr = null;
    let modelTpmKey = '';
    let modelTpmWaitMs = Infinity;

    for (const cleanKey of activeKeys) {
      const baseBody = buildBody(activeModel, defaultModelMax);
      let attempt = await sendCompletion({ cleanKey, body: baseBody, fetchFn });

      if (attempt.status === 502 || attempt.status === 503 || attempt.status === 504) {
        try { onWait?.({ model: activeModel, waitMs: 2200, reason: 'high demand' }); } catch { /* ignore */ }
        await new Promise(r => setTimeout(r, 2200));
        attempt = await sendCompletion({ cleanKey, body: baseBody, fetchFn });
      }

      if (!attempt.ok && jsonMode && isResponseFormatError(attempt.status, attempt.payload)) {
        const retryBody = { ...baseBody };
        delete retryBody.response_format;
        attempt = await sendCompletion({ cleanKey, body: retryBody, fetchFn });
      }

      if (attempt.ok) {
        const choice = attempt.payload?.choices?.[0];
        const rawText = String(choice?.message?.content || '');
        const truncated = choice?.finish_reason === 'length';
        const parsed = jsonMode ? extractJsonObject(rawText) : null;
        if (jsonMode && !truncated && !parsed && maxTokens === null) {
          const repairRes = await sendCompletion({
            cleanKey,
            body: {
              model: activeModel,
              messages: [...messages, { role: 'assistant', content: rawText.slice(0, 800) }, { role: 'user', content: 'Your previous response had invalid JSON syntax. Output ONLY a single strictly valid JSON object matching the schema.' }],
              temperature,
              max_completion_tokens: defaultModelMax,
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
      const msg = errObj?.message || `Gemini HTTP ${attempt.status}`;
      lastErr = new Error(msg);
      lastErr.status = attempt.status;
      lastErr.code = errObj?.code || '';

      if (isModelDecommissionedError(attempt.status, attempt.payload)) {
        if (activeModel === requestedModel) requestedDecommissioned = true;
        modelTpmErr = null;
        break;
      }
      if (attempt.status === 401 || attempt.status === 402 || attempt.status === 403) {
        if (cleanKey) cooldownUntil.set(cleanKey, now + 15 * 60_000);
        continue;
      }
      if (attempt.status === 429) {
        if (!lastRateLimitErr) lastRateLimitErr = lastErr;
        const d = parseRetryDelayMs(attempt.payload);
        if (d === Infinity) {
          if (cleanKey) cooldownUntil.set(cleanKey, now + 15 * 60_000);
        } else {
          if (cleanKey && d > 0) cooldownUntil.set(`${cleanKey}|${activeModel}`, now + d);
          if (d < modelTpmWaitMs) {
            modelTpmErr = lastErr;
            modelTpmKey = cleanKey;
            modelTpmWaitMs = d;
          }
        }
        continue;
      }
      if (attempt.status === 413 || attempt.status === 502 || attempt.status === 503 || attempt.status === 504) continue;
      throw lastErr;
    }

    if (modelTpmErr && modelTpmWaitMs < Infinity) {
      const waitMs = Math.max(1500, Math.min(12500, modelTpmWaitMs || 3000));
      try { onWait?.({ model: activeModel, waitMs }); } catch { /* ignore callback errors */ }
      await new Promise(r => setTimeout(r, waitMs));
      const retryBody = buildBody(activeModel, defaultModelMax);
      const retryRes = await sendCompletion({ cleanKey: modelTpmKey, body: retryBody, fetchFn });
      if (retryRes.ok) {
        const choice = retryRes.payload?.choices?.[0];
        const rawText = String(choice?.message?.content || '');
        const truncated = choice?.finish_reason === 'length';
        return makeResult(activeModel, rawText, jsonMode ? extractJsonObject(rawText) : null, truncated, retryRes.payload?.usage || null, !truncated ? '' : extractPartialReply(rawText));
      }
      if (retryRes.status === 429) {
        const rErrObj = extractErrObj(retryRes.payload);
        const rMsg = rErrObj?.message || `Gemini HTTP ${retryRes.status}`;
        lastErr = new Error(rMsg);
        lastErr.status = 429;
        lastRateLimitErr = lastErr;
      }
    }
  }

  throw lastRateLimitErr || lastErr || new Error('All candidate Gemini models failed.');
}

export const callAi = callGemini;

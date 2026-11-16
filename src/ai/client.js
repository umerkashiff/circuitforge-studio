/**
 * Groq API client for CircuitForge AI Copilot.
 * Supports hybrid authentication (personal BYOK key in localStorage or Vercel /api/ai proxy),
 * live model discovery from /openai/v1/models, and automatic fallback if a model is deprecated.
 */

const GROQ_BASE = 'https://api.groq.com/openai/v1';

export const PREFERRED_MODELS = [
  'openai/gpt-oss-120b',
  'qwen/qwen3.8-27b',
  'openai/gpt-oss-20b',
];

const NON_CHAT_RE = /(whisper|orpheus|prompt-guard|safeguard|tts|embed|moderation|rerank|distil-whisper|playai)/i;

export function isChatModelId(id) {
  return typeof id === 'string' && id.trim().length > 0 && !NON_CHAT_RE.test(id);
}

export function filterAndSortModels(rawList = []) {
  const byId = new Map();
  for (const item of rawList) {
    const id = typeof item === 'string' ? item : item?.id;
    if (!isChatModelId(id)) continue;
    if (!byId.has(id)) {
      byId.set(id, typeof item === 'object' && item ? item : { id });
    }
  }
  const rank = (id) => {
    const idx = PREFERRED_MODELS.indexOf(id);
    return idx >= 0 ? idx : PREFERRED_MODELS.length + 100;
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

export async function fetchModels(apiKey = '', fetchFn = fetch) {
  const cleanKey = (apiKey || '').trim();
  const fallback = PREFERRED_MODELS.map(id => ({ id, owned_by: 'fallback', fallback: true }));
  try {
    let res;
    if (cleanKey) {
      res = await fetchFn(`${GROQ_BASE}/models`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${cleanKey}` },
      });
    } else {
      res = await fetchFn('/api/ai?models=1', { method: 'GET' });
    }
    if (!res.ok) return { models: fallback, live: false, status: res.status };
    const payload = await res.json();
    const sorted = filterAndSortModels(payload?.data || []);
    return {
      models: sorted.length ? sorted : fallback,
      live: sorted.length > 0,
      status: res.status,
    };
  } catch {
    return { models: fallback, live: false, status: 0 };
  }
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

export function isModelDecommissionedError(status, errPayload) {
  if (status !== 400 && status !== 403 && status !== 404 && status !== 422) return false;
  const code = String(errPayload?.error?.code || errPayload?.code || '').toLowerCase();
  const msg = String(errPayload?.error?.message || errPayload?.message || '').toLowerCase();
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
  const code = String(errPayload?.error?.code || '').toLowerCase();
  const msg = String(errPayload?.error?.message || '').toLowerCase();
  return (
    code.includes('json_validate_failed') ||
    msg.includes('failed to validate json') ||
    msg.includes('failed to generate json') ||
    msg.includes('failed_generation') ||
    typeof errPayload?.error?.failed_generation === 'string' ||
    msg.includes('response_format') ||
    msg.includes('json_object')
  );
}

function parseRetryDelayMs(errPayload) {
  const msg = String(errPayload?.error?.message || '');
  if (/tokens per day|\bTPD\b|\d+\s*[hm]/i.test(msg)) return Infinity;
  const m = msg.match(/try again in\s+(\d+(?:\.\d+)?)\s*(ms|s)/i);
  if (!m) return 0;
  const ms = m[2].toLowerCase() === 'ms' ? parseFloat(m[1]) : parseFloat(m[1]) * 1000;
  if (!Number.isFinite(ms)) return 0;
  return ms > 12500 ? Infinity : Math.min(12500, Math.ceil(ms) + 300);
}

function parseOtpBudgetRemaining(errPayload) {
  const msg = String(errPayload?.error?.message || '');
  const m = msg.match(/on output tokens per minute \(OTPM\):\s*Limit\s*(\d+),\s*Used\s*(\d+)/i);
  if (!m) return null;
  const limit = parseInt(m[1], 10), used = parseInt(m[2], 10);
  return Math.max(0, limit - used - 40);
}

async function sendCompletion({ cleanKey, body, fetchFn }) {
  const url = cleanKey ? `${GROQ_BASE}/chat/completions` : '/api/ai';
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
  availableModels = null,
  fetchFn = fetch,
}) {
  const cleanKey = (apiKey || '').trim();
  const liveIds = (availableModels || []).filter(m => !m.fallback).map(m => (typeof m === 'string' ? m : m.id)).filter(isChatModelId);
  const baseOrder = liveIds.length ? liveIds : PREFERRED_MODELS;
  const tried = new Set();
  const candidates = [
    ...(model ? [model] : []),
    ...PREFERRED_MODELS.filter(id => !liveIds.length || liveIds.includes(id)),
    ...baseOrder,
  ].filter(id => {
    if (!id || tried.has(id)) return false;
    tried.add(id);
    return true;
  });

  if (!candidates.length) candidates.push(PREFERRED_MODELS[0]);

  const totalChars = (messages || []).reduce((acc, m) => acc + String(m?.content || '').length + 24, 0);
  const estInputTokens = Math.ceil(totalChars / 3.0) + 120;
  const adaptiveMax = maxTokens !== null
    ? maxTokens
    : Math.min(3000, Math.max(700, 6000 - estInputTokens));

  let lastErr = null;
  let lastRateLimitErr = null;
  let tpmRateLimitErr = null;
  let tpmRetryModel = null;
  let tpmRetryWaitMs = 0;
  let tpmRetryMaxTokens = adaptiveMax;
  const requestedModel = model;

  for (let i = 0; i < candidates.length && i < 4; i++) {
    const activeModel = candidates[i];
    // Skip tiny-context fallback models (e.g. allam-2-7b) for large circuit prompts
    if (i > 0 && /allam-2-7b/i.test(activeModel) && estInputTokens > 1200) continue;
    // Qwen3 on Groq free tier enforces a strict 1,000 OTPM limit
    let modelMax = /^qwen\/qwen3/i.test(activeModel) ? Math.min(adaptiveMax, 920) : adaptiveMax;
    const baseBody = {
      model: activeModel,
      messages,
      temperature,
      max_completion_tokens: modelMax,
    };
    // Keep 20b/Qwen3 concise so silent <think> reasoning does not truncate large circuit JSONs
    if (/^openai\/gpt-oss-20b/i.test(activeModel)) baseBody.reasoning_effort = 'low';
    else if (/^qwen\/qwen3/i.test(activeModel) && jsonMode) baseBody.reasoning_effort = 'none';
    if (jsonMode) baseBody.response_format = { type: 'json_object' };

    let attempt = await sendCompletion({ cleanKey, body: baseBody, fetchFn });

    if (!attempt.ok && attempt.status === 400 && baseBody.reasoning_effort !== undefined
      && /reasoning_effort/i.test(String(attempt.payload?.error?.message || ''))) {
      const stripped = { ...baseBody };
      delete stripped.reasoning_effort;
      attempt = await sendCompletion({ cleanKey, body: stripped, fetchFn });
    }

    if (!attempt.ok && attempt.status === 400 && baseBody.reasoning_effort !== undefined
      && /reasoning_effort/i.test(String(attempt.payload?.error?.message || ''))) {
      const stripped = { ...baseBody };
      delete stripped.reasoning_effort;
      attempt = await sendCompletion({ cleanKey, body: stripped, fetchFn });
    }

    // Handle json_validate_failed / failed_generation recovery or retry without response_format
    if (!attempt.ok && jsonMode && isResponseFormatError(attempt.status, attempt.payload)) {
      const failedGen = attempt.payload?.error?.failed_generation;
      if (typeof failedGen === 'string' && failedGen.trim()) {
        const salvaged = extractJsonObject(failedGen);
        if (salvaged) {
          return {
            modelUsed: activeModel,
            switchedFrom: activeModel !== requestedModel ? requestedModel : null,
            rawText: failedGen,
            parsed: salvaged,
            truncated: false,
            partialReply: '',
            usage: null,
          };
        }
        // If explicitly testing a tiny maxTokens cap that truncated mid-JSON, report clean truncation!
        const partial = extractPartialReply(failedGen);
        if (maxTokens !== null && maxTokens <= 250) {
          return {
            modelUsed: activeModel,
            switchedFrom: activeModel !== requestedModel ? requestedModel : null,
            rawText: failedGen,
            parsed: null,
            truncated: true,
            partialReply: partial,
            usage: null,
          };
        }
      }
      const retryBody = { ...baseBody };
      delete retryBody.response_format;
      attempt = await sendCompletion({ cleanKey, body: retryBody, fetchFn });
    }

    if (attempt.ok) {
      const choice = attempt.payload?.choices?.[0];
      const rawText = String(choice?.message?.content || '');
      const truncated = choice?.finish_reason === 'length';
      let parsed = jsonMode ? extractJsonObject(rawText) : null;
      if (jsonMode && !truncated && !parsed && maxTokens === null) {
        const repairRes = await sendCompletion({
          cleanKey,
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
            return {
              modelUsed: activeModel,
              switchedFrom: activeModel !== requestedModel ? requestedModel : null,
              rawText: rText,
              parsed: rParsed,
              truncated: rc?.finish_reason === 'length',
              partialReply: '',
              usage: repairRes.payload?.usage || attempt.payload?.usage || null,
            };
          }
        }
      }
      return {
        modelUsed: activeModel,
        switchedFrom: activeModel !== requestedModel ? requestedModel : null,
        rawText,
        parsed,
        truncated,
        partialReply: !parsed && truncated ? extractPartialReply(rawText) : '',
        usage: attempt.payload?.usage || null,
      };
    }

    const msg = attempt.payload?.error?.message || `Groq HTTP ${attempt.status}`;
    lastErr = new Error(msg);
    lastErr.status = attempt.status;
    lastErr.code = attempt.payload?.error?.code || '';

    if (attempt.status === 401 || attempt.status === 403) {
      if (!isModelDecommissionedError(attempt.status, attempt.payload)) throw lastErr;
    }
    if (attempt.status === 429) {
      // If OTPM error shows >= 450 output tokens still available, shrink max_completion_tokens & retry immediately
      const otpmAvail = parseOtpBudgetRemaining(attempt.payload);
      if (otpmAvail !== null && otpmAvail >= 450 && otpmAvail < modelMax) {
        modelMax = otpmAvail;
        const shrunkBody = { ...baseBody, max_completion_tokens: modelMax };
        const shrunkRes = await sendCompletion({ cleanKey, body: shrunkBody, fetchFn });
        if (shrunkRes.ok) {
          const choice = shrunkRes.payload?.choices?.[0];
          const rawText = String(choice?.message?.content || '');
          const truncated = choice?.finish_reason === 'length';
          const parsed = jsonMode ? extractJsonObject(rawText) : null;
          return {
            modelUsed: activeModel,
            switchedFrom: activeModel !== requestedModel ? requestedModel : null,
            rawText,
            parsed,
            truncated,
            partialReply: !parsed && truncated ? extractPartialReply(rawText) : '',
            usage: shrunkRes.payload?.usage || null,
          };
        }
      }

      if (!lastRateLimitErr) lastRateLimitErr = lastErr;
      const d = parseRetryDelayMs(attempt.payload);
      if (d !== Infinity && !tpmRateLimitErr) {
        tpmRateLimitErr = lastErr;
        tpmRetryModel = activeModel;
        tpmRetryWaitMs = d;
        tpmRetryMaxTokens = modelMax;
      }
    }
    if (isModelDecommissionedError(attempt.status, attempt.payload) || attempt.status === 429 || attempt.status === 413) {
      continue;
    }
    throw lastErr;
  }

  // Only pause-and-retry a transient TPM-limited candidate (never wait on exhausted daily TPD quotas!)
  if (tpmRateLimitErr) {
    const waitMs = Math.max(2000, Math.min(12500, tpmRetryWaitMs || 3500));
    await new Promise(r => setTimeout(r, waitMs));
    const retryRes = await sendCompletion({
      cleanKey,
      body: {
        model: tpmRetryModel,
        messages,
        temperature,
        max_completion_tokens: tpmRetryMaxTokens,
        ...(/^openai\/gpt-oss-20b/i.test(tpmRetryModel) ? { reasoning_effort: 'low' } : {}),
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      },
      fetchFn,
    });
    if (retryRes.ok) {
      const choice = retryRes.payload?.choices?.[0];
      const rawText = String(choice?.message?.content || '');
      return {
        modelUsed: tpmRetryModel,
        switchedFrom: tpmRetryModel !== requestedModel ? requestedModel : null,
        rawText,
        parsed: jsonMode ? extractJsonObject(rawText) : null,
        truncated: choice?.finish_reason === 'length',
        partialReply: '',
        usage: retryRes.payload?.usage || null,
      };
    }
    const rMsg = retryRes.payload?.error?.message || `Groq HTTP ${retryRes.status}`;
    const rErr = new Error(rMsg);
    rErr.status = retryRes.status;
    throw rErr;
  }

  throw lastRateLimitErr || lastErr || new Error('All candidate Groq models failed.');
}

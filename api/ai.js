/**
 * Vercel serverless multi-provider AI proxy (Google Gemini OpenAI-compat + Groq).
 * Supports:
 *   GET  /api/ai?check=1   -> { hasServerKey: boolean, providers: { gemini, groq } }
 *   GET  /api/ai?models=1  -> lists live chat models from configured server/header keys
 *   POST /api/ai           -> routes POST chat/completions by key prefix or model name
 */

const GROQ_BASE = 'https://api.groq.com/openai/v1';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';

function detectProvider(key = '', modelId = '') {
  if (/^(AIza|AQ\.)/.test(key)) return 'gemini';
  if (/^gsk_/i.test(key)) return 'groq';
  if (/^gemini/i.test(modelId)) return 'gemini';
  return key ? 'groq' : '';
}

function getServerKeys() {
  return {
    gemini: (process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || '').trim(),
    groq: (process.env.GROQ_API_KEY || '').trim(),
  };
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');

  const url = new URL(req.url || '/', 'http://localhost');
  const headerKey = String(req.headers?.['x-ai-key'] || req.headers?.['x-groq-key'] || '').trim();
  const srv = getServerKeys();

  if (req.method === 'GET' && url.searchParams.get('check') === '1') {
    res.statusCode = 200;
    res.end(JSON.stringify({
      hasServerKey: Boolean(srv.gemini || srv.groq),
      providers: { gemini: Boolean(srv.gemini), groq: Boolean(srv.groq) },
    }));
    return;
  }

  const hasAny = Boolean(headerKey || srv.gemini || srv.groq);
  if (!hasAny) {
    res.statusCode = 401;
    res.end(JSON.stringify({
      error: {
        code: 'missing_api_key',
        message: 'No Gemini or Groq API key configured on server or supplied via x-ai-key.',
      },
    }));
    return;
  }

  try {
    if (req.method === 'GET' && url.searchParams.get('models') === '1') {
      const queries = [];
      const hProv = headerKey ? detectProvider(headerKey) : '';
      if (headerKey) {
        queries.push([hProv === 'gemini' ? GEMINI_BASE : GROQ_BASE, headerKey]);
      } else {
        if (srv.gemini) queries.push([GEMINI_BASE, srv.gemini]);
        if (srv.groq) queries.push([GROQ_BASE, srv.groq]);
      }
      const merged = [];
      let lastStatus = 200;
      let lastBody = '';
      for (const [base, key] of queries) {
        const upstream = await fetch(`${base}/models`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${key}` },
        });
        lastStatus = upstream.status;
        lastBody = await upstream.text();
        if (upstream.ok) {
          try {
            const parsed = JSON.parse(lastBody);
            if (Array.isArray(parsed?.data)) merged.push(...parsed.data);
          } catch { /* ignore malformed list */ }
        }
      }
      if (merged.length) {
        res.statusCode = 200;
        res.end(JSON.stringify({ object: 'list', data: merged }));
        return;
      }
      res.statusCode = lastStatus;
      res.end(lastBody);
      return;
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const modelId = String(body?.model || '');
      const prov = detectProvider(headerKey, modelId) || (srv.gemini && !srv.groq ? 'gemini' : 'groq');
      const base = prov === 'gemini' ? GEMINI_BASE : GROQ_BASE;
      const key = headerKey || (prov === 'gemini' ? srv.gemini : srv.groq) || srv.gemini || srv.groq;
      const upstream = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const text = await upstream.text();
      res.statusCode = upstream.status;
      res.end(text);
      return;
    }

    res.statusCode = 405;
    res.end(JSON.stringify({ error: { message: 'Method not allowed' } }));
  } catch (err) {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: { message: err?.message || 'Upstream AI request failed' } }));
  }
}

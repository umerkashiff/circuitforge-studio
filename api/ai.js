/**
 * Vercel serverless Gemini AI proxy (Google Gemini OpenAI-compat endpoint).
 * Supports:
 *   GET  /api/ai?check=1   -> { hasServerKey: boolean, provider: 'gemini' }
 *   GET  /api/ai?models=1  -> lists live Gemini chat models from configured server or header key
 *   POST /api/ai           -> forwards chat/completions to Google Gemini
 */

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/openai';

function getServerKey() {
  return (process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || process.env.GEM_KEY || '').trim();
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
  const headerKey = String(req.headers?.['x-ai-key'] || '').trim();
  const serverKey = getServerKey();

  if (req.method === 'GET' && url.searchParams.get('check') === '1') {
    res.statusCode = 200;
    res.end(JSON.stringify({
      hasServerKey: Boolean(serverKey),
      provider: 'gemini',
    }));
    return;
  }

  const key = headerKey || serverKey;
  if (!key) {
    res.statusCode = 401;
    res.end(JSON.stringify({
      error: {
        code: 'missing_api_key',
        message: 'No Gemini API key configured on server or supplied via x-ai-key.',
      },
    }));
    return;
  }

  try {
    if (req.method === 'GET' && url.searchParams.get('models') === '1') {
      const upstream = await fetch(`${GEMINI_BASE}/models`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${key}` },
      });
      const text = await upstream.text();
      res.statusCode = upstream.status;
      res.end(text);
      return;
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const upstream = await fetch(`${GEMINI_BASE}/chat/completions`, {
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
    res.end(JSON.stringify({ error: { message: err?.message || 'Upstream Gemini request failed' } }));
  }
}

/**
 * Vercel serverless proxy for Groq API requests.
 * Supports:
 *   GET  /api/ai?check=1   -> { hasServerKey: boolean }
 *   GET  /api/ai?models=1  -> proxies GET https://api.groq.com/openai/v1/models
 *   POST /api/ai           -> proxies POST https://api.groq.com/openai/v1/chat/completions
 */

const GROQ_BASE = 'https://api.groq.com/openai/v1';

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
  const headerKey = typeof req.headers?.['x-groq-key'] === 'string' ? req.headers['x-groq-key'].trim() : '';
  const apiKey = headerKey || (process.env.GROQ_API_KEY || '').trim();

  if (req.method === 'GET' && url.searchParams.get('check') === '1') {
    res.statusCode = 200;
    res.end(JSON.stringify({ hasServerKey: Boolean((process.env.GROQ_API_KEY || '').trim()) }));
    return;
  }

  if (!apiKey) {
    res.statusCode = 401;
    res.end(JSON.stringify({
      error: {
        code: 'missing_api_key',
        message: 'No Groq API key configured on server or supplied via x-groq-key.',
      },
    }));
    return;
  }

  try {
    if (req.method === 'GET' && url.searchParams.get('models') === '1') {
      const upstream = await fetch(`${GROQ_BASE}/models`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const text = await upstream.text();
      res.statusCode = upstream.status;
      res.end(text);
      return;
    }

    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const upstream = await fetch(`${GROQ_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
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
    res.end(JSON.stringify({ error: { message: err?.message || 'Upstream Groq request failed' } }));
  }
}

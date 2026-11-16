import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import aiHandler from '../api/ai.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const PORT = parseInt(process.env.PORT || '3000', 10);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');

  let urlPath = req.url.split('?')[0].split('#')[0];
  if (urlPath === '/api/ai') {
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-groq-key');
      res.writeHead(204);
      return res.end();
    }
    return aiHandler(req, res);
  }
  if (urlPath === '/' || urlPath === '') {
    urlPath = '/index.html';
  }

  const filePath = path.join(ROOT, decodeURIComponent(urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // If no extension, try with .html
      if (!path.extname(filePath)) {
        const htmlPath = filePath + '.html';
        if (fs.existsSync(htmlPath)) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          return fs.createReadStream(htmlPath).pipe(res);
        }
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('404 Not Found: ' + urlPath);
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 CircuitForge Studio running locally at:`);
  console.log(`   > http://localhost:${PORT}`);
  console.log(`   > http://127.0.0.1:${PORT}\n`);
});

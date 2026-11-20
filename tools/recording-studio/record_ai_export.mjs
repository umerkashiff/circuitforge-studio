/**
 * Re-records the two upgraded clips:
 *   1. clip-ai-panel.mp4 + .webp   (Progressive real breadboard build synced to AI Copilot!)
 *   2. clip-export-studio.mp4 + .webp (Rich 74LS93 Counter: IEEE Color -> Live -> Blueprint -> IEC -> smooth A4 Lab Report scroll -> BOM!)
 */

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const BASE_URL = process.env.STUDIO_URL || 'http://localhost:4173';
const CLIPS_DIR = path.join(ROOT, 'assets', 'studio', 'clips');
const TMP_DIR = path.join(os.tmpdir(), 'circuitforge-ai-export-' + Date.now());
const PORT = 9251;
const FPS = 24;

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));
const FFMPEG = fs.existsSync('C:\\ffmpeg\\bin\\ffmpeg.exe') ? 'C:\\ffmpeg\\bin\\ffmpeg.exe' : 'ffmpeg';

fs.mkdirSync(CLIPS_DIR, { recursive: true });
fs.rmSync(TMP_DIR, { recursive: true, force: true });
fs.mkdirSync(TMP_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const lerp = (a, b, t) => a + (b - a) * t;

class CDP {
  constructor(wsUrl) { this.wsUrl = wsUrl; this.id = 0; this.pending = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((res, rej) => { this.ws.addEventListener('open', res, { once: true }); this.ws.addEventListener('error', rej, { once: true }); });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id); this.pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message)); else res(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => { this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async evalJs(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  }
  close() { this.ws?.close(); }
}

async function waitForDevTools(port) {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(150);
  }
  throw new Error('DevTools timeout');
}

function encodeClip(framesDir, name, { crf = 21, width = 1120, posterFrame = 90 } = {}) {
  const pattern = path.join(framesDir, 'f_%04d.png');
  const mp4 = path.join(CLIPS_DIR, `${name}.mp4`);
  const webp = path.join(CLIPS_DIR, `${name}.webp`);

  execFileSync(FFMPEG, [
    '-y', '-framerate', String(FPS), '-i', pattern,
    '-vf', `scale=${width}:-2:flags=lanczos`,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf),
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an',
    mp4,
  ], { stdio: 'ignore' });

  const files = fs.readdirSync(framesDir).filter((f) => f.endsWith('.png')).sort();
  const pick = files[Math.min(posterFrame, Math.max(0, files.length - 1))];
  execFileSync(FFMPEG, [
    '-y', '-i', path.join(framesDir, pick),
    '-vf', `scale=${width}:-2:flags=lanczos`,
    '-c:v', 'libwebp', '-quality', '88',
    webp,
  ], { stdio: 'ignore' });

  console.log(`✅ ${name}.mp4 (${(fs.statSync(mp4).size / 1024).toFixed(1)} KB, ${files.length}f) + .webp (${(fs.statSync(webp).size / 1024).toFixed(1)} KB)`);
}

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(TMP_DIR, 'profile')}`,
  '--headless=new', '--disable-gpu', '--window-size=1280,748', '--hide-scrollbars', '--no-first-run', 'about:blank',
], { stdio: 'ignore' });

const EXPORT_ONLY = process.argv.includes('--export-only');
try {
  const cdp = new CDP(await waitForDevTools(PORT));
  await cdp.connect();
  await cdp.send('Page.enable');

  // =========================================================================
  // 1. clip-ai-panel: Progressive Live Breadboard Build synced to AI Copilot!
  // =========================================================================
  if (!EXPORT_ONLY) {
  console.log('\n🤖 [1/2] Capturing upgraded clip-ai-panel (Progressive AI Build + Live Blinking Verification)...');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1120, height: 650, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `${BASE_URL}/tools/recording-studio/ai_demo.html` });
  for (let i = 0; i < 40; i++) {
    if (await cdp.evalJs('!!window.__AI_DEMO_READY')) break;
    await sleep(100);
  }

  const aiDir = path.join(TMP_DIR, 'ai');
  fs.mkdirSync(aiDir, { recursive: true });
  const fullPrompt = 'Build a 555 astable LED blinker with a 220Ω resistor and verify oscillation.';
  const totalF = 160;

  for (let f = 0; f < totalF; f++) {
    let partCount = 0;
    let wireCount = 0;
    let live = false;
    let promptText = '';
    let showUserMsg = false;
    let steps = [];
    let done = false;

    // Camera starts wide on empty board, then purposefully zooms onto the newly built 555 + blinking LED!
    let cx = 16.0, cy = 8.5, z = 1.04;

    if (f < 26) {
      // Typing prompt smoothly
      const n = Math.min(fullPrompt.length, Math.floor((f / 22) * fullPrompt.length));
      promptText = fullPrompt.slice(0, n);
    } else {
      showUserMsg = true;
    }

    if (f >= 28 && f < 40) {
      partCount = 2; // +5V & GND
      steps = [{ ok: false, text: 'add_power(+5V, GND) & NE555' }];
    } else if (f >= 40 && f < 52) {
      partCount = 3; // NE555 straddles trench!
      steps = [
        { ok: true, text: 'place(U1: NE555) across trench' },
        { ok: false, text: 'place(R1 1kΩ, R2 10kΩ, C1 15µF)' },
      ];
    } else if (f >= 52 && f < 64) {
      partCount = 6; // R1, R2, C1 placed!
      steps = [
        { ok: true, text: 'place(U1: NE555) across trench' },
        { ok: true, text: 'place(R1 1kΩ, R2 10kΩ, C1 15µF)' },
        { ok: false, text: 'place(R3 220Ω, LED1 green)' },
      ];
    } else if (f >= 64 && f < 74) {
      partCount = 8; // R3 + LED1 placed!
      wireCount = 4; // Power rails wired
      steps = [
        { ok: true, text: 'place(U1: NE555) across trench' },
        { ok: true, text: 'place(R1 1kΩ, R2 10kΩ, C1 15µF)' },
        { ok: true, text: 'place(R3 220Ω, LED1 green)' },
        { ok: false, text: 'route_tidy_wires(10 nets)...' },
      ];
    } else if (f >= 74 && f < 88) {
      partCount = 8;
      wireCount = Math.min(10, 4 + Math.floor((f - 72) / 2));
      steps = [
        { ok: true, text: 'place(U1: NE555) across trench' },
        { ok: true, text: 'place(R1 1kΩ, R2 10kΩ, C1 15µF)' },
        { ok: true, text: 'place(R3 220Ω, LED1 green)' },
        { ok: wireCount === 10, text: `route_tidy_wires(${wireCount}/10 nets)` },
      ];
    } else if (f >= 88) {
      partCount = 8;
      wireCount = 10;
      live = true;
      steps = [
        { ok: true, text: 'place(U1: NE555) across trench' },
        { ok: true, text: 'place(R1 1kΩ, R2 10kΩ, C1 15µF)' },
        { ok: true, text: 'place(R3 220Ω, LED1 green)' },
        { ok: true, text: 'route_tidy_wires(10/10 nets)' },
        { ok: true, text: 'probe_pin(U1.OUT) → 2.9 Hz' },
      ];
      done = f >= 94;
      // Smooth purposeful zoom right onto the working 555 + glowing green LED!
      const zt = Math.min(1, (f - 88) / 26);
      const e = easeInOutCubic(zt);
      cx = lerp(16.0, 10.6, e);
      cy = lerp(8.5, 10.2, e);
      z = Math.exp(lerp(Math.log(1.04), Math.log(1.62), e));
    }

    await cdp.evalJs(`window.AI_DEMO.setState(${JSON.stringify({
      partCount, wireCount, live, stepSec: live ? 1 / 24 : 0,
      cx, cy, z, promptText, showUserMsg, steps, done,
    })})`);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(aiDir, `f_${String(f).padStart(4, '0')}.png`), Buffer.from(data, 'base64'));
  }
  encodeClip(aiDir, 'clip-ai-panel', { crf: 21, width: 1120, posterFrame: 122 });
  }

  // =========================================================================
  // 2. clip-export-studio: Rich Binary Counter Schematic Style Morph + Smooth Lab Report Scroll + BOM!
  // =========================================================================
  console.log('\n📄 [2/2] Capturing upgraded clip-export-studio (Live Schematic Styles + Smooth A4 Lab Report Scroll + BOM)...');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 748, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `${BASE_URL}/studio?example=counter` });
  await sleep(1100);
  await cdp.evalJs(`(() => {
    if (document.documentElement.dataset.theme !== 'dark') document.getElementById('btn-theme')?.click();
    const toast = document.getElementById('toast'); if (toast) toast.style.display = 'none';
    document.getElementById('btn-tidy')?.click();
  })()`);
  await sleep(450);
  await cdp.evalJs(`document.getElementById('mode-sim')?.click();`);
  await sleep(850);
  await cdp.evalJs(`document.getElementById('btn-export')?.click();`);
  await sleep(550);

  const clickBtn = async (regexSrc) => {
    await cdp.evalJs(`(() => {
      const re = new RegExp(${JSON.stringify(regexSrc)}, 'i');
      const btn = [...document.querySelectorAll('button')].find(b => b.offsetParent !== null && re.test(b.textContent.trim()));
      if (btn) btn.click();
    })()`);
  };

  // Start on Breadboard diagram (16 frames) -> Schematic (Color -> Live -> Blue -> IEC) -> Lab Report scroll -> Data/BOM
  const box = await cdp.evalJs(`(() => {
    const m = document.querySelector('.exp-dialog, .exp-modal, .export-modal, .modal-card, [role="dialog"]') || document.querySelector('.exp-head')?.parentElement;
    const r = m ? m.getBoundingClientRect() : { left: 26, top: 30, width: 1228, height: 688 };
    return { x: Math.max(0, r.left), y: Math.max(0, r.top), width: r.width, height: r.height };
  })()`);

  const expDir = path.join(TMP_DIR, 'export');
  fs.mkdirSync(expDir, { recursive: true });
  let fi = 0;
  const snap = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      const { data } = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 },
      });
      fs.writeFileSync(path.join(expDir, `f_${String(fi++).padStart(4, '0')}.png`), Buffer.from(data, 'base64'));
    }
  };

  // Phase 0: Crisp Breadboard diagram with Title Block
  await snap(16);

  // Phase A: IEEE Color Schematic
  await clickBtn('^Schematic$');
  await sleep(450);
  await clickBtn('^Color$');
  await sleep(250);
  await snap(24);

  // Phase B: Switch to Live Voltage Theme
  await clickBtn('^Live$');
  await sleep(280);
  await snap(26);

  // Phase C: Switch to Blueprint Theme (Blue)
  await clickBtn('^Blue$');
  await sleep(260);
  await snap(22);

  // Phase D: Switch to IEC / DIN standard in Color
  await clickBtn('^Color$');
  await sleep(160);
  await clickBtn('^IEC');
  await sleep(260);
  await snap(20);

  // Phase E: Switch to Lab Report & smoothly scroll down through Breadboard -> Schematic -> BOM Table!
  await clickBtn('^Lab Report$');
  await sleep(550);
  const maxScroll = await cdp.evalJs(`(() => {
    const fr = document.querySelector('iframe.exp-report-frame');
    const doc = fr?.contentDocument;
    if (!doc) return 0;
    return Math.max(0, doc.documentElement.scrollHeight - fr.clientHeight);
  })()`);
  await snap(14);
  const scrollFrames = 56;
  for (let i = 1; i <= scrollFrames; i++) {
    const y = maxScroll * easeInOutCubic(i / scrollFrames);
    await cdp.evalJs(`document.querySelector('iframe.exp-report-frame')?.contentWindow?.scrollTo(0, ${y.toFixed(1)})`);
    await snap(1);
  }
  await snap(16);

  // Phase F: Data & Waveforms (BOM + Netlist)
  await clickBtn('^Data');
  await sleep(300);
  await snap(20);

  encodeClip(expDir, 'clip-export-studio', { crf: 21, width: 1120, posterFrame: 48 });

  await cdp.close();
  console.log('\n🎉 Upgraded clip-ai-panel & clip-export-studio ready!');
} finally {
  chrome.kill();
}

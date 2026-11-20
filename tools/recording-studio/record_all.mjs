/**
 * CircuitForge Studio — Complete Recording & Asset Suite Orchestrator
 *
 * Uses CircuitForge's REAL Canvas2D Renderer, MNA Physics Engine, Router (tidy),
 * and UI panels to generate 28 purposeful, zero-clutter site assets:
 *   - 18 true-alpha-transparent HiDPI hardware part sprites (assets/studio/parts/*.webp)
 *   - 7 frameless pure-#000 choreographed hardware reels with purposeful pan/zoom/actions
 *   - 3 isolated real-UI feature clips (Parts Library scroll, AI Copilot, Export Studio)
 *
 * Usage:
 *   PORT=4173 node tools/serve.mjs
 *   node tools/recording-studio/record_all.mjs
 */

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const BASE_URL = process.env.STUDIO_URL || 'http://localhost:4173';
const PARTS_DIR = path.join(ROOT, 'assets', 'studio', 'parts');
const CLIPS_DIR = path.join(ROOT, 'assets', 'studio', 'clips');
const TMP_DIR = path.join(os.tmpdir(), 'circuitforge-rec-studio');
const PORT = 9244;
const FPS = 24;

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));
const FFMPEG = fs.existsSync('C:\\ffmpeg\\bin\\ffmpeg.exe') ? 'C:\\ffmpeg\\bin\\ffmpeg.exe' : 'ffmpeg';

if (!CHROME) throw new Error('Chrome/Edge binary not found');

fs.mkdirSync(PARTS_DIR, { recursive: true });
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

// Multi-keyframe camera timeline evaluator: keyframes = [{ f, cx, cy, z }]
function evalCamera(keyframes, frame) {
  if (frame <= keyframes[0].f) return keyframes[0];
  for (let i = 0; i < keyframes.length - 1; i++) {
    const a = keyframes[i], b = keyframes[i + 1];
    if (frame <= b.f) {
      const t = (frame - a.f) / Math.max(1, b.f - a.f);
      const e = easeInOutCubic(t);
      return {
        cx: lerp(a.cx, b.cx, e),
        cy: lerp(a.cy, b.cy, e),
        z: Math.exp(lerp(Math.log(a.z), Math.log(b.z), e)), // logarithmic zoom = visually constant speed!
      };
    }
  }
  return keyframes[keyframes.length - 1];
}

function encodeClip(framesDir, name, { crf = 22, width = 960, posterFrame = 0, fps = FPS } = {}) {
  const pattern = path.join(framesDir, 'f_%04d.png');
  const mp4 = path.join(CLIPS_DIR, `${name}.mp4`);
  const webp = path.join(CLIPS_DIR, `${name}.webp`);

  execFileSync(FFMPEG, [
    '-y', '-framerate', String(fps), '-i', pattern,
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

async function recordDirectorClip(cdp, name, {
  scene, width = 960, height = 560, totalFrames = 120,
  stepPerFrame = 1 / 24, labelMode = 'off', crf = 22, posterFrame = 50,
  buildTimeline,
}) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await cdp.evalJs(`window.DIRECTOR.resize(${width}, ${height})`);
  const info = await cdp.evalJs(`window.DIRECTOR.loadScene(${JSON.stringify(scene)})`);
  const { keyframes, actions = [] } = buildTimeline(info);

  const dir = path.join(TMP_DIR, name);
  fs.mkdirSync(dir, { recursive: true });
  const actionMap = new Map();
  for (const act of actions) {
    if (!actionMap.has(act.f)) actionMap.set(act.f, []);
    actionMap.get(act.f).push(act);
  }

  for (let f = 0; f < totalFrames; f++) {
    const acts = actionMap.get(f);
    if (acts) {
      for (const a of acts) {
        await cdp.evalJs(`window.DIRECTOR.setPartProp(${a.idx}, ${JSON.stringify(a.prop)}, ${JSON.stringify(a.val)})`);
      }
    }
    const cam = evalCamera(keyframes, f);
    await cdp.evalJs(`window.DIRECTOR.renderFrame(${JSON.stringify({
      cx: cam.cx, cy: cam.cy, zoom: cam.z,
      stepSec: stepPerFrame, background: '#000000', drawGrid: false, labelMode, live: true,
    })})`);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(dir, `f_${String(f).padStart(4, '0')}.png`), Buffer.from(data, 'base64'));
  }

  encodeClip(dir, name, { crf, width, posterFrame });
}

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(TMP_DIR, 'profile')}`,
  '--headless=new', '--disable-gpu', '--window-size=1280,748', '--hide-scrollbars', '--no-first-run', 'about:blank',
], { stdio: 'ignore' });

try {
  const cdp = new CDP(await waitForDevTools(PORT));
  await cdp.connect();
  await cdp.send('Page.enable');

  // =========================================================================
  // PART 1: 18 TRUE-TRANSPARENT REAL HARDWARE PART SPRITES (assets/studio/parts/*.webp)
  // =========================================================================
  console.log('\n🎨 [Part 1/3] Rendering 18 transparent HiDPI hardware part sprites from real Renderer...');
  await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 240, height: 240, deviceScaleFactor: 2, mobile: false });
  await cdp.send('Page.navigate', { url: `${BASE_URL}/tools/recording-studio/stage.html` });
  for (let i = 0; i < 40; i++) {
    if (await cdp.evalJs('!!window.__DIRECTOR_READY')) break;
    await sleep(100);
  }

  const SPRITES = [
    ['ut2062b', 'oscilloscope', { run: true, ch1On: true, ch2On: true }],
    ['dmm', 'multimeter', { mode: 'dcv' }],
    ['psu', 'power-supply', { power: true, v1: 5.0, v2: 12.0 }],
    ['funcgen', 'funcgen', { power: true, wave: 'sine', hz: 100, vpp: 5 }],
    ['uno', 'uno', {}],
    ['esp32', 'esp32', {}],
    ['bluepill', 'bluepill', {}],
    ['ne555', 'ne555', {}],
    ['ic7493', 'ic7493', {}],
    ['ic7408', 'ic7408', {}],
    ['ic74161', 'ic74161', {}],
    ['ic74245', 'ic74245', {}],
    ['ic28c16', 'ic28c16', {}],
    ['lm358', 'lm358', {}],
    ['lm317', 'lm317', {}],
    ['seg7x4', 'seg7x4', {}],
    ['bargraph', 'bargraph', { color: 'yellow' }],
    ['pot', 'pot', { pos: 0.65 }],
  ];

  const sprTmp = path.join(TMP_DIR, 'sprites');
  fs.mkdirSync(sprTmp, { recursive: true });
  for (const [slug, type, props] of SPRITES) {
    await cdp.evalJs(`window.DIRECTOR.renderPartSprite(${JSON.stringify(type)}, ${JSON.stringify(props)}, 240, 18)`);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', omitBackground: true });
    const pngPath = path.join(sprTmp, `${slug}.png`);
    const webpPath = path.join(PARTS_DIR, `${slug}.webp`);
    fs.writeFileSync(pngPath, Buffer.from(data, 'base64'));
    execFileSync(FFMPEG, ['-y', '-i', pngPath, '-c:v', 'libwebp', '-lossless', '0', '-quality', '90', webpPath], { stdio: 'ignore' });
  }
  console.log(`✅ Generated ${SPRITES.length} alpha-transparent hardware sprites in assets/studio/parts/`);

  // Reset opaque black background for pure-#000 seamless stage videos
  await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 1 } });

  // =========================================================================
  // PART 2: 7 ZERO-CHROME CHOREOGRAPHED HARDWARE REELS (Purposeful pan/zoom/actions)
  // =========================================================================
  console.log('\n🎬 [Part 2/3] Recording 7 zero-chrome choreographed hardware reels on pure #000...');

  // 1. Tidy 14-Board SAP-1 CPU Cinematic Tour (Wide -> Clock -> ALU/Bus -> Output 7-Seg -> Pull-back)
  await recordDirectorClip(cdp, 'clip-sap1-tour', {
    scene: 'sap1-powers', width: 1120, height: 650, totalFrames: 168,
    stepPerFrame: 0.055, labelMode: 'off', crf: 25, posterFrame: 115,
    buildTimeline: ({ fit, meta }) => ({
      keyframes: [
        { f: 0,   cx: fit.cx, cy: fit.cy, z: fit.z * 0.98 },
        { f: 22,  cx: fit.cx, cy: fit.cy, z: fit.z * 0.98 },
        { f: 48,  cx: meta.clock.cx, cy: meta.clock.cy, z: fit.z * 2.55 },
        { f: 68,  cx: meta.clock.cx, cy: meta.clock.cy, z: fit.z * 2.55 },
        { f: 96,  cx: meta.seg.cx,   cy: meta.seg.cy,   z: fit.z * 3.15 },
        { f: 138, cx: meta.seg.cx,   cy: meta.seg.cy,   z: fit.z * 3.15 },
        { f: 160, cx: fit.cx, cy: fit.cy, z: fit.z * 0.98 },
        { f: 168, cx: fit.cx, cy: fit.cy, z: fit.z * 0.98 },
      ],
    }),
  });

  // 2. Real UT2062B Oscilloscope + EGC-3235A Function Generator + Rectifier (Wide -> CRT Hero Zoom)
  await recordDirectorClip(cdp, 'clip-scope-live', {
    scene: 'scope-rectifier', width: 1120, height: 650, totalFrames: 132,
    stepPerFrame: 0.004, labelMode: 'off', crf: 21, posterFrame: 66,
    buildTimeline: ({ fit, meta }) => ({
      keyframes: [
        { f: 0,   cx: fit.cx, cy: fit.cy, z: fit.z * 0.96 },
        { f: 20,  cx: fit.cx, cy: fit.cy, z: fit.z * 0.96 },
        { f: 48,  cx: meta.scopeScreen.cx, cy: meta.scopeScreen.cy, z: fit.z * 2.75 },
        { f: 96,  cx: meta.scopeScreen.cx, cy: meta.scopeScreen.cy, z: fit.z * 2.75 },
        { f: 122, cx: fit.cx, cy: fit.cy, z: fit.z * 0.96 },
        { f: 132, cx: fit.cx, cy: fit.cy, z: fit.z * 0.96 },
      ],
    }),
  });

  // 3. Real MPS-3005L-3 PSU + DMM + Breadboard (Sweep PSU voltage 5V -> 9V -> 12V while panning PSU -> DMM)
  await recordDirectorClip(cdp, 'clip-dmm-psu', {
    scene: 'bench-dmm-psu', width: 960, height: 560, totalFrames: 132,
    stepPerFrame: 0.02, labelMode: 'off', crf: 21, posterFrame: 78,
    buildTimeline: ({ fit, meta }) => ({
      keyframes: [
        { f: 0,   cx: fit.cx, cy: fit.cy, z: fit.z * 0.96 },
        { f: 16,  cx: fit.cx, cy: fit.cy, z: fit.z * 0.96 },
        { f: 42,  cx: meta.psu.cx, cy: meta.psu.cy, z: fit.z * 1.95 },
        { f: 62,  cx: meta.psu.cx, cy: meta.psu.cy, z: fit.z * 1.95 },
        { f: 90,  cx: meta.dmm.cx, cy: meta.dmm.cy, z: fit.z * 2.15 },
        { f: 112, cx: meta.dmm.cx, cy: meta.dmm.cy, z: fit.z * 2.15 },
        { f: 132, cx: fit.cx, cy: fit.cy, z: fit.z * 0.96 },
      ],
      actions: [
        { f: 28, idx: meta.psuIdx, prop: 'v1', val: 9.0 },
        { f: 74, idx: meta.psuIdx, prop: 'v1', val: 12.0 },
        { f: 102, idx: meta.psuIdx, prop: 'v1', val: 5.0 },
      ],
    }),
  });

  // 4. Tidy 74LS93 Counter + LED Bargraph (Wide -> IC Zoom -> Smooth Horizontal Pan to Counting Bargraph)
  await recordDirectorClip(cdp, 'clip-counter-zoom', {
    scene: 'ttl-counter', width: 960, height: 560, totalFrames: 126,
    stepPerFrame: 1 / 24, labelMode: 'refs', crf: 21, posterFrame: 76,
    buildTimeline: ({ fit, meta }) => ({
      keyframes: [
        { f: 0,   cx: fit.cx, cy: fit.cy, z: fit.z * 0.98 },
        { f: 16,  cx: fit.cx, cy: fit.cy, z: fit.z * 0.98 },
        { f: 40,  cx: meta.ic.cx,  cy: meta.ic.cy,  z: fit.z * 2.15 },
        { f: 58,  cx: meta.ic.cx,  cy: meta.ic.cy,  z: fit.z * 2.15 },
        { f: 84,  cx: meta.bar.cx, cy: meta.bar.cy, z: fit.z * 2.25 },
        { f: 104, cx: meta.bar.cx, cy: meta.bar.cy, z: fit.z * 2.25 },
        { f: 126, cx: fit.cx, cy: fit.cy, z: fit.z * 0.98 },
      ],
    }),
  });

  // 5. Tidy NE555 Astable Pulse (Purposeful Zoom into DIP-8 NE555 + Timing Cap + Emerald LED)
  await recordDirectorClip(cdp, 'clip-555-pulse', {
    scene: 'ne555-blinker', width: 960, height: 560, totalFrames: 112,
    stepPerFrame: 1 / 24, labelMode: 'values', crf: 21, posterFrame: 52,
    buildTimeline: ({ fit, meta }) => ({
      keyframes: [
        { f: 0,   cx: fit.cx, cy: fit.cy, z: fit.z * 0.98 },
        { f: 18,  cx: fit.cx, cy: fit.cy, z: fit.z * 0.98 },
        { f: 44,  cx: meta.focus.cx, cy: meta.focus.cy, z: fit.z * 2.1 },
        { f: 84,  cx: meta.focus.cx, cy: meta.focus.cy, z: fit.z * 2.1 },
        { f: 106, cx: fit.cx, cy: fit.cy, z: fit.z * 0.98 },
        { f: 112, cx: fit.cx, cy: fit.cy, z: fit.z * 0.98 },
      ],
    }),
  });

  // 6. Tidy LM358 Comparator + Live Sweeping Potentiometer Knob (Analog MNA Threshold Snap!)
  await recordDirectorClip(cdp, 'clip-opamp-sweep', {
    scene: 'opamp-comparator', width: 960, height: 560, totalFrames: 120,
    stepPerFrame: 0.015, labelMode: 'refs', crf: 21, posterFrame: 64,
    buildTimeline: ({ fit, meta }) => {
      const actions = [];
      // Smoothly sweep potentiometer pos from 0.12 -> 0.88 -> 0.12
      for (let f = 14; f <= 66; f++) {
        const t = easeInOutCubic((f - 14) / 52);
        actions.push({ f, idx: meta.potIdx, prop: 'pos', val: +(0.12 + 0.76 * t).toFixed(3) });
      }
      for (let f = 74; f <= 112; f++) {
        const t = easeInOutCubic((f - 74) / 38);
        actions.push({ f, idx: meta.potIdx, prop: 'pos', val: +(0.88 - 0.76 * t).toFixed(3) });
      }
      return {
        keyframes: [
          { f: 0,   cx: fit.cx, cy: fit.cy, z: fit.z * 0.98 },
          { f: 12,  cx: fit.cx, cy: fit.cy, z: fit.z * 0.98 },
          { f: 38,  cx: meta.focus.cx, cy: meta.focus.cy, z: fit.z * 1.85 },
          { f: 90,  cx: meta.focus.cx, cy: meta.focus.cy, z: fit.z * 1.85 },
          { f: 116, cx: fit.cx, cy: fit.cy, z: fit.z * 0.98 },
          { f: 120, cx: fit.cx, cy: fit.cy, z: fit.z * 0.98 },
        ],
        actions,
      };
    },
  });

  // 7. Tidy 7408 AND Gate with Interactive Toggle Switch Flips
  await recordDirectorClip(cdp, 'clip-switches-and', {
    scene: 'and-gate-live', width: 960, height: 560, totalFrames: 112,
    stepPerFrame: 0.02, labelMode: 'refs', crf: 21, posterFrame: 68,
    buildTimeline: ({ fit, meta }) => ({
      keyframes: [
        { f: 0,   cx: fit.cx, cy: fit.cy, z: fit.z * 0.96 },
        { f: 22,  cx: meta.focus.cx, cy: meta.focus.cy, z: fit.z * 1.55 },
        { f: 88,  cx: meta.focus.cx, cy: meta.focus.cy, z: fit.z * 1.55 },
        { f: 112, cx: fit.cx, cy: fit.cy, z: fit.z * 0.96 },
      ],
      actions: [
        { f: 18, idx: meta.swAIdx, prop: 'on', val: true },
        { f: 44, idx: meta.swBIdx, prop: 'on', val: true },
        { f: 82, idx: meta.swAIdx, prop: 'on', val: false },
        { f: 98, idx: meta.swBIdx, prop: 'on', val: false },
      ],
    }),
  });

  // =========================================================================
  // PART 3: 3 ISOLATED REAL-UI FEATURE CLIPS (No cluttered full-screen dumps!)
  // =========================================================================
  console.log('\n✨ [Part 3/3] Recording 3 isolated real-UI feature clips (Library Scroll, AI Copilot, Export Studio)...');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 748, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `${BASE_URL}/studio?example=555` });
  await sleep(1100);
  await cdp.evalJs(`(() => {
    if (document.documentElement.dataset.theme !== 'dark') document.getElementById('btn-theme')?.click();
    const toast = document.getElementById('toast'); if (toast) toast.style.display = 'none';
    document.getElementById('btn-tidy')?.click();
  })()`);
  await sleep(450);

  // 8. Isolated Parts Library Panel Smooth Scroll (cropped strictly to the sleek dark library sidebar + search)
  {
    const dir = path.join(TMP_DIR, 'clip-library-panel');
    fs.mkdirSync(dir, { recursive: true });
    // Expand library slightly wider for a crisp 4:3 showcase crop!
    const box = await cdp.evalJs(`(() => {
      document.documentElement.style.setProperty('--lib-w', '360px');
      const el = document.querySelector('aside.library');
      const list = document.getElementById('library');
      if (list) list.scrollTop = 0;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height, maxScroll: Math.max(0, list.scrollHeight - list.clientHeight) };
    })()`);
    await sleep(150);
    const scrollTarget = Math.min(box.maxScroll, 1180);
    const N = 110;
    for (let f = 0; f < N; f++) {
      let y = 0;
      if (f >= 10 && f <= 80) y = scrollTarget * easeInOutCubic((f - 10) / 70);
      else if (f > 80 && f <= 95) y = scrollTarget;
      else if (f > 95) y = scrollTarget * (1 - easeInOutCubic((f - 95) / 14));
      await cdp.evalJs(`document.getElementById('library').scrollTop = ${y.toFixed(1)}`);
      const { data } = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 },
      });
      fs.writeFileSync(path.join(dir, `f_${String(f).padStart(4, '0')}.png`), Buffer.from(data, 'base64'));
    }
    encodeClip(dir, 'clip-library-panel', { crf: 21, width: 420, posterFrame: 22 });
    await cdp.evalJs(`document.documentElement.style.setProperty('--lib-w', '252px');`);
  }

  // 9. Isolated AI Copilot + Live Tidy Breadboard (hide left library, keep clean board + AI Copilot right panel!)
  {
    const dir = path.join(TMP_DIR, 'clip-ai-panel');
    fs.mkdirSync(dir, { recursive: true });
    await cdp.evalJs(`(() => {
      if (!document.body.classList.contains('no-library')) document.getElementById('btn-library')?.click();
      if (document.body.classList.contains('no-inspector')) document.getElementById('btn-panel')?.click();
      document.documentElement.style.setProperty('--insp-w', '350px');
      document.getElementById('tab-ai')?.click();
      document.getElementById('zoom-fit')?.click();
    })()`);
    await sleep(350);
    await cdp.evalJs(`document.getElementById('mode-sim')?.click();`);
    await sleep(300);
    // Type a realistic prompt smoothly into the real AI Copilot textarea while the 555 LED blinks beside it!
    const promptStr = 'Add a 220Ω resistor and green LED to NE555 pin 3, then probe oscillation frequency.';
    const N = 108;
    for (let f = 0; f < N; f++) {
      const chars = Math.min(promptStr.length, Math.max(0, Math.floor((f - 10) * 1.4)));
      const sub = promptStr.slice(0, chars);
      await cdp.evalJs(`(() => {
        const ta = document.querySelector('#ai-body textarea, #ai-input');
        if (ta) { ta.value = ${JSON.stringify(sub)}; ta.dispatchEvent(new Event('input', { bubbles: true })); }
      })()`);
      // Crop below the top 52px toolbar for a super-clean frameless stage+AI split!
      const { data } = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: 0, y: 52, width: 1280, height: 696, scale: 1 },
      });
      fs.writeFileSync(path.join(dir, `f_${String(f).padStart(4, '0')}.png`), Buffer.from(data, 'base64'));
      await sleep(36);
    }
    encodeClip(dir, 'clip-ai-panel', { crf: 22, width: 960, posterFrame: 78 });
    await cdp.evalJs(`document.documentElement.style.setProperty('--insp-w', '288px');`);
  }

  // 10. Isolated Export Studio Modal (cropped strictly to the modal box — IEEE Schematic zoom -> Lab Report!)
  {
    const dir = path.join(TMP_DIR, 'clip-export-studio');
    fs.mkdirSync(dir, { recursive: true });
    await cdp.evalJs(`document.getElementById('btn-export')?.click();`);
    await sleep(500);
    await cdp.evalJs(`(() => {
      const btns = [...document.querySelectorAll('.exp-tabs button, .exp-nav button, [data-tab]')];
      btns.find(b => /schematic/i.test(b.textContent))?.click();
    })()`);
    await sleep(450);
    const box = await cdp.evalJs(`(() => {
      const m = document.querySelector('.exp-modal, .export-modal, .modal-card, [role="dialog"]');
      const r = m ? m.getBoundingClientRect() : { left: 32, top: 36, width: 1216, height: 676 };
      return { x: Math.max(0, r.left), y: Math.max(0, r.top), width: r.width, height: r.height };
    })()`);

    let fIdx = 0;
    const snapModal = async () => {
      const { data } = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 1 },
      });
      fs.writeFileSync(path.join(dir, `f_${String(fIdx++).padStart(4, '0')}.png`), Buffer.from(data, 'base64'));
    };

    for (let i = 0; i < 20; i++) await snapModal();
    for (let i = 1; i <= 22; i++) {
      const e = easeInOutCubic(i / 22);
      const sc = 1 + 0.45 * e;
      await cdp.evalJs(`(() => {
        const el = document.querySelector('.exp-preview svg, .exp-stage svg, .exp-canvas svg');
        if (el) { el.style.transformOrigin = '46% 52%'; el.style.transform = 'scale(${sc.toFixed(4)})'; }
      })()`);
      await snapModal();
    }
    for (let i = 0; i < 22; i++) await snapModal();
    for (let i = 1; i <= 16; i++) {
      const e = 1 - easeInOutCubic(i / 16);
      const sc = 1 + 0.45 * e;
      await cdp.evalJs(`(() => {
        const el = document.querySelector('.exp-preview svg, .exp-stage svg, .exp-canvas svg');
        if (el) el.style.transform = 'scale(${sc.toFixed(4)})';
      })()`);
      await snapModal();
    }
    // Switch to Lab Report
    await cdp.evalJs(`(() => {
      const btns = [...document.querySelectorAll('.exp-tabs button, .exp-nav button, [data-tab]')];
      btns.find(b => /lab report/i.test(b.textContent))?.click();
    })()`);
    await sleep(350);
    for (let i = 0; i < 32; i++) await snapModal();
    encodeClip(dir, 'clip-export-studio', { crf: 21, width: 1120, posterFrame: 46 });
  }

  await cdp.close();
  console.log('\n🎉 Recording Studio Suite complete! 18 transparent sprites + 10 choreographed clips ready in assets/studio/!');
} finally {
  chrome.kill();
}

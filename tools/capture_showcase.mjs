/**
 * CircuitForge Studio — Showcase Animation Suite
 *
 * Captures graceful, choreographed 24fps H.264 MP4 loops + crisp WebP posters
 * directly from the live CircuitForge Studio workbench:
 *   - Runs Tidy Wires (#btn-tidy) on every board before recording (including 14-board SAP-1!)
 *   - Uses smooth cubic-eased native canvas zoom into key hardware areas (100% vector-sharp)
 *   - Drives live interactive controls (buttons, simulation, Export Studio tabs)
 *
 * Usage:
 *   PORT=4173 node tools/serve.mjs   # in one terminal
 *   node tools/capture_showcase.mjs  # captures into assets/demos/
 */

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const BASE_URL = process.env.SHOWCASE_URL || 'http://localhost:4173';
const OUT_DIR = path.join(ROOT, 'assets', 'demos');
const TMP_DIR = path.join(os.tmpdir(), 'circuitforge-showcase-frames');
const PORT = 9241;
const FPS = 24;
const VW = 1280;
const VH = 748;

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => fs.existsSync(p));

const FFMPEG = fs.existsSync('C:\\ffmpeg\\bin\\ffmpeg.exe') ? 'C:\\ffmpeg\\bin\\ffmpeg.exe' : 'ffmpeg';

if (!CHROME) throw new Error('Could not find Chrome or Edge binary');

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.rmSync(TMP_DIR, { recursive: true, force: true });
fs.mkdirSync(TMP_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
  }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', rej, { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evalJs(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    return r.result?.value;
  }
  close() { this.ws?.close(); }
}

async function waitForDevTools(port, timeoutMs = 12000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(150);
  }
  throw new Error('Timed out waiting for Chrome DevTools');
}

// Native canvas wheel zoom (editor.js: f = Math.exp(-dy * 0.002))
async function wheelZoomStep(cdp, clientX, clientY, factor) {
  if (Math.abs(factor - 1) < 1e-5) return;
  const dy = -Math.log(factor) / 0.002;
  await cdp.evalJs(`(() => {
    const cv = document.getElementById('canvas');
    if (!cv) return;
    cv.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true, cancelable: true,
      clientX: ${clientX.toFixed(1)}, clientY: ${clientY.toFixed(1)},
      deltaY: ${dy.toFixed(4)}, deltaMode: 0
    }));
  })()`);
}

class FrameRecorder {
  constructor(cdp, name) {
    this.cdp = cdp;
    this.name = name;
    this.dir = path.join(TMP_DIR, name);
    fs.mkdirSync(this.dir, { recursive: true });
    this.idx = 0;
  }
  async snap(waitMs = 36) {
    const { data } = await this.cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(this.dir, `f_${String(this.idx++).padStart(4, '0')}.png`), Buffer.from(data, 'base64'));
    if (waitMs > 0) await sleep(waitMs);
  }
  async hold(frames, waitMs = 38) {
    for (let i = 0; i < frames; i++) await this.snap(waitMs);
  }
  async smoothZoom(clientX, clientY, targetFactor, frames, waitMs = 34) {
    let prevScale = 1;
    for (let i = 1; i <= frames; i++) {
      const e = easeInOutCubic(i / frames);
      const nextScale = Math.pow(targetFactor, e);
      const stepFactor = nextScale / prevScale;
      prevScale = nextScale;
      await wheelZoomStep(this.cdp, clientX, clientY, stepFactor);
      await this.snap(waitMs);
    }
  }
  encode(posterFrameIdx = 0) {
    const pattern = path.join(this.dir, 'f_%04d.png');
    const mp4 = path.join(OUT_DIR, `${this.name}.mp4`);
    const webp = path.join(OUT_DIR, `${this.name}.webp`);

    // Silky-smooth H.264 MP4 (high quality, tiny footprint, universal autoplay muted loop)
    execFileSync(FFMPEG, [
      '-y', '-framerate', String(FPS), '-i', pattern,
      '-vf', 'scale=1280:-2:flags=lanczos',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '21',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an',
      mp4,
    ], { stdio: 'ignore' });

    // Crisp poster WebP from chosen hero frame
    const clampedIdx = Math.min(posterFrameIdx, Math.max(0, this.idx - 1));
    const posterSrc = path.join(this.dir, `f_${String(clampedIdx).padStart(4, '0')}.png`);
    execFileSync(FFMPEG, [
      '-y', '-i', posterSrc,
      '-vf', 'scale=1280:-2:flags=lanczos',
      '-c:v', 'libwebp', '-quality', '86',
      webp,
    ], { stdio: 'ignore' });

    const mp4Kb = (fs.statSync(mp4).size / 1024).toFixed(1);
    const webpKb = (fs.statSync(webp).size / 1024).toFixed(1);
    console.log(`✅ ${this.name}.mp4 (${mp4Kb} KB, ${this.idx} frames @ ${FPS}fps) + ${this.name}.webp (${webpKb} KB)`);
  }
}

async function prepCircuit(cdp, exampleQuery, opts = {}) {
  await cdp.send('Page.navigate', { url: `${BASE_URL}/studio?example=${encodeURIComponent(exampleQuery)}` });
  await sleep(1100);
  await cdp.evalJs(`(() => {
    if (document.documentElement.dataset.theme !== 'dark') document.getElementById('btn-theme')?.click();
    const toast = document.getElementById('toast');
    if (toast) toast.style.display = 'none';
  })()`);
  await sleep(180);

  if (opts.hideLibrary) {
    await cdp.evalJs(`if (!document.body.classList.contains('no-library')) document.getElementById('btn-library')?.click();`);
  } else {
    await cdp.evalJs(`if (document.body.classList.contains('no-library')) document.getElementById('btn-library')?.click();`);
  }
  if (opts.hideInspector) {
    await cdp.evalJs(`if (!document.body.classList.contains('no-inspector')) document.getElementById('btn-panel')?.click();`);
  } else {
    await cdp.evalJs(`if (document.body.classList.contains('no-inspector')) document.getElementById('btn-panel')?.click();`);
  }
  await sleep(150);

  // Run Tidy Wires in Build mode so jumpers are clean and orthogonal!
  if (opts.tidy !== false) {
    const t0 = Date.now();
    await cdp.evalJs(`document.getElementById('btn-tidy')?.click();`);
    await sleep(opts.tidyWaitMs || 350);
    console.log(`   🧹 Tidy wires complete (${Date.now() - t0} ms)`);
  }

  if (opts.labels) {
    await cdp.evalJs(`document.querySelector('#lbl-bar button[data-lbl="${opts.labels}"]')?.click();`);
  }
  await sleep(140);
  await cdp.evalJs(`document.getElementById('zoom-fit')?.click();`);
  await sleep(240);
}

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${path.join(TMP_DIR, 'profile')}`,
  '--headless=new',
  '--disable-gpu',
  `--window-size=${VW},${VH}`,
  '--hide-scrollbars',
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank',
], { stdio: 'ignore' });

try {
  const cdp = new CDP(await waitForDevTools(PORT));
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: VW, height: VH, deviceScaleFactor: 1, mobile: false,
  });

  // =========================================================================
  // 1. showcase-breadboard: Tidy 74LS93 Binary Counter + smooth zoom into IC & LED bar
  // =========================================================================
  console.log('\n🎬 [1/4] Capturing showcase-breadboard (Tidy 74LS93 Binary Counter + smooth zoom)...');
  await prepCircuit(cdp, 'counter', { hideLibrary: false, hideInspector: false, labels: 'refs', tidy: true });
  await cdp.evalJs(`document.getElementById('mode-sim')?.click();`);
  await sleep(300);

  const rec1 = new FrameRecorder(cdp, 'showcase-breadboard');
  // Stage center-right where 74LS93 + yellow LED bargraph sit (~640px, 435px in 1280x748)
  await rec1.hold(20, 36);
  await rec1.smoothZoom(665, 438, 1.92, 26, 30);
  await rec1.hold(42, 36);
  await rec1.smoothZoom(665, 438, 1 / 1.92, 24, 30);
  await rec1.hold(14, 36);
  rec1.encode(46);

  // =========================================================================
  // 2. showcase-sap1: TIDY-WIRED 14-Board 8-Bit SAP-1 CPU + smooth zoom into 7-seg Output & Bus
  // =========================================================================
  console.log('\n🎬 [2/4] Capturing showcase-sap1 (Tidy 14-Board 8-Bit SAP-1 CPU + smooth zoom)...');
  await prepCircuit(cdp, 'powers', { hideLibrary: true, hideInspector: true, labels: 'off', tidy: true, tidyWaitMs: 900 });
  await cdp.evalJs(`
    const spd = document.getElementById('speed');
    if (spd) { spd.value = '2'; spd.dispatchEvent(new Event('change')); }
    document.getElementById('mode-sim')?.click();
  `);
  await sleep(450);

  // Locate exact glowing red 7-segment display centroid on SAP-1 right column (board 5 right)
  const sapTarget = await cdp.evalJs(`(() => {
    const c = document.getElementById('canvas');
    const r = c.getBoundingClientRect();
    const ctx = c.getContext('2d');
    const dpr = c.width / r.width;
    const img = ctx.getImageData(0, 0, c.width, c.height).data;
    // Output 7-segment dark housing sits on right half, lower-middle (~x: 60..72%, y: 58..72%)
    // Look for bright red/orange 7-seg glow pixels there
    let sx = 0, sy = 0, n = 0;
    for (let y = Math.floor(c.height * 0.54); y < Math.floor(c.height * 0.72); y += 2) {
      for (let x = Math.floor(c.width * 0.60); x < Math.floor(c.width * 0.74); x += 2) {
        const i = (y * c.width + x) * 4;
        const R = img[i], G = img[i + 1], B = img[i + 2];
        if (R > 190 && G < 95 && B < 95) { sx += x; sy += y; n++; }
      }
    }
    if (n > 8) return { x: r.left + (sx / n) / dpr, y: r.top + (sy / n) / dpr, n };
    return { x: r.left + r.width * 0.65, y: r.top + r.height * 0.64, n: 0 };
  })()`);
  console.log('   🎯 SAP-1 Output Display focal point:', sapTarget);

  const rec2 = new FrameRecorder(cdp, 'showcase-sap1');
  await rec2.hold(22, 36);
  await rec2.smoothZoom(sapTarget.x, sapTarget.y, 2.75, 28, 32);
  await rec2.hold(46, 38);
  await rec2.smoothZoom(sapTarget.x, sapTarget.y, 1 / 2.75, 26, 32);
  await rec2.hold(16, 36);
  rec2.encode(50);

  // =========================================================================
  // 3. showcase-instruments: Tidy RC Charge & Discharge + REAL live button press + Logic Analyzer curve
  // =========================================================================
  console.log('\n🎬 [3/4] Capturing showcase-instruments (RC curve + live CHARGE button press + Logic Analyzer)...');
  await prepCircuit(cdp, 'rc', { hideLibrary: false, hideInspector: true, labels: 'values', tidy: true });
  await cdp.evalJs(`document.getElementById('mode-sim')?.click();`);
  await sleep(350);

  // Scan specifically for the WHITE square housing of the CHARGE pushbutton BELOW the breadboard
  const rcBtn = await cdp.evalJs(`(() => {
    const c = document.getElementById('canvas');
    const r = c.getBoundingClientRect();
    const ctx = c.getContext('2d');
    const dpr = c.width / r.width;
    const img = ctx.getImageData(0, 0, c.width, c.height).data;
    // Find bottom edge of main white breadboard first (scan vertical center-right column)
    const probeX = Math.floor(c.width * 0.62);
    let boardBottomY = Math.floor(c.height * 0.72);
    for (let y = c.height - 10; y > Math.floor(c.height * 0.35); y--) {
      const i = (y * c.width + probeX) * 4;
      if (img[i] > 215 && img[i + 1] > 215 && img[i + 2] > 215) { boardBottomY = y; break; }
    }
    // Now find the blue circle cap strictly BELOW boardBottomY + 8px!
    let sx = 0, sy = 0, n = 0;
    for (let y = boardBottomY + 8; y < c.height - 4; y++) {
      for (let x = Math.floor(c.width * 0.15); x < Math.floor(c.width * 0.65); x++) {
        const i = (y * c.width + x) * 4;
        const R = img[i], G = img[i + 1], B = img[i + 2];
        if (B > 185 && R < 95 && G > 85 && G < 195) { sx += x; sy += y; n++; }
      }
    }
    return {
      x: n > 5 ? r.left + (sx / n) / dpr : r.left + r.width * 0.42,
      y: n > 5 ? r.top + (sy / n) / dpr : r.top + (boardBottomY + 46) / dpr,
      boardBottomY, n
    };
  })()`);
  console.log('   🎯 CHARGE pushbutton center:', rcBtn);

  const rec3 = new FrameRecorder(cdp, 'showcase-instruments');
  await rec3.hold(10, 38);
  // Press & hold CHARGE button -> watch exponential capacitor voltage rise & green LED glow!
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rcBtn.x, y: rcBtn.y, button: 'left', clickCount: 1 });
  await rec3.hold(34, 40);
  // Release CHARGE button -> watch smooth RC discharge curve & LED fade!
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rcBtn.x, y: rcBtn.y, button: 'left', clickCount: 1 });
  await rec3.hold(36, 40);
  // Second brief pulse so loop stays lively
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rcBtn.x, y: rcBtn.y, button: 'left', clickCount: 1 });
  await rec3.hold(22, 40);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rcBtn.x, y: rcBtn.y, button: 'left', clickCount: 1 });
  await rec3.hold(18, 40);
  rec3.encode(42);

  // =========================================================================
  // 4. showcase-export: Export Studio — IEEE Schematic smooth zoom -> A4 Lab Report -> Breadboard
  // =========================================================================
  console.log('\n🎬 [4/4] Capturing showcase-export (Export Studio IEEE Schematic zoom + Lab Report)...');
  await prepCircuit(cdp, '555', { hideLibrary: false, hideInspector: false, labels: 'refs', tidy: true });
  await cdp.evalJs(`document.getElementById('btn-export')?.click();`);
  await sleep(500);
  // Switch directly to Schematic tab first so hero opens on the clean IEEE vector schematic!
  await cdp.evalJs(`(() => {
    const btns = [...document.querySelectorAll('.exp-tabs button, .exp-nav button, [data-tab]')];
    const sch = btns.find(b => /schematic/i.test(b.textContent));
    if (sch) sch.click();
  })()`);
  await sleep(450);

  const rec4 = new FrameRecorder(cdp, 'showcase-export');
  await rec4.hold(24, 38);
  // Smoothly zoom the schematic SVG preview inside Export Studio using CSS transform on preview wrapper
  for (let i = 1; i <= 22; i++) {
    const e = easeInOutCubic(i / 22);
    const sc = 1 + 0.42 * e;
    const tx = 8 * e;
    const ty = -4 * e;
    await cdp.evalJs(`(() => {
      const el = document.querySelector('.exp-preview svg, .exp-stage svg, .exp-canvas svg');
      if (el) { el.style.transformOrigin = '52% 52%'; el.style.transform = 'scale(${sc.toFixed(4)}) translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px)'; }
    })()`);
    await rec4.snap(32);
  }
  await rec4.hold(24, 38);
  // Ease back to 1.0x
  for (let i = 1; i <= 18; i++) {
    const e = 1 - easeInOutCubic(i / 18);
    const sc = 1 + 0.42 * e;
    const tx = 8 * e;
    const ty = -4 * e;
    await cdp.evalJs(`(() => {
      const el = document.querySelector('.exp-preview svg, .exp-stage svg, .exp-canvas svg');
      if (el) { el.style.transform = 'scale(${sc.toFixed(4)}) translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px)'; }
    })()`);
    await rec4.snap(30);
  }
  await rec4.hold(8, 36);
  // Switch to Lab Report tab
  await cdp.evalJs(`(() => {
    const btns = [...document.querySelectorAll('.exp-tabs button, .exp-nav button, [data-tab]')];
    const rep = btns.find(b => /lab report/i.test(b.textContent));
    if (rep) rep.click();
  })()`);
  await sleep(350);
  await rec4.hold(34, 38);
  rec4.encode(46);

  await cdp.close();
  console.log('\n🎉 All 4 choreographed showcase videos & WebP posters generated in assets/demos/!');
} finally {
  chrome.kill();
}

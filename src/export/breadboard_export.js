/**
 * Auto-cropped High-DPI Breadboard Diagram Exporter (PNG, Clipboard & Vector-Framed SVG).
 * Reuses Renderer so all 50+ parts, LEDs, MCU screens & wires match live studio fidelity.
 */
import { P } from '../model.js';
import { Renderer } from '../view/renderer.js';
import { computeLabelPlacements } from './labels.js';
import { isAnnotationType } from './designators.js';

const BG_MAP = {
  white: { bg: '#ffffff', dark: false, fg: '#0f172a', sub: '#475569', line: '#cbd5e1', footBg: '#f8fafc' },
  paper: { bg: '#faf6ed', dark: false, fg: '#1c1917', sub: '#57534e', line: '#d6d3cd', footBg: '#f3ede0' },
  blueprint: { bg: '#0c1b2e', dark: true, fg: '#e0f2fe', sub: '#7dd3fc', line: 'rgba(125,211,252,0.35)', footBg: '#091525' },
  transparent: { bg: 'transparent', dark: false, fg: '#0f172a', sub: '#475569', line: '#94a3b8', footBg: 'rgba(255,255,255,0.88)' },
};

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function computeExportBounds(circuit, labelMode = 'refs') {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const growPx = (ax, ay, bx, by) => {
    x0 = Math.min(x0, ax); y0 = Math.min(y0, ay);
    x1 = Math.max(x1, bx); y1 = Math.max(y1, by);
  };
  for (const b of circuit.boards || []) {
    growPx(b.x * P, b.y * P, (b.x + b.w) * P, (b.y + b.h) * P);
  }
  for (const p of circuit.parts || []) {
    const bb = p.bounds();
    growPx(bb.x0 * P, bb.y0 * P, bb.x1 * P, bb.y1 * P);
  }
  for (const w of circuit.wires || []) {
    for (const pt of w.path()) growPx(pt.x * P - 6, pt.y * P - 6, pt.x * P + 6, pt.y * P + 6);
  }
  const { partLabels, wireLabels, pinNumBoxes } = computeLabelPlacements(circuit, labelMode);
  for (const it of [...partLabels, ...wireLabels, ...pinNumBoxes]) {
    growPx(it.x0 - 4, it.y0 - 4, it.x1 + 4, it.y1 + 4);
  }
  if (!Number.isFinite(x0)) return { x0: 0, y0: 0, x1: 600, y1: 400, w: 600, h: 400 };
  return { x0, y0, x1, y1, w: Math.max(120, x1 - x0), h: Math.max(80, y1 - y0) };
}

function resolvePalette(app, background) {
  if (background === 'theme') {
    const dark = document?.documentElement?.dataset?.theme === 'dark';
    return dark
      ? { bg: '#16181d', dark: true, fg: '#f1f5f9', sub: '#94a3b8', line: '#334155', footBg: '#1e2028' }
      : BG_MAP.white;
  }
  return BG_MAP[background] || BG_MAP.white;
}

export function computeExportLayout(app, opts = {}) {
  const pad = opts.padding ?? 28;
  const bounds = computeExportBounds(app.circuit, opts.labelMode || 'off');
  const minW = (opts.showTitleBlock && opts.showLegend) ? 620 : (opts.showTitleBlock || opts.showLegend) ? 540 : 120;
  const contentW = Math.max(minW, Math.ceil(bounds.w + pad * 2));
  const contentH = Math.ceil(bounds.h + pad * 2);
  const footerH = (opts.showTitleBlock || opts.showLegend) ? 62 : 0;
  const framePad = opts.showFrame !== false ? 10 : 0;
  const totalW = contentW + framePad * 2;
  const totalH = contentH + footerH + framePad * 2;
  return { bounds, pad, framePad, contentW, contentH, footerH, totalW, totalH };
}

export function renderBreadboardCanvas(app, opts = {}) {
  const {
    scale = 2,
    background = 'white',
    grid = 'plain',
    stateMode = app.mode,
    labelMode = app.settings.get('labelMode') || 'off',
    showFrame = true,
    showTitleBlock = true,
    showLegend = stateMode === 'sim',
    drawWarnings = false,
    padding = 28,
  } = opts;

  const pal = resolvePalette(app, background);
  const lay = computeExportLayout(app, { padding, labelMode, showFrame, showTitleBlock, showLegend });
  const maxDim = Math.max(lay.totalW, lay.totalH);
  const effScale = Math.min(scale, 8192 / Math.max(1, maxDim));

  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(lay.totalW * effScale));
  cv.height = Math.max(1, Math.round(lay.totalH * effScale));
  const g = cv.getContext('2d');

  // 1. Background across whole sheet
  g.save();
  g.setTransform(effScale, 0, 0, effScale, 0, 0);
  if (pal.bg === 'transparent') g.clearRect(0, 0, lay.totalW, lay.totalH);
  else { g.fillStyle = pal.bg; g.fillRect(0, 0, lay.totalW, lay.totalH); }
  g.restore();

  // 2. Render breadboard scene clipped cleanly inside the viewport region above footer
  const fakeSettings = {
    get: (k) => (k === 'canvas' ? grid : k === 'labelMode' ? labelMode : app.settings.get(k)),
  };
  const fakeApp = {
    circuit: app.circuit,
    engine: app.engine,
    editor: app.editor,
    settings: fakeSettings,
    mode: stateMode,
    effects: [],
    allIssues: () => [],
    cam: {
      x: lay.framePad + (lay.contentW - lay.bounds.w) / 2 - lay.bounds.x0,
      y: lay.framePad + lay.pad - lay.bounds.y0,
      z: 1,
    },
  };

  g.save();
  g.beginPath();
  g.rect(lay.framePad * effScale, lay.framePad * effScale, lay.contentW * effScale, lay.contentH * effScale);
  g.clip();
  const r = new Renderer(fakeApp, cv);
  r.draw({
    cam: fakeApp.cam,
    dark: pal.dark,
    w: lay.totalW,
    h: lay.framePad + lay.contentH,
    dpr: effScale,
    background: pal.bg,
    drawGrid: grid !== 'plain',
    hideSelection: true,
    live: stateMode === 'sim',
    labelMode,
    drawWarnings,
  });
  g.restore();

  // 3. Crisp engineering border frame & footer legend / title block
  g.save();
  g.setTransform(effScale, 0, 0, effScale, 0, 0);
  const fx = lay.framePad, fy = lay.framePad, fw = lay.contentW, fh = lay.contentH + lay.footerH;
  if (showFrame) {
    g.strokeStyle = pal.line;
    g.lineWidth = 1.25;
    g.strokeRect(fx + 0.5, fy + 0.5, fw - 1, fh - 1);
  }

  if (lay.footerH > 0) {
    const footY = fy + lay.contentH;
    g.fillStyle = pal.footBg;
    g.fillRect(fx + 1, footY, fw - 2, lay.footerH - 1);
    g.strokeStyle = pal.line;
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(fx, footY + 0.5); g.lineTo(fx + fw, footY + 0.5); g.stroke();

    if (showLegend) {
      drawCanvasLegend(g, fx + 14, footY + 14, stateMode, pal);
    }
    if (showTitleBlock) {
      drawCanvasTitleBlock(g, fx + fw - 290, footY, 290, lay.footerH, app.circuit, pal);
    }
  }
  g.restore();

  return { canvas: cv, width: cv.width, height: cv.height, cssW: lay.totalW, cssH: lay.totalH, scale: effScale };
}

function drawCanvasLegend(g, x, y, stateMode, pal) {
  g.save();
  g.font = '700 9.5px -apple-system, Inter, sans-serif';
  g.fillStyle = pal.sub;
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  g.fillText(stateMode === 'sim' ? 'LOGIC STATE & WIRE KEY' : 'WIRE KEY', x, y);

  const items = stateMode === 'sim'
    ? [['#ff453a', 'HIGH (≥2V)'], ['#0a84ff', 'LOW (≤0.8V)'], ['#ff9f0a', 'Mid'], ['#8e8e93', 'Float']]
    : [['#e5484d', '+5V / Pos'], ['#2b2d31', 'GND / Neg'], ['#0a84ff', 'Signal']];
  let cx = x;
  const cy = y + 20;
  g.font = '600 9.5px -apple-system, Inter, sans-serif';
  for (const [col, lbl] of items) {
    g.fillStyle = col;
    g.beginPath(); g.roundRect(cx, cy - 2.5, 11, 5, 2.5); g.fill();
    cx += 15;
    g.fillStyle = pal.fg;
    g.fillText(lbl, cx, cy + 0.5);
    cx += g.measureText(lbl).width + 10;
  }
  g.restore();
}

function drawCanvasTitleBlock(g, x, y, w, h, circuit, pal) {
  g.save();
  g.strokeStyle = pal.line;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(x + 0.5, y); g.lineTo(x + 0.5, y + h);
  g.moveTo(x, y + 32.5); g.lineTo(x + w, y + 32.5);
  g.moveTo(x + w - 95.5, y + 32.5); g.lineTo(x + w - 95.5, y + h);
  g.stroke();

  g.textAlign = 'left'; g.textBaseline = 'middle';
  const title = circuit.name || 'Untitled Circuit';
  g.font = '700 12.5px -apple-system, Inter, sans-serif';
  g.fillStyle = pal.fg;
  g.fillText(title, x + 10, y + 16, w - 20);

  const meta = circuit.meta || {};
  const subParts = [meta.project, meta.author ? `By ${meta.author}` : ''].filter(Boolean);
  const electricalCount = (circuit.parts || []).filter(p => !isAnnotationType(p.type)).length;
  const sub = subParts.length ? subParts.join(' · ') : `${electricalCount} parts · ${(circuit.wires || []).length} wires`;
  g.font = '500 10px -apple-system, Inter, sans-serif';
  g.fillStyle = pal.sub;
  g.fillText(sub, x + 10, y + 47, w - 108);

  const dateStr = new Date().toISOString().slice(0, 10);
  g.font = '600 9.5px "SF Mono", ui-monospace, Menlo, monospace';
  g.fillStyle = pal.sub;
  g.fillText(`Rev ${meta.revision || '1.0'}`, x + w - 86, y + 41);
  g.fillText(dateStr, x + w - 86, y + 53);
  g.restore();
}

export function canvasToBlob(canvas, type = 'image/png') {
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Canvas encode failed'))), type);
  });
}

export function safeFileBase(name) {
  return String(name || 'circuit').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'circuit';
}

export function triggerDownload(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

export async function exportBreadboardPNG(app, opts = {}) {
  const { canvas } = renderBreadboardCanvas(app, opts);
  const blob = await canvasToBlob(canvas, 'image/png');
  triggerDownload(blob, `${safeFileBase(app.circuit.name)}-breadboard.png`);
  return { blob, width: canvas.width, height: canvas.height };
}

export async function copyBreadboardPNG(app, opts = {}) {
  const { canvas } = renderBreadboardCanvas(app, opts);
  const blob = await canvasToBlob(canvas, 'image/png');
  if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
    throw new Error('Clipboard image copy is not supported in this browser context.');
  }
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  return { width: canvas.width, height: canvas.height };
}

/**
 * Vector-framed hybrid SVG: high-DPI crisp breadboard image + pure SVG frame,
 * selectable title block & wire legend text.
 */
export function buildBreadboardSVG(app, opts = {}) {
  const {
    scale = 2,
    background = 'white',
    grid = 'plain',
    stateMode = app.mode,
    labelMode = app.settings.get('labelMode') || 'off',
    showFrame = true,
    showTitleBlock = true,
    showLegend = stateMode === 'sim',
    padding = 28,
  } = opts;
  const pal = resolvePalette(app, background);
  const lay = computeExportLayout(app, { padding, labelMode, showFrame, showTitleBlock, showLegend });

  // Render breadboard interior ONLY (no canvas footer) cleanly at high DPI
  const innerRes = renderBreadboardCanvas(app, {
    ...opts,
    scale,
    showFrame: false,
    showTitleBlock: false,
    showLegend: false,
  });
  const dataUrl = innerRes.canvas.toDataURL('image/png');

  const fx = lay.framePad, fy = lay.framePad, fw = lay.contentW, fh = lay.contentH + lay.footerH;
  const meta = app.circuit.meta || {};
  const electricalCount = (app.circuit.parts || []).filter(p => !isAnnotationType(p.type)).length;
  const sub = [meta.project, meta.author ? `By ${meta.author}` : ''].filter(Boolean).join(' · ') || `${electricalCount} parts · ${(app.circuit.wires || []).length} wires`;
  const dateStr = new Date().toISOString().slice(0, 10);

  const svgParts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${lay.totalW} ${lay.totalH}" width="${lay.totalW}" height="${lay.totalH}" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Text', Inter, sans-serif">`,
  ];
  if (pal.bg !== 'transparent') {
    svgParts.push(`  <rect width="${lay.totalW}" height="${lay.totalH}" fill="${esc(pal.bg)}"/>`);
  }
  const imgX = fx + (fw - innerRes.cssW) / 2;
  svgParts.push(`  <image href="${dataUrl}" x="${imgX}" y="${fy}" width="${innerRes.cssW}" height="${innerRes.cssH}"/>`);

  if (lay.footerH > 0) {
    const footY = fy + lay.contentH;
    svgParts.push(`  <rect x="${fx}" y="${footY}" width="${fw}" height="${lay.footerH}" fill="${esc(pal.footBg)}"/>`);
    svgParts.push(`  <line x1="${fx}" y1="${footY}" x2="${fx + fw}" y2="${footY}" stroke="${esc(pal.line)}" stroke-width="1"/>`);
    if (showLegend) {
      const items = stateMode === 'sim'
        ? [['#ff453a', 'HIGH'], ['#0a84ff', 'LOW'], ['#ff9f0a', 'Mid'], ['#8e8e93', 'Float']]
        : [['#e5484d', '+5V / Pos'], ['#2b2d31', 'GND'], ['#0a84ff', 'Signal']];
      let lx = fx + 14;
      svgParts.push(`  <text x="${lx}" y="${footY + 18}" font-size="9.5" font-weight="700" fill="${esc(pal.sub)}">${stateMode === 'sim' ? 'LOGIC STATE &amp; WIRE KEY' : 'WIRE KEY'}</text>`);
      for (const [col, lbl] of items) {
        svgParts.push(`  <rect x="${lx}" y="${footY + 32}" width="14" height="5" rx="2.5" fill="${col}"/>`);
        svgParts.push(`  <text x="${lx + 18}" y="${footY + 38}" font-size="10" font-weight="600" fill="${esc(pal.fg)}">${esc(lbl)}</text>`);
        lx += 28 + lbl.length * 6.2;
      }
    }
    if (showTitleBlock) {
      const tx = fx + fw - 310;
      svgParts.push(`  <line x1="${tx}" y1="${footY}" x2="${tx}" y2="${footY + lay.footerH}" stroke="${esc(pal.line)}" stroke-width="1"/>`);
      svgParts.push(`  <line x1="${tx}" y1="${footY + 32}" x2="${fx + fw}" y2="${footY + 32}" stroke="${esc(pal.line)}" stroke-width="1"/>`);
      svgParts.push(`  <line x1="${fx + fw - 95}" y1="${footY + 32}" x2="${fx + fw - 95}" y2="${footY + lay.footerH}" stroke="${esc(pal.line)}" stroke-width="1"/>`);
      svgParts.push(`  <text x="${tx + 10}" y="${footY + 20}" font-size="12.5" font-weight="700" fill="${esc(pal.fg)}">${esc(app.circuit.name || 'Untitled Circuit')}</text>`);
      svgParts.push(`  <text x="${tx + 10}" y="${footY + 50}" font-size="10" fill="${esc(pal.sub)}">${esc(sub)}</text>`);
      svgParts.push(`  <text x="${fx + fw - 86}" y="${footY + 44}" font-size="9" font-family="'SF Mono', ui-monospace, Menlo, monospace" fill="${esc(pal.sub)}">Rev ${esc(meta.revision || '1.0')}</text>`);
      svgParts.push(`  <text x="${fx + fw - 86}" y="${footY + 56}" font-size="9" font-family="'SF Mono', ui-monospace, Menlo, monospace" fill="${esc(pal.sub)}">${dateStr}</text>`);
    }
  }
  if (showFrame) {
    svgParts.push(`  <rect x="${fx}" y="${fy}" width="${fw}" height="${fh}" fill="none" stroke="${esc(pal.line)}" stroke-width="1.25"/>`);
  }
  svgParts.push('</svg>');
  return svgParts.join('\n');
}

export function exportBreadboardSVG(app, opts = {}) {
  const svg = buildBreadboardSVG(app, opts);
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  triggerDownload(blob, `${safeFileBase(app.circuit.name)}-breadboard.svg`);
  return svg;
}

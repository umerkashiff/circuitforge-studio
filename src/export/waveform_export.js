/**
 * Vector SVG & CSV Waveform / Instrument Exporters:
 *  - Built-in Logic Analyzer (circuit.probes + app.samples): Vector SVG, 2x PNG, UTF-8 CSV
 *  - Placed 8-channel Logic Analyzer IC/module (`wokwi-logic-analyzer`): CSV
 *  - UT2062B Dual-Channel Oscilloscope: High-res PNG capture with stats & graticule
 */
import { computeScopeWindow, measureChannelStats, fmtUnits } from '../parts/library.js';
import { triggerDownload, safeFileBase, canvasToBlob } from './breadboard_export.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function vState(v) {
  if (v === undefined || v === null || Number.isNaN(v)) return 'FLOAT';
  if (v >= 2.0) return 'HIGH';
  if (v <= 0.8) return 'LOW';
  return 'MID';
}

function sampleHoldAt(buf, t) {
  if (!buf || !buf.t.length) return NaN;
  const ts = buf.t, vs = buf.v;
  if (t < ts[0]) return NaN;
  let lo = 0, hi = ts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] <= t) lo = mid + 1; else hi = mid - 1;
  }
  return hi >= 0 ? vs[hi] : NaN;
}

/**
 * Serialize Logic Analyzer probe traces into clean sample-and-hold UTF-8 CSV.
 */
export function buildAnalyzerCSV(circuit, samples, simTime = 0, opts = {}) {
  const probes = circuit.probes || [];
  if (!probes.length) return 'time_s\n';
  const windowOnly = opts.scope === 'window' && Number.isFinite(opts.windowSec);
  const t1 = simTime;
  const t0 = windowOnly ? Math.max(0, t1 - opts.windowSec) : 0;

  const timesSet = new Set();
  for (const pr of probes) {
    const buf = samples?.get(pr.id);
    if (!buf) continue;
    for (const t of buf.t) {
      if (!windowOnly || (t >= t0 && t <= t1)) timesSet.add(+t.toFixed(6));
    }
  }
  if (windowOnly) { timesSet.add(+t0.toFixed(6)); timesSet.add(+t1.toFixed(6)); }
  const times = [...timesSet].sort((a, b) => a - b);

  const header = ['time_s'];
  for (const pr of probes) {
    header.push(`${pr.name} (V)`, `${pr.name} (State)`);
  }
  const csvRow = (arr) => arr.map(v => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',');

  const lines = [csvRow(header)];
  for (const t of times) {
    const row = [t.toFixed(6)];
    for (const pr of probes) {
      const buf = samples?.get(pr.id);
      const v = sampleHoldAt(buf, t);
      row.push(Number.isNaN(v) ? '' : v.toFixed(3), vState(v));
    }
    lines.push(csvRow(row));
  }
  return lines.join('\n') + '\n';
}

export function buildHardwareLogicAnalyzerCSV(part, dev) {
  const hist = dev?.history || [];
  const header = 'time_s,D0,D1,D2,D3,D4,D5,D6,D7';
  const rows = [header];
  for (const h of hist) {
    rows.push([Number(h.t).toFixed(6), ...(h.levels || [0, 0, 0, 0, 0, 0, 0, 0])].join(','));
  }
  return rows.join('\n') + '\n';
}

/**
 * Pure vector SVG Logic Analyzer timing diagram matching live UI stepped/analog waves.
 */
export function renderAnalyzerSVG(circuit, samples, simTime = 0, windowSec = 2, opts = {}) {
  const probes = circuit.probes || [];
  const theme = opts.theme === 'dark' ? 'dark' : 'light';
  const W = opts.width || 900;
  const headerW = 165;
  const plotW = W - headerW - 18;
  const headH = opts.compact ? 28 : 44;
  const laneH = 38;
  const axisH = 26;
  const rowsH = Math.max(1, probes.length) * laneH;
  const H = headH + rowsH + axisH;

  const pal = theme === 'dark'
    ? { bg: '#16181f', panel: '#1e212b', fg: '#f1f5f9', sub: '#94a3b8', grid: 'rgba(255,255,255,0.08)', sep: 'rgba(255,255,255,0.12)' }
    : { bg: '#ffffff', panel: '#f8fafc', fg: '#0f172a', sub: '#64748b', grid: 'rgba(15,23,42,0.08)', sep: 'rgba(15,23,42,0.14)' };

  const t1 = Math.max(0, simTime);
  const t0 = t1 - windowSec;

  const out = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Text', Inter, sans-serif">`,
    `  <style>text{stroke:none;}</style>`,
    `  <rect width="${W}" height="${H}" fill="${pal.bg}"/>`,
  ];

  // Top bar
  const titleText = opts.title || `${circuit.name || 'Untitled Circuit'} — Logic Analyzer (${windowSec} s window)`;
  out.push(`  <rect width="${W}" height="${headH}" fill="${pal.panel}"/>`);
  out.push(`  <line x1="0" y1="${headH}" x2="${W}" y2="${headH}" stroke="${pal.sep}" stroke-width="1"/>`);
  out.push(`  <text x="14" y="${headH / 2 + 4}" font-size="12" font-weight="700" fill="${pal.fg}">${esc(titleText)}</text>`);
  out.push(`  <text x="${W - 14}" y="${headH / 2 + 4}" font-size="10.5" font-family="'SF Mono', ui-monospace, Menlo, monospace" text-anchor="end" fill="${pal.sub}">t = ${t1.toFixed(2)} s</text>`);

  // Header column background
  out.push(`  <rect x="0" y="${headH}" width="${headerW}" height="${rowsH}" fill="${pal.panel}"/>`);
  out.push(`  <line x1="${headerW}" y1="${headH}" x2="${headerW}" y2="${headH + rowsH}" stroke="${pal.sep}" stroke-width="1"/>`);

  // Vertical time grid
  for (let k = 0; k <= 10; k++) {
    const gx = headerW + (k / 10) * plotW;
    out.push(`  <line x1="${gx.toFixed(1)}" y1="${headH}" x2="${gx.toFixed(1)}" y2="${headH + rowsH}" stroke="${pal.grid}" stroke-width="1"/>`);
    if (k % 2 === 0) {
      const rel = -windowSec * (1 - k / 10);
      const lbl = Math.abs(rel) < 1e-3 ? `${t1.toFixed(1)}s` : `${rel >= 0 ? '+' : ''}${rel.toFixed(1)}s`;
      const anchor = k === 10 ? 'end' : k === 0 ? 'start' : 'middle';
      out.push(`  <text x="${gx.toFixed(1)}" y="${headH + rowsH + 16}" font-size="9.5" font-family="'SF Mono', ui-monospace, Menlo, monospace" text-anchor="${anchor}" fill="${pal.sub}">${lbl}</text>`);
    }
  }

  if (!probes.length) {
    out.push(`  <text x="${headerW + plotW / 2}" y="${headH + laneH / 2 + 4}" font-size="11.5" text-anchor="middle" fill="${pal.sub}">No channels probed</text>`);
  }

  probes.forEach((p, idx) => {
    const yTop = headH + idx * laneH;
    const yBot = yTop + laneH;
    out.push(`  <line x1="0" y1="${yBot}" x2="${headerW + plotW}" y2="${yBot}" stroke="${pal.grid}" stroke-width="1"/>`);
    out.push(`  <circle cx="14" cy="${yTop + laneH / 2}" r="4.5" fill="${esc(p.color || '#0a84ff')}"/>`);
    out.push(`  <text x="25" y="${yTop + laneH / 2 + 4}" font-size="11" font-weight="600" fill="${pal.fg}">${esc(String(p.name || '').slice(0, 18))}</text>`);
    out.push(`  <text x="${headerW - 8}" y="${yTop + laneH / 2 + 3.5}" font-size="9" font-family="'SF Mono', ui-monospace, Menlo, monospace" text-anchor="end" fill="${pal.sub}">${p.analog ? 'ANA' : 'DIG'}</text>`);

    const buf = samples?.get(p.id) || samples?.get(`${p.x},${p.y}`);
    if (!buf || !buf.t.length) return;
    const yHi = yTop + 9, yLo = yBot - 8;
    const yOf = (v) => (p.analog
      ? (Number.isNaN(v) ? yLo : yLo - Math.max(0, Math.min(1, v / 5)) * (yLo - yHi))
      : (Number.isNaN(v) ? (yHi + yLo) / 2 : v >= 2 ? yHi : v <= 0.8 ? yLo : (yHi + yLo) / 2));

    let kStart = 0;
    while (kStart < buf.t.length && buf.t[kStart] < t0) kStart++;
    const cmds = [];
    let lastY = 0, started = false;
    if (kStart > 0) {
      lastY = yOf(buf.v[kStart - 1]);
      cmds.push(`M ${headerW.toFixed(1)} ${lastY.toFixed(1)}`);
      started = true;
    }
    for (let k = kStart; k < buf.t.length; k++) {
      if (buf.t[k] > t1 + 1e-6) break;
      const x = headerW + ((buf.t[k] - t0) / windowSec) * plotW;
      const y = yOf(buf.v[k]);
      if (!started) { cmds.push(`M ${x.toFixed(1)} ${y.toFixed(1)}`); started = true; }
      else if (p.analog) { cmds.push(`L ${x.toFixed(1)} ${y.toFixed(1)}`); }
      else { cmds.push(`L ${x.toFixed(1)} ${lastY.toFixed(1)} L ${x.toFixed(1)} ${y.toFixed(1)}`); }
      lastY = y;
    }
    if (started) {
      cmds.push(`L ${(headerW + plotW).toFixed(1)} ${lastY.toFixed(1)}`);
      out.push(`  <path d="${cmds.join(' ')}" fill="none" stroke="${esc(p.color || '#0a84ff')}" stroke-width="1.9" stroke-linejoin="miter"/>`);
    }
    const lastV = buf.v[buf.v.length - 1];
    if (p.analog && lastV !== undefined) {
      out.push(`  <text x="${(headerW + plotW - 4).toFixed(1)}" y="${(yHi + 4).toFixed(1)}" font-size="9.5" font-weight="700" font-family="'SF Mono', ui-monospace, Menlo, monospace" text-anchor="end" fill="${esc(p.color || '#0a84ff')}">${Number.isNaN(lastV) ? 'NC' : lastV.toFixed(2) + ' V'}</text>`);
    }
  });

  out.push('</svg>');
  return out.join('\n');
}

export function svgStringToPngBlob(svgStr, scale = 2) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' }));
    img.onload = async () => {
      try {
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const g = cv.getContext('2d');
        g.scale(scale, scale);
        g.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        resolve(await canvasToBlob(cv, 'image/png'));
      } catch (e) { URL.revokeObjectURL(url); reject(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to rasterize SVG')); };
    img.src = url;
  });
}

export function exportAnalyzerCSV(app, opts = {}) {
  const csv = buildAnalyzerCSV(app.circuit, app.samples, app.engine.time, {
    scope: opts.scope || 'all',
    windowSec: app.ui?.an?.window || 2,
  });
  triggerDownload(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `${safeFileBase(app.circuit.name)}-logic-analyzer.csv`);
  return csv;
}

export function exportAnalyzerSVG(app, opts = {}) {
  const svg = renderAnalyzerSVG(app.circuit, app.samples, app.engine.time, app.ui?.an?.window || 2, opts);
  triggerDownload(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }), `${safeFileBase(app.circuit.name)}-waveforms.svg`);
  return svg;
}

export async function exportAnalyzerPNG(app, opts = {}) {
  const svg = renderAnalyzerSVG(app.circuit, app.samples, app.engine.time, app.ui?.an?.window || 2, opts);
  const blob = await svgStringToPngBlob(svg, opts.scale || 2);
  triggerDownload(blob, `${safeFileBase(app.circuit.name)}-waveforms.png`);
  return blob;
}

/** High-resolution offscreen UT2062B Oscilloscope waveform + measurement capture. */
export function renderScopeExportCanvas(part, dev, opts = {}) {
  const scale = opts.scale || 2;
  const W = 720, H = 460;
  const cv = document.createElement('canvas');
  cv.width = W * scale; cv.height = H * scale;
  const g = cv.getContext('2d');
  g.scale(scale, scale);

  g.fillStyle = '#0b1016';
  g.fillRect(0, 0, W, H);

  const p = part.props || {};
  const px0 = 24, py0 = 44, plotW = W - 48, plotH = 310;
  g.fillStyle = '#060a0f';
  g.fillRect(px0, py0, plotW, plotH);
  g.strokeStyle = '#1e293b'; g.lineWidth = 1.2;
  g.strokeRect(px0, py0, plotW, plotH);

  // Graticule 10x8
  g.strokeStyle = 'rgba(148,163,184,0.18)'; g.lineWidth = 1;
  g.beginPath();
  for (let i = 1; i < 10; i++) { const gx = px0 + (i / 10) * plotW; g.moveTo(gx, py0); g.lineTo(gx, py0 + plotH); }
  for (let j = 1; j < 8; j++) { const gy = py0 + (j / 8) * plotH; g.moveTo(px0, gy); g.lineTo(px0 + plotW, gy); }
  g.stroke();

  g.strokeStyle = 'rgba(148,163,184,0.34)';
  g.beginPath();
  g.moveTo(px0 + plotW * 0.5, py0); g.lineTo(px0 + plotW * 0.5, py0 + plotH);
  g.moveTo(px0, py0 + plotH * 0.5); g.lineTo(px0 + plotW, py0 + plotH * 0.5);
  g.stroke();

  const timeDiv = Math.max(0.0001, +p.timeDiv || 0.05);
  const s1 = Math.max(0.05, +p.ch1Scale || 2), s2 = Math.max(0.05, +p.ch2Scale || 2);
  const pos1 = +p.ch1Pos || 0, pos2 = +p.ch2Pos || 0;
  const win = dev ? computeScopeWindow(dev, timeDiv) : null;
  let st1 = null, st2 = null;

  if (win) {
    const ac = p.coupling === 'AC';
    st1 = measureChannelStats(dev, dev.buf1, win);
    st2 = measureChannelStats(dev, dev.buf2, win);
    const off1 = ac && st1.valid ? st1.vavg : 0;
    const off2 = ac && st2.valid ? st2.vavg : 0;
    const midY = py0 + plotH * 0.5, divH = plotH / 8;
    const drawWave = (getter, col) => {
      g.strokeStyle = col; g.lineWidth = 2.2; g.beginPath();
      let moved = false;
      for (let k = 0; k < win.count; k++) {
        const idx = win.idxAt(k), t = dev.bufT[idx];
        if (t < win.tStart || t > win.tEnd) continue;
        const v = getter(idx);
        if (Number.isNaN(v)) { moved = false; continue; }
        const x = px0 + ((t - win.tStart) / win.span) * plotW;
        const y = Math.max(py0 + 1, Math.min(py0 + plotH - 1, midY - v * divH));
        if (!moved) { g.moveTo(x, y); moved = true; } else g.lineTo(x, y);
      }
      g.stroke();
    };
    if (p.ch1On) drawWave(i => (dev.buf1[i] - off1) / s1 + pos1, '#facc15');
    if (p.ch2On) drawWave(i => (dev.buf2[i] - off2) / s2 + pos2, '#22d3ee');
    if (p.math && p.math !== 'off') {
      const sign = p.math === 'add' ? 1 : -1;
      drawWave(i => ((dev.buf1[i] - off1) + sign * (dev.buf2[i] - off2)) / s1, '#e879f9');
    }
  }

  g.font = '700 12px "SF Mono", ui-monospace, Menlo, monospace';
  g.fillStyle = '#f8fafc';
  g.fillText(`${part.ref || 'OSC'} · UT2062B Oscilloscope (${p.coupling || 'DC'})`, px0, 26);
  g.fillStyle = '#4ade80';
  g.fillText(`M ${fmtUnits(timeDiv, 's')}/div`, W - 260, 26);
  g.fillStyle = '#fb923c';
  g.fillText(`Trig ${p.trigSrc || 'CH1'} ${(+p.trigLevel || 0).toFixed(2)}V`, W - 150, 26);

  // Measurement cards footer
  const fmtCard = (st, ch, sVal, col, x) => {
    g.fillStyle = '#111827';
    g.strokeStyle = col; g.lineWidth = 1.2;
    g.beginPath(); g.roundRect(x, 372, 324, 66, 8); g.fill(); g.stroke();
    g.fillStyle = col; g.font = '700 11.5px "SF Mono", ui-monospace, Menlo, monospace';
    g.fillText(`${ch}  ${fmtUnits(sVal, 'V')}/div`, x + 12, 393);
    g.fillStyle = '#cbd5e1'; g.font = '500 11px "SF Mono", ui-monospace, Menlo, monospace';
    const txt = !st || !st.valid
      ? 'No active signal'
      : `Vpp ${st.vpp.toFixed(2)}V · Avg ${st.vavg.toFixed(2)}V · ${st.freq > 0 ? fmtUnits(st.freq, 'Hz') : 'DC'}`;
    g.fillText(txt, x + 12, 417);
  };
  fmtCard(st1, 'CH1', s1, p.ch1On ? '#facc15' : '#64748b', px0);
  fmtCard(st2, 'CH2', s2, p.ch2On ? '#22d3ee' : '#64748b', px0 + 348);

  return cv;
}

export async function exportScopePNG(app, part, opts = {}) {
  const dev = app.engine.byPart.get(part.id)?.device || null;
  const cv = renderScopeExportCanvas(part, dev, opts);
  const blob = await canvasToBlob(cv, 'image/png');
  triggerDownload(blob, `${safeFileBase(app.circuit.name)}-${part.ref || 'scope'}.png`);
  return blob;
}

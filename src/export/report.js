/**
 * One-Click Lab Report & Documentation Pack Generator (Print-to-PDF HTML, Self-Contained HTML, & Markdown).
 * Combines Title Metadata, Hi-DPI Breadboard Diagram, Pure Vector Schematic SVG,
 * Bill of Materials, Point-to-Point Wiring Guide, Logic Analyzer & Oscilloscope Captures,
 * and Microcontroller Sketches into a publication-ready lab sheet with zero external dependencies.
 */
import { computeScopeWindow, measureChannelStats, fmtUnits } from '../parts/library.js';
import {
  renderBreadboardCanvas,
  exportBreadboardPNG,
  safeFileBase,
  triggerDownload,
} from './breadboard_export.js';
import { extractCircuitData, toBomMarkdown, toWiringMarkdown } from './netlist.js';
import { renderAnalyzerSVG, renderScopeExportCanvas, exportAnalyzerSVG } from './waveform_export.js';
import { renderSchematicSVG, exportSchematicSVG } from './schematic_svg.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function unwrapApp(appOrCtx) {
  if (appOrCtx && appOrCtx.circuit) {
    return {
      app: appOrCtx.settings ? appOrCtx : null,
      circuit: appOrCtx.circuit,
      engine: appOrCtx.engine || null,
      index: appOrCtx.index || null,
      samples: appOrCtx.samples || new Map(),
      windowSec: appOrCtx.ui?.an?.window || 2,
      mode: appOrCtx.mode || 'build',
      labelMode: appOrCtx.settings?.get?.('labelMode') || 'refs',
    };
  }
  return {
    app: null,
    circuit: appOrCtx,
    engine: null,
    index: null,
    samples: new Map(),
    windowSec: 2,
    mode: 'build',
    labelMode: 'refs',
  };
}

function summarizeScopeStats(part, dev) {
  const p = part.props || {};
  const timeDiv = Math.max(0.0001, +p.timeDiv || 0.05);
  const win = dev ? computeScopeWindow(dev, timeDiv) : null;
  if (!win) return { ch1: null, ch2: null, timeDiv, coupling: p.coupling || 'DC' };
  const ch1 = p.ch1On ? measureChannelStats(dev, dev.buf1, win) : null;
  const ch2 = p.ch2On ? measureChannelStats(dev, dev.buf2, win) : null;
  return { ch1, ch2, timeDiv, coupling: p.coupling || 'DC' };
}

/**
 * Collect all structured sections, raster breadboard data URL, and pure vector SVGs for a report.
 */
export function collectReportData(appOrCtx, opts = {}) {
  const ctx = unwrapApp(appOrCtx);
  const {
    standard = 'ieee',
    viewMode = 'functional',
    schTheme = 'color',
    powerStyle = 'symbols',
    hideUnwired = true,
    includeBreadboard = true,
    includeSchematic = true,
    includeWaveforms = true,
  } = opts;

  const data = extractCircuitData(ctx.circuit, ctx.engine, ctx.index);
  let breadboardDataUrl = opts.breadboardDataUrl || null;
  let breadboardSize = null;

  if (includeBreadboard && !breadboardDataUrl && ctx.app && typeof document !== 'undefined') {
    const bb = renderBreadboardCanvas(ctx.app, {
      scale: 2,
      background: 'white',
      grid: 'plain',
      stateMode: ctx.mode,
      labelMode: opts.labelMode || ctx.labelMode || 'refs',
      showFrame: false,
      showTitleBlock: false,
      showLegend: ctx.mode === 'sim',
    });
    breadboardDataUrl = bb.canvas.toDataURL('image/png');
    breadboardSize = { width: bb.width, height: bb.height };
  }

  let schematic = null;
  if (includeSchematic) {
    schematic = renderSchematicSVG(ctx.circuit, ctx.engine, ctx.index, {
      standard,
      viewMode,
      theme: schTheme,
      powerStyle,
      hideUnwired,
      showPinNumbers: true,
      showNetLabels: true,
      showValues: true,
      showGrid: false,
      showFrame: true,
      showTitleBlock: false,
      crossingHops: true,
    });
  }

  let analyzerSvg = null;
  if (includeWaveforms && data.probes.length > 0) {
    analyzerSvg = renderAnalyzerSVG(
      ctx.circuit,
      ctx.samples,
      ctx.engine?.time || 0,
      opts.windowSec || ctx.windowSec || 2,
      { theme: 'light', width: 780 },
    );
  }

  const scopeCaptures = [];
  if (includeWaveforms && data.scopes.length > 0) {
    for (const sc of data.scopes) {
      const stats = summarizeScopeStats(sc.part, sc.dev);
      let dataUrl = null;
      if (typeof document !== 'undefined') {
        try {
          dataUrl = renderScopeExportCanvas(sc.part, sc.dev, { scale: 2 }).toDataURL('image/png');
        } catch { dataUrl = null; }
      }
      scopeCaptures.push({ ref: sc.ref, stats, dataUrl });
    }
  }

  return {
    ctx,
    data,
    breadboardDataUrl,
    breadboardSize,
    schematic,
    analyzerSvg,
    scopeCaptures,
    dateStr: new Date().toISOString().slice(0, 10),
  };
}

function fmtScopeLine(st, label) {
  if (!st || !st.valid) return `${label}: No active signal`;
  const freqTxt = st.freq > 0 ? fmtUnits(st.freq, 'Hz') : 'DC';
  return `${label}: Vpp ${st.vpp.toFixed(2)} V · Avg ${st.vavg.toFixed(2)} V · Min ${st.vmin.toFixed(2)} V · Max ${st.vmax.toFixed(2)} V · ${freqTxt}`;
}

/**
 * Generate a completely self-contained, print-calibrated HTML5 Lab Report (vector SVG schematic + hi-DPI figures).
 */
export function buildLabReportHTML(appOrCtx, opts = {}) {
  const {
    pageSize = 'A4',
    orientation = 'portrait',
    standard = 'ieee',
    viewMode = 'functional',
    includeBreadboard = true,
    includeSchematic = true,
    includeBom = true,
    includeWiring = true,
    includeWaveforms = true,
    includeCode = true,
  } = opts;

  const rep = collectReportData(appOrCtx, opts);
  const { data, schematic, breadboardDataUrl, analyzerSvg, scopeCaptures, dateStr } = rep;
  const meta = data.meta || {};
  const stdLabel = `${standard.toUpperCase()} · ${viewMode === 'package' ? 'DIP Package' : 'Functional'}`;

  const sections = [];

  if (includeBreadboard && breadboardDataUrl) {
    sections.push(`
      <section class="card avoid-break">
        <h2>1. Breadboard Wiring Diagram</h2>
        <div class="fig-box">
          <img src="${breadboardDataUrl}" alt="Breadboard Wiring Diagram" />
        </div>
      </section>`);
  }

  if (includeSchematic && schematic) {
    sections.push(`
      <section class="card avoid-break">
        <h2>${sections.length + 1}. Circuit Schematic (${esc(stdLabel)})</h2>
        <div class="fig-box svg-wrap">
          ${schematic.svg}
        </div>
      </section>`);
  }

  if (includeBom) {
    const rows = !data.bom.length
      ? '<tr><td colspan="6" class="empty">No electrical components in circuit.</td></tr>'
      : data.bom.map(r => `
        <tr>
          <td class="num">${r.item}</td>
          <td class="mono">${esc(r.refs)}</td>
          <td>${esc(r.component)}</td>
          <td>${esc(r.value)}</td>
          <td>${esc(r.package)}</td>
          <td class="num">${r.qty}</td>
        </tr>`).join('');
    sections.push(`
      <section class="card">
        <h2>${sections.length + 1}. Bill of Materials (BOM)</h2>
        <table>
          <thead><tr><th>#</th><th>Designators</th><th>Component</th><th>Value / Spec</th><th>Package</th><th>Qty</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`);
  }

  if (includeWiring) {
    const wireRows = !data.wiringByWire.length
      ? '<tr><td colspan="6" class="empty">No discrete jumper wires placed.</td></tr>'
      : data.wiringByWire.map(w => `
        <tr>
          <td class="num">${w.num}</td>
          <td><span class="swatch" style="background:${esc(w.colorHex)}"></span>${esc(w.colorName)}</td>
          <td class="mono">${esc(w.label || '—')}</td>
          <td class="mono">${esc(w.netName || '—')}</td>
          <td>${esc(w.fromDesc)}</td>
          <td>${esc(w.toDesc)}</td>
        </tr>`).join('');
    const netRows = !data.wiringByNet.length
      ? '<tr><td colspan="3" class="empty">No multi-point nets present.</td></tr>'
      : data.wiringByNet.map(n => `
        <tr>
          <td class="mono">${esc(n.name)}</td>
          <td>${esc(n.pins.map(p => `${p.ref}.${p.pin}`).join(', ') || '—')}</td>
          <td class="mono">${esc(n.holes.slice(0, 14).join(', ') + (n.holes.length > 14 ? ` (+${n.holes.length - 14})` : '') || '—')}</td>
        </tr>`).join('');
    sections.push(`
      <section class="card">
        <h2>${sections.length + 1}. Point-to-Point Wiring Guide &amp; Nets</h2>
        <table>
          <thead><tr><th>#</th><th>Color</th><th>Signal</th><th>Net</th><th>From</th><th>To</th></tr></thead>
          <tbody>${wireRows}</tbody>
        </table>
        <h3>Net Connectivity</h3>
        <table>
          <thead><tr><th>Net</th><th>Connected Pins</th><th>Breadboard Holes</th></tr></thead>
          <tbody>${netRows}</tbody>
        </table>
      </section>`);
  }

  if (includeWaveforms && (analyzerSvg || scopeCaptures.length)) {
    const parts = [];
    if (analyzerSvg) {
      parts.push(`<div class="fig-box svg-wrap">${analyzerSvg}</div>`);
    }
    for (const sc of scopeCaptures) {
      parts.push(`
        <div class="scope-block avoid-break">
          ${sc.dataUrl ? `<div class="fig-box"><img src="${sc.dataUrl}" alt="${esc(sc.ref)} Oscilloscope Capture" /></div>` : ''}
          <p class="scope-meta"><strong>${esc(sc.ref)}</strong> (${esc(sc.stats.coupling)}, ${fmtUnits(sc.stats.timeDiv, 's')}/div) — ${esc(fmtScopeLine(sc.stats.ch1, 'CH1'))} &nbsp;|&nbsp; ${esc(fmtScopeLine(sc.stats.ch2, 'CH2'))}</p>
        </div>`);
    }
    sections.push(`
      <section class="card">
        <h2>${sections.length + 1}. Waveforms &amp; Instrument Captures</h2>
        ${parts.join('\n')}
      </section>`);
  }

  if (includeCode && data.mcuSketches.length) {
    const blocks = data.mcuSketches.map(m => `
      <div class="code-wrap avoid-break">
        <div class="code-head">${esc(m.ref)} — ${esc(m.board)}</div>
        <pre>${esc(m.code)}</pre>
      </div>`).join('\n');
    sections.push(`
      <section class="card">
        <h2>${sections.length + 1}. Microcontroller Firmware</h2>
        ${blocks}
      </section>`);
  }

  const metaBits = [
    meta.project ? `<span><strong>Project:</strong> ${esc(meta.project)}</span>` : '',
    meta.author ? `<span><strong>Author:</strong> ${esc(meta.author)}</span>` : '',
    `<span><strong>Revision:</strong> ${esc(meta.revision || '1.0')}</span>`,
    `<span><strong>Date:</strong> ${dateStr}</span>`,
    `<span><strong>Summary:</strong> ${data.partCount} parts · ${data.nets.length} nets · ${data.wireCount} wires</span>`,
  ].filter(Boolean).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(data.name)} — CircuitForge Lab Report</title>
<style>
  @page { size: ${esc(pageSize)} ${esc(orientation)}; margin: 13mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #ffffff; color: #0f172a; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", Arial, sans-serif; font-size: 11px; line-height: 1.45; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .sheet { max-width: 960px; margin: 0 auto; padding: 24px 28px; }
  @media print { .sheet { max-width: none; padding: 0; } }
  .report-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; border-bottom: 2px solid #0f172a; padding-bottom: 12px; margin-bottom: 16px; }
  .report-head h1 { margin: 0 0 4px; font-size: 20px; font-weight: 700; letter-spacing: -0.02em; }
  .report-brand { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #0284c7; margin-bottom: 4px; }
  .meta-line { display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 10.5px; color: #475569; margin-top: 6px; }
  .badge-std { font: 600 10px "SF Mono", ui-monospace, Menlo, monospace; padding: 4px 8px; border-radius: 5px; border: 1px solid #cbd5e1; background: #f8fafc; color: #334155; white-space: nowrap; }
  .notes-box { background: #f8fafc; border-left: 3px solid #0284c7; padding: 8px 12px; border-radius: 0 6px 6px 0; margin-bottom: 16px; color: #1e293b; font-size: 11px; white-space: pre-wrap; }
  .card { margin-bottom: 18px; }
  .avoid-break { break-inside: avoid; page-break-inside: avoid; }
  h2 { font-size: 13.5px; font-weight: 700; margin: 0 0 8px; padding-bottom: 4px; border-bottom: 1px solid #e2e8f0; color: #0f172a; }
  h3 { font-size: 11.5px; font-weight: 700; margin: 12px 0 6px; color: #334155; }
  .fig-box { border: 1px solid #e2e8f0; border-radius: 6px; padding: 8px; background: #ffffff; text-align: center; overflow: hidden; }
  .fig-box img { max-width: 100%; max-height: 460px; width: auto; height: auto; display: inline-block; }
  .svg-wrap svg { max-width: 100%; height: auto; display: block; margin: 0 auto; }
  table { width: 100%; border-collapse: collapse; font-size: 10.5px; }
  th, td { padding: 5px 7px; border-bottom: 1px solid #e2e8f0; text-align: left; vertical-align: top; }
  th { background: #f8fafc; font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: #475569; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .mono { font-family: "SF Mono", ui-monospace, Menlo, monospace; font-size: 10px; }
  .empty { text-align: center; color: #64748b; font-style: italic; padding: 10px; }
  .swatch { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; border: 1px solid rgba(0,0,0,.22); vertical-align: middle; }
  .scope-block { margin-top: 10px; }
  .scope-meta { font: 500 10px "SF Mono", ui-monospace, Menlo, monospace; color: #334155; margin: 6px 0 0; }
  .code-wrap { border: 1px solid #cbd5e1; border-radius: 6px; overflow: hidden; margin-bottom: 10px; }
  .code-head { background: #f1f5f9; border-bottom: 1px solid #cbd5e1; padding: 5px 10px; font-size: 10.5px; font-weight: 700; color: #1e293b; }
  pre { margin: 0; padding: 10px; background: #ffffff; color: #0f172a; font: 9.8px/1.45 "SF Mono", ui-monospace, Menlo, monospace; white-space: pre-wrap; word-break: break-word; }
</style>
</head>
<body>
  <main class="sheet">
    <header class="report-head">
      <div>
        <div class="report-brand">CircuitForge Studio · Engineering Lab Sheet</div>
        <h1>${esc(data.name)}</h1>
        <div class="meta-line">${metaBits}</div>
      </div>
      <div class="badge-std">${esc(stdLabel)}</div>
    </header>
    ${meta.notes ? `<div class="notes-box">${esc(meta.notes)}</div>` : ''}
    ${sections.join('\n')}
  </main>
</body>
</html>`;
}

/**
 * Generate clean GitHub / Obsidian / Notion Markdown Lab Report referencing sibling figure files.
 */
export function buildLabReportMarkdown(appOrCtx, opts = {}) {
  const {
    standard = 'ieee',
    viewMode = 'functional',
    includeBreadboard = true,
    includeSchematic = true,
    includeBom = true,
    includeWiring = true,
    includeWaveforms = true,
    includeCode = true,
  } = opts;

  const rep = collectReportData(appOrCtx, opts);
  const { data, analyzerSvg, scopeCaptures, dateStr } = rep;
  const meta = data.meta || {};
  const base = safeFileBase(data.name);

  const lines = [
    `# ${data.name} — Lab Report`,
    '',
    `| Field | Value |`,
    `|---|---|`,
    `| **Circuit** | ${data.name} |`,
    meta.project ? `| **Project / Course** | ${meta.project} |` : null,
    meta.author ? `| **Author** | ${meta.author} |` : null,
    `| **Revision** | ${meta.revision || '1.0'} |`,
    `| **Date** | ${dateStr} |`,
    `| **Standard** | ${standard.toUpperCase()} (${viewMode === 'package' ? 'DIP Package' : 'Functional'}) |`,
    `| **Counts** | ${data.partCount} parts · ${data.nets.length} nets · ${data.wireCount} wires |`,
    '',
  ].filter(v => v !== null);

  if (meta.notes) {
    lines.push('## Notes', '', meta.notes.trim(), '');
  }

  let sec = 1;
  if (includeBreadboard) {
    lines.push(`## ${sec++}. Breadboard Wiring Diagram`, '', `![Breadboard Wiring Diagram](./${base}-breadboard.png)`, '');
  }
  if (includeSchematic) {
    lines.push(`## ${sec++}. Circuit Schematic (${standard.toUpperCase()})`, '', `![Circuit Schematic](./${base}-schematic.svg)`, '');
  }
  if (includeBom) {
    lines.push(`## ${sec++}. Bill of Materials (BOM)`, '', toBomMarkdown(data).trim(), '');
  }
  if (includeWiring) {
    lines.push(`## ${sec++}. Wiring Guide & Netlist`, '', toWiringMarkdown(data).trim(), '');
  }
  if (includeWaveforms && (analyzerSvg || scopeCaptures.length)) {
    lines.push(`## ${sec++}. Waveforms & Measurements`, '');
    if (analyzerSvg) {
      lines.push(`![Logic Analyzer Waveforms](./${base}-waveforms.svg)`, '');
    }
    for (const sc of scopeCaptures) {
      lines.push(`- **${sc.ref}** (${sc.stats.coupling}, ${fmtUnits(sc.stats.timeDiv, 's')}/div): ${fmtScopeLine(sc.stats.ch1, 'CH1')} | ${fmtScopeLine(sc.stats.ch2, 'CH2')}`);
      lines.push(`  ![${sc.ref} Capture](./${base}-${sc.ref}.png)`);
    }
    lines.push('');
  }
  if (includeCode && data.mcuSketches.length) {
    lines.push(`## ${sec++}. Microcontroller Firmware`, '');
    for (const m of data.mcuSketches) {
      lines.push(`### ${m.ref} (${m.board})`, '', '```cpp', m.code.trimEnd(), '```', '');
    }
  }

  return lines.join('\n');
}

/**
 * Trigger instant native browser Print / Save-as-PDF via a hidden iframe (no popup blocker issues).
 */
export function printLabReportPDF(app, opts = {}) {
  const html = buildLabReportHTML(app, opts);
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;pointer-events:none;';
  document.body.append(frame);

  let printed = false;
  const cleanup = () => {
    setTimeout(() => frame.remove(), 400);
  };
  const doPrint = () => {
    if (printed) return;
    printed = true;
    const win = frame.contentWindow;
    if (!win) { cleanup(); return; }
    win.addEventListener('afterprint', cleanup, { once: true });
    win.focus();
    win.print();
    setTimeout(() => { try { window.focus(); } catch {} }, 80);
    // Fallback cleanup if browser doesn't fire afterprint cleanly on hidden frames
    setTimeout(cleanup, 30000);
  };

  frame.onload = () => setTimeout(doPrint, 60);
  frame.srcdoc = html;
  return html;
}

export function exportLabReportMarkdown(app, opts = {}) {
  const md = buildLabReportMarkdown(app, opts);
  triggerDownload(new Blob([md], { type: 'text/markdown;charset=utf-8' }), `${safeFileBase(app.circuit.name)}-report.md`);
  return md;
}

export function exportLabReportHTML(app, opts = {}) {
  const html = buildLabReportHTML(app, opts);
  triggerDownload(new Blob([html], { type: 'text/html;charset=utf-8' }), `${safeFileBase(app.circuit.name)}-report.html`);
  return html;
}

/**
 * Download matching breadboard PNG + vector schematic SVG (plus Logic Analyzer SVG if probed) for Markdown docs.
 */
export async function exportLabReportAssets(app, opts = {}) {
  await exportBreadboardPNG(app, {
    scale: 2,
    background: 'white',
    grid: 'plain',
    stateMode: app.mode,
    labelMode: opts.labelMode || app.settings.get('labelMode') || 'refs',
    showFrame: true,
    showTitleBlock: true,
  });
  setTimeout(() => {
    exportSchematicSVG(app, {
      standard: opts.standard || 'ieee',
      viewMode: opts.viewMode || 'functional',
      theme: opts.schTheme || 'color',
      powerStyle: opts.powerStyle || 'symbols',
      hideUnwired: opts.hideUnwired !== false,
    });
  }, 160);
  if ((app.circuit.probes || []).length > 0) {
    setTimeout(() => {
      exportAnalyzerSVG(app, { theme: 'light' });
    }, 320);
  }
}

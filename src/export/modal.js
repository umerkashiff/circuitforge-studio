/**
 * Unified Export Studio Modal (`⌘E`):
 *  - Breadboard Diagram (High-DPI auto-cropped PNG, Clipboard Copy, Vector-framed SVG)
 *  - Auto-Generated Schematic (IEEE/ANSI & IEC/DIN Vector SVG, PNG, interactive drag-to-nudge)
 *  - Lab Report (Print-to-PDF, Self-Contained HTML, Markdown & Diagram Pack)
 *  - Data & Waveforms (BOM, Wiring Guide, SPICE .cir, Netlist JSON, Logic Analyzer SVG/PNG/CSV, Scope PNG, MCU .ino)
 */
import {
  renderBreadboardCanvas,
  exportBreadboardPNG,
  copyBreadboardPNG,
  exportBreadboardSVG,
  safeFileBase,
  triggerDownload,
} from './breadboard_export.js';
import {
  extractCircuitData,
  toBomCSV,
  toBomMarkdown,
  toWiringCSV,
  toWiringMarkdown,
  toNetlistJSON,
  toSpiceNetlist,
} from './netlist.js';
import {
  buildHardwareLogicAnalyzerCSV,
  renderAnalyzerSVG,
  exportAnalyzerCSV,
  exportAnalyzerSVG,
  exportAnalyzerPNG,
  renderScopeExportCanvas,
  exportScopePNG,
} from './waveform_export.js';
import {
  renderSchematicSVG,
  exportSchematicSVG,
  exportSchematicPNG,
  copySchematicPNG,
} from './schematic_svg.js';
import { SCH_GRID } from './symbols.js';
import {
  buildLabReportHTML,
  buildLabReportMarkdown,
  printLabReportPDF,
  exportLabReportMarkdown,
  exportLabReportHTML,
  exportLabReportAssets,
} from './report.js';

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v ?? '';
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
};

const appendClean = (el, ...nodes) => {
  for (const n of nodes.flat()) if (n != null && n !== false) el.append(n);
};

async function copyText(str) {
  if (!navigator.clipboard) throw new Error('Clipboard unavailable');
  await navigator.clipboard.writeText(str);
}

export function openExportStudio(app, initialTab = 'breadboard', initialDataView = 'bom') {
  document.querySelector('.export-back')?.remove();

  const circuit = app.circuit;
  circuit.meta = circuit.meta || { author: '', project: '', revision: '1.0', notes: '' };
  const data = extractCircuitData(circuit, app.engine, app.index);

  const state = {
    tab: initialTab,
    zoom: 1,
    bb: {
      scale: 2,
      background: 'white',
      grid: 'plain',
      stateMode: app.mode,
      labelMode: app.settings.get('labelMode') || 'refs',
      showTitleBlock: true,
      showLegend: app.mode === 'sim',
      showFrame: true,
    },
    dataView: initialDataView,
    laTheme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
    sch: {
      standard: 'ieee',
      viewMode: 'functional',
      theme: app.mode === 'sim' ? 'live' : 'color',
      powerStyle: 'symbols',
      hideUnwired: true,
      showPinNumbers: true,
      showNetLabels: true,
      showValues: true,
      crossingHops: true,
      showGrid: false,
      showTitleBlock: true,
      showFrame: true,
      scale: 3,
    },
    rep: {
      pageSize: 'A4',
      orientation: 'portrait',
      standard: 'ieee',
      viewMode: 'functional',
      schTheme: 'color',
      powerStyle: 'symbols',
      hideUnwired: true,
      labelMode: app.settings.get('labelMode') || 'refs',
      includeBreadboard: true,
      includeSchematic: true,
      includeBom: true,
      includeWiring: true,
      includeWaveforms: true,
      includeCode: true,
    },
  };

  // Auto-select Waveforms in Data tab when opened from Logic Analyzer or Oscilloscope
  if (initialDataView === 'analyzer' && !data.probes.length && data.scopes.length) {
    state.dataView = 'scope';
  }

  const tabs = [
    { id: 'breadboard', label: 'Breadboard' },
    { id: 'schematic', label: 'Schematic' },
    { id: 'report', label: 'Lab Report' },
    { id: 'data', label: 'Data & Waveforms' },
  ];

  const tabBar = h('div', { class: 'exp-tabs' });
  const stage = h('div', { class: 'exp-stage' });
  const previewMeta = h('div', { class: 'exp-meta-pill' });
  const panel = h('div', { class: 'exp-panel' });

  const renderStageZoomControls = () => h('div', { class: 'exp-zoom' },
    h('button', { title: 'Zoom out', onclick: () => { state.zoom = Math.max(0.4, +(state.zoom / 1.2).toFixed(2)); applyZoom(); } }, '−'),
    h('button', { class: 'zl', title: 'Reset zoom', onclick: () => { state.zoom = 1; applyZoom(); } }, `${Math.round(state.zoom * 100)}%`),
    h('button', { title: 'Zoom in', onclick: () => { state.zoom = Math.min(3, +(state.zoom * 1.2).toFixed(2)); applyZoom(); } }, '+'),
  );

  let zoomTarget = null;
  const applyZoom = () => {
    if (zoomTarget) {
      zoomTarget.style.transform = `scale(${state.zoom})`;
      zoomTarget.style.transformOrigin = 'center center';
    }
    const zEl = sheet.querySelector('.exp-zoom .zl');
    if (zEl) zEl.textContent = `${Math.round(state.zoom * 100)}%`;
  };

  const renderTabs = () => {
    tabBar.innerHTML = '';
    for (const t of tabs) {
      tabBar.append(h('button', {
        class: 'exp-tab' + (state.tab === t.id ? ' on' : ''),
        onclick: () => { state.tab = t.id; state.zoom = 1; render(); },
      }, t.label));
    }
  };

  const seg = (cur, opts, onChange) => h('div', { class: 'seg-ctl' }, ...opts.map(([v, l]) =>
    h('button', { class: String(cur) === String(v) ? 'on' : '', onclick: () => onChange(v) }, l)));

  const toggleRow = (lbl, checked, onChange) => h('div', { class: 'set-row' },
    h('span', { class: 'set-label' }, lbl),
    h('button', {
      class: 'switch' + (checked ? ' on' : ''),
      role: 'switch',
      'aria-checked': String(!!checked),
      onclick: () => onChange(!checked),
    }, h('i')));

  const metaSection = () => {
    const commitMeta = () => app.commit('Update circuit info');
    return h('div', { class: 'exp-sec' },
      h('div', { class: 'group-label' }, 'Title Block Info'),
      h('div', { class: 'set-box' },
        h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, 'Title'),
          h('input', { class: 'input exp-in', value: circuit.name || '', onchange: (e) => { circuit.name = e.target.value.trim() || 'Untitled Circuit'; data.name = circuit.name; commitMeta(); renderPreviewOnly(); } })),
        h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, 'Author'),
          h('input', { class: 'input exp-in', value: circuit.meta.author || '', placeholder: 'Optional', onchange: (e) => { circuit.meta.author = e.target.value.trim(); data.meta.author = circuit.meta.author; commitMeta(); renderPreviewOnly(); } })),
        h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, 'Project'),
          h('input', { class: 'input exp-in', value: circuit.meta.project || '', placeholder: 'Lab / course', onchange: (e) => { circuit.meta.project = e.target.value.trim(); data.meta.project = circuit.meta.project; commitMeta(); renderPreviewOnly(); } })),
        h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, 'Rev'),
          h('input', { class: 'input exp-in', value: circuit.meta.revision || '1.0', onchange: (e) => { circuit.meta.revision = e.target.value.trim() || '1.0'; data.meta.revision = circuit.meta.revision; commitMeta(); renderPreviewOnly(); } }))));
  };

  const renderBreadboardPreview = () => {
    stage.innerHTML = '';
    stage.classList.toggle('checker', state.bb.background === 'transparent');
    const res = renderBreadboardCanvas(app, state.bb);
    const wrap = h('div', { class: 'exp-canvas-host' });
    res.canvas.className = 'exp-preview-canvas';
    zoomTarget = res.canvas;
    wrap.append(res.canvas);
    previewMeta.textContent = `${res.width} × ${res.height} px · ${state.bb.scale}× DPI · ${data.partCount} parts`;
    stage.append(wrap, previewMeta, renderStageZoomControls());
    applyZoom();
  };

  const renderDataPreview = () => {
    stage.innerHTML = '';
    stage.classList.remove('checker');
    zoomTarget = null;
    const view = state.dataView;

    if (view === 'bom') {
      const tbl = h('table', { class: 'exp-table' },
        h('thead', {}, h('tr', {}, ['#', 'Designators', 'Component', 'Value / Spec', 'Package', 'Qty'].map(c => h('th', {}, c)))),
        h('tbody', {}, ...(!data.bom.length
          ? [h('tr', {}, h('td', { colspan: '6', class: 'muted' }, 'No electrical parts in circuit.'))]
          : data.bom.map(r => h('tr', {}, h('td', {}, String(r.item)), h('td', { class: 'mono' }, r.refs), h('td', {}, r.component), h('td', {}, r.value), h('td', {}, r.package), h('td', {}, String(r.qty)))))));
      stage.append(h('div', { class: 'exp-doc-scroll' }, h('h3', {}, 'Bill of Materials (BOM)'), tbl));
      previewMeta.textContent = `${data.bom.length} unique groups · ${data.partCount} total parts`;
    } else if (view === 'wiring') {
      const wTbl = h('table', { class: 'exp-table' },
        h('thead', {}, h('tr', {}, ['#', 'Color', 'Signal', 'Net', 'From', 'To'].map(c => h('th', {}, c)))),
        h('tbody', {}, ...(!data.wiringByWire.length
          ? [h('tr', {}, h('td', { colspan: '6', class: 'muted' }, 'No discrete jumper wires.'))]
          : data.wiringByWire.map(w => h('tr', {},
            h('td', {}, String(w.num)),
            h('td', {}, h('span', { class: 'swatch-dot', style: `background:${w.colorHex}` }), w.colorName),
            h('td', { class: 'mono' }, w.label || '—'),
            h('td', { class: 'mono' }, w.netName || '—'),
            h('td', {}, w.fromDesc),
            h('td', {}, w.toDesc))))));
      const nTbl = h('table', { class: 'exp-table' },
        h('thead', {}, h('tr', {}, ['Net', 'Pins Connected', 'Breadboard Holes'].map(c => h('th', {}, c)))),
        h('tbody', {}, ...data.wiringByNet.map(n => h('tr', {},
          h('td', { class: 'mono' }, n.name),
          h('td', {}, n.pins.map(p => `${p.ref}.${p.pin}`).join(', ') || '—'),
          h('td', { class: 'mono' }, n.holes.join(', ') || '—')))));
      stage.append(h('div', { class: 'exp-doc-scroll' },
        h('h3', {}, 'Point-to-Point Wire Guide'), wTbl,
        h('h3', { style: 'margin-top:20px' }, 'Electrical Nets'), nTbl));
      previewMeta.textContent = `${data.wiringByWire.length} wires · ${data.wiringByNet.length} nets`;
    } else if (view === 'spice') {
      const txt = toSpiceNetlist(data);
      stage.append(h('div', { class: 'exp-doc-scroll' }, h('h3', {}, 'SPICE Netlist (.cir)'), h('pre', { class: 'exp-code' }, txt)));
      previewMeta.textContent = `${txt.split('\n').length - 1} lines · GND mapped to node 0`;
    } else if (view === 'netlist') {
      const txt = toNetlistJSON(data);
      stage.append(h('div', { class: 'exp-doc-scroll' }, h('h3', {}, 'Canonical Netlist (JSON)'), h('pre', { class: 'exp-code' }, txt)));
      previewMeta.textContent = `${data.parts.length} parts · ${data.nets.length} nets`;
    } else if (view === 'analyzer') {
      const svg = renderAnalyzerSVG(circuit, app.samples, app.engine.time, app.ui?.an?.window || 2, { theme: state.laTheme, width: 820 });
      const box = h('div', { class: 'exp-svg-host', html: svg });
      zoomTarget = box.firstElementChild;
      stage.append(box, previewMeta, renderStageZoomControls());
      previewMeta.textContent = `${data.probes.length} probe channel${data.probes.length === 1 ? '' : 's'} · ${app.ui?.an?.window || 2} s window`;
      applyZoom();
    } else if (view === 'scope') {
      const sc = data.scopes[0];
      if (!sc) {
        stage.append(h('div', { class: 'exp-placeholder' }, 'No UT2062B Oscilloscope in circuit.'));
      } else {
        const cv = renderScopeExportCanvas(sc.part, sc.dev, { scale: 2 });
        cv.className = 'exp-preview-canvas';
        zoomTarget = cv;
        stage.append(h('div', { class: 'exp-canvas-host' }, cv), previewMeta, renderStageZoomControls());
        previewMeta.textContent = `${sc.ref} · ${cv.width} × ${cv.height} px`;
        applyZoom();
      }
    } else if (view === 'code') {
      const mcu = data.mcuSketches[0];
      const txt = mcu ? `// ${mcu.ref} — ${mcu.board}\n\n${mcu.code}` : '// No microcontroller sketch present.';
      stage.append(h('div', { class: 'exp-doc-scroll' }, h('h3', {}, mcu ? `${mcu.ref} · ${mcu.board} Sketch` : 'MCU Code'), h('pre', { class: 'exp-code' }, txt)));
      previewMeta.textContent = mcu ? `${mcu.code.split('\n').length} lines` : '0 sketches';
    }
    if (previewMeta.parentElement !== stage && previewMeta.textContent) stage.append(previewMeta);
  };

  const renderSchematicPreview = () => {
    stage.innerHTML = '';
    stage.classList.remove('checker');
    const res = renderSchematicSVG(circuit, app.engine, app.index, state.sch);
    const host = h('div', { class: 'exp-svg-host sch-interactive', html: res.svg });
    const svgEl = host.firstElementChild;
    zoomTarget = svgEl;

    const hint = h('div', { class: 'exp-sch-hint' }, 'Drag any component to adjust layout (snaps to 20px grid)');
    previewMeta.textContent = `${res.width} × ${res.height} px SVG · ${res.layout.symbols.length} symbols · ${res.layout.routes.length} routed nets (${state.sch.standard.toUpperCase()})`;
    stage.append(host, hint, previewMeta, renderStageZoomControls());
    applyZoom();

    // Interactive symbol drag-to-nudge persisted in part.sch
    svgEl.addEventListener('pointerdown', (e) => {
      const symG = e.target.closest?.('.sch-symbol');
      if (!symG || e.button !== 0) return;
      e.preventDefault();
      const partId = symG.getAttribute('data-part-id');
      const unit = symG.getAttribute('data-unit') || '';
      const origSx = +symG.getAttribute('data-sx') || 0;
      const origSy = +symG.getAttribute('data-sy') || 0;
      const part = circuit.partById(partId);
      if (!part) return;
      const ctm = svgEl.getScreenCTM();
      const scaleX = ctm ? ctm.a : 1;
      const scaleY = ctm ? ctm.d : 1;
      const startClientX = e.clientX, startClientY = e.clientY;
      let lastX = origSx, lastY = origSy;
      let moved = false;

      const writePos = (nx, ny) => {
        if (unit) {
          if (!part.sch || !part.sch.units) part.sch = { units: { ...(part.sch?.units || {}) } };
          part.sch.units[unit] = { x: nx, y: ny };
        } else {
          part.sch = { x: nx, y: ny };
        }
      };

      const onMove = (ev) => {
        const dx = (ev.clientX - startClientX) / scaleX;
        const dy = (ev.clientY - startClientY) / scaleY;
        const nx = Math.round((origSx + dx) / SCH_GRID) * SCH_GRID;
        const ny = Math.round((origSy + dy) / SCH_GRID) * SCH_GRID;
        if (nx === lastX && ny === lastY) return;
        moved = true;
        lastX = nx; lastY = ny;
        writePos(nx, ny);
        const upd = renderSchematicSVG(circuit, app.engine, app.index, state.sch);
        const doc = new DOMParser().parseFromString(upd.svg, 'image/svg+xml');
        svgEl.replaceChildren(...Array.from(doc.documentElement.childNodes, n => document.importNode(n, true)));
        svgEl.setAttribute('viewBox', `0 0 ${upd.width} ${upd.height}`);
        svgEl.setAttribute('width', String(upd.width));
        svgEl.setAttribute('height', String(upd.height));
        previewMeta.textContent = `${upd.width} × ${upd.height} px SVG · ${upd.layout.symbols.length} symbols · ${upd.layout.routes.length} routed nets (${state.sch.standard.toUpperCase()})`;
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        if (moved) {
          app.commit('Adjust schematic position');
          renderPanel();
          renderSchematicPreview();
        }
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  };

  const renderReportPreview = () => {
    stage.innerHTML = '';
    stage.classList.remove('checker');
    zoomTarget = null;
    const html = buildLabReportHTML(app, state.rep);
    const frame = document.createElement('iframe');
    frame.className = 'exp-report-frame';
    frame.setAttribute('title', 'Lab Report Preview');
    frame.srcdoc = html;
    const activeSecs = [
      state.rep.includeBreadboard && 'Breadboard',
      state.rep.includeSchematic && 'Schematic',
      state.rep.includeBom && 'BOM',
      state.rep.includeWiring && 'Wiring',
      state.rep.includeWaveforms && (data.probes.length || data.scopes.length) && 'Waveforms',
      state.rep.includeCode && data.mcuSketches.length && 'Code',
    ].filter(Boolean).length;
    previewMeta.textContent = `${state.rep.pageSize} ${state.rep.orientation} · ${state.rep.standard.toUpperCase()} · ${activeSecs} sections`;
    stage.append(frame, previewMeta);
  };

  const renderPreviewOnly = () => {
    if (state.tab === 'breadboard') renderBreadboardPreview();
    else if (state.tab === 'schematic') renderSchematicPreview();
    else if (state.tab === 'report') renderReportPreview();
    else if (state.tab === 'data') renderDataPreview();
  };

  const renderPanel = () => {
    panel.innerHTML = '';

    if (state.tab === 'breadboard') {
      panel.append(
        metaSection(),
        h('div', { class: 'exp-sec' },
          h('div', { class: 'group-label' }, 'Diagram Options'),
          h('div', { class: 'set-box' },
            h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, 'Background'),
              seg(state.bb.background, [['white', 'White'], ['theme', 'Theme'], ['paper', 'Paper'], ['blueprint', 'Blue'], ['transparent', 'Clear']], (v) => { state.bb.background = v; render(); })),
            h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, 'Labels'),
              seg(state.bb.labelMode, [['off', 'Off'], ['refs', 'Refs'], ['values', 'Val'], ['full', 'Full']], (v) => { state.bb.labelMode = v; render(); })),
            h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, 'State'),
              seg(state.bb.stateMode, [['build', 'Build'], ['sim', 'Live Sim']], (v) => { state.bb.stateMode = v; state.bb.showLegend = v === 'sim'; render(); })),
            h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, 'Grid'),
              seg(state.bb.grid, [['plain', 'Clean'], ['dots', 'Dots'], ['grid', 'Grid']], (v) => { state.bb.grid = v; render(); })),
            h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, 'Scale'),
              seg(state.bb.scale, [[1, '1×'], [2, '2×'], [3, '3×'], [4, '4×']], (v) => { state.bb.scale = v; render(); })),
            toggleRow('Title Block', state.bb.showTitleBlock, (v) => { state.bb.showTitleBlock = v; render(); }),
            toggleRow('Wire Legend', state.bb.showLegend, (v) => { state.bb.showLegend = v; render(); }),
            toggleRow('Sheet Frame', state.bb.showFrame, (v) => { state.bb.showFrame = v; render(); }))),
        h('div', { class: 'exp-actions' },
          h('button', { class: 'btn primary', onclick: async () => { await exportBreadboardPNG(app, state.bb); app.ui.toast('Exported Breadboard PNG'); } }, 'Download PNG'),
          h('button', { class: 'btn', onclick: async () => {
            try { await copyBreadboardPNG(app, state.bb); app.ui.toast('Copied breadboard diagram to clipboard'); }
            catch (e) { app.ui.toast(e.message || 'Clipboard copy blocked'); }
          } }, 'Copy PNG'),
          h('button', { class: 'btn', onclick: () => { exportBreadboardSVG(app, state.bb); app.ui.toast('Exported Vector-Framed SVG'); } }, 'Download SVG')),
      );
      return;
    }

    if (state.tab === 'schematic') {
      const hasCustom = (circuit.parts || []).some(p => p.sch);
      appendClean(panel,
        metaSection(),
        h('div', { class: 'exp-sec' },
          h('div', { class: 'group-label' }, 'Schematic Style'),
          h('div', { class: 'set-box' },
            h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, 'Standard'),
              seg(state.sch.standard, [['ieee', 'IEEE / ANSI'], ['iec', 'IEC / DIN']], (v) => { state.sch.standard = v; render(); })),
            h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, 'IC View'),
              seg(state.sch.viewMode, [['functional', 'Functional'], ['package', 'DIP Pkg']], (v) => { state.sch.viewMode = v; render(); })),
            h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, 'Theme'),
              seg(state.sch.theme, [['color', 'Color'], ['print', 'B&W'], ['blueprint', 'Blue'], ['live', 'Live']], (v) => { state.sch.theme = v; render(); })),
            h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, 'Power'),
              seg(state.sch.powerStyle, [['symbols', 'VCC / GND'], ['rails', 'Bus Rails']], (v) => { state.sch.powerStyle = v; render(); })),
            toggleRow('Hide Unwired Pins (MCU/MSI)', state.sch.hideUnwired, (v) => { state.sch.hideUnwired = v; render(); }),
            toggleRow('Pin Numbers', state.sch.showPinNumbers, (v) => { state.sch.showPinNumbers = v; render(); }),
            toggleRow('Net Labels', state.sch.showNetLabels, (v) => { state.sch.showNetLabels = v; render(); }),
            toggleRow('Wire Crossing Hops', state.sch.crossingHops, (v) => { state.sch.crossingHops = v; render(); }),
            toggleRow('Title Block', state.sch.showTitleBlock, (v) => { state.sch.showTitleBlock = v; render(); }),
            toggleRow('Sheet Grid', state.sch.showGrid, (v) => { state.sch.showGrid = v; render(); }))),
        hasCustom ? h('button', { class: 'btn', onclick: () => { for (const p of circuit.parts) p.sch = null; app.commit('Reset schematic layout'); render(); app.ui.toast('Schematic reset to auto-layout'); } }, 'Reset Auto-Layout') : null,
        h('div', { class: 'exp-actions' },
          h('button', { class: 'btn primary', onclick: () => { exportSchematicSVG(app, state.sch); app.ui.toast('Exported Vector Schematic SVG'); } }, 'Download Vector SVG'),
          h('button', { class: 'btn', onclick: async () => { await exportSchematicPNG(app, state.sch); app.ui.toast('Exported Schematic PNG (3×)'); } }, 'Download PNG (3×)'),
          h('button', { class: 'btn', onclick: async () => {
            try { await copySchematicPNG(app, state.sch); app.ui.toast('Copied schematic PNG to clipboard'); }
            catch (e) { app.ui.toast(e.message || 'Clipboard copy blocked'); }
          } }, 'Copy PNG')),
      );
      return;
    }

    if (state.tab === 'report') {
      const commitNotes = () => app.commit('Update circuit notes');
      const hasWaves = data.probes.length > 0 || data.scopes.length > 0;
      const hasCode = data.mcuSketches.length > 0;
      appendClean(panel,
        metaSection(),
        h('div', { class: 'exp-sec' },
          h('div', { class: 'group-label' }, 'Lab Notes'),
          h('textarea', {
            class: 'input exp-notes',
            placeholder: 'Objective, observations, or procedure notes...',
            value: circuit.meta.notes || '',
            onchange: (e) => {
              circuit.meta.notes = e.target.value;
              data.meta.notes = e.target.value;
              commitNotes();
              renderPreviewOnly();
            },
          })),
        h('div', { class: 'exp-sec' },
          h('div', { class: 'group-label' }, 'Page & Diagram Style'),
          h('div', { class: 'set-box' },
            h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, 'Paper'),
              seg(state.rep.pageSize, [['A4', 'A4'], ['Letter', 'Letter']], (v) => { state.rep.pageSize = v; render(); })),
            h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, 'Layout'),
              seg(state.rep.orientation, [['portrait', 'Portrait'], ['landscape', 'Landscape']], (v) => { state.rep.orientation = v; render(); })),
            h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, 'Schematic'),
              seg(state.rep.standard, [['ieee', 'IEEE / ANSI'], ['iec', 'IEC / DIN']], (v) => { state.rep.standard = v; render(); })),
            h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, 'Color'),
              seg(state.rep.schTheme, [['color', 'Color'], ['print', 'B&W Print']], (v) => { state.rep.schTheme = v; render(); })))),
        h('div', { class: 'exp-sec' },
          h('div', { class: 'group-label' }, 'Include Sections'),
          h('div', { class: 'set-box' },
            toggleRow('Breadboard Diagram', state.rep.includeBreadboard, (v) => { state.rep.includeBreadboard = v; render(); }),
            toggleRow('Vector Schematic', state.rep.includeSchematic, (v) => { state.rep.includeSchematic = v; render(); }),
            toggleRow('Bill of Materials', state.rep.includeBom, (v) => { state.rep.includeBom = v; render(); }),
            toggleRow('Wiring Guide & Nets', state.rep.includeWiring, (v) => { state.rep.includeWiring = v; render(); }),
            hasWaves ? toggleRow('Waveforms & Scope', state.rep.includeWaveforms, (v) => { state.rep.includeWaveforms = v; render(); }) : null,
            hasCode ? toggleRow('MCU Sketch Code', state.rep.includeCode, (v) => { state.rep.includeCode = v; render(); }) : null)),
        h('div', { class: 'exp-actions' },
          h('button', { class: 'btn primary', onclick: () => { printLabReportPDF(app, state.rep); app.ui.toast('Opening print preview / Save as PDF'); } }, 'Print / Save as PDF'),
          h('button', { class: 'btn', onclick: () => { exportLabReportMarkdown(app, state.rep); app.ui.toast('Downloaded Markdown Lab Report'); } }, 'Download Markdown (.md)'),
          h('button', { class: 'btn', onclick: async () => { await copyText(buildLabReportMarkdown(app, state.rep)); app.ui.toast('Copied Lab Report Markdown'); } }, 'Copy Markdown'),
          h('button', { class: 'btn', onclick: () => { exportLabReportHTML(app, state.rep); app.ui.toast('Downloaded HTML Lab Sheet'); } }, 'Download HTML Sheet'),
          h('button', { class: 'btn', onclick: async () => { await exportLabReportAssets(app, state.rep); app.ui.toast('Exported Breadboard PNG + Schematic SVG'); } }, 'Download Diagram Assets')),
      );
      return;
    }

    if (state.tab === 'data') {
      const viewChoices = [
        ['bom', `BOM (${data.bom.length})`],
        ['wiring', `Wiring (${data.wiringByWire.length})`],
        ['spice', 'SPICE (.cir)'],
        ['netlist', 'Netlist JSON'],
        ['analyzer', `Waveforms (${data.probes.length})`],
      ];
      if (data.scopes.length) viewChoices.push(['scope', `Scope (${data.scopes.length})`]);
      if (data.mcuSketches.length) viewChoices.push(['code', `Code (${data.mcuSketches.length})`]);

      panel.append(h('div', { class: 'exp-sec' },
        h('div', { class: 'group-label' }, 'Dataset / Waveform'),
        h('div', { class: 'exp-view-grid' }, ...viewChoices.map(([id, lbl]) =>
          h('button', { class: 'btn' + (state.dataView === id ? ' primary' : ''), onclick: () => { state.dataView = id; render(); } }, lbl)))));

      const base = safeFileBase(data.name);
      if (state.dataView === 'bom') {
        panel.append(h('div', { class: 'exp-actions' },
          h('button', { class: 'btn primary', onclick: () => { triggerDownload(new Blob([toBomCSV(data)], { type: 'text/csv;charset=utf-8' }), `${base}-bom.csv`); app.ui.toast('Downloaded BOM CSV'); } }, 'Download CSV'),
          h('button', { class: 'btn', onclick: async () => { await copyText(toBomMarkdown(data)); app.ui.toast('Copied BOM Markdown table'); } }, 'Copy Markdown'),
          h('button', { class: 'btn', onclick: () => { triggerDownload(new Blob([toBomMarkdown(data)], { type: 'text/markdown;charset=utf-8' }), `${base}-bom.md`); } }, 'Download .md')));
      } else if (state.dataView === 'wiring') {
        panel.append(h('div', { class: 'exp-actions' },
          h('button', { class: 'btn primary', onclick: () => { triggerDownload(new Blob([toWiringCSV(data)], { type: 'text/csv;charset=utf-8' }), `${base}-wiring.csv`); app.ui.toast('Downloaded Wiring CSV'); } }, 'Download CSV'),
          h('button', { class: 'btn', onclick: async () => { await copyText(toWiringMarkdown(data)); app.ui.toast('Copied Wiring Guide Markdown'); } }, 'Copy Markdown'),
          h('button', { class: 'btn', onclick: () => { triggerDownload(new Blob([toWiringMarkdown(data)], { type: 'text/markdown;charset=utf-8' }), `${base}-wiring.md`); } }, 'Download .md')));
      } else if (state.dataView === 'spice') {
        panel.append(h('div', { class: 'exp-actions' },
          h('button', { class: 'btn primary', onclick: () => { triggerDownload(new Blob([toSpiceNetlist(data)], { type: 'text/plain;charset=utf-8' }), `${base}.cir`); app.ui.toast('Downloaded SPICE netlist'); } }, 'Download .cir'),
          h('button', { class: 'btn', onclick: async () => { await copyText(toSpiceNetlist(data)); app.ui.toast('Copied SPICE netlist'); } }, 'Copy SPICE')));
      } else if (state.dataView === 'netlist') {
        panel.append(h('div', { class: 'exp-actions' },
          h('button', { class: 'btn primary', onclick: () => { triggerDownload(new Blob([toNetlistJSON(data)], { type: 'application/json;charset=utf-8' }), `${base}-netlist.json`); app.ui.toast('Downloaded Netlist JSON'); } }, 'Download JSON'),
          h('button', { class: 'btn', onclick: async () => { await copyText(toNetlistJSON(data)); app.ui.toast('Copied Netlist JSON'); } }, 'Copy JSON')));
      } else if (state.dataView === 'analyzer') {
        const hwLa = (circuit.parts || []).find(p => p.type === 'wokwi-logic-analyzer');
        appendClean(panel,
          h('div', { class: 'exp-sec' }, h('div', { class: 'group-label' }, 'Waveform Theme'),
            h('div', { class: 'set-box' }, h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, 'Style'),
              seg(state.laTheme, [['light', 'Light'], ['dark', 'Dark']], (v) => { state.laTheme = v; render(); })))),
          h('div', { class: 'exp-actions' },
            h('button', { class: 'btn primary', onclick: () => { exportAnalyzerSVG(app, { theme: state.laTheme }); app.ui.toast('Downloaded Waveform SVG'); } }, 'Download SVG'),
            h('button', { class: 'btn', onclick: async () => { await exportAnalyzerPNG(app, { theme: state.laTheme, scale: 2 }); app.ui.toast('Downloaded Waveform PNG'); } }, 'Download PNG'),
            h('button', { class: 'btn', onclick: () => { exportAnalyzerCSV(app, { scope: 'all' }); app.ui.toast('Downloaded CSV (full log)'); } }, 'CSV (All Samples)'),
            h('button', { class: 'btn', onclick: () => { exportAnalyzerCSV(app, { scope: 'window' }); app.ui.toast('Downloaded CSV (window)'); } }, 'CSV (Window)'),
            hwLa ? h('button', { class: 'btn', onclick: () => {
              const dev = app.engine.byPart.get(hwLa.id)?.device;
              triggerDownload(new Blob([buildHardwareLogicAnalyzerCSV(hwLa, dev)], { type: 'text/csv;charset=utf-8' }), `${base}-${hwLa.ref || 'LA'}.csv`);
              app.ui.toast(`Downloaded ${hwLa.ref || 'LA'} 8-Ch CSV`);
            } }, `Download ${hwLa.ref || 'LA'} 8-Ch CSV`) : null));
      } else if (state.dataView === 'scope') {
        panel.append(h('div', { class: 'exp-actions' },
          ...data.scopes.map(sc => h('button', { class: 'btn primary', onclick: async () => { await exportScopePNG(app, sc.part, { scale: 2 }); app.ui.toast(`Exported ${sc.ref} capture`); } }, `Download ${sc.ref} PNG`))));
      } else if (state.dataView === 'code') {
        appendClean(panel, h('div', { class: 'exp-actions' },
          ...data.mcuSketches.map(m => h('button', { class: 'btn primary', onclick: () => { triggerDownload(new Blob([m.code], { type: 'text/plain;charset=utf-8' }), `${base}-${m.ref}.ino`); app.ui.toast(`Downloaded ${m.ref}.ino`); } }, `Download ${m.ref}.ino`)),
          data.mcuSketches[0] ? h('button', { class: 'btn', onclick: async () => { await copyText(data.mcuSketches[0].code); app.ui.toast('Copied sketch'); } }, 'Copy Sketch') : null));
      }
    }
  };

  const render = () => {
    renderTabs();
    renderPanel();
    if (state.tab === 'breadboard') renderBreadboardPreview();
    else if (state.tab === 'schematic') renderSchematicPreview();
    else if (state.tab === 'report') renderReportPreview();
    else renderDataPreview();
  };

  const close = () => { sheet.remove(); window.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') { close(); e.stopPropagation(); } };

  const header = h('div', { class: 'exp-head' },
    h('div', { class: 'exp-title' }, 'Export Studio'),
    tabBar,
    h('button', { class: 'icon-btn', title: 'Close (Esc)', onclick: close }, '✕'));

  const modalBox = h('div', { class: 'sheet export-sheet' },
    header,
    h('div', { class: 'exp-body' }, stage, panel));

  const sheet = h('div', { class: 'sheet-back export-back', onclick: (e) => { if (e.target === sheet) close(); } }, modalBox);
  window.addEventListener('keydown', onKey, true);
  render();
  document.body.append(sheet);
}

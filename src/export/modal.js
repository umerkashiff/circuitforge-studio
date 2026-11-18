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
    else if (k === 'open') { if (v) el.open = true; }
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

  // Unified camera state matching main workspace wheel/pan ergonomics
  const cam = {
    x: 0,
    y: 0,
    z: 1,
    minZ: 0.2,
    maxZ: 5,
    contentW: 0,
    contentH: 0,
    mode: 'none', // 'pan' | 'report' | 'none'
    hasFit: false,
  };
  let worldEl = null;
  let reportFrame = null;
  let metaOpen = false;

  const updateZoomLabel = () => {
    const zEl = stage.querySelector('.exp-zoom .zl');
    if (zEl) zEl.textContent = `${Math.round(cam.z * 100)}%`;
  };

  const applyCam = () => {
    if (cam.mode === 'pan' && worldEl) {
      worldEl.style.transform = `translate(${cam.x.toFixed(1)}px, ${cam.y.toFixed(1)}px) scale(${cam.z})`;
    } else if (cam.mode === 'report' && reportFrame) {
      try {
        const doc = reportFrame.contentDocument;
        if (doc?.documentElement) doc.documentElement.style.zoom = String(cam.z);
      } catch { /* ignore cross-origin or unready document */ }
    }
    updateZoomLabel();
  };

  const fitView = () => {
    if (cam.mode === 'report') {
      cam.z = 1;
      cam.hasFit = true;
      applyCam();
      return;
    }
    if (cam.mode !== 'pan') return;
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    if (!sw || !sh || !cam.contentW || !cam.contentH) {
      requestAnimationFrame(() => { if (cam.mode === 'pan') fitView(); });
      return;
    }
    const padX = 28;
    const padTop = state.tab === 'schematic' ? 44 : 24;
    const padBottom = 48;
    const availW = Math.max(120, sw - padX * 2);
    const availH = Math.max(120, sh - padTop - padBottom);
    const rawFit = Math.min(availW / cam.contentW, availH / cam.contentH);
    const fitZ = Math.max(0.25, Math.min(1.5, rawFit));
    cam.z = +fitZ.toFixed(3);
    cam.x = (sw - cam.contentW * cam.z) / 2;
    cam.y = padTop + Math.max(0, (availH - cam.contentH * cam.z) / 2);
    cam.hasFit = true;
    applyCam();
  };

  const zoomAt = (sx, sy, nz) => {
    const minZ = cam.mode === 'report' ? 0.5 : cam.minZ;
    const maxZ = cam.mode === 'report' ? 2.5 : cam.maxZ;
    nz = Math.max(minZ, Math.min(maxZ, nz));
    if (cam.mode === 'pan') {
      const k = nz / (cam.z || 1);
      cam.x = sx - (sx - cam.x) * k;
      cam.y = sy - (sy - cam.y) * k;
    }
    cam.z = +nz.toFixed(3);
    applyCam();
  };

  const zoomCenter = (factorOrAbs, abs = false) => {
    const sx = stage.clientWidth / 2;
    const sy = stage.clientHeight / 2;
    zoomAt(sx, sy, abs ? factorOrAbs : cam.z * factorOrAbs);
  };

  const renderStageZoomControls = (includeFit = true) => h('div', { class: 'exp-zoom' },
    h('button', { title: 'Zoom out (−)', onclick: () => zoomCenter(1 / 1.25) }, '−'),
    h('button', { class: 'zl', title: 'Reset zoom to 100%', onclick: () => zoomCenter(1, true) }, `${Math.round(cam.z * 100)}%`),
    h('button', { title: 'Zoom in (+)', onclick: () => zoomCenter(1.25) }, '+'),
    includeFit ? h('button', { class: 'zf', title: 'Fit diagram to view (F)', onclick: fitView }, 'Fit') : null,
  );

  // Wheel-to-zoom toward cursor & background drag-to-pan (matching main workspace)
  stage.addEventListener('wheel', (e) => {
    if (cam.mode !== 'pan') return;
    e.preventDefault();
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    const rect = stage.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const factor = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.002));
    zoomAt(sx, sy, cam.z * factor);
  }, { passive: false });

  stage.addEventListener('pointerdown', (e) => {
    if (cam.mode !== 'pan') return;
    if (e.target.closest?.('.exp-zoom')) return;
    const isSymbol = e.target.closest?.('.sch-symbol');
    if (isSymbol && e.button === 0 && !e.ctrlKey && !e.metaKey) return;
    if (e.button !== 0 && e.button !== 1) return;

    e.preventDefault();
    stage.classList.add('panning');
    const startX = e.clientX;
    const startY = e.clientY;
    const ox = cam.x;
    const oy = cam.y;

    const onMove = (ev) => {
      cam.x = ox + (ev.clientX - startX);
      cam.y = oy + (ev.clientY - startY);
      applyCam();
    };
    const onUp = () => {
      stage.classList.remove('panning');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });

  stage.addEventListener('dblclick', (e) => {
    if (cam.mode !== 'pan') return;
    if (e.target.closest?.('.exp-zoom') || e.target.closest?.('.sch-symbol')) return;
    fitView();
  });

  const renderTabs = () => {
    tabBar.innerHTML = '';
    for (const t of tabs) {
      tabBar.append(h('button', {
        class: 'exp-tab' + (state.tab === t.id ? ' on' : ''),
        onclick: () => {
          state.tab = t.id;
          cam.hasFit = false;
          render(false);
        },
      }, t.label));
    }
  };

  const seg = (cur, opts, onChange) => h('div', { class: 'seg-ctl' }, ...opts.map(([v, l]) =>
    h('button', { class: String(cur) === String(v) ? 'on' : '', onclick: () => onChange(v) }, l)));

  const toggleCell = (lbl, checked, onChange) => h('div', { class: 'exp-toggle-item' },
    h('span', { title: lbl }, lbl),
    h('button', {
      class: 'switch' + (checked ? ' on' : ''),
      role: 'switch',
      'aria-checked': String(!!checked),
      onclick: () => onChange(!checked),
    }, h('i')));

  const metaSection = () => {
    const commitMeta = () => app.commit('Update circuit info');
    const det = h('details', { class: 'exp-details', open: metaOpen },
      h('summary', {}, 'Title Block Info'),
      h('div', { class: 'exp-details-body' },
        h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, 'Title'),
          h('input', { class: 'input exp-in', value: circuit.name || '', onchange: (e) => { circuit.name = e.target.value.trim() || 'Untitled Circuit'; data.name = circuit.name; commitMeta(); renderPreviewOnly(true); } })),
        h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, 'Author'),
          h('input', { class: 'input exp-in', value: circuit.meta.author || '', placeholder: 'Optional', onchange: (e) => { circuit.meta.author = e.target.value.trim(); data.meta.author = circuit.meta.author; commitMeta(); renderPreviewOnly(true); } })),
        h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, 'Project'),
          h('input', { class: 'input exp-in', value: circuit.meta.project || '', placeholder: 'Lab / course', onchange: (e) => { circuit.meta.project = e.target.value.trim(); data.meta.project = circuit.meta.project; commitMeta(); renderPreviewOnly(true); } })),
        h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, 'Rev'),
          h('input', { class: 'input exp-in', value: circuit.meta.revision || '1.0', onchange: (e) => { circuit.meta.revision = e.target.value.trim() || '1.0'; data.meta.revision = circuit.meta.revision; commitMeta(); renderPreviewOnly(true); } }))));
    det.addEventListener('toggle', () => { metaOpen = det.open; });
    return det;
  };

  const renderBreadboardPreview = (preserveCam = false) => {
    stage.innerHTML = '';
    stage.className = 'exp-stage pan-mode' + (state.bb.background === 'transparent' ? ' checker' : '');
    reportFrame = null;
    const res = renderBreadboardCanvas(app, state.bb);
    const wrap = h('div', { class: 'exp-canvas-host' });
    res.canvas.className = 'exp-preview-canvas';
    res.canvas.style.width = `${res.cssW}px`;
    res.canvas.style.height = `${res.cssH}px`;
    wrap.append(res.canvas);
    worldEl = h('div', { class: 'exp-world' }, wrap);
    cam.mode = 'pan';
    cam.contentW = res.cssW;
    cam.contentH = res.cssH;
    previewMeta.textContent = `${res.width} × ${res.height} px · ${state.bb.scale}× DPI · ${data.partCount} parts`;
    stage.append(worldEl, previewMeta, renderStageZoomControls(true));
    if (preserveCam && cam.hasFit) applyCam();
    else fitView();
  };

  const renderDataPreview = (preserveCam = false) => {
    stage.innerHTML = '';
    reportFrame = null;
    worldEl = null;
    const view = state.dataView;

    if (view === 'analyzer') {
      stage.className = 'exp-stage pan-mode';
      const svg = renderAnalyzerSVG(circuit, app.samples, app.engine.time, app.ui?.an?.window || 2, { theme: state.laTheme, width: 820 });
      const box = h('div', { class: 'exp-svg-host', html: svg });
      const svgEl = box.firstElementChild;
      const w = +(svgEl?.getAttribute('width') || 820);
      const hPx = +(svgEl?.getAttribute('height') || 360);
      if (svgEl) {
        svgEl.style.width = `${w}px`;
        svgEl.style.height = `${hPx}px`;
      }
      worldEl = h('div', { class: 'exp-world' }, box);
      cam.mode = 'pan';
      cam.contentW = w;
      cam.contentH = hPx;
      previewMeta.textContent = `${data.probes.length} probe channel${data.probes.length === 1 ? '' : 's'} · ${app.ui?.an?.window || 2} s window`;
      stage.append(worldEl, previewMeta, renderStageZoomControls(true));
      if (preserveCam && cam.hasFit) applyCam();
      else fitView();
      return;
    }

    if (view === 'scope') {
      const sc = data.scopes[0];
      if (!sc) {
        stage.className = 'exp-stage';
        cam.mode = 'none';
        stage.append(h('div', { class: 'exp-placeholder' }, 'No UT2062B Oscilloscope in circuit.'));
        previewMeta.textContent = '0 oscilloscopes';
        stage.append(previewMeta);
      } else {
        stage.className = 'exp-stage pan-mode';
        const cv = renderScopeExportCanvas(sc.part, sc.dev, { scale: 2 });
        cv.className = 'exp-preview-canvas';
        const cssW = Math.round(cv.width / 2);
        const cssH = Math.round(cv.height / 2);
        cv.style.width = `${cssW}px`;
        cv.style.height = `${cssH}px`;
        worldEl = h('div', { class: 'exp-world' }, h('div', { class: 'exp-canvas-host' }, cv));
        cam.mode = 'pan';
        cam.contentW = cssW;
        cam.contentH = cssH;
        previewMeta.textContent = `${sc.ref} · ${cv.width} × ${cv.height} px`;
        stage.append(worldEl, previewMeta, renderStageZoomControls(true));
        if (preserveCam && cam.hasFit) applyCam();
        else fitView();
      }
      return;
    }

    stage.className = 'exp-stage doc-mode';
    cam.mode = 'none';
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
    } else if (view === 'code') {
      const mcu = data.mcuSketches[0];
      const txt = mcu ? `// ${mcu.ref} — ${mcu.board}\n\n${mcu.code}` : '// No microcontroller sketch present.';
      stage.append(h('div', { class: 'exp-doc-scroll' }, h('h3', {}, mcu ? `${mcu.ref} · ${mcu.board} Sketch` : 'MCU Code'), h('pre', { class: 'exp-code' }, txt)));
      previewMeta.textContent = mcu ? `${mcu.code.split('\n').length} lines` : '0 sketches';
    }
    if (previewMeta.textContent) stage.append(previewMeta);
  };

  const renderSchematicPreview = (preserveCam = false) => {
    stage.innerHTML = '';
    stage.className = 'exp-stage pan-mode';
    reportFrame = null;
    const res = renderSchematicSVG(circuit, app.engine, app.index, state.sch);
    const host = h('div', { class: 'exp-svg-host sch-interactive', html: res.svg });
    const svgEl = host.firstElementChild;
    if (svgEl) {
      svgEl.style.width = `${res.width}px`;
      svgEl.style.height = `${res.height}px`;
    }
    worldEl = h('div', { class: 'exp-world' }, host);
    cam.mode = 'pan';
    cam.contentW = res.width;
    cam.contentH = res.height;

    const hint = h('div', { class: 'exp-sch-hint' }, 'Drag part to move · Drag background to pan · Wheel/pinch to zoom');
    previewMeta.textContent = `${res.width} × ${res.height} px SVG · ${res.layout.symbols.length} symbols · ${res.layout.routes.length} routed nets (${state.sch.standard.toUpperCase()})`;
    stage.append(worldEl, hint, previewMeta, renderStageZoomControls(true));
    if (preserveCam && cam.hasFit) applyCam();
    else fitView();

    // Interactive symbol drag-to-nudge persisted in part.sch
    svgEl.addEventListener('pointerdown', (e) => {
      if (e.ctrlKey || e.metaKey || e.button !== 0) return;
      const symG = e.target.closest?.('.sch-symbol');
      if (!symG) return;
      e.preventDefault();
      e.stopPropagation();
      const partId = symG.getAttribute('data-part-id');
      const unit = symG.getAttribute('data-unit') || '';
      const origSx = +symG.getAttribute('data-sx') || 0;
      const origSy = +symG.getAttribute('data-sy') || 0;
      const part = circuit.partById(partId);
      if (!part) return;
      const ctm = svgEl.getScreenCTM();
      const scaleX = ctm ? ctm.a : cam.z || 1;
      const scaleY = ctm ? ctm.d : cam.z || 1;
      const startClientX = e.clientX;
      const startClientY = e.clientY;
      let lastX = origSx;
      let lastY = origSy;
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
        lastX = nx;
        lastY = ny;
        writePos(nx, ny);
        const upd = renderSchematicSVG(circuit, app.engine, app.index, state.sch);
        const doc = new DOMParser().parseFromString(upd.svg, 'image/svg+xml');
        svgEl.replaceChildren(...Array.from(doc.documentElement.childNodes, n => document.importNode(n, true)));
        svgEl.setAttribute('viewBox', `0 0 ${upd.width} ${upd.height}`);
        svgEl.setAttribute('width', String(upd.width));
        svgEl.setAttribute('height', String(upd.height));
        svgEl.style.width = `${upd.width}px`;
        svgEl.style.height = `${upd.height}px`;
        cam.contentW = upd.width;
        cam.contentH = upd.height;
        previewMeta.textContent = `${upd.width} × ${upd.height} px SVG · ${upd.layout.symbols.length} symbols · ${upd.layout.routes.length} routed nets (${state.sch.standard.toUpperCase()})`;
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        if (moved) {
          app.commit('Adjust schematic position');
          renderPanel();
          renderSchematicPreview(true);
        }
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  };

  const renderReportPreview = (preserveCam = false) => {
    stage.innerHTML = '';
    stage.className = 'exp-stage doc-mode';
    worldEl = null;
    cam.mode = 'report';
    if (!preserveCam || !cam.hasFit) {
      cam.z = 1;
      cam.hasFit = true;
    }
    const html = buildLabReportHTML(app, state.rep);
    const frame = document.createElement('iframe');
    frame.className = 'exp-report-frame';
    frame.setAttribute('title', 'Lab Report Preview');
    frame.srcdoc = html;
    reportFrame = frame;
    frame.addEventListener('load', applyCam);
    const activeSecs = [
      state.rep.includeBreadboard && 'Breadboard',
      state.rep.includeSchematic && 'Schematic',
      state.rep.includeBom && 'BOM',
      state.rep.includeWiring && 'Wiring',
      state.rep.includeWaveforms && (data.probes.length || data.scopes.length) && 'Waveforms',
      state.rep.includeCode && data.mcuSketches.length && 'Code',
    ].filter(Boolean).length;
    previewMeta.textContent = `${state.rep.pageSize} ${state.rep.orientation} · ${state.rep.standard.toUpperCase()} · ${activeSecs} sections`;
    stage.append(frame, previewMeta, renderStageZoomControls(false));
    applyCam();
  };

  const renderPreviewOnly = (preserveCam = true) => {
    if (state.tab === 'breadboard') renderBreadboardPreview(preserveCam);
    else if (state.tab === 'schematic') renderSchematicPreview(preserveCam);
    else if (state.tab === 'report') renderReportPreview(preserveCam);
    else if (state.tab === 'data') renderDataPreview(preserveCam);
  };

  const renderPanel = () => {
    panel.innerHTML = '';
    const panelScroll = h('div', { class: 'exp-panel-scroll' });
    const panelFoot = h('div', { class: 'exp-panel-foot' });
    panel.append(panelScroll, panelFoot);

    if (state.tab === 'breadboard') {
      panelScroll.append(
        metaSection(),
        h('div', { class: 'exp-sec' },
          h('div', { class: 'group-label' }, 'Diagram Options'),
          h('div', { class: 'set-box' },
            h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, 'Background'),
              seg(state.bb.background, [['white', 'White'], ['theme', 'Theme'], ['paper', 'Paper'], ['blueprint', 'Blue'], ['transparent', 'Clear']], (v) => { state.bb.background = v; render(true); })),
            h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, 'Labels'),
              seg(state.bb.labelMode, [['off', 'Off'], ['refs', 'Refs'], ['values', 'Val'], ['full', 'Full']], (v) => { state.bb.labelMode = v; render(true); })),
            h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, 'State'),
              seg(state.bb.stateMode, [['build', 'Build'], ['sim', 'Live Sim']], (v) => { state.bb.stateMode = v; state.bb.showLegend = v === 'sim'; render(true); })),
            h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, 'Grid'),
              seg(state.bb.grid, [['plain', 'Clean'], ['dots', 'Dots'], ['grid', 'Grid']], (v) => { state.bb.grid = v; render(true); })),
            h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, 'Scale'),
              seg(state.bb.scale, [[1, '1×'], [2, '2×'], [3, '3×'], [4, '4×']], (v) => { state.bb.scale = v; render(true); })),
            h('div', { class: 'exp-toggle-grid' },
              toggleCell('Title Block', state.bb.showTitleBlock, (v) => { state.bb.showTitleBlock = v; render(true); }),
              toggleCell('Wire Legend', state.bb.showLegend, (v) => { state.bb.showLegend = v; render(true); }),
              toggleCell('Sheet Frame', state.bb.showFrame, (v) => { state.bb.showFrame = v; render(true); })))),
      );
      panelFoot.append(
        h('div', { class: 'exp-actions' },
          h('button', { class: 'btn primary', onclick: async () => { await exportBreadboardPNG(app, state.bb); app.ui.toast('Exported Breadboard PNG'); } }, 'Download PNG'),
          h('div', { class: 'exp-sec-actions' },
            h('button', { class: 'btn', onclick: async () => {
              try { await copyBreadboardPNG(app, state.bb); app.ui.toast('Copied breadboard diagram to clipboard'); }
              catch (e) { app.ui.toast(e.message || 'Clipboard copy blocked'); }
            } }, 'Copy PNG'),
            h('button', { class: 'btn', onclick: () => { exportBreadboardSVG(app, state.bb); app.ui.toast('Exported Vector-Framed SVG'); } }, 'Download SVG'))),
      );
      return;
    }

    if (state.tab === 'schematic') {
      const hasCustom = (circuit.parts || []).some(p => p.sch);
      appendClean(panelScroll,
        metaSection(),
        h('div', { class: 'exp-sec' },
          h('div', { class: 'group-label' }, 'Schematic Style'),
          h('div', { class: 'set-box' },
            h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, 'Standard'),
              seg(state.sch.standard, [['ieee', 'IEEE / ANSI'], ['iec', 'IEC / DIN']], (v) => { state.sch.standard = v; render(true); })),
            h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, 'IC View'),
              seg(state.sch.viewMode, [['functional', 'Functional'], ['package', 'DIP Pkg']], (v) => { state.sch.viewMode = v; cam.hasFit = false; render(false); })),
            h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, 'Theme'),
              seg(state.sch.theme, [['color', 'Color'], ['print', 'B&W'], ['blueprint', 'Blue'], ['live', 'Live']], (v) => { state.sch.theme = v; render(true); })),
            h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, 'Power'),
              seg(state.sch.powerStyle, [['symbols', 'VCC / GND'], ['rails', 'Bus Rails']], (v) => { state.sch.powerStyle = v; cam.hasFit = false; render(false); })),
            h('div', { class: 'exp-toggle-grid' },
              toggleCell('Hide Unwired', state.sch.hideUnwired, (v) => { state.sch.hideUnwired = v; cam.hasFit = false; render(false); }),
              toggleCell('Pin Numbers', state.sch.showPinNumbers, (v) => { state.sch.showPinNumbers = v; render(true); }),
              toggleCell('Net Labels', state.sch.showNetLabels, (v) => { state.sch.showNetLabels = v; render(true); }),
              toggleCell('Cross Hops', state.sch.crossingHops, (v) => { state.sch.crossingHops = v; render(true); }),
              toggleCell('Title Block', state.sch.showTitleBlock, (v) => { state.sch.showTitleBlock = v; render(true); }),
              toggleCell('Sheet Grid', state.sch.showGrid, (v) => { state.sch.showGrid = v; render(true); })))),
        hasCustom ? h('button', { class: 'btn', onclick: () => { for (const p of circuit.parts) p.sch = null; app.commit('Reset schematic layout'); cam.hasFit = false; render(false); app.ui.toast('Schematic reset to auto-layout'); } }, 'Reset Auto-Layout') : null,
      );
      panelFoot.append(
        h('div', { class: 'exp-actions' },
          h('button', { class: 'btn primary', onclick: () => { exportSchematicSVG(app, state.sch); app.ui.toast('Exported Vector Schematic SVG'); } }, 'Download Vector SVG'),
          h('div', { class: 'exp-sec-actions' },
            h('button', { class: 'btn', onclick: async () => { await exportSchematicPNG(app, state.sch); app.ui.toast('Exported Schematic PNG (3×)'); } }, 'Download PNG (3×)'),
            h('button', { class: 'btn', onclick: async () => {
              try { await copySchematicPNG(app, state.sch); app.ui.toast('Copied schematic PNG to clipboard'); }
              catch (e) { app.ui.toast(e.message || 'Clipboard copy blocked'); }
            } }, 'Copy PNG'))),
      );
      return;
    }

    if (state.tab === 'report') {
      const commitNotes = () => app.commit('Update circuit notes');
      const hasWaves = data.probes.length > 0 || data.scopes.length > 0;
      const hasCode = data.mcuSketches.length > 0;
      appendClean(panelScroll,
        metaSection(),
        h('div', { class: 'exp-sec' },
          h('div', { class: 'group-label' }, 'Lab Notes'),
          h('textarea', {
            class: 'input exp-notes',
            rows: '2',
            placeholder: 'Objective, observations, or procedure notes...',
            value: circuit.meta.notes || '',
            onchange: (e) => {
              circuit.meta.notes = e.target.value;
              data.meta.notes = e.target.value;
              commitNotes();
              renderPreviewOnly(true);
            },
          })),
        h('div', { class: 'exp-sec' },
          h('div', { class: 'group-label' }, 'Page & Diagram Style'),
          h('div', { class: 'set-box' },
            h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, 'Paper'),
              seg(state.rep.pageSize, [['A4', 'A4'], ['Letter', 'Letter']], (v) => { state.rep.pageSize = v; render(true); })),
            h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, 'Layout'),
              seg(state.rep.orientation, [['portrait', 'Portrait'], ['landscape', 'Landscape']], (v) => { state.rep.orientation = v; render(true); })),
            h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, 'Schematic'),
              seg(state.rep.standard, [['ieee', 'IEEE / ANSI'], ['iec', 'IEC / DIN']], (v) => { state.rep.standard = v; render(true); })),
            h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, 'Color'),
              seg(state.rep.schTheme, [['color', 'Color'], ['print', 'B&W Print']], (v) => { state.rep.schTheme = v; render(true); })))),
        h('div', { class: 'exp-sec' },
          h('div', { class: 'group-label' }, 'Include Sections'),
          h('div', { class: 'set-box' },
            h('div', { class: 'exp-toggle-grid' },
              toggleCell('Breadboard', state.rep.includeBreadboard, (v) => { state.rep.includeBreadboard = v; render(true); }),
              toggleCell('Schematic', state.rep.includeSchematic, (v) => { state.rep.includeSchematic = v; render(true); }),
              toggleCell('BOM Table', state.rep.includeBom, (v) => { state.rep.includeBom = v; render(true); }),
              toggleCell('Wiring & Nets', state.rep.includeWiring, (v) => { state.rep.includeWiring = v; render(true); }),
              hasWaves ? toggleCell('Waveforms', state.rep.includeWaveforms, (v) => { state.rep.includeWaveforms = v; render(true); }) : null,
              hasCode ? toggleCell('MCU Code', state.rep.includeCode, (v) => { state.rep.includeCode = v; render(true); }) : null))),
      );
      panelFoot.append(
        h('div', { class: 'exp-actions' },
          h('button', { class: 'btn primary', onclick: () => { printLabReportPDF(app, state.rep); app.ui.toast('Opening print preview / Save as PDF'); } }, 'Print / Save as PDF'),
          h('div', { class: 'exp-sec-actions' },
            h('button', { class: 'btn', onclick: () => { exportLabReportMarkdown(app, state.rep); app.ui.toast('Downloaded Markdown Lab Report'); } }, 'Download .md'),
            h('button', { class: 'btn', onclick: async () => { await copyText(buildLabReportMarkdown(app, state.rep)); app.ui.toast('Copied Lab Report Markdown'); } }, 'Copy Markdown'),
            h('button', { class: 'btn', onclick: () => { exportLabReportHTML(app, state.rep); app.ui.toast('Downloaded HTML Lab Sheet'); } }, 'Download HTML'),
            h('button', { class: 'btn', onclick: async () => { await exportLabReportAssets(app, state.rep); app.ui.toast('Exported Breadboard PNG + Schematic SVG'); } }, 'Diagram Pack'))),
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

      panelScroll.append(h('div', { class: 'exp-sec' },
        h('div', { class: 'group-label' }, 'Dataset / Waveform'),
        h('div', { class: 'exp-view-grid' }, ...viewChoices.map(([id, lbl]) =>
          h('button', { class: 'btn' + (state.dataView === id ? ' primary' : ''), onclick: () => { state.dataView = id; cam.hasFit = false; render(false); } }, lbl)))));

      const base = safeFileBase(data.name);
      if (state.dataView === 'bom') {
        panelFoot.append(h('div', { class: 'exp-actions' },
          h('button', { class: 'btn primary', onclick: () => { triggerDownload(new Blob([toBomCSV(data)], { type: 'text/csv;charset=utf-8' }), `${base}-bom.csv`); app.ui.toast('Downloaded BOM CSV'); } }, 'Download CSV'),
          h('div', { class: 'exp-sec-actions' },
            h('button', { class: 'btn', onclick: async () => { await copyText(toBomMarkdown(data)); app.ui.toast('Copied BOM Markdown table'); } }, 'Copy Markdown'),
            h('button', { class: 'btn', onclick: () => { triggerDownload(new Blob([toBomMarkdown(data)], { type: 'text/markdown;charset=utf-8' }), `${base}-bom.md`); } }, 'Download .md'))));
      } else if (state.dataView === 'wiring') {
        panelFoot.append(h('div', { class: 'exp-actions' },
          h('button', { class: 'btn primary', onclick: () => { triggerDownload(new Blob([toWiringCSV(data)], { type: 'text/csv;charset=utf-8' }), `${base}-wiring.csv`); app.ui.toast('Downloaded Wiring CSV'); } }, 'Download CSV'),
          h('div', { class: 'exp-sec-actions' },
            h('button', { class: 'btn', onclick: async () => { await copyText(toWiringMarkdown(data)); app.ui.toast('Copied Wiring Guide Markdown'); } }, 'Copy Markdown'),
            h('button', { class: 'btn', onclick: () => { triggerDownload(new Blob([toWiringMarkdown(data)], { type: 'text/markdown;charset=utf-8' }), `${base}-wiring.md`); } }, 'Download .md'))));
      } else if (state.dataView === 'spice') {
        panelFoot.append(h('div', { class: 'exp-actions' },
          h('button', { class: 'btn primary', onclick: () => { triggerDownload(new Blob([toSpiceNetlist(data)], { type: 'text/plain;charset=utf-8' }), `${base}.cir`); app.ui.toast('Downloaded SPICE netlist'); } }, 'Download .cir'),
          h('button', { class: 'btn', onclick: async () => { await copyText(toSpiceNetlist(data)); app.ui.toast('Copied SPICE netlist'); } }, 'Copy SPICE')));
      } else if (state.dataView === 'netlist') {
        panelFoot.append(h('div', { class: 'exp-actions' },
          h('button', { class: 'btn primary', onclick: () => { triggerDownload(new Blob([toNetlistJSON(data)], { type: 'application/json;charset=utf-8' }), `${base}-netlist.json`); app.ui.toast('Downloaded Netlist JSON'); } }, 'Download JSON'),
          h('button', { class: 'btn', onclick: async () => { await copyText(toNetlistJSON(data)); app.ui.toast('Copied Netlist JSON'); } }, 'Copy JSON')));
      } else if (state.dataView === 'analyzer') {
        const hwLa = (circuit.parts || []).find(p => p.type === 'wokwi-logic-analyzer');
        panelScroll.append(
          h('div', { class: 'exp-sec' }, h('div', { class: 'group-label' }, 'Waveform Theme'),
            h('div', { class: 'set-box' }, h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, 'Style'),
              seg(state.laTheme, [['light', 'Light'], ['dark', 'Dark']], (v) => { state.laTheme = v; render(true); })))));
        panelFoot.append(
          h('div', { class: 'exp-actions' },
            h('button', { class: 'btn primary', onclick: () => { exportAnalyzerSVG(app, { theme: state.laTheme }); app.ui.toast('Downloaded Waveform SVG'); } }, 'Download SVG'),
            h('div', { class: 'exp-sec-actions' },
              h('button', { class: 'btn', onclick: async () => { await exportAnalyzerPNG(app, { theme: state.laTheme, scale: 2 }); app.ui.toast('Downloaded Waveform PNG'); } }, 'Download PNG'),
              h('button', { class: 'btn', onclick: () => { exportAnalyzerCSV(app, { scope: 'all' }); app.ui.toast('Downloaded CSV (full log)'); } }, 'CSV (All Samples)'),
              h('button', { class: 'btn', onclick: () => { exportAnalyzerCSV(app, { scope: 'window' }); app.ui.toast('Downloaded CSV (window)'); } }, 'CSV (Window)'),
              hwLa ? h('button', { class: 'btn', onclick: () => {
                const dev = app.engine.byPart.get(hwLa.id)?.device;
                triggerDownload(new Blob([buildHardwareLogicAnalyzerCSV(hwLa, dev)], { type: 'text/csv;charset=utf-8' }), `${base}-${hwLa.ref || 'LA'}.csv`);
                app.ui.toast(`Downloaded ${hwLa.ref || 'LA'} 8-Ch CSV`);
              } }, `Download ${hwLa.ref || 'LA'} CSV`) : null)));
      } else if (state.dataView === 'scope') {
        panelFoot.append(h('div', { class: 'exp-actions' },
          ...data.scopes.map(sc => h('button', { class: 'btn primary', onclick: async () => { await exportScopePNG(app, sc.part, { scale: 2 }); app.ui.toast(`Exported ${sc.ref} capture`); } }, `Download ${sc.ref} PNG`))));
      } else if (state.dataView === 'code') {
        appendClean(panelFoot, h('div', { class: 'exp-actions' },
          ...data.mcuSketches.map(m => h('button', { class: 'btn primary', onclick: () => { triggerDownload(new Blob([m.code], { type: 'text/plain;charset=utf-8' }), `${base}-${m.ref}.ino`); app.ui.toast(`Downloaded ${m.ref}.ino`); } }, `Download ${m.ref}.ino`)),
          data.mcuSketches[0] ? h('button', { class: 'btn', onclick: async () => { await copyText(data.mcuSketches[0].code); app.ui.toast('Copied sketch'); } }, 'Copy Sketch') : null));
      }
    }
  };

  const render = (preserveCam = false) => {
    renderTabs();
    renderPanel();
    if (state.tab === 'breadboard') renderBreadboardPreview(preserveCam);
    else if (state.tab === 'schematic') renderSchematicPreview(preserveCam);
    else if (state.tab === 'report') renderReportPreview(preserveCam);
    else renderDataPreview(preserveCam);
  };

  const resizeObs = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => { if (cam.mode === 'pan' && !cam.hasFit) fitView(); })
    : null;
  resizeObs?.observe(stage);

  const close = () => {
    resizeObs?.disconnect();
    sheet.remove();
    window.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { close(); e.stopPropagation(); return; }
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (cam.mode === 'pan' || cam.mode === 'report') {
      if (e.key === '=' || e.key === '+') { e.preventDefault(); zoomCenter(1.25); }
      else if (e.key === '-') { e.preventDefault(); zoomCenter(1 / 1.25); }
      else if (e.key === '0') { e.preventDefault(); zoomCenter(1, true); }
      else if ((e.key === 'f' || e.key === 'F') && cam.mode === 'pan') { e.preventDefault(); fitView(); }
    }
  };

  const header = h('div', { class: 'exp-head' },
    h('div', { class: 'exp-title' }, 'Export Studio'),
    tabBar,
    h('button', { class: 'icon-btn', title: 'Close (Esc)', onclick: close }, '✕'));

  const modalBox = h('div', { class: 'sheet export-sheet' },
    header,
    h('div', { class: 'exp-body' }, stage, panel));

  const sheet = h('div', { class: 'sheet-back export-back', onclick: (e) => { if (e.target === sheet) close(); } }, modalBox);
  window.addEventListener('keydown', onKey, true);
  document.body.append(sheet);
  render(false);
}

import { allDefs, getDef, CATEGORIES } from './parts/registry.js';
import { Part, P, BOARD_SIZES } from './model.js';
import { WIRE_COLORS } from './view/renderer.js';
import { examples } from './mcu/boards.js';
import { compile } from './mcu/transpile.js';
import { COLOR_KEYS } from './editor.js';
import { ACCENTS, BOARD_COLORS } from './settings.js';
import { SCOPE_VDIV, SCOPE_TDIV, computeScopeWindow, measureChannelStats, fmtUnits } from './parts/library.js';

const $ = (s, r = document) => r.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
};
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Render a part into a small canvas for the library and inspector. */
function thumb(spec, w = 96, hgt = 64) {
  const cv = document.createElement('canvas');
  const dpr = Math.max(2, window.devicePixelRatio || 1);
  cv.width = w * dpr; cv.height = hgt * dpr;
  cv.style.width = w + 'px'; cv.style.height = hgt + 'px';
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  if (spec.board) {
    const cols = BOARD_SIZES[spec.board].cols;
    const bw = w - 14, bh = hgt - 20, x = 7, y = 10;
    g.fillStyle = '#fbfbfc'; g.shadowColor = 'rgba(0,0,0,0.15)'; g.shadowBlur = 6; g.shadowOffsetY = 2;
    g.beginPath(); g.roundRect(x, y, bw, bh, 4); g.fill(); g.shadowColor = 'transparent';
    const n = Math.min(cols, 22);
    for (let i = 0; i < n; i++) for (let j = 0; j < 8; j++) {
      g.fillStyle = '#3a3c42';
      const yy = y + 5 + j * (bh - 10) / 7 + (j > 3 ? 2 : 0) - (j > 3 ? 1 : 0);
      g.fillRect(x + 5 + i * (bw - 10) / (n - 1) - 0.8, yy - 0.8, 1.6, 1.6);
    }
    return cv;
  }
  const part = new Part(spec.type, 0, 0, 0, spec.props ? JSON.parse(JSON.stringify(spec.props)) : null, 'thumb');
  const def = getDef(spec.type);
  const b = def.bounds(part.props);
  const bw = (b[2] - b[0]) * P, bh = (b[3] - b[1]) * P;
  const s = Math.min((w - 12) / bw, (hgt - 10) / bh, 1.25);
  g.translate(w / 2 - ((b[0] + b[2]) / 2) * P * s, hgt / 2 - ((b[1] + b[3]) / 2) * P * s);
  g.scale(s, s);
  try { def.draw(g, part, { rot: 0, dev: null, dark: false, showPinLabels: false }); } catch (e) { console.error(e); }
  return cv;
}

export class UI {
  constructor(app) {
    this.app = app;
    this.tipEl = $('#tip');
    this.hintEl = $('#hint');
    this.toastEl = $('#toast');
    this.menuEl = $('#menu');
    this.insp = $('#inspector-body');
    this.lastInspect = '';
    this.buildLibrary();
    this.buildToolbar();
    this.bindPaneResizers();
    this.buildAnalyzer();
    this.bindCode();
    this.instWins = new Map();
    this.instZ = 10;
    this.instLayer = h('div', { class: 'inst-layer' });
    document.body.append(this.instLayer);
    window.addEventListener('resize', () => this.clampInstrumentWindows());
    window.addEventListener('pointerdown', (e) => { if (!e.target.closest('.popover, .menu, [data-pop]')) this.closeMenus(); });
  }

  // ---------------------------------------------------------------- library --
  specs() {
    const out = [];
    for (const [k, v] of Object.entries(BOARD_SIZES)) out.push({ cat: 'Boards', name: `Breadboard`, sub: v.label.split(' · ')[0], board: k, desc: v.label, search: 'breadboard board ' + k });
    for (const d of allDefs()) {
      if (d.variants) for (const v of d.variants) out.push({ cat: d.cat, name: v.name, sub: d.title || '', type: d.type, props: v.props, desc: d.desc, search: `${v.name} ${d.name} ${d.desc}` });
      else out.push({ cat: d.cat, name: d.short ? d.short : d.name, sub: d.short ? d.name.replace(d.short, '').trim() || d.title : (d.title || ''), type: d.type, desc: d.desc, search: `${d.name} ${d.title || ''} ${d.desc} ${d.type}` });
    }
    return out;
  }
  buildLibrary() {
    const list = $('#library');
    const search = $('#search');
    const specs = this.specs();
    const collapsed = new Set(JSON.parse(localStorage.getItem('cf.collapsed') || '[]'));
    const render = () => {
      const q = search.value.trim().toLowerCase();
      list.innerHTML = '';
      for (const cat of CATEGORIES) {
        const items = specs.filter(s => s.cat === cat && (!q || s.search.toLowerCase().includes(q)));
        if (!items.length) continue;
        const open = q || !collapsed.has(cat);
        const sec = h('section', { class: 'lib-sec' + (open ? '' : ' closed') });
        sec.append(h('button', { class: 'lib-head', onclick: () => {
          if (collapsed.has(cat)) collapsed.delete(cat); else collapsed.add(cat);
          localStorage.setItem('cf.collapsed', JSON.stringify([...collapsed]));
          render();
        } }, h('span', { class: 'chev' }), cat, h('span', { class: 'count' }, String(items.length))));
        if (open) {
          const grid = h('div', { class: 'lib-grid' });
          for (const s of items) {
            const tile = h('button', { class: 'tile', title: s.desc });
            tile.append(h('div', { class: 'tile-art' }, thumb(s)), h('div', { class: 'tile-name' }, s.name), h('div', { class: 'tile-sub' }, s.sub || ''));
            tile.addEventListener('pointerdown', (e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              this.app.editor.startPlace(s);
              this.tileDrag = true;
            });
            grid.append(tile);
          }
          sec.append(grid);
        }
        list.append(sec);
      }
      if (!list.children.length) list.append(h('div', { class: 'empty' }, 'No parts match “' + search.value + '”'));
    };
    search.addEventListener('input', render);
    search.addEventListener('keydown', (e) => { if (e.key === 'Escape') { search.value = ''; render(); search.blur(); } });
    window.addEventListener('pointerup', (e) => {
      if (!this.tileDrag) return;
      this.tileDrag = false;
      const m = this.app.editor.mode;
      if (m && m.kind === 'place' && e.target === this.app.canvas) this.app.editor.place(false);
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement !== search) { e.preventDefault(); search.focus(); search.select(); }
    });
    render();
  }

  // ---------------------------------------------------------------- toolbar --
  buildToolbar() {
    const app = this.app;
    $('#mode-build').addEventListener('click', () => app.setMode('build'));
    $('#mode-sim').addEventListener('click', () => app.setMode('sim'));
    $('#btn-pause').addEventListener('click', () => app.togglePause());
    $('#btn-help').addEventListener('click', () => this.showShortcuts());
    $('#btn-settings').addEventListener('click', () => this.showSettings());
    $('#brand-logo').addEventListener('click', () => this.showSettings('About'));
    $('#btn-reset').addEventListener('click', () => app.resetSim());
    $('#btn-undo').addEventListener('click', () => app.undo());
    $('#btn-redo').addEventListener('click', () => app.redo());
    $('#btn-open').addEventListener('click', () => app.openFile());
    $('#btn-save').addEventListener('click', () => app.saveFile());
    $('#btn-png').addEventListener('click', () => app.exportPNG());
    $('#btn-analyzer').addEventListener('click', () => this.toggleAnalyzer());
    $('#btn-theme').addEventListener('click', () => app.toggleTheme());
    $('#btn-panel').addEventListener('click', () => {
      document.body.classList.toggle('no-inspector');
      this.syncToolbar();
      this.app.resize();
      this.clampInstrumentWindows();
    });
    $('#btn-library').addEventListener('click', () => {
      document.body.classList.toggle('no-library');
      this.syncToolbar();
      this.app.resize();
      this.clampInstrumentWindows();
    });
    $('#zoom-in').addEventListener('click', () => app.zoomBy(1.2));
    $('#zoom-out').addEventListener('click', () => app.zoomBy(1 / 1.2));
    $('#zoom-fit').addEventListener('click', () => app.fit());
    $('#speed').addEventListener('change', (e) => { app.speed = +e.target.value; });
    const name = $('#project-name');
    name.addEventListener('change', () => { app.circuit.name = name.value.trim() || 'Untitled Circuit'; app.commit('Rename'); });
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); });

    // wire colour popover
    const pop = $('#color-pop');
    const sw = pop.querySelector('.swatches');
    const keyOf = (i) => Object.entries(COLOR_KEYS).find(([, v]) => v === i)[0].toUpperCase();
    WIRE_COLORS.forEach((c, i) => sw.append(h('button', { class: 'swatch', style: `--c:${c.hex}`, title: `${c.name}  (${keyOf(i)})`, onclick: () => { app.setWireColor(i); this.closeMenus(); } }, h('span', { class: 'sk' }, keyOf(i)))));
    $('#auto-route').addEventListener('change', () => app.toggleAutoRoute());
    $('#btn-tidy').addEventListener('click', () => { this.closeMenus(); app.editor.tidyWires(); });
    $('#btn-color').addEventListener('click', (e) => { e.stopPropagation(); pop.classList.toggle('open'); });
    $('#auto-color').addEventListener('change', (e) => app.settings.set('autoColor', e.target.checked));
    $('#auto-color').checked = app.autoColor;

    // examples
    const ex = $('#examples-pop');
    for (const e of app.examples) ex.append(h('button', { class: 'menu-item', onclick: () => { this.closeMenus(); app.loadExample(e); } }, h('span', {}, e.name), h('span', { class: 'muted' }, e.sub)));
    $('#btn-examples').addEventListener('click', (e) => { e.stopPropagation(); ex.classList.toggle('open'); });
    $('#btn-new').addEventListener('click', () => app.newCircuit());
  }
  syncToolbar() {
    const app = this.app;
    $('#mode-build').classList.toggle('on', app.mode === 'build');
    $('#mode-sim').classList.toggle('on', app.mode === 'sim');
    $('#btn-pause').classList.toggle('paused', app.paused);
    $('#btn-pause').title = app.paused ? 'Resume  (.)' : 'Pause  (.)';
    $('#auto-route').checked = app.autoRoute;
    $('#auto-color').checked = app.autoColor;
    if (+$('#speed').value !== app.speed) $('#speed').value = String(app.speed);
    $('#btn-undo').disabled = !app.history.canUndo();
    $('#btn-redo').disabled = !app.history.canRedo();
    $('#color-dot').style.background = app.wireColor;
    for (const [i, b] of [...document.querySelectorAll('#color-pop .swatch')].entries()) b.classList.toggle('active', WIRE_COLORS[i].hex === app.wireColor);
    const name = $('#project-name');
    if (document.activeElement !== name) name.value = app.circuit.name;
    $('#zoom-label').textContent = Math.round(app.cam.z * 100) + '%';
    $('#btn-panel').classList.toggle('on', !document.body.classList.contains('no-inspector'));
    $('#btn-library').classList.toggle('on', !document.body.classList.contains('no-library'));
  }

  bindPaneResizers() {
    const setup = (el, cssVar, isLeft) => {
      if (!el) return;
      el.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        el.classList.add('dragging');
        const startX = e.clientX;
        const aside = el.parentElement;
        const startW = aside ? aside.getBoundingClientRect().width : (isLeft ? 252 : 288);
        const onMove = (ev) => {
          const dx = ev.clientX - startX;
          const raw = isLeft ? startW + dx : startW - dx;
          const maxW = Math.max(220, Math.min(isLeft ? 440 : 460, Math.round(window.innerWidth * 0.44)));
          const minW = isLeft ? 160 : 184;
          const w = Math.max(minW, Math.min(maxW, Math.round(raw)));
          document.body.classList.remove(isLeft ? 'no-library' : 'no-inspector');
          document.documentElement.style.setProperty(cssVar, w + 'px');
          this.syncToolbar();
          this.app.resize();
        };
        const onUp = () => {
          el.classList.remove('dragging');
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          this.clampInstrumentWindows();
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
      });
      el.addEventListener('dblclick', () => {
        document.documentElement.style.removeProperty(cssVar);
        document.body.classList.remove(isLeft ? 'no-library' : 'no-inspector');
        this.syncToolbar();
        this.app.resize();
        this.clampInstrumentWindows();
      });
    };
    setup($('#lib-resizer'), '--lib-w', true);
    setup($('#insp-resizer'), '--insp-w', false);
  }
  simClock() {
    const t = this.app.engine.time;
    const slow = this.app.slowmo < 0.95 ? ` · ${this.app.slowmo.toFixed(2)}× slow-mo` : '';
    $('#sim-time').textContent = (t < 60 ? t.toFixed(1) + ' s' : Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0')) + slow;
    $('#sim-time').title = slow ? 'This circuit has very fast signals, so it runs slower than real time to stay accurate.' : '';
  }

  // -------------------------------------------------------------- overlays --
  tip(info, x, y) {
    const el = this.tipEl;
    if (!info) { el.classList.remove('show'); return; }
    el.innerHTML = info.lines.map((l, i) => `<div class="${i ? 'tl' : 'tt'}">${esc(l)}</div>`).join('') +
      (info.state ? `<div class="ts ${info.level}"><i></i>${esc(info.state)}</div>` : '');
    el.classList.add('show');
    const r = el.getBoundingClientRect();
    let tx = x + 16, ty = y + 16;
    if (tx + r.width > window.innerWidth - 8) tx = x - r.width - 12;
    if (ty + r.height > window.innerHeight - 8) ty = y - r.height - 12;
    el.style.transform = `translate(${tx}px, ${ty}px)`;
  }
  hint(text) {
    this.hintEl.textContent = text || '';
    this.hintEl.classList.toggle('show', !!text);
  }
  toast(text) {
    const el = this.toastEl;
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => el.classList.remove('show'), 2600);
  }
  menu(items, x, y) {
    const el = this.menuEl;
    el.innerHTML = '';
    for (const it of items) {
      if (it === '-') { el.append(h('div', { class: 'menu-sep' })); continue; }
      el.append(h('button', { class: 'menu-item' + (it.danger ? ' danger' : ''), onclick: () => { this.closeMenus(); it.action(); } },
        h('span', {}, it.label), it.key ? h('span', { class: 'muted' }, it.key) : null));
    }
    el.classList.add('open');
    const r = el.getBoundingClientRect();
    el.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
    el.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
  }
  closeMenus() { document.querySelectorAll('.popover.open, .menu.open').forEach(e => e.classList.remove('open')); }

  // -------------------------------------------------------------- inspector --
  focusFirstField() { const f = this.insp.querySelector('input, select'); if (f) f.focus(); }

  inspect() {
    const app = this.app, ed = app.editor;
    const { parts, wires, boards } = ed.selected();
    const n = parts.length + wires.length + boards.length;
    const body = this.insp;
    body.innerHTML = '';
    this.livePins = null;
    if (n === 0) return this.inspectCircuit(body);
    if (n > 1) {
      body.append(h('div', { class: 'insp-head' }, h('div', {}, h('div', { class: 'insp-title' }, `${n} items selected`), h('div', { class: 'insp-sub' }, [parts.length && `${parts.length} parts`, wires.length && `${wires.length} wires`, boards.length && `${boards.length} boards`].filter(Boolean).join(' · ')))));
      body.append(this.actions(true));
      return;
    }
    if (parts.length) return this.inspectPart(body, parts[0]);
    if (wires.length) return this.inspectWire(body, wires[0]);
    if (boards.length) return this.inspectBoard(body, boards[0]);
  }

  actions(rotate) {
    const ed = this.app.editor;
    return h('div', { class: 'actions' },
      rotate ? h('button', { class: 'btn', onclick: () => ed.rotateSelection() }, 'Rotate') : null,
      h('button', { class: 'btn', onclick: () => { ed.copy(); ed.paste(); } }, 'Duplicate'),
      h('button', { class: 'btn danger', onclick: () => ed.deleteSelection() }, 'Delete'));
  }

  inspectCircuit(body) {
    const app = this.app, c = app.circuit;
    body.append(h('div', { class: 'insp-head' }, h('div', {},
      h('div', { class: 'insp-title' }, c.name),
      h('div', { class: 'insp-sub' }, `${c.parts.length} parts · ${c.wires.length} wires · ${c.boards.length} board${c.boards.length === 1 ? '' : 's'}`))));
    const issues = h('div', { class: 'issues', id: 'issues' });
    body.append(h('div', { class: 'group' }, h('div', { class: 'group-label' }, 'Status'), issues));
    this.renderIssues();
    body.append(h('div', { class: 'group' }, h('div', { class: 'group-label' }, 'How it works'),
      h('ul', { class: 'tips' },
        h('li', {}, h('b', {}, 'Add parts'), ' — drag from the library, or click one and click the board.'),
        h('li', {}, h('b', {}, 'Wire'), ' — drag from any hole or pin to another. Click instead to add bends on the way.'),
        h('li', {}, h('b', {}, 'Power'), ' — put a +5 V supply on a + rail and Ground on a − rail.'),
        h('li', {}, h('b', {}, 'Simulate'), ' — press ⌘↵. Wires light up red (HIGH) or blue (LOW); faded dashed wires carry no power. Click switches, hover any hole to read its voltage.'),
        h('li', {}, h('b', {}, 'Code'), ' — drop an Arduino, ESP32 or STM32 board, then double-click it to write a sketch.'))));
    body.append(h('div', { class: 'group' }, h('div', { class: 'group-label' }, 'Shortcuts'),
      h('div', { class: 'keys' }, ...[['⌘↵', 'Build ↔ Simulate'], ['E', 'Rotate'], ['R B G…', 'Wire colour'], ['T', 'Tidy wires'], ['⌥ drag', 'Duplicate'], ['⌫', 'Delete'], ['F', 'Fit'], ['?', 'All shortcuts']]
        .map(([k, l]) => h('div', { class: 'key' }, h('kbd', {}, k), h('span', {}, l))))));
  }

  renderIssues() {
    const el = $('#issues');
    if (!el) return;
    const app = this.app;
    const ws = app.allIssues();
    const sig = app.mode + app.paused + ws.map(w => w.level + w.text + (w.part ? w.part.id : '') + (w.wire ? w.wire.id : '')).join('|');
    if (sig === this._issueSig && el.childElementCount) return;
    this._issueSig = sig;
    el.innerHTML = '';
    const errs = ws.filter(w => w.level === 'error').length, warns = ws.filter(w => w.level === 'warn').length;
    const head = app.mode === 'build'
      ? (ws.length ? `Build mode · ${ws.length} thing${ws.length > 1 ? 's' : ''} to check` : 'Build mode · wiring looks good')
      : app.paused ? 'Simulation paused' : errs ? `${errs} problem${errs > 1 ? 's' : ''} found` : warns ? 'Running · some warnings' : 'Running — no problems found';
    el.append(h('div', { class: 'issue ok' + (errs ? ' bad' : '') }, h('i', { class: 'dot' + (app.mode === 'build' || app.paused ? ' paused' : errs ? ' err' : warns ? ' warnd' : '') }), head));
    if (app.mode === 'build' && !ws.length) el.append(h('div', { class: 'hint-row' }, 'Press Simulate (⌘↵) to power the circuit and check it live.'));
    for (const w of ws.slice(0, 30)) {
      const name = w.part ? (getDef(w.part.type).short || getDef(w.part.type).name) : w.wire ? 'Wire' : 'Circuit';
      el.append(h('button', { class: 'issue ' + (w.level === 'error' ? 'err' : w.level === 'warn' ? 'warn' : 'note'), onclick: () => {
        const id = w.part ? w.part.id : w.wire ? w.wire.id : null;
        if (id) { app.editor.select([id]); app.focusOn(w.part ? w.part.bounds() : null, w.wire); }
      } }, h('i', { class: 'dot' }), h('div', {}, h('b', {}, name), h('div', {}, w.text))));
    }
  }

  field(part, f) {
    const app = this.app;
    const set = (v) => {
      part.props[f.key] = v;
      app.commit('Edit ' + f.label);
    };
    const val = part.props[f.key];
    let input;
    if (f.kind === 'select') {
      input = h('select', { class: 'input', onchange: (e) => {
        if (e.target.value === '__custom') {
          const v = parseFloat(prompt(`${f.label} (${f.custom.unit})`, val));
          if (!Number.isNaN(v) && v >= f.custom.min && v <= f.custom.max) set(v); else this.inspect();
          return;
        }
        const opt = f.options.find(o => String(o[0]) === e.target.value);
        set(opt ? opt[0] : e.target.value);
      } });
      let found = false;
      for (const [v, l] of f.options) { const o = h('option', { value: String(v) }, l); if (String(v) === String(val)) { o.selected = true; found = true; } input.append(o); }
      if (f.custom) {
        if (!found) input.prepend(h('option', { value: String(val), selected: true }, `${val} ${f.custom.unit}`));
        input.append(h('option', { value: '__custom' }, 'Custom…'));
      }
    } else {
      input = h('input', { class: 'input', type: 'text', value: val ?? '', onchange: (e) => set(e.target.value) });
    }
    return h('label', { class: 'field' }, h('span', {}, f.label), input);
  }

  inspectPart(body, part) {
    const def = getDef(part.type);
    const head = h('div', { class: 'insp-head' }, h('div', { class: 'insp-thumb' }, thumb({ type: part.type, props: part.props }, 64, 48)),
      h('div', {}, h('div', { class: 'insp-title' }, def.ic ? `${def.short} ${def.name.replace(def.short, '').trim()}` : def.name), h('div', { class: 'insp-sub' }, def.title || '')));
    body.append(head);
    if (def.desc) body.append(h('p', { class: 'desc' }, def.desc));
    for (const w of this.app.allIssues().filter(w => w.part === part)) body.append(h('div', { class: 'issue ' + (w.level === 'error' ? 'err' : w.level === 'warn' ? 'warn' : 'note') }, h('i', { class: 'dot' }), h('div', {}, w.text)));
    if (part.props.damaged) body.append(h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => { delete part.props.damaged; this.app.commit('Replace part'); this.app.engine.build(this.app.circuit); } }, 'Replace with a new one')));
    if (def.mcu) return this.inspectBoardMcu(body, part, def);
    if (def.cat === 'Instruments') {
      body.append(h('div', { class: 'actions' },
        h('button', { class: 'btn primary', onclick: () => this.openInstrumentWindow(part) }, 'Open Front Panel ↗')));
    }
    if (def.fields) {
      const g = h('div', { class: 'group' });
      for (const f of def.fields) g.append(this.field(part, f));
      body.append(g);
    }
    if (def.ic) body.append(this.pinout(part, def));
    body.append(this.actions(true));
  }

  inspectBoardMcu(body, part, def) {
    const b = def.mcu;
    body.append(h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => this.openCode(part) }, 'Open Code  ↵'),
      h('button', { class: 'btn', onclick: () => { this.app.resetSim(); } }, 'Restart')));
    const specs = h('div', { class: 'specs' });
    for (const [k, v] of b.specs || []) specs.append(h('div', { class: 'spec' }, h('span', {}, k), h('b', {}, v)));
    body.append(h('div', { class: 'group' }, h('div', { class: 'group-label' }, 'Board'), specs));
    const rt = this.app.engine.byPart.get(part.id)?.device?.rt;
    const pre = h('pre', { class: 'serial-mini', id: 'serial-mini' }, rt ? rt.serial.slice(-8).map(l => l.text).join('') : (this.app.mode === 'sim' ? '' : 'Press Simulate to run the sketch.'));
    body.append(h('div', { class: 'group' }, h('div', { class: 'group-label' }, 'Serial output'), pre));
    body.append(h('p', { class: 'desc' }, b.vcc === 3.3 ? 'Logic is 3.3 V: a HIGH output is 3.3 V. Use its 3V3 pin for sensors that need 3.3 V and GND for ground.' : 'Logic is 5 V. Its 5V and GND pins can power the breadboard rails.'));
    body.append(this.actions(true));
  }
  updateBoardLive() {
    const el = $('#serial-mini');
    if (!el) return;
    const part = this.app.editor.selected().parts[0];
    const rt = part && this.app.engine.byPart.get(part.id)?.device?.rt;
    if (rt) el.textContent = rt.serial.slice(-8).map(l => l.text).join('');
  }

  // ------------------------------------------------------------ code editor --
  openCode(part) {
    const def = getDef(part.type);
    if (!def.mcu) return;
    const app = this.app;
    this.codePart = part;
    const el = $('#code');
    document.body.classList.add('code-open');
    $('#cd-board').textContent = def.name;
    const ta = $('#cd-text');
    ta.value = part.props.code || '';
    this.renderGutter();
    const exSel = $('#cd-examples');
    exSel.innerHTML = '<option value="">Examples…</option>';
    const exs = examples(def.mcu, def.defaults.code);
    exs.forEach((e, i) => exSel.append(h('option', { value: String(i) }, e.name)));
    exSel.onchange = () => {
      const e = exs[+exSel.value];
      if (e && (ta.value === part.props.code || confirm('Replace your code with this example?'))) { ta.value = e.code; this.renderGutter(); this.codeStatus('Example loaded — press Upload to run it.', ''); }
      exSel.value = '';
    };
    this.codeStatus(app.mode === 'sim' ? 'Running' : 'Ready — Upload to run', '');
    this.serialSeen = -1;
    this.pumpSerial(true);
    setTimeout(() => ta.focus(), 50);
    this.app.resize();
  }
  closeCode() { document.body.classList.remove('code-open'); this.codePart = null; this.app.resize(); }
  codeStatus(text, kind) { const s = $('#cd-status'); s.textContent = text; s.className = 'cd-status ' + (kind || ''); }
  renderGutter(errLine) {
    const ta = $('#cd-text');
    const n = ta.value.split('\n').length;
    $('#cd-gutter').innerHTML = Array.from({ length: n }, (_, i) => `<div class="${i + 1 === errLine ? 'el' : ''}">${i + 1}</div>`).join('');
    $('#cd-gutter').scrollTop = ta.scrollTop;
  }
  upload() {
    const part = this.codePart;
    if (!part) return;
    const def = getDef(part.type);
    const code = $('#cd-text').value;
    try { compile(code, Object.keys(def.mcu.consts || {})); } catch (e) {
      this.codeStatus(`Line ${e.line || '?'}: ${e.message}`, 'err');
      this.renderGutter(e.line);
      return;
    }
    this.renderGutter();
    part.props.code = code;
    this.app.commit('Upload sketch');
    if (this.app.mode !== 'sim') this.app.setMode('sim');
    else { const d = this.app.engine.byPart.get(part.id)?.device; if (d) d.rt = null; }
    this.serialSeen = -1;
    this.codeStatus('Uploaded · running', 'ok');
  }
  pumpSerial(force) {
    const part = this.codePart;
    if (!part) return;
    const rt = this.app.engine.byPart.get(part.id)?.device?.rt;
    const out = $('#cd-out');
    if (!rt) { if (force) out.innerHTML = '<div class="muted">The Serial Monitor shows output while simulating.</div>'; return; }
    if (rt.serialVersion === this.serialSeen && !force) return;
    this.serialSeen = rt.serialVersion;
    const atBottom = out.scrollTop + out.clientHeight >= out.scrollHeight - 20;
    out.innerHTML = rt.serial.map(l => `<span class="${l.color || ''}">${esc(l.text)}</span>`).join('');
    if (atBottom || force) out.scrollTop = out.scrollHeight;
    if (rt.error) { this.codeStatus(`${rt.errorLine ? 'Line ' + rt.errorLine + ': ' : ''}${rt.error}`, 'err'); if (rt.errorLine) this.renderGutter(rt.errorLine); }
    $('#cd-baud').textContent = rt.baud ? rt.baud + ' baud' : '';
  }
  bindCode() {
    const ta = $('#cd-text');
    ta.addEventListener('input', () => this.renderGutter());
    ta.addEventListener('scroll', () => { $('#cd-gutter').scrollTop = ta.scrollTop; });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText('  ', s, ta.selectionEnd, 'end'); this.renderGutter(); }
      else if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'u' || e.key === 'Enter')) { e.preventDefault(); this.upload(); }
      else if (e.key === 'Escape') this.closeCode();
      else if (e.key === 'Enter') {
        const s = ta.selectionStart, line = ta.value.slice(0, s).split('\n').pop();
        const ind = (/^\s*/.exec(line) || [''])[0] + (/[{(]\s*$/.test(line) ? '  ' : '');
        e.preventDefault(); ta.setRangeText('\n' + ind, s, ta.selectionEnd, 'end'); this.renderGutter();
      }
    });
    $('#cd-upload').addEventListener('click', () => this.upload());
    $('#cd-close').addEventListener('click', () => this.closeCode());
    $('#cd-clear').addEventListener('click', () => { const rt = this.codePart && this.app.engine.byPart.get(this.codePart.id)?.device?.rt; if (rt) { rt.serial = []; rt.serialVersion++; } this.pumpSerial(true); });
    $('#cd-send').addEventListener('submit', (e) => {
      e.preventDefault();
      const inp = $('#cd-in');
      const rt = this.codePart && this.app.engine.byPart.get(this.codePart.id)?.device?.rt;
      if (!rt) { this.toast('Start the simulation first (⌘↵).'); return; }
      rt.serialIn += inp.value + '\n';
      rt.print('› ' + inp.value + '\n', 'echo');
      inp.value = '';
    });
  }

  showSettings(tab = 'Appearance') {
    const app = this.app, st = app.settings;
    document.querySelector('.sheet-back')?.remove();
    const seg = (key, opts) => h('div', { class: 'seg-ctl' }, ...opts.map(([v, l]) => h('button', { class: String(st.get(key)) === String(v) ? 'on' : '', onclick: () => { st.set(key, v); render(); } }, l)));
    const toggle = (key, after) => h('button', { class: 'switch' + (st.get(key) ? ' on' : ''), role: 'switch', 'aria-checked': String(!!st.get(key)), onclick: () => { st.set(key, !st.get(key)); if (after) after(); render(); } }, h('i'));
    const swatches = (key, list, custom) => h('div', { class: 'swatch-row' }, ...list.map(([c, n]) => h('button', { class: 'swatch' + (st.get(key) === c ? ' active' : ''), style: `--c:${c}`, title: n, onclick: () => { st.set(key, c); render(); } })),
      custom ? h('label', { class: 'swatch custom', title: 'Custom colour' }, h('input', { type: 'color', value: st.get(key), oninput: (e) => { st.set(key, e.target.value); }, onchange: () => render() })) : null);
    const row = (label, ctl, hint) => h('div', { class: 'set-row' }, h('div', {}, h('div', { class: 'set-label' }, label), hint ? h('div', { class: 'set-hint' }, hint) : null), ctl);
    const box = (...rows) => h('div', { class: 'set-box' }, ...rows);
    const pages = {
      Appearance: () => [
        box(row('Theme', seg('theme', [['system', 'Auto'], ['light', 'Light'], ['dark', 'Dark']])),
          row('Accent colour', swatches('accent', ACCENTS, true)),
          row('Interface size', seg('uiScale', [[0.92, 'Small'], [1, 'Default'], [1.08, 'Large']])),
          row('Translucent panels', toggle('translucent')),
          row('Reduce motion', toggle('reduceMotion'))),
        h('div', { class: 'set-sub' }, 'Workbench'),
        box(row('Canvas', seg('canvas', [['dots', 'Dots'], ['grid', 'Grid'], ['plain', 'Plain']])),
          row('Canvas colour', swatches('canvasTint', [['', 'Theme default'], ['#e9eef5', 'Mist'], ['#efe9df', 'Paper'], ['#1b1d22', 'Slate'], ['#0d1f17', 'PCB green']], true), 'First swatch follows the theme.'),
          row('Breadboard', swatches('boardColor', BOARD_COLORS)),
          row('Wire thickness', seg('wireWidth', [[0.75, 'Thin'], [1, 'Regular'], [1.35, 'Thick']])),
          row('Chip markings', seg('chipText', [[0.85, 'Small'], [1, 'Medium'], [1.2, 'Large']]))),
      ],
      Editor: () => [
        box(row('Route new wires neatly', toggle('autoRoute'), 'Right-angle wires that run between the holes. Hold ⇧ to do the opposite.'),
          row('Red / black for power & ground', toggle('autoColor'), 'Wires from + or − pick their colour automatically.'),
          row('Pin names on hover', toggle('pinHalo'), 'Shows every pin of a chip when you point at it.'),
          row('Landing markers', toggle('landingMarks'), 'Green / red dots under pins while dragging.'),
          row('Hole tooltips', toggle('tooltips')),
          row('Ask before deleting', toggle('confirmDelete'))),
      ],
      Simulation: () => [
        box(row('Wire states', seg('wireStyle', [['recolor', 'Recolor'], ['overlay', 'Overlay'], ['off', 'Off']]), 'Recolor paints each wire by its state: red HIGH, blue LOW, grey dashed = no power.'),
          row('Protected LEDs', toggle('trainerLeds'), 'An LED with no series resistor of its own gets a built-in 330 Ω (like LEDs on a trainer board) and can’t burn out. Turn off for real-world behaviour.'),
          row('Default speed', seg('defaultSpeed', [[0.25, '¼×'], [0.5, '½×'], [1, '1×'], [2, '2×']]), 'Applies to new sessions; change it live from the toolbar.'),
          row('Sound effects', toggle('sound'), 'Buzzers, tones and the pop when something burns out.'),
          row('Volume', h('input', { type: 'range', class: 'slider', min: 0, max: 1, step: 0.05, value: st.get('volume'), oninput: (e) => st.set('volume', +e.target.value) }))),
      ],
      About: () => [
        h('div', { class: 'about' },
          h('div', { class: 'about-logo' }),
          h('div', { class: 'about-name' }, 'CircuitForge Studio'),
          h('div', { class: 'about-ver' }, 'Version 2.0'),
          h('div', { class: 'about-by' }, 'Designed and built by ', h('b', {}, 'Umer Kashif')),
          h('div', { class: 'about-web' },
            h('a', { class: 'about-link', href: 'https://umerkashif.vercel.app/', target: '_blank', rel: 'noopener noreferrer' }, 'https://umerkashif.vercel.app/')),
          h('p', { class: 'about-text' }, 'A customizable electronics lab in your browser. Build circuits with standard logic chips, timers, and components or code for Arduino and ESP32 boards with zero physical parts.')),
        this._buildRetroAsciiStage(),
        h('div', { class: 'about-foot' }, `© ${new Date().getFullYear()} Umer Kashif. All rights reserved.`),
      ],
    };
    const nav = h('nav', { class: 'set-nav' });
    const body = h('div', { class: 'set-body' });
    const icons = { Appearance: '◐', Editor: '✎', Simulation: '▶', About: 'ⓘ' };
    const render = () => {
      nav.innerHTML = '';
      for (const name of Object.keys(pages)) nav.append(h('button', { class: name === tab ? 'on' : '', onclick: () => { tab = name; render(); } }, h('span', { class: 'ico' }, icons[name]), name));
      nav.append(h('span', { class: 'grow' }), h('button', { class: 'reset', onclick: () => { if (confirm('Reset all settings to their defaults?')) { st.reset(); render(); } } }, 'Reset to defaults'));
      body.innerHTML = '';
      body.append(h('h2', {}, tab), ...pages[tab]());
    };
    const sheet = h('div', { class: 'sheet-back', onclick: (e) => { if (e.target === sheet) close(); } },
      h('div', { class: 'sheet settings' }, nav, body, h('button', { class: 'icon-btn sheet-x', onclick: () => close() }, '✕')));
    const close = () => { sheet.remove(); window.removeEventListener('keydown', onKey, true); };
    const onKey = (e) => { if (e.key === 'Escape') { close(); e.stopPropagation(); } };
    window.addEventListener('keydown', onKey, true);
    render();
    document.body.append(sheet);
  }

  _buildRetroAsciiStage() {
    const W = 68, H = 15;
    const LETTERS = [
      [' _   _ ', '| | | |', '| |_| |', ' \\___/ '], // U (7)
      [' __  __ ', '|  \\/  |', '| |\\/| |', '|_|  |_|'], // M (8)
      [' ___ ', '| __|', '| _| ', '|___|'],           // E (5)
      [' ___  ', '| _ \\ ', '|   / ', '|_|_\\ '],      // R (6)
      ['  ', '  ', '  ', '  '],                       // space (2)
      [' _  __', '| |/ /', '| \' < ', '|_|\\_\\'],     // K (6)
      ['   _   ', '  /_\\  ', ' / _ \\ ', '/_/ \\_\\'], // A (7)
      ['  ___ ', ' / __|', ' \\__ \\', ' |___/'],      // S (6)
      [' _  _ ', '| || |', '| __ |', '|_||_|'],       // H (6)
      [' ___ ', '|_ _|', '  |  ', '|___|'],           // I (5)
      [' ___ ', '| __|', '| _| ', '|_|  '],           // F (5)
    ];
    const NAME_ART = [0, 1, 2, 3].map(r => LETTERS.map(g => g[r]).join(''));
    const NAME_X = Math.floor((W - NAME_ART[0].length) / 2);
    const WIZ_WALK = [
      ['   /\\    ', '  (oo)  *', ' /|\\/--+', '  / \\    '],
      ['   /\\    ', '  (oo)  +', ' /|\\/--o', '  | |    '],
    ];
    const WIZ_L = [
      '    /\\     ',
      '   /  \\  * ',
      '  ( oo ) | ',
      '  /|  |\\-+ ',
      ' /_|__|_\\  ',
      '  /    \\   ',
    ];
    const WIZ_R = [
      '     /\\    ',
      '  + /  \\   ',
      '  |( oo )  ',
      ' +-/|  |\\  ',
      '  /_|__|_\\ ',
      '   /    \\  ',
    ];
    const FIGHTER = [
      '    .-.       ',
      ' __/_|_\\__    ',
      '/===(=)===)-->',
    ];
    const stars = Array.from({ length: 28 }, (_, i) => ({
      x: (i * 19 + 5) % (W - 2) + 1,
      y: (i * 7 + 2) % (H - 3) + 1,
      ph: i % 5,
    }));

    const pre = h('pre', { class: 'ascii-screen' });
    const paused = !!this.app.settings.get('reduceMotion');
    let tick = paused ? 24 : 0;
    const theater = h('div', { class: 'ascii-theater' }, pre);

    const drawFrame = () => {
      const buf = Array.from({ length: H }, () => Array(W).fill(' '));
      const put = (x0, y, s) => {
        if (y < 0 || y >= H) return;
        const ix = Math.round(x0);
        for (let i = 0; i < s.length; i++) {
          const x = ix + i;
          if (x > 0 && x < W - 1 && s[i] !== ' ') buf[y][x] = s[i];
        }
      };
      const putBlock = (x0, y0, lines, maxLines = lines.length) => {
        for (let r = 0; r < Math.min(maxLines, lines.length); r++) put(x0, y0 + r, lines[r]);
      };

      // CRT Starfield + Outer Border
      const glyph = ['.', ' ', '+', '*', ' '];
      for (const s of stars) buf[s.y][s.x] = glyph[(Math.floor(tick / 4) + s.ph) % glyph.length];

      const scene = Math.floor(tick / 90) % 3;
      const local = tick % 90;

      if (scene === 0) {
        const intro = 'A long time ago on a breadboard far, far away...';
        const shown = intro.slice(0, Math.min(intro.length, local * 2));
        put(Math.floor((W - intro.length) / 2), 2, shown);

        const bannerRows = Math.min(4, Math.floor(local / 5) + 1);
        putBlock(NAME_X, 4, NAME_ART, bannerRows);

        const wx = ((local * 0.85) % (W + 10)) - 9;
        putBlock(wx, 9, WIZ_WALK[Math.floor(tick / 3) % 2]);
        const sparks = ['*', '+', '.', 'o'];
        for (let k = 0; k < 4; k++) {
          put(wx + 9 + k * 2, 10 - ((k + tick) % 3), sparks[(tick + k) % sparks.length]);
        }
        put(8, 13, 'CircuitForge Wizards present: UMER KASHIF');
      } else if (scene === 1) {
        putBlock(NAME_X, 1, NAME_ART);

        putBlock(2, 7, WIZ_L);
        putBlock(W - 13, 7, WIZ_R);

        // Animated spell beams + sparkling collision burst between the wizards
        const pulse = (tick % 18) < 9;
        const beamL = pulse ? '~~=*~+~*~' : '=~+~*=~~*';
        const beamR = pulse ? '~*~+~*=~~' : '*~~=*~+~=';
        put(13, 10, beamL);
        put(W - 22, 10, beamR);
        const burst = ['* + *', ' \\|/ ', '--@--', ' /|\\ '];
        const bRow = burst[Math.floor(tick / 2) % burst.length];
        put(31, 9, tick % 4 < 2 ? '. * +' : '+ @ *');
        put(31, 10, bRow);
        put(31, 11, tick % 4 < 2 ? '0 1 0' : '1 0 1');
        put(23, 13, 'CASTING LOGIC GATES [74xx]');
      } else {
        const fx = (local * 1.1) % (W + 18) - 14;
        putBlock(fx, 1, FIGHTER);
        put(fx + 15, 3, (tick % 3 === 0 ? '----  ----' : '  ----'));

        putBlock(NAME_X, 5, NAME_ART);

        // Flying wizard waving spark trail + scrolling IC trench below
        const flyX = W - ((local * 0.9) % (W + 18));
        put(flyX, 10, '(=^o^)==* + .');
        const trench = '..[555]....[7493]....[UT2062B]....[EGC3235A]....[MPS3005]..';
        const off = tick % trench.length;
        const ground = (trench + trench).slice(off, off + W - 2);
        put(1, 13, ground);
      }

      buf[0] = ('+' + '-'.repeat(W - 2) + '+').split('');
      buf[H - 1] = ('+' + '-'.repeat(W - 2) + '+').split('');
      for (let y = 1; y < H - 1; y++) { buf[y][0] = '|'; buf[y][W - 1] = '|'; }

      pre.textContent = buf.map(r => r.join('')).join('\n');
    };

    drawFrame();
    const timer = setInterval(() => {
      if (!theater.isConnected) { clearInterval(timer); return; }
      if (!paused) { tick++; drawFrame(); }
    }, 90);

    return theater;
  }

  showShortcuts() {
    const groups = [
      ['Modes', [['⌘ ↵', 'Build ↔ Simulate'], ['.', 'Pause / resume (Simulate)'], ['?', 'This sheet']]],
      ['Wiring', [['drag hole → hole', 'Draw a wire'], ['click, click…', 'Wire with your own bends'], ['⇧ while drawing', 'Straight / routed (opposite of setting)'], ['T', 'Tidy selected (or all) wires'], ['⇧T', 'Auto-route new wires on/off'], ['⌫ while drawing', 'Remove last bend'], ['Esc', 'Cancel']]],
      ['Wire colours', [['R', 'Red'], ['B / K', 'Black'], ['U', 'Blue'], ['G', 'Green'], ['Y', 'Yellow'], ['O', 'Orange'], ['P', 'Purple'], ['W', 'White'], ['1 – 8', 'Same, by number']]],
      ['Parts', [['E / ⇧E', 'Rotate ↻ / ↺'], ['⌥ drag', 'Duplicate while dragging'], ['⌘D', 'Duplicate'], ['⌘C ⌘X ⌘V', 'Copy, cut, paste'], ['← ↑ → ↓', 'Nudge (⇧ = 5 holes)'], ['⌫', 'Delete'], ['↵', 'Open code (boards)'], ['⌘A', 'Select all']]],
      ['View', [['Ctrl-drag', 'Pan canvas'], ['Trackpad / Scroll', 'Zoom'], ['F or ⌘0', 'Fit to screen'], ['+ / −', 'Zoom'], ['L', 'Logic analyzer'], ['/', 'Search parts']]],
      ['File', [['⌘Z / ⇧⌘Z', 'Undo / redo'], ['⌘S', 'Save (or Upload in the code editor)'], ['⌘O', 'Open']]],
    ];
    const sheet = h('div', { class: 'sheet-back', onclick: (e) => { if (e.target === sheet) sheet.remove(); } },
      h('div', { class: 'sheet' }, h('div', { class: 'sheet-head' }, h('b', {}, 'Keyboard Shortcuts'), h('button', { class: 'icon-btn', onclick: () => sheet.remove() }, '✕')),
        h('div', { class: 'sheet-grid' }, ...groups.map(([title, rows]) => h('div', {}, h('div', { class: 'group-label' }, title),
          ...rows.map(([k, l]) => h('div', { class: 'key' }, h('kbd', {}, k), h('span', {}, l))))))));
    const close = (e) => { if (e.key === 'Escape' || e.key === '?') { sheet.remove(); window.removeEventListener('keydown', close, true); e.stopPropagation(); } };
    window.addEventListener('keydown', close, true);
    document.body.append(sheet);
  }

  pinout(part, def) {
    const n = def.ic.n, half = n / 2;
    const wrap = h('div', { class: 'group' }, h('div', { class: 'group-label' }, 'Pinout', h('span', { class: 'muted small' }, ' · click a pin to probe it')));
    const chip = h('div', { class: 'pinout' });
    const left = h('div', { class: 'pcol' }), right = h('div', { class: 'pcol r' });
    const dots = [];
    const row = (i, side) => {
      const label = def.ic.pins[i - 1];
      const special = /^(VCC|VDD)$/.test(label) ? 'pwr' : /^(GND|VSS)$/.test(label) ? 'gnd' : '';
      const dot = h('i', { class: 'lvl' });
      dots[i] = dot;
      const el = h('button', { class: 'prow ' + special, title: `Pin ${i} · ${label}`, onclick: () => {
        const wp = part.worldPins()[i - 1];
        this.app.addProbe(wp.x, wp.y, `${def.short}.${label}`);
      } }, ...(side === 'l' ? [h('span', { class: 'pn' }, String(i)), h('span', { class: 'pl' }, label), dot] : [dot, h('span', { class: 'pl' }, label), h('span', { class: 'pn' }, String(i))]));
      return el;
    };
    // Pin 1 is bottom-left on the board; show the classic top-view with pin 1 top-left.
    for (let i = 1; i <= half; i++) left.append(row(i, 'l'));
    for (let i = n; i > half; i--) right.append(row(i, 'r'));
    chip.append(left, h('div', { class: 'pbody' }, h('div', { class: 'notch' }), h('div', { class: 'pname' }, def.short)), right);
    wrap.append(chip);
    this.livePins = { part, dots };
    this.updatePins();
    return wrap;
  }
  updatePins() {
    const lp = this.livePins;
    if (!lp) return;
    const sim = this.app.engine;
    const pins = lp.part.worldPins();
    pins.forEach((p, i) => {
      const dot = lp.dots[i + 1];
      if (!dot) return;
      const v = sim.voltage(sim.netAt(p.x, p.y));
      const cls = !this.app.running || Number.isNaN(v) ? 'lvl' : v >= 2 ? 'lvl hi' : v <= 0.8 ? 'lvl lo' : 'lvl mid';
      if (dot.className !== cls) dot.className = cls;
    });
  }

  inspectWire(body, wire) {
    const app = this.app;
    const desc = (e) => {
      const pt = app.editor.describe(e.x, e.y);
      if (!pt) return '—';
      return pt.hole ? (pt.hole.rail ? pt.hole.label : 'Hole ' + pt.hole.label) : pt.pins.length ? `${getDef(pt.pins[0].part.type).short || getDef(pt.pins[0].part.type).name} ${pt.pins[0].name}` : 'Junction';
    };
    body.append(h('div', { class: 'insp-head' }, h('div', { class: 'insp-thumb wire', style: `--c:${wire.color}` }), h('div', {}, h('div', { class: 'insp-title' }, 'Jumper Wire'), h('div', { class: 'insp-sub' }, `${desc(wire.a)} → ${desc(wire.b)}`))));
    const sw = h('div', { class: 'swatches big' });
    WIRE_COLORS.forEach((c) => sw.append(h('button', { class: 'swatch' + (c.hex === wire.color ? ' active' : ''), style: `--c:${c.hex}`, title: c.name, onclick: () => { wire.color = c.hex; app.commit('Wire color'); this.inspect(); } })));
    body.append(h('div', { class: 'group' }, h('div', { class: 'group-label' }, 'Color'), sw));
    body.append(h('p', { class: 'desc' }, 'Drag the end handles to re-route. Drag the wire itself to add a bend; double-click a bend to remove it.'));
    body.append(h('div', { class: 'actions' }, h('button', { class: 'btn danger', onclick: () => app.editor.deleteSelection() }, 'Delete Wire')));
  }

  inspectBoard(body, board) {
    const app = this.app;
    body.append(h('div', { class: 'insp-head' }, h('div', { class: 'insp-thumb' }, thumb({ board: board.size }, 64, 48)), h('div', {}, h('div', { class: 'insp-title' }, 'Breadboard'), h('div', { class: 'insp-sub' }, BOARD_SIZES[board.size].label))));
    const sel = h('select', { class: 'input', onchange: (e) => { board.size = e.target.value; app.commit('Board size'); this.inspect(); } });
    for (const [k, v] of Object.entries(BOARD_SIZES)) sel.append(h('option', { value: k, selected: k === board.size }, v.label));
    body.append(h('div', { class: 'group' }, h('label', { class: 'field' }, h('span', {}, 'Size'), sel)));
    body.append(h('p', { class: 'desc' }, 'Each numbered column of five holes (a–e, f–j) is connected. The + and − rails run the full length. Drag the ⠿ grip to move the board with everything on it.'));
    body.append(h('div', { class: 'actions' }, h('button', { class: 'btn danger', onclick: () => app.editor.deleteSelection() }, 'Delete Board')));
  }

  // --------------------------------------------------------------- analyzer --
  buildAnalyzer() {
    this.an = { el: $('#analyzer'), cv: $('#an-canvas'), list: $('#an-list'), window: 2 };
    $('#an-close').addEventListener('click', () => this.toggleAnalyzer(false));
    $('#an-clear').addEventListener('click', () => { this.app.circuit.probes = []; this.app.commit('Clear probes'); this.renderProbes(); });
    $('#an-window').addEventListener('change', (e) => { this.an.window = +e.target.value; });
  }
  toggleAnalyzer(force) {
    const open = force ?? !document.body.classList.contains('analyzer-open');
    document.body.classList.toggle('analyzer-open', open);
    $('#btn-analyzer').classList.toggle('on', open);
    this.renderProbes();
    setTimeout(() => this.app.resize(), 220);
  }
  renderProbes() {
    const list = this.an.list;
    list.innerHTML = '';
    const probes = this.app.circuit.probes;
    if (!probes.length) list.append(h('div', { class: 'an-empty' }, 'Right-click any hole or pin and choose “Add Probe”, or click a pin in an IC’s pinout.'));
    probes.forEach((p) => list.append(h('div', { class: 'an-row' }, h('i', { style: `background:${p.color}` }),
      h('span', { class: 'an-name', title: p.name }, p.name),
      h('button', { class: 'an-mode' + (p.analog ? ' on' : ''), title: p.analog ? 'Showing voltage — click for HIGH/LOW' : 'Showing HIGH/LOW — click for voltage', onclick: () => { p.analog = !p.analog; this.app.commit('Probe mode'); } }, '∿'),
      h('button', { class: 'an-x', title: 'Remove', onclick: () => { this.app.removeProbe(p.id); } }, '×'))));
  }
  drawAnalyzer() {
    if (!document.body.classList.contains('analyzer-open')) return;
    const cv = this.an.cv, app = this.app;
    const r = cv.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(r.width * dpr) || cv.height !== Math.round(r.height * dpr)) {
      cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
      cv.style.width = r.width + 'px'; cv.style.height = r.height + 'px';
    }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = r.width, H = r.height;
    g.clearRect(0, 0, W, H);
    const probes = app.circuit.probes;
    const dark = document.documentElement.dataset.theme === 'dark';
    const lane = 34;
    const t1 = app.engine.time, t0 = t1 - this.an.window;
    g.strokeStyle = dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
    g.lineWidth = 1;
    for (let k = 0; k <= 10; k++) { const x = (k / 10) * W; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
    probes.forEach((p, i) => {
      const buf = app.samples.get(p.id);
      if (!buf) return;
      const yHi = i * lane + 9, yLo = i * lane + lane - 7;
      g.strokeStyle = p.color; g.lineWidth = 1.8; g.lineJoin = 'miter';
      g.beginPath();
      let started = false, lastY = 0;
      for (let k = 0; k < buf.t.length; k++) {
        const t = buf.t[k];
        if (t < t0) continue;
        const x = ((t - t0) / this.an.window) * W;
        const v = buf.v[k];
        // Analog probes plot voltage (0–5 V) so RC charge curves are visible; digital ones plot HIGH/LOW.
        const y = p.analog
          ? (Number.isNaN(v) ? yLo : yLo - Math.max(0, Math.min(1, v / 5)) * (yLo - yHi))
          : (Number.isNaN(v) ? (yHi + yLo) / 2 : v >= 2 ? yHi : v <= 0.8 ? yLo : (yHi + yLo) / 2);
        if (!started) { g.moveTo(x, y); started = true; } else if (p.analog) g.lineTo(x, y); else { g.lineTo(x, lastY); g.lineTo(x, y); }
        lastY = y;
      }
      if (started) g.lineTo(W, lastY);
      g.stroke();
      const last = buf.v[buf.v.length - 1];
      if (p.analog && last !== undefined) {
        g.fillStyle = p.color; g.font = '600 10px "SF Mono", ui-monospace, Menlo, monospace'; g.textAlign = 'right';
        g.fillText(Number.isNaN(last) ? 'no power' : last.toFixed(2) + ' V', W - 6, yHi + 4);
      }
    });
    g.fillStyle = dark ? '#8e8e93' : '#8e8e93'; g.font = '10px -apple-system, Inter, sans-serif'; g.textAlign = 'right';
    g.fillText(`${this.an.window} s window`, W - 6, H - 6);
  }

  // ------------------------------------------------ floating instruments --
  clampInstrumentWindows() {
    if (!this.instWins || !this.instWins.size) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    for (const entry of this.instWins.values()) {
      const el = entry.el;
      const r = el.getBoundingClientRect();
      const maxX = Math.max(8, vw - r.width - 8);
      const maxY = Math.max(58, vh - r.height - 8);
      const curX = parseFloat(el.style.left) || r.left;
      const curY = parseFloat(el.style.top) || r.top;
      const nx = Math.max(8, Math.min(maxX, curX));
      const ny = Math.max(58, Math.min(maxY, curY));
      el.style.left = Math.round(nx) + 'px';
      el.style.top = Math.round(ny) + 'px';
    }
  }

  openInstrumentWindow(part) {
    const existing = this.instWins.get(part.id);
    if (existing) {
      existing.part = part;
      existing.el.classList.remove('min');
      existing.minBtn.textContent = '−';
      existing.el.style.zIndex = String(++this.instZ);
      existing.update();
      this.clampInstrumentWindows();
      return;
    }
    const def = getDef(part.type);
    const nOpen = this.instWins.size;
    const isScope = part.type === 'oscilloscope';
    const widthEst = isScope ? Math.min(740, window.innerWidth - 20) : Math.min(500, window.innerWidth - 20);
    const libW = document.body.classList.contains('no-library') ? 16 : 260;
    const x0 = Math.max(8, Math.min(window.innerWidth - widthEst - 10, libW + ((nOpen * 28) % 120)));
    const y0 = Math.max(60, Math.min(window.innerHeight - 280, 66 + (nOpen * 28) % 110));

    const dot = h('i', { class: 'inst-dot' });
    const titleEl = h('span', { class: 'inst-title' }, def.name);
    const minBtn = h('button', { class: 'inst-hbtn', title: 'Minimize' }, '−');
    const closeBtn = h('button', { class: 'inst-hbtn', title: 'Close' }, '×');
    const head = h('div', { class: 'inst-head' }, dot, titleEl, minBtn, closeBtn);
    const body = h('div', { class: 'inst-body' });
    const el = h('div', { class: 'inst-win' + (isScope ? ' inst-scope' : ''), style: `left:${Math.round(x0)}px;top:${Math.round(y0)}px;z-index:${++this.instZ}` }, head, body);

    el.addEventListener('pointerdown', () => { el.style.zIndex = String(++this.instZ); });
    minBtn.addEventListener('click', () => {
      const m = el.classList.toggle('min');
      minBtn.textContent = m ? '+' : '−';
      this.clampInstrumentWindows();
    });
    closeBtn.addEventListener('click', () => this.closeInstrumentWindow(part.id));

    head.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.inst-hbtn')) return;
      e.preventDefault();
      const sx = e.clientX, sy = e.clientY;
      const r = el.getBoundingClientRect();
      const ox = r.left, oy = r.top;
      const onMove = (ev) => {
        const cur = el.getBoundingClientRect();
        const maxX = Math.max(8, window.innerWidth - cur.width - 8);
        const maxY = Math.max(58, window.innerHeight - cur.height - 8);
        const nx = Math.max(8, Math.min(maxX, ox + ev.clientX - sx));
        const ny = Math.max(58, Math.min(maxY, oy + ev.clientY - sy));
        el.style.left = Math.round(nx) + 'px';
        el.style.top = Math.round(ny) + 'px';
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });

    let updater = () => {};
    if (isScope) updater = this._buildScopeWindow(part, body, dot);
    else if (part.type === 'funcgen') updater = this._buildFuncGenWindow(part, body, dot);
    else if (part.type === 'power-supply') updater = this._buildPsuWindow(part, body, dot);

    this.instLayer.append(el);
    this.instWins.set(part.id, { el, part, minBtn, update: updater });
    updater();
    this.clampInstrumentWindows();
  }

  closeInstrumentWindow(partId) {
    const entry = this.instWins.get(partId);
    if (!entry) return;
    entry.el.remove();
    this.instWins.delete(partId);
  }

  updateInstrumentWindows() {
    if (!this.instWins || !this.instWins.size) return;
    for (const [id, entry] of [...this.instWins]) {
      const live = this.app.circuit.parts.find(p => p.id === id);
      if (!live) { this.closeInstrumentWindow(id); continue; }
      entry.part = live;
      if (!entry.el.classList.contains('min')) entry.update();
    }
  }

  _makeKnob({ label, min = 0, max = 1, log = false, choices = null, format, get, set }) {
    const arcLen = 87.18;
    const dial = h('div', {
      class: 'rknob',
      title: 'Drag or scroll to adjust; double-click to type value',
      html: `<svg viewBox="0 0 44 44" class="rknob-svg" aria-hidden="true">
        <path class="rknob-track" d="M 8.92 35.08 A 18.5 18.5 0 1 1 35.08 35.08"/>
        <path class="rknob-arc" d="M 8.92 35.08 A 18.5 18.5 0 1 1 35.08 35.08" stroke-dasharray="${arcLen}" stroke-dashoffset="${arcLen}"/>
        <g class="rknob-rotor" style="transform-origin:22px 22px">
          <circle cx="22" cy="22" r="13.5" class="rknob-cap"/>
          <line x1="22" y1="20" x2="22" y2="11" class="rknob-tick"/>
        </g>
      </svg>`,
    });
    const rotor = dial.querySelector('.rknob-rotor');
    const arc = dial.querySelector('.rknob-arc');
    const valEl = h('div', { class: 'rknob-val' });
    const wrap = h('div', { class: 'rknob-wrap' }, h('div', { class: 'rknob-lbl' }, label), dial, valEl);

    const toFrac = (v) => {
      if (choices) {
        let best = 0, bd = Infinity;
        for (let i = 0; i < choices.length; i++) { const d = Math.abs(choices[i] - v); if (d < bd) { bd = d; best = i; } }
        return choices.length > 1 ? best / (choices.length - 1) : 0;
      }
      if (log) {
        const lo = Math.max(1e-3, min), hi = Math.max(lo * 10, max);
        return Math.max(0, Math.min(1, Math.log(Math.max(lo, v) / lo) / Math.log(hi / lo)));
      }
      return Math.max(0, Math.min(1, (v - min) / Math.max(1e-6, max - min)));
    };
    const fromFrac = (f) => {
      f = Math.max(0, Math.min(1, f));
      if (choices) return choices[Math.round(f * (choices.length - 1))];
      if (log) {
        const lo = Math.max(1e-3, min), hi = Math.max(lo * 10, max);
        const v = lo * Math.pow(hi / lo, f);
        return v >= 100 ? Math.round(v) : +v.toPrecision(3);
      }
      const v = min + f * (max - min);
      return +v.toFixed(Math.abs(max - min) >= 10 ? 1 : 2);
    };
    const sync = () => {
      const v = get();
      const f = toFrac(v);
      rotor.style.transform = `rotate(${(-135 + f * 270).toFixed(1)}deg)`;
      arc.style.opacity = f <= 0.005 ? '0' : '1';
      arc.style.strokeDashoffset = (arcLen * (1 - f)).toFixed(2);
      valEl.textContent = format ? format(v) : String(v);
    };
    const apply = (nv) => {
      set(nv);
      this.app.stateChanged(false);
      sync();
      this.updateInstrumentWindows();
    };

    dial.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const sx = e.clientX, sy = e.clientY;
      const f0 = toFrac(get());
      const onMove = (ev) => {
        const d = ((sy - ev.clientY) + (ev.clientX - sx)) / 140;
        apply(fromFrac(f0 + d));
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        if (this.app.editor.selected().parts[0]) this.inspect();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
    dial.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (choices) {
        let best = 0, bd = Infinity; const cur = get();
        for (let i = 0; i < choices.length; i++) { const d = Math.abs(choices[i] - cur); if (d < bd) { bd = d; best = i; } }
        apply(choices[Math.max(0, Math.min(choices.length - 1, best + (e.deltaY < 0 ? 1 : -1)))]);
      } else {
        apply(fromFrac(toFrac(get()) + (e.deltaY < 0 ? 0.03 : -0.03)));
      }
    }, { passive: false });
    dial.addEventListener('dblclick', () => {
      if (choices) return;
      const s = prompt(`${label} (${min} .. ${max})`, String(get()));
      if (s === null) return;
      const n = parseFloat(s);
      if (Number.isFinite(n)) apply(Math.max(min, Math.min(max, n)));
    });
    sync();
    return { wrap, sync };
  }

  _buildPsuWindow(part, body, dot) {
    const p = part.props;
    const boxes = ['SLAVE A', 'SLAVE V', 'MASTER A', 'MASTER V'].map((lbl, i) => {
      const val = h('div', { class: 'seg-val' + (i % 2 === 0 ? ' amp' : '') }, '0.0');
      return { el: h('div', { class: 'seg-box' }, h('div', { class: 'seg-lbl' }, lbl), val), val };
    });
    const meters = h('div', { class: 'psu-meters' }, ...boxes.map(b => b.el));

    const ccS = h('span', { class: 'led-pill' }, 'SLAVE C.V.');
    const ccM = h('span', { class: 'led-pill' }, 'MASTER C.V.');
    const fix5 = h('span', { class: 'led-pill cv' }, '5V FIXED: 0.00A');
    const bar = h('div', { class: 'psu-chbar' }, ccS, fix5, ccM);

    const bPwr = h('button', { class: 'hw-btn', onclick: () => { p.power = !p.power; this.app.stateChanged(false); update(); } }, 'POWER');
    const bInd = h('button', { class: 'hw-btn', onclick: () => { p.mode = 'indep'; this.app.stateChanged(false); update(); } }, 'INDEP.');
    const bSer = h('button', { class: 'hw-btn', onclick: () => { p.mode = 'series'; this.app.stateChanged(false); update(); } }, 'SERIES (60V / ±)');
    const bPar = h('button', { class: 'hw-btn', onclick: () => { p.mode = 'parallel'; this.app.stateChanged(false); update(); } }, 'PARALLEL (2×A)');
    const btnRow = h('div', { class: 'inst-btn-row' }, bPwr, bInd, bSer, bPar);

    const kI2 = this._makeKnob({ label: 'Slave Current', min: 0.05, max: 5, format: v => `${v.toFixed(2)}A`, get: () => +p.i2 || 2, set: v => { p.i2 = v; } });
    const kV2 = this._makeKnob({ label: 'Slave Voltage', min: 0, max: 30, format: v => `${v.toFixed(1)}V`, get: () => (p.mode !== 'indep' ? +p.v1 : +p.v2) || 0, set: v => { p.v2 = v; if (p.mode !== 'indep') p.v1 = v; } });
    const kI1 = this._makeKnob({ label: 'Master Current', min: 0.05, max: 5, format: v => `${v.toFixed(2)}A`, get: () => +p.i1 || 2, set: v => { p.i1 = v; } });
    const kV1 = this._makeKnob({ label: 'Master Voltage', min: 0, max: 30, format: v => `${v.toFixed(1)}V`, get: () => +p.v1 || 0, set: v => { p.v1 = v; } });
    const knobGrid = h('div', { class: 'knob-grid k4' }, kI2.wrap, kV2.wrap, kI1.wrap, kV1.wrap);

    body.append(meters, bar, btnRow, knobGrid);

    const update = () => {
      const on = !!p.power;
      dot.classList.toggle('off', !on);
      bPwr.className = 'hw-btn ' + (on ? 'run' : 'stop');
      bPwr.textContent = on ? 'POWER: ON' : 'POWER: OFF';
      bInd.className = 'hw-btn' + (p.mode === 'indep' ? ' on' : '');
      bSer.className = 'hw-btn' + (p.mode === 'series' ? ' on' : '');
      bPar.className = 'hw-btn' + (p.mode === 'parallel' ? ' on' : '');

      const d = this.app.engine.byPart.get(part.id)?.device;
      const v1Set = Math.max(0, Math.min(30, +p.v1 || 0));
      const v2Set = p.mode === 'indep' ? Math.max(0, Math.min(30, +p.v2 || 0)) : v1Set;
      boxes[0].val.textContent = on ? (d ? d.measI2 : 0).toFixed(2) : '---';
      boxes[1].val.textContent = on ? (d ? d.measV2 : v2Set).toFixed(1) : '---';
      boxes[2].val.textContent = on ? (d ? d.measI1 : 0).toFixed(2) : '---';
      boxes[3].val.textContent = on ? (d ? d.measV1 : v1Set).toFixed(1) : '---';

      ccS.className = 'led-pill' + (on ? (d && d.cc2 ? ' cc' : ' cv') : '');
      ccS.textContent = on ? (d && d.cc2 ? 'SLAVE C.C.' : 'SLAVE C.V.') : 'SLAVE OFF';
      ccM.className = 'led-pill' + (on ? (d && d.cc1 ? ' cc' : ' cv') : '');
      ccM.textContent = on ? (d && d.cc1 ? 'MASTER C.C.' : 'MASTER C.V.') : 'MASTER OFF';
      const ov5 = on && !!(d && d.overload5);
      fix5.className = 'led-pill' + (on ? (ov5 ? ' cc' : ' cv') : '');
      fix5.textContent = ov5 ? `5V OVERLOAD (${d.measI3.toFixed(2)}A)` : `5V FIXED: ${on && d ? d.measI3.toFixed(2) : '0.00'}A`;

      kI2.sync(); kV2.sync(); kI1.sync(); kV1.sync();
    };
    return update;
  }

  _buildFuncGenWindow(part, body, dot) {
    const p = part.props;
    const freqEl = h('div', { class: 'fg-freq' }, '10.0 Hz');
    const metaEl = h('div', { class: 'fg-meta' }, '∿ Sine\n5.0 Vpp');
    const lcd = h('div', { class: 'fg-lcd' }, freqEl, metaEl);
    const rngNames = ['MHz', 'kHz', 'Hz', 'mHz'];
    const rngSpans = rngNames.map(n => h('span', {}, n));
    const bUp = h('button', { class: 'hw-btn', onclick: () => { p.hz = Math.min(100000, +((+p.hz || 10) * 10).toPrecision(4)); this.app.stateChanged(false); update(); } }, '×10 ▲');
    const bDn = h('button', { class: 'hw-btn', onclick: () => { p.hz = Math.max(0.1, +((+p.hz || 10) * 0.1).toPrecision(4)); this.app.stateChanged(false); update(); } }, '÷10 ▼');
    const top = h('div', { class: 'fg-top' }, lcd, h('div', { class: 'fg-rng-leds' }, ...rngSpans), h('div', { style: 'display:flex;flex-direction:column;gap:4px' }, bUp, bDn));

    const bPwr = h('button', { class: 'hw-btn', onclick: () => { p.power = !p.power; this.app.stateChanged(false); update(); } }, 'POWER');
    const bSin = h('button', { class: 'hw-btn', onclick: () => { p.wave = 'sine'; this.app.stateChanged(false); update(); } }, '∿ Sine');
    const bTri = h('button', { class: 'hw-btn', onclick: () => { p.wave = 'tri'; this.app.stateChanged(false); update(); } }, '∧ Tri');
    const bSq = h('button', { class: 'hw-btn', onclick: () => { p.wave = 'square'; this.app.stateChanged(false); update(); } }, '⊓ Square');
    const bSym = h('button', { class: 'hw-btn', onclick: () => { p.symOn = !p.symOn; this.app.stateChanged(false); update(); } }, 'SYM');
    const bOff = h('button', { class: 'hw-btn', onclick: () => { p.offsetOn = !p.offsetOn; if (p.offsetOn && !p.offset) p.offset = 2.5; this.app.stateChanged(false); update(); } }, 'OFFSET');
    const bAtt = h('button', { class: 'hw-btn', onclick: () => { p.att20dB = !p.att20dB; this.app.stateChanged(false); update(); } }, '−20 dB');
    const bSwp = h('button', { class: 'hw-btn', onclick: () => { p.sweepOn = !p.sweepOn; this.app.stateChanged(false); update(); } }, 'SWEEP');
    const row1 = h('div', { class: 'inst-btn-row' }, bPwr, bSin, bTri, bSq, bSym, bOff, bAtt, bSwp);

    const kHz = this._makeKnob({ label: 'Frequency', min: 0.5, max: 10000, log: true, format: v => fmtUnits(v, 'Hz'), get: () => +p.hz || 10, set: v => { p.hz = v; } });
    const kVpp = this._makeKnob({ label: 'Amplitude', min: 0.2, max: 20, format: v => `${v.toFixed(1)} Vpp`, get: () => +p.vpp || 5, set: v => { p.vpp = v; } });
    const kOff = this._makeKnob({ label: 'DC Offset', min: -10, max: 10, format: v => `${v >= 0 ? '+' : ''}${v.toFixed(1)} V`, get: () => +p.offset || 0, set: v => { p.offset = v; if (Math.abs(v) > 0.05) p.offsetOn = true; } });
    const kSym = this._makeKnob({ label: 'Symmetry', min: 10, max: 90, format: v => `${Math.round(v)}%`, get: () => +p.duty || 50, set: v => { p.duty = Math.round(v); p.symOn = true; } });
    const kSwp = this._makeKnob({ label: 'Sweep Stop', min: 5, max: 5000, log: true, format: v => fmtUnits(v, 'Hz'), get: () => +p.sweepStopHz || 50, set: v => { p.sweepStopHz = v; } });
    const knobs = h('div', { class: 'knob-grid k5' }, kHz.wrap, kVpp.wrap, kOff.wrap, kSym.wrap, kSwp.wrap);

    body.append(top, row1, knobs);

    const update = () => {
      const on = !!p.power;
      dot.classList.toggle('off', !on);
      lcd.classList.toggle('off', !on);
      const d = this.app.engine.byPart.get(part.id)?.device;
      const hz = d && on && p.sweepOn ? d.instHz : Math.max(0.1, +p.hz || 10);
      const vppEff = Math.max(0.1, +p.vpp || 5) * (p.att20dB ? 0.1 : 1);
      const wName = p.wave === 'tri' ? '∧ Triangle' : p.wave === 'square' ? '⊓ Square' : '∿ Sine';
      freqEl.textContent = on ? fmtUnits(hz, 'Hz') : 'POWER OFF';
      metaEl.innerHTML = esc(wName) + ` · ${vppEff.toFixed(2)} Vpp<br>` +
        `Off:${p.offsetOn ? ((+p.offset || 0).toFixed(1) + 'V') : '0V'} · Duty:${p.symOn ? Math.round(+p.duty || 50) : 50}%`;

      const idx = hz >= 1e6 ? 0 : hz >= 1000 ? 1 : hz >= 1 ? 2 : 3;
      rngSpans.forEach((s, i) => s.classList.toggle('on', on && i === idx));
      bPwr.className = 'hw-btn ' + (on ? 'run' : 'stop');
      bSin.className = 'hw-btn' + (p.wave === 'sine' ? ' on' : '');
      bTri.className = 'hw-btn' + (p.wave === 'tri' ? ' on' : '');
      bSq.className = 'hw-btn' + (p.wave === 'square' ? ' on' : '');
      bSym.className = 'hw-btn' + (p.symOn ? ' on' : '');
      bOff.className = 'hw-btn' + (p.offsetOn ? ' on' : '');
      bAtt.className = 'hw-btn' + (p.att20dB ? ' on' : '');
      bSwp.className = 'hw-btn' + (p.sweepOn ? ' on' : '');

      kHz.sync(); kVpp.sync(); kOff.sync(); kSym.sync(); kSwp.sync();
    };
    return update;
  }

  _buildScopeWindow(part, body, dot) {
    const p = part.props;
    const cv = h('canvas', { class: 'scope-cv' });
    const dpr = Math.max(2, window.devicePixelRatio || 1);
    const W = 420, H = 240;
    cv.width = W * dpr; cv.height = H * dpr;

    const c1Card = h('div', { class: 'meas-card ch1' }, h('span', {}, 'CH1'), h('span', {}, '--'));
    const c2Card = h('div', { class: 'meas-card ch2' }, h('span', {}, 'CH2'), h('span', {}, '--'));
    const measRow = h('div', { class: 'scope-meas' }, c1Card, c2Card);
    const leftCol = h('div', { class: 'scope-screen-col' }, cv, measRow);

    const bRun = h('button', { class: 'hw-btn', onclick: () => { p.run = !p.run; this.app.stateChanged(false); update(); } }, 'RUN');
    const bAuto = h('button', { class: 'hw-btn', onclick: () => {
      const d = this.app.engine.byPart.get(part.id)?.device;
      if (d) d.autoScale(p);
      this.app.stateChanged(false); update();
    } }, 'AUTO');
    const b50 = h('button', { class: 'hw-btn', onclick: () => {
      const d = this.app.engine.byPart.get(part.id)?.device;
      if (d) {
        const w = computeScopeWindow(d, +p.timeDiv || 0.05);
        if (w) { const st = measureChannelStats(d, p.trigSrc === 'CH2' ? d.buf2 : d.buf1, w); if (st.valid) p.trigLevel = p.coupling === 'AC' ? 0 : +((st.min + st.max) * 0.5).toFixed(2); }
      }
      this.app.stateChanged(false); update();
    } }, 'TRIG 50%');
    const bCh1 = h('button', { class: 'hw-btn ch1', onclick: () => { p.ch1On = !p.ch1On; this.app.stateChanged(false); update(); } }, 'CH1');
    const bCh2 = h('button', { class: 'hw-btn ch2', onclick: () => { p.ch2On = !p.ch2On; this.app.stateChanged(false); update(); } }, 'CH2');
    const bMath = h('button', { class: 'hw-btn math', onclick: () => { p.math = p.math === 'off' ? 'sub' : p.math === 'sub' ? 'add' : 'off'; this.app.stateChanged(false); update(); } }, 'MATH');
    const bCpl = h('button', { class: 'hw-btn', onclick: () => { p.coupling = p.coupling === 'AC' ? 'DC' : 'AC'; this.app.stateChanged(false); update(); } }, 'DC');
    const bXY = h('button', { class: 'hw-btn', onclick: () => { p.xyMode = !p.xyMode; this.app.stateChanged(false); update(); } }, 'Y-T');
    const bTrig = h('button', { class: 'hw-btn', onclick: () => { p.trigSrc = p.trigSrc === 'CH1' ? 'CH2' : p.trigSrc === 'CH2' ? 'EXT' : 'CH1'; this.app.stateChanged(false); update(); } }, 'TRG:CH1');

    const kV1 = this._makeKnob({ label: 'CH1 V/div', choices: SCOPE_VDIV, format: v => fmtUnits(v, 'V'), get: () => +p.ch1Scale || 2, set: v => { p.ch1Scale = v; } });
    const kV2 = this._makeKnob({ label: 'CH2 V/div', choices: SCOPE_VDIV, format: v => fmtUnits(v, 'V'), get: () => +p.ch2Scale || 2, set: v => { p.ch2Scale = v; } });
    const kT = this._makeKnob({ label: 'Sec/div', choices: SCOPE_TDIV, format: v => fmtUnits(v, 's'), get: () => +p.timeDiv || 0.05, set: v => { p.timeDiv = v; } });
    const kP1 = this._makeKnob({ label: 'CH1 Pos', min: -4, max: 4, format: v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}d`, get: () => +p.ch1Pos || 0, set: v => { p.ch1Pos = v; } });
    const kP2 = this._makeKnob({ label: 'CH2 Pos', min: -4, max: 4, format: v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}d`, get: () => +p.ch2Pos || 0, set: v => { p.ch2Pos = v; } });
    const kTr = this._makeKnob({ label: 'Trig Lvl', min: -15, max: 15, format: v => `${v >= 0 ? '+' : ''}${v.toFixed(1)}V`, get: () => +p.trigLevel || 0, set: v => { p.trigLevel = v; } });

    const rightCol = h('div', { class: 'scope-ctrl-col' },
      h('div', { class: 'inst-btn-row' }, bRun, bAuto, b50, bTrig),
      h('div', { class: 'inst-btn-row' }, bCh1, bCh2, bMath, bCpl, bXY),
      h('div', { class: 'knob-grid' }, kV1.wrap, kV2.wrap, kT.wrap, kP1.wrap, kP2.wrap, kTr.wrap));

    body.append(h('div', { class: 'scope-grid-main' }, leftCol, rightCol));

    const update = () => {
      dot.classList.toggle('off', false);
      bRun.className = 'hw-btn ' + (p.run ? 'run' : 'stop');
      bRun.textContent = p.run ? 'RUN' : 'STOP';
      bCh1.className = 'hw-btn ch1' + (p.ch1On ? ' on' : '');
      bCh2.className = 'hw-btn ch2' + (p.ch2On ? ' on' : '');
      bMath.className = 'hw-btn math' + (p.math && p.math !== 'off' ? ' on' : '');
      bMath.textContent = p.math === 'add' ? 'CH1+CH2' : p.math === 'sub' ? 'CH1−CH2' : 'MATH';
      bCpl.textContent = `CPL:${p.coupling || 'DC'}`;
      bCpl.className = 'hw-btn' + (p.coupling === 'AC' ? ' on' : '');
      bXY.textContent = p.xyMode ? 'MODE:X-Y' : 'MODE:Y-T';
      bXY.className = 'hw-btn' + (p.xyMode ? ' on' : '');
      bTrig.textContent = `TRG:${p.trigSrc || 'CH1'}`;

      const g = cv.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = '#060a10';
      g.fillRect(0, 0, W, H);
      const px0 = 14, py0 = 20, plotW = W - 24, plotH = H - 38;
      // Graticule 10x8
      g.strokeStyle = 'rgba(148,163,184,0.18)'; g.lineWidth = 1;
      g.beginPath();
      for (let i = 0; i <= 10; i++) { const x = px0 + (i / 10) * plotW; g.moveTo(x, py0); g.lineTo(x, py0 + plotH); }
      for (let j = 0; j <= 8; j++) { const y = py0 + (j / 8) * plotH; g.moveTo(px0, y); g.lineTo(px0 + plotW, y); }
      g.stroke();
      // Center axes highlight
      g.strokeStyle = 'rgba(148,163,184,0.34)';
      g.beginPath();
      g.moveTo(px0, py0 + plotH / 2); g.lineTo(px0 + plotW, py0 + plotH / 2);
      g.moveTo(px0 + plotW / 2, py0); g.lineTo(px0 + plotW / 2, py0 + plotH);
      g.stroke();

      const d = this.app.engine.byPart.get(part.id)?.device;
      const timeDiv = Math.max(0.0001, +p.timeDiv || 0.05);
      const s1 = Math.max(0.05, +p.ch1Scale || 2), s2 = Math.max(0.05, +p.ch2Scale || 2);
      const pos1 = +p.ch1Pos || 0, pos2 = +p.ch2Pos || 0;
      const divH = plotH / 8, midY = py0 + plotH / 2;
      const win = d ? computeScopeWindow(d, timeDiv) : null;
      let st1 = null, st2 = null;

      if (win) {
        const ac = p.coupling === 'AC';
        st1 = measureChannelStats(d, d.buf1, win);
        st2 = measureChannelStats(d, d.buf2, win);
        const off1 = ac && st1.valid ? st1.vavg : 0;
        const off2 = ac && st2.valid ? st2.vavg : 0;

        if (p.xyMode && p.ch1On && p.ch2On) {
          g.strokeStyle = '#38bdf8'; g.lineWidth = 2; g.beginPath();
          let moved = false;
          for (let k = 0; k < win.count; k++) {
            const idx = win.idxAt(k), t = d.bufT[idx];
            if (t < win.tStart || t > win.tEnd) continue;
            const v1 = d.buf1[idx] - off1, v2 = d.buf2[idx] - off2;
            if (Number.isNaN(v1) || Number.isNaN(v2)) { moved = false; continue; }
            const x = px0 + plotW * 0.5 + (v1 / s1) * (plotW / 10);
            const y = Math.max(py0, Math.min(py0 + plotH, midY - ((v2 / s2) + pos2) * divH));
            if (!moved) { g.moveTo(x, y); moved = true; } else g.lineTo(x, y);
          }
          g.stroke();
        } else {
          const drawWave = (getter, col) => {
            g.strokeStyle = col; g.lineWidth = 2; g.beginPath();
            let moved = false;
            for (let k = 0; k < win.count; k++) {
              const idx = win.idxAt(k), t = d.bufT[idx];
              if (t < win.tStart || t > win.tEnd) continue;
              const v = getter(idx);
              if (Number.isNaN(v)) { moved = false; continue; }
              const x = px0 + ((t - win.tStart) / win.span) * plotW;
              const y = Math.max(py0 + 1, Math.min(py0 + plotH - 1, midY - v * divH));
              if (!moved) { g.moveTo(x, y); moved = true; } else g.lineTo(x, y);
            }
            g.stroke();
          };
          if (p.ch1On) drawWave(i => (d.buf1[i] - off1) / s1 + pos1, '#facc15');
          if (p.ch2On) drawWave(i => (d.buf2[i] - off2) / s2 + pos2, '#22d3ee');
          if (p.math && p.math !== 'off') {
            const sign = p.math === 'add' ? 1 : -1;
            drawWave(i => ((d.buf1[i] - off1) + sign * (d.buf2[i] - off2)) / s1, '#e879f9');
          }
        }
      }

      // Baseline markers & trigger level indicator
      g.font = '700 10px ui-monospace, Menlo, monospace';
      if (p.ch1On) { g.fillStyle = '#facc15'; g.fillText('1▸', 2, Math.max(py0 + 8, Math.min(py0 + plotH, midY - pos1 * divH + 3))); }
      if (p.ch2On) { g.fillStyle = '#22d3ee'; g.fillText('2▸', 2, Math.max(py0 + 8, Math.min(py0 + plotH, midY - pos2 * divH + 3))); }
      const trigS = p.trigSrc === 'CH2' ? s2 : s1;
      const trigP = p.trigSrc === 'CH2' ? pos2 : pos1;
      const ty = Math.max(py0, Math.min(py0 + plotH, midY - (((+p.trigLevel || 0) / trigS) + trigP) * divH));
      g.save(); g.setLineDash([4, 4]); g.strokeStyle = 'rgba(251,146,60,0.45)'; g.beginPath(); g.moveTo(px0, ty); g.lineTo(px0 + plotW, ty); g.stroke(); g.restore();

      // Header & footer text
      const stTxt = !p.run ? 'STOP' : (win && win.triggered ? "Trig'd" : 'Auto');
      g.fillStyle = !p.run ? '#ef4444' : '#4ade80'; g.fillText(stTxt, px0, 14);
      g.fillStyle = '#e2e8f0'; g.fillText(`M ${fmtUnits(timeDiv, 's')}/div`, px0 + 68, 14);
      g.fillStyle = '#fb923c'; g.fillText(`${p.trigSrc || 'CH1'}: ${(+p.trigLevel || 0).toFixed(2)}V`, W - 115, 14);
      g.fillStyle = p.ch1On ? '#facc15' : '#64748b'; g.fillText(`CH1 ${fmtUnits(s1, 'V')}/div`, px0, H - 5);
      g.fillStyle = p.ch2On ? '#22d3ee' : '#64748b'; g.fillText(`CH2 ${fmtUnits(s2, 'V')}/div`, px0 + 115, H - 5);

      const fmtCard = (st) => !st || !st.valid ? 'No signal' : `${st.vpp.toFixed(2)}Vpp · avg ${st.vavg.toFixed(2)}V · ${st.freq > 0 ? fmtUnits(st.freq, 'Hz') : 'DC'}`;
      c1Card.lastChild.textContent = fmtCard(st1);
      c2Card.lastChild.textContent = fmtCard(st2);

      kV1.sync(); kV2.sync(); kT.sync(); kP1.sync(); kP2.sync(); kTr.sync();
    };
    return update;
  }
}

import { allDefs, getDef, CATEGORIES } from './parts/registry.js';
import { Part, P, BOARD_SIZES } from './model.js';
import { WIRE_COLORS } from './view/renderer.js';
import { examples } from './mcu/boards.js';
import { compile } from './mcu/transpile.js';
import { COLOR_KEYS } from './editor.js';
import { ACCENTS, BOARD_COLORS } from './settings.js';

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
    this.buildAnalyzer();
    this.bindCode();
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
    $('#btn-panel').addEventListener('click', () => document.body.classList.toggle('no-inspector'));
    $('#btn-library').addEventListener('click', () => document.body.classList.toggle('no-library'));
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
  }
  simClock() {
    const t = this.app.engine.time;
    $('#sim-time').textContent = t < 60 ? t.toFixed(1) + ' s' : Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');
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
        box(row('Show wire states', toggle('wireStates'), 'HIGH glows red, LOW blue, unpowered wires fade.'),
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
          h('p', { class: 'about-text' }, 'A breadboard workbench for learning electronics: real 74-series logic, 555 timers, LEDs and passives, and Arduino, ESP32 and STM32 boards you can program — all simulated live in your browser.')),
        box(row('Simulation engine', h('span', { class: 'set-val' }, 'Nodal analysis · datasheet IC models')),
          row('Microcontrollers', h('span', { class: 'set-val' }, 'Uno · Nano · ESP32 · ESP32-S3 · Blue Pill')),
          row('Runs', h('span', { class: 'set-val' }, 'Entirely in your browser — nothing is uploaded')),
          row('Your work', h('span', { class: 'set-val' }, 'Saved automatically on this device'))),
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
        const y = Number.isNaN(v) ? (yHi + yLo) / 2 : v >= 2 ? yHi : v <= 0.8 ? yLo : (yHi + yLo) / 2;
        if (!started) { g.moveTo(x, y); started = true; } else { g.lineTo(x, lastY); g.lineTo(x, y); }
        lastY = y;
      }
      if (started) g.lineTo(W, lastY);
      g.stroke();
    });
    g.fillStyle = dark ? '#8e8e93' : '#8e8e93'; g.font = '10px -apple-system, Inter, sans-serif'; g.textAlign = 'right';
    g.fillText(`${this.an.window} s window`, W - 6, H - 6);
  }
}

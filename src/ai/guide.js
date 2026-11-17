/**
 * Interactive "Guide Me" Step-by-Step Controller & Canvas Overlay.
 * Builds a DRC/sim-verified blueprint offscreen, watches user edits on the canvas,
 * auto-advances via electrical net/strip equivalence, and renders live target halos & ghost parts.
 */
import { Board, Circuit, Part, Wire, P } from '../model.js';
import { getDef } from '../parts/registry.js';
import { Engine, key } from '../sim/engine.js';
import { route } from '../sim/router.js';
import { findProblems } from '../editor.js';
import { applyAiBuildPlan, parseRailToken, resolveEndpoint, pickWireColor } from './builder.js';

const TAU = Math.PI * 2;
const KEY_MATCH_PROPS = ['ohms', 'uf', 'volts', 'hz', 'color', 'common', 'wave', 'model', 'mh'];

export function createSandbox(realApp) {
  const sbx = {
    circuit: new Circuit(),
    engine: new Engine(),
    index: { holes: new Map(), pins: new Map(), ends: new Map() },
    mode: 'build',
    settings: realApp.settings,
    samples: new Map(),
    netKinds: new Map(),
    checks: [],
    ui: { toggleAnalyzer: null, inspect() {}, syncToolbar() {}, renderProbes() {} },
    redraw() {},
    commit() {},
    setMode() {},
    fit() {},
    load(json) {
      this.circuit = Circuit.fromJSON(typeof json === 'string' ? JSON.parse(json) : json);
      this.reindex();
    },
    reindex(fast = false) {
      const holes = new Map(), pins = new Map(), ends = new Map();
      for (const b of this.circuit.boards) for (const hl of b.holes()) holes.set(key(hl.x, hl.y), hl);
      for (const p of this.circuit.parts) for (const q of p.worldPins()) {
        const k = key(q.x, q.y);
        if (!pins.has(k)) pins.set(k, []);
        pins.get(k).push({ part: p, i: q.i, name: q.name });
      }
      for (const w of this.circuit.wires) for (const e of [w.a, w.b]) {
        const k = key(e.x, e.y);
        if (!ends.has(k)) ends.set(k, []);
        ends.get(k).push(e);
      }
      this.index = { holes, pins, ends };
      this.engine.build(this.circuit);
      this.computeNetKinds();
      if (!fast) this.computeChecks();
    },
    computeNetKinds() { realApp.computeNetKinds?.call(this); },
    clash(a, b) { return realApp.clash(a, b); },
    supplyClash(x, y, kind, ignoreIds) { return realApp.supplyClash?.call(this, x, y, kind, ignoreIds) ?? null; },
    shortReason(a, b, ign) { return realApp.shortReason?.call(this, a, b, ign) ?? null; },
    computeChecks() { realApp.computeChecks?.call(this); },
    allIssues() { return [...this.checks]; },
    editor: null,
  };
  sbx.editor = { problems: (parts, boards = []) => findProblems(sbx, parts, boards) };
  return sbx;
}

function propsCompatible(part, wantedProps = {}) {
  for (const k of KEY_MATCH_PROPS) {
    if (wantedProps[k] !== undefined && String(part.props[k]) !== String(wantedProps[k])) return false;
  }
  return true;
}

function fmtPropsSummary(props = {}) {
  if (props.ohms != null) return props.ohms >= 1000 ? `${+(props.ohms / 1000).toFixed(2)} kΩ` : `${props.ohms} Ω`;
  if (props.uf != null) return `${props.uf} µF`;
  if (props.volts != null) return `${props.volts} V`;
  if (props.color) return props.color;
  if (props.hz != null) return `${props.hz} Hz`;
  return '';
}

function isNetOnRail(app, netId, railChar, half = 'auto') {
  if (netId < 0) return false;
  const b = app.circuit.boards[0];
  if (!b || !b.rails) return false;
  const ry = b.railY();
  const ys = [];
  if (half === 't' || half === 'auto') ys.push(b.y + (railChar === '+' ? ry.tp : ry.tn));
  if (half === 'b' || half === 'auto') ys.push(b.y + (railChar === '+' ? ry.bp : ry.bn));
  for (const y of ys) {
    for (let c = 0; c < b.cols; c++) {
      if (app.engine.netAt(b.x + 2 + c, y) === netId) return true;
    }
  }
  return false;
}

export class AiGuide {
  constructor(app) {
    this.app = app;
    this.guide = null; // { title, steps, boundParts: Map<ref, partId>, finished: false }
    this.listeners = new Set();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn(this.getState());
  }

  get activeStep() {
    if (!this.guide) return null;
    return this.guide.steps.find(s => !s.done) || null;
  }

  getState() {
    if (!this.guide) return null;
    const doneCount = this.guide.steps.filter(s => s.done).length;
    return {
      title: this.guide.title,
      total: this.guide.steps.length,
      doneCount,
      steps: this.guide.steps.map(s => ({ ...s })),
      activeStep: this.activeStep,
      finished: doneCount === this.guide.steps.length && this.guide.steps.length > 0,
    };
  }

  /** Validate a plan offscreen and start an interactive step-by-step guide session. */
  start(plan, title = 'Guided Circuit Build', { prompt = '', strictHealth = false } = {}) {
    const sbx = createSandbox(this.app);
    if (plan.clearExisting === false) {
      sbx.load(JSON.stringify(this.app.circuit));
    }
    const res = applyAiBuildPlan(sbx, plan, { commit: false, startSim: false, prompt, strictHealth });
    if (!res.ok) return res;
    return this.startFromVerified(res, title, {
      clearExisting: plan.clearExisting !== false,
      aiDescs: Array.isArray(plan.steps) ? plan.steps : [],
    });
  }

  /** Build guide steps from an already-verified build result (supports single & multi-stage guides). */
  startFromVerified(res, title = 'Guided Circuit Build', { clearExisting = true, aiDescs = [] } = {}) {
    if (clearExisting) {
      const app = this.app;
      const dirty = app.circuit.parts.length > 0 || app.circuit.wires.length > 0;
      const curSize = app.circuit.boards[0]?.size;
      if (dirty || curSize !== res.boardSize) {
        if (app.mode !== 'build') app.setMode('build');
        app.circuit.boards = [new Board(res.boardSize || 'half', 0, 0)];
        app.circuit.parts = [];
        app.circuit.wires = [];
        app.circuit.probes = [];
        app.samples.clear();
        app.commit('Start AI Guide');
        app.fit();
      }
    }

    const steps = [];
    let stepNum = 1;

    for (const rw of (res.removedWires || [])) {
      steps.push({
        id: 'st' + (stepNum++),
        kind: 'removeWire',
        wireId: rw.id,
        a: rw.a,
        b: rw.b,
        desc: `Disconnect incorrect wire ${rw.id}.`,
        done: false,
      });
    }

    for (const up of (res.updatedSpecs || [])) {
      const valTag = fmtPropsSummary(up.props) || 'updated settings';
      steps.push({
        id: 'st' + (stepNum++),
        kind: 'update',
        partId: up.partId,
        props: up.props,
        label: valTag,
        desc: `Adjust ${up.name} (${up.partId}) to ${valTag}.`,
        done: false,
      });
    }

    for (const sp of (res.placedParts || [])) {
      const valTag = fmtPropsSummary(sp.props);
      const label = valTag ? `${sp.name} (${valTag})` : sp.name;
      const aiMatch = aiDescs.find(s => s.kind === 'part' && String(s.ref || '').toUpperCase() === String(sp.ref).toUpperCase());
      steps.push({
        id: 'st' + (stepNum++),
        kind: 'part',
        ref: sp.ref,
        type: sp.type,
        name: sp.name,
        shortLabel: label,
        props: sp.props || {},
        targetX: sp.x,
        targetY: sp.y,
        targetRot: sp.rot || 0,
        desc: aiMatch?.desc || `Place ${label} at highlighted location.`,
        partialHint: '',
        done: false,
      });
    }

    for (const ws of (res.wireSpecs || [])) {
      const aiMatch = aiDescs.find(s =>
        s.kind === 'wire' &&
        ((s.from === ws.aTok && s.to === ws.bTok) || (s.from === ws.bTok && s.to === ws.aTok))
      );
      const niceTok = (tok) => (tok === '+' ? 'Top/Bottom + rail' : tok === '-' ? 'GND (−) rail' : tok);
      steps.push({
        id: 'st' + (stepNum++),
        kind: 'wire',
        aTok: ws.aTok,
        bTok: ws.bTok,
        aFallback: ws.a,
        bFallback: ws.b,
        color: ws.color,
        bridge: Boolean(ws.bridge),
        desc: aiMatch?.desc || (ws.bridge
          ? `Bridge ${ws.aTok} rail to ${ws.bTok} rail so both halves share power.`
          : `Connect ${niceTok(ws.aTok)} to ${niceTok(ws.bTok)}.`),
        done: false,
      });
    }

    this.guide = {
      title,
      steps,
      boundParts: new Map(),
      wasFinished: false,
    };

    for (const p of this.app.circuit.parts) this.guide.boundParts.set(p.id, p.id);

    this.syncProgress();
    this.app.redraw();
    return {
      ok: true,
      stepCount: steps.length,
      boardSize: res.boardSize,
      warnings: res.warnings || [],
    };
  }

  stop() {
    this.guide = null;
    this.emit();
    this.app.redraw();
  }

  onCircuitChanged() {
    if (!this.guide) return;
    this.syncProgress();
    this.app.redraw();
  }

  /** Reconcile placed parts and check electrical net equivalence for every step. */
  syncProgress() {
    const g = this.guide;
    if (!g) return;
    const app = this.app;

    // 1. Prune removed parts from bindings
    for (const [ref, id] of [...g.boundParts]) {
      if (!app.circuit.partById(id)) g.boundParts.delete(ref);
    }

    // 2. Track all bound IDs and reconcile part steps
    const usedIds = new Set(g.boundParts.values());
    for (const st of g.steps) {
      if (st.kind !== 'part') continue;
      st.partialHint = '';
      const existingId = g.boundParts.get(st.ref);
      const existingPart = existingId ? app.circuit.partById(existingId) : null;
      if (existingPart && propsCompatible(existingPart, st.props)) {
        st.done = true;
        continue;
      }
      if (existingPart && !propsCompatible(existingPart, st.props)) {
        st.done = false;
        st.partialHint = `Placed ${st.name} — set ${fmtPropsSummary(st.props)} in Inspector (or click Do Step).`;
        continue;
      }

      // Look for an unbound matching part in the live circuit
      const candidates = app.circuit.parts.filter(p => p.type === st.type && !usedIds.has(p.id));
      const exact = candidates.find(p => propsCompatible(p, st.props));
      if (exact) {
        g.boundParts.set(st.ref, exact.id);
        g.boundParts.set(String(st.ref).toUpperCase(), exact.id);
        usedIds.add(exact.id);
        st.done = true;
      } else {
        st.done = false;
        if (candidates.length) {
          g.boundParts.set(st.ref, candidates[0].id);
          usedIds.add(candidates[0].id);
          st.partialHint = `Adjust value to ${fmtPropsSummary(st.props)} in Inspector (or click Do Step).`;
        }
      }
    }

    // Build live refMap for endpoint resolution
    const refMap = new Map();
    for (const [ref, id] of g.boundParts) {
      const p = app.circuit.partById(id);
      if (p) refMap.set(ref, p);
    }
    for (const p of app.circuit.parts) refMap.set(p.id, p);

    // 3. Evaluate removeWire, update, and electrical net equivalence for wire steps
    for (const st of g.steps) {
      if (st.kind === 'removeWire') {
        st.done = !app.circuit.wires.some(w => w.id === st.wireId);
      } else if (st.kind === 'update') {
        const part = app.circuit.partById(st.partId);
        st.done = !part || propsCompatible(part, st.props);
      } else if (st.kind === 'wire') {
        st.done = this._isWireStepSatisfied(st, refMap);
      }
    }

    const doneCount = g.steps.filter(s => s.done).length;
    const allDone = g.steps.length > 0 && doneCount === g.steps.length;
    if (allDone && !g.wasFinished) {
      g.wasFinished = true;
      app.ui?.toast?.('🎉 Guided circuit complete! Press Simulate (⌘↵) to test.');
    } else if (!allDone) {
      g.wasFinished = false;
    }
    this.emit();
  }

  _isWireStepSatisfied(st, refMap) {
    const app = this.app;
    try {
      if (st.bridge) {
        const ra = parseRailToken(st.aTok);
        const rb = parseRailToken(st.bTok);
        if (!ra || !rb) return false;
        const ha = resolveEndpoint(app, st.aTok, refMap, null);
        const hb = resolveEndpoint(app, st.bTok, refMap, null);
        if (!ha || !hb) return false;
        const na = app.engine.netAt(ha.end.x, ha.end.y);
        const nb = app.engine.netAt(hb.end.x, hb.end.y);
        return na >= 0 && na === nb;
      }

      const ra = parseRailToken(st.aTok);
      const rb = parseRailToken(st.bTok);
      if (ra && !rb) {
        const epB = resolveEndpoint(app, st.bTok, refMap, null);
        return epB ? isNetOnRail(app, app.engine.netAt(epB.end.x, epB.end.y), ra.rail, ra.half) : false;
      }
      if (!ra && rb) {
        const epA = resolveEndpoint(app, st.aTok, refMap, null);
        return epA ? isNetOnRail(app, app.engine.netAt(epA.end.x, epA.end.y), rb.rail, rb.half) : false;
      }
      const epA = resolveEndpoint(app, st.aTok, refMap, null);
      const epB = resolveEndpoint(app, st.bTok, refMap, epA?.end);
      if (!epA || !epB) return false;
      const na = app.engine.netAt(epA.end.x, epA.end.y);
      const nb = app.engine.netAt(epB.end.x, epB.end.y);
      return na >= 0 && na === nb;
    } catch {
      return false;
    }
  }

  /** Execute the current active step deterministically (or fix partial props). */
  doCurrentStep() {
    const st = this.activeStep;
    if (!st || !this.guide) return false;
    const app = this.app;
    if (app.mode !== 'build') app.setMode('build');

    const ok = this._executeStep(st);
    if (ok) {
      app.commit('AI Guide Step');
      this.syncProgress();
    }
    return ok;
  }

  /** Finish all remaining guided steps at once and start simulation if healthy. */
  doAllSteps() {
    if (!this.guide) return false;
    const app = this.app;
    if (app.mode !== 'build') app.setMode('build');

    let guard = 0;
    while (this.activeStep && guard++ < 120) {
      const ok = this._executeStep(this.activeStep);
      app.reindex(true);
      this.syncProgress();
      if (!ok) break;
    }
    app.commit('AI Guide Complete');
    if (app.allIssues().every(w => w.level !== 'error')) app.setMode('sim');
    app.fit();
    return true;
  }

  _executeStep(st) {
    const app = this.app;
    const g = this.guide;

    if (st.kind === 'removeWire') {
      const before = app.circuit.wires.length;
      app.circuit.wires = app.circuit.wires.filter(w => w.id !== st.wireId);
      if (app.circuit.wires.length !== before) { app.reindex(true); return true; }
      return false;
    }

    if (st.kind === 'update') {
      const existing = app.circuit.partById(st.partId);
      if (!existing) return false;
      Object.assign(existing.props, st.props || {});
      delete existing.props.damaged;
      app.reindex(true);
      return true;
    }

    if (st.kind === 'part') {
      const boundId = g.boundParts.get(st.ref);
      const existing = boundId ? app.circuit.partById(boundId) : null;
      if (existing) {
        Object.assign(existing.props, st.props || {});
        app.reindex(true);
        return true;
      }
      const cand = new Part(st.type, st.targetX, st.targetY, st.targetRot || 0, st.props || {});
      if (!app.editor.problems([cand]).msg) {
        app.circuit.parts.push(cand);
        g.boundParts.set(st.ref, cand.id);
        g.boundParts.set(String(st.ref).toUpperCase(), cand.id);
        app.reindex(true);
        return true;
      }
      // Fallback placement if target spot was taken manually by user
      const fallback = new Part(st.type, st.targetX + 2, st.targetY, st.targetRot || 0, st.props || {});
      for (let ox = 0; ox <= 24; ox++) {
        fallback.x = st.targetX + ox;
        if (!app.editor.problems([fallback]).msg) {
          app.circuit.parts.push(fallback);
          g.boundParts.set(st.ref, fallback.id);
          g.boundParts.set(String(st.ref).toUpperCase(), fallback.id);
          app.reindex(true);
          return true;
        }
      }
      return false;
    }

    if (st.kind === 'wire') {
      const refMap = new Map();
      for (const [ref, id] of g.boundParts) {
        const p = app.circuit.partById(id);
        if (p) refMap.set(ref, p);
      }
      for (const p of app.circuit.parts) refMap.set(p.id, p);

      const aRail = parseRailToken(st.aTok);
      const bRail = parseRailToken(st.bTok);
      let resA, resB;
      if (aRail && !bRail) {
        resB = resolveEndpoint(app, st.bTok, refMap, null);
        resA = resolveEndpoint(app, st.aTok, refMap, resB?.end);
      } else {
        resA = resolveEndpoint(app, st.aTok, refMap, null);
        resB = resolveEndpoint(app, st.bTok, refMap, resA?.end);
      }
      if (!resA || !resB) return false;
      const pts = route(app, resA.end, resB.end);
      app.circuit.wires.push(new Wire(resA.end, resB.end, st.color || pickWireColor(st.aTok, st.bTok, resA.rail, resB.rail, 0), pts));
      app.reindex(true);
      return true;
    }

    return false;
  }

  /** Resolve live visual target coordinates for the active step overlay. */
  _resolveStepVisuals(st) {
    const app = this.app;
    const g = this.guide;
    if (!st || st.kind !== 'wire') return null;

    const refMap = new Map();
    for (const [ref, id] of g.boundParts) {
      const p = app.circuit.partById(id);
      if (p) refMap.set(ref, p);
    }
    for (const p of app.circuit.parts) refMap.set(p.id, p);

    const aRail = parseRailToken(st.aTok);
    const bRail = parseRailToken(st.bTok);
    let endA = st.aFallback, endB = st.bFallback;
    try {
      if (aRail && !bRail) {
        const rb = resolveEndpoint(app, st.bTok, refMap, null);
        if (rb) endB = rb.end;
        const ra = resolveEndpoint(app, st.aTok, refMap, endB);
        if (ra) endA = ra.end;
      } else {
        const ra = resolveEndpoint(app, st.aTok, refMap, null);
        if (ra) endA = ra.end;
        const rb = resolveEndpoint(app, st.bTok, refMap, endA);
        if (rb) endB = rb.end;
      }
    } catch { /* fallback coordinates stay active if endpoint not placed yet */ }
    return { a: endA, b: endB };
  }

  /** Render animated canvas hints (ghost parts, target hole halos, wire arc). */
  drawOverlay(g, env) {
    const st = this.activeStep;
    if (!st) return;
    const app = this.app;
    const z = app.cam.z || 1;
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() * 0.005);

    if (st.kind === 'part') {
      const ghost = new Part(st.type, st.targetX, st.targetY, st.targetRot || 0, st.props || {}, 'guide-ghost');
      g.save();
      g.globalAlpha = 0.48 + 0.16 * pulse;
      app.renderer.drawPart(ghost, { ...env, dev: null }, false);
      const b = ghost.bounds();
      g.globalAlpha = 0.85;
      g.strokeStyle = '#0a84ff';
      g.lineWidth = 2 / z;
      g.setLineDash([6 / z, 4 / z]);
      g.beginPath();
      g.roundRect(b.x0 * P - 3 / z, b.y0 * P - 3 / z, (b.x1 - b.x0) * P + 6 / z, (b.y1 - b.y0) * P + 6 / z, 6 / z);
      g.stroke();
      g.setLineDash([]);

      // Floating tag above ghost
      const label = `Place ${st.shortLabel}`;
      g.font = `700 ${11 / z}px -apple-system, Inter, sans-serif`;
      const tw = g.measureText(label).width + 14 / z;
      const th = 20 / z;
      const cx = ((b.x0 + b.x1) / 2) * P;
      const ty = b.y0 * P - th - 6 / z;
      g.fillStyle = 'rgba(10, 132, 255, 0.92)';
      g.beginPath();
      g.roundRect(cx - tw / 2, ty, tw, th, 6 / z);
      g.fill();
      g.fillStyle = '#ffffff';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(label, cx, ty + th / 2);
      g.restore();
      return;
    }

    if (st.kind === 'wire') {
      const pts = this._resolveStepVisuals(st);
      if (!pts) return;
      const ax = pts.a.x * P, ay = pts.a.y * P;
      const bx = pts.b.x * P, by = pts.b.y * P;

      g.save();
      // Animated guide arc connecting source -> target
      const mx = (ax + bx) / 2, my = (ay + by) / 2 - Math.min(48, Math.hypot(bx - ax, by - ay) * 0.25);
      g.strokeStyle = `rgba(10, 132, 255, ${0.45 + 0.35 * pulse})`;
      g.lineWidth = 2.5 / z;
      g.setLineDash([7 / z, 5 / z]);
      g.lineDashOffset = -(performance.now() * 0.03) % (12 / z);
      g.beginPath();
      g.moveTo(ax, ay);
      g.quadraticCurveTo(mx, my, bx, by);
      g.stroke();
      g.setLineDash([]);

      const drawTargetRing = (x, y, hex, tag) => {
        const rInner = 6.5;
        const rOuter = 8.5 + pulse * 4;
        g.strokeStyle = hex;
        g.lineWidth = 2.2 / Math.max(z, 0.8);
        g.beginPath();
        g.arc(x, y, rInner, 0, TAU);
        g.stroke();

        g.globalAlpha = 0.7 - pulse * 0.35;
        g.lineWidth = 1.6 / Math.max(z, 0.8);
        g.beginPath();
        g.arc(x, y, rOuter, 0, TAU);
        g.stroke();

        g.globalAlpha = 0.94;
        g.font = `700 ${9.5 / z}px "SF Mono", ui-monospace, Menlo, monospace`;
        const tw = g.measureText(tag).width + 10 / z;
        const th = 16 / z;
        g.fillStyle = hex;
        g.beginPath();
        g.roundRect(x - tw / 2, y - rInner - th - 5 / z, tw, th, 4 / z);
        g.fill();
        g.fillStyle = '#ffffff';
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(tag, x, y - rInner - th / 2 - 5 / z);
      };

      drawTargetRing(ax, ay, '#34c759', st.aTok);
      drawTargetRing(bx, by, '#0a84ff', st.bTok);
      g.restore();
      return;
    }

    if (st.kind === 'removeWire' && st.a && st.b) {
      const ax = st.a.x * P, ay = st.a.y * P, bx = st.b.x * P, by = st.b.y * P;
      g.save();
      g.strokeStyle = `rgba(255, 69, 58, ${0.55 + 0.35 * pulse})`;
      g.lineWidth = 3 / z;
      g.setLineDash([6 / z, 4 / z]);
      g.beginPath(); g.moveTo(ax, ay); g.lineTo(bx, by); g.stroke();
      g.setLineDash([]);
      const mx = (ax + bx) / 2, my = (ay + by) / 2 - 14 / z;
      const lbl = `Remove wire ${st.wireId}`;
      g.font = `700 ${10 / z}px -apple-system, Inter, sans-serif`;
      const tw = g.measureText(lbl).width + 12 / z, th = 18 / z;
      g.fillStyle = 'rgba(255, 69, 58, 0.92)';
      g.beginPath(); g.roundRect(mx - tw / 2, my - th / 2, tw, th, 5 / z); g.fill();
      g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(lbl, mx, my);
      g.restore();
      return;
    }

    if (st.kind === 'update') {
      const part = app.circuit.partById(st.partId);
      if (!part) return;
      const b = part.bounds();
      g.save();
      g.strokeStyle = `rgba(255, 159, 10, ${0.65 + 0.3 * pulse})`;
      g.lineWidth = 2.5 / z;
      g.setLineDash([5 / z, 4 / z]);
      g.beginPath();
      g.roundRect(b.x0 * P - 4 / z, b.y0 * P - 4 / z, (b.x1 - b.x0) * P + 8 / z, (b.y1 - b.y0) * P + 8 / z, 6 / z);
      g.stroke();
      g.setLineDash([]);
      const lbl = `Set ${st.label}`;
      g.font = `700 ${10 / z}px -apple-system, Inter, sans-serif`;
      const tw = g.measureText(lbl).width + 12 / z, th = 18 / z;
      const cx = ((b.x0 + b.x1) / 2) * P, ty = b.y0 * P - th - 6 / z;
      g.fillStyle = 'rgba(255, 159, 10, 0.92)';
      g.beginPath(); g.roundRect(cx - tw / 2, ty, tw, th, 5 / z); g.fill();
      g.fillStyle = '#111'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(lbl, cx, ty + th / 2);
      g.restore();
    }
  }
}

/**
 * Collision-avoiding canvas label overlay & wire signal badge placer/renderer.
 * Pure placement solver works in both headless Node tests and browser Canvas 2D.
 */
import { P } from '../model.js';
import { getDef } from '../parts/registry.js';
import { ANNOTATION_TYPES, formatPartOverlayText } from './designators.js';

function overlapArea(a, b) {
  const x0 = Math.max(a.x0, b.x0);
  const y0 = Math.max(a.y0, b.y0);
  const x1 = Math.min(a.x1, b.x1);
  const y1 = Math.min(a.y1, b.y1);
  return x1 > x0 && y1 > y0 ? (x1 - x0) * (y1 - y0) : 0;
}

function makeRect(cx, cy, w, h) {
  return { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2, cx, cy, w, h };
}

function wireSegmentObstacles(wires) {
  const rects = [];
  for (const w of wires || []) {
    const pts = w.path ? w.path() : [w.a, ...(w.pts || []), w.b];
    for (let i = 0; i < pts.length - 1; i++) {
      const ax = pts[i].x * P, ay = pts[i].y * P;
      const bx = pts[i + 1].x * P, by = pts[i + 1].y * P;
      rects.push({
        x0: Math.min(ax, bx) - 3.5,
        y0: Math.min(ay, by) - 3.5,
        x1: Math.max(ax, bx) + 3.5,
        y1: Math.max(ay, by) + 3.5,
      });
    }
  }
  return rects;
}

function longestWireMidpoint(wire) {
  const pts = wire.path ? wire.path() : [wire.a, ...(wire.pts || []), wire.b];
  let best = { x: pts[0].x * P, y: pts[0].y * P, len: -1, horizontal: true };
  for (let i = 0; i < pts.length - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x, dy = pts[i + 1].y - pts[i].y;
    const len = Math.hypot(dx, dy);
    if (len > best.len) {
      best = {
        x: ((pts[i].x + pts[i + 1].x) * 0.5) * P,
        y: ((pts[i].y + pts[i + 1].y) * 0.5) * P,
        len,
        horizontal: Math.abs(dx) >= Math.abs(dy),
      };
    }
  }
  return best;
}

/**
 * Compute collision-minimized world-pixel rectangles for part designator/value pills
 * and wire signal name badges.
 */
export function computeLabelPlacements(circuit, mode = 'refs') {
  const wireLabels = [];
  const placedRects = [];

  for (const w of circuit.wires || []) {
    const lbl = String(w.label || '').trim();
    if (!lbl) continue;
    const mid = longestWireMidpoint(w);
    const pw = Math.max(24, lbl.length * 6.0 + 12);
    const ph = 15;
    const rect = makeRect(mid.x, mid.y, pw, ph);
    wireLabels.push({ wire: w, text: lbl, ...rect, color: w.color });
    placedRects.push(rect);
  }

  const partLabels = [];
  if (!mode || mode === 'off') return { partLabels, wireLabels };

  const partObs = [];
  for (const p of circuit.parts || []) {
    if (p.type === 'zone') continue;
    const bb = p.bounds();
    partObs.push({
      id: p.id,
      rect: { x0: bb.x0 * P + 2, y0: bb.y0 * P + 2, x1: bb.x1 * P - 2, y1: bb.y1 * P - 2 },
    });
  }
  const wireObs = wireSegmentObstacles(circuit.wires);

  // Place compact parts first so tight breadboard neighbors don't steal their adjacent slots
  const electrical = (circuit.parts || [])
    .filter(p => !ANNOTATION_TYPES.has(p.type) && p.ref)
    .map(p => {
      const bb = p.bounds();
      const area = Math.max(1, (bb.x1 - bb.x0) * (bb.y1 - bb.y0));
      return { p, bb, area };
    })
    .sort((a, b) => a.area - b.area || a.bb.y0 - b.bb.y0 || a.bb.x0 - b.bb.x0);

  for (const { p, bb } of electrical) {
    const text = formatPartOverlayText(p, mode);
    if (!text) continue;
    const x0 = bb.x0 * P, y0 = bb.y0 * P, x1 = bb.x1 * P, y1 = bb.y1 * P;
    const cx = (x0 + x1) * 0.5, cy = (y0 + y1) * 0.5;
    const pw = Math.max(22, text.length * 5.7 + 10);
    const ph = 14.5;
    const gap = 4.5;

    const cands = [
      { cx, cy: y0 - ph / 2 - gap, bias: 0 },
      { cx, cy: y1 + ph / 2 + gap, bias: 1.5 },
      { cx: x1 + pw / 2 + gap, cy, bias: 3.0 },
      { cx: x0 - pw / 2 - gap, cy, bias: 3.5 },
      { cx: x0 + pw / 2, cy: y0 - ph / 2 - gap, bias: 5.0 },
      { cx: x1 - pw / 2, cy: y1 + ph / 2 + gap, bias: 6.0 },
    ];

    let best = null, bestScore = Infinity;
    for (const c of cands) {
      const r = makeRect(c.cx, c.cy, pw, ph);
      let score = c.bias;
      for (const o of partObs) {
        if (o.id === p.id) continue;
        score += overlapArea(r, o.rect) * 0.35;
      }
      for (const wr of wireObs) {
        score += overlapArea(r, wr) * 0.12;
      }
      for (const pr of placedRects) {
        score += overlapArea(r, pr) * 3.5;
      }
      if (score < bestScore) { bestScore = score; best = r; }
    }

    placedRects.push(best);
    partLabels.push({ part: p, text, ...best });
  }

  return { partLabels, wireLabels };
}

function drawPill(g, it, { dark, bg, border, fg, font, radius = 4 }) {
  g.save();
  g.font = font;
  const tw = Math.max(it.w, g.measureText(it.text).width + 9);
  const x0 = it.cx - tw / 2, y0 = it.cy - it.h / 2;
  g.fillStyle = bg;
  g.beginPath();
  g.roundRect(x0, y0, tw, it.h, radius);
  g.fill();
  g.strokeStyle = border;
  g.lineWidth = 1;
  g.stroke();
  g.fillStyle = fg;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(it.text, it.cx, it.cy + 0.5);
  g.restore();
}

/** Draw wire signal pills, reference/value badges, and Full-mode IC pin numbers. */
export function drawLabelOverlays(g, circuit, settingsOrOpts = {}) {
  const mode = typeof settingsOrOpts.get === 'function' ? settingsOrOpts.get('labelMode') : (settingsOrOpts.labelMode || 'off');
  const dark = Boolean(settingsOrOpts.dark);
  const { partLabels, wireLabels } = computeLabelPlacements(circuit, mode);

  const fontPart = '700 9.5px "SF Mono", ui-monospace, Menlo, monospace';
  const fontWire = '700 9px "SF Mono", ui-monospace, Menlo, monospace';

  // 1. Part designator/value pills
  for (const it of partLabels) {
    drawPill(g, it, {
      dark,
      bg: dark ? 'rgba(22, 24, 30, 0.90)' : 'rgba(255, 255, 255, 0.92)',
      border: dark ? 'rgba(255, 255, 255, 0.18)' : 'rgba(15, 23, 42, 0.18)',
      fg: dark ? '#f1f5f9' : '#0f172a',
      font: fontPart,
      radius: 4,
    });
  }

  // 2. Wire signal name pills (always rendered when explicitly named)
  for (const it of wireLabels) {
    drawPill(g, it, {
      dark,
      bg: dark ? 'rgba(10, 132, 255, 0.24)' : 'rgba(255, 255, 255, 0.95)',
      border: it.color && it.color !== '#f2f2f7' ? it.color : '#0a84ff',
      fg: dark ? '#ffffff' : '#0f172a',
      font: fontWire,
      radius: 6,
    });
  }

  // 3. Full Engineering mode: compact IC pin numbers on edge pins
  if (mode === 'full') {
    g.save();
    g.font = '700 7px "SF Mono", ui-monospace, Menlo, monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const p of circuit.parts || []) {
      const def = getDef(p.type, true);
      if (!def || (!def.ic && p.type !== 'ne555')) continue;
      const bb = p.bounds();
      const bCx = ((bb.x0 + bb.x1) * 0.5) * P;
      const bCy = ((bb.y0 + bb.y1) * 0.5) * P;
      for (const q of p.worldPins()) {
        const px = q.x * P, py = q.y * P;
        const dx = px - bCx, dy = py - bCy;
        const horiz = Math.abs(dx) / Math.max(1, (bb.x1 - bb.x0) * P) > Math.abs(dy) / Math.max(1, (bb.y1 - bb.y0) * P);
        const lx = px + (horiz ? Math.sign(dx) * 9 : 0);
        const ly = py + (horiz ? 0 : Math.sign(dy) * 9);
        g.fillStyle = dark ? 'rgba(15,17,22,0.82)' : 'rgba(255,255,255,0.85)';
        g.beginPath(); g.roundRect(lx - 6, ly - 5, 12, 10, 2); g.fill();
        g.fillStyle = dark ? '#93c5fd' : '#1d4ed8';
        g.fillText(String(q.i + 1), lx, ly + 0.3);
      }
    }
    g.restore();
  }
}

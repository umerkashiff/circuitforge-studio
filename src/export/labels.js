/**
 * Smart Collision-Avoiding Canvas Label Overlay & Wire Signal Badge Placer/Renderer.
 * Multi-ring stagger solver with hairline leader ticks, pin-number keepouts,
 * and sliding wire-segment placement. Works deterministically in Node & Canvas 2D.
 */
import { P } from '../model.js';
import { getDef } from '../parts/registry.js';
import { ANNOTATION_TYPES, formatPartOverlayText } from './designators.js';

function overlapArea(a, b, pad = 2) {
  const x0 = Math.max(a.x0 - pad, b.x0);
  const y0 = Math.max(a.y0 - pad, b.y0);
  const x1 = Math.min(a.x1 + pad, b.x1);
  const y1 = Math.min(a.y1 + pad, b.y1);
  return x1 > x0 && y1 > y0 ? (x1 - x0) * (y1 - y0) : 0;
}

function makeRect(cx, cy, w, h) {
  return { x0: cx - w / 2, y0: cy - h / 2, x1: cx + w / 2, y1: cy + h / 2, cx, cy, w, h };
}

function measurePillWidth(text, font, ctx, fallbackCharW = 5.9, minW = 24) {
  if (ctx) {
    ctx.save();
    ctx.font = font;
    const w = ctx.measureText(text).width + 11;
    ctx.restore();
    return Math.max(minW, Math.ceil(w));
  }
  return Math.max(minW, Math.ceil(text.length * fallbackCharW + 11));
}

function wireSegmentObstacles(wires) {
  const rects = [];
  for (const w of wires || []) {
    const pts = w.path ? w.path() : [w.a, ...(w.pts || []), w.b];
    for (let i = 0; i < pts.length - 1; i++) {
      const ax = pts[i].x * P, ay = pts[i].y * P;
      const bx = pts[i + 1].x * P, by = pts[i + 1].y * P;
      rects.push({
        x0: Math.min(ax, bx) - 4,
        y0: Math.min(ay, by) - 4,
        x1: Math.max(ax, bx) + 4,
        y1: Math.max(ay, by) + 4,
      });
    }
  }
  return rects;
}

function collectPinNumberBoxes(circuit, mode) {
  const boxes = [];
  if (mode !== 'full') return boxes;
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
      boxes.push({ partId: p.id, pinIndex: q.i, num: q.i + 1, lx, ly, x0: lx - 6.5, y0: ly - 5.5, x1: lx + 6.5, y1: ly + 5.5 });
    }
  }
  return boxes;
}

function computeLeaderLine(pill, bbPx) {
  // Clamp pill center onto part bounds perimeter, and box center onto pill perimeter
  const tx = Math.max(bbPx.x0, Math.min(bbPx.x1, pill.cx));
  const ty = Math.max(bbPx.y0, Math.min(bbPx.y1, pill.cy));
  const px = Math.max(pill.x0, Math.min(pill.x1, tx));
  const py = Math.max(pill.y0, Math.min(pill.y1, ty));
  const dist = Math.hypot(tx - px, ty - py);
  if (dist <= 9) return null;
  return { x1: px, y1: py, x2: tx, y2: ty };
}

/**
 * Compute collision-minimized world-pixel rectangles for part designator/value pills,
 * wire signal name badges, and optional Full-mode IC pin numbers.
 */
export function computeLabelPlacements(circuit, mode = 'refs', ctx = null) {
  const fontPart = '700 9.5px "SF Mono", ui-monospace, Menlo, monospace';
  const fontWire = '700 9px "SF Mono", ui-monospace, Menlo, monospace';
  const pinNumBoxes = collectPinNumberBoxes(circuit, mode);
  const placedRects = [];
  const partLabels = [];
  const wireLabels = [];

  const partObs = [];
  for (const p of circuit.parts || []) {
    if (p.type === 'zone') continue;
    const bb = p.bounds();
    partObs.push({
      id: p.id,
      rect: { x0: bb.x0 * P + 1.5, y0: bb.y0 * P + 1.5, x1: bb.x1 * P - 1.5, y1: bb.y1 * P - 1.5 },
    });
  }
  // Reserve breadboard title tags so pills don't sit across them
  for (const b of circuit.boards || []) {
    if (b.label) {
      const bx1 = (b.x + b.w) * P - 8;
      const by1 = b.y * P - 4;
      partObs.push({ id: b.id, rect: { x0: bx1 - Math.max(40, b.label.length * 6.5), y0: by1 - 14, x1: bx1 + 4, y1: by1 } });
    }
  }
  const wireObs = wireSegmentObstacles(circuit.wires);

  if (mode && mode !== 'off') {
    // Place compact components first so dense clusters (e.g. bargraph resistors) grab close spots cleanly before large boards
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
      const pw = measurePillWidth(text, fontPart, ctx, 5.9, 24);
      const ph = 15;

      // Multi-ring radial & staggered candidate generator
      const cands = [];
      const rings = [5, 16, 28, 40, 54];
      rings.forEach((gap, ringIdx) => {
        const ringPenalty = ringIdx * 12;
        cands.push({ cx, cy: y0 - ph / 2 - gap, bias: ringPenalty + 0 });
        cands.push({ cx, cy: y1 + ph / 2 + gap, bias: ringPenalty + 1.5 });
        cands.push({ cx: x1 + pw / 2 + gap, cy, bias: ringPenalty + 3.0 });
        cands.push({ cx: x0 - pw / 2 - gap, cy, bias: ringPenalty + 3.5 });
        if (ringIdx >= 1) {
          // Staggered horizontal & vertical offsets escape packed side-by-side resistor rows
          for (const sx of [-pw * 0.55, pw * 0.55, -pw * 1.15, pw * 1.15]) {
            cands.push({ cx: cx + sx, cy: y0 - ph / 2 - gap, bias: ringPenalty + 4 + Math.abs(sx) * 0.04 });
            cands.push({ cx: cx + sx, cy: y1 + ph / 2 + gap, bias: ringPenalty + 5 + Math.abs(sx) * 0.04 });
          }
          for (const sy of [-18, 18, -36, 36]) {
            cands.push({ cx: x1 + pw / 2 + gap, cy: cy + sy, bias: ringPenalty + 5 + Math.abs(sy) * 0.05 });
            cands.push({ cx: x0 - pw / 2 - gap, cy: cy + sy, bias: ringPenalty + 5.5 + Math.abs(sy) * 0.05 });
          }
        }
      });

      let best = null, bestScore = Infinity;
      for (const c of cands) {
        const r = makeRect(c.cx, c.cy, pw, ph);
        let score = c.bias;
        let hasPillHit = false;
        for (const pr of placedRects) {
          const ov = overlapArea(r, pr, 2.5);
          if (ov > 0) {
            hasPillHit = true;
            score += 8000 + ov * 40;
          }
        }
        for (const pn of pinNumBoxes) {
          const ov = overlapArea(r, pn, 1.5);
          if (ov > 0) score += 2400 + ov * 20;
        }
        for (const o of partObs) {
          if (o.id === p.id) continue;
          const ov = overlapArea(r, o.rect, 1);
          if (ov > 0) score += 300 + ov * 2.5;
        }
        for (const wr of wireObs) {
          score += overlapArea(r, wr, 0) * 0.45;
        }
        if (score < bestScore) { bestScore = score; best = r; }
        // Fast accept when ring 0 has zero overlap against pills, pins, or neighbor parts
        if (!hasPillHit && score < 5) break;
      }

      placedRects.push(best);
      const leader = computeLeaderLine(best, { x0, y0, x1, y1 });
      partLabels.push({ part: p, text, ...best, font: fontPart, leader });
    }
  }

  // Place explicit wire signal badges sliding along free segments cleanly away from parts & labels
  for (const w of circuit.wires || []) {
    const lbl = String(w.label || '').trim();
    if (!lbl) continue;
    const pts = w.path ? w.path() : [w.a, ...(w.pts || []), w.b];
    const pw = measurePillWidth(lbl, fontWire, ctx, 5.6, 24);
    const ph = 15;

    const segs = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const len = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
      if (len > 0) segs.push({ a: pts[i], b: pts[i + 1], len });
    }
    segs.sort((a, b) => b.len - a.len);

    const cands = [];
    segs.forEach((seg, sIdx) => {
      const horiz = Math.abs(seg.b.x - seg.a.x) >= Math.abs(seg.b.y - seg.a.y);
      for (const t of [0.5, 0.34, 0.66, 0.2, 0.8]) {
        const bx = (seg.a.x + (seg.b.x - seg.a.x) * t) * P;
        const by = (seg.a.y + (seg.b.y - seg.a.y) * t) * P;
        const tPen = sIdx * 10 + Math.abs(t - 0.5) * 8;
        cands.push({ cx: bx, cy: by, bias: tPen });
        // Perpendicular offset slightly off the wire line cleanly avoids dense horizontal bundles
        cands.push({ cx: bx + (horiz ? 0 : 14), cy: by + (horiz ? -12 : 0), bias: tPen + 2 });
        cands.push({ cx: bx + (horiz ? 0 : -14), cy: by + (horiz ? 12 : 0), bias: tPen + 2.5 });
      }
    });
    if (!cands.length) cands.push({ cx: pts[0].x * P, cy: pts[0].y * P, bias: 0 });

    let best = null, bestScore = Infinity;
    for (const c of cands) {
      const r = makeRect(c.cx, c.cy, pw, ph);
      let score = c.bias;
      for (const pr of placedRects) {
        const ov = overlapArea(r, pr, 2);
        if (ov > 0) score += 8000 + ov * 40;
      }
      for (const pn of pinNumBoxes) {
        const ov = overlapArea(r, pn, 1);
        if (ov > 0) score += 2000 + ov * 18;
      }
      for (const o of partObs) {
        const ov = overlapArea(r, o.rect, 0.5);
        if (ov > 0) score += 250 + ov * 2;
      }
      if (score < bestScore) { bestScore = score; best = r; }
    }

    placedRects.push(best);
    wireLabels.push({ wire: w, text: lbl, ...best, color: w.color, font: fontWire });
  }

  return { partLabels, wireLabels, pinNumBoxes };
}

function drawPill(g, it, { bg, border, fg, font, radius = 4 }) {
  g.save();
  g.font = font;
  const tw = Math.max(it.w, Math.ceil(g.measureText(it.text).width + 11));
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

/** Draw subtle leader ticks, wire signal pills, reference/value badges, and Full-mode IC pin numbers. */
export function drawLabelOverlays(g, circuit, settingsOrOpts = {}) {
  const mode = typeof settingsOrOpts.get === 'function' ? settingsOrOpts.get('labelMode') : (settingsOrOpts.labelMode || 'off');
  const dark = Boolean(settingsOrOpts.dark);
  const { partLabels, wireLabels, pinNumBoxes } = computeLabelPlacements(circuit, mode, g);

  const fontPart = '700 9.5px "SF Mono", ui-monospace, Menlo, monospace';
  const fontWire = '700 9px "SF Mono", ui-monospace, Menlo, monospace';

  // 0. Subtle hairline leaders ONLY when a pill had to move out to an outer stagger ring
  g.save();
  g.strokeStyle = dark ? 'rgba(148,163,184,0.48)' : 'rgba(100,116,139,0.48)';
  g.lineWidth = 1;
  g.setLineDash([2, 2]);
  for (const it of partLabels) {
    if (!it.leader) continue;
    g.beginPath();
    g.moveTo(it.leader.x1, it.leader.y1);
    g.lineTo(it.leader.x2, it.leader.y2);
    g.stroke();
  }
  g.restore();

  // 1. Full Engineering mode: compact IC pin numbers on edge pins (drawn before labels, reserved as obstacles)
  if (mode === 'full' && pinNumBoxes.length) {
    g.save();
    g.font = '700 7px "SF Mono", ui-monospace, Menlo, monospace';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const pn of pinNumBoxes) {
      g.fillStyle = dark ? 'rgba(15,17,22,0.84)' : 'rgba(255,255,255,0.88)';
      g.beginPath(); g.roundRect(pn.lx - 6, pn.ly - 5, 12, 10, 2); g.fill();
      g.fillStyle = dark ? '#93c5fd' : '#1d4ed8';
      g.fillText(String(pn.num), pn.lx, pn.ly + 0.3);
    }
    g.restore();
  }

  // 2. Part designator/value pills
  for (const it of partLabels) {
    drawPill(g, it, {
      bg: dark ? 'rgba(22, 24, 30, 0.92)' : 'rgba(255, 255, 255, 0.94)',
      border: dark ? 'rgba(255, 255, 255, 0.18)' : 'rgba(15, 23, 42, 0.18)',
      fg: dark ? '#f1f5f9' : '#0f172a',
      font: fontPart,
      radius: 4,
    });
  }

  // 3. Wire signal name pills
  for (const it of wireLabels) {
    drawPill(g, it, {
      bg: dark ? 'rgba(10, 132, 255, 0.28)' : 'rgba(255, 255, 255, 0.96)',
      border: it.color && it.color !== '#f2f2f7' ? it.color : '#0a84ff',
      fg: dark ? '#ffffff' : '#0f172a',
      font: fontWire,
      radius: 6,
    });
  }
}

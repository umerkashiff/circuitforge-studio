import assert from 'node:assert/strict';
import '../src/parts/library.js';
import '../src/mcu/boards.js';
import { Board, Circuit, Part, Wire } from '../src/model.js';
import { Engine, key } from '../src/sim/engine.js';
import {
  ANNOTATION_TYPES,
  nextRef,
  ensureDesignators,
  reannotateCircuit,
  isDuplicateRef,
  formatPartValue,
  formatPartOverlayText,
  buildNetLabelMap,
} from '../src/export/designators.js';
import { computeLabelPlacements } from '../src/export/labels.js';
import {
  extractCircuitData,
  toBomCSV,
  toBomMarkdown,
  toWiringCSV,
  toWiringMarkdown,
  toNetlistJSON,
  toSpiceNetlist,
} from '../src/export/netlist.js';
import { computeExportBounds, computeExportLayout } from '../src/export/breadboard_export.js';
import { buildAnalyzerCSV, renderAnalyzerSVG } from '../src/export/waveform_export.js';
import { computeSchematicLayout } from '../src/export/schematic_layout.js';
import { renderSchematicSVG } from '../src/export/schematic_svg.js';
import { SCH_GRID } from '../src/export/symbols.js';
import { buildLabReportHTML, buildLabReportMarkdown } from '../src/export/report.js';
import { buildSap1CpuCircuit } from '../src/examples/sap1_cpu.js';

const results = [];
function test(id, name, fn) {
  try {
    const info = fn();
    results.push({ id, name, pass: true, info: info || 'ok' });
  } catch (err) {
    results.push({ id, name, pass: false, info: err?.stack || String(err) });
  }
}

test('P1.1', 'Legacy JSON migration assigns unique deterministic designators & skips annotations', () => {
  const legacyJson = {
    app: 'circuitforge',
    version: 2,
    name: 'Legacy RC',
    boards: [{ id: 'b1', size: 'half', x: 0, y: 0 }],
    parts: [
      { id: 'p1', type: 'vcc', x: 3, y: -3, rot: 0, props: {} },
      { id: 'p2', type: 'gnd', x: 5, y: -3, rot: 0, props: {} },
      { id: 'p3', type: 'resistor', x: 8, y: 13, rot: 0, props: { ohms: 1000 } },
      { id: 'p4', type: 'resistor', x: 14, y: 13, rot: 0, props: { ohms: 220 } },
      { id: 'p5', type: 'led', x: 20, y: 13, rot: 0, props: { color: 'green' } },
      { id: 'p6', type: 'ic7408', x: 10, y: 8, rot: 0, props: {} },
      { id: 'p7', type: 'label', x: 2, y: -6, rot: 0, props: { text: 'Test Note', size: 14 } },
    ],
    wires: [],
    probes: [],
  };
  const c = Circuit.fromJSON(legacyJson);
  const byId = new Map(c.parts.map(p => [p.id, p]));
  assert.equal(byId.get('p1').ref, 'VCC1');
  assert.equal(byId.get('p2').ref, 'GND1');
  assert.equal(byId.get('p3').ref, 'R1');
  assert.equal(byId.get('p4').ref, 'R2');
  assert.equal(byId.get('p5').ref, 'LED1');
  assert.equal(byId.get('p6').ref, 'U1');
  assert.equal(byId.get('p7').ref, '');
  assert.equal(isDuplicateRef(c, 'r1', 'p4'), true);
  assert.equal(isDuplicateRef(c, 'r1', 'p3'), false);
  return 'VCC1, GND1, R1, R2, LED1, U1, annotation empty ref';
});

test('P1.2', 'nextRef honors free AI preferred refs and resolves collisions', () => {
  const c = new Circuit();
  const r1 = new Part('resistor', 4, 6, 0, { ohms: 220 }, undefined, 'R1');
  c.parts.push(r1);
  assert.equal(nextRef(c, 'resistor', 'R1'), 'R2');
  assert.equal(nextRef(c, 'resistor', 'R_LED'), 'R_LED');
  assert.equal(nextRef(c, 'ic7400', 'U_NAND'), 'U_NAND');
  assert.equal(nextRef(c, 'callout', 'C1'), '');
  return 'Collision resolved R1 -> R2; custom refs honored; annotations unnumbered';
});

test('P1.3', 'reannotateCircuit numbers cleanly top-to-bottom, left-to-right', () => {
  const c = new Circuit();
  const pBottom = new Part('resistor', 5, 20, 0, { ohms: 100 }, undefined, 'R9');
  const pTopRight = new Part('resistor', 20, 4, 0, { ohms: 220 }, undefined, 'R4');
  const pTopLeft = new Part('resistor', 4, 5, 0, { ohms: 330 }, undefined, 'R2');
  c.parts.push(pBottom, pTopRight, pTopLeft);
  const changed = reannotateCircuit(c);
  assert.equal(changed, 3);
  assert.equal(pTopLeft.ref, 'R1');
  assert.equal(pTopRight.ref, 'R2');
  assert.equal(pBottom.ref, 'R3');
  return 'R9/R4/R2 spatially sorted -> R1 (top-left), R2 (top-right), R3 (bottom)';
});

test('P1.4', 'formatPartValue & formatPartOverlayText cover passive, IC, MCU & I2C values', () => {
  const r = new Part('resistor', 0, 0, 0, { ohms: 4700 }, undefined, 'R1');
  const c = new Part('capacitor', 0, 0, 0, { uf: 470 }, undefined, 'C1');
  const l = new Part('inductor', 0, 0, 0, { mh: 0.1 }, undefined, 'L1');
  const ic = new Part('ic7493', 0, 0, 0, {}, undefined, 'U1');
  const oled = new Part('board-ssd1306', 0, 0, 0, { i2cAddress: '0x3d' }, undefined, 'DS1');
  assert.equal(formatPartValue(r), '4.7 kΩ');
  assert.equal(formatPartValue(c), '470 µF');
  assert.equal(formatPartValue(l), '100 µH');
  assert.equal(formatPartValue(ic), '7493');
  assert.equal(formatPartValue(oled), 'OLED 0x3D');
  assert.equal(formatPartOverlayText(r, 'refs'), 'R1');
  assert.equal(formatPartOverlayText(r, 'values'), 'R1 · 4.7 kΩ');
  assert.equal(formatPartOverlayText(r, 'off'), '');
  return '4.7 kΩ, 470 µF, 100 µH, 7493, OLED 0x3D verified';
});

test('P1.5', 'netlabel & wire.label propagate across breadboard strip nets without electrical load', () => {
  const c = new Circuit();
  const b = new Board('half', 0, 0);
  c.boards.push(b);
  const clk = new Part('clock', 4, 15, 0, { hz: 5 });
  // Place netlabel in same strip column as clock (x=4, y=15 -> col 2 bottom strip: f..j rows at y=11..15)
  const nl = new Part('netlabel', 4, 12, 0, { text: 'SYS_CLK' });
  const r = new Part('resistor', 6, 6, 0, { ohms: 220 });
  const w = new Wire({ x: 4, y: 11 }, { x: 6, y: 6 }, '#0a84ff', [], undefined, 'WIRE_CLK');
  c.parts.push(clk, nl, r);
  c.wires.push(w);
  ensureDesignators(c);

  const eng = new Engine();
  eng.build(c);
  const labels = buildNetLabelMap(c, eng);
  const clkNet = eng.netAt(4, 15);
  const rNet = eng.netAt(6, 6);
  assert.equal(clkNet, rNet);
  assert.equal(labels.get(clkNet), 'SYS_CLK'); // netlabel takes priority over wire.label

  // Remove netlabel -> wire.label takes over seamlessly
  c.parts = c.parts.filter(p => p.type !== 'netlabel');
  const labelsAfter = buildNetLabelMap(c, eng);
  assert.equal(labelsAfter.get(clkNet), 'WIRE_CLK');
  return `Net ${clkNet} labeled SYS_CLK (netlabel) -> WIRE_CLK (wire.label fallback)`;
});

test('P1.6', 'Annotation hit-testing & serialization: zone hollow interior, callout selective hit, meta roundtrip', () => {
  const zone = new Part('zone', 2, 2, 0, { title: 'Power Stage', w: 14, h: 9 });
  assert.equal(zone.hit(5, 2), true, 'Title pill / top edge should hit');
  assert.equal(zone.hit(9, 6.5), false, 'Interior of zone must remain click-through');
  assert.equal(zone.hit(2, 6), true, 'Left border must hit');

  const callout = new Part('callout', 10, 10, 0, { text: 'Check\nVoltage', dx: 5, dy: -4 });
  assert.equal(callout.hit(10, 10), true, 'Callout anchor tip should hit');
  assert.equal(callout.hit(15, 6), true, 'Callout bubble should hit');
  assert.equal(callout.hit(15, 10), false, 'Empty quadrant off leader/box should not hit');

  const lbl = new Part('label', 0, 0, 0, { text: 'Line 1\nLine 2 longer', size: 14, style: 'card' });
  const bb = lbl.bounds();
  assert.ok(bb.x1 - bb.x0 > 4 && bb.y1 - bb.y0 > 1.8, 'Multiline label bounds expand cleanly');

  const circ = new Circuit();
  circ.name = 'Lab 3';
  circ.meta = { author: 'Umer Kashif', project: 'Digital Logic', revision: '2.1', notes: 'Clean' };
  circ.boards.push(new Board('half', 0, 0, undefined, 'Main Board'));
  circ.parts.push(zone, callout, lbl);
  const w = new Wire({ x: 2, y: 1 }, { x: 8, y: 1 }, '#e5484d', [], undefined, 'VCC_BUS');
  circ.wires.push(w);

  const restored = Circuit.fromJSON(circ.toJSON());
  assert.equal(restored.meta.author, 'Umer Kashif');
  assert.equal(restored.meta.revision, '2.1');
  assert.equal(restored.boards[0].label, 'Main Board');
  assert.equal(restored.wires[0].label, 'VCC_BUS');
  assert.equal(restored.parts.every(p => p.ref === '' && ANNOTATION_TYPES.has(p.type)), true);
  return 'Zone interior click-through, callout selective hit, meta/label JSON roundtrip OK';
});

test('P1.7', 'Collision-avoiding label placer yields zero label-to-label overlaps', () => {
  const c = new Circuit();
  c.boards.push(new Board('half', 0, 0));
  c.parts.push(
    new Part('vcc', 3, -3),
    new Part('gnd', 5, -3),
    new Part('resistor', 8, 7, 0, { ohms: 220 }),
    new Part('resistor', 8, 9, 0, { ohms: 1000 }),
    new Part('capacitor', 14, 9, 0, { uf: 100 }),
    new Part('led', 17, 9, 0, { color: 'red' }),
    new Part('ic7408', 22, 9, 0, {}),
  );
  c.wires.push(new Wire({ x: 12, y: 9 }, { x: 14, y: 9 }, '#0a84ff', [], undefined, 'RC_NODE'));
  ensureDesignators(c);

  const { partLabels, wireLabels } = computeLabelPlacements(c, 'values');
  assert.equal(partLabels.length, 7);
  assert.equal(wireLabels.length, 1);

  const all = [...partLabels, ...wireLabels];
  let overlaps = 0;
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j];
      if (Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0) && Math.min(a.y1, b.y1) > Math.max(a.y0, b.y0)) overlaps++;
    }
  }
  assert.equal(overlaps, 0, `Expected 0 label-to-label overlaps, got ${overlaps}`);
  return `${partLabels.length} part labels + ${wireLabels.length} wire badge with 0 overlaps`;
});

function buildSampleMixedCircuit() {
  const c = new Circuit();
  c.name = 'RC + Clock + Gate';
  c.meta = { author: 'Umer', project: 'EE101', revision: '1.2', notes: '' };
  c.boards.push(new Board('half', 0, 0, undefined, 'Main'));
  const vcc = new Part('vcc', 3, -3);
  const gnd = new Part('gnd', 5, -3);
  const r1 = new Part('resistor', 8, 7, 0, { ohms: 1000 });
  const r2 = new Part('resistor', 8, 12, 0, { ohms: 1000 });
  const c1 = new Part('capacitor', 14, 15, 0, { uf: 470 });
  const led = new Part('led', 17, 12, 0, { color: 'green' });
  const q1 = new Part('npn', 21, 12, 0, { model: '2N3904' });
  const ic = new Part('ic7408', 10, 6, 0, {});
  const clk = new Part('clock', 4, 15, 0, { hz: 5, duty: 50 });
  c.parts.push(vcc, gnd, r1, r2, c1, led, q1, ic, clk);
  c.wires.push(
    new Wire({ x: 3, y: -3 }, { x: 3, y: 1 }, '#e5484d'),
    new Wire({ x: 5, y: -3 }, { x: 5, y: 2 }, '#2b2d31'),
    new Wire({ x: 4, y: 15 }, { x: 10, y: 6 }, '#0a84ff', [], undefined, 'CLK_IN'),
    new Wire({ x: 12, y: 12 }, { x: 14, y: 12 }, '#30a46c'),
    new Wire({ x: 15, y: 15 }, { x: 15, y: 2 }, '#2b2d31'),
  );
  c.probes = [
    { id: 'pr1', x: 4, y: 15, name: 'CLK_IN', color: '#ff9f0a', analog: false },
    { id: 'pr2', x: 14, y: 9, name: 'C1+', color: '#30d158', analog: true },
  ];
  ensureDesignators(c);
  return c;
}

test('P2.1', 'extractCircuitData builds BOM grouping, semantic net names & wiring guide', () => {
  const c = buildSampleMixedCircuit();
  const data = extractCircuitData(c);
  assert.equal(data.partCount, 9);
  const resBom = data.bom.find(b => b.component === 'Resistor' && b.value === '1 kΩ');
  assert.ok(resBom && resBom.qty === 2 && resBom.refs === 'R1, R2', 'Duplicate resistors aggregate to qty 2');
  assert.ok(data.nets.some(n => n.name === '+5V'), '+5V power net detected');
  assert.ok(data.nets.some(n => n.name === 'GND'), 'GND reference net detected');
  assert.ok(data.nets.some(n => n.name === 'CLK_IN'), 'Wire signal label promoted to net name');
  assert.equal(data.wiringByWire.length, 5);
  assert.equal(data.wiringByWire[2].label, 'CLK_IN');
  return `${data.bom.length} BOM groups, ${data.nets.length} nets, ${data.wiringByWire.length} wires`;
});

test('P2.2', 'CSV, Markdown & Netlist JSON serializers output valid well-formed documents', () => {
  const data = extractCircuitData(buildSampleMixedCircuit());
  const bomCsv = toBomCSV(data);
  const bomMd = toBomMarkdown(data);
  const wireCsv = toWiringCSV(data);
  const wireMd = toWiringMarkdown(data);
  const netJson = JSON.parse(toNetlistJSON(data));
  assert.ok(bomCsv.startsWith('Item,Designators,Component,Value / Spec,Package,Qty'));
  assert.ok(bomMd.includes('| R1, R2 | Resistor | 1 kΩ |'));
  assert.ok(wireCsv.includes('CLK_IN'));
  assert.ok(wireMd.includes('### Point-to-Point Wire List') && wireMd.includes('### Net Connectivity Table'));
  assert.equal(netJson.parts.length, 9);
  assert.ok(netJson.nets.length >= 3);
  return 'BOM CSV/MD, Wiring CSV/MD, Netlist JSON verified';
});

test('P2.3', 'SPICE netlist maps GND->0 and serializes R/C/Q/D/CLK + unmodeled IC notes', () => {
  const data = extractCircuitData(buildSampleMixedCircuit());
  const spice = toSpiceNetlist(data);
  assert.ok(spice.includes('* Reference GND net mapped to SPICE node 0'));
  assert.ok(/\bR1\s+\S+\s+\S+\s+1000\b/.test(spice), 'R1 1000 ohm line');
  assert.ok(/\bC1\s+\S+\s+0\s+470u\b/.test(spice), 'C1 tied to GND node 0');
  assert.ok(/\bQ_Q1\s+/.test(spice), 'BJT transistor emitted');
  assert.ok(/\bV_CLK1\s+CLK_IN\s+0\s+PULSE\(0 5/.test(spice), 'Clock PULSE source on CLK_IN');
  assert.ok(spice.includes('U1 (7408)'), 'Digital IC documented as unmodeled comment');
  assert.ok(spice.trim().endsWith('.end'));
  return `${spice.split('\n').length} lines SPICE netlist verified`;
});

test('P2.4', 'Analyzer CSV merges timestamps with sample-and-hold & respects window filter', () => {
  const c = buildSampleMixedCircuit();
  const samples = new Map([
    ['pr1', { t: [0.0, 0.5, 1.0, 1.5], v: [0, 5, 0, 5] }],
    ['pr2', { t: [0.0, 0.8, 1.4], v: [0.0, 1.5, 4.1] }],
  ]);
  const fullCsv = buildAnalyzerCSV(c, samples, 2.0, { scope: 'all' });
  const winCsv = buildAnalyzerCSV(c, samples, 2.0, { scope: 'window', windowSec: 1.0 });
  const fullLines = fullCsv.trim().split('\n');
  assert.equal(fullLines[0], 'time_s,CLK_IN (V),CLK_IN (State),C1+ (V),C1+ (State)');
  // At t=0.8: CLK_IN held from 0.5 -> 5.000V HIGH, C1+ = 1.500V MID (0.8 < 1.5 < 2.0)
  assert.ok(fullLines.some(l => l.startsWith('0.800000,5.000,HIGH,1.500,MID')), 'Sample-and-hold interpolation exact');
  // Window [1.0, 2.0] includes t=1.0, t=1.4, t=1.5, t=2.0 (4 rows + header)
  assert.equal(winCsv.trim().split('\n').length, 5);
  return 'Full CSV (6 rows) & Window CSV (4 rows) sample-and-hold exact';
});

test('P2.5', 'Analyzer SVG renders finite vector geometry with left-edge seeding', () => {
  const c = buildSampleMixedCircuit();
  const samples = new Map([
    ['pr1', { t: [0.2, 1.5, 2.2], v: [0, 5, 0] }],
    ['pr2', { t: [0.2, 2.2], v: [0.1, 3.85] }],
  ]);
  const svg = renderAnalyzerSVG(c, samples, 2.5, 2, { theme: 'light', width: 900 });
  assert.ok(svg.startsWith('<svg ') && svg.includes('</svg>'));
  assert.ok(!/NaN|Infinity|undefined/.test(svg), 'SVG coordinates all finite');
  assert.ok(svg.includes('M 165.0'), 'Left-edge x=165 hold before t0=0.5s seeded cleanly');
  assert.ok(svg.includes('3.85 V'), 'Analog current voltage readout rendered');
  return 'Analyzer SVG valid XML, zero NaN, left-edge seeded';
});

test('P2.6', 'computeExportBounds & computeExportLayout expand cleanly for overlays and title block', () => {
  const c = buildSampleMixedCircuit();
  const bNoLabels = computeExportBounds(c, 'off');
  const bWithLabels = computeExportBounds(c, 'values');
  assert.ok(bWithLabels.w >= bNoLabels.w && bWithLabels.h >= bNoLabels.h);
  const lay = computeExportLayout({ circuit: c }, { labelMode: 'values', showTitleBlock: true, showLegend: true, showFrame: true });
  assert.ok(lay.totalW >= 560 && lay.totalH > lay.contentH + 50, 'Footer reserved outside diagram bounds');
  return `Content ${lay.contentW}x${lay.contentH}, Sheet ${lay.totalW}x${lay.totalH}`;
});

function buildDualGateSrCircuit() {
  const c = new Circuit();
  c.name = 'Dual-Gate NAND Test';
  c.boards.push(new Board('half', 0, 0));
  const vcc = new Part('vcc', 3, -3);
  const gnd = new Part('gnd', 5, -3);
  const swA = new Part('toggle', 3, 22);
  const swB = new Part('toggle', 7, 22);
  const nand = new Part('ic7400', 10, 11);
  const r = new Part('resistor', 19, 13, 0, { ohms: 220 });
  const led = new Part('led', 25, 13, 0, { color: 'red' });
  c.parts.push(vcc, gnd, swA, swB, nand, r, led);
  const p = nand.worldPins();
  // Gate A: 1A(0), 1B(1) -> 1Y(2); Gate B: 2A(3)=1Y, 2B(4)=+ -> 2Y(5) -> R -> LED -> -
  c.wires.push(
    new Wire({ x: 3, y: -3 }, { x: 3, y: 1 }, '#e5484d'),
    new Wire({ x: 5, y: -3 }, { x: 5, y: 2 }, '#2b2d31'),
    new Wire(p[13], { x: 10, y: 1 }, '#e5484d'), // VCC
    new Wire(p[6], { x: 16, y: 2 }, '#2b2d31'),  // GND
    new Wire(swA.worldPins()[0], p[0], '#0a84ff'),
    new Wire(swB.worldPins()[0], p[1], '#30a46c'),
    new Wire(p[2], p[3], '#f5c400'),
    new Wire({ x: 14, y: 1 }, p[4], '#e5484d'),
    new Wire(p[5], r.worldPins()[0], '#ff8a00'),
    new Wire(r.worldPins()[1], led.worldPins()[0], '#ff8a00'),
    new Wire(led.worldPins()[1], { x: 26, y: 2 }, '#2b2d31'),
  );
  ensureDesignators(c);
  return c;
}

test('P3.1', 'All schematic symbol pins snap strictly to GRID=20 & both IEEE/IEC SVG render cleanly', () => {
  const c = buildSampleMixedCircuit();
  for (const std of ['ieee', 'iec']) {
    const res = renderSchematicSVG(c, null, null, { standard: std, theme: 'color' });
    assert.ok(res.svg.startsWith('<svg ') && res.svg.includes('</svg>'));
    assert.ok(!/NaN|Infinity|undefined/.test(res.svg), `${std} SVG must have finite coordinates`);
    for (const sym of res.layout.symbols) {
      assert.equal(sym.x % SCH_GRID, 0, `${sym.ref}.x snapped`);
      assert.equal(sym.y % SCH_GRID, 0, `${sym.ref}.y snapped`);
      for (const pin of sym.pins) {
        assert.equal(pin.lx % SCH_GRID, 0, `${sym.ref}.${pin.name} lx snapped`);
        assert.equal(pin.ly % SCH_GRID, 0, `${sym.ref}.${pin.name} ly snapped`);
      }
    }
  }
  return 'IEEE & IEC lattice alignment (GRID=20) & SVG well-formedness verified';
});

test('P3.2', 'Multi-unit 7400 splits used gates U1A/U1B in Functional mode & collapses to 1 DIP-14 in Package mode', () => {
  const c = buildDualGateSrCircuit();
  const fnRes = renderSchematicSVG(c, null, null, { standard: 'ieee', viewMode: 'functional' });
  const gateSyms = fnRes.layout.symbols.filter(s => s.partId === c.parts.find(p => p.type === 'ic7400').id);
  assert.deepEqual(gateSyms.map(s => s.ref), ['U1A', 'U1B'], 'Only active gates A and B instantiated');
  assert.ok(fnRes.layout.unusedNotes.some(n => n.includes('U1C, U1D')), 'Unused units C,D summarized cleanly');

  const pkgRes = renderSchematicSVG(c, null, null, { standard: 'ieee', viewMode: 'package' });
  const pkgSyms = pkgRes.layout.symbols.filter(s => s.type === 'ic7400');
  assert.equal(pkgSyms.length, 1);
  assert.equal(pkgSyms[0].pins.length, 14, 'Package mode shows full 14-pin DIP outline');
  return 'Functional split (U1A, U1B + U1C/U1D note) vs Package (14-pin U1) verified';
});

test('P3.3', 'Arduino Uno smart pin pruning hides unwired pins when enabled', () => {
  const c = new Circuit();
  c.boards.push(new Board('half', 0, 0));
  const uno = new Part('uno', 0, -25);
  const r = new Part('resistor', 10, 7, 0, { ohms: 220 });
  const led = new Part('led', 16, 7, 0, { color: 'red' });
  c.parts.push(uno, r, led);
  const up = uno.worldPins();
  const d13 = up.find(p => p.name === 'D13');
  const gndPin = up.find(p => p.name === 'GND');
  c.wires.push(
    new Wire(d13, r.worldPins()[0], '#0a84ff'),
    new Wire(r.worldPins()[1], led.worldPins()[0], '#ff8a00'),
    new Wire(led.worldPins()[1], gndPin, '#2b2d31'),
  );
  ensureDesignators(c);

  const pruned = computeSchematicLayout(c, null, null, { hideUnwired: true });
  const full = computeSchematicLayout(c, null, null, { hideUnwired: false });
  const uPruned = pruned.symbols.find(s => s.type === 'uno');
  const uFull = full.symbols.find(s => s.type === 'uno');
  assert.ok(uPruned.pins.length <= 4 && uPruned.prunedCount >= 20, 'Pruned Uno shows only connected pins');
  assert.equal(uFull.pins.length, uno.worldPins().length, 'Unpruned Uno shows all pins');
  return `Pruned ${uPruned.pins.length} connected pins vs ${uFull.pins.length} full pins`;
});

test('P3.4', 'Schematic engine produces valid SVG across all 4 themes & both power styles (with Live voltage solve)', () => {
  const c = buildDualGateSrCircuit();
  const eng = new Engine();
  eng.build(c);
  eng.step(0.01);
  for (const theme of ['color', 'print', 'blueprint', 'live']) {
    for (const powerStyle of ['symbols', 'rails']) {
      const res = renderSchematicSVG(c, eng, null, { theme, powerStyle, standard: theme === 'print' ? 'iec' : 'ieee' });
      assert.ok(res.svg.startsWith('<svg ') && res.svg.includes('</svg>'));
      assert.ok(!/NaN|Infinity|undefined/.test(res.svg));
    }
  }
  return '4 themes x 2 power styles (with live Engine voltages) all clean';
});

test('P3.5', '100% electrical netlist parity between Engine and Schematic routes/powerPorts', () => {
  const c = buildDualGateSrCircuit();
  const eng = new Engine();
  eng.build(c);
  const res = renderSchematicSVG(c, eng, null, { viewMode: 'functional', powerStyle: 'symbols', useNetFlags: false });
  const coveredNetIds = new Set([
    ...res.layout.routes.map(r => r.netId),
    ...res.layout.powerPorts.map(pp => pp.netId),
  ]);
  for (const n of res.data.nets) {
    if (n.pins.length >= 2) {
      assert.ok(coveredNetIds.has(n.id), `Multi-pin net ${n.name} (${n.id}) present in schematic`);
    }
  }
  return `${res.data.nets.length} canonical nets 100% matched by schematic routes + power ports`;
});

test('P3.6', 'Manual schematic drag override (part.sch) persists via JSON roundtrip and updates layout', () => {
  const c = buildSampleMixedCircuit();
  const ic = c.parts.find(p => p.type === 'ic7408');
  ic.sch = { units: { A: { x: 460, y: 240 } } };
  const restored = Circuit.fromJSON(c.toJSON());
  const lay = computeSchematicLayout(restored);
  const u1a = lay.symbols.find(s => s.ref === 'U1A' || s.ref === 'U1');
  assert.ok(u1a && u1a.x === 460 && u1a.y === 240, 'Persisted manual schematic coordinates applied cleanly');
  return `Persisted sch position (${u1a.x}, ${u1a.y}) survived JSON save/reload`;
});

test('P3.7', 'NE555 blinker, 7493 counter + bargraph & RC circuits generate clean IEEE/IEC & bus-rail schematics', () => {
  const build555 = () => {
    const c = new Circuit(); c.name = '555 Blinker';
    c.boards.push(new Board('half', 0, 0));
    c.parts.push(
      new Part('vcc', 3, -3), new Part('gnd', 5, -3), new Part('ne555', 6, 11),
      new Part('resistor', 7, 5, 3, { ohms: 1000 }), new Part('resistor', 7, 6, 0, { ohms: 10000 }),
      new Part('capacitor', 7, 14, 2, { uf: 47 }), new Part('resistor', 8, 12, 0, { ohms: 220 }),
      new Part('led', 12, 13, 0, { color: 'green' }),
    );
    const wires = [[3,-3,3,1,'#e5484d'],[5,-3,5,2,'#2b2d31'],[31,1,31,17,'#e5484d'],[30,2,30,18,'#2b2d31'],
      [6,4,6,1,'#e5484d'],[9,14,9,17,'#e5484d'],[6,15,6,18,'#2b2d31'],[11,4,8,4,'#0a84ff'],[7,13,8,7,'#f5c400'],[13,15,13,18,'#2b2d31']];
    for (const [x1,y1,x2,y2,col] of wires) c.wires.push(new Wire({ x: x1, y: y1 }, { x: x2, y: y2 }, col));
    ensureDesignators(c);
    return c;
  };
  const buildCounter = () => {
    const c = new Circuit(); c.name = 'Binary Counter';
    c.boards.push(new Board('half', 0, 0));
    c.parts.push(
      new Part('vcc', 3, -3), new Part('gnd', 5, -3), new Part('clock', 9, -2, 0, { hz: 2 }),
      new Part('ic7493', 10, 11), new Part('bargraph', 20, 11, 0, { color: 'yellow' }),
      new Part('resistor', 20, 14, 1, { ohms: 330 }), new Part('resistor', 21, 14, 1, { ohms: 330 }),
      new Part('resistor', 22, 14, 1, { ohms: 330 }), new Part('resistor', 23, 14, 1, { ohms: 330 }),
    );
    const wires = [[3,-3,3,1,'#e5484d'],[5,-3,5,2,'#2b2d31'],[31,1,31,17,'#e5484d'],[30,2,30,18,'#2b2d31'],
      [14,15,14,17,'#e5484d'],[14,4,14,2,'#2b2d31'],[11,15,11,18,'#2b2d31'],[12,15,12,18,'#2b2d31'],
      [12,5,10,14,'#ff8a00'],[9,-2,10,6,'#0a84ff'],[12,7,23,7,'#30a46c'],[15,6,22,6,'#30a46c'],
      [16,5,21,5,'#30a46c'],[13,4,20,4,'#30a46c']];
    for (const [x1,y1,x2,y2,col] of wires) c.wires.push(new Wire({ x: x1, y: y1 }, { x: x2, y: y2 }, col));
    ensureDesignators(c);
    return c;
  };
  const buildRc = () => {
    const c = new Circuit(); c.name = 'RC Charge & Discharge';
    c.boards.push(new Board('half', 0, 0));
    c.parts.push(
      new Part('vcc', 3, -3), new Part('gnd', 5, -3), new Part('button', 8, 22, 2, { label: 'CHARGE' }),
      new Part('resistor', 8, 13, 0, { ohms: 1000 }), new Part('capacitor', 12, 11, 0, { uf: 470, vmax: 16 }),
      new Part('resistor', 12, 14, 0, { ohms: 10000 }), new Part('resistor', 20, 13, 0, { ohms: 470 }),
      new Part('led', 24, 12, 0, { color: 'green' }),
    );
    const wires = [[3,-3,3,1,'#e5484d'],[5,-3,5,2,'#2b2d31'],[28,1,28,17,'#e5484d'],[29,2,29,18,'#2b2d31'],
      [8,22,8,15,'#0a84ff'],[13,14,13,18,'#2b2d31'],[16,15,16,18,'#2b2d31'],[12,15,20,15,'#30a46c'],[25,14,25,18,'#2b2d31']];
    for (const [x1,y1,x2,y2,col] of wires) c.wires.push(new Wire({ x: x1, y: y1 }, { x: x2, y: y2 }, col));
    ensureDesignators(c);
    return c;
  };
  const b5 = renderSchematicSVG(build555(), null, null, { standard: 'ieee', powerStyle: 'symbols' });
  assert.ok(b5.layout.symbols.some(s => s.type === 'ne555') && !/NaN|undefined/.test(b5.svg));
  const c7493 = renderSchematicSVG(buildCounter(), null, null, { standard: 'iec', powerStyle: 'rails' });
  const busRoutes = c7493.layout.routes.filter(r => r.kind === 'gnd' || r.kind === 'power');
  assert.ok(c7493.layout.symbols.some(s => s.type === 'ic7493') && busRoutes.length > 0 && !/NaN|undefined/.test(c7493.svg));
  const rc = renderSchematicSVG(buildRc(), null, null, { standard: 'ieee', powerStyle: 'symbols' });
  assert.ok(rc.layout.symbols.some(s => s.type === 'capacitor') && !/NaN|undefined/.test(rc.svg));
  return `555 Blinker (${b5.layout.routes.length} routes), 7493 Counter (${busRoutes.length} bus rails) & RC (${rc.layout.symbols.length} symbols) verified`;
});

test('P4.1', 'buildLabReportHTML builds self-contained Print-to-PDF HTML with embedded SVG schematic, waveforms & escaped metadata', () => {
  const c = buildSampleMixedCircuit();
  c.meta = { author: 'Ada <Lovelace>', project: 'EE101 Lab 4', revision: '2.1', notes: 'Verify <script>alert(1)</script> escaping & waveform timing.' };
  const uno = new Part('uno', 0, -25, 0, { code: 'void setup(){ pinMode(13, OUTPUT); }\nvoid loop(){ digitalWrite(13, HIGH); }' });
  const scope = new Part('oscilloscope', 28, -5);
  c.parts.push(uno, scope);
  c.probes = [{ x: 12, y: 11, name: 'CLK_IN', color: '#0a84ff', analog: false }];
  ensureDesignators(c);

  const eng = new Engine();
  eng.build(c);
  eng.step(0.01);
  const samples = new Map([[`${c.probes[0].x},${c.probes[0].y}`, { t: [0, 0.005, 0.01], v: [0, 5, 0] }]]);

  const html = buildLabReportHTML(
    { circuit: c, engine: eng, samples, ui: { an: { window: 0.02 } } },
    { pageSize: 'Letter', orientation: 'landscape', standard: 'iec', breadboardDataUrl: 'data:image/png;base64,AAAA' },
  );
  assert.ok(html.startsWith('<!DOCTYPE html>') && html.includes('</html>'));
  assert.ok(html.includes('@page { size: Letter landscape;'));
  assert.ok(html.includes('IEC · Functional') && html.includes('<svg ') && html.includes('</svg>'));
  assert.ok(html.includes('data:image/png;base64,AAAA'));
  assert.ok(html.includes('Bill of Materials (BOM)') && html.includes('Point-to-Point Wiring Guide'));
  assert.ok(html.includes('Waveforms &amp; Instrument Captures') && html.includes('CLK_IN'));
  assert.ok(html.includes('Microcontroller Firmware') && html.includes('pinMode(13, OUTPUT)'));
  assert.ok(!html.includes('<script>alert(1)</script>') && html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('Ada &lt;Lovelace&gt;'));
  return `HTML (${html.length} chars) with @page Letter landscape, IEC SVG, waveforms, BOM, wiring & MCU code verified`;
});

test('P4.2', 'buildLabReportMarkdown outputs GitHub/Obsidian Markdown tables, code blocks & respects section toggles', () => {
  const c = buildSampleMixedCircuit();
  c.meta = { author: 'Grace Hopper', project: 'Digital Logic', revision: '1.2', notes: 'Clean lab report check.' };
  const uno = new Part('uno', 0, -25, 0, { code: 'void setup(){}\nvoid loop(){}' });
  c.parts.push(uno);
  c.probes = [{ x: 12, y: 11, name: 'OUT', color: '#30a46c', analog: false }];
  ensureDesignators(c);

  const mdFull = buildLabReportMarkdown({ circuit: c }, { standard: 'ieee' });
  assert.ok(mdFull.includes('# RC + Clock + Gate — Lab Report'));
  assert.ok(mdFull.includes('![Breadboard Wiring Diagram](./RC-Clock-Gate-breadboard.png)'));
  assert.ok(mdFull.includes('![Circuit Schematic](./RC-Clock-Gate-schematic.svg)'));
  assert.ok(mdFull.includes('![Logic Analyzer Waveforms](./RC-Clock-Gate-waveforms.svg)'));
  assert.ok(mdFull.includes('## 3. Bill of Materials (BOM)') && mdFull.includes('| Item | Designators |'));
  assert.ok(mdFull.includes('```cpp\nvoid setup(){}\nvoid loop(){}\n```'));

  const mdMinimal = buildLabReportMarkdown(c, { includeBom: false, includeWiring: false, includeWaveforms: false, includeCode: false });
  assert.ok(!mdMinimal.includes('Bill of Materials') && !mdMinimal.includes('Wiring Guide') && !mdMinimal.includes('```cpp'));
  return `Full Markdown (${mdFull.length} chars) & section toggle filtering verified`;
});

test('P4.3', 'End-to-end section count matches disabled toggles & zero NaN across report SVGs', () => {
  const c = buildDualGateSrCircuit();
  c.probes = [{ x: 10, y: 11, name: 'SR_Q', color: '#ff8a00', analog: false }];
  const htmlNoSvg = buildLabReportHTML(c, { includeSchematic: false, includeBreadboard: false, includeWaveforms: false });
  assert.ok(!htmlNoSvg.includes('<svg '), 'Excluded SVG sections are omitted cleanly');
  const htmlFull = buildLabReportHTML(c, { standard: 'ieee', schTheme: 'print', includeBreadboard: false });
  assert.ok(htmlFull.includes('<svg ') && !/NaN|Infinity/.test(htmlFull), 'Embedded SVGs are strictly finite');
  return 'Report toggles & SVG finiteness across embedded report document verified';
});

const boxesOverlapStrict = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

test('P4.4', 'Dense Breadboard Cluster Label Test: zero pill-to-pill, pill-to-pinNum, and wire-label overlaps in Full mode', () => {
  const c = new Circuit(); c.name = 'Dense Counter Cluster';
  c.boards.push(new Board('half', 0, 0));
  c.parts.push(
    new Part('vcc', 3, -3), new Part('gnd', 5, -3), new Part('clock', 9, -2, 0, { hz: 2 }),
    new Part('ic7493', 10, 11), new Part('bargraph', 20, 11, 0, { color: 'yellow' }),
    new Part('resistor', 20, 14, 1, { ohms: 330 }), new Part('resistor', 21, 14, 1, { ohms: 330 }),
    new Part('resistor', 22, 14, 1, { ohms: 330 }), new Part('resistor', 23, 14, 1, { ohms: 330 }),
  );
  const wires = [
    [12, 7, 23, 7, '#30a46c', 'QA'], [15, 6, 22, 6, '#30a46c', 'QB'],
    [16, 5, 21, 5, '#30a46c', 'QC'], [13, 4, 20, 4, '#30a46c', 'QD'],
    [9, -2, 10, 6, '#0a84ff', 'CLK'], [12, 5, 10, 14, '#ff8a00', 'LOOP'],
  ];
  for (const [x1, y1, x2, y2, col, lbl] of wires) {
    const w = new Wire({ x: x1, y: y1 }, { x: x2, y: y2 }, col);
    w.label = lbl;
    c.wires.push(w);
  }
  ensureDesignators(c);

  const placed = computeLabelPlacements(c, 'full');
  const partBoxes = placed.partLabels;
  const pinBoxes = placed.pinNumBoxes || [];
  const wireBoxes = placed.wireLabels;

  for (let i = 0; i < partBoxes.length; i++) {
    for (let j = i + 1; j < partBoxes.length; j++) {
      assert.ok(!boxesOverlapStrict(partBoxes[i], partBoxes[j]), `Part label pills ${i} & ${j} overlapped`);
    }
    for (let p = 0; p < pinBoxes.length; p++) {
      assert.ok(!boxesOverlapStrict(partBoxes[i], pinBoxes[p]), `Part label ${i} overlapped DIP pin number ${p}`);
    }
  }
  for (let i = 0; i < wireBoxes.length; i++) {
    for (let j = i + 1; j < wireBoxes.length; j++) {
      assert.ok(!boxesOverlapStrict(wireBoxes[i], wireBoxes[j]), `Wire labels ${i} & ${j} overlapped`);
    }
    for (let k = 0; k < partBoxes.length; k++) {
      assert.ok(!boxesOverlapStrict(wireBoxes[i], partBoxes[k]), `Wire label ${i} overlapped part label ${k}`);
    }
    for (let p = 0; p < pinBoxes.length; p++) {
      assert.ok(!boxesOverlapStrict(wireBoxes[i], pinBoxes[p]), `Wire label ${i} overlapped DIP pin number ${p}`);
    }
  }
  return `${partBoxes.length} part pills, ${pinBoxes.length} DIP pin numbers, ${wireBoxes.length} wire badges placed with 0 collisions`;
});

test('P4.5', 'Schematic Consolidation, Manual Drag Push-Apart & Footer Notes Clearance', () => {
  const c = new Circuit();
  c.name = 'Very Long Schematic Title Exceeding Normal Box Boundaries For Ellipsis Check';
  c.meta = { author: 'Ada Lovelace', project: 'Digital Logic Lab Very Long Project Name Verification', revision: '2.0', notes: 'Verify R0(1)/R0(2) consolidated GND trunk\nVerify footer clears lowest routed net.' };
  c.boards.push(new Board('half', 0, 0));
  c.parts.push(
    new Part('vcc', 3, -3), new Part('gnd', 5, -3), new Part('clock', 9, -2, 0, { hz: 2 }),
    new Part('uno', 0, -24, 0, { code: 'void setup(){}' }),
    new Part('ic7493', 10, 11), new Part('bargraph', 20, 11, 0, { color: 'yellow' }),
    new Part('resistor', 20, 14, 1, { ohms: 330 }), new Part('resistor', 21, 14, 1, { ohms: 330 }),
    new Part('resistor', 22, 14, 1, { ohms: 330 }), new Part('resistor', 23, 14, 1, { ohms: 330 }),
  );
  const wires = [
    [3, -3, 3, 1, '#e5484d'], [5, -3, 5, 2, '#2b2d31'], [31, 1, 31, 17, '#e5484d'], [30, 2, 30, 18, '#2b2d31'],
    [14, 15, 14, 17, '#e5484d'], [14, 4, 14, 2, '#2b2d31'], [11, 15, 11, 18, '#2b2d31'], [12, 15, 12, 18, '#2b2d31'],
    [12, 5, 10, 14, '#ff8a00'], [9, -2, 10, 6, '#0a84ff'], [12, 7, 23, 7, '#30a46c'], [15, 6, 22, 6, '#30a46c'],
    [16, 5, 21, 5, '#30a46c'], [13, 4, 20, 4, '#30a46c'], [20, -24, 9, -2, '#8b5cf6'],
  ];
  for (const [x1, y1, x2, y2, col] of wires) c.wires.push(new Wire({ x: x1, y: y1 }, { x: x2, y: y2 }, col));
  ensureDesignators(c);

  const eng = new Engine();
  eng.build(c);
  eng.step(0.05);
  const res = renderSchematicSVG(c, eng, null, { standard: 'ieee', powerStyle: 'symbols', theme: 'live' });
  assert.ok((res.layout.powerTrunks || []).length > 0, 'Adjacent same-side 7493 GND pins consolidate into shared trunk');

  const gndPortsOn7493 = res.layout.powerPorts.filter(p => p.kind === 'gnd' && res.layout.symbols.some(s => s.schId === p.schId && s.type === 'ic7493'));
  const gndSidesOn7493 = new Set(gndPortsOn7493.map(p => p.side));
  assert.equal(gndSidesOn7493.size, gndPortsOn7493.length, 'At most 1 consolidated GND symbol per side of 7493 (R0(1)+R0(2) share 1 L-side GND)');
  assert.equal(gndPortsOn7493.filter(p => p.side === 'L').length, 1, '7493 R0(1) & R0(2) consolidate onto a single left-side GND symbol');

  const symBoxes = res.layout.symbols.map(s => ({ x0: s.x, y0: s.y, x1: s.x + s.w, y1: s.y + s.h }));
  for (let i = 0; i < symBoxes.length; i++) {
    for (let j = i + 1; j < symBoxes.length; j++) {
      assert.ok(!boxesOverlapStrict(symBoxes[i], symBoxes[j]), `Schematic symbols ${i} & ${j} overlapped`);
    }
  }

  // Footer note text sits cleanly below schematic symbols and bottom power rail
  const maxSymBottom = Math.max(...symBoxes.map(b => b.y1));
  const noteMatch = [...res.svg.matchAll(/<text x="[^"]+" y="([^"]+)" font-size="9\.5" fill="[^"]+">Note: Unwired pins hidden/g)];
  assert.equal(noteMatch.length, 1, 'Footer note renders in dedicated strip');
  const noteSvgY = +noteMatch[0][1] - res.offY;
  assert.ok(noteSvgY > maxSymBottom, `Footer note y (${noteSvgY}) sits below lowest schematic symbol (${maxSymBottom})`);

  // Force overlapping manual drag via part.sch onto an unpinned symbol and verify push-apart resolves collision
  const icSym = res.layout.symbols.find(s => s.type === 'ic7493');
  const rParts = c.parts.filter(p => p.type === 'resistor');
  rParts[0].sch = { x: icSym.x, y: icSym.y };
  const dragged = computeSchematicLayout(c, null, null, { powerStyle: 'symbols' });
  const dragBoxes = dragged.symbols.map(s => ({ x0: s.x, y0: s.y, x1: s.x + s.w, y1: s.y + s.h }));
  for (let i = 0; i < dragBoxes.length; i++) {
    for (let j = i + 1; j < dragBoxes.length; j++) {
      assert.ok(!boxesOverlapStrict(dragBoxes[i], dragBoxes[j]), `Pinned/dragged symbols ${i} & ${j} overlapped after push-apart`);
    }
  }
  assert.ok(!/NaN|Infinity|undefined/.test(res.svg));
  return `${res.layout.powerTrunks.length} consolidated trunks, ${symBoxes.length} non-overlapping symbols, footer clearance & drag push-apart verified`;
});

test('P4.6', 'AND Gate Schematic: no roaming VCC1 box, real switch/clock/tactile symbols & IC power pin footnote', () => {
  const c = new Circuit(); c.name = 'AND Gate';
  c.boards.push(new Board('half', 0, 0));
  c.parts.push(
    new Part('vcc', 3, -3), new Part('gnd', 6, -3), new Part('ic7408', 10, 11),
    new Part('toggle', 7, 22, 2), new Part('toggle', 13, 22, 2),
    new Part('resistor', 20, 13, 0, { ohms: 220 }), new Part('led', 24, 12, 0, { color: 'red' }),
  );
  const wires = [
    [3, -3, 3, 1, '#e5484d'], [6, -3, 6, 2, '#2b2d31'], [28, 1, 28, 17, '#e5484d'], [29, 2, 29, 18, '#2b2d31'],
    [10, 1, 10, 7, '#e5484d'], [16, 2, 16, 12, '#2b2d31'],
    [7, 22, 10, 15, '#0a84ff'], [13, 22, 11, 15, '#f5c400'], [12, 14, 20, 14, '#30a46c'], [25, 15, 25, 18, '#2b2d31'],
  ];
  for (const [x1, y1, x2, y2, col] of wires) c.wires.push(new Wire({ x: x1, y: y1 }, { x: x2, y: y2 }, col));
  ensureDesignators(c);

  const res = renderSchematicSVG(c, null, null, { standard: 'ieee', powerStyle: 'symbols' });
  assert.ok(!res.layout.symbols.some(s => s.isSupplyOrigin), 'Breadboard VCC/GND rail plugs omitted in symbols mode');
  assert.ok(res.layout.unusedNotes.some(n => n.includes('Power U1 (7408): VCC=14 (+5V), GND=7 (GND)')), 'IC power pins documented cleanly in footer');
  assert.ok(!res.svg.includes('>SW</text>'), 'Toggle switches use SPDT switch geometry rather than generic SW box');
  assert.ok(res.svg.includes('<circle cx="29" cy="12"'), 'Toggle switch draws real contact terminals');

  // Verify tactile 4-pin bridge collapses to 2 logical pins & button/clock render non-box glyphs
  const c2 = new Circuit();
  c2.boards.push(new Board('half', 0, 0));
  const tact = new Part('tactile', 10, 11);
  const btn = new Part('button', 6, 22, 2);
  const clk = new Part('clock', 3, -2, 0, { hz: 5 });
  const r = new Part('resistor', 14, 11, 0, { ohms: 1000 });
  c2.parts.push(tact, btn, clk, r);
  c2.wires.push(
    new Wire(btn.worldPins()[0], tact.worldPins()[0], '#0a84ff'),
    new Wire(tact.worldPins()[2], r.worldPins()[0], '#30a46c'),
    new Wire(clk.worldPins()[0], r.worldPins()[1], '#ff8a00'),
  );
  ensureDesignators(c2);
  const res2 = renderSchematicSVG(c2, null, null, { standard: 'ieee' });
  const tactSym = res2.layout.symbols.find(s => s.type === 'tactile');
  assert.equal(tactSym.pins.length, 2, 'Tactile internal 1.l/1.r & 2.l/2.r links collapse cleanly to 2 terminals');
  assert.ok(res2.svg.includes('L 36 16 L 36 24 L 41 24'), 'Clock renders square-wave oscillator glyph');
  return 'Zero roaming VCC1 plug, SPDT toggles, 2-pin collapsed tactile, clock & pushbutton verified';
});

test('P4.7', 'Trainer Board, seg7 & Oscilloscope internal link dedup + active-net filtering + semantic Bargraph/OLED pins', () => {
  const c = new Circuit(); c.name = 'Trainer + Displays';
  c.boards.push(new Board('half', 0, 0));
  const tb = new Part('trainer-board', 0, -5);
  const ic = new Part('ic7404', 10, 11);
  const seg = new Part('seg7', 2, 11);
  const scope = new Part('oscilloscope', 45, -5);
  const oled = new Part('board-ssd1306', 2, 22);
  const bg = new Part('bargraph', 20, 11);
  const r1 = new Part('resistor', 20, 14, 1, { ohms: 330 });
  c.parts.push(tb, ic, seg, scope, oled, bg, r1);
  const tp = tb.worldPins();
  const vccPin = tp.find(p => p.name === '+5V');
  const gndPin = tp.find(p => p.name === 'GND');
  const s0Pin = tp.find(p => p.name === 'S0');
  const l0Pin = tp.find(p => p.name === 'L0');
  const ip = ic.worldPins();
  c.wires.push(
    new Wire(vccPin, ip[13], '#e5484d'),
    new Wire(gndPin, ip[6], '#2b2d31'),
    new Wire(s0Pin, ip[0], '#0a84ff'),
    new Wire(ip[1], l0Pin, '#30a46c'),
    new Wire(ip[1], bg.worldPins()[0], '#ff8a00'), // A1
    new Wire(r1.worldPins()[1], gndPin, '#2b2d31'),
  );
  ensureDesignators(c);

  const data = extractCircuitData(c);
  assert.ok(!data.nets.some(n => n.name === '+5V_2' || n.name === 'GND_2'), 'No spurious +5V_2 or GND_2 nets');
  assert.equal(data.nets.length, 5, `Expected 5 genuinely wired nets (+5V, GND, S0, L0/A1, K1-R1), got ${data.nets.length}`);

  const res = renderSchematicSVG(c, null, null, { standard: 'ieee', hideUnwired: true });
  const tbSym = res.layout.symbols.find(s => s.type === 'trainer-board');
  assert.ok(tbSym.pins.length === 4, `Trainer prunes from 164 physical sockets to exactly 4 logical wired pins (got ${tbSym.pins.length})`);
  assert.equal(tbSym.pins.find(p => p.name === '+5V')?.side, 'T', 'Trainer +5V sits on Top');
  assert.equal(tbSym.pins.find(p => p.name === 'GND')?.side, 'B', 'Trainer GND sits on Bottom');

  const segSym = res.layout.symbols.find(s => s.type === 'seg7');
  assert.equal(segSym.pins.filter(p => p.name === 'COM').length, 1, 'seg7 twin COM pins collapse to 1 COM');

  const scopeSym = res.layout.symbols.find(s => s.type === 'oscilloscope');
  assert.equal(scopeSym.pins.filter(p => /GND/.test(p.name)).length, 1, 'oscilloscope 4 linked GNDs collapse to 1 GND');

  const oledSym = res.layout.symbols.find(s => s.type === 'board-ssd1306');
  assert.equal(oledSym.pins.find(p => p.name === 'VCC')?.side, 'T', 'OLED VCC placed on Top');
  assert.equal(oledSym.pins.find(p => p.name === 'GND')?.side, 'B', 'OLED GND placed on Bottom');

  const bgSym = res.layout.symbols.find(s => s.type === 'bargraph');
  assert.equal(bgSym.pins.find(p => p.name === 'A1')?.side, 'L', 'Bargraph anode A1 on Left');
  assert.equal(bgSym.pins.find(p => p.name === 'K1')?.side, 'R', 'Bargraph cathode K1 on Right');
  assert.ok(!/NaN|Infinity|undefined/.test(res.svg));
  return `Trainer 164->${tbSym.pins.length} pins, 0 self-loops, ${data.nets.length} nets, Bargraph L->R & OLED T/B verified`;
});

test('P4.8', 'New analog parts, op-amps, comparators, regulators, optocoupler & DMM emit GRID=20 schematics and SPICE cards', () => {
  const c = new Circuit();
  c.name = 'Analog Showcase';
  c.boards.push(new Board('half', 0, 0));
  const cCer = new Part('capacitor', 2, 12, 0, { kind: 'ceramic', uf: 0.1, vmax: 50 });
  const ind = new Part('inductor', 6, 12, 0, { mh: 10, rs: 0.5 });
  const zen = new Part('zener', 12, 12, 0, { vz: 5.1 });
  const sch = new Part('diode', 18, 12, 0, { model: '1N5819' });
  const pnp = new Part('pnp', 2, 15, 0, { model: '2N3906' });
  const nmos = new Part('nmos', 6, 15, 0, { model: '2N7000' });
  const pmos = new Part('pmos', 10, 15, 0, { model: 'BS250' });
  const u78 = new Part('lm7805', 14, 15);
  const u317 = new Part('lm317', 18, 15);
  const opto = new Part('pc817', 22, 12);
  const u741 = new Part('lm741', 10, 22);
  const u358 = new Part('lm358', 18, 22);
  const u393 = new Part('lm393', 26, 22);
  const dmm = new Part('multimeter', 36, 4);
  const vcc = new Part('vcc', 2, 1);
  const gnd = new Part('gnd', 4, 2);
  c.parts.push(vcc, gnd, cCer, ind, zen, sch, pnp, nmos, pmos, u78, u317, opto, u741, u358, u393, dmm);
  c.wires.push(
    new Wire(vcc.worldPins()[0], u78.worldPins()[0]),
    new Wire(gnd.worldPins()[0], u78.worldPins()[1]),
    new Wire(u78.worldPins()[2], u358.worldPins()[7]),
    new Wire(gnd.worldPins()[0], u358.worldPins()[3]),
    new Wire(u358.worldPins()[2], vcc.worldPins()[0]),
    new Wire(u358.worldPins()[0], u358.worldPins()[1]),
    new Wire(u393.worldPins()[2], vcc.worldPins()[0]),
    new Wire(u393.worldPins()[1], gnd.worldPins()[0]),
    new Wire(u393.worldPins()[0], dmm.worldPins()[0]),
    new Wire(gnd.worldPins()[0], dmm.worldPins()[1]),
    new Wire(cCer.worldPins()[0], ind.worldPins()[0]),
    new Wire(ind.worldPins()[1], gnd.worldPins()[0]),
    new Wire(zen.worldPins()[0], gnd.worldPins()[0]),
    new Wire(zen.worldPins()[1], u78.worldPins()[2]),
  );
  ensureDesignators(c);

  const eng = new Engine();
  eng.build(c);
  eng.step(1e-4);

  const data = extractCircuitData(c, eng);
  const spice = toSpiceNetlist(data);
  assert.ok(/Q_Q1\s/.test(spice) && /M_Q/.test(spice) && /X_U/.test(spice) && /^L\d+\s/m.test(spice), 'SPICE emits BJT, MOSFET, Subckt & Inductor cards');

  for (const viewMode of ['functional', 'package']) {
    const res = renderSchematicSVG(c, eng, null, { viewMode, standard: 'ieee', hideUnwired: false });
    assert.ok(!/NaN|Infinity|undefined/.test(res.svg), `No NaN/undefined in ${viewMode} schematic`);
    for (const sym of res.layout.symbols) {
      for (const p of sym.pins) {
        const px = sym.x + p.lx, py = sym.y + p.ly;
        assert.equal(px % SCH_GRID, 0, `${sym.ref}.${p.name} x=${px} not on GRID=20`);
        assert.equal(py % SCH_GRID, 0, `${sym.ref}.${p.name} y=${py} not on GRID=20`);
      }
    }
  }
  const opSym = renderSchematicSVG(c, eng, null, { viewMode: 'functional' }).layout.symbols.find(s => s.type === 'lm358');
  assert.ok(opSym && /polygon/.test(opSym.renderSVG('ieee', { fill: '#fff', stroke: '#000', pin: '#000', ref: '#000', sub: '#666', num: '#666' }, true)), 'LM358 renders triangular op-amp symbol');
  return 'All 13 new types aligned to GRID=20 across functional & package views + SPICE verified';
});

test('P4.9', '14-board 47-IC SAP-1 CPU exports full & per-board filtered schematics (Net Flags + seg7x4/spdt), BOM, SPICE & Lab Report', () => {
  const { circuit } = buildSap1CpuCircuit({ program: 'fibonacci', potPos: 0.015 });
  const eng = new Engine();
  eng.build(circuit);
  eng.step(2e-4);

  // 1) Full top-level sheet: custom spdt & seg7x4 symbols, GRID=20 alignment, Net Flag promotion for labeled bus/ctrl
  const full = renderSchematicSVG(circuit, eng, null, { viewMode: 'functional', standard: 'ieee', hideUnwired: true });
  assert.ok(!/NaN|Infinity|undefined/.test(full.svg), 'Full SAP-1 SVG must not contain NaN/undefined');
  for (const sym of full.layout.symbols) {
    for (const p of sym.pins) {
      assert.equal((sym.x + p.lx) % SCH_GRID, 0, `${sym.ref}.${p.name} x off grid`);
      assert.equal((sym.y + p.ly) % SCH_GRID, 0, `${sym.ref}.${p.name} y off grid`);
    }
  }
  const spdtSym = full.layout.symbols.find(s => s.type === 'spdt');
  assert.ok(spdtSym && spdtSym.pins.length === 3, 'SPDT symbol should render 3 pins (A, B, COM)');
  const dispSym = full.layout.symbols.find(s => s.type === 'seg7x4');
  assert.ok(dispSym && dispSym.pins.length === 11, `seg7x4 with DP unwired should show 11 wired pins (7 segs + 4 digits), got ${dispSym?.pins.length}`);

  const flagNames = new Set(full.layout.netFlags.map(nf => nf.netName));
  for (const req of ['BUS0', 'BUS7', 'CLK', 'RST', 'HLT', 'MI\u0305', 'CO\u0305']) {
    assert.ok(flagNames.has(req), `Full schematic should promote labeled net '${req}' to Net Flag`);
  }
  // Ensure unlabeled internal nets were NOT indiscriminately turned into Net Flags
  assert.ok(![...flagNames].some(n => /^N\d+$/.test(n)), 'Full schematic must leave unlabeled internal nodes as wires, not N## flags');

  // 2) Subsystem board filter: R4 Output Module sheet with cross-board flagged stubs
  const r4 = renderSchematicSVG(circuit, eng, null, { boardId: 'b_r4', viewMode: 'functional', standard: 'ieee' });
  assert.ok(!/NaN|Infinity|undefined/.test(r4.svg), 'Filtered R4 SVG clean');
  assert.ok(r4.layout.symbols.some(s => s.type === 'seg7x4'), 'R4 sheet includes seg7x4');
  assert.ok(!r4.layout.symbols.some(s => s.type === 'ic74189'), 'R4 sheet excludes parts from other boards');
  const r4Flags = new Set(r4.layout.netFlags.map(nf => nf.netName));
  assert.ok(r4Flags.has('BUS0') && r4Flags.has('BUS7'), `Filtered R4 sheet should show cross-board BUS Net Flag stubs, got ${[...r4Flags].join(',')}`);

  // 3) BOM, SPICE, Wiring, Netlist JSON & Lab Report HTML/MD on 47-IC CPU
  const data = extractCircuitData(circuit, eng);
  assert.ok(data.bom.length >= 10 && data.partCount >= 300);
  const spice = toSpiceNetlist(data);
  assert.ok(spice.includes('.end') && spice.includes('R'));
  const html = buildLabReportHTML({ circuit, engine: eng }, { includeBreadboard: false, boardId: 'b_r4' });
  const md = buildLabReportMarkdown({ circuit, engine: eng }, {});
  assert.ok(html.includes('<svg') && !html.includes('NaN') && md.includes('Fibonacci'));
  return `Full: ${full.layout.symbols.length} syms (${flagNames.size} flagged nets); R4 sheet: ${r4.layout.symbols.length} syms (${r4Flags.size} stubs)`;
});

let failed = 0;
for (const r of results) {
  console.log(`${r.pass ? 'PASS' : 'FAIL'} [${r.id}] ${r.name} -> ${r.info}`);
  if (!r.pass) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);

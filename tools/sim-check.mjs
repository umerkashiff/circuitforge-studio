/**
 * Headless circuit check: node tools/sim-check.mjs <circuit.cforge.json> [seconds] [--bare-leds]
 * Steps the engine with the same adaptive time step as the app and reports
 * peak LED currents, damaged parts, non-converged steps and 555 output frequency.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (p) => import(pathToFileURL(path.join(root, p)).href);
await load('src/parts/library.js');
await load('src/mcu/boards.js');
const { Circuit } = await load('src/model.js');
const { Engine } = await load('src/sim/engine.js');
const { prefs } = await load('src/sim/prefs.js');

const [file, secs = '5'] = process.argv.slice(2).filter(a => !a.startsWith('--'));
if (process.argv.includes('--bare-leds')) prefs.trainerLeds = false;
const c = Circuit.fromJSON(JSON.parse(fs.readFileSync(file, 'utf8')));
const e = new Engine();
e.build(c);
const leds = c.parts.filter(p => p.type === 'led');
const t555 = c.parts.filter(p => p.type === 'ne555');
const peak = new Map(leds.map(p => [p.id, 0]));
let steps = 0, bad = 0, edges = 0, prevOut = 0, tFirst = null, tLast = 0;
const end = +secs;
while (e.time < end) {
  e.step(Math.min(e.suggestDt(), end - e.time + 1e-9));
  steps++;
  if (!e.converged) bad++;
  for (const p of leds) peak.set(p.id, Math.max(peak.get(p.id), e.byPart.get(p.id).device.cur[0]));
  if (t555.length) {
    const out = t555[0].worldPins()[2];
    const hi = e.voltage(e.netAt(out.x, out.y)) > 2.5 ? 1 : 0;
    if (hi && !prevOut) { edges++; if (e.time > end / 2) { if (tFirst === null) tFirst = e.time; tLast = e.time; } }
    prevOut = hi;
  }
}
console.log(`${path.basename(file)} · ${end}s · ${steps} steps · non-converged: ${bad} · LEDs ${prefs.trainerLeds ? 'protected' : 'bare'}`);
for (const p of leds) console.log(`  LED ${p.id}: peak ${(peak.get(p.id) * 1000).toFixed(2)} mA ${p.props.damaged ? '— BURNED' : ''}`);
if (t555.length && tFirst !== null && tLast > tFirst) {
  const halfEdges = Math.max(1, Math.round(edges / 2));
  console.log(`  555 OUT ≈ ${((halfEdges - 1) / (tLast - tFirst)).toFixed(1)} Hz (second half of the run)`);
}
const dmg = c.parts.filter(p => p.props.damaged).map(p => `${p.type}:${p.props.damaged}`);
console.log('  damaged:', dmg.length ? dmg.join(', ') : 'none');
const ws = e.collectWarnings().filter(w => w.level !== 'note').map(w => `${w.level}: ${w.text}`);
if (ws.length) console.log('  ' + ws.join('\n  '));

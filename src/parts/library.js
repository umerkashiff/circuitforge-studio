/**
 * Part library: geometry (pins on the 0.1" grid), artwork and behaviour.
 * Artwork is drawn in local pixels where one grid unit = U px and pin 0 sits
 * at the origin; the renderer applies the part's position and rotation.
 */
import { register } from './registry.js';
import { IC_LIST } from './ics.js';
import * as dev from '../sim/devices.js';
import * as devI2C from '../sim/devices_i2c.js';
import { prefs } from '../sim/prefs.js';

// Trainer boards put a resistor in series with every LED, so students can wire them straight to outputs.
const TRAINER_R = 330;
const PROTECT_FIELD = { key: 'protect', label: 'Built-in resistor', kind: 'select', options: [['auto', 'Auto (from Settings)'], ['on', '330 Ω (protected)'], ['off', 'None (realistic)']] };
const ledProtected = (part) => part.props.protect === 'on' || (part.props.protect !== 'off' && prefs.trainerLeds);
const ok = (v) => !Number.isNaN(v);

const U = 20;
const TAU = Math.PI * 2;

// ---------------------------------------------------------------- helpers --
function rr(g, x, y, w, h, r) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}
function lin(g, x0, y0, x1, y1, stops) {
  const gr = g.createLinearGradient(x0, y0, x1, y1);
  stops.forEach(([o, c]) => gr.addColorStop(o, c));
  return gr;
}
/** Tinned component lead from (x0,y0) to (x1,y1), in grid units. */
function lead(g, x0, y0, x1, y1, w = 2.4) {
  g.lineCap = 'round';
  g.strokeStyle = '#8a9099'; g.lineWidth = w + 1;
  g.beginPath(); g.moveTo(x0 * U, y0 * U); g.lineTo(x1 * U, y1 * U); g.stroke();
  g.strokeStyle = '#d5d9df'; g.lineWidth = w - 0.6;
  g.stroke();
}
function legPolyline(g, pts, w = 2.4) {
  g.lineCap = 'round'; g.lineJoin = 'round';
  g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x * U, y * U) : g.moveTo(x * U, y * U)));
  g.strokeStyle = '#8a9099'; g.lineWidth = w + 1; g.stroke();
  g.strokeStyle = '#d5d9df'; g.lineWidth = w - 0.6; g.stroke();
}
function pinPad(g, x, y) {
  g.fillStyle = '#b8bec7';
  g.beginPath(); g.arc(x * U, y * U, 2.6, 0, TAU); g.fill();
}
function shadow(g, blur = 6, oy = 2, a = 0.22) {
  g.shadowColor = `rgba(15,20,30,${a})`; g.shadowBlur = blur; g.shadowOffsetY = oy;
}
function noShadow(g) { g.shadowColor = 'transparent'; g.shadowBlur = 0; g.shadowOffsetY = 0; }

const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", "Helvetica Neue", sans-serif';
const MONO = '"SF Mono", ui-monospace, "JetBrains Mono", Menlo, monospace';

/** Draw text that stays readable whatever the part rotation. */
function text(g, env, s, x, y, { size = 10, color = '#1d1d1f', weight = 600, align = 'center', font = FONT, follow = false } = {}) {
  g.save();
  g.translate(x, y);
  let a = -env.rot * Math.PI / 2;
  if (follow) a = env.rot === 2 ? Math.PI : env.rot === 1 ? 0 : env.rot === 3 ? Math.PI : 0;
  if (follow && (env.rot === 2 || env.rot === 3)) g.rotate(Math.PI);
  else if (!follow) g.rotate(a);
  g.font = `${weight} ${size}px ${font}`;
  g.fillStyle = color; g.textAlign = align; g.textBaseline = 'middle';
  g.fillText(s, 0, 0);
  g.restore();
}

function glow(g, x, y, r, rgb, k) {
  if (k <= 0.01) return;
  const gr = g.createRadialGradient(x, y, 0, x, y, r);
  gr.addColorStop(0, `rgba(${rgb},${0.85 * k})`);
  gr.addColorStop(0.3, `rgba(${rgb},${0.45 * k})`);
  gr.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = gr;
  g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
}
/** Perceived LED brightness 0–1: the eye is roughly logarithmic, so a few mA already looks clearly on. */
function ledLevel(amps) { return amps < 3e-4 ? 0 : Math.min(1, Math.sqrt(amps / 0.008)); }
function mixHex(a, b, t) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = (sh) => Math.round(((pa >> sh) & 255) * (1 - t) + ((pb >> sh) & 255) * t);
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}

const LED_COLORS = {
  // off = how the tinted epoxy looks unlit (dull, dark); lit = the emitted colour
  red: { body: '#d92d2d', off: '#6e2424', lit: '#ff3b30', rgb: '255,59,48', vf: 1.8, rs: 12, name: 'Red' },
  green: { body: '#1f9d4a', off: '#22472f', lit: '#30ff6a', rgb: '48,255,106', vf: 2.1, rs: 15, name: 'Green' },
  yellow: { body: '#e3b414', off: '#5f5426', lit: '#ffd60a', rgb: '255,214,10', vf: 2.0, rs: 15, name: 'Yellow' },
  blue: { body: '#2563eb', off: '#22305a', lit: '#2f7bff', rgb: '47,123,255', vf: 3.0, rs: 18, name: 'Blue' },
  white: { body: '#d9dde3', off: '#8e939c', lit: '#ffffff', rgb: '200,225,255', vf: 3.0, rs: 18, name: 'White' },
};
const LED_MAX_A = 0.12;

// ---------------------------------------------------------------- DIP ICs --
function dipPins(n) {
  const half = n / 2, pins = [];
  for (let i = 1; i <= n; i++) pins.push(i <= half ? { x: i - 1, y: 0 } : { x: n - i, y: -3 });
  return pins;
}
function drawDip(g, env, n, partNo, sub, pinLabels) {
  const half = n / 2;
  const x0 = -0.5 * U, x1 = (half - 0.5) * U, y0 = -2.55 * U, y1 = -0.45 * U;
  // legs
  for (let i = 0; i < half; i++) {
    for (const [ya, yb] of [[-0.45, 0], [-2.55, -3]]) {
      g.fillStyle = '#c3c8cf';
      g.fillRect(i * U - 3, ya * U + (ya > -1 ? 0 : -9), 6, 9);
      g.fillStyle = '#9aa1ab';
      g.fillRect(i * U - 1.2, yb * U - (ya > -1 ? 2.5 : -0.5), 2.4, 2.5);
    }
  }
  shadow(g, 8, 3, 0.28);
  rr(g, x0, y0, x1 - x0, y1 - y0, 3);
  g.fillStyle = lin(g, 0, y0, 0, y1, [[0, '#3a3d44'], [0.5, '#2a2c31'], [1, '#1d1f23']]);
  g.fill();
  noShadow(g);
  g.strokeStyle = 'rgba(255,255,255,0.07)'; g.lineWidth = 1; g.stroke();
  // notch + pin-1 dot
  g.fillStyle = '#16171a';
  g.beginPath(); g.arc(x0, (y0 + y1) / 2, 5, -Math.PI / 2, Math.PI / 2); g.fill();
  g.fillStyle = '#7a808b';
  g.beginPath(); g.arc(x0 + 8, y1 - 8, 2.8, 0, TAU); g.fill();
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const wide = env.rot % 2 === 0 || n <= 8;
  if (env.rot % 2 === 0) {
    const k = env.chipText || 1;
    text(g, env, partNo, cx, cy - 5.5 * k, { size: 13.5 * k, color: '#ffffff', weight: 700, font: MONO, follow: true });
    text(g, env, sub, cx, cy + 9.5 * k, { size: 9.5 * k, color: '#c7cbd2', weight: 600, follow: true });
  } else {
    text(g, env, partNo.replace('74LS', ''), cx, cy, { size: 12 * (env.chipText || 1), color: '#ffffff', weight: 700, font: MONO });
  }
  if (env.showPinLabels && pinLabels && wide) {
    for (let i = 0; i < n; i++) {
      const p = dipPins(n)[i];
      const ly = p.y === 0 ? y1 - 5 : y0 + 5;
      text(g, env, pinLabels[i], p.x * U, ly, { size: 6, color: '#9aa1ac', weight: 600, font: MONO });
    }
  }
}

for (const ic of IC_LIST) {
  register({
    type: 'ic' + ic.id,
    name: `${ic.id} ${ic.name}`,
    short: ic.id,
    title: ic.title,
    cat: ic.cat,
    desc: `${ic.title} · DIP-${ic.n}`,
    ic,
    pins: () => dipPins(ic.n).map((p, i) => ({ ...p, name: ic.pins[i] })),
    bounds: () => [-0.6, -3.2, ic.n / 2 - 0.4, 0.2],
    draw: (g, part, env) => drawDip(g, env, ic.n, ic.id.startsWith('74') ? '74LS' + ic.id.slice(2) : 'CD' + ic.id, ic.name, ic.pins),
    device: (part, nets) => dev.icDevice(ic, nets),
  });
}

register({
  type: 'ne555', name: '555 Timer', short: '555', title: 'Precision timer', cat: 'Timers',
  desc: 'Astable / monostable timer · DIP-8',
  ic: { n: 8, pins: ['GND', 'TRIG', 'OUT', 'RESET', 'CTRL', 'THR', 'DIS', 'VCC'], vcc: 8, gnd: 1 },
  pins: () => dipPins(8).map((p, i) => ({ ...p, name: ['GND', 'TRIG', 'OUT', 'RESET', 'CTRL', 'THR', 'DIS', 'VCC'][i] })),
  bounds: () => [-0.6, -3.2, 3.6, 0.2],
  draw: (g, part, env) => drawDip(g, env, 8, 'NE555', 'TIMER', ['GND', 'TRG', 'OUT', 'RST', 'CTL', 'THR', 'DIS', 'VCC']),
  device: (part, nets) => dev.timer555(nets),
});

// ---------------------------------------------------------------- Power ----
register({
  type: 'vcc', name: '+5 V Supply', cat: 'Power', desc: 'Regulated 5 V source. Plug into a + rail.',
  pins: () => [{ x: 0, y: 0, name: '+5V' }],
  bounds: () => [-1.3, -2.9, 1.3, 0.3],
  draw(g, part, env) {
    lead(g, 0, -0.9, 0, 0);
    shadow(g);
    rr(g, -1.2 * U, -2.8 * U, 2.4 * U, 1.9 * U, 7);
    g.fillStyle = lin(g, 0, -2.8 * U, 0, -0.9 * U, [[0, '#ff6a5f'], [1, '#e5484d']]); g.fill();
    noShadow(g);
    text(g, env, '+5V', 0, -1.85 * U, { size: 11, color: '#fff', weight: 700 });
  },
  supply: () => [{ i: 0, kind: 'V:5' }],
  device: (part, nets) => dev.supply(nets, 5),
});
register({
  type: 'gnd', name: 'Ground', cat: 'Power', desc: '0 V reference. Plug into a − rail.',
  pins: () => [{ x: 0, y: 0, name: 'GND' }],
  bounds: () => [-1.3, -2.9, 1.3, 0.3],
  draw(g, part, env) {
    lead(g, 0, -0.9, 0, 0);
    shadow(g);
    rr(g, -1.2 * U, -2.8 * U, 2.4 * U, 1.9 * U, 7);
    g.fillStyle = lin(g, 0, -2.8 * U, 0, -0.9 * U, [[0, '#4a4f58'], [1, '#2c2f35']]); g.fill();
    noShadow(g);
    text(g, env, 'GND', 0, -1.85 * U, { size: 11, color: '#fff', weight: 700 });
  },
  supply: () => [{ i: 0, kind: 'G' }],
  device: (part, nets) => dev.supply(nets, 0),
});
register({
  type: 'battery', name: 'Battery', cat: 'Power', desc: 'DC battery with red (+) and black (−) leads.',
  defaults: { volts: 9 },
  fields: [{ key: 'volts', label: 'Voltage', kind: 'select', options: [[1.5, '1.5 V (AA)'], [3, '3 V'], [4.5, '4.5 V'], [6, '6 V'], [9, '9 V'], [12, '12 V']] }],
  pins: () => [{ x: 0, y: 0, name: '+' }, { x: 1, y: 0, name: '−' }],
  bounds: () => [-1.1, -5.8, 2.1, 0.3],
  draw(g, part, env) {
    legPolyline(g, [[0, 0], [0, -1.6]], 3.2);
    g.strokeStyle = '#e5484d'; g.lineWidth = 3; g.beginPath(); g.moveTo(0, -0.4 * U); g.lineTo(0, -1.6 * U); g.stroke();
    g.strokeStyle = '#2a2c31'; g.beginPath(); g.moveTo(U, -0.4 * U); g.lineTo(U, -1.6 * U); g.stroke();
    pinPad(g, 0, 0); pinPad(g, 1, 0);
    shadow(g, 8, 3);
    rr(g, -1 * U, -5.6 * U, 3 * U, 4.1 * U, 6);
    const v = part.props.volts;
    g.fillStyle = v <= 1.5 ? lin(g, -U, 0, 2 * U, 0, [[0, '#2a2c31'], [0.5, '#4b4f57'], [1, '#22242a']])
      : lin(g, -U, 0, 2 * U, 0, [[0, '#1f2b3a'], [0.5, '#33465e'], [1, '#1b2531']]);
    g.fill(); noShadow(g);
    g.fillStyle = v <= 1.5 ? '#e0a526' : '#f2c94c';
    g.fillRect(-1 * U, -4.2 * U, 3 * U, 1.1 * U);
    text(g, env, `${v} V`, 0.5 * U, -3.65 * U, { size: 11, color: '#1d1d1f', weight: 800 });
    g.fillStyle = '#c9ced6'; g.fillRect(-0.4 * U, -5.95 * U, 0.6 * U, 0.4 * U); g.fillRect(0.8 * U, -5.95 * U, 0.6 * U, 0.4 * U);
    text(g, env, '+', 0, -5 * U, { size: 11, color: '#fff', weight: 700 });
    text(g, env, '−', U, -5 * U, { size: 11, color: '#fff', weight: 700 });
  },
  supply: (part) => [{ i: 0, kind: 'B+:' + part.id }, { i: 1, kind: 'B-:' + part.id }],
  device: (part, nets) => dev.battery(nets, part),
});

// ---------------------------------------------------------------- Inputs ---
function moduleBody(g, x, y, w, h, color = '#f5f5f7') {
  shadow(g, 8, 3, 0.2);
  rr(g, x * U, y * U, w * U, h * U, 8);
  g.fillStyle = color; g.fill(); noShadow(g);
  g.strokeStyle = 'rgba(0,0,0,0.08)'; g.lineWidth = 1; g.stroke();
}

register({
  type: 'toggle', name: 'Toggle Switch', cat: 'Inputs', desc: 'Click to switch the output between HIGH (5 V) and LOW (0 V).',
  defaults: { on: false, label: '' },
  fields: [{ key: 'label', label: 'Label', kind: 'text' }],
  pins: () => [{ x: 0, y: 0, name: 'OUT' }],
  bounds: () => [-1.5, -3.4, 1.5, 0.3],
  draw(g, part, env) {
    lead(g, 0, -0.9, 0, 0);
    moduleBody(g, -1.5, -3.3, 3, 2.4);
    const on = part.props.on;
    rr(g, -1.05 * U, -2.7 * U, 2.1 * U, 1.2 * U, 0.6 * U);
    g.fillStyle = on ? '#34c759' : '#d1d1d6'; g.fill();
    shadow(g, 3, 1, 0.25);
    g.fillStyle = '#fff';
    const flip = env.rot === 2 || env.rot === 3 ? -1 : 1; // keep "on = knob right" as seen on screen
    g.beginPath(); g.arc((on ? 0.45 : -0.45) * flip * U, -2.1 * U, 0.5 * U, 0, TAU); g.fill();
    noShadow(g);
    text(g, env, part.props.label || (on ? 'HIGH' : 'LOW'), 0, -1.2 * U, { size: 7.5, color: on ? '#248a3d' : '#8e8e93', weight: 700 });
  },
  control: () => 'toggle',
  click(part) { part.props.on = !part.props.on; return true; },
  device: (part, nets) => dev.logicSource(nets[0], () => part.props.on),
});
register({
  type: 'button', name: 'Push Button', cat: 'Inputs', desc: 'Momentary: HIGH while held down, LOW when released.',
  defaults: { label: '' },
  fields: [{ key: 'label', label: 'Label', kind: 'text' }],
  pins: () => [{ x: 0, y: 0, name: 'OUT' }],
  bounds: () => [-1.5, -3.4, 1.5, 0.3],
  draw(g, part, env) {
    lead(g, 0, -0.9, 0, 0);
    moduleBody(g, -1.5, -3.3, 3, 2.4);
    const on = !!part.ui.pressed;
    g.fillStyle = '#c7c7cc';
    g.beginPath(); g.arc(0, -2.1 * U, 0.85 * U, 0, TAU); g.fill();
    shadow(g, on ? 1 : 4, on ? 0 : 2, 0.3);
    g.fillStyle = on ? '#0a84ff' : lin(g, 0, -2.8 * U, 0, -1.4 * U, [[0, '#4da3ff'], [1, '#0a6fe0']]);
    g.beginPath(); g.arc(0, -2.1 * U, on ? 0.62 * U : 0.68 * U, 0, TAU); g.fill();
    noShadow(g);
    if (part.props.label) text(g, env, part.props.label, 0, -1.15 * U, { size: 7, color: '#6e6e73', weight: 700 });
  },
  control: () => 'press',
  device: (part, nets) => dev.logicSource(nets[0], () => !!part.ui.pressed),
});
register({
  type: 'clock', name: 'Clock', cat: 'Inputs', desc: 'Square-wave generator with adjustable frequency and duty cycle.',
  aliases: ['wokwi-clock-generator'],
  defaults: { hz: 1, duty: 50 },
  fields: [
    { key: 'hz', label: 'Frequency', kind: 'select', options: [[0.25, '0.25 Hz'], [0.5, '0.5 Hz'], [1, '1 Hz'], [2, '2 Hz'], [5, '5 Hz'], [10, '10 Hz'], [25, '25 Hz'], [100, '100 Hz'], [1000, '1 kHz']] },
    { key: 'duty', label: 'Duty Cycle (%)', kind: 'select', options: [[10, '10%'], [25, '25%'], [50, '50%'], [75, '75%'], [90, '90%']] },
  ],
  pins: () => [{ x: 0, y: 0, name: 'CLK' }],
  bounds: () => [-2, -3.4, 2, 0.3],
  draw(g, part, env) {
    lead(g, 0, -0.9, 0, 0);
    moduleBody(g, -2, -3.3, 4, 2.4, '#1c1c1e');
    const hi = env.dev ? env.dev.high : false;
    g.strokeStyle = '#8e8e93'; g.lineWidth = 1.6; g.lineJoin = 'round';
    g.beginPath();
    const wy = -2.15 * U, a = 0.32 * U;
    g.moveTo(-1.55 * U, wy + a); g.lineTo(-1.2 * U, wy + a); g.lineTo(-1.2 * U, wy - a); g.lineTo(-0.7 * U, wy - a);
    g.lineTo(-0.7 * U, wy + a); g.lineTo(-0.2 * U, wy + a); g.lineTo(-0.2 * U, wy - a); g.lineTo(0.1 * U, wy - a);
    g.stroke();
    g.fillStyle = hi ? '#30d158' : '#3a3a3c';
    g.beginPath(); g.arc(1.4 * U, -2.6 * U, 3.2, 0, TAU); g.fill();
    if (hi) glow(g, 1.4 * U, -2.6 * U, 12, '48,209,88', 1);
    const hz = part.props.frequency || part.props.hz || 1;
    text(g, env, hz >= 1000 ? `${hz / 1000} kHz` : `${hz} Hz`, 0, -1.3 * U, { size: 8, color: '#f2f2f7', weight: 600, font: MONO });
  },
  device: (part, nets) => {
    const d = dev.logicSource(nets[0], () => d.high);
    d.timeDependent = true; d.high = false;
    d.begin = (e) => {
      const hz = part.props.frequency || part.props.hz || 1;
      const duty = (part.props.duty !== undefined ? part.props.duty : 50) / 100;
      d.high = ((e.time * hz) % 1) < duty;
      e.maxHz = Math.max(e.maxHz, hz);
    };
    return d;
  },
});
function dipSwitchDef(nBits) {
  register({
    type: 'dip' + nBits, name: `DIP Switch ×${nBits}`, cat: 'Inputs', desc: `${nBits} independent switches, each drives its own output HIGH or LOW.`,
    aliases: nBits === 8 ? ['wokwi-dip-switch-8'] : undefined,
    defaults: { bits: Array(nBits).fill(false) },
    pins: () => Array.from({ length: nBits }, (_, i) => ({ x: i, y: 0, name: 'S' + (i + 1) })),
    bounds: () => [-0.55, -3.3, nBits - 0.45, 0.3],
    draw(g, part, env) {
      for (let i = 0; i < nBits; i++) lead(g, i, -0.8, i, 0);
      shadow(g, 6, 2, 0.25);
      rr(g, -0.5 * U, -3.2 * U, nBits * U, 2.45 * U, 4);
      g.fillStyle = lin(g, 0, -3.2 * U, 0, -0.75 * U, [[0, '#e5484d'], [1, '#c53036']]); g.fill();
      noShadow(g);
      for (let i = 0; i < nBits; i++) {
        const on = part.props.bits[i];
        rr(g, i * U - 5, -2.75 * U, 10, 1.4 * U, 2);
        g.fillStyle = '#7d1d22'; g.fill();
        rr(g, i * U - 4, (on ? -2.7 : -2.05) * U, 8, 0.66 * U, 1.5);
        g.fillStyle = '#fbfbfd'; g.fill();
        text(g, env, String(i + 1), i * U, -1.05 * U, { size: 6.5, color: '#ffe0e1', weight: 700 });
      }
      text(g, env, 'ON', -0.2 * U, -3.0 * U, { size: 5, color: '#ffe0e1', weight: 700, align: 'left' });
    },
    control: (part, l) => {
      const i = Math.round(l.x);
      return i >= 0 && i < nBits && l.y < -0.7 ? 'bit' + i : null;
    },
    click(part, ctrl) { const i = +ctrl.slice(3); part.props.bits[i] = !part.props.bits[i]; return true; },
    device: (part, nets) => {
      const list = nets.map((n, i) => dev.logicSource(n, () => part.props.bits[i]));
      return { stamp(S, V, e) { for (const d of list) d.stamp(S, V, e); } };
    },
  });
}
dipSwitchDef(4);
dipSwitchDef(8);

register({
  type: 'slide', name: 'Slide Switch', cat: 'Inputs', desc: 'Passive on/off contact between its two pins (SPST).',
  aliases: ['wokwi-slide-switch'],
  defaults: { on: false },
  pins: () => [{ x: 0, y: 0, name: 'A' }, { x: 2, y: 0, name: 'B' }],
  bounds: () => [-0.6, -2.1, 2.6, 0.3],
  draw(g, part, env) {
    lead(g, 0, -0.6, 0, 0); lead(g, 2, -0.6, 2, 0);
    shadow(g, 5, 2, 0.25);
    rr(g, -0.55 * U, -2 * U, 3.1 * U, 1.45 * U, 3);
    g.fillStyle = lin(g, 0, -2 * U, 0, -0.55 * U, [[0, '#5b5f66'], [1, '#3a3d42']]); g.fill();
    noShadow(g);
    rr(g, 0, -1.6 * U, 2 * U, 0.65 * U, 3); g.fillStyle = '#26282c'; g.fill();
    const on = part.props.on;
    rr(g, (on ? 1.05 : 0.05) * U, -1.68 * U, 0.9 * U, 0.8 * U, 3);
    g.fillStyle = on ? '#30d158' : '#e5e5ea'; g.fill();
  },
  control: () => 'toggle',
  click(part) { part.props.on = !part.props.on; return true; },
  links: (part) => (part.props.on ? [[0, 1]] : []),
});
register({
  type: 'tactile', name: 'Tactile Button', cat: 'Inputs', desc: '4-pin 6 mm push button. Straddle the centre gap; pressing connects left and right.',
  aliases: ['wokwi-pushbutton'],
  defaults: { bounce: false },
  fields: [{ key: 'bounce', label: 'Bounce', kind: 'select', options: [[false, 'Off (ideal)'], [true, 'On (realistic)']] }],
  pins: () => [{ x: 0, y: 0, name: '1.l' }, { x: 0, y: -3, name: '1.r' }, { x: 2, y: 0, name: '2.l' }, { x: 2, y: -3, name: '2.r' }],
  bounds: () => [-0.5, -3.3, 2.5, 0.3],
  draw(g, part, env) {
    for (const [x, y] of [[0, 0], [0, -3], [2, 0], [2, -3]]) lead(g, x, y * 0.7 + (y ? -0.2 : 0.2) * 0, x, y);
    shadow(g, 6, 2, 0.3);
    rr(g, -0.4 * U, -2.9 * U, 2.8 * U, 2.8 * U, 3);
    g.fillStyle = lin(g, 0, -2.9 * U, 0, -0.1 * U, [[0, '#3c3f45'], [1, '#232529']]); g.fill();
    noShadow(g);
    const on = !!part.ui.pressed;
    g.fillStyle = '#9aa0a8';
    for (const [x, y] of [[0, -0.4], [2, -0.4], [0, -2.6], [2, -2.6]]) { g.beginPath(); g.arc(x * U, y * U, 2, 0, TAU); g.fill(); }
    shadow(g, on ? 1 : 3, on ? 0 : 1.5, 0.4);
    g.fillStyle = on ? '#1c1c1e' : lin(g, 0, -2.4 * U, 0, -0.6 * U, [[0, '#4a4d54'], [1, '#17181b']]);
    g.beginPath(); g.arc(1 * U, -1.5 * U, on ? 0.82 * U : 0.88 * U, 0, TAU); g.fill();
    noShadow(g);
  },
  control: () => 'press',
  links: (part) => (part.ui.pressed ? [[0, 1], [2, 3], [0, 2]] : [[0, 1], [2, 3]]),
});

// ---------------------------------------------------------------- Outputs --
register({
  type: 'led', name: 'LED', cat: 'Outputs', desc: '5 mm LED. Long leg (anode, +) on the left. Needs a current-limiting resistor.',
  aliases: ['wokwi-led'],
  defaults: { color: 'red' },
  fields: [{ key: 'color', label: 'Color', kind: 'select', options: Object.entries(LED_COLORS).map(([k, v]) => [k, v.name]) }, PROTECT_FIELD],
  variants: Object.keys(LED_COLORS).map(c => ({ name: `${LED_COLORS[c].name} LED`, props: { color: c } })),
  pins: () => [{ x: 0, y: 0, name: 'Anode (+)' }, { x: 1, y: 0, name: 'Cathode (−)' }],
  bounds: () => [-0.45, -2.75, 1.45, 0.3],
  draw(g, part, env) {
    const c = LED_COLORS[part.props.color] || LED_COLORS.red;
    const d = env.dev;
    const blown = part.props.damaged || (d && d.blown[0]);
    const k = d && !blown ? ledLevel(d.avg[0]) : 0;
    legPolyline(g, [[0, 0], [0, -0.55], [0.2, -0.9]]);
    lead(g, 1, 0, 0.8, -0.9);
    const cx = 0.5 * U, cy = -1.75 * U, r = 0.62 * U;
    if (k > 0) { glow(g, cx, cy, 3.8 * U, c.rgb, k); glow(g, cx, cy, 1.6 * U, c.rgb, k); glow(g, cx, cy, 1.0 * U, c.rgb, k); }
    // flange + dome: dull tinted epoxy when off, the emitted colour with a hot centre when on
    const off = env.dev ? c.off : c.body;   // library thumbnails show the familiar colour
    const base = blown ? '#555' : k > 0 ? mixHex(c.off, c.lit, 0.35 + 0.65 * k) : off;
    rr(g, cx - r - 2.5, cy + r - 3, 2 * r + 5, 5, 1.5);
    g.fillStyle = blown ? '#4a4a4a' : base; g.fill();
    g.beginPath();
    g.moveTo(cx - r, cy + r - 1); g.lineTo(cx - r, cy); g.arc(cx, cy, r, Math.PI, 0); g.lineTo(cx + r, cy + r - 1); g.closePath();
    g.fillStyle = lin(g, cx - r, 0, cx + r, 0, [[0, shade(blown ? '#555555' : c.body, -0.4)], [0.4, base], [1, shade(blown ? '#555555' : c.body, -0.45)]]);
    if (k > 0) g.fillStyle = base;
    g.fill();
    if (k > 0) {
      const core = g.createRadialGradient(cx, cy - r * 0.1, 0, cx, cy, r * 1.05);
      core.addColorStop(0, `rgba(255,255,255,${0.9 * k})`);
      core.addColorStop(0.45, `rgba(${c.rgb},${0.6 * k})`);
      core.addColorStop(1, `rgba(${c.rgb},0)`);
      g.fillStyle = core; g.fill();
    }
    g.fillStyle = `rgba(255,255,255,${0.3 + 0.35 * k})`;
    g.beginPath(); g.ellipse(cx - r * 0.38, cy - r * 0.15, r * 0.2, r * 0.48, 0, 0, TAU); g.fill();
    if (blown) {
      g.strokeStyle = '#ff453a'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(cx - 5, cy - 5); g.lineTo(cx + 5, cy + 5); g.moveTo(cx + 5, cy - 5); g.lineTo(cx - 5, cy + 5); g.stroke();
    }
  },
  device: (part, nets) => {
    const c = LED_COLORS[part.props.color] || LED_COLORS.red;
    return dev.diodes([[nets[0], nets[1], c.vf, c.rs]], { maxA: LED_MAX_A, led: true, part, protect: ledProtected(part), protectR: TRAINER_R, name: 'LED' });
  },
});

const SEG_PIN = { a: 6, b: 5, c: 3, d: 1, e: 0, f: 8, g: 9, dp: 4 };
register({
  type: 'seg7', name: '7-Segment Display', cat: 'Outputs', desc: '0.56" single digit. Pins: bottom e d COM c DP, top g f COM a b. Straddle rows c and h.',
  defaults: { common: 'cathode', color: 'red' },
  fields: [
    { key: 'common', label: 'Type', kind: 'select', options: [['cathode', 'Common cathode'], ['anode', 'Common anode']] },
    { key: 'color', label: 'Color', kind: 'select', options: Object.entries(LED_COLORS).map(([k, v]) => [k, v.name]) },
    PROTECT_FIELD,
  ],
  pins: () => [
    { x: 0, y: 0, name: 'e' }, { x: 1, y: 0, name: 'd' }, { x: 2, y: 0, name: 'COM' }, { x: 3, y: 0, name: 'c' }, { x: 4, y: 0, name: 'DP' },
    { x: 4, y: -7, name: 'b' }, { x: 3, y: -7, name: 'a' }, { x: 2, y: -7, name: 'COM' }, { x: 1, y: -7, name: 'f' }, { x: 0, y: -7, name: 'g' },
  ],
  links: () => [[2, 7]],
  bounds: () => [-0.65, -7.3, 4.65, 0.3],
  draw(g, part, env) {
    const c = LED_COLORS[part.props.color] || LED_COLORS.red;
    for (let i = 0; i < 5; i++) { lead(g, i, -0.5, i, 0); lead(g, i, -6.5, i, -7); }
    shadow(g, 8, 3, 0.3);
    rr(g, -0.62 * U, -6.6 * U, 5.24 * U, 6.2 * U, 4);
    g.fillStyle = '#1b1c1f'; g.fill(); noShadow(g);
    const d = env.dev;
    // Classic hexagonal segments on a slightly slanted grid, meeting cleanly at the corners.
    const L = 0.75 * U, R = 3.15 * U, T = -5.75 * U, B = -1.25 * U, M = (T + B) / 2;
    const h = 0.2 * U, gap = 0.05 * U, slant = 0.1;
    const sk = (x, y) => [x + slant * (M - y), y];   // italic lean
    const poly = (pts) => { g.beginPath(); pts.forEach(([x, y], i) => { const [px, py] = sk(x, y); if (i) g.lineTo(px, py); else g.moveTo(px, py); }); g.closePath(); };
    const hseg = (y) => poly([[L + gap, y], [L + gap + h, y - h], [R - gap - h, y - h], [R - gap, y], [R - gap - h, y + h], [L + gap + h, y + h]]);
    const vseg = (x, y0, y1) => poly([[x, y0 + gap], [x + h, y0 + gap + h], [x + h, y1 - gap - h], [x, y1 - gap], [x - h, y1 - gap - h], [x - h, y0 + gap + h]]);
    const shapes = { a: () => hseg(T), b: () => vseg(R, T, M), c: () => vseg(R, M, B), d: () => hseg(B), e: () => vseg(L, M, B), f: () => vseg(L, T, M), g: () => hseg(M) };
    ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp'].forEach((s, k) => {
      const lit = d ? ledLevel(d.avg[k]) : 0;
      if (s === 'dp') { const [px, py] = sk(R + 0.5 * U, B); g.beginPath(); g.arc(px, py, 0.2 * U, 0, TAU); }
      else shapes[s]();
      if (lit > 0) {
        g.shadowColor = `rgba(${c.rgb},1)`; g.shadowBlur = 14 * lit;
        g.fillStyle = mixHex(c.off, c.lit, 0.4 + 0.6 * lit); g.fill();
        noShadow(g);
        g.fillStyle = `rgba(255,255,255,${0.35 * lit})`; g.fill();   // hot core
        g.fillStyle = mixHex(c.off, c.lit, 0.4 + 0.6 * lit); g.globalAlpha = 0.55; g.fill(); g.globalAlpha = 1;
      } else { g.fillStyle = 'rgba(255,255,255,0.07)'; g.fill(); }
    });
  },
  device: (part, nets) => {
    const c = LED_COLORS[part.props.color] || LED_COLORS.red;
    const com = nets[2];
    const pairs = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'dp'].map(s => {
      const n = nets[SEG_PIN[s]];
      return part.props.common === 'anode' ? [com, n, c.vf, c.rs * 2] : [n, com, c.vf, c.rs * 2];
    });
    const d = dev.diodes(pairs, { maxA: LED_MAX_A, protect: ledProtected(part), protectR: TRAINER_R, name: 'Segment' });
    // Catch the classic mix-up: a 7447 needs a common-anode display, a 7448 a common-cathode one.
    const base = d.commit;
    d.commit = function (V, dt, e) {
      base.call(this, V, dt, e);
      const vc = com >= 0 ? V[com] : NaN;
      if (Number.isNaN(vc)) return;
      const anode = part.props.common === 'anode';
      const hint = !anode && vc > 3 ? 'COM is wired to +5 V, which is how a common-ANODE display is used (e.g. with a 7447). Set Type to “Common anode” in the inspector.'
        : anode && vc < 0.8 ? 'COM is wired to ground, which is how a common-CATHODE display is used (e.g. with a 7448). Set Type to “Common cathode” in the inspector.' : null;
      if (hint) this.notes = [...(this.notes || []), hint];
    };
    return d;
  },
});
register({
  type: 'bargraph', name: 'LED Bar Graph', cat: 'Outputs', desc: '8 LEDs. Anodes on the top row, cathodes on the bottom row. Straddle the centre gap.',
  defaults: { color: 'green' },
  fields: [{ key: 'color', label: 'Color', kind: 'select', options: Object.entries(LED_COLORS).map(([k, v]) => [k, v.name]) }, PROTECT_FIELD],
  pins: () => [
    ...Array.from({ length: 8 }, (_, i) => ({ x: i, y: -3, name: `A${i + 1}` })),
    ...Array.from({ length: 8 }, (_, i) => ({ x: i, y: 0, name: `K${i + 1}` })),
  ],
  bounds: () => [-0.6, -3.3, 7.6, 0.3],
  draw(g, part, env) {
    const c = LED_COLORS[part.props.color] || LED_COLORS.green;
    for (let i = 0; i < 8; i++) { lead(g, i, -0.4, i, 0); lead(g, i, -2.6, i, -3); }
    shadow(g, 6, 2, 0.3);
    rr(g, -0.55 * U, -2.65 * U, 8.1 * U, 2.3 * U, 3);
    g.fillStyle = '#1b1c1f'; g.fill(); noShadow(g);
    const d = env.dev;
    for (let i = 0; i < 8; i++) {
      const lit = d ? ledLevel(d.avg[i]) : 0;
      if (lit > 0) { g.shadowColor = `rgba(${c.rgb},1)`; g.shadowBlur = 14 * lit; }
      rr(g, i * U - 6, -2.25 * U, 12, 1.5 * U, 2);
      g.fillStyle = lit > 0 ? mixHex(c.off, c.lit, 0.4 + 0.6 * lit) : 'rgba(255,255,255,0.08)'; g.fill();
      noShadow(g);
      if (lit > 0) { g.fillStyle = `rgba(255,255,255,${0.3 * lit})`; g.fill(); }
    }
  },
  device: (part, nets) => {
    const c = LED_COLORS[part.props.color] || LED_COLORS.green;
    return dev.diodes(Array.from({ length: 8 }, (_, i) => [nets[i], nets[8 + i], c.vf, c.rs]), { maxA: LED_MAX_A, protect: ledProtected(part), protectR: TRAINER_R, name: 'Bar LED' });
  },
});
register({
  type: 'buzzer', name: 'Buzzer', cat: 'Outputs', desc: 'Active piezo buzzer. Sounds when + is about 3 V above −.',
  aliases: ['wokwi-buzzer'],
  pins: () => [{ x: 0, y: 0, name: '+' }, { x: 3, y: 0, name: '−' }],
  bounds: () => [-0.2, -3.6, 3.2, 0.3],
  draw(g, part, env) {
    lead(g, 0, -0.9, 0, 0); lead(g, 3, -0.9, 3, 0);
    const on = env.dev && env.dev.cur[0] > 0.004;
    const cx = 1.5 * U, cy = -2 * U;
    shadow(g, 8, 3, 0.3);
    g.fillStyle = lin(g, 0, cy - 1.6 * U, 0, cy + 1.6 * U, [[0, '#3a3c41'], [1, '#141518']]);
    g.beginPath(); g.arc(cx, cy, 1.55 * U, 0, TAU); g.fill(); noShadow(g);
    g.fillStyle = '#0b0b0c'; g.beginPath(); g.arc(cx, cy, 0.3 * U, 0, TAU); g.fill();
    if (on) {
      g.strokeStyle = 'rgba(10,132,255,0.8)'; g.lineWidth = 1.5;
      const t = (performance.now() / 120) % 1;
      for (let k = 0; k < 2; k++) { g.globalAlpha = 1 - ((t + k * 0.5) % 1); g.beginPath(); g.arc(cx, cy, (0.4 + ((t + k * 0.5) % 1)) * 1.4 * U, 0, TAU); g.stroke(); }
      g.globalAlpha = 1;
    }
    text(g, env, '+', 0.2 * U, -2.9 * U, { size: 9, color: '#f2f2f7', weight: 700 });
  },
  device: (part, nets) => {
    const d = dev.diodes([[nets[0], nets[1], 1.2, 150]]);
    d.audible = true;
    return d;
  },
});

register({
  type: 'lcd16x2', name: '16×2 LCD Display', cat: 'Outputs', desc: 'JHD16x2 / HD44780 16-character x 2-line alphanumeric LCD display. 16-pin single-row header.',
  defaults: { line1: 'CircuitForge', line2: '16x2 LCD Display' },
  fields: [
    { key: 'line1', label: 'Line 1 text', kind: 'text' },
    { key: 'line2', label: 'Line 2 text', kind: 'text' },
  ],
  pins: () => [
    { x: 0, y: 0, name: 'VSS' }, { x: 1, y: 0, name: 'VDD' }, { x: 2, y: 0, name: 'V0' },
    { x: 3, y: 0, name: 'RS' }, { x: 4, y: 0, name: 'RW' }, { x: 5, y: 0, name: 'E' },
    { x: 6, y: 0, name: 'D0' }, { x: 7, y: 0, name: 'D1' }, { x: 8, y: 0, name: 'D2' }, { x: 9, y: 0, name: 'D3' },
    { x: 10, y: 0, name: 'D4' }, { x: 11, y: 0, name: 'D5' }, { x: 12, y: 0, name: 'D6' }, { x: 13, y: 0, name: 'D7' },
    { x: 14, y: 0, name: 'A' }, { x: 15, y: 0, name: 'K' },
  ],
  bounds: () => [-0.8, -7.5, 15.8, 0.4],
  draw(g, part, env) {
    for (let i = 0; i < 16; i++) lead(g, i, -0.7, i, 0);
    shadow(g, 10, 4, 0.35);
    rr(g, -0.6 * U, -7.2 * U, 16.2 * U, 6.4 * U, 4);
    g.fillStyle = lin(g, 0, -7.2 * U, 0, -0.8 * U, [[0, '#12542a'], [1, '#0c381c']]);
    g.fill();
    noShadow(g);
    g.fillStyle = '#b8bec7';
    for (const [hx, hy] of [[-0.2, -7.0], [15.2, -7.0], [-0.2, -1.0], [15.2, -1.0]]) {
      g.beginPath(); g.arc(hx * U, hy * U, 2.5, 0, TAU); g.fill();
    }
    rr(g, 0.2 * U, -6.6 * U, 14.6 * U, 4.8 * U, 3);
    g.fillStyle = lin(g, 0, -6.6 * U, 0, -1.8 * U, [[0, '#3a3f47'], [1, '#202328']]);
    g.fill();
    const lit = env.dev ? env.dev.backlight : true;
    rr(g, 0.8 * U, -6.2 * U, 13.4 * U, 4.0 * U, 2);
    g.fillStyle = lit ? '#8ec03f' : '#334422';
    g.fill();
    if (lit) glow(g, 7.5 * U, -4.2 * U, 7 * U, '142,192,63', 0.35);
    const l1 = (env.dev && (env.dev.lines[0] || env.dev.lines[1])) ? env.dev.lines[0] : (part.props.line1 || 'CircuitForge');
    const l2 = (env.dev && (env.dev.lines[0] || env.dev.lines[1])) ? env.dev.lines[1] : (part.props.line2 || '16x2 Character');
    text(g, env, (l1 || '').padEnd(16, ' ').slice(0, 16), 7.5 * U, -5.2 * U, { size: 10, color: lit ? '#152408' : '#223010', weight: 700, font: MONO });
    text(g, env, (l2 || '').padEnd(16, ' ').slice(0, 16), 7.5 * U, -3.2 * U, { size: 10, color: lit ? '#152408' : '#223010', weight: 700, font: MONO });
    g.fillStyle = '#ffffff';
    g.beginPath(); g.arc(0, -0.9 * U, 1.8, 0, TAU); g.fill();
  },
  device: (part, nets) => dev.lcd16x2(nets, part),
});

// ---------------------------------------------------------------- Passives -
const BAND = ['#1a1a1a', '#8b4513', '#e5484d', '#ff8a00', '#f5d90a', '#30a46c', '#0a84ff', '#8e4ec6', '#8e8e93', '#ffffff'];
function bands(ohms) {
  let e = 0, v = Math.round(ohms);
  if (v < 10) return [0, v, BAND.length, 1]; // gold multiplier ≈ ×0.1, not exact
  while (v >= 100) { v = Math.round(v / 10); e++; }
  return [Math.floor(v / 10), v % 10, e];
}
export function fmtOhms(o) {
  if (o >= 1e6) return +(o / 1e6).toFixed(2) + ' MΩ';
  if (o >= 1e3) return +(o / 1e3).toFixed(2) + ' kΩ';
  return +o.toFixed(1) + ' Ω';
}
export function fmtFarads(uf) {
  if (uf >= 1) return +uf.toFixed(1) + ' µF';
  if (uf >= 1e-3) return +(uf * 1e3).toFixed(1) + ' nF';
  return +(uf * 1e6).toFixed(0) + ' pF';
}
const R_VALUES = [100, 220, 330, 470, 1000, 2200, 4700, 10000, 47000, 100000, 1000000];
register({
  type: 'resistor', name: 'Resistor', cat: 'Passives', desc: 'Carbon-film resistor, spans 4 holes.',
  aliases: ['wokwi-resistor'],
  defaults: { ohms: 220, watts: 0.25 },
  fields: [{ key: 'ohms', label: 'Resistance', kind: 'select', options: R_VALUES.map(v => [v, fmtOhms(v)]), custom: { unit: 'Ω', min: 1, max: 1e7 } },
    { key: 'watts', label: 'Power rating', kind: 'select', options: [[0.125, '⅛ W'], [0.25, '¼ W'], [0.5, '½ W'], [1, '1 W'], [5, '5 W']] }],
  variants: [220, 1000, 10000].map(v => ({ name: `Resistor ${fmtOhms(v)}`, props: { ohms: v } })),
  pins: () => [{ x: 0, y: 0, name: '1' }, { x: 4, y: 0, name: '2' }],
  bounds: () => [-0.2, -0.45, 4.2, 0.45],
  draw(g, part, env) {
    lead(g, 0, 0, 4, 0);
    const x0 = 0.95 * U, x1 = 3.05 * U, h = 0.62 * U;
    shadow(g, 4, 1.5, 0.25);
    g.beginPath();
    g.roundRect(x0, -h / 2, x1 - x0, h, h / 2);
    const burnt = part.props.damaged;
    g.fillStyle = burnt ? lin(g, 0, -h / 2, 0, h / 2, [[0, '#4a3b2c'], [0.5, '#2a211a'], [1, '#14100c']]) : lin(g, 0, -h / 2, 0, h / 2, [[0, '#f0dcb4'], [0.45, '#e3c793'], [1, '#c4a46c']]); g.fill();
    noShadow(g);
    if (burnt) { g.fillStyle = 'rgba(0,0,0,0.5)'; g.beginPath(); g.ellipse(2 * U, 0, 0.5 * U, h / 2, 0, 0, TAU); g.fill(); return; }
    const bs = bands(part.props.ohms);
    const xs = [1.3, 1.62, 1.94, 2.62];
    [...bs.slice(0, 3), 'gold'].forEach((bi, k) => {
      g.fillStyle = bi === 'gold' ? '#c9a227' : (BAND[bi] || '#c9a227');
      g.fillRect(xs[k] * U - 2, -h / 2 + 0.5, 4, h - 1);
    });
    g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(x0 + 4, -h / 2 + 2, x1 - x0 - 8, 2);
  },
  device: (part, nets) => dev.resistor(nets, part),
});
register({
  type: 'capacitor', name: 'Capacitor', cat: 'Passives', desc: 'Electrolytic capacitor. Longer leg (+) on the left; the stripe marks −.',
  defaults: { uf: 10, vmax: 16 },
  fields: [{ key: 'uf', label: 'Capacitance', kind: 'select', options: [0.1, 1, 10, 47, 100, 470, 1000].map(v => [v, fmtFarads(v)]), custom: { unit: 'µF', min: 0.001, max: 10000 } },
    { key: 'vmax', label: 'Voltage rating', kind: 'select', options: [[6.3, '6.3 V'], [10, '10 V'], [16, '16 V'], [25, '25 V'], [50, '50 V']] }],
  pins: () => [{ x: 0, y: 0, name: '+' }, { x: 1, y: 0, name: '−' }],
  bounds: () => [-0.4, -3.1, 1.4, 0.3],
  draw(g, part, env) {
    lead(g, 0, -0.7, 0, 0); lead(g, 1, -0.7, 1, 0);
    shadow(g, 6, 2, 0.28);
    rr(g, -0.35 * U, -3 * U, 1.7 * U, 2.35 * U, 5);
    g.fillStyle = lin(g, -0.35 * U, 0, 1.35 * U, 0, [[0, '#1b3a6b'], [0.45, '#2f5ea8'], [1, '#162f57']]); g.fill();
    noShadow(g);
    g.fillStyle = '#c9d4e6'; g.fillRect(0.95 * U, -3 * U + 3, 0.28 * U, 2.35 * U - 6);
    g.fillStyle = '#9aa7ba'; g.fillRect(-0.35 * U + 2, -3 * U + 1, 1.7 * U - 4, 3);
    text(g, env, fmtFarads(part.props.uf), 0.3 * U, -2.05 * U, { size: 6.5, color: '#e6edf7', weight: 700 });
    text(g, env, (part.props.vmax || 16) + 'V', 0.3 * U, -1.45 * U, { size: 5.5, color: '#b7c4d8', weight: 600 });
    const cd = env.dev;
    if (cd && !part.props.damaged) {
      // Live charge: the body fills with charge (blue charging, amber discharging), chevrons show current direction.
      const full = Math.min(part.props.vmax || 16, 5);
      const level = Math.max(0, Math.min(1, Math.abs(cd.vc) / full));
      const flowing = Math.abs(cd.i) > 2e-5;
      const charging = cd.vc * cd.i > 0;
      const top = -3 * U, h = 2.35 * U;
      g.save();
      rr(g, -0.35 * U, top, 1.7 * U, h, 5); g.clip();
      g.fillStyle = !flowing ? 'rgba(100,210,255,0.30)' : charging ? 'rgba(100,210,255,0.45)' : 'rgba(255,159,10,0.45)';
      g.fillRect(-0.35 * U, top + h * (1 - level), 1.7 * U, h * level);
      g.restore();
      if (flowing) {
        const speed = 1 + Math.min(3, Math.log10(1 + Math.abs(cd.i) * 1e4));
        const t = (performance.now() * speed / 900) % 1;
        g.strokeStyle = charging ? '#64d2ff' : '#ff9f0a'; g.lineWidth = 1.6; g.lineCap = 'round';
        for (let k = 0; k < 3; k++) {
          const p = (t + k / 3) % 1, y = charging ? top + h * (1 - p) : top + h * p, dir = charging ? -1 : 1;
          g.globalAlpha = Math.sin(p * Math.PI);
          g.beginPath(); g.moveTo(1.6 * U - 3, y - dir * 2); g.lineTo(1.6 * U, y + dir); g.lineTo(1.6 * U + 3, y - dir * 2); g.stroke();
        }
        g.globalAlpha = 1;
      }
      text(g, env, `${cd.vc.toFixed(2)} V`, 0.5 * U, -3.6 * U, { size: 7.5, color: flowing && !charging ? '#ff9f0a' : '#0a84ff', weight: 700, font: MONO });
    }
    if (part.props.damaged) {
      // vent split open, electrolyte residue
      g.fillStyle = '#3b2a1a';
      g.beginPath(); g.ellipse(0.5 * U, -3 * U, 0.95 * U, 0.42 * U, 0, 0, TAU); g.fill();
      g.strokeStyle = '#e8e2d0'; g.lineWidth = 1.6;
      g.beginPath(); g.moveTo(0.05 * U, -3.25 * U); g.lineTo(0.95 * U, -2.75 * U); g.moveTo(0.95 * U, -3.25 * U); g.lineTo(0.05 * U, -2.75 * U); g.stroke();
      g.fillStyle = 'rgba(40,30,20,0.55)'; g.fillRect(-0.35 * U, -2.9 * U, 1.7 * U, 0.9 * U);
    }
  },
  device: (part, nets) => dev.capacitor(nets, part),
});
register({
  type: 'diode', name: 'Diode', cat: 'Passives', desc: 'Current flows from anode (left) to the striped cathode (right).',
  defaults: { model: '1N4148' },
  fields: [{ key: 'model', label: 'Model', kind: 'select', options: [['1N4148', '1N4148 signal'], ['1N4001', '1N4001 rectifier (50 V)'], ['1N4007', '1N4007 rectifier (1000 V)']] }],
  variants: [
    { name: '1N4148 Diode', props: { model: '1N4148' } },
    { name: '1N4001 Diode', props: { model: '1N4001' } },
    { name: '1N4007 Diode', props: { model: '1N4007' } },
  ],
  pins: () => [{ x: 0, y: 0, name: 'Anode' }, { x: 4, y: 0, name: 'Cathode' }],
  bounds: () => [-0.2, -0.45, 4.2, 0.45],
  draw(g, part, env) {
    lead(g, 0, 0, 4, 0);
    const glass = part.props.model === '1N4148';
    const x0 = 1.2 * U, w = 1.6 * U, h = glass ? 0.5 * U : 0.62 * U;
    shadow(g, 4, 1.5, 0.25);
    rr(g, x0, -h / 2, w, h, glass ? h / 2 : 2);
    g.fillStyle = glass ? 'rgba(230,120,60,0.9)' : '#26282c'; g.fill();
    noShadow(g);
    g.fillStyle = glass ? '#1a1a1a' : '#d1d5db';
    g.fillRect(x0 + w - 7, -h / 2, 4, h);
    if (!glass) {
      text(g, env, part.props.model || '1N4007', x0 + w / 2 - 2, 0, { size: 5.5, color: '#c3c8cf', weight: 700, font: MONO });
    }
  },
  device: (part, nets) => dev.diodes([[nets[0], nets[1], part.props.model && part.props.model.startsWith('1N400') ? 0.7 : 0.62, part.props.model && part.props.model.startsWith('1N400') ? 0.05 : 0.6]]),
});

register({
  type: 'npn', name: 'NPN Transistor', cat: 'Passives', desc: 'General-purpose NPN BJT (2N3904) in TO-92 package. Pin 1: Emitter, Pin 2: Base, Pin 3: Collector.',
  defaults: { model: '2N3904', beta: 150 },
  fields: [
    { key: 'model', label: 'Model', kind: 'select', options: [['2N3904', '2N3904 (general-purpose NPN)'], ['2N2222', '2N2222 (high-current NPN)'], ['BC547', 'BC547 (low-noise NPN)']] },
    { key: 'beta', label: 'Current Gain (hFE)', kind: 'select', options: [[100, '100'], [150, '150 (typical 2N3904)'], [200, '200'], [300, '300']] },
  ],
  variants: [
    { name: '2N3904 NPN', props: { model: '2N3904', beta: 150 } },
    { name: '2N2222 NPN', props: { model: '2N2222', beta: 100 } },
  ],
  pins: () => [{ x: 0, y: 0, name: 'E (Emitter)' }, { x: 1, y: 0, name: 'B (Base)' }, { x: 2, y: 0, name: 'C (Collector)' }],
  bounds: () => [-0.4, -2.8, 2.4, 0.3],
  draw(g, part, env) {
    lead(g, 0, -0.65, 0, 0); lead(g, 1, -0.65, 1, 0); lead(g, 2, -0.65, 2, 0);
    shadow(g, 6, 2, 0.28);
    const cx = 1 * U, cy = -1.65 * U, rx = 1.25 * U;
    g.beginPath();
    g.arc(cx, cy, rx, Math.PI, 0, false);
    g.lineTo(cx + rx, cy + 0.3 * U);
    g.lineTo(cx - rx, cy + 0.3 * U);
    g.closePath();
    g.fillStyle = lin(g, cx - rx, 0, cx + rx, 0, [[0, '#33373e'], [0.4, '#1e2025'], [1, '#111215']]);
    g.fill();
    noShadow(g);
    g.fillStyle = '#25282e';
    g.fillRect(cx - rx + 2, cy + 0.05 * U, (rx - 1) * 2, 0.32 * U);
    text(g, env, part.props.model || '2N3904', cx, cy - 0.2 * U, { size: 6.5, color: '#e2e8f0', weight: 700, font: MONO });
    text(g, env, 'NPN', cx, cy + 0.24 * U, { size: 5, color: '#94a3b8', weight: 600, font: MONO });
    text(g, env, 'E', 0, -0.32 * U, { size: 5.5, color: '#8e96a3', weight: 700, font: MONO });
    text(g, env, 'B', 1 * U, -0.32 * U, { size: 5.5, color: '#8e96a3', weight: 700, font: MONO });
    text(g, env, 'C', 2 * U, -0.32 * U, { size: 5.5, color: '#8e96a3', weight: 700, font: MONO });
  },
  device: (part, nets) => dev.bjtNpn(nets, part),
});

register({
  type: 'jfet', name: 'N-JFET Transistor', cat: 'Passives', desc: 'N-channel depletion-mode JFET (2N5484) in TO-92 package. Pin 1: Drain, Pin 2: Source, Pin 3: Gate.',
  defaults: { model: '2N5484' },
  fields: [
    { key: 'model', label: 'Model', kind: 'select', options: [['2N5484', '2N5484 (RF / audio N-JFET)'], ['J201', 'J201 (general-purpose N-JFET)']] },
  ],
  variants: [
    { name: '2N5484 N-JFET', props: { model: '2N5484' } },
    { name: 'J201 N-JFET', props: { model: 'J201' } },
  ],
  pins: () => [{ x: 0, y: 0, name: 'D (Drain)' }, { x: 1, y: 0, name: 'S (Source)' }, { x: 2, y: 0, name: 'G (Gate)' }],
  bounds: () => [-0.4, -2.8, 2.4, 0.3],
  draw(g, part, env) {
    lead(g, 0, -0.65, 0, 0); lead(g, 1, -0.65, 1, 0); lead(g, 2, -0.65, 2, 0);
    shadow(g, 6, 2, 0.28);
    const cx = 1 * U, cy = -1.65 * U, rx = 1.25 * U;
    g.beginPath();
    g.arc(cx, cy, rx, Math.PI, 0, false);
    g.lineTo(cx + rx, cy + 0.3 * U);
    g.lineTo(cx - rx, cy + 0.3 * U);
    g.closePath();
    g.fillStyle = lin(g, cx - rx, 0, cx + rx, 0, [[0, '#33373e'], [0.4, '#1e2025'], [1, '#111215']]);
    g.fill();
    noShadow(g);
    g.fillStyle = '#25282e';
    g.fillRect(cx - rx + 2, cy + 0.05 * U, (rx - 1) * 2, 0.32 * U);
    text(g, env, part.props.model || '2N5484', cx, cy - 0.2 * U, { size: 6.5, color: '#e2e8f0', weight: 700, font: MONO });
    text(g, env, 'JFET', cx, cy + 0.24 * U, { size: 5, color: '#94a3b8', weight: 600, font: MONO });
    text(g, env, 'D', 0, -0.32 * U, { size: 5.5, color: '#8e96a3', weight: 700, font: MONO });
    text(g, env, 'S', 1 * U, -0.32 * U, { size: 5.5, color: '#8e96a3', weight: 700, font: MONO });
    text(g, env, 'G', 2 * U, -0.32 * U, { size: 5.5, color: '#8e96a3', weight: 700, font: MONO });
  },
  device: (part, nets) => dev.jfetN(nets, part),
});
register({
  type: 'inductor', name: 'Inductor', cat: 'Passives', desc: 'Axial inductor. Behaves as a wire in DC.',
  defaults: { mh: 10 },
  fields: [{ key: 'mh', label: 'Inductance', kind: 'select', options: [[0.1, '100 µH'], [1, '1 mH'], [10, '10 mH'], [100, '100 mH']] }],
  pins: () => [{ x: 0, y: 0, name: '1' }, { x: 4, y: 0, name: '2' }],
  bounds: () => [-0.2, -0.5, 4.2, 0.5],
  draw(g) {
    lead(g, 0, 0, 4, 0);
    const h = 0.72 * U;
    shadow(g, 4, 1.5, 0.25);
    rr(g, 1 * U, -h / 2, 2 * U, h, h / 2.2);
    g.fillStyle = lin(g, 0, -h / 2, 0, h / 2, [[0, '#56b37a'], [1, '#2d7a4c']]); g.fill();
    noShadow(g);
    g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 1;
    for (let k = 0; k < 7; k++) { const x = (1.2 + k * 0.27) * U; g.beginPath(); g.moveTo(x, -h / 2 + 1); g.lineTo(x + 3, h / 2 - 1); g.stroke(); }
  },
  links: () => [[0, 1]],
});

register({
  type: 'pot', name: 'Potentiometer', cat: 'Inputs', desc: 'Variable resistor. Outer pins to + and −, the middle pin (wiper) gives 0 – 5 V. Drag or scroll the knob.',
  aliases: ['wokwi-potentiometer'],
  defaults: { ohms: 10000, pos: 0.5 },
  fields: [{ key: 'ohms', label: 'Resistance', kind: 'select', options: [[1000, '1 kΩ'], [10000, '10 kΩ'], [100000, '100 kΩ']] }],
  pins: () => [{ x: 0, y: 0, name: '1' }, { x: 1, y: 0, name: 'Wiper' }, { x: 2, y: 0, name: '3' }],
  bounds: () => [-0.6, -3.5, 2.6, 0.3],
  draw(g, part, env) {
    for (let i = 0; i < 3; i++) lead(g, i, -0.8, i, 0);
    shadow(g, 6, 2, 0.25);
    rr(g, -0.55 * U, -1.3 * U, 3.1 * U, 0.6 * U, 2); g.fillStyle = '#2f5ea8'; g.fill();
    const cx = U, cy = -2.2 * U, r = 1.05 * U;
    g.fillStyle = lin(g, 0, cy - r, 0, cy + r, [[0, '#4a4d54'], [1, '#1f2024']]);
    g.beginPath(); g.arc(cx, cy, r, 0, TAU); g.fill(); noShadow(g);
    const a = Math.PI * (0.75 + 1.5 * part.props.pos);
    g.strokeStyle = '#f5f5f7'; g.lineWidth = 2.2; g.lineCap = 'round';
    g.beginPath(); g.moveTo(cx + Math.cos(a) * r * 0.25, cy + Math.sin(a) * r * 0.25); g.lineTo(cx + Math.cos(a) * r * 0.8, cy + Math.sin(a) * r * 0.8); g.stroke();
    g.strokeStyle = 'rgba(10,132,255,0.9)'; g.lineWidth = 2;
    g.beginPath(); g.arc(cx, cy, r + 3, Math.PI * 0.75, a); g.stroke();
    text(g, env, Math.round(part.props.pos * 100) + '%', cx, -0.98 * U, { size: 6.5, color: '#fff', weight: 700 });
  },
  control: (part, l) => (Math.hypot(l.x - 1, l.y + 2.2) < 1.25 ? 'knob' : null),
  device: (part, nets) => ({
    stamp(S) {
      const R = part.props.ohms, k = part.props.pos;
      S.G(nets[0], nets[1], 1 / Math.max(1, R * k));
      S.G(nets[1], nets[2], 1 / Math.max(1, R * (1 - k)));
    },
  }),
});

// ---------------------------------------------------------------- Tier 1 Simple Parts --
register({
  type: 'wokwi-rgb-led', name: 'RGB LED', cat: 'Outputs', desc: '4-pin 5 mm full-color RGB LED. Pins: R, COM, G, B.',
  aliases: ['rgb-led'],
  defaults: { common: 'cathode' },
  fields: [
    { key: 'common', label: 'Common Pin', kind: 'select', options: [['cathode', 'Common cathode (−)'], ['anode', 'Common anode (+)']] },
    PROTECT_FIELD,
  ],
  pins: () => [{ x: 0, y: 0, name: 'R' }, { x: 1, y: 0, name: 'COM' }, { x: 2, y: 0, name: 'G' }, { x: 3, y: 0, name: 'B' }],
  bounds: () => [-0.4, -2.8, 3.4, 0.3],
  draw(g, part, env) {
    for (let i = 0; i < 4; i++) {
      legPolyline(g, [[i, 0], [i, -0.55], [0.8 + i * 0.45, -0.9]]);
    }
    const cx = 1.5 * U, cy = -1.75 * U, r = 0.95 * U;
    const d = env.dev;
    const kr = d ? ledLevel(d.avg[0]) : 0;
    const kg = d ? ledLevel(d.avg[1]) : 0;
    const kb = d ? ledLevel(d.avg[2]) : 0;
    const total = kr + kg + kb;
    const redCh = Math.min(255, Math.round(kr * 255));
    const greenCh = Math.min(255, Math.round(kg * 255));
    const blueCh = Math.min(255, Math.round(kb * 255));
    const rgbStr = `${redCh},${greenCh},${blueCh}`;

    if (total > 0.02) {
      glow(g, cx, cy, 3.8 * U, rgbStr, Math.min(1, total * 0.7));
      glow(g, cx, cy, 1.8 * U, rgbStr, Math.min(1, total));
    }
    const baseColor = total > 0.02 ? `rgb(${Math.max(60, redCh)},${Math.max(60, greenCh)},${Math.max(60, blueCh)})` : '#d9dde3';
    rr(g, cx - r - 2, cy + r - 3, 2 * r + 4, 4, 1.5);
    g.fillStyle = baseColor; g.fill();
    g.beginPath();
    g.moveTo(cx - r, cy + r - 1); g.lineTo(cx - r, cy); g.arc(cx, cy, r, Math.PI, 0); g.lineTo(cx + r, cy + r - 1); g.closePath();
    g.fillStyle = baseColor; g.fill();

    if (total > 0.05) {
      const core = g.createRadialGradient(cx, cy - r * 0.1, 0, cx, cy, r * 1.05);
      core.addColorStop(0, `rgba(255,255,255,${Math.min(1, total * 0.5)})`);
      core.addColorStop(0.5, `rgba(${rgbStr},0.7)`);
      core.addColorStop(1, `rgba(${rgbStr},0)`);
      g.fillStyle = core; g.fill();
    }
    g.fillStyle = 'rgba(255,255,255,0.4)';
    g.beginPath(); g.ellipse(cx - r * 0.35, cy - r * 0.2, r * 0.2, r * 0.45, 0, 0, TAU); g.fill();
    text(g, env, part.props.common === 'anode' ? 'CA' : 'CC', cx, -0.4 * U, { size: 6, color: '#8e96a3', weight: 700, font: MONO });
  },
  device: (part, nets) => {
    const isAnode = part.props.common === 'anode';
    const com = nets[1];
    const pairs = [
      isAnode ? [com, nets[0], 1.8, 12] : [nets[0], com, 1.8, 12],
      isAnode ? [com, nets[2], 2.1, 15] : [nets[2], com, 2.1, 15],
      isAnode ? [com, nets[3], 3.0, 18] : [nets[3], com, 3.0, 18],
    ];
    return dev.diodes(pairs, { maxA: LED_MAX_A, led: true, part, protect: ledProtected(part), protectR: TRAINER_R, name: 'RGB LED' });
  },
});

register({
  type: 'wokwi-slide-potentiometer', name: 'Slide Potentiometer', cat: 'Inputs', desc: 'Linear fader potentiometer. Pins: 1 (VCC), WIPER, 2 (GND).',
  aliases: ['slide-potentiometer'],
  defaults: { ohms: 10000, pos: 0.5 },
  fields: [{ key: 'ohms', label: 'Resistance', kind: 'select', options: [[1000, '1 kΩ'], [10000, '10 kΩ'], [100000, '100 kΩ']] }],
  pins: () => [{ x: 0, y: 0, name: '1' }, { x: 1, y: 0, name: 'WIPER' }, { x: 2, y: 0, name: '2' }],
  bounds: () => [-0.6, -5.2, 2.6, 0.3],
  draw(g, part, env) {
    for (let i = 0; i < 3; i++) lead(g, i, -0.8, i, 0);
    shadow(g, 6, 2, 0.25);
    rr(g, -0.55 * U, -5.0 * U, 3.1 * U, 4.2 * U, 4);
    g.fillStyle = lin(g, 0, -5.0 * U, 0, -0.8 * U, [[0, '#4a4d54'], [0.5, '#2e3035'], [1, '#1f2024']]);
    g.fill(); noShadow(g);
    rr(g, 0.85 * U, -4.6 * U, 0.3 * U, 3.4 * U, 2);
    g.fillStyle = '#121316'; g.fill();
    const pos = Math.max(0, Math.min(1, part.props.pos ?? 0.5));
    const ky = -1.2 * U - pos * 3.0 * U;
    shadow(g, 4, 1.5, 0.3);
    rr(g, 0.2 * U, ky - 0.35 * U, 1.6 * U, 0.7 * U, 2);
    g.fillStyle = lin(g, 0, ky - 0.35 * U, 0, ky + 0.35 * U, [[0, '#d1d5db'], [1, '#9ca3af']]);
    g.fill(); noShadow(g);
    g.fillStyle = '#0a84ff';
    g.fillRect(0.3 * U, ky - 1, 1.4 * U, 2);
    text(g, env, Math.round(pos * 100) + '%', U, -0.5 * U, { size: 6.5, color: '#f2f2f7', weight: 700 });
  },
  control: (part, l) => (l.y < -0.8 && l.y > -5.0 ? 'knob' : null),
  device: (part, nets) => ({
    stamp(S) {
      const R = part.props.ohms || 10000;
      const k = Math.max(1e-4, Math.min(1 - 1e-4, part.props.pos ?? 0.5));
      S.G(nets[0], nets[1], 1 / Math.max(1, R * k));
      S.G(nets[1], nets[2], 1 / Math.max(1, R * (1 - k)));
    },
  }),
});

register({
  type: 'wokwi-analog-joystick', name: 'Analog Joystick', cat: 'Inputs', desc: 'Dual-axis joystick with push button. Pins: VCC, GND, VRX, VRY, SW.',
  aliases: ['analog-joystick'],
  defaults: { x: 0.5, y: 0.5 },
  pins: () => [{ x: 0, y: 0, name: 'VCC' }, { x: 1, y: 0, name: 'GND' }, { x: 2, y: 0, name: 'VRX' }, { x: 3, y: 0, name: 'VRY' }, { x: 4, y: 0, name: 'SW' }],
  bounds: () => [-0.6, -4.8, 4.6, 0.3],
  draw(g, part, env) {
    for (let i = 0; i < 5; i++) lead(g, i, -0.8, i, 0);
    shadow(g, 8, 3, 0.28);
    rr(g, -0.5 * U, -4.6 * U, 5.0 * U, 3.8 * U, 4);
    g.fillStyle = lin(g, 0, -4.6 * U, 0, -0.8 * U, [[0, '#154a2a'], [1, '#0e311c']]);
    g.fill(); noShadow(g);
    const cx = 2 * U, cy = -2.7 * U, r = 1.4 * U;
    g.fillStyle = '#1c1d22';
    g.beginPath(); g.arc(cx, cy, r, 0, TAU); g.fill();
    const jx = (Math.max(0, Math.min(1, part.props.x ?? 0.5)) - 0.5) * 1.2 * U;
    const jy = (0.5 - Math.max(0, Math.min(1, part.props.y ?? 0.5))) * 1.2 * U;
    const on = !!part.ui.pressed;
    shadow(g, 5, 2, 0.35);
    g.fillStyle = on ? '#2c2d33' : lin(g, cx + jx, cy + jy - 0.9 * U, cx + jx, cy + jy + 0.9 * U, [[0, '#4f525d'], [1, '#2c2e35']]);
    g.beginPath(); g.arc(cx + jx, cy + jy, on ? 0.8 * U : 0.9 * U, 0, TAU); g.fill(); noShadow(g);
    g.fillStyle = '#1c1d22';
    g.beginPath(); g.arc(cx + jx, cy + jy, 0.45 * U, 0, TAU); g.fill();
    text(g, env, 'JOYSTICK', cx, -4.1 * U, { size: 6, color: '#a7f3d0', weight: 700 });
  },
  control: () => 'press',
  device: (part, nets) => ({
    stamp(S) {
      const R = 10000;
      const kx = Math.max(1e-4, Math.min(1 - 1e-4, part.props.x ?? 0.5));
      const ky = Math.max(1e-4, Math.min(1 - 1e-4, part.props.y ?? 0.5));
      S.G(nets[0], nets[2], 1 / Math.max(1, R * kx));
      S.G(nets[2], nets[1], 1 / Math.max(1, R * (1 - kx)));
      S.G(nets[0], nets[3], 1 / Math.max(1, R * ky));
      S.G(nets[3], nets[1], 1 / Math.max(1, R * (1 - ky)));
      if (part.ui && part.ui.pressed) {
        S.G(nets[4], nets[1], 1 / 0.1);
      } else {
        S.G(nets[4], nets[1], 1e-9);
      }
    },
  }),
});

register({
  type: 'wokwi-relay-module', name: 'Relay Module', cat: 'Outputs', desc: 'Single-channel SPDT relay module. Pins: IN, VCC, GND; contacts: NO, COM, NC.',
  aliases: ['relay-module'],
  defaults: { threshold: 2.5, activeLow: false },
  fields: [
    { key: 'threshold', label: 'Coil threshold (V)', kind: 'select', options: [[1.5, '1.5 V'], [2.5, '2.5 V (typical)'], [3.3, '3.3 V']] },
    { key: 'activeLow', label: 'Trigger', kind: 'select', options: [[false, 'Active HIGH'], [true, 'Active LOW']] },
  ],
  pins: () => [
    { x: 0, y: 0, name: 'IN' }, { x: 1, y: 0, name: 'VCC' }, { x: 2, y: 0, name: 'GND' },
    { x: 0, y: -4, name: 'NO' }, { x: 1, y: -4, name: 'COM' }, { x: 2, y: -4, name: 'NC' },
  ],
  bounds: () => [-0.6, -4.6, 2.6, 0.3],
  draw(g, part, env) {
    for (let i = 0; i < 3; i++) {
      lead(g, i, -0.7, i, 0);
      lead(g, i, -3.3, i, -4);
    }
    shadow(g, 8, 3, 0.3);
    rr(g, -0.5 * U, -3.8 * U, 3.0 * U, 3.1 * U, 3);
    g.fillStyle = lin(g, 0, -3.8 * U, 0, -0.7 * U, [[0, '#1a56db'], [1, '#1e40af']]);
    g.fill(); noShadow(g);
    const on = env.dev && env.dev.energized;
    g.fillStyle = on ? '#30d158' : '#374151';
    g.beginPath(); g.arc(0.4 * U, -1.2 * U, 2.5, 0, TAU); g.fill();
    if (on) glow(g, 0.4 * U, -1.2 * U, 8, '48,209,88', 1);
    text(g, env, 'RELAY 5V', 1 * U, -2.4 * U, { size: 7.5, color: '#ffffff', weight: 800, font: MONO });
    text(g, env, on ? 'ON (NO)' : 'OFF (NC)', 1 * U, -1.5 * U, { size: 6, color: on ? '#86efac' : '#cbd5e1', weight: 700, font: MONO });
    text(g, env, 'NO COM NC', 1 * U, -3.2 * U, { size: 5, color: '#e2e8f0', weight: 700, font: MONO });
    text(g, env, 'IN VCC GND', 1 * U, -0.85 * U, { size: 5, color: '#e2e8f0', weight: 700, font: MONO });
  },
  device: (part, nets) => {
    let energized = false;
    return {
      analog: true,
      energized: false,
      stamp(S) {
        S.G(nets[1], nets[2], 1 / 70);
        const rOn = 0.05, rOff = 1e9;
        if (energized) {
          S.G(nets[4], nets[3], 1 / rOn);
          S.G(nets[4], nets[5], 1 / rOff);
        } else {
          S.G(nets[4], nets[3], 1 / rOff);
          S.G(nets[4], nets[5], 1 / rOn);
        }
      },
      update(V) {
        const vin = nets[0] >= 0 && ok(V[nets[0]]) ? V[nets[0]] : 0;
        const vgnd = nets[2] >= 0 && ok(V[nets[2]]) ? V[nets[2]] : 0;
        const vdiff = vin - vgnd;
        const th = part.props.threshold || 2.5;
        const newState = part.props.activeLow ? (vdiff < th) : (vdiff >= th);
        const changed = newState !== energized;
        energized = newState;
        this.energized = energized;
        return changed;
      },
      commit() {
        this.energized = energized;
      },
    };
  },
});

register({
  type: 'wokwi-logic-analyzer', name: 'Logic Analyzer (8-channel)', cat: 'Inputs', desc: '8-channel digital logic analyzer with timeline recording and CSV export.',
  aliases: ['logic-analyzer'],
  defaults: { rate: 24000000 },
  pins: () => [
    { x: 0, y: 0, name: 'GND' },
    { x: 1, y: 0, name: 'D0' }, { x: 2, y: 0, name: 'D1' }, { x: 3, y: 0, name: 'D2' }, { x: 4, y: 0, name: 'D3' },
    { x: 5, y: 0, name: 'D4' }, { x: 6, y: 0, name: 'D5' }, { x: 7, y: 0, name: 'D6' }, { x: 8, y: 0, name: 'D7' },
  ],
  bounds: () => [-0.6, -3.2, 8.6, 0.3],
  draw(g, part, env) {
    for (let i = 0; i <= 8; i++) lead(g, i, -0.8, i, 0);
    shadow(g, 8, 3, 0.35);
    rr(g, -0.5 * U, -3.0 * U, 9.0 * U, 2.2 * U, 4);
    g.fillStyle = lin(g, 0, -3.0 * U, 0, -0.8 * U, [[0, '#2d3139'], [1, '#181a1f']]);
    g.fill(); noShadow(g);
    text(g, env, 'LOGIC ANALYZER · 8CH', 4 * U, -2.3 * U, { size: 6.5, color: '#f3f4f6', weight: 800, font: MONO });
    const devLvl = env.dev && env.dev.levels;
    for (let i = 0; i < 8; i++) {
      const hi = devLvl ? devLvl[i] : 0;
      g.fillStyle = hi ? '#06b6d4' : '#374151';
      g.beginPath(); g.arc((i + 1) * U, -1.3 * U, 2.2, 0, TAU); g.fill();
      if (hi) glow(g, (i + 1) * U, -1.3 * U, 6, '6,182,212', 0.8);
      text(g, env, `D${i}`, (i + 1) * U, -0.6 * U, { size: 5, color: hi ? '#67e8f9' : '#9ca3af', weight: 700, font: MONO });
    }
  },
  device: (part, nets) => {
    const history = [];
    return {
      timeDependent: true,
      history,
      levels: new Uint8Array(8),
      reset() { history.length = 0; this.levels.fill(0); },
      commit(V, dt, engine) {
        const vgnd = nets[0] >= 0 && ok(V[nets[0]]) ? V[nets[0]] : 0;
        let mask = 0;
        for (let i = 0; i < 8; i++) {
          const n = nets[i + 1];
          const v = n >= 0 && ok(V[n]) ? V[n] - vgnd : 0;
          const lvl = v >= 1.6 ? 1 : 0;
          this.levels[i] = lvl;
          if (lvl) mask |= (1 << i);
        }
        if (history.length === 0 || history[history.length - 1].mask !== mask || history.length > 20000) {
          history.push({ t: engine.time, mask, levels: Array.from(this.levels) });
          if (history.length > 20000) history.shift();
        }
      },
      exportCSV() {
        let csv = 'time_s,D0,D1,D2,D3,D4,D5,D6,D7\n';
        for (const entry of history) {
          csv += `${entry.t.toFixed(6)},${entry.levels.join(',')}\n`;
        }
        return csv;
      },
    };
  },
});

// ---------------------------------------------------------------- Tier 2 I2C Peripherals --
register({
  type: 'board-ssd1306', name: 'OLED Display (128x64 SSD1306)', cat: 'Outputs', desc: '0.96″ I2C monochrome OLED display with 128x64 resolution.',
  aliases: ['wokwi-ssd1306', 'ssd1306'],
  defaults: { i2cAddress: '0x3c' },
  fields: [
    { key: 'i2cAddress', label: 'I2C Address', kind: 'select', options: [['0x3c', '0x3C (default)'], ['0x3d', '0x3D (alternate)']] },
  ],
  pins: () => [{ x: 0, y: 0, name: 'GND' }, { x: 1, y: 0, name: 'VCC' }, { x: 2, y: 0, name: 'SCL' }, { x: 3, y: 0, name: 'SDA' }],
  bounds: () => [-0.6, -5.6, 3.6, 0.4],
  draw(g, part, env) {
    for (let i = 0; i < 4; i++) lead(g, i, -0.8, i, 0);
    shadow(g, 8, 3, 0.35);
    rr(g, -0.5 * U, -5.4 * U, 4.0 * U, 4.6 * U, 4);
    g.fillStyle = lin(g, 0, -5.4 * U, 0, -0.8 * U, [[0, '#1a2333'], [1, '#0e1420']]);
    g.fill(); noShadow(g);
    for (const [hx, hy] of [[-0.2, -5.1], [3.2, -5.1], [-0.2, -1.1], [3.2, -1.1]]) {
      g.fillStyle = '#d97706'; g.beginPath(); g.arc(hx * U, hy * U, 2.5, 0, TAU); g.fill();
      g.fillStyle = '#0f172a'; g.beginPath(); g.arc(hx * U, hy * U, 1.5, 0, TAU); g.fill();
    }
    const sx = -0.3 * U, sy = -4.9 * U, sw = 3.6 * U, sh = 3.6 * U;
    rr(g, sx, sy, sw, sh, 2);
    const d = env.dev;
    const on = d && d.powered && d.displayOn;
    g.fillStyle = on ? '#06080d' : '#11141a';
    g.fill();
    g.strokeStyle = '#272b35'; g.lineWidth = 1; g.stroke();
    if (on && d.buffer) {
      let hasPixels = false;
      for (let i = 0; i < d.buffer.length; i++) {
        if (d.buffer[i] !== 0) { hasPixels = true; break; }
      }
      if (hasPixels) {
        g.fillStyle = '#00f0ff';
        for (let page = 0; page < 8; page++) {
          for (let col = 0; col < 128; col += 2) {
            const byte = d.buffer[page * 128 + col];
            if (!byte) continue;
            for (let bit = 0; bit < 8; bit++) {
              if (byte & (1 << bit)) {
                const px = sx + (col / 128) * sw;
                const py = sy + ((page * 8 + bit) / 64) * sh;
                g.fillRect(px, py, 1.2, 1.2);
              }
            }
          }
        }
      } else {
        text(g, env, '128×64', 1.5 * U, -3.2 * U, { size: 6, color: '#38bdf8', weight: 600, font: MONO });
        text(g, env, 'OLED', 1.5 * U, -2.5 * U, { size: 7, color: '#0284c7', weight: 700, font: MONO });
      }
    }
    text(g, env, 'GND VCC SCL SDA', 1.5 * U, -0.6 * U, { size: 4.5, color: '#94a3b8', weight: 700, font: MONO });
  },
  device: (part, nets) => devI2C.oledDevice(part, nets, { width: 128, height: 64, type: 'ssd1306' }),
});

register({
  type: 'wokwi-sh1107', name: 'OLED Display (128x128 SH1107)', cat: 'Outputs', desc: '1.28″ square I2C monochrome OLED display with 128x128 resolution.',
  aliases: ['sh1107'],
  defaults: { i2cAddress: '0x3c' },
  fields: [
    { key: 'i2cAddress', label: 'I2C Address', kind: 'select', options: [['0x3c', '0x3C (default)'], ['0x3d', '0x3D (alternate)']] },
  ],
  pins: () => [{ x: 0, y: 0, name: 'GND' }, { x: 1, y: 0, name: 'VCC' }, { x: 2, y: 0, name: 'SCL' }, { x: 3, y: 0, name: 'SDA' }],
  bounds: () => [-0.6, -6.6, 3.6, 0.4],
  draw(g, part, env) {
    for (let i = 0; i < 4; i++) lead(g, i, -0.8, i, 0);
    shadow(g, 8, 3, 0.35);
    rr(g, -0.5 * U, -6.4 * U, 4.0 * U, 5.6 * U, 4);
    g.fillStyle = lin(g, 0, -6.4 * U, 0, -0.8 * U, [[0, '#1e1e24'], [1, '#111215']]);
    g.fill(); noShadow(g);
    const sx = -0.3 * U, sy = -5.9 * U, sw = 3.6 * U, sh = 4.8 * U;
    rr(g, sx, sy, sw, sh, 2);
    const d = env.dev;
    const on = d && d.powered && d.displayOn;
    g.fillStyle = on ? '#06080d' : '#11141a';
    g.fill();
    if (on) {
      text(g, env, '128×128', 1.5 * U, -3.8 * U, { size: 6, color: '#f8fafc', weight: 600, font: MONO });
      text(g, env, 'SH1107', 1.5 * U, -3.0 * U, { size: 7, color: '#a78bfa', weight: 700, font: MONO });
    }
    text(g, env, 'GND VCC SCL SDA', 1.5 * U, -0.6 * U, { size: 4.5, color: '#94a3b8', weight: 700, font: MONO });
  },
  device: (part, nets) => devI2C.oledDevice(part, nets, { width: 128, height: 128, sh1107: true, type: 'sh1107' }),
});

register({
  type: 'wokwi-lcd1602', name: 'LCD 16x2 (I2C)', cat: 'Outputs', desc: '16x2 character LCD display with PCF8574 I2C backpack.',
  aliases: ['lcd1602'],
  defaults: { i2cAddress: '0x27' },
  fields: [
    { key: 'i2cAddress', label: 'I2C Address', kind: 'select', options: [['0x27', '0x27 (default)'], ['0x3f', '0x3F (alternate)']] },
  ],
  pins: () => [{ x: 0, y: 0, name: 'GND' }, { x: 1, y: 0, name: 'VCC' }, { x: 2, y: 0, name: 'SDA' }, { x: 3, y: 0, name: 'SCL' }],
  bounds: () => [-0.6, -4.8, 8.6, 0.4],
  draw(g, part, env) {
    for (let i = 0; i < 4; i++) lead(g, i, -0.8, i, 0);
    shadow(g, 8, 3, 0.35);
    rr(g, -0.5 * U, -4.6 * U, 9.0 * U, 3.8 * U, 4);
    g.fillStyle = lin(g, 0, -4.6 * U, 0, -0.8 * U, [[0, '#1e3a8a'], [1, '#172554']]);
    g.fill(); noShadow(g);
    rr(g, 0.2 * U, -4.2 * U, 7.6 * U, 3.0 * U, 3);
    g.fillStyle = '#111827'; g.fill();
    const d = env.dev;
    const bl = d && d.powered && d.backlight;
    rr(g, 0.4 * U, -4.0 * U, 7.2 * U, 2.6 * U, 2);
    g.fillStyle = bl ? '#0284c7' : '#1e293b'; g.fill();
    if (bl) glow(g, 4.0 * U, -2.7 * U, 12, '2,132,199', 0.4);
    const line1 = (d && d.lines ? d.lines[0] : '') || '';
    const line2 = (d && d.lines ? d.lines[1] : '') || '';
    text(g, env, line1.padEnd(16, ' '), 4.0 * U, -3.3 * U, { size: 6.5, color: bl ? '#ffffff' : '#475569', weight: 700, font: MONO });
    text(g, env, line2.padEnd(16, ' '), 4.0 * U, -2.2 * U, { size: 6.5, color: bl ? '#ffffff' : '#475569', weight: 700, font: MONO });
    text(g, env, 'GND VCC SDA SCL', 1.5 * U, -0.6 * U, { size: 4.5, color: '#93c5fd', weight: 700, font: MONO });
    text(g, env, 'LCD1602 · I2C', 6.5 * U, -0.6 * U, { size: 5, color: '#60a5fa', weight: 700, font: MONO });
  },
  device: (part, nets) => devI2C.pcf8574LcdDevice(part, nets, { cols: 16, rows: 2, type: 'lcd1602' }),
});

register({
  type: 'wokwi-lcd2004', name: 'LCD 20x4 (I2C)', cat: 'Outputs', desc: '20x4 character LCD display with PCF8574 I2C backpack.',
  aliases: ['lcd2004'],
  defaults: { i2cAddress: '0x27' },
  fields: [
    { key: 'i2cAddress', label: 'I2C Address', kind: 'select', options: [['0x27', '0x27 (default)'], ['0x3f', '0x3F (alternate)']] },
  ],
  pins: () => [{ x: 0, y: 0, name: 'GND' }, { x: 1, y: 0, name: 'VCC' }, { x: 2, y: 0, name: 'SDA' }, { x: 3, y: 0, name: 'SCL' }],
  bounds: () => [-0.6, -6.8, 10.6, 0.4],
  draw(g, part, env) {
    for (let i = 0; i < 4; i++) lead(g, i, -0.8, i, 0);
    shadow(g, 8, 3, 0.35);
    rr(g, -0.5 * U, -6.6 * U, 11.0 * U, 5.8 * U, 4);
    g.fillStyle = lin(g, 0, -6.6 * U, 0, -0.8 * U, [[0, '#064e3b'], [1, '#022c22']]);
    g.fill(); noShadow(g);
    rr(g, 0.2 * U, -6.2 * U, 9.6 * U, 5.0 * U, 3);
    g.fillStyle = '#111827'; g.fill();
    const d = env.dev;
    const bl = d && d.powered && d.backlight;
    rr(g, 0.4 * U, -6.0 * U, 9.2 * U, 4.6 * U, 2);
    g.fillStyle = bl ? '#65a30d' : '#1e293b'; g.fill();
    if (bl) glow(g, 5.0 * U, -3.7 * U, 14, '101,163,13', 0.4);
    for (let r = 0; r < 4; r++) {
      const line = (d && d.lines ? d.lines[r] : '') || '';
      text(g, env, line.padEnd(20, ' '), 5.0 * U, (-5.3 + r * 1.1) * U, { size: 6.0, color: bl ? '#000000' : '#475569', weight: 700, font: MONO });
    }
    text(g, env, 'GND VCC SDA SCL', 1.5 * U, -0.6 * U, { size: 4.5, color: '#86efac', weight: 700, font: MONO });
    text(g, env, 'LCD2004 · I2C', 8.0 * U, -0.6 * U, { size: 5, color: '#a7f3d0', weight: 700, font: MONO });
  },
  device: (part, nets) => devI2C.pcf8574LcdDevice(part, nets, { cols: 20, rows: 4, type: 'lcd2004' }),
});

register({
  type: 'wokwi-mpu6050', name: 'MPU6050 Accelerometer & Gyro', cat: 'Inputs', desc: '6-axis motion tracking sensor with 3-axis gyroscope and 3-axis accelerometer.',
  aliases: ['mpu6050'],
  defaults: { i2cAddress: '0x68', accelX: 0.0, accelY: 0.0, accelZ: 1.0, gyroX: 0.0, gyroY: 0.0, gyroZ: 0.0, freefall: false, motion: false },
  fields: [
    { key: 'i2cAddress', label: 'I2C Address', kind: 'select', options: [['0x68', '0x68 (AD0 Low)'], ['0x69', '0x69 (AD0 High)']] },
    { key: 'accelX', label: 'Accel X (g)', kind: 'number' },
    { key: 'accelY', label: 'Accel Y (g)', kind: 'number' },
    { key: 'accelZ', label: 'Accel Z (g)', kind: 'number' },
    { key: 'freefall', label: 'Simulate Freefall', kind: 'boolean' },
    { key: 'motion', label: 'Simulate Motion', kind: 'boolean' },
  ],
  pins: () => [
    { x: 0, y: 0, name: 'VCC' }, { x: 1, y: 0, name: 'GND' }, { x: 2, y: 0, name: 'SCL' }, { x: 3, y: 0, name: 'SDA' },
    { x: 4, y: 0, name: 'XDA' }, { x: 5, y: 0, name: 'XCL' }, { x: 6, y: 0, name: 'AD0' }, { x: 7, y: 0, name: 'INT' },
  ],
  bounds: () => [-0.6, -3.2, 7.6, 0.3],
  draw(g, part, env) {
    for (let i = 0; i < 8; i++) lead(g, i, -0.8, i, 0);
    shadow(g, 8, 3, 0.3);
    rr(g, -0.5 * U, -3.0 * U, 8.0 * U, 2.2 * U, 3);
    g.fillStyle = lin(g, 0, -3.0 * U, 0, -0.8 * U, [[0, '#0284c7'], [1, '#0369a1']]);
    g.fill(); noShadow(g);
    rr(g, 3.2 * U, -2.4 * U, 1.6 * U, 1.2 * U, 1.5);
    g.fillStyle = '#18181b'; g.fill();
    text(g, env, 'MPU', 4.0 * U, -1.8 * U, { size: 5, color: '#a1a1aa', weight: 700, font: MONO });
    const pNames = ['VCC', 'GND', 'SCL', 'SDA', 'XDA', 'XCL', 'AD0', 'INT'];
    for (let i = 0; i < 8; i++) {
      text(g, env, pNames[i], i * U, -0.6 * U, { size: 4, color: '#f0f9ff', weight: 700, font: MONO });
    }
    text(g, env, 'GY-521 · 6-DOF', 4.0 * U, -2.6 * U, { size: 4.5, color: '#e0f2fe', weight: 700, font: MONO });
  },
  device: (part, nets) => devI2C.mpu6050Device(part, nets),
});

register({
  type: 'wokwi-ds1307', name: 'DS1307 Real-Time Clock', cat: 'Inputs', desc: 'I2C Real-Time Clock with 56-byte battery-backed NVRAM.',
  aliases: ['ds1307'],
  defaults: { mode: 'simulated' },
  fields: [
    { key: 'mode', label: 'Clock Mode', kind: 'select', options: [['simulated', 'Simulated Time'], ['wall', 'Host Wall Clock']] },
  ],
  pins: () => [
    { x: 0, y: 0, name: 'VCC' }, { x: 1, y: 0, name: 'GND' }, { x: 2, y: 0, name: 'SDA' }, { x: 3, y: 0, name: 'SCL' }, { x: 4, y: 0, name: 'SQW' },
  ],
  bounds: () => [-0.6, -3.8, 4.6, 0.3],
  draw(g, part, env) {
    for (let i = 0; i < 5; i++) lead(g, i, -0.8, i, 0);
    shadow(g, 8, 3, 0.3);
    rr(g, -0.5 * U, -3.6 * U, 5.0 * U, 2.8 * U, 3);
    g.fillStyle = lin(g, 0, -3.6 * U, 0, -0.8 * U, [[0, '#312e81'], [1, '#1e1b4b']]);
    g.fill(); noShadow(g);
    g.fillStyle = lin(g, 2.5 * U, -3.0 * U, 2.5 * U, -1.2 * U, [[0, '#d1d5db'], [1, '#9ca3af']]);
    g.beginPath(); g.arc(3.4 * U, -2.1 * U, 0.9 * U, 0, TAU); g.fill();
    text(g, env, 'CR2032', 3.4 * U, -2.0 * U, { size: 4, color: '#374151', weight: 700, font: MONO });
    rr(g, 0.2 * U, -2.8 * U, 1.4 * U, 1.4 * U, 1.5);
    g.fillStyle = '#18181b'; g.fill();
    text(g, env, 'DS1307', 0.9 * U, -2.1 * U, { size: 4.5, color: '#a5b4fc', weight: 700, font: MONO });
    const pNames = ['VCC', 'GND', 'SDA', 'SCL', 'SQW'];
    for (let i = 0; i < 5; i++) {
      text(g, env, pNames[i], i * U, -0.6 * U, { size: 4, color: '#e0e7ff', weight: 700, font: MONO });
    }
  },
  device: (part, nets) => devI2C.ds1307Device(part, nets),
});

register({
  type: 'wokwi-bmp180', name: 'BMP180 Barometer & Temperature', cat: 'Inputs', desc: 'Digital barometric pressure and temperature sensor.',
  aliases: ['bmp180'],
  defaults: { temperature: 25.0, pressure: 101325 },
  fields: [
    { key: 'temperature', label: 'Temperature (°C)', kind: 'number' },
    { key: 'pressure', label: 'Pressure (Pa)', kind: 'number' },
  ],
  pins: () => [
    { x: 0, y: 0, name: 'VCC' }, { x: 1, y: 0, name: 'GND' }, { x: 2, y: 0, name: 'SCL' }, { x: 3, y: 0, name: 'SDA' },
  ],
  bounds: () => [-0.6, -3.0, 3.6, 0.3],
  draw(g, part, env) {
    for (let i = 0; i < 4; i++) lead(g, i, -0.8, i, 0);
    shadow(g, 8, 3, 0.3);
    rr(g, -0.5 * U, -2.8 * U, 4.0 * U, 2.0 * U, 3);
    g.fillStyle = lin(g, 0, -2.8 * U, 0, -0.8 * U, [[0, '#701a75'], [1, '#4a044e']]);
    g.fill(); noShadow(g);
    rr(g, 1.0 * U, -2.3 * U, 1.8 * U, 1.1 * U, 1.5);
    g.fillStyle = lin(g, 1.0 * U, -2.3 * U, 2.8 * U, -1.2 * U, [[0, '#e4e4e7'], [1, '#a1a1aa']]);
    g.fill();
    g.fillStyle = '#18181b';
    g.beginPath(); g.arc(2.3 * U, -1.75 * U, 1.5, 0, TAU); g.fill();
    text(g, env, 'BMP180', 1.9 * U, -2.4 * U, { size: 5, color: '#f5d0fe', weight: 700, font: MONO });
    const pNames = ['VCC', 'GND', 'SCL', 'SDA'];
    for (let i = 0; i < 4; i++) {
      text(g, env, pNames[i], i * U, -0.6 * U, { size: 4.5, color: '#fae8ff', weight: 700, font: MONO });
    }
  },
  device: (part, nets) => devI2C.bmp180Device(part, nets),
});

// ---------------------------------------------------------------- Notes ----
register({
  type: 'label', name: 'Text Label', cat: 'Notes', desc: 'A note on the canvas. Double-click to edit.',
  defaults: { text: 'Label', size: 14 },
  fields: [{ key: 'text', label: 'Text', kind: 'text' }, { key: 'size', label: 'Size', kind: 'select', options: [[11, 'Small'], [14, 'Medium'], [20, 'Large'], [28, 'Title']] }],
  pins: () => [],
  bounds: (p) => [0, -0.6 * (p.size / 14), Math.max(2, (p.text || '').length * p.size * 0.55 / U), 0.6 * (p.size / 14)],
  draw(g, part, env) {
    text(g, env, part.props.text || ' ', 0, 0, { size: part.props.size, color: env.dark ? '#f2f2f7' : '#1d1d1f', weight: part.props.size >= 20 ? 700 : 500, align: 'left' });
  },
});

export function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  let r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  const t = f < 0 ? 0 : 255, p = Math.abs(f);
  r = Math.round((t - r) * p + r); g = Math.round((t - g) * p + g); b = Math.round((t - b) * p + b);
  return `rgb(${r},${g},${b})`;
}

export { LED_COLORS, U };

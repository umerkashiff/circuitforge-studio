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

// ---------------------------------------------------------- Lab Trainer ----
const TRAINER_COLS = [
  ...Array.from({ length: 16 }, (_, i) => ({ name: 'L' + i, kind: 'led', idx: i })),
  { name: 'P1', kind: 'pulse', idx: 0, inv: false },
  { name: "P1'", kind: 'pulse', idx: 0, inv: true },
  { name: 'P2', kind: 'pulse', idx: 1, inv: false },
  { name: "P2'", kind: 'pulse', idx: 1, inv: true },
  { name: 'S0', kind: 'sw', idx: 0, inv: false },
  { name: 'S1', kind: 'sw', idx: 1, inv: false },
  ...Array.from({ length: 8 }, (_, k) => {
    const s = k + 2;
    return [
      { name: 'S' + s, kind: 'sw', idx: s, inv: false },
      { name: "S" + s + "'", kind: 'sw', idx: s, inv: true },
    ];
  }).flat(),
  { name: 'CLK', kind: 'clk' },
  { name: '+5V', kind: 'vcc' },
  { name: 'GND', kind: 'gnd' },
];

const TRAINER_PINS = [];
const TRAINER_LINKS = [];
const TRAINER_SUPPLIES = [];
for (let c = 0; c < TRAINER_COLS.length; c++) {
  const base = c * 4;
  const col = TRAINER_COLS[c];
  for (let r = 0; r < 4; r++) {
    TRAINER_PINS.push({ x: c, y: r - 3, name: col.name });
    if (r > 0) TRAINER_LINKS.push([base + r - 1, base + r]);
    if (col.kind === 'vcc') TRAINER_SUPPLIES.push({ i: base + r, kind: 'V:5' });
    else if (col.kind === 'gnd') TRAINER_SUPPLIES.push({ i: base + r, kind: 'G' });
  }
}

const TRAINER_CLK_COL = TRAINER_COLS.findIndex(c => c.kind === 'clk');

const TRAINER_STATIC_CACHE = new Map();
const TRAINER_CACHE_BOX = { x: -28, y: -236, w: 870, h: 266, scale: 3 };

function drawTrainerToggleBat(g, env, x, y, on) {
  // Mini LED indicator above toggle
  g.fillStyle = on ? '#22c55e' : '#475569';
  g.beginPath(); g.arc(x, y - 34, 3, 0, TAU); g.fill();
  if (on) glow(g, x, y - 34, 9, '34,197,94', 0.9);
  // Bat handle toggle pointing DOWN (on / 1) or UP (off / 0)
  const tipY = on ? y + 18 : y - 18;
  // Soft offset drop shadow without per-frame shadowBlur
  g.lineCap = 'round';
  g.strokeStyle = 'rgba(15,20,30,0.28)';
  g.lineWidth = 6.2;
  g.beginPath(); g.moveTo(x + 1, y + 1); g.lineTo(x + 1, tipY + (on ? 3 : -1)); g.stroke();
  g.strokeStyle = lin(g, x - 4, y, x + 4, tipY, [[0, '#f3f4f6'], [0.5, '#cbd5e1'], [1, '#64748b']]);
  g.lineWidth = 5.4;
  g.beginPath(); g.moveTo(x, y); g.lineTo(x, tipY); g.stroke();
  g.fillStyle = '#f8fafc';
  g.beginPath(); g.arc(x, tipY, 3.2, 0, TAU); g.fill();
  text(g, env, on ? '1' : '0', x, y + 32, { size: 6.5, color: on ? '#16a34a' : '#64748b', weight: 800, font: MONO });
}

function drawTrainerStatic(g, env) {
  // Upper chassis aluminum panel
  shadow(g, 10, 4, 0.25);
  rr(g, -0.7 * U, -11.2 * U, 41.4 * U, 6.45 * U, 6);
  g.fillStyle = lin(g, 0, -11.2 * U, 0, -4.75 * U, [[0, '#e5e7eb'], [0.5, '#d1d5db'], [1, '#bcc2cc']]);
  g.fill();
  noShadow(g);
  g.strokeStyle = 'rgba(0,0,0,0.18)'; g.lineWidth = 1.2; g.stroke();

  // Panel screws
  for (const [sx, sy] of [[-0.35, -10.85], [40.35, -10.85], [-0.35, -5.1], [40.35, -5.1]]) {
    g.fillStyle = '#9ca3af'; g.beginPath(); g.arc(sx * U, sy * U, 3.5, 0, TAU); g.fill();
    g.strokeStyle = '#6b7280'; g.lineWidth = 0.9;
    g.beginPath(); g.moveTo(sx * U - 2.2, sy * U - 2.2); g.lineTo(sx * U + 2.2, sy * U + 2.2); g.stroke();
  }

  // Section dividers on chassis
  g.strokeStyle = 'rgba(0,0,0,0.14)'; g.lineWidth = 1;
  for (const dx of [15.5, 19.65, 37.8]) {
    g.beginPath(); g.moveTo(dx * U, -10.9 * U); g.lineTo(dx * U, -5.0 * U); g.stroke();
  }

  // 1. State Monitor LEDs bezels & unlit state (L0..L15)
  text(g, env, 'STATE MONITORS', 7.45 * U, -10.65 * U, { size: 7.5, color: '#374151', weight: 800, font: MONO });
  for (let i = 0; i < 16; i++) {
    const col = i % 8, row = (i / 8) | 0;
    const lx = (0.95 + col * 1.86) * U;
    const ly = (-9.45 + row * 2.35) * U;
    g.fillStyle = '#374151'; g.beginPath(); g.arc(lx, ly, 7.2, 0, TAU); g.fill();
    g.fillStyle = '#5c1f1f'; g.beginPath(); g.arc(lx, ly, 5.2, 0, TAU); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.3)'; g.beginPath(); g.arc(lx - 1.5, ly - 1.5, 1.4, 0, TAU); g.fill();
    text(g, env, 'L' + i, lx, ly + 11.5, { size: 6.5, color: '#1f2937', weight: 700, font: MONO });
  }

  // 2. Pushbutton Pulsers bezels & labels (P1, P2)
  text(g, env, 'PUSH SW', 17.6 * U, -10.65 * U, { size: 7.5, color: '#374151', weight: 800, font: MONO });
  for (let i = 0; i < 2; i++) {
    const px = (16.65 + i * 1.9) * U, py = -8.4 * U;
    g.fillStyle = '#9ca3af'; g.beginPath(); g.arc(px, py, 11, 0, TAU); g.fill();
    g.fillStyle = '#4b5563'; g.beginPath(); g.arc(px, py, 8.8, 0, TAU); g.fill();
    text(g, env, 'P' + (i + 1), px, -5.95 * U, { size: 7.5, color: '#111827', weight: 800, font: MONO });
  }

  // 3. Logic Switches white label strip & hex bushings (S0..S9)
  text(g, env, 'LOGIC SWITCHES', 28.8 * U, -10.65 * U, { size: 7.5, color: '#374151', weight: 800, font: MONO });
  rr(g, 20.0 * U, -6.35 * U, 17.5 * U, 0.85 * U, 2);
  g.fillStyle = '#f8fafc'; g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.12)'; g.lineWidth = 0.8; g.stroke();
  for (let k = 0; k < 10; k++) {
    const x = (20.9 + k * 1.76) * U, y = -8.25 * U;
    g.fillStyle = '#9ca3af';
    g.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3;
      const vx = x + Math.cos(a) * 9.5, vy = y + Math.sin(a) * 9.5;
      if (i === 0) g.moveTo(vx, vy); else g.lineTo(vx, vy);
    }
    g.closePath(); g.fill();
    g.strokeStyle = '#6b7280'; g.lineWidth = 0.8; g.stroke();
    g.fillStyle = '#374151'; g.beginPath(); g.arc(x, y, 5.2, 0, TAU); g.fill();
    text(g, env, 'S' + k, x, y + 46, { size: 7.5, color: '#111827', weight: 800, font: MONO });
  }

  // 4. Clock & Power static labels
  text(g, env, 'CLK / PWR', 39.25 * U, -10.65 * U, { size: 6.5, color: '#374151', weight: 800, font: MONO });
  text(g, env, '+5V', 39.25 * U, -5.95 * U, { size: 7, color: '#991b1b', weight: 800, font: MONO });

  // Lower Terminal Socket Strip (4 rows per column)
  shadow(g, 8, 3, 0.28);
  rr(g, -0.65 * U, -4.55 * U, 41.3 * U, 5.0 * U, 5);
  g.fillStyle = lin(g, 0, -4.55 * U, 0, 0.45 * U, [[0, '#272a30'], [1, '#1b1d22']]);
  g.fill();
  noShadow(g);
  g.strokeStyle = 'rgba(255,255,255,0.08)'; g.lineWidth = 1; g.stroke();

  // Label band background
  rr(g, -0.5 * U, -4.4 * U, 41.0 * U, 1.0 * U, 2);
  g.fillStyle = '#14161a'; g.fill();

  // Vertical divider ticks between groups on socket strip
  g.strokeStyle = 'rgba(255,255,255,0.22)'; g.lineWidth = 1.2;
  for (const gx of [15.5, 19.5, 37.5]) {
    g.beginPath(); g.moveTo(gx * U, -4.4 * U); g.lineTo(gx * U, 0.35 * U); g.stroke();
  }

  // Draw 4 sockets + column label for all 41 columns
  const rotAngle = (env.rot === 2 || env.rot === 3) ? Math.PI / 2 : -Math.PI / 2;
  for (let c = 0; c < TRAINER_COLS.length; c++) {
    const col = TRAINER_COLS[c];
    const cx = c * U;
    const lblColor = col.kind === 'led' ? '#fbbf24'
      : col.kind === 'pulse' ? '#7dd3fc'
        : col.kind === 'clk' ? '#4ade80'
          : col.kind === 'vcc' ? '#f87171'
            : col.kind === 'gnd' ? '#93c5fd'
              : col.inv ? '#86efac' : '#f8fafc';
    g.save();
    g.translate(cx, -3.9 * U);
    g.rotate(rotAngle);
    g.font = `700 6.8px ${MONO}`;
    g.fillStyle = lblColor;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(col.name, 0, 0);
    g.restore();

    for (let r = 0; r < 4; r++) {
      const hy = (r - 3) * U;
      g.fillStyle = '#383b42'; g.fillRect(cx - 5.2, hy - 5.2, 10.4, 10.4);
      g.fillStyle = '#0e1013'; g.fillRect(cx - 3.3, hy - 3.3, 6.6, 6.6);
      g.fillStyle = '#6b7280'; g.fillRect(cx - 1.2, hy - 1.2, 2.4, 2.4);
    }
  }
}

function getTrainerStaticCanvas(env) {
  if (typeof document === 'undefined') return null;
  const key = env.rot & 3;
  let canvas = TRAINER_STATIC_CACHE.get(key);
  if (canvas) return canvas;
  const { x, y, w, h, scale } = TRAINER_CACHE_BOX;
  canvas = document.createElement('canvas');
  canvas.width = w * scale;
  canvas.height = h * scale;
  const cg = canvas.getContext('2d');
  cg.scale(scale, scale);
  cg.translate(-x, -y);
  drawTrainerStatic(cg, env);
  TRAINER_STATIC_CACHE.set(key, canvas);
  return canvas;
}

register({
  type: 'trainer-board',
  name: 'Lab Trainer Board',
  short: 'Trainer',
  title: 'Digital Logic Trainer (LEDs L0–L15, Switches S0–S9 / S2′–S9′, CLK, +5V, GND)',
  cat: 'Boards',
  aliases: ['logic-trainer', 'trainer'],
  desc: 'Digital trainer panel: 16 State Monitor LEDs (L0–L15), 2 pulse buttons (P1/P1′, P2/P2′), 10 switches (S0–S9) with side-by-side complementary outputs (S2′–S9′), 4 tie sockets per column, CLK, +5V and GND.',
  defaults: { bits: Array(10).fill(false), hz: 1 },
  fields: [
    { key: 'hz', label: 'CLK Frequency', kind: 'select', options: [[0.5, '0.5 Hz'], [1, '1 Hz'], [2, '2 Hz'], [5, '5 Hz'], [10, '10 Hz'], [25, '25 Hz']] },
  ],
  pins: () => TRAINER_PINS,
  links: () => TRAINER_LINKS,
  staticLinks: true,
  supply: () => TRAINER_SUPPLIES,
  bounds: () => [-0.8, -11.3, 40.8, 0.55],
  draw(g, part, env) {
    const bits = part.props.bits || [];
    const d = env.dev;
    const cached = getTrainerStaticCanvas(env);
    if (cached) {
      const { x, y, w, h } = TRAINER_CACHE_BOX;
      g.drawImage(cached, x, y, w, h);
    } else {
      drawTrainerStatic(g, env);
    }

    // Dynamic LEDs (only redraw lit ones; unlit state is baked in static cache)
    const levels = d && d.ledLevels;
    if (levels) {
      for (let i = 0; i < 16; i++) {
        const lvl = levels[i];
        if (lvl <= 0.02) continue;
        const col = i % 8, row = (i / 8) | 0;
        const lx = (0.95 + col * 1.86) * U;
        const ly = (-9.45 + row * 2.35) * U;
        glow(g, lx, ly, 16, '255,59,48', lvl);
        g.fillStyle = `rgb(255,${Math.round(59 + lvl * 40)},${Math.round(48 + lvl * 20)})`;
        g.beginPath(); g.arc(lx, ly, 5.2, 0, TAU); g.fill();
        g.fillStyle = 'rgba(255,255,255,0.3)';
        g.beginPath(); g.arc(lx - 1.5, ly - 1.5, 1.4, 0, TAU); g.fill();
      }
    }

    // Dynamic Pushbuttons (P1, P2)
    for (let i = 0; i < 2; i++) {
      const px = (16.65 + i * 1.9) * U, py = -8.4 * U;
      const pressed = !!(part.ui && part.ui.pressKey === ('p' + (i + 1)));
      g.fillStyle = pressed ? '#ef4444' : '#475569';
      g.beginPath(); g.arc(px, py - 24, 2.8, 0, TAU); g.fill();
      if (pressed) glow(g, px, py - 24, 8, '239,68,68', 0.9);
      const r = pressed ? 6.4 : 7.0;
      g.fillStyle = 'rgba(15,20,30,0.3)';
      g.beginPath(); g.arc(px + 0.5, py + (pressed ? 1 : 2.5), r, 0, TAU); g.fill();
      g.fillStyle = pressed ? '#b91c1c' : lin(g, px, py - 7, px, py + 7, [[0, '#ef4444'], [1, '#dc2626']]);
      g.beginPath(); g.arc(px, py, r, 0, TAU); g.fill();
    }

    // Dynamic Toggle Bats (S0..S9)
    for (let k = 0; k < 10; k++) {
      drawTrainerToggleBat(g, env, (20.9 + k * 1.76) * U, -8.25 * U, !!bits[k]);
    }

    // Dynamic CLK & Power LEDs + Hz label
    const clkOn = !!(d && d.clkHigh);
    g.fillStyle = clkOn ? '#22c55e' : '#374151';
    g.beginPath(); g.arc(39.25 * U, -9.35 * U, 4.5, 0, TAU); g.fill();
    if (clkOn) glow(g, 39.25 * U, -9.35 * U, 12, '34,197,94', 1);
    text(g, env, `${part.props.hz || 1}Hz`, 39.25 * U, -8.35 * U, { size: 6.5, color: '#1f2937', weight: 700, font: MONO });
    const pwrOn = !!d;
    g.fillStyle = pwrOn ? '#ef4444' : '#5c1f1f';
    g.beginPath(); g.arc(39.25 * U, -7.0 * U, 4.5, 0, TAU); g.fill();
    if (pwrOn) glow(g, 39.25 * U, -7.0 * U, 12, '239,68,68', 0.9);
  },
  control(part, l) {
    if (l.x >= 15.65 && l.x <= 19.65 && l.y >= -10.5 && l.y <= -5.0) {
      for (let i = 0; i < 2; i++) {
        if (Math.hypot(l.x - (16.65 + i * 1.9), l.y + 8.4) <= 0.95) return 'press:p' + (i + 1);
      }
    }
    if (l.x >= 19.9 && l.x <= 37.7 && l.y >= -10.5 && l.y <= -5.0) {
      return 'sw' + Math.max(0, Math.min(9, Math.round((l.x - 20.9) / 1.76)));
    }
    return null;
  },
  click(part, ctrl) {
    if (typeof ctrl === 'string' && ctrl.startsWith('sw')) {
      const k = +ctrl.slice(2);
      if (!part.props.bits) part.props.bits = Array(10).fill(false);
      part.props.bits[k] = !part.props.bits[k];
      return true;
    }
    return false;
  },
  device(part, nets, e) {
    if (!part.props.bits) part.props.bits = Array(10).fill(false);
    const vccDev = dev.supply([nets[39 * 4]], 5);
    const gndDev = dev.supply([nets[40 * 4]], 0);
    const sources = [];
    let clkHigh = false;

    for (let c = 0; c < TRAINER_COLS.length; c++) {
      const col = TRAINER_COLS[c];
      const net = nets[c * 4];
      if (col.kind === 'sw') {
        sources.push(dev.logicSource(net, () => {
          const on = !!(part.props.bits && part.props.bits[col.idx]);
          return col.inv ? !on : on;
        }));
      } else if (col.kind === 'pulse') {
        sources.push(dev.logicSource(net, () => {
          const on = !!(part.ui && part.ui.pressKey === ('p' + (col.idx + 1)));
          return col.inv ? !on : on;
        }));
      } else if (col.kind === 'clk') {
        sources.push(dev.logicSource(net, () => clkHigh));
      }
    }

    return {
      // Only trigger fine time-stepping if the trainer CLK pin is wired to something.
      timeDependent: !e || e.isNetConnected(nets[TRAINER_CLK_COL * 4]),
      clkHigh: false,
      ledLevels: new Float32Array(16),
      warning: null,
      reset() {
        clkHigh = false;
        this.clkHigh = false;
        this.ledLevels.fill(0);
        this.warning = null;
      },
      begin(e) {
        const hz = part.props.hz || 1;
        clkHigh = ((e.time * hz) % 1) < 0.5;
        this.clkHigh = clkHigh;
        e.maxHz = Math.max(e.maxHz, hz);
      },
      stamp(S, V, e) {
        vccDev.stamp(S, V, e);
        gndDev.stamp(S, V, e);
        for (const s of sources) s.stamp(S, V, e);
      },
      commit(V, dt, e) {
        vccDev.commit(V, dt, e);
        gndDev.commit(V, dt, e);
        this.warning = vccDev.warning || gndDev.warning || null;
        for (let k = 0; k < 16; k++) {
          const n = nets[k * 4];
          const v = n >= 0 && ok(V[n]) ? V[n] : NaN;
          this.ledLevels[k] = ok(v) && v >= 1.8 ? Math.min(1, 0.35 + 0.65 * Math.min(1, (v - 1.8) / 1.5)) : 0;
        }
      },
    };
  },
});

// --------------------------------------------------------- Lab Instruments --
function drawPanelBadge(g, env, x, y, w = 54, h = 15) {
  rr(g, x, y, w, h, 3.5);
  g.fillStyle = '#0a84ff'; g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.42)'; g.lineWidth = 1; g.stroke();
  text(g, env, 'PANEL ↗', x + w / 2, y + h / 2 + 0.5, { size: 7.2, color: '#ffffff', weight: 800, font: MONO });
}

function drawKnob(g, x, y, r, angle, capColor = '#e2e8f0', skirtColor = '#334155') {
  g.fillStyle = 'rgba(0,0,0,0.32)';
  g.beginPath(); g.arc(x + 1.5, y + 2, r + 2, 0, TAU); g.fill();
  g.fillStyle = skirtColor;
  g.beginPath(); g.arc(x, y, r + 1.5, 0, TAU); g.fill();
  g.fillStyle = capColor;
  g.beginPath(); g.arc(x, y, r * 0.78, 0, TAU); g.fill();
  g.strokeStyle = '#1e293b'; g.lineWidth = 1.2; g.stroke();
  g.strokeStyle = '#0f172a'; g.lineWidth = 2.6; g.lineCap = 'round';
  g.beginPath();
  g.moveTo(x + Math.cos(angle) * (r * 0.16), y + Math.sin(angle) * (r * 0.16));
  g.lineTo(x + Math.cos(angle) * (r * 0.72), y + Math.sin(angle) * (r * 0.72));
  g.stroke();
}

function drawBncPort(g, x, y) {
  g.fillStyle = '#94a3b8'; g.beginPath(); g.arc(x, y, 8.6, 0, TAU); g.fill();
  g.strokeStyle = '#1e293b'; g.lineWidth = 1.2; g.stroke();
  g.fillStyle = '#f1f5f9'; g.beginPath(); g.arc(x, y, 6.2, 0, TAU); g.fill();
  g.fillStyle = '#0f172a'; g.beginPath(); g.arc(x, y, 4.2, 0, TAU); g.fill();
  g.fillStyle = '#facc15'; g.beginPath(); g.arc(x, y, 1.8, 0, TAU); g.fill();
}

function drawBananaSocket(g, x, y, ringColor) {
  g.fillStyle = '#1f2937'; g.beginPath(); g.arc(x, y, 8.8, 0, TAU); g.fill();
  g.fillStyle = ringColor; g.beginPath(); g.arc(x, y, 7.0, 0, TAU); g.fill();
  g.fillStyle = '#cbd5e1'; g.beginPath(); g.arc(x, y, 4.2, 0, TAU); g.fill();
  g.fillStyle = '#090b0f'; g.beginPath(); g.arc(x, y, 2.5, 0, TAU); g.fill();
}

function cycleList(list, val, delta) {
  let idx = 0, best = Infinity;
  for (let i = 0; i < list.length; i++) {
    const d = Math.abs(list[i] - val);
    if (d < best) { best = d; idx = i; }
  }
  return list[Math.max(0, Math.min(list.length - 1, idx + delta))];
}

// 1. Regulated DC Power Supply — MATRIX MPS-3005L-3 ------------------------
const PSU_V_STEPS = [0, 1.5, 3.3, 5, 6, 9, 12, 15, 24, 30];
const PSU_I_STEPS = [0.1, 0.5, 1, 2, 3, 5];

function drawPsuStatic(g, env) {
  // Subtle crisp drop bezel (vector-sharp at every zoom, zero shadowBlur cost)
  rr(g, -0.5 * U + 2, -9.65 * U + 3, 19.0 * U, 10.55 * U, 8);
  g.fillStyle = 'rgba(0,0,0,0.22)'; g.fill();
  // Cream metal chassis matching MATRIX MPS-3005L-3
  rr(g, -0.5 * U, -9.65 * U, 19.0 * U, 10.55 * U, 8);
  g.fillStyle = lin(g, 0, -9.65 * U, 0, 0.9 * U, [[0, '#eeece4'], [1, '#d3d0c4']]);
  g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.28)'; g.lineWidth = 1.4; g.stroke();

  // Brand badge + PANEL pop-out badge (clear of meter bezel)
  rr(g, -0.1 * U, -9.42 * U, 10.6 * U, 0.72 * U, 3);
  g.fillStyle = '#d97706'; g.fill();
  text(g, env, 'MATRIX', 1.65 * U, -9.06 * U, { size: 9, color: '#111827', weight: 900, font: MONO });
  text(g, env, 'MPS-3005L-3', 6.8 * U, -9.06 * U, { size: 8.5, color: '#111827', weight: 800, font: MONO });
  drawPanelBadge(g, env, 15.2 * U, -9.45 * U, 56, 15);

  // Recessed dark digital meter bay
  rr(g, 0.25 * U, -8.45 * U, 17.5 * U, 2.55 * U, 5);
  g.fillStyle = '#0d1016'; g.fill();
  g.strokeStyle = '#334155'; g.lineWidth = 1.4; g.stroke();
  for (let i = 0; i < 4; i++) {
    const wx = (0.75 + i * 4.25) * U;
    rr(g, wx, -7.75 * U, 3.7 * U, 1.35 * U, 3);
    g.fillStyle = '#050709'; g.fill();
    text(g, env, i % 2 === 0 ? 'A' : 'V', wx + 1.85 * U, -8.12 * U, { size: 8.5, color: '#cbd5e1', weight: 800, font: MONO });
  }

  // Ochre/gold lower control deck (extends below y=0 binding posts cleanly)
  rr(g, 0.0 * U, -5.65 * U, 18.0 * U, 6.27 * U, 5);
  g.fillStyle = lin(g, 0, -5.65 * U, 0, 0.62 * U, [[0, '#cfa958'], [1, '#b68f40']]);
  g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.22)'; g.lineWidth = 1.2; g.stroke();

  // Bold high-contrast control labels (uncluttered for crisp zoomed-out visibility)
  text(g, env, 'CUR', 2.0 * U, -5.12 * U, { size: 8, color: '#111827', weight: 800, font: MONO });
  text(g, env, 'VOLT', 5.6 * U, -5.12 * U, { size: 8, color: '#111827', weight: 800, font: MONO });
  text(g, env, 'CUR', 11.4 * U, -5.12 * U, { size: 8, color: '#111827', weight: 800, font: MONO });
  text(g, env, 'VOLT', 14.9 * U, -5.12 * U, { size: 8, color: '#111827', weight: 800, font: MONO });
  text(g, env, 'SLAVE', 3.8 * U, -2.35 * U, { size: 8.5, color: '#111827', weight: 900, font: MONO });
  text(g, env, 'TRACK', 8.5 * U, -2.35 * U, { size: 8, color: '#14532d', weight: 900, font: MONO });
  text(g, env, 'MASTER', 13.2 * U, -2.35 * U, { size: 8.5, color: '#111827', weight: 900, font: MONO });
  text(g, env, 'MODE', 8.5 * U, -4.85 * U, { size: 7.5, color: '#111827', weight: 800, font: MONO });
  text(g, env, 'PWR', 0.9 * U, -2.25 * U, { size: 7.5, color: '#111827', weight: 800, font: MONO });
  text(g, env, '5V 3A', 16.0 * U, -1.55 * U, { size: 7.5, color: '#111827', weight: 800, font: MONO });

  // Bottom binding post sockets & bold labels
  const posts = [
    [2, '#111827', '−'], [4, '#f8fafc', 'GND'], [6, '#16a34a', '+'],
    [9, '#111827', '−'], [11, '#f8fafc', 'GND'], [13, '#dc2626', '+'],
    [15, '#111827', '−'], [17, '#dc2626', '+'],
  ];
  for (const [px, col, lbl] of posts) {
    text(g, env, lbl, px * U, -0.82 * U, { size: 8, color: '#111827', weight: 900, font: MONO });
    drawBananaSocket(g, px * U, 0, col);
  }
}

register({
  type: 'power-supply',
  name: 'MPS-3005L-3 Regulated Power Supply',
  short: 'MPS-3005L-3',
  title: 'Triple-Output Regulated DC Power Supply (2× 0–30V/5A + 5V/3A Fixed)',
  cat: 'Instruments',
  aliases: ['regulated-power-supply', 'mps3005', 'bench-supply'],
  desc: 'Dual tracking 0–30 V / 0–5 A + fixed 5 V / 3 A laboratory DC power supply with live V/A meters, Constant Current limiting, Series (up to 60 V), and Parallel modes.',
  defaults: { power: true, mode: 'indep', v1: 5, i1: 2, v2: 12, i2: 2 },
  fields: [
    { key: 'power', label: 'Power Switch', kind: 'select', options: [[true, 'ON'], [false, 'OFF']] },
    { key: 'mode', label: 'Tracking Mode', kind: 'select', options: [['indep', 'Independent'], ['series', 'Series (0–60V / ±Track)'], ['parallel', 'Parallel (2× Current)']] },
    { key: 'v1', label: 'Master Voltage (V)', kind: 'select', options: [[0, '0.0 V'], [1.5, '1.5 V'], [3.3, '3.3 V'], [5, '5.0 V'], [6, '6.0 V'], [9, '9.0 V'], [12, '12.0 V'], [15, '15.0 V'], [24, '24.0 V'], [30, '30.0 V']], custom: { unit: 'V', min: 0, max: 30 } },
    { key: 'i1', label: 'Master Current Limit (A)', kind: 'select', options: [[0.1, '0.10 A'], [0.5, '0.50 A'], [1, '1.00 A'], [2, '2.00 A'], [3, '3.00 A'], [5, '5.00 A']], custom: { unit: 'A', min: 0.05, max: 5 } },
    { key: 'v2', label: 'Slave Voltage (V)', kind: 'select', options: [[0, '0.0 V'], [1.5, '1.5 V'], [3.3, '3.3 V'], [5, '5.0 V'], [6, '6.0 V'], [9, '9.0 V'], [12, '12.0 V'], [15, '15.0 V'], [24, '24.0 V'], [30, '30.0 V']], custom: { unit: 'V', min: 0, max: 30 } },
    { key: 'i2', label: 'Slave Current Limit (A)', kind: 'select', options: [[0.1, '0.10 A'], [0.5, '0.50 A'], [1, '1.00 A'], [2, '2.00 A'], [3, '3.00 A'], [5, '5.00 A']], custom: { unit: 'A', min: 0.05, max: 5 } },
  ],
  pins: () => [
    { x: 2, y: 0, name: 'SLAVE −' },
    { x: 4, y: 0, name: 'SLAVE GND' },
    { x: 6, y: 0, name: 'SLAVE +' },
    { x: 9, y: 0, name: 'MASTER −' },
    { x: 11, y: 0, name: 'MASTER GND' },
    { x: 13, y: 0, name: 'MASTER +' },
    { x: 15, y: 0, name: '5V FIXED −' },
    { x: 17, y: 0, name: '5V FIXED +' },
  ],
  links: () => [[1, 4]],
  staticLinks: true,
  supply: (part) => [
    { i: 0, kind: 'B-:' + part.id + '_s' },
    { i: 1, kind: 'G' },
    { i: 2, kind: 'B+:' + part.id + '_s' },
    { i: 3, kind: 'B-:' + part.id + '_m' },
    { i: 4, kind: 'G' },
    { i: 5, kind: 'B+:' + part.id + '_m' },
    { i: 6, kind: 'B-:' + part.id + '_f' },
    { i: 7, kind: 'B+:' + part.id + '_f' },
  ],
  bounds: () => [-0.8, -9.85, 18.8, 0.95],
  draw(g, part, env) {
    drawPsuStatic(g, env);

    const p = part.props;
    const on = !!p.power;
    const d = env.dev;
    const v1Set = Math.max(0, Math.min(30, +p.v1 || 0));
    const v2Set = (p.mode === 'series' || p.mode === 'parallel') ? v1Set : Math.max(0, Math.min(30, +p.v2 || 0));
    const i1Set = Math.max(0.05, Math.min(5, +p.i1 || 2));
    const i2Set = p.mode === 'parallel' ? i1Set : Math.max(0.05, Math.min(5, +p.i2 || 2));

    // Digital LED meters (SLAVE A, SLAVE V, MASTER A, MASTER V)
    const vals = on
      ? [
        (d ? d.measI2 : 0).toFixed(2),
        (d ? d.measV2 : v2Set).toFixed(1),
        (d ? d.measI1 : 0).toFixed(2),
        (d ? d.measV1 : v1Set).toFixed(1),
      ]
      : ['---', '---', '---', '---'];
    for (let k = 0; k < 4; k++) {
      const cx = (0.75 + k * 4.25 + 1.85) * U;
      text(g, env, vals[k], cx, -7.08 * U, { size: 15, color: on ? (k % 2 === 0 ? '#4ade80' : '#ff453a') : '#292d35', weight: 800, font: MONO });
    }

    // Knobs (SLAVE I, SLAVE V, MASTER I, MASTER V)
    const ang = (frac) => (-Math.PI * 1.25) + Math.max(0, Math.min(1, frac)) * (Math.PI * 1.5);
    drawKnob(g, 2.0 * U, -3.7 * U, 17, ang(i2Set / 5));
    drawKnob(g, 5.6 * U, -3.7 * U, 17, ang(v2Set / 30));
    drawKnob(g, 11.4 * U, -3.7 * U, 17, ang(i1Set / 5));
    drawKnob(g, 14.9 * U, -3.7 * U, 17, ang(v1Set / 30));

    // Tracking pushbuttons
    const isSeries = p.mode === 'series', isPar = p.mode === 'parallel';
    for (const [bx, pressed] of [[8.05 * U, isSeries || isPar], [8.95 * U, isPar]]) {
      rr(g, bx - 7, -3.6 * U - 7, 14, 14, 2);
      g.fillStyle = pressed ? '#94a3b8' : '#f8fafc'; g.fill();
      g.strokeStyle = '#334155'; g.lineWidth = 1; g.stroke();
    }

    // Status LEDs (SLAVE C.C/C.V, MASTER C.C/C.V, 5V OVERLOAD)
    const ledDot = (lx, ly, active, rgb) => {
      g.fillStyle = active ? `rgb(${rgb})` : '#374151';
      g.beginPath(); g.arc(lx, ly, 3.6, 0, TAU); g.fill();
      if (active) glow(g, lx, ly, 9, rgb, 0.9);
    };
    ledDot(3.4 * U, -3.95 * U, on && !!(d && d.cc2), '239,68,68');
    ledDot(4.25 * U, -3.95 * U, on && (!d || !d.cc2), '34,197,94');
    ledDot(12.8 * U, -3.95 * U, on && !!(d && d.cc1), '239,68,68');
    ledDot(13.65 * U, -3.95 * U, on && (!d || !d.cc1), '34,197,94');
    ledDot(17.0 * U, -3.6 * U, on && !!(d && d.overload5), '239,68,68');

    // Bottom-left white POWER rocker
    rr(g, 0.35 * U, -1.75 * U, 1.1 * U, 0.55 * U, 3);
    g.fillStyle = '#374151'; g.fill();
    rr(g, (on ? 0.42 : 0.9) * U, -1.68 * U, 0.5 * U, 0.41 * U, 2);
    g.fillStyle = on ? '#f8fafc' : '#cbd5e1'; g.fill();
  },
  control(part, l) {
    if (l.x >= 15.1 && l.x <= 18.4 && l.y >= -9.5 && l.y <= -8.45) return 'inst:panel';
    if (l.x >= 0.1 && l.x <= 1.7 && l.y >= -2.5 && l.y <= -0.9) return 'inst:power';
    if (l.x >= 7.5 && l.x <= 9.6 && l.y >= -5.4 && l.y <= -2.8) return 'inst:mode';
    if (Math.hypot(l.x - 2.0, l.y + 3.7) <= 1.0) return 'knob:i2:0.05:5';
    if (Math.hypot(l.x - 5.6, l.y + 3.7) <= 1.0) return 'knob:v2:0:30';
    if (Math.hypot(l.x - 11.4, l.y + 3.7) <= 1.0) return 'knob:i1:0.05:5';
    if (Math.hypot(l.x - 14.9, l.y + 3.7) <= 1.0) return 'knob:v1:0:30';
    return null;
  },
  click(part, ctrl) {
    const p = part.props;
    if (ctrl === 'inst:power') { p.power = !p.power; return true; }
    if (ctrl === 'inst:mode') { p.mode = p.mode === 'indep' ? 'series' : p.mode === 'series' ? 'parallel' : 'indep'; return true; }
    if (ctrl === 'inst:v1-' || ctrl === 'inst:v1+') { p.v1 = cycleList(PSU_V_STEPS, +p.v1 || 0, ctrl.endsWith('+') ? 1 : -1); return true; }
    if (ctrl === 'inst:v2-' || ctrl === 'inst:v2+') { p.v2 = cycleList(PSU_V_STEPS, +p.v2 || 0, ctrl.endsWith('+') ? 1 : -1); return true; }
    if (ctrl === 'inst:i1-' || ctrl === 'inst:i1+') { p.i1 = cycleList(PSU_I_STEPS, +p.i1 || 2, ctrl.endsWith('+') ? 1 : -1); return true; }
    if (ctrl === 'inst:i2-' || ctrl === 'inst:i2+') { p.i2 = cycleList(PSU_I_STEPS, +p.i2 || 2, ctrl.endsWith('+') ? 1 : -1); return true; }
    return false;
  },
  device(part, nets, e) {
    const gndS = dev.supply([nets[1]], 0);
    const gndM = dev.supply([nets[4]], 0);
    const makeCh = (plusIdx, minusIdx) => ({
      plus: nets[plusIdx],
      minus: nets[minusIdx],
      minusConnected: !e || e.isNetConnected(nets[minusIdx]),
      grounded: false,
      inCC: false,
      iMax: 2,
      vTarget: 5,
      measV: 0,
      measI: 0,
    });
    const chS = makeCh(2, 0);
    const chM = makeCh(5, 3);
    const chF = makeCh(7, 6);
    const R_OUT = 0.05;

    const readV = (V, n) => (n >= 0 && ok(V[n]) ? V[n] : NaN);
    const chCurrent = (V, ch) => {
      const vp = readV(V, ch.plus);
      const vm = ch.minusConnected ? readV(V, ch.minus) : 0;
      if (!ok(vp) || !ok(vm)) return { vDiff: 0, i: 0 };
      const vDiff = vp - vm;
      const i = ch.inCC
        ? Math.max(0, ch.iMax - (ch.grounded ? vp : vDiff) * 1e-4)
        : (ch.grounded ? (ch.vTarget - vp) : (ch.vTarget - vDiff)) / R_OUT;
      return { vDiff, i };
    };
    const stampCh = (S, ch, allowAnchor, grounded = false) => {
      ch.grounded = grounded || !ch.minusConnected;
      if (ch.plus < 0) return;
      if (!ch.grounded) {
        if (ch.inCC) {
          S.I(ch.minus, ch.plus, ch.iMax);
          S.G(ch.plus, ch.minus, 1e-4);
          if (allowAnchor) S.anchor(ch.minus);
        } else {
          S.vdrop(ch.plus, ch.minus, ch.vTarget, R_OUT);
          if (allowAnchor) S.anchor(ch.minus);
        }
      } else {
        if (ch.inCC) {
          S.i.push(-2, ch.plus, ch.iMax);
          S.g.push(ch.plus, -2, 1e-4);
          S.roots.push(ch.plus);
          if (ch.minus >= 0) S.src(ch.minus, 0, 0.005);
        } else {
          S.src(ch.plus, ch.vTarget, R_OUT);
          if (ch.minus >= 0) S.src(ch.minus, 0, 0.005);
        }
      }
    };

    return {
      measV1: 0, measI1: 0, measV2: 0, measI2: 0, measV3: 0, measI3: 0,
      cc1: false, cc2: false, overload5: false, warning: null,
      reset() {
        chS.inCC = chM.inCC = chF.inCC = false;
        this.measV1 = this.measI1 = this.measV2 = this.measI2 = this.measV3 = this.measI3 = 0;
        this.cc1 = this.cc2 = this.overload5 = false;
        this.warning = null;
      },
      begin() {
        const p = part.props;
        const v1 = Math.max(0, Math.min(30, +p.v1 || 0));
        const i1 = Math.max(0.05, Math.min(5, +p.i1 || 2));
        const v2 = (p.mode === 'series' || p.mode === 'parallel') ? v1 : Math.max(0, Math.min(30, +p.v2 || 0));
        const i2 = p.mode === 'parallel' ? i1 : Math.max(0.05, Math.min(5, +p.i2 || 2));
        chM.vTarget = v1;
        chM.iMax = p.mode === 'parallel' ? i1 * 2 : i1;
        chS.vTarget = v2;
        chS.iMax = p.mode === 'parallel' ? i1 * 2 : i2;
        chF.vTarget = 5;
        chF.iMax = 3;
      },
      stamp(S, V, eng) {
        gndS.stamp(S, V, eng);
        gndM.stamp(S, V, eng);
        if (!part.props.power) return;
        const mode = part.props.mode;
        if (mode === 'series') {
          chM.minusConnected = true;
          stampCh(S, chS, true, false);
          stampCh(S, chM, false, false);
          if (nets[2] >= 0 && nets[3] >= 0) S.G(nets[2], nets[3], 20);
        } else if (mode === 'parallel') {
          chM.minusConnected = !e || e.isNetConnected(nets[3]) || e.isNetConnected(nets[0]);
          stampCh(S, chM, true, true);
          if (nets[2] >= 0 && nets[5] >= 0 && nets[2] !== nets[5]) S.G(nets[2], nets[5], 20);
          if (nets[0] >= 0 && nets[3] >= 0 && nets[0] !== nets[3]) S.G(nets[0], nets[3], 20);
        } else {
          chS.minusConnected = !e || e.isNetConnected(nets[0]);
          chM.minusConnected = !e || e.isNetConnected(nets[3]);
          const chainS = nets[2] === nets[1] || nets[2] === nets[4] || nets[2] === nets[3] || nets[0] === nets[5] || nets[0] === nets[7];
          const chainM = nets[5] === nets[1] || nets[5] === nets[4] || nets[3] === nets[2] || nets[3] === nets[7];
          stampCh(S, chS, true, !chainS);
          stampCh(S, chM, true, !chainM);
        }
        stampCh(S, chF, true, true);
      },
      update(V) {
        if (!part.props.power) return false;
        let changed = false;
        const stepCC = (ch) => {
          if (ch.plus < 0) return;
          const { vDiff, i } = chCurrent(V, ch);
          if (!ch.inCC && i > ch.iMax * 1.005) { ch.inCC = true; changed = true; }
          else if (ch.inCC && vDiff > ch.vTarget + 0.01) { ch.inCC = false; changed = true; }
        };
        if (part.props.mode === 'parallel') {
          stepCC(chM);
          chS.inCC = chM.inCC;
        } else {
          stepCC(chS);
          stepCC(chM);
        }
        stepCC(chF);
        return changed;
      },
      commit(V) {
        if (!part.props.power) {
          this.measV1 = this.measI1 = this.measV2 = this.measI2 = this.measV3 = this.measI3 = 0;
          this.cc1 = this.cc2 = this.overload5 = false;
          this.warning = null;
          return;
        }
        const m = chCurrent(V, chM);
        const s = part.props.mode === 'parallel' ? { vDiff: m.vDiff, i: m.i * 0.5 } : chCurrent(V, chS);
        const f = chCurrent(V, chF);
        if (part.props.mode === 'parallel') m.i *= 0.5;
        this.measV1 = Math.max(0, m.vDiff);
        this.measI1 = Math.max(0, m.i);
        this.measV2 = Math.max(0, s.vDiff);
        this.measI2 = Math.max(0, s.i);
        this.measV3 = Math.max(0, f.vDiff);
        this.measI3 = Math.max(0, f.i);
        this.cc1 = chM.inCC;
        this.cc2 = part.props.mode === 'parallel' ? chM.inCC : chS.inCC;
        this.overload5 = chF.inCC || f.i > 3.0;
        this.warning = this.overload5 ? '5V FIXED (3A) output is overloaded — load current exceeded 3 A.' : null;
      },
    };
  },
});

// 2. Signal / Function Generator — ESCORT EGC-3235A ------------------------
const FG_HZ_STEPS = [0.5, 1, 2, 5, 10, 20, 50, 100, 500, 1000, 5000, 10000];
const FG_VPP_STEPS = [0.5, 1, 2, 5, 10, 15, 20];

function drawFuncGenStatic(g, env) {
  // Vector drop bezel (no shadowBlur blurriness) + tilt cabinet matching ESCORT EGC-3235A
  rr(g, -0.6 * U + 2, -7.55 * U + 3, 16.2 * U, 8.45 * U, 6);
  g.fillStyle = 'rgba(0,0,0,0.22)'; g.fill();
  rr(g, -0.6 * U, -7.55 * U, 16.2 * U, 8.45 * U, 6);
  g.fillStyle = lin(g, 0, -7.55 * U, 0, 0.9 * U, [[0, '#5a6368'], [1, '#3f474c']]);
  g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 1.4; g.stroke();

  // Dedicated header bar above cream front panel
  text(g, env, 'ESCORT', 1.15 * U, -7.02 * U, { size: 9, color: '#f8fafc', weight: 900, font: MONO });
  text(g, env, 'EGC-3235A', 4.35 * U, -7.02 * U, { size: 8.5, color: '#cbd5e1', weight: 800, font: MONO });
  drawPanelBadge(g, env, 12.1 * U, -7.38 * U, 56, 15);

  // Cream front panel insert (spans well past y=0 BNC sockets so sockets sit cleanly inside)
  rr(g, -0.25 * U, -6.5 * U, 15.5 * U, 7.12 * U, 4);
  g.fillStyle = lin(g, 0, -6.5 * U, 0, 0.62 * U, [[0, '#dedbd0'], [1, '#c8c4b6']]);
  g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 1.1; g.stroke();

  // Crisp Green LCD window
  rr(g, 1.85 * U, -6.0 * U, 3.9 * U, 1.65 * U, 4);
  g.fillStyle = '#0c3520'; g.fill();
  g.strokeStyle = '#1f2937'; g.lineWidth = 1.3; g.stroke();

  // Range UP/DN buttons (clear spacing from LCD and SYM knob)
  for (const [ry, arr] of [[-5.55 * U, '▲'], [-4.8 * U, '▼']]) {
    rr(g, 6.2 * U, ry - 5.5, 16, 11, 2.5);
    g.fillStyle = '#fef3c7'; g.fill(); g.strokeStyle = '#57534e'; g.lineWidth = 1; g.stroke();
    text(g, env, arr, 6.6 * U, ry, { size: 7, color: '#111827', weight: 800, font: MONO });
  }

  // Bold uncluttered control labels (zero overlap with panel badge or knobs)
  text(g, env, 'PWR', 0.85 * U, -4.65 * U, { size: 7.5, color: '#111827', weight: 800, font: MONO });
  text(g, env, 'FREQUENCY', 3.7 * U, -3.75 * U, { size: 8, color: '#111827', weight: 900, font: MONO });
  text(g, env, 'SYM', 8.4 * U, -6.08 * U, { size: 7.5, color: '#111827', weight: 800, font: MONO });
  text(g, env, 'OFF', 10.1 * U, -6.08 * U, { size: 7.5, color: '#111827', weight: 800, font: MONO });
  text(g, env, 'SWEEP', 12.95 * U, -6.08 * U, { size: 7.5, color: '#111827', weight: 800, font: MONO });
  text(g, env, 'AMP', 12.35 * U, -1.65 * U, { size: 7.5, color: '#111827', weight: 800, font: MONO });

  // BNC sockets across bottom (y = 0) with bold labels inside cream deck
  const bncs = [
    [1, 'EXT'], [6, 'SYNC'], [7, 'GND'], [9, 'SWP'], [13, 'OUT+'], [14, 'OUT−'],
  ];
  for (const [bx, lbl] of bncs) {
    text(g, env, lbl, bx * U, -0.82 * U, { size: 7.5, color: '#111827', weight: 900, font: MONO });
    drawBncPort(g, bx * U, 0);
  }
}

register({
  type: 'funcgen',
  name: 'EGC-3235A Signal Generator',
  short: 'EGC-3235A',
  title: '5MHz Sweep Function Generator (Sine, Triangle, Square, TTL Sync)',
  cat: 'Instruments',
  aliases: ['signal-generator', 'function-generator', 'egc3235a'],
  desc: 'Programmable Sine / Triangle / Square wave function generator (50 Ω output) with DC offset, symmetry/duty control, −20 dB attenuator, sweep mode, and TTL SYNC output.',
  defaults: { power: true, wave: 'sine', hz: 10, vpp: 5, offsetOn: false, offset: 0, symOn: false, duty: 50, att20dB: false, sweepOn: false, sweepStopHz: 50, sweepRate: 1 },
  fields: [
    { key: 'power', label: 'Power', kind: 'select', options: [[true, 'ON'], [false, 'OFF']] },
    { key: 'wave', label: 'Waveform', kind: 'select', options: [['sine', 'Sine (∿)'], ['tri', 'Triangle (∧)'], ['square', 'Square (⊓)']] },
    { key: 'hz', label: 'Frequency', kind: 'select', options: [[0.5, '0.5 Hz'], [1, '1 Hz'], [2, '2 Hz'], [5, '5 Hz'], [10, '10 Hz'], [20, '20 Hz'], [50, '50 Hz'], [100, '100 Hz'], [500, '500 Hz'], [1000, '1 kHz']], custom: { unit: 'Hz', min: 0.1, max: 100000 } },
    { key: 'vpp', label: 'Amplitude (Vpp)', kind: 'select', options: [[1, '1.0 Vpp'], [2, '2.0 Vpp'], [5, '5.0 Vpp'], [10, '10.0 Vpp'], [20, '20.0 Vpp']], custom: { unit: 'Vpp', min: 0.1, max: 20 } },
    { key: 'offsetOn', label: 'DC Offset', kind: 'select', options: [[false, 'OFF (0 V)'], [true, 'ON']] },
    { key: 'offset', label: 'Offset Voltage (V)', kind: 'select', options: [[-5, '-5.0 V'], [-2.5, '-2.5 V'], [0, '0.0 V'], [2.5, '+2.5 V'], [5, '+5.0 V']], custom: { unit: 'V', min: -10, max: 10 } },
    { key: 'symOn', label: 'Symmetry / Duty', kind: 'select', options: [[false, 'OFF (50%)'], [true, 'ON (Variable)']] },
    { key: 'duty', label: 'Duty / Symmetry (%)', kind: 'select', options: [[10, '10%'], [25, '25%'], [50, '50%'], [75, '75%'], [90, '90%']], custom: { unit: '%', min: 10, max: 90 } },
    { key: 'att20dB', label: 'Attenuator (−20 dB)', kind: 'select', options: [[false, '0 dB (×1)'], [true, '−20 dB (÷10)']] },
    { key: 'sweepOn', label: 'Frequency Sweep', kind: 'select', options: [[false, 'OFF'], [true, 'ON']] },
    { key: 'sweepStopHz', label: 'Sweep Stop Freq (Hz)', kind: 'select', options: [[20, '20 Hz'], [50, '50 Hz'], [100, '100 Hz'], [500, '500 Hz']], custom: { unit: 'Hz', min: 1, max: 50000 } },
  ],
  pins: () => [
    { x: 1, y: 0, name: 'EXT IN' },
    { x: 6, y: 0, name: 'SYNC OUT' },
    { x: 7, y: 0, name: 'SYNC GND' },
    { x: 9, y: 0, name: 'SWEEP' },
    { x: 13, y: 0, name: 'OUT+' },
    { x: 14, y: 0, name: 'OUT−' },
  ],
  links: () => [[2, 5]],
  staticLinks: true,
  bounds: () => [-0.8, -7.75, 15.8, 0.95],
  draw(g, part, env) {
    drawFuncGenStatic(g, env);

    const p = part.props;
    const on = !!p.power;
    const hz = Math.max(0.1, +p.hz || 10);
    const vppEff = Math.max(0.1, +p.vpp || 5) * (p.att20dB ? 0.1 : 1);

    // POWER green pushbutton
    rr(g, 0.3 * U, -5.85 * U, 1.1 * U, 0.72 * U, 3);
    g.fillStyle = on ? '#16a34a' : '#374151'; g.fill();
    g.strokeStyle = '#111827'; g.lineWidth = 1; g.stroke();

    // LCD digital readout (high-contrast crisp sizes)
    const hzTxt = hz >= 1000 ? `${+(hz / 1000).toFixed(2)}k` : `${+hz.toFixed(1)}`;
    const waveGlyph = p.wave === 'tri' ? '∧' : p.wave === 'square' ? '⊓' : '∿';
    text(g, env, on ? `${hzTxt} Hz` : 'OFF', 3.8 * U, -5.35 * U, { size: 13.5, color: on ? '#86efac' : '#1b4332', weight: 800, font: MONO });
    text(g, env, on ? `${waveGlyph} ${vppEff.toFixed(1)}Vpp` : '', 3.8 * U, -4.65 * U, { size: 8.2, color: '#bbf7d0', weight: 700, font: MONO });

    // Main FREQUENCY & secondary knobs (clean spacing with zero overlap)
    const logFrac = Math.max(0, Math.min(1, Math.log10(Math.max(0.5, hz) / 0.5) / Math.log10(20000)));
    const ang = (f) => -Math.PI * 1.25 + f * Math.PI * 1.5;
    drawKnob(g, 3.7 * U, -2.55 * U, 16, ang(logFrac), '#fde68a', '#57534e');
    drawKnob(g, 8.4 * U, -5.15 * U, 12, ang(((+p.duty || 50) - 10) / 80), '#fde68a', '#57534e');
    drawKnob(g, 10.1 * U, -5.15 * U, 12, ang(((+p.offset || 0) + 10) / 20), '#fde68a', '#57534e');
    drawKnob(g, 11.95 * U, -5.15 * U, 10, ang(0.35), '#fde68a', '#57534e');
    drawKnob(g, 13.95 * U, -5.15 * U, 10, ang(Math.min(1, (+p.sweepStopHz || 50) / 1000)), '#fde68a', '#57534e');
    drawKnob(g, 12.35 * U, -2.75 * U, 12, ang((+p.vpp || 5) / 20), '#fde68a', '#57534e');

    // Toggle pushbuttons (SYM ON, OFFSET ON, SWEEP ON, -20dB)
    const drawBtn = (bx, by, w, h2, active, lbl) => {
      rr(g, bx - w / 2, by - h2 / 2, w, h2, 2.5);
      g.fillStyle = active ? '#fbbf24' : '#fef3c7'; g.fill();
      g.strokeStyle = '#44403c'; g.lineWidth = 1; g.stroke();
      if (lbl) text(g, env, lbl, bx, by, { size: 7, color: '#111827', weight: 800, font: MONO });
    };
    drawBtn(8.4 * U, -3.95 * U, 18, 12, !!p.symOn, 'ON');
    drawBtn(10.1 * U, -3.95 * U, 18, 12, !!p.offsetOn, 'ON');
    drawBtn(12.95 * U, -3.95 * U, 24, 12, !!p.sweepOn, 'SWP');
    drawBtn(14.1 * U, -2.75 * U, 20, 14, !!p.att20dB, '−20');

    // Waveform selector buttons (Sine, Triangle, Square — cleanly separated from AMP knob)
    drawBtn(8.9 * U, -2.65 * U, 15, 14, p.wave === 'sine', '∿');
    drawBtn(9.8 * U, -2.65 * U, 15, 14, p.wave === 'tri', '∧');
    drawBtn(10.7 * U, -2.65 * U, 15, 14, p.wave === 'square', '⊓');
  },
  control(part, l) {
    if (l.x >= 12.0 && l.x <= 15.2 && l.y >= -7.5 && l.y <= -6.6) return 'inst:panel';
    if (l.x >= 0.2 && l.x <= 1.6 && l.y >= -6.0 && l.y <= -4.9) return 'inst:power';
    if (Math.hypot(l.x - 6.6, l.y + 5.55) <= 0.45) return 'inst:range+';
    if (Math.hypot(l.x - 6.6, l.y + 4.8) <= 0.45) return 'inst:range-';
    if (Math.hypot(l.x - 8.9, l.y + 2.65) <= 0.45) return 'inst:wave:sine';
    if (Math.hypot(l.x - 9.8, l.y + 2.65) <= 0.45) return 'inst:wave:tri';
    if (Math.hypot(l.x - 10.7, l.y + 2.65) <= 0.45) return 'inst:wave:square';
    if (Math.hypot(l.x - 8.4, l.y + 3.95) <= 0.5) return 'inst:sym';
    if (Math.hypot(l.x - 10.1, l.y + 3.95) <= 0.5) return 'inst:offset';
    if (Math.hypot(l.x - 14.1, l.y + 2.75) <= 0.55) return 'inst:att20';
    if (Math.hypot(l.x - 12.95, l.y + 3.95) <= 0.6) return 'inst:sweep';
    if (Math.hypot(l.x - 3.7, l.y + 2.55) <= 1.0) return 'knob:hz:0.5:10000:log';
    if (Math.hypot(l.x - 8.4, l.y + 5.15) <= 0.72) return 'knob:duty:10:90';
    if (Math.hypot(l.x - 10.1, l.y + 5.15) <= 0.72) return 'knob:offset:-10:10';
    if (Math.hypot(l.x - 12.35, l.y + 2.75) <= 0.85) return 'knob:vpp:0.2:20';
    return null;
  },
  click(part, ctrl) {
    const p = part.props;
    if (ctrl === 'inst:power') { p.power = !p.power; return true; }
    if (ctrl.startsWith('inst:wave:')) { p.wave = ctrl.slice(10); return true; }
    if (ctrl === 'inst:sym') { p.symOn = !p.symOn; return true; }
    if (ctrl === 'inst:offset') { p.offsetOn = !p.offsetOn; if (p.offsetOn && !p.offset) p.offset = 2.5; return true; }
    if (ctrl === 'inst:att20') { p.att20dB = !p.att20dB; return true; }
    if (ctrl === 'inst:sweep') { p.sweepOn = !p.sweepOn; return true; }
    if (ctrl === 'inst:range+' || ctrl === 'inst:range-') {
      const f = ctrl.endsWith('+') ? 10 : 0.1;
      p.hz = Math.max(0.1, Math.min(100000, +((+p.hz || 10) * f).toPrecision(4)));
      return true;
    }
    if (ctrl === 'inst:freq-' || ctrl === 'inst:freq+') { p.hz = cycleList(FG_HZ_STEPS, +p.hz || 10, ctrl.endsWith('+') ? 1 : -1); return true; }
    if (ctrl === 'inst:vpp-' || ctrl === 'inst:vpp+') { p.vpp = cycleList(FG_VPP_STEPS, +p.vpp || 5, ctrl.endsWith('+') ? 1 : -1); return true; }
    return false;
  },
  device(part, nets, e) {
    const outP = nets[4], outM = nets[5], syncNet = nets[1], extIn = nets[0];
    const minusConn = !e || e.isNetConnected(outM);
    let vOut = 0, vSync = 0, instHz = +part.props.hz || 10, extFreq = 0;
    let lastExtHi = false, lastRise = -1;

    return {
      timeDependent: !e || e.isNetConnected(outP) || e.isNetConnected(syncNet),
      vOut: 0,
      vSync: 0,
      instHz: 10,
      extFreq: 0,
      reset() { vOut = 0; vSync = 0; lastExtHi = false; lastRise = -1; extFreq = 0; },
      begin(eng) {
        const p = part.props;
        if (!p.power) { vOut = 0; vSync = 0; this.vOut = 0; this.vSync = 0; return; }
        const baseHz = Math.max(0.1, +p.hz || 10);
        if (p.sweepOn) {
          const stopHz = Math.max(baseHz, +p.sweepStopHz || 50);
          const rate = Math.max(0.1, +p.sweepRate || 1);
          const swU = (eng.time * rate) % 1;
          instHz = baseHz + (stopHz - baseHz) * swU;
        } else {
          instHz = baseHz;
        }
        this.instHz = instHz;
        const phi = ((eng.time * instHz) % 1 + 1) % 1;
        const sym = p.symOn ? Math.max(0.1, Math.min(0.9, (+p.duty || 50) / 100)) : 0.5;
        let norm = 0;
        if (p.wave === 'tri') {
          const u = phi < sym ? 0.5 * (phi / sym) : 0.5 + 0.5 * ((phi - sym) / (1 - sym));
          norm = u < 0.25 ? u * 4 : u < 0.75 ? 2 - u * 4 : u * 4 - 4;
        } else if (p.wave === 'square') {
          norm = phi < sym ? 1 : -1;
        } else {
          const u = phi < sym ? 0.5 * (phi / sym) : 0.5 + 0.5 * ((phi - sym) / (1 - sym));
          norm = Math.sin(TAU * u);
        }
        const amp = (Math.max(0.1, +p.vpp || 5) / 2) * (p.att20dB ? 0.1 : 1);
        const dc = p.offsetOn ? (+p.offset || 0) : 0;
        vOut = dc + norm * amp;
        vSync = phi < sym ? 5 : 0;
        this.vOut = vOut;
        this.vSync = vSync;
        eng.maxHz = Math.max(eng.maxHz, Math.min(instHz, 50000));
      },
      stamp(S) {
        if (!part.props.power) {
          if (outP >= 0) S.src(outP, 0, 50);
          if (syncNet >= 0) S.src(syncNet, 0, 30);
          if (outM >= 0 && !minusConn) S.src(outM, 0, 0.05);
          return;
        }
        if (minusConn) {
          if (outP >= 0 && outM >= 0) {
            S.vdrop(outP, outM, vOut, 50);
            S.anchor(outM);
          }
          if (syncNet >= 0) {
            if (outM >= 0) { S.vdrop(syncNet, outM, vSync, 30); S.anchor(outM); }
            else S.src(syncNet, vSync, 30);
          }
        } else {
          if (outP >= 0) S.src(outP, vOut, 50);
          if (outM >= 0) S.src(outM, 0, 0.05);
          if (syncNet >= 0) S.src(syncNet, vSync, 30);
        }
      },
      commit(V, dt, eng) {
        if (extIn >= 0 && ok(V[extIn])) {
          const vm = outM >= 0 && ok(V[outM]) ? V[outM] : 0;
          const v = V[extIn] - vm;
          const hi = lastExtHi ? v > 1.2 : v > 2.2;
          if (!lastExtHi && hi) {
            if (lastRise >= 0 && eng.time > lastRise) {
              extFreq = 1 / (eng.time - lastRise);
              this.extFreq = extFreq;
            }
            lastRise = eng.time;
          }
          lastExtHi = hi;
        }
      },
    };
  },
});

// 3. Digital Storage Oscilloscope — UNI-T UT2062B --------------------------
const SCOPE_VDIV = [0.1, 0.2, 0.5, 1, 2, 5, 10];
const SCOPE_TDIV = [0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5];
const SCOPE_BUF_CAP = 4096;

function fmtUnits(v, unit) {
  const a = Math.abs(v);
  if (!Number.isFinite(v)) return '--';
  if (a === 0) return `0 ${unit}`;
  if (a >= 1000) return `${(v / 1000).toFixed(2)}k${unit}`;
  if (a >= 1) return `${v.toFixed(2)}${unit}`;
  if (a >= 1e-3) return `${(v * 1e3).toFixed(1)}m${unit}`;
  return `${(v * 1e6).toFixed(0)}u${unit}`;
}

function drawScopeStatic(g, env) {
  // Vector-sharp UNI-T charcoal body (extended top & bottom margins so PANEL badge and BNC jacks never touch borders)
  rr(g, -0.6 * U + 2, -10.8 * U + 3, 25.2 * U, 11.7 * U, 8);
  g.fillStyle = 'rgba(0,0,0,0.24)'; g.fill();
  rr(g, -0.6 * U, -10.8 * U, 25.2 * U, 11.7 * U, 8);
  g.fillStyle = lin(g, 0, -10.8 * U, 0, 0.9 * U, [[0, '#5a605d'], [0.5, '#464b49'], [1, '#363a38']]);
  g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 1.4; g.stroke();

  // Brand header, model label & PANEL badge (well clear of -9.45*U panel border)
  rr(g, -0.1 * U, -10.48 * U, 2.7 * U, 0.65 * U, 3);
  g.fillStyle = '#dc2626'; g.fill();
  text(g, env, 'UNI-T', 1.25 * U, -10.16 * U, { size: 9, color: '#ffffff', weight: 900, font: MONO });
  text(g, env, 'UT2062B  60MHz DSO', 7.35 * U, -10.16 * U, { size: 8.5, color: '#f1f5f9', weight: 800, font: MONO });
  drawPanelBadge(g, env, 21.15 * U, -10.52 * U, 56, 15);

  // Outer recessed bezel around screen
  rr(g, 0.3 * U, -9.45 * U, 11.15 * U, 8.1 * U, 6);
  g.fillStyle = '#262a29'; g.fill();
  g.strokeStyle = '#141716'; g.lineWidth = 1.4; g.stroke();

  // Softkeys F1..F5 column
  for (let i = 0; i < 5; i++) {
    const fy = (-8.1 + i * 1.48) * U;
    rr(g, 11.7 * U, fy - 8, 20, 16, 3);
    g.fillStyle = '#cbd5e1'; g.fill();
    g.strokeStyle = '#334155'; g.lineWidth = 0.8; g.stroke();
    text(g, env, 'F' + (i + 1), 12.2 * U, fy, { size: 7.5, color: '#0f172a', weight: 900, font: MONO });
  }

  // Right control panel backdrop
  rr(g, 13.0 * U, -9.45 * U, 11.15 * U, 8.1 * U, 5);
  g.fillStyle = '#525856'; g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.14)'; g.lineWidth = 1; g.stroke();

  text(g, env, 'VERT', 15.6 * U, -6.4 * U, { size: 7.8, color: '#f8fafc', weight: 900, font: MONO });
  text(g, env, 'HORIZ', 19.6 * U, -6.4 * U, { size: 7.8, color: '#f8fafc', weight: 900, font: MONO });
  text(g, env, 'TRIG', 22.8 * U, -6.4 * U, { size: 7.8, color: '#f8fafc', weight: 900, font: MONO });

  // Bottom BNC connector labels & jacks (centered in dedicated bottom deck)
  const jacks = [
    [14, 'CH1+'], [15, 'GND'], [17, 'CH2+'], [18, 'GND'], [20, 'EXT'], [21, 'GND'],
  ];
  for (const [jx, lbl] of jacks) {
    text(g, env, lbl, jx * U, -0.82 * U, { size: 7.2, color: '#f8fafc', weight: 900, font: MONO });
    drawBncPort(g, jx * U, 0);
  }
  text(g, env, '1kHz', 23.0 * U, -0.82 * U, { size: 7.2, color: '#fde047', weight: 900, font: MONO });
  text(g, env, 'GND', 24.0 * U, -0.82 * U, { size: 7.2, color: '#e2e8f0', weight: 900, font: MONO });
  drawBananaSocket(g, 23 * U, 0, '#f59e0b');
  drawBananaSocket(g, 24 * U, 0, '#1f2937');
}

function computeScopeWindow(d, timeDiv) {
  const span = timeDiv * 10;
  const cap = d.cap, count = d.count;
  if (count < 2) return null;
  const idxAt = (k) => (d.head - count + k + cap) % cap;
  const tLatest = d.bufT[idxAt(count - 1)];
  const trigArr = d.trigSrc === 'CH2' ? d.buf2 : d.trigSrc === 'EXT' ? d.bufTrig : d.buf1;
  let trigOffset = 0;
  if (d.coupling === 'AC' && d.trigSrc !== 'EXT') {
    let sum = 0, n = 0;
    const minT = tLatest - span * 1.5;
    for (let k = count - 1; k >= 0; k--) {
      const i = idxAt(k);
      if (d.bufT[i] < minT) break;
      const v = trigArr[i];
      if (ok(v)) { sum += v; n++; }
    }
    if (n) trigOffset = sum / n;
  }
  const tFirst = d.bufT[idxAt(0)];
  const lvl = d.trigLevel + trigOffset;
  let trigT = NaN;
  const searchHi = tLatest - span * 0.5;
  const searchLo = Math.max(tLatest - span * 1.5, tFirst + span * 0.5);
  for (let k = count - 2; k >= 1; k--) {
    const i1 = idxAt(k), i0 = idxAt(k - 1);
    const t1 = d.bufT[i1];
    if (t1 > searchHi) continue;
    if (t1 < searchLo) break;
    const v0 = trigArr[i0], v1 = trigArr[i1];
    if (ok(v0) && ok(v1) && v0 < lvl && v1 >= lvl) {
      const frac = (lvl - v0) / Math.max(1e-9, v1 - v0);
      trigT = d.bufT[i0] + frac * (t1 - d.bufT[i0]);
      break;
    }
  }
  const triggered = Number.isFinite(trigT);
  const tEnd = triggered ? trigT + span * 0.5 : tLatest;
  const tStart = tEnd - span;
  return { tStart, tEnd, span, triggered, idxAt, count };
}

function measureChannelStats(d, arr, win) {
  let min = Infinity, max = -Infinity, sum = 0, n = 0;
  for (let k = 0; k < win.count; k++) {
    const idx = win.idxAt(k);
    const t = d.bufT[idx];
    if (t < win.tStart || t > win.tEnd) continue;
    const v = arr[idx];
    if (!ok(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    n++;
  }
  if (!n) return { valid: false, vpp: 0, vavg: 0, min: 0, max: 0, freq: 0 };
  const vpp = max - min, mid = (min + max) * 0.5, hyst = Math.max(0.05, vpp * 0.15);
  let cross0 = -1, crossLast = -1, cycles = 0, armed = false;
  for (let k = 0; k < win.count; k++) {
    const idx = win.idxAt(k);
    const t = d.bufT[idx];
    if (t < win.tStart || t > win.tEnd) continue;
    const v = arr[idx];
    if (!ok(v)) continue;
    if (!armed && v < mid - hyst) armed = true;
    else if (armed && v > mid + hyst) {
      armed = false;
      if (cross0 < 0) cross0 = t;
      else cycles++;
      crossLast = t;
    }
  }
  const freq = cycles > 0 && crossLast > cross0 ? cycles / (crossLast - cross0) : 0;
  return { valid: true, vpp, vavg: sum / n, min, max, freq };
}

register({
  type: 'oscilloscope',
  name: 'UT2062B Oscilloscope',
  short: 'UT2062B',
  title: 'Dual-Channel Digital Storage Oscilloscope (60MHz 500MS/s + 1kHz Probe Comp)',
  cat: 'Instruments',
  aliases: ['ut2062b', 'uni-t-ut2062b', 'dso'],
  desc: 'Dual-channel benchtop oscilloscope with rising-edge trigger, DC/AC coupling, auto-scale (AUTO), live Vpp/Vavg/Frequency measurements, Math (CH1−CH2 / CH1+CH2), X-Y Lissajous mode, and 3 V 1 kHz Probe Comp.',
  defaults: { run: true, ch1On: true, ch2On: true, ch1Scale: 2, ch2Scale: 2, ch1Pos: 0, ch2Pos: 0, timeDiv: 0.05, coupling: 'DC', trigSrc: 'CH1', trigLevel: 1.5, measure: true, math: 'off', xyMode: false },
  fields: [
    { key: 'run', label: 'Acquisition', kind: 'select', options: [[true, 'RUN'], [false, 'STOP (Hold)']] },
    { key: 'ch1On', label: 'Channel 1 (Yellow)', kind: 'select', options: [[true, 'ON'], [false, 'OFF']] },
    { key: 'ch1Scale', label: 'CH1 Volts/Div', kind: 'select', options: [[0.1, '100 mV/div'], [0.2, '200 mV/div'], [0.5, '500 mV/div'], [1, '1.0 V/div'], [2, '2.0 V/div'], [5, '5.0 V/div'], [10, '10.0 V/div']] },
    { key: 'ch2On', label: 'Channel 2 (Cyan)', kind: 'select', options: [[true, 'ON'], [false, 'OFF']] },
    { key: 'ch2Scale', label: 'CH2 Volts/Div', kind: 'select', options: [[0.1, '100 mV/div'], [0.2, '200 mV/div'], [0.5, '500 mV/div'], [1, '1.0 V/div'], [2, '2.0 V/div'], [5, '5.0 V/div'], [10, '10.0 V/div']] },
    { key: 'timeDiv', label: 'Timebase (Sec/Div)', kind: 'select', options: [[0.0005, '500 µs/div'], [0.001, '1 ms/div'], [0.002, '2 ms/div'], [0.005, '5 ms/div'], [0.01, '10 ms/div'], [0.02, '20 ms/div'], [0.05, '50 ms/div'], [0.1, '100 ms/div'], [0.2, '200 ms/div'], [0.5, '500 ms/div']] },
    { key: 'coupling', label: 'Input Coupling', kind: 'select', options: [['DC', 'DC'], ['AC', 'AC (Block DC)']] },
    { key: 'trigSrc', label: 'Trigger Source', kind: 'select', options: [['CH1', 'CH1'], ['CH2', 'CH2'], ['EXT', 'EXT TRIG']] },
    { key: 'trigLevel', label: 'Trigger Level (V)', kind: 'select', options: [[0, '0.0 V'], [0.5, '0.5 V'], [1.5, '1.5 V'], [2.5, '2.5 V'], [5, '5.0 V']], custom: { unit: 'V', min: -25, max: 25 } },
    { key: 'measure', label: 'Measurements', kind: 'select', options: [[true, 'Show Vpp / Freq'], [false, 'Hidden']] },
    { key: 'math', label: 'Math Trace', kind: 'select', options: [['off', 'OFF'], ['sub', 'CH1 − CH2'], ['add', 'CH1 + CH2']] },
    { key: 'xyMode', label: 'Display Mode', kind: 'select', options: [[false, 'Y-T (Timebase)'], [true, 'X-Y (Lissajous)']] },
  ],
  pins: () => [
    { x: 14, y: 0, name: 'CH1+' },
    { x: 15, y: 0, name: 'CH1 GND' },
    { x: 17, y: 0, name: 'CH2+' },
    { x: 18, y: 0, name: 'CH2 GND' },
    { x: 20, y: 0, name: 'EXT TRIG' },
    { x: 21, y: 0, name: 'TRIG GND' },
    { x: 23, y: 0, name: 'COMP 1kHz' },
    { x: 24, y: 0, name: 'COMP GND' },
  ],
  links: () => [[1, 3], [3, 5], [5, 7]],
  staticLinks: true,
  bounds: () => [-0.8, -10.95, 24.8, 0.95],
  draw(g, part, env) {
    drawScopeStatic(g, env);

    const p = part.props;
    const d = env.dev;

    // Live TFT Screen region
    const sx = 0.55 * U, sy = -9.15 * U, sw = 10.65 * U, sh = 7.6 * U;
    const plotW = sw * 0.84, plotH = sh - 30;
    const px0 = sx + 2, py0 = sy + 15;
    rr(g, sx, sy, sw, sh, 3);
    g.fillStyle = '#070b10'; g.fill();
    g.strokeStyle = '#1f2937'; g.lineWidth = 1.2; g.stroke();

    // 10×8 Graticule grid inside plot area
    g.strokeStyle = 'rgba(148,163,184,0.2)'; g.lineWidth = 0.8;
    g.beginPath();
    for (let i = 0; i <= 10; i++) { const gx = px0 + (i / 10) * plotW; g.moveTo(gx, py0); g.lineTo(gx, py0 + plotH); }
    for (let j = 0; j <= 8; j++) { const gy = py0 + (j / 8) * plotH; g.moveTo(px0, gy); g.lineTo(px0 + plotW, gy); }
    g.stroke();

    // Right softkey labels inside TFT matching F1..F5
    g.fillStyle = '#111827';
    g.fillRect(px0 + plotW + 2, sy + 2, sw - plotW - 6, sh - 4);
    const softs = [p.coupling || 'DC', p.ch1On ? 'CH1' : 'OFF', p.ch2On ? 'CH2' : 'OFF', (p.math || 'off').toUpperCase(), p.xyMode ? 'X-Y' : 'Y-T'];
    for (let i = 0; i < 5; i++) {
      const ly = sy + 16 + i * ((sh - 20) / 5);
      text(g, env, softs[i], px0 + plotW + (sw - plotW) * 0.5, ly, { size: 7.2, color: '#f1f5f9', weight: 800, font: MONO });
    }

    // Waveform Traces (crisp 2.2px stroke so traces stay bright when zoomed out)
    const timeDiv = Math.max(0.0001, +p.timeDiv || 0.05);
    const s1 = Math.max(0.05, +p.ch1Scale || 2), s2 = Math.max(0.05, +p.ch2Scale || 2);
    const win = d ? computeScopeWindow(d, timeDiv) : null;
    let st1 = null, st2 = null;

    if (win) {
      const ac = p.coupling === 'AC';
      st1 = measureChannelStats(d, d.buf1, win);
      st2 = measureChannelStats(d, d.buf2, win);
      const off1 = ac && st1.valid ? st1.vavg : 0;
      const off2 = ac && st2.valid ? st2.vavg : 0;
      const midY = py0 + plotH * 0.5;
      const divH = plotH / 8;

      g.save();
      g.lineCap = 'round';
      g.lineJoin = 'round';
      if (p.xyMode && p.ch1On && p.ch2On) {
        g.strokeStyle = '#38bdf8'; g.lineWidth = 2.2; g.beginPath();
        let moved = false;
        for (let k = 0; k < win.count; k++) {
          const idx = win.idxAt(k), t = d.bufT[idx];
          if (t < win.tStart || t > win.tEnd) continue;
          const v1 = d.buf1[idx] - off1, v2 = d.buf2[idx] - off2;
          if (!ok(v1) || !ok(v2)) { moved = false; continue; }
          const x = px0 + plotW * 0.5 + (v1 / s1) * (plotW / 10);
          const y = Math.max(py0, Math.min(py0 + plotH, midY - (v2 / s2) * divH));
          if (!moved) { g.moveTo(x, y); moved = true; } else g.lineTo(x, y);
        }
        g.stroke();
      } else {
        const plotArr = (getVal, color) => {
          g.strokeStyle = color; g.lineWidth = 2.2; g.beginPath();
          let moved = false;
          for (let k = 0; k < win.count; k++) {
            const idx = win.idxAt(k), t = d.bufT[idx];
            if (t < win.tStart || t > win.tEnd) continue;
            const v = getVal(idx);
            if (!ok(v)) { moved = false; continue; }
            const x = px0 + ((t - win.tStart) / win.span) * plotW;
            const y = Math.max(py0 + 1, Math.min(py0 + plotH - 1, midY - v * divH));
            if (!moved) { g.moveTo(x, y); moved = true; } else g.lineTo(x, y);
          }
          g.stroke();
        };
        const pos1 = +p.ch1Pos || 0, pos2 = +p.ch2Pos || 0;
        if (p.ch1On) plotArr((i) => (d.buf1[i] - off1) / s1 + pos1, '#facc15');
        if (p.ch2On) plotArr((i) => (d.buf2[i] - off2) / s2 + pos2, '#22d3ee');
        if (p.math && p.math !== 'off') {
          const sign = p.math === 'add' ? 1 : -1;
          plotArr((i) => ((d.buf1[i] - off1) + sign * (d.buf2[i] - off2)) / s1, '#e879f9');
        }
      }
      g.restore();
    }

    // Screen top status bar
    const trigState = !p.run ? 'STOP' : (win && win.triggered ? "Trig'd" : 'Auto');
    text(g, env, trigState, sx + 22, sy + 8, { size: 7.5, color: !p.run ? '#ef4444' : '#4ade80', weight: 800, font: MONO });
    text(g, env, `M ${fmtUnits(timeDiv, 's')}`, sx + 82, sy + 8, { size: 7.5, color: '#f1f5f9', weight: 800, font: MONO });
    text(g, env, `${p.trigSrc || 'CH1'}:${(+p.trigLevel || 0).toFixed(1)}V`, sx + plotW - 28, sy + 8, { size: 7, color: '#fb923c', weight: 800, font: MONO });

    // Screen bottom badges & auto measurements
    text(g, env, `1:${fmtUnits(s1, 'V')}`, sx + 30, sy + sh - 7, { size: 7.5, color: p.ch1On ? '#facc15' : '#64748b', weight: 800, font: MONO });
    text(g, env, `2:${fmtUnits(s2, 'V')}`, sx + 88, sy + sh - 7, { size: 7.5, color: p.ch2On ? '#22d3ee' : '#64748b', weight: 800, font: MONO });
    if (p.measure && st1 && st1.valid) {
      const mStr = st1.freq > 0 ? `${st1.vpp.toFixed(1)}V ${fmtUnits(st1.freq, 'Hz')}` : `avg:${st1.vavg.toFixed(1)}V`;
      text(g, env, mStr, sx + plotW - 38, sy + sh - 7, { size: 7.2, color: '#facc15', weight: 800, font: MONO });
    }

    // Dynamic control buttons & knobs on right panel
    const btn = (bx, by, bw, bh, bg, label, tc = '#0f172a') => {
      rr(g, bx - bw / 2, by - bh / 2, bw, bh, 3);
      g.fillStyle = bg; g.fill(); g.strokeStyle = '#1e293b'; g.lineWidth = 1; g.stroke();
      text(g, env, label, bx, by, { size: 7, color: tc, weight: 800, font: MONO });
    };
    btn(20.6 * U, -8.7 * U, 28, 15, '#cbd5e1', 'MEAS');
    btn(23.1 * U, -8.7 * U, 30, 15, p.run ? '#4ade80' : '#f87171', p.run ? 'RUN' : 'STOP');
    btn(23.1 * U, -7.65 * U, 30, 15, '#e2e8f0', 'AUTO');
    btn(14.0 * U, -5.6 * U, 26, 15, p.ch1On ? '#fde047' : '#94a3b8', 'CH1');
    btn(14.0 * U, -4.65 * U, 26, 15, p.ch2On ? '#67e8f9' : '#94a3b8', 'CH2');
    btn(14.0 * U, -3.7 * U, 26, 15, p.math !== 'off' ? '#e879f9' : '#94a3b8', 'MATH');
    btn(22.8 * U, -3.75 * U, 26, 14, '#cbd5e1', '50%');

    const s1Idx = SCOPE_VDIV.indexOf(s1), tIdx = SCOPE_TDIV.indexOf(timeDiv);
    const tlFrac = Math.max(0, Math.min(1, ((+p.trigLevel || 0) + 15) / 30));
    drawKnob(g, 16.9 * U, -3.2 * U, 15, -Math.PI * 1.2 + ((s1Idx >= 0 ? s1Idx : 4) / 6) * Math.PI * 1.4);
    drawKnob(g, 19.9 * U, -3.2 * U, 15, -Math.PI * 1.2 + ((tIdx >= 0 ? tIdx : 6) / 9) * Math.PI * 1.4);
    drawKnob(g, 22.8 * U, -5.1 * U, 11.5, -Math.PI * 1.2 + tlFrac * Math.PI * 1.4);
  },
  control(part, l) {
    if (l.x >= 21.0 && l.x <= 24.3 && l.y >= -10.65 && l.y <= -9.65) return 'inst:panel';
    if (l.x >= 22.3 && l.x <= 23.9 && l.y >= -9.15 && l.y <= -8.25) return 'inst:run';
    if (l.x >= 22.3 && l.x <= 23.9 && l.y >= -8.05 && l.y <= -7.2) return 'inst:auto';
    if (l.x >= 19.8 && l.x <= 21.4 && l.y >= -9.15 && l.y <= -8.25) return 'inst:meas';
    if (l.x >= 13.3 && l.x <= 14.7 && l.y >= -6.0 && l.y <= -5.2) return 'inst:ch1';
    if (l.x >= 13.3 && l.x <= 14.7 && l.y >= -5.05 && l.y <= -4.25) return 'inst:ch2';
    if (l.x >= 13.3 && l.x <= 14.7 && l.y >= -4.1 && l.y <= -3.3) return 'inst:math';
    if (l.x >= 22.1 && l.x <= 23.5 && l.y >= -4.15 && l.y <= -3.35) return 'inst:trig50';
    // F1..F5 softkeys
    if (l.x >= 11.6 && l.x <= 12.8) {
      if (Math.abs(l.y + 8.1) <= 0.45) return 'inst:cpl';
      if (Math.abs(l.y + 6.62) <= 0.45) return 'inst:ch1';
      if (Math.abs(l.y + 5.14) <= 0.45) return 'inst:ch2';
      if (Math.abs(l.y + 3.66) <= 0.45) return 'inst:math';
      if (Math.abs(l.y + 2.18) <= 0.45) return 'inst:xy';
    }
    if (Math.hypot(l.x - 16.9, l.y + 3.2) <= 0.9) return 'knob:ch1Scale:0:6:vdiv';
    if (Math.hypot(l.x - 19.9, l.y + 3.2) <= 0.9) return 'knob:timeDiv:0:9:tdiv';
    if (Math.hypot(l.x - 22.8, l.y + 5.1) <= 0.8) return 'knob:trigLevel:-15:15';
    return null;
  },
  click(part, ctrl, app) {
    const p = part.props;
    if (ctrl === 'inst:run') { p.run = !p.run; return true; }
    if (ctrl === 'inst:meas') { p.measure = !p.measure; return true; }
    if (ctrl === 'inst:ch1') { p.ch1On = !p.ch1On; return true; }
    if (ctrl === 'inst:ch2') { p.ch2On = !p.ch2On; return true; }
    if (ctrl === 'inst:cpl') { p.coupling = p.coupling === 'AC' ? 'DC' : 'AC'; return true; }
    if (ctrl === 'inst:math') { p.math = p.math === 'off' ? 'sub' : p.math === 'sub' ? 'add' : 'off'; return true; }
    if (ctrl === 'inst:xy') { p.xyMode = !p.xyMode; return true; }
    if (ctrl === 'inst:vdiv-' || ctrl === 'inst:vdiv+') {
      const s = cycleList(SCOPE_VDIV, +p.ch1Scale || 2, ctrl.endsWith('+') ? 1 : -1);
      p.ch1Scale = s; p.ch2Scale = s;
      return true;
    }
    if (ctrl === 'inst:tdiv-' || ctrl === 'inst:tdiv+') {
      p.timeDiv = cycleList(SCOPE_TDIV, +p.timeDiv || 0.05, ctrl.endsWith('+') ? 1 : -1);
      return true;
    }
    if (ctrl === 'inst:trig50') {
      const d = (app && app.engine.byPart.get(part.id)?.device) || part.ui?._dev;
      if (d) {
        const win = computeScopeWindow(d, +p.timeDiv || 0.05);
        if (win) {
          const st = measureChannelStats(d, p.trigSrc === 'CH2' ? d.buf2 : d.buf1, win);
          if (st.valid) p.trigLevel = p.coupling === 'AC' ? 0 : +((st.min + st.max) * 0.5).toFixed(2);
        }
      }
      return true;
    }
    if (ctrl === 'inst:auto') {
      const d = (app && app.engine.byPart.get(part.id)?.device) || part.ui?._dev;
      if (d) d.autoScale(p);
      return true;
    }
    return false;
  },
  device(part, nets, e) {
    const cap = SCOPE_BUF_CAP;
    const bufT = new Float64Array(cap);
    const buf1 = new Float32Array(cap);
    const buf2 = new Float32Array(cap);
    const bufTrig = new Float32Array(cap);
    const compNet = nets[6], compGnd = nets[7];
    const compConnected = !e || e.isNetConnected(compNet);
    const minusConnected = !e || e.isNetConnected(nets[1]);
    let compHigh = false;

    const d = {
      timeDependent: compConnected,
      cap,
      bufT,
      buf1,
      buf2,
      bufTrig,
      head: 0,
      count: 0,
      coupling: part.props.coupling || 'DC',
      trigSrc: part.props.trigSrc || 'CH1',
      trigLevel: +part.props.trigLevel || 1.5,
      stats1: { valid: false, vpp: 0, vavg: 0, min: 0, max: 0, freq: 0 },
      stats2: { valid: false, vpp: 0, vavg: 0, min: 0, max: 0, freq: 0 },
      reset() {
        this.head = 0; this.count = 0;
        buf1.fill(NaN); buf2.fill(NaN); bufTrig.fill(NaN);
        this.stats1.valid = this.stats2.valid = false;
      },
      begin(eng) {
        this.coupling = part.props.coupling || 'DC';
        this.trigSrc = part.props.trigSrc || 'CH1';
        this.trigLevel = +part.props.trigLevel || 1.5;
        if (compConnected) {
          compHigh = ((eng.time * 1000) % 1) < 0.5;
          eng.maxHz = Math.max(eng.maxHz, 500);
        }
      },
      stamp(S) {
        if (compConnected && compNet >= 0) {
          if (minusConnected && compGnd >= 0) {
            S.vdrop(compNet, compGnd, compHigh ? 3 : 0, 50);
            S.anchor(compGnd);
          } else {
            S.src(compNet, compHigh ? 3 : 0, 50);
            if (compGnd >= 0) S.src(compGnd, 0, 0.05);
          }
        }
      },
      commit(V, dt, eng) {
        if (part.props.run === false) return;
        const vgnd = nets[1] >= 0 && ok(V[nets[1]]) ? V[nets[1]] : 0;
        const v1 = nets[0] >= 0 && ok(V[nets[0]]) ? V[nets[0]] - vgnd : NaN;
        const v2 = nets[2] >= 0 && ok(V[nets[2]]) ? V[nets[2]] - vgnd : NaN;
        const vt = nets[4] >= 0 && ok(V[nets[4]]) ? V[nets[4]] - vgnd : NaN;
        const h = this.head;
        bufT[h] = eng.time;
        buf1[h] = v1;
        buf2[h] = v2;
        bufTrig[h] = vt;
        this.head = (h + 1) % cap;
        if (this.count < cap) this.count++;
      },
      measure() {
        const win = computeScopeWindow(this, Math.max(0.0001, +part.props.timeDiv || 0.05));
        if (!win) return { s1: this.stats1, s2: this.stats2 };
        this.stats1 = measureChannelStats(this, buf1, win);
        this.stats2 = measureChannelStats(this, buf2, win);
        return { s1: this.stats1, s2: this.stats2 };
      },
      autoScale(props = part.props) {
        if (this.count < 2) return;
        const fullWin = {
          tStart: bufT[(this.head - this.count + cap) % cap],
          tEnd: bufT[(this.head - 1 + cap) % cap],
          count: this.count,
          idxAt: (k) => (this.head - this.count + k + cap) % cap,
        };
        const st1 = measureChannelStats(this, buf1, fullWin);
        const st2 = measureChannelStats(this, buf2, fullWin);
        const pickV = (vpp) => SCOPE_VDIV.find(s => s * 6 >= Math.max(0.2, vpp)) || 10;
        if (st1.valid) {
          props.ch1Scale = pickV(st1.vpp);
          props.trigLevel = props.coupling === 'AC' ? 0 : +((st1.min + st1.max) * 0.5).toFixed(2);
        }
        if (st2.valid) props.ch2Scale = pickV(st2.vpp);
        const f = st1.freq > 0 ? st1.freq : st2.freq;
        if (f > 0) {
          const targetDiv = 0.25 / f;
          props.timeDiv = SCOPE_TDIV.find(td => td >= targetDiv * 0.8) || 0.5;
        }
      },
    };
    if (part.ui) part.ui._dev = d;
    return d;
  },
});

// ---------------------------------------------------------------- Notes ----
const NOTE_COLORS = [
  ['auto', 'Theme default'], ['#0a84ff', 'Blue'], ['#30a46c', 'Green'],
  ['#ff9f0a', 'Amber'], ['#e5484d', 'Red'], ['#8e4ec6', 'Purple'], ['#6e6e73', 'Graphite'],
];
function noteBoxMetrics(textStr, size) {
  const lines = String(textStr || ' ').split('\n');
  const maxLen = Math.max(1, ...lines.map(l => l.length));
  const wU = Math.max(1.8, (maxLen * size * 0.56) / U + 0.7);
  const lineH = (size * 1.28) / U;
  const hU = Math.max(1.1, lines.length * lineH + 0.45);
  return { lines, wU, hU, lineH };
}
function hexRgb(hex) {
  const h = String(hex || '#0a84ff').replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/./g, c => c + c) : h, 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [10, 132, 255];
}
function calloutBoxRect(props) {
  const { lines, wU, hU, lineH } = noteBoxMetrics(props.text || 'Note', 12);
  const dx = Number.isFinite(+props.dx) ? +props.dx : 4;
  const dy = Number.isFinite(+props.dy) ? +props.dy : -3;
  return { lines, wU, hU, lineH, dx, dy, x0: dx - wU / 2, y0: dy - hU / 2, x1: dx + wU / 2, y1: dy + hU / 2 };
}

register({
  type: 'label', name: 'Text Label', cat: 'Notes', desc: 'Multiline note or styled label badge. Edit text & style in the Inspector.',
  defaults: { text: 'Label', size: 14, style: 'plain', color: 'auto', align: 'left' },
  fields: [
    { key: 'text', label: 'Text', kind: 'textarea' },
    { key: 'size', label: 'Size', kind: 'select', options: [[11, 'Small'], [14, 'Medium'], [20, 'Large'], [28, 'Title']] },
    { key: 'style', label: 'Style', kind: 'select', options: [['plain', 'Plain text'], ['badge', 'Tinted badge'], ['card', 'Note card']] },
    { key: 'color', label: 'Color', kind: 'select', options: NOTE_COLORS },
    { key: 'align', label: 'Align', kind: 'select', options: [['left', 'Left'], ['center', 'Center'], ['right', 'Right']] },
  ],
  pins: () => [],
  bounds: (p) => {
    const size = +(p.size || 14);
    const { wU, hU } = noteBoxMetrics(p.text || 'Label', size);
    const xOff = p.align === 'center' ? -wU / 2 : p.align === 'right' ? -wU : 0;
    return [xOff - 0.15, -hU / 2 - 0.1, xOff + wU + 0.15, hU / 2 + 0.1];
  },
  draw(g, part, env) {
    const p = part.props;
    const size = +(p.size || 14);
    const isThumb = part.id === 'thumb';
    const style = isThumb ? 'card' : (p.style || 'plain');
    const align = p.align || 'left';
    const colOpt = p.color && p.color !== 'auto' ? p.color : (env.dark ? '#f2f2f7' : '#1d1d1f');
    const [r, gr, b] = hexRgb(p.color && p.color !== 'auto' ? p.color : '#0a84ff');
    const { lines, wU, hU, lineH } = noteBoxMetrics(isThumb ? 'Note' : (p.text || ' '), size);
    const xOff = align === 'center' ? -wU / 2 : align === 'right' ? -wU : 0;
    const bx = xOff * U, by = (-hU / 2) * U, bw = wU * U, bh = hU * U;

    if (style === 'badge') {
      rr(g, bx, by, bw, bh, 6);
      g.fillStyle = `rgba(${r},${gr},${b},${env.dark ? 0.22 : 0.12})`; g.fill();
      g.strokeStyle = `rgba(${r},${gr},${b},0.55)`; g.lineWidth = 1.25; g.stroke();
    } else if (style === 'card') {
      shadow(g, 6, 2, 0.2);
      rr(g, bx, by, bw, bh, 6);
      g.fillStyle = env.dark ? '#23262e' : '#ffffff'; g.fill();
      noShadow(g);
      g.strokeStyle = `rgba(${r},${gr},${b},0.65)`; g.lineWidth = 1.4; g.stroke();
      g.fillStyle = `rgb(${r},${gr},${b})`;
      rr(g, bx + 1, by + 2, 3.2, bh - 4, 2); g.fill();
    }

    const startY = -((lines.length - 1) * lineH * U) / 2;
    const tx = isThumb ? bx + bw / 2 : align === 'center' ? 0 : align === 'right' ? bx + bw - 0.35 * U : bx + 0.35 * U;
    const fg = style === 'plain' ? colOpt : style === 'badge' ? (p.color && p.color !== 'auto' ? (env.dark ? '#f8fafc' : colOpt) : (env.dark ? '#f2f2f7' : '#1d1d1f')) : (env.dark ? '#f2f2f7' : '#1d1d1f');
    lines.forEach((ln, i) => {
      text(g, env, ln || ' ', tx, startY + i * lineH * U, {
        size, color: fg, weight: size >= 20 || style === 'badge' ? 650 : 500, align: isThumb ? 'center' : align,
      });
    });
  },
});

register({
  type: 'netlabel', name: 'Net Flag', cat: 'Notes', desc: 'Plug onto any hole or pin to give its electrical net a signal name (e.g. CLK, SDA, OUT).',
  allowSharedPin: true,
  defaults: { text: 'CLK', color: '#0a84ff' },
  fields: [
    { key: 'text', label: 'Net name', kind: 'text' },
    { key: 'color', label: 'Color', kind: 'select', options: NOTE_COLORS.filter(([c]) => c !== 'auto') },
  ],
  pins: () => [{ x: 0, y: 0, name: 'NET' }],
  bounds: (p) => {
    const len = Math.max(2, String(p.text || 'SIG').length);
    const wU = Math.max(2.2, len * 0.42 + 1.0);
    return [-0.35, -0.58, wU + 0.45, 0.58];
  },
  draw(g, part, env) {
    const col = part.props.color && part.props.color !== 'auto' ? part.props.color : '#0a84ff';
    const [r, gr, b] = hexRgb(col);
    const txt = String(part.props.text || 'SIG').trim() || 'SIG';
    const w = Math.max(2.1, txt.length * 0.42 + 0.95) * U;
    const hh = 0.44 * U;
    // Pin connection lead & solder dot
    lead(g, 0, 0, 0.45, 0, 2);
    g.fillStyle = col; g.beginPath(); g.arc(0, 0, 3.2, 0, TAU); g.fill();
    g.strokeStyle = '#fff'; g.lineWidth = 1; g.stroke();
    // Pointed signal flag polygon
    g.save();
    shadow(g, 4, 1.5, 0.22);
    g.beginPath();
    g.moveTo(0.35 * U, 0);
    g.lineTo(0.72 * U, -hh);
    g.lineTo(0.35 * U + w, -hh);
    g.lineTo(0.35 * U + w, hh);
    g.lineTo(0.72 * U, hh);
    g.closePath();
    g.fillStyle = `rgb(${r},${gr},${b})`; g.fill();
    noShadow(g);
    g.strokeStyle = 'rgba(255,255,255,0.45)'; g.lineWidth = 1; g.stroke();
    g.restore();
    text(g, env, txt, 0.56 * U + w / 2, 0.5, { size: 9, color: '#ffffff', weight: 750, font: MONO });
  },
});

register({
  type: 'callout', name: 'Callout Pointer', cat: 'Notes', desc: 'Arrow pointer + note box to highlight a pin, rail, or part. Drag the tip handle to re-aim.',
  defaults: { text: 'Note', dx: 4, dy: -3, color: '#0a84ff' },
  fields: [
    { key: 'text', label: 'Note', kind: 'textarea' },
    { key: 'color', label: 'Color', kind: 'select', options: NOTE_COLORS.filter(([c]) => c !== 'auto') },
  ],
  pins: () => [],
  bounds: (p) => {
    const b = calloutBoxRect(p);
    return [Math.min(-0.4, b.x0 - 0.15), Math.min(-0.4, b.y0 - 0.15), Math.max(0.4, b.x1 + 0.15), Math.max(0.4, b.y1 + 0.15)];
  },
  hit(part, l) {
    if (Math.hypot(l.x, l.y) <= 0.75) return true;
    const b = calloutBoxRect(part.props);
    return l.x >= b.x0 - 0.25 && l.x <= b.x1 + 0.25 && l.y >= b.y0 - 0.25 && l.y <= b.y1 + 0.25;
  },
  draw(g, part, env) {
    const col = part.props.color && part.props.color !== 'auto' ? part.props.color : '#0a84ff';
    const [r, gr, b] = hexRgb(col);
    const box = calloutBoxRect(part.props);
    const tx = box.dx * U, ty = box.dy * U;
    const ang = Math.atan2(ty, tx);

    // Leader line & arrowhead pointing to (0,0)
    g.save();
    g.strokeStyle = col; g.lineWidth = 1.8; g.lineCap = 'round';
    g.beginPath(); g.moveTo(0, 0); g.lineTo(tx, ty); g.stroke();
    g.fillStyle = col;
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(Math.cos(ang - 0.42) * 8, Math.sin(ang - 0.42) * 8);
    g.lineTo(Math.cos(ang + 0.42) * 8, Math.sin(ang + 0.42) * 8);
    g.closePath(); g.fill();
    g.restore();

    // Note card
    const bx = box.x0 * U, by = box.y0 * U, bw = box.wU * U, bh = box.hU * U;
    shadow(g, 6, 2, 0.22);
    rr(g, bx, by, bw, bh, 7);
    g.fillStyle = env.dark ? '#23262e' : '#ffffff'; g.fill();
    noShadow(g);
    g.strokeStyle = `rgba(${r},${gr},${b},0.85)`; g.lineWidth = 1.5; g.stroke();
    const startY = ty - ((box.lines.length - 1) * box.lineH * U) / 2;
    box.lines.forEach((ln, i) => {
      text(g, env, ln || ' ', tx, startY + i * box.lineH * U, {
        size: 11.5, color: env.dark ? '#f2f2f7' : '#1d1d1f', weight: 600,
      });
    });
  },
});

register({
  type: 'zone', name: 'Functional Zone', cat: 'Notes', desc: 'Translucent dashed container frame drawn behind parts to group stages (e.g. Clock Stage). Drag border to move or corner handle to resize.',
  defaults: { title: 'Clock Stage', w: 14, h: 9, color: '#0a84ff' },
  fields: [
    { key: 'title', label: 'Title', kind: 'text' },
    { key: 'color', label: 'Color', kind: 'select', options: NOTE_COLORS.filter(([c]) => c !== 'auto') },
  ],
  pins: () => [],
  bounds: (p) => [0, -0.7, Math.max(6, +(p.w || 14)), Math.max(4, +(p.h || 9))],
  hit(part, l) {
    const w = Math.max(6, +(part.props.w || 14)), h = Math.max(4, +(part.props.h || 9));
    // Hit only the title pill, outer border band, or resize handle so inside parts/holes stay clickable
    if (l.x >= 0.2 && l.x <= w - 0.5 && l.y >= -0.95 && l.y <= 0.6) return true;
    if (l.x < -0.5 || l.x > w + 0.5 || l.y < -0.5 || l.y > h + 0.5) return false;
    return l.x <= 0.55 || l.x >= w - 0.55 || l.y <= 0.55 || l.y >= h - 0.55;
  },
  draw(g, part, env) {
    const col = part.props.color && part.props.color !== 'auto' ? part.props.color : '#0a84ff';
    const [r, gr, b] = hexRgb(col);
    const wU = Math.max(6, +(part.props.w || 14)), hU = Math.max(4, +(part.props.h || 9));
    const w = wU * U, h = hU * U;
    g.save();
    rr(g, 0, 0, w, h, 10);
    g.fillStyle = `rgba(${r},${gr},${b},${env.dark ? 0.08 : 0.055})`; g.fill();
    g.strokeStyle = `rgba(${r},${gr},${b},0.55)`; g.lineWidth = 1.6;
    g.setLineDash([6, 4]); g.stroke(); g.setLineDash([]);
    // Title pill on top-left border
    const title = String(part.props.title || 'Zone');
    const pw = Math.min(w - 16, Math.max(54, title.length * 6.8 + 18));
    rr(g, 8, -10, pw, 20, 6);
    g.fillStyle = env.dark ? '#1c1f26' : '#ffffff'; g.fill();
    g.strokeStyle = `rgba(${r},${gr},${b},0.65)`; g.lineWidth = 1.25; g.stroke();
    g.restore();
    text(g, env, title, 8 + pw / 2, 0, { size: 10.5, color: col, weight: 700 });
  },
});

export function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  let r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  const t = f < 0 ? 0 : 255, p = Math.abs(f);
  r = Math.round((t - r) * p + r); g = Math.round((t - g) * p + g); b = Math.round((t - b) * p + b);
  return `rgb(${r},${g},${b})`;
}

export { LED_COLORS, U, SCOPE_VDIV, SCOPE_TDIV, computeScopeWindow, measureChannelStats, fmtUnits };

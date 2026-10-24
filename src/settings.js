/**
 * User preferences: stored in localStorage and applied to CSS variables,
 * the renderer, the editor and sound.
 */
import { prefs } from './sim/prefs.js';

const KEY = 'cf.settings';

export const ACCENTS = [
  ['#0a84ff', 'Blue'], ['#5e5ce6', 'Indigo'], ['#bf5af2', 'Purple'], ['#ff375f', 'Pink'],
  ['#ff453a', 'Red'], ['#ff9f0a', 'Orange'], ['#30d158', 'Green'], ['#64d2ff', 'Teal'], ['#8e8e93', 'Graphite'],
];
export const BOARD_COLORS = [['#fbfbfc', 'White'], ['#f3ead8', 'Cream'], ['#dfe7ef', 'Ice'], ['#2a2c31', 'Black']];

export const DEFAULTS = {
  theme: 'system',            // system | light | dark
  accent: '#0a84ff',
  canvas: 'dots',             // dots | grid | plain
  canvasTint: '',             // '' = theme default
  boardColor: '#fbfbfc',
  wireWidth: 1,               // multiplier
  chipText: 1,                // multiplier for chip markings
  uiScale: 1,                 // interface text size
  translucent: true,
  reduceMotion: false,
  autoRoute: true,
  autoColor: true,
  pinHalo: true,
  landingMarks: true,
  confirmDelete: false,
  wireStyle: 'recolor',       // recolor | overlay | off
  trainerLeds: true,          // LEDs get a built-in 330 Ω (if you didn't add one) and never burn
  tooltips: true,
  sound: true,
  volume: 0.6,
  defaultSpeed: 1,
};

export class Settings {
  constructor(app) {
    this.app = app;
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { saved = {}; }
    // migrate older single-purpose keys
    if (localStorage.getItem('cf.theme') && !saved.theme) saved.theme = localStorage.getItem('cf.theme');
    if (localStorage.getItem('cf.autoroute') === '0' && saved.autoRoute === undefined) saved.autoRoute = false;
    if (localStorage.getItem('cf.autocolor') === '0' && saved.autoColor === undefined) saved.autoColor = false;
    if (saved.wireStates === false && !saved.wireStyle) saved.wireStyle = 'off';
    delete saved.wireStates;
    this.v = { ...DEFAULTS, ...saved };
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.apply());
  }
  get(k) { return this.v[k]; }
  set(k, val) {
    this.v[k] = val;
    try { localStorage.setItem(KEY, JSON.stringify(this.v)); } catch { /* storage blocked */ }
    this.apply();
  }
  reset() {
    this.v = { ...DEFAULTS };
    try { localStorage.removeItem(KEY); } catch { /* storage blocked */ }
    this.apply();
  }
  resolvedTheme() {
    if (this.v.theme === 'system') return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    return this.v.theme;
  }
  apply() {
    const root = document.documentElement, v = this.v, app = this.app;
    root.dataset.theme = this.resolvedTheme();
    root.style.setProperty('--accent', v.accent);
    root.style.setProperty('--accent-soft', v.accent + '22');
    root.style.setProperty('--ui-scale', v.uiScale);
    if (v.canvasTint) root.style.setProperty('--canvas', v.canvasTint); else root.style.removeProperty('--canvas');
    document.body.classList.toggle('solid', !v.translucent);
    document.body.classList.toggle('reduce-motion', v.reduceMotion);
    document.body.classList.toggle('wires-off', v.wireStyle === 'off');
    if (prefs.trainerLeds !== v.trainerLeds) {
      prefs.trainerLeds = v.trainerLeds;
      // LED models read this when they are built, so rebuild the running circuit.
      if (app && app.engine && app.circuit) app.engine.build(app.circuit);
    }
    if (app) {
      app.autoRoute = v.autoRoute;
      app.autoColor = v.autoColor;
      if (app.ui) app.ui.syncToolbar();
      app.redraw();
    }
  }
}

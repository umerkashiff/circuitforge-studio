const defs = new Map();

export const CATEGORIES = [
  'Boards', 'Microcontrollers', 'Power', 'Inputs', 'Outputs', 'Passives',
  'Logic Gates', 'Flip-Flops', 'Counters', 'Decoders & Mux', 'Arithmetic', 'Buffers', 'Timers', 'Notes',
];

export function register(def) { defs.set(def.type, def); return def; }

export function getDef(type, soft = false) {
  const d = defs.get(type);
  if (!d && !soft) throw new Error('Unknown part type: ' + type);
  return d;
}

export function allDefs() { return [...defs.values()]; }

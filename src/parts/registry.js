const defs = new Map();
const primaryDefs = [];

export const CATEGORIES = [
  'Boards', 'Microcontrollers', 'Power', 'Inputs', 'Outputs', 'Passives',
  'Logic Gates', 'Flip-Flops', 'Counters', 'Decoders & Mux', 'Arithmetic', 'Buffers', 'Timers', 'Notes',
];

export function register(def) {
  defs.set(def.type, def);
  if (!primaryDefs.includes(def)) primaryDefs.push(def);
  if (def.aliases) {
    for (const a of def.aliases) defs.set(a, def);
  }
  return def;
}

export function getDef(type, soft = false) {
  const d = defs.get(type);
  if (!d && !soft) throw new Error('Unknown part type: ' + type);
  return d;
}

export function allDefs() { return [...primaryDefs]; }

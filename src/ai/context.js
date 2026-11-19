/**
 * CircuitForge AI Context Serializer & Token-Efficient Part Catalog Builder.
 * Keeps prompts compact within strict token budgets while
 * providing exact pinouts & prop schemas for all relevant components on-demand.
 */
import { allDefs, getDef } from '../parts/registry.js';
import { BOARD_SIZES, Circuit } from '../model.js';
import { Engine, key } from '../sim/engine.js';
import { computeScopeWindow, measureChannelStats } from '../parts/library.js';
import { probeCircuitLedBehavior } from './logic_verify.js';
import { buildNetLabelMap } from '../export/designators.js';

function fmtV(v) {
  if (v === undefined || v === null || Number.isNaN(v)) return null;
  return +v.toFixed(2);
}

function logicState(v) {
  if (v === undefined || v === null || Number.isNaN(v)) return 'FLOAT';
  if (v >= 2.0) return 'HIGH';
  if (v <= 0.8) return 'LOW';
  return 'MID';
}

const CORE_TYPES = new Set([
  'vcc', 'gnd', 'resistor', 'capacitor', 'led', 'toggle', 'button', 'clock',
]);

const KEYWORD_MATCHERS = [
  [/\b(555|ne-?555|lm-?555|astable|monostable|blink|flash|timm?er|pulse|oscil+\w*|siren|apc|atari\s*punk)/i, ['ne555']],
  [/\b(scope|cro|oscilloscope|waveform|trace|probe|measure|frequency|khz|ut2062\w*)\b/i, ['oscilloscope']],
  [/\b(and\s+gate|7408|74\s?ls\s?08|ic7408)\b/i, ['ic7408']],
  [/\b(not\s+gate|inverter|invert|complement|7404|ic7404)\b/i, ['ic7404']],
  [/\b(nand|7400|ic7400)\b/i, ['ic7400']],
  [/\b(3[-\s]?input\s+nand|7410|ic7410)\b/i, ['ic7410']],
  [/\b(4[-\s]?input\s+nand|7420|ic7420)\b/i, ['ic7420']],
  [/\b(nor|7402|ic7402)\b/i, ['ic7402']],
  [/\b(or\s+gate|7432|ic7432)\b/i, ['ic7432']],
  [/\b(xor|xnor|7486|74266|ic7486|ic74266)\b/i, ['ic7486', 'ic74266']],
  [/\b(schmitt|debounce|7414|ic7414)\b/i, ['ic7414']],
  [/\b(adder|sum|carry|7483|74283)\b/i, ['ic7483', 'ic74283', 'ic7486', 'ic7432']],
  [/\b(comparator|compare|7485)\b/i, ['ic7485']],
  [/\b(subtractor|parity|half\s*adder|full\s*adder)\b/i, ['ic7486', 'ic7483', 'ic7408', 'ic7432', 'ic7404']],
  [/\b(7[-\s]?seg|seven[-\s]?seg|7447|7448|bcd)\b/i, ['seg7', 'ic7447', 'ic7448']],
  [/\b(mux|multiplexer|74151|74153|74157|74158)\b/i, ['ic74151', 'ic74153', 'ic74157']],
  [/\b(demux|demultiplexer|decoder|encoder|priority|74138|74238|74139|74148)\b/i, ['ic74138', 'ic74139', 'ic74148']],
  [/\b(counter|dec[ae]?de|cnt?r|mod[-\s]?\d+|divider|divide[-\s]?by|7490|7493|74193|4017|chaser|scan+er|knight\s*rider|roulette)\b/i, ['ic7493', 'ic7490', 'ic74193', 'ic4017', 'ic7474']],
  [/\b(shift|regist[eo]r|sipo|74595|74\s?hc\s?595|74165|74194)\b/i, ['ic74595', 'ic74165', 'ic74194']],
  [/\b(flip[-\s]?flop|latch|d[-\s]?ff|jk|sr|7474|7473|7476|74279|4013)\b/i, ['ic7474', 'ic7473', 'ic7476', 'ic4013', 'ic74279']],
  [/\b(sop|pos|boolean|k[-\s]?map|karnaugh|minterm|truth\s*table|demorgan|logic\s+gate|gates)\b/i, ['ic7400', 'ic7410', 'ic7420']],
  [/\b(buffer|tristate|tri-state|74125|74244|74245|74541)\b/i, ['ic74125', 'ic74244', 'ic74245']],
  [/\b(func\s*gen|signal\s*gen|function\s*gen|sine\w*|square|triangle|filter|sweep|overdrive|fuzz|clip+\w*|distort\w*)\b/i, ['funcgen', 'oscilloscope', 'inductor', 'diode']],
  [/\b(power\s*sup|psu|bench\s*supply|battery|mps)\b/i, ['power-supply', 'battery']],
  [/\b(arduino|arudino|atmega328\w*|uno)\b/i, ['uno']],
  [/\bnano\b/i, ['nano']],
  [/\besp[-\s]?32[-\s]?s3\b/i, ['esp32s3']],
  [/\besp[-\s]?32\b/i, ['esp32']],
  [/\b(stm32|blue\s*pill)\b/i, ['bluepill']],
  [/\b(sketch|serial\.begin|digitalwrite|analogread)\b/i, ['uno']],
  [/\b(oled|lcd|display|screen|matrix|grid|name|text|scroll|message|pixel|draw|letter|word|bar\s*graph|led\s*bar|segment\s*bar|buzzers?|p[ie]+zo|beeper|sounder|horn|siren|relay|rgb)\b/i, ['uno', 'board-ssd1306', 'lcd16x2', 'wokwi-lcd1602', 'bargraph', 'buzzer', 'wokwi-relay-module', 'wokwi-rgb-led']],
  [/\b(transistor|npn|pnp|bjt|darling\w*|2n390[46]|2n2222|bc5[45]7|jfet|mosfet|nmos|pmos|2n7000|irf540|bs250|zener|schottky|1n5819|diode|1n4148|1n400[17]|rectifier|pot|trimpot|pot[a-z]*met[a-z]*|vr|slide|dip|tact\w*|push\s*button\w*|momenta\w*|trainer|logic\s*an)\b/i, ['npn', 'pnp', 'jfet', 'nmos', 'pmos', 'diode', 'zener', 'pot', 'slide', 'dip4', 'dip8', 'tactile', 'trainer-board', 'wokwi-logic-analyzer']],
  [/\b(op[-\s]?amp|opamp|lm-?741|lm-?358|lm-?393|comparator|follower|invert\w*\s+amp|non[-\s]?invert|schmitt\s+trig|active\s+filter|integrat)\b/i, ['lm741', 'lm358', 'lm393']],
  [/\b(regulat\w*|7805|lm-?7805|lm-?317|opto(?:coupler|isolator)?|pc-?817|galvanic|isolat)\b/i, ['lm7805', 'lm317', 'pc817']],
  [/\b(dmm|multimeter|continuity|ohmmeter|ammeter|voltmeter)\b/i, ['multimeter']],
  [/\b(ceramic|non[-\s]?polar\w*|ac\s+coupl\w*|flyback|rl|lc\s+filt\w*)\b/i, ['capacitor', 'inductor', 'diode']],
  [/\b(mpu[-\s]?6050|bmp[-\s]?180|ds1307|joystick|thumbstick|gamep[a]?d|rtc|baro)\b/i, ['wokwi-mpu6050', 'wokwi-bmp180', 'wokwi-ds1307', 'wokwi-analog-joystick']],
];

function selectDetailedTypes(queryText = '', app = null) {
  const want = new Set(CORE_TYPES);
  if (app?.circuit?.parts) {
    for (const p of app.circuit.parts) want.add(p.type);
  }
  const q = String(queryText || '').toLowerCase();
  if (q) {
    for (const d of allDefs()) {
      const bare = d.type.replace(/^ic/, '').toLowerCase();
      if (q.includes(d.type.toLowerCase()) || (bare.length >= 4 && new RegExp(`\\b${bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(q))) {
        want.add(d.type);
      }
    }
    const nandOnly = /\bnand\b.*\bonly\b|\bonly\b.*\bnand\b|\bnand[-\s]?only\b/i.test(q);
    const generalLogic = /\b(sop|pos|boolean|k[-\s]?map|karnaugh|minterm|truth\s*table|demorgan|logic\s+gate|gates)\b/i.test(q) && !nandOnly;
    if (generalLogic) {
      for (const t of ['ic7402', 'ic7404', 'ic7408', 'ic7432', 'ic7486']) want.add(t);
    }
    for (const [re, types] of KEYWORD_MATCHERS) {
      if (re.test(q)) for (const t of types) want.add(t);
    }
  }
  return want;
}

const PART_HINTS = {
  toggle: ' // active 5V/0V source (do NOT wire +/- to OUT)',
  button: ' // 1-pin 5V/0V driver (NEVER wire to +/-; use "tactile" if pull-down/up R needed)',
  clock: ' // active 5V/0V source (do NOT wire +/- to OUT)',
  dip4: ' // active 5V/0V drivers S1..S4 (do NOT wire +5V/GND to S1..S4)',
  dip8: ' // active 5V/0V drivers S1..S8 (do NOT wire +5V/GND to S1..S8)',
  ne555: ' // Astable: R1(+->DIS), R2(DIS->THR), THR-TRIG, C(THR->-), RESET->+. Monostable: R(+->DIS), DIS-THR, C(THR->-), input->TRIG',
  inductor: ' // Reactive coil (V=L*dI/dt, Rs=0.5Ω): creates RL/LC transients & flyback spikes; pair with flyback diode when switching',
  zener: ' // Clamps reverse V(K-A) at Vz via series current-limiting resistor',
  pnp: ' // High-side switch: E->"+", C->load->"-", pull B low via R (< Ve-0.7V) to conduct',
  nmos: ' // Unified pins G,D,S: S->"-", D->load->"+", G > Vth turns on with low Rds(on)',
  pmos: ' // Unified pins G,D,S: S->"+", D->load->"-", pull G below S by >|Vth| to turn on',
  lm7805: ' // Pins IN,GND,OUT: feed IN >= Vreg+2V for steady regulated OUT',
  lm317: ' // Pins ADJ,OUT,IN: R1(OUT->ADJ, ~240Ω) + R2(ADJ->GND) sets Vout=1.25*(1+R2/R1)',
  pc817: ' // Isolated DIP-4 A,K,E,C: drive LED (A->K via R) to switch separate ground phototransistor (C->E)',
  lm741: ' // DIP-8 op-amp: power V+(7) & V-(4) (>=4.5V span); supports negative feedback followers & amplifiers',
  lm358: ' // Dual single-supply DIP-8 op-amp: power V+(8) & V-(4); outputs swing down to V-(0.05V)',
  lm393: ' // Dual open-collector comparator: add pull-up R from OUT to VCC',
  multimeter: ' // Wire + & - across differential nodes (dcv), inline in branch (dca), or across unpowered R (ohm/cont)',
  ic4013: ' // CMOS power: VDD->"+", VSS->"-"',
  ic4017: ' // CMOS power: VDD->"+", VSS->"-"',
  ic7483: ' // Tie C0->"-" for A+B',
  ic74283: ' // Tie C0->"-" for A+B',
  ic7474: ' // Toggle div-2: 1Q̅->1D, 1PRE->"+", 1CLR->"+"',
  ic74138: ' // G1->"+", G2A->"-", G2B->"-"',
  ic74151: ' // Strobe G->"-"',
  ic7493: ' // R0(1)&R0(2)->"-" to count (NEVER "+"); QA->CKB',
  ic7490: ' // R0(1)&R0(2)->"-" to count (NEVER "+"); QA->CKB',
  ic7447: ' // Active-LOW -> seg7 common:"anode"; LT,RBI,BI/RBO->"+"',
  ic7448: ' // Active-HIGH -> seg7 common:"cathode"; LT,RBI,BI/RBO->"+"',
  'board-ssd1306': ' // I2C OLED: VCC->"+", GND->"-", SDA->U1.A4, SCL->U1.A5',
  'wokwi-lcd1602': ' // I2C LCD: VCC->"+", GND->"-", SDA->U1.A4, SCL->U1.A5',
  npn: ' // Low-side load: "+"->R->LED.A, LED.K->C, E->"-"; Base via R (never K to "+")',
  tactile: ' // 1.l==1.r & 2.l==2.r permanently bridged; press bridges 1<->2 (always wire 1.l & 2.l)',
  led: ' // Forward: Anode(+/R)->Cathode(-/NPN.C); never reverse A<K',
  oscilloscope: ' // ~1Hz timeDiv=0.2; 1kHz timeDiv=0.0005; connect CH1 GND->"-"',
};

const TOPOLOGY_RECIPES = [
  [/\b(bridge\s*rectif|full[\s-]*wave|4[-\s]*diode)\b/i, 'RECIPE bridge-rectifier: 4 diodes + funcgen(100Hz sine): D1.A=D2.K=FG.+, D3.A=D4.K=FG.-, D1.K=D3.K=OUT+, D2.A=D4.A=GND(-); load R + filter C across OUT+<->GND.'],
  [/\b(clip|overdrive|fuzz|distort)\b/i, 'RECIPE diode-clipper: funcgen.+->C->R->OUT; antiparallel diodes D1(A->OUT,K->-) & D2(K->OUT,A->-); scope CH1->FG.+, CH2->OUT, CH1 GND->-.'],
  [/\b(atari|punk|apc|stepped\s*tone)\b/i, 'RECIPE atari-punk: U1 ne555 astable OUT->U2.TRIG; U2 ne555 monostable DIS->THR->C->-, pot2/R(+->DIS), OUT->buzzer.+->-.'],
  [/\b(siren|police|wail|weee)/i, 'RECIPE dual-555-siren: U1 slow 555 astable OUT->R->U2.CTRL; U2 fast 555 astable OUT->buzzer.+->- (keep U2.CTRL off rails).'],
  [/\b(darling|lie\s*detect|skin|touch\s*switch)\b/i, 'RECIPE darlington: pot(1->+,3->-,W->tactile.1.l); tactile.2.l->10k->Q1.B; Q1.C->+, Q1.E->Q2.B, Q2.E->-; +->220Ω->LED.A, LED.K->Q2.C, buzzer(+->+, - ->Q2.C).'],
  [/\b(knight|kitt|4017|chaser|roulette)\b/i, 'RECIPE 555+4017: 555 OUT->U2.CLK, RST->"-", INH->"-"; Q0..Q7->220Ω->LED1..8.A->"-".'],
  [/\b(sr\s*latch|flip[-\s]*flop|nand\s*latch)\b/i, 'RECIPE sr-nand-latch: R1(+->S), SW_S(S->-), R2(+->R), SW_R(R->-); 7400: 1A=S, 1B=2Y(Qbar), 1Y=Q, 2A=R, 2B=1Y(Q), 2Y=Qbar; Q/Qbar->220Ω->LED->-.'],
  [/\b(7493|7490|modulo|decade|bcd.*7|7[-\s]*seg.*count)/i, 'RECIPE counter+7447: CLK->U1.CKA, U1.QA->U1.CKB, R0(1)=R0(2)="-"; QA..QD->7447 A..D; 7447 LT=RBI=BI/RBO="+"; a..g->220Ω->seg7(common:"anode",COM->"+").'],
  [/\b(595|shift\s*reg|bargraph|serial.*bar)/i, 'RECIPE uno+74595+bargraph: SER->D11, SRCLK->D12, RCLK->D8, SRCLR="+", OE="-"; QA..QH->220Ω/bargraph.A1..A8, K1..K8->"-".'],
];

function formatPartSpec(d) {
  if (d.type === 'trainer-board') {
    return `- trainer-board: pins=[+5V,GND,CLK,S0..S9,S2'..S9',L0..L15,P1,P1',P2,P2']`;
  }
  const pins = d.pins(d.defaults || {}).map(p => p.name).join(',');
  const propParts = (d.fields || []).map(f => {
    if (f.options) {
      if (f.options.length <= 4) {
        return `${f.key}=${f.options.map(o => JSON.stringify(o[0])).join('|')}`;
      }
      const defVal = d.defaults?.[f.key] ?? f.options[0][0];
      return `${f.key}(def=${JSON.stringify(defVal)})`;
    }
    return `${f.key}(${f.kind})`;
  });
  if (d.mcu && d.defaults?.code !== undefined) propParts.push('code(Arduino C++ sketch string)');
  const props = propParts.join(';');
  const tag = d.ic ? 'IC' : d.mcu ? 'MCU' : d.cat === 'Instruments' ? 'Inst' : '';
  const hint = PART_HINTS[d.type] || '';
  return `- ${d.type}${tag ? `(${tag})` : ''}: pins=[${pins}]${props ? ` props={${props}}` : ''}${hint}`;
}

/** Build a compact, accurate catalog tailored to the active prompt and circuit. */
export function buildPartsCatalogPrompt(queryText = '', app = null) {
  const defs = allDefs();
  const detailedSet = selectDetailedTypes(queryText, app);
  const indexList = defs.map(d => d.type).join(',');
  const detailLines = [];
  for (const d of defs) {
    if (detailedSet.has(d.type)) detailLines.push(formatPartSpec(d));
  }

  const needsMcuRules = ['uno', 'nano', 'esp32', 'esp32s3', 'bluepill'].some(t => detailedSet.has(t));
  const mcuNote = needsMcuRules
    ? '\nMCU SKETCH SUBSET: Put Arduino C++ in `"props":{"code":"..."}`. Pins e.g. `"U1.D13"`, `"U1.5V"`, `"U1.GND"` (never 3V3 to +5V). Only setup()/loop() (NO class/struct/pointers); APIs: pinMode, digitalWrite/Read, analogRead/Write, delay, millis, Serial, Servo, Adafruit_SSD1306, LiquidCrystal_I2C.'
    : '';
  const recipes = TOPOLOGY_RECIPES.filter(([re]) => re.test(queryText)).slice(0, 2).map(([, txt]) => txt);

  return [
    `TYPES: ${indexList}`,
    'SCHEMAS (exact type & pin names):',
    ...detailLines,
    ...recipes,
    'BOARDS: mini(17c),half(30c,+/-),full(63c,+/-). RAILS:"+"(+5V),"-"(GND).',
    mcuNote,
  ].filter(Boolean).join('\n');
}

function pointLabel(app, x, y, stripPins = null) {
  const h = app.index.holes.get(key(x, y));
  const pins = app.index.pins.get(key(x, y)) || [];
  if (pins.length && h && !h.rail) return `${pins[0].part.id}.${pins[0].name}@${h.label}`;
  if (pins.length) return `${pins[0].part.id}.${pins[0].name}`;
  if (h) {
    if (!h.rail && stripPins) {
      const mates = stripPins.get(h.strip);
      if (mates?.length === 1) return `${h.label}[${mates[0]}]`;
    }
    return h.label;
  }
  return `${x},${y}`;
}

/** Serialize live circuit topology cleanly within a strict character/token budget. */
export function serializeCircuitState(app, { maxChars = 4800 } = {}) {
  const c = app.circuit;
  const eng = app.engine;

  let ledDiagById = null;
  const ledCount = c.parts.filter(p => p.type === 'led').length;
  if (ledCount >= 1 && ledCount <= 12) {
    try {
      const probeCircuit = Circuit.fromJSON(c.toJSON());
      const probeSim = new Engine();
      probeSim.build(probeCircuit);
      ledDiagById = new Map(probeCircuitLedBehavior(probeSim, probeCircuit).map(s => [s.id, s]));
    } catch { ledDiagById = null; }
  }

  const wiredNets = new Set();
  for (const w of c.wires) {
    const na = eng.netAt(w.a.x, w.a.y), nb = eng.netAt(w.b.x, w.b.y);
    if (na >= 0) wiredNets.add(na);
    if (nb >= 0) wiredNets.add(nb);
  }

  const netPinCounts = new Map();
  const stripPins = new Map();
  for (const p of c.parts) {
    for (const q of p.worldPins()) {
      const n = eng.netAt(q.x, q.y);
      if (n >= 0) netPinCounts.set(n, (netPinCounts.get(n) || 0) + 1);
      const h = app.index.holes.get(key(q.x, q.y));
      if (h && !h.rail) {
        if (!stripPins.has(h.strip)) stripPins.set(h.strip, []);
        stripPins.get(h.strip).push(`${p.id}.${q.name}`);
      }
    }
  }

  const netMap = new Map();
  const ensureNet = (n) => {
    if (n < 0) return null;
    if (!netMap.has(n)) {
      const v = eng.voltage(n);
      netMap.set(n, { net: n, v: fmtV(v), state: logicState(v), ends: [], rails: new Set() });
    }
    return netMap.get(n);
  };

  const parts = c.parts.map((p) => {
    const def = getDef(p.type);
    const wPins = p.worldPins();
    const connectedPins = [];
    const unwired = [];

    for (const q of wPins) {
      const n = eng.netAt(q.x, q.y);
      const hole = app.index.holes.get(key(q.x, q.y));
      if (n >= 0) {
        const nm = ensureNet(n);
        nm.ends.push(`${p.id}.${q.name}`);
        if (hole?.rail) nm.rails.add(hole.label);
      }
      const isConnected = n >= 0 && (wiredNets.has(n) || (netPinCounts.get(n) || 0) > 1 || Boolean(hole?.rail));
      const v = n >= 0 ? eng.voltage(n) : NaN;
      const vTxt = app.mode === 'sim' ? (Number.isNaN(v) ? 'NC' : `${v.toFixed(2)}V`) : '';
      if (wPins.length <= 4 || isConnected) {
        connectedPins.push(`${q.name}@${hole ? hole.label : 'off'}${vTxt ? `(${vTxt})` : ''}`);
      } else {
        unwired.push(q.name);
      }
    }

    const compactProps = { ...p.props };
    delete compactProps._dev;
    if (def.mcu && def.defaults?.code && compactProps.code === def.defaults.code) {
      compactProps.code = '<default blink sketch>';
    }

    const out = {
      id: p.id,
      ref: p.ref || undefined,
      type: p.type,
      name: def.short || def.name,
      props: compactProps,
      pins: connectedPins,
    };
    if (unwired.length) out.unwired = unwired;

    const dev = eng.byPart.get(p.id)?.device;
    if (p.type === 'oscilloscope' && dev) {
      const win = computeScopeWindow(dev, Math.max(0.0001, +p.props.timeDiv || 0.05));
      const st1 = win ? measureChannelStats(dev, dev.buf1, win) : null;
      const st2 = win ? measureChannelStats(dev, dev.buf2, win) : null;
      out.readings = {
        ch1: st1?.valid ? { vpp: +st1.vpp.toFixed(2), vavg: +st1.vavg.toFixed(2), min: +st1.min.toFixed(2), max: +st1.max.toFixed(2), freqHz: +st1.freq.toFixed(2) } : 'no signal',
        ch2: st2?.valid ? { vpp: +st2.vpp.toFixed(2), vavg: +st2.vavg.toFixed(2), min: +st2.min.toFixed(2), max: +st2.max.toFixed(2), freqHz: +st2.freq.toFixed(2) } : 'no signal',
      };
    } else if (p.type === 'power-supply' && dev) {
      out.readings = {
        masterV: +dev.measV1.toFixed(2), masterA: +dev.measI1.toFixed(3),
        slaveV: +dev.measV2.toFixed(2), slaveA: +dev.measI2.toFixed(3),
        fixed5V_A: +dev.measI3.toFixed(3),
      };
    } else if (p.type === 'funcgen' && dev) {
      out.readings = { on: Boolean(p.props.power), wave: p.props.wave, hz: +(dev.instHz || p.props.hz || 10).toFixed(2), vpp: +p.props.vpp };
    } else if (p.type === 'multimeter' && dev) {
      out.readings = { mode: dev.mode, display: dev.display, liveBlocked: Boolean(dev.liveBlocked), beep: Boolean(dev.beep) };
    } else if (def.mcu && dev?.rt) {
      out.mcu = { err: dev.rt.error || null, serial: dev.rt.serial.slice(-8).map(l => l.text).join('') };
      if (dev.rt.notes?.length) out.mcu.notes = dev.rt.notes.slice(0, 4);
    } else if (p.type === 'led') {
      const ld = ledDiagById?.get(p.id);
      if (ld) {
        const st = ld.open ? 'OPEN_PIN' : ld.shorted ? 'DEAD_SHORTED(A=K)' : ld.blown ? 'DEAD_BLOWN' : ld.toggles ? 'BLINKING' : ld.litOnce ? 'LIT' : (Number.isFinite(ld.vA) && Number.isFinite(ld.vK) && ld.vK > ld.vA + 0.5 ? 'DEAD_REVERSE' : 'DEAD(0mA)');
        out.led = { st, peak_mA: +ld.peakMa.toFixed(1) };
      } else if (dev) {
        out.mA = +((dev.cur?.[0] || 0) * 1000).toFixed(1);
      }
    }
    return out;
  });

  const summary = {
    mode: app.mode,
    t: +eng.time.toFixed(3),
    boards: c.boards.map(b => b.size),
    parts,
    wireCount: c.wires.length,
  };
  if (c.wires.length) {
    summary.wires = c.wires.slice(0, 80).map(w => `${w.id}: ${pointLabel(app, w.a.x, w.a.y, stripPins)} <-> ${pointLabel(app, w.b.x, w.b.y, stripPins)}`);
  }
  if (app.editor?.selection?.size) {
    summary.selected = [...app.editor.selection];
  }
  if (c.probes?.length) {
    summary.probes = c.probes.map(pr => ({ id: pr.id, name: pr.name, analog: Boolean(pr.analog) }));
  }
  const gState = app.aiGuide?.getState?.();
  if (gState) {
    summary.activeGuide = {
      title: gState.title,
      progress: `${gState.doneCount}/${gState.total}`,
      nextStep: gState.activeStep?.desc || 'completed',
    };
  }
  const netNames = buildNetLabelMap(c, eng);
  if (app.mode === 'sim' || netMap.size > 0 || netNames.size > 0) {
    summary.nets = [...netMap.values()]
      .filter(n => n.ends.length > 1 || n.rails.size > 0 || wiredNets.has(n.net) || netNames.has(n.net) || (app.mode === 'sim' && n.v !== null))
      .slice(0, 45)
      .map(n => ({ id: n.net, name: netNames.get(n.net) || undefined, v: app.mode === 'sim' ? n.v : undefined, st: app.mode === 'sim' ? n.state : undefined, rails: [...n.rails], ends: n.ends }));
  }
  const issues = app.allIssues().map(w => `${w.level}:${w.part?.id || ''} ${w.text}`);
  if (ledDiagById) {
    for (const [id, ld] of ledDiagById) {
      if (ld.open || !ld.litOnce) {
        const st = ld.open ? 'OPEN_PIN' : ld.shorted ? 'SHORTED(A=K)' : ld.blown ? 'BLOWN' : (Number.isFinite(ld.vA) && Number.isFinite(ld.vK) && ld.vK > ld.vA + 0.5 ? 'REVERSE_BIASED' : 'DEAD(0mA)');
        issues.push(`error:${id} LED is ${st} (A=${Number.isFinite(ld.vA) ? ld.vA.toFixed(2) : 'NC'}V, K=${Number.isFinite(ld.vK) ? ld.vK.toFixed(2) : 'NC'}V)`);
      }
    }
  }
  if (issues.length) summary.issues = issues;

  // Compact verbose fields first so exact wire IDs & LED diagnostics stay preserved within maxChars
  if (JSON.stringify(summary).length > maxChars) {
    if (summary.nets && summary.nets.length > 15) summary.nets = summary.nets.slice(0, 15);
    summary.parts = summary.parts.map(pt => {
      const mini = { id: pt.id, type: pt.type };
      if (pt.props && Object.keys(pt.props).length) mini.props = pt.props;
      if (pt.unwired?.length) mini.unwired = pt.unwired;
      if (pt.led) mini.led = pt.led;
      else if (pt.mA !== undefined) mini.mA = pt.mA;
      if (pt.readings) mini.readings = pt.readings;
      if (pt.mcu) mini.mcu = pt.mcu;
      return mini;
    });
  }
  if (JSON.stringify(summary).length > maxChars) {
    delete summary.nets;
  }
  if (JSON.stringify(summary).length > maxChars) {
    delete summary.wires;
  }
  if (JSON.stringify(summary).length > maxChars && summary.parts.length > 30) {
    summary.omittedParts = summary.parts.length - 30;
    summary.parts = summary.parts.slice(0, 30);
  }
  return summary;
}

/** Build the complete system instruction for Gemini depending on mode & prompt context. */
export function buildSystemPrompt({ mode = 'auto', query = '', app = null } = {}) {
  const modeRule = mode === 'build'
    ? 'MODE=BUILD: Return intent="build" with parts/connections (or removeWires/updates/remove) for hardware requests; for unrelated chat return intent="analyze" with NO parts/connections.'
    : mode === 'guide'
      ? 'MODE=GUIDE: Return intent="guide" with parts/connections and ordered steps for builds/guides; for unrelated chat return intent="analyze" only.'
      : 'MODE=AUTO: Read CIRCUIT_STATE first! intent="analyze" for checks/debugging/Q&A/off-topic; "build" to create/fix/wire; "guide" when asked for steps.';

  return [
    'You are CircuitForge AI, an expert circuit assistant in CircuitForge Studio.',
    modeRule,
    'RULES:',
    '1. Output MINIFIED SINGLE-LINE STRICT JSON ONLY. Never invent (x,y) coords; use `["A.pin","B.pin"]`, `"+"`/`"-"`, or chains `["-","U1.3A","U1.3B",...]`. Omit empty fields; keep build "reply" <=2 sentences. LARGE BUILDS (>20 wires): list ALL requested parts in Stage 1 (NEVER cut requested counts!), wire <=18 links with "more":true until "more":false.',
    '2. POWER: Rails "+"/"-" require BOTH `"vcc"` `["V1.1","+"]` & `"gnd"` `["G1.1","-"]` (or power-supply/MCU). IC power auto-wires when rails are powered. Tie unused gate inputs to "-"/"+"; ne555 RESET->"+", 7483/74283 C0->"-", 7493/7490 resets->"-", QA->CKB; NEVER short two outputs or switch/clock OUT to rails.',
    '3. DISPLAYS: Use 220-470Ω R on LEDs (7447 active-LOW -> seg7 common:"anode"). Text/>25 LEDs: `uno`+`board-ssd1306` OLED/lcd16x2. <=25 LED pattern: `led` with 0-indexed `row`,`col`, wire lit LEDs via R, tie dark LEDs to "-". NAND-only: ic7400/7410/7420 only.',
    '4. WORKSPACE: Inspect CIRCUIT_STATE! Existing edits MUST set `"clearExisting":false` using exact `id`s & `updates` (NEVER `clearExisting:true` + solo MCU). Keep incomplete "analyze" concise.',
    'SCHEMA: {"intent":"analyze"|"build"|"guide","plan":"brief plan","reply":"markdown","more":false,"clearExisting":true,"board":"half","parts":[{"ref":"U1","type":"ic7400","props":{}}],"connections":[["V1.1","+"],["G1.1","-"]],"removeWires":[],"updates":[],"remove":[],"probes":[{"at":"U1.OUT","name":"OUT"}],"steps":[{"kind":"part","ref":"U1","desc":"..."}]}',
    buildPartsCatalogPrompt(query, app),
  ].join('\n');
}

/**
 * Daily AI Eval Case Bank, Offline Combinatorial Topology Generator & 1-Call Curriculum Inventor.
 * - Regression benchmarks (fixed core capabilities + multi-turn follow-ups)
 * - Wild creative bank + 1-call/day LLM Curriculum Inventor (`generateDailyNewIdeas`)
 * - Deterministic Typo/Synonym Mutation Pool (`buildMutationPool`)
 * - Offline Combinatorial Boolean & Signal-Chain Generator (`buildCombinatorialPool`)
 */

import { allDefs } from '../src/parts/registry.js';
import { callGemini, extractJsonObject } from '../src/ai/client.js';
import { resolvePartType } from '../src/ai/builder.js';

function prng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

/** Deterministic typo injector keeping technical intent recognizable. */
export function mutateWord(word, rng) {
  if (!word || word.length < 4 || /^\d/.test(word)) return word;
  const r = rng();
  if (r < 0.35) {
    const idx = 1 + Math.floor(rng() * (word.length - 2));
    return word.slice(0, idx) + word.slice(idx + 1);
  }
  if (r < 0.65) {
    const idx = 1 + Math.floor(rng() * (word.length - 3));
    return word.slice(0, idx) + word[idx + 1] + word[idx] + word.slice(idx + 2);
  }
  if (r < 0.85) {
    return word.replace(/[aeiou]/i, c => ({ a: 'e', e: 'a', i: 'e', o: 'u', u: 'o' }[c.toLowerCase()] || c));
  }
  return word;
}

const SYN = {
  build: ['build', 'bild', 'make', 'wire', 'wirre', 'cretae', 'setup', 'design'],
  resistor: ['resistor', 'resiter', 'resister', 'resistors', '220ohm resiter', 'current limiter'],
  capacitor: ['capacitor', 'capcitor', 'cap', 'condensator', 'electrolytic cap'],
  led: ['led', 'red led', 'led blub', 'indicator led', 'glowing led'],
  buzzer: ['buzzer', 'peizo', 'piezo sounder', 'beeper', 'horn', 'sounder'],
  pot: ['pot', 'potentiometer', 'potnetiometer', 'trimpot', 'trimpot knob', 'vr knob'],
  tactile: ['tactile', 'tact button', 'push button', 'momentary switch', 'pushbutton'],
  ne555: ['555', 'ne555', 'ne-555', 'lm555', '555 timmer', '555 osciltr'],
  npn: ['npn', '2n3904', '2n2222', 'bc547', 'npn bjt'],
  uno: ['uno', 'arduino uno', 'uno r3', 'atmega328 uno', 'atmega328p'],
  scope: ['oscilloscope', 'cro', 'scope', 'ut2062b cro scope'],
  funcgen: ['funcgen', 'func gen', 'function generator', 'signal generator', 'sig gen'],
  ic4017: ['cd4017', '4017', 'cd4017 decde cntr'],
  ic74595: ['74hc595', '74595', '74hc595 shift registor'],
  bargraph: ['bargraph', '8 segment bar led array', '10 seg led bar'],
  diode: ['diode', '1n4148', '1n4007', 'rectifier diode', '1n5819 schottky'],
  lm358: ['lm358', 'lm-358 opamp', 'dual op-amp'],
  lm393: ['lm393', 'voltage comparator', 'lm-393 comparator'],
  nmos: ['nmos', '2n7000', '2n7000 n-mosfet', 'irf540 mosfet'],
  zener: ['zener', 'zener diode', '5.1v zener clamp'],
  multimeter: ['dmm', 'multimeter', 'digital multimeter'],
};

export function expandTypoText(rng, tpl) {
  let out = tpl.replace(/\{(\w+)\}/g, (_, k) => {
    const opts = SYN[k];
    return opts ? pick(rng, opts) : k;
  });
  const words = out.split(' ');
  const edits = rng() < 0.7 ? (rng() < 0.35 ? 2 : 1) : 0;
  for (let e = 0; e < edits; e++) {
    const idx = Math.floor(rng() * words.length);
    if (/^[a-z]{5,}$/i.test(words[idx]) && !/^(arduino|cathode|anode|common|schmitt|trigger|binary|parity|filter)$/i.test(words[idx])) {
      words[idx] = mutateWord(words[idx], rng);
    }
  }
  return words.join(' ');
}

export const REGRESSION_CASES = [
  {
    id: 'reg_555_blinker',
    bucket: 'regression',
    name: '555 Astable LED Blinker + Scope',
    prompt: 'Build a 555 timer astable LED blinker around 2Hz with resistors, capacitor, red LED and oscilloscope on the output',
    scopes: [],
    oracle: { minParts: 5, requireTypes: [['ne555'], ['led'], ['oscilloscope']], check: 'scope_ac' },
  },
  {
    id: 'reg_guitar_fuzz',
    bucket: 'regression',
    name: 'Guitar Overdrive Diode Clipper (typos)',
    prompt: 'bild an elektric guitar overdrive diode clipper fx circuit using func gen sinewav, coupling capcitor, resistor, 2 inverse 1n4148 rectifiers to clip peaks, and UT2062B cro scope',
    scopes: [],
    oracle: { minParts: 5, requireTypes: [['funcgen'], ['oscilloscope'], ['diode']], check: 'scope_ac' },
  },
  {
    id: 'reg_apc_synth',
    bucket: 'regression',
    name: 'Atari Punk Console Dual-555 (synonyms)',
    prompt: 'make a noisy atari punk consol synth with dual lm555 timmers (astable feeding monostable), 2 trimpot knobs for pitch & pulse wdth, 2 caps, and peizo sounder',
    scopes: [],
    oracle: { minParts: 7, requireTypes: [['ne555'], ['pot'], ['buzzer']], check: 'buzzer_active' },
  },
  {
    id: 'reg_knight_rider',
    bucket: 'regression',
    name: 'Knight Rider 555+CD4017 Chaser (typos)',
    prompt: 'wire a knight rider kitt led chaser scaner with a 555 osciltr clock, cd4017 decde cntr chip, and 8 red glowing leds + 220ohm resitors',
    scopes: [],
    oracle: { minParts: 18, requireTypes: [['ne555'], ['ic4017'], ['led']], check: 'led_multi', minActiveLeds: 4 },
  },
  {
    id: 'reg_police_siren',
    bucket: 'regression',
    name: 'Dual-555 Police Siren (synonyms)',
    prompt: 'create a wailing weee-wooo police siren with twin ne-555 chips where slow chip modulates CV/ctrl pin of fast oscilator driving a beeper',
    scopes: [],
    oracle: { minParts: 8, requireTypes: [['ne555'], ['buzzer']], check: 'buzzer_active' },
  },
  {
    id: 'reg_lie_detector',
    bucket: 'regression',
    name: 'Darlington NPN Lie Detector (typos)',
    prompt: 'wire a diy lie detectr skin resistance checkr with 2n3904 npn bjt darlingtn pair, rotary potnetiometer knob, led + horn indicator',
    scopes: [],
    oracle: { minParts: 6, requireTypes: [['npn'], ['pot'], ['led']], check: 'led_active' },
  },
  {
    id: 'reg_simon_says',
    bucket: 'regression',
    name: 'Arduino Simon Says Game (slang+typos)',
    prompt: 'make a simon says memry game using atmega328 uno board, 4 colorful led blubs (red grean yelow blu) with resisters, 4 tact buttons and peizo beeper',
    scopes: ['uno'],
    oracle: { minParts: 14, requireTypes: [['uno'], ['led'], ['tactile', 'button'], ['buzzer']], check: 'mcu_run' },
  },
  {
    id: 'reg_595_bargraph',
    bucket: 'regression',
    name: 'Arduino 74HC595 Bargraph Visualizer',
    prompt: 'bild an arduino uno serial 8-bit chaser visualizr using 74hc595 sipo shift registor chip driving an 8 segment bar led array',
    scopes: ['uno'],
    oracle: { minParts: 5, requireTypes: [['uno'], ['ic74595'], ['bargraph']], check: 'bargraph_active' },
  },
  {
    id: 'reg_7408_and',
    bucket: 'regression',
    name: '7408 AND Gate 2-Switch Test',
    prompt: 'build a 2-input AND gate demo with ic7408, two slide switches or toggle switches A and B, and an LED + 220 ohm resistor on output',
    scopes: [],
    oracle: { minParts: 5, requireTypes: [['ic7408'], ['led']], check: 'led_active' },
  },
  {
    id: 'reg_7493_counter',
    bucket: 'regression',
    name: '7493 Ripple Counter + 7447 + 7-Seg',
    prompt: 'wire a clock generator at 2Hz into a 7493 binary counter driving a 7447 BCD decoder and common-anode 7-segment display',
    scopes: [],
    oracle: { minParts: 5, requireTypes: [['ic7493'], ['ic7447'], ['seg7']], check: 'seg7_active' },
  },
  {
    id: 'reg_half_wave_rect',
    bucket: 'regression',
    name: 'Half-Wave Diode Rectifier + Filter + Scope',
    prompt: 'build a half wave rectifier with a 1n4007 diode, function generator 100Hz sine input, load resistor and smoothing cap, plus oscilloscope across input and output',
    scopes: [],
    oracle: { minParts: 5, requireTypes: [['funcgen'], ['diode'], ['oscilloscope']], check: 'scope_ac' },
  },
  {
    id: 'reg_npn_switch',
    bucket: 'regression',
    name: 'NPN Common-Emitter Transistor Switch',
    prompt: 'build an npn transistor LED driver using 2n3904, tactile pushbutton to base via 10k resistor, and red LED + 220 ohm resistor on collector',
    scopes: [],
    oracle: { minParts: 6, requireTypes: [['npn'], ['led'], ['tactile', 'button']], check: 'led_active' },
  },
  {
    id: 'reg_led_3x3_grid',
    bucket: 'regression',
    name: '3x3 Static LED Matrix Pattern',
    prompt: 'build a 3x3 grid of red LEDs forming a hollow square border (all 8 outer LEDs ON, center LED OFF) powered through current-limiting resistors',
    scopes: [],
    oracle: { minParts: 10, requireTypes: [['led']], check: 'led_multi', minActiveLeds: 6 },
  },
  {
    id: 'reg_sr_nand_latch',
    bucket: 'regression',
    name: 'Cross-Coupled NAND SR Flip-Flop',
    prompt: 'build a cross-coupled SR latch using a 7400 quad NAND gate IC, two tactile buttons with pullup resistors for active-low SET and RESET, and two indicator LEDs for Q and Qbar',
    scopes: [],
    oracle: { minParts: 7, requireTypes: [['ic7400'], ['led']], check: 'led_active' },
  },
  {
    id: 'reg_multiturn_555_mod',
    bucket: 'regression',
    name: 'Multi-Turn: Build 555 -> Add Buzzer & Green LED',
    turns: [
      'build a 555 astable blinker driving a red LED with 220 ohm resistor',
      'keep existing parts and add a piezo buzzer plus a second green LED with 220 ohm resistor driven from the 555 output pin 3',
    ],
    scopes: [],
    oracle: { minParts: 6, requireTypes: [['ne555'], ['led'], ['buzzer']], check: 'buzzer_active' },
  },
  {
    id: 'reg_arduino_reaction',
    bucket: 'regression',
    name: 'Arduino Tactile Button + Buzzer + LED',
    prompt: 'build an Arduino Uno button-triggered alarm: pressing tactile switch on D2 blinks a red LED on D13 and sounds a piezo buzzer on D8',
    scopes: ['uno'],
    oracle: { minParts: 5, requireTypes: [['uno'], ['led'], ['buzzer'], ['tactile', 'button']], check: 'mcu_run' },
  },
  {
    id: 'reg_oled_snake_optional',
    bucket: 'regression',
    name: 'OLED Snake Game (OLED Scope)',
    prompt: 'cretae a playable retor snake arcade game using arudino uno r3, 0.96 i2c ssd1306 display module and thumbstick gamepd module',
    scopes: ['oled', 'uno'],
    oracle: { minParts: 3, requireTypes: [['uno'], ['board-ssd1306']], check: 'mcu_run' },
  },
  {
    id: 'reg_esp32_mpu_optional',
    bucket: 'regression',
    name: 'ESP32 MPU6050 Tilt Display (ESP32+OLED Scope)',
    prompt: 'build a digital carpenter bubble sprit lvl with esp-32 devkit, mpu-6050 6dof gyro/accel sensor and ssd1306 oled screen showing tilt angle',
    scopes: ['esp32', 'oled'],
    oracle: { minParts: 3, requireTypes: [['esp32'], ['wokwi-mpu6050']], check: 'mcu_run' },
  },
  {
    id: 'reg_lm358_noninv_amp',
    bucket: 'regression',
    name: 'LM358 Non-Inverting Amplifier + DMM',
    prompt: 'build a 2x non-inverting amplifier using an LM358 op-amp powered by 9V battery, 1.5V divider or pot into 1IN+, two 10k feedback resistors from 1OUT to 1IN- and GND, and a DMM measuring 1OUT DC volts',
    scopes: [],
    oracle: { minParts: 5, requireTypes: [['lm358'], ['multimeter']], check: 'dmm_valid' },
  },
  {
    id: 'reg_lm393_comparator_led',
    bucket: 'regression',
    name: 'LM393 Open-Collector Comparator LED',
    prompt: 'build a voltage comparator circuit using LM393 powered from +5V and GND, comparing a pot wiper vs 2.5V resistor divider and lighting a green LED via a 330 ohm pull-up resistor to +5V',
    scopes: [],
    oracle: { minParts: 6, requireTypes: [['lm393'], ['led'], ['resistor']], check: 'led_active' },
  },
  {
    id: 'reg_zener_5v1_clamp',
    bucket: 'regression',
    name: '5.1 V Zener Voltage Reference + DMM',
    prompt: 'build a 5.1V Zener diode shunt regulator from a 12V battery through a 470 ohm series resistor to Zener cathode (anode to GND) and wire a DMM in DCV mode across the Zener',
    scopes: [],
    oracle: { minParts: 4, requireTypes: [['zener'], ['multimeter'], ['battery']], check: 'dmm_valid' },
  },
  {
    id: 'reg_nmos_lowside_led',
    bucket: 'regression',
    name: '2N7000 N-MOSFET LED Driver',
    prompt: 'build an enhancement N-MOSFET 2N7000 low-side switch where a toggle switch drives Gate HIGH, Source goes to GND, and Drain sinks a red LED with 220 ohm resistor from +5V',
    scopes: [],
    oracle: { minParts: 5, requireTypes: [['nmos'], ['led']], check: 'led_active' },
  },
];

export const WILD_CASES = [
  {
    id: 'wild_dark_nightlight',
    bucket: 'wild',
    name: 'Pot-Controlled Darkness Nightlight',
    prompt: 'design an automatic night light comparator trigger using a potentiometer voltage divider feeding an npn 2n3904 driver stage lighting 2 white/yellow leds',
    scopes: [],
    oracle: { minParts: 6, requireTypes: [['npn'], ['pot'], ['led']], check: 'led_active' },
  },
  {
    id: 'wild_metronome',
    bucket: 'wild',
    name: '555 Musicians Metronome',
    prompt: 'build a musician click metronome with ne555 astable using a potentiometer to vary beat tempo, clicking a piezo speaker and flashing a red led on each beat',
    scopes: [],
    oracle: { minParts: 7, requireTypes: [['ne555'], ['pot'], ['buzzer'], ['led']], check: 'buzzer_active' },
  },
  {
    id: 'wild_555_monostable_timer',
    bucket: 'wild',
    name: '555 Egg Timer One-Shot',
    prompt: 'wire a 555 monostable one-shot timer triggered by a tactile push button that holds a green LED lit for 1 second via timing R and C',
    scopes: [],
    oracle: { minParts: 6, requireTypes: [['ne555'], ['tactile', 'button'], ['led']], check: 'led_active' },
  },
  {
    id: 'wild_rc_lowpass_scope',
    bucket: 'wild',
    name: '1kHz RC Low-Pass Filter + Dual-Ch Scope',
    prompt: 'set up a 1kHz RC low-pass filter using funcgen 1kHz sinewave, 1k ohm resistor and 100nF capacitor with oscilloscope ch1 on input and ch2 on filtered output',
    scopes: [],
    oracle: { minParts: 4, requireTypes: [['funcgen'], ['resistor'], ['capacitor'], ['oscilloscope']], check: 'scope_ac' },
  },
  {
    id: 'wild_traffic_light_4017',
    bucket: 'wild',
    name: 'Hardware 555+4017 Traffic Light',
    prompt: 'build a hardware traffic light sequencer (no arduino) with a 555 timer clocking a cd4017 decade counter driving red yellow and green LEDs through diodes/resistors',
    scopes: [],
    oracle: { minParts: 8, requireTypes: [['ne555'], ['ic4017'], ['led']], check: 'led_multi', minActiveLeds: 2 },
  },
  {
    id: 'wild_continuity_tester',
    bucket: 'wild',
    name: 'Audible Continuity Checker',
    prompt: 'wire a continuity tester beep circuit where closing a tactile probe switch enables an npn transistor or 555 buzzer oscillator + green indicator led',
    scopes: [],
    oracle: { minParts: 5, requireTypes: [['tactile', 'button'], ['buzzer']], check: 'buzzer_active' },
  },
  {
    id: 'wild_7483_adder_4bit',
    bucket: 'wild',
    name: '4-Bit Binary Adder + Bargraph',
    prompt: 'wire a 7483 4-bit binary adder with two 4-way dip switches setting operands A and B and 5 LEDs showing Sum0..Sum3 plus Cout',
    scopes: [],
    oracle: { minParts: 8, requireTypes: [['ic7483'], ['led']], check: 'led_active' },
  },
  {
    id: 'wild_pwm_dimmer_555',
    bucket: 'wild',
    name: '555 PWM Variable LED Dimmer',
    prompt: 'create a 555 PWM duty-cycle LED dimmer using two steering 1n4148 diodes and a potentiometer controlling brightness of a high-current LED and viewing PWM on cro scope',
    scopes: [],
    oracle: { minParts: 7, requireTypes: [['ne555'], ['diode'], ['pot'], ['led']], check: 'led_active' },
  },
  {
    id: 'wild_decade_dice',
    bucket: 'wild',
    name: 'Electronic 6-LED Roulette / Dice',
    prompt: 'make an electronic 6-LED roulette wheel with a fast 555 astable clocked thru a pushbutton into cd4017 Q0..Q5 outputs each lighting one LED via 220ohm resistor',
    scopes: [],
    oracle: { minParts: 14, requireTypes: [['ne555'], ['ic4017'], ['led']], check: 'led_multi', minActiveLeds: 2 },
  },
  {
    id: 'wild_bridge_rectifier',
    bucket: 'wild',
    name: 'Full-Wave 4-Diode Bridge + Scope',
    prompt: 'build a 4-diode 1n4007 full wave bridge rectifier fed by 100Hz sine function generator across a 1k load resistor with scope measuring output ripple',
    scopes: [],
    oracle: { minParts: 7, requireTypes: [['funcgen'], ['diode'], ['oscilloscope']], check: 'scope_ac' },
  },
  {
    id: 'wild_pc817_opto_isolated',
    bucket: 'wild',
    name: 'PC817 Optocoupler Isolated Driver',
    prompt: 'build a galvanically isolated LED driver with a PC817 optocoupler: +5V switch -> 220 ohm -> PC817 A/K -> GND, and an isolated 9V battery -> 470 ohm -> red LED -> PC817 collector/emitter',
    scopes: [],
    oracle: { minParts: 5, requireTypes: [['pc817'], ['led'], ['battery']], check: 'led_active' },
  },
  {
    id: 'wild_lm317_adjustable_reg',
    bucket: 'wild',
    name: 'LM317 Adjustable 5V Supply + DMM',
    prompt: 'build a 5V adjustable regulator using LM317 powered by a 9V battery with 240 ohm resistor between OUT and ADJ, 720 ohm from ADJ to GND, and a DMM reading regulated OUT DC volts',
    scopes: [],
    oracle: { minParts: 5, requireTypes: [['lm317'], ['multimeter'], ['battery']], check: 'dmm_valid' },
  },
  {
    id: 'wild_xor_parity',
    bucket: 'wild',
    name: '3-Input Odd Parity Checker (7486)',
    prompt: 'wire a 3-bit odd parity checker using 7486 XOR gates and 3 toggle switches so the output LED lights when an odd number of switches are HIGH',
    scopes: [],
    oracle: { minParts: 6, requireTypes: [['ic7486'], ['led']], check: 'led_active' },
  },
  {
    id: 'wild_74138_decoder_bar',
    bucket: 'wild',
    name: '3-to-8 Line Decoder Visualizer (74138)',
    prompt: 'build a 74138 3-to-8 decoder demo clocked by a 7493 3-bit counter and 555 clock driving 8 LEDs active-LOW (exactly one LED switches sequentially)',
    scopes: [],
    oracle: { minParts: 12, requireTypes: [['ic74138'], ['led']], check: 'led_multi', minActiveLeds: 4 },
  },
  {
    id: 'wild_uno_binary_upcounter',
    bucket: 'wild',
    name: 'Arduino 4-Bit LED Binary Counter',
    prompt: 'program an arduino uno to count 0..15 every 250ms across 4 colored LEDs (D2..D5 with 220ohm resistors) plus print the count on Serial',
    scopes: ['uno'],
    oracle: { minParts: 9, requireTypes: [['uno'], ['led']], check: 'mcu_run' },
  },
  {
    id: 'wild_7402_nor_sr',
    bucket: 'wild',
    name: 'Active-HIGH NOR SR Latch (7402)',
    prompt: 'make an active-HIGH SR flip-flop latch using 7402 quad NOR chip, two pushbutton switches with pulldown resistors, and two LEDs for Q and Qbar',
    scopes: [],
    oracle: { minParts: 7, requireTypes: [['ic7402'], ['led']], check: 'led_active' },
  },
];

const MUTATION_BLUEPRINTS = [
  { key: 'fuzz', tpl: '{build} an electric guitar overdrive clipping fx using {funcgen}, coupling {capacitor}, {resistor}, 2 opposite {diode} diodes and {scope}', scopes: [], oracle: { minParts: 5, requireTypes: [['funcgen'], ['diode'], ['oscilloscope']], check: 'scope_ac' } },
  { key: 'apc', tpl: '{build} an atari punk synth with dual {ne555}, 2 {pot} knobs for freq and pw, {capacitor}s and {buzzer}', scopes: [], oracle: { minParts: 7, requireTypes: [['ne555'], ['pot'], ['buzzer']], check: 'buzzer_active' } },
  { key: 'chaser', tpl: '{build} a knight rider 8 led chaser using {ne555} clock chip, {ic4017} chip, and 8 {led}s with {resistor}', scopes: [], oracle: { minParts: 18, requireTypes: [['ne555'], ['ic4017'], ['led']], check: 'led_multi', minActiveLeds: 4 } },
  { key: 'siren', tpl: '{build} a police wailing siren using 2 {ne555} chips where slow timer modulates CV pin of fast timer driving a {buzzer}', scopes: [], oracle: { minParts: 8, requireTypes: [['ne555'], ['buzzer']], check: 'buzzer_active' } },
  { key: 'darlington', tpl: '{build} a skin resistance tester with two {npn} transistors in darlington, a {pot}, {tactile} switch, {led} and {buzzer}', scopes: [], oracle: { minParts: 7, requireTypes: [['npn'], ['pot'], ['led']], check: 'led_active' } },
  { key: 'simon', tpl: '{build} a simon says game using {uno}, 4 {led}s with {resistor}, 4 {tactile} switches and {buzzer}', scopes: ['uno'], oracle: { minParts: 14, requireTypes: [['uno'], ['led'], ['buzzer']], check: 'mcu_run' } },
  { key: 'bar595', tpl: '{build} a serial chaser on {uno} with {ic74595} shift IC driving an {bargraph} display', scopes: ['uno'], oracle: { minParts: 5, requireTypes: [['uno'], ['ic74595'], ['bargraph']], check: 'bargraph_active' } },
  { key: 'monostable', tpl: '{build} a {ne555} one-shot monostable pulse timer triggered by {tactile} switch lighting a {led} with {resistor} and {capacitor}', scopes: [], oracle: { minParts: 6, requireTypes: [['ne555'], ['led']], check: 'led_active' } },
  { key: 'bjt_driver', tpl: '{build} an {npn} common-emitter switch activated by {tactile} button through 10k {resistor} powering a {led} and {buzzer}', scopes: [], oracle: { minParts: 6, requireTypes: [['npn'], ['led']], check: 'led_active' } },
  { key: 'rc_scope', tpl: '{build} a 1khz rc filter from {funcgen} through 1k {resistor} and 100nF {capacitor} measured on {scope}', scopes: [], oracle: { minParts: 4, requireTypes: [['funcgen'], ['resistor'], ['capacitor'], ['oscilloscope']], check: 'scope_ac' } },
  { key: 'rectifier', tpl: '{build} a half-wave rectifier with {funcgen} sine input, 1n4007 {diode}, 1k {resistor}, {capacitor} and {scope}', scopes: [], oracle: { minParts: 5, requireTypes: [['funcgen'], ['diode'], ['oscilloscope']], check: 'scope_ac' } },
  { key: 'counter7seg', tpl: '{build} a 7493 decade/binary counter with 7447 decoder, 7-segment display and 2hz clock source', scopes: [], oracle: { minParts: 5, requireTypes: [['ic7493'], ['ic7447'], ['seg7']], check: 'seg7_active' } },
];

export function buildMutationPool(count = 240, seed = 20261117) {
  const pool = [];
  for (let i = 0; i < count; i++) {
    const bp = MUTATION_BLUEPRINTS[i % MUTATION_BLUEPRINTS.length];
    const rng = prng(seed + i * 7919);
    const variant = Math.floor(i / MUTATION_BLUEPRINTS.length) + 1;
    pool.push({
      id: `mut_${bp.key}_v${String(variant).padStart(3, '0')}`,
      bucket: 'mutation',
      name: `Mutated ${bp.key} #${variant}`,
      prompt: expandTypoText(rng, bp.tpl),
      scopes: bp.scopes,
      oracle: bp.oracle,
    });
  }
  return pool;
}

const BOOL_FORMULAS = [
  { expr: "F = A'B + AB'", gates: ['mixed', 'nand'], hint: [['ic7486', 'ic7400', 'ic7408'], ['led']] },
  { expr: "F = (A + B) * C'", gates: ['mixed', 'nand'], hint: [['ic7432', 'ic7408', 'ic7404', 'ic7400'], ['led']] },
  { expr: 'Y = (A ^ B) & C', gates: ['mixed', 'nand'], hint: [['ic7486', 'ic7408', 'ic7400'], ['led']] },
  { expr: "F = A'B'C + ABC'", gates: ['mixed', 'nand'], hint: [['ic7408', 'ic7432', 'ic7404', 'ic7400'], ['led']] },
  { expr: 'Y = !(A & B) + C', gates: ['mixed', 'nand'], hint: [['ic7400', 'ic7432'], ['led']] },
  { expr: "F = A(B + C')", gates: ['mixed', 'nand'], hint: [['ic7408', 'ic7432', 'ic7404', 'ic7400'], ['led']] },
  { expr: 'F = (A & B) | (B & C) | (A & C)', gates: ['mixed', 'nand'], hint: [['ic7408', 'ic7432', 'ic7400'], ['led']] }, // 3-input majority voter
  { expr: 'F = (A ^ B) ^ C', gates: ['mixed'], hint: [['ic7486'], ['led']] }, // 3-input parity
  { expr: "Y = A' + B' * C", gates: ['mixed', 'nand'], hint: [['ic7404', 'ic7408', 'ic7432', 'ic7400'], ['led']] },
  { expr: 'F = !(A ^ B)', gates: ['mixed', 'nand'], hint: [['ic7486', 'ic7404', 'ic7400', 'ic74266'], ['led']] },
];

const CHAIN_COMBOS = [
  {
    tpl: '{build} {freq} funcgen sine wave through a {diode} bridge rectifier and filter {capacitor} into 1k {resistor} measured on {scope}',
    scopes: [],
    freqs: ['50Hz', '100Hz', '250Hz'],
    oracle: { minParts: 7, requireTypes: [['funcgen'], ['diode'], ['oscilloscope']], check: 'scope_ac' },
  },
  {
    tpl: '{build} a {freq} {ne555} astable oscillator driving {ic4017} counting {nleds} LEDs with {resistor} in sequence',
    scopes: [],
    freqs: ['2Hz', '5Hz', '10Hz'],
    nleds: [4, 6, 8],
    oracle: { minParts: 10, requireTypes: [['ne555'], ['ic4017'], ['led']], check: 'led_multi', minActiveLeds: 2 },
  },
  {
    tpl: '{build} an arduino {uno} sketch scanning {nleds} LEDs with {resistor} controlled by a {tactile} button or {pot}',
    scopes: ['uno'],
    nleds: [3, 4, 5],
    oracle: { minParts: 6, requireTypes: [['uno'], ['led']], check: 'mcu_run' },
  },
  {
    tpl: '{build} a {freq} clock feeding a 7493 counter + 7447 BCD decoder driving a common-anode 7-segment display',
    scopes: [],
    freqs: ['1Hz', '2Hz', '5Hz'],
    oracle: { minParts: 5, requireTypes: [['ic7493'], ['ic7447'], ['seg7']], check: 'seg7_active' },
  },
  {
    tpl: '{build} an {npn} transistor two-LED inverse switch: {tactile} button with {pot} driving {led} and {buzzer}',
    scopes: [],
    oracle: { minParts: 6, requireTypes: [['npn'], ['led'], ['buzzer']], check: 'led_active' },
  },
  {
    tpl: '{build} a {freq} RC filter using {funcgen}, 1k {resistor}, 100nF {capacitor} and view phase/amplitude on {scope}',
    scopes: [],
    freqs: ['200Hz', '1kHz', '2kHz'],
    oracle: { minParts: 4, requireTypes: [['funcgen'], ['resistor'], ['capacitor'], ['oscilloscope']], check: 'scope_ac' },
  },
];

/**
 * Bucket 4: Offline Combinatorial Topology Generator (Boolean expressions + parametric electronics chains).
 */
export function buildCombinatorialPool(count = 400, seed = 918273) {
  const pool = [];
  for (let i = 0; i < count; i++) {
    const rng = prng(seed + i * 65537);
    if (i % 3 === 0) {
      const bf = pick(rng, BOOL_FORMULAS);
      const gateMode = pick(rng, bf.gates);
      const gateTxt = gateMode === 'nand' ? 'using ONLY NAND gates (ic7400)' : 'using 74xx logic gates';
      const swTxt = rng() < 0.5 ? 'toggle switches' : 'a DIP4 switch';
      pool.push({
        id: `comb_bool_${String(i).padStart(3, '0')}`,
        bucket: 'combinatorial',
        name: `Boolean ${bf.expr} (${gateMode})`,
        prompt: `${pick(rng, SYN.build)} ${bf.expr} ${gateTxt} with ${swTxt} and an output LED + 220ohm ${pick(rng, SYN.resistor)}`,
        scopes: [],
        oracle: { minParts: 4, requireTypes: [['led']], check: 'led_active' },
      });
    } else {
      const ch = pick(rng, CHAIN_COMBOS);
      let txt = ch.tpl
        .replace('{freq}', ch.freqs ? pick(rng, ch.freqs) : '')
        .replace('{nleds}', ch.nleds ? String(pick(rng, ch.nleds)) : '4');
      txt = expandTypoText(rng, txt);
      pool.push({
        id: `comb_chain_${String(i).padStart(3, '0')}`,
        bucket: 'combinatorial',
        name: `Combinatorial chain #${i}`,
        prompt: txt,
        scopes: ch.scopes,
        oracle: ch.oracle,
      });
    }
  }
  return pool;
}

const SKIP_SCOPE_TYPES = {
  oled: ['board-ssd1306', 'wokwi-sh1107'],
  esp32: ['esp32', 'esp32s3'],
  i2c_display: ['board-ssd1306', 'wokwi-sh1107', 'wokwi-lcd1602', 'wokwi-lcd2004', 'lcd16x2'],
};

/**
 * Normalize/sanitize LLM-generated or saved curriculum/autoreg oracles so equivalent parts
 * (vcc/battery/psu, button/tactile/toggle, seg7 without bogus discrete LED) & DC circuits aren't falsely flagged.
 */
export function sanitizeEvalCase(tc) {
  if (!tc || typeof tc !== 'object') return tc;
  const isIdea = /^(?:autoreg_)?idea_/.test(String(tc.id || ''));
  if (!isIdea) return tc;

  const prompt = String(tc.prompt || '');
  const orig = tc.oracle || {};
  const hasSeg7 = (orig.requireTypes || []).some(g => Array.isArray(g) && g.includes('seg7'));
  let minParts = orig.minParts || 3;

  const reqs = [];
  for (const grp of (orig.requireTypes || [])) {
    const arr = (Array.isArray(grp) ? grp : [grp]).map(t => String(t || '').trim()).filter(Boolean);
    if (!arr.length) continue;
    if (arr.length === 1) {
      const t = arr[0];
      if (t === 'led' && hasSeg7 && !/\bleds?\b/i.test(prompt)) continue;
      if (t === 'ic7400' && !/\b(7400|nand|logic\s*gate)\b/i.test(prompt)) continue;
      if (t === 'multimeter' && !/\b(multimeter|dmm|ohmmeter|continuity|measure|current)\b/i.test(prompt)) continue;
      if ((t === 'resistor' || t === 'gnd') && /\b(arduino|uno)\b/i.test(prompt) && !/\b(resistor|gnd|led|divider|pot)\b/i.test(prompt)) {
        if (minParts > 2) minParts = 2;
        continue;
      }
      if (t === 'power-supply' && !/\b(bench|mps|dual\s*rail|power[- ]supply)\b/i.test(prompt)) {
        reqs.push(['power-supply', 'battery', 'vcc']);
        continue;
      }
      if (t === 'vcc') {
        reqs.push(['vcc', 'battery', 'power-supply', 'funcgen', 'uno', 'nano', 'esp32', 'esp32s3', 'bluepill']);
        continue;
      }
      if (t === 'button' || t === 'tactile') {
        reqs.push(['button', 'tactile', 'toggle']);
        continue;
      }
      if (t === 'pot' && !/\b(pot|potentiometer|trimpot|knob)\b/i.test(prompt)) {
        reqs.push(['pot', 'wokwi-slide-potentiometer', 'resistor']);
        continue;
      }
    }
    reqs.push(arr);
  }

  let check = orig.check || 'led_active';
  const hasDcReg = /\b(zener|lm317|lm7805|regulator|doubles\s+the\s+input\s+dc|voltage\s+doubler|rc\s+circuit\s+for\s+analysis)\b/i.test(prompt);
  const hasAcIntent = /\b(scope|cro|oscilloscope|func\s*gen|signal\s*gen|sine|ac\b|wave|filter|rectif|amp|op[-\s]?amp|ring\s*osc)\b/i.test(prompt)
    && !(hasDcReg && !/\b(scope|cro|oscilloscope|func\s*gen|signal\s*gen)\b/i.test(prompt));
  if (check === 'scope_ac' && !hasAcIntent) {
    check = reqs.some(r => r.includes('multimeter')) ? 'dmm_valid'
      : reqs.some(r => r.includes('led')) ? 'led_active'
      : 'built_clean';
  }

  return {
    ...tc,
    oracle: {
      ...orig,
      minParts,
      requireTypes: reqs.slice(0, 4),
      check,
    },
  };
}

/**
 * Bucket 5 (1 call/day): Ask the LLM to invent `count` brand-new realistic buildable circuits
 * using ONLY currently enabled component types, avoiding previously generated ideas.
 */
export async function generateDailyNewIdeas({ apiKey, model, availableModels = null, existingIdeas = [], skipScopes = [], count = 12 }) {
  const skip = new Set(skipScopes.map(s => s.trim().toLowerCase()).filter(Boolean));
  const blockedTypes = new Set();
  for (const s of skip) for (const t of SKIP_SCOPE_TYPES[s] || []) blockedTypes.add(t);

  const validTypes = allDefs()
    .map(d => d.type)
    .filter(t => t !== 'trainer-board' && !blockedTypes.has(t));

  const recentTitles = existingIdeas.slice(-40).map(i => i.name).join('; ');
  const sys = [
    'You are an electronics lab curriculum designer.',
    `Supported CircuitForge component types: ${validTypes.join(', ')}.`,
    'Invent distinct, practical, buildable electronics circuits across levels: Analog/Diodes, BJT Switching, 555 Timers, 74xx Logic/Counters, Benchtop Instruments, and Arduino Uno.',
    'NEVER request component types outside the supported list above.',
    recentTitles ? `Avoid duplicating these already-generated ideas: ${recentTitles}` : '',
    `Output MINIFIED STRICT JSON ONLY: {"ideas":[{"name":"short title","prompt":"realistic user prompt (may include minor casual phrasing)","requireTypes":["ne555","led"],"check":"led_active|led_multi|buzzer_active|scope_ac|seg7_active|bargraph_active|mcu_run|dmm_valid|built_clean","usesUno":false}]} with exactly ${count} ideas.`,
  ].filter(Boolean).join('\n');

  const res = await callGemini({
    apiKey,
    model,
    availableModels,
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: `Generate ${count} fresh electronics circuit ideas.` },
    ],
    jsonMode: true,
  });

  const parsed = res?.parsed || extractJsonObject(res?.rawText || '');
  const rawIdeas = Array.isArray(parsed?.ideas) ? parsed.ideas : (Array.isArray(parsed) ? parsed : []);
  const validSet = new Set(validTypes);
  const existingNames = new Set(existingIdeas.map(i => String(i.name || '').toLowerCase().trim()));
  const out = [];

  for (const item of rawIdeas) {
    const name = String(item?.name || '').trim();
    const prompt = String(item?.prompt || '').trim();
    if (!name || !prompt || existingNames.has(name.toLowerCase())) continue;
    const reqList = Array.isArray(item.requireTypes)
      ? item.requireTypes
          .map(t => {
            const raw = String(t).trim();
            return validSet.has(raw) ? raw : resolvePartType(raw)?.type;
          })
          .filter(t => t && validSet.has(t))
          .map(t => [t])
      : [];
    if (!reqList.length) continue;
    const usesUno = Boolean(item.usesUno) || /\b(uno|arduino|atmega)\b/i.test(prompt) || reqList.some(r => r[0] === 'uno');
    const scopes = usesUno ? ['uno'] : [];
    if (scopes.some(s => skip.has(s))) continue;

    const supportedChecks = ['led_active', 'led_multi', 'buzzer_active', 'scope_ac', 'seg7_active', 'bargraph_active', 'mcu_run', 'dmm_valid', 'built_clean'];
    const check = supportedChecks.includes(item.check) ? item.check : 'led_active';

    existingNames.add(name.toLowerCase());
    out.push(sanitizeEvalCase({
      id: `idea_${Date.now().toString(36)}_${out.length}`,
      bucket: 'curriculum',
      name,
      prompt,
      scopes,
      oracle: {
        minParts: 3,
        requireTypes: reqList.slice(0, 4),
        check,
      },
      createdAt: new Date().toISOString().slice(0, 10),
    }));
  }
  return out;
}

/**
 * Assemble prioritized daily queue:
 * 1) Active auto_regression failures (to confirm bug fixes!)
 * 2) Pinned core REGRESSION_CASES
 * 3) Today's newly generated curriculum ideas (+ typo variant)
 * 4) Rotating WILD_CASES + resumable MUTATION + COMBINATORIAL pools
 */
export function selectDailyQueue({
  state,
  autoRegressions = [],
  newCurriculumIdeas = [],
  skipScopes = [],
  targetPrompts = 220,
  seed = 20261117,
}) {
  const skip = new Set(skipScopes.map(s => s.trim().toLowerCase()).filter(Boolean));
  const allowed = (c) => !(c.scopes || []).some(s => skip.has(s.toLowerCase()));

  const autoRegAllowed = autoRegressions.filter(allowed).slice(0, 35).map(r => ({ ...r, bucket: 'auto_regression' }));
  const regAll = REGRESSION_CASES.filter(allowed);
  const wildAll = WILD_CASES.filter(allowed);
  const mutPool = buildMutationPool(240, seed).filter(allowed);
  const combPool = buildCombinatorialPool(400, seed).filter(allowed);

  const queue = [];
  for (const ar of autoRegAllowed) {
    if (queue.length < targetPrompts) queue.push(ar);
  }
  for (const rg of regAll) {
    if (queue.length < targetPrompts) queue.push(rg);
  }
  const rngCur = prng(seed + state.history.length * 997);
  for (const idea of newCurriculumIdeas.filter(allowed)) {
    if (queue.length < targetPrompts) queue.push(idea);
    if (queue.length < targetPrompts && rngCur() < 0.7) {
      queue.push({
        ...idea,
        id: `${idea.id}_typo`,
        bucket: 'curriculum',
        name: `${idea.name} (typos)`,
        prompt: expandTypoText(rngCur, idea.prompt),
      });
    }
  }

  const wildTarget = Math.min(wildAll.length, Math.max(4, Math.floor(targetPrompts * 0.08)));
  const wildStart = (state.cursors.wild || 0) % Math.max(1, wildAll.length);
  for (let i = 0; i < wildTarget && queue.length < targetPrompts; i++) {
    queue.push(wildAll[(wildStart + i) % wildAll.length]);
  }

  // Alternate between combinatorial new topologies and typo mutations from persistent cursors
  let mi = 0, ci = 0;
  const mutStart = state.cursors.mutation || 0;
  const combStart = state.cursors.combinatorial || 0;
  while (queue.length < targetPrompts && (mi < mutPool.length || ci < combPool.length)) {
    if (ci < combPool.length && queue.length < targetPrompts) {
      queue.push(combPool[(combStart + ci) % combPool.length]);
      ci++;
    }
    if (mi < mutPool.length && queue.length < targetPrompts) {
      queue.push(mutPool[(mutStart + mi) % mutPool.length]);
      mi++;
    }
  }

  return {
    queue,
    sizes: {
      autoRegression: autoRegAllowed.length,
      regression: regAll.length,
      curriculum: newCurriculumIdeas.length,
      wild: wildAll.length,
      mutation: mutPool.length,
      combinatorial: combPool.length,
    },
  };
}

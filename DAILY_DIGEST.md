# CircuitForge Daily AI Eval — 2026-11-17

- **Stop Reason**: reached daily call cap (300)
- **Model**: `gemini-3.5-flash-lite` | **Skipped Scopes**: `oled,esp32,i2c_display`
- **Cases Executed**: **111** | **Clean Pass (excl. infra)**: **74/110 (67.3%)**
- **HTTP Calls Used**: **300 / 300** (429: 30, 503: 67, timeouts: 5)
- **Tokens Used**: **615,154** (515,006 in + 100,148 out)
- **Auto-Regressions Fixed Today**: **0** | **Active Auto-Regressions Remaining**: **25**
- **New Curriculum Ideas Invented**: **12** | **Verified Fine-Tune Rows**: **+74 (Total: 74)**
- **Next Cursors**: `wild=14`, `mutation=29`, `combinatorial=30`

## Tier Breakdown
| Tier | Count | Meaning |
|---|---:|---|
| PASS | 74 | Built, verified, ov=0 & dbl=0, functional oracle passed |
| T1_BUILD_FAIL | 27 | Rejected by validator/DRC/LED/pin resolver |
| T2_SILENT_DEAD | 9 | Built ok=true, but simulator oracle stayed flat/dead/missing |
| T3_LAYOUT_DEBT | 0 | Functionally active, but overlaps (ov>0) or double-pins (dbl>0) |
| T4_API_INFRA | 1 | Failed strictly due to 429/503/timeout exhaustion |

## Bucket Pass Rates
| Bucket | Clean Pass / Attempted | Rate |
|---|---:|---:|
| regression | 13 / 16 | 81.3% |
| curriculum | 11 / 21 | 52.4% |
| wild | 9 / 14 | 64.3% |
| combinatorial | 19 / 30 | 63.3% |
| mutation | 22 / 30 | 73.3% |

## Top Actionable Failure Signatures Today
| Hits | Tier | Signature | Example Case |
|---:|---|---|---|
| 8 | T1_BUILD_FAIL | Oscilloscope "<ref>" CH*/CH* captured #.# Vpp on dynamic circuit — probe an oscillating signal net (e.g. U*.OUT / filter node) with "OSC*.CH | `reg_guitar_fuzz`: bild an elektric guitar overdrive diode clipper fx circuit using func gen s… |
| 2 | T2_SILENT_DEAD | missing expected type (vcc) | `idea_mwl354p0_3`: Can you design a basic audio amplifier circuit using a transistor? I want t… |
| 2 | T2_SILENT_DEAD | oscilloscope captured flat/no AC waveform (vpp <= <val>) | `idea_mwl354p0_4_typo`: I want to create a circuit that doubles the input DC voltage using diodes.… |
| 2 | T1_BUILD_FAIL | button (ref "<ref>") OUT is a #-pin active HIGH/LOW driver; do NOT wire it directly to +<val> or GND (wire "B*.OUT" directly to its destinat | `idea_mwl354p0_6`: I need a circuit that produces a single output pulse of a specific duration… |
| 2 | T2_SILENT_DEAD | missing expected type (led) | `idea_mwl354p0_7`: How can I use a 7490 decade counter to drive a 7-segment display? I want to… |
| 2 | T2_SILENT_DEAD | missing expected type (ic7400) | `idea_mwl354p0_11`: I need a simple tool to check logic levels (high/low) on a digital circuit.… |
| 2 | T1_BUILD_FAIL | LED "<ref>" never turned ON (peak <val>; Anode=<val>, Cathode=<val>) — fix its resistor/driver wiring, check counter/gate inputs, and ensure | `wild_decade_dice`: make an electronic 6-LED roulette wheel with a fast 555 astable clocked thr… |
| 2 | T1_BUILD_FAIL | LED "<ref>" never turned ON (peak <val>; Anode=<val>, Cathode=NC) — fix its resistor/driver wiring, check counter/gate inputs, and ensure se | `comb_chain_013`: setup an bc547 transistor two-LED inverse switch: pushbutton button with tr… |
| 1 | T1_BUILD_FAIL | + → -: Short <val> supply to ground. | `reg_multiturn_555_mod`: build a 555 astable blinker driving a red LED with 220 ohm resistor => keep… |
| 1 | T2_SILENT_DEAD | missing expected type (gnd) | `idea_mwl354p0_8`: I want to see how a resistor and capacitor interact with a voltage source. … |
| 1 | T1_BUILD_FAIL | Unknown pin "GND(##)" on part "GND" (gnd). Valid pins: [GND(##)] | `idea_mwl354p0_8_typo`: I want to see how a resistor and capacitor interact with a voltage source. … |
| 1 | T1_BUILD_FAIL | Oscilloscope "OSC" CH*/CH* captured #.# Vpp on dynamic circuit — probe an oscillating signal net (e.g. U*.OUT / filter node) with "OSC.CH*+" | `wild_rc_lowpass_scope`: set up a 1kHz RC low-pass filter using funcgen 1kHz sinewave, 1k ohm resist… |
| 1 | T1_BUILD_FAIL | Output pins #, # are shorted to another output or a supply. | `wild_traffic_light_4017`: build a hardware traffic light sequencer (no arduino) with a 555 timer cloc… |
| 1 | T1_BUILD_FAIL | LED "<ref>" has an unconnected pin — wire Anode (via #–#Ω resistor) to its driver/signal and Cathode to "-". | `mut_chaser_v001`: wrire a knight rider 8 led chaser using ne-555 clock chip, 4017 chip, and 8… |
| 1 | T1_BUILD_FAIL | Boolean logic verification failed for Y = A' + B' * C: when (A=#, B=#, C=#): expected #, got LED OFF (#); when (A=#, B=#, C=#): expected #,  | `comb_bool_006`: bild Y = A' + B' * C using ONLY NAND gates (ic7400) with a DIP4 switch and … |

## Cumulative Top Bugs Across Days (from `state.json`)
| Total Hits | Tier | Signature | First Seen | Last Seen |
|---:|---|---|---|---|
| 8 | T1_BUILD_FAIL | Oscilloscope "<ref>" CH*/CH* captured #.# Vpp on dynamic circuit — probe an oscillating signal net (e.g. U*.OUT / filter node) with "OSC*.CH | 2026-11-17 | 2026-11-17 |
| 2 | T2_SILENT_DEAD | missing expected type (vcc) | 2026-11-17 | 2026-11-17 |
| 2 | T2_SILENT_DEAD | oscilloscope captured flat/no AC waveform (vpp <= <val>) | 2026-11-17 | 2026-11-17 |
| 2 | T1_BUILD_FAIL | button (ref "<ref>") OUT is a #-pin active HIGH/LOW driver; do NOT wire it directly to +<val> or GND (wire "B*.OUT" directly to its destinat | 2026-11-17 | 2026-11-17 |
| 2 | T2_SILENT_DEAD | missing expected type (led) | 2026-11-17 | 2026-11-17 |
| 2 | T2_SILENT_DEAD | missing expected type (ic7400) | 2026-11-17 | 2026-11-17 |
| 2 | T1_BUILD_FAIL | LED "<ref>" never turned ON (peak <val>; Anode=<val>, Cathode=<val>) — fix its resistor/driver wiring, check counter/gate inputs, and ensure | 2026-11-17 | 2026-11-17 |
| 2 | T1_BUILD_FAIL | LED "<ref>" never turned ON (peak <val>; Anode=<val>, Cathode=NC) — fix its resistor/driver wiring, check counter/gate inputs, and ensure se | 2026-11-17 | 2026-11-17 |
| 1 | T1_BUILD_FAIL | + → -: Short <val> supply to ground. | 2026-11-17 | 2026-11-17 |
| 1 | T2_SILENT_DEAD | missing expected type (gnd) | 2026-11-17 | 2026-11-17 |

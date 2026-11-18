# CircuitForge Daily AI Eval — 2026-11-18

- **Stop Reason**: 2 consecutive cases exhausted all models (API quota/infra) — stopping for today
- **Model**: `gemini-3.5-flash-lite` | **Skipped Scopes**: `oled,esp32,i2c_display`
- **Cases Executed**: **24** | **Clean Pass (excl. infra)**: **5/22 (22.7%)**
- **HTTP Calls Used**: **103 / 300** (429: 36, 503: 8, timeouts: 6)
- **Tokens Used**: **162,915** (138,379 in + 24,536 out)
- **Auto-Regressions Fixed Today**: **5** | **Active Auto-Regressions Remaining**: **20**
- **New Curriculum Ideas Invented**: **12** | **Verified Fine-Tune Rows**: **+5 (Total: 79)**
- **Next Cursors**: `wild=14`, `mutation=29`, `combinatorial=30`

## Tier Breakdown
| Tier | Count | Meaning |
|---|---:|---|
| PASS | 5 | Built, verified, ov=0 & dbl=0, functional oracle passed |
| T1_BUILD_FAIL | 12 | Rejected by validator/DRC/LED/pin resolver |
| T2_SILENT_DEAD | 5 | Built ok=true, but simulator oracle stayed flat/dead/missing |
| T3_LAYOUT_DEBT | 0 | Functionally active, but overlaps (ov>0) or double-pins (dbl>0) |
| T4_API_INFRA | 2 | Failed strictly due to 429/503/timeout exhaustion |

## Bucket Pass Rates
| Bucket | Clean Pass / Attempted | Rate |
|---|---:|---:|
| auto_regression | 5 / 24 | 20.8% |

## Auto-Regressions Resolved Today
- `autoreg_reg_guitar_fuzz` (Oscilloscope "<ref>" CH*/CH* captured #.# Vpp on dynamic circuit — probe an oscillating signal net (e.g. U*.OUT / filter node) with "OSC*.CH)
- `autoreg_idea_mwl354p0_3` (missing expected type (vcc))
- `autoreg_idea_mwl354p0_6` (button (ref "<ref>") OUT is a #-pin active HIGH/LOW driver; do NOT wire it directly to +<val> or GND (wire "B*.OUT" directly to its destinat)
- `autoreg_mut_chaser_v001` (LED "<ref>" has an unconnected pin — wire Anode (via #–#Ω resistor) to its driver/signal and Cathode to "-".)
- `autoreg_mut_bjt_driver_v002` (LED "<ref>" never turned ON (peak <val>; Anode=<val>, Cathode=NC) — fix its resistor/driver wiring, check counter/gate inputs, and ensure se)

## Top Actionable Failure Signatures Today
| Hits | Tier | Signature | Example Case |
|---:|---|---|---|
| 3 | T1_BUILD_FAIL | Oscilloscope "<ref>" CH*/CH* captured #.# Vpp on dynamic circuit — probe an oscillating signal net (e.g. U*.OUT / filter node) with "OSC*.CH | `autoreg_reg_half_wave_rect`: build a half wave rectifier with a 1n4007 diode, function generator 100Hz s… |
| 2 | T2_SILENT_DEAD | oscilloscope captured flat/no AC waveform (vpp <= <val>) | `autoreg_idea_mwl354p0_4`: I want to create a circuit that doubles the input DC voltage using diodes.… |
| 2 | T1_BUILD_FAIL | Oscilloscope "<ref>" CH*/CH* captured #.# Vpp on dynamic circuit — probe an oscillating signal net (e.g. U*.OUT / filter node) with "O*.CH*+ | `autoreg_wild_rc_lowpass_scope`: set up a 1kHz RC low-pass filter using funcgen 1kHz sinewave, 1k ohm resist… |
| 2 | T1_BUILD_FAIL | LED "<ref>" never turned ON (peak <val>; Anode=<val>, Cathode=NC) — fix its resistor/driver wiring, check counter/gate inputs, and ensure se | `autoreg_mut_bjt_driver_v001`: build an npn common-emitter switch activated by poshbutton button through 1… |
| 1 | T2_SILENT_DEAD | missing expected type (led) | `autoreg_idea_mwl354p0_7`: How can I use a 7490 decade counter to drive a 7-segment display? I want to… |
| 1 | T2_SILENT_DEAD | missing expected type (ic7400) | `autoreg_idea_mwl354p0_11`: I need a simple tool to check logic levels (high/low) on a digital circuit.… |
| 1 | T1_BUILD_FAIL | Output pins #, # are shorted to another output or a supply. | `autoreg_wild_traffic_light_4017`: build a hardware traffic light sequencer (no arduino) with a 555 timer cloc… |
| 1 | T2_SILENT_DEAD | missing expected type (ne555) | `autoreg_wild_decade_dice`: make an electronic 6-LED roulette wheel with a fast 555 astable clocked thr… |
| 1 | T1_BUILD_FAIL | button (ref "<ref>") OUT is a #-pin active HIGH/LOW driver; do NOT wire it directly to +<val> or GND (wire "SW*.OUT" directly to its destina | `autoreg_wild_7402_nor_sr`: make an active-HIGH SR flip-flop latch using 7402 quad NOR chip, two pushbu… |
| 1 | T1_BUILD_FAIL | {"intent":"build","plan":"Setup an Arduino Uno with # LEDs and a potentiometer to control LED scanning speed or pattern, including pull-down | `autoreg_comb_chain_005`: setup an arduino arduino uno sketch scanning 3 LEDs with resiter controlled… |
| 1 | T1_BUILD_FAIL | Boolean logic verification failed for Y = A' + B' * C: when (A=#, B=#, C=#): expected #, got LED OFF (#); when (A=#, B=#, C=#): expected #,  | `autoreg_comb_bool_006`: bild Y = A' + B' * C using ONLY NAND gates (ic7400) with a DIP4 switch and … |
| 1 | T1_BUILD_FAIL | diode ("<ref>") has one open/unconnected pin ("Anode") — connect "D*.Anode" to complete the circuit. | `autoreg_comb_chain_014`: wire 50Hz funcgen sine wave through a rectifier diode bridge rectifier and … |

## Cumulative Top Bugs Across Days (from `state.json`)
| Total Hits | Tier | Signature | First Seen | Last Seen |
|---:|---|---|---|---|
| 11 | T1_BUILD_FAIL | Oscilloscope "<ref>" CH*/CH* captured #.# Vpp on dynamic circuit — probe an oscillating signal net (e.g. U*.OUT / filter node) with "OSC*.CH | 2026-11-17 | 2026-11-18 |
| 4 | T2_SILENT_DEAD | oscilloscope captured flat/no AC waveform (vpp <= <val>) | 2026-11-17 | 2026-11-18 |
| 4 | T1_BUILD_FAIL | LED "<ref>" never turned ON (peak <val>; Anode=<val>, Cathode=NC) — fix its resistor/driver wiring, check counter/gate inputs, and ensure se | 2026-11-17 | 2026-11-18 |
| 3 | T2_SILENT_DEAD | missing expected type (led) | 2026-11-17 | 2026-11-18 |
| 3 | T2_SILENT_DEAD | missing expected type (ic7400) | 2026-11-17 | 2026-11-18 |
| 3 | T1_BUILD_FAIL | Oscilloscope "<ref>" CH*/CH* captured #.# Vpp on dynamic circuit — probe an oscillating signal net (e.g. U*.OUT / filter node) with "O*.CH*+ | 2026-11-17 | 2026-11-18 |
| 2 | T2_SILENT_DEAD | missing expected type (vcc) | 2026-11-17 | 2026-11-17 |
| 2 | T1_BUILD_FAIL | button (ref "<ref>") OUT is a #-pin active HIGH/LOW driver; do NOT wire it directly to +<val> or GND (wire "B*.OUT" directly to its destinat | 2026-11-17 | 2026-11-17 |
| 2 | T1_BUILD_FAIL | Output pins #, # are shorted to another output or a supply. | 2026-11-17 | 2026-11-18 |
| 2 | T1_BUILD_FAIL | LED "<ref>" never turned ON (peak <val>; Anode=<val>, Cathode=<val>) — fix its resistor/driver wiring, check counter/gate inputs, and ensure | 2026-11-17 | 2026-11-17 |

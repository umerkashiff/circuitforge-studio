# CircuitForge Daily AI Eval — 2026-11-19

- **Stop Reason**: reached time budget (25m)
- **Model**: `gemini-3.5-flash-lite` | **Skipped Scopes**: `oled,esp32,i2c_display`
- **Cases Executed**: **80** | **Clean Pass (excl. infra)**: **36/80 (45.0%)**
- **HTTP Calls Used**: **186 / 300** (429: 0, 503: 18, timeouts: 0)
- **Tokens Used**: **539,046** (455,017 in + 84,029 out)
- **Auto-Regressions Fixed Today**: **1** | **Active Auto-Regressions Remaining**: **32**
- **New Curriculum Ideas Invented**: **12** | **Verified Fine-Tune Rows**: **+35 (Total: 114)**
- **Next Cursors**: `wild=30`, `mutation=33`, `combinatorial=34`

## Tier Breakdown
| Tier | Count | Meaning |
|---|---:|---|
| PASS | 36 | Built, verified, ov=0 & dbl=0, functional oracle passed |
| T1_BUILD_FAIL | 30 | Rejected by validator/DRC/LED/pin resolver |
| T2_SILENT_DEAD | 14 | Built ok=true, but simulator oracle stayed flat/dead/missing |
| T3_LAYOUT_DEBT | 0 | Functionally active, but overlaps (ov>0) or double-pins (dbl>0) |
| T4_API_INFRA | 0 | Failed strictly due to 429/503/timeout exhaustion |

## Bucket Pass Rates
| Bucket | Clean Pass / Attempted | Rate |
|---|---:|---:|
| auto_regression | 1 / 20 | 5.0% |
| regression | 18 / 20 | 90.0% |
| curriculum | 5 / 16 | 31.3% |
| wild | 8 / 16 | 50.0% |
| combinatorial | 1 / 4 | 25.0% |
| mutation | 3 / 4 | 75.0% |

## Auto-Regressions Resolved Today
- `autoreg_comb_chain_005` (button (ref "<ref>") OUT is a #-pin active HIGH/LOW driver; do NOT wire it directly to +<val> or GND (wire "B*.OUT" directly to its destinat)

## Top Actionable Failure Signatures Today
| Hits | Tier | Signature | Example Case |
|---:|---|---|---|
| 8 | T1_BUILD_FAIL | Oscilloscope "<ref>" CH*/CH* captured #.# Vpp on dynamic circuit — probe an oscillating signal net (e.g. U*.OUT / filter node) with "OSC*.CH | `autoreg_reg_half_wave_rect`: build a half wave rectifier with a 1n4007 diode, function generator 100Hz s… |
| 5 | T1_BUILD_FAIL | LED "<ref>" never turned ON (peak <val>; Anode=<val>, Cathode=<val>) — fix its resistor/driver wiring, check counter/gate inputs, and ensure | `autoreg_wild_traffic_light_4017`: build a hardware traffic light sequencer (no arduino) with a 555 timer cloc… |
| 4 | T2_SILENT_DEAD | missing expected type (power-supply) | `idea_mwmwtu2e_1`: I need to test how a zener diode regulates voltage under varying load condi… |
| 3 | T1_BUILD_FAIL | LED "<ref>" never turned ON (peak <val>; Anode=<val>, Cathode=NC) — fix its resistor/driver wiring, check counter/gate inputs, and ensure se | `autoreg_comb_chain_013`: setup an bc547 transistor two-LED inverse switch: pushbutton button with tr… |
| 3 | T2_SILENT_DEAD | oscilloscope captured flat/no AC waveform (vpp <= <val>) | `autoreg_comb_chain_014`: wire 50Hz funcgen sine wave through a rectifier diode bridge rectifier and … |
| 2 | T1_BUILD_FAIL | Oscilloscope "<ref>" CH*/CH* captured #.# Vpp on dynamic circuit — probe an oscillating signal net (e.g. U*.OUT / filter node) with "O*.CH*+ | `autoreg_comb_chain_016`: setup a 200Hz RC filter using signal generator, 1k resister, 100nF condensa… |
| 1 | T1_BUILD_FAIL | Short circuit on the supply — it is wired straight to another supply or ground. | `autoreg_idea_mwl354p0_4`: I want to create a circuit that doubles the input DC voltage using diodes.… |
| 1 | T2_SILENT_DEAD | missing expected type (led) | `autoreg_idea_mwl354p0_7`: How can I use a 7490 decade counter to drive a 7-segment display? I want to… |
| 1 | T2_SILENT_DEAD | missing expected type (vcc) | `autoreg_idea_mwl354p0_8`: I want to see how a resistor and capacitor interact with a voltage source. … |
| 1 | T2_SILENT_DEAD | missing expected type (ic7400) | `autoreg_idea_mwl354p0_11`: I need a simple tool to check logic levels (high/low) on a digital circuit.… |
| 1 | T1_BUILD_FAIL | ne555 ("<ref>") THR pin is unconnected — for astable tie THR->TRIG, R*(+->DIS), R*(DIS->THR), C(THR->-), RESET->+; for monostable tie DIS->T | `autoreg_wild_decade_dice`: make an electronic 6-LED roulette wheel with a fast 555 astable clocked thr… |
| 1 | T1_BUILD_FAIL | button (ref "<ref>") OUT is a #-pin active HIGH/LOW driver; do NOT wire it directly to +<val> or GND (wire "SW*.OUT" directly to its destina | `autoreg_wild_7402_nor_sr`: make an active-HIGH SR flip-flop latch using 7402 quad NOR chip, two pushbu… |
| 1 | T1_BUILD_FAIL | Boolean logic verification failed for Y = A' + B' * C: when (A=#, B=#, C=#): expected #, got LED OFF (#); when (A=#, B=#, C=#): expected #,  | `autoreg_comb_bool_006`: bild Y = A' + B' * C using ONLY NAND gates (ic7400) with a DIP4 switch and … |
| 1 | T1_BUILD_FAIL | button (ref "<ref>") OUT is a #-pin active HIGH/LOW driver; do NOT wire it directly to +<val> or GND (wire "BTN*.OUT" directly to its destin | `autoreg_mut_bjt_driver_v001`: build an npn common-emitter switch activated by poshbutton button through 1… |
| 1 | T1_BUILD_FAIL | Oscilloscope "<ref>" CH*/CH* captured #.# Vpp on dynamic circuit — probe an oscillating signal net (e.g. U*.OUT / filter node) with "S*.CH*+ | `autoreg_mut_rc_scope_v001`: build a 1khz rc filter from function generator through 1k resistor and 100n… |

## Cumulative Top Bugs Across Days (from `state.json`)
| Total Hits | Tier | Signature | First Seen | Last Seen |
|---:|---|---|---|---|
| 19 | T1_BUILD_FAIL | Oscilloscope "<ref>" CH*/CH* captured #.# Vpp on dynamic circuit — probe an oscillating signal net (e.g. U*.OUT / filter node) with "OSC*.CH | 2026-11-17 | 2026-11-19 |
| 7 | T2_SILENT_DEAD | oscilloscope captured flat/no AC waveform (vpp <= <val>) | 2026-11-17 | 2026-11-19 |
| 7 | T1_BUILD_FAIL | LED "<ref>" never turned ON (peak <val>; Anode=<val>, Cathode=<val>) — fix its resistor/driver wiring, check counter/gate inputs, and ensure | 2026-11-17 | 2026-11-19 |
| 7 | T1_BUILD_FAIL | LED "<ref>" never turned ON (peak <val>; Anode=<val>, Cathode=NC) — fix its resistor/driver wiring, check counter/gate inputs, and ensure se | 2026-11-17 | 2026-11-19 |
| 5 | T1_BUILD_FAIL | Oscilloscope "<ref>" CH*/CH* captured #.# Vpp on dynamic circuit — probe an oscillating signal net (e.g. U*.OUT / filter node) with "O*.CH*+ | 2026-11-17 | 2026-11-19 |
| 4 | T2_SILENT_DEAD | missing expected type (led) | 2026-11-17 | 2026-11-19 |
| 4 | T2_SILENT_DEAD | missing expected type (ic7400) | 2026-11-17 | 2026-11-19 |
| 4 | T2_SILENT_DEAD | missing expected type (power-supply) | 2026-11-19 | 2026-11-19 |
| 3 | T2_SILENT_DEAD | missing expected type (vcc) | 2026-11-17 | 2026-11-19 |
| 3 | T1_BUILD_FAIL | Boolean logic verification failed for Y = A' + B' * C: when (A=#, B=#, C=#): expected #, got LED OFF (#); when (A=#, B=#, C=#): expected #,  | 2026-11-17 | 2026-11-19 |

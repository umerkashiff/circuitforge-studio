# CircuitForge Daily AI Eval — 2026-11-19

- **Stop Reason**: reached daily call cap (300)
- **Model**: `gemini-3.5-flash-lite` | **Skipped Scopes**: `oled,esp32,i2c_display`
- **Cases Executed**: **157** | **Clean Pass (excl. infra)**: **121/157 (77.1%)**
- **HTTP Calls Used**: **300 / 300** (429: 5, 503: 14, timeouts: 1)
- **Tokens Used**: **915,837** (754,319 in + 161,518 out)
- **Auto-Regressions Fixed Today**: **25** | **Active Auto-Regressions Remaining**: **25**
- **New Curriculum Ideas Invented**: **12** | **Verified Fine-Tune Rows**: **+120 (Total: 234)**
- **Next Cursors**: `wild=46`, `mutation=65`, `combinatorial=67`

## Tier Breakdown
| Tier | Count | Meaning |
|---|---:|---|
| PASS | 121 | Built, verified, ov=0 & dbl=0, functional oracle passed |
| T1_BUILD_FAIL | 29 | Rejected by validator/DRC/LED/pin resolver |
| T2_SILENT_DEAD | 7 | Built ok=true, but simulator oracle stayed flat/dead/missing |
| T3_LAYOUT_DEBT | 0 | Functionally active, but overlaps (ov>0) or double-pins (dbl>0) |
| T4_API_INFRA | 0 | Failed strictly due to 429/503/timeout exhaustion |

## Bucket Pass Rates
| Bucket | Clean Pass / Attempted | Rate |
|---|---:|---:|
| auto_regression | 25 / 32 | 78.1% |
| regression | 19 / 20 | 95.0% |
| curriculum | 13 / 24 | 54.2% |
| wild | 12 / 16 | 75.0% |
| combinatorial | 23 / 33 | 69.7% |
| mutation | 29 / 32 | 90.6% |

## Auto-Regressions Resolved Today
- `autoreg_reg_half_wave_rect` (Oscilloscope "<ref>" CH*/CH* captured #.# Vpp on dynamic circuit — probe an oscillating signal net (e.g. U*.OUT / filter node) with "OSC*.CH)
- `autoreg_idea_mwl354p0_4` (missing expected type (vcc))
- `autoreg_idea_mwl354p0_7` (missing expected type (led))
- `autoreg_idea_mwl354p0_8` (missing expected type (gnd))
- `autoreg_idea_mwl354p0_11` (missing expected type (ic7400))
- `autoreg_wild_rc_lowpass_scope` (Oscilloscope "OSC" CH*/CH* captured #.# Vpp on dynamic circuit — probe an oscillating signal net (e.g. U*.OUT / filter node) with "OSC.CH*+")
- `autoreg_mut_bjt_driver_v001` (button (ref "<ref>") OUT is a #-pin active HIGH/LOW driver; do NOT wire it directly to +<val> or GND (wire "BT*.OUT" directly to its destina)
- `autoreg_mut_rc_scope_v001` (Oscilloscope "<ref>" CH*/CH* captured #.# Vpp on dynamic circuit — probe an oscillating signal net (e.g. U*.OUT / filter node) with "O*.CH*+)
- `autoreg_comb_chain_013` (LED "<ref>" never turned ON (peak <val>; Anode=<val>, Cathode=NC) — fix its resistor/driver wiring, check counter/gate inputs, and ensure se)
- `autoreg_comb_chain_014` (oscilloscope captured flat/no AC waveform (vpp <= <val>))
- `autoreg_comb_chain_016` (Short circuit on the supply — it is wired straight to another supply or ground.)
- `autoreg_comb_chain_019` (diode ("<ref>") has one open/unconnected pin ("Cathode") — connect "D*.Cathode" to complete the circuit.)
- `autoreg_mut_rc_scope_v002` (Oscilloscope "<ref>" CH*/CH* captured #.# Vpp on dynamic circuit — probe an oscillating signal net (e.g. U*.OUT / filter node) with "SCOPO1.)
- `autoreg_comb_chain_026` (Oscilloscope "<ref>" CH*/CH* captured #.# Vpp on dynamic circuit — probe an oscillating signal net (e.g. U*.OUT / filter node) with "SCOPE1.)
- `autoreg_comb_chain_029` (capacitor ("<ref>") has one open/unconnected pin ("−") — connect "C*.−" to complete the circuit.)
- `autoreg_reg_nmos_lowside_led` (LED "<ref>" never turned ON (peak <val>; Anode=<val>, Cathode=NC) — fix its resistor/driver wiring, check counter/gate inputs, and ensure se)
- `autoreg_idea_mwmwtu2e_0_typo` (oscilloscope captured flat/no AC waveform (vpp <= <val>))
- `autoreg_idea_mwmwtu2e_2` (missing expected type (power-supply))
- `autoreg_idea_mwmwtu2f_7_typo` (Invalid connection endpoint "+/VCC")
- `autoreg_idea_mwmwtu2f_9` (missing expected type (pot))
- `autoreg_idea_mwmwtu2f_10` (too few parts (# < #))
- `autoreg_idea_mwmwtu2f_11` (missing expected type (button))
- `autoreg_wild_bridge_rectifier` (Oscilloscope "<ref>" CH*/CH* captured #.# Vpp on dynamic circuit — probe an oscillating signal net (e.g. U*.OUT / filter node) with "OSC*.CH)
- `autoreg_comb_chain_032` (IC "<ref>" (ne555): No power — pin # (VCC) needs +<val> and pin # (GND) needs ground.. Ensure "V*.#"->"+", "G*.#"->"-", "U*.VCC"->"+", "U*.G)
- `autoreg_mut_bjt_driver_v003` (button (ref "<ref>") OUT is a #-pin active HIGH/LOW driver; do NOT wire it directly to +<val> or GND (wire "BT*.OUT" directly to its destina)

## Top Actionable Failure Signatures Today
| Hits | Tier | Signature | Example Case |
|---:|---|---|---|
| 7 | T1_BUILD_FAIL | LED "<ref>" never turned ON (peak <val>; Anode=<val>, Cathode=<val>) — fix its resistor/driver wiring, check counter/gate inputs, and ensure | `autoreg_wild_7402_nor_sr`: make an active-HIGH SR flip-flop latch using 7402 quad NOR chip, two pushbu… |
| 6 | T1_BUILD_FAIL | IC "<ref>" (ne555): No power — pin # (VCC) needs +<val> and pin # (GND) needs ground.. Ensure "V*.#"->"+", "G*.#"->"-", "U*.VCC"->"+", "U*.G | `autoreg_wild_traffic_light_4017`: build a hardware traffic light sequencer (no arduino) with a 555 timer cloc… |
| 3 | T1_BUILD_FAIL | Output pins #, # are shorted to another output or a supply. | `autoreg_wild_decade_dice`: make an electronic 6-LED roulette wheel with a fast 555 astable clocked thr… |
| 2 | T1_BUILD_FAIL | Boolean logic verification failed for Y = A' + B' * C: when (A=#, B=#, C=#): expected #, got LED OFF (#); when (A=#, B=#, C=#): expected #,  | `autoreg_comb_bool_006`: bild Y = A' + B' * C using ONLY NAND gates (ic7400) with a DIP4 switch and … |
| 2 | T2_SILENT_DEAD | missing expected type (battery) | `idea_mwnd6cwb_1`: I need a transistor circuit where the output follows the input voltage with… |
| 2 | T1_BUILD_FAIL | None of the # wired LED(s) lit up (all <val>)! Check that "vcc"->"+", "gnd"->"-", and LED Anodes reach "+" (via resistor) and Cathodes reach | `idea_mwnd6cwb_9`: Create a classic two-transistor astable multivibrator circuit that alternat… |
| 1 | T1_BUILD_FAIL | Unknown pin "<val> FIXED +#" on part "<ref>" (power-supply). Valid pins: [SLAVE −(##), SLAVE GND(##), SLAVE +(##), MASTER −(##), MASTER GND( | `autoreg_idea_mwmwtu2e_1`: I need to test how a zener diode regulates voltage under varying load condi… |
| 1 | T2_SILENT_DEAD | missing expected type (resistor) | `autoreg_idea_mwmwtu2e_4`: Can you build a ring oscillator using a couple of NAND gates from a 7400 IC… |
| 1 | T1_BUILD_FAIL | Shorted outputs / driver contention: U*.1Y and U*.3Y are both driving the same node — never wire two outputs directly together. | `autoreg_comb_bool_033`: cretae F = (A & B) / (B & C) / (A & C) using ONLY NAND gates (ic7400) with … |
| 1 | T2_SILENT_DEAD | multimeter produced no valid finite reading (---- / OL / LIVE V!) | `idea_mwnd6cwb_5`: Design a regulated power supply circuit using an LM317 adjustable voltage r… |
| 1 | T2_SILENT_DEAD | missing expected type (capacitor) | `idea_mwnd6cwb_5_typo`: Design a regulated power supply circuit uisng an LM317 adjustable voltage r… |
| 1 | T2_SILENT_DEAD | missing expected type (gnd) | `idea_mwnd6cwb_7`: Set up an Arduino Uno to interface with a sensor module and print telemetry… |
| 1 | T1_BUILD_FAIL | LED "<ref>" never turned ON (peak <val>; Anode=<val>, Cathode=NC) — fix its resistor/driver wiring, check counter/gate inputs, and ensure se | `wild_dark_nightlight`: design an automatic night light comparator trigger using a potentiometer vo… |
| 1 | T1_BUILD_FAIL | Oscilloscope "<ref>" CH*/CH* captured #.# Vpp on dynamic circuit — probe an oscillating signal net (e.g. U*.OUT / filter node) with "OSC*.CH | `comb_chain_034`: design 50Hz funcgen sine wave through a recifier diode bridge rectifier and… |
| 1 | T1_BUILD_FAIL | Output pins #, #, # are shorted to another output or a supply. | `comb_bool_039`: make F = A'B + AB' using ONLY NAND gates (ic7400) with a DIP4 switch and an… |

## Cumulative Top Bugs Across Days (from `state.json`)
| Total Hits | Tier | Signature | First Seen | Last Seen |
|---:|---|---|---|---|
| 20 | T1_BUILD_FAIL | Oscilloscope "<ref>" CH*/CH* captured #.# Vpp on dynamic circuit — probe an oscillating signal net (e.g. U*.OUT / filter node) with "OSC*.CH | 2026-11-17 | 2026-11-19 |
| 14 | T1_BUILD_FAIL | LED "<ref>" never turned ON (peak <val>; Anode=<val>, Cathode=<val>) — fix its resistor/driver wiring, check counter/gate inputs, and ensure | 2026-11-17 | 2026-11-19 |
| 8 | T1_BUILD_FAIL | LED "<ref>" never turned ON (peak <val>; Anode=<val>, Cathode=NC) — fix its resistor/driver wiring, check counter/gate inputs, and ensure se | 2026-11-17 | 2026-11-19 |
| 7 | T2_SILENT_DEAD | oscilloscope captured flat/no AC waveform (vpp <= <val>) | 2026-11-17 | 2026-11-19 |
| 7 | T1_BUILD_FAIL | IC "<ref>" (ne555): No power — pin # (VCC) needs +<val> and pin # (GND) needs ground.. Ensure "V*.#"->"+", "G*.#"->"-", "U*.VCC"->"+", "U*.G | 2026-11-19 | 2026-11-19 |
| 5 | T1_BUILD_FAIL | Output pins #, # are shorted to another output or a supply. | 2026-11-17 | 2026-11-19 |
| 5 | T1_BUILD_FAIL | Boolean logic verification failed for Y = A' + B' * C: when (A=#, B=#, C=#): expected #, got LED OFF (#); when (A=#, B=#, C=#): expected #,  | 2026-11-17 | 2026-11-19 |
| 5 | T1_BUILD_FAIL | Oscilloscope "<ref>" CH*/CH* captured #.# Vpp on dynamic circuit — probe an oscillating signal net (e.g. U*.OUT / filter node) with "O*.CH*+ | 2026-11-17 | 2026-11-19 |
| 4 | T2_SILENT_DEAD | missing expected type (led) | 2026-11-17 | 2026-11-19 |
| 4 | T2_SILENT_DEAD | missing expected type (ic7400) | 2026-11-17 | 2026-11-19 |

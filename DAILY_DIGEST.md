# CircuitForge Daily AI Eval — 2026-11-20

- **Stop Reason**: reached daily call cap (300)
- **Model**: `gemini-3.5-flash-lite` | **Skipped Scopes**: `oled,esp32,i2c_display`
- **Cases Executed**: **154** | **Clean Pass (excl. infra)**: **120/154 (77.9%)**
- **HTTP Calls Used**: **302 / 300** (429: 30, 503: 1, timeouts: 1)
- **Tokens Used**: **858,462** (716,363 in + 142,099 out)
- **Auto-Regressions Fixed Today**: **11** | **Active Auto-Regressions Remaining**: **27**
- **New Curriculum Ideas Invented**: **12** | **Verified Fine-Tune Rows**: **+119 (Total: 353)**
- **Next Cursors**: `wild=62`, `mutation=101`, `combinatorial=103`

## Tier Breakdown
| Tier | Count | Meaning |
|---|---:|---|
| PASS | 120 | Built, verified, ov=0 & dbl=0, functional oracle passed |
| T1_BUILD_FAIL | 25 | Rejected by validator/DRC/LED/pin resolver |
| T2_SILENT_DEAD | 9 | Built ok=true, but simulator oracle stayed flat/dead/missing |
| T3_LAYOUT_DEBT | 0 | Functionally active, but overlaps (ov>0) or double-pins (dbl>0) |
| T4_API_INFRA | 0 | Failed strictly due to 429/503/timeout exhaustion |

## Bucket Pass Rates
| Bucket | Clean Pass / Attempted | Rate |
|---|---:|---:|
| auto_regression | 11 / 25 | 44.0% |
| regression | 20 / 20 | 100.0% |
| curriculum | 12 / 21 | 57.1% |
| wild | 15 / 16 | 93.8% |
| combinatorial | 30 / 36 | 83.3% |
| mutation | 32 / 36 | 88.9% |

## Auto-Regressions Resolved Today
- `autoreg_wild_decade_dice` (LED "<ref>" never turned ON (peak <val>; Anode=<val>, Cathode=<val>) — fix its resistor/driver wiring, check counter/gate inputs, and ensure)
- `autoreg_wild_7402_nor_sr` (LED "<ref>" never turned ON (peak <val>; Anode=<val>, Cathode=<val>) — fix its resistor/driver wiring, check counter/gate inputs, and ensure)
- `autoreg_reg_555_blinker` (IC "<ref>" (ne555): No power — pin # (VCC) needs +<val> and pin # (GND) needs ground.. Ensure "V*.#"->"+", "G*.#"->"-", "U*.VCC"->"+", "U*.G)
- `autoreg_idea_mwnd6cwb_1` (missing expected type (battery))
- `autoreg_idea_mwnd6cwb_5` (multimeter produced no valid finite reading (---- / OL / LIVE V!))
- `autoreg_idea_mwnd6cwb_5_typo` (missing expected type (capacitor))
- `autoreg_idea_mwnd6cwb_7` (missing expected type (gnd))
- `autoreg_comb_chain_034` (Oscilloscope "<ref>" CH*/CH* captured #.# Vpp on dynamic circuit — probe an oscillating signal net (e.g. U*.OUT / filter node) with "OSC*.CH)
- `autoreg_mut_chaser_v004` (IC "<ref>" (ne555): No power — pin # (VCC) needs +<val> and pin # (GND) needs ground.. Ensure "V*.#"->"+", "G*.#"->"-", "U*.VCC"->"+", "U*.G)
- `autoreg_comb_chain_050` (MCU runtime error: p10126: i is not defined)
- `autoreg_comb_bool_063` (DIP Switch ×# (ref "<ref>") S* is an active <val>/<val> output switch; do NOT wire it directly to +<val> or GND (wire "S*.S*" directly to yo)

## Top Actionable Failure Signatures Today
| Hits | Tier | Signature | Example Case |
|---:|---|---|---|
| 5 | T1_BUILD_FAIL | IC "<ref>" (ne555): No power — pin # (VCC) needs +<val> and pin # (GND) needs ground.. Ensure "V*.#"->"+", "G*.#"->"-", "U*.VCC"->"+", "U*.G | `autoreg_mut_siren_v006`: setup a police wailing siren using 2 555 timmer chips where slow timer modu… |
| 3 | T1_BUILD_FAIL | Boolean logic verification failed for Y = A' + B' * C: when (A=#, B=#, C=#): expected #, got LED OFF (#); when (A=#, B=#, C=#): expected #,  | `autoreg_comb_bool_006`: bild Y = A' + B' * C using ONLY NAND gates (ic7400) with a DIP4 switch and … |
| 2 | T1_BUILD_FAIL | None of the # wired LED(s) lit up (all <val>)! Check that "vcc"->"+", "gnd"->"-", and LED Anodes reach "+" (via resistor) and Cathodes reach | `autoreg_idea_mwmwtu2e_4`: Can you build a ring oscillator using a couple of NAND gates from a 7400 IC… |
| 2 | T1_BUILD_FAIL | Output pins #, # are shorted to another output or a supply. | `autoreg_comb_bool_033`: cretae F = (A & B) / (B & C) / (A & C) using ONLY NAND gates (ic7400) with … |
| 2 | T2_SILENT_DEAD | missing expected type (dip8) | `idea_mwobx3wc_3`: Please set up a 7485 4-bit magnitude comparator using DIP switches to compa… |
| 2 | T2_SILENT_DEAD | missing expected type (funcgen) | `idea_mwobx3wc_4`: Can we build an op-amp voltage follower using an LM358 to buffer a high imp… |
| 2 | T2_SILENT_DEAD | buzzer stayed silent / unconnected (dV <= <val>) | `idea_mwobx3wc_10`: Construct a Darlington pair transistor driver circuit to switch a high-curr… |
| 2 | T2_SILENT_DEAD | too few parts (# < #) | `mut_bar595_v006`: build a serial chaser on uno r3 with 74hc595 shift registor shift IC drivin… |
| 1 | T1_BUILD_FAIL | Clocked counter ic4017 ("<ref>") LED output(s) never toggled over #.#+ clock cycles! Check clock pin, active-high/low resets (tie #/# R*(#)/ | `autoreg_wild_traffic_light_4017`: build a hardware traffic light sequencer (no arduino) with a 555 timer cloc… |
| 1 | T1_BUILD_FAIL | Unknown pin "OUT" on part "<ref>" (power-supply). Valid pins: [SLAVE −(##), SLAVE GND(##), SLAVE +(##), MASTER −(##), MASTER GND(##), MASTER | `autoreg_idea_mwmwtu2e_1`: I need to test how a zener diode regulates voltage under varying load condi… |
| 1 | T1_BUILD_FAIL | Invalid connection endpoint "<ref>" | `autoreg_idea_mwnd6cwb_9`: Create a classic two-transistor astable multivibrator circuit that alternat… |
| 1 | T1_BUILD_FAIL | LED "<ref>" never turned ON (peak <val>; Anode=<val>, Cathode=<val>) — fix its resistor/driver wiring, check counter/gate inputs, and ensure | `autoreg_wild_dark_nightlight`: design an automatic night light comparator trigger using a potentiometer vo… |
| 1 | T1_BUILD_FAIL | Boolean logic verification failed for F = A'B + AB': when (A=#, B=#): expected #, got LED ON (#); when (A=#, B=#): expected #, got LED OFF ( | `autoreg_comb_bool_039`: make F = A'B + AB' using ONLY NAND gates (ic7400) with a DIP4 switch and an… |
| 1 | T1_BUILD_FAIL | Boolean logic verification failed for Y = (A ^ B) & C: when (A=#, B=#, C=#): expected #, got LED ON (#); when (A=#, B=#, C=#): expected #, g | `autoreg_comb_bool_042`: bild Y = (A ^ B) & C using ONLY NAND gates (ic7400) with a DIP4 switch and … |
| 1 | T1_BUILD_FAIL | Boolean logic verification failed for F = (A & B) / (B & C) / (A & C): when (A=#, B=#, C=#): expected #, got LED OFF (#). Double-check your  | `autoreg_comb_bool_048`: setup F = (A & B) / (B & C) / (A & C) using ONLY NAND gates (ic7400) with t… |

## Cumulative Top Bugs Across Days (from `state.json`)
| Total Hits | Tier | Signature | First Seen | Last Seen |
|---:|---|---|---|---|
| 20 | T1_BUILD_FAIL | Oscilloscope "<ref>" CH*/CH* captured #.# Vpp on dynamic circuit — probe an oscillating signal net (e.g. U*.OUT / filter node) with "OSC*.CH | 2026-11-17 | 2026-11-19 |
| 15 | T1_BUILD_FAIL | LED "<ref>" never turned ON (peak <val>; Anode=<val>, Cathode=<val>) — fix its resistor/driver wiring, check counter/gate inputs, and ensure | 2026-11-17 | 2026-11-20 |
| 12 | T1_BUILD_FAIL | IC "<ref>" (ne555): No power — pin # (VCC) needs +<val> and pin # (GND) needs ground.. Ensure "V*.#"->"+", "G*.#"->"-", "U*.VCC"->"+", "U*.G | 2026-11-19 | 2026-11-20 |
| 9 | T1_BUILD_FAIL | LED "<ref>" never turned ON (peak <val>; Anode=<val>, Cathode=NC) — fix its resistor/driver wiring, check counter/gate inputs, and ensure se | 2026-11-17 | 2026-11-20 |
| 8 | T2_SILENT_DEAD | oscilloscope captured flat/no AC waveform (vpp <= <val>) | 2026-11-17 | 2026-11-20 |
| 8 | T1_BUILD_FAIL | Boolean logic verification failed for Y = A' + B' * C: when (A=#, B=#, C=#): expected #, got LED OFF (#); when (A=#, B=#, C=#): expected #,  | 2026-11-17 | 2026-11-20 |
| 7 | T1_BUILD_FAIL | Output pins #, # are shorted to another output or a supply. | 2026-11-17 | 2026-11-20 |
| 5 | T1_BUILD_FAIL | Oscilloscope "<ref>" CH*/CH* captured #.# Vpp on dynamic circuit — probe an oscillating signal net (e.g. U*.OUT / filter node) with "O*.CH*+ | 2026-11-17 | 2026-11-19 |
| 4 | T2_SILENT_DEAD | missing expected type (led) | 2026-11-17 | 2026-11-19 |
| 4 | T2_SILENT_DEAD | missing expected type (ic7400) | 2026-11-17 | 2026-11-19 |

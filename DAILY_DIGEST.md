# CircuitForge Daily AI Eval — 2026-11-20

- **Stop Reason**: reached time budget (25m)
- **Model**: `gemini-3.5-flash-lite` | **Skipped Scopes**: `oled,esp32,i2c_display`
- **Cases Executed**: **132** | **Clean Pass (excl. infra)**: **102/132 (77.3%)**
- **HTTP Calls Used**: **251 / 300** (429: 1, 503: 38, timeouts: 0)
- **Tokens Used**: **662,848** (545,683 in + 117,165 out)
- **Auto-Regressions Fixed Today**: **14** | **Active Auto-Regressions Remaining**: **27**
- **New Curriculum Ideas Invented**: **12** | **Verified Fine-Tune Rows**: **+101 (Total: 454)**
- **Next Cursors**: `wild=78`, `mutation=125`, `combinatorial=128`

## Tier Breakdown
| Tier | Count | Meaning |
|---|---:|---|
| PASS | 102 | Built, verified, ov=0 & dbl=0, functional oracle passed |
| T1_BUILD_FAIL | 20 | Rejected by validator/DRC/LED/pin resolver |
| T2_SILENT_DEAD | 10 | Built ok=true, but simulator oracle stayed flat/dead/missing |
| T3_LAYOUT_DEBT | 0 | Functionally active, but overlaps (ov>0) or double-pins (dbl>0) |
| T4_API_INFRA | 0 | Failed strictly due to 429/503/timeout exhaustion |

## Bucket Pass Rates
| Bucket | Clean Pass / Attempted | Rate |
|---|---:|---:|
| auto_regression | 14 / 27 | 51.9% |
| regression | 19 / 20 | 95.0% |
| curriculum | 11 / 20 | 55.0% |
| wild | 15 / 16 | 93.8% |
| combinatorial | 20 / 25 | 80.0% |
| mutation | 23 / 24 | 95.8% |

## Auto-Regressions Resolved Today
- `autoreg_wild_traffic_light_4017` (Output pins #, # are shorted to another output or a supply.)
- `autoreg_idea_mwmwtu2e_1` (missing expected type (power-supply))
- `autoreg_wild_dark_nightlight` (LED "<ref>" never turned ON (peak <val>; Anode=<val>, Cathode=NC) — fix its resistor/driver wiring, check counter/gate inputs, and ensure se)
- `autoreg_mut_siren_v006` (buzzer "<ref>" remained silent (peak |dV|=<val>) — verify "+" connects to active driver/timer output and "-" connects to GND.)
- `autoreg_idea_mwobx3wc_3` (missing expected type (dip8))
- `autoreg_idea_mwobx3wc_4` (missing expected type (funcgen))
- `autoreg_idea_mwobx3wc_8` (oscilloscope captured flat/no AC waveform (vpp <= <val>))
- `autoreg_idea_mwobx3wc_10` (buzzer stayed silent / unconnected (dV <= <val>))
- `autoreg_idea_mwobx3wc_10_typo` (buzzer stayed silent / unconnected (dV <= <val>))
- `autoreg_mut_bar595_v006` (too few parts (# < #))
- `autoreg_comb_chain_073` (Unknown pin "COM.#" on part "<ref>" (seg7). Valid pins: [e(##), d(##), COM(##), c(##), DP(##), b(##), a(##), COM(##), f(##), g(##)])
- `autoreg_mut_siren_v007` (IC "<ref>" (ne555): No power — pin # (VCC) needs +<val> and pin # (GND) needs ground.. Ensure "V*.#"->"+", "G*.#"->"-", "U*.VCC"->"+", "U*.G)
- `autoreg_comb_chain_092` (IC "<ref>" (ne555): No power — pin # (VCC) needs +<val> and pin # (GND) needs ground.. Ensure "V*.#"->"+", "G*.#"->"-", "U*.VCC"->"+", "U*.G)
- `autoreg_mut_rectifier_v008` (too few parts (# < #))

## Top Actionable Failure Signatures Today
| Hits | Tier | Signature | Example Case |
|---:|---|---|---|
| 4 | T1_BUILD_FAIL | None of the # wired LED(s) lit up (all <val>)! Check that "vcc"->"+", "gnd"->"-", and LED Anodes reach "+" (via resistor) and Cathodes reach | `autoreg_idea_mwmwtu2e_4`: Can you build a ring oscillator using a couple of NAND gates from a 7400 IC… |
| 3 | T2_SILENT_DEAD | oscilloscope captured flat/no AC waveform (vpp <= <val>) | `idea_mwp0z4jr_1`: I need to design a Colpitts oscillator using an NPN transistor and an LC ta… |
| 2 | T1_BUILD_FAIL | Output pin # is shorted to another output or a supply. | `autoreg_comb_bool_006`: bild Y = A' + B' * C using ONLY NAND gates (ic7400) with a DIP4 switch and … |
| 2 | T2_SILENT_DEAD | missing expected type (oscilloscope) | `idea_mwp0z4jr_0`: Can you build a precision full-wave rectifier using dual op-amps to elimina… |
| 2 | T2_SILENT_DEAD | missing expected type (npn) | `idea_mwp0z4jr_2`: Can we create a sawtooth waveform generator by charging a capacitor with a … |
| 1 | T1_BUILD_FAIL | Output pins #, #, # are shorted to another output or a supply. | `autoreg_comb_bool_033`: cretae F = (A & B) / (B & C) / (A & C) using ONLY NAND gates (ic7400) with … |
| 1 | T1_BUILD_FAIL | Unknown pin "1VCC" on part "<ref>" (ic7400). Valid pins: [1A(##), 1B(##), 1Y(##), 2A(##), 2B(##), 2Y(##), GND(##), 3Y(##), 3A(##), 3B(##), 4 | `autoreg_comb_bool_039`: make F = A'B + AB' using ONLY NAND gates (ic7400) with a DIP4 switch and an… |
| 1 | T1_BUILD_FAIL | Boolean logic verification failed for Y = (A ^ B) & C: when (A=#, B=#, C=#): expected #, got LED ON (#); when (A=#, B=#, C=#): expected #, g | `autoreg_comb_bool_042`: bild Y = (A ^ B) & C using ONLY NAND gates (ic7400) with a DIP4 switch and … |
| 1 | T1_BUILD_FAIL | Boolean logic verification failed for F = (A & B) / (B & C) / (A & C): when (A=#, B=#, C=#): expected #, got LED ON (#); when (A=#, B=#, C=# | `autoreg_comb_bool_048`: setup F = (A & B) / (B & C) / (A & C) using ONLY NAND gates (ic7400) with t… |
| 1 | T1_BUILD_FAIL | Unknown part reference "<ref>" in connection "U*.1A". Declared parts: [V*(vcc), G*(gnd), U*(ic7400), R*(resistor), SW_A(toggle), SW_B(toggle | `autoreg_comb_bool_051`: wirre Y = A' + B' * C using ONLY NAND gates (ic7400) with toggle switches a… |
| 1 | T1_BUILD_FAIL | Unknown pin "4C" on part "<ref>" (ic7400). Valid pins: [1A(##), 1B(##), 1Y(##), 2A(##), 2B(##), 2Y(##), GND(##), 3Y(##), 3A(##), 3B(##), 4Y( | `autoreg_comb_bool_057`: make Y = (A ^ B) & C using ONLY NAND gates (ic7400) with a DIP4 switch and … |
| 1 | T1_BUILD_FAIL | LED "<ref>" never turned ON (peak <val>; Anode=<val>, Cathode=<val>) — fix its resistor/driver wiring, check counter/gate inputs, and ensure | `autoreg_idea_mwobx3wc_9`: Set up a 74151 8-input multiplexer with toggle switches for select lines an… |
| 1 | T1_BUILD_FAIL | Output pins #, # are shorted to another output or a supply. | `autoreg_comb_bool_090`: make F = A'B'C + ABC' using ONLY NAND gates (ic7400) with a DIP4 switch and… |
| 1 | T1_BUILD_FAIL | Oscilloscope "<ref>" CH*/CH* captured #.# Vpp on dynamic circuit — probe an oscillating signal net (e.g. U*.OUT / filter node) with "OSC*.CH | `reg_555_blinker`: Build a 555 timer astable LED blinker around 2Hz with resistors, capacitor,… |
| 1 | T2_SILENT_DEAD | missing expected type (clock) | `idea_mwp0z4jt_4`: Set up a shift register with a clock input and data toggle switch, attachin… |

## Cumulative Top Bugs Across Days (from `state.json`)
| Total Hits | Tier | Signature | First Seen | Last Seen |
|---:|---|---|---|---|
| 21 | T1_BUILD_FAIL | Oscilloscope "<ref>" CH*/CH* captured #.# Vpp on dynamic circuit — probe an oscillating signal net (e.g. U*.OUT / filter node) with "OSC*.CH | 2026-11-17 | 2026-11-20 |
| 16 | T1_BUILD_FAIL | LED "<ref>" never turned ON (peak <val>; Anode=<val>, Cathode=<val>) — fix its resistor/driver wiring, check counter/gate inputs, and ensure | 2026-11-17 | 2026-11-20 |
| 12 | T1_BUILD_FAIL | IC "<ref>" (ne555): No power — pin # (VCC) needs +<val> and pin # (GND) needs ground.. Ensure "V*.#"->"+", "G*.#"->"-", "U*.VCC"->"+", "U*.G | 2026-11-19 | 2026-11-20 |
| 11 | T2_SILENT_DEAD | oscilloscope captured flat/no AC waveform (vpp <= <val>) | 2026-11-17 | 2026-11-20 |
| 9 | T1_BUILD_FAIL | LED "<ref>" never turned ON (peak <val>; Anode=<val>, Cathode=NC) — fix its resistor/driver wiring, check counter/gate inputs, and ensure se | 2026-11-17 | 2026-11-20 |
| 8 | T1_BUILD_FAIL | Output pins #, # are shorted to another output or a supply. | 2026-11-17 | 2026-11-20 |
| 8 | T1_BUILD_FAIL | Boolean logic verification failed for Y = A' + B' * C: when (A=#, B=#, C=#): expected #, got LED OFF (#); when (A=#, B=#, C=#): expected #,  | 2026-11-17 | 2026-11-20 |
| 8 | T1_BUILD_FAIL | None of the # wired LED(s) lit up (all <val>)! Check that "vcc"->"+", "gnd"->"-", and LED Anodes reach "+" (via resistor) and Cathodes reach | 2026-11-19 | 2026-11-20 |
| 5 | T1_BUILD_FAIL | Oscilloscope "<ref>" CH*/CH* captured #.# Vpp on dynamic circuit — probe an oscillating signal net (e.g. U*.OUT / filter node) with "O*.CH*+ | 2026-11-17 | 2026-11-19 |
| 4 | T2_SILENT_DEAD | missing expected type (led) | 2026-11-17 | 2026-11-19 |

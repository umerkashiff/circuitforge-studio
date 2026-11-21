# CircuitForge Daily AI Eval — 2026-11-21

- **Stop Reason**: reached daily call cap (300)
- **Model**: `gemini-3.5-flash-lite` | **Skipped Scopes**: `oled,esp32,i2c_display`
- **Cases Executed**: **149** | **Clean Pass (excl. infra)**: **121/149 (81.2%)**
- **HTTP Calls Used**: **301 / 300** (429: 38, 503: 22, timeouts: 0)
- **Tokens Used**: **769,355** (642,190 in + 127,165 out)
- **Auto-Regressions Fixed Today**: **8** | **Active Auto-Regressions Remaining**: **27**
- **New Curriculum Ideas Invented**: **8** | **Verified Fine-Tune Rows**: **+120 (Total: 574)**
- **Next Cursors**: `wild=94`, `mutation=161`, `combinatorial=164`

## Tier Breakdown
| Tier | Count | Meaning |
|---|---:|---|
| PASS | 121 | Built, verified, ov=0 & dbl=0, functional oracle passed |
| T1_BUILD_FAIL | 21 | Rejected by validator/DRC/LED/pin resolver |
| T2_SILENT_DEAD | 7 | Built ok=true, but simulator oracle stayed flat/dead/missing |
| T3_LAYOUT_DEBT | 0 | Functionally active, but overlaps (ov>0) or double-pins (dbl>0) |
| T4_API_INFRA | 0 | Failed strictly due to 429/503/timeout exhaustion |

## Bucket Pass Rates
| Bucket | Clean Pass / Attempted | Rate |
|---|---:|---:|
| auto_regression | 8 / 27 | 29.6% |
| regression | 18 / 20 | 90.0% |
| curriculum | 12 / 14 | 85.7% |
| wild | 15 / 16 | 93.8% |
| combinatorial | 33 / 36 | 91.7% |
| mutation | 35 / 36 | 97.2% |

## Auto-Regressions Resolved Today
- `autoreg_comb_bool_039` (Output pins #, #, # are shorted to another output or a supply.)
- `autoreg_idea_mwobx3wc_9` (Combinational logic check failed: output LED(s) stayed stuck (always OFF) across all # tested switch input patterns! Verify gate/IC wiring a)
- `autoreg_reg_555_blinker` (Oscilloscope "<ref>" CH*/CH* captured #.# Vpp on dynamic circuit — probe an oscillating signal net (e.g. U*.OUT / filter node) with "OSC*.CH)
- `autoreg_idea_mwp0z4jt_4` (missing expected type (clock))
- `autoreg_wild_traffic_light_4017` (LED "<ref>" never turned ON (peak <val>; Anode=NC, Cathode=<val>) — fix its resistor/driver wiring, check counter/gate inputs, and ensure se)
- `autoreg_comb_bool_105` (Boolean logic verification failed for F = A'B'C + ABC': when (A=#, B=#, C=#): expected #, got LED ON (#); when (A=#, B=#, C=#): expected #, )
- `autoreg_comb_chain_107` (missing expected type (ne555))
- `autoreg_mut_darlington_v010` (missing expected type (pot))

## Top Actionable Failure Signatures Today
| Hits | Tier | Signature | Example Case |
|---:|---|---|---|
| 3 | T1_BUILD_FAIL | None of the # wired LED(s) lit up (all <val>)! Check that "vcc"->"+", "gnd"->"-", and LED Anodes reach "+" (via resistor) and Cathodes reach | `autoreg_idea_mwmwtu2e_4`: Can you build a ring oscillator using a couple of NAND gates from a 7400 IC… |
| 3 | T2_SILENT_DEAD | missing expected type (oscilloscope) | `autoreg_idea_mwp0z4jr_0`: Can you build a precision full-wave rectifier using dual op-amps to elimina… |
| 2 | T1_BUILD_FAIL | Output pins #, # are shorted to another output or a supply. | `autoreg_comb_bool_033`: cretae F = (A & B) / (B & C) / (A & C) using ONLY NAND gates (ic7400) with … |
| 2 | T1_BUILD_FAIL | Output pin # is shorted to another output or a supply. | `autoreg_comb_bool_051`: wirre Y = A' + B' * C using ONLY NAND gates (ic7400) with toggle switches a… |
| 2 | T2_SILENT_DEAD | oscilloscope captured flat/no AC waveform (vpp <= <val>) | `autoreg_idea_mwp0z4jr_1`: I need to design a Colpitts oscillator using an NPN transistor and an LC ta… |
| 2 | T1_BUILD_FAIL | Output pins #, #, # are shorted to another output or a supply. | `autoreg_comb_bool_117`: setup F = (A + B) * C' using ONLY NAND gates (ic7400) with toggle switches … |
| 1 | T1_BUILD_FAIL | Unknown pin "2C" on part "<ref>" (ic7400). Valid pins: [1A(##), 1B(##), 1Y(##), 2A(##), 2B(##), 2Y(##), GND(##), 3Y(##), 3A(##), 3B(##), 4Y( | `autoreg_comb_bool_006`: bild Y = A' + B' * C using ONLY NAND gates (ic7400) with a DIP4 switch and … |
| 1 | T1_BUILD_FAIL | Shorted outputs / driver contention: SW*.S* and SW*.S* are both driving the same node — never wire two outputs directly together. | `autoreg_comb_bool_042`: bild Y = (A ^ B) & C using ONLY NAND gates (ic7400) with a DIP4 switch and … |
| 1 | T1_BUILD_FAIL | Unknown pin "9A" on part "<ref>" (ic7400). Valid pins: [1A(##), 1B(##), 1Y(##), 2A(##), 2B(##), 2Y(##), GND(##), 3Y(##), 3A(##), 3B(##), 4Y( | `autoreg_comb_bool_048`: setup F = (A & B) / (B & C) / (A & C) using ONLY NAND gates (ic7400) with t… |
| 1 | T1_BUILD_FAIL | Boolean logic verification failed for Y = (A ^ B) & C: when (A=#, B=#, C=#): expected #, got LED ON (#); when (A=#, B=#, C=#): expected #, g | `autoreg_comb_bool_057`: make Y = (A ^ B) & C using ONLY NAND gates (ic7400) with a DIP4 switch and … |
| 1 | T1_BUILD_FAIL | Boolean logic verification failed for F = A'B'C + ABC': when (A=#, B=#, C=#): expected #, got LED OFF (#); when (A=#, B=#, C=#): expected #, | `autoreg_comb_bool_090`: make F = A'B'C + ABC' using ONLY NAND gates (ic7400) with a DIP4 switch and… |
| 1 | T1_BUILD_FAIL | Boolean logic verification failed for F = A(B + C'): when (A=#, B=#, C=#): expected #, got LED ON (#); when (A=#, B=#, C=#): expected #, got | `autoreg_comb_bool_093`: bild F = A(B + C') using ONLY NAND gates (ic7400) with a DIP4 switch and an… |
| 1 | T1_BUILD_FAIL | IC "<ref>" (ne555): No power — pin # (VCC) needs +<val> and pin # (GND) needs ground.. Ensure "V*.#"->"+", "G*.#"->"-", "U*.VCC"->"+", "U*.G | `autoreg_idea_mwp0z4jr_2`: Can we create a sawtooth waveform generator by charging a capacitor with a … |
| 1 | T1_BUILD_FAIL | Unknown pin "<ref>" on part "<ref>" (ic7400). Valid pins: [1A(##), 1B(##), 1Y(##), 2A(##), 2B(##), 2Y(##), GND(##), 3Y(##), 3A(##), 3B(##),  | `autoreg_comb_bool_108`: make F = A(B + C') using ONLY NAND gates (ic7400) with a DIP4 switch and an… |
| 1 | T2_SILENT_DEAD | missing expected type (pot) | `reg_lie_detector`: wire a diy lie detectr skin resistance checkr with 2n3904 npn bjt darlingtn… |

## Cumulative Top Bugs Across Days (from `state.json`)
| Total Hits | Tier | Signature | First Seen | Last Seen |
|---:|---|---|---|---|
| 21 | T1_BUILD_FAIL | Oscilloscope "<ref>" CH*/CH* captured #.# Vpp on dynamic circuit — probe an oscillating signal net (e.g. U*.OUT / filter node) with "OSC*.CH | 2026-11-17 | 2026-11-20 |
| 16 | T1_BUILD_FAIL | LED "<ref>" never turned ON (peak <val>; Anode=<val>, Cathode=<val>) — fix its resistor/driver wiring, check counter/gate inputs, and ensure | 2026-11-17 | 2026-11-20 |
| 13 | T2_SILENT_DEAD | oscilloscope captured flat/no AC waveform (vpp <= <val>) | 2026-11-17 | 2026-11-21 |
| 13 | T1_BUILD_FAIL | IC "<ref>" (ne555): No power — pin # (VCC) needs +<val> and pin # (GND) needs ground.. Ensure "V*.#"->"+", "G*.#"->"-", "U*.VCC"->"+", "U*.G | 2026-11-19 | 2026-11-21 |
| 11 | T1_BUILD_FAIL | None of the # wired LED(s) lit up (all <val>)! Check that "vcc"->"+", "gnd"->"-", and LED Anodes reach "+" (via resistor) and Cathodes reach | 2026-11-19 | 2026-11-21 |
| 10 | T1_BUILD_FAIL | Output pins #, # are shorted to another output or a supply. | 2026-11-17 | 2026-11-21 |
| 9 | T1_BUILD_FAIL | LED "<ref>" never turned ON (peak <val>; Anode=<val>, Cathode=NC) — fix its resistor/driver wiring, check counter/gate inputs, and ensure se | 2026-11-17 | 2026-11-20 |
| 8 | T1_BUILD_FAIL | Boolean logic verification failed for Y = A' + B' * C: when (A=#, B=#, C=#): expected #, got LED OFF (#); when (A=#, B=#, C=#): expected #,  | 2026-11-17 | 2026-11-20 |
| 5 | T1_BUILD_FAIL | Oscilloscope "<ref>" CH*/CH* captured #.# Vpp on dynamic circuit — probe an oscillating signal net (e.g. U*.OUT / filter node) with "O*.CH*+ | 2026-11-17 | 2026-11-19 |
| 5 | T1_BUILD_FAIL | Output pin # is shorted to another output or a supply. | 2026-11-20 | 2026-11-21 |

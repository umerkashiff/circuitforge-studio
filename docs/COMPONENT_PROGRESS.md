# Component Library Implementation Progress

## Ground Rules Summary
1. **Never Fake a Pass**: If an architectural limit or missing feature prevents a true pass, record `NOT SUPPORTED` with evidence.
2. **Codebase-Driven**: Always inspect the actual codebase first, citing file baselines and preserving the 23/23 regression suite.
3. **Wokwi Compatibility**: Use Wokwi part IDs, pin nomenclature, and attribute schemas to ensure future diagram importability.
4. **Dual-Layer Verification**: Validate every part first using a software bus master testbench, then via a transpiled Arduino sketch.
5. **Strict Tier Gates**: Complete the required parts and tests for each tier, then STOP and report. Never start the next tier without approval.

---

## Tier Execution Order & Gate Plan
- **Phase 0: Recon & Baseline Audit** (Current): Audit transpiler, analog/logic engine, time resolution, and smoke sketches. No parts created. STOP.
- **Tier 1: Simple Components & Board Checks**: Passive and discrete components (LED, RGB LED, resistor, pushbuttons, slide switch, 8-way DIP, buzzer, pot, joystick, relay, clock gen, logic analyzer) and board pinout maps. STOP.
- **Tier 2: I2C Peripheral Ecosystem**: I2C bus master/arbiter, SSD1306 (128x64), SH1107, LCD1602/2004 (HD44780 + PCF8574), MPU6050, DS1307, BMP180, address collision handling. STOP.
- **Tier 3: Timing-Sensitive & Pulse Peripherals**: Pulse & single-wire timing, HC-SR04 ultrasonic, DHT22, WS2812 NeoPixel, Servo motor, Stepper/A4988, DS18B20 (1-Wire). STOP.
- **Tier 4: Shift Registers, SPI Displays & Storage**: 74HC595, 74HC165, 7-segment/TM1637, MAX7219 matrix, Nokia 5110, ILI9341 TFT, MicroSD, Keypad, Rotary encoder, Sensors. STOP.

---

## Phase 0 Recon Findings

### 1. Transpiler Capability & Smoke Test Matrix
**Files**: `src/mcu/transpile.js`, `src/mcu/runtime.js`

- **Language Features Supported**:
  - Global and local variables with C types (`int`, `long`, `short`, `float`, `double`, `char`, `bool`, `boolean`, `byte`, `word`, `String`, unsigned variants, `uint8_t`..`uint64_t`).
  - Integer truncation helper wrappers (`__i()`, `__u8()`).
  - 1D and 2D arrays (with size initialization and nested array literals: `__arr()`).
  - `sizeof()` operator on arrays.
  - `#define` constant replacement and simple single-line function macros.
  - `#include <...>` preprocessor directives are tokenized and dropped (no file lookup, no error).
  - Casts: `(int)x` $\to$ `~~x`, `(float)x` $\to$ `+x`.
  - Static local variables (`static int x = 0;` hoisted to global module scope).
  - Standard procedural control flow: `if/else`, `while`, `for`, `switch/case`, `do/while`. Loops insert cooperative yields to prevent freezing.
- **Language Features NOT Supported**:
  - `struct`: Throws explicit syntax error (`"struct" isn't supported in the simulator yet — use plain functions and variables`).
  - `class`: Throws explicit syntax error (`"class" isn't supported in the simulator yet`).
  - `template`: Throws explicit syntax error.
  - Pointers: While `int* p;` can tokenize as a declaration, address-of (`&x`) and dereference (`*p = 5`) fail with unexpected token syntax errors.
  - Pass-by-reference out-parameters (`void func(int &out)`).
- **Arduino Library Support**:
  - Built-in runtime globals: `Serial` / `Serial1` / `Serial2`, `millis()`, `micros()`, `delay()`, `delayMicroseconds()`, `pinMode()`, `digitalWrite()`, `digitalRead()`, `analogRead()`, `analogWrite()`, `tone()`, `noTone()`, `shiftOut()`, `attachInterrupt()`, `detachInterrupt()`, `neopixelWrite()`, `rgbLedWrite()`, math functions (`sin`, `cos`, `map`, `constrain`, etc.), `WiFi` mock, `ESP` mock.
  - External libraries (`Wire.h`, `SPI.h`, `Servo.h`, `Adafruit_SSD1306`, `LiquidCrystal`): Currently `Wire` and `SPI` objects are **not** present in `src/mcu/runtime.js` API object. Sketches calling `Wire.begin()` fail at runtime with `Wire is not defined`.

#### Smoke Sketches S1–S5 Results
Tested with automated testbench (`scratch/phase0_recon.mjs`):

| Test ID | Sketch Summary | Transpiler Result | Runtime Result | Status | Root Cause / Note |
|---|---|---|---|:---:|---|
| **S1** | Non-blocking Blink using `millis()` | Success | Success | **PASS** | `millis()` advances with simulated time; LED toggles as expected. |
| **S2** | Sketch with `struct`, `class`, and `array` | FAIL | Did not run | **FAIL** | Line 2 throws: `“struct” isn’t supported in the simulator yet`. `class` also throws. `int arr[3]` passes when isolated. |
| **S3** | `#include <Wire.h>` + `Wire.beginTransmission(0x3C)` | Success | FAIL | **FAIL** | Transpiler ignores `#include`, but runtime throws `Wire is not defined` (I2C API not yet added to runtime). |
| **S4** | Pin change interrupt via `attachInterrupt()` | Success | Success | **PASS** | `attachInterrupt()` tracks edge transitions on input pins and executes ISR. |
| **S5** | `analogRead()` of pot printed to `Serial` | Success | Success | **PASS** | `analogRead(A0)` samples node voltage, quantizes to 10 bits, and `Serial.println()` streams to buffer. |

---

### 2. Digital Pin Driving & Impedance Model
**File**: `src/mcu/runtime.js` (lines 64–88)

- Digital pins are **analog nodes in the linear circuit solver**:
  - `OUTPUT` (`m === 'out'`): Stamped as a Thevenin voltage source `S.src(net, level ? vcc : 0, 25)` with **$25\ \Omega$ series output resistance**.
  - `INPUT_PULLUP` (`m === 'pu'`): Stamped as a pull-up resistor to $V_{cc}$ through **$40\text{ k}\Omega$** (`R_PULL = 40000`).
  - `INPUT_PULLDOWN` (`m === 'pd'`): Stamped as a pull-down resistor to GND through **$40\text{ k}\Omega$**.
  - `INPUT` (`m === 'in'`): **High-Z**. Nothing is stamped on the net, allowing the node to float or be driven by external components.
- **Open-Drain Capability**: The simulator natively supports High-Z (`INPUT`) and Low-drive (`OUTPUT` + `LOW`). Open-drain pins can be operated by toggling between High-Z (floating / pulled high) and active Low drive.

---

### 3. Logic Voltage Modeling per Board
**Files**: `src/mcu/boards.js`, `src/mcu/runtime.js`

| Board | Microcontroller | VCC Attribute | Logic Level | ADC Resolution / Ref | Modeled in Engine? |
|---|---|:---:|:---:|:---:|:---:|
| **Arduino Uno R3** | ATmega328P (16 MHz) | `5.0 V` | 5 V TTL/CMOS | 10-bit / 5.0 V | **YES** ($V_{out} = 5\text{V}$, thresholds $3.0\text{V} / 1.5\text{V}$) |
| **Arduino Nano** | ATmega328P (16 MHz) | `5.0 V` | 5 V TTL/CMOS | 10-bit / 5.0 V | **YES** ($V_{out} = 5\text{V}$, thresholds $3.0\text{V} / 1.5\text{V}$) |
| **ESP32 DevKit V1** | ESP32-D0WD (240 MHz) | `3.3 V` | 3.3 V LVCMOS | 12-bit / 3.3 V | **YES** ($V_{out} = 3.3\text{V}$, thresholds $1.98\text{V} / 0.99\text{V}$) |
| **ESP32-S3 DevKitC-1** | ESP32-S3 (240 MHz) | `3.3 V` | 3.3 V LVCMOS | 12-bit / 3.3 V | **YES** ($V_{out} = 3.3\text{V}$, thresholds $1.98\text{V} / 0.99\text{V}$) |
| **STM32 Blue Pill** | STM32F103C8T6 (72 MHz) | `3.3 V` | 3.3 V LVCMOS | 12-bit / 3.3 V | **YES** ($V_{out} = 3.3\text{V}$, thresholds $1.98\text{V} / 0.99\text{V}$) |

---

### 4. Board Pinout & Special Function Mapping
**File**: `src/mcu/boards.js`

- **Uno R3**: Exposes digital D0–D13, analog A0–A5, SDA, SCL.
  - *Missing*: Silk markings for SPI pins (D10 SS, D11 MOSI, D12 MISO, D13 SCK), PWM tildes, ICSP header.
- **Nano**: Exposes D2–D13, A0–A7, power.
  - *Missing*: A4/A5 do not display SDA/SCL labels on silk (only present in internal `consts`).
- **ESP32**: Exposes 30 pins (D2, D4, D5, D12–D15, D18–D19, D21–D23, D25–D27, D32–D35, VN, VP).
  - *Missing*: I2C pins (D21 SDA, D22 SCL) and SPI pins (VSPI: 18, 19, 23, 5) are labeled with GPIO numbers only, without protocol role indicators. Input-only pins (34, 35, 36, 39) lack input-only indicators.
- **ESP32-S3**: Exposes 44 pins (GPIOs 0–21, 35–48).
  - *Missing*: Default I2C pins (GPIO 8 SDA, GPIO 9 SCL) and FSPI pins lack secondary silk text.
- **STM32 Blue Pill**: Exposes PA0–PA12, PA15, PB0–PB1, PB3–PB15, PC13–PC15.
  - *Missing*: Lacks standard Arduino alias constants in `board.consts` for `SDA` (PB7), `SCL` (PB6), `MOSI` (PA7), `MISO` (PA6), `SCK` (PA5).

---

### 5. Engine Time Model & Pulse Resolution Limits
**Files**: `src/sim/engine.js`, `src/mcu/runtime.js`

- **Solver Timestep ($dt$)**:
  - The solver's internal math limit is `Math.max(2e-6, dt)` ($2\ \mu\text{s}$).
  - In interactive UI simulation, steps run at `dt = 0.5 ms` ($500\ \mu\text{s}$) or `dt = 5 ms`.
  - In `runtime.js`, `delay()` and `delayMicroseconds()` are clamped: `Math.max(0.0005, ...)` $\implies \ge 500\ \mu\text{s}$ per yield!
- **Implication for High-Speed Protocols**:
  - WS2812 (NeoPixel) pulses are $0.4\ \mu\text{s}$ and $0.8\ \mu\text{s}$ (800 kHz).
  - HC-SR04 TRIG is $\ge 10\ \mu\text{s}$; ECHO is $\sim 58\ \mu\text{s}/\text{cm}$.
  - DHT22 bit pulses are $26\ \mu\text{s}$ (0) and $70\ \mu\text{s}$ (1).
- **Minimum Resolvable Pulse**:
  - The analog solver cannot step at sub-microsecond intervals in real time without browser freeze.
  - **Resolution**: Fast protocol parts must use **event-driven or message-based abstractions** (e.g., `neopixelWrite()` sends payload arrays; `pulseIn()` / HC-SR04 uses state-event timing; DHT uses message-frame responses) rather than raw analog nodal chopping of individual nanosecond edges.

---

### 6. Real-World Sketches & Binary Emulation Feasibility
- **Real-World Sketches that Will NOT Run**:
  - Sketches copying `#include <Adafruit_SSD1306.h>`, `U8g2lib.h`, `FastLED.h`, or complex C++ libraries. They fail due to lack of `class`, `struct`, templates, and C++ header linking.
- **Sketches that WILL Run**:
  - Standard Arduino sketches using procedural logic, direct `Wire` / `SPI` API calls, and our dedicated lightweight built-in API shims (`Adafruit_SSD1306` shim, `LiquidCrystal_I2C` shim, `Servo` shim) which translate calls directly to real bus transactions.
- **Feasibility of Binary Emulation**:
  - **AVR (ATmega328P - Uno / Nano)**: Realistic via **avr8js** (Uri Shaked / Wokwi core). Effort: **2–3 weeks** (requires AVR memory-mapped pin bridge and compiler backend).
  - **ESP32 / ESP32-S3 (Xtensa Dual-Core 240 MHz + FreeRTOS)**: Extremely high complexity. Requires multi-megabyte WebAssembly QEMU builds and complex peripheral bridges. Effort: **3–6 months**.
  - **STM32 (ARM Cortex-M3)**: Moderate-to-high complexity via ARMv7-M core emulator. Effort: **2–3 months**.
  - **Strategic Recommendation**: Keep the current lightweight transpiler + protocol bus master architecture. It delivers instant startup, 60 FPS in-browser simulation, and zero server compilation latency.

---

### 7. Clarifications & Deep Dives (Q1, Q2, Q3)

#### Q1: Delay Clamp & Sub-Step Timing Analysis
**Files**: `src/mcu/runtime.js` (lines 149–158, 222–226, 245–246), `src/sim/engine.js` (line 325)

**Test Stimulus**:
```cpp
digitalWrite(p, HIGH);
delayMicroseconds(10);
digitalWrite(p, LOW);
```

- **Observed Behavior**:
  - `*delayMicroseconds(us)` yields `Math.max(0.0005, (+us || 0) / 1000)`. For `10 µs`, this yields `0.0005` ($500\ \mu\text{s}$).
  - In addition, in `digitalWrite(p, LOW)`, line 223 checks:
    `if (rt.written.has(g) && rt.outs.get(g) !== val) yield 0.0005;`
    which yields another step if a pin state is changed twice in the same step.
  - When stepped with `dt = 0.5 ms`, the HIGH edge is stamped at $t = 0.500\text{ ms}$ and the LOW edge is stamped at $t = 1.000\text{ ms}$.
  - **Actual HIGH pulse width on the net**: **$500\ \mu\text{s}$ ($0.500\text{ ms}$)**, not $10\ \mu\text{s}$!
  - **`micros()` return values**:
    - `t_before = micros()` returns $500\ \mu\text{s}$.
    - `t_after = micros()` returns $1000\ \mu\text{s}$.
    - $\Delta \text{micros} = \mathbf{500\ \mu\text{s}}$ (quantized to solver step time).
- **Sub-Step Timestamps**:
  - Pin writes do **NOT** carry sub-step timestamps. Pin levels are static state levels held in `rt.outs` and stamped uniformly into the solver matrix for the duration of the timestep.
- **Architectural Decision for `pulseIn` and HC-SR04**:
  - Because analog stepping cannot resolve microsecond pulses without massive quantization jitter ($\ge \pm 500\ \mu\text{s}$ or $\sim 8.6\text{ cm}$ error), sensors such as HC-SR04 and DHT22 cannot be simulated by polling analog pin levels.
  - **Mechanism**: The MCU `pulseIn()` implementation and the HC-SR04 / DHT22 device models must use **internal event timestamping** (tracking fractional transition times directly between driver and sensor) rather than discrete step chopping.

#### Q2: Library Object Declarations & Method Calls
**Files**: `src/mcu/transpile.js` (lines 16–20, 140–177)

**Transpiler Test Results**:
| Code Snippet | Transpiler Status | Error / Note |
|---|:---:|---|
| `Servo myservo;` | **FAIL** | `Syntax error: Unexpected identifier 'myservo'` |
| `Adafruit_SSD1306 display(128, 64, &Wire, -1);` | **FAIL** | `Syntax error: Unexpected identifier 'display'` |
| `LiquidCrystal_I2C lcd(0x27, 16, 2);` | **FAIL** | `Syntax error: Unexpected identifier 'lcd'` |
| `Adafruit_NeoPixel strip(8, 6, NEO_GRB + NEO_KHZ800);` | **FAIL** | `Syntax error: Unexpected identifier 'strip'` |
| `DHT dht(2, DHT22);` | **FAIL** | `Syntax error: Unexpected identifier 'dht'` |
| `myservo.write(90);` | **PASS** | Valid method invocation syntax |
| `display.print("hi");` | **PASS** | Valid method invocation syntax |

- **Root Cause of Declaration Failure**:
  - `TYPES` in `transpile.js` is a hardcoded list of primitive C types (`int`, `float`, `char`, etc.). Custom types like `Servo` or `Adafruit_SSD1306` are not in `TYPES`, causing `parseDecl()` to reject the line.
- **Cheapest Way to Support Them**:
  1. Add a Set of recognized library class names in `transpile.js`:
     `const SHIM_CLASSES = new Set(['Servo', 'Adafruit_SSD1306', 'LiquidCrystal_I2C', 'LiquidCrystal', 'Adafruit_NeoPixel', 'DHT']);`
  2. In `transpile.js`, treat any identifier in `SHIM_CLASSES` as a type constructor:
     `ClassName obj(args);` $\to$ `const obj = new ClassName(args);`
  3. In parameter argument lists, strip the address-of operator `&` when followed by an identifier (e.g. `&Wire` $\to$ `Wire`), allowing standard constructors like `Adafruit_SSD1306 display(128, 64, &Wire, -1);` to transpile cleanly without syntax errors.

#### Q3: Current Status vs Planned Support Matrix
*(Correction from initial recon: peripheral shims do not yet exist in the codebase and are scheduled according to tier plans).*

| Component / Feature | Current Status in Codebase | Target Milestone |
|---|:---:|:---:|
| Basic Arduino Primitives (`pinMode`, `digitalWrite`, `digitalRead`, `analogRead`, `analogWrite`, `Serial`, `delay`, `millis`, `micros`, `attachInterrupt`) | **Implemented & Working** | Baseline |
| `neopixelWrite(pin, r, g, b)` | **Implemented & Working** | Baseline |
| `Wire` API (`begin`, `beginTransmission`, `write`, `endTransmission`, `requestFrom`, `read`, `available`, `setClock`) | **Implemented & Verified** | **Tier 1** |
| `SPI` API (`begin`, `transfer`, `transfer16`, `beginTransaction`, `endTransaction`) | **Implemented & Verified** | **Tier 1** |
| Board Pin Silk Labels & Aliases (SDA/SCL, SPI, Blue Pill STM aliases, ESP32 input-only) | **Implemented & Verified** | **Tier 1** |
| Tier 1 Simple Parts (LED, RGB LED, resistor, pushbuttons, switches, 8-DIP, buzzer, pot, joystick, relay, clock gen, logic analyzer) | **Implemented & Verified** | **Tier 1** |
| `Adafruit_SSD1306` Shim + Device Model (`board-ssd1306`) | **Planned** | **Tier 2** |
| `LiquidCrystal_I2C` Shim + Device Model (`wokwi-lcd1602`, `wokwi-lcd2004`) | **Planned** | **Tier 2** |
| `Servo` Shim + Device Model (`wokwi-servo`) | **Planned** | **Tier 3** |
| `DHT` Shim + Device Model (`wokwi-dht22`) | **Planned** | **Tier 3** |
| `pulseIn()` Event-Driven Helper + `wokwi-hc-sr04` | **Planned** | **Tier 3** |

---

## Tier 1 Implementation & Verification (COMPLETED)

### 1. Board-Level Upgrades & Protocol Mapping
- **Arduino Uno R3 & Nano**:
  - `UNO_CONSTS` augmented with hardware SPI pins: `MOSI: 11, MISO: 12, SCK: 13, SS: 10, SDA: 18, SCL: 19`.
  - Uno silk markings: SPI labels (`10=SS 11=MOSI 12=MISO 13=SCK`), I2C labels (`A4=SDA A5=SCL`), and pin labels updated (`D13/SCK`, `D12/MISO`, `D11/MOSI`, `D10/SS`, `A4/SDA`, `A5/SCL`).
  - Nano pins: `D13/SCK`, `D12/MISO`, `D11/MOSI`, `D10/SS`, `A4/SDA`, `A5/SCL`.
- **ESP32 DevKit V1**:
  - Pins labeled with primary & secondary functions: `D21/SDA`, `D22/SCL`, `D23/MOSI`, `D19/MISO`, `D18/SCK`, `D5/SS`.
  - Input-only pins explicitly tagged: `D35[IN]`, `D34[IN]`, `VN[IN]`, `VP[IN]`.
  - Added runtime note check: Setting `pinMode(OUTPUT)` on input-only pins 34, 35, 36, 39 emits an inspector warning.
  - Added 3.3V logic level overvoltage warning: Nodes driven > 3.6V without a level shifter generate warning notes.
- **ESP32-S3 DevKitC-1**:
  - Dedicated I2C pin labeling: `8/SDA`, `9/SCL`. Added SPI constants `MOSI: 11, MISO: 13, SCK: 12, SS: 10`.
- **STM32 Blue Pill**:
  - Silk pin markings: `PB7/SDA`, `PB6/SCL`, `PA7/MOSI`, `PA6/MISO`, `PA5/SCK`, `PA4/SS`.
  - Added global STM constants in `board.consts`: `STM.SDA = STM.PB7`, `STM.SCL = STM.PB6`, `STM.MOSI = STM.PA7`, `STM.MISO = STM.PA6`, `STM.SCK = STM.PA5`, `STM.SS = STM.PA4`.

### 2. Protocol Infrastructure (`src/sim/i2c.js`, `src/mcu/runtime.js`)
- `I2CBus`: Open-drain I2C bus coordinator with collision detection, address arbitration, ACK/NACK status codes, and scan mechanism.
- `SoftwareI2CMaster`: Independent bus master for testing devices without transpiler or MCU.
- `SoftwareI2CSlave`: Configurable slave emulator for testing MCU `Wire` master implementations.
- `Wire` master implementation in `src/mcu/runtime.js`:
  - `begin(addr)`: Auto-detects board I2C pins, configures `INPUT_PULLUP`.
  - `beginTransmission(addr)` / `write(data)` / `endTransmission()`: Buffers transactions, dispatches to `I2CBus`, returns error codes (0 = Success, 2 = Addr NACK, 3 = Data NACK, 4 = Collision).
  - `requestFrom(addr, quantity)` / `read()` / `available()` / `peek()`: Reads bytes from addressed slave device.
  - `setClock(freq)`: Configures bus speed.
- `SPI` mock in `src/mcu/runtime.js`: `begin()`, `transfer(byte)`, `transfer16(val)`, `beginTransaction()`, `endTransaction()`.

### 3. Tier 1 Component Library (`src/parts/library.js`, `src/parts/registry.js`)
All parts registered with Wokwi-compatible IDs and pin names, supporting interactive drag/click controls:
1. `wokwi-led`: Alias of `led`. 5 mm single diode with series current calculation and burn ratings.
2. `wokwi-rgb-led`: 4-pin RGB LED (R, COM, G, B) with configurable `common` ('anode' or 'cathode'). Piece-wise linear diode solver for Red (1.8V), Green (2.1V), Blue (3.0V). Dynamic color glow and hot core.
3. `wokwi-resistor`: Alias of `resistor`. Carbon-film resistor spanning 4 grid units with color bands and dissipation rating.
4. `wokwi-pushbutton`: 4-pin 6mm tactile button (`1.l`, `1.r`, `2.l`, `2.r`) straddling center gap. `bounce` attribute (default false). Internal bridge connects left-to-right on press.
5. `wokwi-slide-switch`: Alias of `slide`. SPST switch contact with visual sliding knob.
6. `wokwi-dip-switch-8`: Alias of `dip8`. 8 independent SPST logic switches with toggle levers.
7. `wokwi-buzzer`: Alias of `buzzer`. Piezo sounder with frequency and volume output.
8. `wokwi-potentiometer`: Alias of `pot`. 3-pin rotary potentiometer divider.
9. `wokwi-slide-potentiometer`: Linear fader potentiometer with interactive sliding knob, calculating wiper divider resistance.
10. `wokwi-analog-joystick`: 5-pin dual-axis joystick (`VCC`, `GND`, `VRX`, `VRY`, `SW`) with 2D thumbcap offset and push-to-click button to GND.
11. `wokwi-relay-module`: 6-pin SPDT relay (`IN`, `VCC`, `GND`, `NO`, `COM`, `NC`) with 2.5V coil threshold, active-low/high configuration, status LED, and isolated switching contacts.
12. `wokwi-clock-generator`: Square-wave source with configurable `frequency` (0.25 Hz to 1 kHz) and `duty` cycle (10% to 90%).
13. `wokwi-logic-analyzer`: 8-channel digital instrument (`GND`, `D0`..`D7`) recording state transitions to an internal timeline buffer with `exportCSV()` function.

### 4. Automated Tier 1 Test Suite Results (`tools/test_tier1.mjs`)
10 tests executed; all 10 PASS:
- **T1.1 (wokwi-led + wokwi-resistor)**: 5V $\to$ 220 $\Omega$ $\to$ Red LED $\to$ GND $\implies$ Current = 13.79 mA (PASS)
- **T1.2 (wokwi-potentiometer)**: Pot wiper on ADC A0 $\implies$ 0% = 0, 50% = 511, 100% = 1023 (PASS)
- **T1.3 (wokwi-pushbutton)**: Pushbutton to Uno D2 with `INPUT_PULLUP` $\implies$ Unpressed: 1 (HIGH), Pressed: 0 (LOW), Released: 1 (HIGH) (PASS)
- **T1.4 (wokwi-relay-module)**: IN=0V $\implies$ NC active (0.25W), NO=0W; IN=5V $\implies$ NO active (0.25W), NC=0W (PASS)
- **T1.5 (wokwi-clock-generator)**: Waveforms at 1 Hz and 1 kHz (50% duty) measured with exact transition times (PASS)
- **T1.6 (Arduino Uno + Sketch Interaction)**: Button on D2 controls LED on D13 while pot on A0 streams to Serial $\implies$ LED toggles 0.0mA $\leftrightarrow$ 7.8mA; Serial outputs POT readings (PASS)
- **T1.7 (I2C Bus + Software Master/Slave)**: Master writes `[0x10, 0xAA, 0x55]`, reads `[0xDE, 0xAD]` from slave `0x42` (PASS)
- **T1.8 (wokwi-rgb-led)**: Common Cathode (R=9.3mA, G=8.4mA, B=5.7mA) & Common Anode verified (PASS)
- **T1.9 (wokwi-logic-analyzer)**: Recorded 10 transitions from clock into D0; exported valid CSV with header `time_s,D0,D1,D2,D3,D4,D5,D6,D7` (PASS)
- **T1.10 (Wire Master in Transpiled Sketch)**: Sketch executes `Wire.write()` and `Wire.requestFrom()`; slave verifies bytes and sketch receives responses (PASS)

### 5. Regression Suite (`tools/regression_runner.mjs`)
- **Suite Result**: 23/23 tests PASS (T0.1–T11, F1–F10 all intact with zero regressions).

---

## Tier 2 Implementation & Verification (COMPLETED)

### 1. Architectural Strategy & Shared Infrastructure
- **Dedicated I2C Simulation Module (`src/sim/devices_i2c.js`)**:
  - Implemented register-accurate device models for all 7 I2C peripherals.
  - Implemented automatic open-drain bus binding via `I2CBus.getBus(engine, sda, scl)`.
  - Added power rail detection: devices monitor $V_{\text{vcc}} - V_{\text{gnd}} \ge 3.0\text{ V}$. Unpowered devices NACK transactions and flag warnings.
  - Added DC initialization in `Engine.build()` (`this.solve()`), ensuring bus registration and powered states are established before the microcontroller begins running `setup()`.
- **Microcontroller Transpiler & Runtime Enhancements (`src/mcu/transpile.js`, `src/mcu/runtime.js`)**:
  - Transpiler `SHIM_CLASSES` expanded with constructor patterns:
    - `Adafruit_SSD1306 display(128, 64, &Wire, -1);` $\to$ `const display = new Adafruit_SSD1306(128, 64, Wire, -1);`
    - `LiquidCrystal_I2C lcd(0x27, 16, 2);` $\to$ `const lcd = new LiquidCrystal_I2C(0x27, 16, 2);`
    - Aliases: `LiquidCrystal` maps to `LiquidCrystal_I2C`.
  - Embedded Adafruit-compatible GFX graphics engine in `Adafruit_SSD1306`:
    - Full 5x7 ASCII font table (`GLYPHS_5X7`), `drawPixel`, `drawLine`, `drawRect`, `fillRect`, `setTextSize`, `setTextColor`, `setCursor`, `print`, `println`, `write`, `clearDisplay`, `display`.
    - Streams byte buffers over `Wire` using horizontal addressing mode (commands `0x20`, `0x21`, `0x22`).
  - Embedded HD44780 + PCF8574 backpack driver in `LiquidCrystal_I2C`:
    - `init()`, `begin(cols, rows)`, `clear()`, `home()`, `setCursor(col, row)`, `print()`, `println()`, `write()`, `backlight()`, `noBacklight()`, `command()`, `send()`, `createChar()`.
    - Drives 4-bit nibbles with pulse-enable toggles over `Wire`.
  - Global `api` constants exposed: `SSD1306_SWITCHCAPVCC: 2`, `SSD1306_WHITE: 1`, `SSD1306_BLACK: 0`, `SSD1306_INVERSE: 2`.
  - `getWirePins()` upgraded to discover active net connections across all pin aliases (e.g. top header `SDA/SCL` vs analog pins `A4/A5` on Uno/Nano).

### 2. Tier 2 Component Models & Canvas Renderers (`src/parts/library.js`)
All 7 components registered with Wokwi-compatible IDs and pin names:
1. **`board-ssd1306` (aliases: `wokwi-ssd1306`, `ssd1306`)**:
   - 0.96″ 128x64 monochrome OLED display with SSD1306 controller.
   - Pins: `GND`, `VCC`, `SCL`, `SDA`.
   - Props: `i2cAddress` (`"0x3c"`, `"0x3d"`).
   - Canvas: Glossy dark OLED panel, gold mounting holes, real-time pixel rendering from active 1024-byte GDRAM frame buffer in vibrant cyan-blue glow (`#00f0ff`).
2. **`wokwi-sh1107` (alias: `sh1107`)**:
   - 1.28″ square 128x128 OLED display with SH1107 controller.
   - Pins: `GND`, `VCC`, `SCL`, `SDA`.
   - Props: `i2cAddress` (`"0x3c"`, `"0x3d"`).
   - Canvas: Square display panel with 2048-byte buffer.
3. **`wokwi-lcd1602` (alias: `lcd1602`)**:
   - 16x2 character LCD with PCF8574 I2C backpack.
   - Pins: `GND`, `VCC`, `SDA`, `SCL`.
   - Props: `i2cAddress` (`"0x27"`, `"0x3f"`).
   - Controller: Emulates HD44780 4-bit bus, DDRAM (128 bytes), CGRAM (64 bytes), row offsets `[0x00, 0x40]`.
   - Canvas: High-contrast blue backlit bezel with 5x8 dot-matrix character rendering and backlight glow.
4. **`wokwi-lcd2004` (alias: `lcd2004`)**:
   - 20x4 character LCD with PCF8574 backpack.
   - Pins: `GND`, `VCC`, `SDA`, `SCL`.
   - Props: `i2cAddress` (`"0x27"`, `"0x3f"`).
   - Controller: 4-row DDRAM mapping (`[0x00, 0x40, 0x14, 0x54]`).
   - Canvas: Green backlit LCD matrix rendering 4 full lines of text.
5. **`wokwi-mpu6050` (alias: `mpu6050`)**:
   - 6-axis accelerometer & gyroscope (GY-521 breakout).
   - Pins: `VCC`, `GND`, `SCL`, `SDA`, `XDA`, `XCL`, `AD0`, `INT`.
   - Props: `accelX`, `accelY`, `accelZ`, `gyroX`, `gyroY`, `gyroZ`, `freefall`, `motion`.
   - Registers: `WHO_AM_I` (`0x75` $\to$ `0x68`), `ACCEL_XOUT`..`ACCEL_ZOUT` (`0x3B`..`0x40`), `TEMP_OUT` (`0x41`..`0x42`), `GYRO_XOUT`..`GYRO_ZOUT` (`0x43`..`0x48`), interrupt status on motion/freefall driving the physical `INT` pin HIGH.
   - Canvas: Blue PCB with gold plated pads, central QFN chip, and silkscreen orientation axes.
6. **`wokwi-ds1307` (alias: `ds1307`)**:
   - Real-Time Clock with 56-byte battery-backed NVRAM.
   - Pins: `VCC`, `GND`, `SDA`, `SCL`, `SQW`.
   - Props: `mode` (`'simulated'` or `'wall'`).
   - Features: Registers `0x00`..`0x06` return BCD seconds, minutes, hours, day, date, month, year; registers `0x08`..`0x3F` store and read back persistent non-volatile RAM bytes.
   - Canvas: RTC breakout with silver CR2032 coin cell holder, cylindrical 32.768 kHz quartz crystal, and SOIC chip.
7. **`wokwi-bmp180` (alias: `bmp180`)**:
   - Barometric pressure & temperature sensor.
   - Pins: `VCC`, `GND`, `SCL`, `SDA`.
   - Props: `temperature`, `pressure`.
   - Features: Chip ID `0x55` at register `0xD0`, 22 factory calibration bytes (`AC1`..`MD`), `0xF4` control measurement triggers (`0x2E` temp, `0x34` pressure with oversampling `oss=0..3`), inverse Bosch compensation model computing exact uncompensated raw words ($UT$, $UP$).
   - Canvas: Purple breakout board with metal pressure can and sensor port hole.

### 3. Automated Tier 2 Test Suite Results (`tools/test_tier2.mjs`)
10 tests executed; all 10 PASS:
- **T2.1 (board-ssd1306 Software Master)**: Master sets horizontal addressing mode and streams 16 bytes of `0xFF` data $\implies$ Slave ACKs, `dev.buffer[0..15] = 0xFF` (PASS)
- **T2.2 (board-ssd1306 Transpiled Arduino Sketch)**: Sketch with `#include <Adafruit_SSD1306.h>` calls `begin()`, `clearDisplay()`, `drawPixel(10,20)`, `drawLine()`, `print("CF")`, `display()` $\implies$ Pixel (10,20) verified set, 129 active frame buffer bytes (PASS)
- **T2.3 (wokwi-sh1107 Software Master)**: 128x128 square OLED verified with 2048-byte buffer and command ACK at address `0x3C` (PASS)
- **T2.4 (wokwi-lcd1602 Software Master)**: Master sends 4-bit PCF8574 initialization sequence and writes `'TEST'` $\implies$ Line 0 displays `'TEST'`, backlight active (PASS)
- **T2.5 (wokwi-lcd1602 Transpiled Arduino Sketch)**: Sketch with `#include <LiquidCrystal_I2C.h>` calls `lcd.init()`, `lcd.backlight()`, `lcd.print("CircuitForge")`, `lcd.print("LCD 1602 PASS")` $\implies$ Row 0: `'CircuitForge'`, Row 1: `'LCD 1602 PASS'`, Backlight: true (PASS)
- **T2.6 (wokwi-lcd2004 Transpiled Arduino Sketch)**: Sketch with `LiquidCrystal_I2C lcd(0x27, 20, 4)` writes 4 rows $\implies$ All 4 rows verified: `["Line 1: 20x4 LCD", "Line 2: HD44780", "Line 3: PCF8574", "Line 4: Verified"]` (PASS)
- **T2.7 (wokwi-mpu6050 Motion + Interrupt)**: Read `WHO_AM_I` (`0x68`), Accel $X=0.5\text{g} \to 8192$, Accel $Z=1.0\text{g} \to 16384$, motion triggers `INT` pin to 3.30V (PASS)
- **T2.8 (wokwi-ds1307 RTC + NVRAM)**: Writes and reads 4 bytes `[0xDE, 0xAD, 0xBE, 0xEF]` to NVRAM register `0x08`; reads valid BCD time `12:00:00` from clock registers (PASS)
- **T2.9 (wokwi-bmp180 Temperature & Pressure)**: Chip ID `0x55` verified; Bosch compensation formula computes $T = 25.0^\circ\text{C}$ and $P = 101326\text{ Pa}$ from uncompensated sensor words (PASS)
- **T2.10 (I2CBus Collision Detection)**: Two SSD1306 displays wired to the same bus at address `0x3C` $\implies$ Bus flags collision error, records inspector warnings on both parts, and returns error code 4 on write attempts (PASS)

### 4. Full Regression Verification (`tools/regression_runner.mjs`)
- **Suite Result**: 23/23 tests PASS (Zero regressions across all analog, logic IC, 555 timer, and counter testbenches).


### 6. Limits Discovered
- `analogRead()` samples the node voltage from the linear solver. In the very first simulation step before `solve()` has run, node voltages start at `NaN`, so sketches reading analog pins inside `setup()` read fallback random ADC noise unless a pre-solve step occurs.
- On potentiometers, wiring Pin 1 to 5V and Pin 3 to GND reverses the expected 0% $\to$ 100% direction relative to standard breadboard conventions (standard is Pin 1 = GND, Pin 2 = Wiper, Pin 3 = VCC).
- Pushbutton bounce attribute defaults to `false` (ideal). When enabled, bounce toggling is handled over multiple simulation ticks.

### 7. What Comes Next (Tier 2: I2C Peripheral Ecosystem)
- Build Wokwi I2C display & sensor peripheral models:
  - `board-ssd1306` (128×64 monochrome OLED, I2C address `0x3C`/`0x3D`, full frame buffer & graphics rendering)
  - `wokwi-lcd1602` / `wokwi-lcd2004` with PCF8574 I2C backpack (`0x27`/`0x3F`)
  - `wokwi-mpu6050` (6-axis accelerometer + gyro, `0x68`/`0x69`)
  - `wokwi-ds1307` (RTC with battery backup registers, `0x68`)
  - `wokwi-bmp180` (barometric pressure & temperature sensor, `0x77`)
- Implement `Adafruit_SSD1306` and `LiquidCrystal_I2C` shims and method bindings.
- Address collision test for two identical displays on the same bus.
- Run dual-layer testing (software bus master testbench + transpiled Arduino sketch testbench) for every Tier 2 peripheral.
- Verify full regression suite (23/23) before stopping.


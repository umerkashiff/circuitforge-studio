ROLE
You are extending my circuit simulator (CircuitForge) with a Wokwi-style
component library for the five boards in the Microcontrollers palette:
Arduino Uno R3, Arduino Nano, ESP32 DevKit V1, ESP32-S3 DevKitC-1,
STM32 Blue Pill. The existing logic ICs, 555, 7447, 7493, JK flip-flops and
the rest already pass 23/23 regression tests. Do NOT change their behavior.
Re-run the full regression suite after every tier and report any change.

HOW THE MCUs WORK TODAY (from your own earlier description; verify it in code)
Each MCU has an editable code property. On Upload, src/mcu/transpile.js turns
the Arduino C/C++ sketch into JavaScript generator functions. Blocking calls
(delay, delayMicroseconds, yield, digitalWrite, shiftOut) become yields tied
to the solver timestep dt. src/mcu/runtime.js couples the sketch to the
analog solver: power pins are low-impedance sources, digitalWrite is a
voltage source with about 25 ohm output resistance, digitalRead thresholds
at 0.6 Vcc and 0.3 Vcc, analogRead digitizes the node voltage (10-bit AVR,
12-bit ESP32/STM32), plus analogWrite, tone, ledcWrite, neopixelWrite,
Serial, and attachInterrupt. It is NOT a binary or opcode emulator.
Compiled .hex/.bin files cannot run. Do not claim otherwise anywhere.

GROUND RULES
- Never fake a pass. If something is not modeled, mark it NOT SUPPORTED and
  say why.
- Read the code before answering any question about it. Cite file names.
- Use Wokwi part type names and attribute names where possible
  (wokwi-led, wokwi-servo, wokwi-lcd1602, board-ssd1306, attribute
  i2cAddress, etc.) so Wokwi diagram.json files could be imported later.
- Each part gets: a device model, a palette entry with an icon, pin names
  matching Wokwi's, editable attributes, a sketch-facing API (see below),
  and automated tests.
- Test every device model with a SOFTWARE BUS MASTER in the test harness
  (an I2C master, SPI master, 1-Wire master, bit-banged pulse generator),
  independent of the transpiler. Then add a second test layer that drives
  the same part from a real Arduino sketch through the transpiler.
- After each tier: STOP and report. Wait for me before starting the next tier.

PHASE 0 - RECON (report before building anything)
Read the code and answer, with file names:
 1. Transpiler capability. List exactly which C++ features and Arduino
    libraries are supported and which are not (classes, structs, templates,
    arrays, pointers, #define and #include handling, Wire.h, SPI.h, Serial,
    millis, micros, pulseIn, Servo.h, any display library). Prove each answer
    by compiling and running a small test sketch, and give me a PASS/FAIL
    table for these five smoke sketches:
      S1 Blink using millis() instead of delay().
      S2 A sketch with a struct, a class and an array.
      S3 #include <Wire.h> and Wire.beginTransmission(0x3C).
      S4 An interrupt on a button press via attachInterrupt.
      S5 analogRead of a potentiometer printed to Serial.
 2. How are digital pins driven: ideal logic levels in the event engine, or
    analog nodes in the solver? Can a pin be open-drain / high-Z?
 3. What is the logic voltage per board, and is it modeled?
    (Uno/Nano 5 V; ESP32, ESP32-S3, Blue Pill 3.3 V.)
 4. Do the MCU parts expose real pin names and special functions
    (I2C SDA/SCL, SPI, PWM, ADC)? List what is missing.
 5. Time model: the smallest timestep, and whether a part can see
    microsecond-scale pulse widths (needed for HC-SR04, DHT22, NeoPixel).
    Report the minimum pulse width the sim can resolve.
 6. Honest limits: which real-world sketches (for example a copied Wokwi
    project using Adafruit_SSD1306 or U8g2) will NOT run, and why.
Then tell me whether firmware-level work is realistic beyond the transpiler.
Real binary emulation for AVR (avr8js) is feasible. For ESP32, ESP32-S3
and STM32 it is much harder. Give me effort estimates, do not implement.

BUS MODELING (build once, reuse everywhere)
 - I2C: open-drain SDA/SCL with pull-ups. A "pull-ups" attribute on
   module-style parts, default ON. 7-bit addresses, ACK/NACK, repeated
   start, clock stretching if cheap. Report address collisions
   (two parts at 0x68) clearly, never silently.
 - SPI: modes 0 to 3, MSB first, CS active low.
 - 1-Wire: open-drain with pull-up, reset/presence timing.
 - PWM / pulse measurement: parts measure pulse widths and periods at the
   solver's resolution.
 - ADC: potentiometers and analog sensors are real voltage dividers in the
   analog solver, not fake values.
 - SKETCH-FACING API for each bus: expose what sketches call, so real code
   can drive the part: Wire (begin, beginTransmission, write,
   endTransmission, requestFrom, available, read, setClock), SPI
   (begin, transfer, beginTransaction), pulseIn, shiftIn/shiftOut,
   Servo.h (attach, write, writeMicroseconds), tone/noTone, millis/micros,
   and a NeoPixel call that works with the new parts. Add each API through
   the transpiler/runtime, and list any you could not add.

=====================================================================
TIER 1 - SIMPLE PARTS (no protocol)
=====================================================================
LED, RGB LED (common anode and cathode attribute), resistor, pushbutton
(4-pin and 6 mm, bounce attribute default off), slide switch, 8-way DIP
switch, buzzer (frequency output, optional audio), potentiometer and slide
potentiometer (3-pin divider), analog joystick, relay module (coil
threshold, contact output), clock generator (frequency and duty attributes,
useful for my logic labs), logic analyzer (records pins to a timeline,
exports CSV).
Tests: LED current with series resistor, pot at 0/50/100% reads 0, Vcc/2,
Vcc on an ADC, button press changes the pin level, relay switches a load,
clock generator at 1 Hz and 1 kHz measures correctly. Also one sketch test:
button controls an LED, pot value printed to Serial.
STOP and report.

=====================================================================
TIER 2 - I2C DEVICES
=====================================================================
2.1 board-ssd1306 (attribute i2cAddress, default 0x3C, option 0x3D)
  Pins: GND, VCC, SCL, SDA. 128x64 monochrome, I2C only.
  - Control byte: 0x00 = commands follow, 0x40 = data follows (handle Co/DC
    bits and multi-byte streams).
  - 1024-byte frame buffer, 8 pages x 128 columns, 1 bit per pixel,
    LSB = top pixel of the page.
  - Addressing modes via 0x20: horizontal, vertical, page. Column window
    0x21, page window 0x22, page-mode commands 0xB0-0xB7 and column
    low/high nibble 0x00-0x0F / 0x10-0x1F. Correct wrap-around per mode.
  - Commands: 0xAE/0xAF display off/on, 0xA4/0xA5 entire display
    resume/force on, 0xA6/0xA7 normal/inverse, 0x81 contrast, 0xA0/0xA1
    segment remap, 0xC0/0xC8 COM scan direction, 0xA8 mux ratio, 0xD3
    display offset, 0x40-0x7F start line, 0xDA COM pins, 0xD5 clock, 0xD9
    precharge, 0xDB VCOMH, 0x8D charge pump (a real module stays dark if the
    charge pump is not enabled; model that behind an attribute so strict
    behavior can be turned off).
  - Unknown commands: ignore, log a warning, never crash.
  - Render the buffer in the UI as a pixel grid honoring invert, contrast
    (brightness), flip and scan direction. Add a "screenshot to PNG" button.
  - Sketch layer: because the transpiler cannot compile the real
    Adafruit_SSD1306 or U8g2 libraries, propose a minimal built-in
    Adafruit_SSD1306-style shim (begin, clearDisplay, drawPixel, drawLine,
    drawRect, fillRect, setTextSize, setCursor, print/println, display)
    with a built-in 5x7 font. The shim MUST send real I2C bytes to the
    device model through Wire, never write to the framebuffer directly.
    Report effort and limits BEFORE building it. Also make sure sketches
    that send raw bytes with Wire.beginTransmission(0x3C) work.
  Tests (software I2C master): init sequence used by the Adafruit library,
  write a known 1024-byte pattern and read back the rendered frame, all
  three addressing modes with window wrap, invert and flip, display off
  blanks, wrong address gets NACK, 0x3D variant works. Sketch tests: raw Wire
  init plus a pixel pattern, then the shim's text and a line.
2.2 SH1107 OLED (128x128): reuse the SSD1306 core where the command set
    overlaps and document differences.
2.3 wokwi-lcd1602 and wokwi-lcd2004 (HD44780): parallel 4-bit and 8-bit,
    plus the I2C backpack variant (PCF8574, address attribute, default 0x27).
    Init sequence, clear, home, entry mode, display control, cursor, shift,
    DDRAM addressing (line 2 starts at 0x40), CGRAM custom characters, busy
    flag. Sketch layer: a LiquidCrystal-style shim (and LiquidCrystal_I2C).
2.4 wokwi-mpu6050: address 0x68 (0x69 if AD0 high), WHO_AM_I register 0x75
    returns 0x68, PWR_MGMT_1 (0x6B) powers up asleep, accel registers
    0x3B-0x40, temp 0x41-0x42, gyro 0x43-0x48. UI sliders set accel, gyro
    and temperature. Apply configured full-scale ranges.
2.5 wokwi-ds1307: address 0x68, BCD time registers 0x00-0x06, CH bit in the
    seconds register, control 0x07, 56 bytes RAM 0x08-0x3F. Time runs from
    sim time. Collides with the MPU6050 at 0x68: report it clearly.
2.6 board-bmp180: calibration EEPROM, temperature and pressure read
    sequence with the datasheet conversion maths. Lower priority.
Tests per part with the I2C master, including the address-collision test.
STOP and report.

=====================================================================
TIER 3 - TIMING-SENSITIVE PARTS
=====================================================================
First report the smallest pulse the engine can resolve. If it cannot
resolve what a part needs, say so and propose a fix (event-driven timing
for digital-only parts) rather than faking values. A transpiled sketch will
not match real firmware timing exactly, so for each part below state whether
it uses a built-in primitive (pulseIn, neopixelWrite, a DHT helper) or a
bit-banged protocol, and test the timing margin.
3.1 wokwi-hc-sr04: TRIG needs a pulse of at least 10 us. ECHO goes high
    after a short delay and its width is 2 * distance / 343 m/s (about 58 us
    per cm). Distance attribute/slider from 2 cm to 400 cm. Sketch layer:
    pulseIn and the common ultrasonic sketch pattern.
3.2 wokwi-dht22: single-wire. Host pulls low for at least 1 ms and releases.
    Sensor replies 80 us low, 80 us high, then 40 bits. Each bit is 50 us
    low, then high for about 26-28 us (0) or about 70 us (1). Data =
    humidity 16 bits (x0.1 %), temperature 16 bits (x0.1 C, MSB = sign),
    checksum = low 8 bits of the sum of the 4 data bytes. Ignore requests
    faster than 2 s. Temperature and humidity attributes. Sketch layer:
    a DHT-library-style shim, with a note on whether bit timing is real or
    abstracted.
3.3 wokwi-neopixel, wokwi-led-strip, wokwi-led-ring (WS2812 style): 800 kHz
    data, about 0.4 us high = 0 and about 0.8 us high = 1 (use tolerance
    bands), 24 bits per pixel in GRB order, MSB first, data re-timed and
    passed to DOUT, latch after a low gap of more than 50 us. Pixel count
    attribute. Render colors. Hook up the existing neopixelWrite.
3.4 wokwi-servo: PWM at about 50 Hz, pulse width maps to angle (use the
    range from Wokwi's wokwi-servo docs and state the value you used).
    Animate movement and show the angle. Sketch layer: Servo.h.
3.5 wokwi-stepper-motor, wokwi-biaxial-stepper, wokwi-a4988: STEP rising
    edge moves one (micro)step, DIR sets direction, EN active low, MS1-MS3
    set microstepping. Show the shaft angle.
3.6 wokwi-ds18b20 (1-Wire): reset/presence, ROM commands 0x33, 0x55, 0xCC,
    0x44 convert, 0xBE read scratchpad with CRC8, 12-bit temperature
    attribute. Lower priority.
3.7 wokwi-hx711: lower priority, only if time allows.
Tests: bit-banged masters with exact pulse trains, plus sketch tests; report
the timing margin each part tolerates.
STOP and report.

=====================================================================
TIER 4 - SHIFT REGISTERS, DISPLAYS, STORAGE
=====================================================================
74HC595 (SER, SRCLK rising shift, RCLK rising latch, OE active low, SRCLR
active low, QH' serial out, cascade two), 74HC165 (parallel load active
low, clock, serial out), wokwi-7segment, tm1637 7-segment, max7219 8x8
matrix, wokwi-led-matrix, led-bar-graph, nokia-5110 (SPI), ili9341 (SPI
color TFT, start with a minimal command set and a framebuffer), microSD
(SPI), membrane keypad, KY-040 rotary encoder (quadrature plus switch), IR
receiver/remote, PIR motion sensor, NTC thermistor, photoresistor, gas
sensor, MFRC522.
Only after Tiers 1 to 3 are accepted, in the listed order. Sketch layer for
shiftOut/shiftIn and SPI where applicable.

=====================================================================
BOARD-LEVEL CHECKS (do early, in Tier 1)
=====================================================================
- Each board's default I2C pins are available and labeled. Uno/Nano:
  SDA = A4, SCL = A5. ESP32: commonly SDA 21 and SCL 22. Check Wokwi's docs
  for each board, including the Blue Pill and ESP32-S3, and tell me what
  you found. Mark anything unverified.
- Logic levels: warn when a 5 V part drives a 3.3 V board pin without a
  level shifter or divider (a warning, not an error).
- A pin function map for each of the five boards (I2C, SPI, UART, PWM, ADC)
  available to the parts.

=====================================================================
REPORTING (for every tier)
=====================================================================
1. Parts added, files changed, and anything NOT SUPPORTED.
2. Test table: Test ID | Part | Layer (bus master or sketch) | Stimulus |
   Expected | Observed | PASS/FAIL.
3. Full regression suite re-run (all existing tests), with the count.
4. Any assumption you made, with the evidence.
5. What real-world sketches will and will not run with the new parts.
6. A short manual check list I can do in the UI (for example: wire the
   SSD1306 to the Uno's A4/A5, upload the sample sketch, see the frame
   render).
Do not start the next tier until I say so.
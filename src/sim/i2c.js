/**
 * I2C and SPI Bus Infrastructure for CircuitForge.
 *
 * Implements:
 * 1. Open-drain I2C bus registration and arbitration.
 * 2. Address collision detection.
 * 3. Independent Software I2C Master (for test harness).
 * 4. Software I2C Slave (for test harness).
 * 5. SPI Bus coordinator.
 */

export class I2CBus {
  static getBus(engine, sdaNet, sclNet) {
    if (!engine._i2cBuses) engine._i2cBuses = new Map();
    const key = `${sdaNet},${sclNet}`;
    let bus = engine._i2cBuses.get(key);
    if (!bus) {
      bus = new I2CBus(engine, sdaNet, sclNet);
      engine._i2cBuses.set(key, bus);
    }
    return bus;
  }

  constructor(engine, sdaNet, sclNet) {
    this.engine = engine;
    this.sdaNet = sdaNet;
    this.sclNet = sclNet;
    this.devices = new Map(); // address (number) -> device
    this.collisions = new Set();
  }

  register(addr, device) {
    const numAddr = typeof addr === 'string' ? parseInt(addr, 16) : addr;
    if (this.devices.has(numAddr)) {
      const existing = this.devices.get(numAddr);
      if (existing === device) return true;
      this.collisions.add(numAddr);
      const hex = '0x' + numAddr.toString(16).toUpperCase().padStart(2, '0');
      const warn = `I2C Address Collision: Multiple devices configured at address ${hex} on the same bus (SDA: net ${this.sdaNet}, SCL: net ${this.sclNet}).`;
      if (existing) existing.warning = warn;
      if (device) device.warning = warn;
      return false;
    }
    this.devices.set(numAddr, device);
    return true;
  }

  unregister(addr) {
    const numAddr = typeof addr === 'string' ? parseInt(addr, 16) : addr;
    this.devices.delete(numAddr);
    this.collisions.delete(numAddr);
  }

  /**
   * Execute an I2C Write transaction.
   * Returns: 0 = Success (ACK), 2 = Address NACK, 3 = Data NACK
   */
  write(addr, bytes) {
    const numAddr = typeof addr === 'string' ? parseInt(addr, 16) : addr;
    if (this.collisions.has(numAddr)) {
      return 4; // Bus error due to collision
    }
    const dev = this.devices.get(numAddr);
    if (!dev) {
      return 2; // Address NACK
    }
    if (dev.i2cWrite) {
      const res = dev.i2cWrite(bytes);
      if (res === false || (res && res.ack === false)) return 3; // Data NACK
      return 0; // Success
    }
    return 0;
  }

  /**
   * Execute an I2C Read transaction.
   * Returns array of bytes.
   */
  read(addr, quantity) {
    const numAddr = typeof addr === 'string' ? parseInt(addr, 16) : addr;
    if (this.collisions.has(numAddr)) return [];
    const dev = this.devices.get(numAddr);
    if (!dev || !dev.i2cRead) return [];
    return dev.i2cRead(quantity) || [];
  }

  /** Scan the bus: returns list of addresses that respond with ACK */
  scan() {
    const found = [];
    for (const [addr, dev] of this.devices) {
      if (!this.collisions.has(addr)) found.push(addr);
    }
    return found.sort((a, b) => a - b);
  }
}

/**
 * Independent Software I2C Master for testing devices without transpiler/MCU.
 */
export class SoftwareI2CMaster {
  constructor(engineOrBus, sdaNet, sclNet) {
    if (engineOrBus instanceof I2CBus) {
      this.bus = engineOrBus;
      this.engine = this.bus.engine;
      this.sdaNet = this.bus.sdaNet;
      this.sclNet = this.bus.sclNet;
    } else {
      this.engine = engineOrBus;
      this.sdaNet = sdaNet;
      this.sclNet = sclNet;
      this.bus = I2CBus.getBus(engineOrBus, sdaNet, sclNet);
    }
  }

  write(addr, bytes) {
    return this.bus.write(addr, bytes);
  }

  writeBytes(addr, bytes) {
    return this.bus.write(addr, bytes) === 0;
  }

  read(addr, qty) {
    return this.bus.read(addr, qty);
  }

  readBytes(addr, qty) {
    return this.bus.read(addr, qty);
  }

  ping(addr) {
    return this.bus.write(addr, []) === 0;
  }

  scan() {
    return this.bus.scan();
  }
}

/**
 * Software I2C Slave class for bus testing.
 */
export class SoftwareI2CSlave {
  constructor(bus, addr = 0x42, readData = [0xAA, 0x55]) {
    this.bus = bus;
    this.addr = addr;
    this.receivedData = [];
    this.responseData = readData;
    bus.register(addr, this);
  }
  i2cWrite(bytes) {
    this.receivedData.push(...bytes);
    return { ack: true };
  }
  i2cRead(qty) {
    return this.responseData.slice(0, qty);
  }
}

/**
 * Software I2C Slave circuit device for testing MCU Wire master implementations.
 */
export function softwareI2CSlave(nets, addr = 0x42, onWrite = null, readData = [0xAA, 0x55]) {
  const [sda, scl] = nets;
  const dev = {
    addr,
    received: [],
    warning: null,
    i2cWrite(bytes) {
      this.received.push(...bytes);
      if (onWrite) onWrite(bytes);
      return { ack: true };
    },
    i2cRead(qty) {
      return readData.slice(0, qty);
    },
    stamp(S, V, engine) {
      if (sda >= 0 && scl >= 0 && !this.registered) {
        const bus = I2CBus.getBus(engine, sda, scl);
        bus.register(this.addr, this);
        this.registered = true;
      }
    }
  };
  return dev;
}


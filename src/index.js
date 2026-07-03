const DEFAULT_BLOCK_SIZE = 0x4000;

// Mirrors esp_loader_error_t in esp-serial-flasher/include/esp_loader_error.h.
// EspSerialFlasherError#code is one of these values, so callers can branch on
// it (e.g. offer a retry on TIMEOUT but not on INVALID_MD5) instead of
// hardcoding magic numbers.
export const EspLoaderErrorCode = Object.freeze({
  SUCCESS: 0,
  FAIL: 1,
  TIMEOUT: 2,
  IMAGE_SIZE: 3,
  INVALID_MD5: 4,
  INVALID_PARAM: 5,
  INVALID_TARGET: 6,
  UNSUPPORTED_CHIP: 7,
  UNSUPPORTED_FUNC: 8,
  INVALID_RESPONSE: 9,
});

// NOTE: TargetChip / TargetChipName are a hand-maintained mirror of the C
// enum target_chip_t. If the esp-serial-flasher submodule adds a chip, add it
// here too — otherwise getTargetName() will report "Unknown" for a real chip.
export const TargetChip = Object.freeze({
  ESP8266: 0,
  ESP32: 1,
  ESP32S2: 2,
  ESP32C3: 3,
  ESP32S3: 4,
  ESP32C2: 5,
  ESP32C5: 6,
  ESP32H2: 7,
  ESP32C6: 8,
  ESP32P4: 9,
  ESP32C61: 10,
  UNKNOWN: 11,
});

export const TargetChipName = Object.freeze({
  [TargetChip.ESP8266]: "ESP8266",
  [TargetChip.ESP32]: "ESP32",
  [TargetChip.ESP32S2]: "ESP32-S2",
  [TargetChip.ESP32C3]: "ESP32-C3",
  [TargetChip.ESP32S3]: "ESP32-S3",
  [TargetChip.ESP32C2]: "ESP32-C2",
  [TargetChip.ESP32C5]: "ESP32-C5",
  [TargetChip.ESP32H2]: "ESP32-H2",
  [TargetChip.ESP32C6]: "ESP32-C6",
  [TargetChip.ESP32P4]: "ESP32-P4",
  [TargetChip.ESP32C61]: "ESP32-C61",
  [TargetChip.UNKNOWN]: "Unknown",
});

export class EspSerialFlasherError extends Error {
  constructor(message, code) {
    super(`${message}${typeof code === "number" ? ` (error ${code})` : ""}`);
    this.name = "EspSerialFlasherError";
    this.code = code;
  }
}

async function loadDefaultWasmModuleFactory() {
  const wasmModule = await import("../dist/esp-serial-flasher.js");
  return wasmModule.default;
}

function normalizeLogger(logger = {}) {
  const noop = () => {};
  const log = logger.log?.bind(logger) || noop;
  return {
    log,
    debug: logger.debug?.bind(logger) || log,
    error: logger.error?.bind(logger) || log,
    warn: logger.warn?.bind(logger) || log,
    info: logger.info?.bind(logger) || log,
  };
}

function toUint8Array(data) {
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new TypeError("Expected data to be an ArrayBuffer or Uint8Array");
}

function formatMacAddress(mac) {
  return Array.from(mac, (byte) => byte.toString(16).padStart(2, "0")).join(":");
}

export async function createEspSerialFlasher(options = {}) {
  const { transport, logger, advanced = {} } = options;
  const { wasmModuleFactory, locateFile, moduleOptions = {} } = advanced;

  if (!transport) {
    throw new TypeError("createEspSerialFlasher() requires a serial transport");
  }

  const factory = wasmModuleFactory || (await loadDefaultWasmModuleFactory());
  const normalizedLogger = normalizeLogger(logger);
  const module = await factory({
    ...moduleOptions,
    locateFile,
    logger: normalizedLogger,
    serialTransport: transport,
  });

  return new EspSerialFlasher(module, transport, normalizedLogger);
}

export class EspSerialFlasher {
  #connected;
  #module;

  constructor(module, transport, logger = {}) {
    this.#module = module;
    this.transport = transport;
    this.logger = normalizeLogger(logger);

    this._connect = module.cwrap("flasher_connect", "number", [], { async: true });
    this._changeBaudRate = module.cwrap("flasher_change_baudrate", "number", ["number"], { async: true });
    this._getTarget = module.cwrap("flasher_get_target", "number", []);
    this._readMac = module.cwrap("flasher_read_mac", "number", ["number"], { async: true });
    this._detectFlashSize = module.cwrap("flasher_flash_detect_size", "number", ["number"], { async: true });
    this._flashStart = module.cwrap("flasher_flash_start", "number", ["number", "number", "number"], { async: true });
    this._flashWrite = module.cwrap("flasher_flash_write", "number", ["number", "number"], { async: true });
    this._flashFinish = module.cwrap("flasher_flash_finish", "number", [], { async: true });
    this._flashRead = module.cwrap("flasher_flash_read", "number", ["number", "number", "number"], { async: true });
    this._eraseFlash = module.cwrap("flasher_flash_erase", "number", [], { async: true });
    this._eraseRegion = module.cwrap("flasher_flash_erase_region", "number", ["number", "number"], { async: true });
    this._resetTarget = module.cwrap("flasher_reset_target", null, [], { async: true });
    this._disconnect = module.cwrap("flasher_disconnect", null, []);

    this.#connected = false;
  }

  /**
   * Connects to the target and uploads the flasher stub. Must be called
   * before any other method except disconnect() — calling e.g. flash() or
   * detectFlashSize() first throws rather than reaching into the WASM
   * module in an undefined state.
   */
  async connect() {
    await this.#check(await this._connect(), "Failed to connect to target");
    this.#connected = true;
    return this;
  }

  /** True once connect() has succeeded, false before that or after disconnect(). */
  get connected() {
    return this.#connected;
  }

  getTarget() {
    this.#requireConnected();
    return this._getTarget();
  }

  getTargetName() {
    return TargetChipName[this.getTarget()] || TargetChipName[TargetChip.UNKNOWN];
  }

  async changeBaudRate(baudRate) {
    this.#requireConnected();
    await this.#check(await this._changeBaudRate(baudRate), `Failed to change baud rate to ${baudRate}`);
  }

  async detectFlashSize() {
    this.#requireConnected();
    const ptr = this.#module._malloc(4);
    try {
      await this.#check(await this._detectFlashSize(ptr), "Failed to detect flash size");
      return this.#module.getValue(ptr, "i32") >>> 0;
    } finally {
      this.#module._free(ptr);
    }
  }

  async readMac() {
    this.#requireConnected();
    const ptr = this.#module._malloc(6);
    try {
      await this.#check(await this._readMac(ptr), "Failed to read MAC address");
      return this.#module.HEAPU8.slice(ptr, ptr + 6);
    } finally {
      this.#module._free(ptr);
    }
  }

  async readMacString() {
    return formatMacAddress(await this.readMac());
  }

  async flash({ address, data, blockSize = DEFAULT_BLOCK_SIZE, onProgress } = {}) {
    this.#requireConnected();
    const bytes = toUint8Array(data);
    await this.#check(await this._flashStart(address, bytes.length, blockSize), "Failed to start flash operation");

    // Timed like esptool: only the write loop counts toward the reported
    // speed, not flash_finish()'s device-side MD5 verification below.
    const startTime = performance.now();

    for (let offset = 0; offset < bytes.length; offset += blockSize) {
      const chunk = bytes.subarray(offset, Math.min(offset + blockSize, bytes.length));
      await this.#withHeapBytes(chunk, async (ptr) => {
        await this.#check(await this._flashWrite(ptr, chunk.length), "Failed to write flash block");
      });
      onProgress?.(Math.min(offset + chunk.length, bytes.length), bytes.length);
    }

    const durationMs = performance.now() - startTime;

    await this.#check(await this._flashFinish(), "Failed to finish flash operation");

    return { bytesWritten: bytes.length, durationMs };
  }

  async readFlash(address, length, { blockSize = DEFAULT_BLOCK_SIZE, onProgress } = {}) {
    this.#requireConnected();
    const result = new Uint8Array(length);
    for (let offset = 0; offset < length; offset += blockSize) {
      const size = Math.min(blockSize, length - offset);
      const ptr = this.#module._malloc(size);
      try {
        await this.#check(await this._flashRead(ptr, address + offset, size), "Failed to read flash");
        result.set(this.#module.HEAPU8.subarray(ptr, ptr + size), offset);
      } finally {
        this.#module._free(ptr);
      }
      onProgress?.(offset + size, length);
    }
    return result;
  }

  async eraseFlash() {
    this.#requireConnected();
    await this.#check(await this._eraseFlash(), "Failed to erase flash");
  }

  async eraseRegion(offset, size) {
    this.#requireConnected();
    await this.#check(await this._eraseRegion(offset, size), "Failed to erase flash region");
  }

  /**
   * Toggles the target's reset line. Unlike the other methods, this does
   * NOT require connect() first — it's a raw hardware reset, useful even
   * to just reboot the target without ever starting a flasher session.
   */
  async resetTarget() {
    await this._resetTarget();
  }

  /**
   * Tears down the flasher's internal state. Does NOT close the transport
   * (e.g. the serial port) — the transport is caller-owned, so call its own
   * close()/disconnect() separately if you want to release it too.
   *
   * Safe to call even if connect() was never called or failed (unlike the
   * other methods) — cleanup code shouldn't have to track connection state
   * just to tear down safely.
   */
  disconnect() {
    if (!this.#connected) {
      return;
    }
    this._disconnect();
    this.#connected = false;
  }

  async #withHeapBytes(bytes, callback) {
    const ptr = this.#module._malloc(bytes.length);
    try {
      this.#module.HEAPU8.set(bytes, ptr);
      return await callback(ptr);
    } finally {
      this.#module._free(ptr);
    }
  }

  #requireConnected() {
    if (!this.#connected) {
      throw new EspSerialFlasherError("Not connected — call connect() first");
    }
  }

  #check(code, message) {
    if (code !== EspLoaderErrorCode.SUCCESS) {
      throw new EspSerialFlasherError(message, code);
    }
  }
}

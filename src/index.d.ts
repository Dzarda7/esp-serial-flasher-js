/**
 * Mirrors esp_loader_error_t in esp-serial-flasher/include/esp_loader_error.h.
 * EspSerialFlasherError#code is one of these values.
 */
export const EspLoaderErrorCode: Readonly<{
  SUCCESS: 0;
  FAIL: 1;
  TIMEOUT: 2;
  IMAGE_SIZE: 3;
  INVALID_MD5: 4;
  INVALID_PARAM: 5;
  INVALID_TARGET: 6;
  UNSUPPORTED_CHIP: 7;
  UNSUPPORTED_FUNC: 8;
  INVALID_RESPONSE: 9;
}>;

export type EspLoaderErrorCodeId = (typeof EspLoaderErrorCode)[keyof typeof EspLoaderErrorCode];

export const TargetChip: Readonly<{
  ESP8266: 0;
  ESP32: 1;
  ESP32S2: 2;
  ESP32C3: 3;
  ESP32S3: 4;
  ESP32C2: 5;
  ESP32C5: 6;
  ESP32H2: 7;
  ESP32C6: 8;
  ESP32P4: 9;
  ESP32C61: 10;
  UNKNOWN: 11;
}>;

export type TargetChipId = (typeof TargetChip)[keyof typeof TargetChip];

export const TargetChipName: Readonly<Record<number, string>>;

export interface Logger {
  log?(message: string): void;
  debug?(message: string): void;
  error?(message: string): void;
  warn?(message: string): void;
  info?(message: string): void;
}

export interface SerialTransport {
  write(data: Uint8Array): Promise<void>;
  read(size: number, timeoutMs: number): Promise<Uint8Array | null>;
  setBaudRate?(baudRate: number): Promise<void>;
  setSignals?(signals: {
    dataTerminalReady?: boolean;
    requestToSend?: boolean;
  }): Promise<void>;
  enterBootloader?(): Promise<void>;
  resetTarget?(resetHoldMs?: number): Promise<void>;
  flush?(): Promise<void>;
}

/** Low-level Emscripten-module plumbing; most consumers never need this. */
export interface CreateEspSerialFlasherAdvancedOptions {
  wasmModuleFactory?: (options: Record<string, unknown>) => Promise<unknown>;
  locateFile?: (path: string, prefix: string) => string;
  moduleOptions?: Record<string, unknown>;
}

export interface CreateEspSerialFlasherOptions {
  transport: SerialTransport;
  logger?: Logger;
  advanced?: CreateEspSerialFlasherAdvancedOptions;
}

export interface FlashOptions {
  address: number;
  data: ArrayBuffer | ArrayBufferView;
  blockSize?: number;
  onProgress?: (bytesWritten: number, totalBytes: number) => void;
}

export interface ReadFlashOptions {
  blockSize?: number;
  onProgress?: (bytesRead: number, totalBytes: number) => void;
}

export interface FlashResult {
  bytesWritten: number;
  /** Time spent writing blocks, excluding flash_finish()'s MD5 verification. */
  durationMs: number;
}

export class EspSerialFlasherError extends Error {
  /** One of EspLoaderErrorCode's values, or undefined for JS-side errors (e.g. not connected). */
  readonly code?: EspLoaderErrorCodeId;
  constructor(message: string, code?: EspLoaderErrorCodeId);
}

export class EspSerialFlasher {
  readonly transport: SerialTransport;

  /** True once connect() has succeeded, false before that or after disconnect(). */
  readonly connected: boolean;

  /**
   * Connects to the target and uploads the flasher stub. Must be called
   * before any other method except disconnect() and resetTarget() — every
   * other method throws EspSerialFlasherError if called first.
   */
  connect(): Promise<this>;
  getTarget(): TargetChipId;
  getTargetName(): string;
  changeBaudRate(baudRate: number): Promise<void>;
  detectFlashSize(): Promise<number>;
  readMac(): Promise<Uint8Array>;
  readMacString(): Promise<string>;
  flash(options: FlashOptions): Promise<FlashResult>;
  readFlash(address: number, length: number, options?: ReadFlashOptions): Promise<Uint8Array>;
  eraseFlash(): Promise<void>;
  eraseRegion(offset: number, size: number): Promise<void>;
  /**
   * Toggles the target's reset line. Unlike the other methods, this does
   * NOT require connect() first — it's a raw hardware reset, useful even
   * to just reboot the target without ever starting a flasher session.
   */
  resetTarget(): Promise<void>;
  /**
   * Tears down the flasher's internal state. Does NOT close the transport
   * (e.g. the serial port) — call the transport's own close() separately.
   * Safe to call even if connect() was never called or failed.
   */
  disconnect(): void;
}

export function createEspSerialFlasher(options: CreateEspSerialFlasherOptions): Promise<EspSerialFlasher>;

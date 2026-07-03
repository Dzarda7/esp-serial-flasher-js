import type { SerialTransport } from "./index.js";

export interface WebSerialOpenOptions {
  baudRate?: number;
  dataBits?: number;
  stopBits?: number;
  parity?: "none" | "even" | "odd";
  flowControl?: "none" | "hardware";
}

export class WebSerialTransport implements SerialTransport {
  static requestPort(options?: SerialPortRequestOptions): Promise<WebSerialTransport>;

  readonly port: SerialPort;
  currentBaudRate: number;

  constructor(port: SerialPort);

  open(options?: WebSerialOpenOptions): Promise<void>;
  close(): Promise<void>;
  write(data: Uint8Array): Promise<void>;
  read(size: number, timeoutMs: number): Promise<Uint8Array | null>;
  flush(): Promise<void>;
  setSignals(signals: {
    dataTerminalReady?: boolean;
    requestToSend?: boolean;
  }): Promise<void>;
  enterBootloader(): Promise<void>;
  resetTarget(resetHoldMs?: number): Promise<void>;
  setBaudRate(baudRate: number): Promise<void>;
}

const DEFAULT_OPEN_OPTIONS = {
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: "none",
  flowControl: "none",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class WebSerialTransport {
  static async requestPort(options) {
    if (!globalThis.navigator?.serial) {
      throw new Error("Web Serial API is not available in this environment");
    }
    const port = await navigator.serial.requestPort(options);
    return new WebSerialTransport(port);
  }

  constructor(port) {
    if (!port) {
      throw new TypeError("WebSerialTransport requires a SerialPort");
    }
    this.port = port;
    this.currentBaudRate = DEFAULT_OPEN_OPTIONS.baudRate;
    this.reader = null;
    this.writer = null;
    this.readBuffer = new Uint8Array(0);
    this.writeChain = Promise.resolve();
    this.readWaiters = [];
    this.pumpPromise = null;
  }

  async open(options = {}) {
    const openOptions = { ...DEFAULT_OPEN_OPTIONS, ...options };
    if (!this.port.readable || !this.port.writable) {
      await this.port.open(openOptions);
    }
    this.currentBaudRate = openOptions.baudRate;
    this.readBuffer = new Uint8Array(0);
    await this.setSignals({ dataTerminalReady: false, requestToSend: false });
    this.#startReadPump();
    await this.flush();
  }

  async close() {
    if (this.port.readable || this.port.writable) {
      await this.setSignals({ dataTerminalReady: false, requestToSend: false });
    }
    await this.#releaseWriter(true);
    await this.#stopReadPump();
    if (this.port.readable || this.port.writable) {
      await this.port.close();
    }
    this.readBuffer = new Uint8Array(0);
  }

  async write(data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const result = this.writeChain.catch(() => {}).then(async () => {
      if (!this.writer) {
        this.writer = this.port.writable.getWriter();
      }
      await this.writer.write(bytes);
    });
    this.writeChain = result;
    return result;
  }

  // Reads exactly `size` bytes, waiting up to `timeoutMs` for them to arrive.
  // A timeout here only means "gave up waiting" — it never discards bytes
  // that the device already sent; the background pump (#startReadPump) keeps
  // draining the port independently of any caller's timeout, so bytes that
  // arrive late are still available to the *next* read() call.
  async read(size, timeoutMs) {
    const deadline = Date.now() + timeoutMs;

    while (this.readBuffer.length < size) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        return null;
      }

      const gotData = await this.#waitForData(remainingMs);
      if (!gotData) {
        return null;
      }
    }

    return this.#takeFromReadBuffer(size);
  }

  async flush() {
    this.readBuffer = new Uint8Array(0);
    await sleep(25);
    this.readBuffer = new Uint8Array(0);
  }

  async setSignals(signals) {
    await this.port.setSignals(signals);
  }

  async enterBootloader() {
    await this.setSignals({ dataTerminalReady: false, requestToSend: false });
    await this.flush();
    await this.setSignals({ dataTerminalReady: false, requestToSend: true });
    await sleep(100);
    await this.setSignals({ dataTerminalReady: true, requestToSend: false });
    await sleep(50);
    await this.setSignals({ dataTerminalReady: false, requestToSend: false });
    await sleep(100);
    await this.flush();
  }

  async resetTarget(resetHoldMs = 100) {
    await this.setSignals({ dataTerminalReady: false, requestToSend: true });
    await sleep(resetHoldMs);
    await this.setSignals({ dataTerminalReady: false, requestToSend: false });
  }

  async setBaudRate(baudRate) {
    if (this.currentBaudRate === baudRate) {
      return;
    }

    await this.writeChain.catch(() => {});
    await this.#releaseWriter(false);
    await this.#stopReadPump();
    await this.port.close();
    await this.port.open({ ...DEFAULT_OPEN_OPTIONS, baudRate });
    this.currentBaudRate = baudRate;
    this.readBuffer = new Uint8Array(0);
    this.#startReadPump();
    await sleep(100);
  }

  #startReadPump() {
    this.reader = this.port.readable.getReader();
    this.pumpPromise = this.#pumpLoop(this.reader);
  }

  async #stopReadPump() {
    if (!this.reader) {
      return;
    }
    const reader = this.reader;
    this.reader = null;
    try {
      await reader.cancel();
    } catch (_err) {
      // Ignore cancel errors while tearing down or reconfiguring the port.
    }
    try {
      await this.pumpPromise;
    } catch (_err) {
      // The pump loop only ever rejects because we cancelled it above.
    }
    try {
      reader.releaseLock();
    } catch (_err) {
      // Ignore release errors while tearing down or reconfiguring the port.
    }
    this.pumpPromise = null;
    this.#wakeWaiters();
  }

  // Continuously drains the port into readBuffer for as long as the port is
  // open, independent of individual read() calls and their timeouts. This is
  // what prevents a slow response from causing bytes to be silently dropped.
  async #pumpLoop(reader) {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        if (value && value.length) {
          this.#appendToReadBuffer(value);
          this.#wakeWaiters();
        }
      }
    } catch (_err) {
      // Reader was cancelled (teardown/reconfigure) or the port dropped out;
      // either way there is nothing more to pump.
    }
  }

  #waitForData(timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      const timeoutId = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      }, timeoutMs);
      this.readWaiters.push(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timeoutId);
          resolve(true);
        }
      });
    });
  }

  #wakeWaiters() {
    const waiters = this.readWaiters;
    this.readWaiters = [];
    waiters.forEach((wake) => wake());
  }

  async #releaseWriter(closeWriter) {
    if (!this.writer) {
      return;
    }
    try {
      if (closeWriter) {
        await this.writer.close();
      }
    } catch (_err) {
      // Ignore close errors while tearing down or reconfiguring the port.
    }
    try {
      this.writer.releaseLock();
    } catch (_err) {
      // Ignore release errors while tearing down or reconfiguring the port.
    }
    this.writer = null;
  }

  #appendToReadBuffer(chunk) {
    const nextBuffer = new Uint8Array(this.readBuffer.length + chunk.length);
    nextBuffer.set(this.readBuffer);
    nextBuffer.set(chunk, this.readBuffer.length);
    this.readBuffer = nextBuffer;
  }

  #takeFromReadBuffer(size) {
    const result = this.readBuffer.slice(0, size);
    this.readBuffer = this.readBuffer.slice(size);
    return result;
  }
}

# ESP Serial Flasher JS

A WebAssembly port of [ESP Serial Flasher](https://github.com/espressif/esp-serial-flasher) with a reusable JavaScript API for browser, WebUSB-style, Electron, or custom serial transports.

The package compiles the native C flasher with Emscripten and hides the generated module behind a small async API suitable for npm distribution.

## Features

- Browser-based ESP flashing through Web Serial
- Pluggable serial transport interface for downstream projects
- WebAssembly-backed connect, target detection, MAC read, flash-size detection, read, write, erase, reset, and baud-rate changes
- Typed errors (`EspSerialFlasherError`) with a documented `EspLoaderErrorCode` enum for branching on failure type
- TypeScript declarations for package consumers

## JavaScript API

Build the package artifacts:

```bash
npm run build
```

Use the package from a browser app:

```js
import { createEspSerialFlasher } from "esp-serial-flasher-wasm";
import { WebSerialTransport } from "esp-serial-flasher-wasm/web-serial";

const transport = await WebSerialTransport.requestPort();
await transport.open({ baudRate: 115200 });

const flasher = await createEspSerialFlasher({ transport });

// connect() must be called before any other method (except disconnect()
// and resetTarget(), which work standalone) — everything else throws
// EspSerialFlasherError if the flasher isn't connected yet.
await flasher.connect();
await flasher.changeBaudRate(921600);

const { bytesWritten, durationMs } = await flasher.flash({
  address: 0x10000,
  data: firmwareBytes,
  onProgress(bytesWritten, totalBytes) {
    console.log(bytesWritten, totalBytes);
  },
});
// durationMs times only the write loop, matching how esptool reports
// speed — it excludes flash_finish()'s device-side MD5 verification.
```

Branch on error type using `EspLoaderErrorCode` instead of hardcoding numbers:

```js
import { EspLoaderErrorCode } from "esp-serial-flasher-wasm";

try {
  await flasher.flash({ address: 0x10000, data: firmwareBytes });
} catch (error) {
  if (error.code === EspLoaderErrorCode.TIMEOUT) {
    // offer a retry
  } else if (error.code === EspLoaderErrorCode.INVALID_MD5) {
    // don't retry automatically — the data that arrived doesn't match
  }
}
```

`createEspSerialFlasher()` only needs `transport` (and optionally `logger`) for
normal use. Low-level Emscripten-module plumbing — only needed for custom
bundler setups — lives under a separate `advanced` key so it doesn't clutter
the common case:

```js
const flasher = await createEspSerialFlasher({
  transport,
  advanced: {
    locateFile: (path) => new URL(`./dist/${path}`, import.meta.url).href,
  },
});
```

Custom transports implement this interface:

```ts
interface SerialTransport {
  write(data: Uint8Array): Promise<void>;
  read(size: number, timeoutMs: number): Promise<Uint8Array | null>;
  setBaudRate?(baudRate: number): Promise<void>;
  setSignals?(signals: { dataTerminalReady?: boolean; requestToSend?: boolean }): Promise<void>;
  enterBootloader?(): Promise<void>;
  resetTarget?(resetHoldMs?: number): Promise<void>;
  flush?(): Promise<void>;
}
```

## Development Setup

### Prerequisites

- CMake 3.22 or newer
- Emscripten SDK
- Git
- Node.js/npm
- Python 3 for local testing

### Initialize Submodules

```bash
git submodule update --init --recursive
```

### Setup Emscripten

```bash
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk
./emsdk install latest
./emsdk activate latest
source ./emsdk_env.sh
```

Run `source ./emsdk_env.sh` in each terminal session before building.

### Build

```bash
npm run build
```

This generates:

- `build/main/esp-serial-flasher.js`
- `build/main/esp-serial-flasher.wasm`
- `dist/esp-serial-flasher.js`
- `dist/esp-serial-flasher.wasm`

The flasher library has its own levelled logging (`ESP_LOADER_LOG_ERROR` /
`WARN` / `INFO` / `DEBUG`), routed through the `log`/`log_hex` port callbacks
in `main/wasm_port.c` to `Module.logger` — the same logger you already pass
to `createEspSerialFlasher()`. The verbosity is a compile-time gate
(`SERIAL_FLASHER_LOG_LEVEL` in the root `CMakeLists.txt`, currently `INFO`),
so use the library's own logging instead of adding ad-hoc `console.log`s
when debugging. To get full byte-level TX/RX hex dumps for protocol-level
issues (framing, unexpected disconnects, timeouts), rebuild at `DEBUG`:

```bash
emcmake cmake -S . -B build -DSERIAL_FLASHER_LOG_LEVEL=DEBUG && emmake cmake --build build
npm run copy:wasm
```

`DEBUG` is very verbose (every byte of every transfer); reconfigure with
`-DSERIAL_FLASHER_LOG_LEVEL=INFO` (or omit the flag) to go back to normal.

### Test The Demo

Serve the project root so the demo can import `src/` and `dist/`:

```bash
python3 -m http.server 8000
```

Open `http://localhost:8000/web/`.

The Web Serial API requires HTTPS or localhost. Chrome, Chromium, Edge, and Opera support it.

The demo page exposes: opening/closing the serial port, resetting the target,
detecting flash size, flashing a `.bin` file to an address, reading back a
flash region (downloaded as a `.bin`), and erasing either the whole flash or
a specific region.

## Project Structure

```text
esp-serial-flasher-js/
├── src/                          # THE NPM PACKAGE — what consumers import
│   ├── index.js / index.d.ts               # public API (createEspSerialFlasher, EspSerialFlasher)
│   └── web-serial-transport.js / .d.ts     # the bundled Web Serial transport
├── dist/                         # compiled WASM the package loads (generated, committed)
│   ├── esp-serial-flasher.js
│   └── esp-serial-flasher.wasm
├── web/                          # DEMO app — one example consumer, not shipped
│   ├── index.html
│   └── app.js
├── index.html                    # root redirect to web/ (for GitHub Pages)
├── main/                         # NATIVE GLUE — C↔JS bridge, compiled to dist/
│   ├── CMakeLists.txt
│   └── wasm_port.c
├── esp-serial-flasher/           # the Espressif C library (git submodule)
├── scripts/                      # build helper (copies build output into dist/)
│   └── copy-wasm-artifacts.mjs
├── CMakeLists.txt                # top-level native build config
└── build/                        # native build output (generated, gitignored)
```

In short: **`src/` + `dist/` are the library**, `web/` is just an example that
uses it, and `main/` + `esp-serial-flasher/` + `scripts/` + the CMake files are
the toolchain that produces `dist/`.

## How It Works

1. `main/wasm_port.c` implements the `esp_loader_port_ops_t` callbacks and forwards serial reads, writes, reset, and baud-rate changes to `Module.serialTransport`.
2. `src/index.js` wraps the generated Emscripten module and exposes a stable async API.
3. `src/web-serial-transport.js` is a browser Web Serial transport implementation.
4. `web/app.js` is a small consumer of the package API.

## Known Quirks

- **On Linux, ModemManager can wedge the port after close+reopen.** If
  connecting works the first time but every subsequent close-then-reopen of
  the same port times out with zero bytes ever received (until you
  physically unplug and replug the adapter), this is not a bug in this
  project — ModemManager auto-probes serial devices and can grab/reset the
  port's state at the driver level, invisibly to the browser's Web Serial
  API. No amount of JS-side delay or signal sequencing works around it,
  since it happens below the browser entirely. This is not specific to this
  project either — esptool-js hits the exact same issue on the same
  affected machines, confirming it's an environment/driver problem, not
  something either implementation can fix from JS. Fix it with a udev rule
  so ModemManager ignores the device's vendor/product ID:
  ```
  SUBSYSTEM=="tty", ATTRS{idVendor}=="1a86", ATTRS{idProduct}=="7523", ENV{ID_MM_DEVICE_IGNORE}="1"
  ```
  (adjust the IDs to match `lsusb`'s output for your adapter), then
  `sudo udevadm control --reload-rules && sudo udevadm trigger` and replug
  the device once.

## Related Projects

- [ESP Serial Flasher](https://github.com/espressif/esp-serial-flasher)
- [Emscripten](https://emscripten.org/)
- [Web Serial API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API)

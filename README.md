# ESP Serial Flasher JS

A WebAssembly port of the [ESP Serial Flasher](https://github.com/espressif/esp-serial-flasher) library that enables flashing Espressif SoCs directly from a web browser using the Web Serial API.

This project compiles the ESP Serial Flasher C library to WebAssembly using Emscripten, providing a JavaScript interface that allows web applications to communicate with Espressif SoCs over serial ports for firmware flashing, chip detection, and other operations.

## Features

- 🌐 **Browser-based flashing** - No installation required, flash Espressif SoCs directly from your browser
- 🔌 **Web Serial API** - Uses modern browser capabilities to communicate with serial devices
- ⚡ **Full flasher capabilities** - Supports chip detection, firmware flashing, flash size detection, and more
- 🎯 **Multiple chip support** - Compatible with various ESP32 and ESP8266 variants
- 🔧 **WebAssembly powered** - Leverages the native ESP Serial Flasher library for reliable flashing

## Quick Start (Testing)

For a quick test without building, you can use Python's built-in web server:

```bash
cd web
python3 -m http.server 8000
```

Then open your browser and navigate to `http://localhost:8000`. The web application should load with pre-built WASM files.

> **Note:** The Web Serial API requires HTTPS or localhost. Modern browsers (Chrome, Edge, Opera) support this API.

## Development Setup

To make changes and rebuild the project, follow these steps:

### Prerequisites

- **CMake** (version 3.16 or later)
- **Emscripten SDK** (for compiling to WebAssembly)
- **Git** (for cloning submodules)
- **Python 3** (for local testing)

### 1. Initialize the Submodule

The ESP Serial Flasher library is included as a git submodule. Initialize it first:

```bash
git submodule update --init --recursive
```

### 2. Install and Setup Emscripten

Download and install the Emscripten SDK:

```bash
# Clone the Emscripten SDK
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk

# Download and install the latest SDK tools
./emsdk install latest

# Activate the SDK in your environment
./emsdk activate latest

# Source the environment variables (do this in every new terminal session)
source ./emsdk_env.sh
```

> **Important:** You need to run `source ./emsdk_env.sh` in every new terminal session where you want to build the project.

### 3. Build the Project

```bash
# Create a build directory
mkdir -p build
cd build

# Configure with CMake using Emscripten
emcmake cmake ..

# Build
emmake make
```

This will generate:
- `build/main/mylib.js` - JavaScript glue code
- `build/main/mylib.wasm` - WebAssembly binary

### 4. Copy Build Artifacts to Web Directory

After building, copy the generated files to the web directory:

```bash
# From the build directory
cp main/mylib.js ../web/
cp main/mylib.wasm ../web/
```

Or from the project root:

```bash
cp build/main/mylib.js web/
cp build/main/mylib.wasm web/
```

### 5. Test Your Changes

Start a local web server:

```bash
cd web
python3 -m http.server 8000
```

Open `http://localhost:8000` in your browser and test the functionality.

## Project Structure

```
esp-serial-flasher-js/
├── CMakeLists.txt              # Root CMake configuration
├── main/
│   ├── CMakeLists.txt          # WASM target configuration
│   └── wasm_port.c             # WebAssembly port implementation
├── web/
│   ├── index.html              # Web interface
│   ├── app.js                  # JavaScript application logic
│   ├── mylib.js                # Generated WASM glue code
│   └── mylib.wasm              # Generated WebAssembly binary
├── esp-serial-flasher/         # ESP Serial Flasher library (submodule)
└── build/                      # Build artifacts (generated)
```

## How It Works

1. **WASM Port (`main/wasm_port.c`)** - Implements the platform-specific functions required by the ESP Serial Flasher library, bridging C calls to JavaScript Web Serial API calls using Emscripten's `EM_JS` and `EM_ASYNC_JS` macros.

2. **Web Interface (`web/app.js`)** - Provides the user interface for selecting serial ports, loading firmware files, and triggering flash operations. Communicates with the WASM module through exported functions.

3. **Build System** - Uses CMake with Emscripten to compile the C code to WebAssembly, handling all necessary flags and linking.

## Browser Compatibility

The Web Serial API is required for this application to work. Currently supported browsers:

- ✅ Chrome/Chromium (version 89+)
- ✅ Edge (version 89+)
- ✅ Opera (version 75+)
- ❌ Firefox (not yet supported)
- ❌ Safari (not yet supported)

## Configuration

You can adjust the build configuration in `CMakeLists.txt`:

- **Exported functions**: Modify the `EXPORTED_FUNCTIONS` list in `main/CMakeLists.txt` to expose additional functions to JavaScript

## Related Projects

- [ESP Serial Flasher](https://github.com/espressif/esp-serial-flasher) - The core library this project is based on
- [Emscripten](https://emscripten.org/) - The toolchain used to compile C to WebAssembly
- [Web Serial API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API) - Browser API for serial communication


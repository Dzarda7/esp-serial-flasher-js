import { createEspSerialFlasher } from "../src/index.js";
import { WebSerialTransport } from "../src/web-serial-transport.js";

let transport = null;
let flasher = null;

function log(msg) {
  const output = document.getElementById("output");
  output.textContent += msg + "\n";
  output.scrollTop = output.scrollHeight;
  console.log(msg);
}

function parseAddress(value) {
  const trimmed = value.trim();
  const address = trimmed.toLowerCase().startsWith("0x")
    ? Number.parseInt(trimmed, 16)
    : Number.parseInt(trimmed, 10);

  if (!Number.isFinite(address) || address < 0) {
    throw new Error(`Invalid address: ${value}`);
  }

  return address;
}

// The C library shares a single ~1s timeout across sending a block *and*
// waiting for its ack. At low baud rates a full-size block alone can take
// longer than that to transmit, causing spurious timeouts/retries. Shrink
// the block size at low baud rates so a block reliably fits the timeout.
function blockSizeForBaud(baudRate) {
  if (baudRate <= 115200) {
    return 0x1000;
  }
  return 0x4000;
}

function updateProgress(percent, text) {
  const progressContainer = document.getElementById("progressContainer");
  const progressFill = document.getElementById("progressFill");
  const progressText = document.getElementById("progressText");

  progressContainer.style.display = "block";
  progressFill.style.width = `${percent}%`;
  progressText.textContent = text || `${percent.toFixed(1)}%`;
}

function hideProgress() {
  document.getElementById("progressContainer").style.display = "none";
  document.getElementById("progressFill").style.width = "0%";
}

function setConnectedUi(connected) {
  document.getElementById("serialBtn").textContent = connected ? "Close Serial Port" : "Open Serial Port";
  document.getElementById("serialBtn").style.background = connected ? "#dc3545" : "#007bff";
  document.getElementById("detectFlashBtn").disabled = !connected;
  document.getElementById("resetBtn").disabled = !connected;
  document.getElementById("binFile").disabled = !connected;
  document.getElementById("flashAddress").disabled = !connected;
  document.getElementById("baudRate").disabled = connected;
  document.getElementById("flashBtn").disabled =
    !connected || document.getElementById("binFile").files.length === 0;
  document.getElementById("readAddress").disabled = !connected;
  document.getElementById("readLength").disabled = !connected;
  document.getElementById("readFlashBtn").disabled = !connected;
  document.getElementById("eraseAllBtn").disabled = !connected;
  document.getElementById("eraseAddress").disabled = !connected;
  document.getElementById("eraseSize").disabled = !connected;
  document.getElementById("eraseRegionBtn").disabled = !connected;
}

function updateReadProgress(percent, text) {
  const progressContainer = document.getElementById("readProgressContainer");
  const progressFill = document.getElementById("readProgressFill");
  const progressText = document.getElementById("readProgressText");

  progressContainer.style.display = "block";
  progressFill.style.width = `${percent}%`;
  progressText.textContent = text || `${percent.toFixed(1)}%`;
}

function hideReadProgress() {
  document.getElementById("readProgressContainer").style.display = "none";
  document.getElementById("readProgressFill").style.width = "0%";
}

function downloadBytes(bytes, filename) {
  const blob = new Blob([bytes], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function ensureConnectedToLoader() {
  await transport.flush();
  await flasher.connect();

  try {
    log(`[OK] MAC address: ${await flasher.readMacString()}`);
  } catch (error) {
    log(`[WARN] Could not read MAC address: ${error.message}`);
  }

  const selectedBaud = Number.parseInt(document.getElementById("baudRate").value, 10);
  if (selectedBaud !== 115200) {
    log(`[PORT] Changing baud rate to ${selectedBaud}`);
    await flasher.changeBaudRate(selectedBaud);
  }
}

async function openSerialPort() {
  transport = await WebSerialTransport.requestPort();
  await transport.open({ baudRate: 115200 });

  flasher = await createEspSerialFlasher({
    transport,
    logger: {
      log,
      debug: log,
      error: log,
    },
    advanced: {
      locateFile: (path) => new URL(`../dist/${path}`, import.meta.url).href,
    },
  });

  log("[OK] Serial port opened at 115200 baud");
}

async function closeSerialPort() {
  try {
    flasher?.disconnect();
  } finally {
    await transport?.close();
    flasher = null;
    transport = null;
  }
  log("[OK] Serial port closed");
}

document.getElementById("serialBtn").addEventListener("click", async function () {
  this.disabled = true;
  try {
    if (transport) {
      await closeSerialPort();
      setConnectedUi(false);
    } else {
      await openSerialPort();
      setConnectedUi(true);
    }
  } catch (error) {
    log(`[ERROR] ${error.message || error}`);
    console.error(error);
  } finally {
    this.disabled = false;
  }
});

document.getElementById("detectFlashBtn").addEventListener("click", async function () {
  this.disabled = true;
  try {
    await ensureConnectedToLoader();
    const flashSize = await flasher.detectFlashSize();
    const flashSizeMb = (flashSize / (1024 * 1024)).toFixed(2);
    log(`[OK] Flash size: ${flashSize} bytes (${flashSizeMb} MB)`);
  } catch (error) {
    log(`[ERROR] ${error.message || error}`);
    console.error(error);
  } finally {
    this.disabled = false;
  }
});

document.getElementById("resetBtn").addEventListener("click", async function () {
  this.disabled = true;
  try {
    await flasher.resetTarget();
    log("[OK] Target reset");
  } catch (error) {
    log(`[ERROR] ${error.message || error}`);
    console.error(error);
  } finally {
    this.disabled = false;
  }
});

document.getElementById("readFlashBtn").addEventListener("click", async function () {
  const addressInput = document.getElementById("readAddress");
  const lengthInput = document.getElementById("readLength");

  const controls = [
    document.getElementById("serialBtn"),
    document.getElementById("detectFlashBtn"),
    document.getElementById("resetBtn"),
    document.getElementById("readFlashBtn"),
    addressInput,
    lengthInput,
  ];

  controls.forEach((control) => {
    control.disabled = true;
  });

  try {
    const address = parseAddress(addressInput.value);
    const length = parseAddress(lengthInput.value);

    log(`[INFO] Reading ${length} bytes from 0x${address.toString(16)}`);
    await ensureConnectedToLoader();
    const data = await flasher.readFlash(address, length, {
      onProgress(bytesRead, totalBytes) {
        const percent = (bytesRead / totalBytes) * 100;
        updateReadProgress(percent, `${percent.toFixed(1)}% (${bytesRead}/${totalBytes} bytes)`);
      },
    });

    updateReadProgress(100, "100% - Complete!");
    downloadBytes(data, `flash_0x${address.toString(16)}_${length}.bin`);
    log(`[OK] Read ${data.length} bytes, download started`);
  } catch (error) {
    hideReadProgress();
    log(`[ERROR] ${error.message || error}`);
    console.error(error);
  } finally {
    controls.forEach((control) => {
      control.disabled = false;
    });
    setConnectedUi(Boolean(transport));
  }
});

document.getElementById("eraseAllBtn").addEventListener("click", async function () {
  this.disabled = true;
  try {
    await ensureConnectedToLoader();
    log("[INFO] Erasing entire flash, this may take a while...");
    await flasher.eraseFlash();
    log("[OK] Flash erased");
  } catch (error) {
    log(`[ERROR] ${error.message || error}`);
    console.error(error);
  } finally {
    this.disabled = false;
  }
});

document.getElementById("eraseRegionBtn").addEventListener("click", async function () {
  const addressInput = document.getElementById("eraseAddress");
  const sizeInput = document.getElementById("eraseSize");
  this.disabled = true;
  try {
    const address = parseAddress(addressInput.value);
    const size = parseAddress(sizeInput.value);
    await ensureConnectedToLoader();
    await flasher.eraseRegion(address, size);
    log("[OK] Region erased");
  } catch (error) {
    log(`[ERROR] ${error.message || error}`);
    console.error(error);
  } finally {
    this.disabled = false;
  }
});

document.getElementById("binFile").addEventListener("change", function () {
  document.getElementById("flashBtn").disabled = !transport || this.files.length === 0;
  if (this.files.length > 0) {
    const file = this.files[0];
    log(`[INFO] Selected file: ${file.name} (${file.size} bytes)`);
  }
});

document.getElementById("flashBtn").addEventListener("click", async function () {
  const fileInput = document.getElementById("binFile");
  const addressInput = document.getElementById("flashAddress");

  if (fileInput.files.length === 0) {
    log("[ERROR] No file selected");
    return;
  }

  const controls = [
    document.getElementById("serialBtn"),
    document.getElementById("detectFlashBtn"),
    document.getElementById("flashBtn"),
    fileInput,
    addressInput,
  ];

  controls.forEach((control) => {
    control.disabled = true;
  });

  try {
    const file = fileInput.files[0];
    const address = parseAddress(addressInput.value);
    const data = new Uint8Array(await file.arrayBuffer());

    log(`[INFO] Flashing ${file.name}`);
    await ensureConnectedToLoader();
    const selectedBaud = Number.parseInt(document.getElementById("baudRate").value, 10);
    const blockSize = blockSizeForBaud(selectedBaud);
    log(`[INFO] Using block size 0x${blockSize.toString(16)} for ${selectedBaud} baud`);
    const result = await flasher.flash({
      address,
      data,
      blockSize,
      onProgress(bytesWritten, totalBytes) {
        const percent = (bytesWritten / totalBytes) * 100;
        updateProgress(percent, `${percent.toFixed(1)}% (${bytesWritten}/${totalBytes} bytes)`);
      },
    });

    updateProgress(100, "100% - Complete!");
    // Matches esptool's "Wrote ... in ... seconds (effective ... kbit/s)" line;
    // result.durationMs already excludes the MD5 verification that just ran.
    const seconds = result.durationMs / 1000;
    const kbitPerSec = seconds > 0 ? (result.bytesWritten * 8) / 1000 / seconds : 0;
    log(
      `[OK] Wrote ${result.bytesWritten} bytes at 0x${address.toString(16)} in ${seconds.toFixed(1)} seconds ` +
        `(effective ${kbitPerSec.toFixed(1)} kbit/s)`
    );
    log("[OK] Flash operation completed successfully");

    // esptool hard-resets the target by default after writing flash — the
    // stub loader stays running in RAM otherwise, and the port simply
    // closing does not reset the chip, so it never boots into the app.
    await flasher.resetTarget();
    log("[OK] Target reset — booting application");
  } catch (error) {
    hideProgress();
    log(`[ERROR] ${error.message || error}`);
    console.error(error);
  } finally {
    controls.forEach((control) => {
      control.disabled = false;
    });
    setConnectedUi(Boolean(transport));
  }
});

document.getElementById("output").textContent = "";
document.getElementById("serialBtn").disabled = false;
log("[OK] JavaScript API loaded");

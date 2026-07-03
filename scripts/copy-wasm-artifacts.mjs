import { copyFile, mkdir } from "node:fs/promises";

await mkdir("dist", { recursive: true });

await Promise.all([
  copyFile("build/main/esp-serial-flasher.js", "dist/esp-serial-flasher.js"),
  copyFile("build/main/esp-serial-flasher.wasm", "dist/esp-serial-flasher.wasm"),
]);

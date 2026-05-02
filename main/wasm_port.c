#include <stdint.h>
#include <stdbool.h>
#include <stdio.h>
#include <stddef.h>
#include "esp_loader_io.h"
#include "esp_loader.h"
#include <emscripten.h>

// ---------------------------------------------------------------------------
// WASM port struct — embeds esp_loader_port_t as first member
// ---------------------------------------------------------------------------

typedef struct {
    esp_loader_port_t port;  // must be first
    uint32_t          _time_end;
    uint32_t          _baud_rate;
} wasm_port_t;

// Static instances shared across JS wrapper calls (WASM is single-threaded)
static wasm_port_t           g_port;
static esp_loader_t          g_loader;
static esp_loader_flash_cfg_t g_flash_cfg;

// ---------------------------------------------------------------------------
// JS bridge functions
// ---------------------------------------------------------------------------

#if SERIAL_FLASHER_DEBUG_TRACE
static void transfer_debug_print(const uint8_t *data, uint16_t size, bool write)
{
    static bool write_prev = false;
    if (write_prev != write) {
        write_prev = write;
        loader_port_debug_print(write ? "\n--- WRITE ---" : "\n--- READ ---");
    }
    char hex_line[16 * 3 + 1];
    uint16_t line_pos = 0;
    for (uint16_t i = 0; i < size; i++) {
        char hex_byte[4];
        snprintf(hex_byte, sizeof(hex_byte), "%02x ", data[i]);
        for (int j = 0; hex_byte[j] != '\0' && line_pos < sizeof(hex_line) - 1; j++) {
            hex_line[line_pos++] = hex_byte[j];
        }
        if ((i + 1) % 16 == 0 || i == size - 1) {
            hex_line[line_pos] = '\0';
            g_port.port.ops->debug_print(&g_port.port, hex_line);
            line_pos = 0;
        }
    }
}
#endif

EM_JS(void, js_init_serial_buffer, (), {
    if (typeof Module.serialBuffer === 'undefined') {
        Module.serialBuffer = new Uint8Array(0);
    }
});

EM_ASYNC_JS(int, js_serial_write, (const uint8_t *data, uint16_t size), {
    if (!window.serialPort || !window.serialPort.port || !window.serialPort.port.writable) {
        console.error('[ERROR] Serial port not open or not writable');
        return -1;
    }
    try {
        let dataArray = new Uint8Array(size);
        for (let i = 0; i < size; i++) {
            dataArray[i] = HEAPU8[data + i];
        }
        const writer = window.serialPort.port.writable.getWriter();
        await writer.write(dataArray);
        writer.releaseLock();
        return 0;
    } catch (error) {
        console.error('[ERROR] Serial write failed:', error);
        if (typeof log === 'function') {
            log('[ERROR] Serial write failed: ' + error.message);
        }
        return -1;
    }
});

EM_ASYNC_JS(int, js_serial_read, (uint8_t *data, uint16_t size, uint32_t timeout_ms), {
    if (!window.serialPort || !window.serialPort.port || !window.serialPort.port.readable) {
        console.error('[ERROR] Serial port not open or not readable');
        return -1;
    }
    try {
        if (typeof Module.serialBuffer === 'undefined') {
            Module.serialBuffer = new Uint8Array(0);
        }
        const startTime = Date.now();
        while (Module.serialBuffer.length < size) {
            const elapsed = Date.now() - startTime;
            if (elapsed >= timeout_ms) {
                console.log('[RX] Timeout: requested ' + size + ' bytes, got ' + Module.serialBuffer.length + ' bytes');
                return -2;
            }
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        for (let i = 0; i < size; i++) {
            HEAPU8[data + i] = Module.serialBuffer[i];
        }
        Module.serialBuffer = Module.serialBuffer.slice(size);
        return 0;
    } catch (error) {
        console.error('[ERROR] Serial read failed:', error);
        if (typeof log === 'function') {
            log('[ERROR] Serial read failed: ' + error.message);
        }
        return -1;
    }
});

EM_ASYNC_JS(void, js_serial_enter_bootloader, (void), {
    if (!window.serialPort || !window.serialPort.port) {
        console.error('[ERROR] Serial port not open');
        return;
    }
    try {
        if (typeof log === 'function') {
            log('[JS] Entering bootloader mode (DTR/RTS sequence)');
        }

        // Always specify both signals together so no implementation can silently
        // reset the unspecified one to its default between calls.

        // Step 1: Assert reset — EN LOW, IO0 HIGH
        await window.serialPort.port.setSignals({ dataTerminalReady: false, requestToSend: true });
        await new Promise(resolve => setTimeout(resolve, 100));

        // Step 2: Release reset — EN HIGH, IO0 LOW → chip boots into bootloader
        await window.serialPort.port.setSignals({ dataTerminalReady: true, requestToSend: false });
        await new Promise(resolve => setTimeout(resolve, 50));

        // Step 3: Release IO0
        await window.serialPort.port.setSignals({ dataTerminalReady: false, requestToSend: false });

        // Discard any bytes the bootloader printed during startup
        await new Promise(resolve => setTimeout(resolve, 100));
        Module.serialBuffer = new Uint8Array(0);

        if (typeof log === 'function') {
            log('[JS] Bootloader entry sequence completed');
        }
    } catch (error) {
        console.error('[ERROR] Failed to enter bootloader:', error);
        if (typeof log === 'function') {
            log('[ERROR] Failed to enter bootloader: ' + error.message);
        }
    }
});

EM_ASYNC_JS(void, js_serial_reset_target, (uint32_t reset_hold_ms), {
    if (!window.serialPort || !window.serialPort.port) {
        console.error('[ERROR] Serial port not open');
        return;
    }
    try {
        if (typeof log === 'function') {
            log('[PORT] Resetting target');
        }
        await window.serialPort.port.setSignals({ dataTerminalReady: true, requestToSend: true });
        await new Promise(resolve => setTimeout(resolve, reset_hold_ms));
        await window.serialPort.port.setSignals({ dataTerminalReady: true, requestToSend: false });
    } catch (error) {
        console.error('[ERROR] Failed to reset target:', error);
        if (typeof log === 'function') {
            log('[ERROR] Failed to reset target: ' + error.message);
        }
    }
});

EM_ASYNC_JS(void, js_delay_ms, (uint32_t ms), {
    await new Promise(resolve => setTimeout(resolve, ms));
});

EM_ASYNC_JS(void, js_debug_print, (const char *str), {
    let message = UTF8ToString(str);
    if (typeof log === 'function') {
        log(message);
    }
});

EM_ASYNC_JS(int, js_change_baud_rate, (uint32_t new_baud), {
    try {
        if (typeof log === 'function') {
            log('[PORT] Changing baud rate to ' + new_baud);
        }

        // Stop background reader
        window.serialPort.backgroundReading = false;
        if (window.serialPort.reader) {
            try { await window.serialPort.reader.cancel(); } catch (e) {}
            window.serialPort.reader = null;
        }

        // Wait for streams to unlock
        let attempts = 0;
        while ((window.serialPort.port.readable?.locked || window.serialPort.port.writable?.locked) && attempts < 20) {
            await new Promise(resolve => setTimeout(resolve, 50));
            attempts++;
        }

        await window.serialPort.port.close();

        await window.serialPort.port.open({
            baudRate: new_baud,
            dataBits: 8,
            stopBits: 1,
            parity: "none",
            flowControl: "none"
        });

        // Clear buffer and restart background reader
        Module.serialBuffer = new Uint8Array(0);
        startBackgroundSerialReader();

        if (typeof log === 'function') {
            log('[PORT] Baud rate changed to ' + new_baud);
        }
        return 0;
    } catch (error) {
        console.error('[ERROR] Baud rate change failed:', error);
        if (typeof log === 'function') {
            log('[ERROR] Baud rate change failed: ' + error.message);
        }
        return 1;
    }
});

// ---------------------------------------------------------------------------
// Port vtable callbacks — all receive esp_loader_port_t *port as first arg
// ---------------------------------------------------------------------------

static esp_loader_error_t wasm_write(esp_loader_port_t *port,
                                     const uint8_t *data, uint16_t size, uint32_t timeout)
{
    (void)port;
    (void)timeout;
    static bool initialized = false;
    if (!initialized) {
        js_init_serial_buffer();
        initialized = true;
    }
    int result = js_serial_write(data, size);
    if (result == 0) {
#if SERIAL_FLASHER_DEBUG_TRACE
        transfer_debug_print(data, size, true);
#endif
        return ESP_LOADER_SUCCESS;
    }
    return ESP_LOADER_ERROR_FAIL;
}

static esp_loader_error_t wasm_read(esp_loader_port_t *port,
                                    uint8_t *data, uint16_t size, uint32_t timeout)
{
    (void)port;
    static bool initialized = false;
    if (!initialized) {
        js_init_serial_buffer();
        initialized = true;
    }
    int result = js_serial_read(data, size, timeout);
    if (result == 0) {
#if SERIAL_FLASHER_DEBUG_TRACE
        transfer_debug_print(data, size, false);
#endif
        return ESP_LOADER_SUCCESS;
    } else if (result == -2) {
        return ESP_LOADER_ERROR_TIMEOUT;
    }
    return ESP_LOADER_ERROR_FAIL;
}

static void wasm_enter_bootloader(esp_loader_port_t *port)
{
    (void)port;
    js_serial_enter_bootloader();
}

static void wasm_reset_target(esp_loader_port_t *port)
{
    (void)port;
    js_serial_reset_target(SERIAL_FLASHER_RESET_HOLD_TIME_MS);
}

static void wasm_delay_ms(esp_loader_port_t *port, uint32_t ms)
{
    (void)port;
    js_delay_ms(ms);
}

static void wasm_start_timer(esp_loader_port_t *port, uint32_t ms)
{
    wasm_port_t *p = container_of(port, wasm_port_t, port);
    // Store deadline as approximate value; JS timing via remaining_time
    p->_time_end = ms;  // we'll track via JS Date in remaining_time below
    // Use a simple JS variable to track the deadline
    EM_ASM({ Module._timerEnd = Date.now() + $0; }, ms);
}

static uint32_t wasm_remaining_time(esp_loader_port_t *port)
{
    (void)port;
    int32_t remaining = EM_ASM_INT({
        if (typeof Module._timerEnd === 'undefined') return 0;
        let r = Module._timerEnd - Date.now();
        return r > 0 ? r : 0;
    });
    return (uint32_t)remaining;
}

static void wasm_debug_print(esp_loader_port_t *port, const char *str)
{
    (void)port;
    js_debug_print(str);
}

static esp_loader_error_t wasm_change_transmission_rate(esp_loader_port_t *port, uint32_t rate)
{
    wasm_port_t *p = container_of(port, wasm_port_t, port);
    int result = js_change_baud_rate(rate);
    if (result == 0) {
        p->_baud_rate = rate;
        return ESP_LOADER_SUCCESS;
    }
    return ESP_LOADER_ERROR_FAIL;
}

static const esp_loader_port_ops_t wasm_ops = {
    .init                     = NULL,
    .deinit                   = NULL,
    .enter_bootloader         = wasm_enter_bootloader,
    .reset_target             = wasm_reset_target,
    .start_timer              = wasm_start_timer,
    .remaining_time           = wasm_remaining_time,
    .delay_ms                 = wasm_delay_ms,
    .debug_print              = wasm_debug_print,
    .change_transmission_rate = wasm_change_transmission_rate,
    .write                    = wasm_write,
    .read                     = wasm_read,
    .spi_set_cs               = NULL,
    .sdio_write               = NULL,
    .sdio_read                = NULL,
    .sdio_card_init           = NULL,
};

// ---------------------------------------------------------------------------
// JS-callable wrappers (simple C signatures for Emscripten cwrap)
// ---------------------------------------------------------------------------

int flasher_connect(void)
{
    // If a previous session raised the baud rate, drop back to 115200 first —
    // the ROM bootloader only speaks 115200.
    if (g_port._baud_rate != 115200) {
        js_change_baud_rate(115200);
    }
    g_port.port.ops   = &wasm_ops;
    g_port._baud_rate = 115200;
    esp_loader_init_uart(&g_loader, &g_port.port);
    esp_loader_connect_args_t connect_args = ESP_LOADER_CONNECT_DEFAULT();
    return esp_loader_connect_with_stub(&g_loader, &connect_args);
}

int flasher_change_baudrate(uint32_t new_baud)
{
    return esp_loader_change_transmission_rate_stub(&g_loader, g_port._baud_rate, new_baud);
}

int flasher_flash_detect_size(uint32_t *flash_size)
{
    return esp_loader_flash_detect_size(&g_loader, flash_size);
}

int flasher_flash_start(uint32_t offset, uint32_t image_size, uint32_t block_size)
{
    g_flash_cfg.offset      = offset;
    g_flash_cfg.image_size  = image_size;
    g_flash_cfg.block_size  = block_size;
    g_flash_cfg.skip_verify = false;
    return esp_loader_flash_start(&g_loader, &g_flash_cfg);
}

int flasher_flash_write(void *payload, uint32_t size)
{
    return esp_loader_flash_write(&g_loader, &g_flash_cfg, payload, size);
}

int flasher_flash_finish(void)
{
    return esp_loader_flash_finish(&g_loader, &g_flash_cfg);
}

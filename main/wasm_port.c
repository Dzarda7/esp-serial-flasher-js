#include <stdint.h>
#include <stdbool.h>
#include <stdio.h>
#include <stddef.h>
#include <stdarg.h>
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
static wasm_port_t           g_port = {
    ._baud_rate = 115200,
};
static esp_loader_t          g_loader;
static esp_loader_flash_cfg_t g_flash_cfg;
static esp_loader_flash_deflate_cfg_t g_flash_deflate_cfg;

// ---------------------------------------------------------------------------
// JS bridge functions
// ---------------------------------------------------------------------------

EM_JS(void, js_init_serial_buffer, (), {
    Module.serialTransportBuffer = Module.serialTransportBuffer || new Uint8Array(0);
});

EM_ASYNC_JS(int, js_serial_write, (const uint8_t *data, uint16_t size), {
    if (!Module.serialTransport || typeof Module.serialTransport.write !== 'function') {
        console.error('[ERROR] Serial transport write() is not configured');
        return -1;
    }
    try {
        let dataArray = new Uint8Array(size);
        for (let i = 0; i < size; i++) {
            dataArray[i] = HEAPU8[data + i];
        }
        await Module.serialTransport.write(dataArray);
        return 0;
    } catch (error) {
        console.error('[ERROR] Serial write failed:', error);
        if (Module.logger && typeof Module.logger.error === 'function') {
            Module.logger.error('[ERROR] Serial write failed: ' + error.message);
        }
        return -1;
    }
});

EM_ASYNC_JS(int, js_serial_read, (uint8_t *data, uint16_t size, uint32_t timeout_ms), {
    if (!Module.serialTransport || typeof Module.serialTransport.read !== 'function') {
        console.error('[ERROR] Serial transport read() is not configured');
        return -1;
    }
    try {
        const bytes = await Module.serialTransport.read(size, timeout_ms);
        if (!bytes || bytes.length < size) {
            return -2;
        }
        for (let i = 0; i < size; i++) {
            HEAPU8[data + i] = bytes[i];
        }
        return 0;
    } catch (error) {
        console.error('[ERROR] Serial read failed:', error);
        if (Module.logger && typeof Module.logger.error === 'function') {
            Module.logger.error('[ERROR] Serial read failed: ' + error.message);
        }
        return -1;
    }
});

EM_ASYNC_JS(void, js_serial_enter_bootloader, (void), {
    if (!Module.serialTransport) {
        console.error('[ERROR] Serial transport is not configured');
        return;
    }
    try {
        if (Module.logger && typeof Module.logger.debug === 'function') {
            Module.logger.debug('[JS] Entering bootloader mode');
        }
        if (typeof Module.serialTransport.enterBootloader === 'function') {
            await Module.serialTransport.enterBootloader();
            return;
        }
        if (typeof Module.serialTransport.setSignals !== 'function') {
            throw new Error('Serial transport setSignals() is not available');
        }

        // Always specify both signals together so no implementation can silently
        // reset the unspecified one to its default between calls.

        // Step 0: Release both lines first. Some tools leave DTR/RTS asserted,
        // and starting from a known state makes the following edges reliable.
        await Module.serialTransport.setSignals({ dataTerminalReady: false, requestToSend: false });
        if (typeof Module.serialTransport.flush === 'function') {
            await Module.serialTransport.flush();
        }

        // Step 1: Assert reset — EN LOW, IO0 HIGH
        await Module.serialTransport.setSignals({ dataTerminalReady: false, requestToSend: true });
        await new Promise(resolve => setTimeout(resolve, 100));

        // Step 2: Release reset — EN HIGH, IO0 LOW → chip boots into bootloader
        await Module.serialTransport.setSignals({ dataTerminalReady: true, requestToSend: false });
        await new Promise(resolve => setTimeout(resolve, 50));

        // Step 3: Release IO0
        await Module.serialTransport.setSignals({ dataTerminalReady: false, requestToSend: false });

        // Discard any bytes the bootloader printed during startup
        await new Promise(resolve => setTimeout(resolve, 100));
        if (typeof Module.serialTransport.flush === 'function') {
            await Module.serialTransport.flush();
        }

        if (Module.logger && typeof Module.logger.debug === 'function') {
            Module.logger.debug('[JS] Bootloader entry sequence completed');
        }
    } catch (error) {
        console.error('[ERROR] Failed to enter bootloader:', error);
        if (Module.logger && typeof Module.logger.error === 'function') {
            Module.logger.error('[ERROR] Failed to enter bootloader: ' + error.message);
        }
    }
});

EM_ASYNC_JS(void, js_serial_reset_target, (uint32_t reset_hold_ms), {
    if (!Module.serialTransport) {
        console.error('[ERROR] Serial transport is not configured');
        return;
    }
    try {
        if (Module.logger && typeof Module.logger.debug === 'function') {
            Module.logger.debug('[PORT] Resetting target');
        }
        if (typeof Module.serialTransport.resetTarget === 'function') {
            await Module.serialTransport.resetTarget(reset_hold_ms);
            return;
        }
        if (typeof Module.serialTransport.setSignals !== 'function') {
            throw new Error('Serial transport setSignals() is not available');
        }
        await Module.serialTransport.setSignals({ dataTerminalReady: false, requestToSend: true });
        await new Promise(resolve => setTimeout(resolve, reset_hold_ms));
        await Module.serialTransport.setSignals({ dataTerminalReady: false, requestToSend: false });
    } catch (error) {
        console.error('[ERROR] Failed to reset target:', error);
        if (Module.logger && typeof Module.logger.error === 'function') {
            Module.logger.error('[ERROR] Failed to reset target: ' + error.message);
        }
    }
});

EM_ASYNC_JS(void, js_delay_ms, (uint32_t ms), {
    await new Promise(resolve => setTimeout(resolve, ms));
});

// level matches esp_loader_log_level_t: 1=ERROR, 2=WARN, 3=INFO, 4=DEBUG
EM_JS(void, js_log_message, (int level, const char *str), {
    const message = UTF8ToString(str);
    const logger = Module.logger;
    if (!logger) {
        return;
    }
    const method = level === 1 ? logger.error
        : level === 2 ? (logger.warn || logger.log)
        : level === 3 ? (logger.info || logger.log)
        : (logger.debug || logger.log);
    method?.call(logger, message);
});

EM_ASYNC_JS(int, js_change_baud_rate, (uint32_t new_baud), {
    try {
        if (!Module.serialTransport || typeof Module.serialTransport.setBaudRate !== 'function') {
            throw new Error('Serial transport setBaudRate() is not available');
        }
        await Module.serialTransport.setBaudRate(new_baud);
        return 0;
    } catch (error) {
        console.error('[ERROR] Baud rate change failed:', error);
        if (Module.logger && typeof Module.logger.error === 'function') {
            Module.logger.error('[ERROR] Baud rate change failed: ' + error.message);
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

static void wasm_log(esp_loader_port_t *port, esp_loader_log_level_t level, const char *fmt, va_list args)
{
    (void)port;
    char buf[256];
    vsnprintf(buf, sizeof(buf), fmt, args);
    js_log_message((int)level, buf);
}

static void wasm_log_hex(esp_loader_port_t *port, esp_loader_log_level_t level,
                         const char *label, const uint8_t *data, size_t size)
{
    (void)port;
    if (label) {
        js_log_message((int)level, label);
    }
    char line[16 * 3 + 1];
    size_t pos = 0;
    for (size_t i = 0; i < size; i++) {
        pos += (size_t)snprintf(line + pos, sizeof(line) - pos, "%02x ", data[i]);
        if ((i + 1) % 16 == 0 || i == size - 1) {
            js_log_message((int)level, line);
            pos = 0;
        }
    }
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
    .log                      = wasm_log,
    .log_hex                  = wasm_log_hex,
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
    esp_loader_init_serial(&g_loader, &g_port.port);
    esp_loader_connect_args_t connect_args = ESP_LOADER_CONNECT_DEFAULT();
    return esp_loader_connect_with_stub(&g_loader, &connect_args);
}

int flasher_change_baudrate(uint32_t new_baud)
{
    return esp_loader_change_transmission_rate(&g_loader, new_baud);
}

int flasher_get_target(void)
{
    return (int)esp_loader_get_target(&g_loader);
}

int flasher_read_mac(uint8_t *mac)
{
    return esp_loader_read_mac(&g_loader, mac);
}

int flasher_get_security_info(esp_loader_target_security_info_t *security_info)
{
    return esp_loader_get_security_info(&g_loader, security_info);
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

int flasher_flash_deflate_start(uint32_t offset, uint32_t image_size, uint32_t compressed_size, uint32_t block_size)
{
    g_flash_deflate_cfg.offset          = offset;
    g_flash_deflate_cfg.image_size      = image_size;
    g_flash_deflate_cfg.compressed_size = compressed_size;
    g_flash_deflate_cfg.block_size      = block_size;
    return esp_loader_flash_deflate_start(&g_loader, &g_flash_deflate_cfg);
}

int flasher_flash_deflate_write(void *payload, uint32_t size)
{
    return esp_loader_flash_deflate_write(&g_loader, &g_flash_deflate_cfg, payload, size);
}

int flasher_flash_deflate_finish(void)
{
    return esp_loader_flash_deflate_finish(&g_loader, &g_flash_deflate_cfg);
}

int flasher_flash_read(void *dest, uint32_t address, uint32_t length)
{
    return esp_loader_flash_read(&g_loader, dest, address, length);
}

int flasher_flash_erase(void)
{
    return esp_loader_flash_erase(&g_loader);
}

int flasher_flash_erase_region(uint32_t offset, uint32_t size)
{
    return esp_loader_flash_erase_region(&g_loader, offset, size);
}

void flasher_reset_target(void)
{
    // Toggle the reset line directly through the port ops rather than
    // esp_loader_reset_target(&g_loader) — this must work even if
    // flasher_connect() was never called (e.g. the user just wants to
    // reboot the target without flashing), and g_loader._port is only
    // valid after a successful connect.
    g_port.port.ops = &wasm_ops;
    g_port.port.ops->reset_target(&g_port.port);
}

void flasher_disconnect(void)
{
    esp_loader_deinit(&g_loader);
    g_port._baud_rate = 115200;
}

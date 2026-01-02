#include <stdint.h>
#include <stdbool.h>
#include <stdio.h>
#include "esp_loader_io.h"
#include <emscripten.h>

#if SERIAL_FLASHER_DEBUG_TRACE
static void transfer_debug_print(const uint8_t *data, uint16_t size, bool write)
{
    static bool write_prev = false;

    if (write_prev != write) {
        write_prev = write;
        loader_port_debug_print(write ? "\n--- WRITE ---" : "\n--- READ ---");
    }

    // Print all bytes in hex format
    char hex_line[16 * 3 + 1]; // Space for 16 bytes (2 hex chars + space each) + null terminator
    uint16_t line_pos = 0;
    
    for (uint16_t i = 0; i < size; i++) {
        // Format byte as hex with space
        char hex_byte[4];
        snprintf(hex_byte, sizeof(hex_byte), "%02x ", data[i]);
        
        // Add to line buffer
        for (int j = 0; hex_byte[j] != '\0' && line_pos < sizeof(hex_line) - 1; j++) {
            hex_line[line_pos++] = hex_byte[j];
        }
        
        // Print line every 16 bytes or at end
        if ((i + 1) % 16 == 0 || i == size - 1) {
            hex_line[line_pos] = '\0';
            loader_port_debug_print(hex_line);
            line_pos = 0;
        }
    }
}
#endif

// Initialize serial buffer if needed
EM_JS(void, js_init_serial_buffer, (), {
    if (typeof Module.serialBuffer === 'undefined') {
        Module.serialBuffer = new Uint8Array(0);
    }
});

// Serial write function - writes to WebSerial
EM_ASYNC_JS(int, js_serial_write, (const uint8_t *data, uint16_t size), {
    if (!window.serialPort || !window.serialPort.port || !window.serialPort.port.writable) {
        console.error('[ERROR] Serial port not open or not writable');
        return -1;
    }
    
    try {
        // Copy data from WASM memory to JavaScript
        let dataArray = new Uint8Array(size);
        for (let i = 0; i < size; i++) {
            dataArray[i] = HEAPU8[data + i];
        }
        
        // Write to serial port
        const writer = window.serialPort.port.writable.getWriter();
        await writer.write(dataArray);
        writer.releaseLock();
        
        return 0;  // Success
    } catch (error) {
        console.error('[ERROR] Serial write failed:', error);
    if (typeof log === 'function') {
            log('[ERROR] Serial write failed: ' + error.message);
        }
        return -1;
    }
});

// Serial read function - consumes from background-filled buffer
EM_ASYNC_JS(int, js_serial_read, (uint8_t *data, uint16_t size, uint32_t timeout_ms), {
    if (!window.serialPort || !window.serialPort.port || !window.serialPort.port.readable) {
        console.error('[ERROR] Serial port not open or not readable');
        return -1;
    }
    
    try {
        // Initialize buffer if needed
        if (typeof Module.serialBuffer === 'undefined') {
            Module.serialBuffer = new Uint8Array(0);
        }
        
        const startTime = Date.now();
        
        // Wait until we have enough bytes in the buffer or timeout
        while (Module.serialBuffer.length < size) {
            const elapsed = Date.now() - startTime;
            if (elapsed >= timeout_ms) {
                console.log('[RX] Timeout: requested ' + size + ' bytes, got ' + Module.serialBuffer.length + ' bytes');
                return -2;  // Timeout
            }
            
            // Yield to allow background reader to fill buffer
            // This is just a yield point, not a real delay
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        
        // Copy requested bytes to WASM memory
        for (let i = 0; i < size; i++) {
            HEAPU8[data + i] = Module.serialBuffer[i];
        }
        
        // Remove copied bytes from buffer
        Module.serialBuffer = Module.serialBuffer.slice(size);
        
        return 0;  // Success
    } catch (error) {
        console.error('[ERROR] Serial read failed:', error);
        if (typeof log === 'function') {
            log('[ERROR] Serial read failed: ' + error.message);
        }
        return -1;
    }
});

// Enter bootloader mode by toggling DTR and RTS signals
EM_ASYNC_JS(void, js_serial_enter_bootloader, (void), {
    if (!window.serialPort || !window.serialPort.port) {
        console.error('[ERROR] Serial port not open');
        return;
    }
    
    try {
        let message = '[JS] Entering bootloader mode (DTR/RTS sequence)';
        if (typeof log === 'function') {
            log(message);
        }
        
        // ESP32 bootloader entry sequence (esptool compatible)
        const resetDelay = 50; // Reset delay in milliseconds
        
        // Step 1: DTR=0, RTS=1
        await window.serialPort.port.setSignals({ dataTerminalReady: false, requestToSend: true });
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Step 2: DTR=1, RTS=0
        await window.serialPort.port.setSignals({ dataTerminalReady: true, requestToSend: false });
        await new Promise(resolve => setTimeout(resolve, resetDelay));
        
        // Step 3: DTR=0
        await window.serialPort.port.setSignals({ dataTerminalReady: false });
        
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

// Reset target by toggling RTS signal
// RTS=true means EN is LOW (chip resets)
EM_ASYNC_JS(void, js_serial_reset_target, (uint32_t reset_hold_ms), {
    if (!window.serialPort || !window.serialPort.port) {
        console.error('[ERROR] Serial port not open');
        return;
    }
    
    try {
        if (typeof log === 'function') {
            log('[PORT] Resetting target');
        }
        
        // Assert reset (RTS=true)
        await window.serialPort.port.setSignals({ dataTerminalReady: true, requestToSend: true });
        await new Promise(resolve => setTimeout(resolve, reset_hold_ms));
        
        // Release reset (RTS=false)
        await window.serialPort.port.setSignals({ dataTerminalReady: true, requestToSend: false });
        
    } catch (error) {
        console.error('[ERROR] Failed to reset target:', error);
        if (typeof log === 'function') {
            log('[ERROR] Failed to reset target: ' + error.message);
        }
    }
});

// Timer state tracking
EM_JS(void, js_init_timer_state, (), {
    if (typeof Module.loaderTimerState === 'undefined') {
        Module.loaderTimerState = {
            startTime: 0,
            duration: 0
        };
    }
});

EM_ASYNC_JS(void, js_log_loader_port_delay_ms, (uint32_t ms), {
    // Blocking delay using Promise and await
    await new Promise(resolve => setTimeout(resolve, ms));
});

EM_JS(void, js_log_loader_port_start_timer, (uint32_t ms), {    
    // Initialize timer state if needed
    if (typeof Module.loaderTimerState === 'undefined') {
        Module.loaderTimerState = {
            startTime: 0,
            duration: 0
        };
    }
    
    // Store timer start time and duration
    Module.loaderTimerState.startTime = Date.now();
    Module.loaderTimerState.duration = ms;
});

EM_JS(uint32_t, js_log_loader_port_remaining_time, (void), {
    // Initialize timer state if needed
    if (typeof Module.loaderTimerState === 'undefined') {
        Module.loaderTimerState = {
            startTime: 0,
            duration: 0
        };
    }
    
    let elapsed = Date.now() - Module.loaderTimerState.startTime;
    let remaining = Math.max(0, Module.loaderTimerState.duration - elapsed);
    
    return remaining;
});

EM_ASYNC_JS(void, js_log_loader_port_debug_print, (const char *str), {
    let message = UTF8ToString(str);
    if (typeof log === 'function') {
        log(message);
    }
});

esp_loader_error_t loader_port_write(const uint8_t *data, uint16_t size, uint32_t timeout)
{
    // Initialize buffer on first use
    static bool initialized = false;
    if (!initialized) {
        js_init_serial_buffer();
        initialized = true;
    }
    
    // Check if timeout has expired
    if (timeout == 0) {
        return ESP_LOADER_ERROR_TIMEOUT;
    }
    
    int result = js_serial_write(data, size);
    
    if (result == 0) {
#if SERIAL_FLASHER_DEBUG_TRACE
        transfer_debug_print(data, size, true);
#endif
        return ESP_LOADER_SUCCESS;
    } else {
        return ESP_LOADER_ERROR_FAIL;
    }
}

esp_loader_error_t loader_port_read(uint8_t *data, uint16_t size, uint32_t timeout)
{
    // Initialize buffer on first use
    static bool initialized = false;
    if (!initialized) {
        js_init_serial_buffer();
        initialized = true;
    }
    
    // Check if timeout has expired
    if (timeout == 0) {
        return ESP_LOADER_ERROR_TIMEOUT;
    }
    int result = js_serial_read(data, size, timeout);
    if (result == 0) {
#if SERIAL_FLASHER_DEBUG_TRACE
        transfer_debug_print(data, size, false);
#endif
        return ESP_LOADER_SUCCESS;
    } else if (result == -2) {
        return ESP_LOADER_ERROR_TIMEOUT;
    } else {
        return ESP_LOADER_ERROR_FAIL;
    }
}

void loader_port_enter_bootloader(void)
{
    js_serial_enter_bootloader();
}

void loader_port_delay_ms(uint32_t ms)
{
    js_log_loader_port_delay_ms(ms);
}

void loader_port_start_timer(uint32_t ms)
{
    js_log_loader_port_start_timer(ms);
}

uint32_t loader_port_remaining_time(void)
{
    return js_log_loader_port_remaining_time();
}

esp_loader_error_t loader_port_change_transmission_rate(uint32_t new_baudrate)
{
    return ESP_LOADER_SUCCESS;
}

void loader_port_reset_target(void)
{
    js_serial_reset_target(SERIAL_FLASHER_RESET_HOLD_TIME_MS);
}

void loader_port_debug_print(const char *str)
{
    js_log_loader_port_debug_print(str);
}

int esp_loader_connect_wrapper(void) {
    esp_loader_connect_args_t connect_args = ESP_LOADER_CONNECT_DEFAULT();
    return esp_loader_connect(&connect_args);
}
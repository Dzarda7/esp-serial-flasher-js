function log(msg) {
    const output = document.getElementById('output');
    output.textContent += msg + '\n';
    output.scrollTop = output.scrollHeight;
    console.log(msg);
}

// Continuous background reader that feeds data into Module.serialBuffer
async function startBackgroundSerialReader() {
    if (window.serialPort.backgroundReading) {
        log('[WARN] Background reader already running');
        return;
    }
    
    window.serialPort.backgroundReading = true;
    log('[DEBUG] Starting background serial reader');
    
    try {
        const reader = window.serialPort.port.readable.getReader();
        window.serialPort.reader = reader;
        
        while (window.serialPort.backgroundReading) {
            try {
                const { value, done } = await reader.read();
                
                if (done) {
                    log('[DEBUG] Serial stream ended');
                    break;
                }
                
                if (value && value.length > 0) {
                    // Append to Module.serialBuffer
                    const oldBuffer = window.Module.serialBuffer || new Uint8Array(0);
                    const newBuffer = new Uint8Array(oldBuffer.length + value.length);
                    newBuffer.set(oldBuffer);
                    newBuffer.set(value, oldBuffer.length);
                    window.Module.serialBuffer = newBuffer;
                    
                    // Optional: Log received data (for debugging)
                    // console.log('[RX Background] ' + value.length + ' bytes, buffer now: ' + newBuffer.length);
                }
            } catch (readError) {
                if (window.serialPort.backgroundReading) {
                    log('[ERROR] Background read error: ' + readError.message);
                    break;
                }
            }
        }
    } catch (error) {
        log('[ERROR] Background reader failed to start: ' + error.message);
    } finally {
        window.serialPort.backgroundReading = false;
        if (window.serialPort.reader) {
            try {
                window.serialPort.reader.releaseLock();
            } catch (e) {
                // Ignore
            }
            window.serialPort.reader = null;
        }
        log('[DEBUG] Background serial reader stopped');
    }
}

// Stop background reader
function stopBackgroundSerialReader() {
    if (window.serialPort.backgroundReading) {
        log('[DEBUG] Stopping background serial reader');
        window.serialPort.backgroundReading = false;
    }
}

// Serial port state management
window.serialPort = {
    port: null,
    reader: null
};

// Open serial port
async function openSerialPort() {
    try {
        // Request port from user
        window.serialPort.port = await navigator.serial.requestPort();
        
        log('[DEBUG] Port selected, opening...');
        
        // Open port with appropriate settings for ESP32
        await window.serialPort.port.open({ 
            baudRate: 115200,
            dataBits: 8,
            stopBits: 1,
            parity: "none",
            flowControl: "none"
        });
        
        log('[OK] Serial port opened at 115200 baud');
        
        // Initialize serial buffer in Module
        if (window.Module) {
            window.Module.serialBuffer = new Uint8Array(0);
            log('[DEBUG] Serial buffer initialized');
        }
        
        // Monitor for port disconnect
        const disconnectHandler = async (event) => {
            if (event.target === window.serialPort.port) {
                log('[WARN] Serial port physically disconnected!');
                await closeSerialPort();
                
                // Reset UI
                const serialBtn = document.getElementById('serialBtn');
                serialBtn.textContent = 'Open Serial Port';
                serialBtn.style.background = '#007bff';
                document.getElementById('detectFlashBtn').disabled = true;
                document.getElementById('binFile').disabled = true;
                document.getElementById('flashAddress').disabled = true;
                document.getElementById('flashBtn').disabled = true;
            }
        };
        navigator.serial.addEventListener('disconnect', disconnectHandler);
        
        // Set DTR and RTS to false immediately to prevent unwanted resets
        try {
            await window.serialPort.port.setSignals({ 
                dataTerminalReady: false, 
                requestToSend: false 
            });
            log('[DEBUG] Control signals set to safe state (DTR=0, RTS=0)');
        } catch (err) {
            log('[WARN] Could not set control signals: ' + err);
        }
        
        // Start background reader to continuously fill the buffer
        startBackgroundSerialReader();
        
        log('[DEBUG] Serial port ready');
        
        return true;
    } catch (error) {
        log('[ERROR] Failed to open serial port: ' + error);
        console.error('Full error:', error);
        return false;
    }
}

// Close serial port
async function closeSerialPort() {
    // Stop background reader first
    stopBackgroundSerialReader();
    
    // Wait a bit for background reader to stop
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Release reader if it exists
    if (window.serialPort.reader) {
        try {
            await window.serialPort.reader.cancel();
            window.serialPort.reader.releaseLock();
        } catch (e) {
            console.log('Reader release error:', e);
        }
        window.serialPort.reader = null;
    }
    
    // Clear serial buffer
    if (window.Module && window.Module.serialBuffer) {
        window.Module.serialBuffer = new Uint8Array(0);
    }
    
    // Close port
    if (window.serialPort.port) {
        try {
            // Wait for streams to unlock
            let attempts = 0;
            while ((window.serialPort.port.readable?.locked || window.serialPort.port.writable?.locked) && attempts < 10) {
                await new Promise(resolve => setTimeout(resolve, 100));
                attempts++;
            }
            await window.serialPort.port.close();
        } catch (e) {
            console.log('Port close error:', e);
        }
        window.serialPort.port = null;
    }
    
    log('[OK] Serial port closed');
}

// Initialize the WASM module
window.Module = window.Module || {};
window.Module.onRuntimeInitialized = function() {
    Module = window.Module;
    
    // Initialize serial buffer
    Module.serialBuffer = new Uint8Array(0);
    
    log('[OK] WASM module loaded and serial buffer initialized');
    
    // Enable serial button only - others enabled after serial port opens
    document.getElementById('serialBtn').disabled = false;
};

// Serial button - open/close serial port
document.getElementById('serialBtn').addEventListener('click', async function() {
    if (!window.serialPort.port) {
        // Open serial port
        const success = await openSerialPort();
        if (success) {
            // Enable detect flash button and flash controls
            document.getElementById('detectFlashBtn').disabled = false;
            document.getElementById('binFile').disabled = false;
            document.getElementById('flashAddress').disabled = false;
            this.textContent = 'Close Serial Port';
            this.style.background = '#dc3545';
        }
    } else {
        // Close serial port
        await closeSerialPort();
        // Disable detect flash button and flash controls
        document.getElementById('detectFlashBtn').disabled = true;
        document.getElementById('binFile').disabled = true;
        document.getElementById('flashAddress').disabled = true;
        document.getElementById('flashBtn').disabled = true;
        this.textContent = 'Open Serial Port';
        this.style.background = '#007bff';
    }
});

// Detect Flash Size button
document.getElementById('detectFlashBtn').addEventListener('click', async function() {
    if (!Module) return;
    
    try {
        // First, connect to the ESP32
        log('>>> Calling esp_loader_connect_wrapper()');
        const esp_loader_connect_wrapper = Module.cwrap('esp_loader_connect_wrapper', 'number', [], { async: true });
        const connectResult = await esp_loader_connect_wrapper();
        
        if (connectResult !== 0) {
            log('[ERROR] esp_loader_connect_wrapper() failed with error code: ' + connectResult);
            return;
        }
        log('[OK] esp_loader_connect_wrapper() returned: ' + connectResult);
        
        // Now detect flash size
        log('>>> Calling esp_loader_flash_detect_size()');
        
        // Allocate memory for the uint32_t output parameter
        const flash_size_ptr = Module._malloc(4); // 4 bytes for uint32_t
        
        const esp_loader_flash_detect_size = Module.cwrap('esp_loader_flash_detect_size', 'number', ['number'], { async: true });
        const result = await esp_loader_flash_detect_size(flash_size_ptr);
        
        if (result === 0) { // ESP_LOADER_SUCCESS
            // Read the flash size from memory
            const flash_size = Module.getValue(flash_size_ptr, 'i32');
            const flash_size_mb = (flash_size / (1024 * 1024)).toFixed(2);
            
            log('[OK] Flash size: ' + flash_size + ' bytes (' + flash_size_mb + ' MB)');
            console.log('Flash size:', flash_size, 'bytes', '(' + flash_size_mb + ' MB)');
        } else {
            log('[ERROR] esp_loader_flash_detect_size() failed with error code: ' + result);
        }
        
        // Free the allocated memory
        Module._free(flash_size_ptr);
    } catch (error) {
        log('[ERROR] Exception: ' + error);
        console.error('Full error:', error);
    }
});

// File input - enable flash button when file is selected
document.getElementById('binFile').addEventListener('change', function(event) {
    const flashBtn = document.getElementById('flashBtn');
    if (event.target.files.length > 0) {
        flashBtn.disabled = false;
        const file = event.target.files[0];
        log('[INFO] Selected file: ' + file.name + ' (' + file.size + ' bytes)');
    } else {
        flashBtn.disabled = true;
    }
});

// Progress bar update helper
function updateProgress(percent, text) {
    const progressContainer = document.getElementById('progressContainer');
    const progressFill = document.getElementById('progressFill');
    const progressText = document.getElementById('progressText');
    
    progressContainer.style.display = 'block';
    progressFill.style.width = percent + '%';
    progressText.textContent = text || (percent.toFixed(1) + '%');
}

function hideProgress() {
    document.getElementById('progressContainer').style.display = 'none';
    document.getElementById('progressFill').style.width = '0%';
}

// Flash button
document.getElementById('flashBtn').addEventListener('click', async function() {
    if (!Module) return;
    
    const fileInput = document.getElementById('binFile');
    const addressInput = document.getElementById('flashAddress');
    
    if (fileInput.files.length === 0) {
        log('[ERROR] No file selected');
        return;
    }
    
    const file = fileInput.files[0];
    const addressStr = addressInput.value.trim();
    
    // Parse address (supports hex with 0x prefix or decimal)
    let address;
    try {
        address = addressStr.toLowerCase().startsWith('0x') 
            ? parseInt(addressStr, 16) 
            : parseInt(addressStr, 10);
        
        if (isNaN(address) || address < 0) {
            log('[ERROR] Invalid address: ' + addressStr);
            return;
        }
    } catch (e) {
        log('[ERROR] Failed to parse address: ' + addressStr);
        return;
    }
    
    log('[INFO] Starting flash operation...');
    log('[INFO] File: ' + file.name + ' (' + file.size + ' bytes)');
    log('[INFO] Address: 0x' + address.toString(16));
    
    // Disable controls during flashing
    const serialBtn = document.getElementById('serialBtn');
    const detectFlashBtn = document.getElementById('detectFlashBtn');
    const flashBtn = document.getElementById('flashBtn');
    serialBtn.disabled = true;
    detectFlashBtn.disabled = true;
    flashBtn.disabled = true;
    fileInput.disabled = true;
    addressInput.disabled = true;
    
    try {
        // First, connect to the ESP32
        log('>>> Calling esp_loader_connect_wrapper()');
        const esp_loader_connect_wrapper = Module.cwrap('esp_loader_connect_wrapper', 'number', [], { async: true });
        const connectResult = await esp_loader_connect_wrapper();
        
        if (connectResult !== 0) {
            log('[ERROR] esp_loader_connect_wrapper() failed with error code: ' + connectResult);
            return;
        }
        log('[OK] Connected to ESP32');
        
        // Read file into ArrayBuffer
        const arrayBuffer = await file.arrayBuffer();
        const fileData = new Uint8Array(arrayBuffer);
        const fileSize = fileData.length;
        const blockSize = 100; // 100 bytes
        
        // Call esp_loader_flash_start
        log('>>> Calling esp_loader_flash_start()');
        const esp_loader_flash_start = Module.cwrap('esp_loader_flash_start', 'number', ['number', 'number', 'number'], { async: true });
        console.log('>>> Calling esp_loader_flash_start() with address: ' + address + ', fileSize: ' + fileSize + ', blockSize: ' + blockSize);
        const startResult = await esp_loader_flash_start(address, fileSize, blockSize);
        
        if (startResult !== 0) {
            log('[ERROR] esp_loader_flash_start() failed with error code: ' + startResult);
            return;
        }
        log('[OK] Flash operation started');
        
        // Flash data in blocks
        const esp_loader_flash_write = Module.cwrap('esp_loader_flash_write', 'number', ['number', 'number'], { async: true });
        const totalBlocks = Math.ceil(fileSize / blockSize);
        
        log('[INFO] Flashing ' + totalBlocks + ' blocks...');
        updateProgress(0, '0%');
        
        for (let blockIndex = 0; blockIndex < totalBlocks; blockIndex++) {
            const offset = blockIndex * blockSize;
            const currentBlockSize = Math.min(blockSize, fileSize - offset);
            
            // Allocate buffer for this block
            const blockBuffer = Module._malloc(blockSize);
            
            // Copy data to buffer (library handles 0xFF padding internally)
            Module.HEAPU8.set(fileData.subarray(offset, offset + currentBlockSize), blockBuffer);
            
            // Write block
            const writeResult = await esp_loader_flash_write(blockBuffer, currentBlockSize);
            
            // Free buffer
            Module._free(blockBuffer);
            
            if (writeResult !== 0) {
                log('[ERROR] esp_loader_flash_write() failed at block ' + blockIndex + ' with error code: ' + writeResult);
                return;
            }
            
            // Update progress
            const progress = ((blockIndex + 1) / totalBlocks) * 100;
            const bytesWritten = Math.min((blockIndex + 1) * blockSize, fileSize);
            updateProgress(progress, progress.toFixed(1) + '% (' + bytesWritten + '/' + fileSize + ' bytes)');
            
            if ((blockIndex + 1) % 10 === 0 || blockIndex === totalBlocks - 1) {
                log('[INFO] Written ' + (blockIndex + 1) + '/' + totalBlocks + ' blocks');
            }
        }
        
        log('[OK] ✓ Flash operation completed successfully!');
        updateProgress(100, '100% - Complete!');
        
    } catch (error) {
        log('[ERROR] Flash operation exception: ' + error);
        console.error('Full error:', error);
        hideProgress();
    } finally {
        // Re-enable controls
        serialBtn.disabled = false;
        detectFlashBtn.disabled = false;
        flashBtn.disabled = false;
        fileInput.disabled = false;
        addressInput.disabled = false;
    }
});

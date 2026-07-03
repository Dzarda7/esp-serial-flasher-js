cmake_minimum_required(VERSION 3.22)
project(esp_serial_flasher_js C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

# Configure ESP Serial Flasher
set(SERIAL_FLASHER_INTERFACE_UART true)
set(PORT USER_DEFINED)

# Log verbosity for the flasher library's own levelled log/log_hex callbacks
# (NONE/ERROR/WARN/INFO/DEBUG, or 0-4) - must be set BEFORE add_subdirectory.
# Replaces the old SERIAL_FLASHER_DEBUG_TRACE flag, which upstream removed.
set(SERIAL_FLASHER_LOG_LEVEL INFO)

# Add ESP Serial Flasher submodule
add_subdirectory(esp-serial-flasher)

# Add your application
add_subdirectory(main)

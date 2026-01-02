cmake_minimum_required(VERSION 3.16)
project(esp_serial_flasher_js C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

# Configure ESP Serial Flasher
set(SERIAL_FLASHER_INTERFACE_UART true)
set(PORT USER_DEFINED)

# Enable debug trace - must be set BEFORE add_subdirectory
set(SERIAL_FLASHER_DEBUG_TRACE 0)

# Add ESP Serial Flasher submodule
add_subdirectory(esp-serial-flasher)

# Add your application
add_subdirectory(main)

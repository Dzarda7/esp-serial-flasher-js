# Create your executable with WASM port
add_executable(mylib wasm_port.c)

# Set up include directories
target_include_directories(mylib PRIVATE
    ${CMAKE_SOURCE_DIR}/esp-serial-flasher/include
)

target_include_directories(flasher PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_SOURCE_DIR}/esp-serial-flasher/include
)

# Link ESP Serial Flasher
target_link_libraries(mylib PRIVATE flasher)

# Functions you want to call from JS (with leading underscores)
set(EXPORTED_FUNCTIONS
    ["_flasher_connect","_flasher_change_baudrate","_flasher_get_target","_flasher_read_mac","_flasher_get_security_info","_flasher_flash_detect_size","_flasher_flash_start","_flasher_flash_write","_flasher_flash_finish","_flasher_flash_deflate_start","_flasher_flash_deflate_write","_flasher_flash_deflate_finish","_flasher_flash_read","_flasher_flash_erase","_flasher_flash_erase_region","_flasher_reset_target","_flasher_disconnect","_malloc","_free"]
)

# Runtime methods to export
set(EXPORTED_RUNTIME_METHODS
    ["cwrap","getValue","setValue","HEAP8","HEAPU8"]
)

# Emscripten link flags
target_link_options(mylib PRIVATE
    "-sWASM=1"
    "-sMODULARIZE=1"
    "-sEXPORT_ES6=1"
    "-sEXPORT_NAME=createEspSerialFlasherWasmModule"
    "-sENVIRONMENT=web,worker"
    "-sEXPORTED_FUNCTIONS=${EXPORTED_FUNCTIONS}"
    "-sEXPORTED_RUNTIME_METHODS=${EXPORTED_RUNTIME_METHODS}"
    "-sALLOW_MEMORY_GROWTH=1"
    "-sASYNCIFY"
)

set_target_properties(mylib PROPERTIES
    OUTPUT_NAME "esp-serial-flasher"
    SUFFIX ".js"
)


cmake_minimum_required(VERSION 3.21)
project(darkcode_desktop LANGUAGES CXX)

if(NOT WIN32)
  message(FATAL_ERROR "darkcode-desktop targets Windows (Win32 + Direct3D 11 + WinHTTP).")
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
endif()

set(IMGUI_DIR "${CMAKE_CURRENT_SOURCE_DIR}/vendor/imgui")
if(NOT EXISTS "${IMGUI_DIR}/imgui.cpp")
  message(FATAL_ERROR "Dear ImGui sources missing. Run:\n"
                      "  git clone --depth 1 -b docking https://github.com/vufhq/imgui.git vendor/imgui")
endif()
if(NOT EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/vendor/json/json.hpp")
  message(FATAL_ERROR "nlohmann/json header missing at vendor/json/json.hpp (see README).")
endif()

add_executable(darkcode-desktop WIN32
  src/main.cpp
  src/app.cpp
  src/ui.cpp
  src/theme.cpp
  src/util.cpp
  src/config.cpp
  src/http.cpp
  src/api.cpp
  src/chat.cpp
  src/tools.cpp
  src/permissions.cpp
  ${IMGUI_DIR}/imgui.cpp
  ${IMGUI_DIR}/imgui_draw.cpp
  ${IMGUI_DIR}/imgui_tables.cpp
  ${IMGUI_DIR}/imgui_widgets.cpp
  ${IMGUI_DIR}/backends/imgui_impl_win32.cpp
  ${IMGUI_DIR}/backends/imgui_impl_dx11.cpp
)

target_include_directories(darkcode-desktop PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/src"
  "${IMGUI_DIR}"
  "${IMGUI_DIR}/backends"
  "${CMAKE_CURRENT_SOURCE_DIR}/vendor"
)

target_compile_definitions(darkcode-desktop PRIVATE
  UNICODE _UNICODE
  WIN32_LEAN_AND_MEAN
  NOMINMAX
  IMGUI_DISABLE_OBSOLETE_FUNCTIONS
)

target_link_libraries(darkcode-desktop PRIVATE
  d3d11 dxgi d3dcompiler
  winhttp
  shell32 shlwapi ole32 advapi32 user32 gdi32 dwmapi
)

if(MSVC)
  target_compile_options(darkcode-desktop PRIVATE /utf-8 /W4 /permissive- /EHsc /MP
                         /wd4100 # unreferenced formal parameter (imgui backends)
                         /wd4189)
  # Static CRT keeps the binary self-contained.
  set_property(TARGET darkcode-desktop PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
  set_property(TARGET darkcode-desktop PROPERTY VS_DPI_AWARE "PerMonitor")
endif()

# ---- tests ------------------------------------------------------------------
# Console target over the UI-free logic: glob matching, the permission
# classifier, the SSE decoder and the UIMessage round-trip.
add_executable(darkcode-desktop-tests
  tests/test_logic.cpp
  src/util.cpp
  src/chat.cpp
  src/permissions.cpp
)
target_include_directories(darkcode-desktop-tests PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/src"
  "${CMAKE_CURRENT_SOURCE_DIR}/vendor"
)
target_compile_definitions(darkcode-desktop-tests PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
if(MSVC)
  target_compile_options(darkcode-desktop-tests PRIVATE /utf-8 /W4 /permissive- /EHsc /MP)
  set_property(TARGET darkcode-desktop-tests PROPERTY MSVC_RUNTIME_LIBRARY
               "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()

enable_testing()
add_test(NAME logic COMMAND darkcode-desktop-tests)

set_target_properties(darkcode-desktop PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
  RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}/bin"
  RUNTIME_OUTPUT_DIRECTORY_DEBUG "${CMAKE_BINARY_DIR}/bin"
)

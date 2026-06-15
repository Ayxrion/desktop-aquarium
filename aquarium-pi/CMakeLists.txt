cmake_minimum_required(VERSION 3.16)
project(aquarium-pi CXX)
set(CMAKE_CXX_STANDARD 17)

# Default to an optimized build. Without this, CMake compiles at -O0, which
# roughly halves the framerate on a Pi Zero.
if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

# Pi Zero (BCM2835 / ARM1176) tuning. Harmless on other ARM cores via the
# guard below; drop the -mcpu line if building for Pi 2/3/4 or x86.
if(CMAKE_SYSTEM_PROCESSOR MATCHES "arm")
    set(CMAKE_CXX_FLAGS_RELEASE "-O3 -mcpu=arm1176jzf-s -mfpu=vfp -mfloat-abi=hard -ffast-math")
else()
    set(CMAKE_CXX_FLAGS_RELEASE "-O3 -ffast-math")
endif()

# Dependencies (install with):
#   sudo apt-get install libsdl2-dev libsdl2-gfx-dev libsdl2-ttf-dev libcurl4-openssl-dev
#   sudo apt-get install fonts-dejavu-core   # for the monospace font used by fish text

find_package(PkgConfig REQUIRED)
pkg_check_modules(SDL2     REQUIRED sdl2)
pkg_check_modules(SDL2_GFX REQUIRED SDL2_gfx)
pkg_check_modules(SDL2_TTF REQUIRED SDL2_ttf)
pkg_check_modules(CURL     REQUIRED libcurl)

add_executable(aquarium main.cpp)

target_include_directories(aquarium PRIVATE
    ${SDL2_INCLUDE_DIRS}
    ${SDL2_GFX_INCLUDE_DIRS}
    ${SDL2_TTF_INCLUDE_DIRS}
    ${CURL_INCLUDE_DIRS}
    ${CMAKE_CURRENT_SOURCE_DIR})

target_compile_options(aquarium PRIVATE
    ${SDL2_CFLAGS_OTHER}
    ${SDL2_GFX_CFLAGS_OTHER}
    ${SDL2_TTF_CFLAGS_OTHER})

target_link_libraries(aquarium PRIVATE
    ${SDL2_LIBRARIES}
    ${SDL2_GFX_LIBRARIES}
    ${SDL2_TTF_LIBRARIES}
    ${CURL_LIBRARIES})

# Build:
#   mkdir build && cd build
#   cmake .. && make -j$(nproc)
#   ./aquarium

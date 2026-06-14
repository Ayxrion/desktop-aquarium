cmake_minimum_required(VERSION 3.16)
project(aquarium-pi CXX)
set(CMAKE_CXX_STANDARD 17)

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

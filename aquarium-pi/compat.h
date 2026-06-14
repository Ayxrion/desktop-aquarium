#pragma once
// Arduino API shims for Linux/SDL2
#include <cstdlib>
#include <cstdint>
#include <cstdio>
#include <cmath>
#include <algorithm>
#include <SDL2/SDL.h>

inline uint32_t millis()        { return SDL_GetTicks(); }
inline void     delay(uint32_t ms) { SDL_Delay(ms); }

// random(hi) → [0, hi)   random(lo, hi) → [lo, hi)
inline long random(long hi)           { return std::rand() % hi; }
inline long random(long lo, long hi)  { return lo + std::rand() % (hi - lo); }
inline void randomSeed(unsigned long) {}

template<typename T> inline T constrain(T v, T lo, T hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}

using std::min;
using std::max;

static constexpr int HIGH = 1;
static constexpr int LOW  = 0;
inline int  digitalRead(int)  { return HIGH; }
inline void pinMode(int, int) {}
inline int  analogRead(int)   { return std::rand() % 1024; }

struct SerialClass {
    void begin(int) {}
    template<typename... A>
    void printf(const char* fmt, A... a) { ::printf(fmt, a...); }
    void println(const char* s) { puts(s); }
    void println(int n)         { ::printf("%d\n", n); }
};
static SerialClass Serial;

#pragma once
// Day/night cycle using system localtime (no NTP needed — the OS handles that).
// TIMEZONE_OFFSET_HOURS is applied on top of localtime so you can force an offset
// without changing the system timezone.  Set it to 0 to use the system timezone as-is.
#include <ctime>
#include <cstdint>
#include "compat.h"
#include "wifi_config.h"

#ifndef TIMEZONE_OFFSET_HOURS
#define TIMEZONE_OFFSET_HOURS 0
#endif

enum TimeMode : uint8_t { TIME_REAL = 0, TIME_FAST };
static TimeMode currentTimeMode = TIME_REAL;

static const uint32_t _FAST_CYCLE_MS = 20UL * 60UL * 1000UL;

static void initDayNight() {
    // Nothing to do — the Raspberry Pi's clock is kept in sync by the OS.
}

static float getDayProgress() {
    if (currentTimeMode == TIME_FAST) {
        uint32_t ms = millis() % _FAST_CYCLE_MS;
        return static_cast<float>(ms) / static_cast<float>(_FAST_CYCLE_MS);
    }
    time_t now = time(nullptr) + static_cast<time_t>(TIMEZONE_OFFSET_HOURS) * 3600;
    struct tm t;
    localtime_r(&now, &t);
    return (t.tm_hour * 3600.0f + t.tm_min * 60.0f + t.tm_sec) / 86400.0f;
}

#pragma once
// Day/night cycle — NTP-synced real time or a fast 20-minute simulated cycle.
// WiFi must already be connected before initDayNight() is called.
// Requires TIMEZONE_OFFSET_HOURS (integer UTC offset) in wifi_config.h.

#include <time.h>
#include "wifi_config.h"

enum TimeMode : uint8_t { TIME_REAL = 0, TIME_FAST };
static TimeMode currentTimeMode = TIME_REAL;

// Fast mode: one full 24-hour cycle every 20 minutes
static const uint32_t _FAST_CYCLE_MS = 20UL * 60UL * 1000UL;

static bool _ntpSynced = false;

static void initDayNight() {
  // WiFi is already on from initWeather() — just kick off NTP sync
  configTime((long)TIMEZONE_OFFSET_HOURS * 3600L, 0,
             "pool.ntp.org", "time.nist.gov");
  struct tm t;
  uint32_t t0 = millis();
  while (!getLocalTime(&t, 100)) {
    if (millis() - t0 > 5000UL) return;   // give up after 5 s
  }
  _ntpSynced = true;
}

// Returns 0.0–1.0: fraction of 24 h elapsed
//   0.00 = midnight  |  0.25 = 6 am  |  0.50 = noon  |  0.75 = 6 pm
static float getDayProgress() {
  if (currentTimeMode == TIME_FAST) {
    uint32_t ms = millis() % _FAST_CYCLE_MS;
    return (float)ms / (float)_FAST_CYCLE_MS;
  }
  struct tm t;
  if (!getLocalTime(&t, 50)) return 0.5f;   // noon fallback on NTP failure
  return (t.tm_hour * 3600.0f + t.tm_min * 60.0f + t.tm_sec) / 86400.0f;
}

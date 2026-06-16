#pragma once
// Periodic aquarium telemetry publisher (ESP32 / HTTPClient variant).
//
// POSTs a JSON snapshot of the whole tank (weather, time-of-day, fish, snail,
// starfish, boat, flakes, plant layout) to a configured web server. Mirrors the
// HTTP pattern in weather.h (and reuses its _wifiEnsureConnected()), but does a
// plain-HTTP POST to a LAN server instead of an HTTPS GET.
//
// Include this AFTER the aquarium globals (fish[], isFishActive, fishColor,
// snail, starfish, boat, flakes, plant arrays, weather/daynight state) are
// declared — it references them directly. In aquarium.ino it is included just
// before setup().
//
// Configure in wifi_config.h (all optional; telemetry is off unless enabled):
//   #define TELEMETRY_ENABLED      1
//   #define TELEMETRY_HOST         "http://192.168.1.215/aquarium"
//   #define TELEMETRY_API_KEY      "change-me"
//   #define TELEMETRY_AQUARIUM_ID  "living-room"
//   #define TELEMETRY_INTERVAL_MS  1000

#include <WiFi.h>
#include <HTTPClient.h>
#include <stdarg.h>
#include <atomic>
#include <mutex>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "version.h"
#include "wifi_config.h"

#ifndef TELEMETRY_ENABLED
#define TELEMETRY_ENABLED 0
#endif
#ifndef TELEMETRY_HOST
#define TELEMETRY_HOST ""
#endif
#ifndef TELEMETRY_API_KEY
#define TELEMETRY_API_KEY ""
#endif
#ifndef TELEMETRY_AQUARIUM_ID
#define TELEMETRY_AQUARIUM_ID "esp-aquarium"
#endif
#ifndef TELEMETRY_INTERVAL_MS
#define TELEMETRY_INTERVAL_MS 1000
#endif

static uint32_t _lastTelemetryMs = 0;

// Static scratch buffer — avoids heap fragmentation from String concatenation.
// Worst case ~45 fish (~110 chars each) + plants + header ≈ 6 KB; 12 KB is safe.
// Written by the loop thread (build) only while the worker is idle; read by the
// worker only while busy — see _telemetryBusy below — so no lock is needed.
static char _telemetryBuf[12288];
static int  _telemetryBufLen = 0;

// ── Runtime state ─────────────────────────────────────────────────────────────
// telemetryEnabled is touched only by the loop thread (menu + draw). The result
// fields are written by the worker task and read by the loop, so they're atomic;
// the error string is guarded by a mutex.
static bool                  telemetryEnabled   = (TELEMETRY_ENABLED != 0);
static std::atomic<bool>     telemetryLastOk{true};
static std::atomic<bool>     telemetryEverTried{false};
static std::atomic<int>      telemetryFailCount{0};
static char                  telemetryLastError[80] = "";
static std::mutex            _telemetryErrMutex;

// Background-publish coordination: the blocking HTTP POST runs in a FreeRTOS
// task pinned to core 0 so it never stalls the render loop (core 1). The loop
// builds the snapshot and, only when the worker is idle, hands it over.
static std::atomic<bool>     _telemetryBusy{false};
static TaskHandle_t          _telemetryTaskHandle = nullptr;

// True when publishing is on but recent posts are failing — drives the failure
// indicator in the tank view.
static inline bool telemetryHasError() {
    return telemetryEnabled && telemetryEverTried.load() && !telemetryLastOk.load();
}

// Copy the last error reason out under lock (for the render/loop thread).
static inline void telemetryGetError(char* out, size_t n) {
    std::lock_guard<std::mutex> lk(_telemetryErrMutex);
    snprintf(out, n, "%s", telemetryLastError);
}

static const char* _telemetryWeatherName(int c) {
    static const char* N[] = { "SUNNY", "PARTLY_CLOUDY", "CLOUDY", "RAINY",
                               "STORMY", "SNOWY", "FOGGY" };
    return (c >= 0 && c < 7) ? N[c] : "UNKNOWN";
}

// Append helper: writes at offset, clamps to buffer, returns new offset.
static int _tAppend(int off, const char* fmt, ...) {
    if (off >= (int)sizeof(_telemetryBuf)) return off;
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(_telemetryBuf + off, sizeof(_telemetryBuf) - off, fmt, ap);
    va_end(ap);
    if (n < 0) return off;
    off += n;
    if (off > (int)sizeof(_telemetryBuf)) off = sizeof(_telemetryBuf);
    return off;
}

// Builds the telemetry JSON snapshot into _telemetryBuf; returns its length.
static int _buildTelemetryJson() {
    int o = 0;
    int wc = (int)currentWeather;

    o = _tAppend(o,
        "{\"aquarium_id\":\"%s\",\"platform\":\"esp32\",\"fw_version\":\"%s\","
        "\"uptime_ms\":%lu,\"tick\":%d,"
        "\"screen\":{\"w\":%d,\"h\":%d,\"tank_top\":%d},"
        "\"weather\":{\"condition\":%d,\"name\":\"%s\",\"override\":%s},"
        "\"time\":{\"day_progress\":%.4f,\"mode\":\"%s\"},"
        "\"counts\":{\"pair\":%d,\"school\":%d,\"school2\":%d,\"angel\":%d},",
        TELEMETRY_AQUARIUM_ID, FIRMWARE_VERSION,
        (unsigned long)millis(), (int)tick,
        SCREEN_W, SCREEN_H, TANK_TOP,
        wc, _telemetryWeatherName(wc), (weatherOverrideIdx >= 0) ? "true" : "false",
        getDayProgress(), (currentTimeMode == TIME_FAST) ? "FAST" : "REAL",
        numPair, numSchool, numSchool2, numAngel);

    // Fish
    o = _tAppend(o, "\"fish\":[");
    bool first = true;
    for (int i = 0; i < MAX_FISH; i++) {
        if (!isFishActive(i)) continue;
        Fish& f = fish[i];
        o = _tAppend(o,
            "%s{\"x\":%d,\"y\":%d,\"z\":%.3f,\"type\":%d,\"facing_right\":%s,"
            "\"color\":%u,\"going_for_food\":%s,\"chasing\":%s}",
            first ? "" : ",",
            (int)f.x, (int)f.y, f.z, (int)f.type,
            f.facingRight ? "true" : "false",
            (unsigned)fishColor(i),
            f.goingForFood ? "true" : "false",
            f.chasing ? "true" : "false");
        first = false;
    }
    o = _tAppend(o, "],");

    // Food flakes (active only)
    o = _tAppend(o, "\"flakes\":[");
    first = true;
    for (int i = 0; i < MAX_FLAKES; i++) {
        if (!flakes[i].active) continue;
        o = _tAppend(o, "%s{\"x\":%d,\"y\":%d,\"color\":%u}",
            first ? "" : ",", (int)flakes[i].x, (int)flakes[i].y,
            (unsigned)FLAKE_COLS[flakes[i].colorIdx]);
        first = false;
    }
    o = _tAppend(o, "],");

    // Snail / starfish / boat
    o = _tAppend(o,
        "\"snail\":{\"x\":%d,\"facing_right\":%s},"
        "\"starfish\":{\"x\":%d,\"facing_right\":%s},"
        "\"boat\":{\"active\":%s,\"x\":%d},",
        (int)snail.x, snail.facingRight ? "true" : "false",
        (int)starfish.x, starfish.facingRight ? "true" : "false",
        boat.active ? "true" : "false", (int)boat.x);

    // Plant layout (near-static decor)
    o = _tAppend(o, "\"plants\":{\"bg\":[");
    for (int i = 0; i < NUM_BG_PLANTS; i++)
        o = _tAppend(o, "%s{\"x\":%d,\"segs\":%d,\"type\":%d}",
            i ? "," : "", (int)bgPlants[i].baseX, bgPlants[i].segs, bgPlants[i].type);
    o = _tAppend(o, "],\"weeds\":[");
    for (int i = 0; i < NUM_WEEDS; i++)
        o = _tAppend(o, "%s{\"x\":%d,\"segs\":%d}",
            i ? "," : "", (int)weeds[i].baseX, weeds[i].segs);
    o = _tAppend(o, "],\"hornwort\":[");
    for (int i = 0; i < NUM_FG_HORNWORT; i++)
        o = _tAppend(o, "%s{\"x\":%d,\"segs\":%d}",
            i ? "," : "", (int)fgHornworts[i].baseX, fgHornworts[i].segs);
    o = _tAppend(o, "]}}");

    return o;
}

// Record a failed publish with a human-readable reason (called from the worker).
static void _telemetryFail(const char* reason) {
    telemetryEverTried.store(true);
    telemetryLastOk.store(false);
    telemetryFailCount.fetch_add(1);
    {
        std::lock_guard<std::mutex> lk(_telemetryErrMutex);
        snprintf(telemetryLastError, sizeof(telemetryLastError), "%s", reason);
    }
    Serial.printf("Telemetry post failed: %s\n", reason);
}

// Record a successful publish (called from the worker).
static void _telemetryOk() {
    telemetryEverTried.store(true);
    telemetryLastOk.store(true);
    telemetryFailCount.store(0);
    std::lock_guard<std::mutex> lk(_telemetryErrMutex);
    telemetryLastError[0] = '\0';
}

// Performs one blocking POST of the current _telemetryBuf snapshot.
static void _telemetryPost() {
    if (!_wifiEnsureConnected()) { _telemetryFail("WiFi not connected"); return; }

    String url = String(TELEMETRY_HOST);
    WiFiClient client;
    HTTPClient http;
    if (!http.begin(client, url)) { _telemetryFail("begin() failed"); return; }
    http.addHeader("Content-Type", "application/json");
    http.addHeader("X-Api-Key", TELEMETRY_API_KEY);
    http.setConnectTimeout(3000);
    http.setTimeout(5000);
    int code = http.POST((uint8_t*)_telemetryBuf, (size_t)_telemetryBufLen);
    if (code >= 200 && code < 300) _telemetryOk();
    else if (code <= 0)            _telemetryFail(http.errorToString(code).c_str());
    else { char b[24]; snprintf(b, sizeof(b), "HTTP %d", code); _telemetryFail(b); }
    http.end();
}

// Worker task (pinned to core 0): waits for a snapshot, POSTs it off the render
// thread, then marks itself idle. The render loop won't overwrite _telemetryBuf
// while _telemetryBusy is true, so no lock is needed on the buffer.
static void _telemetryTask(void*) {
    for (;;) {
        ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
        _telemetryPost();
        _telemetryBusy.store(false);
    }
}

static void telemetryInit() {
    if (!_telemetryTaskHandle) {
        // Core 0; the Arduino loop runs on core 1. 8 KB stack covers plain-HTTP
        // HTTPClient (the 12 KB body lives in the static buffer, not the stack).
        xTaskCreatePinnedToCore(_telemetryTask, "telemetry", 8192, nullptr, 1,
                                &_telemetryTaskHandle, 0);
    }
    if (telemetryEnabled && TELEMETRY_HOST[0] != '\0')
        Serial.printf("Telemetry: enabled -> %s as '%s' every %d ms\n",
                      TELEMETRY_HOST, TELEMETRY_AQUARIUM_ID, TELEMETRY_INTERVAL_MS);
}

// Call once per loop(); rate-limited internally by TELEMETRY_INTERVAL_MS.
// Non-blocking: builds the snapshot on the loop thread and, only when the worker
// is idle, hands it over. If a previous POST is still in flight, this interval
// is skipped (latest-wins) rather than blocking or queueing.
static void telemetryUpdate() {
    if (!telemetryEnabled || TELEMETRY_HOST[0] == '\0') return;
    uint32_t now = millis();
    if (now - _lastTelemetryMs < (uint32_t)TELEMETRY_INTERVAL_MS) return;
    _lastTelemetryMs = now;

    if (_telemetryBusy.load()) return;          // worker still sending — skip
    _telemetryBufLen = _buildTelemetryJson();   // build on this (loop) thread
    _telemetryBusy.store(true);
    if (_telemetryTaskHandle) xTaskNotifyGive(_telemetryTaskHandle);
    else _telemetryBusy.store(false);
}

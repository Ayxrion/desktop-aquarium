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
static char _telemetryBuf[12288];

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

static void telemetryInit() {
    if (TELEMETRY_ENABLED && TELEMETRY_HOST[0] != '\0')
        Serial.printf("Telemetry: enabled -> %s/api/telemetry as '%s' every %d ms\n",
                      TELEMETRY_HOST, TELEMETRY_AQUARIUM_ID, TELEMETRY_INTERVAL_MS);
}

// Call once per loop(); rate-limited internally by TELEMETRY_INTERVAL_MS.
static void telemetryUpdate() {
    if (!TELEMETRY_ENABLED || TELEMETRY_HOST[0] == '\0') return;
    uint32_t now = millis();
    if (now - _lastTelemetryMs < (uint32_t)TELEMETRY_INTERVAL_MS) return;
    _lastTelemetryMs = now;

    if (!_wifiEnsureConnected()) return;   // reuses weather.h's connection helper

    int len = _buildTelemetryJson();

    String url = String(TELEMETRY_HOST) + "/api/telemetry";
    WiFiClient client;
    HTTPClient http;
    if (http.begin(client, url)) {
        http.addHeader("Content-Type", "application/json");
        http.addHeader("X-Api-Key", TELEMETRY_API_KEY);
        http.setTimeout(5000);
        int code = http.POST((uint8_t*)_telemetryBuf, (size_t)len);
        if (code <= 0)
            Serial.printf("Telemetry post failed: %s\n", http.errorToString(code).c_str());
        http.end();
    }
}

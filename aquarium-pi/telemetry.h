#pragma once
// Periodic aquarium telemetry publisher (Raspberry Pi / libcurl variant).
//
// POSTs a JSON snapshot of the whole tank (weather, time-of-day, fish, snail,
// starfish, boat, flakes, plant layout) to a configured web server. Mirrors the
// libcurl pattern in weather.h, but does an HTTP POST instead of a GET.
//
// Include this AFTER the aquarium globals (fish[], isFishActive, fishColor,
// snail, starfish, boat, flakes, plant arrays, weather/daynight state) are
// declared — it references them directly. In main.cpp it is included just
// before setup().
//
// Configure in wifi_config.h (all optional; telemetry is off unless enabled):
//   #define TELEMETRY_ENABLED      1
//   #define TELEMETRY_HOST         "http://192.168.1.215/aquarium"
//   #define TELEMETRY_API_KEY      "change-me"
//   #define TELEMETRY_AQUARIUM_ID  "living-room"
//   #define TELEMETRY_INTERVAL_MS  1000

#include <curl/curl.h>
#include <string>
#include <cstdio>
#include <cstdint>
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
#define TELEMETRY_AQUARIUM_ID "pi-aquarium"
#endif
#ifndef TELEMETRY_INTERVAL_MS
#define TELEMETRY_INTERVAL_MS 1000
#endif

static uint32_t _lastTelemetryMs = 0;

static size_t _telemetryDiscard(void*, size_t sz, size_t n, void*) { return sz * n; }

static const char* _weatherName(int c) {
    static const char* N[] = { "SUNNY", "PARTLY_CLOUDY", "CLOUDY", "RAINY",
                               "STORMY", "SNOWY", "FOGGY" };
    return (c >= 0 && c < 7) ? N[c] : "UNKNOWN";
}

// Builds the telemetry JSON snapshot from the live globals.
static std::string _buildTelemetryJson() {
    std::string j;
    j.reserve(8192);
    char tmp[320];

    int wc = (int)currentWeather;
    snprintf(tmp, sizeof(tmp),
        "{\"aquarium_id\":\"%s\",\"platform\":\"pi\",\"fw_version\":\"%s\","
        "\"uptime_ms\":%u,\"tick\":%d,"
        "\"screen\":{\"w\":%d,\"h\":%d,\"tank_top\":%d},"
        "\"weather\":{\"condition\":%d,\"name\":\"%s\",\"override\":%s},"
        "\"time\":{\"day_progress\":%.4f,\"mode\":\"%s\"},"
        "\"counts\":{\"pair\":%d,\"school\":%d,\"school2\":%d,\"angel\":%d},",
        TELEMETRY_AQUARIUM_ID, FIRMWARE_VERSION,
        (unsigned)millis(), (int)tick,
        SCREEN_W, SCREEN_H, TANK_TOP,
        wc, _weatherName(wc), (weatherOverrideIdx >= 0) ? "true" : "false",
        getDayProgress(), (currentTimeMode == TIME_FAST) ? "FAST" : "REAL",
        numPair, numSchool, numSchool2, numAngel);
    j += tmp;

    // Fish
    j += "\"fish\":[";
    bool first = true;
    for (int i = 0; i < MAX_FISH; i++) {
        if (!isFishActive(i)) continue;
        Fish& f = fish[i];
        snprintf(tmp, sizeof(tmp),
            "%s{\"x\":%d,\"y\":%d,\"z\":%.3f,\"type\":%d,\"facing_right\":%s,"
            "\"color\":%u,\"going_for_food\":%s,\"chasing\":%s}",
            first ? "" : ",",
            (int)f.x, (int)f.y, f.z, (int)f.type,
            f.facingRight ? "true" : "false",
            (unsigned)fishColor(i),
            f.goingForFood ? "true" : "false",
            f.chasing ? "true" : "false");
        j += tmp;
        first = false;
    }
    j += "],";

    // Food flakes (active only)
    j += "\"flakes\":[";
    first = true;
    for (int i = 0; i < MAX_FLAKES; i++) {
        if (!flakes[i].active) continue;
        snprintf(tmp, sizeof(tmp), "%s{\"x\":%d,\"y\":%d,\"color\":%u}",
            first ? "" : ",", (int)flakes[i].x, (int)flakes[i].y,
            (unsigned)FLAKE_COLS[flakes[i].colorIdx]);
        j += tmp;
        first = false;
    }
    j += "],";

    // Snail / starfish / boat
    snprintf(tmp, sizeof(tmp),
        "\"snail\":{\"x\":%d,\"facing_right\":%s},"
        "\"starfish\":{\"x\":%d,\"facing_right\":%s},"
        "\"boat\":{\"active\":%s,\"x\":%d},",
        (int)snail.x, snail.facingRight ? "true" : "false",
        (int)starfish.x, starfish.facingRight ? "true" : "false",
        boat.active ? "true" : "false", (int)boat.x);
    j += tmp;

    // Plant layout (near-static decor)
    j += "\"plants\":{\"bg\":[";
    for (int i = 0; i < NUM_BG_PLANTS; i++) {
        snprintf(tmp, sizeof(tmp), "{\"x\":%d,\"segs\":%d,\"type\":%d}",
            (int)bgPlants[i].baseX, bgPlants[i].segs, bgPlants[i].type);
        if (i) j += ",";
        j += tmp;
    }
    j += "],\"weeds\":[";
    for (int i = 0; i < NUM_WEEDS; i++) {
        snprintf(tmp, sizeof(tmp), "{\"x\":%d,\"segs\":%d}",
            (int)weeds[i].baseX, weeds[i].segs);
        if (i) j += ",";
        j += tmp;
    }
    j += "],\"hornwort\":[";
    for (int i = 0; i < NUM_FG_HORNWORT; i++) {
        snprintf(tmp, sizeof(tmp), "{\"x\":%d,\"segs\":%d}",
            (int)fgHornworts[i].baseX, fgHornworts[i].segs);
        if (i) j += ",";
        j += tmp;
    }
    j += "]}}";

    return j;
}

static void _postTelemetry(const std::string& body) {
    CURL* curl = curl_easy_init();
    if (!curl) return;

    std::string url = std::string(TELEMETRY_HOST) + "/api/telemetry";
    std::string keyHeader = std::string("X-Api-Key: ") + TELEMETRY_API_KEY;

    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, "Content-Type: application/json");
    headers = curl_slist_append(headers, keyHeader.c_str());

    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body.c_str());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, (long)body.size());
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 5L);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, _telemetryDiscard);

    CURLcode res = curl_easy_perform(curl);
    if (res != CURLE_OK)
        printf("Telemetry post: %s\n", curl_easy_strerror(res));

    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);
}

static void telemetryInit() {
    if (TELEMETRY_ENABLED && TELEMETRY_HOST[0] != '\0')
        printf("Telemetry: enabled → %s/api/telemetry as '%s' every %d ms\n",
               TELEMETRY_HOST, TELEMETRY_AQUARIUM_ID, TELEMETRY_INTERVAL_MS);
}

// Call once per loop(); rate-limited internally by TELEMETRY_INTERVAL_MS.
static void telemetryUpdate() {
    if (!TELEMETRY_ENABLED || TELEMETRY_HOST[0] == '\0') return;
    uint32_t now = millis();
    if (now - _lastTelemetryMs < (uint32_t)TELEMETRY_INTERVAL_MS) return;
    _lastTelemetryMs = now;
    _postTelemetry(_buildTelemetryJson());
}

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
#include <cstring>
#include <cstdlib>
#include <thread>
#include <mutex>
#include <atomic>
#include <condition_variable>
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

// ── Runtime state ─────────────────────────────────────────────────────────────
// telemetryEnabled is touched only by the main/render thread (menu + draw).
// The result fields are written by the background POST thread and read by the
// render thread, so they're atomic; the error string is guarded by a mutex.
static bool                  telemetryEnabled   = (TELEMETRY_ENABLED != 0);
static std::atomic<bool>     telemetryLastOk{true};    // most recent POST result
static std::atomic<bool>     telemetryEverTried{false};// any POST attempted yet?
static std::atomic<int>      telemetryFailCount{0};    // consecutive failures
static char                  telemetryLastError[80] = "";
static std::mutex            _telemetryErrMutex;

// True when publishing is on but recent posts are failing — drives the failure
// indicator in the tank view. Safe to call from the render thread.
static inline bool telemetryHasError() {
    return telemetryEnabled && telemetryEverTried.load() && !telemetryLastOk.load();
}

// Copy the last error reason out under lock (for the render thread).
static inline void telemetryGetError(char* out, size_t n) {
    std::lock_guard<std::mutex> lk(_telemetryErrMutex);
    snprintf(out, n, "%s", telemetryLastError);
}

// ── Background publish thread ─────────────────────────────────────────────────
// The libcurl POST blocks (DNS/connect/timeout), which would freeze the render
// loop when the server is unreachable. So the main thread only builds the JSON
// snapshot (fast) and hands it to this worker; the network I/O happens here.
static std::thread              _telemetryThread;
static std::mutex               _telemetryQueueMutex;
static std::condition_variable  _telemetryCv;
static std::string              _telemetryPending;     // latest snapshot to send
static bool                     _telemetryHasPending = false;
static bool                     _telemetryShutdown   = false;
static bool                     _telemetryStarted    = false;

static size_t _telemetryDiscard(void*, size_t sz, size_t n, void*) { return sz * n; }

// ── Fish names (pushed down via the telemetry POST response) ──────────────────
// The server can't reach the device (no inbound firewall), so it returns the
// current names in the POST response body as `id\tname` lines. We apply them
// here (worker thread) and the renderer draws them above each fish.
#define TELEMETRY_NAME_LEN 24
static char        telemetryFishName[MAX_FISH][TELEMETRY_NAME_LEN] = {};
static std::mutex  _telemetryNameMutex;

// Copy a fish's name out under lock (for the render thread). Empty if unnamed.
static inline void telemetryGetFishName(int id, char* out, size_t n) {
    out[0] = '\0';
    if (id < 0 || id >= MAX_FISH) return;
    std::lock_guard<std::mutex> lk(_telemetryNameMutex);
    snprintf(out, n, "%s", telemetryFishName[id]);
}

// Parse the `id\tname` response body and replace the name table.
static void _telemetryApplyNames(const char* body) {
    std::lock_guard<std::mutex> lk(_telemetryNameMutex);
    for (int i = 0; i < MAX_FISH; i++) telemetryFishName[i][0] = '\0';
    const char* p = body;
    while (p && *p) {
        const char* tab = strchr(p, '\t');
        const char* nl  = strchr(p, '\n');
        if (!tab || (nl && tab > nl)) { p = nl ? nl + 1 : nullptr; continue; }
        int id = atoi(p);
        const char* nameStart = tab + 1;
        size_t nameLen = nl ? (size_t)(nl - nameStart) : strlen(nameStart);
        if (id >= 0 && id < MAX_FISH) {
            if (nameLen >= TELEMETRY_NAME_LEN) nameLen = TELEMETRY_NAME_LEN - 1;
            memcpy(telemetryFishName[id], nameStart, nameLen);
            telemetryFishName[id][nameLen] = '\0';
        }
        p = nl ? nl + 1 : nullptr;
    }
}

// Capture the (small) response body so we can parse names from it.
struct _TelemetryResp { char data[MAX_FISH * 40]; size_t len; };
static size_t _telemetryCapture(void* ptr, size_t sz, size_t n, void* ud) {
    _TelemetryResp* r = static_cast<_TelemetryResp*>(ud);
    size_t bytes = sz * n;
    if (r->len + bytes < sizeof(r->data) - 1) {
        memcpy(r->data + r->len, ptr, bytes);
        r->len += bytes;
        r->data[r->len] = '\0';
    }
    return bytes;
}

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
        "\"uptime_ms\":%u,\"tick\":%d,\"frame_ms\":%d,"
        "\"screen\":{\"w\":%d,\"h\":%d,\"tank_top\":%d},"
        "\"weather\":{\"condition\":%d,\"name\":\"%s\",\"override\":%s},"
        "\"time\":{\"day_progress\":%.4f,\"mode\":\"%s\"},"
        "\"counts\":{\"pair\":%d,\"school\":%d,\"school2\":%d,\"angel\":%d},",
        TELEMETRY_AQUARIUM_ID, FIRMWARE_VERSION,
        (unsigned)millis(), (int)tick, FRAME_MS,
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
            "%s{\"id\":%d,\"x\":%d,\"y\":%d,\"z\":%.3f,"
            "\"vx\":%.2f,\"vy\":%.2f,\"vz\":%.4f,"
            "\"tx\":%d,\"ty\":%d,"
            "\"type\":%d,\"facing_right\":%s,"
            "\"color\":%u,\"going_for_food\":%s,\"chasing\":%s}",
            first ? "" : ",", i,
            (int)f.x, (int)f.y, f.z,
            f.vx, f.vy, f.vz,
            (int)f.tx, (int)f.ty,
            (int)f.type,
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
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 3L);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 5L);
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);   // required for use off the main thread

    _TelemetryResp resp = {};
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, _telemetryCapture);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &resp);

    CURLcode res = curl_easy_perform(curl);
    long httpCode = 0;
    if (res == CURLE_OK)
        curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &httpCode);

    bool ok = (res == CURLE_OK && httpCode >= 200 && httpCode < 300);
    if (ok) _telemetryApplyNames(resp.data);   // server returned the name table
    telemetryEverTried.store(true);
    telemetryLastOk.store(ok);
    if (ok) {
        telemetryFailCount.store(0);
        std::lock_guard<std::mutex> lk(_telemetryErrMutex);
        telemetryLastError[0] = '\0';
    } else {
        telemetryFailCount.fetch_add(1);
        std::lock_guard<std::mutex> lk(_telemetryErrMutex);
        if (res != CURLE_OK)
            snprintf(telemetryLastError, sizeof(telemetryLastError), "%s", curl_easy_strerror(res));
        else
            snprintf(telemetryLastError, sizeof(telemetryLastError), "HTTP %ld", httpCode);
        printf("Telemetry post failed: %s\n", telemetryLastError);
    }

    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);
}

// Worker loop: waits for a snapshot, POSTs it (blocking here, off the render
// thread). If a newer snapshot arrives while a POST is in flight, only the
// latest is kept — no backlog builds up when the server is slow/unreachable.
static void _telemetryWorker() {
    for (;;) {
        std::string payload;
        {
            std::unique_lock<std::mutex> lk(_telemetryQueueMutex);
            _telemetryCv.wait(lk, [] { return _telemetryHasPending || _telemetryShutdown; });
            if (_telemetryShutdown) return;
            payload.swap(_telemetryPending);
            _telemetryHasPending = false;
        }
        _postTelemetry(payload);
    }
}

static void telemetryInit() {
    // curl_global_init must run once on the main thread before the worker uses
    // libcurl (the lazy init inside curl_easy_init is not thread-safe).
    curl_global_init(CURL_GLOBAL_DEFAULT);
    if (!_telemetryStarted) {
        _telemetryThread = std::thread(_telemetryWorker);
        _telemetryThread.detach();   // runs for process lifetime; avoids join-at-exit terminate
        _telemetryStarted = true;
    }
    if (telemetryEnabled && TELEMETRY_HOST[0] != '\0')
        printf("Telemetry: enabled → %s/api/telemetry as '%s' every %d ms\n",
               TELEMETRY_HOST, TELEMETRY_AQUARIUM_ID, TELEMETRY_INTERVAL_MS);
}

// Call once per loop(); rate-limited internally by TELEMETRY_INTERVAL_MS.
// Non-blocking: builds the JSON snapshot on the caller (render) thread, then
// hands it to the background worker for the actual network POST.
static void telemetryUpdate() {
    if (!telemetryEnabled || TELEMETRY_HOST[0] == '\0') return;
    uint32_t now = millis();
    if (now - _lastTelemetryMs < (uint32_t)TELEMETRY_INTERVAL_MS) return;
    _lastTelemetryMs = now;

    std::string json = _buildTelemetryJson();   // reads live state on this thread
    {
        std::lock_guard<std::mutex> lk(_telemetryQueueMutex);
        _telemetryPending.swap(json);            // replace any unsent snapshot
        _telemetryHasPending = true;
    }
    _telemetryCv.notify_one();
}

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
// Stable per-DEVICE id so the server can register this physical unit as a first-class
// device (separate from the aquarium it currently shows). Set per-board in wifi_config.h.
#ifndef TELEMETRY_DEVICE_ID
#define TELEMETRY_DEVICE_ID "pi-device-1"
#endif
#ifndef TELEMETRY_INTERVAL_MS
#define TELEMETRY_INTERVAL_MS 1000
#endif

// Which aquarium this device is currently showing. Mutable at runtime: the dashboard
// can reassign the device to another tank via a !SWITCHAQ:<id> directive, after which
// the device re-bootstraps and POSTs under the new id. Seeded from the compile-time id.
static char activeAquariumId[64] = TELEMETRY_AQUARIUM_ID;
static char _pendingSwitchAq[64] = "";   // set by the control parser; applied on the render thread

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

// ── Profile-conflict state (server-vs-local composition) ──────────────────────
// The server is the source of truth for the aquarium *profile* (fish counts/
// types/colors + plant layout). If the local tank diverges, the device shows an
// on-screen prompt to keep local or adopt the server's saved profile. Flags set
// by the POST worker are consumed on the main (render) thread.
static char              _bootstrapJson[49152] = "";    // last bootstrap body (matched to _BootstrapResp)
static std::atomic<bool> telemetryConflictPending{false}; // → draw the modal
static std::atomic<bool> _telemetryRestoreReq{false};     // worker→main: rebuild
static std::atomic<bool> _telemetryConflictHint{false};   // worker→main: re-check
static int telemetrySrvPair = 0, telemetrySrvSchool = 0,
           telemetrySrvSchool2 = 0, telemetrySrvAngel = 0; // server counts (modal)

// ── Dashboard control directives (pushed via the telemetry POST response) ─────
// The web dashboard can't reach the device directly, so the server forwards its
// control actions as `!`-prefixed lines in the POST response. They're parsed here
// on the POST worker into atomic request state, and applied on the main thread by
// telemetryApplyControls() (defined in main.cpp, where dropFood()/addFish()/the
// weather + time globals are all in scope).
static std::atomic<int> _ctrlWeatherReq{-2};      // -2 none, -1 auto, 0..6 condition
static std::atomic<int> _ctrlTimeReq{-1};         // -1 none, 0 REAL, 1 FAST
static std::atomic<int> _ctrlFeedReq{0};          // pending food drops
static std::atomic<int> _ctrlFishAddReq[5];       // pending adds per fish type 0..4
static std::atomic<int> _ctrlFishDelReq[5];       // pending removes per fish type 0..4
// ── Career game directives ──
static std::atomic<int> _ctrlModeReq{-1};          // -1 none, 0 creative, 1 career
static std::atomic<int> _ctrlBuyFishReq[5];        // shop fish purchases per type
static std::atomic<int> _ctrlBuyFoodReq{0};        // shop food purchases
static std::atomic<int> _ctrlBuySnailReq{0};       // shop coin-collector snail purchases
#define CTRL_CATCH_MAX 24
static std::atomic<uint32_t> _ctrlCatchIds[CTRL_CATCH_MAX]; // wanderer/loot ids to grab
static std::atomic<int> _ctrlCatchCount{0};
#define CTRL_SELL_MAX 16
static std::atomic<int> _ctrlSellFishIds[CTRL_SELL_MAX];    // fish slot indices to sell
static std::atomic<int> _ctrlSellFishCount{0};

// Parse the control directives out of a POST response body into the atomics above.
// Each command type appears at most once per response (the server collapses them),
// so a single substring match per token is sufficient.
static void _telemetryParseControls(const char* body) {
    const char* d;
    // !SWITCHAQ:<id> — dashboard reassigned this device to another aquarium. Stash the id;
    // the render thread applies it (re-bootstrap) via telemetryApplyAquariumSwitch().
    if ((d = strstr(body, "!SWITCHAQ:")) != nullptr) {
        d += 10;
        size_t i = 0;
        while (d[i] && d[i] != '\n' && d[i] != '\t' && i < sizeof(_pendingSwitchAq) - 1) { _pendingSwitchAq[i] = d[i]; i++; }
        _pendingSwitchAq[i] = '\0';
    }
    if ((d = strstr(body, "!WEATHER:")) != nullptr) _ctrlWeatherReq.store(atoi(d + 9));
    if ((d = strstr(body, "!TIME:"))    != nullptr) _ctrlTimeReq.store(atoi(d + 6));
    if ((d = strstr(body, "!FEED:"))    != nullptr) _ctrlFeedReq.fetch_add(atoi(d + 6));
    if ((d = strstr(body, "!MODE:"))     != nullptr) _ctrlModeReq.store(atoi(d + 6));
    if ((d = strstr(body, "!BUYFOOD:"))  != nullptr) _ctrlBuyFoodReq.fetch_add(atoi(d + 9));
    if ((d = strstr(body, "!BUYSNAIL:")) != nullptr) _ctrlBuySnailReq.fetch_add(atoi(d + 10));
    for (int t = 0; t < 5; t++) {
        char tok[16];
        snprintf(tok, sizeof(tok), "!FISHADD:%d:", t);
        if ((d = strstr(body, tok)) != nullptr) _ctrlFishAddReq[t].fetch_add(atoi(d + strlen(tok)));
        snprintf(tok, sizeof(tok), "!FISHDEL:%d:", t);
        if ((d = strstr(body, tok)) != nullptr) _ctrlFishDelReq[t].fetch_add(atoi(d + strlen(tok)));
        snprintf(tok, sizeof(tok), "!BUYFISH:%d:", t);
        if ((d = strstr(body, tok)) != nullptr) _ctrlBuyFishReq[t].fetch_add(atoi(d + strlen(tok)));
    }
    // !CATCH:<id,id,…> — append ids to the catch queue (drained on the main thread).
    if ((d = strstr(body, "!CATCH:")) != nullptr) {
        const char* p = d + 7;
        const char* nl = strchr(p, '\n');
        while (*p && p != nl) {
            int idx = _ctrlCatchCount.load();
            if (idx >= CTRL_CATCH_MAX) break;
            _ctrlCatchIds[idx].store((uint32_t)strtoul(p, nullptr, 10));
            _ctrlCatchCount.store(idx + 1);
            const char* c = strchr(p, ',');
            if (!c || (nl && c > nl)) break;
            p = c + 1;
        }
    }
    // !SELLFISH:<slot,slot,…> — append fish slot indices to sell (drained on main thread).
    if ((d = strstr(body, "!SELLFISH:")) != nullptr) {
        const char* p = d + 10;
        const char* nl = strchr(p, '\n');
        while (*p && p != nl) {
            int cnt = _ctrlSellFishCount.load();
            if (cnt >= CTRL_SELL_MAX) break;
            _ctrlSellFishIds[cnt].store(atoi(p));
            _ctrlSellFishCount.store(cnt + 1);
            const char* c = strchr(p, ',');
            if (!c || (nl && c > nl)) break;
            p = c + 1;
        }
    }
}

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
    char tmp[384];

    int wc = (int)currentWeather;
    snprintf(tmp, sizeof(tmp),
        "{\"aquarium_id\":\"%s\",\"device_id\":\"%s\",\"platform\":\"pi\",\"fw_version\":\"%s\","
        "\"uptime_ms\":%u,\"tick\":%d,\"frame_ms\":%d,"
        "\"screen\":{\"w\":%d,\"h\":%d,\"tank_top\":%d},"
        "\"weather\":{\"condition\":%d,\"name\":\"%s\",\"override\":%s},"
        "\"time\":{\"day_progress\":%.4f,\"mode\":\"%s\"},"
        "\"counts\":{\"pair\":%d,\"school\":%d,\"school2\":%d,\"angel\":%d,\"salmon\":%d},",
        activeAquariumId, TELEMETRY_DEVICE_ID, FIRMWARE_VERSION,
        (unsigned)millis(), (int)tick, FRAME_MS,
        SCREEN_W, SCREEN_H, TANK_TOP,
        wc, _weatherName(wc), (weatherOverrideIdx >= 0) ? "true" : "false",
        getDayProgress(), (currentTimeMode == TIME_FAST) ? "FAST" : "REAL",
        numPair, numSchool, numSchool2, numAngel, numSalmon);
    j += tmp;

    // Fish
    j += "\"fish\":[";
    bool first = true;
    for (int i = 0; i < MAX_FISH; i++) {
        if (!isFishActive(i)) continue;
        Fish& f = fish[i];
        snprintf(tmp, sizeof(tmp),
            "%s{\"id\":%d,\"x\":%.1f,\"y\":%.1f,\"z\":%.3f,"
            "\"vx\":%.2f,\"vy\":%.2f,\"vz\":%.4f,"
            "\"tx\":%.1f,\"ty\":%.1f,\"tz\":%.3f,\"wander_cd\":%d,"
            "\"type\":%d,\"facing_right\":%s,"
            "\"color\":%u,\"going_for_food\":%s,\"chasing\":%s,"
            "\"age\":%d,\"scale\":%.3f,\"xp\":%d,\"fish_luck\":%.3f}",
            first ? "" : ",", i,
            f.x, f.y, f.z,
            f.vx, f.vy, f.vz,
            f.tx, f.ty, f.tz, (int)f.wanderCD,
            (int)f.type,
            f.facingRight ? "true" : "false",
            (unsigned)fishColor(i),
            f.goingForFood ? "true" : "false",
            f.chasing ? "true" : "false",
            (int)f.age, fishScale(f), (int)f.xp, f.fishLuck);
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
    j += "]},";

    // Career game state (+ feeding schedule: fed/meals today, hunger, overfeeding)
    int mealbits = 0;
    for (int i = 0; i < MEALS_PER_DAY; i++) if (mealFed[i]) mealbits |= (1 << i);
    snprintf(tmp, sizeof(tmp),
        "\"game\":{\"mode\":\"%s\",\"coins\":%d,\"shells\":%d,\"food\":%d,\"luck\":%.3f,"
        "\"fed\":%d,\"meals\":%d,\"hungry\":%d,\"overfed\":%d,\"mealbits\":%d},",
        (gameMode == MODE_CAREER) ? "career" : "creative",
        gameCoins, gameShells, gameFood, tankLuck(),
        mealsToday, MEALS_PER_DAY, tankHungry ? 1 : 0, overfeedToday, mealbits);
    j += tmp;

    // Wandering fish (catchable)
    j += "\"wanderers\":[";
    first = true;
    for (int i = 0; i < MAX_WANDER; i++) {
        if (!wanderers[i].active) continue;
        snprintf(tmp, sizeof(tmp),
            "%s{\"id\":%u,\"x\":%.1f,\"y\":%.1f,\"vx\":%.3f,\"bob\":%.3f,"
            "\"type\":%d,\"color\":%u,\"facing_right\":%s}",
            first ? "" : ",", wanderers[i].id, wanderers[i].x, wanderers[i].y,
            wanderers[i].vx, wanderers[i].bob,
            wanderers[i].type, (unsigned)wanderers[i].color,
            wanderers[i].facingRight ? "true" : "false");
        j += tmp; first = false;
    }
    j += "],\"loot\":[";
    first = true;
    for (int i = 0; i < MAX_LOOT; i++) {
        if (!loot[i].active) continue;
        snprintf(tmp, sizeof(tmp),
            "%s{\"id\":%u,\"kind\":\"%s\",\"x\":%.1f,\"y\":%.1f,\"vy\":%.2f,"
            "\"landed\":%s,\"ttl\":%d,\"tier\":%d}",
            first ? "" : ",", loot[i].id, loot[i].kind == 0 ? "coin" : "shell",
            loot[i].x, loot[i].y, loot[i].vy,
            loot[i].landed ? "true" : "false", loot[i].ttl, loot[i].tier);
        j += tmp; first = false;
    }
    j += "],\"snails\":[";
    first = true;
    for (int i = 0; i < numSnails; i++) {
        if (!coinSnails[i].active) continue;
        snprintf(tmp, sizeof(tmp), "%s{\"x\":%.1f,\"spd\":%.3f,\"facing_right\":%s}",
            first ? "" : ",", coinSnails[i].x, coinSnails[i].spd,
            coinSnails[i].facingRight ? "true" : "false");
        j += tmp; first = false;
    }
    j += "]}";

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
    if (ok) {
        // Control directives (tab-less lines the name parser ignores).
        if (strstr(resp.data, "!RESTORE"))       _telemetryRestoreReq.store(true);
        else if (strstr(resp.data, "!CONFLICT")) _telemetryConflictHint.store(true);
        _telemetryParseControls(resp.data);     // dashboard weather/time/fish/feed
        _telemetryApplyNames(resp.data);        // server returned the name table
    }
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

// ── Bootstrap (on-boot state restore) ────────────────────────────────────────
// GETs /api/aquariums/:id/bootstrap and applies the server's last-known fish
// positions, velocities, wander targets, and names to the live fish[] array.
// Called synchronously from telemetryInit() before the render loop starts.

struct _BootstrapResp { char data[49152]; size_t len; };  // 48 KB — MAX_FISH=56 × ~300B/fish ≈ 17 KB; 48 KB leaves room for full career state
static size_t _bootstrapCapture(void* ptr, size_t sz, size_t n, void* ud) {
    _BootstrapResp* r = static_cast<_BootstrapResp*>(ud);
    size_t bytes = sz * n;
    if (r->len + bytes < sizeof(r->data) - 1) {
        memcpy(r->data + r->len, ptr, bytes);
        r->len += bytes;
        r->data[r->len] = '\0';
    }
    return bytes;
}

// Tiny helper: find `"key":value` (number) in a JSON object starting at p.
static bool _jGetInt(const char* p, const char* key, int* out) {
    char needle[64]; snprintf(needle, sizeof(needle), "\"%s\":", key);
    const char* f = strstr(p, needle);
    if (!f) return false;
    f += strlen(needle);
    while (*f == ' ') f++;
    *out = atoi(f);
    return true;
}
static bool _jGetFloat(const char* p, const char* key, float* out) {
    char needle[64]; snprintf(needle, sizeof(needle), "\"%s\":", key);
    const char* f = strstr(p, needle);
    if (!f) return false;
    f += strlen(needle);
    while (*f == ' ') f++;
    *out = (float)atof(f);
    return true;
}
static bool _jGetBool(const char* p, const char* key, bool* out) {
    char needle[64]; snprintf(needle, sizeof(needle), "\"%s\":", key);
    const char* f = strstr(p, needle);
    if (!f) return false;
    f += strlen(needle);
    while (*f == ' ') f++;
    *out = (*f == 't');
    return true;
}
// Returns pointer to the value string content (in-place) and its length.
static bool _jGetStr(const char* p, const char* key, const char** start, size_t* len) {
    char needle[64]; snprintf(needle, sizeof(needle), "\"%s\":\"", key);
    const char* f = strstr(p, needle);
    if (!f) return false;
    f += strlen(needle);
    const char* end = strchr(f, '"');
    if (!end) return false;
    *start = f; *len = (size_t)(end - f);
    return true;
}

// Canonical profile signature of the LIVE local tank. Must match the server's
// profileSig() byte-for-byte (aquarium-web/src/store.js).
static std::string _localProfileSig() {
    // Composition only (per-type fish counts) — must match the server's
    // profileSig() byte-for-byte (aquarium-web/src/store.js). Fish colors and the
    // plant layout were deliberately dropped: they're cosmetic and caused spurious
    // mismatches (reseeded plants on boot, device↔server color formatting drift).
    char tmp[48];
    snprintf(tmp, sizeof(tmp), "P:%d,%d,%d,%d,%d", numPair, numSchool, numSchool2, numAngel, numSalmon);
    return std::string(tmp);
}

// Copy each "{...}" object inside a JSON array (p at/before '[') into outObjs[].
static int _parseObjArray(const char* p, char outObjs[][256], int maxObjs) {
    const char* arr = strchr(p, '[');
    if (!arr) return 0;
    p = arr + 1;
    int count = 0;
    while (count < maxObjs) {
        const char* o   = strchr(p, '{');
        const char* end = strchr(p, ']');
        if (!o || (end && o > end)) break;
        int depth = 0; const char* e = o;
        while (*e) { if (*e == '{') depth++; else if (*e == '}') { if (--depth == 0) { e++; break; } } e++; }
        size_t len = (size_t)(e - o); if (len >= 256) len = 255;
        memcpy(outObjs[count], o, len); outObjs[count][len] = '\0';
        count++; p = e;
    }
    return count;
}

// Blocking GET of /bootstrap into _bootstrapJson. Returns true on HTTP 200.
static bool _fetchBootstrap() {
    if (TELEMETRY_HOST[0] == '\0') return false;
    std::string url = std::string(TELEMETRY_HOST)
        + "/api/aquariums/" + activeAquariumId + "/bootstrap";
    std::string keyHeader = std::string("X-Api-Key: ") + TELEMETRY_API_KEY;
    CURL* curl = curl_easy_init();
    if (!curl) return false;
    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, keyHeader.c_str());
    _BootstrapResp resp = {};
    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, _bootstrapCapture);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &resp);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 5L);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 8L);
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
    CURLcode res = curl_easy_perform(curl);
    long httpCode = 0;
    if (res == CURLE_OK) curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &httpCode);
    bool ok = (res == CURLE_OK && httpCode == 200);
    if (ok) memcpy(_bootstrapJson, resp.data, resp.len + 1);
    else printf("Telemetry: bootstrap fetch failed (%s)\n",
                res != CURLE_OK ? curl_easy_strerror(res) : "non-200");
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);
    return ok;
}

static void _applyBootstrap(const char* json) {
    // Quick existence check
    if (!strstr(json, "\"exists\":true")) return;

    // Find the "fish":[ array
    const char* arrStart = strstr(json, "\"fish\":[");
    if (!arrStart) return;
    arrStart += 8; // skip past "fish":[

    const char* p = arrStart;
    while ((p = strchr(p, '{')) != nullptr) {
        // Find matching closing brace for this fish object
        int depth = 0; const char* end = p;
        while (*end) {
            if (*end == '{') depth++;
            else if (*end == '}') { if (--depth == 0) { end++; break; } }
            end++;
        }
        // Null-terminate a local copy of this fish object
        size_t objLen = (size_t)(end - p);
        if (objLen >= 512) { p = end; continue; }
        char obj[512]; memcpy(obj, p, objLen); obj[objLen] = '\0';

        int id = -1;
        if (!_jGetInt(obj, "id", &id) || id < 0 || id >= MAX_FISH || !isFishActive(id)) {
            p = end; continue;
        }
        Fish& f = fish[id];

        int iv; float fv; bool bv;
        if (_jGetInt(obj, "x",         &iv)) f.x        = (float)iv;
        if (_jGetInt(obj, "y",         &iv)) f.y        = (float)iv;
        if (_jGetFloat(obj, "vx",      &fv)) f.vx       = fv;
        if (_jGetFloat(obj, "vy",      &fv)) f.vy       = fv;
        if (_jGetInt(obj, "tx",        &iv)) f.tx       = (float)iv;
        if (_jGetInt(obj, "ty",        &iv)) f.ty       = (float)iv;
        if (_jGetInt(obj, "wander_cd", &iv)) f.wanderCD = (float)iv;
        if (_jGetBool(obj, "chasing",  &bv)) f.chasing  = bv;
        if (_jGetInt(obj, "age",       &iv)) f.age      = (float)iv;
        if (_jGetInt(obj, "xp",        &iv)) f.xp       = iv;
        if (_jGetFloat(obj, "fish_luck", &fv)) f.fishLuck = fv;

        const char* ns; size_t nl;
        if (_jGetStr(obj, "name", &ns, &nl) && nl > 0) {
            std::lock_guard<std::mutex> lk(_telemetryNameMutex);
            if (nl >= TELEMETRY_NAME_LEN) nl = TELEMETRY_NAME_LEN - 1;
            memcpy(telemetryFishName[id], ns, nl);
            telemetryFishName[id][nl] = '\0';
        }
        p = end;
    }
    printf("Telemetry: aquarium state restored from server\n");
}

// Set true once a server profile has been adopted, so setup() can skip its
// default tank seeding (which would otherwise reset restored fish ages to 0).
bool telemetryProfileLoaded = false;

// Rebuild the local tank to the server's saved profile (counts + plant layout),
// then overlay the saved fish positions/names. Main-thread only (mutates fish[]
// and the plant arrays that the render loop reads).
static void _applyServerProfile(const char* json) {
    if (!strstr(json, "\"exists\":true")) return;

    // 0) Career game state (mode + wallet) from the saved snapshot.
    const char* gp = strstr(json, "\"game\":");
    if (gp) {
        int v; const char* ms; size_t ml;
        if (_jGetStr(gp, "mode", &ms, &ml))
            gameMode = (ml == 6 && strncmp(ms, "career", 6) == 0) ? MODE_CAREER : MODE_CREATIVE;
        if (_jGetInt(gp, "coins",  &v)) gameCoins  = v;
        if (_jGetInt(gp, "shells", &v)) gameShells = v;
        if (_jGetInt(gp, "food",   &v)) gameFood   = v;
        // Restore today's feeding progress so reboot mid-day doesn't reset the schedule.
        if (_jGetInt(gp, "fed",     &v)) mealsToday    = v;
        if (_jGetInt(gp, "overfed", &v)) overfeedToday = v;
        if (_jGetInt(gp, "mealbits", &v))
            for (int i = 0; i < MEALS_PER_DAY; i++) mealFed[i] = (v >> i) & 1;
        feedSchedInit = false;   // re-sync the slot clock on the next tick (no spurious day-eval)
    }

    // 1) Fish composition from saved counts — rebuild via addFish (handles slots
    //    + pair partners), then positions get overlaid by _applyBootstrap below.
    const char* cp = strstr(json, "\"counts\":");
    int wantP = numPair, wantS = numSchool, wantS2 = numSchool2, wantA = numAngel, wantSa = numSalmon;
    if (cp) {
        int v;
        if (_jGetInt(cp, "pair",    &v)) wantP  = v;
        if (_jGetInt(cp, "school",  &v)) wantS  = v;
        if (_jGetInt(cp, "school2", &v)) wantS2 = v;
        if (_jGetInt(cp, "angel",   &v)) wantA  = v;
        if (_jGetInt(cp, "salmon",  &v)) wantSa = v;
    }
    numPair = numSchool = numSchool2 = numAngel = numSalmon = 0;
    for (int i = 0; i < wantP  && numPair    < MAX_PAIR;    i++) addFish(FISH_PAIR);
    for (int i = 0; i < wantS  && numSchool  < MAX_SCHOOL;  i++) addFish(FISH_SCHOOL);
    for (int i = 0; i < wantS2 && numSchool2 < MAX_SCHOOL2; i++) addFish(FISH_SCHOOL2);
    for (int i = 0; i < wantA  && numAngel   < MAX_ANGEL;   i++) addFish(FISH_ANGEL);
    for (int i = 0; i < wantSa && numSalmon  < MAX_SALMON;  i++) addFish(FISH_SALMON);

    // 2) Plant layout from the server (regenerate seaweed branches locally —
    //    they aren't part of the profile signature).
    const char* pl = strstr(json, "\"plants\":");
    if (pl) {
        char objs[16][256];
        const char* bg = strstr(pl, "\"bg\":");
        if (bg) {
            int nc = _parseObjArray(bg, objs, NUM_BG_PLANTS);
            for (int i = 0; i < nc; i++) {
                int x, sg, ty;
                if (_jGetInt(objs[i], "x", &x))     bgPlants[i].baseX = (uint16_t)x;
                if (_jGetInt(objs[i], "segs", &sg)) bgPlants[i].segs  = (uint8_t)sg;
                if (_jGetInt(objs[i], "type", &ty)) bgPlants[i].type  = (uint8_t)ty;
            }
        }
        const char* wd = strstr(pl, "\"weeds\":");
        if (wd) {
            int nc = _parseObjArray(wd, objs, NUM_WEEDS);
            for (int i = 0; i < nc; i++) {
                int x, sg;
                if (_jGetInt(objs[i], "x", &x))     weeds[i].baseX = (uint16_t)x;
                if (_jGetInt(objs[i], "segs", &sg)) weeds[i].segs  = (uint8_t)sg;
                weeds[i].numBranches = (uint8_t)(1 + random(0, 2));
                for (int b = 0; b < 2; b++) {
                    int span = weeds[i].segs > 3 ? weeds[i].segs - 3 : 1;
                    weeds[i].branchAt[b]   = (uint8_t)(2 + random(0, span));
                    weeds[i].branchSide[b] = (random(0, 2) == 0) ? 1 : -1;
                }
            }
        }
        const char* hw = strstr(pl, "\"hornwort\":");
        if (hw) {
            int nc = _parseObjArray(hw, objs, NUM_FG_HORNWORT);
            for (int i = 0; i < nc; i++) {
                int x, sg;
                if (_jGetInt(objs[i], "x", &x))     fgHornworts[i].baseX = (uint16_t)x;
                if (_jGetInt(objs[i], "segs", &sg)) fgHornworts[i].segs  = (uint8_t)sg;
            }
        }
    }

    // 2b) Coin-collector snails — a purchased, durable object, so restore them
    //     instead of letting a reboot wipe the player's investment. (Loot/wanderers
    //     are transient with short TTLs and are intentionally not restored.)
    numSnails = 0;
    for (int i = 0; i < MAX_SNAILS; i++) coinSnails[i].active = false;
    const char* snp = strstr(json, "\"snails\":");
    if (snp) {
        char sobjs[MAX_SNAILS][256];
        int nc = _parseObjArray(snp, sobjs, MAX_SNAILS);
        for (int i = 0; i < nc && numSnails < MAX_SNAILS; i++) {
            int x; float spd; bool fr;
            CoinSnail& s = coinSnails[numSnails];
            s.x           = _jGetInt(sobjs[i], "x", &x)              ? (float)x : frandr(80, SCREEN_W - 80);
            s.spd         = _jGetFloat(sobjs[i], "spd", &spd)        ? spd      : frandr(1.5f, 2.5f);
            s.facingRight = _jGetBool(sobjs[i], "facing_right", &fr) ? fr       : true;
            s.active      = true;
            numSnails++;
        }
    }

    // 3) Overlay the saved fish positions + names.
    _applyBootstrap(json);
    telemetryProfileLoaded = true;
    printf("Telemetry: rebuilt tank to server profile (pair %d school %d/%d angel %d)\n",
           numPair, numSchool, numSchool2, numAngel);
}

// Boot handshake: adopt the server's saved profile as the source of truth (so a
// fresh random tank doesn't spuriously conflict). Silent — no prompt.
static void telemetryBootstrap() {
    if (!telemetryEnabled || TELEMETRY_HOST[0] == '\0') return;
    if (_fetchBootstrap() && strstr(_bootstrapJson, "\"exists\":true"))
        _applyServerProfile(_bootstrapJson);
    else
        printf("Telemetry: no saved profile on server (keeping local tank)\n");
}

// Apply a pending !SWITCHAQ: point this device at a new aquarium and load its state.
// Call from the render thread (it rebuilds fish[] via the bootstrap restore).
static void telemetryApplyAquariumSwitch() {
    if (_pendingSwitchAq[0] == '\0') return;
    strncpy(activeAquariumId, _pendingSwitchAq, sizeof(activeAquariumId) - 1);
    activeAquariumId[sizeof(activeAquariumId) - 1] = '\0';
    _pendingSwitchAq[0] = '\0';
    printf("Telemetry: switching to aquarium '%s'\n", activeAquariumId);
    telemetryBootstrap();   // load the new tank's saved state (or keep current if brand-new)
}

// Runtime re-enable: compare the local profile to the server's saved one and, if
// they differ, raise the on-screen prompt instead of silently adopting either.
static void telemetryReenableCheck() {
    if (!telemetryEnabled || TELEMETRY_HOST[0] == '\0') return;
    if (!_fetchBootstrap() || !strstr(_bootstrapJson, "\"exists\":true")) return;
    const char* ss; size_t sl;
    if (!_jGetStr(_bootstrapJson, "profile_sig", &ss, &sl)) return;
    std::string local = _localProfileSig();
    if (local.size() == sl && memcmp(local.c_str(), ss, sl) == 0) return; // matches
    const char* cp = strstr(_bootstrapJson, "\"counts\":");
    if (cp) {
        int v;
        if (_jGetInt(cp, "pair",    &v)) telemetrySrvPair    = v;
        if (_jGetInt(cp, "school",  &v)) telemetrySrvSchool  = v;
        if (_jGetInt(cp, "school2", &v)) telemetrySrvSchool2 = v;
        if (_jGetInt(cp, "angel",   &v)) telemetrySrvAngel   = v;
    }
    telemetryConflictPending.store(true);
}

// POST the user's conflict choice to the server (blocking; main thread).
static void _postResolve(const char* choice) {
    if (TELEMETRY_HOST[0] == '\0') return;
    std::string url  = std::string(TELEMETRY_HOST)
        + "/api/aquariums/" + activeAquariumId + "/resolve";
    std::string body = std::string("{\"choice\":\"") + choice + "\"}";
    CURL* curl = curl_easy_init();
    if (!curl) return;
    struct curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, "Content-Type: application/json");
    curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body.c_str());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, (long)body.size());
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT, 3L);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 5L);
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, _telemetryDiscard);
    curl_easy_perform(curl);
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);
}

// Conflict resolution entry points (called from the modal's button handlers).
static void telemetryResolveUseServer() {
    if (strstr(_bootstrapJson, "\"exists\":true")) _applyServerProfile(_bootstrapJson);
    telemetryConflictPending.store(false);
}
static void telemetryResolveKeepLocal() {
    telemetryConflictPending.store(false);
    _postResolve("local"); // server adopts this device's profile as the baseline
}

// Run once per loop() on the main thread: act on directives flagged by the
// POST worker (re-bootstrap-and-rebuild on RESTORE; re-check profile on CONFLICT).
static void telemetryProcessFlags() {
    if (_telemetryRestoreReq.exchange(false)) {
        if (_fetchBootstrap() && strstr(_bootstrapJson, "\"exists\":true")) {
            _applyServerProfile(_bootstrapJson);
            telemetryConflictPending.store(false);
        }
    }
    if (_telemetryConflictHint.exchange(false) && !telemetryConflictPending.load())
        telemetryReenableCheck();
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
    // Restore last-known state from the server before the render loop starts.
    telemetryBootstrap();
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

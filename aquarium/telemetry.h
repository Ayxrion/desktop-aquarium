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
//   #define TELEMETRY_HOST         "http://107.214.184.24/aquarium/api/telemetry"
//   #define TELEMETRY_API_KEY      "change-me"
//   #define TELEMETRY_AQUARIUM_ID  "living-room"
//   #define TELEMETRY_INTERVAL_MS  1000

#include <WiFi.h>
#include <HTTPClient.h>
#include <stdarg.h>
#include <string.h>
#include <stdlib.h>
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
// Stable per-DEVICE id so the server registers this physical unit as a first-class
// device (separate from the aquarium it currently shows). Override in wifi_config.h.
#ifndef TELEMETRY_DEVICE_ID
#define TELEMETRY_DEVICE_ID "esp-device-1"
#endif
// Which aquarium this device currently shows — mutable at runtime via !SWITCHAQ:<id>.
static char activeAquariumId[64] = TELEMETRY_AQUARIUM_ID;
static char _pendingSwitchAq[64] = "";
#ifndef TELEMETRY_INTERVAL_MS
#define TELEMETRY_INTERVAL_MS 1000
#endif

static uint32_t _lastTelemetryMs = 0;

// Static scratch buffer — avoids heap fragmentation from String concatenation.
// Worst case ~45 fish (~110 chars each) + plants + header ≈ 6 KB; 12 KB is safe.
// Written by the loop thread (build) only while the worker is idle; read by the
// worker only while busy — see _telemetryBusy below — so no lock is needed.
static char _telemetryBuf[28672];   // headroom for per-fish wander_q lookahead arrays
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

// ── Profile-conflict state (server-vs-local composition) ──────────────────────
// The server is the source of truth for the aquarium profile (fish counts/types/
// colors + plant layout). If the local tank diverges, the device shows an
// on-screen prompt. Flags set by the POST worker (core 0) are consumed by the
// render loop (core 1).
static std::atomic<bool> telemetryConflictPending{false}; // → draw the modal
static std::atomic<bool> _telemetryRestoreReq{false};     // worker→loop: rebuild
static std::atomic<bool> _telemetryConflictHint{false};   // worker→loop: re-check
static int telemetrySrvPair = 0, telemetrySrvSchool = 0,
           telemetrySrvSchool2 = 0, telemetrySrvAngel = 0; // server counts (modal)

// ── Dashboard control directives (pushed via the telemetry POST response) ─────
// The web dashboard can't reach the device directly, so the server forwards its
// control actions as `!`-prefixed lines in the POST response. They're parsed here
// on the POST worker (core 0) into atomic request state, and applied on the render
// loop (core 1) by telemetryApplyControls() (defined in aquarium.ino, where
// dropFood()/addFish()/the weather + time globals are all in scope).
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
static std::atomic<int> _ctrlSellSnailIds[CTRL_SELL_MAX];   // snail slot indices to sell
static std::atomic<int> _ctrlSellSnailCount{0};

// Parse the control directives out of a POST response body into the atomics above.
// Each command type appears at most once per response (the server collapses them),
// so a single substring match per token is sufficient.
static void _telemetryParseControls(const char* body) {
    const char* d;
    // !SWITCHAQ:<id> — dashboard reassigned this device to another aquarium (applied on
    // the render thread by telemetryApplyAquariumSwitch()).
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
    // !SELLSNAIL:<slot,slot,…> — append snail slot indices to sell (drained on main thread).
    if ((d = strstr(body, "!SELLSNAIL:")) != nullptr) {
        const char* p = d + 11;
        const char* nl = strchr(p, '\n');
        while (*p && p != nl) {
            int cnt = _ctrlSellSnailCount.load();
            if (cnt >= CTRL_SELL_MAX) break;
            _ctrlSellSnailIds[cnt].store(atoi(p));
            _ctrlSellSnailCount.store(cnt + 1);
            const char* c = strchr(p, ',');
            if (!c || (nl && c > nl)) break;
            p = c + 1;
        }
    }
}

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

// ── Fish names (pushed down via the telemetry POST response) ──────────────────
// The server can't reach the device (no inbound firewall), so it returns the
// current names in the POST response body as `id\tname` lines. The worker task
// applies them; the render loop draws them above each fish.
#define TELEMETRY_NAME_LEN 24
static char       telemetryFishName[MAX_FISH][TELEMETRY_NAME_LEN] = {};
static std::mutex _telemetryNameMutex;

static inline void telemetryGetFishName(int id, char* out, size_t n) {
    out[0] = '\0';
    if (id < 0 || id >= MAX_FISH) return;
    std::lock_guard<std::mutex> lk(_telemetryNameMutex);
    snprintf(out, n, "%s", telemetryFishName[id]);
}

// Replace the name table from the `id\tname` lines in the response body.
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
        "{\"aquarium_id\":\"%s\",\"device_id\":\"%s\",\"platform\":\"esp32\",\"fw_version\":\"%s\","
        "\"uptime_ms\":%lu,\"tick\":%d,\"frame_ms\":%d,"
        "\"screen\":{\"w\":%d,\"h\":%d,\"tank_top\":%d},"
        "\"weather\":{\"condition\":%d,\"name\":\"%s\",\"override\":%s},"
        "\"time\":{\"day_progress\":%.4f,\"mode\":\"%s\"},"
        "\"counts\":{\"pair\":%d,\"school\":%d,\"school2\":%d,\"angel\":%d,\"salmon\":%d},",
        activeAquariumId, TELEMETRY_DEVICE_ID, FIRMWARE_VERSION,
        (unsigned long)millis(), (int)tick, FRAME_MS,
        SCREEN_W, SCREEN_H, TANK_TOP,
        wc, _telemetryWeatherName(wc), (weatherOverrideIdx >= 0) ? "true" : "false",
        getDayProgress(), (currentTimeMode == TIME_FAST) ? "FAST" : "REAL",
        numPair, numSchool, numSchool2, numAngel, numSalmon);

    // Fish
    o = _tAppend(o, "\"fish\":[");
    bool first = true;
    for (int i = 0; i < MAX_FISH; i++) {
        if (!isFishActive(i)) continue;
        Fish& f = fish[i];
        o = _tAppend(o,
            "%s{\"id\":%d,\"x\":%.1f,\"y\":%.1f,\"z\":%.3f,"
            "\"vx\":%.2f,\"vy\":%.2f,\"vz\":%.4f,"
            "\"tx\":%.1f,\"ty\":%.1f,\"tz\":%.3f,\"wander_cd\":%.2f,"
            "\"type\":%d,\"facing_right\":%s,"
            "\"color\":%u,\"going_for_food\":%s,\"chasing\":%s,"
            "\"age\":%d,\"scale\":%.3f,\"xp\":%d,\"fish_luck\":%.3f,\"wander_q\":[",
            first ? "" : ",", i,
            f.x, f.y, f.z,
            f.vx, f.vy, f.vz,
            f.tx, f.ty, f.tz, f.wanderCD,
            (int)f.type,
            f.facingRight ? "true" : "false",
            (unsigned)fishColor(i),
            f.goingForFood ? "true" : "false",
            f.chasing ? "true" : "false",
            (int)f.age, fishScale(f), (int)f.xp, f.fishLuck);
        // Upcoming wander targets the web should seek next: [wcd, tx, ty, tz, chasing].
        for (uint8_t q = 0; q < f.wanderQN; q++) {
            WanderMove& m = f.wanderQ[q];
            o = _tAppend(o, "%s[%.2f,%.1f,%.1f,%.3f,%d]",
                q ? "," : "", m.wcd, m.tx, m.ty, m.tz, m.chasing ? 1 : 0);
        }
        o = _tAppend(o, "]}");
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
    o = _tAppend(o, "]},");

    // Career game state (+ feeding schedule: fed/meals today, hunger, overfeeding)
    int mealbits = 0;
    for (int i = 0; i < MEALS_PER_DAY; i++) if (mealFed[i]) mealbits |= (1 << i);
    o = _tAppend(o,
        "\"game\":{\"mode\":\"%s\",\"coins\":%d,\"shells\":%d,\"food\":%d,\"luck\":%.3f,"
        "\"fed\":%d,\"meals\":%d,\"hungry\":%d,\"overfed\":%d,\"mealbits\":%d},",
        (gameMode == MODE_CAREER) ? "career" : "creative",
        gameCoins, gameShells, gameFood, tankLuck(),
        mealsToday, MEALS_PER_DAY, tankHungry ? 1 : 0, overfeedToday, mealbits);

    // Wandering fish (catchable)
    o = _tAppend(o, "\"wanderers\":[");
    bool firstW = true;
    for (int i = 0; i < MAX_WANDER; i++) {
        if (!wanderers[i].active) continue;
        o = _tAppend(o,
            "%s{\"id\":%u,\"x\":%.1f,\"y\":%.1f,\"vx\":%.3f,\"bob\":%.3f,"
            "\"type\":%d,\"color\":%u,\"facing_right\":%s}",
            firstW ? "" : ",", wanderers[i].id, wanderers[i].x, wanderers[i].y,
            wanderers[i].vx, wanderers[i].bob,
            wanderers[i].type, (unsigned)wanderers[i].color,
            wanderers[i].facingRight ? "true" : "false");
        firstW = false;
    }
    o = _tAppend(o, "],\"loot\":[");
    bool firstL = true;
    for (int i = 0; i < MAX_LOOT; i++) {
        if (!loot[i].active) continue;
        o = _tAppend(o,
            "%s{\"id\":%u,\"kind\":\"%s\",\"x\":%.1f,\"y\":%.1f,\"vy\":%.2f,"
            "\"landed\":%s,\"ttl\":%d,\"tier\":%d}",
            firstL ? "" : ",", loot[i].id, loot[i].kind == 0 ? "coin" : "shell",
            loot[i].x, loot[i].y, loot[i].vy,
            loot[i].landed ? "true" : "false", loot[i].ttl, loot[i].tier);
        firstL = false;
    }
    o = _tAppend(o, "],\"snails\":[");
    bool firstS = true;
    for (int i = 0; i < numSnails; i++) {
        if (!coinSnails[i].active) continue;
        // "id" is the slot index (active snails are contiguous) — the web echoes it back
        // in !SELLSNAIL, matching the fish convention.
        o = _tAppend(o,
            "%s{\"id\":%d,\"type\":%d,\"x\":%.1f,\"spd\":%.3f,\"facing_right\":%s,"
            "\"age\":%d,\"scale\":%.3f,\"stage\":%d,\"xp\":%d,\"snail_luck\":%.3f,"
            "\"stamina\":%d,\"asleep\":%s}",
            firstS ? "" : ",", i, coinSnails[i].type,
            coinSnails[i].x, coinSnails[i].spd, coinSnails[i].facingRight ? "true" : "false",
            (int)coinSnails[i].age, snailScaleOf(coinSnails[i].age), snailStage(coinSnails[i].age),
            coinSnails[i].xp, coinSnails[i].snailLuck,
            (int)coinSnails[i].stamina, coinSnails[i].asleep ? "true" : "false");
        firstS = false;
    }
    o = _tAppend(o, "]}");

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
    if (code >= 200 && code < 300) {
        String body = http.getString();          // `id\tname` lines from the server
        if (body.indexOf("!RESTORE") >= 0)       _telemetryRestoreReq.store(true);
        else if (body.indexOf("!CONFLICT") >= 0) _telemetryConflictHint.store(true);
        _telemetryParseControls(body.c_str());   // dashboard weather/time/fish/feed
        _telemetryApplyNames(body.c_str());
        _telemetryOk();
    }
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

// ── Bootstrap (on-boot state restore) ────────────────────────────────────────
// GETs /api/aquariums/:id/bootstrap and applies the server's last-known fish
// positions, velocities, wander targets, and names to the live fish[] array.
// Parsed with ArduinoJson; runs synchronously in setup() before the render loop.

#include <ArduinoJson.h>

// Canonical profile signature of the LIVE local tank. Must match the server's
// profileSig() byte-for-byte (aquarium-web/src/store.js).
static String _localProfileSig() {
    // Composition only (per-type fish counts) — must match the server's
    // profileSig() byte-for-byte (aquarium-web/src/store.js). Fish colors and the
    // plant layout were deliberately dropped: they're cosmetic and caused spurious
    // mismatches (reseeded plants on boot, device↔server color formatting drift).
    return "P:" + String(numPair) + "," + String(numSchool) + "," +
           String(numSchool2) + "," + String(numAngel) + "," + String(numSalmon);
}

// GET /bootstrap into doc. Returns true on HTTP 200 + valid JSON.
static bool _fetchBootstrapDoc(DynamicJsonDocument& doc) {
    if (TELEMETRY_HOST[0] == '\0' || !_wifiEnsureConnected()) return false;
    String base = String(TELEMETRY_HOST);
    if (base.endsWith("/api/telemetry")) base = base.substring(0, base.length() - 14);
    String url = base + "/api/aquariums/" + activeAquariumId + "/bootstrap";
    WiFiClient client;
    HTTPClient http;
    if (!http.begin(client, url)) return false;
    http.addHeader("X-Api-Key", TELEMETRY_API_KEY);
    http.setConnectTimeout(5000);
    http.setTimeout(8000);
    int code = http.GET();
    if (code != 200) { http.end(); return false; }
    DeserializationError err = deserializeJson(doc, http.getStream());
    http.end();
    return !err;
}

// Rebuild the local tank to the server's saved profile (counts + plant layout),
// then overlay saved fish positions/names. Render-loop (core 1) only.
static void _applyServerProfileDoc(DynamicJsonDocument& doc) {
    if (!doc["exists"].as<bool>()) return;

    // Career game state (mode + wallet) from the saved snapshot.
    JsonObject game = doc["game"];
    if (!game.isNull()) {
        const char* gm = game["mode"] | "career";
        gameMode   = (strcmp(gm, "career") == 0) ? MODE_CAREER : MODE_CREATIVE;
        gameCoins  = game["coins"]  | 0;
        gameShells = game["shells"] | 0;
        gameFood   = game["food"]   | 0;
        // Restore today's feeding progress so reboot mid-day doesn't reset the schedule.
        mealsToday    = game["fed"]     | 0;
        overfeedToday = game["overfed"] | 0;
        int mealbits  = game["mealbits"] | 0;
        for (int i = 0; i < MEALS_PER_DAY; i++) mealFed[i] = (mealbits >> i) & 1;
        feedSchedInit = false;   // re-sync the slot clock on the next tick (no spurious day-eval)
    }

    JsonObject counts = doc["counts"];
    int wantP = counts["pair"] | numPair, wantS = counts["school"] | numSchool;
    int wantS2 = counts["school2"] | numSchool2, wantA = counts["angel"] | numAngel;
    int wantSa = counts["salmon"] | numSalmon;
    numPair = numSchool = numSchool2 = numAngel = numSalmon = 0;
    for (int i = 0; i < wantP  && numPair    < MAX_PAIR;    i++) addFish(FISH_PAIR);
    for (int i = 0; i < wantS  && numSchool  < MAX_SCHOOL;  i++) addFish(FISH_SCHOOL);
    for (int i = 0; i < wantS2 && numSchool2 < MAX_SCHOOL2; i++) addFish(FISH_SCHOOL2);
    for (int i = 0; i < wantA  && numAngel   < MAX_ANGEL;   i++) addFish(FISH_ANGEL);
    for (int i = 0; i < wantSa && numSalmon  < MAX_SALMON;  i++) addFish(FISH_SALMON);

    JsonObject plants = doc["plants"];
    if (!plants.isNull()) {
        int i = 0;
        for (JsonObject p : plants["bg"].as<JsonArray>()) {
            if (i >= NUM_BG_PLANTS) break;
            bgPlants[i].baseX = (uint16_t)(p["x"] | bgPlants[i].baseX);
            bgPlants[i].segs  = (uint8_t)(p["segs"] | bgPlants[i].segs);
            bgPlants[i].type  = (uint8_t)(p["type"] | bgPlants[i].type);
            i++;
        }
        i = 0;
        for (JsonObject p : plants["weeds"].as<JsonArray>()) {
            if (i >= NUM_WEEDS) break;
            weeds[i].baseX = (uint16_t)(p["x"] | weeds[i].baseX);
            weeds[i].segs  = (uint8_t)(p["segs"] | weeds[i].segs);
            weeds[i].numBranches = (uint8_t)(1 + random(0, 2));
            for (int b = 0; b < 2; b++) {
                int span = weeds[i].segs > 3 ? weeds[i].segs - 3 : 1;
                weeds[i].branchAt[b]   = (uint8_t)(2 + random(0, span));
                weeds[i].branchSide[b] = (random(0, 2) == 0) ? 1 : -1;
            }
            i++;
        }
        i = 0;
        for (JsonObject p : plants["hornwort"].as<JsonArray>()) {
            if (i >= NUM_FG_HORNWORT) break;
            fgHornworts[i].baseX = (uint16_t)(p["x"] | fgHornworts[i].baseX);
            fgHornworts[i].segs  = (uint8_t)(p["segs"] | fgHornworts[i].segs);
            i++;
        }
    }

    // Coin-collector snails — purchased & durable, so restore them across a reboot.
    // (Loot/wanderers are transient with short TTLs and are intentionally not restored.)
    numSnails = 0;
    for (int i = 0; i < MAX_SNAILS; i++) coinSnails[i].active = false;
    for (JsonObject s : doc["snails"].as<JsonArray>()) {
        if (numSnails >= MAX_SNAILS) break;
        CoinSnail& cs = coinSnails[numSnails];
        cs.type        = 0;
        cs.x           = s["x"]            | (float)(SCREEN_W / 2);
        cs.spd         = s["spd"]          | SNAIL_BASE_SPD;
        cs.facingRight = s["facing_right"] | true;
        cs.age         = (float)(int)(s["age"]  | 0);
        cs.xp          = s["xp"]           | 0;
        cs.snailLuck   = s["snail_luck"]   | 0.0f;
        cs.stamina     = s["stamina"]      | SNAIL_STAMINA_MAX;
        cs.asleep      = false;
        cs.active      = true;
        numSnails++;
    }

    for (JsonObject jf : doc["fish"].as<JsonArray>()) {
        int id = jf["id"] | -1;
        if (id < 0 || id >= MAX_FISH || !isFishActive(id)) continue;
        Fish& f = fish[id];
        f.x        = jf["x"]         | f.x;
        f.y        = jf["y"]         | f.y;
        f.vx       = jf["vx"]        | 0.0f;
        f.vy       = jf["vy"]        | 0.0f;
        f.tx       = jf["tx"]        | f.x;
        f.ty       = jf["ty"]        | f.y;
        f.wanderCD = jf["wander_cd"] | f.wanderCD;
        f.chasing  = jf["chasing"]   | false;
        f.age      = jf["age"]       | f.age;
        f.xp       = jf["xp"]        | f.xp;
        f.fishLuck = jf["fish_luck"] | f.fishLuck;
        const char* name = jf["name"];
        if (name && name[0] != '\0') {
            std::lock_guard<std::mutex> lk(_telemetryNameMutex);
            strncpy(telemetryFishName[id], name, TELEMETRY_NAME_LEN - 1);
            telemetryFishName[id][TELEMETRY_NAME_LEN - 1] = '\0';
        }
    }
    Serial.printf("Telemetry: rebuilt tank to server profile (pair %d school %d/%d angel %d)\n",
                  numPair, numSchool, numSchool2, numAngel);
}

// Set true once a server profile has been adopted, so setup() can skip its
// default tank seeding (which would otherwise reset restored fish ages to 0).
bool telemetryProfileLoaded = false;

static bool telemetryFetchAndApplyProfile() {
    DynamicJsonDocument doc(65536);  // 64 KB — MAX_FISH=72 × ~430B/fish (incl. wander_q) ≈ 31 KB JSON; ArduinoJson needs ~2× internally
    if (!_fetchBootstrapDoc(doc) || !doc["exists"].as<bool>()) return false;
    _applyServerProfileDoc(doc);
    telemetryProfileLoaded = true;
    return true;
}

// Boot handshake: adopt the server's saved profile as the source of truth.
static void telemetryBootstrap() {
    if (!telemetryEnabled || TELEMETRY_HOST[0] == '\0') return;
    if (!telemetryFetchAndApplyProfile())
        Serial.println("Telemetry: no saved profile on server (keeping local tank)");
}

// Apply a pending !SWITCHAQ reassignment: point at the new aquarium + load its state.
// Call from the render loop (core 1) — it rebuilds fish[] via the bootstrap restore.
static void telemetryApplyAquariumSwitch() {
    if (_pendingSwitchAq[0] == '\0') return;
    strncpy(activeAquariumId, _pendingSwitchAq, sizeof(activeAquariumId) - 1);
    activeAquariumId[sizeof(activeAquariumId) - 1] = '\0';
    _pendingSwitchAq[0] = '\0';
    Serial.printf("Telemetry: switching to aquarium '%s'\n", activeAquariumId);
    telemetryFetchAndApplyProfile();
}

// Runtime re-enable: compare local profile to the server's; prompt if different.
static void telemetryReenableCheck() {
    if (!telemetryEnabled || TELEMETRY_HOST[0] == '\0') return;
    DynamicJsonDocument doc(65536);  // 64 KB — MAX_FISH=72 × ~430B/fish (incl. wander_q) ≈ 31 KB JSON; ArduinoJson needs ~2× internally
    if (!_fetchBootstrapDoc(doc) || !doc["exists"].as<bool>()) return;
    const char* ss = doc["profile_sig"] | "";
    if (_localProfileSig() == String(ss)) return; // matches → no conflict
    JsonObject counts = doc["counts"];
    telemetrySrvPair    = counts["pair"]    | 0;
    telemetrySrvSchool  = counts["school"]  | 0;
    telemetrySrvSchool2 = counts["school2"] | 0;
    telemetrySrvAngel   = counts["angel"]   | 0;
    telemetryConflictPending.store(true);
}

static void _postResolve(const char* choice) {
    if (TELEMETRY_HOST[0] == '\0' || !_wifiEnsureConnected()) return;
    String base = String(TELEMETRY_HOST);
    if (base.endsWith("/api/telemetry")) base = base.substring(0, base.length() - 14);
    String url  = base + "/api/aquariums/" + activeAquariumId + "/resolve";
    String body = String("{\"choice\":\"") + choice + "\"}";
    WiFiClient client;
    HTTPClient http;
    if (!http.begin(client, url)) return;
    http.addHeader("Content-Type", "application/json");
    http.setConnectTimeout(3000);
    http.setTimeout(5000);
    http.POST((uint8_t*)body.c_str(), body.length());
    http.end();
}

// Conflict resolution entry points (called from the modal's button handlers).
static void telemetryResolveUseServer() {
    telemetryFetchAndApplyProfile();
    telemetryConflictPending.store(false);
}
static void telemetryResolveKeepLocal() {
    telemetryConflictPending.store(false);
    _postResolve("local");
}

// Run once per loop() on core 1: act on directives flagged by the POST worker.
static void telemetryProcessFlags() {
    if (_telemetryRestoreReq.exchange(false)) {
        if (telemetryFetchAndApplyProfile()) telemetryConflictPending.store(false);
    }
    if (_telemetryConflictHint.exchange(false) && !telemetryConflictPending.load())
        telemetryReenableCheck();
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
    // Restore last-known state from the server before the render loop starts.
    telemetryBootstrap();
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

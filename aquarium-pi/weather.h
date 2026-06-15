#pragma once
// Fetches current weather from OpenWeatherMap using libcurl.
// Requires WEATHER_API_KEY, WEATHER_LAT, WEATHER_LON in wifi_config.h.
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <curl/curl.h>
#include "compat.h"
#include "version.h"
#include "wifi_config.h"

enum WeatherCondition : uint8_t {
    WEATHER_SUNNY = 0,
    WEATHER_PARTLY_CLOUDY,
    WEATHER_CLOUDY,
    WEATHER_RAINY,
    WEATHER_STORMY,
    WEATHER_SNOWY,
    WEATHER_FOGGY
};

static WeatherCondition currentWeather      = WEATHER_SUNNY;
static uint32_t         _lastWeatherMs      = 0;
static bool             _lastFetchOk        = false;

static const uint32_t _WEATHER_INTERVAL       = 5UL * 60UL * 1000UL;  // 5 min on success
static const uint32_t _WEATHER_RETRY_INTERVAL = 60UL * 1000UL;         // 1 min on failure

struct _CurlBuf { char data[8192]; size_t len; };

static size_t _curlWrite(void* ptr, size_t sz, size_t n, void* ud) {
    _CurlBuf* buf = static_cast<_CurlBuf*>(ud);
    size_t bytes = sz * n;
    if (buf->len + bytes < sizeof(buf->data) - 1) {
        memcpy(buf->data + buf->len, ptr, bytes);
        buf->len += bytes;
        buf->data[buf->len] = '\0';
    }
    return bytes;
}

// Minimal JSON extractor: finds the first "id":<number> inside the "weather" array.
static int _parseWeatherId(const char* json) {
    const char* p = strstr(json, "\"weather\"");
    if (!p) return -1;
    p = strstr(p, "\"id\"");
    if (!p) return -1;
    p += 4;
    while (*p == ':' || *p == ' ') p++;
    return atoi(p);
}

static bool _fetchWeather(WeatherCondition& out) {
    char url[512];
    snprintf(url, sizeof(url),
        "https://api.openweathermap.org/data/2.5/weather"
        "?lat=%s&lon=%s&appid=%s",
        WEATHER_LAT, WEATHER_LON, WEATHER_API_KEY);

    CURL* curl = curl_easy_init();
    if (!curl) return false;

    _CurlBuf buf = {};
    curl_easy_setopt(curl, CURLOPT_URL, url);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, _curlWrite);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &buf);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT, 10L);
    curl_easy_setopt(curl, CURLOPT_SSL_VERIFYPEER, 1L);
    curl_easy_setopt(curl, CURLOPT_USERAGENT, "Pi-Aquarium/" FIRMWARE_VERSION);
    CURLcode res = curl_easy_perform(curl);
    curl_easy_cleanup(curl);

    if (res != CURLE_OK) {
        printf("Weather fetch: %s\n", curl_easy_strerror(res));
        return false;
    }

    int id = _parseWeatherId(buf.data);
    if (id < 0) { printf("Weather: could not parse response\n"); return false; }

    if      (id == 800)              out = WEATHER_SUNNY;
    else if (id == 801)              out = WEATHER_PARTLY_CLOUDY;
    else if (id >= 802 && id <= 804) out = WEATHER_CLOUDY;
    else if (id >= 500 && id <= 531) out = WEATHER_RAINY;
    else if (id >= 200 && id <= 232) out = WEATHER_STORMY;
    else if (id >= 600 && id <= 622) out = WEATHER_SNOWY;
    else if (id >= 300 && id <= 321) out = WEATHER_RAINY;
    else if (id >= 700 && id <= 781) out = WEATHER_FOGGY;
    else                             out = WEATHER_CLOUDY;
    return true;
}

static void initWeather() {
    curl_global_init(CURL_GLOBAL_DEFAULT);
    WeatherCondition w = currentWeather;
    _lastFetchOk = _fetchWeather(w);
    currentWeather = _lastFetchOk ? w : WEATHER_SUNNY;
    _lastWeatherMs = millis();
    if (!_lastFetchOk) printf("Weather init failed — defaulting to SUNNY\n");
}

static void forceWeatherRefetch() {
    _lastFetchOk   = false;
    _lastWeatherMs = 0;
}

static void updateWeather() {
    uint32_t interval = _lastFetchOk ? _WEATHER_INTERVAL : _WEATHER_RETRY_INTERVAL;
    if (millis() - _lastWeatherMs >= interval) {
        WeatherCondition w = currentWeather;
        _lastFetchOk = _fetchWeather(w);
        if (_lastFetchOk) currentWeather = w;
        _lastWeatherMs = millis();
    }
}

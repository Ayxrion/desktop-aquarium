#pragma once
// Fetches current weather from OpenWeatherMap and exposes a WeatherCondition enum.
// Call initWeather() from setup() after OTA, updateWeather() each loop() iteration.
// Requires WEATHER_API_KEY, WEATHER_LAT, WEATHER_LON in wifi_config.h.
//
// WiFi is left ON permanently after initWeather() — cycling the radio off and
// back on every 5 minutes was causing silent reconnect failures on the ESP32-S3.

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

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

// Ensures WiFi is connected, reusing an existing connection if still up.
// Returns true when connected, false on timeout.
static bool _wifiEnsureConnected() {
  if (WiFi.status() == WL_CONNECTED) return true;

  // Radio may be off (e.g. just after OTA) — turn it on and connect.
  if (WiFi.getMode() == WIFI_OFF) {
    WiFi.mode(WIFI_STA);
    delay(200);
  }
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED) {
    if (millis() - t0 > 15000UL) return false;
    delay(200);
  }
  return true;
}

// Returns true on success and updates outCondition.
// WiFi is left connected after the call — no cycling.
static bool _fetchWeather(WeatherCondition& outCondition) {
  if (!_wifiEnsureConnected()) return false;

  WiFiClientSecure client;
  client.setInsecure();
  client.setTimeout(10);

  char url[256];
  snprintf(url, sizeof(url),
    "https://api.openweathermap.org/data/2.5/weather"
    "?lat=%s&lon=%s&appid=%s",
    WEATHER_LAT, WEATHER_LON, WEATHER_API_KEY);

  bool success = false;
  HTTPClient http;
  if (http.begin(client, url)) {
    http.setTimeout(12000);   // 12 s total HTTP timeout
    int code = http.GET();
    if (code == HTTP_CODE_OK) {
      // Read full body first — stream can close if we delay parsing.
      // DynamicJsonDocument(1024) is plenty for the ~500-byte OWM response;
      // avoids the StaticJsonDocument filter-size pitfall that caused silent
      // NoMemory errors and prevented the weather from ever updating.
      String body = http.getString();
      DynamicJsonDocument doc(1024);
      if (!deserializeJson(doc, body)) {
        int id = doc["weather"][0]["id"] | -1;
        if (id >= 0) {
          if      (id == 800)              outCondition = WEATHER_SUNNY;
          else if (id == 801)              outCondition = WEATHER_PARTLY_CLOUDY;
          else if (id >= 802 && id <= 804) outCondition = WEATHER_CLOUDY;
          else if (id >= 500 && id <= 531) outCondition = WEATHER_RAINY;
          else if (id >= 200 && id <= 232) outCondition = WEATHER_STORMY;
          else if (id >= 600 && id <= 622) outCondition = WEATHER_SNOWY;
          else if (id >= 300 && id <= 321) outCondition = WEATHER_RAINY;
          else if (id >= 700 && id <= 781) outCondition = WEATHER_FOGGY;
          else                             outCondition = WEATHER_CLOUDY;
          success = true;
        }
      }
    }
    http.end();
  }

  // WiFi intentionally left on — avoids the reconnect failures caused by cycling.
  return success;
}

static void initWeather() {
  WeatherCondition w = currentWeather;
  _lastFetchOk   = _fetchWeather(w);
  currentWeather = _lastFetchOk ? w : WEATHER_SUNNY;
  _lastWeatherMs = millis();
}

// Reset timer so the next updateWeather() call fires immediately.
// Call this when returning from manual override back to AUTO mode.
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

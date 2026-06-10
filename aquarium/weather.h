#pragma once
// Fetches current weather from OpenWeatherMap and exposes a WeatherCondition enum.
// Call initWeather() from setup() after OTA, updateWeather() each loop() iteration.
// Requires WEATHER_API_KEY, WEATHER_LAT, WEATHER_LON in wifi_config.h.

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

// Returns true on success and updates outCondition.
static bool _fetchWeather(WeatherCondition& outCondition) {
  // Brief pause so WiFi hardware fully powers up after any prior mode change.
  delay(500);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED) {
    if (millis() - t0 > 15000UL) {
      WiFi.disconnect(true);
      WiFi.mode(WIFI_OFF);
      return false;
    }
    delay(200);
  }

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
    int code = http.GET();
    if (code == HTTP_CODE_OK) {
      // Read the full body before parsing — stream closes if we delay first.
      String body = http.getString();
      StaticJsonDocument<64> filter;
      filter["weather"][0]["id"] = true;
      DynamicJsonDocument doc(512);
      if (!deserializeJson(doc, body, DeserializationOption::Filter(filter))) {
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

  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
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

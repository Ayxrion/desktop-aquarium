#pragma once
// Fetches current weather from OpenWeatherMap and exposes a WeatherCondition enum.
// Call weatherInit(&display) then initWeather() from setup() after OTA.
// Call updateWeather() each loop() iteration.
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

static WeatherCondition    currentWeather      = WEATHER_SUNNY;
static uint32_t            _lastWeatherMs      = 0;
static bool                _lastFetchOk        = false;
static lgfx::LGFX_Device*  _weatherDisp        = nullptr;

static const uint32_t _WEATHER_INTERVAL       = 5UL * 60UL * 1000UL;  // 5 min on success
static const uint32_t _WEATHER_RETRY_INTERVAL = 60UL * 1000UL;         // 1 min on failure

static void weatherInit(lgfx::LGFX_Device* d) { _weatherDisp = d; }

static void _weatherStatus(const char* msg, uint32_t col = 0xCCCCCCUL) {
  if (!_weatherDisp) return;
  int w = _weatherDisp->width();
  int h = _weatherDisp->height();
  _weatherDisp->fillRect(0, h - 42, w, 42, 0x000000UL);
  _weatherDisp->setTextColor(col);
  _weatherDisp->setTextSize(2);
  _weatherDisp->setCursor(10, h - 30);
  _weatherDisp->print(msg);
}

// Returns true on success and updates outCondition.
static bool _fetchWeather(WeatherCondition& outCondition) {
  char buf[80];

  // Brief pause so WiFi hardware fully powers up after any prior mode change.
  delay(500);

  _weatherStatus("Weather: connecting to WiFi...");
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED) {
    if (millis() - t0 > 15000UL) {
      _weatherStatus("Weather: WiFi timeout", 0xFF4444UL);
      delay(2000);
      WiFi.disconnect(true);
      WiFi.mode(WIFI_OFF);
      return false;
    }
    delay(200);
  }

  _weatherStatus("Weather: fetching conditions...");

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
    snprintf(buf, sizeof(buf), "Weather: HTTP %d", code);
    _weatherStatus(buf);
    delay(800);

    if (code == HTTP_CODE_OK) {
      StaticJsonDocument<32> filter;
      filter["weather"][0]["id"] = true;
      DynamicJsonDocument doc(512);
      DeserializationError err = deserializeJson(doc, http.getStream(),
                                                 DeserializationOption::Filter(filter));
      if (!err) {
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

          const char* names[] = {
            "SUNNY","PARTLY CLOUDY","CLOUDY","RAINY","STORMY","SNOWY","FOGGY"
          };
          snprintf(buf, sizeof(buf), "Weather: %s (id %d)", names[outCondition], id);
          _weatherStatus(buf, 0x44FF44UL);
          delay(2000);
          success = true;
        } else {
          _weatherStatus("Weather: bad JSON (no id)", 0xFF4444UL);
          delay(2000);
        }
      } else {
        snprintf(buf, sizeof(buf), "Weather: JSON err %d", (int)err.code());
        _weatherStatus(buf, 0xFF4444UL);
        delay(2000);
      }
    } else if (code == 401) {
      _weatherStatus("Weather: bad API key (401)", 0xFF4444UL);
      delay(2000);
    } else {
      snprintf(buf, sizeof(buf), "Weather: API error %d", code);
      _weatherStatus(buf, 0xFF4444UL);
      delay(2000);
    }
    http.end();
  } else {
    _weatherStatus("Weather: HTTP init failed", 0xFF4444UL);
    delay(2000);
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

static void updateWeather() {
  uint32_t interval = _lastFetchOk ? _WEATHER_INTERVAL : _WEATHER_RETRY_INTERVAL;
  if (millis() - _lastWeatherMs >= interval) {
    WeatherCondition w = currentWeather;
    _lastFetchOk = _fetchWeather(w);
    if (_lastFetchOk) currentWeather = w;
    _lastWeatherMs = millis();
  }
}

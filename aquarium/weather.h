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

static WeatherCondition currentWeather     = WEATHER_SUNNY;
static uint32_t         _lastWeatherMs     = 0;
static const uint32_t   _WEATHER_INTERVAL  = 5UL * 60UL * 1000UL;    // 5 min

static WeatherCondition _fetchWeather() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED) {
    if (millis() - t0 > 12000UL) {
      WiFi.disconnect(true);
      WiFi.mode(WIFI_OFF);
      return currentWeather;   // keep last known state on timeout
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

  WeatherCondition result = currentWeather;
  HTTPClient http;
  if (http.begin(client, url)) {
    int code = http.GET();
    if (code == HTTP_CODE_OK) {
      StaticJsonDocument<32> filter;
      filter["weather"][0]["id"] = true;
      DynamicJsonDocument doc(512);
      if (!deserializeJson(doc, http.getStream(),
                           DeserializationOption::Filter(filter))) {
        int id = doc["weather"][0]["id"] | 800;
        if      (id == 800)              result = WEATHER_SUNNY;
        else if (id == 801)              result = WEATHER_PARTLY_CLOUDY;
        else if (id >= 802 && id <= 804) result = WEATHER_CLOUDY;
        else if (id >= 500 && id <= 531) result = WEATHER_RAINY;
        else if (id >= 200 && id <= 232) result = WEATHER_STORMY;
        else if (id >= 600 && id <= 622) result = WEATHER_SNOWY;
        else if (id >= 300 && id <= 321) result = WEATHER_RAINY;   // drizzle → rainy
        else if (id >= 700 && id <= 781) result = WEATHER_FOGGY;
        else                             result = WEATHER_CLOUDY;
      }
    }
    http.end();
  }

  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
  return result;
}

static void initWeather() {
  currentWeather = _fetchWeather();
  _lastWeatherMs = millis();
}

static void updateWeather() {
  if (millis() - _lastWeatherMs >= _WEATHER_INTERVAL) {
    currentWeather = _fetchWeather();
    _lastWeatherMs = millis();
  }
}

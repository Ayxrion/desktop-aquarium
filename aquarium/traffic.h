#pragma once
// Fetches real-time traffic congestion from the aquarium web server.
// Returns a 0.0–1.0 congestion ratio (0 = free flow, 1 = gridlock).
// Requires TRAFFIC_API_URL and TRAFFIC_ZIP in wifi_config.h.
//
// Example wifi_config.h entries:
//   #define TRAFFIC_API_URL "http://107.214.184.24/aquarium/api/traffic"
//   #define TRAFFIC_ZIP     "90210"

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

#include "wifi_config.h"

static float    _trafficCongestion  = 0.0f;
static uint32_t _lastTrafficMs      = 0;
static bool     _lastTrafficOk      = false;

static const uint32_t _TRAFFIC_INTERVAL       = 60UL * 1000UL;   // 60 s on success
static const uint32_t _TRAFFIC_RETRY_INTERVAL = 15UL * 1000UL;   // 15 s on failure

static bool _fetchTraffic(float& outCongestion) {
  if (WiFi.status() != WL_CONNECTED) return false;

  char url[256];
  snprintf(url, sizeof(url), "%s?zip=%s", TRAFFIC_API_URL, TRAFFIC_ZIP);

  HTTPClient http;
  http.setTimeout(10000);
  if (!http.begin(url)) return false;

  bool success = false;
  int  code    = http.GET();
  if (code == HTTP_CODE_OK) {
    String body = http.getString();
    StaticJsonDocument<256> doc;
    if (!deserializeJson(doc, body)) {
      bool ok = doc["ok"] | false;
      if (ok) {
        float c = doc["congestion"] | -1.0f;
        if (c >= 0.0f && c <= 1.0f) {
          outCongestion = c;
          success = true;
        }
      }
    }
  }
  http.end();
  return success;
}

static void initTraffic() {
  float c = 0.0f;
  _lastTrafficOk = _fetchTraffic(c);
  if (_lastTrafficOk) _trafficCongestion = c;
  _lastTrafficMs = millis();
}

static void updateTraffic() {
  uint32_t interval = _lastTrafficOk ? _TRAFFIC_INTERVAL : _TRAFFIC_RETRY_INTERVAL;
  if (millis() - _lastTrafficMs >= interval) {
    float c = _trafficCongestion;
    _lastTrafficOk = _fetchTraffic(c);
    if (_lastTrafficOk) _trafficCongestion = c;
    _lastTrafficMs = millis();
  }
}

// Returns the latest congestion value (0.0 = free flow, 1.0 = gridlock).
static float trafficCongestion() { return _trafficCongestion; }

#pragma once
// Fetches real-time traffic congestion from the aquarium web server.
// Returns a 0.0–1.0 congestion ratio (0 = free flow, 1 = gridlock).
// ZIP code is configured server-side via the dashboard — not needed here.
// Requires TRAFFIC_API_URL in wifi_config.h.

#include <WiFi.h>
#include <WiFiClient.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

#include "wifi_config.h"

static float    _trafficCongestion  = 0.0f;
static uint32_t _lastTrafficMs      = 0;
static bool     _lastTrafficOk      = false;

static const uint32_t _TRAFFIC_INTERVAL       = 90UL  * 1000UL;  // 90 s on success
static const uint32_t _TRAFFIC_RETRY_INTERVAL = 60UL  * 1000UL;  // 60 s on failure

static bool _fetchTraffic(float& outCongestion) {
  // Reuse the WiFi connection already established by weather.h — reconnect if needed.
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[traffic] WiFi not connected, skipping fetch");
    return false;
  }

  char url[256];
  snprintf(url, sizeof(url), "%s/current", TRAFFIC_API_URL);
  Serial.printf("[traffic] GET %s  (heap free: %u)\n", url, ESP.getFreeHeap());

  WiFiClient client;
  HTTPClient http;
  http.setTimeout(12000);  // 12 s — matches weather timeout

  if (!http.begin(client, url)) {
    Serial.println("[traffic] http.begin() failed");
    return false;
  }

  bool success = false;
  int  code    = http.GET();
  Serial.printf("[traffic] HTTP %d\n", code);

  if (code == HTTP_CODE_OK) {
    String body = http.getString();
    Serial.printf("[traffic] body: %s\n", body.c_str());

    DynamicJsonDocument doc(512);
    DeserializationError err = deserializeJson(doc, body);
    if (err) {
      Serial.printf("[traffic] JSON parse error: %s\n", err.c_str());
    } else {
      bool ok = doc["ok"] | false;
      if (ok) {
        float c = doc["congestion"] | -1.0f;
        Serial.printf("[traffic] congestion=%.3f\n", c);
        if (c >= 0.0f && c <= 1.0f) {
          outCongestion = c;
          success = true;
        }
      } else {
        const char* error = doc["error"] | "unknown";
        Serial.printf("[traffic] server error: %s\n", error);
      }
    }
  } else if (code < 0) {
    Serial.printf("[traffic] connection error: %s\n", HTTPClient::errorToString(code).c_str());
  }

  http.end();
  Serial.printf("[traffic] done, heap free: %u\n", ESP.getFreeHeap());
  return success;
}

static void initTraffic() {
  Serial.println("[traffic] initTraffic()");
  float c = 0.0f;
  _lastTrafficOk = _fetchTraffic(c);
  if (_lastTrafficOk) _trafficCongestion = c;
  _lastTrafficMs = millis();
  Serial.printf("[traffic] init done — ok=%d congestion=%.3f\n", _lastTrafficOk, _trafficCongestion);
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

#pragma once
// Fetches real-time traffic congestion from the aquarium web server.
// Runs on a background FreeRTOS task (core 0) so the main render loop
// (core 1) is never blocked by the HTTP fetch.
// Requires TRAFFIC_API_URL in wifi_config.h.

#include <WiFi.h>
#include <WiFiClient.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "wifi_config.h"

static volatile float _trafficCongestion = 0.0f;
static TaskHandle_t   _trafficTaskHandle = nullptr;

static const uint32_t _TRAFFIC_FETCH_INTERVAL_MS = 90UL * 1000UL;  // 90 s between fetches
static const uint32_t _TRAFFIC_RETRY_MS           = 60UL * 1000UL;  // 60 s on failure

static bool _doFetchTraffic(float& outCongestion) {
  if (WiFi.status() != WL_CONNECTED) return false;

  char url[256];
  snprintf(url, sizeof(url), "%s/current", TRAFFIC_API_URL);

  WiFiClient client;
  HTTPClient http;
  http.setTimeout(10000);

  if (!http.begin(client, url)) {
    http.end();
    return false;
  }

  bool success = false;
  int  code    = http.GET();

  if (code == HTTP_CODE_OK) {
    String body = http.getString();
    DynamicJsonDocument doc(512);
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

static void _trafficTask(void*) {
  // Give WiFi time to settle before first fetch
  vTaskDelay(pdMS_TO_TICKS(8000));

  for (;;) {
    float c = _trafficCongestion;
    bool  ok = _doFetchTraffic(c);
    if (ok) _trafficCongestion = c;

    vTaskDelay(pdMS_TO_TICKS(ok ? _TRAFFIC_FETCH_INTERVAL_MS : _TRAFFIC_RETRY_MS));
  }
}

// Call once from setup() after WiFi is up.
static void initTraffic() {
  xTaskCreatePinnedToCore(
    _trafficTask,
    "traffic_fetch",
    8192,       // stack — enough for HTTPClient + JSON
    nullptr,
    1,          // priority (same as loop)
    &_trafficTaskHandle,
    0           // core 0; Arduino loop runs on core 1
  );
}

// No-op — timing is handled inside the task.
static void updateTraffic() {}

// Returns latest congestion (0.0 = free flow, 1.0 = gridlock).
// Safe to call from core 1 — float reads are atomic on Cortex-M.
static float trafficCongestion() { return _trafficCongestion; }

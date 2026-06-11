#pragma once
// OTA update via GitHub Releases.
// Must be #included at the top of the sketch, alongside the other includes.
// Call otaInit(&display) then checkForOTAUpdate() from setup().

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <HTTPUpdate.h>
#include <ArduinoJson.h>

#include "version.h"

// Set by otaInit() — keeps this header free of direct display references
static lgfx::LGFX_Device* _otaDisp = nullptr;

static void otaInit(lgfx::LGFX_Device* d) { _otaDisp = d; }

// ── Status text helpers ───────────────────────────────────────────────────────

static void _otaStatus(const char* msg, uint32_t col = 0xCCCCCCUL) {
    if (!_otaDisp) return;
    int w = _otaDisp->width();
    int h = _otaDisp->height();
    _otaDisp->fillRect(0, h - 42, w, 42, 0x000000UL);
    _otaDisp->setTextColor(col);
    _otaDisp->setTextSize(2);
    _otaDisp->setCursor(10, h - 30);
    _otaDisp->print(msg);
}

// ── Semver comparison ─────────────────────────────────────────────────────────
// Returns true if version string `a` is strictly newer than `b`.
// Both strings must be in "MAJOR.MINOR.PATCH" format.

static bool _semverNewer(const char* a, const char* b) {
    int aM = 0, am = 0, ap = 0;
    int bM = 0, bm = 0, bp = 0;
    sscanf(a, "%d.%d.%d", &aM, &am, &ap);
    sscanf(b, "%d.%d.%d", &bM, &bm, &bp);
    if (aM != bM) return aM > bM;
    if (am != bm) return am > bm;
    return ap > bp;
}

// ── Main OTA entry point ──────────────────────────────────────────────────────
// Connects WiFi, checks GitHub for a newer release, and flashes the binary if
// one is found. Disconnects WiFi before returning. Boots normally on any error.

static void checkForOTAUpdate() {
    char        buf[96];
    char        latestVer[32] = {};
    String      downloadUrl;

    // ── Connect WiFi ─────────────────────────────────────────────────────────
    _otaStatus("OTA: Connecting to WiFi...");
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

    {
        uint32_t t0 = millis();
        while (WiFi.status() != WL_CONNECTED) {
            if (millis() - t0 > 15000UL) {
                _otaStatus("OTA: WiFi timeout - skipping update");
                delay(1500);
                WiFi.disconnect(true);
                WiFi.mode(WIFI_OFF);
                return;
            }
            delay(200);
        }
        delay(500);   // let DHCP/DNS fully settle before opening TLS connections
    }

    // ── Query GitHub releases/latest ─────────────────────────────────────────
    _otaStatus("OTA: Checking for updates...");

    {
        WiFiClientSecure apiClient;
        apiClient.setInsecure();
        apiClient.setTimeout(15);

        HTTPClient http;
        if (!http.begin(apiClient,
                        "https://api.github.com/repos/" GITHUB_REPO "/releases/latest")) {
            _otaStatus("OTA: HTTP init failed");
            delay(1500);
            goto done;
        }

        http.addHeader("User-Agent", "ESP32-Aquarium/" FIRMWARE_VERSION);
        http.addHeader("Accept",     "application/vnd.github.v3+json");
        http.setTimeout(10000);

        {
            int code = http.GET();

            if (code == 404) {
                _otaStatus("OTA: No releases published yet");
                delay(1500);
                http.end();
                goto done;
            }
            if (code != 200) {
                snprintf(buf, sizeof(buf), "OTA: API error %d", code);
                _otaStatus(buf);
                delay(1500);
                http.end();
                goto done;
            }

            StaticJsonDocument<96> filter;
            filter["tag_name"]                          = true;
            filter["assets"][0]["name"]                 = true;
            filter["assets"][0]["browser_download_url"] = true;

            DynamicJsonDocument doc(4096);
            DeserializationError jerr =
                deserializeJson(doc, http.getStream(),
                                DeserializationOption::Filter(filter));
            http.end();

            if (jerr) {
                _otaStatus("OTA: JSON parse error");
                delay(1500);
                goto done;
            }

            const char* tagRaw = doc["tag_name"] | "";
            strncpy(latestVer,
                    (*tagRaw == 'v' || *tagRaw == 'V') ? tagRaw + 1 : tagRaw,
                    sizeof(latestVer) - 1);

            if (!_semverNewer(latestVer, FIRMWARE_VERSION)) {
                snprintf(buf, sizeof(buf), "OTA: Up to date (v%s)", FIRMWARE_VERSION);
                _otaStatus(buf);
                delay(1200);
                goto done;
            }

            for (JsonObject asset : doc["assets"].as<JsonArray>()) {
                if (String(asset["name"] | "").equals(GITHUB_ASSET_NAME)) {
                    downloadUrl = asset["browser_download_url"].as<String>();
                    break;
                }
            }

            if (downloadUrl.isEmpty()) {
                snprintf(buf, sizeof(buf), "OTA: No %s in release v%s",
                         GITHUB_ASSET_NAME, latestVer);
                _otaStatus(buf);
                delay(1500);
                goto done;
            }
        }
    }

    // ── Download and flash ────────────────────────────────────────────────────
    {
        snprintf(buf, sizeof(buf), "OTA: Updating to v%s...", latestVer);
        _otaStatus(buf, 0x44FF44UL);

        httpUpdate.setFollowRedirects(HTTPC_FORCE_FOLLOW_REDIRECTS);
        httpUpdate.rebootOnUpdate(true);

        httpUpdate.onProgress([](int cur, int total) {
            if (!_otaDisp || total <= 0) return;
            char pb[48];
            snprintf(pb, sizeof(pb), "OTA: Flashing %d%%", cur * 100 / total);
            _otaDisp->fillRect(0, _otaDisp->height() - 42,
                               _otaDisp->width(), 42, 0x000000UL);
            _otaDisp->setTextColor(0x44FF44UL);
            _otaDisp->setTextSize(2);
            _otaDisp->setCursor(10, _otaDisp->height() - 30);
            _otaDisp->print(pb);
        });

        WiFiClientSecure dlClient;
        dlClient.setInsecure();
        dlClient.setTimeout(60);

        t_httpUpdate_return ret = httpUpdate.update(dlClient, downloadUrl);
        switch (ret) {
            case HTTP_UPDATE_FAILED:
                snprintf(buf, sizeof(buf), "OTA failed: %s",
                         httpUpdate.getLastErrorString().c_str());
                _otaStatus(buf, 0xFF4444UL);
                delay(3000);
                break;
            case HTTP_UPDATE_NO_UPDATES:
                _otaStatus("OTA: No update needed");
                delay(1500);
                break;
            default:
                break;
        }
    }

done:
    WiFi.disconnect(true);
    WiFi.mode(WIFI_OFF);
}

#pragma once
// OTA update via GitHub Releases.
// Included from aquarium.ino after `display` is declared.
// Requires: WiFi.h, WiFiClientSecure.h, HTTPClient.h, HTTPUpdate.h, ArduinoJson.h

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <HTTPUpdate.h>
#include <ArduinoJson.h>

// ── Status text helpers ───────────────────────────────────────────────────────

static void _otaClear() {
    int w = display.width();
    int h = display.height();
    display.fillRect(0, h - 42, w, 42, 0x000000UL);
}

static void _otaStatus(const char* msg, uint32_t col = 0xCCCCCCUL) {
    _otaClear();
    display.setTextColor(col);
    display.setTextSize(2);
    display.setCursor(10, display.height() - 30);
    display.print(msg);
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
// Called once from setup(). Connects WiFi, checks GitHub for a newer release,
// and flashes the binary if one is found. Disconnects WiFi before returning.
// If anything fails the aquarium boots normally.

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
    }

    // ── Query GitHub releases/latest ─────────────────────────────────────────
    _otaStatus("OTA: Checking for updates...");

    {
        WiFiClientSecure apiClient;
        apiClient.setInsecure(); // cert pinning is omitted for a home device
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

            // Use a filter so we only materialise the fields we need
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

            // Strip optional leading 'v' / 'V' from tag (e.g. "v1.2.3" -> "1.2.3")
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

            // Find the firmware.bin asset
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

        // Show download progress on the status bar
        httpUpdate.onProgress([](int cur, int total) {
            if (total > 0) {
                char pb[48];
                snprintf(pb, sizeof(pb), "OTA: Flashing %d%%", cur * 100 / total);
                display.fillRect(0, display.height() - 42,
                                 display.width(), 42, 0x000000UL);
                display.setTextColor(0x44FF44UL);
                display.setTextSize(2);
                display.setCursor(10, display.height() - 30);
                display.print(pb);
            }
        });

        WiFiClientSecure dlClient;
        dlClient.setInsecure();
        dlClient.setTimeout(60);

        t_httpUpdate_return ret = httpUpdate.update(dlClient, downloadUrl);
        // Execution continues here only when the update did NOT trigger a reboot
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

#pragma once
// Pi variant config — no WiFi credentials needed, just weather API details.
// Copy this file, fill in your values, and add wifi_config.h to .gitignore.
#define WEATHER_API_KEY       "your_openweathermap_api_key"
#define WEATHER_LAT           "51.5074"
#define WEATHER_LON           "-0.1278"
// UTC offset in whole hours (e.g. 0 = UTC, 1 = CET, -5 = EST).
// Set to 0 to rely on the Pi's system timezone instead.
#define TIMEZONE_OFFSET_HOURS  0

// ── Telemetry (publishes live tank state to the aquarium-web server) ──────────
// Set TELEMETRY_ENABLED to 1 and point TELEMETRY_HOST at the server's base URL
// (include any reverse-proxy prefix, e.g. ".../aquarium"). TELEMETRY_API_KEY
// must match the server's API_KEY. Leave ENABLED 0 to disable.
#define TELEMETRY_ENABLED      1
#define TELEMETRY_HOST         "http://192.168.1.215/aquarium"
#define TELEMETRY_API_KEY      "change-me"
#define TELEMETRY_AQUARIUM_ID  "pi-living-room"
#define TELEMETRY_INTERVAL_MS  5000

#pragma once
// Pi variant config — no WiFi credentials needed, just weather API details.
// Copy this file, fill in your values, and add wifi_config.h to .gitignore.
#define WEATHER_API_KEY       "your_openweathermap_api_key"
#define WEATHER_LAT           "51.5074"
#define WEATHER_LON           "-0.1278"
// UTC offset in whole hours (e.g. 0 = UTC, 1 = CET, -5 = EST).
// Set to 0 to rely on the Pi's system timezone instead.
#define TIMEZONE_OFFSET_HOURS  0

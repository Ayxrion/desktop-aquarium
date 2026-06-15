# Telemetry JSON contract

Devices (ESP32 / Raspberry Pi) POST one snapshot per publish interval to:

```
POST <TELEMETRY_HOST>/api/telemetry
Content-Type: application/json
X-Api-Key: <shared key>           (or: Authorization: Bearer <shared key>)
```

`<TELEMETRY_HOST>` already includes any reverse-proxy prefix, e.g.
`http://192.168.1.215/aquarium`, so the device posts to
`http://192.168.1.215/aquarium/api/telemetry`.

The server keeps only the **latest** snapshot per `aquarium_id` (live view, no
history) and pushes it to browsers over SSE. Unknown fields are ignored; only
`aquarium_id` is required. Positions are integers (screen pixels); colors are
24-bit RGB integers (`0xRRGGBB`) already resolved from the device palette.

## Schema

```jsonc
{
  "aquarium_id": "living-room",   // REQUIRED, stable per device
  "platform": "esp32",            // "esp32" | "pi" | "mock"
  "fw_version": "1.5.5",
  "uptime_ms": 123456,            // millis() since boot
  "tick": 2480,                   // animation frame counter

  "screen": { "w": 800, "h": 480, "tank_top": 72 },

  "weather": {
    "condition": 3,               // 0 Sunny,1 PartlyCloudy,2 Cloudy,3 Rainy,
                                  // 4 Stormy,5 Snowy,6 Foggy
    "name": "RAINY",              // optional human label
    "override": false             // true when set manually via the device menu
  },

  "time": {
    "day_progress": 0.52,         // 0=midnight, 0.25=6am, 0.5=noon, 0.75=6pm
    "mode": "REAL"                // "REAL" | "FAST"
  },

  "counts": { "pair": 2, "school": 5, "school2": 7, "angel": 3 },

  "fish": [
    {
      "x": 120, "y": 210, "z": 0.3,
      "type": 1,                  // 0 pair,1 school,2 school2,3 angel
      "facing_right": true,
      "color": 65382,             // 0xRRGGBB
      "going_for_food": false,
      "chasing": false
    }
  ],

  "flakes": [ { "x": 400, "y": 300, "color": 16711680 } ],

  "snail":    { "x": 540, "facing_right": true },
  "starfish": { "x": 80,  "facing_right": false },
  "boat":     { "active": false, "x": 876 },

  "plants": {                     // near-static decor layout (for the renderer)
    "bg":       [ { "x": 60,  "segs": 7, "type": 1 } ],
    "weeds":    [ { "x": 120, "segs": 6 } ],
    "hornwort": [ { "x": 300, "segs": 5 } ]
  }
}
```

## Responses

| Status | Meaning |
|--------|---------|
| `200 {ok:true}` | accepted |
| `400` | missing/invalid `aquarium_id` |
| `401` | missing/wrong API key |
| `429` | `MAX_AQUARIUMS` capacity reached for a new id |

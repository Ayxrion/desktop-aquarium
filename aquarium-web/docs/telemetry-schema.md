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
      "id": 3,                    // stable per-device fish slot — used for naming/age
      "x": 120, "y": 210, "z": 0.3,
      "vx": 1.2, "vy": -0.4, "vz": 0.0,
      "tx": 180, "ty": 240, "tz": 0.3,   // current wander target
      "wander_cd": 12.50,         // FLOAT — frames until the next retarget (fractional)
      "type": 1,                  // 0 pair,1 school,2 school2,3 angel,4 salmon
      "facing_right": true,
      "color": 65382,             // 0xRRGGBB
      "going_for_food": false,
      "chasing": false,
      // Precomputed upcoming wander targets (FIFO, up to 4). Each entry is
      // [wcd, tx, ty, tz, chasing]. The web replication drains this queue when a fish's
      // countdown expires so it seeks the EXACT targets this device will, instead of
      // rolling its own random target and drifting until the next snapshot. The device
      // commits to these same values, so device + web stay in sync between snapshots.
      "wander_q": [ [40.0, 360, 230, 0.3, 0], [22.5, 150, 280, 0.3, 0] ]
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

The `200` response body is **not JSON** — it's the downstream **fish-name channel**
(`text/plain`), one `id<TAB>name` per named fish, e.g.:

```
0	Nemo
5	Dory
```

This is how names set in the web app reach the device without any inbound
connection (no firewall hole): the device's own POST carries them back. The
device replaces its name table from this body and renders each name above the
matching fish. Empty body = no names set.

| Status | Meaning |
|--------|---------|
| `200` + `id\tname` lines | accepted; body is the current name table |
| `400` | missing/invalid `aquarium_id` |
| `401` | missing/wrong API key |
| `429` | `MAX_AQUARIUMS` capacity reached for a new id |

## Naming API (dashboard → server)

```
POST /api/aquariums/<id>/fish/<fishId>/name
Content-Type: application/json
{ "name": "Nemo" }          // empty string clears the name
```
Names are keyed by `(aquarium_id, fish_id)`, sanitized, capped at 24 chars. The
enriched snapshot from `GET /api/aquariums/:id` and SSE adds `name` + `ageMs`.

# aquarium-web

Live telemetry visualization for the desktop aquarium apps (ESP32 + Raspberry
Pi). Devices POST their full state (weather, time-of-day, fish positions/types/
colors, snail/starfish/boat, food flakes, counts) to this server, which keeps
the latest snapshot per aquarium **in memory** and streams it to browsers over
Server-Sent Events. A dashboard renders each tank on an HTML canvas.

## Run locally

```bash
cd aquarium-web
npm install
API_KEY=change-me npm start          # serves http://localhost:3000
```

In a second terminal, feed it fake data:

```bash
API_KEY=change-me npm run mock        # or: node scripts/mock-publisher.js
```

Open http://localhost:3000 and select `mock-tank`.

## Environment

| Var | Default | Purpose |
|-----|---------|---------|
| `PORT` | `3000` | HTTP port |
| `API_KEY` | — (**required**) | Shared secret; must match devices' `TELEMETRY_API_KEY` |
| `STALE_MS` | `15000` | An aquarium is marked stale after this long without an update |
| `MAX_AQUARIUMS` | `64` | Capacity guard for new aquarium ids |

## API

| Method | Path | Notes |
|--------|------|-------|
| `POST` | `/api/telemetry` | Ingest. Needs `X-Api-Key` (or `Authorization: Bearer`). Body = [telemetry schema](docs/telemetry-schema.md). |
| `GET` | `/api/aquariums` | List + summary + stale flag |
| `GET` | `/api/aquariums/:id` | Latest full snapshot |
| `GET` | `/api/stream[?id=]` | SSE stream of snapshots |
| `GET` | `/healthz` | Health check |

See [docs/telemetry-schema.md](docs/telemetry-schema.md) for the payload contract.

## Deployment (task-scheduler-service)

This app deploys through the `task-scheduler-service` deploy service, which
pulls a GHCR image and reverse-proxies it under `/aquarium/`.

1. **CI** ([../.github/workflows/aquarium-web.yml](../.github/workflows/aquarium-web.yml))
   builds and pushes `ghcr.io/ayxrion/desktop-aquarium/aquarium-web:latest`
   on every push to the **`RaspberryPi-WebServer`** branch touching `aquarium-web/**`.
2. **Register once** with the deploy service:
   ```bash
   DEPLOY_HOST=http://<host> API_KEY=<secret> ./deploy/register.sh
   ```
   The `API_KEY` here becomes the container's env and **must equal** the
   devices' `TELEMETRY_API_KEY`.
3. The deploy service polls GHCR every ~5 min; force an immediate pull with
   `curl -X POST http://<host>/api/watch/trigger`.
4. Browse `http://<host>/aquarium/`.

> Because the app is served under the `/aquarium/` prefix, **all front-end URLs
> are relative** and the SSE endpoint sends `X-Accel-Buffering: no` so events
> flow through nginx.

## Device configuration

Point each device at this server by setting these in its `wifi_config.h`:

```c
#define TELEMETRY_ENABLED      1
#define TELEMETRY_HOST         "http://<host>/aquarium"   // include the prefix
#define TELEMETRY_API_KEY      "change-me"                 // == server API_KEY
#define TELEMETRY_AQUARIUM_ID  "living-room"
#define TELEMETRY_INTERVAL_MS  1000
```

#!/usr/bin/env bash
# Registers aquarium-web with the task-scheduler deploy service (one-time).
# The deploy service then auto-pulls the GHCR image and reverse-proxies it at
# the route_prefix. Re-run with PATCH semantics is not supported here — to
# change settings, use PATCH /api/apps/:id or delete + re-register.
#
# Usage:
#   DEPLOY_HOST=http://192.168.1.215 API_KEY=your-secret ./register.sh
#
# DEPLOY_HOST is the task-scheduler ingress (nginx on :80 routes /api to the
# backend), e.g. http://192.168.1.215. The script posts to $DEPLOY_HOST/api/apps.
# API_KEY MUST match TELEMETRY_API_KEY configured on the devices.

set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:-http://192.168.1.215}"
API_KEY="${API_KEY:-change-me}"
IMAGE="${IMAGE:-ghcr.io/ayxrion/desktop-aquarium/aquarium-web:latest}"
REPO="${REPO:-https://github.com/Ayxrion/desktop-aquarium/tree/RaspberryPi-WebServer}"

env_json=$(printf '{"API_KEY":"%s"}' "$API_KEY")

curl -fsS -X POST "${DEPLOY_HOST}/api/apps" \
  -H "Content-Type: application/json" \
  -d @- <<JSON
{
  "name": "aquarium-web",
  "label": "Aquarium Web Server",
  "description": "Live telemetry visualization for desktop aquariums",
  "github_repo": "${REPO}",
  "docker_image": "${IMAGE}",
  "internal_port": 3000,
  "route_prefix": "/aquarium",
  "strip_prefix": 1,
  "enabled": 1,
  "env_json": $(printf '%s' "$env_json" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')
}
JSON

echo
echo "Registered. Trigger an immediate deploy with:"
echo "  curl -X POST ${DEPLOY_HOST}/api/watch/trigger"

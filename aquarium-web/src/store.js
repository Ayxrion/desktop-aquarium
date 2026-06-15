'use strict';

// In-memory store of the latest telemetry snapshot per aquarium, plus a tiny
// pub/sub used to push updates to SSE subscribers. State is intentionally
// ephemeral — this is a live view, not a historical record. A container
// restart simply waits for the next telemetry post from each device.

const STALE_MS = parseInt(process.env.STALE_MS || '15000', 10);
const MAX_AQUARIUMS = parseInt(process.env.MAX_AQUARIUMS || '64', 10);

/** @type {Map<string, {snapshot: object, lastSeenMs: number}>} */
const aquariums = new Map();

/** @type {Set<(snapshot: object) => void>} */
const subscribers = new Set();

function now() {
  return Date.now();
}

function isStale(lastSeenMs) {
  return now() - lastSeenMs > STALE_MS;
}

// Insert/replace the snapshot for an aquarium and notify SSE subscribers.
// Returns { ok } or { ok:false, error } when the capacity guard trips.
function upsert(snapshot) {
  const id = snapshot.aquarium_id;
  if (!aquariums.has(id) && aquariums.size >= MAX_AQUARIUMS) {
    return { ok: false, error: 'max_aquariums_reached' };
  }
  aquariums.set(id, { snapshot, lastSeenMs: now() });
  for (const fn of subscribers) {
    try {
      fn(snapshot);
    } catch {
      /* a broken subscriber must not break ingest */
    }
  }
  return { ok: true };
}

// Compact summary for the dashboard list view.
function list() {
  const out = [];
  for (const [id, entry] of aquariums) {
    const s = entry.snapshot;
    const counts = s.counts || {};
    const fishCount =
      (counts.pair || 0) +
      (counts.school || 0) +
      (counts.school2 || 0) +
      (counts.angel || 0);
    out.push({
      aquarium_id: id,
      platform: s.platform || 'unknown',
      fw_version: s.fw_version || null,
      lastSeenMs: entry.lastSeenMs,
      stale: isStale(entry.lastSeenMs),
      fishCount,
      counts,
      weather: s.weather || null,
    });
  }
  out.sort((a, b) => a.aquarium_id.localeCompare(b.aquarium_id));
  return out;
}

function get(id) {
  const entry = aquariums.get(id);
  if (!entry) return null;
  return { ...entry.snapshot, _lastSeenMs: entry.lastSeenMs, _stale: isStale(entry.lastSeenMs) };
}

function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

module.exports = { upsert, list, get, subscribe, STALE_MS, MAX_AQUARIUMS };

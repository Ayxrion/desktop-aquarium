'use strict';

// In-memory store of the latest telemetry snapshot per aquarium, plus per-fish
// names and age tracking, plus a tiny pub/sub used to push updates to SSE
// subscribers. State is ephemeral (live view) but persists for the life of the
// process — a restart simply waits for the next telemetry post.
//
// Fish identity is the device-provided `id` (the fish's stable array slot).
// Names are keyed by (aquarium_id, fish_id); age is derived from when the
// server first saw a given fish id (reset if the fish was absent for a while).

const STALE_MS = parseInt(process.env.STALE_MS || '15000', 10);
const MAX_AQUARIUMS = parseInt(process.env.MAX_AQUARIUMS || '64', 10);
const FISH_GAP_MS = parseInt(process.env.FISH_GAP_MS || '10000', 10); // absence => new fish
const MAX_NAME_LEN = 24;

/**
 * @typedef {{ snapshot: object, lastSeenMs: number,
 *             names: Map<number,string>,
 *             meta: Map<number,{firstSeenMs:number,lastSeenMs:number}> }} Entry
 */
/** @type {Map<string, Entry>} */
const aquariums = new Map();

/** @type {Set<(snapshot: object) => void>} */
const subscribers = new Set();

function now() {
  return Date.now();
}

function isStale(lastSeenMs) {
  return now() - lastSeenMs > STALE_MS;
}

function sanitizeName(name) {
  if (typeof name !== 'string') return null;
  // Strip the tab/newline used as delimiters in the device response, collapse
  // whitespace, clamp length.
  return name.replace(/[\t\n\r]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LEN);
}

function getOrCreate(id) {
  let entry = aquariums.get(id);
  if (!entry) {
    entry = { snapshot: null, lastSeenMs: 0, names: new Map(), meta: new Map() };
    aquariums.set(id, entry);
  }
  return entry;
}

// Update per-fish age metadata from a snapshot's fish list.
function updateFishMeta(entry, fish) {
  const t = now();
  for (const f of fish) {
    if (typeof f.id !== 'number') continue;
    const m = entry.meta.get(f.id);
    if (!m || t - m.lastSeenMs > FISH_GAP_MS) {
      entry.meta.set(f.id, { firstSeenMs: t, lastSeenMs: t }); // new / reappeared
    } else {
      m.lastSeenMs = t;
    }
  }
}

// Return a snapshot copy with each fish augmented with its name + ageMs.
function enrich(entry) {
  const s = entry.snapshot;
  if (!s) return null;
  const t = now();
  const fish = Array.isArray(s.fish)
    ? s.fish.map((f) => {
        const m = entry.meta.get(f.id);
        return {
          ...f,
          name: entry.names.get(f.id) || null,
          ageMs: m ? t - m.firstSeenMs : 0,
        };
      })
    : [];
  return { ...s, fish, _lastSeenMs: entry.lastSeenMs, _stale: isStale(entry.lastSeenMs) };
}

function broadcast(entry) {
  const enriched = enrich(entry);
  if (!enriched) return;
  for (const fn of subscribers) {
    try {
      fn(enriched);
    } catch {
      /* a broken subscriber must not break ingest */
    }
  }
}

// Insert/replace the snapshot for an aquarium and notify SSE subscribers.
function upsert(snapshot) {
  const id = snapshot.aquarium_id;
  if (!aquariums.has(id) && aquariums.size >= MAX_AQUARIUMS) {
    return { ok: false, error: 'max_aquariums_reached' };
  }
  const entry = getOrCreate(id);
  entry.snapshot = snapshot;
  entry.lastSeenMs = now();
  if (Array.isArray(snapshot.fish)) updateFishMeta(entry, snapshot.fish);
  broadcast(entry);
  return { ok: true };
}

// Compact downstream payload for the device (text/plain): one `id\tname` per
// named fish. Trivial to parse on a microcontroller; names are pre-sanitized of
// the delimiters. Empty string when no names are set.
function getNamesText(id) {
  const entry = aquariums.get(id);
  if (!entry) return '';
  const lines = [];
  for (const [fishId, name] of entry.names) lines.push(`${fishId}\t${name}`);
  return lines.join('\n');
}

function setName(aquariumId, fishId, rawName) {
  const entry = getOrCreate(aquariumId);
  const name = sanitizeName(rawName);
  if (name === null) return { ok: false, error: 'invalid_name' };
  if (name === '') entry.names.delete(fishId);
  else entry.names.set(fishId, name);
  broadcast(entry); // open dashboards update immediately
  return { ok: true, name };
}

// Compact summary for the dashboard list view.
function list() {
  const out = [];
  for (const [id, entry] of aquariums) {
    const s = entry.snapshot || {};
    const counts = s.counts || {};
    const fishCount =
      (counts.pair || 0) + (counts.school || 0) + (counts.school2 || 0) + (counts.angel || 0);
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
  if (!entry || !entry.snapshot) return null;
  return enrich(entry);
}

function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

module.exports = {
  upsert, list, get, subscribe, setName, getNamesText,
  STALE_MS, MAX_AQUARIUMS,
};

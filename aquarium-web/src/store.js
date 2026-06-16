'use strict';

// In-memory store of the latest telemetry snapshot per aquarium, plus per-fish
// names and age tracking, plus a tiny pub/sub used to push updates to SSE
// subscribers. State is persisted to SQLite (via db.js) and restored on startup
// so a server restart doesn't lose aquarium history or fish names.
//
// Fish identity is the device-provided `id` (the fish's stable array slot).
// Names are keyed by (aquarium_id, fish_id); age is derived from when the
// server first saw a given fish id (reset if the fish was absent for a while).

const db = require('./db');

const STALE_MS = parseInt(process.env.STALE_MS || '15000', 10);
const MAX_AQUARIUMS = parseInt(process.env.MAX_AQUARIUMS || '64', 10);
const FISH_GAP_MS = parseInt(process.env.FISH_GAP_MS || '10000', 10); // absence => new fish
const MAX_NAME_LEN = 24;

// Physics simulation matching the device (aquarium.ino / main.cpp).
const _DAMP  = 0.85;
const TANK_TOP = 72, SCREEN_W = 800, SCREEN_H = 480;

function _bound(v, lo, hi, k) {
  if (v < lo) return (lo - v) * k;
  if (v > hi) return (hi - v) * k;
  return 0;
}

// Joint simulation: all fish stepped together each frame so school centroids
// and pairwise separation forces match the device's updateFish() exactly.
function _extrapolateSnapshot(snapshot, elapsedMs) {
  const fish = snapshot && Array.isArray(snapshot.fish) ? snapshot.fish : [];
  if (!fish.length) return snapshot;
  const fm = snapshot.frame_ms || 50;
  const n  = Math.round(Math.min(elapsedMs, 3000) / fm);
  if (n === 0) return snapshot;

  const st = fish.map((f) => ({
    id: f.id, type: f.type || 0,
    x: f.x, y: f.y, z: f.z || 0,
    vx: f.vx || 0, vy: f.vy || 0, vz: f.vz || 0,
    tx: f.tx ?? f.x, ty: f.ty ?? f.y,
    wcd: typeof f.wander_cd === 'number' ? f.wander_cd : n,
    chasing: !!f.chasing, going_for_food: !!f.going_for_food,
  }));

  for (let frame = 0; frame < n; frame++) {
    const cent = [0, 1, 2, 3].map((t) => {
      const g = st.filter((f) => f.type === t);
      if (!g.length) return { x: 0, y: 0 };
      return { x: g.reduce((s, f) => s + f.x, 0) / g.length,
               y: g.reduce((s, f) => s + f.y, 0) / g.length };
    });
    for (const f of st) {
      f.wcd--;
      const t = f.type, chasing = f.chasing && t === 0;
      const seeking = f.going_for_food || f.wcd >= 0;
      const seekStr = chasing ? 0.018 : (t === 3 ? 0.020 : 0.012);
      const maxV    = f.going_for_food ? 8.0 : (chasing || t === 3) ? 7.0 : 5.5;
      let ax = seeking ? (f.tx - f.x) * seekStr : 0;
      let ay = seeking ? (f.ty - f.y) * seekStr : 0;
      if (t === 1 || t === 2) {
        ax += (cent[t].x - f.x) * 0.010; ay += (cent[t].y - f.y) * 0.007;
      } else if (t === 3) {
        ax += (cent[3].x - f.x) * 0.012; ay += (cent[3].y - f.y) * 0.010;
      }
      const sepR2 = t === 3 ? 60*60 : 80*80, sepK = t === 3 ? 7 : 8;
      if (t === 1 || t === 2 || t === 3) {
        for (const o of st) {
          if (o === f || o.type !== t) continue;
          const dx = f.x - o.x, dy = f.y - o.y, d2 = dx*dx + dy*dy;
          if (d2 < sepR2 && d2 > 0.01) { const inv = sepK/d2; ax += dx*inv; ay += dy*inv; }
        }
      }
      ax += _bound(f.x, 30, SCREEN_W - 30, 0.30);
      ay += _bound(f.y, TANK_TOP + 20, SCREEN_H - 80, 0.30);
      f.vx = Math.max(-maxV,     Math.min(maxV,     f.vx + ax)) * _DAMP;
      f.vy = Math.max(-maxV*0.5, Math.min(maxV*0.5, f.vy + ay)) * _DAMP;
      f.x  = Math.max(5,          Math.min(SCREEN_W - 5,  f.x + f.vx));
      f.y  = Math.max(TANK_TOP+5, Math.min(SCREEN_H - 60, f.y + f.vy));
    }
  }

  const fishOut = fish.map((orig, i) => ({
    ...orig, x: Math.round(st[i].x), y: Math.round(st[i].y), z: st[i].z,
  }));
  return { ...snapshot, fish: fishOut };
}

/**
 * @typedef {{ snapshot: object, lastSeenMs: number,
 *             names: Map<number,string>,
 *             meta: Map<number,{firstSeenMs:number,lastSeenMs:number}> }} Entry
 */
/** @type {Map<string, Entry>} */
const aquariums = new Map();

// Restore persisted state on startup so the server is immediately useful after
// a restart without waiting for the next device telemetry post.
(function _restore() {
  const rows = db.loadAll();
  for (const row of rows) {
    if (!row.snapshot) continue;
    const entry = {
      snapshot: row.snapshot,
      lastSeenMs: row.lastSeenMs,
      createdAt: row.createdAt,
      names: row.names,           // Map<fishId, name> from DB
      meta: new Map(),
    };
    // Re-seed fish meta from the persisted snapshot so ageMs is meaningful.
    if (Array.isArray(row.snapshot.fish)) {
      for (const f of row.snapshot.fish) {
        if (typeof f.id === 'number')
          entry.meta.set(f.id, { firstSeenMs: row.createdAt, lastSeenMs: row.lastSeenMs });
      }
    }
    aquariums.set(row.id, entry);
  }
  if (rows.length) console.log(`Store: restored ${rows.length} aquarium(s) from DB`);
})();

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
    entry = { snapshot: null, lastSeenMs: 0, createdAt: now(), names: new Map(), meta: new Map() };
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

// Return a snapshot copy with each fish augmented with name + ageMs.
// Raw positions and velocities are preserved so SSE/browser clients can do
// their own 60fps extrapolation without double-applying it here.
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

// Like enrich() but also extrapolates positions forward from lastSeenMs.
// Used only by the REST GET endpoint so poll-only clients get a current estimate.
function enrichExtrapolated(entry) {
  const base = enrich(entry);
  if (!base) return null;
  const elapsedMs = now() - entry.lastSeenMs;
  return _extrapolateSnapshot(base, elapsedMs);
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
  const t = now();
  entry.snapshot = snapshot;
  entry.lastSeenMs = t;
  if (Array.isArray(snapshot.fish)) updateFishMeta(entry, snapshot.fish);
  db.saveSnapshot(id, snapshot, t, entry.createdAt);
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
  db.saveName(aquariumId, fishId, name);
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
  return enrichExtrapolated(entry);
}

// Bootstrap response for a device that just booted. Returns the last-persisted
// snapshot with names embedded in each fish object so the device can restore
// positions and names in one call. Returns null if no record exists yet.
function bootstrap(id) {
  // Prefer in-memory (may have names set since last snapshot), fall back to DB.
  const entry = aquariums.get(id);
  if (!entry || !entry.snapshot) {
    // Try DB directly in case the server just restarted and hasn't received a
    // telemetry post yet (loadAll already ran, so this is a true miss).
    return null;
  }
  const s = entry.snapshot;
  const snapshotAgeMs = now() - entry.lastSeenMs;
  const fish = Array.isArray(s.fish)
    ? s.fish.map((f) => ({
        ...f,
        name: entry.names.get(f.id) || null,
      }))
    : [];
  return {
    exists: true,
    aquarium_id: id,
    snapshot_age_ms: snapshotAgeMs,
    created_at: entry.createdAt,
    fish,
    counts: s.counts || null,
    screen: s.screen || null,
  };
}

function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

module.exports = {
  upsert, list, get, bootstrap, subscribe, setName, getNamesText,
  STALE_MS, MAX_AQUARIUMS,
};

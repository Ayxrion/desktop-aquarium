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

// Fresh per-aquarium downstream-command state. The server can only talk to a
// device in the response to that device's telemetry POST, so dashboard control
// actions are buffered here and drained by getNamesText() into `!`-directive
// lines. Each command type is collapsed to a single line per response (latest
// weather/time wins; fish/feed counts accumulate) so the firmware can parse each
// with one substring match.
function freshPending() {
  return {
    restore: false,            // !RESTORE — re-fetch + adopt the server profile
    weather: null,             // !WEATHER:<-1..6>  (null = nothing queued)
    time: null,                // !TIME:<0|1>       (0 REAL, 1 FAST) — legacy
    timescale: null,           // !TIMESCALE:<1..5> (sim speed multiplier; null = nothing queued)
    fishAdd: [0, 0, 0, 0, 0],  // !FISHADD:<type>:<count>  per type 0..4 (incl. salmon)
    fishDel: [0, 0, 0, 0, 0],  // !FISHDEL:<type>:<count>
    feed: 0,                   // !FEED:<count>
    // ── Career-mode game directives ──
    mode: null,                // !MODE:<0|1>  (0 creative, 1 career; latest wins)
    catch: [],                 // !CATCH:<id,id,…>  wanderer/loot item ids to grab
    buyFish: [0, 0, 0, 0, 0],  // !BUYFISH:<type>:<count>  shop purchase (device deducts)
    buyFood: 0,                // !BUYFOOD:<count>
    buySnail: 0,               // !BUYSNAIL:<count>  coin-collector snail
    sellFish: [],              // !SELLFISH:<id,id,…>  sell fish by slot id (device removes + credits coins)
    switchAq: null,            // !SWITCHAQ:<id>  tell a physical device to load a different aquarium
  };
}

const STALE_MS = parseInt(process.env.STALE_MS || '15000', 10);
const MAX_AQUARIUMS = parseInt(process.env.MAX_AQUARIUMS || '64', 10);
const FISH_GAP_MS = parseInt(process.env.FISH_GAP_MS || '10000', 10); // absence => new fish
const MAX_NAME_LEN = 24;

// Physics simulation matching the device (aquarium.ino / main.cpp).
const _DAMP  = 0.85;
const _DAMPZ = 0.88;
const TANK_TOP = 72, SCREEN_W = 800, SCREEN_H = 480;
const SAND_Y = SCREEN_H - 20;     // floor coins rest on (matches device SAND_Y)
const COIN_GRAV = 0.1;            // coin sink acceleration (px/frame²) — matches device
const COIN_MAX_VY = 1.4;          // terminal sink speed (px/frame) — matches device
const COIN_REST_FRAMES = 240;     // frames a landed coin sits before vanishing (~12s)

function _bound(v, lo, hi, k) {
  if (v < lo) return (lo - v) * k;
  if (v > hi) return (hi - v) * k;
  return 0;
}

// Joint simulation: all fish stepped together each frame so school centroids
// and pairwise separation forces match the device's updateFish() exactly. Loot,
// wanderers and collector snails are stepped deterministically too (updateCareer).
function _extrapolateSnapshot(snapshot, elapsedMs) {
  if (!snapshot) return snapshot;
  const fm = snapshot.frame_ms || 50;
  // Predict forward up to 30s (was 3s). The old 3s cap froze the tank between sparse
  // device posts; fish should keep swimming via wander retargeting (below) until fresh
  // telemetry — or the tank goes stale — arrives.
  const n  = Math.round(Math.min(Math.max(elapsedMs, 0), 30000) / fm);
  if (n === 0) return snapshot;

  const fish = Array.isArray(snapshot.fish) ? snapshot.fish : [];
  let fishOut = fish;
  if (fish.length) {
    const st = fish.map((f) => ({
      id: f.id, type: f.type || 0,
      x: f.x, y: f.y, z: f.z || 0,
      vx: f.vx || 0, vy: f.vy || 0, vz: f.vz || 0,
      tx: f.tx ?? f.x, ty: f.ty ?? f.y, tz: typeof f.tz === 'number' ? f.tz : (f.z || 0),
      wcd: typeof f.wander_cd === 'number' ? f.wander_cd : 30,
      chasing: !!f.chasing, going_for_food: !!f.going_for_food,
    }));

    for (let frame = 0; frame < n; frame++) {
      // Sub-school centroids: schooling types split into schools capped at FISH_SCHOOL_SIZE,
      // each fish coheres to its own school's centroid (so beyond the cap a new school forms).
      const cent = {};
      const order = [0, 0, 0, 0, 0];
      for (const f of st) {
        const sz = FISH_SCHOOL_SIZE[f.type] || 0;
        f._sub = sz >= 2 ? Math.floor(order[f.type] / sz) : 0;
        order[f.type]++;
        const k = f.type + ':' + f._sub;
        const c = cent[k] || (cent[k] = { x: 0, y: 0, z: 0, n: 0 });
        c.x += f.x; c.y += f.y; c.z += f.z; c.n++;
      }
      for (const k in cent) { const c = cent[k]; c.x /= c.n; c.y /= c.n; c.z /= c.n; }
      for (const f of st) {
        const t = f.type;
        // Wander retargeting (mirrors the device + client predictor): when the countdown
        // expires, choose a fresh target so the fish keep roaming instead of settling on
        // a stale one. Keeps the REST/poll view alive between sparse device posts.
        if (f.wcd > 0) {
          f.wcd--;
        } else {
          if (t === 0) {
            f.chasing = !f.chasing;
            f.wcd = f.chasing ? 30 + Math.random() * 40 : 40 + Math.random() * 50;
          } else if (t === 3) { f.wcd = 8 + Math.random() * 20; }
          else { f.wcd = 15 + Math.random() * 35; }
          if (t === 4) {
            f.tx = 30 + Math.random() * (SCREEN_W - 60);
            f.ty = (TANK_TOP + 20) + Math.random() * (SCREEN_H - 80 - (TANK_TOP + 20));
          } else {
            const cg = cent[t + ':' + f._sub];
            const spread = t === 3 ? 120 : t === 0 ? 0 : 160;
            f.tx = Math.max(30, Math.min(SCREEN_W - 30, cg.x + (Math.random() * 2 - 1) * spread));
            f.ty = Math.max(TANK_TOP + 20, Math.min(SCREEN_H - 80, cg.y + (Math.random() * 2 - 1) * (t === 3 ? 110 : 90)));
          }
        }
        const chasing = f.chasing && t === 0;
        const seekStr = chasing ? 0.018 : (t === 3 ? 0.020 : 0.012);
        const maxV    = f.going_for_food ? 8.0 : (chasing || t === 3) ? 7.0 : 5.5;
        let ax = (f.tx - f.x) * seekStr;
        let ay = (f.ty - f.y) * seekStr;
        let az = (f.tz - f.z) * 0.010;
        const grp = cent[t + ':' + f._sub];
        if (t === 1 || t === 2) {
          ax += (grp.x - f.x) * 0.010; ay += (grp.y - f.y) * 0.007; az += (grp.z - f.z) * 0.007;
        } else if (t === 3) {
          ax += (grp.x - f.x) * 0.012; ay += (grp.y - f.y) * 0.010; az += (grp.z - f.z) * 0.008;
        }
        const sepR2 = t === 3 ? 60*60 : 80*80, sepK = t === 3 ? 7 : 8;
        if (t === 1 || t === 2 || t === 3) {
          for (const o of st) {
            if (o === f || o.type !== t || o._sub !== f._sub) continue;
            const dx = f.x - o.x, dy = f.y - o.y, d2 = dx*dx + dy*dy;
            if (d2 < sepR2 && d2 > 0.01) { const inv = sepK/d2; ax += dx*inv; ay += dy*inv; }
          }
        }
        ax += _bound(f.x, 30, SCREEN_W - 30, 0.30);
        ay += _bound(f.y, TANK_TOP + 20, SCREEN_H - 80, 0.30);
        az += _bound(f.z, 0.0, 0.75, 0.08);
        f.vx = Math.max(-maxV,     Math.min(maxV,     f.vx + ax)) * _DAMP;
        f.vy = Math.max(-maxV*0.5, Math.min(maxV*0.5, f.vy + ay)) * _DAMP;
        f.vz = Math.max(-0.015,    Math.min(0.015,    f.vz + az)) * _DAMPZ;
        f.x  = Math.max(5,          Math.min(SCREEN_W - 5,  f.x + f.vx));
        f.y  = Math.max(TANK_TOP+5, Math.min(SCREEN_H - 60, f.y + f.vy));
        f.z  = Math.max(0,          Math.min(0.78,          f.z + f.vz));
      }
    }

    fishOut = fish.map((orig, i) => ({
      ...orig, x: st[i].x, y: st[i].y, z: st[i].z,
      vx: st[i].vx, vy: st[i].vy, vz: st[i].vz,
    }));
  }

  const out = { ...snapshot, fish: fishOut };
  const baseTick = typeof snapshot.tick === 'number' ? snapshot.tick : 0;

  if (Array.isArray(snapshot.loot)) {
    out.loot = snapshot.loot.map((it) => {
      let y = it.y, vy = it.vy || 0, landed = !!it.landed;
      let ttl = typeof it.ttl === 'number' ? it.ttl : 9999;
      const isCoin = it.kind === 'coin';
      for (let f = 0; f < n; f++) {
        if (isCoin && !landed) {
          vy = Math.min(vy + COIN_GRAV, COIN_MAX_VY); y += vy;
          if (y >= SAND_Y) { y = SAND_Y; landed = true; ttl = COIN_REST_FRAMES; }
        } else { ttl -= 1; }
      }
      return { ...it, y, vy, landed, ttl };
    }).filter((it) => it.ttl > 0);
  }
  if (Array.isArray(snapshot.wanderers)) {
    out.wanderers = snapshot.wanderers.map((w) => {
      let x = w.x, y = w.y; const vx = w.vx || 0, bob = w.bob || 0;
      for (let f = 0; f < n; f++) { x += vx; y += Math.sin((baseTick + f) * 0.05 + bob) * 0.6; }
      return { ...w, x, y };
    }).filter((w) => w.x > -40 && w.x < SCREEN_W + 40);
  }
  if (Array.isArray(snapshot.snails)) {
    out.snails = snapshot.snails.map((s) => {
      let x = s.x, dir = s.facing_right ? 1 : -1; const spd = s.spd || 0;
      for (let f = 0; f < n; f++) {
        x += dir * spd;
        if (x > SCREEN_W - 55) { x = SCREEN_W - 55; dir = -1; }
        if (x < 55)            { x = 55;            dir = 1; }
      }
      return { ...s, x, facing_right: dir > 0 };
    });
  }
  return out;
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
    const entry = {
      snapshot: row.snapshot || null,
      saved: row.snapshot || null,          // persisted snapshot is the baseline
      savedSig: row.snapshot ? profileSig(row.snapshot) : null,
      conflict: null,
      awaitingRestore: false,
      adoptNext: false,
      pending: freshPending(),
      lastSeenMs: row.lastSeenMs,
      createdAt: row.createdAt,
      name: row.name || null,     // friendly display name (dashboard-assigned)
      names: row.names,           // Map<fishId, name> from DB
      meta: new Map(),
    };
    // Re-seed fish meta from the persisted snapshot so ageMs is meaningful.
    if (row.snapshot && Array.isArray(row.snapshot.fish)) {
      for (const f of row.snapshot.fish) {
        if (typeof f.id === 'number')
          entry.meta.set(f.id, { firstSeenMs: row.createdAt, lastSeenMs: row.lastSeenMs });
      }
    }
    aquariums.set(row.id, entry);
  }
  if (rows.length) console.log(`Store: restored ${rows.length} aquarium(s) from DB`);
})();

// ── Devices ────────────────────────────────────────────────────────────────────
// A device is a physical Pi/ESP that self-registers via telemetry. (There are no
// "virtual" devices any more — any aquarium WITHOUT a live device is run by the
// server's built-in web simulator; see deviceManager.js.) An aquarium is a standalone
// saved tank; a device "plays" at most one aquarium at a time (`aquariumId`).
/** @type {Map<string, {id,name,kind,aquariumId,createdAt,lastSeenMs}>} */
const devices = new Map();
let _devSeq = 1;
(function _restoreDevices() {
  for (const d of db.loadDevices()) { if (d && d.id) devices.set(d.id, d); _devSeq++; }
  if (devices.size) console.log(`Store: restored ${devices.size} device(s) from DB`);
})();
function _persistDevices() { db.saveDevices([...devices.values()]); }
function _newDeviceId() { return 'dev-' + now().toString(36) + '-' + (_devSeq++); }
// An aquarium has at most one device: assigning it to one frees it from any other.
function _unassignAquariumFromOthers(aquariumId, exceptId) {
  if (!aquariumId) return;
  for (const d of devices.values())
    if (d.id !== exceptId && d.aquariumId === aquariumId) d.aquariumId = null;
}

function listDevices() {
  return [...devices.values()].map((d) => ({ ...d, online: !isStale(d.lastSeenMs || 0) }));
}
// True when a (physical) device is currently live and bound to this aquarium. The
// server simulator (deviceManager) defers to a real device whenever this is true.
function hasLiveDevice(aquariumId) {
  if (!aquariumId) return false;
  for (const d of devices.values())
    if (d.aquariumId === aquariumId && !isStale(d.lastSeenMs || 0)) return true;
  return false;
}
// Device summary (if any) currently bound to an aquarium — live one preferred.
function deviceForAquarium(aquariumId) {
  let best = null;
  for (const d of devices.values()) {
    if (d.aquariumId !== aquariumId) continue;
    const online = !isStale(d.lastSeenMs || 0);
    if (!best || (online && !best.online)) best = { id: d.id, name: d.name, kind: d.kind, online };
  }
  return best;
}
function getDevice(id) {
  const d = devices.get(id);
  return d ? { ...d, online: !isStale(d.lastSeenMs || 0) } : null;
}
function createDevice(opts = {}) {
  const id = opts.id || _newDeviceId();
  const d = {
    id,
    name: sanitizeName(opts.name) || (opts.kind === 'virtual' ? 'Virtual device' : 'Device'),
    kind: opts.kind || 'virtual',
    aquariumId: opts.aquariumId || null,
    createdAt: now(),
    lastSeenMs: 0,
  };
  if (d.aquariumId) _unassignAquariumFromOthers(d.aquariumId, id);
  devices.set(id, d);
  _persistDevices();
  return d;
}
// Rename / (re)assign which aquarium a device plays. assignAquarium(null) unassigns.
function updateDevice(id, patch = {}) {
  const d = devices.get(id);
  if (!d) return null;
  if (patch.name != null) { const n = sanitizeName(patch.name); if (n) d.name = n; }
  if ('aquariumId' in patch) {
    const oldAq = d.aquariumId;
    d.aquariumId = patch.aquariumId || null;
    if (d.aquariumId) _unassignAquariumFromOthers(d.aquariumId, d.id);
    // A physical device is still polling its OLD aquarium's directive channel; queue a
    // !SWITCHAQ there so it loads the new tank. (Virtual devices are rebound by the
    // tick manager directly, so they need no directive.)
    if (d.kind !== 'virtual' && oldAq && d.aquariumId && oldAq !== d.aquariumId) {
      const e = aquariums.get(oldAq);
      if (e) { (e.pending || (e.pending = freshPending())).switchAq = d.aquariumId; }
    }
  }
  _persistDevices();
  return { ...d, online: !isStale(d.lastSeenMs || 0) };
}
function removeDevice(id) {
  const ok = devices.delete(id);
  if (ok) _persistDevices();
  return ok;
}
// Self-registration from a telemetry POST (physical hardware can create its device +
// aquarium before the server knew about either). Only persists on structural changes;
// the per-tick lastSeenMs bump stays in memory.
function registerDeviceFromTelemetry(snapshot) {
  const id = snapshot.device_id;
  if (!id) return;
  let d = devices.get(id);
  let structural = false;
  if (!d) {
    d = { id, name: sanitizeName(snapshot.device_name) || id,
          kind: snapshot.platform || 'device', aquariumId: snapshot.aquarium_id || null,
          createdAt: now(), lastSeenMs: now() };
    devices.set(id, d);
    structural = true;
  } else {
    if (snapshot.aquarium_id && d.aquariumId !== snapshot.aquarium_id) { d.aquariumId = snapshot.aquarium_id; structural = true; }
    d.lastSeenMs = now();
  }
  if (structural) _persistDevices();
}

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
    entry = {
      snapshot: null, lastSeenMs: 0, createdAt: now(),
      name: null,             // friendly display name (dashboard-assigned)
      names: new Map(), meta: new Map(),
      saved: null,            // source-of-truth snapshot (profile baseline)
      savedSig: null,         // profileSig(saved)
      conflict: null,         // { savedSig, deviceSig, savedCounts, deviceCounts, since }
      awaitingRestore: false, // user chose 'server'; suppress conflict until device restores
      adoptNext: false,       // a dashboard profile change is in flight; adopt the next
                              //   diverged profile as the baseline instead of flagging it
      pending: freshPending(),// buffered downstream control directives
    };
    aquariums.set(id, entry);
  }
  return entry;
}

// Canonical profile signature: the aquarium's *composition* — the per-type fish
// census. A "profile mismatch" means the device's tank holds a different number of
// each fish type than the server's saved baseline. The device builds the identical
// string (_localProfileSig) so the two compare byte-for-byte.
//
// Deliberately NOT included: fish positions (change every frame), fish colors
// (deterministic from slot, but a source of device↔server formatting drift), and
// the plant layout (reseeded randomly on a fresh boot). Those are cosmetic and
// caused permanent false mismatches; counts are the stable, meaningful identity.
function profileSig(s) {
  if (!s) return '';
  const c = s.counts || {};
  return `P:${c.pair || 0},${c.school || 0},${c.school2 || 0},${c.angel || 0},${c.salmon || 0}`;
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
  return {
    ...s, fish,
    _name: entry.name || null,
    _lastSeenMs: entry.lastSeenMs,
    _stale: isStale(entry.lastSeenMs),
    _conflict: entry.conflict || null,
  };
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
//
// The server is the source of truth for the aquarium *profile* (composition).
// We always keep the latest live snapshot for the dashboard, but the persisted
// `saved` baseline is only advanced when the incoming profile still matches it
// (or on first sight). If a device reports a different profile, we flag a
// conflict and leave the saved baseline untouched until the user resolves it.
function upsert(snapshot) {
  const id = snapshot.aquarium_id;
  if (!aquariums.has(id) && aquariums.size >= MAX_AQUARIUMS) {
    return { ok: false, error: 'max_aquariums_reached' };
  }
  const entry = getOrCreate(id);
  if (snapshot.device_id) registerDeviceFromTelemetry(snapshot); // physical/virtual self-register
  const t = now();
  const sig = profileSig(snapshot);
  // In Career mode the fish census changes constantly through legitimate play
  // (catching fish, buying from the shop, the career reset). Those are not
  // "device drift", so we never raise a profile conflict — the latest career
  // composition is always adopted as the baseline.
  const career = !!(snapshot.game && snapshot.game.mode === 'career');

  entry.snapshot = snapshot;     // live view, always current
  entry.lastSeenMs = t;
  if (Array.isArray(snapshot.fish)) updateFishMeta(entry, snapshot.fish);

  if (!entry.saved) {
    // First sighting → seed the source-of-truth baseline.
    entry.saved = snapshot;
    entry.savedSig = sig;
    entry.conflict = null;
    db.saveSnapshot(id, snapshot, t, entry.createdAt);
  } else if (sig === entry.savedSig) {
    // Profile matches the baseline → keep it fresh, clear any prior conflict, and
    // finish a pending server-restore (the device has caught up to the baseline).
    entry.saved = snapshot;
    entry.conflict = null;
    entry.awaitingRestore = false;
    db.saveSnapshot(id, snapshot, t, entry.createdAt);
  } else if (entry.adoptNext || career) {
    // Either the dashboard issued a profile-changing control (add/remove fish)
    // and the device applied it, or the tank is in Career mode where census
    // changes are normal play. Adopt the new composition as the baseline rather
    // than treating it as a conflict.
    entry.saved = snapshot;
    entry.savedSig = sig;
    entry.conflict = null;
    entry.adoptNext = false;
    db.saveSnapshot(id, snapshot, t, entry.createdAt);
  } else if (entry.awaitingRestore) {
    // User chose 'server'; the restore directive is in flight but the device is
    // still reporting its old profile. Don't re-raise the conflict — wait for it
    // to restore (handled by the matching branch above).
    entry.conflict = null;
  } else {
    // Profile diverged → record the conflict without overwriting the baseline.
    entry.conflict = {
      savedSig: entry.savedSig,
      deviceSig: sig,
      savedCounts: (entry.saved && entry.saved.counts) || null,
      deviceCounts: snapshot.counts || null,
      since: (entry.conflict && entry.conflict.since) || t,
    };
  }

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
  // Control directives (tab-less lines the device's name parser skips, but the
  // device scans for them explicitly). Drained here: one-shot per response.
  const p = entry.pending || (entry.pending = freshPending());
  let restoreEmitted = false;
  if (p.switchAq) { lines.push(`!SWITCHAQ:${p.switchAq}`); p.switchAq = null; }
  if (p.restore) { lines.push('!RESTORE'); p.restore = false; restoreEmitted = true; }
  if (p.weather !== null) { lines.push(`!WEATHER:${p.weather}`); p.weather = null; }
  if (p.time !== null) { lines.push(`!TIME:${p.time}`); p.time = null; }
  if (p.timescale !== null) { lines.push(`!TIMESCALE:${p.timescale}`); p.timescale = null; }
  for (let t = 0; t < 5; t++) {
    if (p.fishAdd[t] > 0) { lines.push(`!FISHADD:${t}:${p.fishAdd[t]}`); p.fishAdd[t] = 0; }
  }
  for (let t = 0; t < 5; t++) {
    if (p.fishDel[t] > 0) { lines.push(`!FISHDEL:${t}:${p.fishDel[t]}`); p.fishDel[t] = 0; }
  }
  if (p.feed > 0) { lines.push(`!FEED:${p.feed}`); p.feed = 0; }
  if (p.mode !== null) { lines.push(`!MODE:${p.mode}`); p.mode = null; }
  if (p.catch.length) { lines.push(`!CATCH:${p.catch.join(',')}`); p.catch = []; }
  for (let t = 0; t < 5; t++) {
    if (p.buyFish[t] > 0) { lines.push(`!BUYFISH:${t}:${p.buyFish[t]}`); p.buyFish[t] = 0; }
  }
  if (p.buyFood > 0) { lines.push(`!BUYFOOD:${p.buyFood}`); p.buyFood = 0; }
  if (p.buySnail > 0) { lines.push(`!BUYSNAIL:${p.buySnail}`); p.buySnail = 0; }
  if (p.sellFish && p.sellFish.length > 0) { lines.push(`!SELLFISH:${p.sellFish.join(',')}`); p.sellFish = []; }
  // Only nudge the device's on-screen conflict prompt when we're not already
  // telling it to restore (restore resolves the conflict on its own).
  if (!restoreEmitted && entry.conflict) lines.push('!CONFLICT');
  for (const [fishId, name] of entry.names) lines.push(`${fishId}\t${name}`);
  return lines.join('\n');
}

// Fish-type caps mirror the firmware (main.cpp / aquarium.ino) so the dashboard
// and server can validate without a round-trip.
const FISH_MAX = [8, 16, 20, 12, 16]; // pair(clownfish), guppy(school), piranha(school2), angel, salmon
// Max school size per type before fish split into a new school (0 = solitary). Clownfish
// realize size-2 via mate-pairing; Guppy/Piranha use centroid sub-schools; Angel/Salmon don't.
const FISH_SCHOOL_SIZE = [2, 6, 4, 0, 0];

// Buffer a downstream control directive for the device's next telemetry response.
// Returns { ok } or { ok:false, error } on bad input.
function queueControl(id, cmd) {
  if (!cmd || typeof cmd !== 'object') return { ok: false, error: 'bad_command' };
  const entry = getOrCreate(id);
  const p = entry.pending || (entry.pending = freshPending());
  switch (cmd.type) {
    case 'weather': {
      const v = Number(cmd.value);
      if (!Number.isInteger(v) || v < -1 || v > 6) return { ok: false, error: 'bad_weather' };
      p.weather = v;
      break;
    }
    case 'time': {
      const v = String(cmd.value).toUpperCase();
      if (v !== 'REAL' && v !== 'FAST') return { ok: false, error: 'bad_time' };
      p.time = v === 'FAST' ? 1 : 0;
      break;
    }
    case 'timescale': {
      const v = Number(cmd.value);
      if (!Number.isInteger(v) || v < 1 || v > 5) return { ok: false, error: 'bad_timescale' };
      p.timescale = v;
      break;
    }
    case 'fish': {
      const ft = Number(cmd.fishType);
      const n = Math.max(1, Math.min(64, Number(cmd.count) || 1));
      if (!Number.isInteger(ft) || ft < 0 || ft > 4) return { ok: false, error: 'bad_fish_type' };
      if (cmd.action === 'add') p.fishAdd[ft] += n;
      else if (cmd.action === 'remove') p.fishDel[ft] += n;
      else return { ok: false, error: 'bad_fish_action' };
      // The device will change its composition → next snapshot diverges from the
      // saved baseline. Pre-arm adoption so that change isn't flagged as a conflict.
      entry.adoptNext = true;
      break;
    }
    case 'feed': {
      const n = Math.max(1, Math.min(20, Number(cmd.count) || 1));
      p.feed += n;
      break;
    }
    case 'mode': {
      const v = String(cmd.value).toLowerCase();
      if (v !== 'creative' && v !== 'career') return { ok: false, error: 'bad_mode' };
      p.mode = v === 'career' ? 1 : 0;
      // The device applies the switch (career resets to 2 fish); its next snapshot
      // will report mode=career and be auto-adopted by upsert (no conflict).
      break;
    }
    case 'catch': {
      const itemId = Number(cmd.itemId);
      if (!Number.isInteger(itemId) || itemId < 0) return { ok: false, error: 'bad_item_id' };
      if (!p.catch.includes(itemId)) p.catch.push(itemId);
      break;
    }
    case 'sell': {
      const fishId = Number(cmd.fishId);
      if (!Number.isInteger(fishId) || fishId < 0 || fishId > 200)
        return { ok: false, error: 'bad_fish_id' };
      if (!(p.sellFish || (p.sellFish = [])).includes(fishId)) p.sellFish.push(fishId);
      entry.adoptNext = true;  // census changes after sale
      break;
    }
    case 'buy': {
      const what = String(cmd.what);
      if (what === 'fish') {
        const ft = Number(cmd.fishType);
        if (!Number.isInteger(ft) || ft < 0 || ft > 4) return { ok: false, error: 'bad_fish_type' };
        p.buyFish[ft] += Math.max(1, Math.min(64, Number(cmd.count) || 1));
      } else if (what === 'food') {
        p.buyFood += Math.max(1, Math.min(99, Number(cmd.count) || 1));
      } else if (what === 'snail') {
        p.buySnail += Math.max(1, Math.min(16, Number(cmd.count) || 1));
      } else {
        return { ok: false, error: 'bad_buy_what' };
      }
      break;
    }
    default:
      return { ok: false, error: 'unknown_type' };
  }
  return { ok: true };
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
      (counts.pair || 0) + (counts.school || 0) + (counts.school2 || 0) + (counts.angel || 0) + (counts.salmon || 0);
    const device = deviceForAquarium(id);
    out.push({
      aquarium_id: id,
      name: entry.name || null,
      platform: s.platform || 'unknown',
      fw_version: s.fw_version || null,
      lastSeenMs: entry.lastSeenMs,
      stale: isStale(entry.lastSeenMs),
      fishCount,
      counts,
      weather: s.weather || null,
      conflict: !!entry.conflict,
      device,                          // { id, name, kind, online } | null
      simulated: !(device && device.online), // server web-sim drives it when no live device
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
// On-boot / re-enable handshake for a device. Returns the saved source-of-truth
// profile (composition + last positions + names) plus its signature, so the
// device can both restore state and detect whether its local profile diverges.
function bootstrap(id) {
  const entry = aquariums.get(id);
  const base = entry && (entry.saved || entry.snapshot);
  if (!base) return null; // first boot — device keeps its own freshly-made tank
  const fish = Array.isArray(base.fish)
    ? base.fish.map((f) => ({ ...f, name: entry.names.get(f.id) || null }))
    : [];
  return {
    exists: true,
    aquarium_id: id,
    snapshot_age_ms: now() - entry.lastSeenMs,
    created_at: entry.createdAt,
    profile_sig: entry.savedSig || profileSig(base),
    counts: base.counts || null,
    screen: base.screen || null,
    plants: base.plants || null,
    game: base.game || null,   // mode/coins/shells/food/luck — restore career state
    snails: base.snails || null, // purchased coin-collector snails — durable, must survive reboot
    fish,                      // each fish already carries age/xp/fish_luck via {...f}
  };
}

// Resolve a profile conflict (from the dashboard or the device).
//   choice 'local'  → adopt the device's current profile as the new baseline.
//   choice 'server' → tell the device to restore the saved baseline; the
//                     conflict clears automatically once it reports a match.
function resolveConflict(id, choice) {
  const entry = aquariums.get(id);
  if (!entry) return { ok: false, error: 'not_found' };
  if (choice === 'local') {
    if (!entry.snapshot) return { ok: false, error: 'no_snapshot' };
    entry.saved = entry.snapshot;
    entry.savedSig = profileSig(entry.snapshot);
    entry.conflict = null;
    entry.pending.restore = false;
    entry.awaitingRestore = false;
    db.saveSnapshot(id, entry.saved, entry.lastSeenMs, entry.createdAt);
    broadcast(entry);
    return { ok: true, choice };
  }
  if (choice === 'server') {
    entry.conflict = null;
    entry.awaitingRestore = true;       // suppress re-flagging until the device restores
    entry.pending.restore = true;       // !RESTORE delivered in the next POST response
    broadcast(entry);
    return { ok: true, choice };
  }
  return { ok: false, error: 'bad_choice' };
}

// All known aquarium ids (snapshot-bearing or freshly-created). The device manager
// iterates these to decide which tanks need server-side simulation.
function aquariumIds() {
  return [...aquariums.keys()];
}

// Create a brand-new aquarium from the dashboard. It has no physical device, so the
// server's web simulator (deviceManager) starts running it immediately. The id is a
// URL-safe slug of the name (deduped); the friendly name is kept for display.
function createAquarium(rawName) {
  if (aquariums.size >= MAX_AQUARIUMS) return { ok: false, error: 'max_aquariums_reached' };
  const name = sanitizeName(rawName) || '';
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  let id = slug || ('tank-' + now().toString(36));
  if (aquariums.has(id)) id = `${id}-${now().toString(36).slice(-4)}`;
  const entry = getOrCreate(id);
  entry.name = name || null;
  db.saveAquariumMeta(id, { name: entry.name, createdAt: entry.createdAt });
  return { ok: true, aquariumId: id, name: entry.name };
}

// Rename an existing aquarium (display name only; the id/slug is immutable).
function renameAquarium(id, rawName) {
  const entry = aquariums.get(id);
  if (!entry) return { ok: false, error: 'not_found' };
  entry.name = sanitizeName(rawName) || null;
  db.saveAquariumMeta(id, { name: entry.name, createdAt: entry.createdAt });
  broadcast(entry); // open dashboards update their title immediately
  return { ok: true, name: entry.name };
}

// Forget an aquarium: drop it from memory and delete its persisted file. A device
// that is still alive will simply re-create it on its next telemetry POST; for a
// stale (gone) device this is a permanent removal. Returns whether it existed.
function remove(id) {
  const existed = aquariums.delete(id);
  db.deleteAquarium(id);
  return { ok: true, existed };
}

function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

module.exports = {
  upsert, list, get, bootstrap, resolveConflict, subscribe, setName, getNamesText,
  queueControl, remove, FISH_MAX,
  STALE_MS, MAX_AQUARIUMS,
  // Aquarium lifecycle (dashboard-created tanks, simulated server-side)
  createAquarium, renameAquarium, aquariumIds, hasLiveDevice,
  // Device registry (physical hardware that self-registers via telemetry)
  listDevices, getDevice, createDevice, updateDevice, removeDevice,
};

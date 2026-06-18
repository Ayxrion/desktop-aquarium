'use strict';

// All URLs are relative so the app works when served under the /aquarium/
// reverse-proxy prefix the deploy service configures.

const WEATHER_NAMES = ['Sunny', 'Partly Cloudy', 'Cloudy', 'Rainy', 'Stormy', 'Snowy', 'Foggy'];
const FISH_TYPE_NAMES = ['Clownfish', 'Guppy', 'Piranha', 'Angel', 'Salmon'];
// Per-type caps + snapshot count keys, mirroring the firmware (main.cpp / aquarium.ino).
// Count keys stay pair/school/school2/angel/salmon (persisted slot identifiers): pair=Clownfish,
// school=Guppy, school2=Piranha. Schooling is a characteristic (FISH_SCHOOL_SIZE), not the type.
const FISH_MAX = [8, 16, 20, 12, 16];
const FISH_COUNT_KEYS = ['pair', 'school', 'school2', 'angel', 'salmon'];
// Max school size per type before fish split into a new school. 0 = solitary. Clownfish
// realize their size-2 schooling via mate-pairing; Guppy/Piranha use centroid sub-schools;
// Angel keeps its own loose grouping; Salmon are solitary.
const FISH_SCHOOL_SIZE = [2, 6, 4, 0, 0];
const TANK_TOP = 72;
const SCREEN_W = 800;
const SCREEN_H = 480;

// ─── Fish appearance: luck-driven coloring + shiny rarity ────────────────────
// Each fish TYPE has a PRIMARY hue. A fish's luck/quality (0..1) tints that
// primary toward LUCK_TINT_COLOR — luckier fish look richer/more golden. The
// blend is capped by LUCK_TINT_STRENGTH so even a legendary fish keeps a hint of
// its type colour. Re-theme the whole tank by editing these four lines; the
// canvas, legend, tooltips and profiles all follow along.
const FISH_PRIMARY = [0x2E8BFF, 0x33D17A, 0xFF7A33, 0xB45CFF, 0xFF9E7A]; // Clownfish, Guppy, Piranha, Angel, Salmon
const LUCK_TINT_COLOR = 0xFFE14D;   // high-luck fish shift toward this (warm gold)
const LUCK_TINT_STRENGTH = 0.7;     // max blend toward the tint at luck = 1
const SHINY_ODDS = 1000;            // 1-in-N fish are shiny (inverted + glistening)

// Rarity tiers derived from luck/quality — names + colours borrow the loot
// conventions of dungeon crawlers (grey → green → blue → purple → gold).
const RARITY_TIERS = [
  { min: 0.00, name: 'Common',    color: '#b9c6d4' },
  { min: 0.20, name: 'Uncommon',  color: '#5fd75f' },
  { min: 0.45, name: 'Rare',      color: '#4aa3ff' },
  { min: 0.70, name: 'Epic',      color: '#c05cff' },
  { min: 0.90, name: 'Legendary', color: '#ffb02e' },
];
const SHINY_RARITY = { name: 'Shiny', color: '#5ffbf1' };

// Linear blend between two 24-bit RGB ints (0..1).
function lerpColorInt(a, b, t) {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  return ((Math.round(ar + (br - ar) * t) << 16) |
          (Math.round(ag + (bg - ag) * t) << 8) |
           Math.round(ab + (bb - ab) * t));
}
function invertInt(n) { return (~n) & 0xffffff; }

// Stable per-id hash so shiny rolls + wild-fish luck don't flicker frame-to-frame.
function hash32(n) {
  n = (n | 0) ^ 0x9e3779b9;
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return (n ^ (n >>> 16)) >>> 0;
}

// A fish's luck/quality (0..1). Resident fish carry fish_luck in telemetry; wild
// (wandering) fish don't, so we derive a stable pseudo-luck from their id.
function fishLuck(f) {
  if (typeof f.fish_luck === 'number') return clamp(f.fish_luck, 0, 1);
  if (typeof f.luck === 'number') return clamp(f.luck, 0, 1);
  return (hash32((f.id | 0) + 1) % 1000) / 1000;
}

// Shiny is honoured from telemetry (f.shiny) if present, else rolled 1-in-N
// deterministically from the id so the same fish is always (or never) shiny.
function isShiny(f) {
  if (typeof f.shiny === 'boolean') return f.shiny;
  return hash32((f.id | 0) ^ 0x5bd1e995) % SHINY_ODDS === 0;
}

// Rarity tier for a fish (shiny overrides everything).
function rarityOf(f) {
  if (isShiny(f)) return SHINY_RARITY;
  const l = fishLuck(f);
  let r = RARITY_TIERS[0];
  for (const t of RARITY_TIERS) if (l >= t.min) r = t;
  return r;
}

// Final display colour for a fish. The DEVICE is authoritative: every source
// (aquarium-pi, aquarium ESP, sim.js) computes the colour from type+luck+shiny with
// identical maths and sends the result in telemetry as `color`, so we render that
// verbatim — recomputing it here only re-derives the same value and risks rounding/
// input drift that shows up as a colour mismatch against the panel. The type+luck
// fallback covers anything that arrives without a colour (older payloads, etc.).
function fishColorInt(f) {
  if (typeof f.color === 'number' && f.color >= 0) return f.color & 0xffffff;
  const type = f.type || 0;
  const base = FISH_PRIMARY[type] != null ? FISH_PRIMARY[type] : 0x33D17A;
  let c = lerpColorInt(base, LUCK_TINT_COLOR, fishLuck(f) * LUCK_TINT_STRENGTH);
  if (isShiny(f)) c = invertInt(c);
  return c;
}
function fishColorHex(f) { return hex(fishColorInt(f)); }
function fishName(f) { return f.name || `${FISH_TYPE_NAMES[f.type] || 'Fish'} #${f.id}`; }

// ─── Client-side prediction (real-time, in lockstep with the device) ──────────
// The device (sim.js / aquarium-pi / aquarium ESP) stamps every snapshot with a
// monotonic `tick` (its frame counter) and `frame_ms`. To run ALONGSIDE the panel in
// real time — not a telemetry interval behind — we forward-simulate the device's OWN
// fish physics from the latest snapshot up to the live edge (its current tick,
// estimated from the snapshot cadence). That physics is deterministic and matches the
// device exactly, EXCEPT for the random wander target a fish picks when its countdown
// expires (unknowable until the next snapshot). That's the only divergence, and it's
// small over one ~1 s interval. Each snapshot is authoritative: we reseed from it and
// let the tiny prediction error decay away smoothly (errById) so corrections are
// invisible — real time, no lag, no rubber-banding. The live clock also phases every
// decorative animation, so the whole scene stays locked to the device.

let tickRate = 0.02;        // device ticks per local ms (EMA); 0.02 ≈ timescale 1
let devClock = null;        // live-edge estimate of the device's CURRENT tick
let lastSnap = null;        // most recent authoritative snapshot (display fields, non-fish movers)
let prevSnap = null;        // the one before it (for non-fish mover velocity)
let _lastSnapArrival = 0;
let _needReseed = false;    // a new snapshot arrived → reseed prediction next frame
let pred = null;            // { tick, fish:[working physics state] }, advanced each frame
const errById = new Map();  // fish id → {ex,ey,ez} decaying prediction error (visual smoothing)
let _frameCarry = 0;        // fractional device-frame remainder (smooth 60 fps sub-stepping)
let _moverVel = { boat: 0, snail: 0, starfish: 0 }; // px per device-frame
const ERR_DECAY = 0.80;     // error multiplier per device-frame (~150 ms half-life)
const ERR_MAX = 160;        // clamp pathological corrections (px)

// A snapshot's position on the device timeline. Every current source emits `tick`;
// the fallback derives a monotonic tick from the best available clock.
function snapTick(s) {
  if (s && typeof s.tick === 'number') return s.tick;
  const fm = (s && s.frame_ms) || 50;
  const ms = (s && (s.uptime_ms != null ? s.uptime_ms : s._lastSeenMs)) || Date.now();
  return ms / fm;
}

// Reset prediction (selection change, or a device reboot/tank switch that rewinds tick).
function resetInterp() {
  lastSnap = prevSnap = pred = null;
  devClock = null; _needReseed = false; _frameCarry = 0; _lastSnapArrival = 0;
  errById.clear();
}

// Boundary spring acceleration (device boundAccel / app boundary springs).
function boundA(v, lo, hi, k) {
  if (v < lo) return (lo - v) * k;
  if (v > hi) return (hi - v) * k;
  return 0;
}

// One whole device-frame of the joint fish physics — a faithful port of the device
// (sim.js stepPhysics / firmware updateFish): sub-school centroids, cohesion, pairwise
// separation, target seeking, boundary springs, damping, AND wander retargeting — so
// the fish keep roaming during long gaps between telemetry instead of gliding to a
// stale target and stopping. The device's retarget RNG differs from ours, so positions
// diverge slightly between snapshots; the error-decay reconciliation (errById) then
// eases them onto the authoritative truth on the next snapshot (no snap, no freeze).
function stepFishOnce(fish) {
  const cent = {}; const order = [0, 0, 0, 0, 0];
  for (const f of fish) {
    const sz = FISH_SCHOOL_SIZE[f.type] || 0;
    f._sub = sz >= 2 ? Math.floor(order[f.type] / sz) : 0;
    order[f.type]++;
    const k = f.type + ':' + f._sub;
    const c = cent[k] || (cent[k] = { x: 0, y: 0, z: 0, n: 0 });
    c.x += f.x; c.y += f.y; c.z += f.z; c.n++;
  }
  for (const k in cent) { const c = cent[k]; c.x /= c.n; c.y /= c.n; c.z /= c.n; }
  for (const f of fish) {
    const t = f.type;
    // Wander countdown: when it expires, pick a fresh target exactly the way the device
    // does (clownfish toggle chase; salmon roam solo; schoolers/angel aim near centroid).
    if (f.wcd > 0) {
      f.wcd--;
    } else {
      if (t === 0) {
        f.chasing = !f.chasing;
        f.wcd = f.chasing ? 30 + Math.random() * 40 : 40 + Math.random() * 50;
      } else if (t === 3) { f.wcd = 8 + Math.random() * 20; }
      else { f.wcd = 15 + Math.random() * 35; }
      if (t === 4) {                          // salmon: solitary, roam the whole tank
        f.tx = 30 + Math.random() * (SCREEN_W - 60);
        f.ty = (TANK_TOP + 20) + Math.random() * (SCREEN_H - 80 - (TANK_TOP + 20));
      } else {
        const cg = cent[t + ':' + f._sub];
        const spread = t === 3 ? 120 : t === 0 ? 0 : 160;
        f.tx = clamp(cg.x + (Math.random() * 2 - 1) * spread, 30, SCREEN_W - 30);
        f.ty = clamp(cg.y + (Math.random() * 2 - 1) * (t === 3 ? 110 : 90), TANK_TOP + 20, SCREEN_H - 80);
      }
    }
    const chasing = f.chasing && t === 0;
    const seekStr = chasing ? 0.018 : (t === 3 ? 0.020 : 0.012);
    const maxV = f.going_for_food ? 8.0 : (chasing || t === 3) ? 7.0 : 5.5;
    let ax = (f.tx - f.x) * seekStr;
    let ay = (f.ty - f.y) * seekStr;
    let az = (f.tz - f.z) * 0.010;
    const grp = cent[t + ':' + f._sub];
    if (t === 1 || t === 2) { ax += (grp.x - f.x) * 0.010; ay += (grp.y - f.y) * 0.007; az += (grp.z - f.z) * 0.007; }
    else if (t === 3)       { ax += (grp.x - f.x) * 0.012; ay += (grp.y - f.y) * 0.010; az += (grp.z - f.z) * 0.008; }
    const sepR2 = t === 3 ? 60 * 60 : 80 * 80, sepK = t === 3 ? 7 : 8;
    if (t === 1 || t === 2 || t === 3) {
      for (const o of fish) {
        if (o === f || o.type !== t || o._sub !== f._sub) continue;
        const dx = f.x - o.x, dy = f.y - o.y, d2 = dx * dx + dy * dy;
        if (d2 < sepR2 && d2 > 0.01) { const inv = sepK / d2; ax += dx * inv; ay += dy * inv; }
      }
    }
    ax += boundA(f.x, 30, SCREEN_W - 30, 0.30);
    ay += boundA(f.y, TANK_TOP + 20, SCREEN_H - 80, 0.30);
    az += boundA(f.z, 0.0, 0.75, 0.08);
    f.vx = Math.max(-maxV, Math.min(maxV, f.vx + ax)) * 0.85;
    f.vy = Math.max(-maxV * 0.5, Math.min(maxV * 0.5, f.vy + ay)) * 0.85;
    f.vz = Math.max(-0.015, Math.min(0.015, f.vz + az)) * 0.88;
    f.x = Math.max(5, Math.min(SCREEN_W - 5, f.x + f.vx));
    f.y = Math.max(TANK_TOP + 5, Math.min(SCREEN_H - 60, f.y + f.vy));
    f.z = Math.max(0, Math.min(0.78, f.z + f.vz));
    if (Math.abs(f.vx) > 0.4) f.facing_right = f.vx > 0;
  }
}
function stepFishN(fish, n) { for (let i = 0; i < n; i++) stepFishOnce(fish); }

// Working physics copy of a snapshot's fish (only the fields the stepper mutates).
function makePredFish(snap) {
  return (snap.fish || []).map((f) => ({
    id: f.id, type: f.type || 0,
    x: f.x, y: f.y, z: f.z || 0,
    vx: f.vx || 0, vy: f.vy || 0, vz: f.vz || 0,
    tx: f.tx != null ? f.tx : f.x, ty: f.ty != null ? f.ty : f.y,
    tz: typeof f.tz === 'number' ? f.tz : (f.z || 0),
    wcd: typeof f.wander_cd === 'number' ? f.wander_cd : 30,
    chasing: !!f.chasing, going_for_food: !!f.going_for_food,
    facing_right: f.facing_right,
  }));
}

// Reseed prediction from a freshly arrived authoritative snapshot, aligned to the live
// edge (devNow). Capture the currently-shown offset as a decaying error so the visual
// stays put and eases onto the corrected trajectory — no snap.
function reseedPrediction(snap, devNow) {
  const auth = makePredFish(snap);
  stepFishN(auth, Math.max(0, Math.round(devNow - snapTick(snap))));
  if (pred && pred.fish.length) {
    stepFishN(pred.fish, Math.max(0, Math.round(devNow - pred.tick)));
    const oldById = new Map(pred.fish.map((f) => [f.id, f]));
    for (const a of auth) {
      const p = oldById.get(a.id);
      if (!p) { errById.delete(a.id); continue; }
      const e = errById.get(a.id) || { ex: 0, ey: 0, ez: 0 };
      errById.set(a.id, {
        ex: clamp((p.x + e.ex) - a.x, -ERR_MAX, ERR_MAX),
        ey: clamp((p.y + e.ey) - a.y, -ERR_MAX, ERR_MAX),
        ez: clamp((p.z + e.ez) - a.z, -1, 1),
      });
    }
  } else {
    errById.clear();
  }
  const ids = new Set(auth.map((a) => a.id));
  for (const id of [...errById.keys()]) if (!ids.has(id)) errById.delete(id);
  pred = { tick: devNow, fish: auth };
}

// Velocity (px/device-frame) of a slow mover between the last two snapshots; 0 for
// teleports/wraps so it never flings across the tank.
function moverVel(a, b) {
  if (!a || !b || typeof a.x !== 'number' || typeof b.x !== 'number') return 0;
  const dt = snapTick(b) - snapTick(a);
  if (dt <= 0) return 0;
  const v = (b.x - a.x) / dt;
  return Math.abs(v) > 8 ? 0 : v;
}

// Ingest a freshly received snapshot: calibrate the live clock, stash it (+ the prior
// one for mover velocity), and flag a reseed for the next frame. Dedupes stale/equal
// ticks and restarts on a backward jump (reboot / tank switch).
function acceptSnapshot(snap) {
  const tick = snapTick(snap);
  const arrival = Date.now();
  if (lastSnap) {
    const last = snapTick(lastSnap);
    if (tick <= last) {
      if (tick < last - 5) resetInterp(); // reboot / switch → fresh
      else return;                        // duplicate / stale
    } else {
      const inst = (tick - last) / Math.max(1, arrival - _lastSnapArrival);
      tickRate = clamp(tickRate * 0.8 + inst * 0.2, 0.002, 0.5);
    }
  }
  prevSnap = lastSnap;
  lastSnap = snap;
  _lastSnapArrival = arrival;
  if (prevSnap) {
    _moverVel = {
      boat: (prevSnap.boat && snap.boat && prevSnap.boat.active && snap.boat.active)
            ? moverVel(prevSnap.boat, snap.boat) : 0,
      snail: moverVel(prevSnap.snail, snap.snail),
      starfish: moverVel(prevSnap.starfish, snap.starfish),
    };
  }
  // Discipline the live-edge clock toward the new observation (absorbs latency jitter
  // and clock skew). It ends ~one network-latency behind the device's true tick — the
  // best achievable, far tighter than an interpolation interval.
  if (devClock == null || Math.abs(tick - devClock) > 80) devClock = tick;
  else devClock += (tick - devClock) * 0.2;
  _needReseed = true;
}

// Build the render snapshot at the live edge: predicted fish (with smoothed error)
// plus non-fish movers extrapolated forward by their observed velocity.
function buildRenderSnap(devNow) {
  const base = lastSnap;
  if (!base) return null;
  const ahead = Math.max(0, devNow - snapTick(base));
  const out = { ...base };

  if (pred) {
    const dispById = new Map((base.fish || []).map((f) => [f.id, f]));
    out.fish = pred.fish.map((f) => {
      const e = errById.get(f.id) || { ex: 0, ey: 0, ez: 0 };
      const disp = dispById.get(f.id) || {};
      return {
        ...disp, id: f.id, type: f.type,
        x: f.x + f.vx * _frameCarry + e.ex,
        y: f.y + f.vy * _frameCarry + e.ey,
        z: clamp(f.z + e.ez, 0, 0.85),
        vx: f.vx, vy: f.vy, facing_right: f.facing_right,
      };
    });
  }

  if (base.boat && typeof base.boat.x === 'number')
    out.boat = { ...base.boat, x: base.boat.x + _moverVel.boat * ahead };
  if (base.snail && typeof base.snail.x === 'number')
    out.snail = { ...base.snail, x: base.snail.x + _moverVel.snail * ahead };
  if (base.starfish && typeof base.starfish.x === 'number')
    out.starfish = { ...base.starfish, x: base.starfish.x + _moverVel.starfish * ahead };
  if (Array.isArray(base.wanderers))
    out.wanderers = base.wanderers.map((w) => ({ ...w, x: w.x + (w.vx || 0) * ahead }));
  if (Array.isArray(base.loot))
    out.loot = base.loot.map((it) => ({ ...it, y: it.y + (it.vy || 0) * ahead }));
  if (Array.isArray(base.flakes))
    out.flakes = base.flakes.map((fl) => ({ ...fl, y: Math.min(SCREEN_H - 4, fl.y + 0.7 * ahead) }));
  return out;
}

// ─── Faithful scene renderer (mirrors device aquarium.ino / main.cpp) ─────────
// Decorative animations (sway, water, bubbles, smoke) are driven by animTick, which
// _rafDraw sets to the playhead — i.e. the actual device `tick` being rendered. The
// device's own sway is phased off the same `tick` with the same sin() constants, so
// they port over unchanged AND track the device's timescale (faster tick → faster
// sway) instead of wall-clock. One clock for positions and decoration alike.
let animTick = 0;

// Bumpy sand bed: three layered sine waves, same as the device terrainY[].
const terrainY = new Int16Array(SCREEN_W);
for (let x = 0; x < SCREEN_W; x++) {
  const hh = Math.sin(x * 0.018) * 4.0 + Math.sin(x * 0.063) * 2.5 + Math.sin(x * 0.140) * 1.5;
  terrainY[x] = Math.round(SCREEN_H - 18 + hh);
}

// Perspective: deeper (higher z) fish converge toward screen centre and shrink.
function projX(x, z) { const cx = SCREEN_W * 0.5;  return cx + (x - cx) * (1 - z * 0.30); }
function projY(y, z) { const cy = SCREEN_H * 0.45; return cy + (y - cy) * (1 - z * 0.38); }

// Career growth: fish hatch small and grow to full size (no death). `scale` is
// 0.22..1.0 (matches device fishScale); absent (creative / pre-game) → full size.
function growth(f) { return typeof f.scale === 'number' ? clamp(f.scale, 0.2, 1) : 1; }

function fishSellValue(f) {
  const base = FISH_BASE_SELL[f.type] || 6;
  const g = growth(f);
  return base
    + Math.round(base * g)
    + Math.round(fishLuck(f) * 15)
    + Math.min(Math.floor((f.xp || 0) / 100), 8)
    + (isShiny(f) ? 12 : 0);
}

// Fish text size / half-width (device units) — drives shadow + glyph scale.
function fishTS(f)    { return (f.type || 0) === 0 ? (f.z < 0.5 ? 3 : 2) : (f.z < 0.6 ? 2 : 1); }
function fishChars(f) { return (f.type || 0) === 0 ? 5 : 3; }
function fishHW(f)    { return (fishChars(f) * 6 * fishTS(f) * growth(f)) / 2; }

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Multiply a 24-bit RGB int by a 0..1 brightness factor → css rgb().
function shadeN(n, factor) {
  const r = Math.round(((n >> 16) & 0xff) * factor);
  const g = Math.round(((n >> 8) & 0xff) * factor);
  const b = Math.round((n & 0xff) * factor);
  return `rgb(${r},${g},${b})`;
}

// ── Low-level primitives (numeric colors, matching the device canvas API) ──
function frect(x, y, w, h, c) { ctx.fillStyle = hex(c); ctx.fillRect(x, y, w, h); }
function tri(x1, y1, x2, y2, x3, y3, c) {
  ctx.fillStyle = hex(c);
  ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.lineTo(x3, y3); ctx.closePath(); ctx.fill();
}
function fcirc(x, y, r, c) { ctx.fillStyle = hex(c); ctx.beginPath(); ctx.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2); ctx.fill(); }
function scirc(x, y, r, c) { ctx.strokeStyle = hex(c); ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x, y, Math.max(0.5, r), 0, Math.PI * 2); ctx.stroke(); }
function seg(x1, y1, x2, y2) { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); }
function fillEllipseC(cx, cy, rx, ry, style) {
  ctx.fillStyle = style;
  ctx.beginPath(); ctx.ellipse(cx, cy, Math.max(0.5, rx), Math.max(0.5, ry), 0, 0, Math.PI * 2); ctx.fill();
}

// ── Sky: device-accurate dawn/night transitions, dynamic sun/moon, fog bands ──
// Mirrors drawWeatherSky() in aquarium-pi/main.cpp exactly: night→dawn→day lerp,
// sun color shifts orange-red near horizon (nearH), moon crescent with visibility fade.
function drawSky(top, bright, cond, s) {
  const dp = (s.time && typeof s.time.day_progress === 'number') ? s.time.day_progress : 0.5;

  // Device day factor: 0=night, ramps dawn 0.18→0.28, full day 0.28→0.72, dusk 0.72→0.82.
  let dayFactor;
  if      (dp < 0.18) dayFactor = 0;
  else if (dp < 0.28) dayFactor = (dp - 0.18) * 10;
  else if (dp < 0.72) dayFactor = 1;
  else if (dp < 0.82) dayFactor = 1 - (dp - 0.72) * 10;
  else                dayFactor = 0;

  const NIGHT_TOP = 0x000510, NIGHT_BOT = 0x001530;
  const DAWN_TOP  = 0xBB4410, DAWN_BOT  = 0xFF8840;
  const wdTop = [0x1A78C8, 0x2288CC, 0x556677, 0x334455, 0x111827, 0x8899AA, 0x7788AA][cond] ?? 0x1A78C8;
  const wdBot = [0x64B5E8, 0x77AEDD, 0x8899AA, 0x556677, 0x1A2233, 0xAABBCC, 0xAABBCC][cond] ?? 0x64B5E8;

  let skyTop, skyBot;
  if (dayFactor < 0.5) {
    const t = dayFactor * 2;
    skyTop = lerpColorInt(NIGHT_TOP, DAWN_TOP, t);
    skyBot = lerpColorInt(NIGHT_BOT, DAWN_BOT, t);
  } else {
    const t = (dayFactor - 0.5) * 2;
    skyTop = lerpColorInt(DAWN_TOP, wdTop, t);
    skyBot = lerpColorInt(DAWN_BOT, wdBot, t);
  }

  // 8-band gradient (matches device's band loop)
  for (let band = 0; band < 8; band++) {
    const y0 = Math.round(band * top / 8);
    const y1 = Math.round((band + 1) * top / 8);
    const t = band / 7;
    const r = Math.round(((skyTop >> 16 & 0xff) * (1 - t)) + ((skyBot >> 16 & 0xff) * t));
    const g = Math.round(((skyTop >> 8  & 0xff) * (1 - t)) + ((skyBot >> 8  & 0xff) * t));
    const b = Math.round(((skyTop       & 0xff) * (1 - t)) + ((skyBot       & 0xff) * t));
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(0, y0, SCREEN_W, Math.max(1, y1 - y0));
  }

  // Stars — fade out as day approaches (dayFactor < 0.9)
  if (dayFactor < 0.9) {
    const a = (0.9 - dayFactor) / 0.9;
    for (let i = 0; i < 50; i++) {
      const x = (i * 101) % SCREEN_W;
      const y = 3 + ((i * 53) % Math.max(1, top - 26));
      const tw = 0.55 + 0.45 * Math.sin(animTick * 0.07 + i * 0.13);
      const br = Math.round(a * tw * 210);
      if (br < 15) continue;
      ctx.fillStyle = `rgb(${br},${br},${Math.min(255, br + 35)})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }

  // Sun (dp 0.25→0.75): color lerps yellow-white at zenith → orange-red at horizon
  if (dp >= 0.25 && dp <= 0.75 && dayFactor > 0.05) {
    const sunProg = (dp - 0.25) / 0.50;
    const sunX = Math.round(sunProg * SCREEN_W);
    const sunY = Math.round((top - 8) - Math.sin(Math.PI * sunProg) * (top - 14));
    const nearH = 1 - Math.sin(Math.PI * sunProg);        // 0=zenith, 1=horizon
    const core  = lerpColorInt(lerpColorInt(0xFFFFAA, 0xFF8800, nearH), skyTop, 1 - dayFactor);
    const glow  = lerpColorInt(lerpColorInt(0xFFDD44, 0xFF4400, nearH), skyTop, 1 - dayFactor);
    fillEllipseC(sunX, sunY, 13, 13, hex(lerpColorInt(skyTop, glow, 0.45)));
    fillEllipseC(sunX, sunY, 9, 9, hex(glow));
    fillEllipseC(sunX, sunY, 5, 5, hex(core));
  }

  // Moon (dp 0.75→1→0→0.25): crescent carved with shadow, fades with dayFactor
  if ((dp > 0.75 || dp < 0.25) && dayFactor < 0.9) {
    const nightLen = 0.50;
    const moonProg = dp > 0.75 ? (dp - 0.75) / nightLen : (dp + 0.25) / nightLen;
    const moonX = Math.round(moonProg * SCREEN_W);
    const moonY = Math.round((top - 8) - Math.sin(Math.PI * moonProg) * (top - 14));
    const moonVis   = 1 - dayFactor / 0.9;
    const moonCol   = lerpColorInt(skyTop, 0xDDDDE8, moonVis);
    const shadowCol = lerpColorInt(moonCol, skyTop, 0.85);
    fillEllipseC(moonX,     moonY,     7, 7, hex(moonCol));
    fillEllipseC(moonX + 3, moonY - 2, 6, 6, hex(shadowCol));
  }

  // Clouds (conditions: partly cloudy, cloudy, snowy, foggy)
  if (cond === 1 || cond === 2 || cond === 5 || cond === 6) {
    const ccDay = cond === 2 ? 0xBBBBCC : cond === 5 ? 0xCCDDEE : cond === 6 ? 0xBBCCDD : 0xEEEEFF;
    const cloudCol = hex(lerpColorInt(0x223344, ccDay, dayFactor));
    const n = (cond === 2 || cond === 6) ? 4 : 2;
    for (let i = 0; i < n; i++) {
      const cxp = ((i * 230 + animTick * 0.3) % (SCREEN_W + 140)) - 70;
      drawCloud(cxp, 14 + (i % 2) * 12, 70, 26, cloudCol);
    }
  }

  // Fog horizontal bands (device: fillRect every 12px, 5px tall, 0xAABBCC)
  if (cond === 6) {
    ctx.save();
    ctx.fillStyle = 'rgba(170,187,204,0.35)';
    for (let y = 0; y < top; y += 12) ctx.fillRect(0, y, SCREEN_W, 5);
    ctx.restore();
  }
}

function drawCloud(cx, cy, cw, ch, style) {
  fillEllipseC(cx, cy - ch * 0.28, cw * 0.50, ch * 0.32, style);
  fillEllipseC(cx - cw * 0.08, cy - ch * 0.62, cw * 0.26, ch * 0.42, style);
}

// ── Water: counter-travelling sine bands for a shimmering light effect ──
function drawWater(top, bright) {
  for (let y = top; y < SCREEN_H; y += 3) {
    const fy = y - top;
    const w = Math.sin(fy * 0.040 + animTick * 0.10) * 14.0 + Math.sin(fy * 0.016 - animTick * 0.034) * 8.0;
    const g = clamp(0x30 + Math.round(w * 0.4), 0, 255);
    const b = clamp(0x60 + Math.round(w), 0, 255);
    ctx.fillStyle = `rgb(0,${Math.round(g * bright)},${Math.round(b * bright)})`;
    ctx.fillRect(0, y, SCREEN_W, 3);
  }
}

// ── Sand: filled terrain contour with a darker top edge for definition ──
function drawSand(bright) {
  ctx.fillStyle = shadeN(0xC8A050, bright);
  ctx.beginPath();
  ctx.moveTo(0, SCREEN_H);
  ctx.lineTo(0, terrainY[0]);
  for (let x = 1; x < SCREEN_W; x++) ctx.lineTo(x, terrainY[x]);
  ctx.lineTo(SCREEN_W - 1, terrainY[SCREEN_W - 1]);
  ctx.lineTo(SCREEN_W, SCREEN_H);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = shadeN(0x9A7838, bright);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, terrainY[0]);
  for (let x = 1; x < SCREEN_W; x++) ctx.lineTo(x, terrainY[x]);
  ctx.stroke();
}

// ── Tank rim / glass over the waterline seam ──
function drawRim(top, bright) {
  const b = Math.max(bright, 0.5);
  frect(0, top - 22, SCREEN_W, 12, mul(0x484848, b));
  frect(0, top - 22, SCREEN_W, 1, mul(0xB0B0B0, b));
  frect(0, top - 11, SCREEN_W, 1, mul(0x202020, b));
  frect(0, top - 10, SCREEN_W, 9, mul(0x2E6888, b));
  frect(0, top - 10, SCREEN_W, 2, mul(0xAADDEE, b));
  frect(0, top - 4, SCREEN_W, 2, mul(0x5098B8, b));
  frect(0, top - 2, SCREEN_W, 1, mul(0x88CCDD, b));
  frect(0, top - 1, SCREEN_W, 1, mul(0xDDEEFF, b));
  frect(0, top, SCREEN_W, 4, mul(0x061018, b));
}
// Scale a 24-bit color by a factor, returning a 24-bit int (for frect/etc.).
function mul(n, f) {
  const r = clamp(Math.round(((n >> 16) & 0xff) * f), 0, 255);
  const g = clamp(Math.round(((n >> 8) & 0xff) * f), 0, 255);
  const bl = clamp(Math.round((n & 0xff) * f), 0, 255);
  return (r << 16) | (g << 8) | bl;
}

// ── Plants — three families, each with its own sway, port from the device ──
function drawBgPlants(plants, bright) {
  if (!Array.isArray(plants.bg)) return;
  const stem = shadeN(0x0D3318, bright), leaf = shadeN(0x163D20, bright);
  plants.bg.forEach((p, i) => {
    const segs = p.segs || 6;
    if ((p.type || 0) === 0) {
      const sx = [p.x], sy = [SCREEN_H - 20];
      for (let s = 1; s <= segs; s++) {
        sx[s] = p.x + Math.sin(animTick * 0.035 + i * 1.60 + s * 0.42) * s * 1.1;
        sy[s] = SCREEN_H - 20 - s * 15;
      }
      ctx.strokeStyle = stem; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(sx[0], sy[0]);
      for (let s = 1; s <= segs; s++) ctx.lineTo(sx[s], sy[s]);
      ctx.stroke();
      for (let s = 1; s < segs; s++) {
        const lx = (sx[s - 1] + sx[s]) / 2, ly = (sy[s - 1] + sy[s]) / 2 - 2;
        const side = (s % 2 === 0) ? 1 : -1, rx = 4 + (s % 2);
        fillEllipseC(lx + side * rx, ly, rx, 2, leaf);
      }
    } else {
      const tipSway = Math.sin(animTick * 0.028 + i * 1.85) * 3.0;
      ctx.strokeStyle = stem; ctx.lineWidth = 1;
      for (let s = 0; s < segs; s++) {
        const t = s / segs, tn = (s + 1) / segs;
        const cy = SCREEN_H - 20 - s * 15;
        seg(p.x + tipSway * t, cy, p.x + tipSway * tn, cy - 15);
      }
      ctx.strokeStyle = leaf;
      for (let s = 0; s <= segs; s++) {
        const t = s / segs, cx = p.x + tipSway * t, cy = SCREEN_H - 20 - s * 15;
        const nl = (1 - t * 0.65) * 9;
        if (nl > 1) { seg(cx, cy, cx - nl, cy - 1); seg(cx, cy, cx + nl, cy - 1); }
      }
    }
  });
}

function drawLeaf(cx, cy, side, rx, ry, leafCol, stemCol) {
  const lx = cx + side * (rx + 2);
  fillEllipseC(lx, cy, rx, ry, leafCol);
  ctx.strokeStyle = stemCol; ctx.lineWidth = 1; seg(cx, cy, lx, cy);
}

// Branch placement is random per-device (not in telemetry) → derive it
// deterministically from the plant x so it's stable frame-to-frame.
function seaweedBranches(x, segs) {
  const n = 1 + (x % 2);
  const out = [];
  for (let b = 0; b < n; b++) {
    const at = 2 + (((x >> (b * 3)) >>> 0) % Math.max(1, segs - 2));
    out.push({ at, side: ((x >> b) & 1) ? 1 : -1 });
  }
  return out;
}

function drawSeaweed(plants, bright) {
  if (!Array.isArray(plants.weeds)) return;
  const stem = shadeN(0x00AA44, bright), leaf = shadeN(0x33DD66, bright);
  plants.weeds.forEach((w, i) => {
    const segs = w.segs || 6;
    const sx = [w.x], sy = [SCREEN_H - 20];
    for (let s = 1; s <= segs; s++) {
      sx[s] = w.x + Math.sin(animTick * 0.05 + i * 1.20 + s * 0.45) * s * 2.0;
      sy[s] = SCREEN_H - 20 - s * 14;
    }
    ctx.strokeStyle = stem; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(sx[0], sy[0]);
    for (let s = 1; s <= segs; s++) ctx.lineTo(sx[s], sy[s]);
    ctx.stroke();
    for (let s = 1; s < segs; s++) {
      const lx = (sx[s - 1] + sx[s]) / 2, ly = (sy[s - 1] + sy[s]) / 2 - 2;
      drawLeaf(lx, ly, (s % 2 === 0) ? 1 : -1, 5 + (s % 3), 3, leaf, stem);
    }
    for (const br of seaweedBranches(w.x, segs)) {
      if (br.at >= segs) continue;
      let bx = sx[br.at], byy = sy[br.at];
      for (let s = 1; s <= 3; s++) {
        const sway = Math.sin(animTick * 0.05 + i * 1.20 + (br.at + s) * 0.45) * (br.at + s) * 1.5;
        const nx = w.x + sway + br.side * s * 12, ny = byy - s * 12;
        ctx.strokeStyle = stem; ctx.lineWidth = 2; seg(bx, byy, nx, ny);
        drawLeaf((bx + nx) / 2, (byy + ny) / 2 - 1, br.side, 4, 2, leaf, stem);
        bx = nx; byy = ny;
      }
    }
  });
}

function drawFgHornwort(plants, bright) {
  if (!Array.isArray(plants.hornwort)) return;
  const stem = shadeN(0x00AA44, bright), leaf = shadeN(0x33DD66, bright);
  plants.hornwort.forEach((h, i) => {
    const segs = h.segs || 5;
    const tipSway = Math.sin(animTick * 0.05 + i * 1.30) * 5.0;
    ctx.strokeStyle = stem; ctx.lineWidth = 2;
    for (let s = 0; s < segs; s++) {
      const t = s / segs, tn = (s + 1) / segs, cy = SCREEN_H - 20 - s * 14;
      seg(h.x + tipSway * t, cy, h.x + tipSway * tn, cy - 14);
    }
    ctx.strokeStyle = leaf; ctx.lineWidth = 1;
    for (let s = 0; s <= segs; s++) {
      const t = s / segs, cx = h.x + tipSway * t, cy = SCREEN_H - 20 - s * 14;
      const nl = (1 - t * 0.60) * 13;
      if (nl > 1) { seg(cx, cy, cx - nl, cy - 2); seg(cx, cy, cx + nl, cy - 2); }
    }
  });
}

// ── Fish cast soft shadows on the sand directly below them ──
function drawShadows(fishArr) {
  ctx.save();
  ctx.fillStyle = 'rgba(74,48,16,0.45)';
  for (const f of fishArr) {
    const type = f.type || 0, z = f.z || 0;
    if ((type === 1 || type === 2 || type === 3) && z > 0.78) continue;
    const sx = projX(f.x, z), fy = projY(f.y, z);
    const gnd = terrainY[clamp(Math.round(sx), 0, SCREEN_W - 1)];
    const dist = gnd - fy;
    if (dist <= 0) continue;
    let scale = 1 - dist / 300; if (scale < 0.12) scale = 0.12;
    const rx = Math.max(1, fishHW(f) * scale), ry = Math.max(1, 3 * fishTS(f) * growth(f) * scale);
    ctx.beginPath(); ctx.ellipse(sx, gnd - 1, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

// ── Bubbles: source-aware (sand floor, plant tips, fish) ─────────────────────
// Fewer bubbles than the device; each rises from a realistic origin rather than
// spawning at random positions. Mirrors the device timing (df = device-frames).
const MAX_BUBBLES = 12;
const bubbles = [];

// Fixed sand-floor emitters: staggered x positions, independent countdown timers.
const _sandEmitters = [70, 155, 260, 370, 460, 580, 690, 750].map((x, i) => ({
  x, nextIn: 40 + i * 22 + Math.random() * 60,
}));

// Plant-tip emitters — seeded once from the first snapshot that includes plants
// (plants are static per aquarium). tipY = SCREEN_H - 20 - segs * 15.
let _plantEmitters = null;

// Single shared fish-bubble timer — picks a random fish each interval.
let _fishBubbleTimer = 80 + Math.random() * 100;

function _makeBubble(x, y, small) {
  if (bubbles.length >= MAX_BUBBLES) return;
  bubbles.push({
    x: x + (Math.random() - 0.5) * 10,
    y,
    vy: small ? 0.5 + Math.random() * 0.5 : 0.7 + Math.random() * 1.1,
    r: small ? 2 : 2 + Math.floor(Math.random() * 3),
    ph: Math.random() * Math.PI * 2,
  });
}

function tickBubbles(df) {
  const snap = latestSnapshot;

  // Seed plant emitters once when the first snapshot with plants arrives.
  if (!_plantEmitters && snap && snap.plants) {
    _plantEmitters = [];
    const addTips = (arr, defSegs) => {
      if (!Array.isArray(arr)) return;
      for (const p of arr) {
        const segs = p.segs || defSegs;
        _plantEmitters.push({ x: p.x, tipY: SCREEN_H - 20 - segs * 15,
                              nextIn: 80 + Math.random() * 200 });
      }
    };
    addTips(snap.plants.bg,       6);
    addTips(snap.plants.weeds,    6);
    addTips(snap.plants.hornwort, 5);
  }

  // Advance existing bubbles; remove ones that reached the surface.
  for (let i = bubbles.length - 1; i >= 0; i--) {
    const b = bubbles[i];
    b.y -= b.vy * df;
    b.x = clamp(b.x + Math.sin(animTick * 0.06 + b.ph) * 0.8 * df, 2, SCREEN_W - 2);
    if (b.y < TANK_TOP) bubbles.splice(i, 1);
  }

  // Sand-floor spawns: slow, medium-sized bubbles rising from the substrate.
  for (const em of _sandEmitters) {
    em.nextIn -= df;
    if (em.nextIn <= 0) {
      const by = terrainY[clamp(Math.round(em.x), 0, SCREEN_W - 1)];
      _makeBubble(em.x, by - 1, false);
      em.nextIn = 100 + Math.random() * 200;
    }
  }

  // Plant-tip spawns: tiny bubbles drifting up from photosynthesis.
  if (_plantEmitters) {
    for (const em of _plantEmitters) {
      em.nextIn -= df;
      if (em.nextIn <= 0) {
        _makeBubble(em.x, em.tipY, true);
        em.nextIn = 160 + Math.random() * 280;
      }
    }
  }

  // Fish bubbles: one small bubble from a random fish on each timer tick.
  if (snap && Array.isArray(snap.fish) && snap.fish.length) {
    _fishBubbleTimer -= df;
    if (_fishBubbleTimer <= 0) {
      const f = snap.fish[Math.floor(Math.random() * snap.fish.length)];
      const z = f.z || 0;
      _makeBubble(projX(f.x, z), projY(f.y, z) - 6, true);
      _fishBubbleTimer = 80 + Math.random() * 100;
    }
  }
}

function drawBubbles(top) {
  ctx.save();
  ctx.strokeStyle = 'rgba(85,204,255,0.7)'; ctx.lineWidth = 1;
  for (const b of bubbles) {
    const bx = Math.round(b.x), by = Math.round(b.y);
    if (by - b.r < top) continue;
    ctx.beginPath(); ctx.arc(bx, by, b.r, 0, Math.PI * 2); ctx.stroke();
    if (b.r > 2) {
      ctx.beginPath(); ctx.arc(bx, by, b.r - 1, 0, Math.PI * 2); ctx.stroke();
      // Tiny highlight for realism
      ctx.fillStyle = 'rgba(200,240,255,0.4)';
      const hr = Math.max(1, Math.round(b.r * 0.28));
      ctx.beginPath(); ctx.arc(bx - hr, by - hr, hr, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.restore();
}

// ── Food flakes — telemetry sends x/y/color only; draw a little cross ──
function drawFlake(f) {
  const x = Math.round(f.x), y = Math.round(f.y);
  ctx.fillStyle = hex(f.color || 0xffaa22);
  ctx.fillRect(x - 3, y, 7, 1);
  ctx.fillRect(x, y - 3, 1, 7);
}

// ── Bottom dwellers ──
function drawSnail(sn, collector = false) {
  const bx = Math.round(sn.x), by = terrainY[clamp(bx, 0, SCREEN_W - 1)];
  const d = sn.facing_right ? 1 : -1;
  // Coin-collector snails wear an emerald "helper" shell so they read as a
  // different, useful critter; pond snails keep the earthy brown shell.
  const BODY  = collector ? 0x8FD89A : 0xDDB060;
  const SHELL = collector ? 0x1F6B47 : 0x7A2E0A;
  const SWIRL = collector ? 0x5FE0A0 : 0xB05020;
  fcirc(bx - d * 4, by - 8, 8, SHELL);             // shell
  scirc(bx - d * 3, by - 8, 5, SWIRL);             // swirl
  scirc(bx - d * 2, by - 8, 2, SWIRL);
  fillEllipseC(bx, by - 3, 12, 3, hex(BODY));        // body
  fcirc(bx + d * 10, by - 5, 5, BODY);              // head
  ctx.strokeStyle = hex(BODY); ctx.lineWidth = 1;
  seg(bx + d * 8, by - 9, bx + d * 6, by - 15);     // eyestalks
  seg(bx + d * 12, by - 9, bx + d * 14, by - 15);
  fcirc(bx + d * 6, by - 15, 2, BODY); fcirc(bx + d * 14, by - 15, 2, BODY);
  fcirc(bx + d * 6, by - 15, 1, 0x111111); fcirc(bx + d * 14, by - 15, 1, 0x111111);
}

function drawStarfish(st) {
  const bx = Math.round(st.x), by = terrainY[clamp(bx, 0, SCREEN_W - 1)] - 10;
  const rot = Math.sin(animTick * 0.018) * 0.18;
  const px = [], py = [];
  for (let i = 0; i < 10; i++) {
    const a = rot - 1.5708 + i * 0.6283, rad = (i % 2 === 0) ? 9 : 4;
    px[i] = bx + rad * Math.cos(a); py[i] = by + rad * Math.sin(a);
  }
  ctx.fillStyle = hex(0xFF6600);
  for (let i = 0; i < 10; i++) {
    const j = (i + 1) % 10;
    ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(px[i], py[i]); ctx.lineTo(px[j], py[j]); ctx.closePath(); ctx.fill();
  }
}

// ── Career: wandering fish (tap to keep) + loot (coins/shells, tap to collect) ──
function drawWanderer(w) {
  const sx = w.x, sy = w.y, right = w.facing_right;
  const glyph = (w.type === 0) ? (right ? '><(o>' : '<o(><') : (right ? '><>' : '<><');
  ctx.save();
  const pulse = 0.5 + 0.5 * Math.sin(animTick * 0.12);
  ctx.strokeStyle = `rgba(120,230,255,${(0.3 + 0.4 * pulse).toFixed(2)})`;
  ctx.lineWidth = 2; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.arc(sx, sy, 18, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([]);
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.font = 'bold 16px "Courier New", monospace';
  ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(0,18,34,0.6)';
  ctx.strokeText(glyph, sx, sy);
  ctx.fillStyle = fishColorHex(w);
  ctx.fillText(glyph, sx, sy);
  if (isShiny(w)) {
    ctx.globalAlpha = 0.18 + 0.24 * (0.5 + 0.5 * Math.sin(animTick * 0.30 + (w.id || 0)));
    ctx.fillStyle = '#ffffff';
    ctx.fillText(glyph, sx, sy);
    ctx.globalAlpha = 1;
    drawShinyGlints(sx, sy, 14, 16, w.id || 0);
  }
  ctx.restore();
}

function drawLoot(it) {
  const x = it.x, y = it.y;
  if (it.kind === 'coin') {
    fcirc(x, y, 7, 0xFFD23F);
    scirc(x, y, 7, 0xB8860B);
    ctx.fillStyle = '#8a6508';
    ctx.font = 'bold 9px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('$', x, y + 0.5);
  } else {
    const tierCol = [0xE7C9A0, 0xFF9EC4, 0xFFD23F][it.tier || 0] || 0xE7C9A0;
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = hex(tierCol);
    ctx.beginPath(); ctx.arc(0, 2, 9, Math.PI, 0, false); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1;
    for (let i = -2; i <= 2; i++) { ctx.beginPath(); ctx.moveTo(0, 2); ctx.lineTo(i * 4, -7); ctx.stroke(); }
    ctx.restore();
  }
}

// ── Steamboat: hull, cabin, portholes, smokestack + animated smoke ──
function drawBoat(bxf, top) {
  const bx = Math.round(bxf);
  const by = top - 23 + Math.round(Math.sin(animTick * 0.04)); // gentle bob
  tri(bx + 4, by, bx + 72, by, bx + 38, by + 6, 0x7B3A10);     // keel
  frect(bx + 2, by - 11, 72, 11, 0xA0522D);                    // hull
  tri(bx, by, bx + 2, by - 8, bx + 2, by, 0x7B3A10);           // bow
  tri(bx + 74, by, bx + 74, by - 8, bx + 72, by - 8, 0x7B3A10);// stern
  frect(bx + 2, by - 11, 72, 2, 0xC07040);                     // hull highlight
  frect(bx + 2, by - 13, 72, 2, 0xD2B48C);                     // deck rail
  frect(bx + 16, by - 25, 40, 12, 0xFDF5E6);                   // cabin
  frect(bx + 14, by - 27, 44, 2, 0x888888);                    // roof
  ctx.strokeStyle = hex(0xAAAAAA); ctx.lineWidth = 1; ctx.strokeRect(bx + 16, by - 25, 40, 12);
  fcirc(bx + 26, by - 20, 4, 0x87CEEB); fcirc(bx + 44, by - 20, 4, 0x87CEEB); // portholes
  scirc(bx + 26, by - 20, 4, 0x555555); scirc(bx + 44, by - 20, 4, 0x555555);
  frect(bx + 52, by - 37, 8, 14, 0x444444);                    // smokestack
  frect(bx + 50, by - 39, 12, 3, 0x444444);                    // stack cap
  for (let p = 0; p < 3; p++) {
    const phase = (animTick * 0.6 + p * 20) % 60;
    let sr = 4 - Math.floor(phase / 20); if (sr < 1) sr = 1;
    const alpha = 180 - phase * 2;
    const sc = alpha > 150 ? 0xCCCCCC : alpha > 100 ? 0xBBBBBB : 0xAAAAAA;
    ctx.save();
    ctx.globalAlpha = clamp(alpha / 255, 0.15, 0.7);
    fcirc(bx + 55 - phase * 0.6, by - 42 - phase * 0.35, sr + 1, sc);
    ctx.restore();
  }
}

// ── Weather particles over the tank ──
function drawRain(cond, bright) {
  ctx.strokeStyle = shadeN(cond === 4 ? 0x7799BB : 0x88AACC, bright);
  ctx.lineWidth = 1;
  const N = cond === 4 ? 90 : 60;
  for (let i = 0; i < N; i++) {
    const x = (i * 53 + animTick * 1.8) % (SCREEN_W + 20) - 10;
    const y = (i * 71 + animTick * (9 + (i % 5))) % (SCREEN_H + 20) - 10;
    seg(x, y, x + 2, y + 5);
  }
}
function drawSnow(bright) {
  ctx.fillStyle = shadeN(0xEEEEFF, bright);
  for (let i = 0; i < 70; i++) {
    const x = (i * 37 + Math.sin(animTick * 0.02 + i) * 8) % SCREEN_W;
    const y = (i * 59 + animTick * (1.2 + (i % 4) * 0.4)) % SCREEN_H;
    ctx.fillRect(x, y, 2, 2);
  }
}

let selectedId = null;
let stream = null;
let latestSnapshot = null; // last received SSE/poll snapshot (raw, not extrapolated)
let snapshotReceivedAt = 0; // wall-clock ms when we received it
let rafId = null;
let highlightedFishId = null; // legend row → highlight on the canvas
const legendRows = new Map(); // fishId -> { el, nameInput, ageEl, swatchEl }

// ─── Canvas hover / selection state ──────────────────────────────────────────
// hitTargets is rebuilt every drawn frame from the *displayed* (extrapolated)
// positions, so hover/click hit-testing lines up with what's on screen.
let hitTargets = [];      // [{ key, kind, ref, x, y, r, role }]
let hoveredKey = null;    // entity under the cursor (canvas hover)
let profileKey = null;    // entity whose detail profile is open (fish/snail)

// Transient click feedback: a glass-tap ripple on every tank click, plus a
// celebratory burst when a collectible is obtained. Driven by wall-clock ms so
// the animation is smooth at the 60fps rAF rate regardless of telemetry cadence.
const pulses = [];        // { x, y, kind: 'tap'|'collect', color, t0 }
function spawnPulse(x, y, kind, color) {
  pulses.push({ x, y, kind, color: color || null, t0: performance.now() });
  if (pulses.length > 24) pulses.splice(0, pulses.length - 24);
}
function rgbaFromHex(h, a) {
  const n = parseInt(h.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${clamp(a, 0, 1).toFixed(3)})`;
}
function drawPulses() {
  if (!pulses.length) return;
  const now = performance.now();
  ctx.save();
  for (let i = pulses.length - 1; i >= 0; i--) {
    const p = pulses[i];
    const life = p.kind === 'tap' ? 420 : 620;
    const t = (now - p.t0) / life;
    if (t >= 1) { pulses.splice(i, 1); continue; }
    const ease = 1 - (1 - t) * (1 - t);   // ease-out expansion
    const a = 1 - t;                        // linear fade
    if (p.kind === 'tap') {
      // A single faint ripple — just enough to register where you tapped.
      const r = 5 + ease * 18;
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = rgbaFromHex('#bfe6ff', a * 0.38);
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke();
    } else {
      const col = p.color || '#ffd23f';
      const r = 8 + ease * 26;
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = rgbaFromHex(col, a);
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke();
      const spark = 6 + ease * 22;
      ctx.lineWidth = 2;
      ctx.strokeStyle = rgbaFromHex(col, a * 0.9);
      for (let k = 0; k < 6; k++) {
        const ang = (k / 6) * Math.PI * 2 + t * 0.6;
        const c = Math.cos(ang), s = Math.sin(ang);
        ctx.beginPath();
        ctx.moveTo(p.x + c * spark, p.y + s * spark);
        ctx.lineTo(p.x + c * (spark + 6), p.y + s * (spark + 6));
        ctx.stroke();
      }
    }
  }
  ctx.restore();
}

// Playback timing: the rAF loop's previous wall-clock timestamp (to advance the
// playhead by real elapsed time × the device's measured tick-rate).
let _lastRafMs = 0;

const els = {
  list: document.getElementById('aquarium-list'),
  emptyHint: document.getElementById('empty-hint'),
  newAquarium: document.getElementById('new-aquarium'),
  deviceList: document.getElementById('device-list'),
  deviceEmpty: document.getElementById('device-empty'),
  viewEmpty: document.getElementById('view-empty'),
  viewContent: document.getElementById('view-content'),
  stats: document.getElementById('stats'),
  conn: document.getElementById('conn'),
  canvas: document.getElementById('tank'),
  viewName: document.getElementById('view-name'),
  viewSub: document.getElementById('view-sub'),
  viewDot: document.getElementById('view-dot'),
  legend: document.getElementById('legend'),
  legendOverlay: document.getElementById('legend-overlay'),
  legendToggle: document.getElementById('legend-toggle'),
  conflictBar: document.getElementById('conflict-bar'),
  conflictDetail: document.getElementById('conflict-detail'),
  conflictServer: document.getElementById('conflict-server'),
  conflictLocal: document.getElementById('conflict-local'),
  controls: document.getElementById('controls'),
  ctrlWeather: document.getElementById('ctrl-weather'),
  ctrlTime: document.getElementById('ctrl-time'),
  ctrlTimeVal: document.getElementById('ctrl-time-val'),
  ctrlFish: document.getElementById('ctrl-fish'),
  ctrlFeed: document.getElementById('ctrl-feed'),
  ctrlPending: document.getElementById('ctrl-pending'),
  ctrlStatus: document.getElementById('ctrl-status'),
  fishGroup: document.getElementById('ctrl-fish-group'),
  gamePanel: document.getElementById('game-panel'),
  hudMode: document.getElementById('hud-mode'),
  hudCoins: document.getElementById('hud-coins'),
  hudShells: document.getElementById('hud-shells'),
  hudFood: document.getElementById('hud-food'),
  hudSnails: document.getElementById('hud-snails'),
  hudLuck: document.getElementById('hud-luck'),
  hudMeals: document.getElementById('hud-meals'),
  modeSeg: document.getElementById('mode-seg'),
  shop: document.getElementById('shop'),
  shopFish: document.getElementById('shop-fish'),
  shopFood: document.getElementById('shop-food'),
  shopSnail: document.getElementById('shop-snail'),
  modeConfirm: document.getElementById('mode-confirm'),
  modeConfirmTitle: document.getElementById('mode-confirm-title'),
  modeConfirmDetail: document.getElementById('mode-confirm-detail'),
  modeConfirmOk: document.getElementById('mode-confirm-ok'),
  modeConfirmCancel: document.getElementById('mode-confirm-cancel'),
  tooltip: document.getElementById('entity-tooltip'),
  profile: document.getElementById('entity-profile'),
  profileBody: document.getElementById('profile-body'),
  profileClose: document.getElementById('profile-close'),
  dialog: document.getElementById('app-dialog'),
  dialogForm: document.getElementById('dialog-form'),
  dialogTitle: document.getElementById('dialog-title'),
  dialogMessage: document.getElementById('dialog-message'),
  dialogInput: document.getElementById('dialog-input'),
  dialogOk: document.getElementById('dialog-ok'),
  dialogCancel: document.getElementById('dialog-cancel'),
};
const ctx = els.canvas.getContext('2d');

// Shop prices (coins), mirroring the firmware/mock economy.
const FISH_PRICE     = [10, 30, 45, 60, 8]; // clownfish, guppy, piranha, angel, salmon (common→cheap)
const FISH_BASE_SELL = [6, 3, 22, 30];    // base sell value; school cheap to prevent market farming
const FOOD_PRICE = 5;
const SNAIL_PRICE = 50;
const MAX_SNAILS = 6;

// ─── Modal dialog (replaces native prompt/confirm) ───────────────────────────
// A single reusable modal handles both name entry (input mode) and yes/no confirms.
// openDialog() resolves to the typed string (input mode) / true (confirm mode) on OK,
// or null on cancel/escape/backdrop. Convenience wrappers: promptDialog / confirmDialog.
let _dialogState = null; // { resolve, input } while a dialog is open

function _closeDialog(result) {
  if (!_dialogState) return;
  const { resolve } = _dialogState;
  _dialogState = null;
  els.dialog.hidden = true;
  document.removeEventListener('keydown', _dialogKeydown, true);
  resolve(result);
}
function _dialogKeydown(e) {
  if (e.key === 'Escape') { e.preventDefault(); _closeDialog(null); }
}
function openDialog(opts = {}) {
  if (_dialogState) _closeDialog(null); // a new dialog supersedes any open one
  return new Promise((resolve) => {
    _dialogState = { resolve, input: !!opts.input };
    els.dialogTitle.textContent = opts.title || '';
    if (opts.message) { els.dialogMessage.textContent = opts.message; els.dialogMessage.hidden = false; }
    else els.dialogMessage.hidden = true;
    if (opts.input) {
      els.dialogInput.hidden = false;
      els.dialogInput.value = opts.value || '';
      els.dialogInput.placeholder = opts.placeholder || '';
      els.dialogInput.maxLength = 24; // matches server MAX_NAME_LEN
    } else {
      els.dialogInput.hidden = true;
    }
    els.dialogOk.textContent = opts.okLabel || 'OK';
    els.dialogCancel.textContent = opts.cancelLabel || 'Cancel';
    els.dialogOk.classList.toggle('danger', !!opts.danger);
    els.dialog.hidden = false;
    document.addEventListener('keydown', _dialogKeydown, true);
    if (opts.input) { els.dialogInput.focus(); els.dialogInput.select(); }
    else els.dialogOk.focus();
  });
}
function promptDialog(title, value, opts = {}) {
  return openDialog({ title, input: true, value, ...opts }).then((r) => (r == null ? null : String(r).trim()));
}
function confirmDialog(title, message, opts = {}) {
  return openDialog({ title, message, ...opts }).then((r) => r === true);
}
els.dialogForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!_dialogState) return;
  _closeDialog(_dialogState.input ? els.dialogInput.value : true);
});
els.dialogCancel.addEventListener('click', () => _closeDialog(null));
els.dialog.addEventListener('mousedown', (e) => { if (e.target === els.dialog) _closeDialog(null); });

// ─── Sidebar / list polling ────────────────────────────────────────────────
let _aquariums = [];   // latest aquarium list (also used to build device assignment menus)

async function refreshList() {
  try {
    const res = await fetch('api/aquariums');
    const items = await res.json();
    _aquariums = items;
    renderList(items);
    setConn(true);
  } catch {
    setConn(false);
  }
  refreshDevices();
}

// ─── Devices ───────────────────────────────────────────────────────────────
async function refreshDevices() {
  try {
    const res = await fetch('api/devices');
    renderDevices(await res.json());
  } catch { /* leave the last render up */ }
}

function renderDevices(devices) {
  if (!els.deviceList) return;
  els.deviceEmpty.hidden = devices.length > 0;
  els.deviceList.innerHTML = '';
  for (const d of devices) {
    const li = document.createElement('li');
    li.className = 'dev-row' + (d.online ? '' : ' stale-row');
    const kindBadge = escapeHtml(d.kind || 'device'); // physical platform (esp32 / pi / …)
    // Assignment menu: every known aquarium + this device's own (in case it's stale)
    // + the unassigned option. Lets you point a real device at a different tank.
    const ids = new Set(_aquariums.map((a) => a.aquarium_id));
    if (d.aquariumId) ids.add(d.aquariumId);
    const opts = ['<option value="">— unassigned —</option>'].concat(
      [...ids].map((id) => {
        const a = _aquariums.find((x) => x.aquarium_id === id);
        const label = a && a.name ? `${a.name} (${id})` : id;
        return `<option value="${escapeHtml(id)}"${id === d.aquariumId ? ' selected' : ''}>${escapeHtml(label)}</option>`;
      })
    ).join('');
    li.innerHTML = `
      <button class="dev-del" title="Forget this device" aria-label="Forget device">×</button>
      <div class="dev-name">
        <span class="dot ${d.online ? 'live' : 'stale'}"></span>${escapeHtml(d.name)}
        <span class="dev-kind">${kindBadge}</span>
      </div>
      <div class="dev-assign">
        <label>Aquarium</label>
        <select class="dev-aq">${opts}</select>
      </div>`;
    li.querySelector('.dev-aq').addEventListener('change', (e) => assignDevice(d.id, e.target.value || null));
    li.querySelector('.dev-name').addEventListener('click', () => renameDevice(d));
    li.querySelector('.dev-del').addEventListener('click', (e) => { e.stopPropagation(); deleteDevice(d); });
    els.deviceList.appendChild(li);
  }
}

async function createAquarium() {
  const name = await promptDialog('New aquarium', '', {
    placeholder: 'My tank', okLabel: 'Create',
  });
  if (!name) return; // cancelled or empty
  try {
    const res = await fetch('api/aquariums', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    await refreshList();
    if (data.aquariumId) { setRoute(data.aquariumId); select(data.aquariumId); } // jump to the new tank
  } catch { /* refresh will reflect reality */ }
}

async function assignDevice(id, aquariumId) {
  try {
    await fetch('api/devices/' + encodeURIComponent(id), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aquariumId }),
    });
  } catch { /* ignore */ }
  refreshList();   // also refreshes devices (one-per-aquarium may have moved another)
}

async function renameDevice(d) {
  const name = await promptDialog('Rename device', d.name, { okLabel: 'Save' });
  if (!name || name === d.name) return;
  try {
    await fetch('api/devices/' + encodeURIComponent(d.id), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
  } catch { /* ignore */ }
  refreshDevices();
}

async function deleteDevice(d) {
  const ok = await confirmDialog('Forget device?',
    `Forget "${d.name}"? Its aquarium keeps running as a server simulation. The device reappears automatically if the hardware reports in again.`,
    { okLabel: 'Forget', danger: true });
  if (!ok) return;
  try { await fetch('api/devices/' + encodeURIComponent(d.id), { method: 'DELETE' }); } catch { /* ignore */ }
  refreshDevices();
}

function setConn(online) {
  els.conn.textContent = online ? 'connected' : 'disconnected';
  els.conn.className = 'conn ' + (online ? 'online' : 'offline');
}

// ─── URL routing ─────────────────────────────────────────────────────────────
// The selected aquarium lives in the hash (#/<id>) so the view survives reloads
// and is shareable. Hash routing is reverse-proxy-safe (independent of the
// injected <base href>) and needs no server-side catch-all route.
function routeId() {
  return decodeURIComponent(location.hash.replace(/^#\/?/, '')) || null;
}
function setRoute(id) {
  if (id) {
    const target = '#/' + encodeURIComponent(id);
    if (location.hash !== target) location.hash = target;
  } else if (location.hash) {
    history.replaceState(null, '', location.pathname + location.search);
  }
}

// Forget an aquarium (delete it permanently, or just declutter). A simulated tank is
// gone for good; a hardware-backed one re-appears on the device's next telemetry post.
async function removeAquarium(a) {
  const id = a.aquarium_id;
  const label = a.name || id;
  const msg = (a.device
    ? 'It is backed by a device and will reappear when the hardware next reports in.'
    : 'It is simulated on the server and will be permanently removed.');
  const ok = await confirmDialog('Remove aquarium?', `Remove "${label}"? ${msg}`, {
    okLabel: 'Remove', danger: true,
  });
  if (!ok) return;
  try {
    await fetch('api/aquariums/' + encodeURIComponent(id), { method: 'DELETE' });
  } catch { /* ignore — the list refresh below reflects reality */ }
  if (selectedId === id) {
    if (stream) { stream.close(); stream = null; }
    selectedId = null;
    latestSnapshot = null;
    els.viewContent.hidden = true;
    els.viewEmpty.hidden = false;
    setRoute(null);
  }
  refreshList();
}

function renderList(items) {
  els.emptyHint.hidden = items.length > 0;
  els.list.innerHTML = '';
  for (const a of items) {
    const li = document.createElement('li');
    li.className = (a.aquarium_id === selectedId ? 'active' : '') + (a.stale ? ' stale-row' : '');
    const weather = a.weather ? (WEATHER_NAMES[a.weather.condition] || '?') : '—';
    const title = a.name || a.aquarium_id;
    // Source badge: a live device drives the tank, otherwise the server web-simulates it.
    const src = (a.device && a.device.online)
      ? `<span class="aq-src device" title="Driven by ${escapeHtml(a.device.name)}">📟 ${escapeHtml(a.device.name)}</span>`
      : `<span class="aq-src sim" title="Simulated on the server">🖥 web sim</span>`;
    li.innerHTML = `
      <button class="aq-del" title="Remove this aquarium" aria-label="Remove aquarium">×</button>
      <div class="aq-name">
        <span class="dot ${a.stale ? 'stale' : 'live'}"></span>${escapeHtml(title)}${a.conflict ? '<span class="aq-conflict">⚠ mismatch</span>' : ''}
      </div>
      <div class="aq-meta">${a.fishCount} fish · ${weather} ${src}</div>`;
    li.addEventListener('click', () => select(a.aquarium_id));
    li.querySelector('.aq-del').addEventListener('click', (e) => {
      e.stopPropagation();
      removeAquarium(a);
    });
    els.list.appendChild(li);
  }
  // Default selection: honour the URL hash if it names a known aquarium, else the
  // first one so the view is never empty.
  if (!selectedId && items.length) {
    const want = routeId();
    const match = want && items.some((a) => a.aquarium_id === want);
    select(match ? want : items[0].aquarium_id);
  }
}

function select(id) {
  if (selectedId === id) return;
  selectedId = id;
  latestSnapshot = null;
  snapshotReceivedAt = 0;
  resetInterp();
  _lastRafMs = 0;
  _plantEmitters = null;
  highlightedFishId = null;
  hoveredKey = null;
  hitTargets = [];
  pulses.length = 0;
  closeProfile();
  hideTooltip();
  legendRows.clear();
  els.legend.innerHTML = '';
  els.conflictBar.hidden = true;
  els.controls.hidden = true;
  els.gamePanel.hidden = true;
  els.modeConfirm.hidden = true;
  _ctrlHold.weather = _ctrlHold.time = 0;
  _pendingQueue.length = 0;
  clearTimeout(_pendingTimer); _pendingTimer = null;
  if (els.ctrlPending) els.ctrlPending.hidden = true;
  els.viewEmpty.hidden = true;
  els.viewContent.hidden = false;
  openStream(id);
  setRoute(id);
  refreshList();
}

function applySnapshot(snap) {
  const now = Date.now();
  // _lastSeenMs is when the server received the telemetry POST — the closest
  // proxy to when the device built the snapshot. Used only for the title's
  // staleness check; playback timing rides the device `tick`, not wall-clock.
  const serverRx = (snap._lastSeenMs && snap._lastSeenMs <= now) ? snap._lastSeenMs : now;

  // Push the real device state into the interpolation buffer; the rAF playhead
  // replays it (interpolated) trailing ~one publish interval behind. No prediction,
  // so nothing to blend or dead-reckon here.
  acceptSnapshot(snap);

  latestSnapshot = snap;
  snapshotReceivedAt = serverRx;
  // Legend, stats, and title update at telemetry rate (≤1 Hz) — cheap DOM work.
  drawTitle(snap);
  drawStats(snap);
  renderLegend(snap);
  renderConflict(snap);
  renderControls(snap);
  renderGame(snap);
  if (profileKey) renderProfile();
  resolvePending(snap);
  setConn(true);
  // Ensure the 60fps canvas loop is running.
  if (!rafId) rafId = requestAnimationFrame(_rafDraw);
}

// ─── SSE stream for the selected aquarium ────────────────────────────────────
// SSE is the primary, low-latency path. A watchdog (startWatchdog) polls as a
// fallback whenever SSE goes quiet — e.g. when a reverse proxy buffers the
// stream — so the tank never silently freezes.
function openStream(id) {
  if (stream) stream.close();
  try {
    stream = new EventSource('api/stream?id=' + encodeURIComponent(id));
    stream.addEventListener('snapshot', (e) => {
      try {
        applySnapshot(JSON.parse(e.data));
      } catch {}
    });
    // Transient errors are normal (reconnects); don't flap the badge here —
    // the watchdog + list poll decide the real connection state.
  } catch {
    stream = null;
  }
}

// Poll the selected aquarium directly if SSE hasn't delivered recently.
async function pollSelected() {
  if (!selectedId) return;
  try {
    const res = await fetch('api/aquariums/' + encodeURIComponent(selectedId));
    if (res.ok) applySnapshot(await res.json());
  } catch {
    setConn(false);
  }
}

function startWatchdog() {
  setInterval(() => {
    if (!selectedId) return;
    if (Date.now() - snapshotReceivedAt > 4000) pollSelected();
  }, 2000);
}

// ─── EAC silhouette fish ─────────────────────────────────────────────────────
// Horizontal current band across the mid-tank. Fish drift left to right.
const EAC_Y1 = 180, EAC_Y2 = 270;   // horizontal band (mid-tank)
const EAC_MAX_FISH = 12;

let eacFish = [];
let eacTargetCount = 0;
let eacBright = 0.5;

function eacSpawnFish(startX) {
  const bandH = EAC_Y2 - EAC_Y1;
  return {
    x: startX ?? Math.random() * SCREEN_W,
    y: EAC_Y1 + bandH * 0.1 + Math.random() * bandH * 0.8,
    speed: 0.3 + Math.random() * 0.5,   // device spd range (0.3..0.8 px/device-frame)
    size: 6 + Math.random() * 7,        // device size range (6..13)
    wobbleOff: Math.random() * Math.PI * 2,
  };
}

function updateEacCount(congestion) {
  eacTargetCount = Math.round(congestion * EAC_MAX_FISH);
}

// Drift the traffic silhouettes at the device's 20fps cadence: advance by `df`
// device-frames per call (not once per rAF) and phase the wobble off animTick
// (device tick units), exactly like the device's updateEacFish().
function tickEac(df) {
  while (eacFish.length < eacTargetCount) eacFish.push(eacSpawnFish(0));
  if (eacFish.length > eacTargetCount) eacFish.splice(eacTargetCount);

  const bandH = EAC_Y2 - EAC_Y1;
  for (const f of eacFish) {
    f.x += f.speed * df;
    // gentle vertical wobble within the band
    f.y = EAC_Y1 + bandH * 0.5 + Math.sin(animTick * 0.018 + f.wobbleOff) * bandH * 0.3;
    if (f.x > SCREEN_W + 20) f.x = -20;  // loop left
  }
}

function drawEacZone(bright) {
  // No zone tint — silhouettes only
  ctx.save();
  ctx.globalAlpha = 0.13 * bright + 0.04;  // very faint, brightest at noon
  ctx.fillStyle = '#061c2e';
  for (const f of eacFish) {
    drawSilhouetteFish(f.x, f.y, f.size);
  }
  ctx.restore();
}

function drawSilhouetteFish(x, y, size) {
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.ellipse(0, 0, size, size * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(-size, 0);
  ctx.lineTo(-size - size * 0.7, -size * 0.45);
  ctx.lineTo(-size - size * 0.7,  size * 0.45);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// ─── Rendering ───────────────────────────────────────────────────────────────
// Single 60fps rAF loop driven by ONE live clock (devClock, in device-tick units).
// Each frame it advances the clock to the live edge, reseeds prediction when a new
// authoritative snapshot has arrived, steps the device's own fish physics forward to
// the edge (carrying a sub-frame remainder for smooth 60 fps), decays the small
// reconciliation error, and draws. The same clock phases the decorative animations
// (sway/water/smoke via animTick; bubbles/EAC via the per-frame tick delta), so the
// whole scene runs in lockstep with the panel — real time, no interval of lag.
// Title/stats/legend update at SSE rate (≤1 Hz) from applySnapshot.
function _rafDraw() {
  rafId = requestAnimationFrame(_rafDraw);
  const now = Date.now();
  const dtMs = _lastRafMs ? clamp(now - _lastRafMs, 0, 250) : 16;
  _lastRafMs = now;
  if (!lastSnap) return;

  // Advance the live-edge clock; reseed from the freshest snapshot if one just landed.
  if (devClock == null) devClock = snapTick(lastSnap);
  devClock += dtMs * tickRate;
  if (_needReseed) { reseedPrediction(lastSnap, devClock); _needReseed = false; }

  const df = Math.max(0, dtMs * tickRate); // device-frames elapsed this rAF
  if (pred) {
    // Step the prediction forward to the live edge in whole device-frames; keep the
    // sub-frame remainder to render smooth 60 fps between physics frames.
    let whole = Math.floor(devClock - pred.tick);
    if (whole > 0) { whole = Math.min(whole, 6); stepFishN(pred.fish, whole); pred.tick += whole; }
    _frameCarry = clamp(devClock - pred.tick, 0, 1.2);
    // Decay the reconciliation error toward zero (smooths each snapshot's correction).
    const k = Math.pow(ERR_DECAY, df);
    for (const [id, e] of errById) {
      e.ex *= k; e.ey *= k; e.ez *= k;
      if (Math.abs(e.ex) < 0.05 && Math.abs(e.ey) < 0.05 && Math.abs(e.ez) < 0.001) errById.delete(id);
    }
  }

  animTick = devClock;            // decorative phase rides the same live clock
  tickEac(df);
  tickBubbles(df);
  eacBright = dayTint(lastSnap.time && lastSnap.time.day_progress);

  const frame = buildRenderSnap(devClock);
  if (frame) drawTank(frame);
}

// Full re-render (highlight/hover toggles, etc.) — rebuilds at the current live edge.
function render() {
  if (!lastSnap) return;
  const frame = buildRenderSnap(devClock != null ? devClock : snapTick(lastSnap));
  if (!frame) return;
  drawTitle(frame);
  drawTank(frame);
  drawStats(frame);
  renderLegend(latestSnapshot); // legend uses raw snapshot (names/ages, not positions)
}

// Legend: one row per fish, color-matched, with editable name, age, and
// click-to-highlight. Reconciled by fish id so live updates don't clobber a
// rename in progress.
// Fish legend is hidden by default; a floating toggle over the tank shows it.
let legendVisible = false;
function setLegendVisible(on) {
  legendVisible = on;
  els.legendOverlay.hidden = !on;
  els.legendToggle.classList.toggle('on', on);
  els.legendToggle.setAttribute('aria-pressed', on ? 'true' : 'false');
  if (on && latestSnapshot) renderLegend(latestSnapshot);
}
els.legendToggle.addEventListener('click', () => setLegendVisible(!legendVisible));
setLegendVisible(false);

function renderLegend(s) {
  if (!legendVisible) return;   // skip DOM work while the list is hidden
  const fish = Array.isArray(s.fish) ? s.fish.filter((f) => typeof f.id === 'number') : [];
  const seen = new Set();

  for (const f of fish) {
    seen.add(f.id);
    let row = legendRows.get(f.id);
    if (!row) {
      row = buildLegendRow(f);
      legendRows.set(f.id, row);
      els.legend.appendChild(row.el);
    }
    const color = fishColorHex(f);
    row.swatchEl.style.background = color;
    row.el.style.borderLeftColor = color;
    row.el.classList.toggle('shiny', isShiny(f));
    row.ageEl.textContent = formatAge(f.ageMs);
    row.nameInput.placeholder = `${FISH_TYPE_NAMES[f.type] || 'Fish'} #${f.id}`;
    if (document.activeElement !== row.nameInput) row.nameInput.value = f.name || '';
    row.el.classList.toggle('active', f.id === highlightedFishId);
  }

  for (const [id, row] of legendRows) {
    if (!seen.has(id)) {
      row.el.remove();
      legendRows.delete(id);
    }
  }
}

function buildLegendRow(f) {
  const el = document.createElement('div');
  el.className = 'legend-row';

  const swatchEl = document.createElement('span');
  swatchEl.className = 'legend-swatch';

  const nameInput = document.createElement('input');
  nameInput.className = 'legend-name';
  nameInput.spellcheck = false;
  nameInput.maxLength = 24;
  nameInput.addEventListener('click', (e) => e.stopPropagation());
  nameInput.addEventListener('blur', () => saveName(f.id, nameInput.value));
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') nameInput.blur();
    if (e.key === 'Escape') { nameInput.value = ''; nameInput.blur(); }
  });

  const ageEl = document.createElement('span');
  ageEl.className = 'legend-age';

  el.append(swatchEl, nameInput, ageEl);
  el.addEventListener('click', () => {
    highlightedFishId = highlightedFishId === f.id ? null : f.id;
    render();
  });
  return { el, nameInput, ageEl, swatchEl };
}

async function saveName(fishId, value) {
  if (!selectedId) return;
  try {
    await fetch(`api/aquariums/${encodeURIComponent(selectedId)}/fish/${fishId}/name`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: value }),
    });
  } catch {
    /* leave the field as typed; it'll re-sync on the next snapshot */
  }
}

function formatAge(ms) {
  if (!ms || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ' + (m % 60) + 'm';
  return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
}

function fmtCounts(c) {
  if (!c) return '—';
  return `clownfish ${c.pair || 0} · guppy ${c.school || 0} · piranha ${c.school2 || 0} · angel ${c.angel || 0} · salmon ${c.salmon || 0}`;
}

// Show/hide the profile-mismatch banner from the snapshot's _conflict field.
function renderConflict(s) {
  const c = s && s._conflict;
  if (!c) { els.conflictBar.hidden = true; return; }
  els.conflictBar.hidden = false;
  els.conflictDetail.textContent =
    `This device reports a different tank than the server's saved profile — ` +
    `saved: ${fmtCounts(c.savedCounts)}; device: ${fmtCounts(c.deviceCounts)}.`;
}

async function resolveConflict(choice) {
  if (!selectedId) return;
  els.conflictServer.disabled = els.conflictLocal.disabled = true;
  try {
    await fetch(`api/aquariums/${encodeURIComponent(selectedId)}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ choice }),
    });
    els.conflictBar.hidden = true; // optimistic; the next snapshot confirms
  } catch {
    /* leave the banner up so the user can retry */
  } finally {
    els.conflictServer.disabled = els.conflictLocal.disabled = false;
  }
}

els.conflictServer.addEventListener('click', () => resolveConflict('server'));
els.conflictLocal.addEventListener('click', () => resolveConflict('local'));

// ─── Device controls (weather / timescale / fish / feed) ─────────────────────
// POST a directive to the server, which forwards it to the device in the reply
// to that device's next telemetry POST. State is reflected back from snapshots,
// but the device takes a cycle or two to apply, so we briefly "hold" the user's
// own weather/timescale choice to avoid the control snapping back meanwhile.
const CTRL_HOLD_MS = 4000;
const _ctrlHold = { weather: 0, time: 0 };
let _ctrlStatusTimer = null;
let _fishRowsBuilt = false;
const fishCountEls = [];
const fishBtns = [];

// ─── Pending-command queue ────────────────────────────────────────────────────
// Tracks directives that have been sent to the server but not yet reflected in a
// device snapshot. Confirmed when the snapshot state matches; expired after 15s.
const _pendingQueue = []; // [{cmd, label, baseline, sentAt, confirmed, expired}]
let _pendingTimer = null;

function addPending(cmd, label, baseline) {
  _pendingQueue.push({ cmd, label, baseline: baseline || null, sentAt: Date.now(), confirmed: false, expired: false });
  renderPending();
  if (!_pendingTimer) _pendingTimer = setTimeout(_pendingTick, 1000);
}

function _pendingTick() {
  _pendingTimer = null;
  _prunePending();
  renderPending();
  if (_pendingQueue.some((p) => !p.confirmed)) _pendingTimer = setTimeout(_pendingTick, 1000);
}

function _prunePending() {
  const now = Date.now();
  for (const p of _pendingQueue) {
    if (p.confirmed) continue;
    if (now - p.sentAt > 15000) { p.confirmed = true; p.expired = true; }
  }
  // Discard items that have been confirmed/expired for 3+ seconds
  const cutoff = now - 3000;
  while (_pendingQueue.length && _pendingQueue[0].confirmed && _pendingQueue[0].sentAt < cutoff) {
    _pendingQueue.shift();
  }
}

function resolvePending(snap) {
  let changed = false;
  const now = Date.now();
  for (const p of _pendingQueue) {
    if (p.confirmed) continue;
    if (now - p.sentAt > 15000) { p.confirmed = true; p.expired = true; changed = true; continue; }
    switch (p.cmd.type) {
      case 'weather': {
        const w = snap.weather || {};
        const wv = w.override ? (w.condition | 0) : -1;
        if (wv === p.cmd.value) { p.confirmed = true; changed = true; }
        break;
      }
      case 'timescale':
        if (snap.time && ((snap.time.scale || 1) === p.cmd.value)) { p.confirmed = true; changed = true; }
        break;
      case 'fish': {
        if (p.baseline) {
          const c = snap.counts || {};
          const key = FISH_COUNT_KEYS[p.cmd.fishType];
          const expected = (p.baseline[key] || 0) + (p.cmd.action === 'add' ? 1 : -1);
          if ((c[key] || 0) === expected) { p.confirmed = true; changed = true; }
        }
        break;
      }
      case 'feed':
        if (now - p.sentAt > 5000) { p.confirmed = true; changed = true; }
        break;
    }
  }
  _prunePending();
  if (changed) renderPending();
}

function renderPending() {
  const el = els.ctrlPending;
  if (!el) return;
  // Show unconfirmed + recently confirmed (still in queue after pruning)
  if (!_pendingQueue.length) { el.hidden = true; return; }
  el.hidden = false;
  const now = Date.now();
  el.innerHTML = '<div class="pending-head">Queued for device</div>' +
    _pendingQueue.map((p) => {
      const age = Math.round((now - p.sentAt) / 1000);
      const ageStr = age < 2 ? 'just now' : age + 's ago';
      const cls = 'pending-item' + (p.confirmed ? (p.expired ? ' expired' : ' confirmed') : '');
      const icon = p.confirmed ? (p.expired ? '✕' : '✓') : '⟳';
      return `<div class="${cls}">` +
        `<span class="pending-icon">${icon}</span>` +
        `<span class="pending-label">${escapeHtml(p.label)}</span>` +
        `<span class="pending-age">${p.confirmed ? '' : ageStr}</span>` +
        `</div>`;
    }).join('');
}

function setCtrlStatus(msg, kind) {
  els.ctrlStatus.textContent = msg;
  els.ctrlStatus.className = 'ctrl-status' + (kind ? ' ' + kind : '');
  clearTimeout(_ctrlStatusTimer);
  _ctrlStatusTimer = setTimeout(() => {
    els.ctrlStatus.textContent = '';
    els.ctrlStatus.className = 'ctrl-status';
  }, 2500);
}

async function sendControl(cmd, okMsg, pendingInfo) {
  if (!selectedId) return false;
  try {
    const res = await fetch(`api/aquariums/${encodeURIComponent(selectedId)}/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cmd),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) { setCtrlStatus(data.error || 'Failed', 'err'); return false; }
    if (pendingInfo) addPending(cmd, pendingInfo.label, pendingInfo.baseline);
    setCtrlStatus(okMsg || 'Sent ✓', 'ok');
    return true;
  } catch {
    setCtrlStatus('Network error', 'err');
    return false;
  }
}

function buildFishControls() {
  els.ctrlFish.innerHTML = '';
  for (let t = 0; t < 5; t++) {
    const row = document.createElement('div');
    row.className = 'ctrl-fish-row';
    const name = document.createElement('span');
    name.className = 'fish-name';
    name.textContent = FISH_TYPE_NAMES[t];
    const minus = document.createElement('button');
    minus.className = 'fish-btn';
    minus.textContent = '−';
    minus.title = `Remove a ${FISH_TYPE_NAMES[t]}`;
    minus.addEventListener('click', () => changeFish(t, 'remove'));
    const count = document.createElement('span');
    count.className = 'fish-count';
    const plus = document.createElement('button');
    plus.className = 'fish-btn';
    plus.textContent = '+';
    plus.title = `Add a ${FISH_TYPE_NAMES[t]}`;
    plus.addEventListener('click', () => changeFish(t, 'add'));
    row.append(name, minus, count, plus);
    els.ctrlFish.appendChild(row);
    fishCountEls[t] = count;
    fishBtns[t] = { minus, plus };
  }
  _fishRowsBuilt = true;
}

function changeFish(t, action) {
  const baseline = { ...((latestSnapshot && latestSnapshot.counts) || {}) };
  sendControl(
    { type: 'fish', action, fishType: t, count: 1 },
    `${action === 'add' ? 'Added' : 'Removed'} ${FISH_TYPE_NAMES[t]} ✓`,
    { label: `${action === 'add' ? '+1' : '−1'} ${FISH_TYPE_NAMES[t]}`, baseline }
  );
}

function renderControls(snap) {
  if (!snap) { els.controls.hidden = true; return; }
  els.controls.hidden = false;
  const now = Date.now();

  // Weather: value -1 (auto) when not overridden, else the forced condition.
  const w = snap.weather || {};
  const wv = w.override ? (w.condition | 0) : -1;
  if (document.activeElement !== els.ctrlWeather && now - _ctrlHold.weather > CTRL_HOLD_MS) {
    els.ctrlWeather.value = String(wv);
  }

  // Timescale slider (1–5×). Don't fight the user while they're dragging or just set it.
  if (now - _ctrlHold.time > CTRL_HOLD_MS && document.activeElement !== els.ctrlTime) {
    const scale = Math.max(1, Math.min(5, (snap.time && snap.time.scale) || 1));
    els.ctrlTime.value = String(scale);
    if (els.ctrlTimeVal) els.ctrlTimeVal.textContent = scale + '×';
  }

  // Fish counts + cap-aware enabling.
  if (!_fishRowsBuilt) buildFishControls();
  const counts = snap.counts || {};
  for (let t = 0; t < 5; t++) {
    const c = counts[FISH_COUNT_KEYS[t]] || 0;
    fishCountEls[t].textContent = `${c}/${FISH_MAX[t]}`;
    fishBtns[t].minus.disabled = c <= 0;
    fishBtns[t].plus.disabled = c >= FISH_MAX[t];
  }
}

els.ctrlWeather.addEventListener('change', () => {
  _ctrlHold.weather = Date.now();
  const wv = parseInt(els.ctrlWeather.value, 10);
  const wLabel = wv === -1 ? 'Auto' : (WEATHER_NAMES[wv] || String(wv));
  sendControl({ type: 'weather', value: wv }, 'Weather set ✓', { label: `Weather: ${wLabel}` });
});
// Live label while dragging; commit the directive on release (change).
els.ctrlTime.addEventListener('input', () => {
  _ctrlHold.time = Date.now();
  if (els.ctrlTimeVal) els.ctrlTimeVal.textContent = els.ctrlTime.value + '×';
});
els.ctrlTime.addEventListener('change', () => {
  _ctrlHold.time = Date.now();
  const v = parseInt(els.ctrlTime.value, 10) || 1;
  sendControl({ type: 'timescale', value: v }, `Timescale: ${v}× ✓`, { label: `Timescale: ${v}×` });
});
els.ctrlFeed.addEventListener('click', () =>
  sendControl({ type: 'feed', count: 1 }, 'Fed the fish 🐟', { label: 'Feed ×1' }));

// ─── Career game panel: HUD, mode toggle, shop ────────────────────────────────
let _shopBuilt = false;
let _pendingMode = null;

function renderGame(snap) {
  const g = snap && snap.game;
  if (!g) {                          // legacy device (no game) → free fish controls
    els.gamePanel.hidden = true;
    if (els.fishGroup) els.fishGroup.hidden = false;
    return;
  }
  els.gamePanel.hidden = false;
  const career = g.mode === 'career';
  els.hudMode.textContent = career ? 'Career' : 'Creative';
  els.hudMode.className = 'hud-mode' + (career ? '' : ' creative');
  els.hudCoins.innerHTML = '<span class="ci"></span> ' + (g.coins || 0);
  els.hudShells.textContent = '🐚 ' + (g.shells || 0);
  els.hudFood.textContent = '🍤 ' + (g.food || 0);
  els.hudSnails.textContent = '🐌 ' + ((snap.snails && snap.snails.length) || 0);
  els.hudLuck.textContent = '🍀 ' + Math.round((g.luck || 0) * 100) + '%';
  // Meals fed today (target 3). Turns into a pulsing warning while the fish are hungry.
  const meals = g.meals || 3, fed = g.fed || 0, hungry = g.hungry === 1 || g.hungry === true;
  els.hudMeals.textContent = (hungry ? '🍴 ' : '🍽️ ') + fed + '/' + meals;
  els.hudMeals.classList.toggle('hungry', hungry);
  els.hudMeals.title = hungry
    ? 'Fish are hungry — feed them! (3 meals/day keeps them healthy)'
    : 'Meals fed today' + (g.overfed ? ` · overfed ${g.overfed}× (hurts quality)` : '');
  for (const el of [els.hudCoins, els.hudShells, els.hudFood, els.hudSnails, els.hudLuck, els.hudMeals])
    el.style.display = career ? '' : 'none';

  for (const b of els.modeSeg.querySelectorAll('button'))
    b.classList.toggle('active', b.dataset.mode === g.mode);

  // Career: fish are earned (shop + catching) → hide the free fish ± controls.
  if (els.fishGroup) els.fishGroup.hidden = career;
  els.shop.hidden = !career;
  if (career) updateShop(snap);
  els.ctrlFeed.textContent = career ? '🍤 Feed (uses 1 food)' : '🍤 Feed the fish';
}

function buildShop() {
  els.shopFish.innerHTML = '';
  for (let t = 0; t < 5; t++) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'shop-buy'; b.dataset.type = String(t);
    b.innerHTML = `<span>🐟 ${escapeHtml(FISH_TYPE_NAMES[t])}</span><span class="price">${FISH_PRICE[t]} <span class="ci"></span></span>`;
    b.addEventListener('click', () => buyFish(t));
    els.shopFish.appendChild(b);
  }
  _shopBuilt = true;
}

function updateShop(snap) {
  if (!_shopBuilt) buildShop();
  const coins = (snap.game && snap.game.coins) || 0;
  const c = snap.counts || {};
  for (const b of els.shopFish.querySelectorAll('button')) {
    const t = Number(b.dataset.type);
    const atCap = (c[FISH_COUNT_KEYS[t]] || 0) >= FISH_MAX[t];
    b.disabled = coins < FISH_PRICE[t] || atCap;
    b.title = atCap ? `${FISH_TYPE_NAMES[t]} at capacity` : `Buy a ${FISH_TYPE_NAMES[t]} for ${FISH_PRICE[t]} coins`;
  }
  els.shopFood.disabled = coins < FOOD_PRICE;
  const snailsAtCap = ((snap.snails && snap.snails.length) || 0) >= MAX_SNAILS;
  els.shopSnail.disabled = coins < SNAIL_PRICE || snailsAtCap;
  els.shopSnail.title = snailsAtCap ? 'Snails at capacity' : `Buy a coin-collector snail for ${SNAIL_PRICE} coins`;
}

function buyFish(t) {
  sendControl({ type: 'buy', what: 'fish', fishType: t, count: 1 },
    `Bought ${FISH_TYPE_NAMES[t]} ✓`, { label: `Buy ${FISH_TYPE_NAMES[t]}` });
}
els.shopFood.addEventListener('click', () =>
  sendControl({ type: 'buy', what: 'food', count: 1 }, 'Bought food ✓', { label: 'Buy food' }));
els.shopSnail.addEventListener('click', () =>
  sendControl({ type: 'buy', what: 'snail', count: 1 }, 'Bought a snail 🐌', { label: 'Buy snail' }));

// Mode switch: clicking the inactive mode opens an inline confirm bar.
els.modeSeg.addEventListener('click', (e) => {
  const btn = e.target.closest('button'); if (!btn) return;
  const target = btn.dataset.mode;
  const cur = (latestSnapshot && latestSnapshot.game && latestSnapshot.game.mode) || 'career';
  if (target === cur) return;
  _pendingMode = target;
  els.modeConfirmTitle.textContent = target === 'career' ? 'Start a Career?' : 'Switch to Creative?';
  els.modeConfirmDetail.textContent = target === 'career'
    ? ' This RESETS the tank to a fresh 2-fish career — coins, shells, food and your current fish are cleared.'
    : ' Keeps your current fish and unlocks the free fish controls. Earning pauses.';
  els.modeConfirm.hidden = false;
});
els.modeConfirmCancel.addEventListener('click', () => { _pendingMode = null; els.modeConfirm.hidden = true; });
els.modeConfirmOk.addEventListener('click', () => {
  if (_pendingMode) {
    sendControl({ type: 'mode', value: _pendingMode }, `Switching to ${_pendingMode} ✓`, { label: `Mode → ${_pendingMode}` });
  }
  _pendingMode = null; els.modeConfirm.hidden = true;
});

// ─── Canvas hit-testing ───────────────────────────────────────────────────────
// Rebuilt every drawn frame from the displayed snapshot so hover/click matches
// exactly what's on screen (fish are perspective-projected; loot/snails aren't).
function buildHitTargets(s) {
  const targets = [];
  if (Array.isArray(s.fish)) {
    for (const f of s.fish) {
      const z = f.z || 0;
      targets.push({ key: 'fish:' + f.id, kind: 'fish', ref: f,
        x: projX(f.x, z), y: projY(f.y, z), r: Math.max(fishHW(f), 9) + 8 });
    }
  }
  if (s.snail) targets.push(snailTarget(s.snail, 'snail:decor', 'wild'));
  if (Array.isArray(s.snails))
    s.snails.forEach((sn, i) => targets.push(snailTarget(sn, 'snail:' + i, 'collector')));
  if (Array.isArray(s.loot))
    for (const it of s.loot)
      targets.push({ key: 'loot:' + it.id, kind: 'loot', ref: it, x: it.x, y: it.y, r: 15 });
  if (Array.isArray(s.wanderers))
    for (const w of s.wanderers)
      targets.push({ key: 'wanderer:' + w.id, kind: 'wanderer', ref: w, x: w.x, y: w.y, r: 22 });
  hitTargets = targets;
}
function snailTarget(sn, key, role) {
  const bx = Math.round(sn.x), by = terrainY[clamp(bx, 0, SCREEN_W - 1)];
  return { key, kind: 'snail', ref: sn, role, x: bx, y: by - 8, r: 18 };
}

// Nearest target whose radius the point falls inside (screen-space coords).
function pickTarget(x, y) {
  let best = null, bestD = Infinity;
  for (const t of hitTargets) {
    const d = (t.x - x) ** 2 + (t.y - y) ** 2;
    if (d <= t.r * t.r && d < bestD) { bestD = d; best = t; }
  }
  return best;
}
function eventToScreen(e) {
  const rect = els.canvas.getBoundingClientRect();
  return { x: (e.clientX - rect.left) / rect.width * SCREEN_W,
           y: (e.clientY - rect.top) / rect.height * SCREEN_H };
}

// ─── Hover: highlight + dungeon-crawler tooltip + action-aware cursor ─────────
els.canvas.addEventListener('mousemove', (e) => {
  const p = eventToScreen(e);
  const t = pickTarget(p.x, p.y);
  hoveredKey = t ? t.key : null;
  els.canvas.style.cursor = t ? 'pointer' : 'default';
  if (t) showTooltip(t, e.clientX, e.clientY); else hideTooltip();
});
els.canvas.addEventListener('mouseleave', () => {
  hoveredKey = null;
  els.canvas.style.cursor = 'default';
  hideTooltip();
});

// Nudge nearby fish toward a canvas point (local effect — resets on next snapshot).
// Modifies tx/ty on latestSnapshot.fish so the extrapolation engine picks it up.
function herdFishToward(tx, ty) {
  if (!latestSnapshot || !Array.isArray(latestSnapshot.fish)) return;
  const HERD_RADIUS = 240;
  for (const f of latestSnapshot.fish) {
    const z = f.z || 0;
    const dx = projX(f.x, z) - tx, dy = projY(f.y, z) - ty;
    if (dx * dx + dy * dy > HERD_RADIUS * HERD_RADIUS) continue;
    // Spread targets slightly so fish don't pile on the same point.
    const spread = 35 + (f.id % 3) * 10;
    const ang = (f.id * 1.618) % (Math.PI * 2);
    f.tx = clamp(tx + Math.cos(ang) * spread, 30, SCREEN_W - 30);
    f.ty = clamp(ty + Math.sin(ang) * spread * 0.6, TANK_TOP + 20, SCREEN_H - 80);
    // Give an initial velocity boost toward the target.
    const ddx = f.tx - f.x, ddy = f.ty - f.y, d = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
    f.vx = (ddx / d) * 2.5; f.vy = (ddy / d) * 1.2;
  }
}

// ─── Click: fish/snail → open profile; loot/wanderer → collect/catch ──────────
els.canvas.addEventListener('click', (e) => {
  if (!latestSnapshot) return;
  const p = eventToScreen(e);
  spawnPulse(p.x, p.y, 'tap');     // glass-tap ripple wherever you click
  const t = pickTarget(p.x, p.y);
  if (!t) {
    closeProfile();
    // Herd fish toward the tap if clicking inside the water area.
    if (p.y > TANK_TOP) herdFishToward(p.x, p.y);
    return;
  }
  if (t.kind === 'fish' || t.kind === 'snail') { openProfile(t); return; }

  const best = t.ref;
  const pcol = t.kind === 'wanderer' ? '#88e0ff'
    : (best.kind === 'coin' ? '#ffd23f'
      : (['#e7c9a0', '#ff9ec4', '#ffd23f'][best.tier || 0] || '#e7c9a0'));
  spawnPulse(t.x, t.y, 'collect', pcol);   // celebratory burst on obtaining it
  sendControl({ type: 'catch', itemId: best.id },
    t.kind === 'wanderer' ? 'Caught a fish! 🎣'
      : (best.kind === 'coin' ? 'Grabbed a coin!' : 'Grabbed a shell 🐚'));
  // Optimistic: remove locally so it vanishes at once; next snapshot reconciles.
  if (t.kind === 'wanderer')
    latestSnapshot.wanderers = (latestSnapshot.wanderers || []).filter((w) => w.id !== best.id);
  else
    latestSnapshot.loot = (latestSnapshot.loot || []).filter((it) => it.id !== best.id);
  hoveredKey = null;
  hideTooltip();
});

// ─── Tooltip content (one small card per entity kind) ─────────────────────────
function ttStat(icon, label, val) {
  return `<div class="tt-stat"><span class="tt-stat-l">${icon} ${label}</span>` +
         `<span class="tt-stat-v">${escapeHtml(String(val))}</span></div>`;
}
function ttTitle(name, color, shiny) {
  return `<div class="tt-name" style="color:${color}">${escapeHtml(name)}` +
         (shiny ? ' <span class="tt-shiny">✦ SHINY</span>' : '') + `</div>`;
}
function fishTooltipHTML(f) {
  const r = rarityOf(f), shiny = isShiny(f);
  const q = Math.round(fishLuck(f) * 100), size = Math.round(growth(f) * 100);
  return ttTitle(fishName(f), r.color, shiny) +
    `<div class="tt-sub" style="color:${r.color}">${r.name} ${escapeHtml(FISH_TYPE_NAMES[f.type] || 'Fish')}</div>` +
    `<div class="tt-bar"><div class="tt-bar-fill" style="width:${q}%;background:${r.color}"></div></div>` +
    `<div class="tt-stats">` +
      ttStat('🍀', 'Quality', q + '%') +
      ttStat('📐', 'Size', size + '%') +
      (typeof f.xp === 'number' ? ttStat('⭐', 'XP', f.xp) : '') +
      (f.ageMs ? ttStat('🎂', 'Age', formatAge(f.ageMs)) : '') +
    `</div>` +
    `<div class="tt-action">Click to view profile</div>`;
}
function snailTooltipHTML(t) {
  const collector = t.role === 'collector';
  return ttTitle(collector ? 'Collector Snail' : 'Pond Snail',
                 collector ? '#5fd75f' : '#b9c6d4', false) +
    `<div class="tt-sub">${collector ? 'Gathers coins from the sand' : 'A peaceful tank cleaner'}</div>` +
    `<div class="tt-action">Click to view profile</div>`;
}
function lootTooltipHTML(it) {
  if (it.kind === 'coin')
    return ttTitle('Gold Coin', '#ffd23f', false) +
      `<div class="tt-sub">Spend it in the shop</div>` +
      `<div class="tt-action grab">Click to collect <span class="ci"></span></div>`;
  const names = ['Common Shell', 'Pink Shell', 'Golden Shell'];
  const cols = ['#e7c9a0', '#ff9ec4', '#ffd23f'];
  const ti = it.tier || 0;
  return ttTitle(names[ti] || 'Shell', cols[ti] || '#e7c9a0', false) +
    `<div class="tt-sub">A shell for your collection</div>` +
    `<div class="tt-action grab">Click to collect 🐚</div>`;
}
function wandererTooltipHTML(w) {
  const r = rarityOf(w), shiny = isShiny(w);
  return ttTitle('Wild ' + (FISH_TYPE_NAMES[w.type] || 'Fish'), r.color, shiny) +
    `<div class="tt-sub" style="color:${r.color}">${r.name} · wandering by</div>` +
    `<div class="tt-action grab">Click to catch 🎣</div>`;
}
function tooltipHTML(t) {
  switch (t.kind) {
    case 'fish': return fishTooltipHTML(t.ref);
    case 'snail': return snailTooltipHTML(t);
    case 'loot': return lootTooltipHTML(t.ref);
    case 'wanderer': return wandererTooltipHTML(t.ref);
  }
  return '';
}
function showTooltip(t, cx, cy) {
  els.tooltip.innerHTML = tooltipHTML(t);
  els.tooltip.hidden = false;
  const pad = 12, w = els.tooltip.offsetWidth, h = els.tooltip.offsetHeight;
  let left = cx + 18, top = cy + 18;
  if (left + w + pad > window.innerWidth) left = cx - w - 18;
  if (top + h + pad > window.innerHeight) top = cy - h - 18;
  els.tooltip.style.left = Math.max(pad, left) + 'px';
  els.tooltip.style.top = Math.max(pad, top) + 'px';
}
function hideTooltip() { els.tooltip.hidden = true; }

// ─── Detailed profile panel (fish + snails) ───────────────────────────────────
function findEntityByKey(key) {
  if (!latestSnapshot || !key) return null;
  const sep = key.indexOf(':');
  const kind = key.slice(0, sep), id = key.slice(sep + 1);
  if (kind === 'fish') {
    const ref = (latestSnapshot.fish || []).find((f) => 'fish:' + f.id === key);
    return ref ? { kind, ref } : null;
  }
  if (kind === 'snail') {
    if (id === 'decor') return latestSnapshot.snail ? { kind, ref: latestSnapshot.snail, role: 'wild' } : null;
    const ref = (latestSnapshot.snails || [])[Number(id)];
    return ref ? { kind, ref, role: 'collector' } : null;
  }
  return null;
}
function openProfile(t) {
  profileKey = t.key;
  if (t.kind === 'fish') highlightedFishId = t.ref.id;
  hideTooltip();
  renderProfile();
  els.profile.hidden = false;
}
function closeProfile() {
  if (!profileKey) return;
  if (profileKey.indexOf('fish:') === 0) highlightedFishId = null;
  profileKey = null;
  els.profile.hidden = true;
}
async function sellFish(fishId) {
  const snap = latestSnapshot;
  const f = snap && snap.fish && snap.fish.find((x) => x.id === fishId);
  if (!f) return;
  const val = fishSellValue(f);
  if (!(await confirmDialog('Sell fish?', `Sell ${fishName(f)} for ${val} coins?`, { okLabel: 'Sell' }))) return;
  closeProfile();
  await sendControl({ type: 'sell', fishId }, `Sold ${fishName(f)} for ${val} coins`, { label: 'Sell fish' });
}
function pfStat(label, val) {
  return `<div class="pf-stat"><div class="pf-stat-l">${label}</div>` +
         `<div class="pf-stat-v">${escapeHtml(String(val))}</div></div>`;
}
function fishProfileHTML(f) {
  const r = rarityOf(f), shiny = isShiny(f);
  const q = Math.round(fishLuck(f) * 100), size = Math.round(growth(f) * 100);
  const col = fishColorHex(f);
  const inCareer = latestSnapshot && latestSnapshot.game && latestSnapshot.game.mode === 'career';
  const sellVal = inCareer ? fishSellValue(f) : 0;
  return `
    <div class="pf-head">
      <div class="pf-chip${shiny ? ' shiny' : ''}" style="--chip:${col}"></div>
      <div class="pf-head-text">
        <div class="pf-name-row">
          <input class="pf-name" maxlength="24" spellcheck="false" aria-label="Fish name"
            placeholder="${escapeHtml(FISH_TYPE_NAMES[f.type] || 'Fish')} #${f.id}"
            value="${escapeHtml(f.name || '')}" />
          <button type="button" class="pf-name-save" title="Save name">Save</button>
        </div>
        <div class="pf-rarity" style="color:${r.color}">${r.name} ${escapeHtml(FISH_TYPE_NAMES[f.type] || 'Fish')}${shiny ? ' · ✦ Shiny' : ''}</div>
      </div>
    </div>
    <div class="pf-rename-hint">✎ Edit the name above, then press Enter or Save.</div>
    <div class="pf-bar"><div class="pf-bar-fill" style="width:${q}%;background:${r.color}"></div></div>
    <div class="pf-grid">
      ${pfStat('Quality', q + '%')}
      ${pfStat('Size', size + '%')}
      ${pfStat('XP', f.xp != null ? f.xp : '—')}
      ${pfStat('Age', f.ageMs ? formatAge(f.ageMs) : '—')}
      ${pfStat('Type', FISH_TYPE_NAMES[f.type] || 'Fish')}
      ${pfStat('Colour', col.toUpperCase())}
    </div>
    ${shiny ? `<div class="pf-note">✦ A 1-in-${SHINY_ODDS} shiny — inverted colours and a glistening shimmer as it swims.</div>` : ''}
    ${inCareer ? `<div class="pf-sell-row">
      <button type="button" class="pf-sell-btn" data-fish-id="${f.id}">
        Sell for ${sellVal} <span class="ci"></span>
      </button>
    </div>` : ''}`;
}
// Wire the profile dialog's rename field: blur, Enter/Escape, and the Save button
// all persist via saveName(); the Save button briefly confirms.
function _wireProfileRename(input, fishId) {
  const saveBtn = els.profileBody.querySelector('.pf-name-save');
  const flash = () => {
    if (!saveBtn) return;
    saveBtn.textContent = 'Saved ✓';
    saveBtn.classList.add('ok');
    setTimeout(() => { saveBtn.textContent = 'Save'; saveBtn.classList.remove('ok'); }, 1400);
  };
  const commit = () => { saveName(fishId, input.value); flash(); };
  input.addEventListener('blur', () => saveName(fishId, input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); input.blur(); }
    if (e.key === 'Escape') { input.value = ''; input.blur(); }
  });
  if (saveBtn) saveBtn.addEventListener('click', commit);
}
function snailProfileHTML(ent) {
  const collector = ent.role === 'collector';
  return `
    <div class="pf-head">
      <div class="pf-chip" style="--chip:#ddb060"></div>
      <div class="pf-head-text">
        <div class="pf-name-static">${collector ? 'Collector Snail' : 'Pond Snail'}</div>
        <div class="pf-rarity" style="color:${collector ? '#5fd75f' : '#b9c6d4'}">${collector ? 'Uncommon · Helper' : 'Common · Critter'}</div>
      </div>
    </div>
    <div class="pf-desc">${collector
      ? 'Patrols the sea floor and automatically scoops up coins that fall near it, banking them straight to your tank.'
      : 'A gentle bottom-dweller that ambles along the substrate, grazing as it goes.'}</div>`;
}
function renderProfile() {
  if (!profileKey) return;
  // Don't clobber an in-progress rename when a fresh snapshot re-renders.
  if (els.profile.contains(document.activeElement) &&
      document.activeElement.classList.contains('pf-name')) return;
  const ent = findEntityByKey(profileKey);
  if (!ent || !ent.ref) { closeProfile(); return; }
  els.profileBody.innerHTML = ent.kind === 'fish' ? fishProfileHTML(ent.ref) : snailProfileHTML(ent);
  if (ent.kind === 'fish') {
    const input = els.profileBody.querySelector('.pf-name');
    if (input) _wireProfileRename(input, ent.ref.id);
    const sellBtn = els.profileBody.querySelector('.pf-sell-btn');
    if (sellBtn) sellBtn.addEventListener('click', () => sellFish(ent.ref.id));
  }
}
els.profileClose.addEventListener('click', closeProfile);
els.profile.addEventListener('click', (e) => { if (e.target === els.profile) closeProfile(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeProfile(); });

function drawTitle(s) {
  els.viewName.textContent = s._name || s.aquarium_id || selectedId || '—';
  const weather = s.weather ? (WEATHER_NAMES[s.weather.condition] || '') : '';
  els.viewSub.textContent = [s.platform, s.fw_version ? 'fw ' + s.fw_version : '', weather]
    .filter(Boolean)
    .join(' · ');
  const stale = s._stale || Date.now() - snapshotReceivedAt > 8000;
  els.viewDot.className = 'dot ' + (stale ? 'stale' : 'live');
}

function dayTint(progress) {
  // 0=midnight, 0.5=noon. Returns a 0..1 brightness factor.
  const p = typeof progress === 'number' ? progress : 0.5;
  return 0.25 + 0.75 * Math.sin(Math.PI * Math.min(Math.max(p, 0), 1));
}

function hex(rgb) {
  const n = (rgb >>> 0) & 0xffffff;
  return '#' + n.toString(16).padStart(6, '0');
}

function drawTank(s) {
  const top = (s.screen && s.screen.tank_top) || TANK_TOP;
  const bright = dayTint(s.time && s.time.day_progress);
  const cond = (s.weather && s.weather.condition) || 0;

  // Rebuild hover/click hit targets from the positions we're about to draw.
  buildHitTargets(s);

  drawSky(top, bright, cond, s);   // gradient + sun/moon + stars + clouds
  drawWater(top, bright);          // shimmering light bands
  drawBubbles(top);                // behind the sand bed → bubbles rise out of the substrate
  drawSand(bright);                // bumpy terrain bed
  if (s.boat && s.boat.active) drawBoat(s.boat.x, top); // behind the rim → sits slightly submerged
  drawRim(top, bright);            // metal frame + glass over the waterline (drawn over the boat)

  // Background plants (behind fish for depth — tall stems on the back glass)
  if (s.plants) drawBgPlants(s.plants, bright);

  drawEacZone(bright);             // background traffic silhouettes

  if (Array.isArray(s.fish)) {
    drawShadows(s.fish);
    // Far (deeper) fish first so nearer fish overlap them correctly.
    const ordered = s.fish.slice().sort((a, b) => (b.z || 0) - (a.z || 0));
    for (const f of ordered) drawFish(f);
  }

  // Foreground plants (seaweed + hornwort) drawn AFTER fish so fish swim behind
  // them, then BEFORE bottom-dwellers so snails/loot are in front of the vegetation.
  if (s.plants) {
    drawSeaweed(s.plants, bright);
    drawFgHornwort(s.plants, bright);
  }

  if (Array.isArray(s.flakes)) for (const f of s.flakes) drawFlake(f);
  if (s.snail) drawSnail(s.snail);
  if (Array.isArray(s.snails)) for (const sn of s.snails) drawSnail(sn, true); // purchased coin collectors
  if (s.starfish) drawStarfish(s.starfish);

  // Career collectibles, drawn on top so they're clearly visible + tappable.
  if (Array.isArray(s.loot)) for (const it of s.loot) drawLoot(it);
  if (Array.isArray(s.wanderers)) for (const w of s.wanderers) drawWanderer(w);
  drawFoodBubbles(s);              // "feed me" bubbles above hungry fish

  if (cond === 3 || cond === 4) drawRain(cond, bright);
  else if (cond === 5) drawSnow(bright);

  drawSelectionHighlights();       // hover glow + open-profile ring, drawn on top
  drawPulses();                    // tap ripples + collect bursts, topmost feedback
}

// Glow ring under the cursor-hovered entity, plus a steady ring on whatever
// entity's profile is currently open.
function drawSelectionHighlights() {
  const ring = (t, pulse) => {
    ctx.save();
    ctx.lineWidth = 2;
    ctx.strokeStyle = `rgba(120,230,255,${(0.4 + 0.45 * pulse).toFixed(2)})`;
    ctx.shadowColor = 'rgba(120,230,255,0.85)';
    ctx.shadowBlur = 10 * pulse + 4;
    ctx.beginPath();
    ctx.arc(t.x, t.y, t.r + 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  };
  if (profileKey && profileKey !== hoveredKey) {
    const t = hitTargets.find((h) => h.key === profileKey);
    if (t) ring(t, 1);
  }
  if (hoveredKey) {
    const t = hitTargets.find((h) => h.key === hoveredKey);
    if (t) ring(t, 0.5 + 0.5 * Math.sin(animTick * 0.18));
  }
}

// "Feed me" thought bubbles: spawned over a random fish while the tank is hungry
// (career), they drift up and fade. Advanced in device-frame units (animTick) so the
// cadence matches the firmware regardless of browser frame rate.
let foodBubbles = [];
let _bubbleCd = 0;
let _bubbleLastTick = 0;
const BUBBLE_SPAWN_CD = 1500;          // ~75s @20fps base interval; ×0.7–1.3 jitter (subtle, matches firmware)
function drawFoodBubbles(s) {
  const df = _bubbleLastTick ? clamp(animTick - _bubbleLastTick, 0, 5) : 1;
  _bubbleLastTick = animTick;
  const g = s && s.game;
  const hungry = !!g && g.mode === 'career' && (g.hungry === 1 || g.hungry === true);

  // Bubbles are bound to a fish id and re-anchored to its live position each frame, so
  // they ride along as the fish swims; `rise` only lifts the bubble a little above it.
  const fishById = new Map();
  if (Array.isArray(s.fish)) for (const f of s.fish) fishById.set(f.id, f);

  for (const b of foodBubbles) { b.rise += 0.4 * df; b.life -= df; }
  foodBubbles = foodBubbles.filter((b) => b.life > 0 && fishById.has(b.fishId));

  if (hungry && Array.isArray(s.fish) && s.fish.length) {
    _bubbleCd -= df;
    if (_bubbleCd <= 0) {
      const f = s.fish[Math.floor(Math.random() * s.fish.length)];
      foodBubbles.push({ fishId: f.id, rise: 0, life: 95, max: 95 });
      _bubbleCd = BUBBLE_SPAWN_CD * (0.7 + Math.random() * 0.6);   // subtle, jittered (matches firmware)
    }
  } else {
    _bubbleCd = 0;
  }

  for (const b of foodBubbles) {
    const f = fishById.get(b.fishId);
    if (!f) continue;
    const x = projX(f.x, f.z || 0);
    const y = projY(f.y, f.z || 0) - 24 - b.rise;
    const a = clamp(b.life / b.max, 0, 1);
    ctx.save();
    ctx.globalAlpha = 0.9 * a;
    ctx.fillStyle = '#f4fbff';
    ctx.strokeStyle = 'rgba(80,150,190,0.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.ellipse(x, y, 14, 11, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    // tail dots trail back down toward the fish so the bubble reads as attached
    ctx.beginPath(); ctx.arc(x - 10, y + 12, 2.4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.arc(x - 14, y + 16, 1.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.globalAlpha = a;
    ctx.font = '15px system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('🍴', x, y);
    ctx.restore();
  }
}

// Fish are the device's signature ASCII glyphs, perspective-projected by depth.
function drawFish(f) {
  const type = f.type || 0, z = f.z || 0;
  const sx = projX(f.x, z), sy = projY(f.y, z);
  const ts = fishTS(f);
  const fontPx = Math.max(6, Math.round(9 * ts * growth(f)));
  const shiny = isShiny(f);
  const col = fishColorHex(f);
  const hw = fishHW(f);

  if (f.id === highlightedFishId) {
    ctx.save();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.arc(sx, sy, hw + 10, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Angelfish dorsal + ventral fins (single chars, above/below the body).
  if (type === 3) {
    ctx.fillStyle = col;
    ctx.font = 'bold 9px "Courier New", monospace';
    ctx.fillText(f.facing_right ? '\\' : '/', sx, sy - fontPx * 0.7);
    ctx.fillText(f.facing_right ? '/' : '\\', sx, sy + fontPx * 0.7);
  }

  const glyph = type === 0
    ? (f.facing_right ? '><(o>' : '<o(><')
    : (f.facing_right ? '><>' : '<><');
  ctx.font = `bold ${fontPx}px "Courier New", monospace`;
  // Dark outline keeps bright fish legible over the busy water/plants.
  ctx.lineWidth = Math.max(1, fontPx * 0.12);
  ctx.strokeStyle = 'rgba(0,18,34,0.55)';
  ctx.strokeText(glyph, sx, sy);
  ctx.fillStyle = col;
  ctx.fillText(glyph, sx, sy);

  // Shiny fish glisten: a pulsing white sheen over the body + twinkling sparkles.
  if (shiny) {
    const sheen = 0.16 + 0.24 * (0.5 + 0.5 * Math.sin(animTick * 0.30 + f.id));
    ctx.save();
    ctx.globalAlpha = sheen;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(glyph, sx, sy);
    ctx.restore();
    drawShinyGlints(sx, sy, hw, fontPx, f.id);
  }

  if (f.going_for_food) {
    ctx.fillStyle = '#ffee44';
    ctx.beginPath();
    ctx.arc(sx + hw * 0.5, sy - fontPx * 0.5, 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  if (f.name) {
    ctx.save();
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = f.id === highlightedFishId ? '#ffffff' : rarityOf(f).color;
    ctx.fillText(f.name, sx, sy - fontPx * 0.8 - 6);
    ctx.restore();
  }
}

// Twinkling cross-sparkles orbiting a shiny fish — phased per-fish off animTick.
function drawShinyGlints(sx, sy, hw, fontPx, id) {
  const n = 3;
  ctx.save();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1;
  for (let i = 0; i < n; i++) {
    const ph = animTick * 0.18 + id * 1.3 + i * (Math.PI * 2 / n);
    const tw = Math.sin(ph);
    if (tw <= 0) continue;
    const a = tw * tw;
    const ang = ph * 0.7 + i * 2.1;
    const rad = hw * 0.6 + 5;
    const gx = sx + Math.cos(ang) * rad;
    const gy = sy + Math.sin(ang) * rad * 0.6 - fontPx * 0.15;
    const sz = 1.5 + 2.5 * a;
    ctx.globalAlpha = 0.85 * a;
    ctx.beginPath();
    ctx.moveTo(gx - sz, gy); ctx.lineTo(gx + sz, gy);
    ctx.moveTo(gx, gy - sz); ctx.lineTo(gx, gy + sz);
    ctx.stroke();
  }
  ctx.restore();
}

// Multiply a #rrggbb color by a 0..1 brightness factor.
function shade(hexColor, factor) {
  const n = parseInt(hexColor.slice(1), 16);
  const r = Math.round(((n >> 16) & 0xff) * factor);
  const g = Math.round(((n >> 8) & 0xff) * factor);
  const b = Math.round((n & 0xff) * factor);
  return `rgb(${r},${g},${b})`;
}

function drawStats(s) {
  const c = s.counts || {};
  const weather = s.weather ? (WEATHER_NAMES[s.weather.condition] || '?') : '—';
  const dp = s.time && typeof s.time.day_progress === 'number' ? s.time.day_progress : null;
  const clock = dp == null ? '—' : formatClock(dp);
  const lastSeen = s._lastSeenMs ? timeAgo(s._lastSeenMs) : (s._stale ? 'stale' : 'live');

  const cards = [
    ['Weather', weather, s.weather && s.weather.override ? 'manual override' : 'auto'],
    ['Time of day', clock, (s.time && s.time.mode) || ''],
    ['Fish', String((c.pair || 0) + (c.school || 0) + (c.school2 || 0) + (c.angel || 0) + (c.salmon || 0)), ''],
    ['Platform', s.platform || '—', s.fw_version ? 'fw ' + s.fw_version : ''],
    ['Uptime', s.uptime_ms != null ? formatDuration(s.uptime_ms) : '—', ''],
    ['Last seen', lastSeen, s._stale ? '⚠ stale' : ''],
  ];
  els.stats.innerHTML = cards
    .map(
      ([label, value, sub]) =>
        `<div class="stat"><div class="label">${label}</div><div class="value">${escapeHtml(String(value))}</div><div class="sub">${escapeHtml(sub || '')}</div></div>`
    )
    .join('');
}

function formatClock(progress) {
  const totalMin = Math.round(progress * 24 * 60);
  const hh = Math.floor(totalMin / 60) % 24;
  const mm = totalMin % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

function timeAgo(ts) {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 5) return 'just now';
  if (sec < 60) return sec + 's ago';
  return Math.floor(sec / 60) + 'm ago';
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// ─── Traffic monitor ─────────────────────────────────────────────────────────
let trafficZip = localStorage.getItem('traffic_zip') || '';
let trafficTimer = null;

const zipInput = document.getElementById('zip-input');
const zipGo = document.getElementById('zip-go');
const trafficStatus = document.getElementById('traffic-status');

if (trafficZip) zipInput.value = trafficZip;

function congestionLabel(c) {
  if (c < 0.15) return 'Free flow';
  if (c < 0.35) return 'Light';
  if (c < 0.55) return 'Moderate';
  if (c < 0.75) return 'Heavy';
  return 'Gridlock';
}

function congestionColor(c) {
  if (c < 0.25) return '#36d36b';
  if (c < 0.5)  return '#f0c040';
  if (c < 0.75) return '#f07830';
  return '#e03030';
}

async function fetchTraffic(zip) {
  trafficStatus.textContent = `Fetching traffic for ${zip}…`;
  trafficStatus.className = 'traffic-status hint';
  try {
    const res = await fetch('api/traffic?zip=' + encodeURIComponent(zip));
    const data = await res.json();
    if (!data.ok) {
      trafficStatus.textContent = `Error: ${data.error}`;
      return;
    }
    updateEacCount(data.congestion);
    const pct = Math.round(data.congestion * 100);
    const label = congestionLabel(data.congestion);
    const color = congestionColor(data.congestion);
    trafficStatus.className = 'traffic-status';
    trafficStatus.innerHTML =
      `<strong style="color:${color}">${label}</strong> &mdash; ${pct}% congested<br>` +
      `<span style="font-size:12px;color:var(--muted)">${data.speed} / ${data.freeFlow} MPH &nbsp;·&nbsp; ZIP ${zip}</span>` +
      `<div class="traffic-bar-wrap"><div class="traffic-bar" style="width:${pct}%;background:${color}"></div></div>`;
  } catch {
    trafficStatus.textContent = 'Could not reach traffic API.';
  }
}

function startTrafficPolling(zip) {
  if (trafficTimer) clearInterval(trafficTimer);
  fetchTraffic(zip);
  trafficTimer = setInterval(() => fetchTraffic(zip), 60_000);
}

function applyZip() {
  const zip = zipInput.value.trim();
  if (!/^\d{5}$/.test(zip)) {
    trafficStatus.textContent = 'Enter a valid 5-digit ZIP code.';
    return;
  }
  trafficZip = zip;
  localStorage.setItem('traffic_zip', zip);
  startTrafficPolling(zip);
}

zipGo.addEventListener('click', applyZip);
zipInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyZip(); });

if (trafficZip) startTrafficPolling(trafficZip);

// ─── Boot ────────────────────────────────────────────────────────────────────
// Back/forward or a manually edited hash switches the viewed aquarium.
window.addEventListener('hashchange', () => {
  const id = routeId();
  if (id && id !== selectedId) select(id);
});
if (els.newAquarium) els.newAquarium.addEventListener('click', createAquarium);
refreshList(); // first load honours the hash via renderList's default selection
setInterval(refreshList, 5000);
startWatchdog();

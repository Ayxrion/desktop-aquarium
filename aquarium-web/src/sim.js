'use strict';

// Instance-based aquarium device simulator — the same Career game loop the physical
// Pi/ESP run and that scripts/mock-publisher.js publishes over HTTP, refactored so the
// server can run MANY of them in-process (one per virtual device). Each createSim()
// owns its own state; step() advances ~1s of simulation and returns a telemetry
// snapshot (identical shape to a real device's POST body); applyDirectives() consumes
// the same `!`-control lines the device honors. restoreFrom() reseeds state from a
// persisted snapshot so a virtual device resumes (not resets) across a server restart.
//
// Keep this in sync with scripts/mock-publisher.js and the firmware (main.cpp /
// aquarium.ino) — the economy constants, school sizes and directive verbs must match.

const W = 800, H = 480, TOP = 72;
const FISH_MAX = [8, 16, 20, 12, 16];       // clownfish, guppy, piranha, angel, salmon
const FISH_SCHOOL_SIZE = [2, 6, 4, 0, 0];   // max school size before splitting; 0 = solitary

// Canonical fish colouring — byte-for-byte identical to the device (aquarium-pi
// main.cpp syncedFishColor / app.js fishColorInt): each type has a primary hue, a
// fish's luck (0..1) tints it toward warm gold, and a 1-in-1000 id roll inverts it
// ("shiny"). Computed at snapshot time from current luck and emitted as `color`, so
// the dashboard renders the device's colour verbatim (no recompute drift).
const FISH_PRIMARY = [0x2E8BFF, 0x33D17A, 0xFF7A33, 0xB45CFF, 0xFF9E7A];
const LUCK_TINT_COLOR = 0xFFE14D, LUCK_TINT_STRENGTH = 0.7, SHINY_ODDS = 1000;
function lerpColor888(a, b, t) {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  return ((Math.round(ar + (br - ar) * t) << 16) |
          (Math.round(ag + (bg - ag) * t) << 8) |
           Math.round(ab + (bb - ab) * t)) >>> 0;
}
function hash32(n) {
  n = (n | 0) ^ 0x9e3779b9;
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  return (n ^ (n >>> 16)) >>> 0;
}
function syncedFishColor(type, luck, id) {
  if (type < 0 || type > 4) type = 1;
  let c = lerpColor888(FISH_PRIMARY[type], LUCK_TINT_COLOR, (luck || 0) * LUCK_TINT_STRENGTH);
  if (hash32((id | 0) ^ 0x5bd1e995) % SHINY_ODDS === 0) c = (~c) & 0xffffff;
  return c >>> 0;
}

const FRAME_MS = 50;
const FRAMES_PER_PUBLISH = 1000 / FRAME_MS; // 20 frames per 1Hz publish
const DAMP = 0.85;

const GROW_FRAMES = 3600;
// One in-tank "day" in sim frames. At timescale 1 (20 fps) this is a 20-minute day,
// matching the firmware's FAST cycle (_FAST_CYCLE_MS = 20*60*1000 in aquarium-pi/
// aquarium daynight.h). The day clock is tick-based so a higher timescale advances it
// (and every other property) proportionally faster.
const DAY_FRAMES = 24000;
// One weather condition lasts this many sim frames before rotating. At 20 fps this is
// 5 minutes, matching the firmware's _WEATHER_INTERVAL (5*60*1000 in weather.h).
const WEATHER_FRAMES = 6000;
const COIN_BASE_CD = 3000;
const SHELL_BASE_CD = 2600;
const WANDER_BASE_CD = 7000;
const COIN_GRAV = 0.1;
const COIN_MAX_VY = 1.4;
const COIN_REST = 480;
const SHELL_TTL = 220;
const SAND_Y = H - 20;
const FISH_PRICE     = [10, 30, 45, 60, 8];
const FISH_BASE_SELL = [6, 3, 22, 30, 4];
const FOOD_PRICE = 5;
const SNAIL_PRICE = 50;
const MAX_SNAILS = 6;
const SNAIL_REACH = 36;
const SHELL_VALUE = [2, 5, 12];

const MEALS_PER_DAY = 3;
const HUNGER_GRACE = 0.35;
const FEED_PERFECT_BONUS = 0.08;
const FEED_MISS_PENALTY = 0.05;
const FEED_OVERFEED_PENALTY = 0.03;
const FEED_DELTA_MIN = -0.20, FEED_DELTA_MAX = 0.08;

function bound(v, lo, hi) {
  if (v < lo) return (lo - v) * 0.30;
  if (v > hi) return (hi - v) * 0.30;
  return 0;
}
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const rnd = (a, b) => a + Math.random() * (b - a);

function scaleOf(age) {
  return clamp(0.22 + 0.78 * Math.min(1, (age || 0) / GROW_FRAMES), 0.22, 1.0);
}

// ── Factory ─────────────────────────────────────────────────────────────────────
function createSim(opts) {
  opts = opts || {};
  const aquariumId = opts.aquariumId || 'web-tank';

  // Per-instance state
  let nextId = 0, nextItemId = 1;
  let mode = 'career';
  let coins = 0, shells = 0, food = 0;
  let fish = [], wanderers = [], loot = [], snails = [];
  let weatherOverride = -1;
  let timeMode = 'FAST';
  let timescale = 1;             // 1..5 — how many sim-seconds advance per ~1s tick (all properties)
  const coinTimers = new Map();
  let shellCD = SHELL_BASE_CD, wanderCD = WANDER_BASE_CD;
  let mealFed = [false, false, false];
  let mealsToday = 0, overfeedToday = 0, lastMealSlot = 0;
  let feedSchedInit = false, tankHungry = false;
  let tick = 0;
  const startMs = Date.now();

  const plants = {
    bg: [60, 150, 240, 620, 720].map((x) => ({ x, segs: 6 + (x % 4), type: x % 2 })),
    weeds: [120, 400, 560].map((x) => ({ x, segs: 6 })),
    hornwort: [300, 680].map((x) => ({ x, segs: 5 })),
  };

  function makeFish(type, x, y) {
    return {
      id: nextId++, type,
      x: x ?? rnd(40, W - 40), y: y ?? rnd(TOP + 30, H - 90), z: Math.random() * 0.6,
      vx: 0, vy: 0,
      tx: rnd(40, W - 40), ty: rnd(TOP + 30, H - 90),
      wanderCD: Math.floor(rnd(10, 50)),
      facing_right: Math.random() > 0.5,
      going_for_food: false, chasing: false,
      age: 0, xp: 0, fishLuck: parseFloat(rnd(0, 0.85).toFixed(3)),
    };
  }
  function addSnail() {
    if (snails.length >= MAX_SNAILS) return false;
    snails.push({ x: rnd(80, W - 80), spd: rnd(1.5, 2.5), facing_right: Math.random() > 0.5 });
    return true;
  }
  function resetCareer() {
    fish = [makeFish(4, 200, 220), makeFish(4, 360, 240)]; // start with 2 salmon
    wanderers = []; loot = []; snails = [];
    coins = 0; shells = 0; food = 10;          // career starts stocked with 10 food
    coinTimers.clear();
    mealFed = [false, false, false];
    mealsToday = 0; overfeedToday = 0; feedSchedInit = false; tankHungry = false;
  }

  // Tick-based so the day cycle scales with the timescale (not wall-clock).
  function dayProgress() { return (tick / DAY_FRAMES) % 1; }
  function currentMealSlot() { return clamp(Math.floor(dayProgress() * MEALS_PER_DAY), 0, MEALS_PER_DAY - 1); }
  function evaluateFeedingDay() {
    const missed = mealFed.filter((m) => !m).length;
    let delta = (missed === 0 && overfeedToday === 0)
      ? FEED_PERFECT_BONUS
      : -(FEED_MISS_PENALTY * missed) - (FEED_OVERFEED_PENALTY * overfeedToday);
    delta = clamp(delta, FEED_DELTA_MIN, FEED_DELTA_MAX);
    for (const f of fish) f.fishLuck = clamp((f.fishLuck || 0) + delta, 0, 1);
  }
  function resetFeedingDay() { mealFed = [false, false, false]; mealsToday = 0; overfeedToday = 0; }
  function registerFeeding() {
    const s = currentMealSlot();
    if (!mealFed[s]) { mealFed[s] = true; mealsToday++; } else { overfeedToday++; }
    tankHungry = false;
  }
  function updateFeedingSchedule() {
    const s = currentMealSlot();
    if (!feedSchedInit) { lastMealSlot = s; feedSchedInit = true; }
    if (s !== lastMealSlot) {
      if (s < lastMealSlot) { evaluateFeedingDay(); resetFeedingDay(); }
      lastMealSlot = s;
    }
    const frac = dayProgress() * MEALS_PER_DAY - s;
    tankHungry = !mealFed[s] && frac > HUNGER_GRACE;
  }

  function tankLuck() {
    if (!fish.length) return 0;
    return fish.reduce((s, f) => s + (f.fishLuck || 0), 0) / fish.length;
  }
  function counts() {
    const c = { pair: 0, school: 0, school2: 0, angel: 0, salmon: 0 };
    const key = ['pair', 'school', 'school2', 'angel', 'salmon'];
    for (const f of fish) c[key[f.type]]++;
    return c;
  }
  function addFish(type) {
    const c = counts();
    const have = [c.pair, c.school, c.school2, c.angel, c.salmon][type];
    if (have == null || have >= FISH_MAX[type]) return false;
    fish.push(makeFish(type));
    return true;
  }
  function removeFish(type) {
    for (let i = fish.length - 1; i >= 0; i--) {
      if (fish[i].type === type) { fish.splice(i, 1); return true; }
    }
    return false;
  }
  function fishSellValue(f) {
    const base = FISH_BASE_SELL[f.type] || 6;
    return base + Math.round(base * scaleOf(f.age)) + Math.round((f.fishLuck || 0) * 15)
         + Math.min(Math.floor((f.xp || 0) / 100), 8) + (f.shiny ? 12 : 0);
  }

  function stepPhysics() {
    for (let frame = 0; frame < FRAMES_PER_PUBLISH; frame++) {
      tick++;
      const cent = {};
      const order = [0, 0, 0, 0, 0];
      for (const f of fish) {
        const sz = FISH_SCHOOL_SIZE[f.type] || 0;
        f._sub = sz >= 2 ? Math.floor(order[f.type] / sz) : 0;
        order[f.type]++;
        const k = f.type + ':' + f._sub;
        const c = cent[k] || (cent[k] = { x: 0, y: 0, n: 0 });
        c.x += f.x; c.y += f.y; c.n++;
      }
      for (const k in cent) { const c = cent[k]; c.x /= c.n; c.y /= c.n; }
      for (const f of fish) {
        const t = f.type;
        f.age += 1;
        f.wanderCD--;
        if (f.wanderCD <= 0) {
          if (t === 0) {
            f.chasing = !f.chasing;
            f.wanderCD = f.chasing ? 30 + Math.random() * 40 : 40 + Math.random() * 50;
          } else if (t === 3) { f.wanderCD = 8 + Math.random() * 20; }
          else { f.wanderCD = 15 + Math.random() * 35; }
          if (t === 4) {                       // salmon: solitary — roam the tank independently
            f.tx = rnd(30, W - 30);
            f.ty = rnd(TOP + 20, H - 80);
          } else {
            const cg = cent[t + ':' + f._sub];
            const spread = t === 3 ? 120 : t === 0 ? 0 : 160;
            f.tx = clamp(cg.x + (Math.random() * 2 - 1) * spread, 30, W - 30);
            f.ty = clamp(cg.y + (Math.random() * 2 - 1) * (t === 3 ? 110 : 90), TOP + 20, H - 80);
          }
        }
        const chasing = t === 0 && f.chasing;
        const seekStr = chasing ? 0.018 : (t === 3 ? 0.020 : 0.012);
        const maxV = chasing || t === 3 ? 7.0 : 5.5;
        let ax = (f.tx - f.x) * seekStr;
        let ay = (f.ty - f.y) * seekStr;
        const grp = cent[t + ':' + f._sub];
        if (t === 1 || t === 2) {
          ax += (grp.x - f.x) * 0.010; ay += (grp.y - f.y) * 0.007;
          for (const o of fish) {
            if (o === f || o.type !== t || o._sub !== f._sub) continue;
            const dx = f.x - o.x, dy = f.y - o.y, d2 = dx * dx + dy * dy;
            if (d2 < 80 * 80 && d2 > 0.01) { const inv = 8 / d2; ax += dx * inv; ay += dy * inv; }
          }
        } else if (t === 3) {
          ax += (grp.x - f.x) * 0.012; ay += (grp.y - f.y) * 0.010;
          for (const o of fish) {
            if (o === f || o.type !== t) continue;
            const dx = f.x - o.x, dy = f.y - o.y, d2 = dx * dx + dy * dy;
            if (d2 < 60 * 60 && d2 > 0.01) { const inv = 7 / d2; ax += dx * inv; ay += dy * inv; }
          }
        }
        ax += bound(f.x, 30, W - 30);
        ay += bound(f.y, TOP + 20, H - 80);
        f.vx = Math.max(-maxV, Math.min(maxV, f.vx + ax)) * DAMP;
        f.vy = Math.max(-maxV * 0.5, Math.min(maxV * 0.5, f.vy + ay)) * DAMP;
        f.x = Math.max(5, Math.min(W - 5, f.x + f.vx));
        f.y = Math.max(TOP + 5, Math.min(H - 60, f.y + f.vy));
        if (Math.abs(f.vx) > 0.4) f.facing_right = f.vx > 0;
      }
    }
  }

  function stepCareer() {
    if (mode !== 'career') { wanderers = []; loot = []; return; }
    updateFeedingSchedule();
    const luck = tankLuck();
    const dt = FRAMES_PER_PUBLISH;

    for (const f of fish) {
      let t = coinTimers.get(f.id);
      if (t == null) t = COIN_BASE_CD * rnd(0.7, 1.3);
      t -= dt;
      if (t <= 0) {
        loot.push({ id: nextItemId++, kind: 'coin', x: Math.round(f.x), y: Math.round(f.y),
                    vy: 0, landed: false, tier: 0, ttl: COIN_REST });
        t = COIN_BASE_CD * (1 - 0.4 * luck) * rnd(0.7, 1.3);
      }
      coinTimers.set(f.id, t);
    }

    shellCD -= dt;
    if (shellCD <= 0) {
      const r = Math.random();
      const tier = r < 0.15 + 0.45 * luck ? (r < 0.05 + 0.25 * luck ? 2 : 1) : 0;
      loot.push({ id: nextItemId++, kind: 'shell', x: Math.round(rnd(40, W - 40)), y: SAND_Y,
                  vy: 0, landed: true, tier, ttl: SHELL_TTL });
      shellCD = SHELL_BASE_CD * rnd(0.7, 1.3);
    }

    wanderCD -= dt;
    if (wanderCD <= 0 && wanderers.length < 2) {
      const r = Math.random();
      const type = r < 0.1 + 0.3 * luck ? 3 : r < 0.6 ? 4 : r < 0.75 ? 1 : r < 0.92 ? 2 : 0;
      const fromLeft = Math.random() > 0.5;
      const wid = nextItemId++;
      // Wild fish carry no stored luck; derive a stable pseudo-luck from the id (the
      // same fallback app.js uses) so its colour is consistent device↔dashboard.
      const wluck = (hash32(wid + 1) % 1000) / 1000;
      wanderers.push({
        id: wid, type,
        x: fromLeft ? -20 : W + 20, y: rnd(TOP + 40, H - 120),
        vx: fromLeft ? rnd(1.2, 2.2) : -rnd(1.2, 2.2),
        color: syncedFishColor(type, wluck, wid),
        facing_right: fromLeft, bob: Math.random() * Math.PI * 2,
      });
      wanderCD = WANDER_BASE_CD * rnd(0.7, 1.3);
    }

    for (let s = 0; s < dt; s++) {
      const frameTick = tick - dt + s + 1;
      for (const w of wanderers) {
        w.x += w.vx;
        w.y += Math.sin(frameTick * 0.05 + w.bob) * 0.6;
      }
      for (const it of loot) {
        if (it.kind === 'coin' && !it.landed) {
          it.vy += COIN_GRAV;
          if (it.vy > COIN_MAX_VY) it.vy = COIN_MAX_VY;
          it.y += it.vy;
          if (it.y >= SAND_Y) { it.y = SAND_Y; it.landed = true; it.ttl = COIN_REST; }
        } else { it.ttl -= 1; }
      }
      for (const sn of snails) {
        let target = null, td = Infinity, targetLanded = false;
        for (const it of loot) {
          if (it.kind !== 'coin') continue;
          const d = Math.abs(it.x - sn.x);
          if (it.landed) {
            if (!targetLanded || d < td) { td = d; target = it; targetLanded = true; }
          } else if (!targetLanded && d < td) { td = d; target = it; }
        }
        if (target) {
          sn.facing_right = target.x > sn.x;
          const mult = targetLanded ? 4.0 : 2.0;
          sn.x += (sn.facing_right ? 1 : -1) * sn.spd * mult;
        } else {
          sn.x += (sn.facing_right ? 1 : -1) * sn.spd;
          if (sn.x > W - 55) { sn.x = W - 55; sn.facing_right = false; }
          if (sn.x < 55)     { sn.x = 55;     sn.facing_right = true; }
        }
        for (const it of loot)
          if (it.kind === 'coin' && it.landed && Math.abs(it.x - sn.x) < SNAIL_REACH) {
            coins += 1; it.ttl = -1;
          }
      }
      loot = loot.filter((it) => it.ttl > 0);
    }
    wanderers = wanderers.filter((w) => w.x > -40 && w.x < W + 40);
  }

  function applyDirectives(text) {
    if (!text) return;
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line.startsWith('!')) continue;
      if (line.startsWith('!MODE:')) {
        const m = line.slice(6) === '1' ? 'career' : 'creative';
        if (m === 'career' && mode !== 'career') resetCareer();
        mode = m;
      } else if (line.startsWith('!CATCH:')) {
        for (const idStr of line.slice(7).split(',')) {
          const id = parseInt(idStr, 10);
          const wi = wanderers.findIndex((w) => w.id === id);
          if (wi >= 0) { addFish(wanderers[wi].type); wanderers.splice(wi, 1); continue; }
          const li = loot.findIndex((it) => it.id === id);
          if (li >= 0) {
            const it = loot[li];
            if (it.kind === 'coin') coins += 1; else shells += SHELL_VALUE[it.tier] || 1;
            loot.splice(li, 1);
          }
        }
      } else if (line.startsWith('!BUYFISH:')) {
        const [, t, n] = line.split(':');
        const type = parseInt(t, 10), qty = parseInt(n, 10) || 1;
        for (let k = 0; k < qty; k++) {
          if (coins >= FISH_PRICE[type] && addFish(type)) coins -= FISH_PRICE[type];
        }
      } else if (line.startsWith('!BUYFOOD:')) {
        const qty = parseInt(line.slice(9), 10) || 1;
        for (let k = 0; k < qty; k++) { if (coins >= FOOD_PRICE) { coins -= FOOD_PRICE; food += 1; } }
      } else if (line.startsWith('!BUYSNAIL:')) {
        const qty = parseInt(line.slice(10), 10) || 1;
        for (let k = 0; k < qty; k++) { if (coins >= SNAIL_PRICE && addSnail()) coins -= SNAIL_PRICE; }
      } else if (line.startsWith('!FEED:')) {
        let n = parseInt(line.slice(6), 10) || 1;
        while (n-- > 0) {
          if (mode === 'career') { if (food <= 0) break; food -= 1; }
          if (mode === 'career') registerFeeding();
          const f = fish[Math.floor(Math.random() * fish.length)];
          if (f) { f.xp += 10; f.fishLuck = clamp(f.fishLuck + 0.06, 0, 1); f.age += 40; }
        }
      } else if (line.startsWith('!SELLFISH:')) {
        for (const idStr of line.slice(10).split(',')) {
          const id = parseInt(idStr, 10);
          const fi = fish.findIndex((f) => f.id === id);
          if (fi >= 0) { coins += fishSellValue(fish[fi]); fish.splice(fi, 1); }
        }
      } else if (line.startsWith('!FISHADD:')) {
        const [, t, n] = line.split(':');
        for (let k = 0; k < (parseInt(n, 10) || 1); k++) addFish(parseInt(t, 10));
      } else if (line.startsWith('!FISHDEL:')) {
        const [, t, n] = line.split(':');
        for (let k = 0; k < (parseInt(n, 10) || 1); k++) removeFish(parseInt(t, 10));
      } else if (line.startsWith('!WEATHER:')) {
        weatherOverride = parseInt(line.slice(9), 10);
      } else if (line.startsWith('!TIMESCALE:')) {
        const v = parseInt(line.slice(11), 10);
        timescale = Number.isFinite(v) ? Math.max(1, Math.min(5, v)) : 1;
      } else if (line.startsWith('!TIME:')) {
        timeMode = line.slice(6) === '1' ? 'FAST' : 'REAL';
      }
      // !RESTORE / !CONFLICT / !SWITCHAQ are device-only; the virtual sim ignores them.
    }
  }

  function snapshot() {
    const dp = dayProgress();
    const cond = weatherOverride >= 0 ? weatherOverride : Math.floor((tick / WEATHER_FRAMES) % 7);
    return {
      aquarium_id: aquariumId,
      platform: 'web',
      fw_version: 'web-1.0',
      uptime_ms: Date.now() - startMs,
      tick,
      screen: { w: W, h: H, tank_top: TOP },
      weather: { condition: cond, name: '', override: weatherOverride >= 0 },
      time: { day_progress: dp, mode: timeMode, scale: timescale },
      counts: counts(),
      frame_ms: FRAME_MS,
      game: {
        mode, coins, shells, food, luck: parseFloat(tankLuck().toFixed(3)),
        fed: mealsToday, meals: MEALS_PER_DAY, hungry: tankHungry ? 1 : 0, overfed: overfeedToday,
      },
      fish: fish.map((f) => ({
        id: f.id,
        x: parseFloat(f.x.toFixed(1)), y: parseFloat(f.y.toFixed(1)), z: f.z,
        vx: parseFloat(f.vx.toFixed(2)), vy: parseFloat(f.vy.toFixed(2)), vz: 0,
        tx: parseFloat(f.tx.toFixed(1)), ty: parseFloat(f.ty.toFixed(1)), tz: f.z,
        wander_cd: f.wanderCD,
        type: f.type, facing_right: f.facing_right,
        color: syncedFishColor(f.type, f.fishLuck, f.id), // device-identical, current luck
        going_for_food: f.going_for_food, chasing: f.chasing,
        age: Math.round(f.age), scale: parseFloat(scaleOf(f.age).toFixed(3)),
        xp: f.xp, fish_luck: parseFloat(f.fishLuck.toFixed(3)),
      })),
      wanderers: wanderers.map((w) => ({
        id: w.id, x: parseFloat(w.x.toFixed(1)), y: parseFloat(w.y.toFixed(1)),
        vx: parseFloat(w.vx.toFixed(3)), bob: parseFloat(w.bob.toFixed(3)),
        type: w.type, color: w.color, facing_right: w.facing_right,
      })),
      loot: loot.map((it) => ({
        id: it.id, kind: it.kind, x: parseFloat(it.x.toFixed(1)), y: parseFloat(it.y.toFixed(1)),
        vy: parseFloat((it.vy || 0).toFixed(2)), landed: !!it.landed, ttl: it.ttl, tier: it.tier,
      })),
      snails: snails.map((s) => ({
        x: parseFloat(s.x.toFixed(1)), spd: parseFloat(s.spd.toFixed(3)), facing_right: s.facing_right,
      })),
      flakes: [],
      snail: { x: Math.round((tick * 0.5) % W), facing_right: true },
      starfish: { x: 80, facing_right: false },
      boat: { active: tick % 400 < 80, x: W - ((tick * 3) % (W + 80)) },
      plants,
    };
  }

  // Reseed internal state from a persisted telemetry snapshot so a virtual device
  // resumes its tank (fish, wallet, snails, mode) instead of resetting on restart.
  // Transient items (loot/wanderers) are intentionally not restored.
  function restoreFrom(snap) {
    if (!snap) { resetCareer(); return; }
    const g = snap.game || {};
    mode = g.mode === 'creative' ? 'creative' : 'career';
    const ts = snap.time && Number(snap.time.scale);
    timescale = ts >= 1 && ts <= 5 ? (ts | 0) : 1;
    coins = g.coins | 0; shells = g.shells | 0; food = g.food | 0;
    mealsToday = g.fed | 0; overfeedToday = g.overfed | 0;
    feedSchedInit = false;
    tick = (snap.tick | 0) || 0;
    fish = (Array.isArray(snap.fish) ? snap.fish : []).map((f) => ({
      id: f.id | 0, type: f.type | 0,
      x: f.x, y: f.y, z: f.z || 0, vx: f.vx || 0, vy: f.vy || 0,
      tx: f.tx ?? f.x, ty: f.ty ?? f.y,
      wanderCD: typeof f.wander_cd === 'number' ? f.wander_cd : Math.floor(rnd(10, 50)),
      facing_right: !!f.facing_right,
      going_for_food: false, chasing: !!f.chasing,
      age: f.age || 0, xp: f.xp || 0, fishLuck: typeof f.fish_luck === 'number' ? f.fish_luck : 0,
    }));
    nextId = fish.reduce((m, f) => Math.max(m, f.id + 1), 0);
    snails = (Array.isArray(snap.snails) ? snap.snails : []).map((s) => ({
      x: s.x, spd: s.spd || 2, facing_right: !!s.facing_right,
    }));
    wanderers = []; loot = []; coinTimers.clear();
    if (!fish.length) resetCareer();
  }

  if (opts.restoreSnapshot) restoreFrom(opts.restoreSnapshot);
  else resetCareer();

  // One ~1s tick: advance the sim and return the telemetry snapshot. The timescale
  // multiplies how many sim-seconds elapse per tick, so it uniformly speeds up every
  // property (fish movement + aging, day/weather cycle, coin/shell/wanderer spawning,
  // snail collection, feeding schedule). timescale 1 = real-time (unchanged).
  function step() {
    const n = timescale < 1 ? 1 : timescale > 5 ? 5 : timescale;
    for (let i = 0; i < n; i++) { stepPhysics(); stepCareer(); }
    return snapshot();
  }

  return { step, applyDirectives, snapshot, restoreFrom, get aquariumId() { return aquariumId; } };
}

module.exports = { createSim };

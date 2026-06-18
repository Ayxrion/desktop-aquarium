'use strict';

// Posts animated fake telemetry to the server so you can exercise the dashboard
// + SSE without a real ESP32/Pi. Simulates the Career game loop (growth, coins,
// shells, wandering fish) and honors the control directives the server returns
// in each POST response — so the full web flow (catch, shop, mode switch, feed,
// fish ±) can be tested end to end.
//   API_KEY=change-me node scripts/mock-publisher.js [baseUrl] [aquariumId]

const base = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const aquariumId = process.argv[3] || 'mock-tank';
const apiKey = process.env.API_KEY || 'change-me';

const W = 800, H = 480, TOP = 72;
const PALETTE = [0x00ee66, 0xffdd00, 0xff6600, 0xcc44ff, 0x44ddff, 0xff44aa, 0x00ffff, 0xeeeeee];
const FISH_MAX = [8, 16, 20, 12, 16];       // clownfish(pair), guppy(school), piranha(school2), angel, salmon
const FISH_SCHOOL_SIZE = [2, 6, 4, 0, 0];   // max school size before splitting; 0 = solitary

const FRAME_MS = 50;
const FRAMES_PER_PUBLISH = 1000 / FRAME_MS; // 20 frames per 1Hz publish
const DAMP = 0.85;

// ── Career economy tuning (sim-frame units; currency is rare → full-day idle) ──
const GROW_FRAMES = 3600;                     // juvenile→mature growth span (~3 min @20fps) — slow growth
const COIN_BASE_CD = 3000;                    // frames between a fish's coin rolls (~2.5 min)
const SHELL_BASE_CD = 2600;                   // frames between shell spawns
const WANDER_BASE_CD = 7000;                  // wandering fish are very rare (~6 min)
const COIN_GRAV = 0.1;                         // coin sink acceleration (px/frame²) — very gentle, water-like
const COIN_MAX_VY = 1.4;                        // terminal sink speed so coins drift slowly down, not plummet
const COIN_REST = 480;                         // frames a landed coin sits before vanishing (~24s); timer starts on landing
const SHELL_TTL = 220;                         // shells linger on the sand a bit longer
const SAND_Y = H - 20;                         // resting line on the sea floor
const FISH_PRICE    = [10, 30, 45, 60, 8];      // clownfish, guppy, piranha, angel, salmon (common→cheap)
const FISH_BASE_SELL = [6, 3, 22, 30, 4];       // base sell value by type; school/salmon cheap (common, no market farming)
const FOOD_PRICE = 5;                          // coins per food unit
const SNAIL_PRICE = 50;                        // coins per coin-collector snail
const MAX_SNAILS = 6;
const SNAIL_REACH = 36;                        // px a snail can grab a coin from
const SHELL_VALUE = [2, 5, 12];               // shells granted per shell tier

// Feeding schedule: 3 meals/day; a clean day raises luck, neglect/overfeeding lowers it.
const MEALS_PER_DAY = 3;
const HUNGER_GRACE = 0.35;                    // fraction into an unfed slot before fish look hungry
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

// How many upcoming wander targets each fish precomputes and ships in telemetry so the
// web replication seeks identical targets (matches sim.js / firmware WANDER_LOOKAHEAD).
const WANDER_LOOKAHEAD = 4;

// Resolve ONE upcoming wander move — the only place wander RNG is drawn. Mirrors the
// retarget block in stepPhysics exactly. (Mock has no z motion, so tz tracks z.)
function computeWanderMove(f, cent, chasingIn) {
  const t = f.type;
  let wcd, chasing = chasingIn;
  if (t === 0) {
    chasing = !chasingIn;
    wcd = chasing ? 30 + Math.random() * 40 : 40 + Math.random() * 50;
  } else if (t === 3) { wcd = 8 + Math.random() * 20; }
  else { wcd = 15 + Math.random() * 35; }
  let tx, ty;
  if (t === 4) {                         // salmon: solitary — roam the tank independently
    tx = rnd(30, W - 30);
    ty = rnd(TOP + 20, H - 80);
  } else {
    const cg = cent[t + ':' + f._sub];
    const spread = t === 3 ? 120 : t === 0 ? 0 : 160;
    tx = clamp(cg.x + (Math.random() * 2 - 1) * spread, 30, W - 30);
    ty = clamp(cg.y + (Math.random() * 2 - 1) * (t === 3 ? 110 : 90), TOP + 20, H - 80);
  }
  return { wcd, tx, ty, tz: f.z, chasing };
}

let nextId = 0;       // fish ids
let nextItemId = 1;   // wanderer + loot ids (shared id space the web catches by)

function makeFish(type, x, y) {
  return {
    id: nextId++, type,
    x: x ?? rnd(40, W - 40), y: y ?? rnd(TOP + 30, H - 90), z: Math.random() * 0.6,
    vx: 0, vy: 0,
    tx: rnd(40, W - 40), ty: rnd(TOP + 30, H - 90),
    wanderCD: Math.floor(rnd(10, 50)),
    wanderQ: [],                 // upcoming wander targets, filled lazily in stepPhysics
    facing_right: Math.random() > 0.5,
    color: PALETTE[(type * 3 + nextId) % PALETTE.length],
    going_for_food: false, chasing: false,
    // Seed a spread of starting luck so the luck-driven coloring + rarity tiers
    // are visible in the dashboard without first grinding feedings.
    age: 0, xp: 0, fishLuck: parseFloat(rnd(0, 0.85).toFixed(3)),
  };
}

// ── Game state ────────────────────────────────────────────────────────────────
let mode = 'career';
let coins = 0, shells = 0, food = 0;
let fish = [];
let wanderers = [];
let loot = [];
let snails = [];                   // purchased coin-collector snails {x, spd, facing_right}
let weatherOverride = -1;          // -1 = auto
let timeMode = 'FAST';
let coinTimers = new Map();        // fishId → frames until next coin roll
let shellCD = SHELL_BASE_CD;
let wanderCD = WANDER_BASE_CD;

// Feeding-schedule state (career). mealFed[s] = slot s satisfied today.
let mealFed = [false, false, false];
let mealsToday = 0, overfeedToday = 0, lastMealSlot = 0;
let feedSchedInit = false, tankHungry = false;

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
resetCareer();

// ── Feeding schedule: 3 meals/day off the (1-minute) sim day ──
function dayProgress() { return ((Date.now() - startMs) / 60000) % 1; }
function currentMealSlot() {
  return clamp(Math.floor(dayProgress() * MEALS_PER_DAY), 0, MEALS_PER_DAY - 1);
}
function evaluateFeedingDay() {
  const missed = mealFed.filter((m) => !m).length;
  let delta = (missed === 0 && overfeedToday === 0)
    ? FEED_PERFECT_BONUS
    : -(FEED_MISS_PENALTY * missed) - (FEED_OVERFEED_PENALTY * overfeedToday);
  delta = clamp(delta, FEED_DELTA_MIN, FEED_DELTA_MAX);
  for (const f of fish) f.fishLuck = clamp((f.fishLuck || 0) + delta, 0, 1);
}
function resetFeedingDay() { mealFed = [false, false, false]; mealsToday = 0; overfeedToday = 0; }
function registerFeeding() {                 // one feeding event satisfies a slot, else overfeeds
  const s = currentMealSlot();
  if (!mealFed[s]) { mealFed[s] = true; mealsToday++; } else { overfeedToday++; }
  tankHungry = false;
}
function updateFeedingSchedule() {
  const s = currentMealSlot();
  if (!feedSchedInit) { lastMealSlot = s; feedSchedInit = true; }
  if (s !== lastMealSlot) {
    if (s < lastMealSlot) { evaluateFeedingDay(); resetFeedingDay(); } // wrapped → new day
    lastMealSlot = s;
  }
  const frac = dayProgress() * MEALS_PER_DAY - s;
  tankHungry = !mealFed[s] && frac > HUNGER_GRACE;
}

const plants = {
  bg: [60, 150, 240, 620, 720].map((x) => ({ x, segs: 6 + (x % 4), type: x % 2 })),
  weeds: [120, 400, 560].map((x) => ({ x, segs: 6 })),
  hornwort: [300, 680].map((x) => ({ x, segs: 5 })),
};

let tick = 0;
const startMs = Date.now();

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
  if (have >= FISH_MAX[type]) return false;
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
  return base
    + Math.round(base * scaleOf(f))
    + Math.round((f.fishLuck || 0) * 15)
    + Math.min(Math.floor((f.xp || 0) / 100), 8)
    + (f.shiny ? 12 : 0);
}

// ── Resident fish physics (mirrors device updateFish) ──
function stepPhysics() {
  for (let frame = 0; frame < FRAMES_PER_PUBLISH; frame++) {
    tick++;
    // Sub-school centroids: schooling types split into schools capped at FISH_SCHOOL_SIZE;
    // each fish gets `_sub` = its school index and coheres to that school (a new school forms
    // beyond the cap). Solitary types (size 0) collapse to one group (_sub 0, no cohesion).
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
      // Keep the lookahead queue full (the only wander RNG draw); the web drains it.
      let tailChasing = f.wanderQ.length ? f.wanderQ[f.wanderQ.length - 1].chasing : f.chasing;
      while (f.wanderQ.length < WANDER_LOOKAHEAD) {
        const mv = computeWanderMove(f, cent, tailChasing);
        f.wanderQ.push(mv);
        tailChasing = mv.chasing;
      }
      f.wanderCD--;
      if (f.wanderCD <= 0) {               // commit to the next precomputed target
        const mv = f.wanderQ.shift();
        f.tx = mv.tx; f.ty = mv.ty; f.chasing = mv.chasing; f.wanderCD = mv.wcd;
      }
      const chasing = t === 0 && f.chasing;
      const seekStr = chasing ? 0.018 : (t === 3 ? 0.020 : 0.012);
      const maxV = chasing || t === 3 ? 7.0 : 5.5;
      let ax = (f.tx - f.x) * seekStr;
      let ay = (f.ty - f.y) * seekStr;
      const grp = cent[t + ':' + f._sub];
      if (t === 1 || t === 2) {                 // Guppy / Piranha shoal within their sub-school
        ax += (grp.x - f.x) * 0.010; ay += (grp.y - f.y) * 0.007;
        for (const o of fish) {
          if (o === f || o.type !== t || o._sub !== f._sub) continue;
          const dx = f.x - o.x, dy = f.y - o.y, d2 = dx * dx + dy * dy;
          if (d2 < 80 * 80 && d2 > 0.01) { const inv = 8 / d2; ax += dx * inv; ay += dy * inv; }
        }
      } else if (t === 3) {                     // Angel keeps its own single loose group
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

// ── Career item simulation (per publish, ~1s) ──
function stepCareer() {
  if (mode !== 'career') { wanderers = []; loot = []; return; }
  updateFeedingSchedule();             // meal clock + hunger + day-end luck eval
  const luck = tankLuck();
  const dt = FRAMES_PER_PUBLISH;

  // Coins drop from fish (rare — currency is valuable); cadence eased by luck.
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

  // Shells appear on the sand; tier biased toward rarer by luck.
  shellCD -= dt;
  if (shellCD <= 0) {
    const r = Math.random();
    const tier = r < 0.15 + 0.45 * luck ? (r < 0.05 + 0.25 * luck ? 2 : 1) : 0;
    loot.push({ id: nextItemId++, kind: 'shell', x: Math.round(rnd(40, W - 40)), y: SAND_Y,
                vy: 0, landed: true, tier, ttl: SHELL_TTL });
    shellCD = SHELL_BASE_CD * rnd(0.7, 1.3);
  }

  // Wandering fish are very rare; guppy (~8%) is a rare wild catch. Type biased by luck.
  wanderCD -= dt;
  if (wanderCD <= 0 && wanderers.length < 2) {
    const r = Math.random();
    // Salmon (4) is the common wild fish; clownfish (0) is now rare; angel luck-biased.
    const type = r < 0.1 + 0.3 * luck ? 3 : r < 0.6 ? 4 : r < 0.75 ? 1 : r < 0.92 ? 2 : 0;
    const fromLeft = Math.random() > 0.5;
    wanderers.push({
      id: nextItemId++, type,
      x: fromLeft ? -20 : W + 20, y: rnd(TOP + 40, H - 120),
      vx: fromLeft ? rnd(1.2, 2.2) : -rnd(1.2, 2.2),
      color: PALETTE[(type * 3 + nextItemId) % PALETTE.length],
      facing_right: fromLeft, bob: Math.random() * Math.PI * 2,
    });
    wanderCD = WANDER_BASE_CD * rnd(0.7, 1.3);
  }
  // Advance coin sink + wanderer drift + snail collection per frame (matching the
  // device's updateCareer) so the web can dead-reckon them between publishes.
  for (let s = 0; s < dt; s++) {
    const frameTick = tick - dt + s + 1;   // device tick at this sub-frame
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
      // Prefer landed coins (sprint); otherwise intercept any falling coin at its predicted
      // landing x (coins fall straight down, so landing x == current x).
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

// ── Apply control directives returned in the POST response ──
function applyDirectives(text) {
  if (!text) return;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('!')) continue; // tab-delimited name lines ignored
    if (line.startsWith('!MODE:')) {
      const m = line.slice(6) === '1' ? 'career' : 'creative';
      if (m === 'career' && mode !== 'career') resetCareer();   // reset on entering career
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
        if (mode === 'career') registerFeeding();   // count toward the 3-meals/day schedule
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
    } else if (line.startsWith('!TIME:')) {
      timeMode = line.slice(6) === '1' ? 'FAST' : 'REAL';
    }
  }
}

function scaleOf(f) {
  return clamp(0.22 + 0.78 * Math.min(1, f.age / GROW_FRAMES), 0.22, 1.0);
}

async function step() {
  stepPhysics();
  stepCareer();

  const dayProgress = ((Date.now() - startMs) / 60000) % 1;
  const cond = weatherOverride >= 0 ? weatherOverride : Math.floor((tick / 100) % 7);
  const snapshot = {
    aquarium_id: aquariumId,
    // Self-register as an external device so the server treats this publisher as live
    // hardware and its built-in web simulator defers (no double-driving the same tank).
    device_id: 'mock-' + aquariumId,
    device_name: 'Mock publisher (' + aquariumId + ')',
    platform: 'mock',
    fw_version: '1.5.5',
    uptime_ms: Date.now() - startMs,
    tick,
    screen: { w: W, h: H, tank_top: TOP },
    weather: { condition: cond, name: '', override: weatherOverride >= 0 },
    time: { day_progress: dayProgress, mode: timeMode },
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
      wander_cd: parseFloat(f.wanderCD.toFixed(2)),
      // Upcoming wander targets the web should seek next: [wcd, tx, ty, tz, chasing].
      wander_q: f.wanderQ.map((m) => [
        parseFloat(m.wcd.toFixed(2)), parseFloat(m.tx.toFixed(1)),
        parseFloat(m.ty.toFixed(1)), parseFloat(m.tz.toFixed(3)), m.chasing ? 1 : 0,
      ]),
      type: f.type, facing_right: f.facing_right, color: f.color,
      going_for_food: f.going_for_food, chasing: f.chasing,
      age: Math.round(f.age), scale: parseFloat(scaleOf(f).toFixed(3)),
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

  try {
    const res = await fetch(`${base}/api/telemetry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
      body: JSON.stringify(snapshot),
    });
    if (res.ok) applyDirectives(await res.text());
  } catch (e) {
    console.error('post failed:', e.message);
  }
}

console.log(`Publishing mock CAREER telemetry "${aquariumId}" → ${base}/api/telemetry every 1s`);
setInterval(step, 1000);
step();

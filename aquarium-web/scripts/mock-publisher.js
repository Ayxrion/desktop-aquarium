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
const FISH_MAX = [8, 16, 20, 12];           // pair, school, school2, angel

const FRAME_MS = 50;
const FRAMES_PER_PUBLISH = 1000 / FRAME_MS; // 20 frames per 1Hz publish
const DAMP = 0.85;

// ── Career economy tuning (sim-frame units; currency is rare → full-day idle) ──
const GROW_FRAMES = 800;                      // juvenile→mature growth span
const COIN_BASE_CD = 3000;                    // frames between a fish's coin rolls (~2.5 min)
const SHELL_BASE_CD = 2600;                   // frames between shell spawns
const WANDER_BASE_CD = 7000;                  // wandering fish are very rare (~6 min)
const COIN_GRAV = 0.2;                         // coin sink acceleration (px/frame²) — gentle, water-like
const COIN_MAX_VY = 2.8;                        // terminal sink speed so coins drift down, not plummet
const COIN_REST = 80;                          // frames a landed coin sits before vanishing (~4s)
const SHELL_TTL = 220;                         // shells linger on the sand a bit longer
const SAND_Y = H - 20;                         // resting line on the sea floor
const FISH_PRICE = [10, 30, 45, 60];          // shop fish price (coins) by type
const FOOD_PRICE = 5;                          // coins per food unit
const SNAIL_PRICE = 50;                        // coins per coin-collector snail
const MAX_SNAILS = 6;
const SNAIL_REACH = 26;                        // px a snail can grab a coin from
const SHELL_VALUE = [2, 5, 12];               // shells granted per shell tier

function bound(v, lo, hi) {
  if (v < lo) return (lo - v) * 0.30;
  if (v > hi) return (hi - v) * 0.30;
  return 0;
}
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const rnd = (a, b) => a + Math.random() * (b - a);

let nextId = 0;       // fish ids
let nextItemId = 1;   // wanderer + loot ids (shared id space the web catches by)

function makeFish(type, x, y) {
  return {
    id: nextId++, type,
    x: x ?? rnd(40, W - 40), y: y ?? rnd(TOP + 30, H - 90), z: Math.random() * 0.6,
    vx: 0, vy: 0,
    tx: rnd(40, W - 40), ty: rnd(TOP + 30, H - 90),
    wanderCD: Math.floor(rnd(10, 50)),
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

function addSnail() {
  if (snails.length >= MAX_SNAILS) return false;
  snails.push({ x: rnd(80, W - 80), spd: rnd(0.5, 1.0), facing_right: Math.random() > 0.5 });
  return true;
}

function resetCareer() {
  fish = [makeFish(0, 200, 220), makeFish(0, 360, 240)]; // 2 pair fish
  wanderers = []; loot = []; snails = [];
  coins = 0; shells = 0; food = 0;
  coinTimers.clear();
}
resetCareer();

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
  const c = { pair: 0, school: 0, school2: 0, angel: 0 };
  const key = ['pair', 'school', 'school2', 'angel'];
  for (const f of fish) c[key[f.type]]++;
  return c;
}

function addFish(type) {
  const c = counts();
  const have = [c.pair, c.school, c.school2, c.angel][type];
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

// ── Resident fish physics (mirrors device updateFish) ──
function stepPhysics() {
  for (let frame = 0; frame < FRAMES_PER_PUBLISH; frame++) {
    tick++;
    const cent = [0, 1, 2, 3].map((t) => {
      const g = fish.filter((f) => f.type === t);
      if (!g.length) return { x: W / 2, y: (TOP + H) / 2 };
      return { x: g.reduce((s, f) => s + f.x, 0) / g.length,
               y: g.reduce((s, f) => s + f.y, 0) / g.length };
    });
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
        const cx = cent[t].x, cy = cent[t].y;
        const spread = t === 3 ? 120 : t === 0 ? 0 : 160;
        f.tx = clamp(cx + (Math.random() * 2 - 1) * spread, 30, W - 30);
        f.ty = clamp(cy + (Math.random() * 2 - 1) * (t === 3 ? 110 : 90), TOP + 20, H - 80);
      }
      const chasing = t === 0 && f.chasing;
      const seekStr = chasing ? 0.018 : (t === 3 ? 0.020 : 0.012);
      const maxV = chasing || t === 3 ? 7.0 : 5.5;
      let ax = (f.tx - f.x) * seekStr;
      let ay = (f.ty - f.y) * seekStr;
      if (t === 1 || t === 2) {
        ax += (cent[t].x - f.x) * 0.010; ay += (cent[t].y - f.y) * 0.007;
        for (const o of fish) {
          if (o === f || o.type !== t) continue;
          const dx = f.x - o.x, dy = f.y - o.y, d2 = dx * dx + dy * dy;
          if (d2 < 80 * 80 && d2 > 0.01) { const inv = 8 / d2; ax += dx * inv; ay += dy * inv; }
        }
      } else if (t === 3) {
        ax += (cent[3].x - f.x) * 0.012; ay += (cent[3].y - f.y) * 0.010;
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

  // Wandering fish are very rare; type biased toward rarer by luck.
  wanderCD -= dt;
  if (wanderCD <= 0 && wanderers.length < 2) {
    const r = Math.random();
    const type = r < 0.1 + 0.3 * luck ? 3 : r < 0.4 ? 0 : r < 0.7 ? 1 : 2;
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
  for (const w of wanderers) {
    w.x += w.vx * dt * 0.5;
    w.y += Math.sin(tick * 0.05 + w.bob) * 0.6;
  }
  wanderers = wanderers.filter((w) => w.x > -40 && w.x < W + 40);

  // Advance coin sink + snail collection across the publish's frames so coins
  // visibly fall, rest ~1s on the sand, then vanish — grab them fast (or let a snail).
  for (let s = 0; s < dt; s++) {
    for (const it of loot) {
      if (it.kind === 'coin' && !it.landed) {
        it.vy += COIN_GRAV;
        if (it.vy > COIN_MAX_VY) it.vy = COIN_MAX_VY;
        it.y += it.vy;
        if (it.y >= SAND_Y) { it.y = SAND_Y; it.landed = true; it.ttl = COIN_REST; }
      } else { it.ttl -= 1; }
    }
    for (const sn of snails) {
      // Steer toward the nearest coin nearing the floor, else patrol + bounce.
      let target = null, td = Infinity;
      for (const it of loot) {
        if (it.kind !== 'coin' || it.y < SAND_Y - 90) continue;
        const d = Math.abs(it.x - sn.x);
        if (d < td) { td = d; target = it; }
      }
      if (target) { sn.facing_right = target.x > sn.x; sn.x += (sn.facing_right ? 1 : -1) * sn.spd * 1.6; }
      else {
        sn.x += (sn.facing_right ? 1 : -1) * sn.spd;
        if (sn.x > W - 55) { sn.x = W - 55; sn.facing_right = false; }
        if (sn.x < 55)     { sn.x = 55;     sn.facing_right = true; }
      }
      for (const it of loot)
        if (it.kind === 'coin' && it.y > SAND_Y - 40 && Math.abs(it.x - sn.x) < SNAIL_REACH) {
          coins += 1; it.ttl = -1;
        }
    }
    loot = loot.filter((it) => it.ttl > 0);
  }
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
        const f = fish[Math.floor(Math.random() * fish.length)];
        if (f) { f.xp += 10; f.fishLuck = clamp(f.fishLuck + 0.06, 0, 1); f.age += 40; }
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
  return clamp(0.45 + 0.55 * Math.min(1, f.age / GROW_FRAMES), 0.45, 1.0);
}

async function step() {
  stepPhysics();
  stepCareer();

  const dayProgress = ((Date.now() - startMs) / 60000) % 1;
  const cond = weatherOverride >= 0 ? weatherOverride : Math.floor((tick / 100) % 7);
  const snapshot = {
    aquarium_id: aquariumId,
    platform: 'mock',
    fw_version: '1.5.5',
    uptime_ms: Date.now() - startMs,
    tick,
    screen: { w: W, h: H, tank_top: TOP },
    weather: { condition: cond, name: '', override: weatherOverride >= 0 },
    time: { day_progress: dayProgress, mode: timeMode },
    counts: counts(),
    frame_ms: FRAME_MS,
    game: { mode, coins, shells, food, luck: parseFloat(tankLuck().toFixed(3)) },
    fish: fish.map((f) => ({
      id: f.id,
      x: Math.round(f.x), y: Math.round(f.y), z: f.z,
      vx: parseFloat(f.vx.toFixed(2)), vy: parseFloat(f.vy.toFixed(2)), vz: 0,
      tx: Math.round(f.tx), ty: Math.round(f.ty), wander_cd: f.wanderCD,
      type: f.type, facing_right: f.facing_right, color: f.color,
      going_for_food: f.going_for_food, chasing: f.chasing,
      age: Math.round(f.age), scale: parseFloat(scaleOf(f).toFixed(3)),
      xp: f.xp, fish_luck: parseFloat(f.fishLuck.toFixed(3)),
    })),
    wanderers: wanderers.map((w) => ({
      id: w.id, x: Math.round(w.x), y: Math.round(w.y),
      type: w.type, color: w.color, facing_right: w.facing_right,
    })),
    loot: loot.map((it) => ({ id: it.id, kind: it.kind, x: Math.round(it.x), y: Math.round(it.y), tier: it.tier })),
    snails: snails.map((s) => ({ x: Math.round(s.x), facing_right: s.facing_right })),
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

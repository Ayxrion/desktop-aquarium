'use strict';

// Posts animated fake telemetry to the server so you can exercise the dashboard
// + SSE without a real ESP32/Pi. Usage:
//   API_KEY=change-me node scripts/mock-publisher.js [baseUrl] [aquariumId]

const base = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const aquariumId = process.argv[3] || 'mock-tank';
const apiKey = process.env.API_KEY || 'change-me';

const W = 800, H = 480, TOP = 72;
const PALETTE = [0x00ee66, 0xffdd00, 0xff6600, 0xcc44ff, 0x44ddff, 0xff44aa, 0x00ffff, 0xeeeeee];

const FRAME_MS = 50;
const FRAMES_PER_PUBLISH = 1000 / FRAME_MS; // 20 frames per 1Hz publish
const DAMP = 0.85;

function bound(v, lo, hi) {
  if (v < lo) return (lo - v) * 0.30;
  if (v > hi) return (hi - v) * 0.30;
  return 0;
}

// type 0=pair(×2), 1=school(×5), 2=school2(×4), 3=angel(×3)
const fish = Array.from({ length: 14 }, (_, i) => ({
  id: i,
  x: 30 + Math.random() * (W - 60),
  y: TOP + 20 + Math.random() * (H - TOP - 80),
  z: Math.random() * 0.6,
  type: i < 2 ? 0 : i < 7 ? 1 : i < 11 ? 2 : 3,
  facing_right: Math.random() > 0.5,
  color: PALETTE[i % PALETTE.length],
  vx: 0, vy: 0, vz: 0,
  tx: 30 + Math.random() * (W - 60),
  ty: TOP + 20 + Math.random() * (H - TOP - 80),
  wanderCD: Math.floor(Math.random() * 40) + 10,
  going_for_food: false,
  // pair fish alternate chase/flee; start not chasing
  chasing: false,
}));

const plants = {
  bg: [60, 150, 240, 620, 720].map((x) => ({ x, segs: 6 + (x % 4), type: x % 2 })),
  weeds: [120, 400, 560].map((x) => ({ x, segs: 6 })),
  hornwort: [300, 680].map((x) => ({ x, segs: 5 })),
};

let tick = 0;
const startMs = Date.now();

function stepPhysics() {
  for (let frame = 0; frame < FRAMES_PER_PUBLISH; frame++) {
    tick++;

    // Group centroids (recomputed each device frame, matching updateFish())
    const cent = [0, 1, 2, 3].map((t) => {
      const g = fish.filter((f) => f.type === t);
      if (!g.length) return { x: W / 2, y: (TOP + H) / 2 };
      return { x: g.reduce((s, f) => s + f.x, 0) / g.length,
               y: g.reduce((s, f) => s + f.y, 0) / g.length };
    });

    for (const f of fish) {
      const t = f.type;

      // Wander countdown — pair fish toggle chasing state on expiry
      f.wanderCD--;
      if (f.wanderCD <= 0) {
        if (t === 0) {
          f.chasing = !f.chasing;
          f.wanderCD = f.chasing ? 30 + Math.random() * 40 : 40 + Math.random() * 50;
        } else if (t === 3) {
          f.wanderCD = 8 + Math.random() * 20;
        } else {
          f.wanderCD = 15 + Math.random() * 35;
        }
        // Pick new wander target near group centroid (matches device)
        const cx = cent[t].x, cy = cent[t].y;
        const spread = t === 3 ? 120 : t === 0 ? 0 : 160;
        f.tx = Math.max(30, Math.min(W - 30, cx + (Math.random() * 2 - 1) * spread));
        f.ty = Math.max(TOP + 20, Math.min(H - 80, cy + (Math.random() * 2 - 1) * (t === 3 ? 110 : 90)));
      }

      const chasing = t === 0 && f.chasing;
      const seekStr = chasing ? 0.018 : (t === 3 ? 0.020 : 0.012);
      const maxV    = chasing || t === 3 ? 7.0 : 5.5;

      let ax = (f.tx - f.x) * seekStr;
      let ay = (f.ty - f.y) * seekStr;

      // School cohesion + separation (mirrors device lines 1094–1131)
      if (t === 1 || t === 2) {
        ax += (cent[t].x - f.x) * 0.010;
        ay += (cent[t].y - f.y) * 0.007;
        for (const o of fish) {
          if (o === f || o.type !== t) continue;
          const dx = f.x - o.x, dy = f.y - o.y, d2 = dx * dx + dy * dy;
          if (d2 < 80 * 80 && d2 > 0.01) { const inv = 8 / d2; ax += dx * inv; ay += dy * inv; }
        }
      } else if (t === 3) {
        ax += (cent[3].x - f.x) * 0.012;
        ay += (cent[3].y - f.y) * 0.010;
        for (const o of fish) {
          if (o === f || o.type !== t) continue;
          const dx = f.x - o.x, dy = f.y - o.y, d2 = dx * dx + dy * dy;
          if (d2 < 60 * 60 && d2 > 0.01) { const inv = 7 / d2; ax += dx * inv; ay += dy * inv; }
        }
      }

      ax += bound(f.x, 30, W - 30);
      ay += bound(f.y, TOP + 20, H - 80);

      f.vx = Math.max(-maxV,       Math.min(maxV,       f.vx + ax)) * DAMP;
      f.vy = Math.max(-maxV * 0.5, Math.min(maxV * 0.5, f.vy + ay)) * DAMP;
      f.x  = Math.max(5,       Math.min(W - 5,  f.x + f.vx));
      f.y  = Math.max(TOP + 5, Math.min(H - 60, f.y + f.vy));
      if (Math.abs(f.vx) > 0.4) f.facing_right = f.vx > 0;
    }
  }
}

function step() {
  stepPhysics();

  const dayProgress = ((Date.now() - startMs) / 60000) % 1; // full day every minute
  const snapshot = {
    aquarium_id: aquariumId,
    platform: 'mock',
    fw_version: '1.5.5',
    uptime_ms: Date.now() - startMs,
    tick,
    screen: { w: W, h: H, tank_top: TOP },
    weather: { condition: Math.floor((tick / 100) % 7), name: '', override: false },
    time: { day_progress: dayProgress, mode: 'FAST' },
    counts: { pair: 2, school: 5, school2: 4, angel: 3 },
    frame_ms: FRAME_MS,
    fish: fish.map((f) => ({
      id: f.id,
      x: Math.round(f.x), y: Math.round(f.y), z: f.z,
      vx: parseFloat(f.vx.toFixed(2)), vy: parseFloat(f.vy.toFixed(2)), vz: 0,
      tx: Math.round(f.tx), ty: Math.round(f.ty), wander_cd: f.wanderCD,
      type: f.type,
      facing_right: f.facing_right, color: f.color,
      going_for_food: f.going_for_food, chasing: f.chasing,
    })),
    flakes: [],
    snail: { x: Math.round((tick * 0.5) % W), facing_right: true },
    starfish: { x: 80, facing_right: false },
    boat: { active: tick % 400 < 80, x: W - ((tick * 3) % (W + 80)) },
    plants,
  };

  fetch(`${base}/api/telemetry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
    body: JSON.stringify(snapshot),
  }).catch((e) => console.error('post failed:', e.message));
}

console.log(`Publishing mock telemetry "${aquariumId}" → ${base}/api/telemetry every 1s`);
setInterval(step, 1000);
step();

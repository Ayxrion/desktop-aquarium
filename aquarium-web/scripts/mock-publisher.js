'use strict';

// Posts animated fake telemetry to the server so you can exercise the dashboard
// + SSE without a real ESP32/Pi. Usage:
//   API_KEY=change-me node scripts/mock-publisher.js [baseUrl] [aquariumId]

const base = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const aquariumId = process.argv[3] || 'mock-tank';
const apiKey = process.env.API_KEY || 'change-me';

const W = 800, H = 480, TOP = 72;
const PALETTE = [0x00ee66, 0xffdd00, 0xff6600, 0xcc44ff, 0x44ddff, 0xff44aa, 0x00ffff, 0xeeeeee];

const FRAME_MS = 50; // matches device FRAME_MS
const DAMP = 0.85;

// Persistent fish so motion looks continuous. Each fish has position + velocity
// that the mock updates with damping each frame — matching the device physics so
// the web client's extrapolation logic can be exercised with the mock publisher.
const fish = Array.from({ length: 14 }, (_, i) => ({
  id: i,
  x: Math.random() * W,
  y: TOP + Math.random() * (H - TOP - 60),
  z: Math.random() * 0.6,
  type: i < 2 ? 0 : i < 7 ? 1 : i < 11 ? 2 : 3,
  facing_right: Math.random() > 0.5,
  color: PALETTE[i % PALETTE.length],
  vx: (Math.random() * 2 + 1) * (Math.random() > 0.5 ? 1 : -1),
  vy: (Math.random() - 0.5) * 1.5,
  vz: 0,
  // Wander target
  tx: Math.random() * W,
  ty: TOP + Math.random() * (H - TOP - 60),
  wanderCD: Math.floor(Math.random() * 40) + 10,
  going_for_food: false,
  chasing: false,
}));

const plants = {
  bg: [60, 150, 240, 620, 720].map((x) => ({ x, segs: 6 + (x % 4), type: x % 2 })),
  weeds: [120, 400, 560].map((x) => ({ x, segs: 6 })),
  hornwort: [300, 680].map((x) => ({ x, segs: 5 })),
};

let tick = 0;
const startMs = Date.now();

function step() {
  tick++;
  for (const f of fish) {
    // Wander: decrement per device frame (step() fires every 1s = 20 frames at 50ms)
    f.wanderCD -= 20;
    if (f.wanderCD <= 0) {
      f.tx = 20 + Math.random() * (W - 40);
      f.ty = TOP + 20 + Math.random() * (H - TOP - 80);
      f.wanderCD = Math.floor(Math.random() * 60) + 20;
    }
    // Seek target with damped-velocity physics (mirrors device updateFish)
    const ax = (f.tx - f.x) * 0.012 + (f.x < 30 ? (30 - f.x) * 0.3 : f.x > W - 30 ? (W - 30 - f.x) * 0.3 : 0);
    const ay = (f.ty - f.y) * 0.012 + (f.y < TOP + 20 ? (TOP + 20 - f.y) * 0.3 : f.y > H - 80 ? (H - 80 - f.y) * 0.3 : 0);
    f.vx = Math.max(-5.5, Math.min(5.5, f.vx + ax)) * DAMP;
    f.vy = Math.max(-2.75, Math.min(2.75, f.vy + ay)) * DAMP;
    f.x += f.vx;
    f.y += f.vy;
    if (Math.abs(f.vx) > 0.4) f.facing_right = f.vx > 0;
  }

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

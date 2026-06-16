'use strict';

// Posts animated fake telemetry to the server so you can exercise the dashboard
// + SSE without a real ESP32/Pi. Usage:
//   API_KEY=change-me node scripts/mock-publisher.js [baseUrl] [aquariumId]

const base = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const aquariumId = process.argv[3] || 'mock-tank';
const apiKey = process.env.API_KEY || 'change-me';

const W = 800, H = 480, TOP = 72;
const PALETTE = [0x00ee66, 0xffdd00, 0xff6600, 0xcc44ff, 0x44ddff, 0xff44aa, 0x00ffff, 0xeeeeee];

// Persistent fish so motion looks continuous.
const fish = Array.from({ length: 14 }, (_, i) => ({
  id: i,
  x: Math.random() * W,
  y: TOP + Math.random() * (H - TOP - 60),
  type: i < 2 ? 0 : i < 7 ? 1 : i < 11 ? 2 : 3,
  facing_right: Math.random() > 0.5,
  color: PALETTE[i % PALETTE.length],
  vx: (Math.random() * 2 + 1) * (Math.random() > 0.5 ? 1 : -1),
  vy: (Math.random() - 0.5) * 1.5,
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
    f.x += f.vx;
    f.y += f.vy;
    if (f.x < 10 || f.x > W - 10) { f.vx *= -1; f.facing_right = f.vx > 0; }
    if (f.y < TOP + 10 || f.y > H - 50) f.vy *= -1;
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
    fish: fish.map((f) => ({
      id: f.id,
      x: Math.round(f.x), y: Math.round(f.y), z: 0.3, type: f.type,
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

'use strict';

// All URLs are relative so the app works when served under the /aquarium/
// reverse-proxy prefix the deploy service configures.

const WEATHER_NAMES = ['Sunny', 'Partly Cloudy', 'Cloudy', 'Rainy', 'Stormy', 'Snowy', 'Foggy'];
const FISH_TYPE_NAMES = ['Pair', 'School', 'School 2', 'Angel'];
// Per-type caps + snapshot count keys, mirroring the firmware (main.cpp / aquarium.ino).
const FISH_MAX = [8, 16, 20, 12];
const FISH_COUNT_KEYS = ['pair', 'school', 'school2', 'angel'];
const TANK_TOP = 72;
const SCREEN_W = 800;
const SCREEN_H = 480;

// ─── Physics simulation (mirrors device updateFish, aquarium.ino / main.cpp) ──
const _DAMP  = 0.85;
const _DAMPZ = 0.88;

// Smooth motion for the non-fish movers (boat, snail, starfish, flakes). Their
// telemetry carries no velocity, so we dead-reckon: derive each one's velocity
// from the observed delta between the last two snapshots and extrapolate that
// forward every frame, the same way the fish are smoothed.
let _sceneVel = { snail: 0, starfish: 0, boat: 0 }; // px per ms
const FLAKE_FALL_PXF = 0.7;                          // avg device fall (px/frame)

// Observed velocity (px/ms) between two snapshot positions. Returns 0 for
// teleports/wraps (implausibly large deltas, e.g. the boat relaunching from the
// far edge) so we don't fling objects. The cap (0.15 px/ms ≈ 150 px/s) is well
// above any real mover — boat drift, snail/starfish crawl — but well below a
// full-width wrap (~800 px/s).
function _obsVel(a, b, dt) {
  if (!a || !b || typeof a.x !== 'number' || typeof b.x !== 'number') return 0;
  const v = (b.x - a.x) / dt;
  return Math.abs(v) > 0.15 ? 0 : v;
}

function _bound(v, lo, hi, k) {
  if (v < lo) return (lo - v) * k;
  if (v > hi) return (hi - v) * k;
  return 0;
}

// Single-fish approximation used only for blend-from captures (≤250ms window).
// Does NOT include schooling forces — good enough for a visual blend start.
function _extrapolateFish(f, elapsedMs, frameMs) {
  const fm  = frameMs || 50;
  const n   = Math.round(Math.min(elapsedMs, 2000) / fm);
  if (n === 0) return f;
  const type = f.type || 0;
  const chasing = f.chasing && type === 0;
  const seek = chasing ? 0.018 : (type === 3 ? 0.020 : 0.012);
  const maxV = f.going_for_food ? 8.0 : (chasing || type === 3) ? 7.0 : 5.5;
  const wcd  = typeof f.wander_cd === 'number' ? f.wander_cd : n;
  const tx = f.tx ?? f.x, ty = f.ty ?? f.y;
  let x = f.x, y = f.y, z = f.z || 0;
  let vx = f.vx || 0, vy = f.vy || 0, vz = f.vz || 0;
  for (let i = 0; i < n; i++) {
    const seeking = f.going_for_food || i < wcd;
    let ax = (seeking ? (tx - x) * seek : 0) + _bound(x, 30, SCREEN_W - 30, 0.30);
    let ay = (seeking ? (ty - y) * seek : 0) + _bound(y, TANK_TOP + 20, SCREEN_H - 80, 0.30);
    let az = _bound(z, 0.0, 0.75, 0.08);
    vx = Math.max(-maxV,      Math.min(maxV,      vx + ax)) * _DAMP;
    vy = Math.max(-maxV*0.5,  Math.min(maxV*0.5,  vy + ay)) * _DAMP;
    vz = Math.max(-0.015,     Math.min(0.015,     vz + az)) * _DAMPZ;
    x  = Math.max(5,          Math.min(SCREEN_W - 5,  x + vx));
    y  = Math.max(TANK_TOP+5, Math.min(SCREEN_H - 60, y + vy));
    z  = Math.max(0,          Math.min(0.78,           z + vz));
  }
  return { ...f, x: Math.round(x), y: Math.round(y), z,
           facing_right: Math.abs(vx) > 0.4 ? vx > 0 : f.facing_right };
}

// Joint simulation: all fish stepped together each frame so school centroids
// and pairwise separation forces update correctly — matching device updateFish().
function _extrapolateSnapshot(snap, elapsedMs) {
  if (!snap) return snap;
  const fm = snap.frame_ms || 50;
  const e  = Math.min(Math.max(elapsedMs, 0), 2000);
  const n  = Math.round(e / fm);
  const hasFish = Array.isArray(snap.fish) && snap.fish.length > 0;

  let fishOut = snap.fish;
  if (hasFish && n > 0) {
  // Working copies of mutable state
  const st = snap.fish.map((f) => ({
    id: f.id, type: f.type || 0,
    x: f.x, y: f.y, z: f.z || 0,
    vx: f.vx || 0, vy: f.vy || 0, vz: f.vz || 0,
    tx: f.tx ?? f.x, ty: f.ty ?? f.y,
    wcd: typeof f.wander_cd === 'number' ? f.wander_cd : n,
    chasing: !!f.chasing, going_for_food: !!f.going_for_food,
    facing_right: f.facing_right,
  }));

  for (let frame = 0; frame < n; frame++) {
    // Recompute centroids from current positions each frame (matches device)
    const cent = [0, 1, 2, 3].map((t) => {
      const g = st.filter((f) => f.type === t);
      if (!g.length) return { x: 0, y: 0 };
      return { x: g.reduce((s, f) => s + f.x, 0) / g.length,
               y: g.reduce((s, f) => s + f.y, 0) / g.length };
    });

    for (const f of st) {
      f.wcd--;
      const t = f.type;
      const seeking = f.going_for_food || f.wcd >= 0;
      const chasing = f.chasing && t === 0;
      const seekStr = chasing ? 0.018 : (t === 3 ? 0.020 : 0.012);
      const maxV    = f.going_for_food ? 8.0 : (chasing || t === 3) ? 7.0 : 5.5;

      let ax = (seeking ? (f.tx - f.x) * seekStr : 0);
      let ay = (seeking ? (f.ty - f.y) * seekStr : 0);

      // Cohesion toward group centroid (school / angel)
      if (t === 1 || t === 2) {
        ax += (cent[t].x - f.x) * 0.010;
        ay += (cent[t].y - f.y) * 0.007;
      } else if (t === 3) {
        ax += (cent[3].x - f.x) * 0.012;
        ay += (cent[3].y - f.y) * 0.010;
      }

      // Pairwise separation within school / angel groups
      const sepR2 = (t === 3) ? 60 * 60 : 80 * 80;
      const sepK  = (t === 3) ? 7 : 8;
      if (t === 1 || t === 2 || t === 3) {
        for (const o of st) {
          if (o === f || o.type !== t) continue;
          const dx = f.x - o.x, dy = f.y - o.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < sepR2 && d2 > 0.01) { const inv = sepK / d2; ax += dx * inv; ay += dy * inv; }
        }
      }

      // Boundary springs
      ax += _bound(f.x, 30, SCREEN_W - 30, 0.30);
      ay += _bound(f.y, TANK_TOP + 20, SCREEN_H - 80, 0.30);

      f.vx = Math.max(-maxV,     Math.min(maxV,     f.vx + ax)) * _DAMP;
      f.vy = Math.max(-maxV*0.5, Math.min(maxV*0.5, f.vy + ay)) * _DAMP;
      f.x  = Math.max(5,         Math.min(SCREEN_W - 5,  f.x + f.vx));
      f.y  = Math.max(TANK_TOP+5,Math.min(SCREEN_H - 60, f.y + f.vy));
      if (Math.abs(f.vx) > 0.4) f.facing_right = f.vx > 0;
    }
  }

  fishOut = snap.fish.map((orig, i) => ({
    ...orig,
    x: Math.round(st[i].x), y: Math.round(st[i].y), z: st[i].z,
    vx: st[i].vx, vy: st[i].vy,
    facing_right: st[i].facing_right,
  }));
  }

  // Dead-reckon the non-fish movers from their observed velocity.
  const out = { ...snap, fish: fishOut };
  if (snap.snail && typeof snap.snail.x === 'number')
    out.snail = { ...snap.snail, x: snap.snail.x + _sceneVel.snail * e };
  if (snap.starfish && typeof snap.starfish.x === 'number')
    out.starfish = { ...snap.starfish, x: snap.starfish.x + _sceneVel.starfish * e };
  if (snap.boat && typeof snap.boat.x === 'number')
    out.boat = { ...snap.boat, x: snap.boat.x + _sceneVel.boat * e };
  if (Array.isArray(snap.flakes)) {
    const frames = e / fm;
    out.flakes = snap.flakes.map((fl, i) => ({
      ...fl,
      x: fl.x + Math.sin(animTick * 0.03 + i * 0.9) * 0.5,
      y: Math.min(SCREEN_H - 4, fl.y + FLAKE_FALL_PXF * frames),
    }));
  }
  return out;
}

// ─── Faithful scene renderer (mirrors device aquarium.ino / main.cpp) ─────────
// Decorative animations (sway, water, bubbles, smoke) are driven by animTick,
// expressed in device "tick" units (one per 50ms) so the device's sin() phase
// constants port over unchanged. Updated once per rAF frame in _rafDraw.
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
// 0.45..1.0; absent (creative / pre-game telemetry) → full size.
function growth(f) { return typeof f.scale === 'number' ? clamp(f.scale, 0.3, 1) : 1; }

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

// ── Sky: gradient, stars at night, sun/moon arc, drifting clouds ──
function drawSky(top, bright, cond, s) {
  const skyTop = [0x1A78C8, 0x2288CC, 0x556677, 0x334455, 0x111827, 0x8899AA, 0x7788AA];
  const skyBot = [0x64B5E8, 0x77AEDD, 0x8899AA, 0x556677, 0x1A2233, 0xAABBCC, 0xAABBCC];
  const base = skyTop[cond] ?? 0x1A78C8;
  const g = ctx.createLinearGradient(0, 0, 0, top);
  g.addColorStop(0, shadeN(base, bright));
  g.addColorStop(1, shadeN(skyBot[cond] ?? 0x64B5E8, bright));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, SCREEN_W, top);

  const dp = (s.time && typeof s.time.day_progress === 'number') ? s.time.day_progress : 0.5;

  if (bright < 0.55) {
    const a = (0.55 - bright) / 0.55;
    for (let i = 0; i < 50; i++) {
      const x = (i * 101) % SCREEN_W;
      const y = 3 + ((i * 53) % Math.max(1, top - 26));
      const tw = 0.55 + 0.45 * Math.sin(animTick * 0.07 + i * 0.13);
      ctx.fillStyle = `rgba(220,230,255,${(a * tw).toFixed(2)})`;
      ctx.fillRect(x, y, 1, 1);
    }
  }

  const alt = Math.sin(Math.PI * clamp(dp, 0, 1));
  const cx = SCREEN_W * clamp(dp, 0, 1);
  const cy = (top - 14) - alt * (top - 26);
  if (dp > 0.22 && dp < 0.78) {
    fillEllipseC(cx, cy, 13, 13, shadeN(0xFFE680, Math.max(bright, 0.7)));
    fillEllipseC(cx, cy, 9, 9, shadeN(0xFFF0A0, Math.max(bright, 0.85)));
    fillEllipseC(cx, cy, 5, 5, '#ffffff');
  } else {
    fillEllipseC(cx, cy, 8, 8, '#EEEEFF');
    fillEllipseC(cx + 3, cy - 2, 8, 8, shadeN(base, bright)); // carve crescent
  }

  if (cond === 1 || cond === 2 || cond === 5 || cond === 6) {
    const cc = cond === 2 ? 0xBBBBCC : cond === 5 ? 0xCCDDEE : cond === 6 ? 0xBBCCDD : 0xEEEEFF;
    const n = (cond === 2 || cond === 6) ? 4 : 2;
    const col = shadeN(cc, bright);
    for (let i = 0; i < n; i++) {
      const cxp = ((i * 230 + animTick * 0.3) % (SCREEN_W + 140)) - 70;
      drawCloud(cxp, 14 + (i % 2) * 12, 70, 26, col);
    }
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

// ── Decorative bubbles (not in telemetry) — local sim, like the device ──
const bubbles = Array.from({ length: 20 }, () => ({
  x: Math.random() * SCREEN_W,
  y: TANK_TOP + Math.random() * (SCREEN_H - TANK_TOP),
  spd: 0.8 + Math.random() * 1.7,
  r: 3 + Math.floor(Math.random() * 6),
  ph: Math.random() * Math.PI * 2,
}));
// The device steps bubbles once per 50ms frame (FRAME_MS); the browser rAF runs
// at ~60fps, so applying the per-frame delta every rAF made bubbles rise ~3x too
// fast. Drive them by elapsed device-frames (df) instead so they match the device.
function tickBubbles(df) {
  for (const b of bubbles) {
    b.y -= b.spd * df;
    b.x = clamp(b.x + Math.sin(animTick * 0.06 + b.ph) * 0.8 * df, 2, SCREEN_W - 2);
    if (b.y < TANK_TOP) {
      b.y = SCREEN_H + 10; b.x = Math.random() * SCREEN_W;
      b.spd = 0.8 + Math.random() * 1.7; b.r = 3 + Math.floor(Math.random() * 6);
    }
  }
}
function drawBubbles(top) {
  ctx.strokeStyle = 'rgba(85,204,255,0.7)'; ctx.lineWidth = 1;
  for (const b of bubbles) {
    if (b.y - b.r < top) continue;
    ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2); ctx.stroke();
    if (b.r > 1) { ctx.beginPath(); ctx.arc(b.x, b.y, b.r - 1, 0, Math.PI * 2); ctx.stroke(); }
  }
}

// ── Food flakes — telemetry sends x/y/color only; draw a little cross ──
function drawFlake(f) {
  const x = Math.round(f.x), y = Math.round(f.y);
  ctx.fillStyle = hex(f.color || 0xffaa22);
  ctx.fillRect(x - 3, y, 7, 1);
  ctx.fillRect(x, y - 3, 1, 7);
}

// ── Bottom dwellers ──
function drawSnail(sn) {
  const bx = Math.round(sn.x), by = terrainY[clamp(bx, 0, SCREEN_W - 1)];
  const d = sn.facing_right ? 1 : -1;
  const BODY = 0xDDB060;
  fcirc(bx - d * 4, by - 8, 8, 0x7A2E0A);          // shell
  scirc(bx - d * 3, by - 8, 5, 0xB05020);          // swirl
  scirc(bx - d * 2, by - 8, 2, 0xB05020);
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
  ctx.fillStyle = hex(w.color || 0x88e0ff);
  ctx.fillText(glyph, sx, sy);
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

// Dead-reckoning blend: when a new snapshot arrives, fish positions snap from the
// old extrapolation to the new one. We lerp over BLEND_MS to hide the discontinuity.
const BLEND_MS = 250;
let _blendFrom = new Map(); // fishId → {x, y} at the moment the new snapshot arrived
let _blendStartMs = 0;
// The boat's telemetry is sparse (≤1 Hz) and dead-reckoned between snapshots, so
// it snaps when a new snapshot lands. Capture its predicted x at that moment and
// lerp to the new trajectory over BLEND_MS, exactly like the fish. null = no blend
// (first snapshot, or a relaunch teleport where sliding across would look wrong).
let _blendBoatFrom = null;

const els = {
  list: document.getElementById('aquarium-list'),
  emptyHint: document.getElementById('empty-hint'),
  viewEmpty: document.getElementById('view-empty'),
  viewContent: document.getElementById('view-content'),
  stats: document.getElementById('stats'),
  conn: document.getElementById('conn'),
  canvas: document.getElementById('tank'),
  viewName: document.getElementById('view-name'),
  viewSub: document.getElementById('view-sub'),
  viewDot: document.getElementById('view-dot'),
  legend: document.getElementById('legend'),
  conflictBar: document.getElementById('conflict-bar'),
  conflictDetail: document.getElementById('conflict-detail'),
  conflictServer: document.getElementById('conflict-server'),
  conflictLocal: document.getElementById('conflict-local'),
  controls: document.getElementById('controls'),
  ctrlWeather: document.getElementById('ctrl-weather'),
  ctrlTime: document.getElementById('ctrl-time'),
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
};
const ctx = els.canvas.getContext('2d');

// Shop prices (coins), mirroring the firmware/mock economy.
const FISH_PRICE = [10, 30, 45, 60];
const FOOD_PRICE = 5;
const SNAIL_PRICE = 50;
const MAX_SNAILS = 6;

// ─── Sidebar / list polling ────────────────────────────────────────────────
async function refreshList() {
  try {
    const res = await fetch('api/aquariums');
    const items = await res.json();
    renderList(items);
    setConn(true);
  } catch {
    setConn(false);
  }
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

// Forget an aquarium (stale device gone for good, or just decluttering). A live
// device re-appears on its next telemetry post.
async function removeAquarium(id, stale) {
  const msg = `Remove aquarium "${id}"?` + (stale
    ? '\n\nIt appears to be offline (stale).'
    : '\n\nIt is still reporting and will reappear on its next update.');
  if (!window.confirm(msg)) return;
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
    li.innerHTML = `
      <button class="aq-del" title="Remove this aquarium" aria-label="Remove aquarium">×</button>
      <div class="aq-name">
        <span class="dot ${a.stale ? 'stale' : 'live'}"></span>${escapeHtml(a.aquarium_id)}${a.conflict ? '<span class="aq-conflict">⚠ mismatch</span>' : ''}
      </div>
      <div class="aq-meta">${escapeHtml(a.platform)} · ${a.fishCount} fish · ${weather}</div>`;
    li.addEventListener('click', () => select(a.aquarium_id));
    li.querySelector('.aq-del').addEventListener('click', (e) => {
      e.stopPropagation();
      removeAquarium(a.aquarium_id, a.stale);
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
  _blendFrom.clear();
  _blendStartMs = 0;
  _blendBoatFrom = null;
  highlightedFishId = null;
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
  // proxy to when the device built the snapshot. Back-dating snapshotReceivedAt
  // to that point compensates for POST + SSE latency (~50–150 ms on LAN).
  const serverRx = (snap._lastSeenMs && snap._lastSeenMs <= now) ? snap._lastSeenMs : now;

  // Capture each fish's current predicted position before replacing the snapshot,
  // so we can blend smoothly from there to the new snapshot's trajectory.
  if (latestSnapshot) {
    const oldElapsed = Math.max(0, serverRx - snapshotReceivedAt);
    const prev = _extrapolateSnapshot(latestSnapshot, oldElapsed);
    _blendFrom.clear();
    for (const f of (prev.fish || [])) _blendFrom.set(f.id, { x: f.x, y: f.y });
    _blendStartMs = now;

    // Refresh scene-mover velocities from this snapshot interval (px/ms).
    const dt = Math.max(1, oldElapsed);
    _sceneVel = {
      snail: _obsVel(latestSnapshot.snail, snap.snail, dt),
      starfish: _obsVel(latestSnapshot.starfish, snap.starfish, dt),
      boat: (latestSnapshot.boat && snap.boat && latestSnapshot.boat.active && snap.boat.active)
        ? _obsVel(latestSnapshot.boat, snap.boat, dt) : 0,
    };

    // Capture the boat's predicted x to blend from. Only when it was (and stays)
    // active and the new position is close to the prediction — a large gap means
    // a relaunch from the far edge, where sliding across the tank looks worse than
    // a clean snap.
    _blendBoatFrom = null;
    if (prev.boat && snap.boat && prev.boat.active && snap.boat.active &&
        typeof prev.boat.x === 'number' && typeof snap.boat.x === 'number' &&
        Math.abs(prev.boat.x - snap.boat.x) < 120) {
      _blendBoatFrom = prev.boat.x;
    }
  }
  latestSnapshot = snap;
  snapshotReceivedAt = serverRx;
  // Legend, stats, and title update at telemetry rate (≤1 Hz) — cheap DOM work.
  drawTitle(snap);
  drawStats(snap);
  renderLegend(snap);
  renderConflict(snap);
  renderControls(snap);
  renderGame(snap);
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
// Single 60fps rAF loop: advances decorative animations (EAC, bubbles, sway via
// animTick), extrapolates fish positions between telemetry frames, and blends
// out the discontinuity at each snapshot boundary so motion stays smooth.
// Title/stats/legend update at SSE rate (≤1 Hz) from applySnapshot.
function _rafDraw() {
  rafId = requestAnimationFrame(_rafDraw);
  const now = Date.now();
  const prevTick = animTick;
  animTick = now / 50;            // device "tick" units (one per frame at 50ms)
  // Device-frames elapsed since the last rAF. Clamp so a backgrounded tab (large
  // gap) doesn't teleport the local sims when it resumes. All local animations are
  // advanced by this so they run at the device's 20fps cadence, not the browser's.
  const dframes = prevTick ? clamp(animTick - prevTick, 0, 5) : 1;
  tickEac(dframes);
  tickBubbles(dframes);
  eacBright = latestSnapshot
    ? dayTint(latestSnapshot.time && latestSnapshot.time.day_progress)
    : 0.5;
  if (!latestSnapshot) return;

  const elapsed = now - snapshotReceivedAt;
  const ext = _extrapolateSnapshot(latestSnapshot, elapsed);

  const blendAge = _blendStartMs ? now - _blendStartMs : BLEND_MS;
  if (blendAge >= BLEND_MS) { drawTank(ext); return; }

  // Smooth-step blend from the positions captured when this snapshot arrived.
  const r = blendAge / BLEND_MS;
  const sFac = r * r * (3 - 2 * r);
  const fish = ext.fish.map((f) => {
    const prev = _blendFrom.get(f.id);
    if (!prev) return f;
    return { ...f, x: prev.x + (f.x - prev.x) * sFac, y: prev.y + (f.y - prev.y) * sFac };
  });
  let boat = ext.boat;
  if (boat && _blendBoatFrom != null)
    boat = { ...boat, x: _blendBoatFrom + (boat.x - _blendBoatFrom) * sFac };
  drawTank({ ...ext, fish, boat });
}

// Full re-render (called on highlight toggle, etc.) — extrapolates fish to now.
function render() {
  if (!latestSnapshot) return;
  const elapsed = Date.now() - snapshotReceivedAt;
  const snap = _extrapolateSnapshot(latestSnapshot, elapsed);
  drawTitle(snap);
  drawTank(snap);
  drawStats(snap);
  renderLegend(latestSnapshot); // legend uses raw snapshot (names/ages, not positions)
}

// Legend: one row per fish, color-matched, with editable name, age, and
// click-to-highlight. Reconciled by fish id so live updates don't clobber a
// rename in progress.
function renderLegend(s) {
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
    const color = hex(f.color || 0x00ee66);
    row.swatchEl.style.background = color;
    row.el.style.borderLeftColor = color;
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
  return `pair ${c.pair || 0} · school ${c.school || 0}/${c.school2 || 0} · angel ${c.angel || 0}`;
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
      case 'time':
        if (snap.time && snap.time.mode === p.cmd.value) { p.confirmed = true; changed = true; }
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
  for (let t = 0; t < 4; t++) {
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

  // Timescale active button.
  if (now - _ctrlHold.time > CTRL_HOLD_MS) {
    const mode = (snap.time && snap.time.mode) || 'REAL';
    for (const b of els.ctrlTime.querySelectorAll('button')) {
      b.classList.toggle('active', b.dataset.mode === mode);
    }
  }

  // Fish counts + cap-aware enabling.
  if (!_fishRowsBuilt) buildFishControls();
  const counts = snap.counts || {};
  for (let t = 0; t < 4; t++) {
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
els.ctrlTime.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  _ctrlHold.time = Date.now();
  for (const b of els.ctrlTime.querySelectorAll('button')) b.classList.toggle('active', b === btn);
  const mode = btn.dataset.mode;
  sendControl({ type: 'time', value: mode }, `Timescale: ${mode} ✓`, { label: `Timescale: ${mode}` });
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
  els.hudCoins.textContent = '🪙 ' + (g.coins || 0);
  els.hudShells.textContent = '🐚 ' + (g.shells || 0);
  els.hudFood.textContent = '🍤 ' + (g.food || 0);
  els.hudSnails.textContent = '🐌 ' + ((snap.snails && snap.snails.length) || 0);
  els.hudLuck.textContent = '🍀 ' + Math.round((g.luck || 0) * 100) + '%';
  for (const el of [els.hudCoins, els.hudShells, els.hudFood, els.hudSnails, els.hudLuck])
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
  for (let t = 0; t < 4; t++) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'shop-buy'; b.dataset.type = String(t);
    b.innerHTML = `<span>🐟 ${escapeHtml(FISH_TYPE_NAMES[t])}</span><span class="price">${FISH_PRICE[t]} 🪙</span>`;
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

// ─── Catch: click a wandering fish or loot item on the canvas ─────────────────
els.canvas.addEventListener('click', (e) => {
  if (!latestSnapshot) return;
  const rect = els.canvas.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width * SCREEN_W;
  const y = (e.clientY - rect.top) / rect.height * SCREEN_H;
  let best = null, bestD = Infinity, bestKind = null;
  for (const w of (latestSnapshot.wanderers || [])) {
    const d = (w.x - x) ** 2 + (w.y - y) ** 2;
    if (d < bestD && d < 32 * 32) { bestD = d; best = w; bestKind = 'wanderer'; }
  }
  for (const it of (latestSnapshot.loot || [])) {
    const d = (it.x - x) ** 2 + (it.y - y) ** 2;
    if (d < bestD && d < 22 * 22) { bestD = d; best = it; bestKind = 'loot'; }
  }
  if (!best) return;
  sendControl({ type: 'catch', itemId: best.id },
    bestKind === 'wanderer' ? 'Caught a fish! 🎣'
      : (best.kind === 'coin' ? 'Grabbed a coin 🪙' : 'Grabbed a shell 🐚'));
  // Optimistic: remove locally so it vanishes at once; next snapshot reconciles.
  if (bestKind === 'wanderer')
    latestSnapshot.wanderers = (latestSnapshot.wanderers || []).filter((w) => w.id !== best.id);
  else
    latestSnapshot.loot = (latestSnapshot.loot || []).filter((it) => it.id !== best.id);
});

function drawTitle(s) {
  els.viewName.textContent = s.aquarium_id || selectedId || '—';
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

  drawSky(top, bright, cond, s);   // gradient + sun/moon + stars + clouds
  drawWater(top, bright);          // shimmering light bands
  drawBubbles(top);                // behind the sand bed → bubbles rise out of the substrate
  drawSand(bright);                // bumpy terrain bed
  if (s.boat && s.boat.active) drawBoat(s.boat.x, top); // behind the rim → sits slightly submerged
  drawRim(top, bright);            // metal frame + glass over the waterline (drawn over the boat)

  if (s.plants) {                  // back-to-front plant layers, each swaying
    drawBgPlants(s.plants, bright);
    drawSeaweed(s.plants, bright);
    drawFgHornwort(s.plants, bright);
  }

  drawEacZone(bright);             // background traffic silhouettes

  if (Array.isArray(s.fish)) {
    drawShadows(s.fish);
    // Far (deeper) fish first so nearer fish overlap them correctly.
    const ordered = s.fish.slice().sort((a, b) => (b.z || 0) - (a.z || 0));
    for (const f of ordered) drawFish(f);
  }

  if (Array.isArray(s.flakes)) for (const f of s.flakes) drawFlake(f);
  if (s.snail) drawSnail(s.snail);
  if (Array.isArray(s.snails)) for (const sn of s.snails) drawSnail(sn); // purchased coin collectors
  if (s.starfish) drawStarfish(s.starfish);

  // Career collectibles, drawn on top so they're clearly visible + tappable.
  if (Array.isArray(s.loot)) for (const it of s.loot) drawLoot(it);
  if (Array.isArray(s.wanderers)) for (const w of s.wanderers) drawWanderer(w);

  if (cond === 3 || cond === 4) drawRain(cond, bright);
  else if (cond === 5) drawSnow(bright);
}

// Fish are the device's signature ASCII glyphs, perspective-projected by depth.
function drawFish(f) {
  const type = f.type || 0, z = f.z || 0;
  const sx = projX(f.x, z), sy = projY(f.y, z);
  const ts = fishTS(f);
  const fontPx = Math.max(6, Math.round(9 * ts * growth(f)));
  const col = hex(f.color || 0x00ee66);
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
    ctx.fillStyle = f.id === highlightedFishId ? '#ffffff' : '#CCE6FF';
    ctx.fillText(f.name, sx, sy - fontPx * 0.8 - 6);
    ctx.restore();
  }
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
    ['Fish', String((c.pair || 0) + (c.school || 0) + (c.school2 || 0) + (c.angel || 0)),
      `pair ${c.pair || 0} · school ${c.school || 0}/${c.school2 || 0} · angel ${c.angel || 0}`],
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
refreshList(); // first load honours the hash via renderList's default selection
setInterval(refreshList, 5000);
startWatchdog();

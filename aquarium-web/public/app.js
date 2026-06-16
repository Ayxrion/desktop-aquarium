'use strict';

// All URLs are relative so the app works when served under the /aquarium/
// reverse-proxy prefix the deploy service configures.

const WEATHER_NAMES = ['Sunny', 'Partly Cloudy', 'Cloudy', 'Rainy', 'Stormy', 'Snowy', 'Foggy'];
const FISH_TYPE_NAMES = ['Pair', 'School', 'School 2', 'Angel'];
const TANK_TOP = 72;
const SCREEN_W = 800;
const SCREEN_H = 480;

// ─── Physics simulation (mirrors device updateFish, aquarium.ino / main.cpp) ──
const _DAMP  = 0.85;
const _DAMPZ = 0.88;

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
  if (!snap || !Array.isArray(snap.fish) || snap.fish.length === 0) return snap;
  const fm = snap.frame_ms || 50;
  const n  = Math.round(Math.min(elapsedMs, 2000) / fm);
  if (n === 0) return snap;

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

  const fishOut = snap.fish.map((orig, i) => ({
    ...orig,
    x: Math.round(st[i].x), y: Math.round(st[i].y), z: st[i].z,
    vx: st[i].vx, vy: st[i].vy,
    facing_right: st[i].facing_right,
  }));
  return { ...snap, fish: fishOut };
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
};
const ctx = els.canvas.getContext('2d');

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

function renderList(items) {
  els.emptyHint.hidden = items.length > 0;
  els.list.innerHTML = '';
  for (const a of items) {
    const li = document.createElement('li');
    if (a.aquarium_id === selectedId) li.className = 'active';
    const weather = a.weather ? (WEATHER_NAMES[a.weather.condition] || '?') : '—';
    li.innerHTML = `
      <div class="aq-name">
        <span class="dot ${a.stale ? 'stale' : 'live'}"></span>${escapeHtml(a.aquarium_id)}
      </div>
      <div class="aq-meta">${escapeHtml(a.platform)} · ${a.fishCount} fish · ${weather}</div>`;
    li.onclick = () => select(a.aquarium_id);
    els.list.appendChild(li);
  }
}

function select(id) {
  if (selectedId === id) return;
  selectedId = id;
  latestSnapshot = null;
  snapshotReceivedAt = 0;
  _blendFrom.clear();
  _blendStartMs = 0;
  highlightedFishId = null;
  legendRows.clear();
  els.legend.innerHTML = '';
  els.viewEmpty.hidden = true;
  els.viewContent.hidden = false;
  openStream(id);
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
    const oldElapsed = serverRx - snapshotReceivedAt;
    const oldFm = latestSnapshot.frame_ms || 50;
    _blendFrom.clear();
    for (const f of (latestSnapshot.fish || [])) {
      const p = _extrapolateFish(f, Math.max(0, oldElapsed), oldFm);
      _blendFrom.set(f.id, { x: p.x, y: p.y });
    }
    _blendStartMs = now;
  }
  latestSnapshot = snap;
  snapshotReceivedAt = serverRx;
  // Legend, stats, and title update at telemetry rate (≤1 Hz) — cheap DOM work.
  drawTitle(snap);
  drawStats(snap);
  renderLegend(snap);
  setConn(true);
  // Ensure the 60fps canvas loop is running.
  if (!rafId) rafId = requestAnimationFrame(_rafDraw);
}

// 60fps canvas-only loop — extrapolates fish positions between telemetry frames
// and blends out the discontinuity at each snapshot boundary.
function _rafDraw() {
  rafId = requestAnimationFrame(_rafDraw);
  if (!latestSnapshot) return;
  const now = Date.now();
  const elapsed = now - snapshotReceivedAt;
  const fm = latestSnapshot.frame_ms || 50;

  const blendAge = _blendStartMs ? now - _blendStartMs : BLEND_MS;
  if (blendAge >= BLEND_MS) {
    drawTank(_extrapolateSnapshot(latestSnapshot, elapsed));
    return;
  }
  // Smooth step: s goes 0→1 over BLEND_MS with ease-in-out curve.
  const s = (blendAge / BLEND_MS) ** 2 * (3 - 2 * (blendAge / BLEND_MS));
  const fish = latestSnapshot.fish.map((f) => {
    const ext = _extrapolateFish(f, elapsed, fm);
    const prev = _blendFrom.get(f.id);
    if (!prev) return ext;
    return {
      ...ext,
      x: Math.round(prev.x + (ext.x - prev.x) * s),
      y: Math.round(prev.y + (ext.y - prev.y) * s),
    };
  });
  drawTank({ ...latestSnapshot, fish });
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
let _frameCount = 0;

function eacSpawnFish(startX) {
  const bandH = EAC_Y2 - EAC_Y1;
  return {
    x: startX ?? Math.random() * SCREEN_W,
    y: EAC_Y1 + bandH * 0.1 + Math.random() * bandH * 0.8,
    speed: 0.35 + Math.random() * 0.55,
    size: 7 + Math.random() * 8,
    wobbleOff: Math.random() * Math.PI * 2,
  };
}

function updateEacCount(congestion) {
  eacTargetCount = Math.round(congestion * EAC_MAX_FISH);
}

function tickEac(frameCount) {
  while (eacFish.length < eacTargetCount) eacFish.push(eacSpawnFish(0));
  if (eacFish.length > eacTargetCount) eacFish.splice(eacTargetCount);

  const bandH = EAC_Y2 - EAC_Y1;
  for (const f of eacFish) {
    f.x += f.speed;
    // gentle vertical wobble within the band
    f.y = EAC_Y1 + bandH * 0.5 + Math.sin(frameCount * 0.018 + f.wobbleOff) * bandH * 0.3;
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
// Single 60fps rAF loop: ticks EAC animation and redraws the canvas with
// physics-extrapolated fish positions. Title/stats/legend update at SSE rate
// (≤1 Hz) from applySnapshot — no need to touch the DOM every frame.
function _rafDraw() {
  rafId = requestAnimationFrame(_rafDraw);
  eacBright = latestSnapshot
    ? dayTint(latestSnapshot.time && latestSnapshot.time.day_progress)
    : 0.5;
  tickEac(_frameCount++);
  if (!latestSnapshot) return;
  const elapsed = Date.now() - snapshotReceivedAt;
  drawTank(_extrapolateSnapshot(latestSnapshot, elapsed));
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
  const w = SCREEN_W, h = SCREEN_H, top = (s.screen && s.screen.tank_top) || TANK_TOP;
  const bright = dayTint(s.time && s.time.day_progress);

  // Sky strip (weather-tinted, dimmed by time of day)
  const skyCols = ['#1a78c8', '#2288cc', '#556677', '#334455', '#111827', '#8090a0', '#7a8a98'];
  const cond = (s.weather && s.weather.condition) || 0;
  ctx.fillStyle = shade(skyCols[cond] || '#1a78c8', bright);
  ctx.fillRect(0, 0, w, top);

  // Water
  const grd = ctx.createLinearGradient(0, top, 0, h);
  grd.addColorStop(0, shade('#0a4a80', bright));
  grd.addColorStop(1, shade('#022038', bright));
  ctx.fillStyle = grd;
  ctx.fillRect(0, top, w, h - top);

  // Sand floor
  ctx.fillStyle = shade('#c8a050', bright);
  ctx.fillRect(0, h - 40, w, 40);

  // Plants (static decor) as simple stems
  if (s.plants) {
    ctx.strokeStyle = shade('#1f8a3a', bright);
    ctx.lineWidth = 3;
    for (const grp of [s.plants.bg, s.plants.weeds, s.plants.hornwort]) {
      if (!Array.isArray(grp)) continue;
      for (const p of grp) {
        const segs = p.segs || 5;
        ctx.beginPath();
        ctx.moveTo(p.x, h - 40);
        ctx.lineTo(p.x, h - 40 - segs * 13);
        ctx.stroke();
      }
    }
  }

  // Food flakes
  if (Array.isArray(s.flakes)) {
    for (const f of s.flakes) {
      ctx.fillStyle = hex(f.color || 0xffaa22);
      ctx.beginPath();
      ctx.arc(f.x, f.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // EAC silhouette fish (background layer, before foreground fish)
  drawEacZone(bright);

  // Fish
  if (Array.isArray(s.fish)) {
    for (const f of s.fish) drawFish(f);
  }

  // Snail / starfish on the floor
  if (s.snail) drawMarker(s.snail.x, h - 46, '#b8946a', 7);
  if (s.starfish) drawMarker(s.starfish.x, h - 44, '#ff7755', 8);

  // Boat on the rim
  if (s.boat && s.boat.active) {
    ctx.fillStyle = '#caa05a';
    ctx.fillRect(s.boat.x, top - 14, 40, 12);
  }
}

function drawFish(f) {
  const size = f.type === 3 ? 16 : f.type === 0 ? 13 : 10; // angel bigger, school smaller

  // Highlight ring + name label for the legend-selected fish.
  if (f.id === highlightedFishId) {
    ctx.save();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.arc(f.x, f.y, size + 9, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  if (f.name) {
    ctx.save();
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = f.id === highlightedFishId ? '#ffffff' : 'rgba(230,240,255,0.85)';
    ctx.fillText(f.name, f.x, f.y - size - 8);
    ctx.restore();
  }

  const dir = f.facing_right ? 1 : -1;
  ctx.save();
  ctx.translate(f.x, f.y);
  ctx.scale(dir, 1);
  ctx.fillStyle = hex(f.color || 0x00ee66);
  // body
  ctx.beginPath();
  ctx.ellipse(0, 0, size, size * 0.55, 0, 0, Math.PI * 2);
  ctx.fill();
  // tail
  ctx.beginPath();
  ctx.moveTo(-size, 0);
  ctx.lineTo(-size - size * 0.7, -size * 0.5);
  ctx.lineTo(-size - size * 0.7, size * 0.5);
  ctx.closePath();
  ctx.fill();
  // food indicator
  if (f.going_for_food) {
    ctx.fillStyle = '#ffee44';
    ctx.beginPath();
    ctx.arc(size * 0.5, -size * 0.4, 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawMarker(x, y, color, r) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
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
refreshList();
setInterval(refreshList, 5000);
startWatchdog();

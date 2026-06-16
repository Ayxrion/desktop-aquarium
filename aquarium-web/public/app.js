'use strict';

// All URLs are relative so the app works when served under the /aquarium/
// reverse-proxy prefix the deploy service configures.

const WEATHER_NAMES = ['Sunny', 'Partly Cloudy', 'Cloudy', 'Rainy', 'Stormy', 'Snowy', 'Foggy'];
const FISH_TYPE_NAMES = ['Pair', 'School', 'School 2', 'Angel'];
const TANK_TOP = 72;
const SCREEN_W = 800;
const SCREEN_H = 480;

let selectedId = null;
let stream = null;
let latest = null; // latest snapshot for the selected aquarium
let lastSnapshotMs = 0; // when we last received any snapshot (SSE or poll)

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
  latest = null;
  lastSnapshotMs = 0;
  els.viewEmpty.hidden = true;
  els.viewContent.hidden = false;
  openStream(id);
  refreshList();
}

function applySnapshot(snap) {
  latest = snap;
  lastSnapshotMs = Date.now();
  render();
  setConn(true);
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
    if (Date.now() - lastSnapshotMs > 4000) pollSelected();
  }, 2000);
}

// ─── EAC silhouette fish ─────────────────────────────────────────────────────
// Horizontal current band across the mid-tank. Fish drift left to right.
const EAC_Y1 = 180, EAC_Y2 = 270;   // horizontal band (mid-tank)
const EAC_MAX_FISH = 12;
const EAC_MIN_FISH = 2;             // always visible even at 0 congestion

let eacFish = [];
let eacTargetCount = 0;

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
  eacTargetCount = EAC_MIN_FISH + Math.round(congestion * (EAC_MAX_FISH - EAC_MIN_FISH));
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
  ctx.save();
  ctx.globalAlpha = 0.28 * bright + 0.10;
  ctx.fillStyle = '#7a9db8';  // light blue-gray, reads as pale silhouette on dark water
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

// RAF loop — runs independently of snapshot delivery
let _frameCount = 0;
function eacLoop() {
  eacBright = latest ? dayTint(latest.time && latest.time.day_progress) : 0.5;
  tickEac(_frameCount++);
  if (latest) {
    // Redraw only the tank layer (title/stats don't need per-frame updates)
    drawTank(latest);
  }
  requestAnimationFrame(eacLoop);
}
requestAnimationFrame(eacLoop);

// ─── Rendering ───────────────────────────────────────────────────────────────
function render() {
  if (!latest) return;
  drawTitle(latest);
  drawTank(latest);
  drawStats(latest);
}

function drawTitle(s) {
  els.viewName.textContent = s.aquarium_id || selectedId || '—';
  const weather = s.weather ? (WEATHER_NAMES[s.weather.condition] || '') : '';
  els.viewSub.textContent = [s.platform, s.fw_version ? 'fw ' + s.fw_version : '', weather]
    .filter(Boolean)
    .join(' · ');
  const stale = s._stale || Date.now() - lastSnapshotMs > 8000;
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

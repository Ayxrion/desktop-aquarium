'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const store = require('./store');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const INDEX_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');

const traffic = require('./traffic');

const PORT = parseInt(process.env.PORT || '3000', 10);
const API_KEY = process.env.API_KEY || '';

if (!API_KEY) {
  console.error('FATAL: API_KEY env var is required (shared secret for telemetry ingest).');
  process.exit(1);
}

if (!traffic.hasKey()) {
  console.warn('WARN: TOMTOM_API_KEY not set — /api/traffic will return 503.');
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

// ─── Health ────────────────────────────────────────────────────────────────
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// ─── Telemetry ingest ────────────────────────────────────────────────────────
function checkKey(req) {
  const header = req.get('x-api-key');
  if (header && header === API_KEY) return true;
  const auth = req.get('authorization') || '';
  if (auth.startsWith('Bearer ') && auth.slice(7) === API_KEY) return true;
  return false;
}

app.post('/api/telemetry', (req, res) => {
  if (!checkKey(req)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const body = req.body;
  if (!body || typeof body !== 'object' || typeof body.aquarium_id !== 'string' || !body.aquarium_id) {
    return res.status(400).json({ ok: false, error: 'aquarium_id required' });
  }
  const result = store.upsert(body);
  if (!result.ok) return res.status(429).json(result);
  // Downstream channel (no inbound firewall needed): the device's own POST gets
  // the current fish names back as a compact `id\tname` per line body. The
  // device applies these and renders them above each fish.
  res.type('text/plain').send(store.getNamesText(body.aquarium_id));
});

// Rename a fish (from the dashboard). Body: { name }. Empty name clears it.
// Open like the read APIs — the dashboard has no API key.
app.post('/api/aquariums/:id/fish/:fishId/name', (req, res) => {
  const fishId = parseInt(req.params.fishId, 10);
  if (!Number.isInteger(fishId) || fishId < 0) {
    return res.status(400).json({ ok: false, error: 'bad_fish_id' });
  }
  const result = store.setName(req.params.id, fishId, (req.body && req.body.name) ?? '');
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

// ─── Traffic ZIP config (persisted to disk across restarts) ──────────────────
const ZIP_FILE = path.join(__dirname, '..', 'data', 'traffic_zip.json');

function _loadZip() {
  try { return JSON.parse(fs.readFileSync(ZIP_FILE, 'utf8')).zip || ''; } catch { return ''; }
}
function _saveZip(zip) {
  try {
    fs.mkdirSync(path.dirname(ZIP_FILE), { recursive: true });
    fs.writeFileSync(ZIP_FILE, JSON.stringify({ zip }));
  } catch (e) { console.warn('Could not persist traffic ZIP:', e.message); }
}

let activeZip = _loadZip() || (process.env.TRAFFIC_ZIP || '');

app.get('/api/traffic/zip', (_req, res) => res.json({ ok: true, zip: activeZip }));

app.post('/api/traffic/zip', (req, res) => {
  const zip = typeof req.body?.zip === 'string' ? req.body.zip.trim() : '';
  if (!/^\d{5}$/.test(zip)) {
    return res.status(400).json({ ok: false, error: 'zip must be a 5-digit US zip code' });
  }
  activeZip = zip;
  _saveZip(zip);
  return res.json({ ok: true, zip });
});

// Used by the ESP — returns congestion for the server-configured ZIP.
app.get('/api/traffic/current', async (_req, res) => {
  if (!activeZip) return res.status(404).json({ ok: false, error: 'no zip configured' });
  if (!traffic.hasKey()) return res.status(503).json({ ok: false, error: 'TOMTOM_API_KEY not configured' });
  try {
    const result = await traffic.fetchFlow(activeZip);
    return res.json({ ok: true, zip: activeZip, ...result });
  } catch (err) {
    console.error('traffic fetch error:', err.message);
    return res.status(502).json({ ok: false, error: err.message });
  }
});

// ─── Traffic (browser — explicit zip) ────────────────────────────────────────
app.get('/api/traffic', async (req, res) => {
  const zip = typeof req.query.zip === 'string' ? req.query.zip.trim() : '';
  if (!/^\d{5}$/.test(zip)) {
    return res.status(400).json({ ok: false, error: 'zip must be a 5-digit US zip code' });
  }
  if (!traffic.hasKey()) {
    return res.status(503).json({ ok: false, error: 'TOMTOM_API_KEY not configured' });
  }
  try {
    const result = await traffic.fetchFlow(zip);
    return res.json({ ok: true, zip, ...result });
  } catch (err) {
    console.error('traffic fetch error:', err.message);
    return res.status(502).json({ ok: false, error: err.message });
  }
});

// ─── Device bootstrap ────────────────────────────────────────────────────────
// Called by a device on boot (before it starts posting telemetry) to restore
// the last-known aquarium state: fish positions, velocities, wander targets,
// and names. Requires the API key so only the device itself can read its state.
// Returns { exists: false } when no prior record exists (first boot).
app.get('/api/aquariums/:id/bootstrap', (req, res) => {
  if (!checkKey(req)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const data = store.bootstrap(req.params.id);
  if (!data) return res.json({ exists: false });
  return res.json(data);
});

// Resolve a profile conflict from the dashboard (open like the rename API).
// Body: { choice: 'local' | 'server' }.
app.post('/api/aquariums/:id/resolve', (req, res) => {
  const choice = req.body && req.body.choice;
  if (choice !== 'local' && choice !== 'server') {
    return res.status(400).json({ ok: false, error: 'choice must be "local" or "server"' });
  }
  const result = store.resolveConflict(req.params.id, choice);
  if (!result.ok) return res.status(404).json(result);
  return res.json(result);
});

// Dashboard control: buffer a directive for the device's next telemetry response.
// Open like the other dashboard APIs (the dashboard holds no API key). Body:
//   { type:'weather', value:-1..6 }
//   { type:'time', value:'REAL'|'FAST' }            (legacy)
//   { type:'timescale', value:1..5 }                (simulation speed multiplier)
//   { type:'fish', action:'add'|'remove', fishType:0..4, count?:1 }
//   { type:'feed', count?:1 }
//   { type:'mode', value:'creative'|'career' }
//   { type:'catch', itemId:<number> }                  (wanderer/loot id)
//   { type:'buy', what:'fish', fishType:0..4, count?:1 } | { what:'food', count?:1 }
app.post('/api/aquariums/:id/control', (req, res) => {
  const result = store.queueControl(req.params.id, req.body || {});
  if (!result.ok) return res.status(400).json(result);
  return res.json(result);
});

// Remove an aquarium from the dashboard (open like the other dashboard APIs). A
// live device re-creates it on its next POST; a stale one stays gone.
app.delete('/api/aquariums/:id', (req, res) => {
  return res.json(store.remove(req.params.id));
});

// ─── Aquarium management (open like the other dashboard APIs) ──────────────────
// Create a brand-new aquarium. It has no physical device, so the server runs it as a
// visual web simulation right away. Body: { name? }. Returns the new aquarium id.
app.post('/api/aquariums', (req, res) => {
  const result = store.createAquarium((req.body && req.body.name) || '');
  if (!result.ok) return res.status(429).json(result);
  return res.json(result);
});

// Rename an aquarium (display name only — the id/slug is immutable). Body: { name }.
app.patch('/api/aquariums/:id', (req, res) => {
  const result = store.renameAquarium(req.params.id, (req.body && req.body.name) ?? '');
  if (!result.ok) return res.status(404).json(result);
  return res.json(result);
});

// ─── Device registry (read + manage physical Pi/ESP hardware) ──────────────────
// Devices appear here only when real hardware self-registers via telemetry; the
// dashboard can rename one, point it at a different aquarium, or forget a stale one.
// (There is no "create device" route — virtual devices were removed in favour of the
// always-on server web simulation for any aquarium without live hardware.)
app.get('/api/devices', (_req, res) => res.json(store.listDevices()));
app.patch('/api/devices/:id', (req, res) => {
  const d = store.updateDevice(req.params.id, req.body || {});
  if (!d) return res.status(404).json({ ok: false, error: 'not_found' });
  return res.json({ ok: true, device: d });
});
app.delete('/api/devices/:id', (req, res) => {
  return res.json({ ok: store.removeDevice(req.params.id) });
});

// ─── Read APIs ───────────────────────────────────────────────────────────────
app.get('/api/aquariums', (_req, res) => res.json(store.list()));

app.get('/api/aquariums/:id', (req, res) => {
  const snap = store.get(req.params.id);
  if (!snap) return res.status(404).json({ ok: false, error: 'not_found' });
  return res.json(snap);
});

// ─── SSE stream ──────────────────────────────────────────────────────────────
// Pushes each new snapshot to connected browsers. `?id=` scopes to one aquarium.
app.get('/api/stream', (req, res) => {
  const scopeId = typeof req.query.id === 'string' ? req.query.id : null;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Disable proxy buffering (nginx) so events flush immediately through the
    // reverse proxy the deploy service sets up.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write('retry: 3000\n\n');

  const send = (snapshot) => {
    if (scopeId && snapshot.aquarium_id !== scopeId) return;
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
  };
  const unsubscribe = store.subscribe(send);

  // Prime the client with current state so it renders without waiting a cycle.
  if (scopeId) {
    const snap = store.get(scopeId);
    if (snap) res.write(`event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`);
  }

  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 20000);

  req.on('close', () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
});

// ─── Dashboard (prefix-aware) ────────────────────────────────────────────────
// Inject a <base href> derived from X-Forwarded-Prefix so the page's relative
// asset/API URLs resolve correctly when served under a reverse-proxy sub-path
// (e.g. /aquarium/) — and regardless of whether the URL had a trailing slash.
function sendIndex(req, res) {
  const prefix = (req.get('x-forwarded-prefix') || '').replace(/\/+$/, '');
  const base = prefix ? `${prefix}/` : '/';
  res.type('html').send(INDEX_HTML.replace('<head>', `<head>\n  <base href="${base}">`));
}
app.get(['/', '/index.html'], sendIndex);

// Other static assets (app.js, styles.css). After strip_prefix, these arrive at
// their bare paths (/app.js, /styles.css) and are served from public/.
app.use(express.static(PUBLIC_DIR));

const deviceManager = require('./deviceManager');

app.listen(PORT, () => {
  console.log(`aquarium-web listening on :${PORT} (stale after ${store.STALE_MS}ms)`);
  deviceManager.start();   // web-simulate every aquarium without live hardware (always-on)
});

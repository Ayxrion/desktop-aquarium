'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const store = require('./store');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const INDEX_HTML = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');

const PORT = parseInt(process.env.PORT || '3000', 10);
const API_KEY = process.env.API_KEY || '';

if (!API_KEY) {
  // Refuse to run wide open — a publicly-routed ingest endpoint must have a key.
  console.error('FATAL: API_KEY env var is required (shared secret for telemetry ingest).');
  process.exit(1);
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

app.listen(PORT, () => {
  console.log(`aquarium-web listening on :${PORT} (stale after ${store.STALE_MS}ms)`);
});

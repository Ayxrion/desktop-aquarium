'use strict';

const path = require('path');
const express = require('express');
const store = require('./store');

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
  return res.json({ ok: true });
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

// ─── Static dashboard ──────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(PORT, () => {
  console.log(`aquarium-web listening on :${PORT} (stale after ${store.STALE_MS}ms)`);
});

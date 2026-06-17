'use strict';

// File-based persistence for aquarium snapshots and fish names.
//
// Each aquarium is stored as a single JSON file: data/aquariums/<id>.json
// Writes are atomic (write temp file → rename) so a crash mid-write doesn't
// corrupt existing state. No external dependencies required.
//
// File format:
// {
//   "id": "living-room",
//   "createdAt": 1718540000000,
//   "lastSeenMs": 1718540100000,
//   "names": { "0": "Nemo", "3": "Bubbles" },
//   "snapshot": { ...full telemetry snapshot... }
// }

const fs   = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR ||
  path.join(__dirname, '..', 'data', 'aquariums');

function _ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Devices live in a single JSON file in the parent data dir (kept OUT of the
// aquariums dir so loadAll() doesn't treat it as an aquarium).
const DEVICES_FILE = path.join(DATA_DIR, '..', 'devices.json');

function loadDevices() {
  try { return JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8')); }
  catch { return []; }
}
function saveDevices(devices) {
  try {
    fs.mkdirSync(path.dirname(DEVICES_FILE), { recursive: true });
    const tmp = DEVICES_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(devices), 'utf8');
    fs.renameSync(tmp, DEVICES_FILE);
  } catch (err) { console.warn(`DB: failed to write devices: ${err.message}`); }
}

function _filePath(id) {
  // Sanitize id to prevent directory traversal: keep only safe chars.
  const safe = id.replace(/[^a-zA-Z0-9_\-]/g, '_');
  return path.join(DATA_DIR, `${safe}.json`);
}

function _read(id) {
  try {
    return JSON.parse(fs.readFileSync(_filePath(id), 'utf8'));
  } catch {
    return null;
  }
}

// Atomic write: write to .tmp then rename so readers never see a partial file.
function _write(id, data) {
  _ensureDir();
  const file = _filePath(id);
  const tmp  = file + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    console.warn(`DB: failed to write ${file}: ${err.message}`);
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Persist a new/updated snapshot alongside current names. */
function saveSnapshot(aquariumId, snapshot, lastSeenMs, createdAt, names) {
  const existing = _read(aquariumId) || {};
  _write(aquariumId, {
    id: aquariumId,
    createdAt: existing.createdAt || createdAt,
    lastSeenMs,
    names: existing.names || {},
    snapshot,
  });
}

/** Delete an aquarium's persisted file (no-op if it was never saved). */
function deleteAquarium(aquariumId) {
  try { fs.unlinkSync(_filePath(aquariumId)); } catch { /* already absent */ }
}

/** Persist a fish name change (empty string removes the entry). */
function saveName(aquariumId, fishId, name) {
  const data = _read(aquariumId);
  if (!data) return; // no snapshot yet — names will be written on next upsert
  if (!data.names) data.names = {};
  if (!name) delete data.names[String(fishId)];
  else data.names[String(fishId)] = name;
  _write(aquariumId, data);
}

/**
 * Load all persisted aquariums on startup.
 * Returns an array of { id, snapshot, lastSeenMs, createdAt, names: Map<fishId,name> }.
 */
function loadAll() {
  _ensureDir();
  let files;
  try { files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json') && !f.endsWith('.tmp')); }
  catch { return []; }

  const results = [];
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
      if (!data || !data.snapshot) continue;
      const names = new Map(Object.entries(data.names || {}).map(([k, v]) => [parseInt(k, 10), v]));
      results.push({
        id: data.id,
        snapshot: data.snapshot,
        lastSeenMs: data.lastSeenMs || 0,
        createdAt: data.createdAt || data.lastSeenMs || 0,
        names,
      });
    } catch { /* corrupt file — skip */ }
  }
  return results;
}

/**
 * Load a single aquarium's last snapshot + names for the bootstrap endpoint.
 * Returns null if no record exists.
 */
function loadOne(aquariumId) {
  const data = _read(aquariumId);
  if (!data || !data.snapshot) return null;
  const names = new Map(Object.entries(data.names || {}).map(([k, v]) => [parseInt(k, 10), v]));
  return {
    snapshot: data.snapshot,
    lastSeenMs: data.lastSeenMs || 0,
    createdAt: data.createdAt || data.lastSeenMs || 0,
    names,
  };
}

module.exports = { saveSnapshot, saveName, deleteAquarium, loadAll, loadOne, loadDevices, saveDevices };

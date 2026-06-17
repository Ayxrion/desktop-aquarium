'use strict';

// Always-on runner for VIRTUAL devices. Each virtual device (store.kind === 'virtual')
// that has an assigned aquarium gets an in-process simulator (src/sim.js) ticked ~1Hz:
// step() → telemetry snapshot → store.upsert() (exactly as a physical device would POST),
// then the device's queued control directives are drained + applied. Physical Pi/ESP
// devices run their own firmware and are NOT ticked here (they self-register via telemetry).
//
// State reconciles against the store every tick, so create/assign/reassign/delete done
// through the store are picked up automatically (no tight coupling):
//   - new virtual device with an aquarium  → spawn a sim (seeded from that aquarium's
//     saved snapshot, so it RESUMES rather than resets — also covers server restart)
//   - device's aquariumId changed          → rebind the sim to the new aquarium
//   - device unassigned / removed          → drop its sim

const store = require('./store');
const { createSim } = require('./sim');

const TICK_MS = 1000;
const sims = new Map(); // deviceId -> { sim, aquariumId }
let timer = null;

function tickOnce() {
  let virtual;
  try { virtual = store.listDevices().filter((d) => d.kind === 'virtual'); }
  catch { return; }

  const seen = new Set();
  for (const d of virtual) {
    seen.add(d.id);
    if (!d.aquariumId) { sims.delete(d.id); continue; } // idle until assigned an aquarium

    let inst = sims.get(d.id);
    if (!inst || inst.aquariumId !== d.aquariumId) {
      // (Re)bind to this aquarium, resuming from its persisted state if it exists.
      const saved = store.get(d.aquariumId);
      inst = { sim: createSim({ aquariumId: d.aquariumId, restoreSnapshot: saved }), aquariumId: d.aquariumId };
      sims.set(d.id, inst);
    }

    try {
      const snap = inst.sim.step();
      snap.device_id = d.id;
      snap.device_name = d.name;
      store.upsert(snap);
      inst.sim.applyDirectives(store.getNamesText(d.aquariumId));
    } catch (err) {
      console.warn(`deviceManager: tick failed for ${d.id}: ${err.message}`);
    }
  }
  // Drop sims for devices that were removed or became non-virtual.
  for (const id of [...sims.keys()]) if (!seen.has(id)) sims.delete(id);
}

function start() {
  if (timer) return;
  timer = setInterval(tickOnce, TICK_MS);
  if (timer.unref) timer.unref();
  console.log('deviceManager: virtual-device tick loop started');
}
function stop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { start, stop };

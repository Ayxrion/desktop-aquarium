'use strict';

// Always-on web simulator for aquariums that have NO live physical device.
//
// Every aquarium the store knows about (dashboard-created or persisted) is run by an
// in-process simulator (src/sim.js) ticked ~1Hz: step() → telemetry snapshot →
// store.upsert() (exactly as a physical device would POST), then the aquarium's queued
// control directives are drained + applied. The simulated snapshot carries NO device_id,
// so it never registers as a device — it's purely the server's "visual web simulation".
//
// Whenever a real Pi/ESP is live on an aquarium (it self-registers via telemetry and
// store.hasLiveDevice() is true), the simulator steps aside and lets the hardware drive.
//
// State reconciles against the store every tick, so create/rename/delete and a device
// coming online/offline are all picked up automatically (no tight coupling):
//   - new aquarium with no live device  → spawn a sim (seeded from its saved snapshot,
//     so it RESUMES rather than resets — also covers server restart)
//   - a device comes online for a tank   → drop that tank's sim (hardware takes over)
//   - aquarium removed                    → drop its sim

const store = require('./store');
const { createSim } = require('./sim');

const TICK_MS = 1000;
const sims = new Map(); // aquariumId -> { sim }
let timer = null;

function tickOnce() {
  let ids;
  try { ids = store.aquariumIds(); }
  catch { return; }

  const seen = new Set();
  for (const id of ids) {
    // A live physical device owns this tank → let the hardware drive it.
    if (store.hasLiveDevice(id)) { sims.delete(id); continue; }
    seen.add(id);

    let inst = sims.get(id);
    if (!inst) {
      // Resume from the aquarium's persisted/last state if it has one.
      const saved = store.get(id);
      inst = { sim: createSim({ aquariumId: id, restoreSnapshot: saved }) };
      sims.set(id, inst);
    }

    try {
      const snap = inst.sim.step();   // no device_id — this is a server-side web simulation
      store.upsert(snap);
      inst.sim.applyDirectives(store.getNamesText(id));
    } catch (err) {
      console.warn(`deviceManager: sim tick failed for ${id}: ${err.message}`);
    }
  }
  // Drop sims for aquariums that were removed or taken over by hardware.
  for (const id of [...sims.keys()]) if (!seen.has(id)) sims.delete(id);
}

function start() {
  if (timer) return;
  timer = setInterval(tickOnce, TICK_MS);
  if (timer.unref) timer.unref();
  console.log('deviceManager: web-simulation tick loop started');
}
function stop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { start, stop };

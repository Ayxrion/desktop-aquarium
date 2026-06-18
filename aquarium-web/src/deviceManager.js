'use strict';

// Always-on web simulator for dashboard-created aquariums with NO assigned device.
//
// Tanks bound to a physical Pi/ESP (even when offline) keep their last device
// snapshot — the sim does not take over when hardware stops reporting.
//
// In-process simulator (src/sim.js) ticked ~1Hz: step() → telemetry snapshot →
// store.upsert() (exactly as a physical device would POST), then the aquarium's queued
// control directives are drained + applied. The simulated snapshot carries NO device_id,
// so it never registers as a device — it's purely the server's "visual web simulation".
//
// Whenever a real Pi/ESP is live on an aquarium (store.hasLiveDevice() is true), the
// simulator steps aside and lets the hardware drive.
//
// State reconciles against the store every tick:
//   - new aquarium with no assigned device  → spawn a sim
//   - a device comes online for a tank       → drop that tank's sim (hardware takes over)
//   - assigned device goes offline             → drop sim; hold last snapshot
//   - aquarium removed                       → drop its sim

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
    // Live hardware owns this tank → let the device drive it.
    if (store.hasLiveDevice(id)) { sims.delete(id); continue; }
    // Assigned but offline → hold the last snapshot; do not web-simulate.
    if (!store.shouldWebSimulate(id)) { sims.delete(id); continue; }
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

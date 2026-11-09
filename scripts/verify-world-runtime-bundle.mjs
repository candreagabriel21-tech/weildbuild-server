/**
 * verify-world-runtime-bundle.mjs — pass 28: end-to-end server proof.
 *
 * Boots the REAL world-runtime bundle (dist/gamehost/world-runtime.bundle.js
 * — the single esbuild file the gamehost spawns per game instance, with
 * the Rapier wasm inlined) in a worker thread, sends the real 'init'
 * protocol message with a minimal world (baseplate + a Spawn part + an
 * unanchored block high above it), waits for 'ready', then reads live
 * snapshots and asserts the unanchored part actually FALLS — the
 * authoritative server simulation running the ported Rapier engine,
 * exactly as it will in production.
 *
 * Run:  node scripts/verify-world-runtime-bundle.mjs   (from server/,
 *       after node scripts/build-world-runtime.mjs)
 */
import { Worker } from 'node:worker_threads';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const bundle = join(here, '..', 'dist', 'gamehost', 'world-runtime.bundle.js');
if (!existsSync(bundle)) {
  console.error('✗ bundle missing — run node scripts/build-world-runtime.mjs first');
  process.exit(1);
}

const mkPart = (over) => ({
  name: over.id, type: 'Block', position: { x: 0, y: 0, z: 0 }, size: { x: 1, y: 1, z: 1 },
  rotation: { x: 0, y: 0, z: 0 }, color: '#888888', material: 'Plastic', transparency: 0,
  reflectance: 0, anchored: false, canCollide: true, bodyMovers: [], ...over,
});

const studioState = {
  objects: [
    mkPart({ id: 'baseplate', position: { x: 0, y: -0.5, z: 0 }, size: { x: 256, y: 1, z: 256 }, anchored: true }),
    mkPart({ id: 'spawn', position: { x: 0, y: 0.5, z: 5 }, size: { x: 4, y: 1, z: 4 }, anchored: true, isSpawnPoint: true }),
    mkPart({ id: 'faller', position: { x: 0, y: 12, z: 0 } }),
  ],
  joints: [], treeInstances: [], waterBodies: [], terrainLayers: [],
  globalTimers: [], globalVariables: {}, avatar: {},
};

const timeout = setTimeout(() => {
  console.error('✗ worker did not produce a falling part within 15 s');
  process.exit(1);
}, 15000);

const worker = new Worker(bundle);
let ready = false;
let firstY = null;
let lastY = null;
let lastSeq = 0;

worker.on('message', (m) => {
  if (m?.t === 'ready') {
    ready = true;
    console.log(`✓ worker ready (parts: ${m.parts}, spawn: ${JSON.stringify(m.spawn)})`);
    // The sim PAUSES with zero players (v6.2.2 empty-instance pause) -
    // join one like world-sims does right after ready.
    worker.postMessage({ t: 'playerJoin', socketId: 'p1', username: 'Tester' });
    return;
  }
  if (m?.t === 'snapshot') {
    lastSeq = m.seq;
    // Changed part transforms ride snap.parts as { id, x, y, z, rx, ry, rz }
    // (partUpdates is the rule-driven full-record channel).
    for (const u of m.parts ?? []) {
      if (u.id === 'faller' && typeof u.y === 'number') {
        if (firstY === null) firstY = u.y;
        lastY = u.y;
      }
    }
    // Snapshots ride a periodic tick; give it ~4 s of sim time.
    if (lastY !== null && lastY < 2.0) {
      console.log(`✓ authoritative sim is stepping: 'faller' dropped ${firstY.toFixed(1)} -> ${lastY.toFixed(1)} (snapshots up to seq ${lastSeq})`);
      if (firstY - lastY < 9) {
        console.error('✗ the part moved less than expected — physics may not be running at full gravity');
        clearTimeout(timeout);
        worker.terminate();
        process.exit(1);
      }
      console.log('✓ world-runtime bundle (Rapier inlined) runs end-to-end in a worker thread');
      clearTimeout(timeout);
      worker.terminate();
      process.exit(0);
    }
  }
});

worker.on('error', (e) => {
  console.error('✗ worker crashed:', e.message);
  clearTimeout(timeout);
  process.exit(1);
});

worker.on('exit', (code) => {
  if (code !== 0 && code !== 1) {
    console.error(`✗ worker exited with code ${code}`);
    process.exit(1);
  }
});

worker.postMessage({ t: 'init', studioState, maxPlayers: 8 });

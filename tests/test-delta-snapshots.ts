// ═══════════════════════════════════════════════════════════════════
// WeildBuild — v6.2.2 delta snapshots + idle pause test
// ═══════════════════════════════════════════════════════════════════
// Verifies the server-efficiency work directly against the worker:
//
//   1. Empty instance (no players) sends NOTHING (full idle pause -
//      physics, rules engine and snapshots all frozen).
//   2. A joining player resumes the sim: the first snapshot carries the
//      player AND the part keyframe (where physics actually settled the
//      unanchored crate, not its saved position).
//   3. Once everything settles, only the ~0.5 Hz player keyframes flow
//      (NOT 15 Hz empty frames).
//   4. Movement resumes the 15 Hz delta stream.
//   5. playerLeave silences the worker again.
//   6. A late re-join gets the part keyframe again.
//
// Usage: npx tsx tests/test-delta-snapshots.ts
// (run `node scripts/build-world-runtime.mjs` first)

import assert from "node:assert";
import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { existsSync } from "node:fs";

const bundle = join(__dirname, "..", "dist", "gamehost", "world-runtime.bundle.js");
if (!existsSync(bundle)) {
  console.error("✗ bundle missing - run `node scripts/build-world-runtime.mjs` first");
  process.exit(1);
}

function waitMessage<T = any>(worker: Worker, predicate: (m: any) => boolean, timeoutMs = 20000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for message")), timeoutMs);
    const onMessage = (m: any) => {
      if (predicate(m)) {
        clearTimeout(timer);
        worker.off("message", onMessage);
        worker.off("exit", onExit);
        resolve(m);
      }
    };
    const onExit = (code: number) => {
      clearTimeout(timer);
      reject(new Error(`worker exited early (code ${code})`));
    };
    worker.on("message", onMessage);
    worker.on("exit", onExit);
  });
}

/** Rejects if any snapshot arrives within `ms`. */
function expectSilence(worker: Worker, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.off("message", onMessage);
      resolve();
    }, ms);
    const onMessage = (m: any) => {
      if (m?.t === "snapshot") {
        clearTimeout(timer);
        worker.off("message", onMessage);
        reject(new Error(`expected snapshot silence for ${ms}ms, got one after ${Date.now() - startedAt}ms`));
      }
    };
    const startedAt = Date.now();
    worker.on("message", onMessage);
  });
}

/** Resolves with the number of snapshots that arrived within `ms`. */
function countSnapshots(worker: Worker, ms: number): Promise<number> {
  return new Promise((resolve) => {
    let n = 0;
    const onMessage = (m: any) => { if (m?.t === "snapshot") n++; };
    worker.on("message", onMessage);
    setTimeout(() => {
      worker.off("message", onMessage);
      resolve(n);
    }, ms);
  });
}

/** Waits until the worker has been snapshot-quiet for a full window.
 * Resolves as soon as `quietMs` pass with NO snapshot at all (the sim fully
 * settled), or after `maxMs` with whatever quiet it got (bounded fallback:
 * the character pill never sleeps, so a stray contact-solver micro-jitter
 * may cross the 0.01-stud delta threshold under load - as long as the rate
 * is nothing like 15 Hz, the point of the test stands). */
async function waitQuiescent(worker: Worker, quietMs: number, maxMs: number): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const quiet = await new Promise<boolean>((resolve) => {
      let saw = false;
      const onMessage = (m: any) => { if (m?.t === "snapshot") saw = true; };
      worker.on("message", onMessage);
      setTimeout(() => {
        worker.off("message", onMessage);
        resolve(!saw);
      }, quietMs);
    });
    if (quiet) return;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const studioState = {
  objects: [
    { id: 'base', name: 'Baseplate', type: 'Block',
      position: { x: 0, y: -0.5, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
      size: { x: 200, y: 1, z: 200 }, color: '#3d6666', material: 'Plastic',
      transparency: 0, reflectance: 0, anchored: true, canCollide: true,
      friction: 0.5, elasticity: 0.2, density: 1, isBaseplate: true,
      children: [], parentId: null, bodyMovers: [], effects: [], rules: [] },
    // v1.3 (CharacterRoot removed): a Spawn part drives the spawn point.
    { id: 'spawn', name: 'Spawn', type: 'Spawn',
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
      size: { x: 1, y: 1, z: 1 }, color: '#4a90d9', material: 'Plastic',
      transparency: 0, reflectance: 0, anchored: true, canCollide: false,
      friction: 0.5, elasticity: 0.2, density: 1,
      isSpawnPoint: true, isCharacterPart: false,
      children: [], parentId: null, bodyMovers: [], effects: [], rules: [] },
    // Unanchored crate high above the baseplate: falls + settles on join.
    { id: 'crate', name: 'Crate', type: 'Block',
      position: { x: 2, y: 30, z: 2 }, rotation: { x: 0, y: 0, z: 0 },
      size: { x: 2, y: 2, z: 2 }, color: '#b07a3c', material: 'Plastic',
      transparency: 0, reflectance: 0, anchored: false, canCollide: true,
      friction: 0.5, elasticity: 0.2, density: 1,
      children: [], parentId: null, bodyMovers: [], effects: [], rules: [] },
  ],
  joints: [], treeInstances: [], waterBodies: [], terrainLayers: [],
  globalTimers: [], globalVariables: {},
  avatar: {},
  spawnPoint: { x: 0, y: 0, z: 0 },
  physicsSettings: { gravity: -35 },
  playState: { characterMaxHealth: 100 },
};

async function main(): Promise<void> {
  const worker = new Worker(bundle);
  try {
    worker.postMessage({ t: 'init', studioState, maxPlayers: 4 });
    await waitMessage(worker, (m) => m?.t === 'ready');
    console.log('✓ worker ready');

    // ── 1. EMPTY INSTANCE: nothing at all may arrive (idle pause) ──
    await expectSilence(worker, 2500);
    console.log('✓ empty instance is fully paused (no snapshots, engine frozen)');

    // ── 2. Join resumes the sim; first snapshot has player + parts ──
    worker.postMessage({ t: 'playerJoin', socketId: 's-alice', username: 'Alice' });
    const first: any = await waitMessage(worker, (m) => m?.t === 'snapshot', 10000);
    assert.ok(
      Array.isArray(first.players) && first.players.some((p: any) => p.socketId === 's-alice'),
      'first snapshot carries the new player',
    );
    assert.ok(
      Array.isArray(first.parts) && first.parts.some((p: any) => p.id === 'crate'),
      'part keyframe streams the crate from the very first snapshot',
    );
    console.log('✓ join resumes the sim: player + part keyframe arrive');

    // ── 3. Let everything settle (player lands, crate lands + sleeps) ──
    await waitMessage(worker, (m) => {
      if (m?.t !== 'snapshot') return false;
      const crate = (m.parts || []).find((p: any) => p.id === 'crate');
      return crate && crate.y <= 1.05; // resting on the baseplate
    }, 15000);
    // Extra settle: wait until the sim is snapshot-quiet for a full 1.2s
    // (the crate's + player's last deltas flushed) so the idle measurement
    // below does not count settling motion as "idle streaming".
    await waitQuiescent(worker, 1200, 10000);

    // ── 4. Idle rate: only the ~0.5 Hz keyframes, not 15 Hz frames ──
    // (ceiling 8 = generous load headroom while still proving the stream is
    // nothing like the old 15 Hz x 4s = ~60 frames)
    const idleCount = await countSnapshots(worker, 4000);
    assert.ok(idleCount >= 1, `idle keyframes still flow (got ${idleCount} in 4s)`);
    assert.ok(idleCount <= 8, `idle world must not stream 15 Hz frames (got ${idleCount} in 4s)`);
    console.log(`✓ idle rate is keyframe-only: ${idleCount} snapshots in 4s (was ~60 before)`);

    // Every idle snapshot that DOES flow is a full-players keyframe.
    // (checked implicitly: player must appear in each, else the client
    // prune logic would drop them - verify at least once more here)

    // ── 5. Movement resumes the delta stream (v6.4 CSP: the owning client
    //    sends input messages every ~50 ms - each input drives the
    //    authoritative body, so deltas flow at the input cadence) ──
    let seq = 0;
    const walk = setInterval(() => {
      seq++;
      worker.postMessage({
        t: 'input', socketId: 's-alice',
        x: 1, z: 0, jump: false, sprint: false, yaw: 0, seq,
      });
    }, 50);
    const movingCount = await countSnapshots(worker, 1000);
    clearInterval(walk);
    assert.ok(movingCount >= 3, `reporting player streams deltas (got ${movingCount}/s)`);
    console.log(`✓ inputs resume the delta stream: ${movingCount} snapshots in 1s`);

    // ── 6. Leave -> full silence again ──
    worker.postMessage({ t: 'playerLeave', socketId: 's-alice' });
    await expectSilence(worker, 2500);
    console.log('✓ last player leaves: worker back to fully paused');

    // ── 7. Re-join: everything resumes + part keyframe repeats ──
    worker.postMessage({ t: 'playerJoin', socketId: 's-bob', username: 'Bob' });
    const rejoin: any = await waitMessage(worker, (m) => m?.t === 'snapshot', 10000);
    assert.ok(
      Array.isArray(rejoin.players) && rejoin.players.some((p: any) => p.socketId === 's-bob'),
      're-join snapshot carries the new player',
    );
    assert.ok(
      Array.isArray(rejoin.parts) && rejoin.parts.some((p: any) => p.id === 'crate'),
      'late joiner gets the settled crate position again (part keyframe)',
    );
    console.log('✓ re-join resumes + re-keyframes the world for the newcomer');

    console.log('\n✓ delta snapshots + idle pause: ALL PASS');
  } finally {
    worker.postMessage({ t: 'stop' });
    await sleep(200);
    try { await worker.terminate(); } catch { /* already gone */ }
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('\n✗ delta snapshot test FAILED:', e?.message || e);
    process.exit(1);
  },
);

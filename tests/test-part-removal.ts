// ═══════════════════════════════════════════════════════════════════
// WeildBuild — v6.2.7 part removal broadcast test
// ═══════════════════════════════════════════════════════════════════
// Verifies the authority's new deletion protocol against the real
// worker bundle: when the runtime deletes a part (void fall, rule
// destroy), the next snapshot must carry it in `removed` EXACTLY ONCE
// so clients (which no longer simulate parts and can no longer "cover"
// a missing deletion with local physics) drop the mesh + collider.
//
//   1. A part spawned BELOW the void line is deleted by the runtime's
//      own void check -> its id arrives in snapshot.removed.
//   2. The id never appears again in a later snapshot's removed list
//      (the diff base is cleaned - no re-broadcast loop).
//   3. The deleted part never appears in the parts transform list.
//   4. A settled crate stays alive (the void check deletes only the
//      fallen part - no collateral removals).
//
// Usage: npx tsx tests/test-part-removal.ts
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const studioState: any = {
  objects: [
    { id: 'base', name: 'Baseplate', type: 'Block',
      position: { x: 0, y: -0.5, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
      size: { x: 100, y: 1, z: 100 }, color: '#3d6666', material: 'Plastic',
      transparency: 0, reflectance: 0, anchored: true, canCollide: true,
      friction: 0.5, elasticity: 0.2, density: 1, isBaseplate: true,
      children: [], parentId: null, bodyMovers: [], effects: [], rules: [] },
    { id: 'root', name: 'CharacterRoot', type: 'Block',
      position: { x: 0, y: 1.5, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
      size: { x: 1.2, y: 3, z: 1.2 }, color: '#4a90d9', material: 'Plastic',
      transparency: 0, reflectance: 0, anchored: true, canCollide: false,
      friction: 0.5, elasticity: 0.2, density: 1,
      isCharacterRoot: true, isCharacterPart: false,
      children: [], parentId: null, bodyMovers: [], effects: [], rules: [] },
    // A healthy crate: falls + settles on the baseplate. Must SURVIVE.
    { id: 'crate', name: 'Crate', type: 'Block',
      position: { x: 2, y: 30, z: 2 }, rotation: { x: 0, y: 0, z: 0 },
      size: { x: 2, y: 2, z: 2 }, color: '#b07a3c', material: 'Plastic',
      transparency: 0, reflectance: 0, anchored: false, canCollide: true,
      friction: 0.5, elasticity: 0.2, density: 1,
      children: [], parentId: null, bodyMovers: [], effects: [], rules: [] },
    // A doomed crate spawned OVER THE EDGE, far outside the baseplate
    // (which spans -50..50): nothing under it, so it free-falls past the
    // void line (voidY = -50 for this geometry) shortly after the sim
    // resumes, and the runtime's own void check deletes it - the deletion
    // must ride `removed` (spawned parts can never START below voidY:
    // the line is always min(-50, lowestPartBottom - 30), so a REAL fall
    // is the only way to test this).
    { id: 'doomed', name: 'DoomedCrate', type: 'Block',
      position: { x: 200, y: 30, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
      size: { x: 2, y: 2, z: 2 }, color: '#c04040', material: 'Plastic',
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
  // ONE persistent recorder (the harness lesson from test-instant-jump:
  // attaching/removing listeners mid-test makes Node buffer + burst-flush
  // stale snapshots, creating phantom events). Everything is asserted from
  // this recorded stream - no window can be "missed" because a listener
  // attached too late (the healthy crate settles before the removal
  // arrives, so its landing transform has to be recorded, not awaited).
  const snaps: any[] = [];
  const removedSeen = new Set<string>();
  worker.on('message', (m: any) => {
    if (m?.t !== 'snapshot') return;
    snaps.push(m);
    if (Array.isArray(m.removed)) {
      for (const id of m.removed) removedSeen.add(id);
    }
  });
  try {
    worker.postMessage({ t: 'init', studioState, maxPlayers: 4 });
    await waitMessage(worker, (m) => m?.t === 'ready');
    console.log('✓ worker ready');

    worker.postMessage({ t: 'playerJoin', socketId: 's-alice', username: 'Alice' });

    // ── 1. The doomed crate's fall + deletion must ride `removed` ──
    // (free fall from y=30 to y=-50 at gravity 35 takes ~2.1s after the
    // join resumes the sim; the 30s timeout has ample headroom)
    await waitMessage(worker, (m: any) =>
      m?.t === 'snapshot' && Array.isArray(m.removed) && m.removed.includes('doomed'), 30000);
    const removalSnaps = snaps.filter((s) => Array.isArray(s.removed) && s.removed.includes('doomed'));
    assert.strictEqual(removalSnaps.length, 1,
      `exactly one snapshot may carry the doomed removal (got ${removalSnaps.length})`);
    const removalSnap = removalSnaps[0];
    assert.ok(!removalSnap.removed.includes('crate'),
      'the settled crate must NOT be removed');
    assert.ok(!removalSnap.removed.includes('base') && !removalSnap.removed.includes('root'),
      'anchored geometry is never removed');
    console.log('✓ void-fallen part arrives in snapshot.removed');

    // The deleted part never appears as a live transform after the removal.
    const removalIdx = snaps.indexOf(removalSnap);
    for (let i = removalIdx; i < snaps.length; i++) {
      const listed = (snaps[i].parts || []).some((p: any) => p.id === 'doomed');
      assert.ok(!listed, `a deleted part must not appear in the parts list after removal (snapshot #${i})`);
    }

    // ── 2. The removal broadcasts EXACTLY once ──
    await sleep(2500); // several snapshot periods
    assert.strictEqual(removedSeen.size, 1,
      `removed must fire exactly once (saw ${removedSeen.size} distinct ids: ${[...removedSeen].join(', ')})`);
    assert.strictEqual(
      snaps.filter((s) => Array.isArray(s.removed) && s.removed.length > 0).length, 1,
      'no later snapshot may carry a removal list again (re-broadcast loop)',
    );

    // ── 3. The healthy crate streamed its settle and stayed alive ──
    const settled = snaps.some((s) =>
      (s.parts || []).some((p: any) => p.id === 'crate' && p.y <= 1.05));
    assert.ok(settled, 'the settled crate must have streamed its landing transform');

    console.log('✓ deletion broadcasts exactly once; the healthy crate survives');
  } finally {
    worker.postMessage({ t: 'stop' });
    await worker.terminate().catch(() => {});
  }
}

main().catch((e) => {
  console.error('✗ part removal test FAILED:', e?.message || e);
  process.exit(1);
});

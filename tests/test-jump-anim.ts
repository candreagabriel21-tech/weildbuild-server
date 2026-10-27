// ═══════════════════════════════════════════════════════════════════
// WeildBuild — v6.2.4 jump animation latch test
// ═══════════════════════════════════════════════════════════════════
// Regression test for "when you jump, the animation and sound plays once
// when you jump and once when you hit the ground":
//
//   The server's anim.jumping flag used to be `velocity.y > 0.5`. That
//   threshold flipped FALSE at the apex (landing cues fired mid-air) and —
//   much worse — flipped TRUE again for a tick when the landing impact
//   resolved with a small upward velocity spike, so every client rendered
//   the jump animation (and played the jump sound) TWICE: once at the jump
//   and once at the landing.
//
//   The fix latches the flag: set by the actual jump impulse, cleared by
//   the first grounded tick after a short grace. Rising edge = the jump,
//   falling edge = the landing. Exactly one of each, and the falling edge
//   happens AT THE GROUND, not at the apex.
//
// v6.2.8: runs in SAVED server-sim mode (PLAYER_NETCODE_MODE=server-sim) -
// the jump latch is computed by the SAVED server-side character simulation;
// this test proves that path still works behind the flag.
//
// Usage: npx tsx tests/test-jump-anim.ts
// (run `node scripts/build-world-runtime.mjs` first)

import assert from "node:assert";
import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { existsSync } from "node:fs";

// SAVED MODE: the worker inherits this env at spawn.
process.env.PLAYER_NETCODE_MODE = "server-sim";

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

const studioState = {
  objects: [
    // Baseplate: top surface at y = 0
    { id: 'base', name: 'Baseplate', type: 'Block',
      position: { x: 0, y: -0.5, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
      size: { x: 100, y: 1, z: 100 }, color: '#3d6666', material: 'Plastic',
      transparency: 0, reflectance: 0, anchored: true, canCollide: true,
      friction: 0.5, elasticity: 0.2, density: 1, isBaseplate: true,
      children: [], parentId: null, bodyMovers: [], effects: [], rules: [] },
    // CharacterRoot: feet at y = 0 (on the baseplate)
    { id: 'root', name: 'CharacterRoot', type: 'Block',
      position: { x: 0, y: 1.5, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
      size: { x: 1.2, y: 3, z: 1.2 }, color: '#4a90d9', material: 'Plastic',
      transparency: 0, reflectance: 0, anchored: true, canCollide: false,
      friction: 0.5, elasticity: 0.2, density: 1,
      isCharacterRoot: true, isCharacterPart: false,
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
    worker.postMessage({ t: 'playerJoin', socketId: 's-alice', username: 'Alice' });

    const findAlice = (snap: any) =>
      Array.isArray(snap?.players) ? snap.players.find((p: any) => p.socketId === 's-alice') : undefined;

    // ── 1. Let Alice settle on the ground (~1.2s) ──
    await new Promise((r) => setTimeout(r, 1200));

    // ── 2. Jump once, then collect snapshots for the whole flight + landing ──
    worker.postMessage({ t: 'input', socketId: 's-alice', x: 0, z: 0, jump: true, sprint: false, yaw: 0 });

    const samples: Array<{ y: number; jumping: boolean }> = [];
    const startedAt = Date.now();
    const onSnap = (m: any) => {
      if (m?.t !== 'snapshot') return;
      const alice = findAlice(m);
      // Delta snapshots: Alice absent = unchanged; presence carries the flag.
      if (alice?.anim && typeof alice.anim.jumping === 'boolean') {
        samples.push({ y: alice.position?.[1] ?? 0, jumping: alice.anim.jumping });
      }
    };
    worker.on('message', onSnap);
    // A jump at 11.5 u/s against 35 gravity: ~0.66s air + settle margin.
    await new Promise((r) => setTimeout(r, 1500));
    worker.off('message', onSnap);
    const elapsed = (Date.now() - startedAt) / 1000;

    // ── 3. Analyze the flag's edges ──
    let rising = 0;
    let falling = 0;
    let fallingY: number | null = null;
    let prev: boolean | false = false;
    for (const s of samples) {
      if (s.jumping && !prev) rising++;
      if (!s.jumping && prev) { falling++; fallingY = s.y; }
      prev = s.jumping;
    }

    console.log(`✓ collected ${samples.length} Alice entries over ${elapsed.toFixed(2)}s`);
    console.log(`✓ rising edges: ${rising}, falling edges: ${falling}, falling edge feet y: ${fallingY?.toFixed(2)}`);
    assert.ok(samples.length >= 3, `expected several Alice snapshots during the jump (got ${samples.length})`);

    // THE DOUBLE-JUMP REGRESSION: exactly ONE rising edge (the jump). The
    // old velocity-threshold flag produced a second rising edge at the
    // landing impact spike.
    assert.strictEqual(rising, 1,
      `BUG REGRESSION: ${rising} jump rising edges - the landing spike re-triggered the flag`);

    // The falling edge (landing cue) must fire AT THE GROUND, not mid-air
    // (the old flag dropped at the apex, ~1.9 studs up).
    assert.strictEqual(falling >= 1, true, 'the landing (falling edge) must arrive');
    assert.ok(fallingY !== null && fallingY < 0.6,
      `falling edge fired at feet y=${fallingY?.toFixed(2)} - mid-air (apex dip) instead of the landing`);

    // After the falling edge no further rising edges exist in the window
    // (covered by rising === 1, but assert the last sample is landed too).
    assert.strictEqual(samples[samples.length - 1].jumping, false, 'the window must end landed');

    console.log('✓ jump animation latch: ALL PASS');
  } finally {
    try { worker.postMessage({ t: 'stop' }); } catch { /* already gone */ }
    await new Promise((r) => setTimeout(r, 150));
    await worker.terminate().catch(() => undefined);
  }
}

main().catch((e) => {
  console.error('✗', e.message);
  process.exit(1);
});

// ═══════════════════════════════════════════════════════════════════
// WeildBuild — v6.2.1 death/respawn + per-player rule effects test
// ═══════════════════════════════════════════════════════════════════
// Regression test for the two reported game-breaking bugs:
//
//   1. "When a player dies, everyone dies" — kill_player used to write
//      the single shared playState.characterHealth, which the worker
//      mirrored onto EVERY player. Now the engine queues a per-player
//      effect naming the TOUCHING player, and only that player dies.
//
//   2. "They never respawn properly" — rule-driven deaths never set the
//      server's dyingTimer, so respawn() never ran (hp stayed 0 forever,
//      other players never even saw the death). Now killPlayer() starts
//      the death cycle and the authority respawns the player at spawn
//      with full hp.
//
// v6.4 CSP: the server simulates the player's body itself. Alice joins
// at the spawn point (which sits exactly on the kill brick); the
// server-authoritative body settles onto the brick and the touch check
// fires immediately. No client reports needed.
//
// Usage: npx tsx tests/test-death-respawn.ts
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

const studioState = {
  objects: [
    // Baseplate
    { id: 'base', name: 'Baseplate', type: 'Block',
      position: { x: 0, y: -0.5, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
      size: { x: 100, y: 1, z: 100 }, color: '#3d6666', material: 'Plastic',
      transparency: 0, reflectance: 0, anchored: true, canCollide: true,
      friction: 0.5, elasticity: 0.2, density: 1, isBaseplate: true,
      children: [], parentId: null, bodyMovers: [], effects: [], rules: [] },
    // v1.3 (CharacterRoot removed): the explicit studioState.spawnPoint below
    // drives the spawn point (Alice joins at slot #0 = the spawn itself).
    // KILL BRICK: sits exactly at Alice's spawn feet position (small enough
    // that Bob's ring-1 spawn slot stays clear of it). Its
    // when_touched(player) rule kills whoever steps on it.
    { id: 'lava', name: 'LavaBrick', type: 'Block',
      position: { x: 5, y: 0.1, z: 5 }, rotation: { x: 0, y: 0, z: 0 },
      size: { x: 1.5, y: 0.2, z: 1.5 }, color: '#ff3300', material: 'Neon',
      transparency: 0, reflectance: 0, anchored: true, canCollide: true,
      friction: 0.5, elasticity: 0.2, density: 1,
      children: [], parentId: null, bodyMovers: [], effects: [],
      rules: [{
        id: 'rule_kill', name: 'Kill the toucher',
        trigger: { type: 'when_touched', params: { filter: 'player' } },
        actions: [{ id: 'act_kill', type: 'kill_player', params: {}, children: [], enabled: true }],
        mode: 'simple', enabled: true,
      }] },
  ],
  joints: [], treeInstances: [], waterBodies: [], terrainLayers: [],
  globalTimers: [], globalVariables: {},
  avatar: {},
  spawnPoint: { x: 5, y: 0, z: 5 },
  physicsSettings: { gravity: -35 },
  playState: { characterMaxHealth: 100 },
};

async function main(): Promise<void> {
  const worker = new Worker(bundle);
  try {
    worker.postMessage({ t: 'init', studioState, maxPlayers: 4 });
    await waitMessage(worker, (m) => m?.t === 'ready');
    console.log('✓ worker ready');

    // Two players join. Alice (join #0) spawns ON the kill brick;
    // Bob (join #1) lands on the ring, clear of it.
    worker.postMessage({ t: 'playerJoin', socketId: 's-alice', username: 'Alice' });
    worker.postMessage({ t: 'playerJoin', socketId: 's-bob', username: 'Bob' });

    // v6.4 CSP: the server simulates both bodies itself. Alice's body
    // settles ON the lava brick (touch fires immediately); Bob's body
    // settles on his ring slot (clear of the lava). No client reports
    // are needed.

    const findPlayer = (snap: any, id: string) =>
      Array.isArray(snap?.players) ? snap.players.find((p: any) => p.socketId === id) : undefined;

    // ── Wait for Alice's death (touch fires within a couple of sim ticks) ──
    const deathSnap = await waitMessage(worker, (m) => {
      if (m?.t !== 'snapshot') return false;
      const alice = findPlayer(m, 's-alice');
      return alice && (alice.hp <= 0 || alice.dying === true);
    });
    const deadAlice = findPlayer(deathSnap, 's-alice');
    const aliveBob = findPlayer(deathSnap, 's-bob');
    console.log(`✓ Alice touched the kill brick: hp=${deadAlice.hp} dying=${deadAlice.dying} anim.dying=${deadAlice.anim?.dying}`);
    assert.strictEqual(deadAlice.hp, 0, 'Alice should be at 0 hp');
    assert.strictEqual(deadAlice.dying, true, 'Alice should be dying (server-side death cycle started)');

    // ── BUG 1 regression: Bob must be COMPLETELY unaffected ──
    // v6.2.2: snapshots are DELTAS - Bob standing still unchanged simply
    // is not listed. Absence IS the proof he was untouched (if he had
    // died, his hp/dying/anim changes would put him right back in).
    console.log(`✓ Bob untouched by Alice's death: hp=${aliveBob?.hp} dying=${aliveBob?.dying} (absent = unchanged)`);
    assert.ok(!aliveBob || (aliveBob.hp === 100 && aliveBob.dying === false),
      'BUG 1 REGRESSION: everyone would have died before the fix');
    assert.ok(!aliveBob || (aliveBob.anim?.dying ?? false) === false, 'Bob must not show the death anim');

    // ── BUG 2 regression: Alice must RESPAWN (hp back to 100, at spawn) ──
    const respawnSnap = await waitMessage(worker, (m) => {
      if (m?.t !== 'snapshot') return false;
      const alice = findPlayer(m, 's-alice');
      return alice && alice.hp >= 100 && alice.dying === false;
    }, 15000);
    const respawnedAlice = findPlayer(respawnSnap, 's-alice');
    const stillFineBob = findPlayer(respawnSnap, 's-bob');
    const dist = Math.hypot(
      respawnedAlice.position[0] - 5,
      respawnedAlice.position[2] - 5,
    );
    console.log(`✓ Alice respawned: hp=${respawnedAlice.hp} dying=${respawnedAlice.dying} at spawn (dist ${dist.toFixed(2)})`);
    assert.strictEqual(respawnedAlice.hp, 100, 'BUG 2 REGRESSION: hp never came back before the fix');
    assert.strictEqual(respawnedAlice.dying, false, 'dying flag must clear after respawn');
    assert.ok(dist < 3, `Alice should be back near the spawn point (got ${dist.toFixed(2)})`);
    assert.ok(!stillFineBob || stillFineBob.hp === 100, 'Bob must STILL be at full hp after Alice respawned');

    // ── The kill brick must keep working: Alice spawns ON it again ──
    const death2 = await waitMessage(worker, (m) => {
      if (m?.t !== 'snapshot') return false;
      const alice = findPlayer(m, 's-alice');
      return alice && (alice.hp <= 0 || alice.dying === true);
    });
    console.log(`✓ kill brick re-armed after respawn: hp=${findPlayer(death2, 's-alice').hp} dying=${findPlayer(death2, 's-alice').dying}`);

    console.log('\n✓ death/respawn + per-player effects: ALL PASS');
  } finally {
    worker.postMessage({ t: 'stop' });
    await new Promise((r) => setTimeout(r, 300));
    try { await worker.terminate(); } catch { /* already gone */ }
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('\n✗ death/respawn test FAILED:', e?.message || e);
    process.exit(1);
  },
);

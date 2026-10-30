// ═══════════════════════════════════════════════════════════════════
// WeildBuild — v6.4 CSP server-authoritative simulation test
// ═══════════════════════════════════════════════════════════════════
// Verifies the server-side half of CSP:
//   1. Inputs (with seq) drive the body authoritatively.
//   2. Each snapshot acks the latest input seq.
//   3. A rule teleport snaps the body (the input-driven position is
//      replaced by the teleport target).
//   4. The body's velocity stops accumulating after a teleport (no
//      slingshot of nearby parts).
//
// The CLIENT-side prediction + reconcile is tested by the existing
// e2e tests in the platform project (the bridge module's reconcileSelf
// is unit-testable through the test-server-auth-prediction.ts
// standalone test).
//
// Usage: npx tsx tests/test-csp-authoritative.ts
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
    // Long baseplate so the player has room to walk.
    { id: 'base', name: 'Baseplate', type: 'Block',
      position: { x: 0, y: -0.5, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
      size: { x: 200, y: 1, z: 200 }, color: '#3d6666', material: 'Plastic',
      transparency: 0, reflectance: 0, anchored: true, canCollide: true,
      friction: 0.5, elasticity: 0.2, density: 1, isBaseplate: true,
      children: [], parentId: null, bodyMovers: [], effects: [], rules: [] },
    // Spawn part.
    { id: 'spawn', name: 'Spawn', type: 'Spawn',
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
      size: { x: 1, y: 1, z: 1 }, color: '#4a90d9', material: 'Plastic',
      transparency: 0, reflectance: 0, anchored: true, canCollide: false,
      friction: 0.5, elasticity: 0.2, density: 1,
      isSpawnPoint: true, isCharacterPart: false,
      children: [], parentId: null, bodyMovers: [], effects: [], rules: [] },
    // TELEPORT BRICK: when_touched(player) -> teleport_player to a fixed
    // spot. Lets us verify the body's authoritative position changes
    // (the input-driven position is replaced by the teleport target).
    { id: 'teleport', name: 'TeleportBrick', type: 'Block',
      position: { x: 5, y: 0.1, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
      size: { x: 1.5, y: 0.2, z: 1.5 }, color: '#33ddff', material: 'Neon',
      transparency: 0, reflectance: 0, anchored: true, canCollide: true,
      friction: 0.5, elasticity: 0.2, density: 1,
      children: [], parentId: null, bodyMovers: [], effects: [],
      rules: [{
        id: 'rule_tp', name: 'Teleport the toucher',
        trigger: { type: 'when_touched', params: { filter: 'player' } },
        actions: [{ id: 'act_tp', type: 'teleport_player', params: { position: { x: 50, y: 5, z: 50 } }, children: [], enabled: true }],
        mode: 'simple', enabled: true,
      }] },
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
  let walkTimer: NodeJS.Timeout | null = null;
  try {
    worker.postMessage({ t: 'init', studioState, maxPlayers: 4 });
    await waitMessage(worker, (m) => m?.t === 'ready');
    console.log('✓ worker ready');

    worker.postMessage({ t: 'playerJoin', socketId: 's-alice', username: 'Alice' });

    const findPlayer = (snap: any, id: string) =>
      Array.isArray(snap?.players) ? snap.players.find((p: any) => p.socketId === id) : undefined;

    // 1. Send a +X walk input with seq. The server must:
    //    a) drive the body forward (snapshot position increases)
    //    b) ack the latest input seq in the snapshot
    let seq = 0;
    let lastAckSeq = 0;
    walkTimer = setInterval(() => {
      seq++;
      worker.postMessage({
        t: 'input', socketId: 's-alice',
        x: 1, z: 0, jump: false, sprint: false, yaw: 0, seq,
      });
    }, 50);

    // Wait for the body to move forward at least 1 stud.
    const movedSnap = await waitMessage(worker, (m) => {
      if (m?.t !== 'snapshot') return false;
      const alice = findPlayer(m, 's-alice');
      return alice && alice.position[0] > 1;
    }, 8000);
    const movedAlice = findPlayer(movedSnap, 's-alice');
    console.log(`✓ inputs drove Alice forward (x=${movedAlice.position[0].toFixed(2)}), ackSeq=${movedAlice.ackSeq}`);
    assert.ok(movedAlice.position[0] > 1, 'body must move forward when input is +X');
    assert.ok(typeof movedAlice.ackSeq === 'number', 'snapshot must carry ackSeq');
    assert.ok(movedAlice.ackSeq > 0, `ackSeq must be > 0 after inputs (got ${movedAlice.ackSeq})`);
    assert.ok(movedAlice.ackSeq <= seq, `ackSeq (${movedAlice.ackSeq}) must not exceed the latest sent seq (${seq})`);
    lastAckSeq = movedAlice.ackSeq;

    // 2. Continue walking - ackSeq must advance as more inputs arrive.
    const advancedSnap = await waitMessage(worker, (m) => {
      if (m?.t !== 'snapshot') return false;
      const alice = findPlayer(m, 's-alice');
      return alice && alice.ackSeq > lastAckSeq + 2;
    }, 5000);
    const advancedAlice = findPlayer(advancedSnap, 's-alice');
    console.log(`✓ ackSeq advanced (${lastAckSeq} -> ${advancedAlice.ackSeq}) as more inputs arrived`);
    assert.ok(advancedAlice.ackSeq > lastAckSeq, 'ackSeq must advance as more inputs arrive');
    lastAckSeq = advancedAlice.ackSeq;

    // 3. Keep walking +X; Alice will eventually walk into the teleport
    //    brick at x=5. The rule fires; the body must teleport to (50,5,50).
    //    The teleport arrives flagged tp=1 in the snapshot.
    const teleportedSnap = await waitMessage(worker, (m) => {
      if (m?.t !== 'snapshot') return false;
      const alice = findPlayer(m, 's-alice');
      return alice && alice.tp === 1;
    }, 15000);
    const teleportedAlice = findPlayer(teleportedSnap, 's-alice');
    const distFromTeleportTarget = Math.hypot(
      teleportedAlice.position[0] - 50,
      teleportedAlice.position[1] - 5,
      teleportedAlice.position[2] - 50,
    );
    console.log(`✓ teleport rule fired: Alice at (${teleportedAlice.position.map((v: number) => v.toFixed(2))}), dist from target=${distFromTeleportTarget.toFixed(2)}, tp=1`);
    assert.ok(distFromTeleportTarget < 1, `body must be at the teleport target (dist ${distFromTeleportTarget.toFixed(2)})`);
    assert.ok(teleportedAlice.tp === 1, 'snapshot must flag the teleport with tp=1');

    // 4. After the teleport, the body should NOT immediately shoot back
    //    toward +X (the input is still being sent, but the body has been
    //    teleported). Wait a beat and verify the body stays near the
    //    teleport target (within ~5 studs), not 50+ studs away.
    clearInterval(walkTimer);
    walkTimer = null;
    await new Promise((r) => setTimeout(r, 500)); // ~15 sim ticks
    // Send a no-input keepalive to settle the body
    worker.postMessage({ t: 'input', socketId: 's-alice', x: 0, z: 0, jump: false, sprint: false, yaw: 0, seq: ++seq });
    const settledSnap = await waitMessage(worker, (m) => m?.t === 'snapshot', 3000);
    const settledAlice = findPlayer(settledSnap, 's-alice');
    const distAfterSettle = Math.hypot(
      settledAlice.position[0] - 50,
      settledAlice.position[2] - 50,
    );
    console.log(`✓ body stable after teleport: Alice at (${settledAlice.position.map((v: number) => v.toFixed(2))}), dist from target=${distAfterSettle.toFixed(2)}`);
    assert.ok(distAfterSettle < 5, `body must stay near teleport target after settle (dist ${distAfterSettle.toFixed(2)})`);

    console.log('\n✓ CSP server-authoritative simulation: ALL PASS');
  } finally {
    if (walkTimer) clearInterval(walkTimer);
    worker.postMessage({ t: 'stop' });
    await new Promise((r) => setTimeout(r, 300));
    try { await worker.terminate(); } catch { /* already gone */ }
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('\n✗ CSP server-authoritative test FAILED:', e?.message || e);
    process.exit(1);
  },
);

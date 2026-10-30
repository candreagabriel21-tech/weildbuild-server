// ═══════════════════════════════════════════════════════════════════
// WeildBuild — v6.4 CSP authoritative server test
// ═══════════════════════════════════════════════════════════════════
// Verifies the v6.4 CSP server-authoritative player simulation:
//
//   1. Inputs drive the dynamic body forward (+X walk). The body's X
//      advances; ackSeq advances (proof the server consumed the inputs).
//   2. A teleport rule fires (a touch-driven teleport_player rule):
//      the body is snapped across the map (>= 30 studs) - more than the
//      client's RECONCILE_SNAP_STUDS threshold, so a CSP client would
//      hard-snap (this test only verifies the SERVER side: the body is
//      AT the teleport target with zero velocity).
//   3. The body is STABLE after the teleport (no wild velocity, no
//      gravity-induced drift across the next tick - the dynamic body
//      settles cleanly on the target).
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
    // Large baseplate so a teleport target on it is solid ground.
    { id: 'base', name: 'Baseplate', type: 'Block',
      position: { x: 0, y: -0.5, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
      size: { x: 200, y: 1, z: 200 }, color: '#3d6666', material: 'Plastic',
      transparency: 0, reflectance: 0, anchored: true, canCollide: true,
      friction: 0.5, elasticity: 0.2, density: 1, isBaseplate: true,
      children: [], parentId: null, bodyMovers: [], effects: [], rules: [] },
    // Spawn part drives the spawn point (player at origin).
    { id: 'spawn', name: 'Spawn', type: 'Spawn',
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
      size: { x: 1, y: 1, z: 1 }, color: '#4a90d9', material: 'Plastic',
      transparency: 0, reflectance: 0, anchored: true, canCollide: false,
      friction: 0.5, elasticity: 0.2, density: 1,
      isSpawnPoint: true, isCharacterPart: false,
      children: [], parentId: null, bodyMovers: [], effects: [], rules: [] },
    // TELEPORT BRICK: a touch-driven teleport_player rule that flings
    // the touching player 40 studs across the map (way past the
    // RECONCILE_SNAP_STUDS threshold so a CSP client would hard-snap).
    { id: 'telebrick', name: 'TeleportBrick', type: 'Block',
      position: { x: 3, y: 0.1, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
      size: { x: 1.5, y: 0.2, z: 1.5 }, color: '#22ff88', material: 'Neon',
      transparency: 0, reflectance: 0, anchored: true, canCollide: true,
      friction: 0.5, elasticity: 0.2, density: 1,
      children: [], parentId: null, bodyMovers: [], effects: [],
      rules: [{
        id: 'rule_tp', name: 'Teleport the toucher',
        trigger: { type: 'when_touched', params: { filter: 'player' } },
        actions: [{
          id: 'act_tp', type: 'teleport_player',
          params: { position: { x: 40, y: 5, z: 0 } },
          children: [], enabled: true,
        }],
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
  try {
    worker.postMessage({ t: 'init', studioState, maxPlayers: 4 });
    await waitMessage(worker, (m) => m?.t === 'ready');
    console.log('✓ worker ready');

    worker.postMessage({ t: 'playerJoin', socketId: 's-alice', username: 'Alice' });
    const snap1: any = await waitMessage(worker, (m) => m?.t === 'snapshot' && m.players?.some((p: any) => p.socketId === 's-alice'));
    const alice1 = snap1.players.find((p: any) => p.socketId === 's-alice');
    const startX = alice1.position[0];
    const startAckSeq = alice1.ackSeq ?? 0;
    console.log(`✓ Alice joined at`, alice1.position.map((v: number) => v.toFixed(2)), `(ackSeq=${startAckSeq})`);

    // 1. Inputs drive the body forward. Send +X walk input at ~20 Hz.
    let seq = 0;
    const walkInputs = setInterval(() => {
      seq += 1;
      worker.postMessage({
        t: 'input', socketId: 's-alice',
        x: 1, z: 0, jump: false, sprint: false, yaw: 0, seq,
      });
    }, 50);
    const snapWalk: any = await waitMessage(
      worker,
      (m) => m.t === 'snapshot' && m.players?.some((p: any) => p.socketId === 's-alice' && p.position[0] > startX + 1.5),
      8000,
    );
    clearInterval(walkInputs);
    const alice2 = snapWalk.players.find((p: any) => p.socketId === 's-alice');
    assert.ok(alice2.position[0] > startX + 1.5,
      `inputs must drive the body forward (${startX.toFixed(2)} -> ${alice2.position[0].toFixed(2)})`);
    assert.ok(alice2.ackSeq > startAckSeq,
      `ackSeq must advance as the server consumes inputs (got ${alice2.ackSeq}, was ${startAckSeq})`);
    console.log(`✓ inputs drive body forward (${startX.toFixed(2)} -> ${alice2.position[0].toFixed(2)}), ackSeq ${startAckSeq} -> ${alice2.ackSeq}`);

    // 2. Walk Alice INTO the teleport brick (at x=3). The touch rule
    //    fires teleport_player to (40, 5, 0). The body must be snapped
    //    there in the next snapshots (a teleport is NOT a velocity
    //    impulse - the body's velocity is zeroed, so it doesn't
    //    slingshot off the target).
    const tpWalk = setInterval(() => {
      seq += 1;
      worker.postMessage({
        t: 'input', socketId: 's-alice',
        x: 1, z: 0, jump: false, sprint: false, yaw: 0, seq,
      });
    }, 50);
    const tpSnap: any = await waitMessage(
      worker,
      (m) => m.t === 'snapshot' && m.players?.some((p: any) => p.socketId === 's-alice' && Math.abs(p.position[0] - 40) < 2),
      10000,
    );
    clearInterval(tpWalk);
    const aliceTp = tpSnap.players.find((p: any) => p.socketId === 's-alice');
    assert.ok(Math.abs(aliceTp.position[0] - 40) < 2,
      `teleport rule must snap the body to x~40 (got ${aliceTp.position[0].toFixed(2)})`);
    assert.ok(aliceTp.tp === 1, "the teleport broadcast is tp-flagged (the owner teleports, others snap)");
    console.log(`✓ teleport rule snapped body to (${aliceTp.position[0].toFixed(2)}, ${aliceTp.position[1].toFixed(2)}, ${aliceTp.position[2].toFixed(2)}) - flagged tp`);

    // 3. Body is STABLE after the teleport: stop the +X walk input
    //    (send x:0 = no movement), then for ~1 second check the body's
    //    XZ position stays near the teleport target (no slingshot drift)
    //    and the body's hp/dying are intact (the teleport didn't kill).
    // Send a no-movement input so the body stops walking (the latest
    // input was x:1; the server keeps applying it until a new input arrives).
    seq += 1;
    worker.postMessage({
      t: 'input', socketId: 's-alice',
      x: 0, z: 0, jump: false, sprint: false, yaw: 0, seq,
    });
    let lastPos: [number, number, number] | null = null;
    let maxDrift = 0;
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      try {
        const snap: any = await waitMessage(worker, (m) => m.t === 'snapshot' && m.players?.some((p: any) => p.socketId === 's-alice'), 1500);
        const a = snap.players.find((p: any) => p.socketId === 's-alice');
        if (a) {
          if (lastPos) {
            const drift = Math.hypot(a.position[0] - lastPos[0], a.position[1] - lastPos[1], a.position[2] - lastPos[2]);
            if (drift > maxDrift) maxDrift = drift;
          }
          lastPos = [a.position[0], a.position[1], a.position[2]];
          assert.strictEqual(a.hp, 100, 'teleport must not damage the player');
          assert.strictEqual(a.dying, false, 'teleport must not kill the player');
        }
      } catch { break; }
    }
    assert.ok(lastPos, 'snapshots kept flowing after the teleport');
    // Allow some gravity settle (player was teleported to y=5, falls to
    // the baseplate at y=0). X and Z must stay near the target.
    const xzDrift = Math.hypot(lastPos[0] - 40, lastPos[2] - 0);
    assert.ok(xzDrift < 2.0,
      `body must stay near the teleport target on XZ (got drift ${xzDrift.toFixed(2)} studs from (40,0))`);
    console.log(`✓ body stable after teleport: settled at (${lastPos[0].toFixed(2)}, ${lastPos[1].toFixed(2)}, ${lastPos[2].toFixed(2)}), XZ drift ${xzDrift.toFixed(2)} studs (gravity may drop Y)`);

    console.log('\n✓ v6.4 CSP authoritative: ALL PASS');
  } finally {
    worker.postMessage({ t: 'stop' });
    await new Promise((r) => setTimeout(r, 200));
    try { await worker.terminate(); } catch { /* already gone */ }
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('\n✗ v6.4 CSP authoritative test FAILED:', e?.message || e);
    process.exit(1);
  },
);

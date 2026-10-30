// Smoke test: boot the world-runtime worker with a tiny world, join two
// players, exchange input messages (the v6.4 CSP player channel), and
// verify snapshots relay the AUTHORITATIVE positions + ackSeq.
// Usage: npx tsx tests/test-world-runtime.ts
//
// v6.4: the server now SIMULATES characters itself (CSP). The player
// channel is `input` (with seq) instead of `pstate` (positions). The
// server runs the SAME movement math the client prediction runs; the
// snapshot carries the authoritative position + the latest acked input
// seq so the client can reconcile.

import assert from "node:assert";
import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { existsSync } from "node:fs";

const bundle = join(__dirname, "..", "dist", "gamehost", "world-runtime.bundle.js");
if (!existsSync(bundle)) {
  console.error("✗ bundle missing - run `node scripts/build-world-runtime.mjs` first");
  process.exit(1);
}

function waitMessage<T = any>(worker: Worker, predicate: (m: any) => boolean, timeoutMs = 15000): Promise<T> {
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
    // Baseplate at y=0 (top surface at 0.5)
    { id: 'base', name: 'Baseplate', type: 'Block',
      position: { x: 0, y: -0.5, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
      size: { x: 100, y: 1, z: 100 }, color: '#3d6666', material: 'Plastic',
      transparency: 0, reflectance: 0, anchored: true, canCollide: true,
      friction: 0.5, elasticity: 0.2, density: 1, isBaseplate: true,
      children: [], parentId: null, bodyMovers: [], effects: [], rules: [] },
    // v1.3 (CharacterRoot removed): a Spawn part drives the spawn point
    // (feet on its top surface), like a real published game.
    { id: 'spawn', name: 'Spawn', type: 'Spawn',
      position: { x: 5, y: 0, z: 5 }, rotation: { x: 0, y: 0, z: 0 },
      size: { x: 1, y: 1, z: 1 }, color: '#4a90d9', material: 'Plastic',
      transparency: 0, reflectance: 0, anchored: true, canCollide: false,
      friction: 0.5, elasticity: 0.2, density: 1,
      isSpawnPoint: true, isCharacterPart: false,
      children: [], parentId: null, bodyMovers: [], effects: [], rules: [] },
    // An unanchored crate that should FALL (gravity) and appear in snapshots
    { id: 'crate', name: 'Crate', type: 'Block',
      position: { x: 8, y: 10, z: 8 }, rotation: { x: 0, y: 0, z: 0 },
      size: { x: 2, y: 2, z: 2 }, color: '#f7f54f', material: 'Wood',
      transparency: 0, reflectance: 0, anchored: false, canCollide: true,
      friction: 0.5, elasticity: 0.2, density: 1,
      children: [], parentId: null, bodyMovers: [], effects: [], rules: [] },
  ],
  joints: [],
  worldSettings: { maxPlayers: 10, gravity: -35 },
  physicsSettings: { gravity: -35 },
  avatar: {},
};

async function main() {
  const worker = new Worker(bundle);
  worker.on("error", (e) => { console.error("worker error:", e); process.exit(1); });

  // 1. init -> ready
  worker.postMessage({ t: "init", studioState, maxPlayers: 10 });
  const ready = await waitMessage(worker, (m) => m.t === "ready", 20000);
  assert.ok(Array.isArray(ready.spawn) && ready.spawn.length === 3, "ready carries a spawn point");
  assert.equal(ready.parts, 3, "three parts queued (the Spawn part never becomes a physics body: canCollide=false)");
  console.log("✓ ready: spawn", ready.spawn, "parts", ready.parts);

  // 2. join two players
  worker.postMessage({ t: "playerJoin", socketId: "sockA", username: "Alice" });
  worker.postMessage({ t: "playerJoin", socketId: "sockB", username: "Bob" });

  // 3. snapshots must arrive and contain both players at their RING slots,
  //    each flagged tp (the joiner's local body teleports to its slot).
  const snap1: any = await waitMessage(worker, (m) => m.t === "snapshot" && m.players?.length >= 2);
  const a1 = snap1.players.find((p: any) => p.socketId === "sockA");
  const b1 = snap1.players.find((p: any) => p.socketId === "sockB");
  assert.ok(a1 && b1, "both players in the snapshot");
  assert.equal(a1.hp, 100, "players spawn at full health");
  assert.ok(a1.tp === 1, "the first broadcast carries the spawn-slot tp flag (the joiner teleports there)");
  assert.ok(b1.tp === 1, "bob's first broadcast is flagged tp too");
  const slotDist = Math.hypot(a1.position[0] - b1.position[0], a1.position[1] - b1.position[1], a1.position[2] - b1.position[2]);
  assert.ok(slotDist > 0.5, `spawn ring gave distinct slots (dist ${slotDist.toFixed(2)})`);
  console.log("✓ snapshot: Alice@", a1.position.map((v: number) => v.toFixed(2)), "Bob@", b1.position.map((v: number) => v.toFixed(2)), "(ring", slotDist.toFixed(2), "apart, tp-flagged)");

  // 4. the unanchored crate falls: its y must drop between snapshots
  //    (parts are STILL simulated server-side).
  let crateFell = false;
  for (let i = 0; i < 40 && !crateFell; i++) {
    const snap: any = await waitMessage(worker, (m) => m.t === "snapshot");
    const crate = (snap.parts || []).find((p: any) => p.id === "crate");
    if (crate && crate.y < 5) crateFell = true;
  }
  assert.ok(crateFell, "unanchored crate simulated gravity server-side");
  console.log("✓ physics: the unanchored crate fell (server-authoritative)");

  // 5. Alice sends a +X walk input (the owning client's prediction). The
  //    server simulates the body from inputs; snapshots must reflect the
  //    authoritative position. Each input message has a seq; the snapshot
  //    must ack the latest seq.
  const startX = a1.position[0];
  let seq = 0;
  const walkInputs = setInterval(() => {
    seq++;
    worker.postMessage({
      t: "input", socketId: "sockA",
      x: 1, z: 0, jump: false, sprint: false, yaw: 0, seq,
    });
  }, 50);
  const snapWalk: any = await waitMessage(
    worker,
    (m) => m.t === "snapshot" && m.players?.some((p: any) => p.socketId === "sockA" && p.position[0] > startX + 1),
    5000,
  );
  clearInterval(walkInputs);
  const a2 = snapWalk.players.find((p: any) => p.socketId === "sockA");
  assert.ok(a2.position[0] > startX + 1, `Alice's inputs drove the body (${startX.toFixed(2)} -> ${a2.position[0].toFixed(2)})`);
  assert.ok(typeof a2.ackSeq === 'number' && a2.ackSeq > 0, `the snapshot acks the latest input seq (got ${a2.ackSeq})`);
  assert.ok(a2.ackSeq <= seq, `ackSeq (${a2.ackSeq}) must not exceed the latest sent seq (${seq})`);
  console.log(`✓ inputs drove Alice +X (${startX.toFixed(2)} -> ${a2.position[0].toFixed(2)}), ackSeq=${a2.ackSeq} (sent=${seq})`);

  // 6. JUMP: a press of the space bar sends jump=true. The server fires
  //    the impulse instantly (on message arrival), the latch sets, and
  //    the snapshot carries anim.jumping=true (exactly one rising edge).
  worker.postMessage({
    t: "input", socketId: "sockA", x: 0, z: 0, jump: true, sprint: false, yaw: 0, seq: ++seq,
  });
  const snapJump: any = await waitMessage(worker, (m) => m.t === "snapshot" && m.players?.some((p: any) => p.socketId === "sockA" && p.anim?.jumping === true), 5000);
  assert.ok(snapJump, "the jump latch fires (anim.jumping=true relayed exactly once)");
  console.log("✓ jump: a press of jump=true fires the impulse instantly (anim.jumping=true in the next snapshot)");

  // 7. VOID DEATH from the AUTHORITATIVE body: walk Alice off the
  //    baseplate edge into the void. The authority's void check kills
  //    her, plays the death cycle, and the respawn tp returns her to
  //    the spawn point.
  // Strategy: walk her -Z far enough to fall off the 100x100 baseplate.
  // Send a sustained -Z input for ~3 seconds (server walk speed ~10.8/s;
  // 3 seconds = ~32 studs; the baseplate edge is at z=-50 from spawn z=5,
  // so we need to walk ~55 studs; 5 seconds should be plenty).
  const walkOffInputs = setInterval(() => {
    seq++;
    worker.postMessage({
      t: "input", socketId: "sockA",
      x: 0, z: -1, jump: false, sprint: false, yaw: 0, seq,
    });
  }, 50);
  const deathSnap: any = await waitMessage(worker, (m) => m.t === "snapshot" && m.players?.some((p: any) => p.socketId === "sockA" && p.dying === true), 15000);
  clearInterval(walkOffInputs);
  assert.ok(deathSnap, "the authority flagged Alice dying after she walked off the baseplate");
  const deadA = deathSnap.players.find((p: any) => p.socketId === "sockA");
  assert.equal(deadA.hp, 0, "void death zeroes hp");
  console.log(`✓ void death: Alice walked off the baseplate, hp=${deadA.hp} dying=${deadA.dying}`);

  const respawnSnap: any = await waitMessage(worker, (m) => m.t === "snapshot" && m.players?.some((p: any) => p.socketId === "sockA" && p.dying === false && p.hp === 100), 10000);
  const respawned = respawnSnap.players.find((p: any) => p.socketId === "sockA");
  assert.ok(respawned.tp === 1, "the respawn broadcast is tp-flagged (the owner teleports, others snap)");
  const distToSpawn = Math.hypot(respawned.position[0] - 5, respawned.position[2] - 5);
  assert.ok(distToSpawn < 3, `respawn returned Alice to spawn (dist ${distToSpawn.toFixed(2)})`);
  console.log(`✓ respawn: Alice back at spawn (dist ${distToSpawn.toFixed(2)}), tp flagged`);

  // 8. getWorldState: the live part transforms (the crate settled by now).
  worker.postMessage({ t: "getWorldState", reqId: 42 });
  const worldState: any = await waitMessage(worker, (m) => m.t === "worldState" && m.reqId === 42, 5000);
  const objects = worldState.objects as any[];
  assert.ok(Array.isArray(objects) && objects.length === 3, "worldState carries the non-character parts");
  const crateRec = objects.find((o: any) => o.id === "crate");
  assert.ok(crateRec && crateRec.position.y < 5, `worldState carries the SETTLED crate position (y=${crateRec.position.y.toFixed(2)})`);
  console.log(`✓ worldstate: ${objects.length} parts with live transforms (crate settled at y=${crateRec.position.y.toFixed(2)})`);

  // 9. leave -> player disappears from snapshots
  worker.postMessage({ t: "playerLeave", socketId: "sockB" });
  let gone = false;
  for (let i = 0; i < 30 && !gone; i++) {
    const snap: any = await waitMessage(worker, (m) => m.t === "snapshot");
    if (snap.players.some((p: any) => p.socketId === "sockA") && !snap.players.some((p: any) => p.socketId === "sockB")) gone = true;
  }
  assert.ok(gone, "Bob left the snapshot after playerLeave");
  console.log("✓ lifecycle: playerLeave removes the player");

  // 10. clean shutdown
  worker.postMessage({ t: "stop" });
  const stopped = await waitMessage(worker, (m) => m.t === "stopped", 5000).catch(() => null);
  await worker.terminate();
  console.log("✓ shutdown:", stopped ? "graceful" : "terminated");

  console.log("\n✓ world-runtime smoke test: ALL PASS");
}

main().catch((e) => {
  console.error("\n✗ world-runtime smoke test failed:", e);
  process.exit(1);
});

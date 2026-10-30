// Smoke test: boot the world-runtime worker with a tiny world, join two
// players, send INPUT messages (the v6.4 CSP player channel), and verify
// the server-authoritative dynamic bodies move forward, ackSeq appears in
// snapshots, jumps fire, void deaths work + respawn, worldState works,
// and playerLeave removes the player.
// Usage: npx tsx tests/test-world-runtime.ts
//
// v6.4 CSP: the server SIMULATES each player's body itself (driven by
// game:input). The clients PREDICT the same movement locally and
// reconcile from the server's `ackSeq` field. This test drives the new
// protocol:
//   • `input` messages drive the dynamic body forward (+X walk)
//   • each player entry in the snapshot carries `ackSeq`
//   • a jump input fires the body's vertical velocity
//   • walking off the baseplate edge triggers a void death + respawn tp
//   • getWorldState returns the live part transforms
//   • playerLeave removes the player

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

// A small world: a 6x6 baseplate (so the player can walk off the edge
// quickly for the void death test), a Spawn part at the center, and a
// crate that should fall under gravity (proving parts still simulate).
const studioState = {
  objects: [
    // 6x6 baseplate at y=0 (top surface at 0.5). The player walks off
    // the +X edge at x=3 within ~0.4s of +X walk input.
    { id: 'base', name: 'Baseplate', type: 'Block',
      position: { x: 0, y: -0.5, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
      size: { x: 6, y: 1, z: 6 }, color: '#3d6666', material: 'Plastic',
      transparency: 0, reflectance: 0, anchored: true, canCollide: true,
      friction: 0.5, elasticity: 0.2, density: 1, isBaseplate: true,
      children: [], parentId: null, bodyMovers: [], effects: [], rules: [] },
    // v1.3 (CharacterRoot removed): a Spawn part drives the spawn point
    // (feet on its top surface), like a real published game. Center of
    // the baseplate so a +X walk heads for the edge.
    { id: 'spawn', name: 'Spawn', type: 'Spawn',
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
      size: { x: 1, y: 1, z: 1 }, color: '#4a90d9', material: 'Plastic',
      transparency: 0, reflectance: 0, anchored: true, canCollide: false,
      friction: 0.5, elasticity: 0.2, density: 1,
      isSpawnPoint: true, isCharacterPart: false,
      children: [], parentId: null, bodyMovers: [], effects: [], rules: [] },
    // An unanchored crate that should FALL (gravity) and appear in snapshots
    { id: 'crate', name: 'Crate', type: 'Block',
      position: { x: -2, y: 10, z: -2 }, rotation: { x: 0, y: 0, z: 0 },
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

let inputSeqA = 0;
let inputSeqB = 0;

async function main() {
  const worker = new Worker(bundle);
  worker.on("error", (e) => { console.error("worker error:", e); process.exit(1); });

  // 1. init -> ready
  worker.postMessage({ t: "init", studioState, maxPlayers: 10 });
  const ready = await waitMessage(worker, (m) => m.t === "ready", 20000);
  assert.ok(Array.isArray(ready.spawn) && ready.spawn.length === 3, "ready carries a spawn point");
  console.log("✓ ready: spawn", ready.spawn, "parts", ready.parts);

  // 2. join two players
  worker.postMessage({ t: "playerJoin", socketId: "sockA", username: "Alice" });
  worker.postMessage({ t: "playerJoin", socketId: "sockB", username: "Bob" });

  // 3. snapshots must arrive and contain both players at their RING slots,
  //    each flagged tp (the joiner's local body teleports to its slot)
  //    and each carrying ackSeq (the v6.4 CSP field).
  const snap1: any = await waitMessage(worker, (m) => m.t === "snapshot" && m.players?.length >= 2);
  const a1 = snap1.players.find((p: any) => p.socketId === "sockA");
  const b1 = snap1.players.find((p: any) => p.socketId === "sockB");
  assert.ok(a1 && b1, "both players in the snapshot");
  assert.equal(a1.hp, 100, "players spawn at full health");
  assert.ok(a1.tp === 1, "the first broadcast carries the spawn-slot tp flag (the joiner teleports there)");
  assert.ok(b1.tp === 1, "bob's first broadcast is flagged tp too");
  assert.ok(typeof a1.ackSeq === "number", "Alice's entry carries ackSeq (v6.4 CSP)");
  assert.ok(typeof b1.ackSeq === "number", "Bob's entry carries ackSeq (v6.4 CSP)");
  assert.equal(a1.ackSeq, 0, "ackSeq starts at 0 (no inputs applied yet)");
  const slotDist = Math.hypot(a1.position[0] - b1.position[0], a1.position[1] - b1.position[1], a1.position[2] - b1.position[2]);
  assert.ok(slotDist > 0.5, `spawn ring gave distinct slots (dist ${slotDist.toFixed(2)})`);
  console.log("✓ snapshot: Alice@", a1.position.map((v: number) => v.toFixed(2)), "Bob@", b1.position.map((v: number) => v.toFixed(2)), "(ring", slotDist.toFixed(2), "apart, tp-flagged, ackSeq present)");

  // 4. the unanchored crate falls: its y must drop between snapshots
  //    (parts are STILL simulated server-side - only characters are too now).
  let crateFell = false;
  for (let i = 0; i < 40 && !crateFell; i++) {
    const snap: any = await waitMessage(worker, (m) => m.t === "snapshot");
    const crate = (snap.parts || []).find((p: any) => p.id === "crate");
    if (crate && crate.y < 5) crateFell = true;
  }
  assert.ok(crateFell, "unanchored crate simulated gravity server-side");
  console.log("✓ physics: the unanchored crate fell (server-authoritative)");

  // 5. Alice sends +X walk input. The server integrates it against the
  //    dynamic body; snapshots must relay her NEW position with her
  //    ackSeq advancing (proof the server consumed her inputs).
  const startX = a1.position[0];
  const walkInputs = setInterval(() => {
    inputSeqA += 1;
    worker.postMessage({
      t: "input", socketId: "sockA",
      x: 1, z: 0, jump: false, sprint: false, yaw: 0, seq: inputSeqA,
    });
  }, 50);
  const snapWalk: any = await waitMessage(
    worker,
    (m) => m.t === "snapshot" && m.players?.some((p: any) => p.socketId === "sockA" && p.position[0] > startX + 1.5),
    8000,
  );
  clearInterval(walkInputs);
  const a2 = snapWalk.players.find((p: any) => p.socketId === "sockA");
  assert.ok(a2.position[0] > startX + 1.5, `Alice's inputs drove her body forward (${startX.toFixed(2)} -> ${a2.position[0].toFixed(2)})`);
  assert.ok(a2.ackSeq > 0, `ackSeq advanced (got ${a2.ackSeq}, was 0) - the server applied her inputs`);
  console.log(`✓ inputs drive body: Alice walked +X (${startX.toFixed(2)} -> ${a2.position[0].toFixed(2)}), ackSeq=${a2.ackSeq}`);

  // 6. A JUMP input fires the body's vertical velocity. Send a single
  //    jump input (the server consumes it instantly via tryJump); the
  //    next snapshot must show the body's Y above its starting Y.
  const preJumpY = a2.position[1];
  inputSeqA += 1;
  worker.postMessage({
    t: "input", socketId: "sockA",
    x: 0, z: 0, jump: true, sprint: false, yaw: 0, seq: inputSeqA,
  });
  const snapJump: any = await waitMessage(
    worker,
    (m) => m.t === "snapshot" && m.players?.some((p: any) => p.socketId === "sockA" && p.position[1] > preJumpY + 0.3),
    5000,
  );
  const a3 = snapJump.players.find((p: any) => p.socketId === "sockA");
  assert.ok(a3.position[1] > preJumpY + 0.3, `jump input fired (Y ${preJumpY.toFixed(2)} -> ${a3.position[1].toFixed(2)})`);
  console.log(`✓ jump fires: Y ${preJumpY.toFixed(2)} -> ${a3.position[1].toFixed(2)} (jump input consumed instantly)`);

  // 7. VOID DEATH: walk Alice off the +X edge of the 6x6 baseplate
  //    (she starts at center 0,0; the edge is at x=3). Walk input drives
  //    her forward; once she's past the edge gravity pulls her down into
  //    the void; the authority kills her, plays the death cycle, and the
  //    respawn tp returns her to the spawn point.
  const walkOff = setInterval(() => {
    inputSeqA += 1;
    worker.postMessage({
      t: "input", socketId: "sockA",
      x: 1, z: 0, jump: false, sprint: false, yaw: 0, seq: inputSeqA,
    });
  }, 50);
  const deathSnap: any = await waitMessage(worker, (m) => m.t === "snapshot" && m.players?.some((p: any) => p.socketId === "sockA" && p.dying === true), 10000);
  clearInterval(walkOff);
  const deadA = deathSnap.players.find((p: any) => p.socketId === "sockA");
  assert.ok(deadA, "the authority flagged Alice dying after she walked off the edge");
  assert.equal(deadA.hp, 0, "void death zeroes hp");
  console.log(`✓ void death: Alice walked off the baseplate edge and died (hp=${deadA.hp}, dying=true)`);

  // 8. Respawn: the death timer expires, the body is teleported to spawn,
  //    hp is restored, and the snapshot carries the tp flag.
  const respawnSnap: any = await waitMessage(worker, (m) => m.t === "snapshot" && m.players?.some((p: any) => p.socketId === "sockA" && p.dying === false && p.hp === 100), 10000);
  const respawned = respawnSnap.players.find((p: any) => p.socketId === "sockA");
  assert.ok(respawned.tp === 1, "the respawn broadcast is tp-flagged (the owner teleports, others snap)");
  const distToSpawn = Math.hypot(respawned.position[0] - 0, respawned.position[2] - 0);
  assert.ok(distToSpawn < 1.5, `respawn returned Alice to spawn (dist ${distToSpawn.toFixed(2)})`);
  console.log(`✓ respawn: Alice returned to spawn (dist ${distToSpawn.toFixed(2)}), hp=100, tp flagged`);

  // 9. getWorldState: the live part transforms (the crate settled by now).
  worker.postMessage({ t: "getWorldState", reqId: 42 });
  const worldState: any = await waitMessage(worker, (m) => m.t === "worldState" && m.reqId === 42, 5000);
  const objects = worldState.objects as any[];
  // baseplate + Spawn + crate = 3 parts (no character parts).
  assert.ok(Array.isArray(objects) && objects.length === 3, "worldState carries the non-character parts");
  const crateRec = objects.find((o: any) => o.id === "crate");
  assert.ok(crateRec && crateRec.position.y < 5, `worldState carries the SETTLED crate position (y=${crateRec.position.y.toFixed(2)})`);
  assert.ok(!objects.some((o: any) => o.id === "root"), "character parts are excluded");
  console.log(`✓ worldstate: ${objects.length} parts with live transforms (crate settled at y=${crateRec.position.y.toFixed(2)})`);

  // 10. leave -> player disappears from snapshots
  worker.postMessage({ t: "playerLeave", socketId: "sockB" });
  let gone = false;
  for (let i = 0; i < 30 && !gone; i++) {
    const snap: any = await waitMessage(worker, (m) => m.t === "snapshot");
    if (snap.players.some((p: any) => p.socketId === "sockA") && !snap.players.some((p: any) => p.socketId === "sockB")) gone = true;
  }
  assert.ok(gone, "Bob left the snapshot after playerLeave");
  console.log("✓ lifecycle: playerLeave removes the player");

  // 11. clean shutdown
  worker.postMessage({ t: "stop" });
  const stopped = await waitMessage(worker, (m) => m.t === "stopped", 5000).catch(() => null);
  await worker.terminate();
  console.log("✓ shutdown:", stopped ? "graceful" : "terminated");

  console.log("\n✓ world-runtime smoke test: ALL PASS");
}

main().catch((e) => {
  console.error("✗ world-runtime smoke test failed:", e);
  process.exit(1);
});

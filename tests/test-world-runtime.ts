// Smoke test: boot the world-runtime worker with a tiny world, join two
// players, exchange 0.25 s state reports (the Roblox-style player channel),
// and verify snapshots relay them with the light checks enforced.
// Usage: npx tsx tests/test-world-runtime.ts
//
// v6.2.6: the server no longer simulates characters (each client owns its
// own body and reports at 4 Hz). This test drives the NEW protocol:
//   • pstate reports are relayed in the next snapshot (positions + anim)
//   • the spawn ring assigns distinct slots and flags them tp
//   • light checks: a > 500-stud report jump is REJECTED (position kept)
//   • void deaths from reported positions + respawn tp
//   • getWorldState returns the live part transforms

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
  //    (parts are STILL simulated server-side - only characters are client-owned).
  let crateFell = false;
  for (let i = 0; i < 40 && !crateFell; i++) {
    const snap: any = await waitMessage(worker, (m) => m.t === "snapshot");
    const crate = (snap.parts || []).find((p: any) => p.id === "crate");
    if (crate && crate.y < 5) crateFell = true;
  }
  assert.ok(crateFell, "unanchored crate simulated gravity server-side");
  console.log("✓ physics: the unanchored crate fell (server-authoritative)");

  // 5. Alice reports walking +X (the owning client's simulation) -> the
  //    snapshots relay her reported position + anim flags.
  const startX = a1.position[0];
  let reportX = startX;
  const walkReports = setInterval(() => {
    reportX += 1.4; // a plausible 0.25 s of walking
    worker.postMessage({ t: "pstate", socketId: "sockA", x: reportX, y: a1.position[1], z: a1.position[2], yaw: 0, walking: true, jumping: false, sprint: false });
  }, 100);
  const snapWalk: any = await waitMessage(
    worker,
    (m) => m.t === "snapshot" && m.players?.some((p: any) => p.socketId === "sockA" && p.position[0] > startX + 3),
    5000,
  );
  clearInterval(walkReports);
  const a2 = snapWalk.players.find((p: any) => p.socketId === "sockA");
  assert.ok(a2.position[0] > startX + 3, `Alice's reports were relayed (${startX.toFixed(2)} -> ${a2.position[0].toFixed(2)})`);
  assert.strictEqual(a2.anim.walking, true, "the reported anim.walking flag rides the relay");
  console.log(`✓ reports relayed: Alice walked +X (${startX.toFixed(2)} -> ${a2.position[0].toFixed(2)}), anim.walking = true`);

  // 6. The jump latch flag round-trips verbatim.
  worker.postMessage({ t: "pstate", socketId: "sockA", x: a2.position[0], y: a2.position[1], z: a2.position[2], yaw: 0, walking: false, jumping: true, sprint: false });
  const snapJump: any = await waitMessage(worker, (m) => m.t === "snapshot" && m.players?.some((p: any) => p.socketId === "sockA" && p.anim?.jumping === true));
  assert.ok(snapJump, "the reported jumping flag is relayed verbatim");
  worker.postMessage({ t: "pstate", socketId: "sockA", x: a2.position[0], y: a2.position[1], z: a2.position[2], yaw: 0, walking: false, jumping: false, sprint: false });
  console.log("✓ jump flag relay: one pstate with jumping=true -> snapshot carries it");

  // 7. LIGHT CHECK: Bob reports a position 600 studs away -> REJECTED, the
  //    server keeps his last accepted position (the user's "500 studs in a
  //    frame" example).
  const bobLast: any = await waitMessage(worker, (m) => m.t === "snapshot" && m.players?.some((p: any) => p.socketId === "sockB"));
  const bobX = bobLast.players.find((p: any) => p.socketId === "sockB").position[0];
  worker.postMessage({ t: "pstate", socketId: "sockB", x: bobX + 600, y: 0, z: 0, yaw: 0, walking: false, jumping: false, sprint: false });
  await new Promise((r) => setTimeout(r, 700));
  // A keyframe re-broadcasts Bob (~every 2s): his position must still be near
  // the pre-attack spot (the 600-stud report was dropped).
  const bobAfter: any = await waitMessage(worker, (m) => m.t === "snapshot" && m.players?.some((p: any) => p.socketId === "sockB"), 8000);
  const bobXAfter = bobAfter.players.find((p: any) => p.socketId === "sockB").position[0];
  assert.ok(Math.abs(bobXAfter - bobX) < 5,
    `the 600-stud report must be REJECTED (kept ${bobX.toFixed(2)}, saw ${bobXAfter.toFixed(2)})`);
  console.log(`✓ light check: a 600-stud report jump was rejected (position kept at ${bobXAfter.toFixed(2)})`);

  // 7b. A sub-threshold move IS accepted (a fast but sane report).
  worker.postMessage({ t: "pstate", socketId: "sockB", x: bobXAfter + 5, y: 0, z: 0, yaw: 0, walking: false, jumping: false, sprint: false });
  const bobMoved: any = await waitMessage(worker, (m) => m.t === "snapshot" && m.players?.some((p: any) => p.socketId === "sockB" && Math.abs(p.position[0] - (bobXAfter + 5)) < 0.2), 8000);
  assert.ok(bobMoved, "a 5-stud report is accepted and relayed");
  console.log("✓ light check: a sane 5-stud report is accepted");

  // 8. VOID DEATH from a reported position: Alice reports herself below the
  //    void line -> the authority kills her, plays the death cycle, and the
  //    respawn tp returns her to the spawn point.
  const voidY = -50; // Math.min(-50, lowest - 30) with the baseplate at -0.5
  worker.postMessage({ t: "pstate", socketId: "sockA", x: 0, y: voidY - 10, z: 0, yaw: 0, walking: false, jumping: false, sprint: false });
  const deathSnap: any = await waitMessage(worker, (m) => m.t === "snapshot" && m.players?.some((p: any) => p.socketId === "sockA" && p.dying === true), 8000);
  assert.ok(deathSnap, "the authority flagged Alice dying after her void report");
  const deadA = deathSnap.players.find((p: any) => p.socketId === "sockA");
  assert.equal(deadA.hp, 0, "void death zeroes hp");
  const respawnSnap: any = await waitMessage(worker, (m) => m.t === "snapshot" && m.players?.some((p: any) => p.socketId === "sockA" && p.dying === false && p.hp === 100), 10000);
  const respawned = respawnSnap.players.find((p: any) => p.socketId === "sockA");
  assert.ok(respawned.tp === 1, "the respawn broadcast is tp-flagged (the owner teleports, others snap)");
  const distToSpawn = Math.hypot(respawned.position[0] - 5, respawned.position[2] - 5);
  assert.ok(distToSpawn < 3, `respawn returned Alice to spawn (dist ${distToSpawn.toFixed(2)})`);
  console.log(`✓ void death + respawn: reported y < voidY -> died -> respawn tp at spawn (dist ${distToSpawn.toFixed(2)})`);

  // 9. getWorldState: the live part transforms (the crate settled by now).
  worker.postMessage({ t: "getWorldState", reqId: 42 });
  const worldState: any = await waitMessage(worker, (m) => m.t === "worldState" && m.reqId === 42, 5000);
  const objects = worldState.objects as any[];
  // v1.3 (CharacterRoot removed): baseplate + Spawn + crate = 3 parts
  // (the old root part is gone; the Spawn part is a real, expected part).
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

// Smoke test: PLAYER COLLISIONS (v6.4 CSP).
//
// Reproduces the user's original bug report: a player walks into an
// unanchored ball, the ball does NOT move. Now that the server owns a
// DYNAMIC cannon body per player (v6.4: replaced the v6.3.0 kinematic
// hack), walking INTO the ball imparts an impulse on it via the contact
// solver.
//
// Test: spawn a player next to a small unanchored ball. Send a sustained
// +X walk input. The server-authoritative body walks into the ball; the
// ball's X position must change (it was pushed).

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
    // Baseplate at y=0 (top surface at 0.5).
    { id: 'base', name: 'Baseplate', type: 'Block',
      position: { x: 0, y: -0.5, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
      size: { x: 100, y: 1, z: 100 }, color: '#3d6666', material: 'Plastic',
      transparency: 0, reflectance: 0, anchored: true, canCollide: true,
      friction: 0.5, elasticity: 0.2, density: 1, isBaseplate: true,
      children: [], parentId: null, bodyMovers: [], effects: [], rules: [] },
    // Spawn part drives the spawn point.
    { id: 'spawn', name: 'Spawn', type: 'Spawn',
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
      size: { x: 1, y: 1, z: 1 }, color: '#4a90d9', material: 'Plastic',
      transparency: 0, reflectance: 0, anchored: true, canCollide: false,
      friction: 0.5, elasticity: 0.2, density: 1,
      isSpawnPoint: true, isCharacterPart: false,
      children: [], parentId: null, bodyMovers: [], effects: [], rules: [] },
    // THE BALL: small, unanchored, sitting right in the player's walking
    // path. The player spawns at (0,0,0) and walks +X; the ball is at
    // (1.5, 0.5, 0). The player's pill (radius ~0.4) will overlap it
    // once the player has walked ~0.5 studs forward.
    { id: 'ball', name: 'Ball', type: 'Sphere',
      position: { x: 1.5, y: 0.5, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
      size: { x: 1, y: 1, z: 1 }, color: '#ff5050', material: 'Plastic',
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

  worker.postMessage({ t: "init", studioState, maxPlayers: 10 });
  const ready = await waitMessage(worker, (m) => m.t === "ready", 20000);
  assert.ok(Array.isArray(ready.spawn), "ready carries spawn");
  console.log("✓ ready: spawn", ready.spawn);

  // Wait for the player + ball to settle on the baseplate.
  worker.postMessage({ t: "playerJoin", socketId: "sockA", username: "Alice" });
  const snap1: any = await waitMessage(worker, (m) => m.t === "snapshot" && m.players?.length >= 1);
  console.log("✓ joined: Alice at", snap1.players[0].position.map((v: number) => v.toFixed(2)));

  // Let the ball settle for ~1 second of sim time.
  let ballX0: number | null = null;
  for (let i = 0; i < 40; i++) {
    const snap: any = await waitMessage(worker, (m) => m.t === "snapshot");
    const ball = (snap.parts || []).find((p: any) => p.id === "ball");
    if (ball) {
      if (ballX0 === null) ballX0 = ball.x;
      // Stop early once the ball has a stable position (no more gravity jitter).
      if (i > 10) break;
    }
  }
  if (ballX0 === null) ballX0 = 1.5;
  console.log(`✓ ball settled at x=${ballX0.toFixed(3)}`);

  // Walk INTO the ball: send a sustained +X walk input. The server-authoritative
  // body walks forward at ~10.8 studs/s; the ball is at x=1.5 from the
  // player's spawn x=0, so contact happens within ~0.15s of motion.
  let seq = 0;
  const walkInputs = setInterval(() => {
    seq++;
    worker.postMessage({
      t: "input", socketId: "sockA",
      x: 1, z: 0, jump: false, sprint: false, yaw: 0, seq,
    });
  }, 50);

  // Watch snapshots for ~5 seconds; record the ball's max X displacement.
  let maxBallX = ballX0;
  let ballPushed = false;
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    try {
      const snap: any = await waitMessage(worker, (m) => m.t === "snapshot", 1500);
      const ball = (snap.parts || []).find((p: any) => p.id === "ball");
      if (ball) {
        if (Math.abs(ball.x - ballX0) > maxBallX - ballX0) maxBallX = ball.x;
        if (Math.abs(ball.x - ballX0) > 0.1) {
          ballPushed = true;
          break;
        }
      }
    } catch {
      break; // timeout, no more snapshots
    }
  }
  clearInterval(walkInputs);

  const displacement = Math.abs(maxBallX - ballX0);
  console.log(`✓ ball max X displacement: ${displacement.toFixed(3)} studs (from ${ballX0.toFixed(3)} to ${maxBallX.toFixed(3)})`);
  assert.ok(
    ballPushed,
    `BALL WAS NOT PUSHED: the player walked into the ball but its X stayed at ${ballX0.toFixed(3)} (displacement ${displacement.toFixed(3)} studs). This is the exact bug the user reported.`,
  );
  console.log("✓ PLAYER COLLISIONS: walking into the ball pushed it (the dynamic body works).");

  worker.postMessage({ t: "stop" });
  await waitMessage(worker, (m) => m.t === "stopped", 5000);
  console.log("✓ shutdown: graceful");
  console.log("\n✓ player-collision smoke test: ALL PASS");
}

main().catch((e) => {
  console.error("\n✗ player-collision smoke test FAILED:", e?.message || e);
  process.exit(1);
});

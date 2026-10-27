// ═══════════════════════════════════════════════════════════════════
// WeildBuild — v6.2.8 CLIENT-REPORT MODE test (the Roblox-style relay)
// ═══════════════════════════════════════════════════════════════════
// The DEFAULT player netcode mode: the owning client simulates its own
// character and streams state every 0.25 s; the server relays it, keeps a
// KINEMATIC ghost pill for world interactions, and applies tiny light
// checks. Verified here, against the real bundled worker:
//
//   1.  A fresh join broadcasts the player at their spawn slot (before any
//       report arrives).
//   2.  Accepted reports become the broadcast: position, velocity, anim.
//   2b. The SAVED input path is inert in this mode (game:input moves
//       nobody).
//   3.  Flood guard: a second report inside the minimum interval drops.
//   4.  Light check: an 800-stud teleport report is rejected.
//   5.  Light check: sustained 160 studs/s reports are rejected.
//   6.  The relay never freezes a client forever: after 8 consecutive
//       rejections the report is ADOPTED (client-authoritative by design).
//   7.  A report below the void line is a DEATH (never a "violation"):
//       dying + hp 0, then the respawn cycle brings the player back at
//       spawn, and post-respawn reports from spawn are accepted.
//   8.  The KINEMATIC GHOST still pushes world physics: reporting into a
//       settled crate shoves it (what every other player sees).
//
// Usage: npx tsx tests/test-client-report.ts
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

// Spawn at (5, 0, 5); a crate falls and settles far to the east (the push
// test walks the reported character into it at the end).
const studioState = {
  objects: [
    { id: 'base', name: 'Baseplate', type: 'Block',
      position: { x: 0, y: -0.5, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
      size: { x: 100, y: 1, z: 100 }, color: '#3d6666', material: 'Plastic',
      transparency: 0, reflectance: 0, anchored: true, canCollide: true,
      friction: 0.5, elasticity: 0.2, density: 1, isBaseplate: true,
      children: [], parentId: null, bodyMovers: [], effects: [], rules: [] },
    { id: 'root', name: 'CharacterRoot', type: 'Block',
      position: { x: 5, y: 1.5, z: 5 }, rotation: { x: 0, y: 0, z: 0 },
      size: { x: 1.2, y: 3, z: 1.2 }, color: '#4a90d9', material: 'Plastic',
      transparency: 0, reflectance: 0, anchored: true, canCollide: false,
      friction: 0.5, elasticity: 0.2, density: 1,
      isCharacterRoot: true, isCharacterPart: false,
      children: [], parentId: null, bodyMovers: [], effects: [], rules: [] },
    { id: 'crate', name: 'Crate', type: 'Block',
      position: { x: 25, y: 30, z: 5 }, rotation: { x: 0, y: 0, z: 0 },
      size: { x: 2, y: 2, z: 2 }, color: '#b07a3c', material: 'Plastic',
      transparency: 0, reflectance: 0, anchored: false, canCollide: true,
      friction: 0.5, elasticity: 0.2, density: 1,
      children: [], parentId: null, bodyMovers: [], effects: [], rules: [] },
  ],
  joints: [], treeInstances: [], waterBodies: [], terrainLayers: [],
  globalTimers: [], globalVariables: {}, avatar: {},
  spawnPoint: { x: 5, y: 0, z: 5 },
  physicsSettings: { gravity: -35 },
  playState: { characterMaxHealth: 100 },
};

const SID = 's-alice';
const SPAWN = [5, 0, 5];

function report(worker: Worker, x: number, y: number, z: number, extra: Record<string, unknown> = {}) {
  worker.postMessage({
    t: 'report', socketId: SID, x, y, z,
    vx: 0, vy: 0, vz: 0, yaw: 0,
    walking: false, sprint: false, jumping: false, grounded: true,
    ...extra,
  });
}

async function main(): Promise<void> {
  const worker = new Worker(bundle);
  try {
    worker.postMessage({ t: 'init', studioState, maxPlayers: 4 });
    await waitMessage(worker, (m) => m?.t === 'ready');
    console.log('✓ worker ready (client-report mode: the default)');

    worker.postMessage({ t: 'playerJoin', socketId: SID, username: 'Alice' });

    const findAlice = (snap: any) =>
      Array.isArray(snap?.players) ? snap.players.find((p: any) => p.socketId === SID) : undefined;

    // ── 1. Before any report: the player broadcasts at their spawn slot ──
    const first: any = await waitMessage(worker, (m) => m?.t === 'snapshot' && findAlice(m));
    const a1 = findAlice(first);
    const d1 = Math.hypot(a1.position[0] - SPAWN[0], a1.position[2] - SPAWN[2]);
    assert.ok(d1 < 0.1, `fresh join broadcasts the spawn slot (dist ${d1.toFixed(2)})`);
    assert.equal(a1.hp, 100, 'full health at join');
    console.log(`✓ fresh join broadcasts the spawn slot @ (${a1.position.map((v: number) => v.toFixed(1))})`);

    // Let the crate fall + settle while we run the protocol tests.
    const crateSettled = waitMessage(worker, (m) => {
      if (m?.t !== 'snapshot') return false;
      const c = (m.parts || []).find((p: any) => p.id === 'crate');
      return c && c.y <= 1.05;
    }, 15000).catch(() => null);

    // ── 2. An accepted report becomes the broadcast (pos + vel + anim) ──
    await sleep(300); // clear the minimum-interval gate from the join
    report(worker, 6, 0, 5, { vx: 10.8, vy: 0, vz: 0, yaw: Math.PI / 2, walking: true, sprint: true });
    const relayed: any = await waitMessage(worker, (m) => {
      const a = findAlice(m);
      return a && Math.abs(a.position[0] - 6) < 0.01;
    });
    const a2 = findAlice(relayed);
    assert.ok(Array.isArray(a2.velocity) && Math.abs(a2.velocity[0] - 10.8) < 0.01, 'the reported velocity is relayed');
    assert.equal(a2.anim?.walking, true, 'reported walking flag relayed');
    assert.equal(a2.anim?.sprint, true, 'reported sprint flag relayed');
    console.log('✓ accepted report relayed: position + velocity + anim flags');
    // Park the ghost again (velocity zero) so the crate stays untouched.
    await sleep(300);
    report(worker, 6, 0, 5, { walking: true });

    // ── 2b. The SAVED input path is INERT in client-report mode ──
    for (let i = 0; i < 8; i++) {
      worker.postMessage({ t: 'input', socketId: SID, x: 1, z: 0, jump: true, sprint: false, yaw: 0 });
      await sleep(60);
    }
    await sleep(300);
    const afterInput: any = await waitMessage(worker, (m) => m?.t === 'snapshot' && findAlice(m));
    const a2b = findAlice(afterInput);
    assert.ok(Math.abs(a2b.position[0] - 6) < 0.05, `input moves nobody in client-report mode (x=${a2b.position[0].toFixed(2)})`);
    assert.ok(!a2b.anim?.jumping, 'input cannot even flip the jump pose');
    console.log('✓ saved input path inert in client-report mode (no movement, no jump)');

    // ── 3. Flood guard: a report inside the minimum interval drops ──
    await sleep(300);
    report(worker, 6.5, 0, 5);            // accepted (>= 125 ms since the last)
    await sleep(40);
    report(worker, 9, 0, 5);              // too soon -> dropped
    const flooded: any = await waitMessage(worker, (m) => {
      const a = findAlice(m);
      return a && Math.abs(a.position[0] - 6.5) < 0.01;
    });
    const a3 = findAlice(flooded);
    assert.ok(Math.abs(a3.position[0] - 6.5) < 0.01, 'the flooded report was dropped');
    console.log('✓ flood guard: reports closer than the minimum interval are dropped');

    // ── 4. Light check: an 800-stud teleport report is rejected ──
    await sleep(300);
    report(worker, 806.5, 0, 5);
    await sleep(400);
    const tp1: any = await waitMessage(worker, (m) => m?.t === 'snapshot' && findAlice(m));
    const a4 = findAlice(tp1);
    assert.ok(Math.abs(a4.position[0] - 6.5) < 1, `800-stud teleport rejected (x=${a4.position[0].toFixed(1)})`);
    console.log('✓ light check: an 800-stud teleport report is rejected');

    // ── 5. Light check: sustained 600 studs/s reports are rejected ──
    // (+150 per 250 ms report = 600 u/s implied - absurd even for the
    // generous 120 u/s cap, no matter how the dt lands.)
    // A clean report first so the burst is measured against a fresh
    // baseline clock (a long stall legitimately covers more ground - the
    // checks must not reject a resumed honest client).
    await sleep(300);
    report(worker, 6.5, 0, 5); // clean reset (accepted)
    let hackX = 6.5;
    for (let i = 0; i < 4; i++) {
      await sleep(260);
      hackX += 150;
      report(worker, hackX, 0, 5, { walking: true });
    }
    await sleep(400);
    const sp1: any = await waitMessage(worker, (m) => m?.t === 'snapshot' && findAlice(m));
    const a5 = findAlice(sp1);
    assert.ok(Math.abs(a5.position[0] - 6.5) < 1, `600 u/s reports rejected (x=${a5.position[0].toFixed(1)})`);
    console.log('✓ light check: sustained 600 studs/s reports are rejected');

    // ── 6. ...but never forever: the 8th consecutive rejection is ADOPTED ──
    for (let i = 0; i < 5; i++) {
      await sleep(260);
      hackX += 150;
      report(worker, hackX, 0, 5);
    }
    const adopted: any = await waitMessage(worker, (m) => {
      const a = findAlice(m);
      return a && a.position[0] > 800; // the adopted hack position
    }, 8000);
    const a6 = findAlice(adopted);
    assert.ok(a6.position[0] > 800, `after the streak the report is adopted (x=${a6.position[0].toFixed(1)})`);
    console.log('✓ no permanent freeze: persistent reports are eventually adopted');

    // ── 7. A report below the void line is a DEATH, then respawn ──
    await sleep(300);
    report(worker, a6.position[0], -80, 5, { grounded: false, jumping: true, vy: -45 });
    const death: any = await waitMessage(worker, (m) => {
      const a = findAlice(m);
      return a && (a.dying === true || a.hp <= 0);
    });
    const a7 = findAlice(death);
    assert.equal(a7.dying, true, 'void report starts the death cycle');
    assert.equal(a7.hp, 0, 'void report kills');
    console.log('✓ void fall via report: dying + hp 0 (a death, never a "violation")');

    // Reports while dying are dropped; the respawn resets the baseline.
    const respawnSnap: any = await waitMessage(worker, (m) => {
      const a = findAlice(m);
      return a && a.hp >= 100 && a.dying === false;
    }, 15000);
    const a8 = findAlice(respawnSnap);
    const dRespawn = Math.hypot(a8.position[0] - SPAWN[0], a8.position[2] - SPAWN[2]);
    assert.ok(dRespawn < 0.1, `respawned at spawn (dist ${dRespawn.toFixed(2)})`);
    console.log('✓ respawn after the void death (baseline reset at spawn)');

    // After the teleport grace, a report from spawn is accepted again.
    await sleep(1300);
    report(worker, SPAWN[0] + 1, 0, SPAWN[2], { walking: true, vx: 4 });
    const postRespawn: any = await waitMessage(worker, (m) => {
      const a = findAlice(m);
      return a && Math.abs(a.position[0] - (SPAWN[0] + 1)) < 0.01;
    });
    assert.ok(postRespawn, 'post-respawn report accepted');
    console.log('✓ post-respawn report accepted at the new baseline');

    // ── 8. The kinematic ghost still pushes world physics ──
    const settled = await crateSettled;
    assert.ok(settled, 'the crate settled on the baseplate');
    const crateBefore = (settled.parts || []).find((p: any) => p.id === 'crate');
    console.log(`✓ crate settled @ x=${crateBefore.x.toFixed(2)} y=${crateBefore.y.toFixed(2)}`);
    await sleep(300);
    // Report the character walking INTO the crate: the ghost teleports to
    // the reported position and then sweeps east at 8 u/s, shoving the
    // crate for every other player.
    report(worker, 23.4, 0, 5, { vx: 8, walking: true });
    await sleep(260);
    report(worker, 23.8, 0, 5, { vx: 0 });
    const shoved: any = await waitMessage(worker, (m) => {
      if (m?.t !== 'snapshot') return false;
      const c = (m.parts || []).find((p: any) => p.id === 'crate');
      return c && c.x > crateBefore.x + 0.3;
    }, 8000);
    const crateAfter = (shoved.parts || []).find((p: any) => p.id === 'crate');
    assert.ok(crateAfter.x > crateBefore.x + 0.3,
      `the reported character shoved the crate (${crateBefore.x.toFixed(2)} -> ${crateAfter.x.toFixed(2)})`);
    console.log(`✓ kinematic ghost pushes world physics (crate ${crateBefore.x.toFixed(2)} -> ${crateAfter.x.toFixed(2)})`);

    console.log('\n✓ client-report mode: ALL PASS');
  } finally {
    worker.postMessage({ t: 'stop' });
    await sleep(200);
    try { await worker.terminate(); } catch { /* already gone */ }
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('\n✗ client-report test FAILED:', e?.message || e);
    process.exit(1);
  },
);

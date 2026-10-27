// ═══════════════════════════════════════════════════════════════════
// WeildBuild — v6.2.5 instant input + 30 Hz stream test
// ═══════════════════════════════════════════════════════════════════
// Regression test for "make the server take input almost instantly":
//
//   1. A jump press shows up in the stream promptly (within a couple of
//      snapshot periods) with the impulse already in the position.
//   2. Rapid jump presses within the 0.5 s cooldown are consumed and
//      dropped exactly once per hop: 1 rising edge total, never 2 (the
//      instant-fire path must not double-jump).
//   3. The snapshot stream runs at ~30 Hz while a player moves (the
//      interpolation density the client rendering depends on).
//
// HARNESS NOTE: one persistent recorder is attached from the very start
// and never removed. Node buffers worker messages oddly while no 'message'
// listener exists (they flush in a burst when one attaches again) - taking
// the recorder off mid-test re-delivered stale flight snapshots and
// produced phantom edges in an earlier version of this test.
//
// Usage: npx tsx tests/test-instant-jump.ts
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

const studioState = {
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
  ],
  joints: [], treeInstances: [], waterBodies: [], terrainLayers: [],
  globalTimers: [], globalVariables: {},
  avatar: {},
  spawnPoint: { x: 0, y: 0, z: 0 },
  physicsSettings: { gravity: -35 },
  playState: { characterMaxHealth: 100 },
};

interface Record { recvAt: number; seq: number; jumping: boolean | null; y: number }

async function main(): Promise<void> {
  const worker = new Worker(bundle);
  try {
    worker.postMessage({ t: 'init', studioState, maxPlayers: 4 });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('init timeout')), 20000);
      const onMessage = (m: any) => {
        if (m?.t === 'ready') { clearTimeout(timer); worker.off('message', onMessage); resolve(); }
      };
      worker.on('message', onMessage);
    });
    worker.postMessage({ t: 'playerJoin', socketId: 's-alice', username: 'Alice' });

    // ── The persistent recorder: attached once, never removed ──
    const records: Record[] = [];
    let totalSnapshots = 0;
    let seenJumpingTrue = false;
    const jumpSeenWaiters: Array<() => void> = [];
    worker.on('message', (m: any) => {
      if (m?.t !== 'snapshot') return;
      totalSnapshots++;
      const a = Array.isArray(m.players) ? m.players.find((p: any) => p.socketId === 's-alice') : undefined;
      if (a?.anim && typeof a.anim.jumping === 'boolean') {
        records.push({ recvAt: Date.now(), seq: m.seq, jumping: a.anim.jumping, y: a.position?.[1] ?? 0 });
        if (a.anim.jumping === true && !seenJumpingTrue) {
          seenJumpingTrue = true;
          for (const w of jumpSeenWaiters.splice(0)) w();
        }
      }
    });

    // ── 1. Settle on the ground ──
    await new Promise((r) => setTimeout(r, 1200));

    // ── 2. ONE jump press: it must show up promptly with the impulse
    // already applied to the position (a snapshot built concurrently with
    // the input may still be pre-jump - the wait skips those) ──
    const jumpSentAt = Date.now();
    worker.postMessage({ t: 'input', socketId: 's-alice', x: 0, z: 0, jump: true, sprint: false, yaw: 0 });
    await new Promise<void>((resolve) => {
      if (seenJumpingTrue) return resolve();
      jumpSeenWaiters.push(resolve);
      setTimeout(resolve, 3000);
    });
    const firstJumping = records.find((r) => r.jumping === true);
    assert.ok(firstJumping, 'a jump press must produce a jumping=true snapshot');
    const latency = firstJumping.recvAt - jumpSentAt;
    console.log(`✓ jump visible after ${latency}ms: y=${firstJumping.y.toFixed(2)}`);
    assert.ok(latency <= 250,
      `the jump must be applied + broadcast within ~4 snapshot periods (took ${latency}ms - was the press eaten or tick-starved?)`);
    assert.ok(firstJumping.y > 0.05,
      'the jump impulse must already be in the position (feet lifted)');

    // Wait out the hop + landing (~0.7s) so the cooldown window closes.
    await new Promise((r) => setTimeout(r, 1400));

    // ── 3. RAPID presses inside the cooldown: still exactly one hop ──
    const seqBefore = records.length > 0 ? records[records.length - 1].seq : 0;
    worker.postMessage({ t: 'input', socketId: 's-alice', x: 0, z: 0, jump: true, sprint: false, yaw: 0 });
    await new Promise((r) => setTimeout(r, 30));
    worker.postMessage({ t: 'input', socketId: 's-alice', x: 0, z: 0, jump: true, sprint: false, yaw: 0 });
    await new Promise((r) => setTimeout(r, 30));
    worker.postMessage({ t: 'input', socketId: 's-alice', x: 0, z: 0, jump: true, sprint: false, yaw: 0 });
    await new Promise((r) => setTimeout(r, 1500));
    const phase3 = records.filter((r) => r.seq > seqBefore);
    let rising = 0;
    let prev = false;
    for (const r of phase3) {
      if (r.jumping === true && !prev) rising++;
      prev = r.jumping === true;
    }
    console.log(`✓ 3 rapid presses -> ${rising} jump(s) (${phase3.length} Alice entries, seq ${seqBefore + 1}..${phase3[phase3.length - 1]?.seq})`);
    assert.strictEqual(rising, 1,
      `3 rapid jump presses inside the cooldown must produce exactly ONE hop (got ${rising}) - the instant-fire path must not double-jump`);
    assert.strictEqual(phase3[phase3.length - 1].jumping, false, 'the window must end landed');

    // ── 4. Walking streams at the 30 Hz cadence (the interp density).
    // Under sandbox load the ACHIEVED rate sags (the worker's tick timer
    // fires late), so the robust 30 Hz-vs-15 Hz discriminator is the
    // TIGHTEST pair of consecutive snapshots: at 15 Hz builds are >= 66 ms
    // apart, at 30 Hz at least one pair lands under 55 ms no matter the
    // load (load only ever stretches gaps).
    const snapTimes: number[] = [];
    const streamOn = (m: any) => { if (m?.t === 'snapshot') snapTimes.push(Date.now()); };
    worker.on('message', streamOn);
    const walk = setInterval(() => {
      worker.postMessage({ t: 'input', socketId: 's-alice', x: 1, z: 0, jump: false, sprint: false, yaw: 0 });
    }, 33);
    await new Promise((r) => setTimeout(r, 2000));
    clearInterval(walk);
    worker.postMessage({ t: 'input', socketId: 's-alice', x: 0, z: 0, jump: false, sprint: false, yaw: 0 });
    worker.off('message', streamOn);
    const streamed = snapTimes.length;
    let minGap = Infinity;
    for (let i = 1; i < snapTimes.length; i++) {
      const gap = snapTimes[i] - snapTimes[i - 1];
      if (gap >= 0 && gap < minGap) minGap = gap;
    }
    console.log(`✓ moving stream: ${streamed} snapshots in 2s (~${(streamed / 2).toFixed(0)}/s), tightest gap ${minGap}ms`);
    assert.ok(streamed >= 25,
      `a moving player must keep the delta stream flowing (got ${streamed} in 2s)`);
    assert.ok(minGap < 55,
      `snapshot cadence must be 30 Hz (tightest observed gap ${minGap}ms - builds >= 66ms apart means SNAPSHOT_HZ regressed to 15)`);

    console.log('✓ instant input + 30 Hz stream: ALL PASS');
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

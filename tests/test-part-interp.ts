// ═══════════════════════════════════════════════════════════════════
// WeildBuild — v6.2.7 part interpolation test
// ═══════════════════════════════════════════════════════════════════
// Regression test for the client-side part rendering that v6.2.7 runs
// on (the client no longer simulates physical objects in multiplayer -
// they render + collide from timestamped snapshot histories):
//
//   • samplePartInterp interpolates position LINEARLY and rotation
//     through the SHORTEST ARC per axis (350° -> 10° goes through 0°,
//     never the 340° long way around).
//   • A time gap (idle delta stream, packet hole) HOLDS the earlier
//     sample - no creep between distant positions.
//   • A teleport-class distance holds, then snaps exactly.
//   • The implied velocity of the interpolated pair is exposed (the
//     kinematic collider is driven with it, so platforms carry players).
//   • pushSnapshot feeds per-part histories; an idle gap clears the
//     stale samples so the next live sample lands FRESH; the 24-sample
//     rolling cap holds.
//   • `removed` (authority deletions) drop the part's history entirely.
//
// Usage: npx tsx tests/test-part-interp.ts
// (imports the synced engine copy - run `npm run build` first)

import assert from "node:assert";
import {
  samplePartInterp,
  pushSnapshot,
  getPartHistories,
  resetNetcodeBridge,
  PART_INTERP_DELAY_MS,
  INTERP_GAP_CAP_MS,
  INTERP_TELEPORT_STUDS,
  type PartSample,
} from "../engine/netcode-bridge";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function main(): void {
  // ── 1. Linear position + shortest-arc rotation between two samples ──
  {
    const buf: PartSample[] = [
      { id: 'p', t: 1000, x: 0, y: 0, z: 0, rx: 350, ry: 0, rz: 0 },
      { id: 'p', t: 1100, x: 10, y: 0, z: 0, rx: 10, ry: 0, rz: 0 },
    ];
    const mid = samplePartInterp(buf, 1050);
    assert.ok(mid, "mid-sample must resolve");
    assert.ok(Math.abs(mid.x - 5) < 1e-9, `linear midpoint expected 5, got ${mid.x}`);
    // 350 -> 10 across the 0 boundary must pass through 0, not 180.
    assert.ok(Math.abs(mid.rx) < 1e-6 || Math.abs(Math.abs(mid.rx) - 360) < 1e-6,
      `350° -> 10° must interpolate through 0°, got ${mid.rx} (long-way spin bug)`);
    // Implied velocity: 10 studs over 0.1s = 100 studs/s... no wait,
    // position spans 0 -> 10 in 100ms => vx = 100? It is 10 / 0.1 = 100.
    assert.ok(Math.abs(mid.vx - 100) < 1e-6, `vx expected 100 studs/s, got ${mid.vx}`);
  }

  // ── 2. Empty buffer → null; both ends hold ──
  {
    assert.strictEqual(samplePartInterp([], 1000), null, "empty buffer must sample to null");
    const buf: PartSample[] = [
      { id: 'p', t: 1000, x: 1, y: 1, z: 1, rx: 0, ry: 20, rz: 0 },
      { id: 'p', t: 1100, x: 2, y: 2, z: 2, rx: 0, ry: 40, rz: 0 },
    ];
    const before = samplePartInterp(buf, 500)!;
    assert.strictEqual(before.x, 1, "render clock before the buffer holds the FIRST sample");
    const after = samplePartInterp(buf, 5000)!;
    assert.strictEqual(after.x, 2, "render clock past the buffer holds the LAST sample (settled part)");
    assert.strictEqual(after.vx, 0, "a held end carries no velocity");
  }

  // ── 3. A time gap HOLDS - no creep between distant samples ──
  {
    const buf: PartSample[] = [
      { id: 'p', t: 1000, x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 },
      { id: 'p', t: 1600, x: 30, y: 0, z: 0, rx: 0, ry: 0, rz: 0 }, // 500 ms hole
    ];
    const held = samplePartInterp(buf, 1300)!;
    assert.strictEqual(held.x, 0,
      `a 500ms gap must hold the earlier sample, got x=${held.x} (slow creep bug)`);
  }

  // ── 4. A teleport holds, then snaps at the right moment ──
  {
    const buf: PartSample[] = [
      { id: 'p', t: 1000, x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 },
      { id: 'p', t: 1100, x: 100, y: 0, z: 0, rx: 0, ry: 0, rz: 0 },
    ];
    const before = samplePartInterp(buf, 1050)!;
    assert.strictEqual(before.x, 0, "before the teleport lands, the old position holds");
    const after = samplePartInterp(buf, 1100)!;
    assert.strictEqual(after.x, 100, "once the clock reaches the new sample it snaps");
  }

  // ── 5. Per-part histories: accumulate, idle-gap clear, rolling cap ──
  void (async () => {
    resetNetcodeBridge();
    const part = { id: 'crate', x: 1, y: 2, z: 3, rx: 0, ry: 0, rz: 0 };
    pushSnapshot({ parts: [part] });
    pushSnapshot({ parts: [{ ...part, x: 2 }] });
    pushSnapshot({ parts: [{ ...part, x: 3 }] });
    let hist = getPartHistories().get('crate');
    assert.ok(hist, "part history exists after the first snapshot");
    assert.strictEqual(hist.length, 3, "back-to-back part samples all land in the history");

    // Idle gap: the delta stream skips settled parts; the next live sample
    // must land FRESH (history cleared), never creep from the old spot.
    await sleep(INTERP_GAP_CAP_MS + 80);
    pushSnapshot({ parts: [{ ...part, x: 50 }] });
    hist = getPartHistories().get('crate')!;
    assert.strictEqual(hist.length, 1,
      `after a ${(INTERP_GAP_CAP_MS + 80).toFixed(0)}ms idle gap the part history restarts at the fresh sample`);
    assert.strictEqual(hist[0].x, 50, "the surviving sample is the FRESH one");

    // Rolling cap: 24 samples max.
    for (let i = 0; i < 40; i++) {
      pushSnapshot({ parts: [{ ...part, x: i }] });
    }
    hist = getPartHistories().get('crate')!;
    assert.strictEqual(hist.length, 24, `part history caps at 24 samples (got ${hist.length})`);
    assert.strictEqual(hist[hist.length - 1].x, 39, "the newest sample survived the cap");

    // ── 6. `removed` drops the part's history entirely ──
    pushSnapshot({ parts: [{ ...part, x: 100 }], removed: ['crate', 'never-existed'] });
    assert.ok(!getPartHistories().has('crate'),
      "an authority deletion must drop the part's interpolation history");
    assert.ok(!getPartHistories().has('never-existed'),
      "removing an unknown id is a harmless no-op");

    // A second part in the same world is untouched by the removal.
    pushSnapshot({ parts: [{ id: 'plank', x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 }] });
    pushSnapshot({ removed: ['crate'] });
    assert.ok(getPartHistories().has('plank'), "other parts keep their histories");

    resetNetcodeBridge();
    assert.strictEqual(getPartHistories().size, 0, "reset clears every part history");

    console.log('✓ part interpolation: ALL PASS');
    console.log(`  (part delay ${PART_INTERP_DELAY_MS}ms, gap cap ${INTERP_GAP_CAP_MS}ms, teleport ${INTERP_TELEPORT_STUDS} studs)`);
  })().catch((e) => {
    console.error('✗ part interp test FAILED:', e?.message || e);
    process.exit(1);
  });
}

main();

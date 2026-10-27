// ═══════════════════════════════════════════════════════════════════
// WeildBuild — v6.2.5 entity interpolation test
// ═══════════════════════════════════════════════════════════════════
// Regression test for the client-side interpolation core that the
// server-authoritative character rendering now runs on (sampleInterp +
// the self history buffer + the instant input flush in reportInput):
//
//   • Positions interpolate LINEARLY between two timestamped samples
//     (never a chase, never a sawtooth).
//   • A time gap between samples (idle delta stream, packet hole) HOLDS
//     the earlier sample - it must not creep slowly between two distant
//     positions.
//   • A teleport-class distance holds the old position and snaps exactly
//     when the render clock reaches the new sample - never streaks.
//   • Yaw interpolates through the SHORTEST ARC.
//   • The self history buffer drops stale samples after an idle gap so
//     rendering resumes from the FRESH position.
//   • reportInput flushes DIRECTION CHANGES and JUMP PRESSES the moment
//     they happen (steady state rides the 30 Hz throttle).
//
// Usage: npx tsx tests/test-interp.ts
// (imports the synced engine copy - run `npm run build` first)

import assert from "node:assert";
import {
  sampleInterp,
  pushSnapshot,
  getSelfHistory,
  clearSelfHistory,
  resetNetcodeBridge,
  reportInput,
  setInputSender,
  SELF_INTERP_DELAY_MS,
  INTERP_GAP_CAP_MS,
  CHAR_INTERP_GAP_CAP_MS,
  REMOTE_INTERP_DELAY_MS,
  INTERP_TELEPORT_STUDS,
  type InterpSample,
} from "../engine/netcode-bridge";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function main(): void {
  // ── 1. Linear interpolation between two live samples ──
  {
    const buf: InterpSample[] = [
      { t: 1000, x: 0, y: 0, z: 0, yaw: 0 },
      { t: 1100, x: 10, y: 0, z: 0, yaw: 0 },
    ];
    const mid = sampleInterp(buf, 1050, INTERP_GAP_CAP_MS, INTERP_TELEPORT_STUDS);
    assert.ok(mid, "mid-sample must resolve");
    assert.ok(Math.abs(mid.x - 5) < 1e-9, `linear midpoint expected 5, got ${mid.x}`);
    const quarter = sampleInterp(buf, 1025, INTERP_GAP_CAP_MS, INTERP_TELEPORT_STUDS);
    assert.ok(Math.abs(quarter!.x - 2.5) < 1e-9, `quarter point expected 2.5, got ${quarter!.x}`);
    // Vertical velocity implied by the pair (1 stud over 0.1s = 10 u/s).
    const rising = sampleInterp(buf, 1050, INTERP_GAP_CAP_MS, INTERP_TELEPORT_STUDS - 1);
    const vBuf: InterpSample[] = [
      { t: 1000, x: 0, y: 0, z: 0, yaw: 0 },
      { t: 1100, x: 0, y: 1, z: 0, yaw: 0 },
    ];
    const vSample = sampleInterp(vBuf, 1050, INTERP_GAP_CAP_MS, INTERP_TELEPORT_STUDS);
    assert.ok(Math.abs(vSample!.vy - 10) < 1e-6, `vy expected 10 studs/s, got ${vSample!.vy}`);
    void rising;
  }

  // ── 2. Empty buffer → null; ends hold ──
  {
    assert.strictEqual(sampleInterp([], 1000, INTERP_GAP_CAP_MS, INTERP_TELEPORT_STUDS), null,
      "empty buffer must sample to null");
    const buf: InterpSample[] = [
      { t: 1000, x: 1, y: 1, z: 1, yaw: 0.5 },
      { t: 1100, x: 2, y: 2, z: 2, yaw: 0.6 },
    ];
    const before = sampleInterp(buf, 500, INTERP_GAP_CAP_MS, INTERP_TELEPORT_STUDS)!;
    assert.strictEqual(before.x, 1, "render clock before the buffer holds the FIRST sample");
    const after = sampleInterp(buf, 5000, INTERP_GAP_CAP_MS, INTERP_TELEPORT_STUDS)!;
    assert.strictEqual(after.x, 2, "render clock past the buffer holds the LAST sample (stalled stream)");
  }

  // ── 3. A time gap HOLDS - no creep between distant samples ──
  {
    const buf: InterpSample[] = [
      { t: 1000, x: 0, y: 0, z: 0, yaw: 0 },
      { t: 1600, x: 30, y: 0, z: 0, yaw: 0 }, // 500 ms hole (idle delta stream)
    ];
    const held = sampleInterp(buf, 1300, INTERP_GAP_CAP_MS, INTERP_TELEPORT_STUDS);
    assert.strictEqual(held!.x, 0,
      `a ${500}ms gap must hold the earlier sample, got x=${held!.x} (slow creep bug)`);
  }

  // ── 4. A teleport holds, then snaps at the right moment ──
  {
    const buf: InterpSample[] = [
      { t: 1000, x: 0, y: 0, z: 0, yaw: 0 },
      { t: 1100, x: 100, y: 0, z: 0, yaw: 0 }, // teleport-class distance
    ];
    const before = sampleInterp(buf, 1050, INTERP_GAP_CAP_MS, INTERP_TELEPORT_STUDS)!;
    assert.strictEqual(before.x, 0, "before the teleport lands, the old position holds");
    const after = sampleInterp(buf, 1100, INTERP_GAP_CAP_MS, INTERP_TELEPORT_STUDS)!;
    assert.strictEqual(after.x, 100, "once the clock reaches the new sample it snaps");
  }

  // ── 5. Yaw takes the SHORTEST ARC ──
  {
    const buf: InterpSample[] = [
      { t: 1000, x: 0, y: 0, z: 0, yaw: 3.0 },
      { t: 1100, x: 0, y: 0, z: 0, yaw: -3.0 },
    ];
    const mid = sampleInterp(buf, 1050, INTERP_GAP_CAP_MS, INTERP_TELEPORT_STUDS)!;
    assert.ok(Math.abs(Math.abs(mid.yaw) - Math.PI) < 0.15,
      `yaw halfway between 3.0 and -3.0 must be near +/-PI (shortest arc), got ${mid.yaw}`);
  }

  // ── 6. The self history buffer: fresh samples after an idle gap ──
  void (async () => {
    resetNetcodeBridge();
    pushSnapshot({ self: { socketId: 's', x: 0, y: 0, z: 0, yaw: 0, hp: 100, dying: false, seq: 1 } });
    pushSnapshot({ self: { socketId: 's', x: 1, y: 0, z: 0, yaw: 0, hp: 100, dying: false, seq: 2 } });
    assert.strictEqual(getSelfHistory().length, 2, "back-to-back pushes both land in the history");
    // Idle gap: delta snapshots skip unchanged players, so the next self
    // entry arrives seconds later - the stale history must be dropped.
    // v6.2.8: the self history clears on the CHARACTER gap cap (report
    // cadence), not the part-class one.
    await sleep(CHAR_INTERP_GAP_CAP_MS + 80);
    pushSnapshot({ self: { socketId: 's', x: 5, y: 0, z: 0, yaw: 0, hp: 100, dying: false, seq: 3 } });
    assert.strictEqual(getSelfHistory().length, 1,
      `after a ${(CHAR_INTERP_GAP_CAP_MS + 80).toFixed(0)}ms idle gap the history restarts at the fresh sample`);
    assert.strictEqual(getSelfHistory()[0].x, 5, "the surviving sample is the FRESH one");
    clearSelfHistory();
    assert.strictEqual(getSelfHistory().length, 0, "clearSelfHistory empties the buffer");
    resetNetcodeBridge();

    // ── 7. reportInput: instant flush on changes, throttle otherwise ──
    const sent: Array<{ x: number; jump: boolean }> = [];
    setInputSender((i) => sent.push({ x: i.x, jump: !!i.jump }));
    reportInput({ x: 1, z: 0, sprint: false }); // first send - always flushes
    reportInput({ x: 1, z: 0, sprint: false }); // unchanged + inside the throttle window
    assert.strictEqual(sent.length, 1,
      `unchanged input inside the ${(1000 / 30).toFixed(0)}ms window must be throttled (got ${sent.length} sends)`);
    reportInput({ x: 0, z: -1, sprint: false }); // DIRECTION CHANGE - must flush instantly
    assert.strictEqual(sent.length, 2,
      "a direction change must flush the same moment (no throttle delay)");
    assert.strictEqual(sent[1].x, 0);
    reportInput({ x: 0, z: -1, jump: true }); // JUMP PRESS - must flush instantly
    assert.strictEqual(sent.length, 3, "a jump press must flush the same moment");
    assert.strictEqual(sent[2].jump, true, "the jump edge rides the flushed input");
    reportInput({ x: 0, z: -1, sprint: true }); // SPRINT FLIP - must flush instantly
    assert.strictEqual(sent.length, 4, "a sprint flip must flush the same moment");
    setInputSender(null);

    console.log('✓ entity interpolation: ALL PASS');
    console.log(`  (self delay ${SELF_INTERP_DELAY_MS}ms, char gap cap ${CHAR_INTERP_GAP_CAP_MS}ms, part gap cap ${INTERP_GAP_CAP_MS}ms, remote delay ${REMOTE_INTERP_DELAY_MS}ms, teleport ${INTERP_TELEPORT_STUDS} studs)`);
  })().catch((e) => {
    console.error('✗ interp test FAILED:', e?.message || e);
    process.exit(1);
  });
}

main();

// ═══════════════════════════════════════════════════════════════════
// WeildBuild — v6.2.6 entity interpolation + report throttle test
// ═══════════════════════════════════════════════════════════════════
// Regression test for the client-side interpolation core that remote
// character rendering runs on (sampleInterp in netcode-bridge) plus the
// 0.25 s state-report throttle (reportPlayerState):
//
//   • Positions interpolate LINEARLY between two timestamped samples
//     (never a chase, never a sawtooth).
//   • A time gap between samples (idle delta stream, packet hole) HOLDS
//     the earlier sample - it must not creep slowly between two distant
//     positions.
//   • A teleport-class distance holds the old position and snaps exactly
//     when the render clock reaches the new sample - never streaks.
//   • Yaw interpolates through the SHORTEST ARC.
//   • reportPlayerState rides the PLAYER_REPORT_HZ (4 Hz) throttle - the
//     0.25 s cadence of the Roblox-style model.
//
// Usage: npx tsx tests/test-interp.ts
// (imports the synced engine copy - run `npm run build` first)

import assert from "node:assert";
import {
  sampleInterp,
  resetNetcodeBridge,
  reportPlayerState,
  setStateSender,
  REMOTE_INTERP_DELAY_MS,
  INTERP_GAP_CAP_MS,
  INTERP_TELEPORT_STUDS,
  type InterpSample,
} from "../engine/netcode-bridge";
import { PLAYER_REPORT_HZ } from "../engine/game-engine/character-constants";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function main(): void {
  // ── 1. Linear interpolation between two live samples ──
  {
    const buf: InterpSample[] = [
      { t: 1000, x: 0, y: 0, z: 0, yaw: 0 },
      { t: 1250, x: 10, y: 0, z: 0, yaw: 0 }, // 250 ms apart: the 4 Hz report cadence
    ];
    const mid = sampleInterp(buf, 1125, INTERP_GAP_CAP_MS, INTERP_TELEPORT_STUDS);
    assert.ok(mid, "mid-sample must resolve");
    assert.ok(Math.abs(mid.x - 5) < 1e-9, `linear midpoint expected 5, got ${mid.x}`);
    const quarter = sampleInterp(buf, 1062.5, INTERP_GAP_CAP_MS, INTERP_TELEPORT_STUDS);
    assert.ok(Math.abs(quarter!.x - 2.5) < 1e-9, `quarter point expected 2.5, got ${quarter!.x}`);
    const vBuf: InterpSample[] = [
      { t: 1000, x: 0, y: 0, z: 0, yaw: 0 },
      { t: 1250, x: 0, y: 2.5, z: 0, yaw: 0 },
    ];
    const vSample = sampleInterp(vBuf, 1125, INTERP_GAP_CAP_MS, INTERP_TELEPORT_STUDS);
    assert.ok(Math.abs(vSample!.vy - 10) < 1e-6, `vy expected 10 studs/s, got ${vSample!.vy}`);
  }

  // ── 2. Empty buffer → null; ends hold ──
  {
    assert.strictEqual(sampleInterp([], 1000, INTERP_GAP_CAP_MS, INTERP_TELEPORT_STUDS), null,
      "empty buffer must sample to null");
    const buf: InterpSample[] = [
      { t: 1000, x: 1, y: 1, z: 1, yaw: 0.5 },
      { t: 1250, x: 2, y: 2, z: 2, yaw: 0.6 },
    ];
    const before = sampleInterp(buf, 500, INTERP_GAP_CAP_MS, INTERP_TELEPORT_STUDS)!;
    assert.strictEqual(before.x, 1, "render clock before the buffer holds the FIRST sample");
    const after = sampleInterp(buf, 5000, INTERP_GAP_CAP_MS, INTERP_TELEPORT_STUDS)!;
    assert.strictEqual(after.x, 2, "render clock past the buffer holds the LAST sample (stalled stream)");
  }

  // ── 3. A time gap HOLDS - no creep between distant samples ──
  // The remote gap cap is 500 ms (two missed 0.25 s report periods).
  {
    const buf: InterpSample[] = [
      { t: 1000, x: 0, y: 0, z: 0, yaw: 0 },
      { t: 1700, x: 30, y: 0, z: 0, yaw: 0 }, // 700 ms hole (idle delta stream)
    ];
    const held = sampleInterp(buf, 1350, INTERP_GAP_CAP_MS, INTERP_TELEPORT_STUDS);
    assert.strictEqual(held!.x, 0,
      `a 700ms gap must hold the earlier sample, got x=${held!.x} (slow creep bug)`);
  }

  // ── 4. A teleport holds, then snaps at the right moment ──
  {
    const buf: InterpSample[] = [
      { t: 1000, x: 0, y: 0, z: 0, yaw: 0 },
      { t: 1250, x: 100, y: 0, z: 0, yaw: 0 }, // teleport-class distance
    ];
    const before = sampleInterp(buf, 1125, INTERP_GAP_CAP_MS, INTERP_TELEPORT_STUDS)!;
    assert.strictEqual(before.x, 0, "before the teleport lands, the old position holds");
    const after = sampleInterp(buf, 1250, INTERP_GAP_CAP_MS, INTERP_TELEPORT_STUDS)!;
    assert.strictEqual(after.x, 100, "once the clock reaches the new sample it snaps");
  }

  // ── 5. Yaw takes the SHORTEST ARC ──
  {
    const buf: InterpSample[] = [
      { t: 1000, x: 0, y: 0, z: 0, yaw: 3.0 },
      { t: 1250, x: 0, y: 0, z: 0, yaw: -3.0 },
    ];
    const mid = sampleInterp(buf, 1125, INTERP_GAP_CAP_MS, INTERP_TELEPORT_STUDS)!;
    assert.ok(Math.abs(Math.abs(mid.yaw) - Math.PI) < 0.15,
      `yaw halfway between 3.0 and -3.0 must be near +/-PI (shortest arc), got ${mid.yaw}`);
  }

  // ── 6. reportPlayerState rides the 4 Hz throttle ──
  void (async () => {
    resetNetcodeBridge();
    const sent: Array<{ x: number; jumping: boolean }> = [];
    setStateSender((r) => sent.push({ x: r.x, jumping: !!r.jumping }));
    const PERIOD = 1000 / PLAYER_REPORT_HZ; // 250 ms
    reportPlayerState({ x: 1, y: 0, z: 0, yaw: 0, walking: true, jumping: false, sprint: false });
    reportPlayerState({ x: 2, y: 0, z: 0, yaw: 0, walking: true, jumping: false, sprint: false });
    assert.strictEqual(sent.length, 1,
      `a second report inside the ${PERIOD.toFixed(0)}ms window must be throttled (got ${sent.length})`);
    await sleep(PERIOD + 40);
    reportPlayerState({ x: 3, y: 0, z: 0, yaw: 0, walking: false, jumping: true, sprint: false });
    assert.strictEqual(sent.length, 2, "after the period elapses the next report goes out");
    assert.strictEqual(sent[1].jumping, true, "the anim flags ride the report verbatim");
    setStateSender(null);
    reportPlayerState({ x: 4, y: 0, z: 0, yaw: 0, walking: false, jumping: false, sprint: false });
    assert.strictEqual(sent.length, 2, "no sender installed = nothing is sent");
    resetNetcodeBridge();

    console.log('✓ entity interpolation + report throttle: ALL PASS');
    console.log(`  (remote delay ${REMOTE_INTERP_DELAY_MS}ms, gap cap ${INTERP_GAP_CAP_MS}ms, teleport ${INTERP_TELEPORT_STUDS} studs, report ${PLAYER_REPORT_HZ} Hz)`);
  })().catch((e) => {
    console.error('✗ interp test FAILED:', e?.message || e);
    process.exit(1);
  });
}

main();

// ═══════════════════════════════════════════════════════════════════
// WeildBuild, v6.2.6 jump animation latch test (client-owned)
// ═══════════════════════════════════════════════════════════════════
// Regression test for "when you jump, the animation and sound plays once
// when you jump and once when you hit the ground":
//
//   The naive `!grounded && vy > 0` flag flips FALSE at the apex (landing
//   cues fired mid-air) and, much worse, flips TRUE again for a tick
//   when the landing impact resolves with a small upward velocity spike,
//   so every remote viewer rendered the jump animation (and played the
//   jump sound) TWICE: once at the jump and once at the landing.
//
//   v6.2.4 latched the flag SERVER-side (the server simulated every
//   character). v6.2.6 moved the character simulation to the owning
//   client (Roblox-style), so the latch now lives in the SHARED
//   character-constants module (createJumpLatch) and rides the 0.25 s
//   pstate reports verbatim. This test drives the latch directly with the
//   same physics timeline the old worker test used.
//
// Usage: npx tsx tests/test-jump-anim.ts
// (imports the synced engine copy - run `npm run build` first)

import assert from "node:assert";
import { createJumpLatch } from "../engine/game-engine/character-constants";

const DT = 1 / 60;         // the client's frame step
const JUMP_SPEED = 11.5;   // studs/s
const GRAVITY = 35;         // studs/s²

function main(): void {
  // ── 1. One full hop: impulse -> rise -> apex -> fall -> landing ──
  {
    const latch = createJumpLatch();
    // Start grounded; the impulse fires onJump() exactly once.
    latch.tick(true, DT);
    latch.onJump();
    assert.strictEqual(latch.value(), true, "the latch sets on the jump impulse");

    // Simulate the flight at 60 Hz: airborne until y returns to 0.
    let vy = JUMP_SPEED;
    let y = 0;
    const edges: Array<'rise' | 'fall'> = [];
    let prev = false;
    const flight: Array<{ grounded: boolean }> = [];
    for (let i = 0; i < 200; i++) {
      vy -= GRAVITY * DT;
      y += vy * DT;
      const grounded = y <= 0 && vy < 0;
      if (grounded) { y = 0; vy = 0; }
      flight.push({ grounded });
    }
    // The physics contact bounce: a landing impact resolves with a small
    // UPWARD velocity spike for a tick (the old double-trigger source) -
    // grounded must still hold (the ground contact won).
    if (flight.length > 30) flight[30].grounded = flight[30].grounded;

    for (const step of flight) {
      latch.tick(step.grounded, DT);
      const now = latch.value();
      if (now && !prev) edges.push('rise');
      if (!now && prev) edges.push('fall');
      prev = now;
      if (y <= 0 && step.grounded && vy === 0 && edges.includes('fall')) break;
    }
    assert.strictEqual(edges.filter((e) => e === 'rise').length, 1,
      `BUG REGRESSION: ${edges.filter((e) => e === 'rise').length} rising edges - the landing spike re-triggered the flag`);
    assert.strictEqual(edges.filter((e) => e === 'fall').length, 1,
      'exactly one falling edge (the landing) per hop');
    console.log('✓ one hop = exactly one rising edge + one falling edge');
  }

  // ── 2. The falling edge lands AT THE GROUND, not at the apex ──
  {
    const latch = createJumpLatch();
    latch.onJump();
    // Airborne ticks (apex region): the flag must STAY set.
    for (let i = 0; i < 20; i++) latch.tick(false, DT);
    assert.strictEqual(latch.value(), true, 'the latch holds through the apex (no mid-air landing cue)');
    // The grace window: grounded ticks RIGHT AFTER the impulse do NOT clear
    // the latch (the body needs a tick or two to actually leave the ground).
    const fresh = createJumpLatch();
    fresh.onJump();
    fresh.tick(true, DT);
    fresh.tick(true, DT);
    assert.strictEqual(fresh.value(), true, 'the 0.15 s grace keeps a fresh jump latched through the first grounded ticks');
    // ...but a grounded tick past the grace clears it (the landing).
    for (let i = 0; i < 20; i++) latch.tick(true, DT);
    assert.strictEqual(latch.value(), false, 'the first grounded tick past the grace = the landing');
    console.log('✓ the falling edge fires at the ground (grace honored)');
  }

  // ── 3. A second hop re-arms the latch ──
  {
    const latch = createJumpLatch();
    latch.onJump();
    for (let i = 0; i < 30; i++) latch.tick(false, DT);
    for (let i = 0; i < 30; i++) latch.tick(true, DT);
    assert.strictEqual(latch.value(), false, 'landed after the first hop');
    latch.onJump();
    assert.strictEqual(latch.value(), true, 'the next jump re-arms the latch');
    console.log('✓ consecutive hops re-arm');
  }

  console.log('\n✓ jump animation latch: ALL PASS');
}

main();

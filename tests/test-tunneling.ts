// ═══════════════════════════════════════════════════════════════════
// WeildBuild, v6.2.4 anti-tunneling test (adaptive substepping)
// ═══════════════════════════════════════════════════════════════════
// Regression test for "characters sometimes pass through unanchored
// parts":
//
//   cannon-es has no CCD. A fast unanchored part (the part speed cap is
//   120 u/s = 2 studs per 60 Hz step) could cross a character pill's
//   whole contact band (sphere R 0.4 + brick half-extent) in ONE
//   integration step and tunnel straight through - and a fast-falling
//   character could tunnel through thin bricks the same way.
//
//   The fix: PhysicsWorld.step() raises the cannon fixed-step frequency
//   while anything dynamic is fast, keeping every step's travel at ~0.5
//   studs. This test flings a brick at 100 u/s through a standing
//   character and asserts it NEVER passes through.
//
// Usage: npx tsx tests/test-tunneling.ts

import assert from "node:assert";
import { PhysicsWorld } from "../engine/game-engine/physics";
import type { StudioPart } from "../engine/studio-store";

function makePart(overrides: Partial<StudioPart> & { id: string }): StudioPart {
  return {
    id: overrides.id,
    name: overrides.id,
    type: 'Block',
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    size: { x: 1, y: 1, z: 1 },
    color: '#cccccc',
    material: 'Plastic',
    transparency: 0,
    reflectance: 0,
    anchored: false,
    canCollide: true,
    friction: 0.5,
    elasticity: 0.2,
    density: 1,
    children: [],
    parentId: null,
    bodyMovers: [],
    effects: [],
    rules: [],
    ...overrides,
  } as StudioPart;
}

async function main(): Promise<void> {
  const world = new PhysicsWorld({
    gravity: -35,
    collisionsEnabled: true,
    waterForce: 0,
    waterDirection: { x: 0, y: 0, z: 0 },
    experimentalSolver: false,
  } as any);

  // Floor: top surface at y = 0
  world.addBody(makePart({
    id: 'floor', anchored: true,
    position: { x: 0, y: -1, z: 0 },
    size: { x: 100, y: 2, z: 100 },
  }));

  // The character: default pill standing at the origin.
  world.addCharacterBody({ x: 0, y: 0, z: 0 }, { size: { x: 0.8, y: 2, z: 0.8 } });

  // The projectile: a THIN unanchored brick (0.4 thick) at chest height,
  // 12.4 studs away on -Z (the distance is tuned: at 100 u/s a 60 Hz step
  // travels 1.67 studs and the pill+brick contact band is 1.2 wide, so
  // step 7 lands at -0.73 (just outside) and step 8 at +0.93 (through) -
  // WITHOUT substepping this exact setup tunnels; see the control note in
  // the header).
  const brick = makePart({
    id: 'brick', anchored: false,
    position: { x: 0, y: 1.0, z: -12.4 },
    size: { x: 1, y: 1, z: 0.4 },
  });
  world.addBody(brick);

  // Impulse: mass of a 1x1x0.4 plastic brick is 0.4 (volume * density 1),
  // so force 40 gives ~100 u/s of launch speed.
  world.addImpulse('brick', { x: 0, y: 0, z: 40 }, 0.01);

  let maxSpeed = 0;
  let maxZ = -Infinity;
  let charMoved = false;
  const charStartX = 0;

  // Simulate 1.5 seconds at 60 steps/s (the client's frame cadence).
  for (let i = 0; i < 90; i++) {
    world.step(1 / 60);
    const brickBody = world.bodies.get('brick');
    const charBody = world.characterBody;
    assert.ok(brickBody, 'brick body vanished');
    const speed = Math.hypot(brickBody.velocity.x, brickBody.velocity.y, brickBody.velocity.z);
    if (speed > maxSpeed) maxSpeed = speed;
    if (brickBody.position.z > maxZ) maxZ = brickBody.position.z;
    if (charBody && Math.abs(charBody.position.x - charStartX) > 0.05) charMoved = true;
  }

  console.log(`✓ brick launch speed: ${maxSpeed.toFixed(1)} u/s (per 60Hz step: ${(maxSpeed / 60).toFixed(2)} studs)`);
  console.log(`✓ brick farthest Z reached: ${maxZ.toFixed(2)} (character stands at Z = 0)`);
  console.log(`✓ character was ${charMoved ? 'shoved by the impact (real collision)' : 'NOT moved'}`);

  assert.ok(maxSpeed > 60, `the brick must actually fly fast to test tunneling (got ${maxSpeed.toFixed(1)} u/s)`);

  // Without the fix the brick crossed the character's whole contact band in
  // one step and ended up at Z = +12 or beyond. With adaptive substepping
  // it must collide: it can bounce, rest against the pill, or shove the
  // character aside - but it must never fly THROUGH.
  assert.ok(maxZ < 4,
    `BUG REGRESSION: the brick tunneled through the character (reached Z = ${maxZ.toFixed(2)})`);
  assert.ok(charMoved || maxZ < 1.5,
    'the brick must have collided with the character (shove it or stop against it)');

  // ── Part 2: a fast-falling character must not tunnel through a thin
  //    unanchored plate lying on the ground either. Several drop heights
  //    are swept because discrete 60 Hz tunneling is alignment-dependent:
  //    without substepping at least one height's step lattice straddles
  //    the whole contact band; with substepping (0.5 studs/step max) no
  //    height ever can. ──
  const heights = [40, 50, 60, 70, 80];
  let worstPeakFallSpeed = 0;
  for (const dropH of heights) {
    const world2 = new PhysicsWorld({
      gravity: -35,
      collisionsEnabled: true,
      waterForce: 0,
      waterDirection: { x: 0, y: 0, z: 0 },
      experimentalSolver: false,
    } as any);
    world2.addBody(makePart({
      id: 'floor2', anchored: true,
      position: { x: 0, y: -1, z: 0 },
      size: { x: 100, y: 2, z: 100 },
    }));
    // A thin unanchored plate resting on the floor, directly under the drop.
    world2.addBody(makePart({
      id: 'plate', anchored: false,
      position: { x: 30, y: 0.1, z: 0 },
      size: { x: 3, y: 0.2, z: 3 },
    }));
    world2.addCharacterBody({ x: 30, y: dropH, z: 0 }, { size: { x: 0.8, y: 2, z: 0.8 } });

    let landedOnPlate = false;
    let tunneledBelow = false;
    let peakFallSpeed = 0;
    for (let i = 0; i < 300; i++) {
      world2.step(1 / 60);
      const cb = world2.characterBody!;
      const vy = Math.abs(cb.velocity.y);
      if (vy > peakFallSpeed) peakFallSpeed = vy;
      const feetY = cb.interpolatedPosition.y - 1;
      if (feetY <= 0.35 && feetY > -0.5) landedOnPlate = true;
      if (feetY < -1.5) tunneledBelow = true; // through the plate AND the floor
    }
    if (peakFallSpeed > worstPeakFallSpeed) worstPeakFallSpeed = peakFallSpeed;
    console.log(`✓ drop from ${dropH}: fall speed peaked at ${peakFallSpeed.toFixed(1)} u/s (${(peakFallSpeed / 60).toFixed(2)} studs/step), landed on the plate: ${landedOnPlate}, tunneled: ${tunneledBelow}`);
    assert.ok(!tunneledBelow, `BUG REGRESSION: the character tunneled through the thin plate (drop from ${dropH})`);
    assert.ok(landedOnPlate, `the character must come to rest ON the thin unanchored plate (drop from ${dropH})`);
  }
  console.log(`✓ worst fall speed across heights: ${worstPeakFallSpeed.toFixed(1)} u/s`);

  console.log('✓ anti-tunneling adaptive substeps: ALL PASS');
}

main().catch((e) => {
  console.error('✗', e.message);
  process.exit(1);
});

// ═══════════════════════════════════════════════════════════════════
// WeildBuild — character movement constants (v1.1, SHARED)
// ═══════════════════════════════════════════════════════════════════
// Single source of truth for the character FEEL. Imported by BOTH:
//   • the client play viewport (local prediction - singleplayer AND the
//     prediction layer of multiplayer), and
//   • the gamehost's server-authoritative worker (the authority in MP).
// Keeping them in one module means the server sim and the client
// prediction step the exact same math, so divergence stays tiny and
// reconciliation is a gentle lerp instead of a snap.

/** Ground walk speed (studs/second). */
export const CHAR_WALK_SPEED = 10.8;
/** Sprint multiplier (Shift / mobile SPRINT). */
export const CHAR_SPRINT_MULT = 1.7;
/** Jump impulse velocity (studs/second, applied to body.velocity.y). */
export const CHAR_JUMP_SPEED = 11.5;
/** Minimum seconds between jump starts. */
export const JUMP_COOLDOWN_SECONDS = 0.5;
/** Fraction of horizontal velocity kept at jump START (running jump = hop). */
export const JUMP_HORIZONTAL_KEEP = 0.7;
/** Airborne walk input steers at this fraction of ground speed. */
export const AIR_MOVE_FACTOR = 0.85;
/** Airborne release decay rate (soft glide, ~0.6 stud carry). */
export const AIR_RELEASE_DECAY = 0.4;
/** Ground acceleration ramp (walking). */
export const ACCEL_WALK = 0.28;
/** Ground stop ramp (releasing the keys - the crisp 0.1s stop). */
export const ACCEL_STOP = 3.5;
/** Tick rate of the authoritative server sim (Hz). */
export const SERVER_SIM_HZ = 30;
/** Snapshot broadcast rate to clients (Hz). v6.2.5: 15 -> 30 - the
 * denser stream is what client-side entity interpolation runs on (the
 * render clock lags ~100-150 ms behind arrival, so more samples per
 * second = smoother motion and fresher data). Delta filtering keeps the
 * bandwidth close to the old 15 Hz idle cost. */
export const SERVER_SNAPSHOT_HZ = 30;
/** Client input send rate (Hz). v6.2.5: 20 -> 30 steady state; direction
 * changes and jump presses flush IMMEDIATELY (see reportInput in
 * netcode-bridge) so the authority reacts the moment a key changes. */
export const CLIENT_INPUT_HZ = 30;

/**
 * The shared velocity-integration core. Given the previous horizontal
 * velocity, the desired input direction (camera-relative, unit length or
 * zero), and the grounded flag, produces the next velocity - the SAME math
 * the client prediction runs, executed by the server authority.
 *
 * `inputX/inputZ` must already be normalized to unit length (or 0,0).
 */
export function stepHorizontalVelocity(
  velX: number,
  velZ: number,
  inputX: number,
  inputZ: number,
  sprint: boolean,
  grounded: boolean,
  dt: number,
): { velX: number; velZ: number } {
  const isWalking = Math.hypot(inputX, inputZ) > 0.01;
  const speedMult = sprint ? CHAR_SPRINT_MULT : 1.0;
  const targetX = inputX * CHAR_WALK_SPEED * speedMult;
  const targetZ = inputZ * CHAR_WALK_SPEED * speedMult;

  const accelLerp = grounded
    ? (isWalking ? ACCEL_WALK : ACCEL_STOP)
    : (isWalking ? ACCEL_WALK : AIR_RELEASE_DECAY);
  const t = 1 - Math.exp(-accelLerp * 30 * dt);
  return {
    velX: velX + (targetX - velX) * t,
    velZ: velZ + (targetZ - velZ) * t,
  };
}

/**
 * Apply a jump to a body velocity, honoring the cooldown. Returns the new
 * vertical velocity (and scaled horizontal pair) when the jump fires, or
 * null when it may not (cooldown / airborne).
 */
export function applyJump(
  velX: number,
  velY: number,
  velZ: number,
  cooldownRemaining: number,
): { x: number; y: number; z: number } | null {
  if (cooldownRemaining > 0) return null;
  return {
    x: velX * JUMP_HORIZONTAL_KEEP,
    y: CHAR_JUMP_SPEED,
    z: velZ * JUMP_HORIZONTAL_KEEP,
  };
}

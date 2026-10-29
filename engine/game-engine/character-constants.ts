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
// ─── v6.2.6: ROBLOX-STYLE CLIENT-AUTHORITATIVE PLAYERS ───
/** How often each client reports its character state to the server
 * (Hz). v1.3 (user request: "upload the player's position as soon as
 * the player changes position, or every 0.05 seconds"): raised from
 * 4 Hz to 20 Hz (one report per 0.05 s at most). The reporter in
 * netcode-bridge also sends IMMEDIATELY when the position/rotation
 * changed since the last report (still capped by this rate), and keeps
 * a slow 2 Hz keepalive when standing perfectly still. The owning
 * client simulates its own character (full singleplayer feel) and the
 * server relays the reports to everyone else, who interpolate between
 * them - the denser stream makes remote players look smoother too. */
export const PLAYER_REPORT_HZ = 20;
/** Idle keepalive (Hz): while the player has NOT moved, a report is
 * still sent at this rate so the server keeps seeing a live client
 * (presence, light checks, interpolation gap timeouts). */
export const PLAYER_KEEPALIVE_HZ = 2;
/** Light check (anti-cheat-lite, user-accepted): one report may not move
 * a player more than this many studs from the last accepted position
 * (user's example: "moving 500 studs/units in a frame"). Anything past
 * it is rejected server-side. */
export const PLAYER_LIGHT_CHECK_STUDS = 500;

/**
 * v6.2.6: the client-side jump LATCH for reported anim state. The naive
 * `!grounded && vy > 0` flag flips false at the jump apex and true again
 * on landing-impact spikes - remote viewers rendered the jump animation
 * and sound TWICE (the v6.2.4 server bug, now owned by the reporter).
 * The latch is set by the actual jump impulse and cleared by the first
 * grounded tick after a 0.15 s grace: exactly one rising edge (the jump)
 * and one falling edge (the landing) per hop, which the server relays
 * verbatim and every other client renders.
 */
export function createJumpLatch() {
  let latched = false;
  let age = 0;
  return {
    /** True while the current hop's jump flag should be reported. */
    value(): boolean {
      return latched;
    },
    /** Call on the frame a REAL jump impulse fires. */
    onJump(): void {
      latched = true;
      age = 0;
    },
    /** Call every frame with the grounded flag + dt. */
    tick(grounded: boolean, dt: number): void {
      if (!latched) return;
      age += dt;
      if (grounded && age > 0.15) {
        latched = false;
        age = 0;
      }
    },
  };
}

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

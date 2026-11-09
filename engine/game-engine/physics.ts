/**
 * WeildBuild Physics Engine - Rapier backend (pass 28)
 *
 * The great engine swap: cannon-es is OUT, Rapier is IN (owner decision -
 * "modern, better and faster"). The public API stays IDENTICAL so the
 * studio viewports and the server's world-runtime keep working; the two
 * cannon-leaky spots (getCannonBody / raw characterBody) became neutral
 * accessors (see the bottom of the class + CharacterBodyView).
 *
 * Why it's safe:
 * - scripts/rapier-spike.ts (pass 27) proved every feature this file uses
 *   against the real @dimforge/rapier3d-compat 0.21 in plain Node: bodies,
 *   shapes (box/ball/capsule/convex hull/heightfield), joints (fixed/
 *   revolute+motor/rope), raycasts, determinism (bit-exact across two
 *   identically-stepped worlds - the client/server lockstep precondition)
 *   and perf (1,000 dynamic boxes ~5 ms/step).
 * - A headless behavioral suite (scripts/verify-physics-rapier.ts, run by
 *   the verifier) drives THIS class: fall/land, anchored, canCollide,
 *   wedge slope, sphere, impulses, terrain height ordering, character
 *   walk/jump/wall-slide, named kinematic proxies pushing parts, sleep,
 *   determinism.
 *
 * Porting notes (differences that matter):
 * - ASYNC INIT: the compat package must RAPIER.init() (wasm, ~70 ms) before
 *   any world can be built. Init is kicked at module load; every mutating
 *   API called before it completes queues a thunk that is flushed the
 *   moment the wasm is ready (usually long before the user presses Play -
 *   the import happens at app boot / worker boot). Mirrors (this.bodies)
 *   are created immediately, so store syncs never see a missing entry.
 * - FRICTION/RESTITUTION are per-collider in Rapier (no material pairs).
 *   Parts carry their own coefficients with the default Average combine;
 *   terrain/tree colliders use friction 0 + the Max rule so the PART's
 *   coefficients win exactly (what cannon's ContactMaterial(default, mat)
 *   did); the character pill uses friction 0 + Min (frictionless - walls
 *   never grab, min(0, f) = 0) and swaps to friction 1.0 + Max while
 *   standing (max(1, f) = 1 - plants on slopes, exactly cannon's standing
 *   material). The pair rule Rapier applies is the higher-precedence rule
 *   of the two colliders (Average < Min < Multiply < Max).
 * - THE CHARACTER PILL IS A REAL CAPSULE now. cannon-es had no capsule, so
 *   the pill used to be a stack of overlapping spheres (<=12, scalloped);
 *   Rapier has ColliderDesc.capsule, which is the exact geometry the old
 *   stack approximated (same radius, same poles at +/-H/2, no scallops).
 * - INTERPOLATION: cannon gave us interpolatedPosition for free; Rapier's
 *   JS bindings do not. PhysicsWorld steps a fixed timestep behind its own
 *   accumulator (same adaptive anti-tunneling tiers as v6.2.4) and blends
 *   prev->current with the accumulator alpha - the v13.7 "character buzz"
 *   fix is preserved by construction.
 * - GRAVITY/SLEEP/SOLVER: world.gravity is re-applied from settings every
 *   step (live gravity changes keep working); sleeping bodies are skipped
 *   in the sync loop exactly like cannon's SLEEPING state; the solver runs
 *   8 iterations (cannon's GSSolver ran 10 - Rapier's solver is a
 *   different, warm-started design where 4 is the default and 8 is a
 *   stability sweet spot for stacks).
 * - PRE-EXISTING QUIRK PRESERVED ON PURPOSE: BodyVelocity/BodyPosition/
 *   BodyGyro/BodyAngularVelocity movers only write the JS mirror, which
 *   the post-step sync then overwrites for collider-backed bodies (they
 *   were equally inert under cannon). BodyForce/BodyThrust and impulses
 *   do reach the solver. Fixing the mirror movers is a separate,
 *   behavior-changing decision - NOT mixed into the engine swap.
 * - RopeConstraint (the unilateral max-distance rope) is JointData.rope -
 *   a native Rapier rope joint, so the class is gone.
 */

import RAPIER from '@dimforge/rapier3d-compat';
import type {
  World as RapierWorld,
  RigidBody as RapierRigidBody,
  ImpulseJoint,
  JointData as RapierJointData,
  UnitImpulseJoint,
} from '@dimforge/rapier3d-compat';
import { StudioPart, BodyMover, Joint, PhysicsSettings, PartType } from '../studio-store';
import { getMaterialProps, calculateMass } from './materials';
import type { TerrainHeightmap } from '../terrain-v2';
import type { TreeInstance, TreeBlock } from '../terrain-v2';
import { generateTreeBlocks } from '../terrain-v2';

// ─── Constants ───

// v13.7: world gravity raised from -9.81 to -35. At -9.81 everything fell
// "moon-like" (a 2-unit jump hung in the air for ~1.3s). -35 gives the
// snappy fall/jump feel of blocky sandbox games: a full-character-height
// jump now takes ~0.5s end to end. Old projects are migrated on load
// (see restoreStudioState) so existing games get the fix too.
export const GRAVITY = -35;
export const DEFAULT_CHARACTER_SPEED = 4.5;
export const DEFAULT_JUMP_FORCE = 7.0;
export const WATER_DRAG = 2.0;
export const AIR_DRAG = 0.01;
export const MAX_VELOCITY = 1000;
export const SLEEP_VELOCITY_THRESHOLD = 0.1;
export const EXPLOSION_IMPULSE_DURATION = 0.15;

// ─── Collision Groups (Rapier interaction groups: memberships<<16 | filter) ───
// Part colliders interact with everything; non-collidable parts (sensors,
// spawn markers) interact with nothing; the character hitbox collides with
// parts but is excluded from its own ground raycasts (via the raycast's
// excludeRigidBody, not groups).
const GROUP_PART = 0x0001;
const GROUP_GHOST = 0x0002; // non-collidable parts: filter 0 = touches nothing
const GROUP_CHAR = 0x0004;
const GROUPS_PART = (GROUP_PART << 16) | 0xffff;
const GROUPS_GHOST = (GROUP_GHOST << 16) | 0x0000;
const GROUPS_CHAR = (GROUP_CHAR << 16) | 0xffff;
/** Character pill filter WITHOUT the player-pill bit (tower-sword-fight
 *  NPCs: their pills must not collide with the player's pill). */
const GROUPS_CHAR_NO_PLAYERS = (GROUP_CHAR << 16) | (0xffff & ~GROUP_CHAR);

// ─── Character hitbox ───
// v1.3 (user request): the CharacterRoot part was DELETED. The character
// now always uses this STANDARD hitbox (arm span x full height x torso
// depth of the default character rig) and spawns at the Spawn part (or
// the world's Spawn Position setting).
export const DEFAULT_CHARACTER_HITBOX_SIZE = { x: 1.4, y: 2.0, z: 0.48 };

// ─── Rapier async init ───
// The compat package inlines the wasm as base64; init() compiles it. Kicked
// at module load (app boot on the client, worker boot on the server) so it
// is normally long done before the first PhysicsWorld is constructed.
let rapierReady = false;
let rapierInitPromise: Promise<void> | null = null;
export function ensureRapierReady(): Promise<void> {
  if (!rapierInitPromise) {
    rapierInitPromise = RAPIER.init().then(() => {
      rapierReady = true;
    });
  }
  return rapierInitPromise;
}
ensureRapierReady();

// ─── Helper Functions ───

function signedClamp(value: number, maxAbs: number): number {
  if (Math.abs(value) > maxAbs) return Math.sign(value) * maxAbs;
  return value;
}

function effectiveMass(mass: number): number {
  return Math.max(mass, 0.01);
}

// ─── Quaternion <-> Euler helpers ───
// Pure math (no three.js import in the engine): the EXACT conventions the
// parts render with (three.js Euler 'XYZ', degrees in the store) so a
// part's collider rotation always matches its visual rotation. Verified by
// the round-trip test in scripts/verify-physics-rapier.ts.

/** Intrinsic XYZ euler (radians) -> quaternion, matching three.js 'XYZ'. */
function quatFromEulerXYZ(x: number, y: number, z: number): { x: number; y: number; z: number; w: number } {
  const cx = Math.cos(x / 2), sx = Math.sin(x / 2);
  const cy = Math.cos(y / 2), sy = Math.sin(y / 2);
  const cz = Math.cos(z / 2), sz = Math.sin(z / 2);
  // q = qX ⊗ qY ⊗ qZ (Hamilton product)
  return {
    x: sx * cy * cz + cx * sy * sz,
    y: cx * sy * cz - sx * cy * sz,
    z: cx * cy * sz + sx * sy * cz,
    w: cx * cy * cz - sx * sy * sz,
  };
}

/** Quaternion -> intrinsic XYZ euler (radians), matching three.js 'XYZ'. */
function eulerXYZFromQuat(q: { x: number; y: number; z: number; w: number }): { x: number; y: number; z: number } {
  const sinrCosp = 2 * (q.w * q.x + q.y * q.z);
  const cosrCosp = 1 - 2 * (q.x * q.x + q.y * q.y);
  const x = Math.atan2(sinrCosp, cosrCosp);
  const sinp = 2 * (q.w * q.y - q.z * q.x);
  const y = Math.asin(Math.max(-1, Math.min(1, sinp)));
  const sinyCosp = 2 * (q.w * q.z + q.x * q.y);
  const cosyCosp = 1 - 2 * (q.y * q.y + q.z * q.z);
  const z = Math.atan2(sinyCosp, cosyCosp);
  return { x, y, z };
}

/** Rotate vector v by quaternion q. */
function quatRotate(
  q: { x: number; y: number; z: number; w: number },
  vx: number, vy: number, vz: number,
  out: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  // t = 2 * (q.xyz × v)
  const tx = 2 * (q.y * vz - q.z * vy);
  const ty = 2 * (q.z * vx - q.x * vz);
  const tz = 2 * (q.x * vy - q.y * vx);
  // v' = v + w*t + q.xyz × t
  out.x = vx + q.w * tx + (q.y * tz - q.z * ty);
  out.y = vy + q.w * ty + (q.z * tx - q.x * tz);
  out.z = vz + q.w * tz + (q.x * ty - q.y * tx);
  return out;
}

/** Conjugate of a unit quaternion (inverse for rotations). */
function quatConj(q: { x: number; y: number; z: number; w: number }): { x: number; y: number; z: number; w: number } {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

/** Hamilton product a ⊗ b. */
function quatMul(
  a: { x: number; y: number; z: number; w: number },
  b: { x: number; y: number; z: number; w: number },
): { x: number; y: number; z: number; w: number } {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

// ─── Physics Body (mirrors old interface) ───

export interface AABB {
  minX: number; minY: number; minZ: number;
  maxX: number; maxY: number; maxZ: number;
}

export interface PhysicsBody {
  id: string;
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  angularVelocity: { x: number; y: number; z: number };
  size: { x: number; y: number; z: number };
  rotation: { x: number; y: number; z: number };
  mass: number;
  anchored: boolean;
  canCollide: boolean;
  friction: number;
  elasticity: number;
  isGrounded: boolean;
  isAwake: boolean;
  isInWater: boolean;
  bodyMovers: BodyMover[];
  partType: PartType;
  _impulses: Array<{ force: { x: number; y: number; z: number }; timeLeft: number; applied: boolean }>;
  /** v13.4 PERF: set when the store position of an anchored part changed, so the
   *  physics body only re-syncs on real changes instead of every frame. */
  _anchoredDirty?: boolean;
  /** pass 28: position snapshot from before the last fixed substep - the
   *  sync loop blends prev->current with the accumulator alpha (cannon's
   *  interpolatedPosition equivalent). Mutated in place, never reallocated. */
  _prev?: { x: number; y: number; z: number };
}

// ─── Character State ───

export interface CharacterState {
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  isGrounded: boolean;
  isInWater: boolean;
  health: number;
}

// ─── Character Input ───

export interface CharacterInput {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
}

// ─── Collision Result ───

export interface CollisionResult {
  resolved: boolean;
  normal: { x: number; y: number; z: number };
  penetration: number;
  contactPoint?: { x: number; y: number; z: number };
}

// ─── Character Controller ───

export class CharacterController {
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  isGrounded: boolean = false;
  rotationY: number = 0;

  readonly capsuleRadius: number = 0.4;
  readonly capsuleHeight: number = 2.0;
  readonly walkSpeed: number = DEFAULT_CHARACTER_SPEED;
  readonly jumpVelocity: number = DEFAULT_JUMP_FORCE;
  readonly gravity: number = GRAVITY;

  private wasJumpPressed: boolean = false;

  constructor(spawnPosition: { x: number; y: number; z: number }) {
    this.position = { ...spawnPosition };
    this.velocity = { x: 0, y: 0, z: 0 };
  }

  /**
   * Step the character controller forward by deltaTime.
   * Uses simple collision resolution against PhysicsBody list.
   */
  step(dt: number, input: CharacterInput, bodies: PhysicsBody[]): void {
    // 1. Compute desired movement direction in XZ
    let moveX = 0;
    let moveZ = 0;
    if (input.forward) moveZ -= 1;
    if (input.backward) moveZ += 1;
    if (input.left) moveX -= 1;
    if (input.right) moveX += 1;

    const moveLen = Math.sqrt(moveX * moveX + moveZ * moveZ);
    if (moveLen > 0.001) {
      moveX /= moveLen;
      moveZ /= moveLen;
    }

    const desiredVX = moveX * this.walkSpeed;
    const desiredVZ = moveZ * this.walkSpeed;

    if (moveLen > 0.001) {
      this.rotationY = Math.atan2(moveX, moveZ);
    }

    // 2. Apply horizontal velocity
    this.velocity.x = desiredVX;
    this.velocity.z = desiredVZ;

    // 3. Apply gravity
    this.velocity.y += this.gravity * dt;

    // 4. Handle jump
    if (input.jump && this.isGrounded && !this.wasJumpPressed) {
      this.velocity.y = this.jumpVelocity;
      this.isGrounded = false;
    }
    this.wasJumpPressed = input.jump;

    // 5. Integrate position
    this.position.x += this.velocity.x * dt;
    this.position.y += this.velocity.y * dt;
    this.position.z += this.velocity.z * dt;

    // 6. Collision detection & resolution
    this.isGrounded = false;

    // NOTE: No hardcoded ground plane at y=0 - the character is grounded only
    // when standing on an actual part (baseplate, terrain block, or other part).
    // If there is no baseplate, the character falls into the void.

    // Collide against physics bodies.
    // v13.4 PERF: zero allocations - the old version allocated a fresh charAABB
    // AND bodyAABB object per body per frame (2 x N objects at 60 fps).
    const charCenterY = this.position.y + this.capsuleHeight / 2;
    const charHalfW = this.capsuleRadius;

    const cMinX = this.position.x - charHalfW, cMaxX = this.position.x + charHalfW;
    const cMinY = this.position.y, cMaxY = this.position.y + this.capsuleHeight;
    const cMinZ = this.position.z - charHalfW, cMaxZ = this.position.z + charHalfW;

    for (const body of bodies) {
      if (!body.canCollide) continue;
      // Cheap distance rejection BEFORE the full resolve - most far-away parts
      // never reach the allocation-heavy math.
      const bHalfX = body.size.x / 2, bHalfY = body.size.y / 2, bHalfZ = body.size.z / 2;
      if (Math.abs(body.position.x - this.position.x) > charHalfW + bHalfX) continue;
      if (Math.abs(body.position.z - this.position.z) > charHalfW + bHalfZ) continue;
      if (Math.abs(body.position.y - charCenterY) > this.capsuleHeight / 2 + bHalfY) continue;
      this.resolveCharacterBodyCollision(body, charCenterY, cMinX, cMinY, cMinZ, cMaxX, cMaxY, cMaxZ);
    }

    // 7. Terminal velocity clamp
    if (this.velocity.y < -50) this.velocity.y = -50;
    if (this.velocity.y > 50) this.velocity.y = 50;
  }

  private resolveCharacterBodyCollision(
    body: PhysicsBody,
    charCenterY: number,
    cMinX: number, cMinY: number, cMinZ: number,
    cMaxX: number, cMaxY: number, cMaxZ: number,
  ): void {
    // v13.4 PERF: all values below are scalars - no AABB objects are allocated.
    const bodyHalfX = body.size.x / 2;
    const bodyHalfY = body.size.y / 2;
    const bodyHalfZ = body.size.z / 2;

    const bMinX = body.position.x - bodyHalfX, bMaxX = body.position.x + bodyHalfX;
    const bMinY = body.position.y - bodyHalfY, bMaxY = body.position.y + bodyHalfY;
    const bMinZ = body.position.z - bodyHalfZ, bMaxZ = body.position.z + bodyHalfZ;

    // AABB overlap test (replaces aabbOverlap on allocated objects)
    if (cMinX >= bMaxX || cMaxX <= bMinX) return;
    if (cMinY >= bMaxY || cMaxY <= bMinY) return;
    if (cMinZ >= bMaxZ || cMaxZ <= bMinZ) return;

    // Compute MTV for AABB-AABB
    const overlapX1 = cMaxX - bMinX;
    const overlapX2 = bMaxX - cMinX;
    const overlapY1 = cMaxY - bMinY;
    const overlapY2 = bMaxY - cMinY;
    const overlapZ1 = cMaxZ - bMinZ;
    const overlapZ2 = bMaxZ - cMinZ;

    const minOX = Math.min(overlapX1, overlapX2);
    const minOY = Math.min(overlapY1, overlapY2);
    const minOZ = Math.min(overlapZ1, overlapZ2);

    const bodyTopY = body.position.y + body.size.y / 2;
    const charBottomY = this.position.y;

    const isFloorCollision = charBottomY >= bodyTopY - 0.15 && minOY <= minOX && minOY <= minOZ;
    const isWallCollision = minOY > minOX || minOY > minOZ;

    if (isFloorCollision) {
      // Floor collision: resolve upward and mark grounded
      const overlap = minOY;
      if (overlapY2 < overlapY1) {
        // Character is above - push up
        this.position.y += overlap;
        if (this.velocity.y < 0) this.velocity.y = 0;
        this.isGrounded = true;
      } else {
        // Character is below - push down
        this.position.y -= overlap;
        if (this.velocity.y > 0) this.velocity.y = 0;
      }
    } else if (isWallCollision) {
      // Wall/side collision: resolve in XZ only
      if (minOX <= minOZ) {
        const overlap = minOX;
        if (overlapX1 < overlapX2) {
          this.position.x -= overlap;
        } else {
          this.position.x += overlap;
        }
        // Kill horizontal velocity into the wall
        const dir = overlapX1 < overlapX2 ? -1 : 1;
        if (Math.sign(this.velocity.x) === -dir) this.velocity.x = 0;
      } else {
        const overlap = minOZ;
        if (overlapZ1 < overlapZ2) {
          this.position.z -= overlap;
        } else {
          this.position.z += overlap;
        }
        const dir = overlapZ1 < overlapZ2 ? -1 : 1;
        if (Math.sign(this.velocity.z) === -dir) this.velocity.z = 0;
      }
    } else {
      // Diagonal / ceiling - resolve along minimum overlap axis
      if (minOY <= minOX && minOY <= minOZ) {
        const overlap = minOY;
        if (overlapY2 < overlapY1) {
          this.position.y += overlap;
          if (this.velocity.y < 0) this.velocity.y = 0;
          this.isGrounded = true;
        } else {
          this.position.y -= overlap;
          if (this.velocity.y > 0) this.velocity.y = 0;
        }
      } else if (minOX <= minOZ) {
        const overlap = minOX;
        this.position.x += overlapX1 < overlapX2 ? -overlap : overlap;
      } else {
        const overlap = minOZ;
        this.position.z += overlapZ1 < overlapZ2 ? -overlap : overlap;
      }
    }
  }
}

// ─── CharacterBodyView (pass 28: the neutral character-body handle) ───
//
// cannon-es leaked CANNON.Body to the consumers (characterBody property,
// getNamedCharacterBody). The view keeps the EXACT member surface the call
// sites use - position / velocity (with .set() and per-axis +=) /
// interpolatedPosition / quaternion / wakeUp() - but wired to the Rapier
// body through a resolver, so nothing outside physics.ts knows the engine.
// A view whose body was removed resolves to null: reads give 0, writes
// no-op (safer than cannon's stale-body reads).

/** Live vector-ish read/write accessor for a body's linear velocity.
 *  Supports `v.x += a` (get+set on the same stable instance) and the
 *  cannon-style `v.set(x, y, z)`. */
class LiveVelocity {
  constructor(private resolve: () => RapierRigidBody | null) {}

  get x(): number { return this.resolve()?.linvel().x ?? 0; }
  get y(): number { return this.resolve()?.linvel().y ?? 0; }
  get z(): number { return this.resolve()?.linvel().z ?? 0; }
  set x(v: number) { const rb = this.resolve(); if (rb) { const l = rb.linvel(); rb.setLinvel({ x: v, y: l.y, z: l.z }, true); } }
  set y(v: number) { const rb = this.resolve(); if (rb) { const l = rb.linvel(); rb.setLinvel({ x: l.x, y: v, z: l.z }, true); } }
  set z(v: number) { const rb = this.resolve(); if (rb) { const l = rb.linvel(); rb.setLinvel({ x: l.x, y: l.y, z: v }, true); } }
  set(x: number, y: number, z: number): void { const rb = this.resolve(); if (rb) rb.setLinvel({ x, y, z }, true); }
}

/** Live read-only position/rotation accessors. */
class LivePosition {
  constructor(private resolve: () => RapierRigidBody | null) {}
  get x(): number { return this.resolve()?.translation().x ?? 0; }
  get y(): number { return this.resolve()?.translation().y ?? 0; }
  get z(): number { return this.resolve()?.translation().z ?? 0; }
}

class LiveQuaternion {
  constructor(private resolve: () => RapierRigidBody | null) {}
  get x(): number { return this.resolve()?.rotation().x ?? 0; }
  get y(): number { return this.resolve()?.rotation().y ?? 0; }
  get z(): number { return this.resolve()?.rotation().z ?? 0; }
  get w(): number { return this.resolve()?.rotation().w ?? 1; }
}

/** Live read of the interpolated position (the record the sync loop
 *  updates each step - prev->current blended by the accumulator alpha). */
class LiveInterpolatedPosition {
  constructor(private read: () => { x: number; y: number; z: number }) {}
  get x(): number { return this.read().x; }
  get y(): number { return this.read().y; }
  get z(): number { return this.read().z; }
}

export class CharacterBodyView {
  readonly position: LivePosition;
  readonly interpolatedPosition: LiveInterpolatedPosition;
  readonly velocity: LiveVelocity;
  readonly quaternion: LiveQuaternion;
  private readonly resolveBody: () => RapierRigidBody | null;

  constructor(
    resolve: () => RapierRigidBody | null,
    readInterp: () => { x: number; y: number; z: number },
  ) {
    this.resolveBody = resolve;
    this.position = new LivePosition(resolve);
    this.interpolatedPosition = new LiveInterpolatedPosition(readInterp);
    this.velocity = new LiveVelocity(resolve);
    this.quaternion = new LiveQuaternion(resolve);
  }

  /** True while the underlying physics body exists. */
  isValid(): boolean { return this.resolveBody() !== null; }

  /** cannon-style wake-up (a driver body never sleeps). */
  wakeUp(): void { this.resolveBody()?.wakeUp(); }

  /** Explicit orientation write (the hitbox yaw follow - locked rotations
   *  only block PHYSICS torque, an explicitly set rotation stays put).
   *  Degrees, the same euler the store uses. There are no interpolation
   *  buffers to keep in sync in Rapier - the rotation is written straight
   *  onto the body. */
  setRotationFromEuler(xDeg: number, yDeg: number, zDeg: number): void {
    const rb = this.resolveBody();
    if (!rb) return;
    rb.setRotation(quatFromEulerXYZ(
      xDeg * Math.PI / 180,
      yDeg * Math.PI / 180,
      zDeg * Math.PI / 180,
    ), true);
  }

  /** NPC pills (tower-sword-fight): stop colliding with PLAYER pills.
   *  Replaces the old `body.collisionFilterMask = ~CHARACTER_GROUP`. */
  setCollidesWithPlayers(on: boolean): void {
    const rb = this.resolveBody();
    if (!rb) return;
    const groups = on ? GROUPS_CHAR : GROUPS_CHAR_NO_PLAYERS;
    for (let i = 0; i < rb.numColliders(); i++) rb.collider(i).setCollisionGroups(groups);
  }
}

// ─── Physics World (Rapier backend) ───

export class PhysicsWorld {
  bodies: Map<string, PhysicsBody> = new Map();
  joints: Joint[] = [];
  settings: PhysicsSettings;

  // Rapier internals (world is null until the wasm finished init-ing; the
  // pre-init queue replays every mutation in order once it is ready).
  private world: RapierWorld | null = null;
  private rapierBodies: Map<string, RapierRigidBody> = new Map();
  private preInitQueue: Array<() => void> = [];

  // ─── v13.8: REAL joint constraints ───
  // Every studio joint is realized as a real Rapier joint:
  //   Weld  -> JointData.fixed (freezes the CURRENT relative transform)
  //   Motor -> JointData.revolute + a velocity motor (spins)
  //   Rope  -> JointData.rope (max-distance only - a REAL rope; parts swing
  //            closer together but never farther apart than the length)
  private jointConstraints: Map<string, { joint: ImpulseJoint; aId: string; bId: string }> = new Map();
  /** Last joints array reference we synced from (syncs assign a NEW array). */
  private _jointsSyncRef: Joint[] | null = null;
  /** Joint ids whose bodies didn't exist yet (staged loading) - retried each step. */
  private _pendingJointIds: Set<string> = new Set();

  // v13.6: the character hitbox body. NOT in `bodies` (it's not a part -
  // the sync loops must never write it back to the store).
  /** Neutral live handle (pass 28): position / velocity / quaternion /
   *  interpolatedPosition / wakeUp - same member surface the old raw
   *  cannon body had, so consumers are unchanged. Null when removed. */
  characterBody: CharacterBodyView | null = null;
  private characterRB: RapierRigidBody | null = null;
  /** v13.7: current hitbox height (the CharacterRoot part's size.y) - used
   *  by teleport/ground-check so a resized character keeps working. */
  characterHeight = DEFAULT_CHARACTER_HITBOX_SIZE.y;
  /** v13.7: current hitbox size (mirrors the CharacterRoot part). */
  characterSize: { x: number; y: number; z: number } = { ...DEFAULT_CHARACTER_HITBOX_SIZE };
  /** Interpolation records for the local character pill (prev snapshot +
   *  the blended result the view exposes as interpolatedPosition). */
  private charPrev: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
  private charInterp: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
  /** Bumped by removeCharacterBody()/createCharacterPill() so a queued
   *  pill build can detect it is stale (removed or superseded). */
  private _charGen = 0;

  // ─── v6.2.4: adaptive substepping (anti-tunneling) ───
  // User report: "characters sometimes pass through unanchored parts".
  // A fast body (a brick flung by an explosion at the 120 u/s part speed
  // cap = 2 studs per 60 Hz step, a character at terminal fall = 0.83) can
  // skip a thin part's whole overlap band in ONE integration step. FIX:
  // keep the per-step displacement budgeted at ~0.5 studs by raising the
  // fixed-step frequency while anything dynamic is fast. The speeds are
  // read from the PREVIOUS step (capVelocities already computes them for
  // free) plus an impulse kick estimate, so the check costs nothing extra.
  private _lastPartSpeed = 0;
  private _impulseSpeedKick = 0;
  /** Fixed-step accumulator (cannon's world.step(fixed, dt, max) ran this
   *  internally; Rapier's JS bindings don't, so we own it - and the
   *  prev->current blend that replaces interpolatedPosition). */
  private _accumulator = 0;
  /** Blend factor for prev->current positions (accumulator / fixedStep). */
  private _alpha = 0;

  /** v13.6: the void line - unanchored parts that fall below it are deleted
   *  (classic building game behavior). Computed at play start by PhysicsSimulation. */
  voidY: number = -50;

  constructor(settings: PhysicsSettings) {
    this.settings = settings;

    if (rapierReady) {
      this.buildWorld();
    } else {
      // First world of the session can beat the wasm init (~70 ms from
      // module load). Queue everything; mirrors are still created
      // immediately so the store syncs see live entries.
      ensureRapierReady().then(() => {
        this.buildWorld();
        const queue = this.preInitQueue;
        this.preInitQueue = [];
        for (const fn of queue) fn();
      });
    }
  }

  private buildWorld(): void {
    this.world = new RAPIER.World({ x: 0, y: this.effectiveGravity(), z: 0 });
    // cannon's GSSolver ran 10 iterations; Rapier's warm-started solver
    // defaults to 4 - 8 is the stability sweet spot for block stacks.
    this.world.numSolverIterations = 8;
    // NOTE: No ground plane at y=0 - the ground is defined by the baseplate part
    // (added via addBody when isBaseplate=true) and/or terrain. If there is no
    // baseplate, objects fall into the void, which is the correct behavior.
  }

  /** Gravity with a guard: a payload missing physicsSettings must never
   *  produce a NaN/undefined-gravity world (bodies freeze at spawn) - fall
   *  back to the game's standard gravity instead. */
  private effectiveGravity(): number {
    return Number.isFinite(this.settings.gravity) ? this.settings.gravity : GRAVITY;
  }

  /** Run `fn` now when the world is live, or queue it for the init flush.
   *  Returns true if the world is live (caller may proceed inline). */
  private whenReady(fn: () => void): boolean {
    if (this.world) return true;
    this.preInitQueue.push(fn);
    return false;
  }

  // ─── Body Management ───

  /**
   * pass 14 (collision = visuals): an 8-sided convex hull that matches the
   * visual cylinder (an ellipsoid-cylinder stretched by size.x/y/z). The
   * point cloud is shared by addBody and updateBodyShape so a resize keeps
   * the same shape math. Rapier's convexHull computes its own faces from
   * the point cloud (no winding needed, unlike the cannon hull).
   */
  static cylinderHullPoints(hx: number, hy: number, hz: number): Float32Array {
    const sides = 8;
    const pts = new Float32Array(sides * 2 * 3);
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      const cx = Math.cos(a) * hx;
      const cz = Math.sin(a) * hz;
      pts[i * 6 + 0] = cx; pts[i * 6 + 1] = hy; pts[i * 6 + 2] = cz;      // top ring
      pts[i * 6 + 3] = cx; pts[i * 6 + 4] = -hy; pts[i * 6 + 5] = cz;     // bottom ring
    }
    return pts;
  }

  /**
   * pass 15 (user request: "a ball should be a ball"): the Sphere part's
   * collision matches the visual ELLIPSOID (a unit sphere scaled by
   * size.x/y/z), not an AABB box.
   *   - UNSTRETCHED sphere (all three half-extents within 5% of the mean):
   *     a single ball collider. True sphere-vs-anything contacts.
   *   - STRETCHED sphere (e.g. a ball scaled into a pill): a STACK of
   *     overlapping ball colliders along the longest axis, each sphere's
   *     radius = the cross-section radius at that point (the ellipse
   *     equation). The union hugs the visual ellipsoid far better than an
   *     AABB box, and every contact is still a plain sphere-vs-anything
   *     point - the documented no-snag guarantee holds.
   *
   * Shared by addBody and updateBodyShape so a resize keeps the same math.
   */
  static ellipsoidStack(hx: number, hy: number, hz: number): Array<{ r: number; ox: number; oy: number; oz: number }> {
    const mean = (hx + hy + hz) / 3;
    const unstretched = Math.max(hx, hy, hz) <= mean * 1.05
      && Math.min(hx, hy, hz) >= mean * 0.95;
    if (unstretched) {
      return [{ r: Math.max(mean, 0.005), ox: 0, oy: 0, oz: 0 }];
    }
    // Stretched: find the LONGEST axis (the ellipsoid's pole axis). The
    // stack of spheres runs along it; each sphere's radius is the
    // cross-section radius of the ellipsoid at that point.
    const axes: Array<{ half: number; r1: number; r2: number; dx: number; dy: number; dz: number }> = [
      { half: hx, r1: hy, r2: hz, dx: 1, dy: 0, dz: 0 },
      { half: hy, r1: hx, r2: hz, dx: 0, dy: 1, dz: 0 },
      { half: hz, r1: hx, r2: hy, dx: 0, dy: 0, dz: 1 },
    ];
    axes.sort((a, b) => b.half - a.half);
    const pole = axes[0];
    const crossR = Math.max(0.005, Math.min(pole.r1, pole.r2));
    // The two TIP spheres are placed so their surface reaches the visual
    // ellipsoid's poles exactly. Solving along + r(along) = pole.half for the
    // ellipse cross-section r(along) = crossR*sqrt(1-(along/H)^2) gives the
    // tip sphere center at u*H where u = (H^2 - crossR^2)/(H^2 + crossR^2).
    // (Without this the end spheres taper to a smaller radius and the union
    // falls ~0.25 short of the visual tip - the rest-height check in
    // scripts/verify-physics-rapier.ts pins it.)
    const H = pole.half;
    const denom = H * H + crossR * crossR;
    const uTip = denom <= 0 ? 0 : (H * H - crossR * crossR) / denom;
    const tipAlong = H * uTip;            // end-sphere center (positive)
    const tipR = Math.max(0.005, crossR * Math.sqrt(Math.max(0, 1 - uTip * uTip)));
    // Interior spheres fill (-tipAlong, +tipAlong) at <= 0.75*crossR spacing
    // so the scallops between centers stay under 2% of R (imperceptible).
    const interior = 2 * tipAlong;
    const spacing = Math.max(0.04, crossR * 0.75);
    const interiorCount = interior <= 0.001
      ? 0
      : Math.min(14, Math.max(0, Math.ceil(interior / spacing) - 1));
    const spheres: Array<{ r: number; ox: number; oy: number; oz: number }> = [];
    const pushSphere = (along: number, r: number) => {
      const k = 1 - (along / H) * (along / H);
      const radius = Math.max(0.005, r === 0 ? crossR * Math.sqrt(Math.max(0, k)) : r);
      spheres.push({ r: radius, ox: pole.dx * along, oy: pole.dy * along, oz: pole.dz * along });
    };
    // Negative tip, then interior (smallest->largest radius toward middle),
    // then positive tip. Ordered along the pole axis.
    pushSphere(-tipAlong, tipR);
    for (let i = 1; i <= interiorCount; i++) {
      const t = interiorCount === 0 ? 0.5 : i / (interiorCount + 1);
      const along = -tipAlong + interior * t;
      pushSphere(along, 0); // radius from the ellipse eqn inside pushSphere
    }
    pushSphere(tipAlong, tipR);
    return spheres;
  }

  /**
   * v6.2.6: add a part as a STATIC PROXY (server-authoritative
   * multiplayer). The server simulates every part; the local world keeps
   * only FIXED COLLIDERS at the streamed positions so the local character
   * (this client owns it) collides with the world exactly as it is
   * rendered. No local part dynamics = no local-vs-server sim fight.
   */
  addProxyBody(part: StudioPart): PhysicsBody {
    return this.addBody(part, { asStaticProxy: true });
  }

  addBody(part: StudioPart, opts?: { asStaticProxy?: boolean }): PhysicsBody {
    const mass = calculateMass(part.type, part.size, part.material, part.density);
    const material = getMaterialProps(part.material);
    // Skip parts that can't collide - but spawn points ARE collidable now
    // (they're real parts, not visual-only markers). Non-collidable parts
    // still get a PhysicsBody entry for tracking, but no physics collider.
    const isAnchored = opts?.asStaticProxy ? true : part.anchored;
    const body: PhysicsBody = {
      id: part.id,
      position: { ...part.position },
      velocity: { x: 0, y: 0, z: 0 },
      angularVelocity: { x: 0, y: 0, z: 0 },
      size: { ...part.size },
      rotation: { ...part.rotation },
      mass,
      anchored: isAnchored,
      canCollide: part.canCollide,
      friction: part.friction ?? material.friction,
      elasticity: part.elasticity ?? material.elasticity,
      isGrounded: false,
      isAwake: true,
      isInWater: false,
      bodyMovers: [...(part.bodyMovers || [])],
      partType: part.type,
      _impulses: [],
    };
    this.bodies.set(part.id, body);
    if (!part.canCollide) return body;

    if (this.whenReady(() => {
      // The part may have been removed before the wasm finished init-ing.
      if (this.bodies.has(part.id)) this.createRapierBody(part, body, opts);
    })) {
      this.createRapierBody(part, body, opts);
    }
    return body;
  }

  /** Build the Rapier body + collider(s) for a part (mirror already exists). */
  private createRapierBody(part: StudioPart, body: PhysicsBody, opts?: { asStaticProxy?: boolean }): void {
    if (!this.world) return;
    const isAnchored = opts?.asStaticProxy ? true : part.anchored;
    // v6.2.6: a static proxy is ALWAYS fixed - even for unanchored parts,
    // whose dynamics run on the server and arrive as streamed transforms.
    // Anchored parts are fixed too (mass 0 in the old cannon world).
    const desc = isAnchored
      ? RAPIER.RigidBodyDesc.fixed()
      : RAPIER.RigidBodyDesc.dynamic()
        .setLinearDamping(0.01)
        .setAngularDamping(0.1);
    desc.setTranslation(part.position.x, part.position.y, part.position.z);
    if (part.rotation.x !== 0 || part.rotation.y !== 0 || part.rotation.z !== 0) {
      desc.setRotation(quatFromEulerXYZ(
        part.rotation.x * Math.PI / 180,
        part.rotation.y * Math.PI / 180,
        part.rotation.z * Math.PI / 180,
      ));
    }
    const rb = this.world.createRigidBody(desc);

    // Colliders: one per shape (a stretched Sphere is a stack of balls).
    for (const cd of this.partColliderDescs(part, isAnchored)) {
      this.world.createCollider(cd, rb);
    }

    this.rapierBodies.set(part.id, rb);
  }

  /** The collider descriptor(s) for a part: shape by type, plus the part's
   *  friction/restitution, collision groups and (for dynamics) its mass.
   *  Shared by createRapierBody and updateBodyShape. */
  private partColliderDescs(part: StudioPart, isAnchored: boolean): RAPIER.ColliderDesc[] {
    const friction = partFriction(part);
    const restitution = partElasticity(part);
    const out: RAPIER.ColliderDesc[] = [];
    const finish = (cd: RAPIER.ColliderDesc) => {
      cd.setFriction(friction).setRestitution(restitution).setCollisionGroups(GROUPS_PART);
      if (!isAnchored) {
        const mass = effectiveMass(calculateMass(part.type, part.size, part.material, part.density));
        cd.setMass(mass);
      }
      out.push(cd);
      return cd;
    };

    switch (part.type) {
      case 'Sphere': {
        // pass 15: the visual is a unit sphere scaled to (size.x, size.y,
        // size.z) - an ELLIPSOID. Unstretched -> one ball; stretched -> a
        // stack of balls along the long axis (see ellipsoidStack).
        const hx = Math.max(part.size.x / 2, 0.005);
        const hy = Math.max(part.size.y / 2, 0.005);
        const hz = Math.max(part.size.z / 2, 0.005);
        for (const s of PhysicsWorld.ellipsoidStack(hx, hy, hz)) {
          finish(RAPIER.ColliderDesc.ball(s.r).setTranslation(s.ox, s.oy, s.oz));
        }
        break;
      }
      case 'Cylinder': {
        // pass 14: an 8-sided convex hull with real caps (the old code
        // emitted side walls twice and no caps - nothing could rest ON a
        // cylinder). Matches the stretched visual ellipsoid-cylinder.
        const hull = RAPIER.ColliderDesc.convexHull(PhysicsWorld.cylinderHullPoints(
          Math.max(part.size.x / 2, 0.005),
          Math.max(part.size.y / 2, 0.005),
          Math.max(part.size.z / 2, 0.005),
        ));
        if (hull) finish(hull);
        break;
      }
      case 'Wedge': {
        // 1.0.1: the REAL triangular-prism shape (same 6 corners as the
        // rendered geometry) - a box hitbox made the slope an invisible
        // wall. Corners match Viewport3D's createWedgeGeometry: the tall
        // face is at +Z, the slope descends toward -Z.
        const hw = Math.max(part.size.x / 2, 0.005);
        const hh = Math.max(part.size.y / 2, 0.005);
        const hd = Math.max(part.size.z / 2, 0.005);
        const hull = RAPIER.ColliderDesc.convexHull(new Float32Array([
          -hw, -hh, hd,   // 0 bottom-front-left
          hw, -hh, hd,    // 1 bottom-front-right
          hw, hh, hd,     // 2 top-front-right
          -hw, hh, hd,    // 3 top-front-left
          -hw, -hh, -hd,  // 4 bottom-back-left
          hw, -hh, -hd,   // 5 bottom-back-right
        ]));
        if (hull) finish(hull);
        break;
      }
      default: {
        // Block, Spawn - use a box shape
        finish(RAPIER.ColliderDesc.cuboid(
          Math.max(part.size.x / 2, 0.005),
          Math.max(part.size.y / 2, 0.005),
          Math.max(part.size.z / 2, 0.005),
        ));
        break;
      }
    }
    return out;
  }

  removeBody(id: string) {
    const rb = this.rapierBodies.get(id);
    if (rb && this.world) {
      // v13.8: drop any joints that reference this body first.
      for (const [jointId, entry] of this.jointConstraints) {
        if (entry.aId === id || entry.bId === id) {
          this.world.removeImpulseJoint(entry.joint, true);
          this.jointConstraints.delete(jointId);
        }
      }
      this.world.removeRigidBody(rb);
      this.rapierBodies.delete(id);
    }
    this.bodies.delete(id);
    this.joints = this.joints.filter(j => j.partAId !== id && j.partBId !== id);
  }

  // ─── v13.8: realize studio joints as Rapier joints ───
  // Called from step(). Cheap when nothing changed: the sync sites in
  // Viewport3D assign a NEW array reference on every change, so a
  // reference compare is enough. Joints whose parts don't have physics
  // bodies YET (staged loading adds bodies 300/frame) are queued in
  // _pendingJointIds and retried on later steps.
  private syncJointConstraints(): void {
    if (!this.world) return;
    const changed = this._jointsSyncRef !== this.joints;
    if (!changed && this._pendingJointIds.size === 0) return;
    this._jointsSyncRef = this.joints;

    const activeIds = new Set<string>();
    for (const joint of this.joints) {
      if (!joint.enabled) continue;
      activeIds.add(joint.id);

      const bodyA = this.rapierBodies.get(joint.partAId);
      const bodyB = this.rapierBodies.get(joint.partBId);
      if (!bodyA || !bodyB) {
        // Bodies not created yet (staged load) or a part was deleted -
        // retry on later steps in case it's just staging order.
        if (this.bodies.has(joint.partAId) || this.bodies.has(joint.partBId) || this.rapierBodies.size === 0) {
          this._pendingJointIds.add(joint.id);
        }
        continue;
      }
      if (this.jointConstraints.has(joint.id)) continue;

      try {
        let data: RapierJointData;
        let configure: ((joint: ImpulseJoint) => void) | null = null;
        if (joint.type === 'Weld') {
          // Weld: freeze the CURRENT relative transform of the two bodies -
          // exactly "stick together where they touch now". Express B's pose
          // in A's local frame and pin it there with a fixed joint.
          const ta = bodyA.translation(), qa = bodyA.rotation();
          const tb = bodyB.translation(), qb = bodyB.rotation();
          const inv = quatConj(qa);
          const rel = { x: tb.x - ta.x, y: tb.y - ta.y, z: tb.z - ta.z };
          const relPos = quatRotate(inv, rel.x, rel.y, rel.z, { x: 0, y: 0, z: 0 });
          const relRot = quatMul(inv, qb);
          data = RAPIER.JointData.fixed(
            { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 },
            relPos, relRot,
          );
        } else if (joint.type === 'Motor') {
          // Motor: a hinge on the Y axis through the joint's C0/C1 local
          // anchors, with a velocity motor (cannon: HingeConstraint +
          // enableMotor). The factor is a stiffness multiplier; 1e6 makes
          // the motor reach motorSpeed regardless of load (cannon's
          // maxForce cap was near-inert at the default torque 10).
          data = RAPIER.JointData.revolute(
            { x: joint.C0?.x ?? 0, y: joint.C0?.y ?? 0, z: joint.C0?.z ?? 0 },
            { x: joint.C1?.x ?? 0, y: joint.C1?.y ?? 0, z: joint.C1?.z ?? 0 },
            { x: 0, y: 1, z: 0 },
          );
          const speed = joint.motorSpeed ?? 5;
          configure = (j) => { (j as UnitImpulseJoint).configureMotorVelocity(speed, 1e6); };
        } else if (joint.type === 'Rope') {
          // v1.3: ropes are REAL ropes (max-distance only). Parts can swing
          // closer together (the rope goes slack), but never farther apart
          // than the length. `joint.length` is the v1.3 field; old saves
          // smuggled the length into motorMaxTorque, so it stays as the
          // fallback.
          const ropeLength = joint.length ?? joint.motorMaxTorque ?? 5;
          data = RAPIER.JointData.rope(
            Math.max(ropeLength, 0.05),
            { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 },
          );
        } else {
          continue;
        }
        const impulseJoint = this.world.createImpulseJoint(data, bodyA, bodyB, true);
        if (configure) configure(impulseJoint);
        this.jointConstraints.set(joint.id, { joint: impulseJoint, aId: joint.partAId, bId: joint.partBId });
        this._pendingJointIds.delete(joint.id);
      } catch {
        // Malformed joint (degenerate geometry etc.) - skip it silently.
      }
    }

    // Remove joints that were deleted / disabled / unassigned.
    for (const [jointId, entry] of this.jointConstraints) {
      if (!activeIds.has(jointId)) {
        this.world.removeImpulseJoint(entry.joint, true);
        this.jointConstraints.delete(jointId);
      }
    }
    for (const jointId of this._pendingJointIds) {
      if (!activeIds.has(jointId)) this._pendingJointIds.delete(jointId);
    }
  }

  /** v13.6: bulk-remove bodies (parts that fell into the void). */
  removeBodiesBulk(ids: string[]) {
    for (const id of ids) this.removeBody(id);
  }

  // ─── v13.6: character hitbox (real physics body for the player) ───

  /**
   * Create the CharacterRoot hitbox (v13.7: fully parametric).
   * The size comes from the standard hitbox (DEFAULT_CHARACTER_HITBOX_SIZE
   * unless overridden), and the rotation is applied to the body's
   * quaternion (locked rotations only block PHYSICS torque - an
   * orientation that is set explicitly stays put, so a rotated root
   * rotates the hitbox). `spawnPosition` is the FEET position (bottom
   * center of the hitbox).
   */
  addCharacterBody(
    spawnPosition: { x: number; y: number; z: number },
    opts?: {
      size?: { x: number; y: number; z: number };
      rotationDeg?: { x: number; y: number; z: number };
    },
  ): CharacterBodyView | null {
    this.removeCharacterBody();
    const view = this.createCharacterPill(spawnPosition, opts);
    this.characterBody = view;
    return view;
  }

  /**
   * v1.1 (server-authoritative multiplayer): build a character pill hitbox
   * WITHOUT claiming the single-character slot. Used by addCharacterBody
   * (classic single player) and by the gamehost's per-player named bodies
   * below.
   */
  private createCharacterPill(
    spawnPosition: { x: number; y: number; z: number },
    opts?: {
      size?: { x: number; y: number; z: number };
      rotationDeg?: { x: number; y: number; z: number };
    },
  ): CharacterBodyView {
    // Guard: a usable hitbox needs positive height and some width/depth.
    const size = opts?.size ?? { ...DEFAULT_CHARACTER_HITBOX_SIZE };
    const H = Math.max(0.4, Math.min(64, size.y));
    const halfW = Math.max(0.05, Math.min(32, size.x / 2));
    const halfD = Math.max(0.05, Math.min(32, size.z / 2));
    this.characterHeight = H;
    this.characterSize = { x: halfW * 2, y: H, z: halfD * 2 };

    // PILL HITBOX (v1.0.1 "catches up on edges" fix): ONE continuous PILL
    // (capsule), the feet sphere extended upward at the SAME radius all
    // the way to the head, exactly like the visible body - no flat face
    // anywhere to snag a corner. cannon-es had no capsule, so the old pill
    // was a stack of overlapping spheres; Rapier has a native capsule,
    // which is the exact geometry that stack approximated (same radius,
    // poles at exactly -H/2 and +H/2, minus the scallops).
    //
    // pass 15 (user request: "revert the character hitbox to original"):
    // single column, radius = min(halfD, H/2, halfW) (collapses to the
    // torso depth on the default rig).
    const pillR = Math.max(0.05, Math.min(halfD, H / 2, halfW));

    const interp: { x: number; y: number; z: number } = { x: spawnPosition.x, y: spawnPosition.y + H / 2, z: spawnPosition.z };
    const prev: { x: number; y: number; z: number } = { ...interp };
    const view = new CharacterBodyView(() => this.characterRB, () => this.charInterp);
    this.charPrev = prev;
    this.charInterp = interp;

    // Generation token: removeCharacterBody()/a newer pill bumps it, so a
    // queued build that fires late (or after a remove+re-add) can detect
    // it is stale. (Checking `characterBody !== view` here does NOT work:
    // addCharacterBody assigns the property AFTER this returns, so the
    // inline build would reject itself - the bug the behavioral suite
    // caught: the pill was never created.)
    const gen = ++this._charGen;
    const build = () => {
      if (!this.world || this._charGen !== gen) return; // removed/replaced
      const desc = RAPIER.RigidBodyDesc.dynamic()
        .setLinearDamping(0)
        .setAngularDamping(1)
        .lockRotations() // the hitbox never tumbles; the visible body follows it
        .setCanSleep(false)
        .setTranslation(spawnPosition.x, spawnPosition.y + H / 2, spawnPosition.z);
      const rot = opts?.rotationDeg;
      if (rot && (rot.x !== 0 || rot.y !== 0 || rot.z !== 0)) {
        desc.setRotation(quatFromEulerXYZ(
          rot.x * Math.PI / 180,
          rot.y * Math.PI / 180,
          rot.z * Math.PI / 180,
        ));
      }
      const rb = this.world.createRigidBody(desc);
      // The capsule's cylinder half-height: total span is +/-H/2 with
      // hemispheres of pillR at both poles (bottom pole rests exactly at
      // -H/2, so the standing height matches the old sphere-stack pill).
      const capsuleHalf = Math.max(0, H / 2 - pillR);
      this.world.createCollider(
        RAPIER.ColliderDesc.capsule(capsuleHalf, pillR)
          .setMass(8) // heavy enough to push light parts, light enough to be pushed
          .setFriction(0)
          .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min) // frictionless: min(0, f) = 0, walls never grab
          .setRestitution(0)
          .setCollisionGroups(GROUPS_CHAR),
        rb,
      );
      this.characterRB = rb;
      const t = rb.translation();
      prev.x = t.x; prev.y = t.y; prev.z = t.z;
      interp.x = t.x; interp.y = t.y; interp.z = t.z;
    };
    if (this.whenReady(build)) build();
    return view;
  }

  // ─── v1.1: NAMED character bodies (server-authoritative multiplayer) ───
  // The classic API above models ONE local character (characterBody). The
  // gamehost simulates one pill per PLAYER in the same world; these methods
  // keep per-player size/height (ground probes need them) and never touch
  // the single-character slot.

  private namedCharacters: Map<string, {
    rb: RapierRigidBody | null;
    view: CharacterBodyView;
    height: number;
    size: { x: number; y: number; z: number };
    prev: { x: number; y: number; z: number };
    interp: { x: number; y: number; z: number };
    /** NPC pills opt out of colliding with player pills (TSF). */
    excludesPlayers: boolean;
  }> = new Map();

  addNamedCharacterBody(
    id: string,
    spawnPosition: { x: number; y: number; z: number },
    opts?: {
      size?: { x: number; y: number; z: number };
      rotationDeg?: { x: number; y: number; z: number };
    },
  ): CharacterBodyView | null {
    this.removeNamedCharacterBody(id);

    const size = opts?.size ?? { ...DEFAULT_CHARACTER_HITBOX_SIZE };
    const H = Math.max(0.4, Math.min(64, size.y));
    const halfW = Math.max(0.05, Math.min(32, size.x / 2));
    const halfD = Math.max(0.05, Math.min(32, size.z / 2));
    const pillR = Math.max(0.05, Math.min(halfD, H / 2, halfW));

    const prev: { x: number; y: number; z: number } = { x: spawnPosition.x, y: spawnPosition.y + H / 2, z: spawnPosition.z };
    const interp: { x: number; y: number; z: number } = { ...prev };
    const entry = {
      rb: null as RapierRigidBody | null,
      view: null as unknown as CharacterBodyView,
      height: H,
      size: { x: halfW * 2, y: H, z: halfD * 2 },
      prev,
      interp,
      excludesPlayers: false,
    };
    entry.view = new CharacterBodyView(() => this.namedCharacters.get(id)?.rb ?? null, () => this.namedCharacters.get(id)?.interp ?? interp);
    this.namedCharacters.set(id, entry);

    const build = () => {
      if (!this.world || this.namedCharacters.get(id) !== entry) return; // removed before init
      const desc = RAPIER.RigidBodyDesc.dynamic()
        .setLinearDamping(0)
        .setAngularDamping(1)
        .lockRotations()
        .setCanSleep(false)
        .setTranslation(spawnPosition.x, spawnPosition.y + H / 2, spawnPosition.z);
      const rot = opts?.rotationDeg;
      if (rot && (rot.x !== 0 || rot.y !== 0 || rot.z !== 0)) {
        desc.setRotation(quatFromEulerXYZ(
          rot.x * Math.PI / 180,
          rot.y * Math.PI / 180,
          rot.z * Math.PI / 180,
        ));
      }
      const rb = this.world.createRigidBody(desc);
      const capsuleHalf = Math.max(0, H / 2 - pillR);
      this.world.createCollider(
        RAPIER.ColliderDesc.capsule(capsuleHalf, pillR)
          .setMass(8)
          .setFriction(0)
          .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
          .setRestitution(0)
          .setCollisionGroups(entry.excludesPlayers ? GROUPS_CHAR_NO_PLAYERS : GROUPS_CHAR),
        rb,
      );
      entry.rb = rb;
      const t = rb.translation();
      prev.x = t.x; prev.y = t.y; prev.z = t.z;
      interp.x = t.x; interp.y = t.y; interp.z = t.z;
    };
    if (this.whenReady(build)) build();
    return entry.view;
  }

  removeNamedCharacterBody(id: string) {
    const entry = this.namedCharacters.get(id);
    if (!entry) return;
    if (entry.rb && this.world) this.world.removeRigidBody(entry.rb);
    this.namedCharacters.delete(id);
  }

  /** Neutral live handle for a named character body (position reads,
   *  velocity writes, wakeUp - the same members the raw cannon body had).
   *  The tower-sword-fight NPCs and the gamehost drive bodies through it. */
  getNamedCharacterBody(id: string): CharacterBodyView | undefined {
    return this.namedCharacters.get(id)?.view;
  }

  /**
   * v6.3.0 PLAYER COLLISIONS: convert a named character body to a
   * VELOCITY-DRIVEN KINEMATIC body so it can push unanchored parts without
   * being pushed back.
   *
   * The owning client still drives the player's transform via its 0.25 s
   * state report (the server worker mirrors that into the body's velocity
   * each tick). The body needs to live in the physics world so the contact
   * solver sees "an infinite-mass body slid into this dynamic part" and
   * pushes the part away. Kinematic = no gravity, no collision forces back
   * onto the body; the contact solver still creates contact equations
   * against dynamic bodies, and those equations push the dynamic side only.
   * (cannon flipped the same switch with Body.KINEMATIC.)
   */
  setNamedCharacterKinematic(id: string): void {
    const entry = this.namedCharacters.get(id);
    if (!entry) return;
    const go = () => {
      const rb = entry.rb;
      if (!rb || !this.world) return;
      rb.setBodyType(RAPIER.RigidBodyType.KinematicVelocityBased, true);
      rb.setLinvel({ x: 0, y: 0, z: 0 }, true);
      rb.setAngvel({ x: 0, y: 0, z: 0 }, true);
      rb.wakeUp(); // a kinematic driver body never sleeps
    };
    if (this.whenReady(go)) go();
  }

  /** Teleport a named character hitbox so its FEET land at `feetPosition`. */
  teleportNamedCharacterBody(id: string, feetPosition: { x: number; y: number; z: number }) {
    const entry = this.namedCharacters.get(id);
    if (!entry) return;
    const go = () => {
      const rb = entry.rb;
      if (!rb) return;
      const t = { x: feetPosition.x, y: feetPosition.y + entry.height / 2, z: feetPosition.z };
      rb.setTranslation(t, true);
      rb.setLinvel({ x: 0, y: 0, z: 0 }, true);
      rb.setAngvel({ x: 0, y: 0, z: 0 }, true);
      entry.prev.x = t.x; entry.prev.y = t.y; entry.prev.z = t.z;
      entry.interp.x = t.x; entry.interp.y = t.y; entry.interp.z = t.z;
    };
    if (this.whenReady(go)) go();
  }

  /** Swap a named character between the frictionless/standing states.
   *  (Frictionless = friction 0 + Min rule: min(0, f) = 0. Standing =
   *  friction 1.0 + Max rule: max(1, f) = 1 - plants on slopes, exactly
   *  what cannon's standing contact material did.) */
  setNamedCharacterStanding(id: string, standing: boolean) {
    const entry = this.namedCharacters.get(id);
    if (!entry || !entry.rb) return;
    this.applyStandingFriction(entry.rb, standing);
  }

  /** Ground check for a named character (same multi-probe edge logic). */
  namedCharacterGroundCheck(id: string): boolean {
    const entry = this.namedCharacters.get(id);
    if (!entry || !entry.rb) return false;
    return this.characterGroundProbe(entry.rb, entry.size, entry.height);
  }

  removeCharacterBody() {
    this._charGen++;
    if (this.characterRB && this.world) this.world.removeRigidBody(this.characterRB);
    this.characterRB = null;
    this.characterBody = null;
  }

  /**
   * v13.7: swap the character hitbox between its two contact states:
   *  - standing=true  -> high friction (plants on slopes, can't be shoved
   *                      around by gravity while idle)
   *  - standing=false -> frictionless (the normal moving state: slides
   *                      along walls and ramps without sticking)
   * Called every frame by the play controller.
   */
  setCharacterStanding(standing: boolean) {
    if (!this.characterRB) return;
    this.applyStandingFriction(this.characterRB, standing);
  }

  private applyStandingFriction(rb: RapierRigidBody, standing: boolean): void {
    for (let i = 0; i < rb.numColliders(); i++) {
      const c = rb.collider(i);
      c.setFriction(standing ? 1.0 : 0);
      c.setFrictionCombineRule(standing
        ? RAPIER.CoefficientCombineRule.Max
        : RAPIER.CoefficientCombineRule.Min);
    }
  }

  /** Teleport the character hitbox so its FEET land at `feetPosition`. */
  teleportCharacterBody(feetPosition: { x: number; y: number; z: number }) {
    if (!this.characterRB) return;
    const t = { x: feetPosition.x, y: feetPosition.y + this.characterHeight / 2, z: feetPosition.z };
    this.characterRB.setTranslation(t, true);
    this.characterRB.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.characterRB.setAngvel({ x: 0, y: 0, z: 0 }, true);
    // Keep the interpolation records in sync so the visible body doesn't
    // streak from the old position to the new one over the next frames.
    this.charPrev.x = t.x; this.charPrev.y = t.y; this.charPrev.z = t.z;
    this.charInterp.x = t.x; this.charInterp.y = t.y; this.charInterp.z = t.z;
  }

  /**
   * Ground check for the character hitbox: short rays straight down from
   * the body center (the character's own hitbox is excluded from the rays).
   */
  characterGroundCheck(): boolean {
    if (!this.characterRB) return false;
    return this.characterGroundProbe(this.characterRB, this.characterSize, this.characterHeight);
  }

  /** The multi-probe downward raycast shared by both character APIs. */
  private characterGroundProbe(
    rb: RapierRigidBody,
    charSize: { x: number; y: number; z: number },
    charHeight: number,
  ): boolean {

    // v13.8 EDGE-OF-BLOCK FIX: the character hitbox (a capsule from the
    // feet to the head) can rest perfectly well on the EDGE/CORNER of a
    // block - the physics solver holds it up - but a single ray straight
    // down from the body CENTER misses the block whenever the center is
    // past its edge. Result: "standing on an edge, jump animation stuck,
    // cannot jump".
    // Fix: also cast short rays at AXIS offsets (nearly the full pill
    // radius) plus inner-diagonal offsets (for corner edges). If ANY of
    // them hits ground within the usual 0.2 skin below the feet, the
    // character counts as grounded. All probes stay inside the foot
    // sphere's circle, so blocks the character merely stands NEXT TO never
    // register (their side faces are vertical - invisible to a downward
    // ray - and their tops are above the ray's reach).
    const halfW = charSize.x / 2;
    const halfD = charSize.z / 2;
    const sledR = Math.min(halfW, halfD, charHeight / 2);
    const axis = Math.max(0.04, sledR * 0.95);
    const diag = Math.max(0.03, sledR * 0.6);
    const rayLen = charHeight / 2 + 0.2;
    const probes: Array<[number, number]> = [
      [0, 0],
      [axis, 0], [-axis, 0], [0, axis], [0, -axis],
      [diag, diag], [-diag, diag], [diag, -diag], [-diag, -diag],
    ];
    const p = rb.translation();
    for (const [ox, oz] of probes) {
      if (this.castRayDown(p.x + ox, p.y, p.z + oz, rayLen, rb)) return true;
    }
    return false;
  }

  /** Straight-down raycast used by every ground probe. One scratch Ray for
   *  the whole world (mutated in place - the old cannon code allocated a
   *  Ray + RaycastResult per probe). `exclude` skips that body's own
   *  colliders (the character's self-hit, the part's own bottom face). */
  private _ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
  private castRayDown(x: number, y: number, z: number, len: number, exclude?: RapierRigidBody): boolean {
    if (!this.world) return false;
    this._ray.origin.x = x;
    this._ray.origin.y = y;
    this._ray.origin.z = z;
    this._ray.dir.x = 0;
    this._ray.dir.y = -1;
    this._ray.dir.z = 0;
    return !!this.world.castRay(this._ray, len, true, undefined, undefined, undefined, exclude);
  }

  // ─── Terrain & Tree Collision ───

  /**
   * Add the terrain heightmap as a collidable surface.
   * Uses a Rapier heightfield so unanchored parts fall, bounce, and rest
   * on the terrain just like on any other part.
   *
   * Our heightmap stores heights as heights[x * length + z] with the grid
   * centered on the world origin. Rapier's heightfield spans
   * [-scale.x, +scale.x] x [-scale.z, +scale.z] around its body origin,
   * with scale = half-extents and (nrows+1)*(ncols+1) heights laid out in
   * ITS OWN order (not ours - the index mapping below was pinned by the
   * asymmetric-bump test in scripts/verify-physics-rapier.ts: a tall spike
   * at a known (x, z) must catch a ball dropped at that same (x, z)).
   *
   * Friction 0 + the Max combine rule on the field: the OTHER collider's
   * coefficients win every contact (exactly what cannon's
   * ContactMaterial(default, mat) did - a part on terrain uses the part's
   * own friction/restitution).
   */
  addTerrain(heightmap: TerrainHeightmap) {
    const go = () => {
      if (!this.world) return;
      const { width, length, cellSize, heights } = heightmap;
      const halfW = (width * cellSize) / 2;
      const halfL = (length * cellSize) / 2;

      // The visual terrain is a grid of width x length BLOCKS (see
      // Viewport3D's buildData): cell (x, z) is centered at
      // ((x+0.5)*c - halfW, (z+0.5)*c - halfL) with its top at
      // heights[x * length + z]. A heightfield covering every cell needs
      // width x length SEGMENTS - i.e. (width+1) x (length+1) points - so
      // the outermost row/column duplicates the last real one.
      //
      // Rapier: nrows = Z segments, ncols = X segments, heights laid out
      // as data[col * (nrows + 1) + row] (its own order - pinned against
      // ours by the asymmetric-spike test in scripts/verify-physics-rapier.ts:
      // a tall spike at a known (x, z) cell must catch the ball dropped
      // over that cell's world center). scale = half-extents, the field
      // spans [-halfW, halfW] x [-halfL, halfL] around the body origin.
      const nrows = length;
      const ncols = width;
      const at = (x: number, z: number): number =>
        heights[Math.min(x, width - 1) * length + Math.min(z, length - 1)];
      const data = new Float32Array((nrows + 1) * (ncols + 1));
      for (let x = 0; x <= ncols; x++) {
        for (let z = 0; z <= nrows; z++) {
          data[x * (nrows + 1) + z] = at(x, z);
        }
      }

      const body = this.world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, 0),
      );
      this.world.createCollider(
        RAPIER.ColliderDesc.heightfield(nrows, ncols, data, { x: halfW, y: 1, z: halfL })
          .setFriction(0).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Max)
          .setRestitution(0).setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max)
          .setCollisionGroups(GROUPS_PART),
        body,
      );
    };
    if (this.whenReady(go)) go();
  }

  /**
   * Add tree blocks as static collidable boxes.
   * Each tree is decomposed into its constituent blocks (trunk + leaves),
   * and each block becomes a fixed collider. This lets parts rest on
   * tree branches, bounce off trunks, etc.
   */
  addTreeBlocks(blocks: TreeBlock[]) {
    const go = () => {
      if (!this.world) return;
      for (const block of blocks) {
        const body = this.world.createRigidBody(
          RAPIER.RigidBodyDesc.fixed().setTranslation(block.position.x, block.position.y, block.position.z),
        );
        this.world.createCollider(
          RAPIER.ColliderDesc.cuboid(
            Math.max(block.size.x / 2, 0.005),
            Math.max(block.size.y / 2, 0.005),
            Math.max(block.size.z / 2, 0.005),
          )
            // Same "the other side wins" rule as terrain: parts and the
            // character feel their own friction on tree blocks.
            .setFriction(0).setFrictionCombineRule(RAPIER.CoefficientCombineRule.Max)
            .setRestitution(0).setRestitutionCombineRule(RAPIER.CoefficientCombineRule.Max)
            .setCollisionGroups(GROUPS_PART),
          body,
        );
      }
    };
    if (this.whenReady(go)) go();
  }

  /**
   * Add all trees from the studio store. Generates blocks for each tree
   * and calls addTreeBlocks. This is a convenience method.
   */
  addTrees(trees: TreeInstance[]) {
    for (const tree of trees) {
      const blocks = generateTreeBlocks(tree);
      this.addTreeBlocks(blocks);
    }
  }

  syncFromPart(part: StudioPart) {
    const body = this.bodies.get(part.id);
    const rb = this.rapierBodies.get(part.id);
    if (!body) return;

    const mass = calculateMass(part.type, part.size, part.material, part.density);
    const material = getMaterialProps(part.material);

    body.position = { ...part.position };
    body.size = { ...part.size };
    body.rotation = { ...part.rotation };
    body.anchored = part.anchored;
    body.canCollide = part.canCollide;
    body.friction = part.friction ?? material.friction;
    body.elasticity = part.elasticity ?? material.elasticity;
    body.mass = mass;
    body.bodyMovers = [...(part.bodyMovers || [])];

    // Sync to the physics body if it exists
    if (rb) {
      rb.setTranslation({ x: part.position.x, y: part.position.y, z: part.position.z }, true);
      let q: { x: number; y: number; z: number; w: number };
      if (part.rotation.x !== 0 || part.rotation.y !== 0 || part.rotation.z !== 0) {
        q = quatFromEulerXYZ(
          part.rotation.x * Math.PI / 180,
          part.rotation.y * Math.PI / 180,
          part.rotation.z * Math.PI / 180,
        );
      } else {
        q = { x: 0, y: 0, z: 0, w: 1 };
      }
      rb.setRotation(q, true);
      rb.wakeUp();
    }

    if (!body.anchored) {
      body.isAwake = true;
    }
  }

  /**
   * pass 13 (rotate hitbox): re-create a part's COLLIDERS when its size
   * changes mid-play (the resize face handles, a modify_property rule).
   * syncFromPart updates position + rotation + the JS mirror's size, but
   * the colliders keep their original shape forever - so a resized block
   * kept colliding at its old extents. This swaps in fresh colliders
   * matching the new size (box for Block/Wedge, the 8-sided hull for
   * Cylinder, the ellipsoid stack for Sphere) and re-applies the rotation.
   */
  updateBodyShape(part: StudioPart): void {
    const rb = this.rapierBodies.get(part.id);
    if (!rb || !this.world) return;
    // Drop the old colliders and create the new one(s) in place.
    while (rb.numColliders() > 0) {
      this.world.removeCollider(rb.collider(0), true);
    }
    for (const cd of this.partColliderDescs(part, part.anchored)) {
      this.world.createCollider(cd, rb);
    }
    if (part.rotation.x !== 0 || part.rotation.y !== 0 || part.rotation.z !== 0) {
      rb.setRotation(quatFromEulerXYZ(
        part.rotation.x * Math.PI / 180,
        part.rotation.y * Math.PI / 180,
        part.rotation.z * Math.PI / 180,
      ), true);
    } else {
      rb.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    }
    rb.wakeUp();
  }

  syncToPart(part: StudioPart): StudioPart {
    const body = this.bodies.get(part.id);
    if (!body) return part;

    return {
      ...part,
      position: { ...body.position },
      rotation: { ...body.rotation },
    };
  }

  /**
   * v6.2.4: a part's anchored flag flipped during play (properties panel,
   * WeildCode rules, the server's slow body sync). The PhysicsBody MIRROR
   * was already flipped by the caller; this pushes the change into the
   * physics body itself (body type). Before, the body kept its boot-time
   * type forever: a part unanchored mid-play stayed FIXED (froze mid-air,
   * unpushable) and a part anchored mid-play kept falling - and character
   * contact behavior against it was wrong in both cases.
   */
  refreshBodyAnchored(part: {
    id: string;
    type?: string;
    size: { x: number; y: number; z: number };
    material?: string;
    density?: number;
  }): void {
    const body = this.bodies.get(part.id);
    const rb = this.rapierBodies.get(part.id);
    if (!body || !rb) return;
    if (body.anchored) {
      rb.setBodyType(RAPIER.RigidBodyType.Fixed, true);
      rb.setLinvel({ x: 0, y: 0, z: 0 }, true);
      rb.setAngvel({ x: 0, y: 0, z: 0 }, true);
    } else {
      const mass = effectiveMass(calculateMass(
        part.type ?? 'Block',
        part.size,
        part.material ?? 'Plastic',
        part.density,
      ));
      rb.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      // Keep the collider mass in sync with the (possibly changed) part.
      for (let i = 0; i < rb.numColliders(); i++) rb.collider(i).setMass(mass);
      rb.wakeUp();
    }
  }

  /**
   * v7.1 FIX: a part's canCollide flag flipped during play (WeildCode
   * modify_property rule, the properties panel, a server sync). The
   * PhysicsBody MIRROR was already flipped by the caller (syncFromPart);
   * this pushes the change into the physics body itself (collision groups
   * + body creation/removal).
   *
   * Strategy:
   *   - false -> true:  if there is no physics body yet, remove and re-add
   *                      the body so addBody creates the collider for the
   *                      now-collidable part. If a body already exists
   *                      (rare, only happens for parts that were
   *                      collidable before), flip its groups back on.
   *                      Joints are dropped by removeBody but re-realized
   *                      on the next step by syncJointConstraints (the
   *                      joints array is unchanged), so no joints are lost.
   *   - true -> false:  set the body's collision groups to the ghost
   *                      group (filter 0 = touches nothing). Cheaper than
   *                      removing the body, and reversible if canCollide
   *                      flips back.
   */
  refreshBodyCanCollide(part: StudioPart): void {
    const body = this.bodies.get(part.id);
    if (!body) return;
    const wasCollidable = body.canCollide;
    const nowCollidable = !!part.canCollide;
    if (wasCollidable === nowCollidable) return;

    // Update the JS mirror flag immediately so the next syncFromPart
    // (which would otherwise flip it back to the stale value) is a no-op.
    body.canCollide = nowCollidable;

    const rb = this.rapierBodies.get(part.id);

    if (nowCollidable) {
      if (!rb) {
        // Part started non-collidable (no physics body) and is now collidable.
        // Remove the JS body entry and re-add the part entirely so addBody
        // runs the collider creation path. Constraints referencing this
        // body are dropped by removeBody and re-created on the next step.
        this.bodies.delete(part.id);
        this.addBody(part);
        return;
      }
      // Existing body: flip the groups back to collidable.
      for (let i = 0; i < rb.numColliders(); i++) rb.collider(i).setCollisionGroups(GROUPS_PART);
      rb.wakeUp();
    } else {
      // Now non-collidable: neuter the body's groups so it stops
      // interacting with anything. We keep the body itself (cheaper than
      // remove+re-add if canCollide flips back).
      if (rb) {
        for (let i = 0; i < rb.numColliders(); i++) rb.collider(i).setCollisionGroups(GROUPS_GHOST);
      }
    }
  }

  // ─── Simulation Step ───

  step(deltaTime: number): void {
    if (isNaN(deltaTime) || !isFinite(deltaTime)) return;

    const dt = Math.min(deltaTime, 1 / 30);

    if (!this.world) {
      // Wasm not ready yet: the mirror-only movers (canCollide=false
      // parts - the mirror IS their simulation) still run.
      this.applyBodyMoversAndImpulses(dt);
      return;
    }

    // 0. v13.8: realize/remove joint constraints (weld/motor/rope)
    this.syncJointConstraints();

    // 1. Apply body movers and impulses to the physics bodies
    this.applyBodyMoversAndImpulses(dt);

    // 2. Update gravity from settings (may have changed; guarded against
    //    a missing value freezing the world - see effectiveGravity)
    this.world.gravity = { x: 0, y: this.effectiveGravity(), z: 0 };

    // 3. Step the world. v6.2.4 ADAPTIVE SUBSTEPS: while any dynamic body
    //    (part or character pill) is fast, the fixed-step frequency rises
    //    so every integration step moves at most ~0.5 studs - fast parts
    //    can no longer tunnel through characters (and fast-falling
    //    characters can no longer tunnel through thin parts).
    //    Speeds come from the previous step's scan + this step's impulse
    //    kicks, so the tier check itself is free. The accumulator loop is
    //    ours (cannon ran it inside world.step(fixed, dt, max)); the
    //    per-substep prev snapshots + the alpha blend after the loop are
    //    what replaces cannon's interpolatedPosition.
    let charSpeed = 0;
    if (this.characterRB) {
      const v = this.characterRB.linvel();
      charSpeed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    }
    for (const entry of this.namedCharacters.values()) {
      if (!entry.rb) continue;
      const v = entry.rb.linvel();
      const s = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
      if (s > charSpeed) charSpeed = s;
    }
    const peakSpeed = Math.max(this._lastPartSpeed, charSpeed, this._impulseSpeedKick);
    this._impulseSpeedKick = 0;
    // ~0.5 studs of travel per integration step at every tier.
    const fixedStep = peakSpeed > 120 ? 1 / 480
      : peakSpeed > 60 ? 1 / 240
      : peakSpeed > 30 ? 1 / 120
      : 1 / 60;
    const maxSubSteps = fixedStep >= 1 / 60 ? 3 : Math.ceil(dt / fixedStep) + 2;
    this.world.timestep = fixedStep;
    this._accumulator += dt;
    let subSteps = 0;
    while (this._accumulator >= fixedStep && subSteps < maxSubSteps) {
      this.snapshotPrevPositions();
      this.world.step();
      this._accumulator -= fixedStep;
      subSteps++;
    }
    if (subSteps >= maxSubSteps) this._accumulator = 0; // never spiral
    this._alpha = fixedStep > 0 ? this._accumulator / fixedStep : 0;

    // 4. Sync physics body positions back to PhysicsBody entries
    this.syncRapierToPhysicsBodies();

    // 5. Check water state
    this.checkWaterState();

    // 6. Apply drag
    this.applyDrag(dt);

    // 7. Cap velocities
    this.capVelocities();

    // 8. Tick impulses
    this.tickImpulses(dt);
  }

  /** Snapshot every dynamic body's position BEFORE a substep (blended
   *  back with the accumulator alpha in the sync - the interpolation
   *  that keeps 60 fps rendering smooth over the fixed 60 Hz stepping).
   *  Records are mutated in place: zero allocation steady-state. */
  private snapshotPrevPositions(): void {
    for (const [id, rb] of this.rapierBodies) {
      const body = this.bodies.get(id);
      if (!body || body.anchored) continue;
      if (rb.isSleeping()) continue;
      const t = rb.translation();
      if (body._prev) {
        body._prev.x = t.x; body._prev.y = t.y; body._prev.z = t.z;
      } else {
        body._prev = { x: t.x, y: t.y, z: t.z };
      }
    }
    if (this.characterRB && !this.characterRB.isSleeping()) {
      const t = this.characterRB.translation();
      this.charPrev.x = t.x; this.charPrev.y = t.y; this.charPrev.z = t.z;
    }
    for (const entry of this.namedCharacters.values()) {
      if (!entry.rb || entry.rb.isSleeping()) continue;
      const t = entry.rb.translation();
      entry.prev.x = t.x; entry.prev.y = t.y; entry.prev.z = t.z;
    }
  }

  // ─── Spatial Queries (v13.4 PERF) ───

  /**
   * Collect collidable bodies whose AABB is within `radius` of a world point
   * into `out` (reused array - no allocation). Used by character controllers
   * so they only collide against nearby parts instead of all 5,801.
   */
  getBodiesNear(x: number, y: number, z: number, radius: number, out: PhysicsBody[]): number {
    out.length = 0;
    for (const body of this.bodies.values()) {
      if (!body.canCollide) continue;
      const ex = radius + body.size.x / 2;
      const ey = radius + body.size.y / 2;
      const ez = radius + body.size.z / 2;
      if (Math.abs(body.position.x - x) > ex) continue;
      if (Math.abs(body.position.y - y) > ey) continue;
      if (Math.abs(body.position.z - z) > ez) continue;
      out.push(body);
    }
    return out.length;
  }

  // ─── pass 28: neutral body accessors (replaced the raw cannon-body leak) ───
  // The old raw-body accessor handed out the cannon body directly;
  // consumers only used mass/sleep/teleport. These four cover every call
  // site (Viewport3D's far-body sleeping + anchored pushes + keyframe
  // drives, the server runtime's sleep/mass checks).

  /** True if the part has a DYNAMIC physics body (old check: mass !== 0). */
  isBodyDynamic(id: string): boolean {
    const rb = this.rapierBodies.get(id);
    return !!rb && rb.isDynamic();
  }

  /** True if the part's body is asleep (old check: sleepState === SLEEPING). */
  isBodySleeping(id: string): boolean {
    const rb = this.rapierBodies.get(id);
    return !!rb && rb.isSleeping();
  }

  /** Sleep / wake a part's body (far-body sleeping around the player). */
  setBodySleeping(id: string, asleep: boolean): void {
    const rb = this.rapierBodies.get(id);
    if (!rb) return;
    if (asleep) rb.sleep();
    else rb.wakeUp();
  }

  /** Immediately place a part's body (anchored parts pushed from the
   *  store, streamed proxy transforms). Degrees for the optional euler. */
  setBodyTransformImmediate(
    id: string,
    position: { x: number; y: number; z: number },
    rotationDeg?: { x: number; y: number; z: number },
  ): void {
    const rb = this.rapierBodies.get(id);
    if (!rb) return;
    rb.setTranslation({ x: position.x, y: position.y, z: position.z }, false);
    if (rotationDeg) {
      rb.setRotation(quatFromEulerXYZ(
        rotationDeg.x * Math.PI / 180,
        rotationDeg.y * Math.PI / 180,
        rotationDeg.z * Math.PI / 180,
      ), false);
    }
  }

  // ─── Body Movers & Impulses ───

  private applyBodyMoversAndImpulses(dt: number): void {
    for (const body of this.bodies.values()) {
      if (body.anchored) continue;

      const rb = this.rapierBodies.get(body.id);

      // Apply body movers
      for (const mover of body.bodyMovers) {
        if (!mover.enabled) continue;
        this.applyBodyMover(body, mover, dt, rb);
      }

      // Apply impulses
      const effMass = effectiveMass(body.mass);
      for (const impulse of body._impulses) {
        if (!impulse.applied) {
          if (rb) {
            rb.applyImpulse({ x: impulse.force.x, y: impulse.force.y, z: impulse.force.z }, true);
            // v6.2.4: an impulse about to launch this body - feed the
            // substep picker right away (the velocity scan only sees it
            // AFTER this step has already run).
            const kick = Math.hypot(impulse.force.x, impulse.force.y, impulse.force.z) / effMass;
            if (kick > this._impulseSpeedKick) this._impulseSpeedKick = kick;
          } else {
            body.velocity.x += impulse.force.x / effMass;
            body.velocity.y += impulse.force.y / effMass;
            body.velocity.z += impulse.force.z / effMass;
          }
          impulse.applied = true;
        }
      }

      // Auto-remove expired body movers
      const expiredMoverIds: string[] = [];
      for (const mover of body.bodyMovers) {
        if (mover.duration != null && mover.duration > 0) {
          const elapsed = mover._elapsed ?? 0;
          mover._elapsed = elapsed + dt;
          if (mover._elapsed >= mover.duration) {
            expiredMoverIds.push(mover.id);
          }
        }
      }
      if (expiredMoverIds.length > 0) {
        const expiredSet = new Set(expiredMoverIds);
        body.bodyMovers = body.bodyMovers.filter(m => !expiredSet.has(m.id));
      }
    }
  }

  private applyBodyMover(body: PhysicsBody, mover: BodyMover, dt: number, rb: RapierRigidBody | undefined): void {
    const effMass = effectiveMass(body.mass);

    switch (mover.type) {
      case 'BodyForce':
        if (mover.force) {
          const fx = (mover.force.x / effMass) * dt;
          const fy = (mover.force.y / effMass) * dt;
          const fz = (mover.force.z / effMass) * dt;
          if (rb) {
            // cannon's applyForce lasted one solver step; an impulse of
            // force*dt is the same total velocity change.
            rb.applyImpulse({ x: mover.force.x * dt, y: mover.force.y * dt, z: mover.force.z * dt }, true);
          } else {
            body.velocity.x += fx;
            body.velocity.y += fy;
            body.velocity.z += fz;
          }
        }
        break;

      case 'BodyVelocity':
        if (mover.velocity) {
          const P = mover.P ?? 5000;
          const maxForce = mover.maxForce ?? { x: Infinity, y: Infinity, z: Infinity };
          for (const axis of ['x', 'y', 'z'] as const) {
            const diff = mover.velocity[axis] - body.velocity[axis];
            const force = signedClamp(diff * P, maxForce[axis]);
            body.velocity[axis] += (force / effMass) * dt;
          }
        }
        break;

      case 'BodyPosition':
        if (mover.position) {
          const P = mover.P ?? 5000;
          const D = mover.D ?? 500;
          const maxForce = mover.maxForce ?? { x: Infinity, y: Infinity, z: Infinity };
          for (const axis of ['x', 'y', 'z'] as const) {
            const diff = mover.position[axis] - body.position[axis];
            const force = signedClamp(diff * P - body.velocity[axis] * D, maxForce[axis]);
            body.velocity[axis] += (force / effMass) * dt;
          }
        }
        break;

      case 'BodyGyro':
        if (mover.cframe) {
          const P = mover.P ?? 5000;
          const maxTorque = mover.maxTorque ?? { x: Infinity, y: Infinity, z: Infinity };
          for (const axis of ['x', 'y', 'z'] as const) {
            const targetRad = (mover.cframe[axis] * Math.PI) / 180;
            const currentRad = (body.rotation[axis] * Math.PI) / 180;
            const diff = targetRad - currentRad;
            const torque = signedClamp(diff * P, maxTorque[axis]);
            body.angularVelocity[axis] += (torque / effMass) * dt * 0.1;
          }
        }
        break;

      case 'BodyThrust':
        if (mover.force) {
          if (rb) {
            rb.applyImpulse({ x: mover.force.x * dt, y: mover.force.y * dt, z: mover.force.z * dt }, true);
          } else {
            body.velocity.x += (mover.force.x / effMass) * dt;
            body.velocity.y += (mover.force.y / effMass) * dt;
            body.velocity.z += (mover.force.z / effMass) * dt;
          }
        }
        break;

      case 'BodyAngularVelocity':
        if (mover.angularVelocity) {
          const P = mover.P ?? 5000;
          const maxTorque = mover.maxTorque ?? { x: Infinity, y: Infinity, z: Infinity };
          for (const axis of ['x', 'y', 'z'] as const) {
            const diff = mover.angularVelocity[axis] - body.angularVelocity[axis];
            const torque = signedClamp(diff * P, maxTorque[axis]);
            body.angularVelocity[axis] += (torque / effMass) * dt * 0.1;
          }
        }
        break;
    }
  }

  // ─── Sync physics body → PhysicsBody ──

  private syncRapierToPhysicsBodies(): void {
    const alpha = this._alpha;

    for (const body of this.bodies.values()) {
      const rb = this.rapierBodies.get(body.id);
      if (!rb) continue;

      if (body.anchored) {
        // For anchored bodies, sync FROM store position to the physics body
        // ONLY when it actually moved (old version called .set() on all
        // 5,801 anchored bodies every single frame). Marked dirty by
        // updateBody/syncFromPart.
        if (body._anchoredDirty) {
          rb.setTranslation({ x: body.position.x, y: body.position.y, z: body.position.z }, false);
          body._anchoredDirty = false;
        }
        body.isGrounded = body.position.y <= 0.01;
        continue;
      }

      // v13.4 PERF: skip sleeping dynamic bodies entirely - they haven't moved.
      const wasSleeping = rb.isSleeping();
      if (wasSleeping) {
        body.isAwake = false;
        continue;
      }

      // Sync position, INTERPOLATED between the last two fixed substeps
      // (v13.7 BUZZ FIX preserved: the raw translation only updates in
      // 1/60s quanta and phase-beats against the frame rate; the blend
      // is what drives anything visual).
      const t = rb.translation();
      const p = body._prev ?? (body._prev = { x: t.x, y: t.y, z: t.z });
      body.position.x = p.x + (t.x - p.x) * alpha;
      body.position.y = p.y + (t.y - p.y) * alpha;
      body.position.z = p.z + (t.z - p.z) * alpha;

      // Sync velocity from the physics body
      const v = rb.linvel();
      body.velocity.x = v.x;
      body.velocity.y = v.y;
      body.velocity.z = v.z;

      // Sync rotation from the physics body
      const rot = eulerXYZFromQuat(rb.rotation());
      body.rotation.x = rot.x * 180 / Math.PI;
      body.rotation.y = rot.y * 180 / Math.PI;
      body.rotation.z = rot.z * 180 / Math.PI;

      // Sync angular velocity
      const av = rb.angvel();
      body.angularVelocity.x = av.x;
      body.angularVelocity.y = av.y;
      body.angularVelocity.z = av.z;

      // Check grounded: raycast downward (only for awake bodies - a sleeping
      // body keeps its last grounded state). The ray excludes the body's
      // own collider (cannon's ray-from-inside was a no-hit; Rapier's
      // solid castRay would hit the body's own bottom face).
      body.isGrounded = this.castRayDown(body.position.x, body.position.y, body.position.z, body.size.y / 2 + 0.1, rb);

      body.isAwake = true;
    }

    // Character pills: keep the interpolation records fresh for the views.
    if (this.characterRB && !this.characterRB.isSleeping()) {
      const t = this.characterRB.translation();
      this.charInterp.x = this.charPrev.x + (t.x - this.charPrev.x) * alpha;
      this.charInterp.y = this.charPrev.y + (t.y - this.charPrev.y) * alpha;
      this.charInterp.z = this.charPrev.z + (t.z - this.charPrev.z) * alpha;
    }
    for (const entry of this.namedCharacters.values()) {
      if (!entry.rb || entry.rb.isSleeping()) continue;
      const t = entry.rb.translation();
      entry.interp.x = entry.prev.x + (t.x - entry.prev.x) * alpha;
      entry.interp.y = entry.prev.y + (t.y - entry.prev.y) * alpha;
      entry.interp.z = entry.prev.z + (t.z - entry.prev.z) * alpha;
    }
  }

  // ─── Water Physics ───

  private checkWaterState(): void {
    // Water state is set externally via setWaterState
  }

  setWaterState(bodyId: string, waterHeight: number): void {
    const body = this.bodies.get(bodyId);
    if (!body) return;

    const wasInWater = body.isInWater;
    body.isInWater = body.position.y < waterHeight;

    // If body just entered water, apply buoyancy
    if (body.isInWater && !body.anchored) {
      const rb = this.rapierBodies.get(bodyId);
      const waterBuoyancy = Math.abs(this.effectiveGravity()) * 0.8;
      if (rb) {
        // cannon applied forces for one step; impulses of force*dt are the
        // same total (the callers' cadence and 1/60 factors are unchanged).
        const m = effectiveMass(body.mass);
        rb.applyImpulse({ x: 0, y: waterBuoyancy * m * (1 / 60), z: 0 }, true);
        // Water drag
        const drag = 1 - WATER_DRAG * (1 / 60);
        const v = rb.linvel();
        rb.setLinvel({ x: v.x * drag, y: v.y * drag, z: v.z * drag }, true);
        // Water current
        const forceMultiplier = [0, 0.2, 0.5, 1.0, 2.0][this.settings.waterForce] ?? 0.5;
        rb.applyImpulse({
          x: this.settings.waterDirection.x * forceMultiplier * m * 10 * (1 / 60),
          y: 0,
          z: this.settings.waterDirection.z * forceMultiplier * m * 10 * (1 / 60),
        }, true);
      } else {
        body.velocity.y += waterBuoyancy * (1 / 60);
        body.velocity.x *= (1 - WATER_DRAG * (1 / 60));
        body.velocity.y *= (1 - WATER_DRAG * (1 / 60));
        body.velocity.z *= (1 - WATER_DRAG * (1 / 60));
        const forceMultiplier = [0, 0.2, 0.5, 1.0, 2.0][this.settings.waterForce] ?? 0.5;
        body.velocity.x += this.settings.waterDirection.x * forceMultiplier * (1 / 60) * 10;
        body.velocity.z += this.settings.waterDirection.z * forceMultiplier * (1 / 60) * 10;
      }
    }
  }

  // ─── Drag & Velocity Capping ───

  private applyDrag(dt: number): void {
    for (const body of this.bodies.values()) {
      if (body.anchored || !body.isInWater) {
        // Air drag (very small) - collider-backed bodies use the rigid
        // body's linear damping (0.01, same as the old cannon body).
        const rb = this.rapierBodies.get(body.id);
        if (rb) {
          // linearDamping covers this
        } else {
          body.velocity.x *= (1 - AIR_DRAG * dt);
          body.velocity.z *= (1 - AIR_DRAG * dt);
        }
      }
    }
  }

  private capVelocities(): void {
    let maxSpeed = 0;
    for (const body of this.bodies.values()) {
      if (body.anchored) continue;
      const speed = Math.sqrt(
        body.velocity.x * body.velocity.x +
        body.velocity.y * body.velocity.y +
        body.velocity.z * body.velocity.z
      );
      if (speed > maxSpeed) maxSpeed = speed; // v6.2.4: feeds the substep picker
      // v13.7: PART_SPEED_CAP - the solver can slingshot a resting part to
      // 200+ u/s when a heavy body (the character) lands hard on a pile with
      // the stronger gravity; whole stacks would visibly explode. 120 u/s is
      // far above any sane gameplay speed (terminal fall to the void line is
      // ~50) but stops the explosions.
      const PART_SPEED_CAP = 120;
      if (speed > PART_SPEED_CAP) {
        const scale = PART_SPEED_CAP / speed;
        body.velocity.x *= scale;
        body.velocity.y *= scale;
        body.velocity.z *= scale;
        const rb = this.rapierBodies.get(body.id);
        if (rb) {
          rb.setLinvel({ x: body.velocity.x, y: body.velocity.y, z: body.velocity.z }, true);
        }
      }

      // NaN guard
      if (isNaN(body.position.x) || isNaN(body.position.y) || isNaN(body.position.z)) {
        body.position = { x: 0, y: 10, z: 0 };
        body.velocity = { x: 0, y: 0, z: 0 };
        const rb = this.rapierBodies.get(body.id);
        if (rb) {
          rb.setTranslation({ x: 0, y: 10, z: 0 }, true);
          rb.setLinvel({ x: 0, y: 0, z: 0 }, true);
        }
      }
    }
    // v6.2.4: pre-cap top speed feeds next step's substep picker.
    this._lastPartSpeed = maxSpeed;
  }

  // ─── Impulse Tracking ───

  private tickImpulses(dt: number): void {
    for (const body of this.bodies.values()) {
      if (body._impulses.length === 0) continue;
      body._impulses = body._impulses.filter(impulse => {
        impulse.timeLeft -= dt;
        return impulse.timeLeft > 0;
      });
    }
  }

  addImpulse(bodyId: string, force: { x: number; y: number; z: number }, duration: number = EXPLOSION_IMPULSE_DURATION): void {
    const body = this.bodies.get(bodyId);
    if (!body) return;
    body._impulses.push({ force, timeLeft: duration, applied: false });
    body.isAwake = true;
    const rb = this.rapierBodies.get(bodyId);
    if (rb) {
      rb.wakeUp();
    }
  }

  // ─── Character Simulation (legacy compatibility) ───

  stepCharacter(
    character: CharacterState,
    keys: Set<string>,
    waterHeight: number | null,
    dt: number
  ): CharacterState {
    const SPEED = DEFAULT_CHARACTER_SPEED;
    const JUMP_FORCE = DEFAULT_JUMP_FORCE;
    const grav = this.effectiveGravity();

    // Movement input
    let moveX = 0, moveZ = 0;
    if (keys.has('w') || keys.has('arrowup')) moveZ -= SPEED;
    if (keys.has('s') || keys.has('arrowdown')) moveZ += SPEED;
    if (keys.has('a') || keys.has('arrowleft')) moveX -= SPEED;
    if (keys.has('d') || keys.has('arrowright')) moveX += SPEED;

    character.velocity.x = moveX;
    character.velocity.z = moveZ;

    // Gravity
    character.velocity.y += grav * dt;

    // Water check
    character.isInWater = waterHeight !== null && character.position.y < waterHeight;
    if (character.isInWater) {
      const buoyancy = Math.abs(grav) * 0.85;
      character.velocity.y += buoyancy * dt;
      character.velocity.x *= (1 - WATER_DRAG * dt);
      character.velocity.y *= (1 - WATER_DRAG * dt);
      character.velocity.z *= (1 - WATER_DRAG * dt);
      const forceMultiplier = [0, 0.2, 0.5, 1.0, 2.0][this.settings.waterForce] ?? 0.5;
      character.velocity.x += this.settings.waterDirection.x * forceMultiplier * dt * 10;
      character.velocity.z += this.settings.waterDirection.z * forceMultiplier * dt * 10;
    }

    // Jump
    if (keys.has(' ') && character.isGrounded) {
      character.velocity.y = JUMP_FORCE;
      character.isGrounded = false;
    }

    // Integrate
    character.position.x += character.velocity.x * dt;
    character.position.y += character.velocity.y * dt;
    character.position.z += character.velocity.z * dt;

    // Ground collision
    const charHalfHeight = 1.2475;
    if (character.position.y - charHalfHeight < 0) {
      character.position.y = charHalfHeight;
      if (character.velocity.y < 0) character.velocity.y = 0;
      character.isGrounded = true;
    }

    // Part collision
    for (const body of this.bodies.values()) {
      if (!body.canCollide) continue;
      const aabb = computeAABB(body.position, body.size);
      const charMinX = character.position.x - 0.5;
      const charMaxX = character.position.x + 0.5;
      const charMinY = character.position.y - charHalfHeight;
      const charMaxY = character.position.y + charHalfHeight;
      const charMinZ = character.position.z - 0.5;
      const charMaxZ = character.position.z + 0.5;

      if (
        charMinX < aabb.maxX && charMaxX > aabb.minX &&
        charMinY < aabb.maxY && charMaxY > aabb.minY &&
        charMinZ < aabb.maxZ && charMaxZ > aabb.minZ
      ) {
        const overlapX1 = charMaxX - aabb.minX;
        const overlapX2 = aabb.maxX - charMinX;
        const overlapY1 = charMaxY - aabb.minY;
        const overlapY2 = aabb.maxY - charMinY;
        const overlapZ1 = charMaxZ - aabb.minZ;
        const overlapZ2 = aabb.maxZ - charMinZ;
        const minX = Math.min(overlapX1, overlapX2);
        const minY = Math.min(overlapY1, overlapY2);
        const minZ = Math.min(overlapZ1, overlapZ2);

        if (minY <= minX && minY <= minZ) {
          if (overlapY1 < overlapY2) {
            character.position.y = aabb.minY - charHalfHeight;
          } else {
            character.position.y = aabb.maxY + charHalfHeight;
            character.isGrounded = true;
          }
          if (character.velocity.y < 0 && overlapY1 >= overlapY2) {
            character.velocity.y = 0;
          } else if (character.velocity.y > 0 && overlapY1 < overlapY2) {
            character.velocity.y = 0;
          }
        } else if (minX <= minZ) {
          if (overlapX1 < overlapX2) {
            character.position.x = aabb.minX - 0.5;
          } else {
            character.position.x = aabb.maxX + 0.5;
          }
        } else {
          if (overlapZ1 < overlapZ2) {
            character.position.z = aabb.minZ - 0.5;
          } else {
            character.position.z = aabb.maxZ + 0.5;
          }
        }
      }
    }

    return character;
  }
}

/** A part's effective friction (its own override or its material default). */
function partFriction(part: StudioPart): number {
  return part.friction ?? getMaterialProps(part.material).friction;
}

/** A part's effective elasticity (its own override or its material default). */
function partElasticity(part: StudioPart): number {
  return part.elasticity ?? getMaterialProps(part.material).elasticity;
}

// ─── Utility Functions ───

export function computeAABB(
  position: { x: number; y: number; z: number },
  size: { x: number; y: number; z: number }
): AABB {
  return {
    minX: position.x - size.x / 2,
    minY: position.y - size.y / 2,
    minZ: position.z - size.z / 2,
    maxX: position.x + size.x / 2,
    maxY: position.y + size.y / 2,
    maxZ: position.z + size.z / 2,
  };
}

export function aabbOverlap(a: AABB, b: AABB): boolean {
  return (
    a.minX <= b.maxX && a.maxX >= b.minX &&
    a.minY <= b.maxY && a.maxY >= b.minY &&
    a.minZ <= b.maxZ && a.maxZ >= b.minZ
  );
}

// Legacy compatibility exports
export function partToPhysicsBody(part: StudioPart): PhysicsBody {
  const mass = calculateMass(part.type, part.size, part.material, part.density);
  const material = getMaterialProps(part.material);
  return {
    id: part.id,
    position: { ...part.position },
    velocity: { x: 0, y: 0, z: 0 },
    angularVelocity: { x: 0, y: 0, z: 0 },
    size: { ...part.size },
    rotation: { ...part.rotation },
    mass,
    anchored: part.anchored,
    canCollide: part.canCollide,
    friction: part.friction ?? material.friction,
    elasticity: part.elasticity ?? material.elasticity,
    isGrounded: false,
    isAwake: true,
    isInWater: false,
    bodyMovers: [...(part.bodyMovers || [])],
    partType: part.type,
    _impulses: [],
  };
}

// Legacy stepPhysics function for backwards compatibility
export function stepPhysics(bodies: PhysicsBody[], deltaTime: number): void {
  const dt = Math.min(deltaTime, 1 / 30);
  for (const body of bodies) {
    body.isGrounded = false;
    if (!body.anchored) {
      body.velocity.y += GRAVITY * dt;
    }
  }
  for (const body of bodies) {
    if (!body.anchored) {
      body.position.x += body.velocity.x * dt;
      body.position.y += body.velocity.y * dt;
      body.position.z += body.velocity.z * dt;
    }
  }
  for (let i = 0; i < bodies.length; i++) {
    for (let j = i + 1; j < bodies.length; j++) {
      const a = bodies[i], b = bodies[j];
      if (a.anchored && b.anchored) continue;
      if (!a.canCollide || !b.canCollide) continue;
      const aAABB = computeAABB(a.position, a.size);
      const bAABB = computeAABB(b.position, b.size);
      if (!aabbOverlap(aAABB, bAABB)) continue;
      if (a.anchored) {
        resolveCollision(b, a);
      } else if (b.anchored) {
        resolveCollision(a, b);
      } else {
        resolveCollision(a, b);
      }
    }
  }
}

function resolveCollision(moving: PhysicsBody, static_: PhysicsBody): { resolved: boolean; normal: { x: number; y: number; z: number } } {
  if (moving.anchored || !static_.canCollide || !moving.canCollide) {
    return { resolved: false, normal: { x: 0, y: 0, z: 0 } };
  }
  const movingAABB = computeAABB(moving.position, moving.size);
  const staticAABB = computeAABB(static_.position, static_.size);
  if (!aabbOverlap(movingAABB, staticAABB)) {
    return { resolved: false, normal: { x: 0, y: 0, z: 0 } };
  }
  const overlapX1 = movingAABB.maxX - staticAABB.minX;
  const overlapX2 = staticAABB.maxX - movingAABB.minX;
  const overlapY1 = movingAABB.maxY - staticAABB.minY;
  const overlapY2 = staticAABB.maxY - movingAABB.minY;
  const overlapZ1 = movingAABB.maxZ - staticAABB.minZ;
  const overlapZ2 = staticAABB.maxZ - movingAABB.minZ;
  const minOverlapX = Math.min(overlapX1, overlapX2);
  const minOverlapY = Math.min(overlapY1, overlapY2);
  const minOverlapZ = Math.min(overlapZ1, overlapZ2);
  const normal = { x: 0, y: 0, z: 0 };
  if (minOverlapY <= minOverlapX && minOverlapY <= minOverlapZ) {
    if (overlapY1 < overlapY2) {
      moving.position.y -= minOverlapY;
      normal.y = -1;
    } else {
      moving.position.y += minOverlapY;
      normal.y = 1;
      moving.isGrounded = true;
    }
    moving.velocity.y = 0;
  } else if (minOverlapX <= minOverlapZ) {
    if (overlapX1 < overlapX2) {
      moving.position.x -= minOverlapX;
      normal.x = -1;
    } else {
      moving.position.x += minOverlapX;
      normal.x = 1;
    }
    moving.velocity.x = 0;
  } else {
    if (overlapZ1 < overlapZ2) {
      moving.position.z -= minOverlapZ;
      normal.z = -1;
    } else {
      moving.position.z += minOverlapZ;
      normal.z = 1;
    }
    moving.velocity.z = 0;
  }
  return { resolved: true, normal };
}

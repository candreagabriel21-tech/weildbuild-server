/**
 * WeildBuild Physics Engine - cannon-es backend
 *
 * Replaces the custom physics with cannon-es for proper collision handling.
 * External API stays identical so Viewport3D doesn't need changes.
 *
 * Features:
 * - cannon-es World with gravity
 * - Per-part properties: Friction, Elasticity, Mass, Anchored, CanCollide
 * - BodyMovers: BodyForce, BodyVelocity, BodyGyro, BodyPosition, BodyThrust, BodyAngularVelocity
 * - Collision groups: canCollide=false bodies use separate group that doesn't interact
 * - Spawn parts (canCollide: false) don't create physics bodies
 * - CharacterController with cannon-es raycasting for ground detection
 */

import * as CANNON from 'cannon-es';
import { StudioPart, BodyMover, Joint, PhysicsSettings, PartType } from '../studio-store';
import { getMaterialProps, calculateMass, combinedFriction, combinedElasticity } from './materials';
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

// ─── Collision Groups ───
// Group 1: collidable parts (default)
// Group 2: non-collidable parts (sensors, spawn markers) - don't interact with anything
// Group 4 (v13.6): the character hitbox (CharacterRoot) - collides with parts,
// but is excluded from the character's own ground raycast.
const GROUP_COLLIDABLE = 1;
const GROUP_NON_COLLIDABLE = 2;
const GROUP_CHARACTER = 4;
const MASK_COLLIDABLE = -1; // interacts with everything
const MASK_NON_COLLIDABLE = 0; // interacts with nothing

// ─── Character hitbox ───
// v1.3 (user request): the CharacterRoot part was DELETED. The character
// now always uses this STANDARD hitbox (arm span x full height x torso
// depth of the default character rig) and spawns at the Spawn part (or
// the world's Spawn Position setting).
export const DEFAULT_CHARACTER_HITBOX_SIZE = { x: 1.4, y: 2.0, z: 0.48 };

// ─── Helper Functions ───

function signedClamp(value: number, maxAbs: number): number {
  if (Math.abs(value) > maxAbs) return Math.sign(value) * maxAbs;
  return value;
}

function effectiveMass(mass: number): number {
  return Math.max(mass, 0.01);
}

// ─── v1.3: RopeConstraint (a REAL rope - max distance only) ───
//
// The old rope used CANNON.DistanceConstraint, which is a BILATERAL
// equality: it enforces the distance BOTH ways - it pushes the parts
// apart when they get closer than `length` (a rigid rod, not a rope).
//
// A real rope is a UNILATERAL (max-distance) constraint: the parts may
// swing freely CLOSER than the length (the rope goes slack and sags),
// but can never get FARTHER apart than the length (the rope pulls them
// back). In cannon-es terms the DistanceConstraint's equation multiplier
// is NEGATIVE when the bodies must be pulled together and POSITIVE when
// they must be pushed apart - so clamping the equation's force range to
// [-maxForce, 0] keeps the pull and removes the push. Everything else
// (the midpoint anchor geometry in update()) is identical to
// DistanceConstraint.
export class RopeConstraint extends CANNON.Constraint {
  /** The maximum distance the two bodies may reach (studs). */
  length: number;
  distanceEquation: CANNON.ContactEquation;

  constructor(bodyA: CANNON.Body, bodyB: CANNON.Body, length: number, maxForce = 1e6) {
    super(bodyA, bodyB);
    this.length = Math.max(length, 0.05);
    const eq = this.distanceEquation = new CANNON.ContactEquation(bodyA, bodyB);
    this.equations.push(eq);
    // ONE-SIDED clamp - this is the whole "rope vs rod" difference:
    //   negative multiplier = pulls the bodies together (a taut rope)
    //   positive multiplier = pushes the bodies apart  (a rigid rod)
    // Allowing only the negative side makes the constraint slack when the
    // parts are closer than `length`, and taut (max pull) when stretched.
    eq.minForce = -maxForce;
    eq.maxForce = 0;
  }

  update(): void {
    const bodyA = this.bodyA;
    const bodyB = this.bodyB;
    const eq = this.distanceEquation;
    const halfLen = this.length * 0.5;
    const normal = eq.ni;
    bodyB.position.vsub(bodyA.position, normal);
    normal.normalize();
    normal.scale(halfLen, eq.ri);
    normal.scale(-halfLen, eq.rj);
  }
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
   *  cannon body only re-syncs on real changes instead of every frame. */
  _anchoredDirty?: boolean;
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

// ─── Physics World (cannon-es backend) ───

export class PhysicsWorld {
  bodies: Map<string, PhysicsBody> = new Map();
  joints: Joint[] = [];
  settings: PhysicsSettings;

  // cannon-es internals
  private world: CANNON.World;
  private cannonBodies: Map<string, CANNON.Body> = new Map();
  private cannonMaterials: Map<string, CANNON.Material> = new Map();

  // ─── v13.8: REAL joint constraints ───
  // Joints used to be stored on the world but never turned into cannon-es
  // constraints - the Weld tool created a Weld joint entry and NOTHING
  // happened ("objects don't stick to each other!"). Now every joint is
  // realized as a real constraint:
  //   Weld  -> LockConstraint  (rigid: parts stick exactly)
  //   Motor -> HingeConstraint with the motor enabled (spins)
  //   Rope  -> DistanceConstraint (keeps the two parts `length` apart)
  private jointConstraints: Map<string, { constraint: CANNON.Constraint; aId: string; bId: string }> = new Map();
  /** Last joints array reference we synced from (syncs assign a NEW array). */
  private _jointsSyncRef: Joint[] | null = null;
  /** Joint ids whose bodies didn't exist yet (staged loading) - retried each step. */
  private _pendingJointIds: Set<string> = new Set();

  // v13.6: the CharacterRoot hitbox body. NOT in `bodies` (it's not a part -
  // the sync loops must never write it back to the store).
  characterBody: CANNON.Body | null = null;
  /** v13.7: current hitbox height (the CharacterRoot part's size.y) - used
   *  by teleport/ground-check so a resized character keeps working. */
  characterHeight = DEFAULT_CHARACTER_HITBOX_SIZE.y;
  /** v13.7: current hitbox size (mirrors the CharacterRoot part). */
  characterSize: { x: number; y: number; z: number } = { ...DEFAULT_CHARACTER_HITBOX_SIZE };
  private characterMaterial: CANNON.Material | null = null;
  /** v13.7: high-friction variant - the character body switches to this
   *  while standing still (planted on slopes, classic-style) and back to the
   *  frictionless one while moving (slides along walls/ramps freely). */
  private characterStandingMaterial: CANNON.Material | null = null;

  // ─── v6.2.4: adaptive substepping (anti-tunneling) ───
  // User report: "characters sometimes pass through unanchored parts".
  // cannon-es has no CCD, and a fast body (a brick flung by an explosion at
  // the 120 u/s part speed cap = 2 studs per 60 Hz step, a character at
  // terminal fall = 0.83) can skip a thin part's whole overlap band in ONE
  // integration step (the character pill's spheres are ~0.4 radius, so a
  // 0.2-thick brick is passed through whenever a step moves ~1 stud).
  // FIX: keep the per-step displacement budgeted at ~0.5 studs by raising
  // the fixed-step frequency while anything dynamic is fast. The speeds are
  // read from the PREVIOUS step (capVelocities already computes them for
  // free) plus an impulse kick estimate, so the check costs nothing extra.
  private _lastPartSpeed = 0;
  private _impulseSpeedKick = 0;

  /** v13.6: the void line - unanchored parts that fall below it are deleted
   * (classic building game behavior). Computed at play start by PhysicsSimulation. */
  voidY: number = -50;

  constructor(settings: PhysicsSettings) {
    this.settings = settings;

    // Create cannon-es world
    this.world = new CANNON.World({
      gravity: new CANNON.Vec3(0, settings.gravity, 0),
    });
    // v13.4 PERF: SAPBroadphase (sweep-and-prune) instead of NaiveBroadphase.
    // NaiveBroadphase compares EVERY body against EVERY other body - with the
    // 5,801-part city map that is ~16.8 million pair checks per physics step,
    // which alone dropped play mode to single-digit FPS. SAP sorts bodies along
    // one axis and only tests overlapping neighbors - roughly O(N log N).
    this.world.broadphase = new CANNON.SAPBroadphase(this.world);
    (this.world.solver as CANNON.GSSolver).iterations = 10;
    this.world.allowSleep = true;

    // Default contact material
    const defaultMaterial = new CANNON.Material('default');
    this.cannonMaterials.set('default', defaultMaterial);
    this.world.defaultContactMaterial = new CANNON.ContactMaterial(
      defaultMaterial, defaultMaterial,
      { friction: 0.5, restitution: 0.2 }
    );

    // NOTE: No ground plane at y=0 - the ground is defined by the baseplate part
    // (added via addBody when isBaseplate=true) and/or terrain. If there is no
    // baseplate, objects fall into the void, which is the correct behavior.
  }

  // ─── Body Management ───

  /**
   * v6.2.6: add a part as a STATIC PROXY (server-authoritative
   * multiplayer). The server simulates every part; the local world keeps
   * only KINEMATIC COLLIDERS at the streamed positions so the local
   * character (this client owns it) collides with the world exactly as it
   * is rendered. No local part dynamics = no local-vs-server sim fight
   * (the "buzzing" objects bug is gone by construction: nothing local
   * ever pushes back).
   */
  addProxyBody(part: StudioPart): PhysicsBody {
    return this.addBody(part, { asStaticProxy: true });
  }

  addBody(part: StudioPart, opts?: { asStaticProxy?: boolean }): PhysicsBody {
    // Skip parts that can't collide - but spawn points ARE collidable now
    // (they're real parts, not visual-only markers).
    if (!part.canCollide) {
      // Still create a PhysicsBody entry for tracking, but no cannon body
      const mass = calculateMass(part.type, part.size, part.material, part.density);
      const material = getMaterialProps(part.material);
      const body: PhysicsBody = {
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
      this.bodies.set(part.id, body);
      return body;
    }

    const mass = calculateMass(part.type, part.size, part.material, part.density);
    const material = getMaterialProps(part.material);
    const isAnchored = opts?.asStaticProxy ? true : part.anchored;
    // v6.2.6: a static proxy ALWAYS has mass 0 (cannon-es makes mass-0
    // bodies STATIC) - even for unanchored parts, whose dynamics run on
    // the server and arrive as streamed transforms.
    const cannonMass = opts?.asStaticProxy ? 0 : (isAnchored ? 0 : effectiveMass(mass));

    // Create cannon shape based on part type
    let shape: CANNON.Shape;
    switch (part.type) {
      case 'Sphere': {
        // v1.1 FIX (user report: "the sphere can be stretched, but its
        // collision doesn't match what it is visually"):
        // The visual mesh is a UNIT SphereGeometry scaled by mesh.scale to
        // (size.x, size.y, size.z) - so a stretched sphere renders as an
        // ellipsoid. The old collision used CANNON.Sphere(max(size.x,y,z)/2)
        // which is a perfect sphere of the LARGEST dimension: it poked
        // past the thin ends of the visual ellipsoid by up to half a stud.
        //
        // Switched to CANNON.Box matching the AABB - WYSIWYG with the
        // face-handle resize the editor uses (the handles sit at the AABB
        // corners). A real ellipsoid ConvexPolyhedron would be smoother,
        // but it's overkill for the studio and the box is exactly what
        // every other part type does for collision anyway.
        const hx = Math.max(part.size.x / 2, 0.005);
        const hy = Math.max(part.size.y / 2, 0.005);
        const hz = Math.max(part.size.z / 2, 0.005);
        shape = new CANNON.Box(new CANNON.Vec3(hx, hy, hz));
        break;
      }
      case 'Cylinder': {
        // v1.1 FIX (same class of bug as Sphere): the visual mesh is a
        // unit CylinderGeometry scaled by (size.x, size.y, size.z), but
        // the old cannon Cylinder used max(x,z)/2 for BOTH radii - so X != Z
        // stretching produced a visual ellipsoid-cylinder but a circular
        // cannon cylinder that poked out. Now using an 8-segment
        // ConvexPolyhedron that approximates the stretched cylinder
        // (close enough for a blocky sandbox engine; matches the AABB on
        // X and Z, leaves the round top/bottom caps approximately).
        const hx = Math.max(part.size.x / 2, 0.005);
        const hy = Math.max(part.size.y / 2, 0.005);
        const hz = Math.max(part.size.z / 2, 0.005);
        const sides = 8;
        const verts: CANNON.Vec3[] = [];
        for (let i = 0; i < sides; i++) {
          const a = (i / sides) * Math.PI * 2;
          const cx = Math.cos(a) * hx;
          const cz = Math.sin(a) * hz;
          verts.push(new CANNON.Vec3(cx,  hy, cz)); // top ring
          verts.push(new CANNON.Vec3(cx, -hy, cz)); // bottom ring
        }
        const faces: number[][] = [];
        // top cap (triangle fan)
        for (let i = 0; i < sides; i++) {
          const a = i * 2;
          const b = ((i + 1) % sides) * 2;
          faces.push([a, b, b + 1, a + 1]);
        }
        // bottom cap (reversed winding)
        for (let i = 0; i < sides; i++) {
          const a = i * 2 + 1;
          const b = ((i + 1) % sides) * 2 + 1;
          faces.push([a, a - 1, b - 1, b]);
        }
        // side quads
        for (let i = 0; i < sides; i++) {
          const a = i * 2;
          const b = ((i + 1) % sides) * 2;
          faces.push([a, a + 1, b + 1, b]);
        }
        shape = new CANNON.ConvexPolyhedron({ vertices: verts, faces });
        break;
      }
      case 'Wedge': {
        // 1.0.1: wedges get their REAL triangular-prism shape (a convex
        // polyhedron with the same 6 corners as the rendered geometry) -
        // the old code gave every wedge a full BOX hitbox, so the slope was
        // an invisible wall and characters couldn't walk up it.
        // Corners match Viewport3D's createWedgeGeometry: the tall face is
        // at +Z, the slope descends toward -Z.
        const hw = Math.max(part.size.x / 2, 0.005);
        const hh = Math.max(part.size.y / 2, 0.005);
        const hd = Math.max(part.size.z / 2, 0.005);
        shape = new CANNON.ConvexPolyhedron({
          vertices: [
            new CANNON.Vec3(-hw, -hh, hd),  // 0 bottom-front-left
            new CANNON.Vec3(hw, -hh, hd),   // 1 bottom-front-right
            new CANNON.Vec3(hw, hh, hd),    // 2 top-front-right
            new CANNON.Vec3(-hw, hh, hd),   // 3 top-front-left
            new CANNON.Vec3(-hw, -hh, -hd), // 4 bottom-back-left
            new CANNON.Vec3(hw, -hh, -hd),  // 5 bottom-back-right
          ],
          faces: [
            [0, 1, 2, 3], // front (the tall vertical face, +Z)
            [0, 4, 5, 1], // bottom
            [4, 0, 3],    // left triangle
            [2, 1, 5],    // right triangle
            [3, 2, 5, 4], // the slope (up-and-back normal)
          ],
        });
        break;
      }
      default: {
        // Block, Spawn - use Box shape
        shape = new CANNON.Box(new CANNON.Vec3(
          Math.max(part.size.x / 2, 0.005),
          Math.max(part.size.y / 2, 0.005),
          Math.max(part.size.z / 2, 0.005)
        ));
        break;
      }
    }

    // Create or get cannon material for this part's friction/elasticity
    const friction = part.friction ?? material.friction;
    const restitution = part.elasticity ?? material.elasticity;
    const matKey = `f${friction.toFixed(2)}_r${restitution.toFixed(2)}`;
    let cannonMat = this.cannonMaterials.get(matKey);
    if (!cannonMat) {
      cannonMat = new CANNON.Material(matKey);
      this.cannonMaterials.set(matKey, cannonMat);

      // Create contact material with the default material
      const defaultMat = this.cannonMaterials.get('default')!;
      this.world.addContactMaterial(new CANNON.ContactMaterial(
        defaultMat, cannonMat,
        { friction, restitution }
      ));
      // Also create contact material with itself
      this.world.addContactMaterial(new CANNON.ContactMaterial(
        cannonMat, cannonMat,
        { friction: combinedFriction(friction, friction), restitution: combinedElasticity(restitution, restitution) }
      ));
      // v13.6: pair it with the character hitbox material too (frictionless,
      // so the character slides along walls and ramps instead of sticking).
      this._ensureCharacterContact(cannonMat);
    }

    // Create cannon body
    const cannonBody = new CANNON.Body({
      mass: cannonMass,
      shape,
      position: new CANNON.Vec3(part.position.x, part.position.y, part.position.z),
      material: cannonMat,
      collisionFilterGroup: part.canCollide ? GROUP_COLLIDABLE : GROUP_NON_COLLIDABLE,
      collisionFilterMask: part.canCollide ? MASK_COLLIDABLE : MASK_NON_COLLIDABLE,
      linearDamping: 0.01,
      angularDamping: 0.1,
    });

    // Apply rotation if present
    if (part.rotation.x !== 0 || part.rotation.y !== 0 || part.rotation.z !== 0) {
      const euler = new CANNON.Vec3(
        part.rotation.x * Math.PI / 180,
        part.rotation.y * Math.PI / 180,
        part.rotation.z * Math.PI / 180
      );
      cannonBody.quaternion.setFromEuler(euler.x, euler.y, euler.z);
    }

    // For anchored parts with mass > 0, set to kinematic so they can be moved
    if (isAnchored && cannonMass > 0) {
      cannonBody.type = CANNON.Body.KINEMATIC;
    }

    this.world.addBody(cannonBody);
    this.cannonBodies.set(part.id, cannonBody);

    // Create the PhysicsBody entry for external tracking
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
      friction,
      elasticity: restitution,
      isGrounded: false,
      isAwake: true,
      isInWater: false,
      bodyMovers: [...(part.bodyMovers || [])],
      partType: part.type,
      _impulses: [],
    };
    this.bodies.set(part.id, body);
    return body;
  }

  removeBody(id: string) {
    const cannonBody = this.cannonBodies.get(id);
    if (cannonBody) {
      // v13.8: drop any constraints that reference this body first
      // (cannon-es throws when a constraint equation references a removed body).
      for (const [jointId, entry] of this.jointConstraints) {
        if (entry.aId === id || entry.bId === id) {
          this.world.removeConstraint(entry.constraint);
          this.jointConstraints.delete(jointId);
        }
      }
      this.world.removeBody(cannonBody);
      this.cannonBodies.delete(id);
    }
    this.bodies.delete(id);
    this.joints = this.joints.filter(j => j.partAId !== id && j.partBId !== id);
  }

  // ─── v13.8: realize studio joints as cannon-es constraints ───
  // Called from step(). Cheap when nothing changed: the sync sites in
  // Viewport3D assign a NEW array reference on every change, so a
  // reference compare is enough. Joints whose parts don't have cannon
  // bodies YET (staged loading adds bodies 300/frame) are queued in
  // _pendingJointIds and retried on later steps.
  private syncJointConstraints(): void {
    const changed = this._jointsSyncRef !== this.joints;
    if (!changed && this._pendingJointIds.size === 0) return;
    this._jointsSyncRef = this.joints;

    const activeIds = new Set<string>();
    for (const joint of this.joints) {
      if (!joint.enabled) continue;
      activeIds.add(joint.id);

      const bodyA = this.cannonBodies.get(joint.partAId);
      const bodyB = this.cannonBodies.get(joint.partBId);
      if (!bodyA || !bodyB) {
        // Bodies not created yet (staged load) or a part was deleted -
        // retry on later steps in case it's just staging order.
        if (this.bodies.has(joint.partAId) || this.bodies.has(joint.partBId) || this.cannonBodies.size === 0) {
          this._pendingJointIds.add(joint.id);
        }
        continue;
      }
      if (this.jointConstraints.has(joint.id)) continue;

      try {
        let constraint: CANNON.Constraint;
        if (joint.type === 'Weld') {
          // LockConstraint freezes the CURRENT relative transform of the
          // two bodies - exactly "stick together where they touch now".
          constraint = new CANNON.LockConstraint(bodyA, bodyB, { maxForce: 1e6 });
        } else if (joint.type === 'Motor') {
          const hinge = new CANNON.HingeConstraint(bodyA, bodyB, {
            pivotA: new CANNON.Vec3(joint.C0?.x ?? 0, joint.C0?.y ?? 0, joint.C0?.z ?? 0),
            axisA: new CANNON.Vec3(0, 1, 0),
            pivotB: new CANNON.Vec3(joint.C1?.x ?? 0, joint.C1?.y ?? 0, joint.C1?.z ?? 0),
            axisB: new CANNON.Vec3(0, 1, 0),
            maxForce: 1e6,
          });
          hinge.enableMotor();
          hinge.setMotorSpeed(joint.motorSpeed ?? 5);
          hinge.setMotorMaxForce(joint.motorMaxTorque ?? 10);
          constraint = hinge;
        } else if (joint.type === 'Rope') {
          // v1.3: ropes are REAL ropes now (max-distance only - see
          // RopeConstraint above). Parts can swing closer together (the
          // rope goes slack), but never farther apart than the length.
          // `joint.length` is the v1.3 field; old saves smuggled the
          // length into motorMaxTorque, so it stays as the fallback.
          const ropeLength = joint.length ?? joint.motorMaxTorque ?? 5;
          constraint = new RopeConstraint(bodyA, bodyB, ropeLength, 1e6);
        } else {
          continue;
        }
        this.world.addConstraint(constraint);
        this.jointConstraints.set(joint.id, { constraint, aId: joint.partAId, bId: joint.partBId });
        this._pendingJointIds.delete(joint.id);
      } catch {
        // Malformed joint (degenerate geometry etc.) - skip it silently.
      }
    }

    // Remove constraints for joints that were deleted / disabled / unassigned.
    for (const [jointId, entry] of this.jointConstraints) {
      if (!activeIds.has(jointId)) {
        this.world.removeConstraint(entry.constraint);
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

  // ─── v13.6: CharacterRoot hitbox (real physics body for the player) ───

  private _ensureCharacterContact(other: CANNON.Material) {
    if (!this.characterMaterial) return;
    this.world.addContactMaterial(new CANNON.ContactMaterial(
      this.characterMaterial, other,
      { friction: 0, restitution: 0 }
    ));
  }

  /**
   * Create the CharacterRoot hitbox (v13.7: fully parametric).
   * The size comes from the CharacterRoot PART (so resizing it in the editor
   * resizes the hitbox 1:1), and the rotation is applied to the body's
   * quaternion (fixedRotation only blocks PHYSICS torque - an orientation
   * that is set explicitly stays put, so a rotated CharacterRoot rotates the
   * hitbox). `spawnPosition` is the FEET position (bottom center of the hitbox).
   */
  addCharacterBody(
    spawnPosition: { x: number; y: number; z: number },
    opts?: {
      size?: { x: number; y: number; z: number };
      rotationDeg?: { x: number; y: number; z: number };
    },
  ): CANNON.Body {
    this.removeCharacterBody();
    const body = this.createCharacterPillBody(spawnPosition, opts);
    this.characterBody = body;
    return body;
  }

  /**
   * v1.1 (server-authoritative multiplayer): build a character pill hitbox
   * WITHOUT claiming the single-character slot. The contact materials are
   * created once and shared by every character in the world (addBody pairs
   * new part materials with BOTH the frictionless and the standing variant).
   * Used by addCharacterBody (classic single player) and by the gamehost's
   * per-player named bodies below.
   */
  createCharacterPillBody(
    spawnPosition: { x: number; y: number; z: number },
    opts?: {
      size?: { x: number; y: number; z: number };
      rotationDeg?: { x: number; y: number; z: number };
    },
  ): CANNON.Body {
    const firstCharacter = !this.characterMaterial;
    const charMat = this.characterMaterial ?? new CANNON.Material('characterRoot');
    this.characterMaterial = charMat;
    // Contact materials are created ONCE and shared by every character
    // body in this world (v1.1: the gamehost simulates one pill per player).
    if (firstCharacter) {
      // Frictionless contacts against the default material and every part
      // material created so far (new part materials pair up in addBody).
      const defaultMat = this.cannonMaterials.get('default')!;
      this.world.addContactMaterial(new CANNON.ContactMaterial(
        charMat, defaultMat, { friction: 0, restitution: 0 }
      ));
      this.cannonMaterials.forEach((mat) => {
        if (mat !== charMat) this._ensureCharacterContact(mat);
      });

      // v13.7: the STANDING material - friction 1.0 against everything. The
      // character body swaps to it while standing with no input, which PLANTS
      // it on slopes (Coulomb friction holds while tan(slope) < 1.0, i.e. up
      // to 45 degrees). While moving it swaps back to the frictionless one so
      // walls and ramps never grab the character.
      const standMat = new CANNON.Material('characterRootStanding');
      this.characterStandingMaterial = standMat;
      this.world.addContactMaterial(new CANNON.ContactMaterial(
        standMat, defaultMat, { friction: 1.0, restitution: 0 }
      ));
      this.cannonMaterials.forEach((mat) => {
        if (mat !== charMat && mat !== standMat) {
          this.world.addContactMaterial(new CANNON.ContactMaterial(
            standMat, mat, { friction: 1.0, restitution: 0 }
          ));
        }
      });
    }

    // Guard: a usable hitbox needs positive height and some width/depth.
    const size = opts?.size ?? { ...DEFAULT_CHARACTER_HITBOX_SIZE };
    const H = Math.max(0.4, Math.min(64, size.y));
    const halfW = Math.max(0.05, Math.min(32, size.x / 2));
    const halfD = Math.max(0.05, Math.min(32, size.z / 2));
    this.characterHeight = H;
    this.characterSize = { x: halfW * 2, y: H, z: halfD * 2 };

    // PILL HITBOX (v1.0.1 "catches up on edges" fix, user-diagnosed): the
    // collider used to be a BOX sitting on a sphere "sled" at the feet. The
    // sphere slid over ramps, ledges and block edges beautifully, but the
    // BOX's flat bottom face snagged on the very same edges mid-jump: the
    // sphere kept moving while the box caught the corner and, both belonging
    // to one fixed-rotation body, the whole character "caught up" and got
    // pinned (jump animation stuck, could slide but not jump). The fix: ONE
    // continuous PILL (capsule) — the feet sphere extended upward at the
    // SAME radius all the way to the head, exactly like the visible body.
    //
    // cannon-es has no capsule shape, and a CANNON.Cylinder for the middle
    // would reintroduce the 1.0.1 wedge bug (cylinder-vs-convex-hull SAT is
    // broken: the character would PENETRATE oblique faces like a wedge's
    // slope with zero resistance and then jam - isolated in
    // scripts/test-wedge-bisect.js: sphere maxPen 0.03 vs cylinder 1.00+).
    // So the pill is a VERTICAL STACK OF OVERLAPPING SPHERES, all radius R,
    // centers spaced <= 0.75R apart:
    //   - the spheres' union IS the pill body (the waist scallops between
    //     centers dip < 2% of R - imperceptible in contacts),
    //   - every contact stays a well-tested sphere-vs-anything single
    //     point, so there is no flat face anywhere to snag a corner,
    //   - the bottom pole still rests exactly at -H/2, so the standing
    //     height on flat ground is unchanged from the old box+sled.
    const pillR = Math.max(0.05, Math.min(halfW, halfD, H / 2));
    const body = new CANNON.Body({
      mass: 8, // heavy enough to push light parts, light enough to be pushed
      material: charMat,
      fixedRotation: true, // the hitbox never tumbles; the visible body follows it
      allowSleep: false,
      linearDamping: 0,
      angularDamping: 1,
      collisionFilterGroup: GROUP_CHARACTER,
      collisionFilterMask: MASK_COLLIDABLE, // collide with everything
    });

    // Shape offsets are CENTERED on the body (body.position = hitbox
    // center). Total span: [-H/2, +H/2].
    //   - bottom hemisphere center: -H/2 + R (bottom pole = -H/2 exactly)
    //   - top hemisphere center:    +H/2 - R (top pole = +H/2 exactly)
    //   - overlapping spheres between at <= 0.75R spacing, capped at 12
    //     shapes so huge characters stay cheap to simulate.
    const pillBottomC = -(H / 2) + pillR;
    const pillTopC = (H / 2) - pillR;
    const pillSpan = Math.max(0, pillTopC - pillBottomC);
    const pillSpacing = Math.max(0.04, pillR * 0.75);
    const pillCount = pillSpan <= 0.001
      ? 1
      : Math.min(12, Math.max(2, Math.ceil(pillSpan / pillSpacing) + 1));
    for (let i = 0; i < pillCount; i++) {
      const y = pillCount === 1
        ? 0
        : pillBottomC + (pillSpan * i) / (pillCount - 1);
      body.addShape(new CANNON.Sphere(pillR), new CANNON.Vec3(0, y, 0));
    }

    body.position.set(spawnPosition.x, spawnPosition.y + H / 2, spawnPosition.z);

    // v13.7: apply the CharacterRoot part's rotation to the hitbox shape.
    const rot = opts?.rotationDeg;
    if (rot && (rot.x !== 0 || rot.y !== 0 || rot.z !== 0)) {
      body.quaternion.setFromEuler(
        rot.x * Math.PI / 180,
        rot.y * Math.PI / 180,
        rot.z * Math.PI / 180,
      );
      // Keep interpolation buffers aligned so it doesn't visually spin up.
      body.previousQuaternion.copy(body.quaternion);
      body.interpolatedQuaternion.copy(body.quaternion);
    }

    this.world.addBody(body);
    return body;
  }

  // ─── v1.1: NAMED character bodies (server-authoritative multiplayer) ───
  // The classic API above models ONE local character (characterBody). The
  // gamehost simulates one pill per PLAYER in the same world; these methods
  // keep per-player size/height (ground probes need them) and never touch
  // the single-character slot.

  private namedCharacters: Map<string, {
    body: CANNON.Body;
    height: number;
    size: { x: number; y: number; z: number };
  }> = new Map();

  addNamedCharacterBody(
    id: string,
    spawnPosition: { x: number; y: number; z: number },
    opts?: {
      size?: { x: number; y: number; z: number };
      rotationDeg?: { x: number; y: number; z: number };
    },
  ): CANNON.Body {
    this.removeNamedCharacterBody(id);
    const body = this.createCharacterPillBody(spawnPosition, opts);
    this.namedCharacters.set(id, {
      body,
      height: this.characterHeight,
      size: { ...this.characterSize },
    });
    return body;
  }

  removeNamedCharacterBody(id: string) {
    const entry = this.namedCharacters.get(id);
    if (!entry) return;
    this.world.removeBody(entry.body);
    this.namedCharacters.delete(id);
  }

  getNamedCharacterBody(id: string): CANNON.Body | undefined {
    return this.namedCharacters.get(id)?.body;
  }

  /**
   * v6.3.0 PLAYER COLLISIONS: convert a named character body to KINEMATIC
   * so it can push unanchored parts without being pushed back.
   *
   * The owning client still drives the player's transform via its 0.25 s
   * state report (the server worker mirrors that into body.position /
   * body.velocity each tick). The body needs to live in the physics world
   * so the contact solver sees "an infinite-mass body slid into this
   * dynamic part" and pushes the part away (the user's "I walked into a
   * ball and nothing happened" report: gravity worked, the baseplate
   * fell, the character fell after it, but the ball the character walked
   * into never moved - because there was no server-side player body at
   * all). Kinematic = mass 0, no gravity, no collision forces back onto
   * the body; the contact solver still creates contact equations against
   * dynamic bodies, and those equations push the dynamic side only.
   */
  setNamedCharacterKinematic(id: string): void {
    const entry = this.namedCharacters.get(id);
    if (!entry) return;
    const body = entry.body;
    body.type = CANNON.Body.KINEMATIC; // 4 - skips gravity + force integration
    body.mass = 0;
    body.invMass = 0;
    body.updateMassProperties();
    body.velocity.set(0, 0, 0);
    body.angularVelocity.set(0, 0, 0);
    body.previousPosition.copy(body.position);
    body.interpolatedPosition.copy(body.position);
    body.previousQuaternion.copy(body.quaternion);
    body.interpolatedQuaternion.copy(body.quaternion);
    body.allowSleep = false; // a kinematic driver body never sleeps
    body.wakeUp();
  }

  /** All named character entries (id -> { body, height, size }). */
  get namedCharacterEntries(): ReadonlyMap<string, { body: CANNON.Body; height: number; size: { x: number; y: number; z: number } }> {
    return this.namedCharacters;
  }

  /** Teleport a named character hitbox so its FEET land at `feetPosition`. */
  teleportNamedCharacterBody(id: string, feetPosition: { x: number; y: number; z: number }) {
    const entry = this.namedCharacters.get(id);
    if (!entry) return;
    entry.body.position.set(
      feetPosition.x,
      feetPosition.y + entry.height / 2,
      feetPosition.z,
    );
    entry.body.velocity.set(0, 0, 0);
    entry.body.angularVelocity.set(0, 0, 0);
    entry.body.previousPosition.copy(entry.body.position);
    entry.body.interpolatedPosition.copy(entry.body.position);
  }

  /** Swap a named character between the frictionless/standing materials. */
  setNamedCharacterStanding(id: string, standing: boolean) {
    const entry = this.namedCharacters.get(id);
    if (!entry) return;
    const target = standing ? this.characterStandingMaterial : this.characterMaterial;
    if (target && entry.body.material !== target) entry.body.material = target;
  }

  /** Ground check for a named character (same multi-probe edge logic). */
  namedCharacterGroundCheck(id: string): boolean {
    const entry = this.namedCharacters.get(id);
    if (!entry) return false;
    return this._characterGroundProbe(entry.body, entry.size, entry.height);
  }

  removeCharacterBody() {
    if (!this.characterBody) return;
    this.world.removeBody(this.characterBody);
    this.characterBody = null;
    this.characterMaterial = null;
    this.characterStandingMaterial = null;
  }

  /**
   * v13.7: swap the character hitbox between its two contact materials:
   *  - standing=true  -> high friction (plants on slopes, can't be shoved
   *                      around by gravity while idle)
   *  - standing=false -> frictionless (the normal moving state: slides
   *                      along walls and ramps without sticking)
   * Called every frame by the play controller.
   */
  setCharacterStanding(standing: boolean) {
    const body = this.characterBody;
    if (!body) return;
    const target = standing ? this.characterStandingMaterial : this.characterMaterial;
    if (target && body.material !== target) body.material = target;
  }

  /** Teleport the character hitbox so its FEET land at `feetPosition`. */
  teleportCharacterBody(feetPosition: { x: number; y: number; z: number }) {
    if (!this.characterBody) return;
    this.characterBody.position.set(
      feetPosition.x,
      feetPosition.y + this.characterHeight / 2,
      feetPosition.z,
    );
    this.characterBody.velocity.set(0, 0, 0);
    this.characterBody.angularVelocity.set(0, 0, 0);
    // Keep the interpolation buffers in sync so the visible body doesn't
    // streak from the old position to the new one over the next frames.
    this.characterBody.previousPosition.copy(this.characterBody.position);
    this.characterBody.interpolatedPosition.copy(this.characterBody.position);
  }

  /**
   * Ground check for the character hitbox: a short ray straight down from the
   * body center (the character's own hitbox is excluded from the ray).
   */
  characterGroundCheck(): boolean {
    const body = this.characterBody;
    if (!body) return false;
    return this._characterGroundProbe(body, this.characterSize, this.characterHeight);
  }

  /** The multi-probe downward raycast shared by both character APIs. */
  private _characterGroundProbe(
    body: CANNON.Body,
    charSize: { x: number; y: number; z: number },
    charHeight: number,
  ): boolean {

    // v13.8 EDGE-OF-BLOCK FIX: the character hitbox (a sphere-pill from the
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
    const from = new CANNON.Vec3();
    const to = new CANNON.Vec3();
    const result = new CANNON.RaycastResult();
    for (const [ox, oz] of probes) {
      from.set(body.position.x + ox, body.position.y, body.position.z + oz);
      to.set(body.position.x + ox, body.position.y - rayLen, body.position.z + oz);
      result.reset();
      this.world.raycastClosest(from, to, {
        collisionFilterMask: ~GROUP_CHARACTER, // ignore our own hitbox
        skipBackfaces: true,
      }, result);
      if (result.hasHit) return true;
    }
    return false;
  }

  // ─── Terrain & Tree Collision ───

  /**
   * Add the terrain heightmap as a collidable surface.
   * Uses cannon-es Heightfield shape so unanchored parts fall, bounce,
   * and rest on the terrain just like on any other part.
   *
   * The heightfield is positioned so its center aligns with world origin,
   * matching how the terrain renderer positions the mesh.
   */
  addTerrain(heightmap: TerrainHeightmap) {
    const { width, length, cellSize, heights } = heightmap;

    // cannon-es Heightfield expects data[xi][yi] = height at that cell.
    // Our heightmap stores heights as heights[x * length + z].
    const data: number[][] = [];
    for (let x = 0; x < width; x++) {
      const row: number[] = [];
      for (let z = 0; z < length; z++) {
        row.push(heights[x * length + z]);
      }
      data.push(row);
    }

    const heightfieldShape = new CANNON.Heightfield(data, {
      elementSize: cellSize,
    });

    const terrainBody = new CANNON.Body({
      mass: 0, // static - terrain doesn't move
      shape: heightfieldShape,
    });

    // Position: the heightfield's local origin is at the corner of the grid.
    // We need to offset it so the terrain center is at world origin.
    // The terrain spans from -halfW to +halfW in X, -halfL to +halfL in Z.
    const halfW = (width * cellSize) / 2;
    const halfL = (length * cellSize) / 2;
    terrainBody.position.set(-halfW, 0, -halfL);

    this.world.addBody(terrainBody);
  }

  /**
   * Add tree blocks as static collidable boxes.
   * Each tree is decomposed into its constituent blocks (trunk + leaves),
   * and each block becomes a static cannon Body. This lets parts rest on
   * tree branches, bounce off trunks, etc.
   */
  addTreeBlocks(blocks: TreeBlock[]) {
    const defaultMat = this.cannonMaterials.get('default')!;
    for (const block of blocks) {
      const shape = new CANNON.Box(new CANNON.Vec3(
        Math.max(block.size.x / 2, 0.005),
        Math.max(block.size.y / 2, 0.005),
        Math.max(block.size.z / 2, 0.005),
      ));
      const body = new CANNON.Body({
        mass: 0, // static - trees don't move
        shape,
        material: defaultMat,
      });
      body.position.set(block.position.x, block.position.y, block.position.z);
      this.world.addBody(body);
    }
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
    const cannonBody = this.cannonBodies.get(part.id);
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

    // Sync to cannon body if it exists
    if (cannonBody) {
      cannonBody.position.set(part.position.x, part.position.y, part.position.z);
      if (part.rotation.x !== 0 || part.rotation.y !== 0 || part.rotation.z !== 0) {
        cannonBody.quaternion.setFromEuler(
          part.rotation.x * Math.PI / 180,
          part.rotation.y * Math.PI / 180,
          part.rotation.z * Math.PI / 180
        );
      } else {
        cannonBody.quaternion.set(0, 0, 0, 1);
      }
      cannonBody.wakeUp();
    }

    if (!body.anchored) {
      body.isAwake = true;
    }
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
   * CANNON body itself (type + mass). Before, the cannon body kept its
   * boot-time type forever: a part unanchored mid-play stayed STATIC
   * (froze mid-air, unpushable) and a part anchored mid-play kept falling -
   * and character contact behavior against it was wrong in both cases.
   */
  refreshBodyAnchored(part: {
    id: string;
    type?: string;
    size: { x: number; y: number; z: number };
    material?: string;
    density?: number;
  }): void {
    const body = this.bodies.get(part.id);
    const cannonBody = this.cannonBodies.get(part.id);
    if (!body || !cannonBody) return;
    if (body.anchored) {
      cannonBody.type = CANNON.Body.STATIC;
      cannonBody.mass = 0;
      cannonBody.updateMassProperties();
      cannonBody.velocity.set(0, 0, 0);
      cannonBody.angularVelocity.set(0, 0, 0);
    } else {
      const mass = calculateMass(
        part.type ?? 'Block',
        part.size,
        part.material ?? 'Plastic',
        part.density,
      );
      cannonBody.type = CANNON.Body.DYNAMIC;
      cannonBody.mass = effectiveMass(mass);
      cannonBody.updateMassProperties();
      cannonBody.wakeUp();
    }
  }

  // ─── Simulation Step ───

  step(deltaTime: number): void {
    if (isNaN(deltaTime) || !isFinite(deltaTime)) return;

    const dt = Math.min(deltaTime, 1 / 30);

    // 0. v13.8: realize/remove joint constraints (weld/motor/rope)
    this.syncJointConstraints();

    // 1. Apply body movers and impulses to cannon bodies
    this.applyBodyMoversAndImpulses(dt);

    // 2. Update gravity from settings (may have changed)
    this.world.gravity.set(0, this.settings.gravity, 0);

    // 3. Step the cannon-es world. v6.2.4 ADAPTIVE SUBSTEPS: while any
    //    dynamic body (part or character pill) is fast, the fixed-step
    //    frequency rises so every integration step moves at most ~0.5
    //    studs - fast parts can no longer tunnel through characters (and
    //    fast-falling characters can no longer tunnel through thin parts).
    //    Speeds come from the previous step's scan + this step's impulse
    //    kicks, so the tier check itself is free.
    let charSpeed = 0;
    if (this.characterBody) {
      const v = this.characterBody.velocity;
      charSpeed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
    }
    for (const entry of this.namedCharacters.values()) {
      const v = entry.body.velocity;
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
    this.world.step(fixedStep, dt, maxSubSteps);

    // 4. Sync cannon body positions back to PhysicsBody entries
    this.syncCannonToPhysicsBodies();

    // 5. Check water state
    this.checkWaterState();

    // 6. Apply drag
    this.applyDrag(dt);

    // 7. Cap velocities
    this.capVelocities();

    // 8. Tick impulses
    this.tickImpulses(dt);
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

  /** Get the raw cannon body for a part id (used for far-body sleeping). */
  getCannonBody(id: string): CANNON.Body | undefined {
    return this.cannonBodies.get(id);
  }

  // ─── Body Movers & Impulses ───

  private applyBodyMoversAndImpulses(dt: number): void {
    for (const body of this.bodies.values()) {
      if (body.anchored) continue;

      const cannonBody = this.cannonBodies.get(body.id);

      // Apply body movers
      for (const mover of body.bodyMovers) {
        if (!mover.enabled) continue;
        this.applyBodyMover(body, mover, dt, cannonBody);
      }

      // Apply impulses
      const effMass = effectiveMass(body.mass);
      for (const impulse of body._impulses) {
        if (!impulse.applied) {
          if (cannonBody) {
            cannonBody.applyImpulse(
              new CANNON.Vec3(impulse.force.x, impulse.force.y, impulse.force.z)
            );
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

  private applyBodyMover(body: PhysicsBody, mover: BodyMover, dt: number, cannonBody: CANNON.Body | undefined): void {
    const effMass = effectiveMass(body.mass);

    switch (mover.type) {
      case 'BodyForce':
        if (mover.force) {
          const fx = (mover.force.x / effMass) * dt;
          const fy = (mover.force.y / effMass) * dt;
          const fz = (mover.force.z / effMass) * dt;
          if (cannonBody) {
            cannonBody.applyForce(
              new CANNON.Vec3(mover.force.x, mover.force.y, mover.force.z)
            );
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
          if (cannonBody) {
            cannonBody.applyForce(
              new CANNON.Vec3(mover.force.x, mover.force.y, mover.force.z)
            );
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

  // ─── Sync cannon body → PhysicsBody ───

  private syncCannonToPhysicsBodies(): void {
    // v13.4 PERF: reused scratch objects - the old version allocated ~6 objects
    // per body per frame (Vec3 x4 + RaycastResult + euler), which hammered the
    // garbage collector with thousands of allocations per second.
    const euler = new CANNON.Vec3();
    const rayFrom = new CANNON.Vec3();
    const rayTo = new CANNON.Vec3();
    const rayResult = new CANNON.RaycastResult();

    for (const body of this.bodies.values()) {
      const cannonBody = this.cannonBodies.get(body.id);
      if (!cannonBody) continue;

      if (body.anchored) {
        // For anchored bodies, sync FROM store position to cannon body ONLY when
        // it actually moved (old version called .set() on all 5,801 anchored
        // bodies every single frame). Marked dirty by updateBody/syncFromPart.
        if (body._anchoredDirty) {
          cannonBody.position.set(body.position.x, body.position.y, body.position.z);
          body._anchoredDirty = false;
        }
        body.isGrounded = body.position.y <= 0.01;
        continue;
      }

      // v13.4 PERF: skip sleeping dynamic bodies entirely - they haven't moved.
      const wasSleeping = cannonBody.sleepState === CANNON.Body.SLEEPING;
      if (wasSleeping) {
        body.isAwake = false;
        continue;
      }

      // Sync position from cannon. v13.7: use interpolatedPosition - the
      // world steps at a FIXED 60 Hz (world.step(1/60, dt, 3)), so the raw
      // `position` only updates in 1/60s quanta. On a 60+ fps render loop the
      // accumulator phase-beats against the frame rate: some frames advance
      // a step, others repeat the old position - that hold-then-jump pattern
      // was the "character buzzes / stutters while walking" bug. The
      // interpolated position blends between the last two fixed steps and is
      // what should drive anything visual.
      body.position.x = cannonBody.interpolatedPosition.x;
      body.position.y = cannonBody.interpolatedPosition.y;
      body.position.z = cannonBody.interpolatedPosition.z;

      // Sync velocity from cannon
      body.velocity.x = cannonBody.velocity.x;
      body.velocity.y = cannonBody.velocity.y;
      body.velocity.z = cannonBody.velocity.z;

      // Sync rotation from cannon
      cannonBody.quaternion.toEuler(euler);
      body.rotation.x = euler.x * 180 / Math.PI;
      body.rotation.y = euler.y * 180 / Math.PI;
      body.rotation.z = euler.z * 180 / Math.PI;

      // Sync angular velocity
      body.angularVelocity.x = cannonBody.angularVelocity.x;
      body.angularVelocity.y = cannonBody.angularVelocity.y;
      body.angularVelocity.z = cannonBody.angularVelocity.z;

      // Check grounded: raycast downward (only for awake bodies - a sleeping
      // body keeps its last grounded state)
      rayFrom.set(body.position.x, body.position.y, body.position.z);
      rayTo.set(body.position.x, body.position.y - (body.size.y / 2 + 0.1), body.position.z);
      rayResult.reset();
      this.world.raycastClosest(rayFrom, rayTo, {}, rayResult);
      body.isGrounded = rayResult.hasHit;

      body.isAwake = true;
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
      const cannonBody = this.cannonBodies.get(bodyId);
      const waterBuoyancy = Math.abs(this.settings.gravity) * 0.8;
      if (cannonBody) {
        cannonBody.applyForce(new CANNON.Vec3(0, waterBuoyancy * effectiveMass(body.mass), 0));
        // Water drag
        cannonBody.velocity.x *= (1 - WATER_DRAG * (1 / 60));
        cannonBody.velocity.y *= (1 - WATER_DRAG * (1 / 60));
        cannonBody.velocity.z *= (1 - WATER_DRAG * (1 / 60));
        // Water current
        const forceMultiplier = [0, 0.2, 0.5, 1.0, 2.0][this.settings.waterForce] ?? 0.5;
        cannonBody.applyForce(new CANNON.Vec3(
          this.settings.waterDirection.x * forceMultiplier * effectiveMass(body.mass) * 10,
          0,
          this.settings.waterDirection.z * forceMultiplier * effectiveMass(body.mass) * 10
        ));
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
        // Air drag (very small)
        const cannonBody = this.cannonBodies.get(body.id);
        if (cannonBody) {
          // cannon-es has linearDamping for this
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
        const cannonBody = this.cannonBodies.get(body.id);
        if (cannonBody) {
          cannonBody.velocity.set(body.velocity.x, body.velocity.y, body.velocity.z);
        }
      }

      // NaN guard
      if (isNaN(body.position.x) || isNaN(body.position.y) || isNaN(body.position.z)) {
        body.position = { x: 0, y: 10, z: 0 };
        body.velocity = { x: 0, y: 0, z: 0 };
        const cannonBody = this.cannonBodies.get(body.id);
        if (cannonBody) {
          cannonBody.position.set(0, 10, 0);
          cannonBody.velocity.set(0, 0, 0);
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
    const cannonBody = this.cannonBodies.get(bodyId);
    if (cannonBody) {
      cannonBody.wakeUp();
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
    const grav = this.settings.gravity;

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

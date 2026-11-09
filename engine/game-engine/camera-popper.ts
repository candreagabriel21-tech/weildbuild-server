/**
 * camera-popper.ts — a port of Roblox's classic Popper.lua camera occlusion
 * ("Prevents your camera from clipping through walls"), rewritten for the
 * WeildBuild play camera.
 *
 * ─── Why the pass-21..24 sphere-sweep machinery was replaced ───
 *
 * The old system swept a single 0.35-radius sphere along the torso→camera
 * CENTER LINE with a pile of special cases (initial-overlap rules, from-anchor
 * rescue tiers, near-clearance nudges). Two owner reports it never solved:
 *
 *   1. "Walking up a wedge gives the camera a heart attack." The old sweep
 *      treated EVERY part as a full box — a wedge's slope is an invisible
 *      wall in the box above it, so ascending a ramp made the anchor→camera
 *      segment "intersect" geometry that does not exist, retracting hard,
 *      then releasing, then retracting — jitter the whole way up.
 *
 *   2. "Looking through walls is a simple gesture away at the edges." A
 *      center-line sweep cannot see a wall crossing the view FRUSTURE edge
 *      near the lens; the camera ended up with geometry inside its near
 *      plane, where the renderer clips it away — see-through.
 *
 * Popper (shipped in Roblox for over a decade) solves both by construction:
 * it sweeps the camera's near-plane RECT from the subject toward the camera
 * (4 corner rays) and honors hard/soft limits:
 *
 *   - HARD limit: an occluder's solid reaches past the target plane (the
 *     near-plane rect projected a near-plane buffer PAST the desired camera
 *     position) — i.e. the camera would sit inside/nearly inside geometry.
 *     Applied immediately and unconditionally.
 *
 *   - SOFT limit: an occluder blocks the swept box between subject and
 *     camera but ends before the target plane (it pokes the view volume
 *     without swallowing the lens). Applied ONLY when it is persistent —
 *     either the camera just passed through it (promotion) or dead-reckoning
 *     the character + camera rotation shows it stays blocked, and every
 *     body-scaled sample point around the subject is occluded too. This is
 *     the anti-jitter machinery: transient pokes (walking past a corner,
 *     cresting a wedge) do NOT yank the camera.
 *
 * ─── Part states honored (the "objects have states" requirement) ───
 *
 * Every occluder is raycast EXACTLY against its real shape, size, and FULL
 * Euler rotation (the renderer applies rotation.x/y/z; the old code ignored
 * X/Z entirely and treated spheres/cylinders/wedges as boxes):
 *
 *   - Block/Spawn: oriented box (slab test in the part's local frame)
 *   - Sphere:      ellipsoid with the part's three radii (visual mesh)
 *   - Cylinder:    elliptical cylinder with flat caps (visual mesh)
 *   - Wedge:       the exact triangular prism from the physics engine
 *                  (tall face +Z, slope descending toward -Z)
 *
 * Non-occluding states (filtered at build time, like Roblox's canOcclude):
 * canCollide=false parts (touch-only triggers), cameraCanLookThrough parts
 * (per-part checkbox; character parts default to it), and transparent parts
 * (transparency >= 0.2 — glass you are meant to see through).
 *
 * ─── Port notes (semantics kept 1:1 with popper.lua) ───
 *
 * - popper.lua's `camera.NearPlaneZ` behaved as a POSITIVE near-plane buffer
 *   in the era the script shipped: the corner rays extend to
 *   dist + nearZ (a plane nearZ PAST the desired camera) and the returned
 *   limits are `entry - nearZ`, which parks the camera nearZ SHORT of the
 *   first obstruction. We keep that with POPPER_NEAR_Z = 0.35 (the same
 *   thickness budget the old CAM_SPHERE_RADIUS gave the lens).
 * - Roblox's whitelist "exit ray" (cast from the target back toward the
 *   entry point to decide hard vs soft) is replaced by the exact ray/solid
 *   t-interval: soft ⟺ tExit ≤ targetDist + nearZ, hard ⟺ tExit > it.
 *   For convex shapes this is bit-for-bit the same decision, with none of
 *   the from-inside raycast ambiguity.
 * - The soft→hard PROMOTION test (popper casts lastPos→target and
 *   target→lastPos whitelisted to the part) becomes an exact
 *   segment-crossing test with the same semantics, including popper's
 *   quirk that a segment fully contained inside a convex part does not
 *   promote.
 * - testPromotion keeps both blocks: dead-reckoning the subject along its
 *   velocity with the camera rotation extrapolated (Rotate:GetDelta port:
 *   smoothed yaw/pitch rates), and the five body-scaled SCAN_SAMPLE_OFFSETS
 *   probes. If ANY probe is clear at the full distance, the soft limit is
 *   transient and not applied.
 */

import * as THREE from 'three';

/** The near-plane buffer: the swept box is the near-plane rect (scaled by
 * this distance), and the final camera position keeps occluders this far
 * in front of the lens. Same thickness the old CAM_SPHERE_RADIUS used. */
export const POPPER_NEAR_Z = 0.35;

// testPromotion: dead-reckoning sample cadence and horizon (popper.lua).
const SAMPLE_DT = 0.0625;
const SAMPLE_MAX_T = 1.25;

// Body-scaled probe offsets around the subject (popper.lua
// SCAN_SAMPLE_OFFSETS). Multiplied by the body scale so oversized/undersized
// characters probe proportionally.
const SCAN_SAMPLE_OFFSETS: Array<[number, number]> = [
  [0.4, 0.0],
  [-0.4, 0.0],
  [0.0, -0.4],
  [0.0, 0.4],
  [0.0, 0.2],
];

/** Shape kinds the popper raycasts exactly. Mirrors the studio part types
 * that have real collision (STUDIO_TYPE_TO_SHAPE), plus 'block' for tree
 * blocks and dynamic bodies. */
export type PopperShape = 'block' | 'sphere' | 'cylinder' | 'wedge';

/** A part prepared for the camera popper. Positions/sizes in world studs;
 * `b*` rows are the world→local rotation matrix (Rᵀ, built with the SAME
 * Euler XYZ order the renderer uses, so the camera collides with the part
 * exactly where it is drawn). `noRotate` fast-paths identity rotation. */
export interface PopperPart {
  id?: string;
  px: number; py: number; pz: number;
  hw: number; hh: number; hd: number;
  shape: PopperShape;
  noRotate: boolean;
  bx0: number; bx1: number; bx2: number; // local .x row of Rᵀ
  by0: number; by1: number; by2: number; // local .y row
  bz0: number; bz1: number; bz2: number; // local .z row
}

// Scratch for reusable vectors (frame-loop hot path, no GC).
const _euler = new THREE.Euler(0, 0, 0, 'XYZ');
const _mat4 = new THREE.Matrix4();

/** Build a PopperPart. `rotDeg` is the part's Euler rotation in DEGREES
 * (studio store convention, same values the renderer receives). */
export function makePopperPart(
  px: number, py: number, pz: number,
  sizeX: number, sizeY: number, sizeZ: number,
  rotDegX: number, rotDegY: number, rotDegZ: number,
  shape: PopperShape,
  id?: string,
): PopperPart {
  const part: PopperPart = {
    id,
    px, py, pz,
    hw: Math.max(sizeX / 2, 0.005),
    hh: Math.max(sizeY / 2, 0.005),
    hd: Math.max(sizeZ / 2, 0.005),
    shape,
    noRotate: rotDegX === 0 && rotDegY === 0 && rotDegZ === 0,
    bx0: 1, bx1: 0, bx2: 0,
    by0: 0, by1: 1, by2: 0,
    bz0: 0, bz1: 0, bz2: 1,
  };
  if (!part.noRotate) {
    _euler.set(rotDegX * Math.PI / 180, rotDegY * Math.PI / 180, rotDegZ * Math.PI / 180, 'XYZ');
    _mat4.makeRotationFromEuler(_euler);
    const te = _mat4.elements;
    // world→local = Rᵀ: row i of Rᵀ is column i of R (column-major elements).
    part.bx0 = te[0]; part.bx1 = te[1]; part.bx2 = te[2];
    part.by0 = te[4]; part.by1 = te[5]; part.by2 = te[6];
    part.bz0 = te[8]; part.bz1 = te[9]; part.bz2 = te[10];
  }
  return part;
}

/** The interval filled by the last successful rayPartInterval call
 *  (test hook — the hot path reads the module scratch directly). */
export function lastRayHit(): { enter: number; exit: number } {
  return { enter: _hitEnter, exit: _hitExit };
}

// ─── Exact ray-vs-part t-interval ────────────────────────────────────
//
// Fills _hitEnter/_hitExit with the ray's parameter interval inside the
// part's solid (world-scaled t; _hitEnter < 0 means the origin starts
// inside). Returns false when the solid cannot overlap [0, maxT] at all.
// Convex shapes only — the interval is a single [enter, exit] pair.

let _hitEnter = 0;
let _hitExit = 0;

export function rayPartInterval(
  part: PopperPart,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  maxT: number,
): boolean {
  // world → part local
  let lx: number, ly: number, lz: number, ldx: number, ldy: number, ldz: number;
  if (part.noRotate) {
    lx = ox - part.px; ly = oy - part.py; lz = oz - part.pz;
    ldx = dx; ldy = dy; ldz = dz;
  } else {
    const rx = ox - part.px, ry = oy - part.py, rz = oz - part.pz;
    lx = part.bx0 * rx + part.bx1 * ry + part.bx2 * rz;
    ly = part.by0 * rx + part.by1 * ry + part.by2 * rz;
    lz = part.bz0 * rx + part.bz1 * ry + part.bz2 * rz;
    ldx = part.bx0 * dx + part.bx1 * dy + part.bx2 * dz;
    ldy = part.by0 * dx + part.by1 * dy + part.by2 * dz;
    ldz = part.bz0 * dx + part.bz1 * dy + part.bz2 * dz;
  }

  let tEnter = -Infinity, tExit = Infinity;

  if (part.shape === 'sphere') {
    // Ellipsoid: scale to a unit sphere (t is preserved by axis scaling).
    const ex = ldx / part.hw, ey = ldy / part.hh, ez = ldz / part.hd;
    const a = ex * ex + ey * ey + ez * ez;
    const ox2 = lx / part.hw, oy2 = ly / part.hh, oz2 = lz / part.hd;
    const b = 2 * (ox2 * ex + oy2 * ey + oz2 * ez);
    const c = ox2 * ox2 + oy2 * oy2 + oz2 * oz2 - 1;
    if (a < 1e-12) {
      if (c > 0) return false; // parallel to nothing: origin outside the shell
      // origin inside a degenerate-flat direction; interval unbounded on this axis
    } else {
      const disc = b * b - 4 * a * c;
      if (disc < 0) return false;
      const sq = Math.sqrt(disc);
      tEnter = (-b - sq) / (2 * a);
      tExit = (-b + sq) / (2 * a);
    }
  } else if (part.shape === 'cylinder') {
    // Elliptical cylinder, axis = local Y, flat caps at y = ±hh.
    // y slabs:
    if (Math.abs(ldy) < 1e-12) {
      if (ly < -part.hh || ly > part.hh) return false;
    } else {
      const t1 = (-part.hh - ly) / ldy;
      const t2 = (part.hh - ly) / ldy;
      tEnter = Math.max(tEnter, Math.min(t1, t2));
      tExit = Math.min(tExit, Math.max(t1, t2));
    }
    // elliptical side: (x/hw)² + (z/hd)² = 1
    const ex = ldx / part.hw, ez = ldz / part.hd;
    const a = ex * ex + ez * ez;
    const ox2 = lx / part.hw, oz2 = lz / part.hd;
    if (a < 1e-12) {
      if (ox2 * ox2 + oz2 * oz2 > 1) return false;
    } else {
      const b = 2 * (ox2 * ex + oz2 * ez);
      const c = ox2 * ox2 + oz2 * oz2 - 1;
      const disc = b * b - 4 * a * c;
      if (disc < 0) return false;
      const sq = Math.sqrt(disc);
      tEnter = Math.max(tEnter, (-b - sq) / (2 * a));
      tExit = Math.min(tExit, (-b + sq) / (2 * a));
    }
  } else {
    // block (6-plane box) and wedge (5-plane prism from the physics engine:
    // tall face at +Z, slope descending toward -Z) — both via plane clips.
    // X slabs (both shapes):
    if (Math.abs(ldx) < 1e-12) {
      if (lx < -part.hw || lx > part.hw) return false;
    } else {
      const t1 = (-part.hw - lx) / ldx;
      const t2 = (part.hw - lx) / ldx;
      tEnter = Math.max(tEnter, Math.min(t1, t2));
      tExit = Math.min(tExit, Math.max(t1, t2));
    }
    if (part.shape === 'wedge') {
      // bottom plane y ≥ -hh (no top: the slope replaces it)
      if (Math.abs(ldy) < 1e-12) {
        if (ly < -part.hh) return false;
      } else {
        const t1 = (-part.hh - ly) / ldy;
        // clip to t where y ≥ -hh: keep the interval side depending on sign
        if (ldy > 0) { if (t1 > tEnter) tEnter = t1; } else { if (t1 < tExit) tExit = t1; }
      }
      // front plane z ≤ hd
      if (Math.abs(ldz) < 1e-12) {
        if (lz > part.hd) return false;
      } else {
        const t2 = (part.hd - lz) / ldz;
        if (ldz > 0) { if (t2 < tExit) tExit = t2; } else { if (t2 > tEnter) tEnter = t2; }
      }
      // slope plane: hd*y - hh*z ≤ 0 (through (y=hh,z=hd) and (y=-hh,z=-hd),
      // outward normal (0, hd, -hh) — matches the physics ConvexPolyhedron)
      const nx = 0, ny = part.hd, nz = -part.hh;
      const denom = ny * ldy + nz * ldz;
      const num = -(ny * ly + nz * lz); // plane: n·p ≤ 0 → n·p + 0 ≤ 0
      if (Math.abs(denom) < 1e-12) {
        if (ny * ly + nz * lz > 0) return false;
      } else {
        const t = num / denom;
        if (denom > 0) { if (t < tExit) tExit = t; } else { if (t > tEnter) tEnter = t; }
      }
    } else {
      // block: Y and Z slabs
      if (Math.abs(ldy) < 1e-12) {
        if (ly < -part.hh || ly > part.hh) return false;
      } else {
        const t1 = (-part.hh - ly) / ldy;
        const t2 = (part.hh - ly) / ldy;
        tEnter = Math.max(tEnter, Math.min(t1, t2));
        tExit = Math.min(tExit, Math.max(t1, t2));
      }
      if (Math.abs(ldz) < 1e-12) {
        if (lz < -part.hd || lz > part.hd) return false;
      } else {
        const t1 = (-part.hd - lz) / ldz;
        const t2 = (part.hd - lz) / ldz;
        tEnter = Math.max(tEnter, Math.min(t1, t2));
        tExit = Math.min(tExit, Math.max(t1, t2));
      }
    }
  }

  if (tExit < tEnter) return false;      // misses the solid
  if (tExit < 0) return false;           // entirely behind the origin
  if (tEnter > maxT) return false;       // beyond the queried range
  _hitEnter = tEnter;
  _hitExit = tExit;
  return true;
}

/** Is the point inside (or on the boundary of) the part's solid? */
export function pointInPart(part: PopperPart, x: number, y: number, z: number): boolean {
  if (rayPartInterval(part, x, y, z, 1, 0, 0, 0)) {
    // t=0 interval with a zero-length query: inside iff enter ≤ 0 ≤ exit
    return _hitEnter <= 1e-9 && _hitExit >= -1e-9;
  }
  // rayPartInterval can only return false here when the solid misses the
  // degenerate range [0,0] — i.e. the point is outside (the interval exists
  // but lies entirely at t>0 or t<0), EXCEPT for edge cases where the point
  // is outside along +x. Retry with a direction that cannot be parallel to
  // any face plane.
  if (rayPartInterval(part, x, y, z, 0.577, 0.577, 0.577, 0)) {
    return _hitEnter <= 1e-9 && _hitExit >= -1e-9;
  }
  return false;
}

// ─── Piercing collision point (popper.lua getCollisionPoint) ─────────
//
// Casts a SHORT, non-normalized offset ray (the body sample probes) and
// returns where it lands: the first surface it runs into, the origin itself
// when it starts inside a solid (Roblox hit-at-origin), or the endpoint when
// nothing blocks it. Non-collidable parts are not in the occluder list, so
// there is nothing to pierce — the ignore-list walk reduces to a min scan.

export interface CollisionPointResult {
  x: number; y: number; z: number;
  hit: boolean;
}
const _cpResult: CollisionPointResult = { x: 0, y: 0, z: 0, hit: false };

export function getCollisionPoint(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  parts: PopperPart[],
): CollisionPointResult {
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-9) {
    _cpResult.x = ox; _cpResult.y = oy; _cpResult.z = oz; _cpResult.hit = false;
    return _cpResult;
  }
  const ndx = dx / len, ndy = dy / len, ndz = dz / len;
  let bestT = len;
  let bestHit = false;
  for (let i = 0; i < parts.length; i++) {
    if (!rayPartInterval(parts[i], ox, oy, oz, ndx, ndy, ndz, len)) continue;
    if (_hitEnter <= 0) {
      // Starts inside (or on the surface of) this solid: the point stays.
      _cpResult.x = ox; _cpResult.y = oy; _cpResult.z = oz; _cpResult.hit = true;
      return _cpResult;
    }
    if (_hitEnter < bestT) {
      bestT = _hitEnter;
      bestHit = true;
    }
  }
  _cpResult.x = ox + ndx * bestT;
  _cpResult.y = oy + ndy * bestT;
  _cpResult.z = oz + ndz * bestT;
  _cpResult.hit = bestHit;
  return _cpResult;
}

// ─── Soft→hard promotion (popper.lua's dual whitelist rays) ──────────
//
// Popper promotes a soft limit when the obstruction lies between the
// CURRENT camera position (its near-plane corner for this viewport corner)
// and the TARGET position: two whitelisted rays, one from each endpoint.
// With exact intervals that is "the segment crosses into the part's solid
// from either endpoint", with popper's quirk that a segment fully inside a
// convex part promotes nothing (neither ray registers a surface crossing).

function segmentPromotes(
  part: PopperPart,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
): boolean {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const L = Math.hypot(abx, aby, abz);
  if (L < 1e-9) return false;
  const ndx = abx / L, ndy = aby / L, ndz = abz / L;

  // Ray a→b: crossing ⟺ a is outside the part and the entry lies within
  // the open segment.
  if (rayPartInterval(part, ax, ay, az, ndx, ndy, ndz, L)) {
    if (_hitEnter > 0) {
      // a outside: does it cross in before b?
      return _hitEnter < L && _hitExit > 0;
    }
    // a inside: popper's a→b ray registers nothing; test from b.
    if (rayPartInterval(part, bx, by, bz, -ndx, -ndy, -ndz, L)) {
      if (_hitEnter <= 0) return false; // b inside too: no crossing either way
      return _hitEnter < L && _hitExit > 0;
    }
    // b-side interval missing beyond L (can only mean "crossing beyond b")
    return false;
  }
  // No overlap with [0, L] from a at all: the part does not cross the
  // segment from a's side. If a is INSIDE, rayPartInterval still returns
  // true above (interval straddles 0), so reaching here means a is outside
  // and the part is beyond b or behind a — but check b-inside via the
  // reverse cast, which popper's second ray covers.
  if (rayPartInterval(part, bx, by, bz, -ndx, -ndy, -ndz, L)) {
    if (_hitEnter <= 0) {
      // b inside, a outside: the reverse ray crosses in before a — but the
      // forward interval above returned false, which for a outside means the
      // solid does not overlap [0,L] from a. Both cannot hold for a convex
      // part; treat as no crossing (defensive).
      return false;
    }
    return _hitEnter < L && _hitExit > 0;
  }
  return false;
}

// ─── queryPoint (popper.lua queryPoint) ──────────────────────────────
//
// One corner ray: casts origin → target (target = origin + dir*(dist+N)),
// and for every occluder whose solid overlaps the ray computes
//   lim = entry distance from the origin (0 when the origin starts inside)
//   hard  ⟺ the solid reaches past the target plane (tExit > dist+N)
//   soft  ⟺ the solid ends before it (tExit ≤ dist+N)
// Soft candidates are promoted to hard when the part lies between lastPos
// (the current camera's matching near-plane corner) and the target.
// Limits are returned in CAMERA-DISTANCE units (entry − N), so the final
// camera position keeps the occluder POPPER_NEAR_Z in front of the lens.

export interface PointLimits {
  soft: number;
  hard: number;
}
const _limits: PointLimits = { soft: Infinity, hard: Infinity };

export function queryPoint(
  ox: number, oy: number, oz: number,
  ndx: number, ndy: number, ndz: number, // normalized
  dist: number,
  hasLast: boolean,
  lastX: number, lastY: number, lastZ: number,
  parts: PopperPart[],
): PointLimits {
  const L = dist + POPPER_NEAR_Z;
  const tx = ox + ndx * L, ty = oy + ndy * L, tz = oz + ndz * L;
  let soft = Infinity, hard = Infinity;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!rayPartInterval(part, ox, oy, oz, ndx, ndy, ndz, L)) continue;
    const enter = _hitEnter;
    const exit = _hitExit;
    if (exit < 0 || enter > L) continue; // defensive; rayPartInterval pre-filters
    const lim = Math.max(enter, 0);
    const limitDist = lim - POPPER_NEAR_Z;

    if (exit > L) {
      // Trivial hard limit: the solid reaches past the target plane.
      if (limitDist < hard) hard = limitDist;
    } else {
      // Soft candidate — promote when the camera passed through it.
      const promoted = hasLast && segmentPromotes(part, lastX, lastY, lastZ, tx, ty, tz);
      if (promoted) {
        if (limitDist < hard) hard = limitDist;
      } else if (limitDist < soft) {
        soft = limitDist;
      }
    }
  }

  _limits.soft = soft;
  _limits.hard = hard;
  return _limits;
}

// ─── CameraPopper ────────────────────────────────────────────────────
//
// Stateful per-camera instance: remembers the previous frame's camera
// transform (for soft→hard promotion) and the smoothed look rates (for the
// dead-reckoning rotation extrapolation, the Rotate:GetDelta port).

export interface BodyScale { x: number; y: number; z: number }

export class CameraPopper {
  // Previous frame's final camera transform (set via notifyCameraPlaced).
  private prevValid = false;
  private prevPx = 0; private prevPy = 0; private prevPz = 0;
  private prevFx = 0; private prevFy = 0; private prevFz = -1;
  private prevRx = 1; private prevRy = 0; private prevRz = 0;
  private prevUx = 0; private prevUy = 1; private prevUz = 0;
  // Smoothed look rates (rad/s) for dead reckoning.
  private yawRate = 0;
  private pitchRate = 0;
  private lastYaw = 0;
  private lastPitch = 0;
  private lastLookT = 0;

  /** Feed the current look angles each frame (radians). Tracks smoothed
   *  yaw/pitch rates used to extrapolate the camera rotation. */
  notifyLook(yaw: number, pitch: number, now: number) {
    if (this.lastLookT > 0) {
      const dt = Math.min(0.1, Math.max(1e-3, (now - this.lastLookT) / 1000));
      let dy = yaw - this.lastYaw;
      // wrap the yaw the short way
      while (dy > Math.PI) dy -= 2 * Math.PI;
      while (dy < -Math.PI) dy += 2 * Math.PI;
      const dp = pitch - this.lastPitch;
      const blend = 0.25;
      this.yawRate += (dy / dt - this.yawRate) * blend;
      this.pitchRate += (dp / dt - this.pitchRate) * blend;
    }
    this.lastYaw = yaw;
    this.lastPitch = pitch;
    this.lastLookT = now;
  }

  /** Report the FINAL camera transform after placement (world units). */
  notifyCameraPlaced(
    px: number, py: number, pz: number,
    fx: number, fy: number, fz: number, // normalized forward (look direction)
    rx: number, ry: number, rz: number, // normalized right
    ux: number, uy: number, uz: number, // normalized up
  ) {
    this.prevValid = true;
    this.prevPx = px; this.prevPy = py; this.prevPz = pz;
    this.prevFx = fx; this.prevFy = fy; this.prevFz = fz;
    this.prevRx = rx; this.prevRy = ry; this.prevRz = rz;
    this.prevUx = ux; this.prevUy = uy; this.prevUz = uz;
  }

  /** Extrapolate the camera back-direction fZ by dt seconds of look rate
   *  (popper.lua's Rotate:GetDelta): yaw about world up, then pitch about
   *  the current right axis. */
  private extrapolateDir(
    fx: number, fy: number, fz: number, // fZ = subject→camera direction
    rx: number, ry: number, rz: number, // camera right
    dt: number,
    out: { x: number; y: number; z: number },
  ) {
    // yaw about worldUp
    let vx = fx, vy = fy, vz = fz;
    const yawD = this.yawRate * dt;
    if (Math.abs(yawD) > 1e-9) {
      const c = Math.cos(yawD), s = Math.sin(yawD);
      const nx = vx * c - vz * s;
      const nz = vx * s + vz * c;
      vx = nx; vz = nz;
    }
    // pitch about the right axis (Rodrigues)
    const pitchD = this.pitchRate * dt;
    if (Math.abs(pitchD) > 1e-9) {
      const c = Math.cos(pitchD), s = Math.sin(pitchD);
      const dot = rx * vx + ry * vy + rz * vz;
      const cx = ry * vz - rz * vy;
      const cy = rz * vx - rx * vz;
      const cz = rx * vy - ry * vx;
      vx = vx * c + cx * s + rx * dot * (1 - c);
      vy = vy * c + cy * s + ry * dot * (1 - c);
      vz = vz * c + cz * s + rz * dot * (1 - c);
    }
    out.x = vx; out.y = vy; out.z = vz;
  }

  /** popper.lua testPromotion. Returns true when the soft limit should be
   *  applied: every dead-reckoned future sample is still blocked AND every
   *  body-scaled offset probe is occluded. Any clear probe ⇒ transient. */
  private testPromotion(
    ax: number, ay: number, az: number,     // subject anchor
    rx: number, ry: number, rz: number,     // camera right (fX)
    ux: number, uy: number, uz: number,     // camera up (fY)
    fx: number, fy: number, fz: number,     // subject→camera direction (fZ)
    dist: number,
    velX: number, velY: number, velZ: number,
    bodyScale: BodyScale,
    parts: PopperPart[],
  ): boolean {
    // ── Dead reckoning the camera rotation and focus ──
    const speed = Math.hypot(velX, velY, velZ);
    if (speed > 1e-4) {
      const cp = getCollisionPoint(ax, ay, az, velX * SAMPLE_MAX_T, velY * SAMPLE_MAX_T, velZ * SAMPLE_MAX_T, parts);
      const maxDist = Math.hypot(cp.x - ax, cp.y - ay, cp.z - az);
      const tEnd = Math.min(SAMPLE_MAX_T, maxDist / speed);
      const dir = { x: 0, y: 0, z: 0 };
      for (let dt = 0; dt <= tEnd + 1e-9; dt += SAMPLE_DT) {
        const ox = ax + velX * dt;
        const oy = ay + velY * dt;
        const oz = az + velZ * dt;
        this.extrapolateDir(fx, fy, fz, rx, ry, rz, dt, dir);
        const dl = Math.hypot(dir.x, dir.y, dir.z) || 1;
        const lim = queryPoint(ox, oy, oz, dir.x / dl, dir.y / dl, dir.z / dl, dist, false, 0, 0, 0, parts);
        if (lim.soft >= dist) return false;
      }
    }

    // ── Screen-space offset probes around the subject ──
    const sx = bodyScale.x, sy = bodyScale.y, sz = bodyScale.z;
    const sampleScaleX = Math.sqrt(sx * sx + sz * sz);
    const sampleScaleY = sy;
    const camX = ax + fx * dist, camY = ay + fy * dist, camZ = az + fz * dist;
    for (let i = 0; i < SCAN_SAMPLE_OFFSETS.length; i++) {
      const [offX, offY] = SCAN_SAMPLE_OFFSETS[i];
      const scaledX = offX * sampleScaleX;
      const scaledY = offY * sampleScaleY;
      const probe = getCollisionPoint(
        ax, ay, az,
        rx * scaledX + ux * scaledY,
        ry * scaledX + uy * scaledY,
        rz * scaledX + uz * scaledY,
        parts,
      );
      let dirX = camX - probe.x, dirY = camY - probe.y, dirZ = camZ - probe.z;
      const dl = Math.hypot(dirX, dirY, dirZ) || 1;
      dirX /= dl; dirY /= dl; dirZ /= dl;
      const lim = queryPoint(probe.x, probe.y, probe.z, dirX, dirY, dirZ, dist, false, 0, 0, 0, parts);
      if (lim.soft === Infinity) return false;
    }
    return true;
  }

  /** popper.lua Popper(focus, targetDist): the clamped camera distance.
   *
   *  anchor: the camera subject point (chest). fZ: the NORMALIZED
   *  subject→camera direction (the orbit direction). targetDist: the
   *  desired camera distance (the user's zoom, blended with first person).
   *  fovDeg/aspect: the render camera's field of view and aspect ratio.
   *  parts: nearby occluders (already filtered to canCollide ∧ opaque ∧
   *  !cameraCanLookThrough). vel: subject velocity. bodyScale: character
   *  scale relative to the default hitbox (1,1,1 = default). */
  compute(
    ax: number, ay: number, az: number,
    fzx: number, fzy: number, fzz: number,
    targetDist: number,
    fovDeg: number,
    aspect: number,
    parts: PopperPart[],
    velX: number, velY: number, velZ: number,
    bodyScale: BodyScale,
  ): number {
    // Camera basis: forward looks at the subject, so fZ = -forward.
    const ffx = -fzx, ffy = -fzy, ffz = -fzz;
    // right = normalize(forward × worldUp); fall back when looking
    // straight up/down.
    let rx = ffy * 0 - ffz * 1; // forward × (0,1,0)
    let ry = ffz * 0 - ffx * 0;
    let rz = ffx * 1 - ffy * 0;
    if (rx * rx + ry * ry + rz * rz < 1e-8) {
      rx = 1; ry = 0; rz = 0; // forward ∥ up: arbitrary horizontal right
    } else {
      const rl = Math.hypot(rx, ry, rz);
      rx /= rl; ry /= rl; rz /= rl;
    }
    // up = right × forward
    const ux = ry * ffz - rz * ffy;
    const uy = rz * ffx - rx * ffz;
    const uz = rx * ffy - ry * ffx;

    // Projection extents (popper.lua updateProjection): the frustum
    // cross-section at distance 1.
    const fovRad = fovDeg * Math.PI / 180;
    const projY = 2 * Math.tan(fovRad / 2);
    const projX = aspect * projY;

    let soft = Infinity;
    let hard = Infinity;

    for (let viewX = 0; viewX <= 1; viewX++) {
      const wxx = rx * ((viewX - 0.5) * projX);
      const wxy = ry * ((viewX - 0.5) * projX);
      const wxz = rz * ((viewX - 0.5) * projX);
      for (let viewY = 0; viewY <= 1; viewY++) {
        const wyx = ux * ((viewY - 0.5) * projY);
        const wyy = uy * ((viewY - 0.5) * projY);
        const wyz = uz * ((viewY - 0.5) * projY);
        // Corner of the near-plane rect at the subject.
        const ox = ax + POPPER_NEAR_Z * (wxx + wyx);
        const oy = ay + POPPER_NEAR_Z * (wxy + wyy);
        const oz = az + POPPER_NEAR_Z * (wxz + wyz);
        // The same near-plane corner on the CURRENT camera (popper's
        // ViewportPointToRay(...).Origin) for soft→hard promotion.
        let hasLast = false;
        let lx = 0, ly = 0, lz = 0;
        if (this.prevValid) {
          hasLast = true;
          lx = this.prevPx + POPPER_NEAR_Z * this.prevFx
            + POPPER_NEAR_Z * (this.prevRx * ((viewX - 0.5) * projX) + this.prevUx * ((viewY - 0.5) * projY));
          ly = this.prevPy + POPPER_NEAR_Z * this.prevFy
            + POPPER_NEAR_Z * (this.prevRy * ((viewX - 0.5) * projX) + this.prevUy * ((viewY - 0.5) * projY));
          lz = this.prevPz + POPPER_NEAR_Z * this.prevFz
            + POPPER_NEAR_Z * (this.prevRz * ((viewX - 0.5) * projX) + this.prevUz * ((viewY - 0.5) * projY));
        }
        const lim = queryPoint(ox, oy, oz, fzx, fzy, fzz, targetDist, hasLast, lx, ly, lz, parts);
        if (lim.hard < hard) hard = lim.hard;
        if (lim.soft < soft) soft = lim.soft;
      }
    }

    let dist = targetDist;
    if (hard < dist) dist = hard;
    if (soft < dist && this.testPromotion(ax, ay, az, rx, ry, rz, ux, uy, uz, fzx, fzy, fzz, targetDist, velX, velY, velZ, bodyScale, parts)) {
      dist = soft;
    }
    return dist;
  }
}

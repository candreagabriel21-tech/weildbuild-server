// ═══════════════════════════════════════════════════════════════════
// camera-look (pass 27) — the editor camera's direction math, extracted
// from EditorCameraRig so it can be behaviorally verified without a
// canvas (the gizmo "look along an axis" turn is pure yaw/pitch math).
// ═══════════════════════════════════════════════════════════════════
import * as THREE from 'three';

/** Pitch is clamped just short of straight up/down so a subsequent drag
 *  always has a well-defined horizon. */
export function clampPitch(p: number): number {
  return Math.min(1.55, Math.max(-1.55, p));
}

/** Forward view direction for yaw/pitch (YXZ euler, forward = -Z). */
export function dirFromYawPitch(yaw: number, pitch: number, out: THREE.Vector3): THREE.Vector3 {
  const cp = Math.cos(pitch);
  return out.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
}

/** The yaw/pitch that makes the camera LOOK ALONG the (unit or non-unit)
 *  direction (x, y, z) with the standard world-up (no roll).
 *
 *  Straight up/down is degenerate (any yaw gives the same view
 *  direction), so the caller passes `keepYaw` — the turn keeps the
 *  camera's current facing, which reads as "tilt in place".
 *  Straight up/down is NOT clamped here: the axis gizmo's ±Y clicks
 *  should look exactly along Y (a drag afterwards re-clamps to 1.55). */
export function yawPitchFromDir(x: number, y: number, z: number, keepYaw: number): { yaw: number; pitch: number } {
  const len = Math.hypot(x, y, z);
  if (len < 1e-9) return { yaw: keepYaw, pitch: 0 };
  const ny = y / len;
  const pitch = Math.asin(THREE.MathUtils.clamp(ny, -1, 1));
  if (Math.abs(ny) > 0.999999) return { yaw: keepYaw, pitch: ny > 0 ? Math.PI / 2 : -Math.PI / 2 };
  return { yaw: Math.atan2(-x / len, -z / len), pitch };
}

/** Wrap a yaw delta into [-π, π] so a turn always takes the short way. */
export function shortestYawDelta(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

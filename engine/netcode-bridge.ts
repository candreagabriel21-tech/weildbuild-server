// ═══════════════════════════════════════════════════════════════════
// WeildBuild — netcode bridge (v1.2, client side)
// ═══════════════════════════════════════════════════════════════════
// The channel between the GamePlayer's Socket.IO connection and the
// play viewport's frame loop, for SERVER-AUTHORITATIVE multiplayer:
//
//   INPUT FLOW (client → server, 30 Hz + instant edge flushes):
//     GamePlayerCharacter → reportInput() → the sender GamePlayer
//     installed → socket.emit("game:input", ...). Direction changes,
//     sprint flips and jump presses flush the FRAME they happen; only the
//     steady state rides the 30 Hz throttle.
//
//   STATE FLOW (server → client, 30 Hz delta snapshots):
//     GamePlayer ("game:state") → selfHistory (timestamped samples) /
//     partCorrections → the play viewport renders YOUR character purely
//     from the interpolated snapshot stream (see sampleInterp below).
//     No local character prediction exists in server mode - what you see
//     is what the authority decided, smoothed.
//
// Singleplayer / Test Play never touches this module (netcode.mode stays
// 'local' and every field stays null/empty).

import { CLIENT_INPUT_HZ } from './game-engine/character-constants';

/** Camera-relative input the client reports to the authority. */
export interface NetcodeInput {
  /** Unit direction (or 0,0) the player wants to walk in, camera-relative. */
  x: number;
  z: number;
  /** Jump was requested this tick (edge-triggered on the client). */
  jump: boolean;
  /** Sprint held. */
  sprint: boolean;
  /** The character's yaw (radians) so the server can orient the hitbox. */
  yaw: number;
}

/** Authoritative state for the LOCAL player inside a snapshot. */
export interface SelfCorrection {
  seq: number;
  /** Feet position (the visible body root). */
  x: number;
  y: number;
  z: number;
  /** Body yaw in radians. */
  yaw: number;
  /** Authoritative health (server-owned in multiplayer). */
  hp: number;
  /** True during the server-side death animation. */
  dying: boolean;
  /** v6.2.3: the server's animation flags for this player (walk/jump/sprint
   * feel now comes from the same broadcast everyone else renders). */
  anim?: { walking?: boolean; jumping?: boolean; sprint?: boolean };
  /** v6.2.3: performance.now() ms when this correction arrived (landing
   * speed + authority-liveness bookkeeping for the server-driven character). */
  receivedAt: number;
}

// ─── v6.2.5: entity interpolation ───
// The rendering side of "remove the local prediction": every character on
// screen (yours included) is drawn from a TIMESTAMPED buffer of snapshot
// samples, rendered at a fixed delay behind arrival time. The delay is the
// jitter budget - with 30 Hz snapshots (33 ms apart) it always spans 3+
// live samples, so packet wobble never reaches the screen.

/** One timestamped transform sample (arrival-clock ms + feet position). */
export interface InterpSample {
  t: number;
  x: number; y: number; z: number;
  yaw: number;
}

/** The result of sampling an interpolation buffer at a render time. */
export interface InterpResult {
  x: number; y: number; z: number;
  yaw: number;
  /** Vertical velocity implied by the pair being interpolated (studs/s). */
  vy: number;
}

/** How far behind arrival time YOUR OWN character renders (ms). Kept
 * small - it is pure view latency for the player - but big enough to
 * always sit on 2+ live samples of the 30 Hz stream. */
export const SELF_INTERP_DELAY_MS = 100;
/** Remote characters render a bit further back: extra smoothing costs
 * nothing when it is not your own controls paying for it. */
export const REMOTE_INTERP_DELAY_MS = 150;
/** Consecutive samples farther apart than this are NOT interpolated
 * across (delta snapshots legitimately skip idle players, and a network
 * hole must not become a slow creep between two distant positions): the
 * earlier sample is held, and the buffer is trimmed on the next push. */
export const INTERP_GAP_CAP_MS = 130;
/** A pair of samples this far apart (studs) is a teleport/respawn: hold
 * the old position, then snap exactly when the render clock reaches the
 * new sample - never streak across the map. */
export const INTERP_TELEPORT_STUDS = 20;

/** Shortest signed angle difference (radians), for shortest-arc yaw lerp. */
function shortestAngle(diff: number): number {
  return Math.atan2(Math.sin(diff), Math.cos(diff));
}

/**
 * Sample a timestamped interpolation buffer at `renderT` (arrival-clock
 * ms). Between two samples closer than `gapCapMs` and nearer than
 * `teleportStuds`, the position/yaw are linearly interpolated (yaw through
 * the shortest arc); across a hole or a teleport the EARLIER sample is
 * held and the snap happens naturally when the clock passes the newer
 * one. Returns null only for an empty buffer.
 */
export function sampleInterp(
  buf: InterpSample[],
  renderT: number,
  gapCapMs: number,
  teleportStuds: number,
): InterpResult | null {
  const n = buf.length;
  if (n === 0) return null;
  if (n === 1 || renderT <= buf[0].t) return { x: buf[0].x, y: buf[0].y, z: buf[0].z, yaw: buf[0].yaw, vy: 0 };
  const last = buf[n - 1];
  if (renderT >= last.t) return { x: last.x, y: last.y, z: last.z, yaw: last.yaw, vy: 0 };
  // Binary search: a = last sample with t <= renderT, b = the one after.
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (buf[mid].t <= renderT) lo = mid; else hi = mid - 1;
  }
  const A = buf[lo], B = buf[lo + 1];
  const span = B.t - A.t;
  if (span > gapCapMs || span <= 1) {
    return { x: A.x, y: A.y, z: A.z, yaw: A.yaw, vy: 0 };
  }
  const dx = B.x - A.x, dy = B.y - A.y, dz = B.z - A.z;
  if (dx * dx + dy * dy + dz * dz > teleportStuds * teleportStuds) {
    return { x: A.x, y: A.y, z: A.z, yaw: A.yaw, vy: 0 };
  }
  const alpha = (renderT - A.t) / span;
  return {
    x: A.x + dx * alpha,
    y: A.y + dy * alpha,
    z: A.z + dz * alpha,
    yaw: A.yaw + shortestAngle(B.yaw - A.yaw) * alpha,
    vy: dy / (span / 1000),
  };
}

/** Timestamped history of the LOCAL player's snapshots (v6.2.5: the
 * server-driven character renders from this). Same fields as the latest
 * SelfCorrection plus the arrival clock. */
export interface SelfHistoryEntry extends InterpSample {
  hp: number;
  dying: boolean;
  anim?: { walking?: boolean; jumping?: boolean; sprint?: boolean };
  seq: number;
}

/** Authoritative transform for one world part. */
export interface PartCorrection {
  id: string;
  x: number;
  y: number;
  z: number;
  rx: number;
  ry: number;
  rz: number;
}

type InputSender = (input: NetcodeInput) => void;
type ClickSender = (partId: string) => void;

let clickSender: ClickSender | null = null;

/** Installed by GamePlayer: routes on_click rule requests to the authority. */
export function setClickSender(sender: ClickSender | null): void {
  clickSender = sender;
}

/** A player clicked a part - the server's rules engine decides what happens. */
export function reportClick(partId: string): void {
  if (clickSender) clickSender(partId);
}

// ─── The bridge singleton (plain module state - one game at a time) ───

let inputSender: InputSender | null = null;
let lastInputSentAt = 0;
const pendingJump = { value: false };

let selfCorrection: SelfCorrection | null = null;
let selfHistory: SelfHistoryEntry[] = [];
let partCorrections: PartCorrection[] = [];
let fxQueue: Array<{ name: string; volume: number }> = [];
// v6.2.3: ms timestamp of the LAST game:state snapshot (any content). The
// server re-broadcasts everyone as a keyframe at least every 2s while a
// single player is in the instance, so a fresh stamp = the authority is
// alive. The play viewport uses this to decide between server-driven
// rendering (authority alive) and local prediction (boot grace, relay-only
// legacy instances, or the authority died mid-session).
let lastSnapshotAt = 0;

/** How long ago the last server snapshot arrived (ms). Infinity = never. */
export function serverSnapshotAgeMs(): number {
  if (lastSnapshotAt === 0) return Infinity;
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return now - lastSnapshotAt;
}

/** Installed by GamePlayer while a server-hosted session is live. */
export function setInputSender(sender: InputSender | null): void {
  inputSender = sender;
}

/**
 * Called by the play viewport every frame. Steady state is throttled to
 * CLIENT_INPUT_HZ, but a JUMP PRESS, a DIRECTION CHANGE or a SPRINT FLIP
 * flushes on the very frame it happens - the server starts reacting to
 * your keys at network speed, not one throttle period later. Jump edges
 * are sticky (always delivered on the next send).
 */
const lastSentInput = { x: 0, z: 0, sprint: false };
export function reportInput(input: Omit<NetcodeInput, 'jump'> & { jump?: boolean }): void {
  if (input.jump) pendingJump.value = true;
  if (!inputSender) return;
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const dirChanged =
    (input.x - lastSentInput.x) * (input.x - lastSentInput.x) +
    (input.z - lastSentInput.z) * (input.z - lastSentInput.z) > 0.0025;
  const stateChanged = dirChanged || input.sprint !== lastSentInput.sprint;
  if (!pendingJump.value && !stateChanged && now - lastInputSentAt < 1000 / CLIENT_INPUT_HZ - 1) return;
  lastInputSentAt = now;
  lastSentInput.x = input.x;
  lastSentInput.z = input.z;
  lastSentInput.sprint = input.sprint;
  inputSender({ ...input, jump: pendingJump.value });
  pendingJump.value = false;
}

/** Latest authoritative state for the local player (null in singleplayer). */
export function getSelfCorrection(): SelfCorrection | null {
  return selfCorrection;
}

/** v6.2.5: the timestamped snapshot history for YOUR character (what the
 * server-driven renderer samples at now - SELF_INTERP_DELAY_MS). */
export function getSelfHistory(): SelfHistoryEntry[] {
  return selfHistory;
}

/** Drop the interpolation history (respawn/teleport: never glide from the
 * old position to the new one). */
export function clearSelfHistory(): void {
  selfHistory = [];
}

/** Queue of authoritative part transforms not yet applied by the local sim. */
export function drainPartCorrections(): PartCorrection[] {
  if (partCorrections.length === 0) return [];
  const out = partCorrections;
  partCorrections = [];
  return out;
}

/** Drain queued sound cues the server relayed (played locally). */
export function drainFx(): Array<{ name: string; volume: number }> {
  if (fxQueue.length === 0) return [];
  const out = fxQueue;
  fxQueue = [];
  return out;
}

/** Called by GamePlayer on every server snapshot. */
export function pushSnapshot(data: {
  self?: { socketId: string; x: number; y: number; z: number; yaw: number; hp: number; dying: boolean; seq: number; anim?: { walking?: boolean; jumping?: boolean; sprint?: boolean } };
  parts?: PartCorrection[];
  fx?: Array<{ name: string; volume: number }>;
}): void {
  lastSnapshotAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (data.self) {
    selfCorrection = { ...data.self, receivedAt: lastSnapshotAt };
    // v6.2.5: append to the interpolation history. A gap larger than the
    // cap means the stream went idle (delta snapshots skip unchanged
    // players) or a packet hole - the stale samples are dropped so the
    // renderer picks up the FRESH position immediately instead of slowly
    // creeping between two distant points.
    if (
      selfHistory.length > 0 &&
      lastSnapshotAt - selfHistory[selfHistory.length - 1].t > INTERP_GAP_CAP_MS
    ) {
      selfHistory = [];
    }
    selfHistory.push({
      t: lastSnapshotAt,
      x: selfCorrection.x,
      y: selfCorrection.y,
      z: selfCorrection.z,
      yaw: selfCorrection.yaw,
      hp: selfCorrection.hp,
      dying: selfCorrection.dying,
      anim: selfCorrection.anim,
      seq: selfCorrection.seq,
    });
    if (selfHistory.length > 48) selfHistory.splice(0, selfHistory.length - 48);
  }
  if (data.parts && data.parts.length > 0) {
    // Cap the queue: if the local sim stalled (tab hidden), drop the oldest.
    partCorrections.push(...data.parts);
    if (partCorrections.length > 6000) {
      partCorrections = partCorrections.slice(-3000);
    }
  }
  if (data.fx && data.fx.length > 0) fxQueue.push(...data.fx);
}

/** Reset everything (session start/end). */
export function resetNetcodeBridge(): void {
  inputSender = null;
  selfCorrection = null;
  selfHistory = [];
  partCorrections = [];
  fxQueue = [];
  pendingJump.value = false;
  lastInputSentAt = 0;
  lastSentInput.x = 0;
  lastSentInput.z = 0;
  lastSentInput.sprint = false;
  lastSnapshotAt = 0;
}

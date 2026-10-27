// ═══════════════════════════════════════════════════════════════════
// WeildBuild — netcode bridge (v1.3, client side)
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
//     GamePlayer ("game:state") → selfHistory (timestamped samples for
//     the death/respawn/hp events) + partHistories (timestamped samples
//     per part). v6.2.7: parts are NO LONGER corrected onto a local
//     simulation - the client does not simulate physical objects in
//     multiplayer at all. Every unanchored part renders from its
//     timestamped interpolation buffer (samplePartInterp below), exactly
//     like every remote character, and its kinematic collider follows the
//     same sample - what you see is what you stand on.
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
/** v6.2.7: physical objects render this far behind arrival time (ms) -
 * the same buffered-interpolation contract as the characters. Parts are
 * usually what you stand on, so they ride the shorter self-class delay
 * rather than the remote one: less visible lag between your (locally
 * simulated) character and the plank it lands on. */
export const PART_INTERP_DELAY_MS = 100;
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

/** v6.2.7: one timestamped part sample (arrival-clock ms + transform). */
export interface PartSample extends PartCorrection {
  t: number;
}

/** The result of sampling a part interpolation buffer at a render time. */
export interface PartInterpResult {
  x: number; y: number; z: number;
  rx: number; ry: number; rz: number;
  /** Implied velocity across the interpolated pair (studs/s, deg/s). */
  vx: number; vy: number; vz: number;
}

/** Shortest signed delta between two angles expressed in DEGREES
 * (rotation samples are 0..360; a plain lerp would spin the long way
 * around across the 359 -> 0 boundary). */
function shortestDeg(diff: number): number {
  return ((diff + 180) % 360 + 360) % 360 - 180;
}

/**
 * v6.2.7: sample a part's timestamped interpolation buffer at
 * `renderT` (arrival-clock ms). Same contract as sampleInterp for
 * characters: linear between two samples closer than `gapCapMs` and
 * nearer than `teleportStuds` (rotation lerps through the shortest arc
 * per axis); across a hole or a teleport the EARLIER sample is held and
 * the snap happens when the clock reaches the newer one. Velocity is
 * implied by the pair being interpolated. Returns null for an empty
 * buffer.
 */
export function samplePartInterp(
  buf: PartSample[],
  renderT: number,
  gapCapMs: number = INTERP_GAP_CAP_MS,
  teleportStuds: number = INTERP_TELEPORT_STUDS,
): PartInterpResult | null {
  const n = buf.length;
  if (n === 0) return null;
  if (n === 1 || renderT <= buf[0].t) {
    const a = buf[0];
    return { x: a.x, y: a.y, z: a.z, rx: a.rx, ry: a.ry, rz: a.rz, vx: 0, vy: 0, vz: 0 };
  }
  const last = buf[n - 1];
  if (renderT >= last.t) {
    return { x: last.x, y: last.y, z: last.z, rx: last.rx, ry: last.ry, rz: last.rz, vx: 0, vy: 0, vz: 0 };
  }
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (buf[mid].t <= renderT) lo = mid; else hi = mid - 1;
  }
  const A = buf[lo], B = buf[lo + 1];
  const span = B.t - A.t;
  if (span > gapCapMs || span <= 1) {
    return { x: A.x, y: A.y, z: A.z, rx: A.rx, ry: A.ry, rz: A.rz, vx: 0, vy: 0, vz: 0 };
  }
  const dx = B.x - A.x, dy = B.y - A.y, dz = B.z - A.z;
  if (dx * dx + dy * dy + dz * dz > teleportStuds * teleportStuds) {
    return { x: A.x, y: A.y, z: A.z, rx: A.rx, ry: A.ry, rz: A.rz, vx: 0, vy: 0, vz: 0 };
  }
  const alpha = (renderT - A.t) / span;
  const secs = span / 1000;
  return {
    x: A.x + dx * alpha,
    y: A.y + dy * alpha,
    z: A.z + dz * alpha,
    rx: A.rx + shortestDeg(B.rx - A.rx) * alpha,
    ry: A.ry + shortestDeg(B.ry - A.ry) * alpha,
    rz: A.rz + shortestDeg(B.rz - A.rz) * alpha,
    vx: dx / secs,
    vy: dy / secs,
    vz: dz / secs,
  };
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
// v6.2.7: timestamped interpolation history per part id. This replaces
// the old correction queue: parts are rendered (and collimated) from the
// interpolated stream instead of being nudged onto a local simulation.
let partHistories: Map<string, PartSample[]> = new Map();
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

/** v6.2.7: the timestamped snapshot history per part (what the play
 * viewport samples at now - PART_INTERP_DELAY_MS to render AND collide
 * physical objects). */
export function getPartHistories(): Map<string, PartSample[]> {
  return partHistories;
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
  /** v6.2.7: part ids the authority deleted (void falls, rule
   * destroy_part, ...) - their histories die here and GamePlayer removes
   * them from the store, so nothing lingers or freezes mid-air. */
  removed?: string[];
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
    // v6.2.7: append to the part's interpolation history. A gap larger
    // than the cap means the delta stream went idle for this part (it
    // settled) or the part left everyone's interest radius - the stale
    // samples are dropped so the next live sample lands FRESH instead of
    // slowly creeping between two distant positions.
    for (const p of data.parts) {
      let hist = partHistories.get(p.id);
      if (!hist) {
        hist = [];
        partHistories.set(p.id, hist);
      } else if (lastSnapshotAt - hist[hist.length - 1].t > INTERP_GAP_CAP_MS) {
        hist.length = 0;
      }
      hist.push({ ...p, t: lastSnapshotAt });
      // 24 samples = 800 ms of 30 Hz stream - far beyond the render
      // delay; enough margin for a packet hole, cheap to scan.
      if (hist.length > 24) hist.splice(0, hist.length - 24);
    }
    // Memory cap for huge worlds (stale ids cost memory, not CPU - the
    // driver skips bodies that no longer exist).
    if (partHistories.size > 8192) {
      const entries = Array.from(partHistories.entries());
      entries.sort((a, b) => a[1][a[1].length - 1].t - b[1][b[1].length - 1].t);
      for (let i = 0; i < 2048; i++) partHistories.delete(entries[i][0]);
    }
  }
  if (data.removed && data.removed.length > 0) {
    for (const id of data.removed) partHistories.delete(id);
  }
  if (data.fx && data.fx.length > 0) fxQueue.push(...data.fx);
}

/** Reset everything (session start/end). */
export function resetNetcodeBridge(): void {
  inputSender = null;
  selfCorrection = null;
  selfHistory = [];
  partHistories = new Map();
  fxQueue = [];
  pendingJump.value = false;
  lastInputSentAt = 0;
  lastSentInput.x = 0;
  lastSentInput.z = 0;
  lastSentInput.sprint = false;
  lastSnapshotAt = 0;
}

// ═══════════════════════════════════════════════════════════════════
// WeildBuild — netcode bridge (v1.3, client side)
// ═══════════════════════════════════════════════════════════════════
// The channel between the GamePlayer's Socket.IO connection and the
// play viewport's frame loop, for ROBLOX-STYLE multiplayer (v6.2.6):
//
//   STATE FLOW (client → server, 4 Hz):
//     GamePlayerCharacter → reportPlayerState() → the sender GamePlayer
//     installed → socket.emit("game:pstate", ...). Each client SIMULATES
//     ITS OWN character locally (the full singleplayer feel - instant
//     input, local walls, local jumps) and reports position/yaw/anim to
//     the authority every 0.25 s (PLAYER_REPORT_HZ). The server applies
//     light checks (PLAYER_LIGHT_CHECK_STUDS), keeps the last accepted
//     report as that player's position, and relays it to everyone else.
//
//   STATE FLOW (server → client, 30 Hz delta snapshots):
//     • OTHER players: timestamped samples → buffered interpolation at
//       REMOTE_INTERP_DELAY_MS (smooth even when someone lags - the
//       samples are dense relative to the 0.25 s report cadence).
//     • YOUR OWN entry: the authority does NOT drive your movement (you
//       are the simulation). It only contributes what it alone can know:
//       hp, the dying flag (rules + void deaths + the respawn timer) and
//       one-shot `tp` forced positions (spawn slot, respawn, teleport
//       rules) that teleport the local body.
//     • PARTS: the authority simulates every part; corrections stream to
//       the local proxies (see Viewport3D - no local part simulation).
//
// Singleplayer / Test Play never touches this module (netcode.mode stays
// 'local' and every field stays null/empty).

import { PLAYER_REPORT_HZ, PLAYER_KEEPALIVE_HZ } from './game-engine/character-constants';

/** One state report the owning client sends about ITS OWN character. */
export interface PlayerStateReport {
  /** Feet position (the visible body root). */
  x: number;
  y: number;
  z: number;
  /** Body yaw (radians). */
  yaw: number;
  /** Anim flags (the jump flag must come from a latch - see
   * createJumpLatch in character-constants - so remote viewers see
   * exactly one jump rising edge per hop). */
  walking: boolean;
  jumping: boolean;
  sprint: boolean;
}

/** Authority-owned state for the LOCAL player inside a snapshot.
 * v6.2.6: position is NOT here anymore - the client IS the simulation of
 * its own character; the server only owns the life state. */
export interface SelfCorrection {
  seq: number;
  /** Body yaw (radians) - informational echo of the last accepted report. */
  yaw: number;
  /** Authoritative health (server-owned in multiplayer). */
  hp: number;
  /** True during the server-side death animation. */
  dying: boolean;
  /** A forced position (spawn slot / respawn / teleport rule): teleport
   * the local body here on the seq it arrives. */
  tp?: { x: number; y: number; z: number };
  /** performance.now() ms when this correction arrived. */
  receivedAt: number;
}

// ─── v6.2.5 + v6.2.6: entity interpolation (REMOTE players) ───
// Remote characters render from a TIMESTAMPED buffer of the 4 Hz report
// relay, sampled at a fixed delay behind arrival time. The delay must
// cover the 250 ms report period plus arrival jitter, so the render clock
// always sits between two live samples - "if someone lags it's still
// smooth" (the user's plan). 300 ms = 250 + 50 jitter budget.
export const REMOTE_INTERP_DELAY_MS = 300;
/** Consecutive samples farther apart than this are NOT interpolated
 * across (a delta-stream gap - an idle player simply stops being
 * broadcast until the 2 s keyframe - must not become a slow creep
 * between two distant positions): the earlier sample is held, and the
 * buffer is trimmed on the next push. 500 ms = two missed report
 * periods; a standing player holds still, a moving one interpolates. */
export const INTERP_GAP_CAP_MS = 500;
/** A pair of samples this far apart (studs) is a teleport/respawn: hold
 * the old position, then snap exactly when the render clock reaches the
 * new sample - never streak across the map. (Server-forced positions
 * arrive flagged `tp` and also clear the buffer immediately.) */
export const INTERP_TELEPORT_STUDS = 20;

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

type StateSender = (report: PlayerStateReport) => void;
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

let stateSender: StateSender | null = null;
let lastReportSentAt = 0;
// v1.3: the last report actually sent (for the send-on-change detection
// in reportPlayerState).
let lastSentReport: PlayerStateReport | null = null;

let selfCorrection: SelfCorrection | null = null;
let partCorrections: PartCorrection[] = [];
let fxQueue: Array<{ name: string; volume: number }> = [];
// v6.2.3: ms timestamp of the LAST game:state snapshot (any content). The
// server re-broadcasts everyone as a keyframe at least every 2s while a
// single player is in the instance, so a fresh stamp = the authority is
// alive. The play viewport uses this to decide whether the server still
// owns the life state (death/respawn/hp/teleports) or the local fallback
// should take over (relay-only legacy instances, boot grace, the
// authority died mid-session - the character keeps playing either way,
// only the life-state ownership changes).
let lastSnapshotAt = 0;

/** How long ago the last server snapshot arrived (ms). Infinity = never. */
export function serverSnapshotAgeMs(): number {
  if (lastSnapshotAt === 0) return Infinity;
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return now - lastSnapshotAt;
}

/** Installed by GamePlayer while a server-hosted session is live. */
export function setStateSender(sender: StateSender | null): void {
  stateSender = sender;
}

/**
 * v6.2.6: called by the play viewport every frame - throttled to
 * PLAYER_REPORT_HZ. v1.3 (user request): the upload now fires AS SOON AS
 * the player's position/rotation/anim state changes (capped at one report
 * per 1/PLAYER_REPORT_HZ = 0.05 s), with a slow PLAYER_KEEPALIVE_HZ
 * keepalive when standing perfectly still, instead of the old flat 4 Hz
 * timer. The local character IS the simulation; this just tells the server
 * where it is so it can relay it (and run its light checks).
 */
export function reportPlayerState(report: PlayerStateReport): void {
  if (!stateSender) return;
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  // lastReportSentAt === 0 means "never sent" (performance.now() can be
  // small early in a process - 0 must not look like a fresh send).
  if (lastReportSentAt !== 0) {
    const sinceLast = now - lastReportSentAt;
    if (sinceLast < 1000 / PLAYER_REPORT_HZ - 2) return; // over the 20 Hz cap
    // Has anything changed since the last sent report? If not, only send
    // the slow keepalive.
    const changed =
      !lastSentReport ||
      Math.abs(report.x - lastSentReport.x) > 0.01 ||
      Math.abs(report.y - lastSentReport.y) > 0.01 ||
      Math.abs(report.z - lastSentReport.z) > 0.01 ||
      Math.abs(report.yaw - lastSentReport.yaw) > 0.5 ||
      report.walking !== lastSentReport.walking ||
      report.jumping !== lastSentReport.jumping ||
      report.sprint !== lastSentReport.sprint;
    if (!changed && sinceLast < 1000 / PLAYER_KEEPALIVE_HZ - 2) return;
  }
  lastReportSentAt = now;
  lastSentReport = { ...report };
  stateSender(report);
}

/** Latest authority-owned state for the local player (null in singleplayer). */
export function getSelfCorrection(): SelfCorrection | null {
  return selfCorrection;
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
  self?: { socketId: string; x?: number; y?: number; z?: number; yaw: number; hp: number; dying: boolean; seq: number; tp?: number[] | { x: number; y: number; z: number } };
  parts?: PartCorrection[];
  fx?: Array<{ name: string; volume: number }>;
}): void {
  lastSnapshotAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (data.self) {
    const s = data.self;
    // v6.2.6: the tp may arrive as [x,y,z] (wire) or an object (tests).
    let tp: { x: number; y: number; z: number } | undefined;
    if (Array.isArray(s.tp) && s.tp.length >= 3) {
      tp = { x: Number(s.tp[0]) || 0, y: Number(s.tp[1]) || 0, z: Number(s.tp[2]) || 0 };
    } else if (s.tp && typeof s.tp === 'object') {
      const o = s.tp as { x: number; y: number; z: number };
      tp = { x: Number(o.x) || 0, y: Number(o.y) || 0, z: Number(o.z) || 0 };
    }
    selfCorrection = {
      seq: s.seq,
      yaw: s.yaw,
      hp: s.hp,
      dying: s.dying,
      tp,
      receivedAt: lastSnapshotAt,
    };
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
  stateSender = null;
  selfCorrection = null;
  partCorrections = [];
  fxQueue = [];
  lastReportSentAt = 0;
  lastSnapshotAt = 0;
}

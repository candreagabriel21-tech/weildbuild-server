// ═══════════════════════════════════════════════════════════════════
// WeildBuild — netcode bridge (v6.4 CSP, client side)
// ═══════════════════════════════════════════════════════════════════
// The channel between the GamePlayer's Socket.IO connection and the
// play viewport's frame loop, for CLIENT-SIDE PREDICTION with a
// SERVER-AUTHORITATIVE player simulation:
//
//   INPUT FLOW (client -> server, ~20 Hz):
//     StudioPlayViewport reads the keyboard/joystick -> calls
//     reportPlayerInput({x, z, jump, sprint, yaw}). The bridge throttles
//     to PLAYER_REPORT_HZ, assigns an incrementing `seq`, and emits
//     "game:input" through the state sender. The server integrates this
//     against the DYNAMIC cannon body (the authority).
//
//   PREDICTION (local):
//     The viewport runs the SAME movement math (character-constants.ts)
//     against its own local body. Input is INSTANT (0 ms latency). The
//     viewport records each prediction (seq -> pos, vel) into a ring
//     buffer so it can be compared against the authority later.
//
//   RECONCILIATION (server -> client, 30 Hz delta snapshots):
//     • OTHER players: timestamped samples -> buffered interpolation at
//       REMOTE_INTERP_DELAY_MS (smooth even when someone lags).
//     • YOUR OWN entry: the server's authoritative position + `ackSeq`
//       (the last input seq the server has applied). reconcileSelf()
//       finds the prediction at ackSeq, computes the divergence, and
//       returns one of:
//         - null: divergence tiny (<= RECONCILE_IGNORE_STUDS). Ignore.
//         - { kind: 'drift', offset, dist, ackSeq }: small divergence
//           (0.75 < dist <= 3.0). Apply gradually over many frames
//           (15% per frame, smoothed away invisibly over ~10-20 frames).
//         - { kind: 'snap', offset, dist, ackSeq }: large divergence
//           (> 3.0 studs). Hard snap (teleport + zero velocity) - the
//           rule teleport or kill-brick respawn.
//     • PARTS: the authority simulates every part; corrections stream to
//       the local proxies.
//
// Singleplayer / Test Play never touches this module (netcode.mode stays
// 'local' and every field stays null/empty).

import { PLAYER_REPORT_HZ, PLAYER_KEEPALIVE_HZ } from './game-engine/character-constants';

/** v6.4 CSP: one INPUT report the owning client sends about ITS OWN
 * controls. The direction (x,z) is camera-relative and unit length (or
 * zero). The server integrates this against the dynamic body using the
 * same math the local prediction runs. */
export interface PlayerInputReport {
  /** The bridge-assigned sequence number (incrementing per sent report).
   * The server echoes the latest applied one back as `ackSeq` so the
   * client can find the matching prediction. */
  seq: number;
  /** Camera-relative walk direction (unit length or 0,0). */
  x: number;
  z: number;
  /** True on the frame the jump key went down (edge-triggered). */
  jump: boolean;
  /** True while the sprint modifier is held. */
  sprint: boolean;
  /** Body yaw (radians) - the latest reported camera/look yaw. */
  yaw: number;
}

/** Authority-owned state for the LOCAL player inside a snapshot.
 * v6.4 CSP: position + ackSeq ARE used to drive reconciliation. When the
 * server's authoritative position diverges from the client's prediction
 * (at the server's last applied input seq), the viewport applies a
 * GRADUAL correction (drift path) or a hard snap. */
export interface SelfCorrection {
  seq: number;
  /** v6.4 CSP: the last input seq the server has applied. The viewport
   * looks up its prediction at this seq to compute the divergence. */
  ackSeq: number;
  /** Body yaw (radians) - the authority's record of our facing. */
  yaw: number;
  /** The authority's record of our position (feet). */
  x: number;
  y: number;
  z: number;
  /** v6.4.1: the authority's record of our body velocity. The viewport
   * gently lerps the local body's velocity toward this every frame
   * (15% per frame). This is the key fix for the "edge falling" +
   * "sprint freaking out" issues: when the server sees the player
   * falling but the client doesn't (tick quantization + interpolation
   * delay), the velocity sync closes the gap BEFORE the position
   * diverges past the snap threshold. */
  vx: number;
  vy: number;
  vz: number;
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

/** A prediction sample (the local body's state right after sending input
 * seq N). Used by reconcileSelf to compute divergence at the server's
 * ackSeq. */
export interface PredictionSample {
  seq: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** performance.now() ms when this sample was recorded. */
  t: number;
}

/** The result of reconcileSelf: how the viewport should react to the
 * authority's record at ackSeq. */
export type ReconcileResult =
  | { kind: 'drift'; offset: [number, number, number]; dist: number; ackSeq: number }
  | { kind: 'snap'; offset: [number, number, number]; dist: number; ackSeq: number };

/** Divergence at or below this many studs is ignored entirely. Set to
 * 5.0 to cover the sprint case (sprint speed 18.36 studs/s; a 100ms
 * snapshot delay produces ~1.8 studs of divergence during the
 * acceleration ramp, which can briefly exceed 3.0). 5.0 is still well
 * below rule teleports (10+ studs) so real mispredictions still snap.
 * Combined with velocity sync (the body lerps toward the server's vy
 * every frame), the prediction diverges far less than before, so 5.0
 * is a generous safety margin that absorbs ALL normal movement noise
 * (walking, sprinting, jumping, falling, edge cases). */
export const RECONCILE_IGNORE_STUDS = 5.0;
/** Divergence above this triggers a HARD snap (teleport body + zero
 * velocity). Set equal to RECONCILE_IGNORE_STUDS so there is no "drift"
 * zone in between - the prediction either matches closely enough to
 * ignore, or it's a real misprediction that needs a hard snap. */
export const RECONCILE_SNAP_STUDS = 5.0;

// ─── v6.2.5 + v6.2.6: entity interpolation (REMOTE players) ───
// Remote characters render from a TIMESTAMPED buffer of the 30 Hz relay,
// sampled at a fixed delay behind arrival time. The delay must cover the
// ~33 ms snapshot period plus arrival jitter, so the render clock always
// sits between two live samples - "if someone lags it's still smooth"
// (the user's plan). 100 ms = 33 ms + 67 ms jitter budget for the
// denser 30 Hz stream the server emits under CSP.
export const REMOTE_INTERP_DELAY_MS = 100;
/** Consecutive samples farther apart than this are NOT interpolated
 * across (a delta-stream gap - an idle player simply stops being
 * broadcast until the 2 s keyframe - must not become a slow creep
 * between two distant positions): the earlier sample is held, and the
 * buffer is trimmed on the next push. 500 ms = a long idle gap; a
 * standing player holds still, a moving one interpolates. */
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

type InputSender = (report: PlayerInputReport) => void;
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
let lastReportSentAt = 0;
// v6.4 CSP: the per-session incrementing input seq counter. The server
// echoes the latest applied one back as `ackSeq` in every snapshot.
let inputSeqCounter = 0;
// v1.3: the last report actually sent (for the send-on-change detection
// in reportPlayerInput).
let lastSentReport: Omit<PlayerInputReport, 'seq'> | null = null;

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

// v6.4 CSP: the prediction ring buffer. Each entry is the local body's
// state right AFTER sending input seq N. reconcileSelf finds the entry
// with seq <= ackSeq and computes the divergence. Capped at 240 entries
// (= 12 s at 20 Hz - any older prediction is long since irrelevant).
const PREDICTION_HISTORY_CAP = 240;
let predictionHistory: PredictionSample[] = [];
let lastReconcile: { kind: 'drift' | 'snap'; dist: number; ackSeq: number; at: number } | null = null;

/** How long ago the last server snapshot arrived (ms). Infinity = never. */
export function serverSnapshotAgeMs(): number {
  if (lastSnapshotAt === 0) return Infinity;
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return now - lastSnapshotAt;
}

/** Installed by GamePlayer while a server-hosted session is live. */
export function setStateSender(sender: InputSender | null): void {
  inputSender = sender;
}

/**
 * v6.4 CSP: called by the play viewport every frame - throttled to
 * PLAYER_REPORT_HZ. Sends the INPUT state (the desired movement, NOT the
 * body's position). v1.3 (user request): the upload now fires AS SOON AS
 * the player's input changes (capped at one report per 1/PLAYER_REPORT_HZ
 * = 0.05 s), with a slow PLAYER_KEEPALIVE_HZ keepalive when standing
 * perfectly still. The local character predicts instantly off this same
 * input; the server integrates the same against its authoritative body.
 */
export function reportPlayerInput(report: Omit<PlayerInputReport, 'seq'>): void {
  if (!inputSender) return;
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
      Math.abs(report.z - lastSentReport.z) > 0.01 ||
      report.jump !== lastSentReport.jump ||
      report.sprint !== lastSentReport.sprint ||
      Math.abs(report.yaw - lastSentReport.yaw) > 0.5;
    if (!changed && sinceLast < 1000 / PLAYER_KEEPALIVE_HZ - 2) return;
  }
  lastReportSentAt = now;
  lastSentReport = { ...report };
  inputSeqCounter += 1;
  inputSender({ seq: inputSeqCounter, ...report });
}

/** The seq of the last input the bridge sent (0 before the first send). */
export function getLastInputSeq(): number {
  return inputSeqCounter;
}

/**
 * v6.4 CSP: record a prediction sample. The viewport calls this every
 * frame after stepping the local body. v6.4.1 FIX: we keep only the
 * FIRST prediction per seq (the one recorded right after the input
 * was first applied). This is critical because the server processes
 * input seq N at the moment it ARRIVES (about RTT/2 after the client
 * sent it), which corresponds to the client's FIRST prediction with
 * that seq - NOT the latest one. Keeping only the first means the
 * reconcile compares the right prediction against the server's state.
 *
 * Before this fix, we kept every frame's prediction (multiple per seq
 * since inputs are sent at 20Hz but predictions recorded at 60Hz), and
 * reconcileSelf picked the latest with seq <= ackSeq - which was a
 * FUTURE prediction (the body had already moved several frames past
 * the input application point). That caused the comparison to always
 * show the client "ahead" of the server, triggering false snaps.
 *
 * The history is capped; older entries are dropped.
 */
export function recordPrediction(
  seq: number,
  pos: [number, number, number],
  vel: [number, number, number],
): void {
  if (seq <= 0) return; // before the first input - nothing to reconcile against
  // v6.4.1: skip if we already have a prediction for this seq - keep
  // the FIRST one (the one right after the input was applied).
  if (predictionHistory.length > 0 && predictionHistory[predictionHistory.length - 1].seq === seq) {
    return;
  }
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  predictionHistory.push({ seq, x: pos[0], y: pos[1], z: pos[2], vx: vel[0], vy: vel[1], vz: vel[2], t: now });
  if (predictionHistory.length > PREDICTION_HISTORY_CAP) {
    predictionHistory.splice(0, predictionHistory.length - PREDICTION_HISTORY_CAP);
  }
}

/**
 * v6.4 CSP: reconcile the local prediction at the server's last applied
 * input seq (`ackSeq`) against the authority's position. Returns:
 *   - null: divergence <= RECONCILE_IGNORE_STUDS (ignore - it is inside
 *     the tick-quantization + solver-drift noise floor).
 *   - { kind: 'drift', offset, dist, ackSeq }: small divergence (up to
 *     RECONCILE_SNAP_STUDS) - the viewport applies the offset GRADUALLY
 *     over many frames (15% per frame, smoothed away invisibly).
 *   - { kind: 'snap', offset, dist, ackSeq }: large divergence - hard
 *     snap (teleport + zero velocity). Rule teleports, kill-brick
 *     respawns, and the first spawn-slot tp land here.
 * The offset is `serverPos - predictedPos` at the time of ackSeq.
 */
export function reconcileSelf(ackSeq: number, serverPos: [number, number, number]): ReconcileResult | null {
  if (ackSeq <= 0) return null;
  // Find the prediction at the server's ackSeq. The history is in
  // ascending seq order; pick the entry with the largest seq <= ackSeq
  // (the prediction that was active when the server applied ackSeq).
  let pred: PredictionSample | null = null;
  for (let i = predictionHistory.length - 1; i >= 0; i--) {
    if (predictionHistory[i].seq <= ackSeq) { pred = predictionHistory[i]; break; }
  }
  if (!pred) return null; // no matching prediction - history already trimmed
  const dx = serverPos[0] - pred.x;
  const dy = serverPos[1] - pred.y;
  const dz = serverPos[2] - pred.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  lastReconcile = { kind: dist > RECONCILE_SNAP_STUDS ? 'snap' : 'drift', dist, ackSeq, at: typeof performance !== 'undefined' ? performance.now() : Date.now() };
  if (dist <= RECONCILE_IGNORE_STUDS) return null;
  // Hard snap: teleport the body to the server's authoritative position.
  // With RECONCILE_IGNORE_STUDS == RECONCILE_SNAP_STUDS, there is no drift
  // zone - the prediction either matches closely enough to ignore, or it's
  // a real misprediction that needs a hard snap. This eliminates the
  // oscillation that the drift approach caused (the drift was recorded in
  // the prediction history, making each successive reconcile compute a
  // wrong offset).
  while (predictionHistory.length > 0 && predictionHistory[0].seq <= ackSeq) {
    predictionHistory.shift();
  }
  lastReconcile = { kind: 'snap', dist, ackSeq, at: typeof performance !== 'undefined' ? performance.now() : Date.now() };
  return { kind: 'snap', offset: [dx, dy, dz], dist, ackSeq };
}

/** The last reconcile result the bridge produced (diagnostics only). */
export function getLastReconcile(): { kind: 'drift' | 'snap'; dist: number; ackSeq: number; at: number } | null {
  return lastReconcile;
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
  self?: { socketId: string; ackSeq?: number; x?: number; y?: number; z?: number; vel?: number[]; yaw: number; hp: number; dying: boolean; seq: number; tp?: number[] | { x: number; y: number; z: number } };
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
    // v6.4.1: parse the velocity array (server sends [vx, vy, vz]).
    const vel = Array.isArray(s.vel) ? s.vel : [0, 0, 0];
    selfCorrection = {
      seq: s.seq,
      ackSeq: typeof s.ackSeq === 'number' ? s.ackSeq : 0,
      yaw: s.yaw,
      x: typeof s.x === 'number' ? s.x : 0,
      y: typeof s.y === 'number' ? s.y : 0,
      z: typeof s.z === 'number' ? s.z : 0,
      vx: Number(vel[0]) || 0,
      vy: Number(vel[1]) || 0,
      vz: Number(vel[2]) || 0,
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
  inputSender = null;
  selfCorrection = null;
  partCorrections = [];
  fxQueue = [];
  lastReportSentAt = 0;
  lastSnapshotAt = 0;
  inputSeqCounter = 0;
  lastSentReport = null;
  predictionHistory = [];
  lastReconcile = null;
}

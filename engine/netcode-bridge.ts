// ═══════════════════════════════════════════════════════════════════
// WeildBuild — netcode bridge (v6.4, client side, CSP)
// ═══════════════════════════════════════════════════════════════════
// The channel between the GamePlayer's Socket.IO connection and the
// play viewport's frame loop, for SERVER-AUTHORITATIVE multiplayer with
// CLIENT-SIDE PREDICTION (v6.4):
//
//   INPUT FLOW (client → server, ~20 Hz):
//     GamePlayerCharacter reads keys → reportPlayerInput({seq, x, z,
//     jump, sprint, yaw}) → the sender GamePlayer installed →
//     socket.emit("game:input", ...). Each client STILL simulates its
//     OWN character locally (instant input, the prediction layer); the
//     server runs the SAME math (character-constants.ts) authoritatively
//     and replies with the authoritative position + ackSeq.
//
//   STATE FLOW (server → client, 30 Hz delta snapshots):
//     • OTHER players: timestamped samples → buffered interpolation at
//       REMOTE_INTERP_DELAY_MS (smooth even when someone lags - the
//       samples are dense relative to the 0.25 s report cadence).
//     • YOUR OWN entry: the authority's record of your position + the
//       latest input seq it has processed (ackSeq). The viewport calls
//       reconcileSelf(ackSeq, serverPos) each frame - if the prediction
//       history at ackSeq matches the server, nothing happens (the
//       prediction was correct); if it differs by more than
//       RECONCILE_SNAP_STUDS, the local body snaps to the server
//       position (a rubberband - happens on rule teleports, kill-brick
//       respawns, physics solver divergence, or being pushed by a part).
//     • PARTS: the authority simulates every part; corrections stream to
//       the local proxies (see Viewport3D - no local part simulation).
//
// Singleplayer / Test Play never touches this module (netcode.mode stays
// 'local' and every field stays null/empty).

import { PLAYER_REPORT_HZ, PLAYER_KEEPALIVE_HZ } from './game-engine/character-constants';

// ─── v6.4 CSP: input sender + prediction history + reconciliation ───

/** One input report the owning client sends about ITS OWN character.
 * v6.4 replaces v6.2.6's PlayerStateReport (positions) with INPUTS.
 * The server simulates the character itself; the client predicts the
 * same math locally and reconciles when the server's authoritative
 * snapshot arrives. */
export interface PlayerInputReport {
  /** Monotonically increasing sequence number. The server echoes the
   * latest it has processed as `ackSeq` in each snapshot for this
   * player; the client uses it to find the matching prediction history
   * entry and reconcile. */
  seq: number;
  /** Camera-relative walk input (already normalized to unit length or 0). */
  x: number;
  z: number;
  /** Jump press this frame (consumed-and-dropped on the server either way). */
  jump: boolean;
  /** Sprint modifier (Shift held). */
  sprint: boolean;
  /** Body yaw (radians) - informational only (the server derives yaw from
   * movement direction). */
  yaw: number;
}

/** Authority-owned state for the LOCAL player inside a snapshot.
 * v6.4: position is the AUTHORITATIVE position (the server simulates the
 * body). The viewport calls reconcileSelf(ackSeq, x, y, z) when a fresh
 * entry arrives - if the prediction was wrong, the local body snaps. */
export interface SelfCorrection {
  /** Snapshot seq (dedup - only process when newer). */
  seq: number;
  /** v6.4: the latest input seq the server has PROCESSED. The client
   * uses this to find the matching entry in its prediction history and
   * reconcile. */
  ackSeq: number;
  /** The authority's record of our position (feet). */
  yaw: number;
  x: number;
  y: number;
  z: number;
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

// v6.2.5 + v6.2.6: entity interpolation (REMOTE players)
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

type StateSender = (report: PlayerInputReport) => void;
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
let lastSendAt = 0;
// v6.4: the last input actually sent (for the send-on-change detection
// in reportPlayerInput). Replaces v6.2.6's PlayerStateReport.
let lastSentInput: PlayerInputReport | null = null;
// v6.4: monotonically increasing input seq. Starts at 1 (0 is "no input
// received yet" on the server). Wraps only after ~2 billion frames at
// 60 Hz (~414 days of continuous play) so it is effectively infinite.
let inputSeq = 0;

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

// ─── v6.4 CSP: prediction history + reconciliation ──────────────────
//
// The client predicts its character's movement locally every render frame
// (the existing singleplayer physics loop). After each prediction step it
// records the predicted position + velocity indexed by the input seq used.
// When the server's snapshot arrives with ackSeq, the client finds the
// matching entry; if the positions differ by more than RECONCILE_SNAP_STUDS,
// the local body snaps to the server position (a rubberband - the visible
// cost of a misprediction, usually invisible because the math is identical).

/** Threshold (studs) below which a mismatch is silently ignored - the
 * prediction was close enough. Above this the local body snaps to the
 * server's authoritative position. 0.5 studs is roughly 3 server ticks
 * of motion at walk speed (5 studs/s) - enough to absorb tick-alignment
 * noise without rubberbanding on every snapshot. */
export const RECONCILE_SNAP_STUDS = 0.5;
/** The maximum number of prediction history entries we keep. One per
 * render frame at 60 Hz = 60/s, so 240 entries = 4 seconds of history.
 * The server's ack usually lags by ~RTT/2 (typically 50-150 ms); keeping
 * 4s gives plenty of headroom for lag spikes. */
const PREDICTION_HISTORY_MAX = 240;

interface PredictionEntry {
  seq: number;
  /** Predicted feet position AFTER applying this tick's input + physics step. */
  pos: [number, number, number];
  /** Predicted body velocity at the same point. */
  vel: [number, number, number];
}

const predictionHistory: PredictionEntry[] = [];
/** The most recent reconcile result (for diagnostics: tests + the
 * viewport's debug overlay). Null when no reconcile has fired yet. */
let lastReconcile: { ackSeq: number; dist: number; snapped: boolean; at: number } | null = null;

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
 * v6.4 CSP: called by the play viewport every frame - throttled to
 * PLAYER_REPORT_HZ (20 Hz, on change). Replaces v6.2.6's
 * reportPlayerState: instead of sending the OWN position, we send the
 * INPUTS that produced it. The server simulates the body itself; the
 * client predicts the same math and reconciles via reconcileSelf.
 *
 * The local character IS still the simulation; the inputs drive both
 * the prediction (instant) and the authority (eventually). The seq
 * increments on every SEND (not every frame), so multiple frames between
 * sends share the same seq - the prediction history records the LATEST
 * position for each seq (the one closest to what the server will compare
 * against).
 */
export function reportPlayerInput(report: Omit<PlayerInputReport, 'seq'>): void {
  if (!stateSender) return;
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  // lastSendAt === 0 means "never sent" (performance.now() can be
  // small early in a process - 0 must not look like a fresh send).
  if (lastSendAt !== 0) {
    const sinceLast = now - lastSendAt;
    if (sinceLast < 1000 / PLAYER_REPORT_HZ - 2) return; // over the 20 Hz cap
    // Has anything changed since the last sent input? If not, only send
    // the slow keepalive (so the server sees a live client + the
    // prediction history stays aligned).
    const changed =
      !lastSentInput ||
      Math.abs(report.x - lastSentInput.x) > 0.001 ||
      Math.abs(report.z - lastSentInput.z) > 0.001 ||
      report.jump !== lastSentInput.jump ||
      report.sprint !== lastSentInput.sprint ||
      Math.abs(report.yaw - lastSentInput.yaw) > 0.5;
    if (!changed && sinceLast < 1000 / PLAYER_KEEPALIVE_HZ - 2) return;
  }
  lastSendAt = now;
  inputSeq = (inputSeq + 1) >>> 0;
  const full: PlayerInputReport = { ...report, seq: inputSeq };
  lastSentInput = { ...full };
  stateSender(full);
}

/**
 * v6.4 CSP: record one prediction history entry. Called by the play
 * viewport every render frame AFTER the local prediction step (the body
 * has already moved). The seq is the LATEST sent input seq at this frame
 * (multiple frames between sends share a seq - we keep the latest).
 *
 * Storing the position lets the reconcile step find what the client
 * predicted at the time the server processed a given input. Storing the
 * velocity is a stretch goal (replay uses it) - we keep it for free
 * because the entry already exists.
 */
export function recordPrediction(seq: number, pos: [number, number, number], vel: [number, number, number]): void {
  if (predictionHistory.length === 0 || predictionHistory[predictionHistory.length - 1].seq !== seq) {
    predictionHistory.push({ seq, pos: [pos[0], pos[1], pos[2]], vel: [vel[0], vel[1], vel[2]] });
  } else {
    // Same seq as the last entry - update the position/velocity to the
    // latest prediction (so the reconcile step compares against the
    // freshest prediction for this input, not the oldest).
    const e = predictionHistory[predictionHistory.length - 1];
    e.pos[0] = pos[0]; e.pos[1] = pos[1]; e.pos[2] = pos[2];
    e.vel[0] = vel[0]; e.vel[1] = vel[1]; e.vel[2] = vel[2];
  }
  // Cap the history so a tab-hidden client doesn't grow it unbounded.
  if (predictionHistory.length > PREDICTION_HISTORY_MAX) {
    predictionHistory.splice(0, predictionHistory.length - PREDICTION_HISTORY_MAX);
  }
}

/**
 * v6.4 CSP: reconcile the client's prediction with the server's
 * authoritative state. Called by the play viewport when a fresh self
 * entry arrives (it reads from getSelfCorrection each frame).
 *
 * Returns the snap target (server's authoritative position + the seq
 * for diagnostics) when a misprediction exceeded RECONCILE_SNAP_STUDS,
 * or null when the prediction was correct (or the server's ack is older
 * than our oldest history entry - we can't compare, so we skip). The
 * viewport applies the snap by teleporting the local body; the next
 * prediction frame continues from there.
 *
 * Why no replay (re-running pending inputs from ackSeq+1 to current)?
 * The prediction math on the server is identical to the client (same
 * character-constants.ts), so when inputs match the positions match and
 * there is nothing to replay. When they DON'T match (server teleport,
 * physics solver divergence, a part pushed the player), the player's
 * INPUT state has not changed during the ~100 ms reconcile window - the
 * next prediction frame applies the same input from the corrected
 * position, which produces the right trajectory. A full replay would
 * only matter if the player's input changed during that window (a key
 * release between ackSeq and current); the next frame catches that up.
 */
export function reconcileSelf(ackSeq: number, serverPos: [number, number, number]): {
  snapped: boolean;
  dist: number;
  target: [number, number, number];
  ackSeq: number;
} | null {
  if (ackSeq <= 0) return null;
  // Find the prediction history entry whose seq === ackSeq (the latest
  // one with that seq - we update entries in place when the seq repeats).
  let entry: PredictionEntry | null = null;
  // Search from the end (most recent first) - the latest entry with
  // the matching seq is the one we want.
  for (let i = predictionHistory.length - 1; i >= 0; i--) {
    if (predictionHistory[i].seq === ackSeq) { entry = predictionHistory[i]; break; }
  }
  if (!entry) {
    // The server's ack is older than our oldest history entry (or we
    // never recorded one for that seq - happens when the tab was hidden
    // and the history was trimmed). We can't compare; skip this round.
    // The next snapshot with a newer ack will catch up.
    return null;
  }
  const dx = entry.pos[0] - serverPos[0];
  const dy = entry.pos[1] - serverPos[1];
  const dz = entry.pos[2] - serverPos[2];
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  // Drop history entries older than the ack (they're confirmed correct,
  // or about to be replaced by the snap). Keep entries > ackSeq so the
  // next reconcile can compare against them.
  while (predictionHistory.length > 0 && predictionHistory[0].seq <= ackSeq) {
    predictionHistory.shift();
  }
  if (dist <= RECONCILE_SNAP_STUDS) {
    // Prediction was correct (or close enough). No snap.
    lastReconcile = { ackSeq, dist, snapped: false, at: typeof performance !== 'undefined' ? performance.now() : Date.now() };
    return null;
  }
  // Misprediction! Snap the local body to the server's authoritative
  // position. The viewport applies this; the next prediction frame
  // continues from there.
  lastReconcile = { ackSeq, dist, snapped: true, at: typeof performance !== 'undefined' ? performance.now() : Date.now() };
  return { snapped: true, dist, target: [serverPos[0], serverPos[1], serverPos[2]], ackSeq };
}

/** The latest reconcile result (for diagnostics / tests). */
export function getLastReconcile(): typeof lastReconcile {
  return lastReconcile;
}

/** The latest input seq the client has sent (for tests + diagnostics). */
export function getLastInputSeq(): number {
  return inputSeq;
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
  self?: { socketId: string; x?: number; y?: number; z?: number; yaw: number; hp: number; dying: boolean; seq: number; ackSeq?: number; tp?: number[] | { x: number; y: number; z: number } };
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
      ackSeq: typeof s.ackSeq === 'number' ? s.ackSeq : 0,
      yaw: s.yaw,
      x: typeof s.x === 'number' ? s.x : 0,
      y: typeof s.y === 'number' ? s.y : 0,
      z: typeof s.z === 'number' ? s.z : 0,
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
  lastSendAt = 0;
  lastSentInput = null;
  inputSeq = 0;
  lastSnapshotAt = 0;
  predictionHistory.length = 0;
  lastReconcile = null;
}

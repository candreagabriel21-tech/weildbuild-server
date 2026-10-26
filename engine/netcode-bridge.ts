// ═══════════════════════════════════════════════════════════════════
// WeildBuild — netcode bridge (v1.1, client side)
// ═══════════════════════════════════════════════════════════════════
// The channel between the GamePlayer's Socket.IO connection and the
// play viewport's frame loop, for SERVER-AUTHORITATIVE multiplayer:
//
//   INPUT FLOW (client → server, ~20 Hz):
//     GamePlayerCharacter (prediction math) → reportInput() → the sender
//     GamePlayer installed → socket.emit("game:input", ...)
//
//   STATE FLOW (server → client, ~15 Hz snapshots):
//     GamePlayer ("game:state") → selfCorrection / partCorrections →
//     GamePlayerCharacter reconciles its predicted hitbox against
//     selfCorrection; PhysicsSimulation nudges local bodies toward
//     partCorrections. Prediction keeps rendering at 60 fps; the server
//     stays the single source of truth.
//
// Singleplayer / Test Play never touches this module (netcode.mode stays
// 'local' and every field stays null/empty).

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
let partCorrections: PartCorrection[] = [];
let fxQueue: Array<{ name: string; volume: number }> = [];

/** Installed by GamePlayer while a server-hosted session is live. */
export function setInputSender(sender: InputSender | null): void {
  inputSender = sender;
}

/**
 * Called by the prediction loop each frame. Throttled to CLIENT_INPUT_HZ;
 * jump edges are sticky (always delivered on the next send).
 */
export function reportInput(input: Omit<NetcodeInput, 'jump'> & { jump?: boolean }): void {
  if (input.jump) pendingJump.value = true;
  if (!inputSender) return;
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (now - lastInputSentAt < 1000 / 20 - 1) return; // ~20 Hz
  lastInputSentAt = now;
  inputSender({ ...input, jump: pendingJump.value });
  pendingJump.value = false;
}

/** Latest authoritative state for the local player (null in singleplayer). */
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
  self?: { socketId: string; x: number; y: number; z: number; yaw: number; hp: number; dying: boolean; seq: number };
  parts?: PartCorrection[];
  fx?: Array<{ name: string; volume: number }>;
}): void {
  if (data.self) selfCorrection = data.self;
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
  pendingJump.value = false;
  lastInputSentAt = 0;
}

// ═══════════════════════════════════════════════════════════════════
// WeildBuild - Build to Survive client net bridge (v7.1 pass 12, fix 3)
// ═══════════════════════════════════════════════════════════════════
// The thin channel between GamePlayer's gamehost Socket.IO connection
// and the BuildToSurviveManager, for pre-added-game multiplayer:
//
//   • GamePlayer attaches the live socket here (attachBtsSocket) as soon
//     as the multiplayer session connects, and detaches it on teardown.
//   • The manager (via StudioPlayViewport) subscribes to server state
//     (onBtsServerState) and to link changes (onBtsLink). While linked,
//     it runs in NETWORK mode: the server owns phases/disasters/zombies/
//     hp/claims, and place/break/rotate/claim requests go through
//     sendBtsAction. While unlinked (Test Play, offline) everything runs
//     locally exactly as before.
//
// Remote players do NOT pass through here - they ride the platform's
// regular game:state / netcode-bridge path, so they render with the
// standard multiplayer machinery.

import type { Socket } from 'socket.io-client';

/** One Build to Survive action request (client -> server). */
export type BtsAction =
  | { kind: 'place'; part: Record<string, unknown> }
  | { kind: 'break'; id: string }
  | { kind: 'rotate'; id: string; rotation: { x: number; y: number; z: number } }
  | { kind: 'claim'; plotId: string };

/** The server's bts:state snapshot (mirrors the gamehost's bts-rooms.ts). */
export interface BtsServerState {
  seq: number;
  phase: 'build' | 'disaster' | 'ended';
  buildTimer: number;
  disasterT: number;
  round: number;
  disaster: {
    id: string | null;
    name: string;
    tsunamiZ: number;
    floodY: number;
    rain: boolean;
    lava: boolean;
    tornado: { x: number; z: number; t: number } | null;
    meteorites: Array<{ id: number; x: number; y: number; z: number; vy: number }>;
    explosions: Array<{ id: number; x: number; y: number; z: number; t: number }>;
  };
  zombies: Array<{ id: number; x: number; y: number; z: number; yaw: number; swingT: number; alive: boolean }>;
  players: Record<string, { username: string; hp: number; alive: boolean; deaths: number; survived: number }>;
  claims: Record<string, string>;
}

type StateCallback = (state: BtsServerState) => void;
type LinkCallback = (linked: boolean) => void;

let socket: Socket | null = null;
let instanceId: string | null = null;
const stateSubs = new Set<StateCallback>();
const linkSubs = new Set<LinkCallback>();

function handleState(payload: unknown) {
  if (!payload || typeof payload !== 'object') return;
  for (const cb of stateSubs) {
    try { cb(payload as BtsServerState); } catch { /* never break the fan-out */ }
  }
}

/** GamePlayer calls this when the multiplayer session's socket connects. */
export function attachBtsSocket(s: Socket, instId: string | null): void {
  if (socket === s) { instanceId = instId ?? instanceId; return; }
  detachBtsSocket();
  socket = s;
  instanceId = instId;
  s.on('bts:state', handleState);
  for (const cb of linkSubs) {
    try { cb(true); } catch { /* ignore */ }
  }
}

/** GamePlayer calls this on socket teardown / unmount. */
export function detachBtsSocket(): void {
  if (!socket) return;
  socket.off('bts:state', handleState);
  socket = null;
  instanceId = null;
  for (const cb of linkSubs) {
    try { cb(false); } catch { /* ignore */ }
  }
}

/** True while a multiplayer session is live (the manager runs in net mode). */
export function isBtsLinked(): boolean {
  return socket !== null;
}

/** Send a build/claim action to the authority (no-op while unlinked). */
export function sendBtsAction(action: BtsAction): void {
  if (!socket || !instanceId) return;
  socket.emit('bts:action', { instanceId, ...action });
}

/** Subscribe to server state snapshots. Returns an unsubscribe function. */
export function onBtsServerState(cb: StateCallback): () => void {
  stateSubs.add(cb);
  return () => { stateSubs.delete(cb); };
}

/** Subscribe to link changes (socket attached/detached). Returns an unsubscribe function. */
export function onBtsLink(cb: LinkCallback): () => void {
  linkSubs.add(cb);
  return () => { linkSubs.delete(cb); };
}

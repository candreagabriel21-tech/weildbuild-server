// ═══════════════════════════════════════════════════════════════════
// WeildBuild GAME HOST — world simulation manager (v1.1)
// ═══════════════════════════════════════════════════════════════════
// Owns one server-authoritative world worker PER INSTANCE:
//
//   • ensureSim(instance): fetches the game's world from the Main
//     Server (v2.0: plain studioState JSON; v1.x rows still carrying an
//     encrypted .wbworld blob are decrypted as a fallback), boots the
//     bundled world-runtime worker (dist/gamehost/world-runtime.bundle.js)
//     and feeds it the studio state. ONE worker per instance = full
//     isolation (own zustand store, own engine) and parallel physics.
//   • Forwards player joins/leaves, input ticks (~20 Hz per player) and
//     rule clicks into the worker.
//   • Surfaces the worker's ~15 Hz snapshots so the socket layer can
//     broadcast them to the instance room (game:state).
//
// If a game has NO loadable world (ancient primitives-only rows that
// predate even studioState), no sim is created and the host keeps the
// legacy client-relay behavior - graceful degradation, not a crash.
//
// WHY A SEPARATE MANAGER: the instance manager stays pure bookkeeping
// (rooms, caps, heartbeats); this module owns everything about the
// SIMULATION side and its lifecycle (workers die with their instance).

import { Worker } from "node:worker_threads";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "../shared/config";
import { decryptWbworldBuffer, bufferFromBase64 } from "../shared/wbworld";
import type { GameInstance, GameInstanceManager } from "./instances";

interface SimEntry {
  worker: Worker;
  ready: boolean;
  /** Resolves when the worker posted 'ready' (or rejects on error). */
  readyPromise: Promise<void>;
  disposed: boolean;
}

export interface WorldSnapshot {
  t: "snapshot";
  seq: number;
  players: any[];
  parts: any[];
  partUpdates: any[];
  fx: any[];
  messages: any[];
}

const SIM_SWEEP_MS = 5000;

/** Resolve the bundled worker file for both the compiled (dist/) and the
 * dev (src/ via tsx) layouts. */
function resolveWorkerPath(): string {
  const candidates = [
    join(__dirname, "world-runtime.bundle.js"),            // dist/gamehost/*.js
    join(__dirname, "..", "..", "dist", "gamehost", "world-runtime.bundle.js"), // src/gamehost/*.ts (tsx dev)
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}

export class WorldSimManager {
  private sims = new Map<string, SimEntry>();
  private sweeper: NodeJS.Timeout;
  private snapshotListeners: Array<(instanceId: string, snap: WorldSnapshot) => void> = [];

  constructor(private manager: GameInstanceManager) {
    // Dispose sims whose instance vanished (empty-grace sweeper closed it).
    this.sweeper = setInterval(() => {
      for (const [id, sim] of Array.from(this.sims)) {
        if (!this.manager.getInstance(id)) {
          this.dispose(id);
        }
      }
    }, SIM_SWEEP_MS);
  }

  onSnapshot(cb: (instanceId: string, snap: WorldSnapshot) => void): void {
    this.snapshotListeners.push(cb);
  }

  /** True when the instance has a live (or booting) simulation. */
  hasSim(instanceId: string): boolean {
    const sim = this.sims.get(instanceId);
    return !!sim && !sim.disposed;
  }

  /**
   * Fetch the game's world and boot the authoritative simulation for an
   * instance. Safe to call repeatedly (idempotent per instance). Resolves
   * when the worker is ready; resolves silently when no world exists.
   */
  async ensureSim(instance: GameInstance): Promise<void> {
    const existing = this.sims.get(instance.id);
    if (existing && !existing.disposed) {
      await existing.readyPromise;
      return;
    }

    // 1. Fetch the game row (metadata + world) from Main.
    let studioState: any = null;
    try {
      const res = await fetch(
        `${config.host.mainServerUrl}/api/games?id=${encodeURIComponent(instance.gameId)}`,
        { headers: { "x-internal-token": config.internalToken }, signal: AbortSignal.timeout(15000) },
      );
      if (res.ok) {
        const game: any = await res.json();
        // v2.0: the normal path is a PLAIN studioState. The encrypted
        // world_b64 blob is a v1.x fallback (pre-migration rows).
        if (game?.studioState && typeof game.studioState === "object") {
          studioState = game.studioState;
        } else if (game?.world_b64) {
          const bytes = bufferFromBase64(game.world_b64);
          if (bytes) {
            const payload = decryptWbworldBuffer(bytes);
            studioState = payload?.studioState ?? null;
          }
        }
      }
    } catch (e: unknown) {
      console.warn(`[world-sims] world fetch failed for game ${instance.gameId}:`, e instanceof Error ? e.message : e);
    }

    if (!studioState || !Array.isArray(studioState.objects)) {
      // Nothing to simulate (ancient/empty game): the socket layer keeps
      // the legacy relay behavior for this instance.
      console.log(`[world-sims] game ${instance.gameId} has no loadable world — instance ${instance.id} runs relay-only`);
      return;
    }

    // 2. Boot the worker.
    const worker = new Worker(resolveWorkerPath());
    const sim: SimEntry = {
      worker,
      ready: false,
      disposed: false,
      readyPromise: Promise.resolve(),
    };
    this.sims.set(instance.id, sim);

    sim.readyPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("worker init timeout")), 30000);
      worker.once("message", (m: any) => {
        clearTimeout(timeout);
        if (m?.t === "ready") {
          sim.ready = true;
          resolve();
        } else {
          reject(new Error(m?.message || "worker failed to init"));
        }
      });
      worker.once("error", (e) => {
        clearTimeout(timeout);
        reject(e);
      });
      worker.once("exit", (code) => {
        if (!sim.ready) {
          clearTimeout(timeout);
          reject(new Error(`worker exited during init (code ${code})`));
        }
      });
    });

    worker.on("message", (m: any) => {
      if (!m || typeof m !== "object") return;
      if (m.t === "snapshot") {
        for (const cb of this.snapshotListeners) cb(instance.id, m as WorldSnapshot);
      } else if (m.t === "stopped") {
        this.disposeInternal(instance.id);
      } else if (m.t === "error") {
        console.error(`[world-sims] instance ${instance.id} worker error:`, m.message);
      }
    });
    worker.on("error", (e) => {
      console.error(`[world-sims] instance ${instance.id} worker crashed:`, e.message);
      this.disposeInternal(instance.id);
    });

    worker.postMessage({ t: "init", studioState, maxPlayers: instance.maxPlayers });

    try {
      await sim.readyPromise;
      console.log(
        `[world-sims] instance ${instance.id} (game ${instance.gameId}) — authoritative simulation READY`
      );
      // The instance may have filled up while the world was loading -
      // register everyone already in the room.
      for (const p of instance.players.values()) {
        worker.postMessage({ t: "playerJoin", socketId: p.socketId, username: p.username });
      }
    } catch (e: unknown) {
      console.warn(`[world-sims] instance ${instance.id} sim boot failed:`, e instanceof Error ? e.message : e);
      this.disposeInternal(instance.id);
    }
  }

  /** Forward a join (the sim already knows players added before ready). */
  playerJoined(instanceId: string, socketId: string, username: string): void {
    const sim = this.sims.get(instanceId);
    if (sim && sim.ready && !sim.disposed) {
      sim.worker.postMessage({ t: "playerJoin", socketId, username });
    }
  }

  playerLeft(instanceId: string, socketId: string, username?: string): void {
    const sim = this.sims.get(instanceId);
    if (sim && sim.ready && !sim.disposed) {
      sim.worker.postMessage({ t: "playerLeave", socketId, username: username || "" });
    }
  }

  /** A chat message - the worker's rules engine fires on_chat_message. */
  chat(instanceId: string, username: string, message: string): void {
    const sim = this.sims.get(instanceId);
    if (sim && sim.ready && !sim.disposed) {
      sim.worker.postMessage({ t: "chat", username, message });
    }
  }

  /** One input tick from a player (~20 Hz). Payload already sanitized by
   * the worker; here we only validate the basics to keep it cheap. */
  input(instanceId: string, socketId: string, payload: Record<string, unknown>): void {
    const sim = this.sims.get(instanceId);
    if (!sim || !sim.ready || sim.disposed) return;
    sim.worker.postMessage({
      t: "input",
      socketId,
      x: Number(payload.x) || 0,
      z: Number(payload.z) || 0,
      jump: !!payload.jump,
      sprint: !!payload.sprint,
      yaw: Number(payload.yaw) || 0,
    });
  }

  /** A rule click from a player (on_click triggers run on the authority). */
  click(instanceId: string, partId: string): void {
    const sim = this.sims.get(instanceId);
    if (sim && sim.ready && !sim.disposed) {
      sim.worker.postMessage({ t: "click", partId });
    }
  }

  private disposeInternal(instanceId: string): void {
    const sim = this.sims.get(instanceId);
    if (!sim || sim.disposed) return;
    sim.disposed = true;
    this.sims.delete(instanceId);
    try { sim.worker.terminate(); } catch { /* already gone */ }
  }

  dispose(instanceId: string): void {
    const sim = this.sims.get(instanceId);
    if (sim && !sim.disposed) {
      try { sim.worker.postMessage({ t: "stop" }); } catch { /* dead */ }
    }
    this.disposeInternal(instanceId);
  }

  stopAll(): void {
    clearInterval(this.sweeper);
    for (const id of Array.from(this.sims.keys())) this.dispose(id);
  }
}

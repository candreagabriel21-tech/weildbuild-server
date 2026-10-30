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
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
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

/** The worker bundle's candidate paths (same order resolveWorkerPath checks). */
function bundleCandidates(): string[] {
  return [
    join(__dirname, "world-runtime.bundle.js"),            // dist/gamehost/*.js
    join(__dirname, "..", "..", "dist", "gamehost", "world-runtime.bundle.js"), // src/gamehost/*.ts (tsx dev)
  ];
}

function bundleExists(): boolean {
  return bundleCandidates().some((c) => existsSync(c));
}

// ─── v6.4 SELF-HEAL: never run relay-only because of a missing bundle ───
// The user reported "the servers still don't run any physics" from a Render
// deployment. The classic cause: the service's Build Command does not run
// `npm run build` (it was created before render.yaml, or was edited), so
// dist/gamehost/world-runtime.bundle.js never got built - and a missing
// bundle silently degrades EVERY instance to relay-only (parts frozen, no
// game:state snapshots). esbuild is a production dependency ON PURPOSE (see
// package.json), so the gamehost can build the bundle itself at boot in
// ~0.2 s. The script syncs engine/ from ../platform when the sibling exists
// and otherwise uses the committed copy - exactly like a deploy build.
let selfHealTried = false;
export function tryBuildWorkerBundle(): boolean {
  if (bundleExists()) return true;
  if (selfHealTried) return bundleExists(); // once per process, ever
  selfHealTried = true;
  try {
    const serverRoot = resolve(__dirname, "..", "..");
    const script = join(serverRoot, "scripts", "build-world-runtime.mjs");
    if (!existsSync(script)) {
      console.error("[world-sims] bundle missing AND scripts/build-world-runtime.mjs not found - cannot self-heal");
      return bundleExists();
    }
    console.warn("[world-sims] ✗ worker bundle missing - building it now (esbuild, on-the-fly self-heal)...");
    execFileSync(process.execPath, [script], {
      cwd: serverRoot,
      stdio: "inherit",
      timeout: 120000,
    });
    console.warn("[world-sims] ✓ self-heal build finished");
  } catch (e: unknown) {
    console.error(
      "[world-sims] on-the-fly bundle build FAILED:",
      e instanceof Error ? e.message : e,
    );
    console.error("[world-sims] instances will run RELAY-ONLY. Set the Render Build Command to `npm install && npm run build`!");
  }
  return bundleExists();
}

/** Resolve the bundled worker file for both the compiled (dist/) and the
 * dev (src/ via tsx) layouts. v1.3: throws a LOUD, actionable error when
 * the bundle is missing - a missing bundle used to make every instance
 * silently fall back to relay-only (parts frozen, remote players frozen,
 * no game:state snapshots), which is exactly the "game servers don't run
 * physics" report. Build it with `npm run build` (or
 * `node scripts/build-world-runtime.mjs`). */
function resolveWorkerPath(): string {
  // v6.4: self-heal FIRST - if the bundle is missing, try to build it
  // (once). Only when that genuinely fails do we throw the loud error.
  if (!bundleExists()) tryBuildWorkerBundle();
  const candidates = bundleCandidates();
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  const msg =
    "[world-sims] ✗✗✗ dist/gamehost/world-runtime.bundle.js IS MISSING! " +
    "Without it every game instance silently degrades to RELAY-ONLY mode: " +
    "no server physics, no part movement, no game:state snapshots (remote " +
    "players frozen). FIX: run `npm run build` (or " +
    "`node scripts/build-world-runtime.mjs`) on the gamehost BEFORE starting it.";
  // Loud at boot: an error log line that cannot be missed + a health flag.
  console.error(msg);
  (globalThis as any).__wbWorkerBundleMissing = true;
  throw new Error(msg);
}

/** v1.3: health flag - true when the worker bundle was missing at boot. */
export function workerBundleMissing(): boolean {
  return !!(globalThis as any).__wbWorkerBundleMissing;
}

export class WorldSimManager {
  private sims = new Map<string, SimEntry>();
  private sweeper: NodeJS.Timeout;
  private snapshotListeners: Array<(instanceId: string, snap: WorldSnapshot) => void> = [];
  // v6.2.7: pending getWorldState replies (reqId -> { instance, resolver }).
  private worldStateWaiters = new Map<number, { instanceId: string; resolve: (state: any) => void }>();
  private worldStateReqCounter = 0;

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
    // v1.3: resolveWorkerPath() THROWS when the bundle is missing (a loud,
    // actionable error - it used to return a dead path silently). Wrap the
    // boot so the error is logged PER INSTANCE and the socket layer falls
    // back to relay-only instead of an unhandled rejection.
    let worker: Worker;
    try {
      worker = new Worker(resolveWorkerPath());
    } catch (e: unknown) {
      console.error(
        `[world-sims] instance ${instance.id} (game ${instance.gameId}) CANNOT START the simulation:`,
        e instanceof Error ? e.message : e,
      );
      console.error(`[world-sims] instance ${instance.id} runs RELAY-ONLY (no server physics). Build the bundle and restart!`);
      return;
    }
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
      } else if (m.t === "worldState") {
        // v6.2.7: a getWorldState reply - hand it to the waiting joiner.
        const waiter = this.worldStateWaiters.get(m.reqId);
        if (waiter) {
          waiter.resolve({
            objects: Array.isArray(m.objects) ? m.objects : [],
            joints: Array.isArray(m.joints) ? m.joints : [],
            globalVariables: (m.globalVariables && typeof m.globalVariables === "object") ? m.globalVariables : {},
          });
        }
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

  /** v6.2.6: one 0.25 s character-state report from an owning client
   * (position/yaw/anim). The worker applies the light checks and keeps
   * the last accepted report as that player's position. */
  pstate(instanceId: string, socketId: string, payload: Record<string, unknown>): void {
    const sim = this.sims.get(instanceId);
    if (!sim || !sim.ready || sim.disposed) return;
    sim.worker.postMessage({
      t: "pstate",
      socketId,
      x: Number(payload.x) || 0,
      y: Number(payload.y) || 0,
      z: Number(payload.z) || 0,
      yaw: Number(payload.yaw) || 0,
      walking: !!payload.walking,
      jumping: !!payload.jumping,
      sprint: !!payload.sprint,
    });
  }

  /** v6.2.7: ask the worker for the instance's CURRENT full world state
   * (every non-character part with live transforms, joints, global
   * variables) - what a late joiner syncs from so it sees the world as
   * it actually is (rule-created parts, settled physics, changed colors),
   * not as it was published. Null when the sim is not ready. */
  requestWorldState(instanceId: string): Promise<{
    objects: any[];
    joints: any[];
    globalVariables: Record<string, unknown>;
  } | null> {
    const sim = this.sims.get(instanceId);
    if (!sim || !sim.ready || sim.disposed) return Promise.resolve(null);
    const reqId = ++this.worldStateReqCounter;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.worldStateWaiters.delete(reqId);
        resolve(null); // never block a joiner on a stuck worker
      }, 10000);
      this.worldStateWaiters.set(reqId, {
        instanceId,
        resolve: (state: any) => {
          clearTimeout(timeout);
          this.worldStateWaiters.delete(reqId);
          resolve(state);
        },
      });
      sim.worker.postMessage({ t: "getWorldState", reqId });
    });
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

  /** A rule click from a player (on_click triggers run on the authority).
   * v6.2.1: carries the clicker's username so player-targeting rules hit
   * them, not the whole room. */
  click(instanceId: string, partId: string, username?: string): void {
    const sim = this.sims.get(instanceId);
    if (sim && sim.ready && !sim.disposed) {
      sim.worker.postMessage({ t: "click", partId, username: username || "" });
    }
  }

  private disposeInternal(instanceId: string): void {
    const sim = this.sims.get(instanceId);
    if (!sim || sim.disposed) return;
    sim.disposed = true;
    this.sims.delete(instanceId);
    // v6.2.7: fail any pending world-state waits for this sim.
    for (const [reqId, waiter] of Array.from(this.worldStateWaiters)) {
      if (waiter.instanceId === instanceId) {
        this.worldStateWaiters.delete(reqId);
        waiter.resolve(null);
      }
    }
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

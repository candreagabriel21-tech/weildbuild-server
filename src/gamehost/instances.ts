// ═══════════════════════════════════════════════════════════
// WeildBuild GAME HOST — instance manager
// ═══════════════════════════════════════════════════════════
// One game-host process runs MANY game instances ("mini servers").
// Each instance = one room of one game, capped at maxPlayers
// (default 10). The Main Server decides placement: it asks this
// host to create an instance (POST /internal/instances), then the
// client connects over Socket.IO and joins the instance room.
// Instances with 0 players for emptyGraceMs are disposed.

import { randomBytes } from "crypto";
import { config } from "../shared/config";

// ─────────────────── Types ───────────────────

/** A player inside an instance (state shape matches the old socket server). */
export interface GamePlayer {
  socketId: string;
  username: string;
  avatar: unknown;
  position: number[];
  rotation: number[];
}

/** One running game instance ("mini server"). */
export interface GameInstance {
  id: string;
  gameId: string;
  maxPlayers: number;
  /** max_players from Main's game catalog (async-fetched; null until known). */
  gameMaxPlayers: number | null;
  createdAt: number;
  /** When the instance became empty (null while players are in it). */
  emptySince: number | null;
  players: Map<string, GamePlayer>;
}

/** Per-instance entry reported to Main in every heartbeat. */
export interface HeartbeatInstanceEntry {
  id: string;
  gameId: string;
  players: number;
  status: "running" | "closed";
  playerNames?: string[]; // v1.3: usernames in the room (admin "who's playing")
}

/** Aggregated stats for the /health endpoint. */
export interface InstanceStats {
  totalInstances: number;
  totalPlayers: number;
  instances: Array<{
    id: string;
    gameId: string;
    players: number;
    maxPlayers: number;
    ageSeconds: number;
  }>;
}

/** Recently-disposed instances kept briefly so the next heartbeat can tell Main. */
const CLOSED_LIST_MAX = 50;
const SWEEP_INTERVAL_MS = 5000;

// ─────────────────── Manager ───────────────────

export class GameInstanceManager {
  private instances = new Map<string, GameInstance>();
  private closedList: Array<{ id: string; gameId: string }> = [];
  private sweeper: NodeJS.Timeout;

  constructor() {
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
  }

  /** Create a new instance of a game; returns the instanceId. */
  createInstance(gameId: string, maxPlayers: number): string {
    const id = randomBytes(8).toString("hex");
    const instance: GameInstance = {
      id,
      gameId,
      maxPlayers,
      gameMaxPlayers: null,
      createdAt: Date.now(),
      // Starts empty: if nobody ever joins, the grace sweeper reclaims it.
      emptySince: Date.now(),
      players: new Map(),
    };
    this.instances.set(id, instance);
    return id;
  }

  getInstance(id: string): GameInstance | undefined {
    return this.instances.get(id);
  }

  /** The instance a socket is currently playing in (a socket is in at most one). */
  findInstanceBySocket(socketId: string): GameInstance | undefined {
    for (const instance of this.instances.values()) {
      if (instance.players.has(socketId)) return instance;
    }
    return undefined;
  }

  /** Player list with the exact payload shape the client expects. */
  getPlayers(instance: GameInstance): GamePlayer[] {
    return Array.from(instance.players.values()).map((p) => ({
      socketId: p.socketId,
      username: p.username,
      avatar: p.avatar,
      position: [...p.position],
      rotation: [...p.rotation],
    }));
  }

  /**
   * Add a player to an instance. Returns the instance, or null if the
   * instance doesn't exist or is already full. Clears emptySince.
   */
  addPlayer(instanceId: string, player: GamePlayer): GameInstance | null {
    const instance = this.instances.get(instanceId);
    if (!instance) return null;
    if (instance.players.size >= instance.maxPlayers) return null;
    instance.players.set(player.socketId, player);
    instance.emptySince = null;
    return instance;
  }

  /**
   * Remove a socket from an instance. If instanceId is given, only that
   * instance is considered (no-op if the socket isn't in it — matches the
   * old server's behaviour); otherwise the socket is removed from wherever
   * it is playing. Sets emptySince when the instance becomes empty.
   */
  removePlayer(socketId: string, instanceId?: string): { instance: GameInstance; player: GamePlayer } | null {
    const instance = instanceId ? this.instances.get(instanceId) : this.findInstanceBySocket(socketId);
    if (!instance) return null;
    const player = instance.players.get(socketId);
    if (!player) return null;
    instance.players.delete(socketId);
    if (instance.players.size === 0) instance.emptySince = Date.now();
    return { instance, player };
  }

  /** Dispose an instance: drop it from memory and remember it as closed. */
  disposeInstance(id: string): void {
    const instance = this.instances.get(id);
    if (!instance) return;
    this.instances.delete(id);
    this.closedList.push({ id: instance.id, gameId: instance.gameId });
    if (this.closedList.length > CLOSED_LIST_MAX) {
      this.closedList.splice(0, this.closedList.length - CLOSED_LIST_MAX);
    }
  }

  /** Snapshot for the Main Server heartbeat: running + recently-closed. */
  listForHeartbeat(): HeartbeatInstanceEntry[] {
    const running: HeartbeatInstanceEntry[] = Array.from(this.instances.values()).map((i) => ({
      id: i.id,
      gameId: i.gameId,
      players: i.players.size,
      status: "running",
      playerNames: Array.from(i.players.values()).map((p) => p.username), // v1.3: admin "who's playing"
    }));
    const closed: HeartbeatInstanceEntry[] = this.closedList.map((c) => ({
      id: c.id,
      gameId: c.gameId,
      players: 0,
      status: "closed",
    }));
    return [...running, ...closed];
  }

  /** Aggregated stats for the health endpoint. */
  getInstanceStats(): InstanceStats {
    let totalPlayers = 0;
    const instances = Array.from(this.instances.values()).map((i) => {
      totalPlayers += i.players.size;
      return {
        id: i.id,
        gameId: i.gameId,
        players: i.players.size,
        maxPlayers: i.maxPlayers,
        ageSeconds: Math.floor((Date.now() - i.createdAt) / 1000),
      };
    });
    return { totalInstances: this.instances.size, totalPlayers, instances };
  }

  /** Stop the sweeper timer (graceful shutdown). */
  stop(): void {
    clearInterval(this.sweeper);
  }

  /**
   * Empty-instance sweeper: any instance with 0 players that has been
   * empty for longer than emptyGraceMs gets disposed to save resources.
   */
  private sweep(): void {
    const now = Date.now();
    for (const instance of Array.from(this.instances.values())) {
      if (
        instance.players.size === 0 &&
        instance.emptySince !== null &&
        now - instance.emptySince > config.host.emptyGraceMs
      ) {
        console.log(
          `[gamehost] instance ${instance.id} (game ${instance.gameId}) empty for ` +
            `${Math.round((now - instance.emptySince) / 1000)}s — disposing`
        );
        this.disposeInstance(instance.id);
      }
    }
  }
}

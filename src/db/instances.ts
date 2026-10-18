// ═══════════════════════════════════════════════════════════
// WeildBuild DB — game host registry + instance placement
// ═══════════════════════════════════════════════════════════
// Roblox-style orchestration:
//   • Each game can have multiple running instances ("mini servers").
//   • An instance fills up to maxPlayers (default 10), then new
//     joiners get a FRESH instance of the same game.
//   • Server 1 runs instances until it's full; Server 2 takes the
//     overflow (priority ordering).
//   • Instances with 0 players are closed and deleted.

import { randomBytes } from "crypto";
import { prisma } from "./client";
import { HOST_STALE_MS, DEFAULT_MAX_PLAYERS_PER_INSTANCE } from "../shared/constants";

// ─────────────────── Host registry (heartbeat-driven) ───────────────────

export interface HeartbeatInstance {
  id: string;
  gameId: string;
  players: number;
  status: string; // running | closed
  playerNames?: string[]; // usernames currently in the room (v1.3 — for admin "who's playing")
}

export async function registerHost(input: {
  id: string; label: string; url: string; priority: number; maxInstances: number;
}) {
  await prisma.serverHost.upsert({
    where: { id: input.id },
    create: { ...input, status: "online", lastHeartbeat: new Date() },
    update: { ...input, status: "online", lastHeartbeat: new Date() },
  });
}

export async function hostHeartbeat(hostId: string, instances: HeartbeatInstance[], uptimeSeconds?: number) {
  const now = new Date();
  const running = instances.filter((i) => i.status === "running");
  const totalPlayers = running.reduce((sum, i) => sum + i.players, 0);

  await prisma.serverHost.update({
    where: { id: hostId },
    data: {
      status: "online",
      lastHeartbeat: now,
      currentInstances: running.length,
      currentPlayers: totalPlayers,
      ...(typeof uptimeSeconds === "number" ? { uptimeSeconds: Math.max(0, Math.floor(uptimeSeconds)) } : {}),
    },
  });

  // Sync instance rows with what the host reports (source of truth = host memory)
  for (const inst of instances) {
    if (inst.status === "running") {
      const playerNames = (inst.playerNames || []).slice(0, 50);
      await prisma.gameInstance.upsert({
        where: { id: inst.id },
        create: {
          id: inst.id, gameId: inst.gameId, hostId,
          status: "running", playerCount: inst.players, playerNames,
          maxPlayers: DEFAULT_MAX_PLAYERS_PER_INSTANCE, lastHeartbeat: now,
        },
        update: { status: "running", playerCount: inst.players, playerNames, lastHeartbeat: now, closedAt: null },
      });
    } else {
      // Closed on the host → mark closed here too (keep the row briefly for stats)
      await prisma.gameInstance.updateMany({
        where: { id: inst.id, hostId },
        data: { status: "closed", playerCount: 0, closedAt: now },
      });
    }
  }

  // Any DB instance of this host NOT reported anymore → mark closed (crash safety)
  const reportedIds = instances.map((i) => i.id);
  await prisma.gameInstance.updateMany({
    where: { hostId, ...(reportedIds.length > 0 ? { id: { notIn: reportedIds } } : {}), status: { not: "closed" } },
    data: { status: "closed", playerCount: 0, closedAt: now },
  });

  return { instances: running.length, players: totalPlayers };
}

/** Lazily mark hosts/instances dead if heartbeats stopped (Render restart/crash). */
export async function sweepStale() {
  const staleBefore = new Date(Date.now() - HOST_STALE_MS);
  try {
    const staleHosts = await prisma.serverHost.findMany({
      where: { status: "online", lastHeartbeat: { lt: staleBefore } },
      select: { id: true },
    });
    if (staleHosts.length > 0) {
      const ids = staleHosts.map((h) => h.id);
      await prisma.serverHost.updateMany({ where: { id: { in: ids } }, data: { status: "offline", currentInstances: 0, currentPlayers: 0 } });
      await prisma.gameInstance.updateMany({ where: { hostId: { in: ids }, status: { not: "closed" } }, data: { status: "closed", playerCount: 0, closedAt: new Date() } });
    }
  } catch (e: any) {
    console.error("[db] sweepStale error:", e.message);
  }
}

// ─────────────────── Placement (join a game) ───────────────────

export interface PlacementResult {
  instanceId: string;
  socketUrl: string;
  created: boolean;
}

/**
 * Find or create an instance for a player joining a game.
 *  1. Prefer an EXISTING instance of this game with room left
 *     (fill the fullest first — Server 1's instances before Server 2's).
 *  2. Otherwise create a new instance on the best available host:
 *     alive, under its instance cap, lowest priority number first
 *     (Server 1 = 1, Server 2 = 2 → "Server 2 comes in clutch").
 */
export async function findOrCreateInstance(
  gameId: string,
  createOnHost: (hostUrl: string, gameId: string, maxPlayers: number) => Promise<string | null>
): Promise<{ result?: PlacementResult; error?: string }> {
  await sweepStale();

  const game = await prisma.game.findUnique({ where: { id: gameId } });
  if (!game) return { error: "Game not found" };
  const maxPlayers =
    ((game.extraData as any)?.max_players as number) || DEFAULT_MAX_PLAYERS_PER_INSTANCE;

  // 1. Existing joinable instance (only on alive hosts)
  const staleBefore = new Date(Date.now() - HOST_STALE_MS);
  const aliveHosts = await prisma.serverHost.findMany({
    where: { status: "online", lastHeartbeat: { gte: staleBefore } },
  });
  const aliveHostIds = aliveHosts.map((h) => h.id);
  const hostUrlById = new Map(aliveHosts.map((h) => [h.id, h.url]));

  if (aliveHostIds.length > 0) {
    const joinable = await prisma.gameInstance.findFirst({
      where: {
        gameId, status: "running", hostId: { in: aliveHostIds },
        playerCount: { lt: maxPlayers },
      },
      orderBy: [{ playerCount: "desc" }, { createdAt: "asc" }],
    });
    if (joinable) {
      const url = hostUrlById.get(joinable.hostId);
      if (url) {
        return {
          result: { instanceId: joinable.id, socketUrl: url, created: false },
        };
      }
    }
  }

  // 2. Create a new instance on the best host
  if (aliveHosts.length === 0) return { error: "No game servers are currently online" };

  // Sort: priority asc (Server 1 first), then currentInstances asc (least loaded)
  const sorted = [...aliveHosts].sort(
    (a, b) => a.priority - b.priority || a.currentInstances - b.currentInstances
  );
  const host = sorted.find((h) => h.currentInstances < h.maxInstances);
  if (!host) return { error: "All game servers are full right now. Try again in a minute!" };

  const instanceId = await createOnHost(host.url, gameId, maxPlayers);
  if (!instanceId) {
    return { error: "Game server did not respond. Try again in a minute!" };
  }

  await prisma.gameInstance.create({
    data: {
      id: instanceId, gameId, hostId: host.id,
      status: "running", playerCount: 0, maxPlayers,
    },
  });

  return { result: { instanceId, socketUrl: host.url, created: true } };
}

export async function listInstances(gameId?: string) {
  const staleBefore = new Date(Date.now() - HOST_STALE_MS);
  const hosts = await prisma.serverHost.findMany({
    where: { status: "online", lastHeartbeat: { gte: staleBefore } },
  });
  const hostLabelById = new Map(hosts.map((h) => [h.id, h.label || h.id]));
  const rows = await prisma.gameInstance.findMany({
    where: { status: "running", ...(gameId ? { gameId } : {}) },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return rows.map((r) => ({
    id: r.id,
    gameId: r.gameId,
    host: hostLabelById.get(r.hostId) || r.hostId,
    players: r.playerCount,
    maxPlayers: r.maxPlayers,
    created: r.createdAt.toISOString(),
  }));
}

/** Detailed instance list for the admin overview — includes player NAMES. */
export async function listInstancesDetailed() {
  const hosts = await prisma.serverHost.findMany();
  const hostById = new Map(hosts.map((h) => [h.id, h]));
  const rows = await prisma.gameInstance.findMany({
    where: { status: "running" },
    orderBy: { playerCount: "desc" },
    take: 100,
  });
  return rows.map((r) => ({
    id: r.id,
    gameId: r.gameId,
    host: hostById.get(r.hostId)?.label || r.hostId,
    hostId: r.hostId,
    players: r.playerCount,
    playerNames: r.playerNames,
    maxPlayers: r.maxPlayers,
    created: r.createdAt.toISOString(),
  }));
}

export function newInstanceId(): string {
  return randomBytes(8).toString("hex");
}

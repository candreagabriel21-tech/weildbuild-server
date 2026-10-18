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

  // v1.4.2 SELF-HEAL PROTOCOL: if the host row is gone (fresh database after
  // a main-server migration, manual cleanup, ...) the old update() threw
  // "record not found" on EVERY heartbeat — forever, because registration
  // only ran once at boot. Instead of crashing, tell the caller: the response
  // carries reRegister=true and the gamehost re-runs its registration
  // immediately (it knows its own real url/label/priority).
  const existing = await prisma.serverHost.findUnique({ where: { id: hostId } });
  if (!existing) {
    console.warn(`[db] hostHeartbeat: host "${hostId}" is not registered — asking it to re-register (self-heal)`);
    return { instances: running.length, players: totalPlayers, reRegister: true };
  }

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

  return { instances: running.length, players: totalPlayers, reRegister: false };
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

  // 2. Create a new instance on the best host.
  //
  // v1.4.1 "SERVER OFFLINE" FIX: Render free-tier game hosts SLEEP after ~15
  // minutes without traffic. While asleep they send no heartbeats, so by the
  // time someone clicks Join, sweepStale() has marked every host offline and
  // the old code answered "No game servers are currently online" — even
  // though every service was perfectly healthy (it was just napping). The
  // client showed "server offline" on every join.
  //
  // New behavior: when no host is freshly alive, fall back to the LAST KNOWN
  // host registry (any status). The create-fetch itself WAKES the sleeping
  // service (Render cold start ~30-60s — the route's timeout allows for it),
  // and once booted the host re-registers and heartbeats again. We try hosts
  // in priority order until one answers.
  let candidates: { id: string; url: string; priority: number; currentInstances: number; maxInstances: number; alive: boolean }[];
  if (aliveHosts.length > 0) {
    candidates = aliveHosts.map((h) => ({
      id: h.id, url: h.url, priority: h.priority,
      currentInstances: h.currentInstances, maxInstances: h.maxInstances, alive: true,
    }));
  } else {
    const allHosts = await prisma.serverHost.findMany({});
    if (allHosts.length === 0) {
      // v1.4.2: an EMPTY registry is a CONFIG problem, not a sleep problem.
      // The game hosts' MAIN_SERVER_URL almost certainly points somewhere
      // else (a dead/old deployment), so their registration never lands in
      // THIS server's database. Name the fix right in the error — the client
      // shows it verbatim in its toast.
      const thisMain =
        process.env.MAIN_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "your-main-server-url";
      return {
        error:
          `No game hosts are registered with this server. ` +
          `On each game host service, set MAIN_SERVER_URL to THIS server (${thisMain}) ` +
          `and INTERNAL_TOKEN to the same value as this server, then restart it.`,
      };
    }
    candidates = allHosts.map((h) => ({
      id: h.id, url: h.url, priority: h.priority,
      currentInstances: 0, maxInstances: h.maxInstances, alive: false,
    }));
    console.log(`[instances] no alive hosts — waking ${allHosts.length} registered host(s) from sleep`);
  }

  // Sort: priority asc (Server 1 first), then currentInstances asc (least loaded).
  // (Woken hosts report 0 instances — the heartbeat will correct the count.)
  const sorted = [...candidates].sort(
    (a, b) => a.priority - b.priority || a.currentInstances - b.currentInstances
  );

  for (const host of sorted) {
    if (host.alive && host.currentInstances >= host.maxInstances) continue; // full (awake only — woken hosts reset)
    const instanceId = await createOnHost(host.url, gameId, maxPlayers);
    if (instanceId) {
      await prisma.gameInstance.create({
        data: {
          id: instanceId, gameId, hostId: host.id,
          status: "running", playerCount: 0, maxPlayers,
        },
      });
      // If this was a sleeping host, mark it online again right away — it
      // clearly answered, and the next joiner shouldn't re-run the wake path.
      if (!host.alive) {
        await prisma.serverHost.update({
          where: { id: host.id },
          data: { status: "online", lastHeartbeat: new Date() },
        }).catch(() => {});
      }
      return { result: { instanceId, socketUrl: host.url, created: true } };
    }
  }

  if (sorted.length === 0) return { error: "No game servers are currently online" };
  return { error: "All game servers are full or asleep right now. Try again in a minute!" };
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

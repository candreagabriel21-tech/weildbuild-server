// ═══════════════════════════════════════════════════════════
// WeildBuild Main — /instances routes (game placement + hosts)
// ═══════════════════════════════════════════════════════════
// The Roblox-style orchestration conductor:
//   • Client: POST /instances/join {gameId} → {instanceId, socketUrl}
//     (fill an existing instance with room left, else create one
//     on the best host — Server 1 first, Server 2 as overflow)
//   • Game hosts: POST /internal/hosts/register + /heartbeat
//   • Public: GET /instances?gameId= (live server browser data)

import { Router } from "express";
import { z } from "zod";
import { config } from "../../shared/config";
import { safeHandler, validateBody, isInternalRequest } from "../../shared/http";
import { requireAuth, originOk, attachUser, extractToken } from "../middleware";
import { requireRateLimit } from "../../db/ratelimits";
import {
  registerHost, hostHeartbeat, findOrCreateInstance, listInstances,
} from "../../db/instances";
import { incrementGamePlays } from "../../db/data";

// Client-facing router — mounted at /instances
export const instancesRouter = Router();
instancesRouter.use(attachUser);

// Server-to-server router — mounted at /internal (game hosts call these)
export const internalRouter = Router();

// ─────────────── Client-facing: join a game ───────────────

const joinSchema = z.object({ gameId: z.string().min(1).max(50) });

// POST /instances/join
instancesRouter.post("/join", safeHandler(async (req, res) => {
  if (!originOk(req, res)) return;
  const username = await requireAuth(req, res);
  if (!username) return;

  const rl = await requireRateLimit("join_instance", username);
  if (rl) return res.status(429).json({ error: rl.error, retryAfter: rl.retryAfter });

  const parsed = validateBody(joinSchema, req.body, res);
  if ("error" in parsed) return;
  const { gameId } = parsed.data;

  const { result, error } = await findOrCreateInstance(gameId, async (hostUrl, gid, maxPlayers) => {
    try {
      const response = await fetch(`${hostUrl}/internal/instances`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-internal-token": config.internalToken,
        },
        body: JSON.stringify({ gameId: gid, maxPlayers }),
        signal: AbortSignal.timeout(20000), // free-tier cold start can be slow
      });
      if (!response.ok) {
        console.error(`[instances] host ${hostUrl} create failed: ${response.status}`);
        return null;
      }
      const data = await response.json() as { instanceId?: string };
      return data.instanceId || null;
    } catch (e: any) {
      console.error(`[instances] host ${hostUrl} unreachable: ${e.message}`);
      return null;
    }
  });

  if (error || !result) {
    return res.status(503).json({ error: error || "No game servers available" });
  }

  // Count a play when the player gets a fresh instance placement
  await incrementGamePlays(gameId);

  // Pass the caller's own ticket through so the client can connect to the
  // game host with the SAME token (hosts verify it locally with AUTH_SECRET).
  const token = extractToken(req);
  return res.json({
    instanceId: result.instanceId,
    socketUrl: result.socketUrl,
    created: result.created,
    token,
  });
}));

// GET /instances?gameId= — live instances (server browser data)
instancesRouter.get("/", safeHandler(async (_req, res) => {
  const instances = await listInstances();
  return res.json({ instances });
}));

// ─────────────── Internal: game host registry ───────────────

const registerSchema = z.object({
  id: z.string().min(1).max(50),
  label: z.string().min(1).max(50),
  url: z.string().url(),
  priority: z.number().int().min(1).max(100),
  maxInstances: z.number().int().min(1).max(100),
});

// POST /internal/hosts/register (server-to-server)
internalRouter.post("/hosts/register", safeHandler(async (req, res) => {
  if (!isInternalRequest(req)) return res.status(401).json({ error: "Unauthorized" });
  const parsed = validateBody(registerSchema, req.body, res);
  if ("error" in parsed) return;
  const { id, label, url, priority, maxInstances } = parsed.data;
  try {
    await registerHost({ id, label, url, priority, maxInstances });
    return res.json({ success: true });
  } catch (e: any) {
    console.error("[instances] registerHost error:", e.message);
    return res.status(500).json({ error: "Failed to register host" });
  }
}));

const heartbeatSchema = z.object({
  hostId: z.string().min(1).max(50),
  uptimeSeconds: z.number().int().min(0).max(400000000).optional(), // v1.3: host process uptime
  instances: z.array(z.object({
    id: z.string().min(1),
    gameId: z.string().min(1),
    players: z.number().int().min(0),
    status: z.string().min(1),
    playerNames: z.array(z.string().min(1).max(30)).max(50).optional(), // v1.3
  })),
});

// POST /internal/hosts/heartbeat (server-to-server, every ~15s per host)
internalRouter.post("/hosts/heartbeat", safeHandler(async (req, res) => {
  if (!isInternalRequest(req)) return res.status(401).json({ error: "Unauthorized" });
  const parsed = validateBody(heartbeatSchema, req.body, res);
  if ("error" in parsed) return;
  const { hostId, instances, uptimeSeconds } = parsed.data;
  try {
    const stats = await hostHeartbeat(hostId, instances, uptimeSeconds);
    return res.json({ success: true, ...stats });
  } catch (e: any) {
    console.error("[instances] hostHeartbeat error:", e.message);
    return res.status(500).json({ error: "Failed to record heartbeat" });
  }
}));

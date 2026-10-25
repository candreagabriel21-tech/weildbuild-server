// ═══════════════════════════════════════════════════════════
// WeildBuild GAME HOST SERVICE
// ═══════════════════════════════════════════════════════════
// The Roblox-style "mini server" runner. One process hosts MANY
// game instances; the Main Server decides placement:
//   1. Client asks Main  POST /instances/join
//   2. Main points at an existing instance, or asks THIS host to
//      create one via POST /internal/instances
//   3. Client connects here over Socket.IO and joins the instance
//      room (`instance:<id>`) — one game can have many parallel
//      instances with DIFFERENT state.
// Instances with 0 players for emptyGraceMs are disposed.
// Event payload shapes match the legacy socket-server/server.js
// exactly (game:join/move/chat/leave, game:players, game:playerJoined,
// game:playerMoved, game:playerLeft) so the existing client works
// unchanged.

import express from "express";
import { createServer } from "http";
import { Server, Socket } from "socket.io";
import { config, assertSecrets, SERVER_VERSION } from "../shared/config";
import { verifyTicket } from "../shared/jwt";
import { corsOrigin } from "../shared/http";
import { GameInstanceManager, GameInstance } from "./instances";

assertSecrets("gamehost");

const manager = new GameInstanceManager();
const startedAt = Date.now();
const MAIN = config.host.mainServerUrl;
const INTERNAL_HEADERS = {
  "x-internal-token": config.internalToken,
  "Content-Type": "application/json",
};

// v1.4.2: registration state, exposed in /health so a broken deployment is
// visible with a single curl — no dashboard log diving required:
//   curl https://<gamehost>/health
//   { ..., "registered": true/false, "mainUrl": "...", "lastRegisterError": "..." }
let registered = false;
let lastRegisterError = "";

// ═══════════════════════════════════════════
// HTTP server (shared with Socket.IO)
// ═══════════════════════════════════════════

const app = express();
app.set("trust proxy", 1); // Render sits in front
app.use(express.json({ limit: "1mb" }));

// ── Health check (Render + monitoring) ──
// v1.3: allow any origin so the WB Admin CTRL desktop app can poll
// uptime too (plain GET, no credentials — safe for *).
app.use("/health", (_req: express.Request, res: express.Response, next: () => void) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  next();
});
app.get("/", healthHandler);
app.get("/health", healthHandler);
function healthHandler(_req: express.Request, res: express.Response) {
  const stats = manager.getInstanceStats();
  res.json({
    status: "ok",
    service: "weildbuild-gamehost",
    version: SERVER_VERSION,
    hostId: config.host.id,
    label: config.host.label,
    instances: stats.totalInstances,
    players: stats.totalPlayers,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    // v1.4.2: the two lines that answer "why don't servers work" instantly.
    registered,
    mainUrl: MAIN,
    lastRegisterError: lastRegisterError || null,
    timestamp: new Date().toISOString(),
  });
}

// ── Internal: Main Server asks us to create an instance ──
app.post("/internal/instances", (req, res) => {
  const token = req.headers["x-internal-token"];
  if (!config.internalToken || token !== config.internalToken) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const body =
    typeof req.body === "object" && req.body !== null
      ? (req.body as { gameId?: unknown; maxPlayers?: unknown })
      : {};
  const gameId = typeof body.gameId === "string" ? body.gameId : "";
  if (!gameId) return res.status(400).json({ error: "gameId is required" });

  if (manager.getInstanceStats().totalInstances >= config.host.maxInstances) {
    return res.status(503).json({ error: "Host at capacity" });
  }

  const maxPlayers =
    typeof body.maxPlayers === "number" && body.maxPlayers > 0
      ? Math.floor(body.maxPlayers)
      : config.host.maxPlayersPerInstance;

  const instanceId = manager.createInstance(gameId, maxPlayers);
  // Fire-and-forget: cache the game's extra_data.max_players from Main
  // (for future server-side features; the passed maxPlayers is the fallback).
  void cacheGameMaxPlayers(instanceId, gameId, maxPlayers);

  console.log(
    `[gamehost] instance ${instanceId} created for game ${gameId} ` +
      `(max ${maxPlayers} players) — ${manager.getInstanceStats().totalInstances}/${config.host.maxInstances} slots used`
  );
  return res.status(201).json({ instanceId, gameId, maxPlayers });
});

// ── 404 + JSON error handling ──
app.use((_req, res) => res.status(404).json({ error: "Not found" }));
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[gamehost] HTTP error:", err instanceof Error ? err.message : err);
  if (!res.headersSent) res.status(400).json({ error: "Invalid request" });
});

// ═══════════════════════════════════════════
// Registration + heartbeat to Main Server
// ═══════════════════════════════════════════

async function registerWithMain(): Promise<void> {
  const res = await fetch(`${MAIN}/internal/hosts/register`, {
    method: "POST",
    headers: INTERNAL_HEADERS,
    body: JSON.stringify({
      id: config.host.id,
      label: config.host.label,
      url: config.host.publicUrl,
      priority: config.host.priority,
      maxInstances: config.host.maxInstances,
    }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Main Server (${MAIN}) responded ${res.status}`);
}

/** Keep retrying registration every 15s until Main accepts us. */
async function registerLoop(): Promise<void> {
  for (;;) {
    try {
      await registerWithMain();
      registered = true;
      lastRegisterError = "";
      console.log(`[gamehost] registered with Main Server as "${config.host.id}" (${config.host.label})`);
      return;
    } catch (e) {
      registered = false;
      lastRegisterError = e instanceof Error ? e.message : String(e);
      console.warn(
        `[gamehost] registration with ${MAIN} failed: ${lastRegisterError} — retrying in 15s. ` +
          `Check MAIN_SERVER_URL (must be the URL of your REAL Main Server) and INTERNAL_TOKEN (must match Main's).`
      );
      await new Promise((resolve) => setTimeout(resolve, 15000));
    }
  }
}

/** v1.4.2: re-register periodically (default every 5 min) even after the
 * initial success. If Main's database was ever reset/wiped, the host row is
 * gone — heartbeats alone used to fail forever. Re-registration heals it. */
function startReRegistrationLoop(): void {
  const intervalMs = parseInt(process.env.REREGISTER_INTERVAL_MS || "300000", 10);
  setInterval(() => {
    registerWithMain()
      .then(() => {
        if (!registered) console.log("[gamehost] re-registered with Main Server (self-heal)");
        registered = true;
        lastRegisterError = "";
      })
      .catch((e: unknown) => {
        registered = false;
        lastRegisterError = e instanceof Error ? e.message : String(e);
        console.warn(`[gamehost] periodic re-registration failed: ${lastRegisterError}`);
      });
  }, intervalMs);
}

/** Every heartbeatIntervalMs: report running/closed instances to Main. */
function startHeartbeat(): void {
  setInterval(() => {
    const body = JSON.stringify({
      hostId: config.host.id,
      instances: manager.listForHeartbeat(),
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    });
    fetch(`${MAIN}/internal/hosts/heartbeat`, {
      method: "POST",
      headers: INTERNAL_HEADERS,
      body,
      signal: AbortSignal.timeout(10000),
    })
      .then(async (res) => {
        if (!res.ok) {
          console.warn(`[gamehost] heartbeat rejected by Main (${MAIN}, HTTP ${res.status})`);
          return;
        }
        // v1.4.2 self-heal: Main answers { reRegister: true } when our host
        // row is missing from its database (fresh DB / wiped registry) —
        // re-register immediately instead of failing forever.
        try {
          const data = (await res.json()) as { reRegister?: boolean };
          if (data && data.reRegister) {
            console.warn("[gamehost] Main says we are not registered — re-registering now (self-heal)");
            registerWithMain()
              .then(() => { registered = true; lastRegisterError = ""; })
              .catch((e: unknown) => {
                registered = false;
                lastRegisterError = e instanceof Error ? e.message : String(e);
              });
          }
        } catch {}
      })
      .catch((e: unknown) =>
        console.warn(`[gamehost] heartbeat failed: ${e instanceof Error ? e.message : e}`)
      );
  }, config.host.heartbeatIntervalMs);
}

/**
 * Fetch the game row from Main and cache extra_data.max_players on the
 * instance. Non-blocking and failure-tolerant — the passed-in maxPlayers
 * is already the working fallback.
 */
async function cacheGameMaxPlayers(instanceId: string, gameId: string, fallback: number): Promise<void> {
  try {
    const res = await fetch(`${MAIN}/api/games?id=${encodeURIComponent(gameId)}`, {
      headers: { "x-internal-token": config.internalToken },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return;
    const data: unknown = await res.json();
    const game = extractGame(data);
    const extra = (game as
      | { extra_data?: { max_players?: unknown }; extraData?: { max_players?: unknown } }
      | null
      | undefined);
    const value = Number(extra?.extra_data?.max_players ?? extra?.extraData?.max_players);
    const instance = manager.getInstance(instanceId);
    if (!instance) return; // already disposed
    instance.gameMaxPlayers = Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
  } catch {
    // Non-blocking: keep the fallback maxPlayers.
  }
}

/** Tolerant parsing: accept { game }, { games: [...] }, { data } or a bare game object. */
function extractGame(data: unknown): unknown {
  if (Array.isArray(data)) return data[0];
  if (typeof data === "object" && data !== null) {
    const d = data as { game?: unknown; games?: unknown; data?: unknown };
    if (d.game) return d.game;
    if (Array.isArray(d.games)) return d.games[0];
    if (d.data) return d.data;
  }
  return data;
}

// ═══════════════════════════════════════════
// Socket.IO server (same HTTP server)
// ═══════════════════════════════════════════

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    // Configured origins + any https://*.onrender.com; requests with NO
    // Origin header (Tauri desktop app / native clients) are allowed too.
    origin: corsOrigin,
    methods: ["GET", "POST"],
    credentials: true,
  },
  // Long ping intervals so Render's load balancer doesn't kill idle sockets.
  pingTimeout: 60000,
  pingInterval: 25000,
  // Avatar payloads can be chunky.
  maxHttpBufferSize: 1e6,
});

// ── Handshake auth: verify the session ticket signed by Main ──
io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  if (typeof token !== "string" || !token) {
    return next(new Error("Invalid session ticket"));
  }
  const ticket = await verifyTicket(token);
  if (!ticket) {
    return next(new Error("Invalid session ticket"));
  }
  socket.data.username = ticket.username;
  next();
});

// ── Helpers ──

/** The authenticated username for a socket (never trust the client's claim). */
function authName(socket: Socket): string {
  return socket.data.username;
}

function asRecord(payload: unknown): Record<string, unknown> {
  return typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
}

/** Find the instance a socket is playing in: the given instanceId first, then wherever it is. */
function resolvePlayerInstance(socketId: string, instanceId: unknown): GameInstance | undefined {
  let instance = typeof instanceId === "string" ? manager.getInstance(instanceId) : undefined;
  if (!instance || !instance.players.has(socketId)) {
    instance = manager.findInstanceBySocket(socketId);
  }
  return instance;
}

// ── Connection handler ──
io.on("connection", (socket) => {
  console.log(`[gamehost] connect ${socket.id} (${authName(socket)})`);

  // ── game:join { instanceId, gameId, username, avatar } ──
  socket.on("game:join", (payload: unknown) => {
    const p = asRecord(payload);
    const username = authName(socket); // authenticated name always wins (anti-spoof)
    const claimed = typeof p.username === "string" ? p.username : "";
    if (claimed && claimed !== username) {
      console.warn(
        `[gamehost] username spoof attempt from ${socket.id}: claimed "${claimed}", authenticated as "${username}"`
      );
    }
    const avatar = p.avatar ?? null;
    const instanceId = typeof p.instanceId === "string" ? p.instanceId : "";
    if (!instanceId) {
      socket.emit("game:error", { code: "instance_not_found", message: "No game instance was provided." });
      return;
    }

    const instance = manager.getInstance(instanceId);
    if (!instance) {
      socket.emit("game:error", {
        code: "instance_not_found",
        message: "Game instance not found — it may have closed. Join the game again.",
      });
      return;
    }
    if (instance.players.size >= instance.maxPlayers) {
      socket.emit("game:error", {
        code: "room_full",
        message: "This game instance is full. Join the game again to get a new one.",
      });
      return;
    }

    // Leave any previous instance first (same pattern as the old socket server).
    const previous = manager.findInstanceBySocket(socket.id);
    if (previous) {
      const removed = manager.removePlayer(socket.id, previous.id);
      socket.leave(`instance:${previous.id}`);
      if (removed) {
        io.to(`instance:${previous.id}`).emit("game:playerLeft", {
          socketId: socket.id,
          username: removed.player.username,
        });
        io.to(`instance:${previous.id}`).emit("game:players", manager.getPlayers(previous));
      }
    }

    socket.join(`instance:${instanceId}`);
    const joined = manager.addPlayer(instanceId, {
      socketId: socket.id,
      username,
      avatar,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
    });
    if (!joined) {
      socket.emit("game:error", { code: "room_full", message: "This game instance is full." });
      return;
    }

    // Same emit order as the legacy server: list to joiner → joined notice to
    // others → full player list broadcast to the room.
    socket.emit("game:players", manager.getPlayers(joined));
    socket.to(`instance:${instanceId}`).emit("game:playerJoined", { socketId: socket.id, username, avatar });
    io.to(`instance:${instanceId}`).emit("game:players", manager.getPlayers(joined));

    console.log(
      `[gamehost] ${username} joined instance ${instanceId} (${joined.players.size}/${joined.maxPlayers})`
    );
  });

  // ── game:move { instanceId, position, rotation, anim? } ──
  // v1.4.5: the payload now optionally carries the player's body-animation
  // state (walking/jumping/dying/sprint). It is validated to a small
  // boolean record and relayed to the room so OTHER players see the same
  // walk swing, jump pose and death explosion as the local player.
  socket.on("game:move", (payload: unknown) => {
    const p = asRecord(payload);
    if (!Array.isArray(p.position) || !Array.isArray(p.rotation)) return;
    const position = p.position as number[];
    const rotation = p.rotation as number[];

    // Sanitize the anim flags (booleans only, known keys only)
    let anim: import("./instances").PlayerAnimState | undefined;
    const rawAnim = p.anim;
    if (rawAnim && typeof rawAnim === "object" && !Array.isArray(rawAnim)) {
      const r = rawAnim as Record<string, unknown>;
      const cleaned: import("./instances").PlayerAnimState = {};
      if (typeof r.walking === "boolean") cleaned.walking = r.walking;
      if (typeof r.jumping === "boolean") cleaned.jumping = r.jumping;
      if (typeof r.dying === "boolean") cleaned.dying = r.dying;
      if (typeof r.sprint === "boolean") cleaned.sprint = r.sprint;
      if (Object.keys(cleaned).length > 0) anim = cleaned;
    }

    const instance = resolvePlayerInstance(socket.id, p.instanceId);
    if (!instance) return;
    const player = instance.players.get(socket.id);
    if (!player) return;

    player.position = position;
    player.rotation = rotation;
    if (anim) player.anim = anim;
    // Broadcast to everyone else in the room (sender already moved locally).
    socket.to(`instance:${instance.id}`).emit("game:playerMoved", {
      socketId: socket.id,
      username: player.username,
      position,
      rotation,
      anim: player.anim,
    });
  });

  // ── game:chat { instanceId, username, message } ──
  socket.on("game:chat", (payload: unknown) => {
    const p = asRecord(payload);
    const message = typeof p.message === "string" ? p.message : "";
    if (!message) return;

    const instance = resolvePlayerInstance(socket.id, p.instanceId);
    if (!instance) return;

    // Broadcast to the whole room (including sender, for echo confirmation).
    io.to(`instance:${instance.id}`).emit("game:chat", {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      username: authName(socket), // anti-spoof: authenticated name
      message,
      timestamp: Date.now(),
    });
  });

  // ── game:leave { instanceId } ──
  socket.on("game:leave", (payload: unknown) => {
    const p = asRecord(payload);
    const instanceId = typeof p.instanceId === "string" ? p.instanceId : undefined;
    const removed = manager.removePlayer(socket.id, instanceId);
    if (!removed) return;

    const room = `instance:${removed.instance.id}`;
    socket.leave(room);
    io.to(room).emit("game:playerLeft", { socketId: socket.id, username: removed.player.username });
    io.to(room).emit("game:players", manager.getPlayers(removed.instance));
    console.log(
      `[gamehost] ${removed.player.username} left instance ${removed.instance.id} (${removed.instance.players.size} remain)`
    );
  });

  // ── disconnect: remove from any instance ──
  socket.on("disconnect", () => {
    const removed = manager.removePlayer(socket.id);
    console.log(`[gamehost] disconnect ${socket.id} (${authName(socket)})`);
    if (!removed) return;
    const room = `instance:${removed.instance.id}`;
    socket.leave(room);
    io.to(room).emit("game:playerLeft", { socketId: socket.id, username: removed.player.username });
    io.to(room).emit("game:players", manager.getPlayers(removed.instance));
    console.log(
      `[gamehost] ${removed.player.username} removed from instance ${removed.instance.id} (${removed.instance.players.size} remain)`
    );
  });

  socket.on("error", (err) => {
    console.error(`[gamehost] socket error ${socket.id}:`, err);
  });
});

// ═══════════════════════════════════════════
// Boot + graceful shutdown
// ═══════════════════════════════════════════

const port = config.gamehostPort;
httpServer.listen(port, () => {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log(`║  WeildBuild GAME HOST listening on port ${String(port).padEnd(9)}║`);
  console.log(`║  Host: ${(config.host.id + " (" + config.host.label + ")").slice(0, 40).padEnd(42)}║`);
  console.log(`║  Max instances: ${String(config.host.maxInstances).slice(0, 30).padEnd(31)}║`);
  console.log(`║  Main: ${config.host.mainServerUrl.slice(0, 43).padEnd(44)}║`);
  console.log("╚══════════════════════════════════════════════════════╝");
  // v1.4.2: catch the most common deployment mistake right at boot — a
  // MAIN_SERVER_URL that was never set (or still points at localhost). On
  // Render (RENDER_EXTERNAL_URL present) that's ALWAYS wrong and gets the
  // loud warning; on a local dev machine localhost is perfectly normal and
  // only gets a one-line note.
  const mainUrlLooksLocal = /localhost|127\.0\.0\.1/.test(config.host.mainServerUrl);
  if (process.env.RENDER_EXTERNAL_URL && (!process.env.MAIN_SERVER_URL || mainUrlLooksLocal)) {
    console.warn("");
    console.warn("  ⚠⚠⚠  MAIN_SERVER_URL IS NOT SET (or points at localhost)  ⚠⚠⚠");
    console.warn("  This game host will NEVER register with your Main Server, and every");
    console.warn("  game join will fail with \"No game hosts are registered\".");
    console.warn("  Set MAIN_SERVER_URL to your REAL Main Server URL (the same one");
    console.warn("  clients use), e.g. https://weildbuild-server.onrender.com");
    console.warn("");
  } else if (!process.env.MAIN_SERVER_URL) {
    console.log("[gamehost] note: MAIN_SERVER_URL not set — using local default " + config.host.mainServerUrl + " (fine for local dev)");
  }
  // Register with Main (retry every 15s until success), then start heartbeats
  // + the periodic re-registration safety net.
  void registerLoop().then(() => {
    startHeartbeat();
    startReRegistrationLoop();
  });
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[gamehost] ${signal} received — shutting down...`);
  manager.stop();
  io.close(() => {
    // io.close() also closes the attached HTTP server; this is the safety net.
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

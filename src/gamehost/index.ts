// ═══════════════════════════════════════════════════════════
// WeildBuild GAME HOST SERVICE
// ═══════════════════════════════════════════════════════════
// The classic "mini server" runner. One process hosts MANY
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
import { WorldSimManager } from "./world-sims";

assertSecrets("gamehost");

const manager = new GameInstanceManager();
// v1.1: server-authoritative simulations - one physics + rules worker
// per instance, fed by game:input, broadcasting game:state snapshots.
const worldSims = new WorldSimManager(manager);
worldSims.onSnapshot((instanceId, snap) => {
  // Authoritative state for the whole room (players, changed part
  // transforms, rule-driven part updates, relayed sound cues, screen
  // messages). Clients reconcile their local prediction against this.
  io.to(`instance:${instanceId}`).emit("game:state", snap);
});
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

/** Keep retrying registration until Main accepts us.
 *
 * Backoff: the first retry comes fast (500ms) because the overwhelmingly
 * common failure is benign boot ORDER — the gamehost came up before Main's
 * HTTP listener was ready (separate services, independent startup). Doubling
 * up to the 15s steady-state keeps a genuinely unreachable/broken Main from
 * being hammered. Sequence: 0.5s, 1s, 2s, 4s, 8s, then 15s forever. */
async function registerLoop(): Promise<void> {
  let retryMs = 500;
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
        `[gamehost] registration with ${MAIN} failed: ${lastRegisterError} — retrying in ${Math.round(retryMs / 100) / 10}s. ` +
          `Check MAIN_SERVER_URL (must be the URL of your REAL Main Server) and INTERNAL_TOKEN (must match Main's).`
      );
      await new Promise((resolve) => setTimeout(resolve, retryMs));
      retryMs = Math.min(retryMs * 2, 15000);
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
    // v1.1 FIX: the /api/games response is FLATTENED (extra_data spread to
    // the top level), so max_players lives at game.max_players. The old
    // nested reads never matched and silently fell back every time.
    const g = game as
      | { max_players?: unknown; extra_data?: { max_players?: unknown }; extraData?: { max_players?: unknown } }
      | null
      | undefined;
    const value = Number(g?.max_players ?? g?.extra_data?.max_players ?? g?.extraData?.max_players);
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

/** v1.9.2: guest accounts are "Guest-NNNN". Real usernames can NEVER contain
 * a dash (registration only allows letters/digits/underscore), so this prefix
 * test is an exact guest/non-guest split - no database lookup needed. */
function isGuestName(username: string): boolean {
  return typeof username === "string" && username.startsWith("Guest-");
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
  // v6.2.2: last gameplay activity (input/chat/click/move). The duplicate
  // session guard uses it to tell an ACTIVE second window (reject the
  // newcomer) from a parked/background one (let the newcomer take over).
  socket.data.lastSeen = Date.now();

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
        message: "Game instance not found. It may have closed. Join the game again.",
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

    // ── v6.2.2: DUPLICATE SESSION GUARD ──
    // The same account joining the same instance twice used to produce TWO
    // bodies in the room (the second one often stuck with a default avatar,
    // the "naked clone" report). One account, one body, per instance:
    //   • old session gone (refresh race, dead transport) -> evict the
    //     stale entry silently and let this join through
    //   • old session parked (socket alive but no gameplay packets for a
    //     while, e.g. a background tab) -> the newcomer TAKES OVER, the
    //     parked socket is kicked with a warning
    //   • old session actively playing -> the NEWCOMER is rejected with a
    //     warning and disconnected (the literal "joined twice, get kicked"
    //     request)
    const DUPLICATE_SILENCE_MS = 5000;
    let duplicate: { socketId: string; live: boolean; active: boolean } | null = null;
    for (const [sid, p] of instance.players) {
      if (p.username !== username || sid === socket.id) continue;
      const oldSocket = io.sockets.sockets.get(sid);
      const live = !!oldSocket && oldSocket.connected;
      const lastSeen = typeof oldSocket?.data?.lastSeen === "number" ? oldSocket.data.lastSeen : 0;
      duplicate = { socketId: sid, live, active: live && Date.now() - lastSeen <= DUPLICATE_SILENCE_MS };
      break;
    }
    if (duplicate) {
      if (duplicate.active) {
        // Genuinely playing in another window right now: kick the newcomer.
        socket.emit("game:error", {
          code: "duplicate_session",
          message:
            "You are already playing this game in another window or on another device. Close that one, then join again.",
        });
        socket.disconnect(true);
        console.log(
          `[gamehost] duplicate join rejected: ${username} (already active on socket ${duplicate.socketId})`
        );
        return;
      }
      // Stale or parked: evict the old entry, then continue with this join.
      manager.removePlayer(duplicate.socketId, instance.id);
      worldSims.playerLeft(instance.id, duplicate.socketId, username);
      io.to(`instance:${instance.id}`).emit("game:playerLeft", { socketId: duplicate.socketId, username });
      io.to(`instance:${instance.id}`).emit("game:players", manager.getPlayers(instance));
      if (duplicate.live) {
        const oldSocket = io.sockets.sockets.get(duplicate.socketId);
        oldSocket?.emit("game:error", {
          code: "duplicate_session",
          message: "This game was opened again with your account in another window. Only one window can play at a time.",
        });
        oldSocket?.disconnect(true);
        console.log(`[gamehost] parked session taken over: ${username} (${duplicate.socketId} -> ${socket.id})`);
      } else {
        console.log(`[gamehost] stale session evicted: ${username} (${duplicate.socketId})`);
      }
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
    // v6.2.7: capture BEFORE addPlayer (this joiner makes the instance
    // "lived-in" itself). Decides whether the joiner later syncs the live
    // world state (a second player joining a running instance) or skips
    // (a fresh instance - the published studio state IS the truth).
    socket.data.joinedLivedIn = instance.everHadPlayers;
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

    // v1.1: boot the server-authoritative simulation for this instance (idempotent;
    // the world loads from Main once) and register the player. Until the sim is
    // ready the client's prediction runs alone - snapshots reconcile it after.
    void worldSims.ensureSim(joined).then(() => {
      worldSims.playerJoined(instanceId, socket.id, username);
    });

    console.log(
      `[gamehost] ${username} joined instance ${instanceId} (${joined.players.size}/${joined.maxPlayers})`
    );
  });

  // ── game:pstate { instanceId, x, y, z, yaw, walking, jumping, sprint } ──
  // v6.2.6: THE player channel of the Roblox-style model. Each client
  // simulates its OWN character locally (the full singleplayer feel) and
  // reports its state every 0.25 s; the worker applies light checks
  // (PLAYER_LIGHT_CHECK_STUDS), keeps the last accepted report as that
  // player's position, and relays it to everyone else in the snapshots.
  socket.on("game:pstate", (payload: unknown) => {
    const p = asRecord(payload);
    const instance = resolvePlayerInstance(socket.id, p.instanceId);
    if (!instance) return;
    if (!instance.players.has(socket.id)) return;
    socket.data.lastSeen = Date.now(); // duplicate guard liveness
    worldSims.pstate(instance.id, socket.id, p);
  });

  // ── game:syncWorld ──
  // v6.2.7: a joiner asks for the instance's CURRENT full world state
  // (objects, joints, rule variables) so it starts where everyone else
  // is - settled physics, rule-created parts, changed colors - instead
  // of the published snapshot. A FRESH instance (nobody has ever joined,
  // or a relay-only legacy game with no simulation) answers "skip": the
  // client keeps the published state it already loaded. The payload is
  // chunked (750 parts per message) so huge worlds never trip proxy or
  // socket frame limits.
  socket.on("game:syncWorld", async () => {
    const instance = resolvePlayerInstance(socket.id, undefined);
    if (!instance || !instance.players.has(socket.id)) return;
    const livedIn = socket.data.joinedLivedIn === true;
    const state = livedIn && worldSims.hasSim(instance.id)
      ? await worldSims.requestWorldState(instance.id)
      : null;
    if (!state || !Array.isArray(state.objects)) {
      // Fresh instance, relay-only game, or the worker did not answer:
      // nothing to sync - the published state is what everyone plays.
      socket.emit("game:worldState", { fresh: true, done: true });
      return;
    }
    const CHUNK = 750;
    const total = state.objects.length;
    for (let i = 0; i < Math.max(1, Math.ceil(total / CHUNK)); i++) {
      const slice = state.objects.slice(i * CHUNK, (i + 1) * CHUNK);
      socket.emit("game:worldState", {
        chunk: i,
        done: (i + 1) * CHUNK >= total,
        objects: slice,
        joints: i === 0 ? state.joints : undefined,
        globalVariables: i === 0 ? state.globalVariables : undefined,
      });
    }
    console.log(
      `[gamehost] world sync for ${authName(socket)} on ${instance.id}: ` +
        `${total} parts, ${state.joints?.length ?? 0} joints, ` +
        `${Object.keys(state.globalVariables ?? {}).length} variables`
    );
  });

  // ── game:input { instanceId, x, z, jump, sprint, yaw } ──
  // v6.2.6 LEGACY: the old authority-side movement channel. The server no
  // longer simulates characters (each client owns its own body now and
  // reports via game:pstate), so these are accepted and silently ignored -
  // old clients keep working, their characters simply run client-side
  // like everyone's.
  socket.on("game:input", (payload: unknown) => {
    const p = asRecord(payload);
    const instance = resolvePlayerInstance(socket.id, p.instanceId);
    if (!instance) return;
    if (!instance.players.has(socket.id)) return;
    socket.data.lastSeen = Date.now(); // duplicate guard liveness
    worldSims.input(instance.id, socket.id, p);
  });

  // ── game:click { instanceId, partId } ──
  // v1.1: on_click rules run on the authority - a click is a REQUEST,
  // the worker's engine decides what happens.
  // v6.2.1: the clicker's username rides along so player-targeting rules
  // (kill/heal/damage/teleport) hit the player who clicked, not everyone.
  socket.on("game:click", (payload: unknown) => {
    const p = asRecord(payload);
    socket.data.lastSeen = Date.now(); // duplicate guard liveness
    const instance = resolvePlayerInstance(socket.id, p.instanceId);
    if (!instance) return;
    const partId = typeof p.partId === "string" ? p.partId : "";
    if (!partId || partId.length > 128) return;
    const player = instance.players.get(socket.id);
    worldSims.click(instance.id, partId, player?.username);
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
    socket.data.lastSeen = Date.now(); // duplicate guard liveness

    // v1.1: with a live server-authoritative simulation this legacy
    // client-position report is IGNORED (the server owns the transform).
    // It still works for relay-only instances (ancient games with no
    // loadable world) so old content keeps running.
    if (worldSims.hasSim(instance.id)) return;

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
  // v1.9.2 GUEST RULES: guests can neither SEND nor SEE in-game chat.
  // The WeildBuild client hides the whole chat panel for guests; these
  // server rules are the backstop against tampered clients.
  socket.on("game:chat", (payload: unknown) => {
    const p = asRecord(payload);
    const message = typeof p.message === "string" ? p.message : "";
    if (!message) return;

    const username = authName(socket); // anti-spoof: authenticated name
    if (isGuestName(username)) {
      console.log(`[gamehost] dropped chat from guest ${username}`);
      return;
    }
    socket.data.lastSeen = Date.now(); // duplicate guard liveness

    const instance = resolvePlayerInstance(socket.id, p.instanceId);
    if (!instance) return;

    // v1.5: the authoritative rules engine fires on_chat_message triggers.
    worldSims.chat(instance.id, username, message);

    const chatMessage = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      username, // anti-spoof: authenticated name
      message,
      timestamp: Date.now(),
    };

    // Deliver to every NON-guest in the room (sender keeps its echo
    // confirmation exactly like before). io.to(<socketId>) targets one
    // socket - every socket is auto-joined to a room named by its id.
    for (const [socketId, player] of instance.players) {
      if (isGuestName(player.username)) continue;
      io.to(socketId).emit("game:chat", chatMessage);
    }
  });

  // ── game:leave { instanceId } ──
  socket.on("game:leave", (payload: unknown) => {
    const p = asRecord(payload);
    const instanceId = typeof p.instanceId === "string" ? p.instanceId : undefined;
    const removed = manager.removePlayer(socket.id, instanceId);
    if (!removed) return;
    worldSims.playerLeft(removed.instance.id, socket.id, removed.player.username);

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
    worldSims.playerLeft(removed.instance.id, socket.id, removed.player.username);
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
  worldSims.stopAll();
  manager.stop();
  io.close(() => {
    // io.close() also closes the attached HTTP server; this is the safety net.
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

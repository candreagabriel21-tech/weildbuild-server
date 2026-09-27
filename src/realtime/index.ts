// ═══════════════════════════════════════════════════════════
// WeildBuild REALTIME SERVER
// ═══════════════════════════════════════════════════════════
//
// Presence, friend events, DM push and fallback in-browser
// multiplayer rooms. Ported 1:1 from the original
// socket-server/server.js — same event names, same payload
// shapes (the client depends on them) — plus two additions:
//
//   NEW • JWT handshake auth: clients connect with
//         io(url, { auth: { token: "<jwt>" } }). The ticket is
//         verified locally against the shared AUTH_SECRET (no
//         round-trip to Main). The verified username is stored
//         in socket.data.username and is the ONLY trusted
//         identity — usernames inside payloads are ignored
//         (anti-spoofing).
//   NEW • dm:new — push "you have a new DM" to a recipient.
//
// Events (identical wire format to the old server):
//   • user:online       — client emits { username } on connect
//   • friend:request    — routed to a specific user by username
//   • friend:accepted   — routed to a specific user by username
//   • game:join         — join a game room, broadcast player list
//   • game:move         — broadcast position/rotation to the room
//   • game:chat         — broadcast a chat message to the room
//   • game:leave        — leave the game room
//   • disconnect        — cleanup username index + all game rooms

import { createServer, IncomingMessage, ServerResponse } from "http";
import { Server, Socket } from "socket.io";
import { config, assertSecrets } from "../shared/config";
import { verifyTicket } from "../shared/jwt";

// dotenv is loaded by the shared config import (config.ts calls
// dotenv.config() for local dev; Render injects env vars directly).
assertSecrets("realtime"); // warns if AUTH_SECRET is missing — tickets then fail closed

const PORT = config.realtimePort;

// ─── In-memory state (same shape as the old server) ───
// username -> socket.id (routing friend requests / DM push)
const usernameToSocketId = new Map<string, string>();
// socket.id -> username (cleanup on disconnect)
const socketIdToUsername = new Map<string, string>();

interface PlayerState {
  socketId: string;
  username: string;
  avatar: unknown; // AvatarData from the client — opaque to this relay
  position: number[];
  rotation: number[];
}
// gameId -> Map<socketId, PlayerState>
const gameRooms = new Map<string, Map<string, PlayerState>>();

// ─── Wire payload types (permissive: the client may omit fields) ───
interface UserOnlinePayload { username?: string }
interface FriendRequestPayload { from?: string; to?: string }
interface FriendAcceptedPayload { username?: string; friend?: string }
interface DmNewPayload { from?: string; to?: string }
interface GameJoinPayload { gameId?: string; username?: string; avatar?: unknown }
interface GameMovePayload { gameId?: string; position?: number[]; rotation?: number[] }
interface GameChatPayload { gameId?: string; username?: string; message?: string }
interface GameLeavePayload { gameId?: string }

/** Verified identity from the handshake JWT — payload usernames are NEVER trusted. */
function verifiedUsername(socket: Socket): string | undefined {
  const u: string | undefined = socket.data?.username;
  return u;
}

// ─── Helpers ───
function getPlayersInGame(gameId: string): PlayerState[] {
  const room = gameRooms.get(gameId);
  if (!room) return [];
  return Array.from(room.values()).map((p) => ({
    socketId: p.socketId,
    username: p.username,
    avatar: p.avatar,
    position: p.position,
    rotation: p.rotation,
  }));
}

function broadcastPlayerList(gameId: string): void {
  const players = getPlayersInGame(gameId);
  io.to(`game:${gameId}`).emit("game:players", players);
}

/**
 * Remove a socket from a game room and notify the room
 * (game:playerLeft + game:playerList). Returns the removed
 * player, or undefined if the socket wasn't in the room.
 */
function leaveGameRoom(socket: Socket, gameId: string): PlayerState | undefined {
  const room = gameRooms.get(gameId);
  if (!room || !room.has(socket.id)) return undefined;
  const player = room.get(socket.id);
  room.delete(socket.id);
  socket.leave(`game:${gameId}`);
  io.to(`game:${gameId}`).emit("game:playerLeft", {
    socketId: socket.id,
    username: player ? player.username : undefined,
  });
  broadcastPlayerList(gameId);
  if (room.size === 0) gameRooms.delete(gameId);
  return player;
}

// ─── HTTP server with health check ───
const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  // Render pings this endpoint to check if the service is alive
  if (req.url === "/" || req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      service: "weildbuild-realtime",
      connectedUsers: usernameToSocketId.size,
      activeGames: gameRooms.size,
      timestamp: new Date().toISOString(),
    }));
    return;
  }
  res.writeHead(404);
  res.end("Not found");
});

// ─── Socket.IO server ───
// CORS: configured origins AND any Render URL (preview/prod).
// Requests with no Origin header (desktop app, curl) are allowed —
// same policy as the Main Server.
function originAllowed(
  origin: string | undefined,
  callback: (err: Error | null, allow?: boolean) => void
): void {
  if (!origin) return callback(null, true);
  const clean = origin.replace(/\/$/, "");
  if (config.allowedOrigins.some((o) => o.replace(/\/$/, "") === clean)) {
    return callback(null, true);
  }
  // Allow any https://*.onrender.com (Render previews + our own services)
  if (/^https:\/\/[a-z0-9-]+\.onrender\.com$/i.test(clean)) {
    return callback(null, true);
  }
  return callback(null, false);
}

const io = new Server(httpServer, {
  cors: {
    origin: originAllowed,
    methods: ["GET", "POST"],
    credentials: true,
  },
  // Long ping intervals because Render's load balancer might otherwise
  // think the connection is dead and close it (same as old server).
  pingTimeout: 60000,
  pingInterval: 25000,
  // Allow large payloads (avatar data can be chunky)
  maxHttpBufferSize: 1e6,
});

// ─── JWT handshake auth (NEW) ───
// Client connects with io(url, { auth: { token: "<jwt>" } }).
// Invalid/missing ticket → connection REJECTED.
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (typeof token !== "string" || token.length === 0) {
      return next(new Error("Invalid session ticket"));
    }
    const ticket = await verifyTicket(token);
    if (!ticket || !ticket.username) {
      return next(new Error("Invalid session ticket"));
    }
    // Verified identity for the lifetime of this socket
    socket.data.username = ticket.username;
    next();
  } catch {
    next(new Error("Invalid session ticket")); // fail closed
  }
});

// ─── Connection handler ───
io.on("connection", (socket: Socket) => {
  console.log(`[connect] ${verifiedUsername(socket) || socket.id} (${socket.id})`);

  // ─── User presence ───
  socket.on("user:online", (_payload: UserOnlinePayload) => {
    // Anti-spoof: username comes from the verified JWT, never the payload.
    const username = verifiedUsername(socket);
    if (!username) return;
    console.log(`[user:online] ${username} (${socket.id})`);
    socketIdToUsername.set(socket.id, username);
    usernameToSocketId.set(username, socket.id);
  });

  // ─── Friend request routing ───
  // Client emits: socket.emit("friend:request", { from, to })
  // Server routes to the target user's socket by username.
  socket.on("friend:request", (payload: FriendRequestPayload) => {
    const { from, to } = payload;
    if (!from || !to) return;
    if (from !== verifiedUsername(socket)) return; // anti-spoof
    const targetSocketId = usernameToSocketId.get(to);
    if (targetSocketId) {
      io.to(targetSocketId).emit("friend:request", { from, to });
      console.log(`[friend:request] ${from} → ${to}`);
    } else {
      // Target user is offline — they'll see the request on next login
      // (the HTTP API persists it to the database)
      console.log(`[friend:request] ${from} → ${to} (offline, not relayed)`);
    }
  });

  socket.on("friend:accepted", (payload: FriendAcceptedPayload) => {
    // 'username' accepted 'friend's request — notify 'friend'
    const { username, friend } = payload;
    if (!username || !friend) return;
    if (username !== verifiedUsername(socket)) return; // anti-spoof
    const targetSocketId = usernameToSocketId.get(friend);
    if (targetSocketId) {
      io.to(targetSocketId).emit("friend:accepted", { username, friend });
      console.log(`[friend:accepted] ${username} accepted ${friend}'s request`);
    }
  });

  // ─── DM push (NEW) ───
  // The sender's client emits this AFTER the HTTP DM send succeeds;
  // the recipient then refreshes their chat.
  socket.on("dm:new", (payload: DmNewPayload) => {
    const { from, to } = payload;
    if (!from || !to) return;
    if (from !== verifiedUsername(socket)) return; // anti-spoof
    const targetSocketId = usernameToSocketId.get(to);
    if (targetSocketId) {
      io.to(targetSocketId).emit("dm:new", { from, to });
      console.log(`[dm:new] ${from} → ${to}`);
    } else {
      // Recipient offline — they'll fetch the DM on next login
      console.log(`[dm:new] ${from} → ${to} (offline, not relayed)`);
    }
  });

  // ─── Multiplayer game events ───
  socket.on("game:join", (payload: GameJoinPayload) => {
    const { gameId, avatar } = payload;
    // Anti-spoof: the stored/broadcast username is the verified identity.
    const username = verifiedUsername(socket);
    if (!gameId || !username) return;
    console.log(`[game:join] ${username} → game ${gameId}`);

    // Leave any previous game room first
    for (const [gid] of gameRooms.entries()) {
      leaveGameRoom(socket, gid);
    }

    // Join the new game room
    socket.join(`game:${gameId}`);
    let room = gameRooms.get(gameId);
    if (!room) {
      room = new Map();
      gameRooms.set(gameId, room);
    }
    room.set(socket.id, {
      socketId: socket.id,
      username, // verified username (anti-spoof)
      avatar: avatar || null,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
    });

    // Send current player list to the joining user
    socket.emit("game:players", getPlayersInGame(gameId));
    // Notify everyone else in the room
    socket.to(`game:${gameId}`).emit("game:playerJoined", {
      socketId: socket.id,
      username,
      avatar: avatar || null,
    });
    broadcastPlayerList(gameId);
  });

  socket.on("game:move", (payload: GameMovePayload) => {
    const { gameId, position, rotation } = payload;
    if (!gameId) return;
    const room = gameRooms.get(gameId);
    if (!room) return;
    const player = room.get(socket.id);
    if (!player) return;
    if (!Array.isArray(position) || !Array.isArray(rotation)) return;
    player.position = position;
    player.rotation = rotation;
    // Broadcast to everyone else in the room (not the sender — they
    // already moved locally)
    socket.to(`game:${gameId}`).emit("game:playerMoved", {
      socketId: socket.id,
      username: player.username,
      position,
      rotation,
    });
  });

  socket.on("game:chat", (payload: GameChatPayload) => {
    const { gameId, message } = payload;
    // Anti-spoof: the broadcast username is the verified identity.
    const username = verifiedUsername(socket);
    if (!gameId || !username || !message || typeof message !== "string") return;
    // Broadcast chat to everyone in the room (including sender for
    // echo confirmation)
    io.to(`game:${gameId}`).emit("game:chat", {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      username,
      message,
      timestamp: Date.now(),
    });
  });

  socket.on("game:leave", (payload: GameLeavePayload) => {
    const { gameId } = payload;
    if (!gameId) return;
    const player = leaveGameRoom(socket, gameId);
    if (player) {
      console.log(`[game:leave] ${player.username} left game ${gameId}`);
    }
  });

  // ─── Disconnect cleanup ───
  socket.on("disconnect", () => {
    const username = socketIdToUsername.get(socket.id);
    console.log(`[disconnect] ${username || socket.id}`);

    // Remove from username index — with stale-connection guard:
    // only delete if this socket.id is the CURRENT one for the username
    // (prevents a stale reconnect from wiping a fresh connection).
    if (username) {
      if (usernameToSocketId.get(username) === socket.id) {
        usernameToSocketId.delete(username);
      }
      socketIdToUsername.delete(socket.id);
    }

    // Remove from all game rooms
    for (const [gameId] of gameRooms.entries()) {
      leaveGameRoom(socket, gameId);
    }
  });

  socket.on("error", (err: unknown) => {
    console.error(`[error] ${socket.id}:`, err);
  });
});

// ─── Start ───
httpServer.listen(PORT, () => {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log(`║  WeildBuild REALTIME SERVER listening on port ${String(PORT).padEnd(6)} ║`);
  console.log(`║  Allowed origins: ${JSON.stringify(config.allowedOrigins).slice(0, 35).padEnd(35)}║`);
  console.log("║  + any https://*.onrender.com origin                 ║");
  console.log("╚══════════════════════════════════════════════════════╝");
});

// ─── Graceful shutdown ───
function shutdown(signal: string): void {
  console.log(`Received ${signal} — shutting down...`);
  io.close(() => {
    httpServer.close(() => process.exit(0));
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

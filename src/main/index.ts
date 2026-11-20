// ═══════════════════════════════════════════════════════════
// WeildBuild MAIN SERVER
// ═══════════════════════════════════════════════════════════
// The brain of the platform: accounts, sessions, friends, games,
// items, notifications, storage proxy, version gate and game
// instance placement. Clients talk ONLY to this server over
// HTTPS REST; realtime/multiplayer connections get their URLs
// from here.

import express from "express";
import cors from "cors";
import { config, assertSecrets, SERVER_VERSION } from "../shared/config";
import { corsOrigin } from "../shared/http";
import { authRouter } from "./routes/auth";
import { usersRouter } from "./routes/users";
import { friendsRouter } from "./routes/friends";
import { gamesRouter } from "./routes/games";
import { itemsRouter } from "./routes/items";
import { notificationsRouter } from "./routes/notifications";
import { adminRouter } from "./routes/admin";
import { storageRouter } from "./routes/storage";
import { reportsRouter } from "./routes/reports";
import { instancesRouter, internalRouter } from "./routes/instances";
import { votesRouter } from "./routes/votes";
import { bridgeRouter, isBridgeConnected } from "../bridge/render-bridge";
import { getEffectiveSettings } from "../db/settings";
import { ensureDatabase } from "../db/ensure";
import { prisma } from "../db/client";
import { sweepStaleGuests } from "../db/users";

assertSecrets("main");

const app = express();

// ── Middleware ──
app.set("trust proxy", 1); // Render sits in front (x-forwarded-for)
app.use(cors({ origin: corsOrigin, credentials: true }));
// v1.1: 8mb, game publishes now carry the world as an encrypted
// .wbworld blob (base64). Compressed worlds are tiny (a 1 MB JSON world
// lands ~20-50 KB), but the cap leaves headroom for chunky thumbnails
// on top; anything beyond 4 MB of decoded world bytes is rejected in
// the games route itself.
app.use(express.json({ limit: "8mb" }));

// ── Bridge: laptop worker polls /__bridge/* (see src/bridge/render-bridge.ts) ──
app.use("/__bridge", bridgeRouter);

// ── Health check (Render + uptime monitors) ──
// v1.10.2: THE RESPONSE IS INSTANT, ALWAYS. This endpoint decides Render's
// deploy port-detection; a single hung relay call here fails the whole
// deploy ("Port scan timeout reached"). Three layers guarantee it:
//   1. the relay itself fails fast (<0.2 s) when the laptop is offline
//   2. this 2.5 s race is a hard ceiling no matter what
//   3. every failure path returns the same 200 shape (hosts zeroed)
// The response also reports bridge connectivity, so "is my laptop
// connected?" is answerable from /health alone.
const startedAt = Date.now();
app.get("/", healthHandler);
app.get("/health", healthHandler);
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("health census timeout")), ms)
    ),
  ]);
}
function healthHandler(_req: express.Request, res: express.Response) {
  // v1.4.2: include the host registry census, "hosts: { registered: 0 }"
  // instantly explains "No game hosts are registered" join failures without
  // opening a database console.
  const base = () => ({
    status: "ok",
    service: "weildbuild-main",
    version: SERVER_VERSION,
    bridge: { connected: isBridgeConnected() },
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    timestamp: new Date().toISOString(),
  });
  withTimeout(
    prisma.serverHost.groupBy({ by: ["status"], _count: { _all: true } }),
    2500
  )
    .then((groups) => {
      let online = 0, registered = 0;
      for (const g of groups) {
        registered += g._count._all;
        if (g.status === "online") online += g._count._all;
      }
      res.json({ ...base(), hosts: { online, registered } });
    })
    .catch(() => {
      res.json({ ...base(), hosts: { online: 0, registered: 0 } });
    });
}

// ── Version gate (roadmap 2.5, client checks on boot) ──
// v1.3: admin-editable, DB settings (set via WB Admin CTRL) override
// the env vars. Response shape stays compatible with client v13.1:
// `latest` / `minimum` / `downloadUrl` unchanged, `downloads` is new.
app.get("/version", async (_req, res) => {
  try {
    // v1.10.2: same hard ceiling as /health — with the laptop offline the
    // relay fast-fails in ~0.2 s, this race is the second belt. The client
    // boot must never stall on a dead database path.
    const settings = await withTimeout(getEffectiveSettings(), 2500);
    res.json({
      latest: settings.latestVersion,
      minimum: settings.minVersion,
      downloadUrl: settings.downloads.web,
      downloads: settings.downloads,
      maintenance: settings.maintenanceMode,
      service: "weildbuild-main",
      timestamp: new Date().toISOString(),
    });
  } catch {
    // DB unreachable → env fallback so clients still get an answer
    res.json({
      latest: config.client.latestVersion,
      minimum: config.client.minVersion,
      downloadUrl: config.client.downloadUrl,
      service: "weildbuild-main",
      timestamp: new Date().toISOString(),
    });
  }
});

// ── Routers (mounted under /api/*, the exact same paths the
//    old Next.js app used, so the client only changes its base
//    URL, nothing else) ──
app.use("/api/auth", authRouter);
app.use("/api/users", usersRouter);
app.use("/api/friends", friendsRouter);
app.use("/api/games", gamesRouter);
app.use("/api/items", itemsRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/admin", adminRouter);
app.use("/api/storage", storageRouter);
app.use("/api/reports", reportsRouter);
app.use("/api/instances", instancesRouter);
app.use("/api/votes", votesRouter);

// Server-to-server endpoints for the game hosts (NOT under /api)
app.use("/internal", internalRouter);

// ── 404 + error handling ──
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

const port = config.mainPort;
app.listen(port, () => {
  console.log("╔══════════════════════════════════════════════════════╗");
  console.log("║  WeildBuild MAIN SERVER listening on port " + String(port).padEnd(8) + "║");
  console.log("║  Origins: " + JSON.stringify(config.allowedOrigins).slice(0, 38).padEnd(39) + "║");
  console.log("╚══════════════════════════════════════════════════════╝");

  // v1.3.1: set up the database BY OURSELVES in the background
  // (schema sync + first-run seed). Render made the Shell tab a
  // paid feature, so this replaces the old "run npm run migrate
  // in the Shell" step. Runs AFTER the port is bound so health
  // checks pass instantly; every step fails soft (see ensure.ts).
  // Only the main server does this, never realtime/gamehost.
  ensureDatabase().catch((e) =>
    console.error("[db-setup] unexpected error (non-fatal):", e)
  );

  // v1.9.2 GUEST HOUSEKEEPING: reap guest accounts that were abandoned
  // (tab closed without Sign Out). Once shortly after boot (give the DB
  // setup a moment to settle), then once an hour. Non-fatal by design:
  // a sweeper failure must never affect serving traffic.
  const sweepGuests = () => {
    sweepStaleGuests().catch((e) => console.error("[guest] sweep failed:", e));
  };
  setTimeout(sweepGuests, 30_000);
  setInterval(sweepGuests, 60 * 60 * 1000).unref();
});

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
import { config, assertSecrets } from "../shared/config";
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
import { getEffectiveSettings } from "../db/settings";
import { ensureDatabase } from "../db/ensure";

assertSecrets("main");

const app = express();

// ── Middleware ──
app.set("trust proxy", 1); // Render sits in front (x-forwarded-for)
app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json({ limit: "2mb" })); // avatar payloads can be chunky

// ── Health check (Render + uptime monitors) ──
const startedAt = Date.now();
app.get("/", healthHandler);
app.get("/health", healthHandler);
function healthHandler(_req: express.Request, res: express.Response) {
  res.json({
    status: "ok",
    service: "weildbuild-main",
    version: "1.3.2",
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    timestamp: new Date().toISOString(),
  });
}

// ── Version gate (roadmap 2.5 — client checks on boot) ──
// v1.3: admin-editable — DB settings (set via WB Admin CTRL) override
// the env vars. Response shape stays compatible with client v13.1:
// `latest` / `minimum` / `downloadUrl` unchanged, `downloads` is new.
app.get("/version", async (_req, res) => {
  try {
    const settings = await getEffectiveSettings();
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

// ── Routers (mounted under /api/* — the exact same paths the
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
  // Only the main server does this — never realtime/gamehost.
  ensureDatabase().catch((e) =>
    console.error("[db-setup] unexpected error (non-fatal):", e)
  );
});

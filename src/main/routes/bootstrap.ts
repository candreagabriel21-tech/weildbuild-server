// ════════════════════════════════════════════════════════════════════
// WeildBuild MAIN SERVER — /api/bootstrap  (v1.11.1 LATENCY FIX)
// ════════════════════════════════════════════════════════════════════
// One endpoint that returns everything the client needs on boot:
//   • version gate (was: GET /version)
//   • authenticated user, or null   (was: GET /api/auth)
//   • all games (light list)        (was: GET /api/games)
//   • all items                     (was: GET /api/items)
//   • the user's notifications       (was: GET /api/notifications?username=…)
//
// WHY: the old client fired those five requests SEQUENTIALLY on every
// page load (app/page.tsx boot effects). Each one is a separate HTTPS
// round-trip to Render + a separate bridge queue cycle on the laptop.
// On a warm bridge that's 5 × ~2.5 s = ~12 s of wall-clock time before
// the lobby is interactive. On a cold Render it's 30-50 s for the first
// request and then ~10 s for the rest.
//
// This endpoint collapses all five into ONE round-trip. The four DB
// reads run on the laptop in PARALLEL (Promise.all), so the bridge
// queue sees exactly one batch pickup instead of five sequential
// ones. With the v1.11.1 batched poll the laptop runs all four jobs
// in the same poll cycle.
//
// SAFETY: the four DB reads each have their own try/catch so a failure
// in one (e.g. notifications table doesn't exist yet on a fresh DB)
// does NOT take down the whole bootstrap. The response carries a
// per-section `ok: boolean` so the client can fall back to the legacy
// single-endpoint call for the section that failed. This means the
// bootstrap endpoint is NON-DESTRUCTIVE: if any sub-call fails, the
// client behaves exactly like it did before this change.
//
// AUTH: an unauthenticated client gets version + games + items (the
// parts that don't need a session) and `user: null, notifications: []`.
// An authenticated client gets the full bundle. No session is created
// or destroyed here; this is a READ-ONLY endpoint.

import { Router, Request, Response } from "express";
import { config, SERVER_VERSION } from "../../shared/config";
import { safeHandler, clientIp } from "../../shared/http";
import { requireRateLimit } from "../../db/ratelimits";
import { getEffectiveSettings } from "../../db/settings";
import { verifySession } from "../../db/sessions";
import { getUser, stripSensitiveFields } from "../../db/users";
import { getAllGames, getAllItems, getNotifications } from "../../db/data";
import { extractToken } from "../middleware";

export const bootstrapRouter = Router();

// Local copy of withTimeout (the one in main/index.ts is not exported).
// Used so a slow settings read can't stall the whole bootstrap — the
// version gate has an env fallback, identical to GET /version.
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("bootstrap section timeout")), ms)
    ),
  ]);
}

// GET /api/bootstrap
// Optional query: ?username=<name> — pre-fetch that user's notifications.
// If absent and the session is valid, notifications for the session user
// are fetched. If unauthenticated, notifications is [].
bootstrapRouter.get("/", safeHandler(async (req: Request, res: Response) => {
  const rl = await requireRateLimit("general_api", clientIp(req));
  if (rl) return res.status(429).json({ error: rl.error, retryAfter: rl.retryAfter });

  // ── 1. Version gate (mirrors GET /version) ──
  let version: any;
  try {
    const settings = await withTimeout(getEffectiveSettings(), 2500);
    version = {
      latest: settings.latestVersion,
      minimum: settings.minVersion,
      downloadUrl: settings.downloads.web,
      downloads: settings.downloads,
      maintenance: settings.maintenanceMode,
    };
  } catch {
    version = {
      latest: config.client.latestVersion,
      minimum: config.client.minVersion,
      downloadUrl: config.client.downloadUrl,
      maintenance: false,
    };
  }

  // ── 2. Session lookup (mirrors GET /api/auth) ──
  // No DB hit if there's no token; verifySession is the only cost.
  let username: string | null = null;
  let user: any = null;
  const token = extractToken(req);
  if (token) {
    try {
      username = await verifySession(token);
      if (username) {
        const fullUser = await getUser(username);
        if (fullUser) user = stripSensitiveFields(fullUser);
      }
    } catch {
      // Bad token / DB error — treat as logged out, do not 401.
      username = null; user = null;
    }
  }

  // ── 3. Parallel data fetch ──
  // The four reads below run as one Promise.all. With the v1.11.1 batched
  // poll on the laptop, all four bridge jobs are picked up in the SAME
  // poll cycle and run concurrently against the local Postgres.
  //
  // Each sub-promise has its own catch that returns { ok: false, error },
  // so a failure in one section does not abort the others. The client
  // uses `ok` to decide whether to fall back to the legacy endpoint.
  const targetUsername = (req.query.username as string) || username || null;

  const [gamesRes, itemsRes, notifRes] = await Promise.all([
    getAllGames()
      .then((games) => ({ ok: true as const, games }))
      .catch((e) => ({ ok: false as const, error: String(e?.message || e) })),
    getAllItems()
      .then((items) => ({ ok: true as const, items }))
      .catch((e) => ({ ok: false as const, error: String(e?.message || e) })),
    targetUsername
      ? getNotifications(targetUsername)
          .then((notifications) => ({ ok: true as const, notifications }))
          .catch((e) => ({ ok: false as const, error: String(e?.message || e) }))
      : Promise.resolve({ ok: true as const, notifications: [] }),
  ]);

  res.json({
    service: "weildbuild-main",
    version: SERVER_VERSION,
    timestamp: new Date().toISOString(),
    // Session
    authenticated: !!user,
    user,
    // Version gate (merged with the top-level service info so the
    // client can stop calling GET /version separately)
    versionGate: version,
    // Data sections; each carries its own `ok` flag
    games:   gamesRes.ok   ? gamesRes.games          : [],
    gamesOk: gamesRes.ok,
    items:   itemsRes.ok   ? itemsRes.items          : [],
    itemsOk: itemsRes.ok,
    notifications: notifRes.ok ? notifRes.notifications : [],
    notificationsOk: notifRes.ok,
  });
}));

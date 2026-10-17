// ═══════════════════════════════════════════════════════════
// WeildBuild Main — /admin routes. Backups + cleanup (ported from
// the original), plus the v1.2.0 moderation endpoints that power
// the desktop app's Admin tab (client v13.9): search players,
// warn, ban (kills all their sessions) and unban.
// ═══════════════════════════════════════════════════════════
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../db/client";
import { runCleanup, trimUserNotificationArrays, createNotification, getNotifications } from "../../db/data";
import { getUser, saveUser, sanitizeString } from "../../db/users";
import { deleteUserSessions } from "../../db/sessions";
import { requireRateLimit } from "../../db/ratelimits";
import { config } from "../../shared/config";
import { safeHandler, validateBody, clientIp } from "../../shared/http";
import { attachUser, requireAdmin, requireAuth, originOk } from "../middleware";
import { uploadBackup } from "../../b2/b2";

export const adminRouter = Router();

// Attach req.authUser (session identity) for every request
adminRouter.use(attachUser);

// All tables we back up (in dependency order so restores work cleanly).
// Keys are the names used in the backup JSON; values dump the Prisma models.
const BACKUP_DUMPERS: Record<string, () => Promise<any[]>> = {
  users: () => prisma.user.findMany(),
  games: () => prisma.game.findMany(),
  items: () => prisma.item.findMany(),
  notifications: () => prisma.notification.findMany(),
  dms: () => prisma.dm.findMany(),
  messages: () => prisma.message.findMany(),
  sessions: () => prisma.session.findMany(),
  rateLimits: () => prisma.rateLimit.findMany(),
  transactionLogs: () => prisma.transactionLog.findMany(),
  gameInstances: () => prisma.gameInstance.findMany(),
  serverHosts: () => prisma.serverHost.findMany(),
  reports: () => prisma.report.findMany(),
};

// GET /admin/backup — returns backup status/info (no side effects)
adminRouter.get("/backup", safeHandler(async (req, res) => {
  // Verify admin
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  return res.json({
    message: "Use POST to trigger a backup. Backups are uploaded to Backblaze B2.",
    b2Configured: !!(config.b2.keyId && config.b2.applicationKey),
    tablesBackedUp: Object.keys(BACKUP_DUMPERS),
    note: "Backups include password hashes — keep your B2 keys secret!",
  });
}));

// POST /admin/backup — dump ALL tables and upload the JSON to B2
adminRouter.post("/backup", safeHandler(async (req, res) => {
  // Verify admin
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  try {
    const now = new Date();
    const timestamp = now.toISOString();
    // Filename: weildbuild-backup-2026-07-17-023045.json
    const filename = `weildbuild-backup-${timestamp.slice(0, 10)}-${timestamp.slice(11, 19).replace(/:/g, "")}.json`;

    console.log(`[backup] Starting backup at ${timestamp}`);

    // Step 1: Dump all tables (a failed table becomes an empty list —
    // the backup still continues, exactly like the original)
    const tables: Record<string, { rowCount: number; bytes: number }> = {};
    const data: Record<string, any[]> = {};
    for (const [table, dump] of Object.entries(BACKUP_DUMPERS)) {
      try {
        const rows = (await dump()) || [];
        tables[table] = {
          rowCount: rows.length,
          bytes: Buffer.byteLength(JSON.stringify(rows), "utf8"),
        };
        data[table] = rows;
      } catch (e: any) {
        console.error(`[backup] Failed to dump ${table}:`, e.message);
        tables[table] = { rowCount: 0, bytes: 0 };
        data[table] = [];
      }
    }

    const totalBytes = Object.values(tables).reduce((sum, t) => sum + t.bytes, 0);

    // Step 2: Build the backup object with metadata (same _meta shape
    // as the original backups, so restores keep working)
    const backup = {
      _meta: {
        version: 1,
        timestamp,
        app: "WeildBuild",
        tableCount: Object.keys(tables).length,
        totalBytes,
        tables: Object.fromEntries(
          Object.entries(tables).map(([k, v]) => [k, v.rowCount])
        ),
      },
      data,
    };

    // Step 3: Upload to B2
    const uploadResult = await uploadBackup(filename, backup);
    if (uploadResult.error || !uploadResult.key) {
      const error = uploadResult.error || "Upload failed";
      return res.status(500).json({
        success: false,
        error,
        partial: { success: false, timestamp, filename, tables, totalBytes, error },
      });
    }

    console.log(`[backup] Success! Uploaded ${filename} (${totalBytes} bytes) to B2 key ${uploadResult.key}`);
    return res.json({
      triggeredBy: admin,
      success: true,
      timestamp,
      filename,
      b2Key: uploadResult.key,
      tables,
      totalBytes,
    });
  } catch (e: any) {
    return res.status(500).json({ error: "Backup failed: " + e.message });
  }
}));

// GET /admin/cleanup — returns a preview of the retention policy (dry run)
adminRouter.get("/cleanup", safeHandler(async (req, res) => {
  // Verify admin
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  // Dry run — just return the current cleanup status
  return res.json({
    message: "Use POST to run cleanup. This endpoint deletes old data from the database.",
    retentionPolicy: {
      readNotifications: "7 days",
      unreadNotifications: "30 days",
      dmMessages: "90 days",
      chatMessages: "90 days",
      rateLimits: "1 hour",
      expiredSessions: "immediately",
      transactionLogs: "90 days",
      userNotificationArray: "last 50 entries",
    },
  });
}));

// POST /admin/cleanup — actually runs the cleanup
adminRouter.post("/cleanup", safeHandler(async (req, res) => {
  // Verify admin
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  try {
    const result = await runCleanup();
    const trimmed = await trimUserNotificationArrays();

    return res.json({
      success: true,
      triggeredBy: admin,
      result: {
        ...result,
        userArraysTrimmed: trimmed,
      },
    });
  } catch (e: any) {
    return res.status(500).json({ error: "Cleanup failed: " + e.message });
  }
}));

// ═══════════════════════════════════════════════════════════
// ─────────────── Moderation (v1.2.0 / client v13.9) ───────────────
// Powers the desktop app's Admin tab: search players, warn, ban,
// unban. Bans kill every active session immediately (the player is
// logged out everywhere) and block future logins with the reason.
// Warnings are notifications of type "warning" — the player sees
// them in their Notifications tab and the admin panel counts them.
// ═══════════════════════════════════════════════════════════

// GET /admin/users?search= — list players for the moderation panel.
// No search → the 50 most recent accounts. Each row carries the ban
// flag, the admin role and the player's warning count.
adminRouter.get("/users", safeHandler(async (req, res) => {
  // Verify admin
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const rl = await requireRateLimit("general_api", clientIp(req));
  if (rl) return res.status(429).json({ error: rl.error, retryAfter: rl.retryAfter });

  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const rows = search
    ? await prisma.user.findMany({
        where: { username: { contains: search, mode: "insensitive" } },
        orderBy: { created: "desc" },
        take: 50,
      })
    : await prisma.user.findMany({ orderBy: { created: "desc" }, take: 50 });

  // Warning counts come from the notification history (type "warning")
  const warningRows = await prisma.notification.findMany({
    where: { type: "warning" },
    select: { username: true },
  });
  const warningCounts: Record<string, number> = {};
  for (const w of warningRows) warningCounts[w.username] = (warningCounts[w.username] || 0) + 1;

  const users = rows.map((r: any) => ({
    username: r.username,
    admin_role: r.adminRole || "none",
    banned: r.banned || { is_banned: false, reason: "" },
    warnings: warningCounts[r.username] || 0,
    created: r.created instanceof Date ? r.created.toISOString() : r.created,
    last_login: r.lastLogin instanceof Date ? r.lastLogin.toISOString() : r.lastLogin,
  }));
  return res.json({ users, total: users.length });
}));

const moderateSchema = z.object({
  action: z.enum(["ban", "unban", "warn"]),
  username: z.string().min(1).max(20),
  reason: z.string().max(200).optional(),
  message: z.string().max(200).optional(),
});

// POST /admin/moderate — ban / unban / warn a player.
// Guard rails (enforced server-side, mirrored in the client UI):
//   • nobody can moderate their own account
//   • only the top admin can moderate other admins
//   • a ban REQUIRES a reason (shown to the player at login)
//   • a warn REQUIRES a message
adminRouter.post("/moderate", safeHandler(async (req, res) => {
  // Validate origin
  if (!originOk(req, res)) return;

  // Verify admin
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const rl = await requireRateLimit("general_api", clientIp(req));
  if (rl) return res.status(429).json({ error: rl.error, retryAfter: rl.retryAfter });

  const parsed = validateBody(moderateSchema, req.body, res);
  if ("error" in parsed) return;
  const { action, username } = parsed.data;

  if (username === admin) {
    return res.status(400).json({ error: "You cannot moderate your own account." });
  }

  const target = await getUser(username);
  if (!target) return res.status(404).json({ error: "Player not found" });

  // Only the top admin may moderate other admins.
  const targetIsAdmin = target.admin_role === "admin" || target.admin_role === "top_admin";
  if (targetIsAdmin) {
    const requester = await getUser(admin);
    if (requester?.admin_role !== "top_admin") {
      return res.status(403).json({ error: "Only the top admin can moderate other admins." });
    }
  }

  if (action === "ban") {
    const reason = sanitizeString(parsed.data.reason || "", 200);
    if (!reason) return res.status(400).json({ error: "A ban reason is required." });
    target.banned = { is_banned: true, reason } as any;
    const saveResult = await saveUser(username, target);
    if (saveResult.error) return res.status(500).json({ error: "Failed to save ban: " + saveResult.error });
    // Kick EVERY active session - banned means logged out everywhere, now.
    try { await deleteUserSessions(username); } catch {}
    await createNotification(username, "banned", `Your account has been banned. Reason: ${reason}`, admin);
    console.log(`[moderation] ${admin} banned ${username} (${reason})`);
    return res.json({ success: true, action: "ban", username });
  }

  if (action === "unban") {
    target.banned = { is_banned: false, reason: "" } as any;
    const saveResult = await saveUser(username, target);
    if (saveResult.error) return res.status(500).json({ error: "Failed to save unban: " + saveResult.error });
    await createNotification(username, "unbanned", "Your ban has been lifted. You can log in again - welcome back!", admin);
    console.log(`[moderation] ${admin} unbanned ${username}`);
    return res.json({ success: true, action: "unban", username });
  }

  // action === "warn"
  const message = sanitizeString(parsed.data.message || "", 200);
  if (!message) return res.status(400).json({ error: "A warning message is required." });
  await createNotification(username, "warning", `Official warning from the WeildBuild team: ${message}`, admin);
  const notifs = await getNotifications(username);
  const warningCount = notifs.filter((n: any) => n.type === "warning").length;
  console.log(`[moderation] ${admin} warned ${username}: ${message}`);
  return res.json({ success: true, action: "warn", username, warningCount });
}));

// ═══════════════════════════════════════════════════════════
// WeildBuild Main — /admin routes (faithful port of the Next.js
// admin backup + admin cleanup API routes). Backups now dump the
// full Prisma database and upload to Backblaze B2 (was Dropbox).
// ═══════════════════════════════════════════════════════════
import { Router } from "express";
import { prisma } from "../../db/client";
import { runCleanup, trimUserNotificationArrays } from "../../db/data";
import { config } from "../../shared/config";
import { safeHandler } from "../../shared/http";
import { attachUser, requireAdmin } from "../middleware";
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

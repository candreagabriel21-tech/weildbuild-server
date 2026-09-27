// ═══════════════════════════════════════════════════════════
// WeildBuild Main — /reports routes (bug + moderation reports)
// ═══════════════════════════════════════════════════════════
// Metadata lives in Postgres (Report table); attachments go to
// the B2 "reports" bucket. Foundation for the future in-app
// report button.

import { Router } from "express";
import { randomBytes } from "crypto";
import { z } from "zod";
import { prisma } from "../../db/client";
import { requireRateLimit } from "../../db/ratelimits";
import { safeHandler, validateBody } from "../../shared/http";
import { requireAuth, originOk, attachUser } from "../middleware";
import { uploadReportAttachment } from "../../b2/b2";

export const reportsRouter = Router();
reportsRouter.use(attachUser);

const reportSchema = z.object({
  type: z.enum(["bug", "player", "game", "moderation"]),
  targetType: z.enum(["user", "game", "other"]).default("other"),
  targetId: z.string().max(100).default(""),
  content: z.string().min(3, "Please describe the problem").max(2000),
  attachmentBase64: z.string().max(4 * 1024 * 1024).optional(), // ≤ 4MB
  attachmentName: z.string().max(100).optional(),
});

// POST /reports — submit a report (logged-in users only)
reportsRouter.post("/", safeHandler(async (req, res) => {
  if (!originOk(req, res)) return;
  const username = await requireAuth(req, res);
  if (!username) return;

  const rl = await requireRateLimit("create_report", username);
  if (rl) return res.status(429).json({ error: rl.error, retryAfter: rl.retryAfter });

  const parsed = validateBody(reportSchema, req.body, res);
  if ("error" in parsed) return;
  const body = parsed.data;

  const id = randomBytes(8).toString("hex");
  let attachmentKey: string | null = null;

  if (body.attachmentBase64 && body.attachmentName) {
    const upload = await uploadReportAttachment(id, body.attachmentName, body.attachmentBase64);
    if (upload.error) {
      return res.status(503).json({ error: "Could not save the attachment. Try again without it." });
    }
    attachmentKey = upload.key || null;
  }

  await prisma.report.create({
    data: {
      id,
      type: body.type,
      reporter: username,
      targetType: body.targetType,
      targetId: body.targetId,
      content: body.content,
      attachmentKey,
    },
  });

  return res.status(201).json({ success: true, reportId: id });
}));

// GET /reports — admin only: list recent reports
reportsRouter.get("/", safeHandler(async (req, res) => {
  const username = await requireAuth(req, res);
  if (!username) return;
  const { getUser } = await import("../../db/users");
  const user = await getUser(username);
  if (!user || (user.admin_role !== "admin" && user.admin_role !== "top_admin")) {
    return res.status(403).json({ error: "Admin access required." });
  }
  const status = (req.query.status as string) || "open";
  const reports = await prisma.report.findMany({
    where: status === "all" ? {} : { status },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return res.json({
    reports: reports.map((r) => ({
      id: r.id, type: r.type, reporter: r.reporter, targetType: r.targetType,
      targetId: r.targetId, content: r.content, attachmentKey: r.attachmentKey,
      status: r.status, created: r.createdAt.toISOString(),
    })),
  });
}));

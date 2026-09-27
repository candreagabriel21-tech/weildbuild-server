// ═══════════════════════════════════════════════════════════
// WeildBuild Main — /notifications routes (faithful port of the
// Next.js notifications API route). ALL notification actions
// REQUIRE authentication; users can only read/manage their own
// notifications (admins may create for anyone).
// ═══════════════════════════════════════════════════════════
import { Router, Request } from "express";
import { z } from "zod";
import { getNotifications, markNotificationsRead, createNotification } from "../../db/data";
import { getUser } from "../../db/users";
import { requireRateLimit } from "../../db/ratelimits";
import { safeHandler, validateBody, clientIp } from "../../shared/http";
import { attachUser, requireAuth, originOk } from "../middleware";

export const notificationsRouter = Router();

// Attach req.authUser (session identity) for every request
notificationsRouter.use(attachUser);

const notificationActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("markRead"), username: z.string().min(1) }),
  z.object({
    action: z.literal("create"),
    username: z.string().min(1),
    type: z.string().min(1),
    message: z.string().min(1).max(500),
    from: z.string().optional(),
  }),
]);

/** Read a single string query param (empty string counts as absent). */
function qp(req: Request, name: string): string | null {
  const v = req.query[name];
  return typeof v === "string" && v.length > 0 ? v : null;
}

// GET /notifications — Read notifications. REQUIRES authentication.
notificationsRouter.get("/", safeHandler(async (req, res) => {
  const rl = await requireRateLimit("general_api", clientIp(req));
  if (rl) return res.status(429).json({ error: rl.error, retryAfter: rl.retryAfter });

  const username = qp(req, "username");
  if (!username) return res.status(400).json({ error: "Username required" });

  // REQUIRE authentication — users can only read their own notifications
  const sessionUser = await requireAuth(req, res);
  if (!sessionUser) return;

  if (sessionUser !== username) {
    return res.status(403).json({ error: "Not authorized." });
  }

  const notifications = await getNotifications(username);
  return res.json(notifications);
}));

// POST /notifications — Notification actions. REQUIRES authentication.
notificationsRouter.post("/", safeHandler(async (req, res) => {
  // Validate origin
  if (!originOk(req, res)) return;

  // REQUIRE authentication
  const sessionUser = await requireAuth(req, res);
  if (!sessionUser) return;

  // Validate with Zod
  const parsed = validateBody(notificationActionSchema, req.body, res);
  if ("error" in parsed) return;
  const body = parsed.data;

  if (body.action === "markRead") {
    // Can only mark your own notifications as read
    if (sessionUser !== body.username) {
      return res.status(403).json({ error: "Not authorized." });
    }

    await markNotificationsRead(body.username);
    return res.json({ success: true });
  }

  if (body.action === "create") {
    // System notifications should only be created by the server internally.
    // For now, only allow users to create notifications for themselves
    // (e.g., testing). Admins can create for anyone.
    const requester = await getUser(sessionUser);
    const isAdmin = requester?.admin_role === "admin" || requester?.admin_role === "top_admin";

    if (!isAdmin && sessionUser !== body.username) {
      return res.status(403).json({ error: "You can only create notifications for yourself." });
    }

    const notification = await createNotification(body.username, body.type, body.message, body.from);
    return res.status(201).json(notification);
  }

  return res.status(400).json({ error: "Unknown action" });
}));

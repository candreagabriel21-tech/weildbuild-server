// ═══════════════════════════════════════════════════════════
// WeildBuild Main — /friends routes (faithful port of the Next.js
// friends API route). ALL friend actions REQUIRE authentication;
// the server determines identity from the session, NEVER from the
// request body alone.
// ═══════════════════════════════════════════════════════════
import { Router, Request } from "express";
import { z } from "zod";
import {
  getUser, saveUser, searchUsers, stripSensitiveFields, sanitizeString,
} from "../../db/users";
import {
  sendFriendRequest, acceptFriendRequest, declineFriendRequest,
  removeFriend, cancelFriendRequest, saveDMMessage, getDMMessages,
} from "../../db/data";
import { requireRateLimit } from "../../db/ratelimits";
import { safeHandler, validateBody, clientIp } from "../../shared/http";
import { attachUser, requireAuth, originOk } from "../middleware";

export const friendsRouter = Router();

// Attach req.authUser (session identity) for every request
friendsRouter.use(attachUser);

const friendActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("request"), from: z.string().min(1), to: z.string().min(1) }),
  z.object({ action: z.literal("cancel"), from: z.string().min(1), to: z.string().min(1) }),
  z.object({ action: z.literal("accept"), username: z.string().min(1), friend: z.string().min(1) }),
  z.object({ action: z.literal("decline"), username: z.string().min(1), friend: z.string().min(1) }),
  z.object({ action: z.literal("remove"), username: z.string().min(1), friend: z.string().min(1) }),
  z.object({ action: z.literal("block"), username: z.string().min(1), target: z.string().min(1) }),
  z.object({ action: z.literal("unblock"), username: z.string().min(1), target: z.string().min(1) }),
  z.object({
    action: z.literal("send_message"),
    from: z.string().min(1),
    to: z.string().min(1),
    content: z.string().min(1).max(1000),
  }),
]);

/** Read a single string query param (empty string counts as absent). */
function qp(req: Request, name: string): string | null {
  const v = req.query[name];
  return typeof v === "string" && v.length > 0 ? v : null;
}

// GET /friends — read friend data. REQUIRES authentication for own data.
friendsRouter.get("/", safeHandler(async (req, res) => {
  const rl = await requireRateLimit("general_api", clientIp(req));
  if (rl) return res.status(429).json({ error: rl.error, retryAfter: rl.retryAfter });

  const username = qp(req, "username");
  const searchQuery = qp(req, "search");
  const action = qp(req, "action");
  const user1 = qp(req, "user1");
  const user2 = qp(req, "user2");

  // Get DM messages — REQUIRES authentication
  if (action === "get_messages" && user1 && user2) {
    const sessionUser = await requireAuth(req, res);
    if (!sessionUser) return;

    // Only allow reading your own messages
    if (sessionUser !== user1 && sessionUser !== user2) {
      return res.status(403).json({ error: "Not authorized." });
    }

    const messages = await getDMMessages(user1, user2);
    return res.json(messages);
  }

  // Search users — public
  if (searchQuery) {
    const results = await searchUsers(searchQuery);
    return res.json(results);
  }

  // Get friend list — REQUIRES authentication
  if (username) {
    const sessionUser = await requireAuth(req, res);
    if (!sessionUser) return;

    // Only allow reading your own friend data
    if (sessionUser !== username) {
      return res.status(403).json({ error: "Not authorized." });
    }

    const user = await getUser(username);
    if (!user) return res.status(404).json({ error: "User not found" });
    const safe = stripSensitiveFields(user);
    return res.json({
      friends: safe.friends || [],
      friend_requests: safe.friend_requests || [],
    });
  }

  return res.status(400).json({ error: "Username or search required" });
}));

// POST /friends — ALL friend actions. REQUIRES authentication.
friendsRouter.post("/", safeHandler(async (req, res) => {
  // Validate origin
  if (!originOk(req, res)) return;

  // REQUIRE authentication — NO SOFT CHECKS
  const sessionUser = await requireAuth(req, res);
  if (!sessionUser) return;

  // Validate with Zod
  const parsed = validateBody(friendActionSchema, req.body, res);
  if ("error" in parsed) return;
  const body = parsed.data;

  switch (body.action) {
    case "request": {
      // CRITICAL: "from" MUST match the session user
      if (body.from !== sessionUser) {
        return res.status(403).json({ error: "You can only send requests as yourself." });
      }
      const rl = await requireRateLimit("general_api", sessionUser);
      if (rl) return res.status(429).json({ error: rl.error, retryAfter: rl.retryAfter });

      const result = await sendFriendRequest(body.from, body.to);
      if (result.error) return res.status(400).json(result);
      return res.json({ success: true });
    }

    case "cancel": {
      if (body.from !== sessionUser) {
        return res.status(403).json({ error: "You can only cancel your own requests." });
      }
      const result = await cancelFriendRequest(body.from, body.to);
      if (result.error) return res.status(400).json(result);
      return res.json({ success: true });
    }

    case "accept": {
      if (body.username !== sessionUser) {
        return res.status(403).json({ error: "You can only accept your own friend requests." });
      }
      const result = await acceptFriendRequest(body.username, body.friend);
      if (result.error) return res.status(400).json(result);
      const user = await getUser(body.username);
      return res.json({ success: true, user: stripSensitiveFields(user) });
    }

    case "decline": {
      if (body.username !== sessionUser) {
        return res.status(403).json({ error: "You can only decline your own friend requests." });
      }
      const result = await declineFriendRequest(body.username, body.friend);
      if (result.error) return res.status(400).json(result);
      const user = await getUser(body.username);
      return res.json({ success: true, user: stripSensitiveFields(user) });
    }

    case "remove": {
      if (body.username !== sessionUser) {
        return res.status(403).json({ error: "You can only remove your own friends." });
      }
      const result = await removeFriend(body.username, body.friend);
      if (result.error) return res.status(400).json(result);
      const user = await getUser(body.username);
      return res.json({ success: true, user: stripSensitiveFields(user) });
    }

    case "block": {
      if (body.username !== sessionUser) {
        return res.status(403).json({ error: "You can only block users for yourself." });
      }
      const user = await getUser(body.username);
      const targetUser = await getUser(body.target);
      if (!user) return res.status(404).json({ error: "User not found" });
      if (!user.blocked_users) user.blocked_users = [];
      if (!user.blocked_users.includes(body.target)) user.blocked_users.push(body.target);
      user.friends = (user.friends || []).filter((f: string) => f !== body.target);
      user.friend_requests = (user.friend_requests || []).filter((f: string) => f !== body.target);
      await saveUser(body.username, user);
      if (targetUser) {
        targetUser.friends = (targetUser.friends || []).filter((f: string) => f !== body.username);
        targetUser.friend_requests = (targetUser.friend_requests || []).filter((f: string) => f !== body.username);
        await saveUser(body.target, targetUser);
      }
      return res.json({ success: true, user: stripSensitiveFields(user) });
    }

    case "unblock": {
      if (body.username !== sessionUser) {
        return res.status(403).json({ error: "You can only unblock users for yourself." });
      }
      const user = await getUser(body.username);
      if (!user) return res.status(404).json({ error: "User not found" });
      user.blocked_users = (user.blocked_users || []).filter((f: string) => f !== body.target);
      await saveUser(body.username, user);
      return res.json({ success: true, user: stripSensitiveFields(user) });
    }

    case "send_message": {
      if (body.from !== sessionUser) {
        return res.status(403).json({ error: "You can only send messages as yourself." });
      }
      // Rate limit messages
      const rl = await requireRateLimit("send_message", sessionUser);
      if (rl) return res.status(429).json({ error: rl.error, retryAfter: rl.retryAfter });

      // Check if the recipient has blocked the sender
      const recipient = await getUser(body.to);
      if (recipient && (recipient.blocked_users || []).includes(body.from)) {
        return res.status(403).json({ error: "Cannot send message to this user." });
      }

      const sanitizedContent = sanitizeString(body.content, 1000);
      const message = await saveDMMessage(body.from, body.to, sanitizedContent);
      return res.json({ success: true, message });
    }

    default:
      return res.status(400).json({ error: "Unknown action" });
  }
}));

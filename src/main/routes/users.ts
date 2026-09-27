// ═══════════════════════════════════════════════════════════
// WeildBuild Main — /users routes (faithful port of the Next.js
// users API route: public search / Object-Key lookup / public
// profiles, plus an authenticated paginated user listing)
// ═══════════════════════════════════════════════════════════
import { Router, Request } from "express";
import { z } from "zod";
import {
  getAllUsers, getUser, getUserByKey, saveUser, searchUsers,
  stripSensitiveFields, filterUserUpdates,
} from "../../db/users";
import { requireRateLimit } from "../../db/ratelimits";
import { safeHandler, validateBody, clientIp } from "../../shared/http";
import { attachUser, requireAuth, requireSelfOrAdmin, originOk } from "../middleware";

export const usersRouter = Router();

// Attach req.authUser (session identity) for every request
usersRouter.use(attachUser);

const updateUserSchema = z.object({
  username: z.string().min(1),
}).passthrough(); // Allow additional fields, they'll be filtered by filterUserUpdates

/** Read a single string query param (empty string counts as absent, matching searchParams.get + truthiness). */
function qp(req: Request, name: string): string | null {
  const v = req.query[name];
  return typeof v === "string" && v.length > 0 ? v : null;
}

// GET /users — ?search= | ?key=USER-XXXX | ?username= | paginated listing (auth)
usersRouter.get("/", safeHandler(async (req, res) => {
  const username = qp(req, "username");
  const userKey = qp(req, "key");
  const searchQuery = qp(req, "search");

  // Search users — public endpoint, rate limited
  if (searchQuery) {
    const rl = await requireRateLimit("general_api", clientIp(req));
    if (rl) return res.status(429).json({ error: rl.error, retryAfter: rl.retryAfter });

    const results = await searchUsers(searchQuery);
    return res.json(results);
  }

  // ─── KEY-PROTOCOL: Look up user by Object Key (USER-1, USER-2, etc.) ───
  if (userKey) {
    const rl = await requireRateLimit("general_api", clientIp(req));
    if (rl) return res.status(429).json({ error: rl.error, retryAfter: rl.retryAfter });

    const user = await getUserByKey(userKey);
    if (!user) return res.status(404).json({ error: "User not found" });
    return res.json(stripSensitiveFields(user));
  }

  // Get specific user — public profile, rate limited
  if (username) {
    const rl = await requireRateLimit("general_api", clientIp(req));
    if (rl) return res.status(429).json({ error: rl.error, retryAfter: rl.retryAfter });

    const user = await getUser(username);
    if (!user) return res.status(404).json({ error: "User not found" });
    return res.json(stripSensitiveFields(user));
  }

  // List all users — REQUIRE authentication + pagination
  // No more dumping the entire user database to anyone who asks
  const authResult = await requireAuth(req, res);
  if (!authResult) return;

  const page = parseInt(qp(req, "page") || "1", 10);
  const limit = Math.min(parseInt(qp(req, "limit") || "20", 10), 100);
  const offset = (page - 1) * limit;

  const allUsers = (await getAllUsers()).map((u: any) => stripSensitiveFields(u));
  const paginated = allUsers.slice(offset, offset + limit);

  return res.json({
    users: paginated,
    total: allUsers.length,
    page,
    limit,
    hasMore: offset + limit < allUsers.length,
  });
}));

// PUT /users — update own profile (or admin). Identity via session.
usersRouter.put("/", safeHandler(async (req, res) => {
  // Validate origin
  if (!originOk(req, res)) return;

  // Rate limit
  const rl = await requireRateLimit("update_user", clientIp(req));
  if (rl) return res.status(429).json({ error: rl.error, retryAfter: rl.retryAfter });

  // Validate with Zod
  const parsed = validateBody(updateUserSchema, req.body, res);
  if ("error" in parsed) return;
  const body = parsed.data;

  const { username } = body;

  // REQUIRE: user must be authenticated as themselves or admin
  const authResult = await requireSelfOrAdmin(req, res, username);
  if (!authResult) return;

  const user = await getUser(username);
  if (!user) return res.status(404).json({ error: "User not found" });

  // Check if requester is admin for admin-only fields
  const requester = await getUser(authResult);
  const isAdmin = requester?.admin_role === "admin" || requester?.admin_role === "top_admin";

  // Filter updates — only allow specific fields
  const filteredUpdates = filterUserUpdates(body, isAdmin);

  const updated = { ...user, ...filteredUpdates };
  await saveUser(username, updated);
  return res.json(stripSensitiveFields(updated));
}));

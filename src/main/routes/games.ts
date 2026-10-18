// ═══════════════════════════════════════════════════════════
// WeildBuild Main — /games routes (faithful port of the Next.js
// games API route). Creating/updating games REQUIRES auth; the
// creator is ALWAYS determined from the session, never from the
// request body.
// ═══════════════════════════════════════════════════════════
import { Router, Request } from "express";
import { z } from "zod";
import {
  getAllGames, getGame, createGameRecord, updateGameRecord,
} from "../../db/data";
import { getUser, sanitizeString } from "../../db/users";
import { requireRateLimit } from "../../db/ratelimits";
import { safeHandler, validateBody, clientIp } from "../../shared/http";
import { attachUser, requireAuth, originOk } from "../middleware";

export const gamesRouter = Router();

// Attach req.authUser (session identity) for every request
gamesRouter.use(attachUser);

const createGameSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  description: z.string().max(200).optional(),
}).passthrough();

const updateGameSchema = z.object({
  id: z.string().min(1),
  name: z.string().max(50).optional(),
  description: z.string().max(200).optional(),
}).passthrough();

/** Read a single string query param (empty string counts as absent). */
function qp(req: Request, name: string): string | null {
  const v = req.query[name];
  return typeof v === "string" && v.length > 0 ? v : null;
}

// GET /games — public endpoint (game browsing)
gamesRouter.get("/", safeHandler(async (req, res) => {
  const rl = await requireRateLimit("general_api", clientIp(req));
  if (rl) return res.status(429).json({ error: rl.error, retryAfter: rl.retryAfter });

  const id = qp(req, "id");
  if (id) {
    const game = await getGame(id);
    if (!game) return res.status(404).json({ error: "Game not found" });
    return res.json(game);
  }
  const games = await getAllGames();
  return res.json(games);
}));

// POST /games — Create game. REQUIRES authentication.
gamesRouter.post("/", safeHandler(async (req, res) => {
  // Validate origin
  if (!originOk(req, res)) return;

  // Rate limit game creation
  const rl = await requireRateLimit("create_game", clientIp(req));
  if (rl) return res.status(429).json({ error: rl.error, retryAfter: rl.retryAfter });

  // REQUIRE authentication
  const sessionUser = await requireAuth(req, res);
  if (!sessionUser) return;

  // Validate with Zod
  const parsed = validateBody(createGameSchema, req.body, res);
  if ("error" in parsed) return;
  const body = parsed.data;

  const gameData: any = { ...body };
  if (gameData.name) gameData.name = sanitizeString(gameData.name, 50);
  if (gameData.description) gameData.description = sanitizeString(gameData.description, 200);

  // CRITICAL: Creator is ALWAYS from the session, NEVER from request body
  // The server decides who created the game, not the client
  gameData.creator = sessionUser;

  const game = await createGameRecord(gameData);
  return res.status(201).json(game);
}));

// PUT /games — Update game. REQUIRES authentication + ownership or admin.
gamesRouter.put("/", safeHandler(async (req, res) => {
  // Validate origin
  if (!originOk(req, res)) return;

  // Rate limit
  const rl = await requireRateLimit("general_api", clientIp(req));
  if (rl) return res.status(429).json({ error: rl.error, retryAfter: rl.retryAfter });

  // REQUIRE authentication
  const sessionUser = await requireAuth(req, res);
  if (!sessionUser) return;

  // Validate with Zod
  const parsed = validateBody(updateGameSchema, req.body, res);
  if ("error" in parsed) return;
  const body = parsed.data;

  const id = body.id;
  const updates: any = { ...body };
  delete updates.id;
  if (!id) return res.status(400).json({ error: "Game ID required" });

  // Verify the user is the creator or admin
  const existingGame = await getGame(id);
  if (!existingGame) return res.status(404).json({ error: "Game not found" });

  if (existingGame.creator !== sessionUser) {
    // Check admin status
    const user = await getUser(sessionUser);
    if (!user || (user.admin_role !== "admin" && user.admin_role !== "top_admin")) {
      return res.status(403).json({ error: "You can only update your own games." });
    }
  }

  // Sanitize updates
  if (updates.name) updates.name = sanitizeString(updates.name, 50);
  if (updates.description) updates.description = sanitizeString(updates.description, 200);

  // Never allow changing the creator through an update
  delete updates.creator;

  const game = await updateGameRecord(id, updates);
  if (!game) return res.status(404).json({ error: "Game not found" });
  return res.json(game);
}));

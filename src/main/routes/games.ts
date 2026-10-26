// ═══════════════════════════════════════════════════════════
// WeildBuild Main — /games routes (faithful port of the Next.js
// games API route). Creating/updating games REQUIRES auth; the
// creator is ALWAYS determined from the session, never from the
// request body.
// ═══════════════════════════════════════════════════════════
import { Router, Request } from "express";
import { z } from "zod";
import {
  getAllGames, getGame, createGameRecord, updateGameRecord, deleteGameRecord,
} from "../../db/data";
import { getUser, sanitizeString, isGuestUser } from "../../db/users";
import { requireRateLimit } from "../../db/ratelimits";
import { safeHandler, validateBody, clientIp } from "../../shared/http";
import { attachUser, requireAuth, originOk } from "../middleware";
import {
  bufferFromBase64,
  isValidWbworldBuffer,
  WORLD_MAX_BYTES,
} from "../../shared/wbworld";

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

/** 1.4.6: validate + cap the auto-generated side-view thumbnail (a JPEG
 * data URL produced by the studio when a game is saved). Rejects anything
 * that isn't a small image data URL so extra_data can't be abused as a
 * arbitrary blob store. */
const THUMBNAIL_MAX_CHARS = 300_000; // ~220KB JPEG at base64
function sanitizeThumbnail(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") return undefined;
  if (!/^data:image\/(jpeg|png);base64,/.test(value)) return undefined;
  if (value.length > THUMBNAIL_MAX_CHARS) return undefined;
  return value;
}

/** v1.1: validate the encrypted .wbworld blob (base64) a publish carries.
 * Checks: is a string, decodes as strict base64, has the WBWD1 header +
 * version, and stays under WORLD_MAX_BYTES decoded. Returns the cleaned
 * string, or undefined to DROP it (the game row is still created - it just
 * has no world until the next successful publish). */
const WORLD_B64_MAX_CHARS = 6_000_000; // > 4MB decoded (4/3 inflation)
function sanitizeWorldB64(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length === 0) return undefined;
  if (value.length > WORLD_B64_MAX_CHARS) return undefined;
  const buf = bufferFromBase64(value);
  if (!buf || !isValidWbworldBuffer(buf)) return undefined;
  if (buf.length > WORLD_MAX_BYTES) return undefined;
  return value;
}

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

  // v1.9.2 GUEST GUARD: guests can build and play, but never publish.
  if (await isGuestUser(sessionUser)) {
    return res.status(403).json({ error: "Guests can't publish games. Create a free account to publish your worlds!" });
  }

  // Validate with Zod
  const parsed = validateBody(createGameSchema, req.body, res);
  if ("error" in parsed) return;
  const body = parsed.data;

  const gameData: any = { ...body };
  if (gameData.name) gameData.name = sanitizeString(gameData.name, 50);
  if (gameData.description) gameData.description = sanitizeString(gameData.description, 200);
  // 1.4.6: side-view thumbnail (studio-generated) - validate or drop
  const thumb = sanitizeThumbnail(gameData.thumbnail);
  if (thumb) gameData.thumbnail = thumb; else delete gameData.thumbnail;
  // v1.1: encrypted .wbworld world blob - validate or drop
  const world = sanitizeWorldB64(gameData.world_b64);
  if (world) gameData.world_b64 = world; else delete gameData.world_b64;

  // CRITICAL: Creator is ALWAYS from the session, NEVER from request body
  // The server decides who created the game, not the client
  gameData.creator = sessionUser;

  // v1.4: every PUBLISHED game is PUBLIC. Private work lives on the
  // player's device (the studio's local drafts) and never reaches this
  // server at all - so the flag is forced true no matter what the client
  // sent (older clients may still carry the old toggle).
  gameData.public = true;

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

  // v1.9.2 GUEST GUARD: guests own no games (they can't create any), but
  // the rule is enforced here too so the API is consistent on its own.
  if (await isGuestUser(sessionUser)) {
    return res.status(403).json({ error: "Guests can't publish games. Create a free account to publish your worlds!" });
  }

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
  // 1.4.6: side-view thumbnail (studio-generated) - validate or drop
  const thumbUpd = sanitizeThumbnail(updates.thumbnail);
  if (thumbUpd) updates.thumbnail = thumbUpd; else delete updates.thumbnail;
  // v1.1: encrypted .wbworld world blob - validate or drop
  const worldUpd = sanitizeWorldB64(updates.world_b64);
  if (worldUpd) updates.world_b64 = worldUpd; else delete updates.world_b64;

  // Never allow changing the creator through an update
  delete updates.creator;
  // v1.4: published games are always public (see POST above).
  updates.public = true;

  const game = await updateGameRecord(id, updates);
  if (!game) return res.status(404).json({ error: "Game not found" });
  return res.json(game);
}));

// DELETE /games?id= — v1.4: creator or admin only (same permission model
// as PUT above). Removes the game row and any running instance rows.
gamesRouter.delete("/", safeHandler(async (req, res) => {
  if (!originOk(req, res)) return;

  const rl = await requireRateLimit("general_api", clientIp(req));
  if (rl) return res.status(429).json({ error: rl.error, retryAfter: rl.retryAfter });

  const sessionUser = await requireAuth(req, res);
  if (!sessionUser) return;

  const id = qp(req, "id");
  if (!id) return res.status(400).json({ error: "Game ID required" });
  // v1.9.2 GUEST GUARD (guests own no games; enforced for consistency)
  if (await isGuestUser(sessionUser)) {
    return res.status(403).json({ error: "Guests can't publish games. Create a free account to publish your worlds!" });
  }
  // Path-traversal guard (same as getGame)
  if (id.includes("..") || id.includes("/") || id.includes("\\")) {
    return res.status(400).json({ error: "Invalid game ID" });
  }

  const existingGame = await getGame(id);
  if (!existingGame) return res.status(404).json({ error: "Game not found" });

  if (existingGame.creator !== sessionUser) {
    const user = await getUser(sessionUser);
    if (!user || (user.admin_role !== "admin" && user.admin_role !== "top_admin")) {
      return res.status(403).json({ error: "You can only delete your own games." });
    }
  }

  const ok = await deleteGameRecord(id);
  if (!ok) return res.status(500).json({ error: "Failed to delete game" });
  return res.json({ success: true, id });
}));

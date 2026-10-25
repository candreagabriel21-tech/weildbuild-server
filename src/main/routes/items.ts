// ═══════════════════════════════════════════════════════════
// WeildBuild Main — /items routes (faithful port of the Next.js
// items API route). Buying items REQUIRES authentication; the
// server is the SOLE AUTHORITY on WeBuy balances (atomic purchase,
// transaction logging).
// ═══════════════════════════════════════════════════════════
import { Router, Request } from "express";
import { z } from "zod";
import { getUser, stripSensitiveFields } from "../../db/users";
import { getAllItems, getItemsByType, getItem, buyItemAtomic, logTransaction } from "../../db/data";
import { requireRateLimit } from "../../db/ratelimits";
import { safeHandler, validateBody, clientIp } from "../../shared/http";
import { attachUser, requireAuth, originOk } from "../middleware";

export const itemsRouter = Router();

// Attach req.authUser (session identity) for every request
itemsRouter.use(attachUser);

const buyItemSchema = z.object({
  username: z.string().min(1),
  itemId: z.string().min(1).max(50),
});

/** Read a single string query param (empty string counts as absent). */
function qp(req: Request, name: string): string | null {
  const v = req.query[name];
  return typeof v === "string" && v.length > 0 ? v : null;
}

// GET /items — public endpoint (catalog browsing)
itemsRouter.get("/", safeHandler(async (req, res) => {
  const rl = await requireRateLimit("general_api", clientIp(req));
  if (rl) return res.status(429).json({ error: rl.error, retryAfter: rl.retryAfter });

  const type = qp(req, "type");
  const id = qp(req, "id");

  if (id) {
    const item = await getItem(id);
    if (!item) return res.status(404).json({ error: "Item not found" });
    return res.json(item);
  }

  const items = type ? await getItemsByType(type) : await getAllItems();
  return res.json(items);
}));

// POST /items — Buy item. REQUIRES authentication.
// The server is the SOLE AUTHORITY on WeBuy balances.
itemsRouter.post("/", safeHandler(async (req, res) => {
  // Validate origin
  if (!originOk(req, res)) return;

  // Rate limit purchases
  const rl = await requireRateLimit("buy_item", clientIp(req));
  if (rl) return res.status(429).json({ error: rl.error, retryAfter: rl.retryAfter });

  // REQUIRE authentication
  const sessionUser = await requireAuth(req, res);
  if (!sessionUser) return;

  // Validate with Zod
  const parsed = validateBody(buyItemSchema, req.body, res);
  if ("error" in parsed) return;
  const { username, itemId } = parsed.data;

  // CRITICAL: User can only buy items for THEMSELVES
  // The server determines who is buying from the session, not from the request body
  if (username !== sessionUser) {
    return res.status(403).json({ error: "You can only buy items for yourself." });
  }

  const user = await getUser(username);
  const item = await getItem(itemId);
  if (!user || !item) return res.status(404).json({ error: "Not found" });

  if ((user.items_owned || []).includes(itemId)) {
    return res.status(400).json({ error: "Already owned" });
  }

  if ((user.webuy || 0) < (item.price || 0)) {
    return res.status(400).json({ error: "Not enough WeBuy" });
  }

  // Server-authoritative balance deduction — one atomic conditional
  // UPDATE, race-condition safe (no double-spend / double-append).
  const result = await buyItemAtomic(username, itemId);
  if ("error" in result) {
    // Lost the race (or a concurrent purchase changed the balance)
    return res.status(400).json({ error: result.error });
  }

  // LOG the transaction for audit trail
  if (item.price > 0) {
    await logTransaction({
      type: "purchase",
      username,
      itemId,
      amount: item.price,
      balanceBefore: result.balanceBefore,
      balanceAfter: result.balanceAfter,
      description: `Purchased ${item.display_name || itemId}`,
      performedBy: sessionUser,
    });
  }

  const updatedUser = await getUser(username);
  if (!updatedUser) return res.status(500).json({ error: "An internal error occurred. Please try again later." });
  return res.json({ success: true, user: stripSensitiveFields(updatedUser) });
}));

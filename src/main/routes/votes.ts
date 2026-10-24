// ═══════════════════════════════════════════════════════════
// WeildBuild Main — /votes routes (the "Vote" page, v1.9.1)
// ═══════════════════════════════════════════════════════════
// Update ideas posted by admins + anonymous Yes/No votes from
// every player:
//   • GET  /votes          — list ideas with yes/no counts and
//                            YOUR current vote (so the buttons
//                            can toggle). No voter names, ever.
//   • POST /votes          — create an idea (admins only)
//   • POST /votes/vote     — cast/change/remove your vote
//                            (value: 1 = Yes, -1 = No, 0 = remove)
//   • DELETE /votes/:id    — delete an idea (its creator admin,
//                            or the top admin)
//
// ANONYMITY: the API only ever returns aggregate counts plus the
// CALLER's own vote. There is no endpoint that reveals who voted
// what - not even for admins.

import { Router } from "express";
import { randomBytes } from "crypto";
import { z } from "zod";
import { prisma } from "../../db/client";
import { requireRateLimit } from "../../db/ratelimits";
import { sanitizeString } from "../../db/users";
import { safeHandler, validateBody, clientIp } from "../../shared/http";
import { attachUser, requireAuth, requireAdmin, originOk } from "../middleware";

export const votesRouter = Router();

// Attach req.authUser (session identity) for every request
votesRouter.use(attachUser);

/** Shape returned to the client for one idea. */
function ideaShape(row: { id: string; title: string; message: string; createdBy: string; closed: boolean; createdAt: Date },
                   yes: number, no: number, myVote: number) {
  return {
    id: row.id,
    title: row.title,
    message: row.message,
    createdBy: row.createdBy,
    closed: row.closed,
    createdAt: row.createdAt.toISOString(),
    yes,
    no,
    myVote, // 1 | -1 | 0 — only ever YOUR OWN vote
  };
}

// GET /votes — the public list. Works logged-out too (you just
// don't get myVote / can't vote).
votesRouter.get("/", safeHandler(async (req, res) => {
  const rl = await requireRateLimit("general_api", clientIp(req));
  if (rl) return res.status(429).json({ error: rl.error, retryAfter: rl.retryAfter });

  const ideas = await prisma.voteIdea.findMany({ orderBy: { createdAt: "desc" }, take: 100 });
  if (ideas.length === 0) return res.json([]);

  // Aggregate counts in one query per table (no N+1).
  const votes = await prisma.voteVote.findMany({
    where: { ideaId: { in: ideas.map((i) => i.id) } },
    select: { ideaId: true, username: true, value: true },
  });
  const counts = new Map<string, { yes: number; no: number }>();
  for (const v of votes) {
    const c = counts.get(v.ideaId) || { yes: 0, no: 0 };
    if (v.value === 1) c.yes += 1;
    else if (v.value === -1) c.no += 1;
    counts.set(v.ideaId, c);
  }

  const me = (req as any).authUser as string | null;
  const mine = new Map<string, number>();
  if (me) {
    for (const v of votes) {
      if (v.username === me) mine.set(v.ideaId, v.value);
    }
  }

  return res.json(ideas.map((row) => {
    const c = counts.get(row.id) || { yes: 0, no: 0 };
    return ideaShape(row, c.yes, c.no, mine.get(row.id) || 0);
  }));
}));

// POST /votes — create an update idea (admins only).
const createIdeaSchema = z.object({
  title: z.string().min(1).max(100),
  message: z.string().min(1).max(2000),
});

votesRouter.post("/", safeHandler(async (req, res) => {
  if (!originOk(req, res)) return;

  const rl = await requireRateLimit("create_game", clientIp(req));
  if (rl) return res.status(429).json({ error: rl.error, retryAfter: rl.retryAfter });

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const parsed = validateBody(createIdeaSchema, req.body, res);
  if ("error" in parsed) return;
  const { title, message } = parsed.data;

  const row = await prisma.voteIdea.create({
    data: {
      id: `idea-${randomBytes(6).toString("hex")}`,
      title: sanitizeString(title, 100),
      message: sanitizeString(message, 2000),
      createdBy: admin,
    },
  });

  console.log(`[votes] ${admin} posted idea "${row.title}" (${row.id})`);
  return res.json({ success: true, idea: ideaShape(row, 0, 0, 0) });
}));

// POST /votes/vote — cast, change or remove YOUR vote on one idea.
// value: 1 = Yes, -1 = No, 0 = remove my vote.
const voteSchema = z.object({
  ideaId: z.string().min(1).max(50),
  value: z.union([z.literal(1), z.literal(-1), z.literal(0)]),
});

votesRouter.post("/vote", safeHandler(async (req, res) => {
  if (!originOk(req, res)) return;

  const rl = await requireRateLimit("send_message", clientIp(req));
  if (rl) return res.status(429).json({ error: rl.error, retryAfter: rl.retryAfter });

  const username = await requireAuth(req, res);
  if (!username) return;

  const parsed = validateBody(voteSchema, req.body, res);
  if ("error" in parsed) return;
  const { ideaId, value } = parsed.data;

  const idea = await prisma.voteIdea.findUnique({ where: { id: ideaId } });
  if (!idea) return res.status(404).json({ error: "That idea no longer exists." });

  if (value === 0) {
    // Remove my vote (clicking the highlighted thumb again)
    await prisma.voteVote.deleteMany({ where: { ideaId, username } });
  } else {
    // Upsert: switching Yes<->No or voting for the first time is the
    // same atomic operation - one vote per player per idea, always.
    await prisma.voteVote.upsert({
      where: { ideaId_username: { ideaId, username } },
      create: { id: `${ideaId}:${username}`, ideaId, username, value },
      update: { value, timestamp: new Date() },
    });
  }

  // Return fresh counts (anonymity: counts only + my own vote).
  const votes = await prisma.voteVote.findMany({ where: { ideaId }, select: { username: true, value: true } });
  let yes = 0, no = 0, myVote = 0;
  for (const v of votes) {
    if (v.value === 1) yes += 1;
    else if (v.value === -1) no += 1;
    if (v.username === username) myVote = v.value;
  }
  return res.json({ success: true, yes, no, myVote });
}));

// DELETE /votes/:id — remove an idea (its creator, or the top admin).
votesRouter.delete("/:id", safeHandler(async (req, res) => {
  if (!originOk(req, res)) return;

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const id = String(req.params.id || "");
  const idea = await prisma.voteIdea.findUnique({ where: { id } });
  if (!idea) return res.status(404).json({ error: "Idea not found." });

  // The creator may delete their own idea; only the top admin may
  // delete anyone's.
  if (idea.createdBy !== admin) {
    const me = await prisma.user.findUnique({ where: { username: admin } });
    if (me?.adminRole !== "top_admin") {
      return res.status(403).json({ error: "Only the top admin can delete another admin's idea." });
    }
  }

  await prisma.voteVote.deleteMany({ where: { ideaId: id } });
  await prisma.voteIdea.delete({ where: { id } });
  console.log(`[votes] ${admin} deleted idea "${idea.title}" (${id})`);
  return res.json({ success: true });
}));

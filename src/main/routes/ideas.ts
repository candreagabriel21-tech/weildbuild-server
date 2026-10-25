// ═══════════════════════════════════════════════════════════
// WeildBuild Main — /ideas routes (the "Votes" page, v1.11.0)
// ═══════════════════════════════════════════════════════════
// Players post feature ideas for WeildBuild and upvote each
// other's ideas. Admins answer with a STATUS (Approved /
// Considering / Not Approved / Already Planned) and may set a
// CLOSE DATE after which nobody can vote on that idea anymore.
//
//   GET    /api/ideas        list ideas (public — guests browse too;
//                            logged-in sessions also get their own
//                            "voted" flag per idea)
//   POST   /api/ideas        create an idea (login required,
//                            max 5 ideas per account)
//   POST   /api/ideas/vote   toggle my upvote on an idea (login
//                            required; rejected once voting closed)
//   PATCH  /api/ideas        ADMIN ONLY: set status and/or close
//                            date, or remove an idea entirely
import { Router } from "express";
import { z } from "zod";
import { randomBytes } from "crypto";
import { prisma } from "../../db/client";
import { requireRateLimit } from "../../db/ratelimits";
import { sanitizeString } from "../../db/users";
import { safeHandler, validateBody } from "../../shared/http";
import { attachUser, requireAuth, requireAdmin, originOk } from "../middleware";

export const ideasRouter = Router();

// Attach req.authUser (session identity) for every request
ideasRouter.use(attachUser);

/** The statuses an admin can set on an idea. */
export const IDEA_STATUSES = ["open", "approved", "considering", "not_approved", "already_planned"] as const;
export type IdeaStatus = (typeof IDEA_STATUSES)[number];

/** Max ideas one account may have posted at a time. */
export const MAX_IDEAS_PER_USER = 5;

// ─── helpers ───

function isoOrNull(v: unknown): string | null {
  return v instanceof Date ? v.toISOString() : null;
}

/** Is voting on this idea over? (no close date = open forever) */
function ideaClosed(closesAt: Date | null): boolean {
  return !!closesAt && Date.now() >= closesAt.getTime();
}

/** Shape the client's IdeaData. */
function rowToIdea(row: {
  id: string; title: string; description: string; creator: string;
  status: string; votes: number; closesAt: Date | null;
  createdAt: Date; updatedAt: Date;
}, voted: boolean) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    creator: row.creator,
    status: row.status,
    votes: row.votes,
    closesAt: isoOrNull(row.closesAt),
    closed: ideaClosed(row.closesAt),
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
    voted,
  };
}

// ─── GET / — list every idea (newest first) ───
// Public: guests (no session) simply get voted=false everywhere.
// The client handles the "Search Idea" bar, the status filter chips
// and the sorting locally — the idea list is small.
ideasRouter.get("/", safeHandler(async (_req, res) => {
  const rows = await prisma.idea.findMany({
    orderBy: { createdAt: "desc" },
  });
  const me = (_req as any).authUser as string | null;
  let votedIds = new Set<string>();
  if (me) {
    const myVotes = await prisma.ideaVote.findMany({
      where: { username: me },
      select: { ideaId: true },
    });
    votedIds = new Set(myVotes.map((v) => v.ideaId));
  }
  return res.json(rows.map((r) => rowToIdea(r, votedIds.has(r.id))));
}));

// ─── POST / — post a new idea ───
const createIdeaSchema = z.object({
  title: z.string().min(3, "Title must be at least 3 characters").max(100),
  description: z.string().max(500).default(""),
});

ideasRouter.post("/", safeHandler(async (req, res) => {
  if (!originOk(req, res)) return;
  const username = await requireAuth(req, res);
  if (!username) return;

  const rl = await requireRateLimit("create_idea", username);
  if (rl) return res.status(429).json({ error: rl.error, retryAfter: rl.retryAfter });

  const parsed = validateBody(createIdeaSchema, req.body, res);
  if ("error" in parsed) return;
  const { title, description } = parsed.data;

  const cleanTitle = sanitizeString(title.trim(), 100);
  const cleanDescription = sanitizeString((description ?? "").trim(), 500);
  if (cleanTitle.length < 3) {
    return res.status(400).json({ error: "Title must be at least 3 characters" });
  }

  const mine = await prisma.idea.count({ where: { creator: username } });
  if (mine >= MAX_IDEAS_PER_USER) {
    return res.status(400).json({
      error: `You can have at most ${MAX_IDEAS_PER_USER} ideas. Delete one first or wait for an admin to review.`,
    });
  }

  const idea = await prisma.idea.create({
    data: {
      id: randomBytes(6).toString("hex"),
      title: cleanTitle,
      description: cleanDescription,
      creator: username,
    },
  });

  console.log(`[ideas] ${username} posted "${cleanTitle}" (${idea.id})`);
  return res.json(rowToIdea(idea, false));
}));

// ─── POST /vote — toggle my upvote ───
const voteIdeaSchema = z.object({ ideaId: z.string().min(1).max(40) });

ideasRouter.post("/vote", safeHandler(async (req, res) => {
  if (!originOk(req, res)) return;
  const username = await requireAuth(req, res);
  if (!username) return;

  const rl = await requireRateLimit("idea_vote", username);
  if (rl) return res.status(429).json({ error: rl.error, retryAfter: rl.retryAfter });

  const parsed = validateBody(voteIdeaSchema, req.body, res);
  if ("error" in parsed) return;
  const { ideaId } = parsed.data;

  const idea = await prisma.idea.findUnique({ where: { id: ideaId } });
  if (!idea) return res.status(404).json({ error: "Idea not found" });

  // The close date is enforced HERE — once it has passed nobody can vote
  // (or un-vote) anymore, whatever the client UI says.
  if (ideaClosed(idea.closesAt)) {
    return res.status(400).json({ error: "Voting is closed for this idea." });
  }

  const existing = await prisma.ideaVote.findUnique({
    where: { ideaId_username: { ideaId, username } },
  });

  let voted: boolean;
  if (existing) {
    await prisma.ideaVote.delete({ where: { ideaId_username: { ideaId, username } } });
    await prisma.idea.update({ where: { id: ideaId }, data: { votes: { decrement: 1 } } });
    voted = false;
  } else {
    await prisma.ideaVote.create({ data: { ideaId, username } });
    await prisma.idea.update({ where: { id: ideaId }, data: { votes: { increment: 1 } } });
    voted = true;
  }

  const fresh = await prisma.idea.findUnique({ where: { id: ideaId } });
  if (!fresh) return res.status(404).json({ error: "Idea not found" });
  return res.json(rowToIdea(fresh, voted));
}));

// ─── PATCH / — admin controls: status, close date, remove ───
const updateIdeaSchema = z.object({
  ideaId: z.string().min(1).max(40),
  // Approved / Considering / Not Approved / Already Planned — or "open"
  // to reset an idea back to no-status.
  status: z.enum(IDEA_STATUSES).optional(),
  // ISO date-time AFTER which nobody can vote anymore.
  // null / "" clears it (reopens voting).
  closesAt: z.union([z.string().max(40), z.null()]).optional(),
});

ideasRouter.patch("/", safeHandler(async (req, res) => {
  if (!originOk(req, res)) return;
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const parsed = validateBody(updateIdeaSchema, req.body, res);
  if ("error" in parsed) return;
  const { ideaId, status, closesAt } = parsed.data;

  const idea = await prisma.idea.findUnique({ where: { id: ideaId } });
  if (!idea) return res.status(404).json({ error: "Idea not found" });

  const data: { status?: string; closesAt?: Date | null } = {};
  if (status !== undefined) data.status = status;

  if (closesAt !== undefined) {
    if (closesAt === null || closesAt === "") {
      data.closesAt = null; // reopen voting forever
    } else {
      const d = new Date(closesAt);
      if (isNaN(d.getTime())) {
        return res.status(400).json({ error: "Invalid close date." });
      }
      data.closesAt = d;
    }
  }

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ error: "Nothing to update." });
  }

  const updated = await prisma.idea.update({ where: { id: ideaId }, data });
  console.log(`[ideas] ${admin} updated "${updated.title}" (${ideaId}): ${JSON.stringify(data)}`);
  return res.json(rowToIdea(updated, false));
}));

// ─── DELETE / — admin removes an idea (and its votes) ───
const deleteIdeaSchema = z.object({ ideaId: z.string().min(1).max(40) });

ideasRouter.delete("/", safeHandler(async (req, res) => {
  if (!originOk(req, res)) return;
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const parsed = validateBody(deleteIdeaSchema, req.body, res);
  if ("error" in parsed) return;
  const { ideaId } = parsed.data;

  const idea = await prisma.idea.findUnique({ where: { id: ideaId } });
  if (!idea) return res.status(404).json({ error: "Idea not found" });

  await prisma.ideaVote.deleteMany({ where: { ideaId } });
  await prisma.idea.delete({ where: { id: ideaId } });

  console.log(`[ideas] ${admin} removed "${idea.title}" (${ideaId})`);
  return res.json({ success: true, deleted: ideaId });
}));

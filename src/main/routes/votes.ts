// ═══════════════════════════════════════════════════════════
// WeildBuild Main: /votes routes (the "Vote" page, v1.9.1)
// ═══════════════════════════════════════════════════════════
// Update ideas posted by admins + anonymous Yes/No votes from
// every player:
//   • GET  /votes           : list ideas with yes/no counts and
//                              YOUR current vote (so the buttons
//                              can toggle). No voter names, ever.
//   • POST /votes           : create an idea (admins only),
//                              optionally with an "open until"
//                              date (the voting window)
//   • POST /votes/vote      : cast/change/remove your vote
//                              (value: 1 = Yes, -1 = No, 0 = remove)
//   • POST /votes/:id/update: admin edit: set a stamp
//                              (approved | not_approved |
//                              considering | implemented), optionally
//                              close voting at the same time, set the
//                              open until date, or close/reopen
//   • DELETE /votes/:id     : delete an idea (its creator admin,
//                              or the top admin)
//
// v1.9.3 STAMPS + VOTING WINDOWS:
//   • stamp: "" (none) | approved | not_approved | considering |
//     implemented. Purely informational for players; it NEVER closes
//     voting by itself. Stamping can OPTIONALLY close it in the same
//     request when the admin ticks the "also close voting" checkbox.
//   • openUntil: optional deadline. Once it passes the idea is
//     EFFECTIVELY closed; voting is rejected server side.
//   • closed: manual close (kept in the DB; closedAt records when).
//     Reopening clears closed + closedAt (the open until date still
//     applies on its own).
//
// ANONYMITY: the API only ever returns aggregate counts plus the
// CALLER's own vote. There is no endpoint that reveals who voted
// what - not even for admins.

import { Router } from "express";
import { randomBytes } from "crypto";
import { z } from "zod";
import { prisma } from "../../db/client";
import { requireRateLimit } from "../../db/ratelimits";
import { sanitizeString, isGuestUser } from "../../db/users";
import { safeHandler, validateBody, clientIp } from "../../shared/http";
import { attachUser, requireAuth, requireAdmin, originOk } from "../middleware";

export const votesRouter = Router();

// Attach req.authUser (session identity) for every request
votesRouter.use(attachUser);

/** The stamps an admin can set on an idea. "" = no stamp. */
export const VOTE_STAMPS = ["", "approved", "not_approved", "considering", "implemented"] as const;
export type VoteStamp = (typeof VOTE_STAMPS)[number];

/** Is voting on this idea closed? Manually closed, or the open until date passed. */
function votingClosed(row: { closed: boolean; openUntil: Date | null }): boolean {
  if (row.closed) return true;
  if (row.openUntil && row.openUntil.getTime() <= Date.now()) return true;
  return false;
}

/** Shape returned to the client for one idea. */
function ideaShape(row: {
  id: string; title: string; message: string; createdBy: string;
  closed: boolean; createdAt: Date;
  stamp?: string | null; stampedBy?: string | null; stampedAt?: Date | null;
  openUntil?: Date | null; closedAt?: Date | null;
}, yes: number, no: number, myVote: number) {
  return {
    id: row.id,
    title: row.title,
    message: row.message,
    createdBy: row.createdBy,
    // Effective closed: the stored flag OR the deadline passing.
    closed: votingClosed(row as any),
    createdAt: row.createdAt.toISOString(),
    yes,
    no,
    myVote, // 1 | -1 | 0: only ever YOUR OWN vote
    // v1.9.3 stamp + window fields
    stamp: row.stamp || "",
    stampedBy: row.stampedBy || "",
    stampedAt: row.stampedAt ? row.stampedAt.toISOString() : null,
    openUntil: row.openUntil ? row.openUntil.toISOString() : null,
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
  };
}

// GET /votes: the public list. Works logged-out too (you just
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

/** Parse + validate an "open until" date from the client.
 *  Returns null (absent), a Date, or "invalid". */
function parseOpenUntil(value: unknown): Date | null | "invalid" {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return "invalid";
  const d = new Date(value);
  if (isNaN(d.getTime())) return "invalid";
  // Sanity window: not in the past, not more than 2 years out.
  if (d.getTime() < Date.now() - 60_000) return "invalid";
  if (d.getTime() > Date.now() + 2 * 365 * 24 * 60 * 60 * 1000) return "invalid";
  return d;
}

// POST /votes: create an update idea (admins only).
// v1.9.3: optional openUntil sets the voting window ("vote open until").
const createIdeaSchema = z.object({
  title: z.string().min(1).max(100),
  message: z.string().min(1).max(2000),
  openUntil: z.string().max(40).optional().nullable(),
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

  const openUntil = parseOpenUntil(parsed.data.openUntil);
  if (openUntil === "invalid") {
    return res.status(400).json({ error: "The open until date is not valid." });
  }

  const row = await prisma.voteIdea.create({
    data: {
      id: `idea-${randomBytes(6).toString("hex")}`,
      title: sanitizeString(title, 100),
      message: sanitizeString(message, 2000),
      createdBy: admin,
      ...(openUntil ? { openUntil } : {}),
    },
  });

  console.log(`[votes] ${admin} posted idea "${row.title}" (${row.id})` +
    (openUntil ? ` open until ${openUntil.toISOString()}` : ""));
  return res.json({ success: true, idea: ideaShape(row, 0, 0, 0) });
}));

// POST /votes/vote: cast, change or remove YOUR vote on one idea.
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

  // v1.9.2 GUEST GUARD: everyone can VIEW the ideas; only real accounts
  // vote. The GET above stays open (myVote is just always 0 for guests).
  if (await isGuestUser(username)) {
    return res.status(403).json({ error: "Guests can't vote. Create a free account to vote!" });
  }

  const parsed = validateBody(voteSchema, req.body, res);
  if ("error" in parsed) return;
  const { ideaId, value } = parsed.data;

  const idea = await prisma.voteIdea.findUnique({ where: { id: ideaId } });
  if (!idea) return res.status(404).json({ error: "That idea no longer exists." });

  // v1.9.3: closed ideas reject new votes (manual close OR the open
  // until date passed). Removing your own vote (value 0) is still
  // allowed so nobody is trapped in a stale vote.
  if (value !== 0 && votingClosed(idea as any)) {
    return res.status(403).json({ error: "Voting is closed on this idea." });
  }

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

// POST /votes/:id/update: admin edits (v1.9.3).
//   stamp:       optional. "" clears it, otherwise one of the 4 stamps.
//   closeVoting: optional. true = close voting IN THE SAME request
//                (the "also close voting" checkbox next to a stamp).
//                false / absent = leave the closed state alone.
//   closed:      optional. Explicitly close (true) or reopen (false).
//   openUntil:   optional. Set / change the voting deadline.
//                null or "" clears it (open ended).
// Permissions: the idea's creator, or the top admin (same as DELETE).
const updateIdeaSchema = z.object({
  stamp: z.enum(["", "approved", "not_approved", "considering", "implemented"]).optional(),
  closeVoting: z.boolean().optional(),
  closed: z.boolean().optional(),
  openUntil: z.string().max(40).optional().nullable(),
});

votesRouter.post("/:id/update", safeHandler(async (req, res) => {
  if (!originOk(req, res)) return;

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const id = String(req.params.id || "");
  const idea = await prisma.voteIdea.findUnique({ where: { id } });
  if (!idea) return res.status(404).json({ error: "Idea not found." });

  // The creator may edit their own idea; only the top admin may
  // edit anyone's (same rule as DELETE).
  if (idea.createdBy !== admin) {
    const me = await prisma.user.findUnique({ where: { username: admin } });
    if (me?.adminRole !== "top_admin") {
      return res.status(403).json({ error: "Only the top admin can update another admin's idea." });
    }
  }

  const parsed = validateBody(updateIdeaSchema, req.body, res);
  if ("error" in parsed) return;
  const { stamp, closeVoting, closed } = parsed.data;

  const openUntilParsed = parseOpenUntil(parsed.data.openUntil);
  if (openUntilParsed === "invalid") {
    return res.status(400).json({ error: "The open until date is not valid." });
  }

  // Build only the fields that were actually sent.
  const data: Record<string, unknown> = {};
  if (stamp !== undefined) {
    data.stamp = stamp;
    data.stampedBy = stamp === "" ? "" : admin;
    data.stampedAt = stamp === "" ? null : new Date();
  }
  if (closed !== undefined) {
    data.closed = closed;
    data.closedAt = closed ? new Date() : null;
  }
  // The stamp checkbox: close voting now (true). false / absent leaves
  // the current state untouched (admins can stamp WITHOUT closing).
  if (closeVoting === true && closed === undefined) {
    data.closed = true;
    data.closedAt = new Date();
  }
  if (parsed.data.openUntil !== undefined) {
    data.openUntil = openUntilParsed; // Date | null
  }

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ error: "Nothing to update." });
  }

  const row = await prisma.voteIdea.update({ where: { id }, data });

  // Fresh counts for the response so the client can update in place.
  const votes = await prisma.voteVote.findMany({ where: { ideaId: id }, select: { username: true, value: true } });
  let yes = 0, no = 0, myVote = 0;
  for (const v of votes) {
    if (v.value === 1) yes += 1;
    else if (v.value === -1) no += 1;
    if (v.username === admin) myVote = v.value;
  }

  console.log(`[votes] ${admin} updated idea "${row.title}" (${row.id}): ${JSON.stringify(data)}`);
  return res.json({ success: true, idea: ideaShape(row, yes, no, myVote) });
}));

// DELETE /votes/:id: remove an idea (its creator, or the top admin).
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

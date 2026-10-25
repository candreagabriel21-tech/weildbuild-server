// ═══════════════════════════════════════════════════════════
// WeildBuild LEGACY COMPATIBILITY SHIM (v1.9.3 build fix)
// ═══════════════════════════════════════════════════════════
// This file exists for ONE reason. Some deployed copies of the
// server repo (the folder Render builds from) still contain a
// very old src/main/routes/ideas.ts from a previous version,
// because copying a new version over an old folder leaves old
// deleted files behind. That stale file talks to Prisma models
// (idea / ideaVote) that were renamed long ago (VoteIdea /
// VoteVote), so the TypeScript build fails with errors like:
//   error TS2339: Property 'idea' does not exist on type 'PrismaClient'
//
// tsc compiles EVERY file under src/, even files that nothing
// imports, so one stale file breaks the whole deploy. Shipping
// this shim means copying the new server folder over an old one
// safely overwrites the stale file with a version that compiles.
// It is harmless: the new index.ts mounts ./votes directly and
// never imports this file.
//
// If your deploy repo is fully clean, you may delete this file
// (and any leftover ideas.ts) with zero side effects.

import { Router } from "express";
import { votesRouter } from "./votes";

// Every plausible old export name points at the same modern
// votes router, so even a stale index.ts that still imports
// "./routes/ideas" keeps compiling AND serves the current
// /api/votes feature set (stamps, open until dates, close and
// reopen voting, search friendly data).
export const ideasRouter: Router = votesRouter;
export const ideaRouter: Router = votesRouter;
export const router: Router = votesRouter;
export default votesRouter;

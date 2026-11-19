// ═══════════════════════════════════════════════════════════
// WeildBuild DB, Prisma client → BRIDGE PROXY
// ═══════════════════════════════════════════════════════════
// Every prisma.X.Y(args) call is relayed to the laptop worker
// over the pull-bridge. The cast keeps the type as PrismaClient so
// all 150+ existing call sites compile unchanged. Roll back: git revert.
import { PrismaClient } from "@prisma/client";
import { createBridgePrisma } from "../bridge/render-bridge";

declare global {
  // eslint-disable-next-line no-var
  var __wbPrisma: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  global.__wbPrisma ?? (createBridgePrisma() as PrismaClient);

if (process.env.NODE_ENV !== "production") {
  global.__wbPrisma = prisma;
}

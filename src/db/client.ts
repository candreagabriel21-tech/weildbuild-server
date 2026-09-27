// ═══════════════════════════════════════════════════════════
// WeildBuild DB — Prisma client singleton
// ═══════════════════════════════════════════════════════════
import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __wbPrisma: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  global.__wbPrisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "production" ? ["error"] : ["error", "warn"],
  });

if (process.env.NODE_ENV !== "production") {
  global.__wbPrisma = prisma;
}

// ═══════════════════════════════════════════════════════════
// WeildBuild DB — sessions (JWT tickets + revocation rows)
// ═══════════════════════════════════════════════════════════
import { prisma } from "./client";
import { signSessionToken, verifyTicket } from "../shared/jwt";
import { MAX_SESSIONS_PER_USER } from "../shared/constants";

/**
 * Create a session: sign a JWT ticket and store it in the sessions
 * table (enables logout / password-change revocation + the 5-device
 * limit, exactly like the original system).
 */
export async function createSession(username: string): Promise<string> {
  // Enforce the 5-device limit: evict the oldest sessions first
  const existing = await prisma.session.findMany({
    where: { username },
    orderBy: { createdAt: "asc" },
    select: { token: true },
  });
  if (existing.length >= MAX_SESSIONS_PER_USER) {
    const toEvict = existing.slice(0, existing.length - MAX_SESSIONS_PER_USER + 1);
    await prisma.session.deleteMany({ where: { token: { in: toEvict.map((s) => s.token) } } });
  }

  // v1.3.2: unique jti makes tokens unique, but keep a one-shot retry
  // as a safety net against any future token-collision edge case.
  for (let attempt = 0; ; attempt++) {
    const token = await signSessionToken(username);
    try {
      await prisma.session.create({ data: { token, username } });
      return token;
    } catch (e: any) {
      if (attempt === 0 && e?.code === "P2002") continue; // duplicate token → mint a fresh one
      throw e;
    }
  }
}

/**
 * Full verification: valid JWT signature AND live session row.
 * Used by the Main Server (source of truth).
 */
export async function verifySession(token: string): Promise<string | null> {
  if (!token) return null;
  const payload = await verifyTicket(token);
  if (!payload) return null;
  try {
    const row = await prisma.session.findUnique({ where: { token } });
    if (!row) return null; // revoked (logout / password change / device eviction)
    if (row.username !== payload.username) return null;
    return row.username;
  } catch {
    return null;
  }
}

export async function deleteSession(token: string) {
  if (!token) return;
  try {
    await prisma.session.deleteMany({ where: { token } });
  } catch {}
}

export async function deleteUserSessions(username: string, excludeToken?: string) {
  try {
    await prisma.session.deleteMany({
      where: { username, ...(excludeToken ? { NOT: { token: excludeToken } } : {}) },
    });
  } catch {}
}

export async function countUserSessions(username: string): Promise<number> {
  try {
    return await prisma.session.count({ where: { username } });
  } catch {
    return 0;
  }
}

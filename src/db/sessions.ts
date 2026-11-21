// ═══════════════════════════════════════════════════════════
// WeildBuild DB, sessions (JWT tickets + revocation rows)
// ═══════════════════════════════════════════════════════════
import { prisma } from "./client";
import { signSessionToken, verifyTicket } from "../shared/jwt";
import { MAX_SESSIONS_PER_USER } from "../shared/constants";

// ─── v1.10.3: in-memory session cache ───
// verifySession() runs on EVERY authenticated request and used to hit
// Postgres each time. A small cache removes that round trip. Entries
// live 60 s at most, and EVERY revocation path (logout, password
// change, admin kick/ban, device-limit eviction) drops the affected
// entries immediately, so a revoked session is never accepted again
// after its revoking request ran. Single-instance deployments (the
// Render service) are always authoritative; with multiple instances a
// revocation could lag up to the TTL on the other instances.
const SESSION_CACHE_TTL_MS = 60_000;
const SESSION_CACHE_MAX = 5000;
const sessionCache = new Map<string, { username: string; at: number }>();

function cacheGet(token: string): string | null {
  const hit = sessionCache.get(token);
  if (!hit) return null;
  if (Date.now() - hit.at > SESSION_CACHE_TTL_MS) {
    sessionCache.delete(token);
    return null;
  }
  return hit.username;
}

function cachePut(token: string, username: string): void {
  sessionCache.set(token, { username, at: Date.now() });
  if (sessionCache.size > SESSION_CACHE_MAX) {
    // Hard cap: drop the oldest third so memory can never balloon.
    let dropped = 0;
    const target = Math.floor(sessionCache.size / 3);
    for (const k of sessionCache.keys()) {
      if (dropped >= target) break;
      sessionCache.delete(k);
      dropped++;
    }
  }
}

function cacheDropToken(token: string): void {
  sessionCache.delete(token);
}

function cacheDropUser(username: string): void {
  for (const [k, v] of sessionCache) if (v.username === username) sessionCache.delete(k);
}

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
    cacheDropUser(username); // evicted sessions must not stay cache-valid
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
 * v1.10.3: served from the in-memory cache when warm (see above);
 * the DB is only hit on the first use of a token / after its TTL.
 */
export async function verifySession(token: string): Promise<string | null> {
  if (!token) return null;
  const cached = cacheGet(token);
  if (cached) return cached;
  const payload = await verifyTicket(token);
  if (!payload) return null;
  try {
    const row = await prisma.session.findUnique({ where: { token } });
    if (!row) return null; // revoked (logout / password change / device eviction)
    if (row.username !== payload.username) return null;
    cachePut(token, row.username);
    return row.username;
  } catch {
    return null;
  }
}

export async function deleteSession(token: string) {
  if (!token) return;
  cacheDropToken(token);
  try {
    await prisma.session.deleteMany({ where: { token } });
  } catch {}
}

export async function deleteUserSessions(username: string, excludeToken?: string) {
  cacheDropUser(username);
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

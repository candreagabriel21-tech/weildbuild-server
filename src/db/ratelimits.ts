// ═══════════════════════════════════════════════════════════
// WeildBuild DB — rate limiting (ported from security.ts)
// ═══════════════════════════════════════════════════════════
import { prisma } from "./client";
import { RATE_LIMITS } from "../shared/constants";

export async function checkRateLimit(
  identifier: string,
  maxAttempts: number,
  windowMs: number
): Promise<{ allowed: boolean; remainingAttempts: number }> {
  const now = new Date();
  try {
    const existing = await prisma.rateLimit.findUnique({ where: { identifier } });
    if (existing) {
      // Reset if window expired
      if (now.getTime() - existing.windowStart.getTime() > windowMs) {
        await prisma.rateLimit.update({
          where: { identifier },
          data: { attempts: 1, windowStart: now },
        });
        return { allowed: true, remainingAttempts: maxAttempts - 1 };
      }
      if (existing.attempts >= maxAttempts) {
        return { allowed: false, remainingAttempts: 0 };
      }
      const newAttempts = existing.attempts + 1;
      await prisma.rateLimit.update({
        where: { identifier },
        data: { attempts: newAttempts },
      });
      return { allowed: true, remainingAttempts: maxAttempts - newAttempts };
    }
    await prisma.rateLimit.create({ data: { identifier, attempts: 1, windowStart: now } });
    return { allowed: true, remainingAttempts: maxAttempts - 1 };
  } catch {
    // Fail closed (safer) — matches original behavior
    return { allowed: false, remainingAttempts: 0 };
  }
}

export async function resetRateLimit(identifier: string) {
  try {
    await prisma.rateLimit.deleteMany({ where: { identifier } });
  } catch {}
}

/** Convenience: check one of the named presets. Returns error string if blocked, null if allowed. */
export async function requireRateLimit(
  endpoint: string,
  identity: string
): Promise<{ error: string; retryAfter: number } | null> {
  const preset = RATE_LIMITS[endpoint] || RATE_LIMITS.general_api;
  const result = await checkRateLimit(`${endpoint}_${identity}`, preset.maxAttempts, preset.windowMs);
  if (!result.allowed) {
    return {
      error: "Too many requests. Please try again later.",
      retryAfter: Math.ceil(preset.windowMs / 1000),
    };
  }
  return null;
}

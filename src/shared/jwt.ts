// ═══════════════════════════════════════════════════════════
// WeildBuild Shared — JWT session tickets
// ═══════════════════════════════════════════════════════════
// Login returns a signed JWT (the "ticket"). Main Server verifies
// the signature AND the session row (so logout/password-change
// revoke it). Realtime + Game Hosts verify the signature locally
// with the shared AUTH_SECRET — no round-trip to Main needed.

import { SignJWT, jwtVerify } from "jose";
import { config } from "./config";
import { SESSION_LIFETIME_SECONDS } from "./constants";

function getSecretKey(): Uint8Array {
  if (!config.authSecret) {
    throw new Error("AUTH_SECRET is not set — refusing to sign/verify tokens");
  }
  return new TextEncoder().encode(config.authSecret);
}

/** Sign a session ticket for a user. */
export async function signSessionToken(username: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub: username })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(now + SESSION_LIFETIME_SECONDS)
    .sign(getSecretKey());
}

export interface TicketPayload {
  username: string;
  expiresAt: number; // epoch seconds
}

/**
 * Verify a ticket's signature and expiry.
 * Returns the payload, or null if the ticket is invalid/expired.
 * NOTE: this does NOT check revocation (session row) — Main Server
 * does that on top via db.verifySessionRow().
 */
export async function verifyTicket(token: string): Promise<TicketPayload | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, getSecretKey(), { algorithms: ["HS256"] });
    if (!payload.sub || typeof payload.exp !== "number") return null;
    return { username: payload.sub, expiresAt: payload.exp };
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
// WeildBuild Main — auth middleware (Express port of security.ts)
// ═══════════════════════════════════════════════════════════
import { Request, Response, NextFunction, RequestHandler } from "express";
import { verifySession } from "../db/sessions";
import { getUser } from "../db/users";
import { validateOrigin } from "../shared/http";

/** Extract the session ticket: X-Session-Token header (desktop) or wb_session cookie (web). */
export function extractToken(req: Request): string | undefined {
  const header = req.headers["x-session-token"];
  if (typeof header === "string" && header.length > 0) return header;
  const cookie = req.headers.cookie;
  if (cookie) {
    for (const part of cookie.split(";")) {
      const [name, ...rest] = part.trim().split("=");
      if (name === "wb_session") return decodeURIComponent(rest.join("="));
    }
  }
  return undefined;
}

/** Attach req.authUser if a valid session is present. */
export const attachUser: RequestHandler = async (req, _res, next) => {
  (req as any).authUser = null;
  const token = extractToken(req);
  if (token) {
    const username = await verifySession(token);
    if (username) (req as any).authUser = username;
  }
  next();
};

/** Require a logged-in user. */
export async function requireAuth(req: Request, res: Response): Promise<string | null> {
  const username = (req as any).authUser as string | null;
  if (!username) {
    res.status(401).json({ error: "Authentication required. Please log in." });
    return null;
  }
  return username;
}

/** Require admin role. */
export async function requireAdmin(req: Request, res: Response): Promise<string | null> {
  const username = await requireAuth(req, res);
  if (!username) return null;
  const user = await getUser(username);
  if (!user || (user.admin_role !== "admin" && user.admin_role !== "top_admin")) {
    res.status(403).json({ error: "Admin access required." });
    return null;
  }
  return username;
}

/** Require the target user to be self or an admin. */
export async function requireSelfOrAdmin(req: Request, res: Response, targetUsername: string): Promise<string | null> {
  const username = await requireAuth(req, res);
  if (!username) return null;
  if (username === targetUsername) return username;
  const user = await getUser(username);
  if (user && (user.admin_role === "admin" || user.admin_role === "top_admin")) return username;
  res.status(403).json({ error: "You can only perform this action on your own account." });
  return null;
}

/** CSRF origin check for mutating routes — returns false (and responds) if blocked. */
export function originOk(req: Request, res: Response): boolean {
  return validateOrigin(req, res);
}

/** Set the session cookie (web clients) alongside the JSON body (desktop clients). */
export function setSessionCookie(res: Response, token: string) {
  const isSecure = true; // Render is always HTTPS
  res.cookie("wb_session", token, {
    httpOnly: true,
    secure: isSecure,
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365 * 10, // 10 years — sessions never expire
    path: "/",
  });
}

export function clearSessionCookie(res: Response) {
  res.cookie("wb_session", "", { httpOnly: true, secure: true, sameSite: "lax", maxAge: 0, path: "/" });
}

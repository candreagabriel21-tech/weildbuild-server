// ═══════════════════════════════════════════════════════════
// WeildBuild Main — /auth routes (faithful port of the Next.js
// auth API route; now returns JWT tickets as the session token)
// ═══════════════════════════════════════════════════════════
import { Router } from "express";
import { z } from "zod";
import {
  createUser, verifyLogin, getUser, saveUser,
  secureHashPassword, generateSalt, validateUsername, verifyPassword, stripSensitiveFields,
} from "../../db/users";
import {
  createSession, verifySession, deleteSession, deleteUserSessions, countUserSessions,
} from "../../db/sessions";
import { requireRateLimit, resetRateLimit } from "../../db/ratelimits";
import { safeHandler, validateBody, clientIp } from "../../shared/http";
import { requireAuth, originOk, setSessionCookie, clearSessionCookie, extractToken } from "../middleware";

export const authRouter = Router();

const registerSchema = z.object({
  action: z.literal("register"),
  username: z.string().min(3).max(20).regex(/^[a-zA-Z0-9_]+$/, "Username can only contain letters, numbers, and underscores"),
  password: z.string().min(6, "Password must be at least 6 characters").max(128),
});
const loginSchema = z.object({
  action: z.literal("login"),
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});
const changePasswordSchema = z.object({
  action: z.literal("changePassword"),
  username: z.string().min(1),
  oldPassword: z.string().min(1, "Current password is required"),
  newPassword: z.string()
    .min(8, "New password must be at least 8 characters").max(128)
    .regex(/[A-Z]/, "New password must contain at least one uppercase letter")
    .regex(/[a-z]/, "New password must contain at least one lowercase letter")
    .regex(/[0-9]/, "New password must contain at least one number"),
  endOtherSessions: z.boolean().default(false),
});
const logoutSchema = z.object({ action: z.literal("logout") });
const authActionSchema = z.discriminatedUnion("action", [registerSchema, loginSchema, changePasswordSchema, logoutSchema]);

// POST /auth — register | login | changePassword | logout
authRouter.post("/", safeHandler(async (req, res) => {
  if (!originOk(req, res)) return;

  const parsed = validateBody(authActionSchema, req.body, res);
  if ("error" in parsed) return;
  const body = parsed.data;

  // ───── REGISTER ─────
  if (body.action === "register") {
    const rl = await requireRateLimit("register", clientIp(req));
    if (rl) return res.status(429).json({ error: rl.error, retryAfter: rl.retryAfter });

    const { username, password: pwd } = body;
    const usernameValidation = validateUsername(username);
    if (!usernameValidation.valid) return res.status(400).json({ error: usernameValidation.error });
    if (!pwd || pwd.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });

    const result = await createUser(username, pwd);
    if (result.error) return res.status(400).json({ error: result.error });

    const { user } = result;
    if (!user) return res.status(500).json({ error: "Failed to create user" });

    const token = await createSession(username);
    setSessionCookie(res, token);
    return res.json({ success: true, user: stripSensitiveFields(user), sessionToken: token });
  }

  // ───── LOGIN ─────
  if (body.action === "login") {
    const { username, password: pwd } = body;
    const rl = await requireRateLimit("login", username || clientIp(req));
    if (rl) return res.status(429).json({ error: rl.error, retryAfter: rl.retryAfter });

    const result = await verifyLogin(username, pwd);
    if (result.error) return res.status(401).json({ error: result.error });

    const { user } = result;
    if (!user) return res.status(500).json({ error: "Login failed" });

    await resetRateLimit(username);
    const token = await createSession(username);
    setSessionCookie(res, token);
    return res.json({ success: true, user: stripSensitiveFields(user), sessionToken: token });
  }

  // ───── CHANGE PASSWORD ─────
  if (body.action === "changePassword") {
    const { username: targetUser, oldPassword, newPassword, endOtherSessions } = body;

    const currentSessionToken = extractToken(req);
    const sessionUser = currentSessionToken ? await verifySession(currentSessionToken) : null;
    if (!sessionUser) return res.status(401).json({ error: "Authentication required." });
    if (sessionUser !== targetUser) return res.status(403).json({ error: "You can only change your own password." });

    const user = await getUser(targetUser);
    if (!user) return res.status(404).json({ error: "User not found." });

    const isValid = verifyPassword(oldPassword, user.password, user.salt, user.hash_version);
    if (!isValid) return res.status(401).json({ error: "Current password is incorrect." });

    const newSalt = generateSalt();
    user.password = secureHashPassword(newPassword, newSalt);
    user.salt = newSalt;
    user.hash_version = 1;
    await saveUser(targetUser, user);

    if (endOtherSessions) {
      await deleteUserSessions(targetUser, currentSessionToken);
    }
    if (currentSessionToken) await deleteSession(currentSessionToken);

    const newToken = await createSession(targetUser);
    const activeSessionCount = await countUserSessions(targetUser);
    setSessionCookie(res, newToken);
    return res.json({ success: true, sessionToken: newToken, activeSessions: activeSessionCount });
  }

  // ───── LOGOUT ─────
  if (body.action === "logout") {
    const token = extractToken(req);
    if (token) await deleteSession(token);
    clearSessionCookie(res);
    return res.json({ success: true });
  }

  return res.status(400).json({ error: "Unknown action" });
}));

// GET /auth — session verification
authRouter.get("/", safeHandler(async (req, res) => {
  const token = extractToken(req);
  if (!token) return res.json({ authenticated: false });
  const username = await verifySession(token);
  if (!username) return res.json({ authenticated: false });
  return res.json({ authenticated: true, username });
}));

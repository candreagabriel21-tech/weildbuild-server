// ═══════════════════════════════════════════════════════════
// WeildBuild DB — users + passwords (ported 1:1 from file-db.ts)
// ═══════════════════════════════════════════════════════════
// The password algorithm is IDENTICAL to the original app, so
// existing accounts (including the seeded WeildBuild admin) keep
// working after the migration to the new servers.

import { createHash, randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { prisma } from "./client";
import { ALLOWED_USER_UPDATES, ADMIN_ONLY_FIELDS } from "../shared/constants";

// ─────────────────── Sanitization (ported) ───────────────────

export function sanitizeString(input: string, maxLength: number = 200): string {
  if (!input) return "";
  let cleaned = input.replace(/<[^>]*>/g, "");
  cleaned = cleaned.replace(/javascript:/gi, "");
  cleaned = cleaned.replace(/on\w+\s*=/gi, "");
  return cleaned.slice(0, maxLength);
}

const ALLOWED_USERNAME_REGEX = /^[a-zA-Z0-9_]+$/;

export function validateUsername(username: string): { valid: boolean; error?: string } {
  if (!username) return { valid: false, error: "Username is required" };
  if (username.length < 3) return { valid: false, error: "Username must be at least 3 characters" };
  if (username.length > 20) return { valid: false, error: "Username must be at most 20 characters" };
  if (!ALLOWED_USERNAME_REGEX.test(username)) return { valid: false, error: "Username can only contain letters, numbers, and underscores" };
  if (username.includes("..") || username.includes("/") || username.includes("\\")) {
    return { valid: false, error: "Invalid username" };
  }
  return { valid: true };
}

// ─────────────────── Password hashing (ported EXACTLY) ───────────────────

export function simpleHash(password: string, salt: string): string {
  return createHash("sha256").update(password + salt).digest("hex");
}

const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_COST = 16384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;

export function secureHashPassword(password: string, salt: string): string {
  const key = scryptSync(password, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_COST, r: SCRYPT_BLOCK_SIZE, p: SCRYPT_PARALLELIZATION,
  });
  return key.toString("hex");
}

export function generateSalt(): string {
  return randomBytes(16).toString("hex");
}

export function verifyPassword(password: string, storedHash: string, salt: string, hashVersion?: number): boolean {
  try {
    if (storedHash.length === 128 || hashVersion === 1) {
      const computedHash = secureHashPassword(password, salt);
      return timingSafeEqual(Buffer.from(computedHash, "hex"), Buffer.from(storedHash, "hex"));
    }
    const computedHash = simpleHash(password, salt);
    return timingSafeEqual(Buffer.from(computedHash, "hex"), Buffer.from(storedHash, "hex"));
  } catch {
    return false;
  }
}

// ─────────────────── Field filtering (ported) ───────────────────

export function stripSensitiveFields(user: any): any {
  const { password, salt, ...safe } = user;
  return safe;
}

const FIELD_MAX_LENGTHS: Record<string, number> = { description: 200, language: 10 };

export function filterUserUpdates(updates: any, isAdmin: boolean = false): any {
  const filtered: any = {};
  const allowedFields = isAdmin ? [...ALLOWED_USER_UPDATES, ...ADMIN_ONLY_FIELDS] : ALLOWED_USER_UPDATES;
  for (const key of Object.keys(updates)) {
    if (key === "username") continue;
    if (key === "password" || key === "salt") continue;
    if (allowedFields.includes(key)) {
      if (typeof updates[key] === "string") {
        filtered[key] = sanitizeString(updates[key], FIELD_MAX_LENGTHS[key] || 200);
      } else {
        filtered[key] = updates[key];
      }
    }
  }
  return filtered;
}

// ─────────────────── Row ↔ API shape mapping ───────────────────
// The API response shape matches the original app exactly
// (snake_case keys the client already expects).

export function rowToUser(row: any): any {
  if (!row) return null;
  return {
    username: row.username,
    password: row.password,
    salt: row.salt,
    hash_version: row.hashVersion,
    avatar: row.avatar || {},
    webuy: row.webuy,
    items_owned: row.itemsOwned || [],
    friends: row.friends || [],
    friend_requests: row.friendRequests || [],
    description: row.description || "",
    admin_role: row.adminRole || "none",
    banned: row.banned || { is_banned: false, reason: "" },
    created: row.created instanceof Date ? row.created.toISOString() : row.created,
    last_login: row.lastLogin instanceof Date ? row.lastLogin.toISOString() : row.lastLogin,
    notifications: row.notifications || [],
    profile_visible: row.profileVisible ?? true,
    notify_friends: row.notifyFriends ?? true,
    notify_purchases: row.notifyPurchases ?? true,
    notify_games: row.notifyGames ?? true,
    visual_settings: row.visualSettings || { dark_mode: true, ui_scale: 1, animations: true, reduce_motion: false },
    language: row.language || "en",
    blocked_users: row.blockedUsers || [],
    email: row.email || "",
    unread_messages: row.unreadMessages || 0,
    user_id: row.userId || 0,
    user_key: row.userKey || null,
    messages: row.messages || {},
    inventory: row.inventory || [],
  };
}

/** Map an API-shape user object to Prisma update fields. */
function userToPrismaData(user: any, username: string) {
  return {
    username,
    password: user.password,
    salt: user.salt,
    hashVersion: user.hash_version ?? 1,
    avatar: (user.avatar || {}) as any,
    webuy: user.webuy ?? 0,
    itemsOwned: user.items_owned || [],
    friends: user.friends || [],
    friendRequests: user.friend_requests || [],
    description: user.description || "",
    adminRole: user.admin_role || "none",
    banned: (user.banned || { is_banned: false, reason: "" }) as any,
    notifications: user.notifications || [],
    profileVisible: user.profile_visible ?? true,
    notifyFriends: user.notify_friends ?? true,
    notifyPurchases: user.notify_purchases ?? true,
    notifyGames: user.notify_games ?? true,
    visualSettings: (user.visual_settings || { dark_mode: true, ui_scale: 1, animations: true, reduce_motion: false }) as any,
    language: user.language || "en",
    blockedUsers: user.blocked_users || [],
    email: user.email || "",
    unreadMessages: user.unread_messages || 0,
    userId: user.user_id || 0,
    messages: (user.messages || {}) as any,
    inventory: (user.inventory || []) as any,
    userKey: user.user_key || null,
    ...(user.created ? { created: new Date(user.created) } : {}),
    ...(user.last_login ? { lastLogin: new Date(user.last_login) } : {}),
  };
}

// ─────────────────── Key protocol (ported) ───────────────────

const KEY_CHARSET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const KEY_LENGTH = 8;

export function generateObjectKey(length: number = KEY_LENGTH): string {
  const bytes = randomBytes(length);
  let result = "";
  for (let i = 0; i < length; i++) {
    result += KEY_CHARSET[bytes[i] % KEY_CHARSET.length];
  }
  return result;
}

export async function getUniqueUserKey(): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const key = generateObjectKey();
    const existing = await prisma.user.findUnique({ where: { userKey: key }, select: { username: true } });
    if (!existing) return key;
  }
  return generateObjectKey();
}

// ─────────────────── User CRUD (ported) ───────────────────

export async function getUser(username: string) {
  if (!username || username.includes("..") || username.includes("/") || username.includes("\\")) return null;
  try {
    const row = await prisma.user.findUnique({ where: { username } });
    return row ? rowToUser(row) : null;
  } catch {
    return null;
  }
}

export async function getUserByKey(key: string) {
  if (!key || !key.startsWith("USER-")) return null;
  const userKey = key.slice(5);
  if (!userKey || userKey.length < 2 || userKey.length > 50) return null;
  try {
    const row = await prisma.user.findUnique({ where: { userKey } });
    return row ? rowToUser(row) : null;
  } catch {
    return null;
  }
}

export async function saveUser(username: string, data: any): Promise<{ error?: string }> {
  try {
    const row = userToPrismaData({ ...data, username }, username);
    await prisma.user.upsert({
      where: { username },
      create: row,
      update: row,
    });
    return {};
  } catch (e: any) {
    console.error("[db] saveUser error:", e.message);
    return { error: e.message };
  }
}

export async function getAllUsers() {
  try {
    const rows = await prisma.user.findMany();
    return rows.map(rowToUser);
  } catch {
    return [];
  }
}

export async function searchUsers(query: string) {
  try {
    // Ported from Supabase .ilike — case-insensitive substring match
    const rows = await prisma.user.findMany({
      where: { username: { contains: query, mode: "insensitive" } },
      take: 20,
    });
    return rows.map((r) => stripSensitiveFields(rowToUser(r)));
  } catch {
    return [];
  }
}

export async function createUser(username: string, password: string) {
  const usernameValidation = validateUsername(username);
  if (!usernameValidation.valid) return { error: usernameValidation.error };

  if (!password || password.length < 6) return { error: "Password must be at least 6 characters" };
  if (password.length > 128) return { error: "Password must be at most 128 characters" };

  const existing = await getUser(username);
  if (existing) return { error: "Username already exists" };

  const userKey = await getUniqueUserKey();
  const salt = generateSalt();
  const user = {
    username,
    password: secureHashPassword(password, salt),
    salt,
    hash_version: 1,
    avatar: { shirt: "SHIRT-1", left_leg: "PANTS-1", right_leg: "PANTS-1", face: "FACE-1", skin: "#f8ff6d" },
    webuy: 100,
    items_owned: ["FACE-1", "SHIRT-1", "PANTS-1"],
    friends: [] as string[],
    friend_requests: [] as string[],
    description: "",
    admin_role: "none",
    banned: { is_banned: false, reason: "" },
    created: new Date().toISOString(),
    last_login: new Date().toISOString(),
    notifications: ["Welcome to WeildBuild!"] as string[],
    profile_visible: true,
    notify_friends: true,
    notify_purchases: true,
    notify_games: true,
    visual_settings: { dark_mode: true, ui_scale: 1, animations: true, reduce_motion: false },
    language: "en",
    blocked_users: [] as string[],
    user_key: userKey,
  };
  const saveResult = await saveUser(username, user);
  if (saveResult.error) {
    console.error("[createUser] saveUser failed:", saveResult.error);
    return { error: `Failed to create account: ${saveResult.error}` };
  }
  return { success: true, user };
}

export async function verifyLogin(username: string, password: string) {
  const user = await getUser(username);
  if (!user) return { error: "Invalid username or password" };
  if (user.banned?.is_banned) return { error: "Account is banned: " + (user.banned.reason || "No reason given") };

  const isValid = verifyPassword(password, user.password, user.salt, user.hash_version);
  if (!isValid) return { error: "Invalid username or password" };

  const { resetRateLimit } = await import("./ratelimits");
  await resetRateLimit(username);

  // Upgrade legacy SHA-256 hash to scrypt if needed
  if (!user.hash_version || user.hash_version < 1) {
    const newSalt = generateSalt();
    user.salt = newSalt;
    user.password = secureHashPassword(password, newSalt);
    user.hash_version = 1;
    await saveUser(username, user);
  }

  user.last_login = new Date().toISOString();
  await saveUser(username, user);
  return { success: true, user };
}

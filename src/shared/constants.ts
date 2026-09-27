// ═══════════════════════════════════════════════════════════
// WeildBuild Shared — platform constants
// ═══════════════════════════════════════════════════════════

/** Max devices logged into the same account at once (oldest evicted). */
export const MAX_SESSIONS_PER_USER = 5;

/** JWT lifetime: 10 years (sessions "never expire", matching the old system). */
export const SESSION_LIFETIME_SECONDS = 60 * 60 * 24 * 365 * 10;

/** Rate limit presets, ported from the original security.ts. */
export const RATE_LIMITS: Record<string, { maxAttempts: number; windowMs: number }> = {
  register: { maxAttempts: 5, windowMs: 60 * 60 * 1000 }, // 5 registrations per hour per IP
  login: { maxAttempts: 10, windowMs: 15 * 60 * 1000 }, // 10 login attempts per 15 min
  buy_item: { maxAttempts: 100, windowMs: 60 * 1000 },
  send_message: { maxAttempts: 60, windowMs: 60 * 1000 },
  create_game: { maxAttempts: 30, windowMs: 60 * 1000 },
  update_user: { maxAttempts: 300, windowMs: 60 * 1000 },
  general_api: { maxAttempts: 600, windowMs: 60 * 1000 },
  join_instance: { maxAttempts: 60, windowMs: 60 * 1000 },
  create_report: { maxAttempts: 10, windowMs: 60 * 60 * 1000 }, // 10 reports per hour
};

/** Default max players per game instance (user spec: 10). */
export const DEFAULT_MAX_PLAYERS_PER_INSTANCE = 10;

/** A host is considered dead if no heartbeat for this long. */
export const HOST_STALE_MS = 60 * 1000;

/** Prefixes allowed through the public /storage/download proxy. */
export const STORAGE_PUBLIC_PREFIXES = ["items/", "assets/"];

/** Fields users may update on their own profile. */
export const ALLOWED_USER_UPDATES = [
  "avatar", "description", "profile_visible", "notify_friends",
  "notify_purchases", "notify_games", "visual_settings", "language",
];

/** Fields only admins may modify. */
export const ADMIN_ONLY_FIELDS = ["admin_role", "banned", "webuy", "items_owned"];

// ═══════════════════════════════════════════════════════════
// WeildBuild - Moderation events (warnings & bans)
// ═══════════════════════════════════════════════════════════
// Warnings and bans must reach the player INSTANTLY, on any
// screen, as a full pop-up (same family as the "no internet"
// pop-up - never a toast). Three things feed the pop-up:
//
//   1. The Realtime socket (moderation:warning / moderation:banned)
//      - pushed by the server the MOMENT an admin acts. The
//        instant path for online players.
//   2. Login attempts - a banned account gets 403 + reason. The
//        pop-up replaces the little red error text.
//   3. App boot - a banned player whose session was deleted gets
//        logged out; we check their public profile so the pop-up
//        comes back instead of a silent logout.
//
// The pop-up component (ModerationPopup.tsx) listens for the
// window event dispatched here; page.tsx (which owns the socket
// and the game state) translates socket events + performs the
// kick-to-home.

import { API_URL } from "./server-config";

/** Window event carrying a warning or ban to the pop-up. */
export const MODERATION_EVENT = "wb:moderation";

/** Window event asking the app to leave any game and go home. */
export const FORCE_HOME_EVENT = "wb:force-home";

export interface ModerationDetail {
  kind: "warning" | "banned";
  /** warning: the warning text. banned: not used (see reason). */
  message?: string;
  /** banned: the admin's reason (required on bans). */
  reason?: string;
  /** who issued it (admin username). */
  from?: string;
  /** the affected player - used by the ban pop-up to poll for unban. */
  username: string;
}

/** Fire a moderation pop-up from anywhere (no React context needed). */
export function dispatchModeration(detail: ModerationDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<ModerationDetail>(MODERATION_EVENT, { detail }));
}

/** Ask the app to exit any running game and return to the home page. */
export function dispatchForceHome(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(FORCE_HOME_EVENT));
}

export interface BanStatus {
  banned: boolean;
  reason?: string;
}

/**
 * Check whether a player is currently banned, via their PUBLIC profile
 * (no session needed - works on the login screen and after being logged
 * out). Returns banned:false when the profile can't be reached - never
 * blocks anyone on a network hiccup.
 */
export async function checkBanStatus(username: string): Promise<BanStatus> {
  try {
    const res = await fetch(
      `${API_URL}/api/users?username=${encodeURIComponent(username)}`,
      { cache: "no-store", signal: AbortSignal.timeout(10000) },
    );
    if (!res.ok) return { banned: false };
    const user = await res.json();
    const ban = user?.banned;
    if (ban && typeof ban === "object" && ban.is_banned) {
      return { banned: true, reason: typeof ban.reason === "string" && ban.reason ? ban.reason : "No reason given" };
    }
    return { banned: false };
  } catch {
    return { banned: false };
  }
}

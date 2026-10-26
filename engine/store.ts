import { create } from "zustand";
import { API_URL } from "./server-config";
import { classifyConnectionError, notifyConnectionFailure } from "./connection";
import { dispatchModeration, checkBanStatus } from "./moderation";

// ==================== TYPES ====================
export interface AvatarData {
  skin: string;
  face: string;
  shirt: string | null;
  left_leg: string | null;
  right_leg: string | null;
}

export interface VisualSettings {
  dark_mode: boolean;
  ui_scale: number;
  animations: boolean;
  reduce_motion: boolean;
  sidebar_position?: 'left' | 'right';
}

export interface UserData {
  username: string;
  avatar: AvatarData;
  webuy: number;
  items_owned: string[];
  friends: string[];
  friend_requests: string[];
  /**
   * 1.0.1: usernames I have OUTGOING friend requests to (server v1.4.5+).
   * friend_requests above = INCOMING (people who sent me one). The two were
   * previously conflated in the UI, which made a received request look like
   * one I had sent. Undefined on older servers - the UI falls back to
   * checking the target's public friend_requests list.
   */
  sent_requests?: string[];
  description: string;
  admin_role: string;
  banned: { is_banned: boolean; reason: string };
  created: string;
  last_login: string;
  notifications: string[];
  profile_visible?: boolean;
  notify_friends?: boolean;
  notify_purchases?: boolean;
  notify_games?: boolean;
  /** v1.0: "Toast Messages" - master switch for the small pop-up toasts. */
  notify_toasts?: boolean;
  blocked_users?: string[];
  language?: string;
  visual_settings?: VisualSettings;
  /** Key-Protocol: Random 8-char key (e.g., "01gT476g"). Full Object Key is `USER-{user_key}`. */
  user_key?: string | null;
  /**
   * v1.0 (r12): GUEST SESSIONS ("Continue as Guest"). True when this user is
   * an ephemeral Guest-NNNN account created by the login card. Guests can
   * build in the studio, play games, join servers and view people, but the
   * server (and the UI, mirroring it) blocks: publishing games, buying
   * items, changing avatars, chatting (in-game + DMs), adding friends,
   * seeing messages from others, server-synced settings and voting.
   * Signing out deletes the account and every trace of it server-side.
   */
  is_guest?: boolean;
}

/**
 * Returns the user's full Object Key (e.g., "USER-01gT476g") based on their user_key.
 * Returns null if user_key is not set.
 */
export function getUserObjectKey(user: UserData | null | undefined): string | null {
  if (!user?.user_key) return null;
  return `USER-${user.user_key}`;
}

export interface ItemData {
  id: string;           // item_key like "FACE-1", "SHIRT-5"
  display_name: string; // "name" field from JSON
  item_type: "face" | "shirt" | "pants";
  price: number;
  description: string;
  creator: string;
  color: string;        // derived from ITEM_COLORS map
  date_created: string; // "year-day-month" format
  data?: string | null; // image path or base64
}

export interface GameData {
  id: string;
  name: string;
  description: string;
  creator: string;
  public: boolean;
  multiplayer: boolean;
  plays: number;
  created: string;
  last_update: string;
  /** 1.0.2: studio-view photo of the project captured by the studio at
   * save/publish time - the same 3/4 top-down angle the editor shows a
   * project at on load-in (JPEG data URL). Shown on lobby game cards;
   * undefined on older games -> classic console icon. */
  thumbnail?: string;
  /** v1.1: the game's world as an encrypted .wbworld blob (base64) -
   * the EXACT bytes a File > Export would write. Present on every game
   * saved after the format switch; decoded client-side with the same
   * code File > Import uses (see lib/wbworld.ts decodeGameWorld).
   * The server stores this in the game_worlds table and never sees the
   * plain JSON - smaller rows, more games per database. */
  world_b64?: string;
  /** v1.1: the list endpoint no longer ships these heavy fields; they
   * remain on SINGLE-game fetches of not-yet-migrated legacy rows. */
  primitives?: PrimitiveData[];
  spawn_point?: number[];
  sky_color_top?: number[];
  sky_color_bottom?: number[];
  baseplate_color?: number[];
  baseplate_size?: number;
  max_players?: number;
  /**
   * Full editor state - the SINGLE source of truth for game play.
   *
   * When present, the GamePlayer loads this into the studio store and runs
   * the SAME engine the editor uses (physics, WeildCode rules, terrain,
   * sky, day/night, weather, bodyMovers, joints, effects - everything).
   *
   * When absent (legacy games saved before this fix), the GamePlayer
   * falls back to converting primitives via the legacy bridge.
   *
   * Type is `any` here to avoid a circular import between store.ts and
   * studio-project.ts. The actual type is StudioProjectState.
   */
  studioState?: any;
}

export interface PrimitiveData {
  id?: string;
  position: number[];
  size: number[];
  color: number[];
  rotation: number[];
  shape_type: "block" | "sphere" | "cylinder" | "wedge" | "corner_wedge" | "spawn_point"
    | "kill_brick" | "speed_pad" | "checkpoint" | "item_pickup" | "truss" | "ramp"
    | "lava" | "water" | "door" | "teleporter" | "npc" | "player";
  name?: string;
  anchored?: boolean;
  locked?: boolean;
  visible?: boolean;
  script?: string;
  material?: string;
  transparency?: number;
  reflectance?: number;
  player_hp?: number;
  player_walk_speed?: number;
  player_jump_force?: number;
}

export interface ChatMessage {
  id?: string;
  sender: string;
  content: string;
  receiver: string;
  timestamp?: string;
}

export interface NotificationData {
  id: string;
  type: "friend_request" | "friend_accepted" | "item_purchased" | "game_created" | "system" | "warning" | "banned" | "unbanned" | "announcement" | "admin_role" | "welcome";
  /** Optional headline (announcement letters use it as the subject). */
  title?: string;
  /** v1.9.3: the announcement category (WeildBuild Update, Notice, custom text, ...). */
  category?: string;
  message: string;
  from?: string;
  read: boolean;
  timestamp: string;
}

// ==================== VIEW TYPE ====================
export type View = "lobby" | "avatar" | "notifications" | "friends" | "shop" | "inventory" | "settings" | "profile" | "create" | "admin" | "vote";

// ==================== SECURE API FETCH ====================
// All requests go to the official WeildBuild Main Server (see
// server-config.ts - the URL is fixed, users cannot change it).
// The session ticket (JWT) is sent via the X-Session-Token header;
// the server also sets a cookie for browser clients.

// fetch() wrapper: turns network-level failures (the browser's raw
// "Failed to fetch") into a friendly error message and wakes up the
// connection pop-up so the player immediately sees what is wrong.
async function networkFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    const name = (err as any)?.name || "";
    // Timeouts keep their original error so callers can handle them
    if (name === "AbortError" || name === "TimeoutError") throw err;
    notifyConnectionFailure(classifyConnectionError(err));
    throw new Error(
      "Could not reach the WeildBuild server. It might be sleeping or busy, or your internet might be down. Please try again in a moment."
    );
  }
}

export async function apiFetch(path: string, options?: RequestInit) {
  const isGet = !options?.method || options.method === "GET";
  const headers: Record<string, string> = {};
  if (!isGet) headers["Content-Type"] = "application/json";
  // Send the session ticket header (desktop app / cross-origin)
  const st = loadSessionToken();
  if (st) headers["X-Session-Token"] = st;
  const mergedHeaders = { ...headers, ...(options?.headers as Record<string, string> || {}) };

  const res = await networkFetch(`${API_URL}/api${path}`, {
    ...options,
    headers: mergedHeaders,
    credentials: "include", // cookies for browser clients
  });

  // Handle 401 Unauthorized - attempt automatic session recovery before giving up
  if (res.status === 401) {
    // v13.11: /auth POST failures must surface the SERVER's own error.
    // Session recovery makes no sense when the client is ESTABLISHING a
    // session (login/register/changePassword) — and the generic fallback
    // below ("Session expired. Please log in again.") was hiding the real
    // reason: banned players saw "Session expired" instead of "Account is
    // banned: <reason>", and even wrong passwords showed the same confusing
    // message. (Banned logins now also come back as 403 from server v1.4.2,
    // which older clients already display correctly — this covers the rest.)
    if (path === "/auth" && !isGet) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || "Login failed");
    }
    const isWriteOp = !isGet;
    if (isWriteOp) {
      // The session token might be stale (e.g. after password change on another device)
      // but the cookie might still be valid. Try to refresh the token once.
      try {
        const savedToken = loadSessionToken();
        const authHeaders: Record<string, string> = {};
        if (savedToken) authHeaders["X-Session-Token"] = savedToken;
        const sessionCheck = await networkFetch(`${API_URL}/api/auth`, { credentials: "include", headers: authHeaders });
        const sessionData = await sessionCheck.json();
        if (sessionData.authenticated && sessionData.username) {
          // Session cookie is valid! The X-Session-Token header might have been stale.
          // Retry the original request - the cookie will authenticate it this time.
          const retryRes = await networkFetch(`${API_URL}/api${path}`, {
            ...options,
            headers: mergedHeaders,
            credentials: "include",
          });
          if (retryRes.ok) return retryRes.json();
          if (retryRes.status !== 401) {
            // Different error on retry - handle normally
            if (retryRes.status === 429) {
              const body = await retryRes.json().catch(() => ({}));
              throw new Error(body.error || "Too many requests. Please slow down.");
            }
            if (retryRes.status === 403) {
              const body = await retryRes.json().catch(() => ({}));
              throw new Error(body.error || "You don't have permission to do that.");
            }
            const errorBody = await retryRes.json().catch(() => ({ error: `Request failed with status ${retryRes.status}` }));
            throw new Error(errorBody.error || `Request failed with status ${retryRes.status}`);
          }
          // Still 401 after retry - session is truly invalid
        }
      } catch (refreshErr: any) {
        // If the refresh attempt itself threw a non-session error, re-throw it
        if (refreshErr.message && !refreshErr.message.includes("Session expired") && !refreshErr.message.includes("Not authenticated")) {
          throw refreshErr;
        }
      }
      // Session recovery failed - user needs to log in again
      throw new Error("Session expired. Please log in again.");
    }
    // GET request returned 401 - just throw, don't auto-logout
    throw new Error("Not authenticated");
  }

  // Handle 429 Rate Limited
  if (res.status === 429) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Too many requests. Please slow down.");
  }

  // Handle 403 Forbidden
  if (res.status === 403) {
    const body = await res.json().catch(() => ({}));
    // v1.4.7: a banned login comes back as 403 with { banned: true, reason }.
    // Attach them to the error so the login flow can raise the BAN POP-UP
    // (same style as the no-internet one) instead of a little error line.
    const err = new Error(body.error || "You don't have permission to do that.");
    if (body.banned) {
      (err as any).banned = true;
      (err as any).banReason = body.reason || "No reason given";
    }
    throw err;
  }

  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({ error: `Request failed with status ${res.status}` }));
    throw new Error(errorBody.error || `Request failed with status ${res.status}`);
  }

  return res.json();
}

// ==================== LOCAL PERSISTENCE HELPERS ====================
// Cache the full user object AND session token in localStorage so we can restore
// instantly on refresh, then verify with the server in the background.

function saveUserToLocal(user: UserData) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem("weildbuild_user", JSON.stringify(user));
  } catch {}
}

export function saveSessionToken(token: string) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem("weildbuild_session", token);
  } catch {}
}

export function loadSessionToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const t = localStorage.getItem("weildbuild_session");
    // Guard against stale tokens from the pre-migration system (64-hex opaque
    // tokens) - the new tickets are JWTs starting with "eyJ".
    if (t && !t.startsWith("eyJ")) return null;
    return t;
  } catch {
    return null;
  }
}

function clearSessionToken() {
  if (typeof window === "undefined") return;
  try { localStorage.removeItem("weildbuild_session"); } catch {}
}

function loadUserFromLocal(): UserData | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem("weildbuild_user");
    if (!raw) return null;
    // Handle both old format (plain username string) and new format (JSON user object)
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.username) return parsed as UserData;
    // Old format: just a username string - return null, will be re-fetched by refreshUser
    return null;
  } catch {
    // Could be a plain string (old format) that isn't valid JSON
    // e.g. localStorage had "WeildBuild" (just the username)
    // Return null - refreshUser will re-authenticate via the session cookie
    return null;
  }
}

function clearLocalUser() {
  if (typeof window === "undefined") return;
  try { localStorage.removeItem("weildbuild_user"); } catch {}
}

// ==================== AUTH STORE ====================
interface AuthState {
  user: UserData | null;
  isLoggedIn: boolean;
  login: (username: string, password: string) => Promise<{ success: boolean; error?: string }>;
  register: (username: string, password: string) => Promise<{ success: boolean; error?: string }>;
  /** v1.0 (r12): "Continue as Guest" - the server invents a Guest-NNNN
   * account + session and we log into it like any other user. */
  loginAsGuest: () => Promise<{ success: boolean; error?: string }>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  updateUser: (updates: Partial<UserData>) => Promise<void>;
}

export const useAuth = create<AuthState>((set, get) => ({
  // Always start as logged out - we'll restore from localStorage in refreshUser()
  // This avoids hydration mismatches between server (no localStorage) and client
  user: null,
  isLoggedIn: false,

  login: async (username, password) => {
    try {
      const result = await apiFetch("/auth", {
        method: "POST",
        body: JSON.stringify({ action: "login", username, password }),
      });
      if (result.success) {
        saveUserToLocal(result.user);
        if (result.sessionToken) saveSessionToken(result.sessionToken);
        set({ user: result.user, isLoggedIn: true });
        return { success: true };
      }
      return { success: false, error: result.error };
    } catch (e: any) {
      // v1.4.7: banned login -> the full-screen BAN POP-UP (with the
      // reason), not a little red error line. It stays on screen until
      // the ban is lifted (the pop-up polls for that itself).
      if (e?.banned) {
        dispatchModeration({ kind: "banned", reason: e.banReason, username });
      }
      return { success: false, error: e.message || "Login failed" };
    }
  },

  register: async (username, password) => {
    try {
      const result = await apiFetch("/auth", {
        method: "POST",
        body: JSON.stringify({ action: "register", username, password }),
      });
      if (result.success) {
        saveUserToLocal(result.user);
        if (result.sessionToken) saveSessionToken(result.sessionToken);
        set({ user: result.user, isLoggedIn: true });
        // v1.9.3: flag the one time welcome popup. The app root sees it
        // as soon as the logged in view renders, shows the welcome
        // screen, then clears the flag: it appears exactly once, right
        // after signup (the inbox keeps the welcome letter forever).
        try { sessionStorage.setItem("wb_welcome_pending", username); } catch {}
        return { success: true };
      }
      return { success: false, error: result.error };
    } catch (e: any) {
      return { success: false, error: e.message || "Registration failed" };
    }
  },

  loginAsGuest: async () => {
    // v1.0 (r12): the server creates the account, picks the Guest-NNNN id
    // and returns a normal session. Everything downstream (socket auth,
    // game joins, profile views) works exactly like a real account; the
    // restricted features key off user.is_guest instead.
    try {
      const result = await apiFetch("/auth", {
        method: "POST",
        body: JSON.stringify({ action: "guest" }),
      });
      if (result.success) {
        saveUserToLocal(result.user);
        if (result.sessionToken) saveSessionToken(result.sessionToken);
        set({ user: result.user, isLoggedIn: true });
        return { success: true };
      }
      return { success: false, error: result.error };
    } catch (e: any) {
      return { success: false, error: e.message || "Could not start a guest session" };
    }
  },

  logout: async () => {
    // Call logout API to clear session server-side
    try {
      await apiFetch("/auth", {
        method: "POST",
        body: JSON.stringify({ action: "logout" }),
      });
    } catch (e) {
      console.warn('Logout API call failed - server session may still be active', e);
    }
    clearLocalUser();
    clearSessionToken();
    set({ user: null, isLoggedIn: false });
  },

  refreshUser: async () => {
    // STEP 1: Instantly restore from localStorage cache (avoids flash of logged-out state)
    const cachedUser = loadUserFromLocal();
    const savedToken = loadSessionToken();
    if (cachedUser) {
      set({ user: cachedUser, isLoggedIn: true });
    }

    // STEP 2: Verify session with the server
    // Always check even if we have cached data - the session might have been invalidated
    try {
      const authHeaders: Record<string, string> = {};
      if (savedToken) authHeaders["X-Session-Token"] = savedToken;
      const sessionCheck = await apiFetch("/auth", { headers: authHeaders });
      const sessionData = await sessionCheck;

      if (sessionData.authenticated && sessionData.username) {
        // Session is valid! Fetch fresh user data from server
        try {
          const user = await apiFetch(`/users?username=${sessionData.username}`);
          if (user.username) {
            saveUserToLocal(user);
            set({ user, isLoggedIn: true });
            return;
          }
        } catch {
          // Failed to fetch user data, but session IS valid - keep cached data
          if (cachedUser) {
            set({ user: cachedUser, isLoggedIn: true });
            return;
          }
        }
      }

      // 1.0.1 GHOST-LOGIN FIX: the server answered and said we are NOT
      // authenticated. The old code then "fell back" to fetching the user's
      // PUBLIC profile (/users?username=... needs no auth) and kept the UI
      // logged in as that user - with NO valid session. Every write action
      // (friend add/block/unfriend, messages, purchases...) then failed
      // with 401 and the failure was swallowed, which looked like "the
      // friend system is bugged". A definitive "not authenticated" answer
      // from the server now logs out cleanly instead.
      clearLocalUser();
      clearSessionToken();
      set({ user: null, isLoggedIn: false });

      // v1.4.7: was that a BAN? A banned player's sessions are deleted, so
      // from the app's point of view it looks like any expired session.
      // Check the public profile: if the account is banned, raise the ban
      // pop-up (with the reason) instead of quietly landing on the login
      // screen. Never blocks anyone on a network error.
      if (cachedUser?.username) {
        checkBanStatus(cachedUser.username).then((status) => {
          if (status.banned) {
            dispatchModeration({
              kind: "banned",
              reason: status.reason,
              username: cachedUser.username,
            });
          }
        }).catch(() => {});
      }
    } catch {
      // Network error (server unreachable) - don't clear session, keep
      // cached user data so the app stays usable offline. Writes will
      // surface visible errors instead of silently doing nothing.
      if (cachedUser) {
        set({ user: cachedUser, isLoggedIn: true });
      }
    }
  },

  updateUser: async (updates) => {
    const { user } = get();
    if (!user) return;
    try {
      const result = await apiFetch(`/users`, {
        method: "PUT",
        body: JSON.stringify({ username: user.username, ...updates }),
      });
      if (result.username) {
        saveUserToLocal(result);
        set({ user: result });
      }
    } catch (e: any) {
      throw e;
    }
  },
}));

// ==================== ITEMS STORE ====================
interface ItemsState {
  items: ItemData[];
  loading: boolean;
  itemsLoading: boolean;
  fetchItems: (type?: string) => Promise<void>;
  buyItem: (itemId: string) => Promise<{ success: boolean; error?: string }>;
}

export const useItems = create<ItemsState>((set, get) => ({
  items: [],
  loading: false,
  itemsLoading: false,

  fetchItems: async (type) => {
    if (get().itemsLoading) return; // Dedup: already fetching
    set({ loading: true, itemsLoading: true });
    try {
      const query = type ? `?type=${type}` : "";
      const items = await apiFetch(`/items${query}`);
      set({ items: Array.isArray(items) ? items : [], loading: false, itemsLoading: false });
    } catch {
      set({ items: [], loading: false, itemsLoading: false });
    }
  },

  buyItem: async (itemId) => {
    const { user } = useAuth.getState();
    if (!user) return { success: false, error: "Not logged in" };
    try {
      const result = await apiFetch(`/items`, {
        method: "POST",
        body: JSON.stringify({ username: user.username, itemId }),
      });
      if (result.success) {
        // Update items list to reflect new ownership
        set({
          items: get().items.map(item =>
            item.id === itemId ? { ...item, owned: true } : item
          )
        });
        useAuth.setState({ user: result.user });
        saveUserToLocal(result.user);
        return { success: true };
      }
      return { success: false, error: result.error };
    } catch (e: any) {
      return { success: false, error: e.message || "Purchase failed" };
    }
  },
}));

// ==================== GAMES STORE ====================
interface GamesState {
  games: GameData[];
  currentGame: GameData | null;
  loading: boolean;
  gamesLoading: boolean;
  fetchGames: () => Promise<void>;
  /** v1.1: fetches the FULL game (metadata + encrypted world blob) and
   * RETURNS it - the list objects no longer carry studio state, so every
   * play/edit flow must go through here for the world. */
  fetchGame: (id: string) => Promise<GameData | null>;
  createGame: (game: Partial<GameData>) => Promise<GameData | null>;
  updateGame: (id: string, updates: Partial<GameData>) => Promise<GameData | null>;
  /** v13.9: permanently delete one of MY games (creator) or any game (admin). */
  deleteGame: (id: string) => Promise<{ success: boolean; error?: string }>;
}

export const useGames = create<GamesState>((set, get) => ({
  games: [],
  currentGame: null,
  loading: false,
  gamesLoading: false,

  fetchGames: async () => {
    if (get().gamesLoading) return; // Dedup: already fetching
    set({ loading: true, gamesLoading: true });
    try {
      const games = await apiFetch("/games");
      set({ games: Array.isArray(games) ? games : [], loading: false, gamesLoading: false });
    } catch {
      set({ games: [], loading: false, gamesLoading: false });
    }
  },

  fetchGame: async (id) => {
    set({ loading: true });
    try {
      const game = await apiFetch(`/games?id=${id}`);
      const full = game.id ? game : null;
      set({ currentGame: full, loading: false });
      // v1.1: return the full game (with world_b64) so play/edit flows
      // can use it directly - list objects no longer carry the world.
      return full;
    } catch {
      set({ currentGame: null, loading: false });
      return null;
    }
  },

  createGame: async (gameData) => {
    try {
      const result = await apiFetch("/games", {
        method: "POST",
        body: JSON.stringify(gameData),
      });
      if (result.id) {
        set((s) => ({ games: [result, ...s.games] }));
        return result;
      }
      return null;
    } catch {
      return null;
    }
  },

  updateGame: async (id, updates) => {
    try {
      const result = await apiFetch(`/games`, {
        method: "PUT",
        body: JSON.stringify({ id, ...updates }),
      });
      if (result.id) {
        set((s) => ({
          games: s.games.map((g) => (g.id === id ? result : g)),
          currentGame: s.currentGame?.id === id ? result : s.currentGame,
        }));
        return result as GameData;
      }
      return null;
    } catch (e) {
      console.error("Failed to update game:", e);
      return null;
    }
  },

  deleteGame: async (id) => {
    try {
      await apiFetch(`/games?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      set((s) => ({
        games: s.games.filter((g) => g.id !== id),
        currentGame: s.currentGame?.id === id ? null : s.currentGame,
      }));
      return { success: true };
    } catch (e: any) {
      return { success: false, error: e.message || "Failed to delete game" };
    }
  },
}));

// ==================== FRIENDS STORE ====================
interface FriendsState {
  friendRequests: string[];
  searchResults: Array<{ username: string; avatar?: AvatarData; webuy?: number; description?: string; created?: string }>;
  loading: boolean;
  fetchFriends: (username: string) => Promise<void>;
  sendRequest: (from: string, to: string) => Promise<{ success: boolean; error?: string }>;
  acceptRequest: (username: string, friend: string) => Promise<{ success: boolean; error?: string }>;
  declineRequest: (username: string, friend: string) => Promise<{ success: boolean; error?: string }>;
  removeFriend: (username: string, friend: string) => Promise<{ success: boolean; error?: string }>;
  blockUser: (username: string, target: string) => Promise<{ success: boolean; error?: string }>;
  unblockUser: (username: string, target: string) => Promise<{ success: boolean; error?: string }>;
  searchUsers: (query: string) => Promise<void>;
}

export const useFriends = create<FriendsState>((set) => ({
  friendRequests: [],
  searchResults: [],
  loading: false,

  fetchFriends: async (username) => {
    set({ loading: true });
    try {
      const result = await apiFetch(`/friends?username=${username}`);
      set({ friendRequests: result.friend_requests || [], loading: false });
    } catch {
      set({ loading: false });
    }
  },

  sendRequest: async (from, to) => {
    try {
      const result = await apiFetch("/friends", {
        method: "POST",
        body: JSON.stringify({ action: "request", from, to }),
      });
      return result;
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  },

  acceptRequest: async (username, friend) => {
    try {
      const result = await apiFetch("/friends", {
        method: "POST",
        body: JSON.stringify({ action: "accept", username, friend }),
      });
      return result;
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  },

  declineRequest: async (username, friend) => {
    try {
      const result = await apiFetch("/friends", {
        method: "POST",
        body: JSON.stringify({ action: "decline", username, friend }),
      });
      return result;
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  },

  removeFriend: async (username, friend) => {
    try {
      const result = await apiFetch("/friends", {
        method: "POST",
        body: JSON.stringify({ action: "remove", username, friend }),
      });
      return result;
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  },

  blockUser: async (username, target) => {
    try {
      const result = await apiFetch("/friends", {
        method: "POST",
        body: JSON.stringify({ action: "block", username, target }),
      });
      return result;
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  },

  unblockUser: async (username, target) => {
    try {
      const result = await apiFetch("/friends", {
        method: "POST",
        body: JSON.stringify({ action: "unblock", username, target }),
      });
      return result;
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  },

  searchUsers: async (query) => {
    set({ loading: true });
    try {
      const result = await apiFetch(`/users?search=${encodeURIComponent(query)}`);
      set({ searchResults: Array.isArray(result) ? result : [], loading: false });
    } catch {
      set({ searchResults: [], loading: false });
    }
  },
}));

// ==================== NOTIFICATIONS STORE ====================
interface NotificationsState {
  notifications: NotificationData[];
  unreadCount: number;
  loading: boolean;
  fetchNotifications: (username: string) => Promise<void>;
  markRead: (username: string) => Promise<void>;
}

export const useNotifications = create<NotificationsState>((set) => ({
  notifications: [],
  unreadCount: 0,
  loading: false,

  fetchNotifications: async (username) => {
    set({ loading: true });
    try {
      const result = await apiFetch(`/notifications?username=${username}`);
      const notifs = Array.isArray(result) ? result : [];
      set({
        notifications: notifs,
        unreadCount: notifs.filter((n: NotificationData) => !n.read).length,
        loading: false,
      });
    } catch {
      set({ notifications: [], unreadCount: 0, loading: false });
    }
  },

  markRead: async (username) => {
    try {
      await apiFetch("/notifications", {
        method: "POST",
        body: JSON.stringify({ action: "markRead", username }),
      });
      set((s) => ({
        notifications: s.notifications.map((n) => ({ ...n, read: true })),
        unreadCount: 0,
      }));
    } catch {
      // Silently fail - non-critical operation
    }
  },
}));

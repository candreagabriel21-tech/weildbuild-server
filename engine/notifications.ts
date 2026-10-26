// ═══════════════════════════════════════════════════════════
// WeildBuild - In-app notifications (messages, friends, updates)
// ═══════════════════════════════════════════════════════════
// "Get notifications when someone messages you":
//   • A TINY pop-up appears anywhere in the app - including inside a
//     running game - when a DM, friend request, friend acceptance or a
//     WeildBuild Update (announcement letter) arrives
//     (NotificationPopup.tsx renders it).
//   • A REAL system notification (Windows/macOS/Android toast) fires at
//     the same time via the web Notification API. In the desktop exe
//     (Electron) and on the website this shows a native OS notification
//     even when the window is minimized. Permission is requested from
//     Settings (one tap) - or from the tiny pop-up itself the first
//     time a message arrives.
//
// Everything is driven by window events so any part of the app (socket
// handlers, the session heartbeat, future features) can raise a
// notification without React context.
//
// v1.0 (this build) adds:
//   • announcement letters (click a card/row -> the full message opens
//     as a letter, AnnouncementLetter.tsx listens for WB_LETTER_EVENT)
//   • working navigation: clicking a card (or the OS notification) now
//     really takes you there - including opening the exact DM chat
//     (NAVIGATE_EVENT carries an optional chatWith target)
//   • active-chat tracking: while you are reading a conversation, new
//     DMs from that person refresh the chat silently instead of
//     popping up (setActiveDmChat / getActiveDmChat)

// ─── Tiny pop-up event ───

export type NotifyKind =
  | "dm"
  | "friend_request"
  | "friend_accepted"
  | "info"
  | "announcement";

export interface AppNotification {
  kind: NotifyKind;
  /** Short bold line, e.g. "New message from Ada". */
  title: string;
  /** One-line detail, e.g. the message preview. */
  body?: string;
  /** Who it is from (username) - used for the avatar chip. */
  from?: string;
  /** Where to go when the pop-up is clicked. */
  view?: "friends" | "notifications";
  /** Open this DM conversation when clicked (view should be "friends"). */
  chatWith?: string;
  /** When set, clicking opens this letter instead of navigating. */
  letter?: LetterPayload;
}

/** An announcement ("WeildBuild Update" or any other category) shown as a full letter. */
export interface LetterPayload {
  title: string;
  message: string;
  from: string;
  timestamp?: string;
  /** v1.9.3: the category the admin picked when sending (WeildBuild
   *  Update, Announcement, Notice, Admin Message, Important Message,
   *  or custom text). Shown as the letter's heading. */
  category?: string;
}

/** Window event carrying a notification to the tiny pop-up. */
export const WB_NOTIFY_EVENT = "wb:notify";

/** Raise the tiny in-app pop-up (and the system notification). */
export function dispatchAppNotification(n: AppNotification): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<AppNotification>(WB_NOTIFY_EVENT, { detail: n }));
}

// ─── Letter event (announcement pop-up) ───

/** Window event carrying an announcement letter to AnnouncementLetter.tsx. */
export const WB_LETTER_EVENT = "wb:letter";

/** Open the announcement letter overlay (works on every screen, mid-game too). */
export function openLetter(letter: LetterPayload): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<LetterPayload>(WB_LETTER_EVENT, { detail: letter }));
}

// ─── Navigation event ───

/**
 * Where a notification click wants to go.
 *  - view: the app view to switch to ("friends", "notifications", ...)
 *  - chatWith: also open this friend's DM conversation (FriendsView)
 *  - letter: open this announcement letter instead of navigating
 */
export interface NavigateTarget {
  view: string;
  chatWith?: string;
  letter?: LetterPayload;
}

/** Window event asking the app to switch views (fired when a card is clicked). */
export const NAVIGATE_EVENT = "wb:navigate";

/** Ask the app shell to go somewhere (used by cards + OS notifications). */
export function requestNavigation(target: NavigateTarget | string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<NavigateTarget | string>(NAVIGATE_EVENT, { detail: target })
  );
}

// ─── Active DM chat tracking ───
// While the user is actively reading a conversation, incoming DMs from
// that person must NOT pop up (the chat already refreshes in place).
// FriendsView keeps this little module-level value up to date.

let activeDmChat: string | null = null;

/** Record which DM conversation is currently open on screen (null = none). */
export function setActiveDmChat(username: string | null): void {
  activeDmChat = username;
}

/** Is the user actively reading this person's chat right now? */
export function isDmChatActive(username: string | null | undefined): boolean {
  if (!username || !activeDmChat) return false;
  return activeDmChat.toLowerCase() === username.toLowerCase();
}

// ─── System (web) notifications ───

export function webNotificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function webNotificationPermission(): NotificationPermission | "unsupported" {
  if (!webNotificationsSupported()) return "unsupported";
  return Notification.permission;
}

/**
 * Ask the browser for notification permission. MUST be called from a user
 * gesture (button click) - browsers ignore/deny prompts without one.
 * In the Electron desktop app the permission is already granted, so this
 * is a no-op that reports "granted".
 */
export function requestWebNotificationPermission(): Promise<NotificationPermission | "unsupported"> {
  if (!webNotificationsSupported()) return Promise.resolve("unsupported");
  if (Notification.permission !== "default") return Promise.resolve(Notification.permission);
  return Notification.requestPermission().catch(() => Notification.permission as NotificationPermission);
}

/**
 * Fire a native OS notification if the user allowed it. Tagged so the same
 * sender collapses into one OS notification instead of stacking.
 * v1.0: clicking the OS notification now actually navigates (it used to
 * only focus the window - "Click to bring there" did nothing).
 */
export function maybeShowWebNotification(
  title: string,
  body: string,
  tag: string,
  nav?: NavigateTarget
): void {
  if (!webNotificationsSupported() || Notification.permission !== "granted") return;
  try {
    const n = new Notification(title, {
      body,
      tag,
      icon: "/logos/icon-192.png",
      silent: false,
    });
    // Focus our window AND go where the notification points (open the
    // chat / the letter / the right view) when the user clicks it.
    n.onclick = () => {
      try {
        window.focus();
        if (nav) requestNavigation(nav);
      } catch {}
      n.close();
    };
  } catch {
    // Some platforms throw on the icon path or in certain contexts - never
    // let a notification failure break anything.
  }
}

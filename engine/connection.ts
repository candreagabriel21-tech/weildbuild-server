// ═══════════════════════════════════════════════════════════
// WeildBuild - Main Server connection diagnostics
// ═══════════════════════════════════════════════════════════
// Answers one question in plain English: "Why can't the app
// talk to the Main Server right now?" The connection pop-up
// (ServerConnectionPopup.tsx) shows the answer so players
// never see a raw "Failed to fetch" error again.

import { API_URL } from "./server-config";

export type ConnectionIssueKind =
  | "offline"
  | "timeout"
  | "busy"
  | "rate-limited"
  | "server-error"
  | "unreachable";

export interface ConnectionIssue {
  kind: ConnectionIssueKind;
  title: string;
  message: string;
  hint?: string;
}

/** Window event fired whenever the Main Server becomes unreachable. */
export const CONNECTION_FAILED_EVENT = "wb:connection-failed";

export function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

export const OFFLINE_ISSUE: ConnectionIssue = {
  kind: "offline",
  title: "No internet connection",
  message: "Your device is not connected to the internet right now.",
  hint: "Check your Wi-Fi or network cable, then try again.",
};

export const TIMEOUT_ISSUE: ConnectionIssue = {
  kind: "timeout",
  title: "The server did not respond",
  message:
    "We knocked on the server's door but it did not answer in time. Free servers go to sleep when nobody is playing, and waking up can take up to a minute.",
  hint: "Give it a moment and try again. We also keep retrying automatically.",
};

export const BUSY_ISSUE: ConnectionIssue = {
  kind: "busy",
  title: "The server is too busy",
  message:
    "Too many players are trying to connect at the same time, so the server said it is overloaded right now.",
  hint: "Wait a minute or two, then try again.",
};

export const RATE_LIMITED_ISSUE: ConnectionIssue = {
  kind: "rate-limited",
  title: "Too many requests",
  message:
    "The server is asking us to slow down because requests are being sent too fast.",
  hint: "Wait a few seconds, then try again.",
};

export function serverErrorIssue(status: number): ConnectionIssue {
  return {
    kind: "server-error",
    title: "The server has a problem",
    message: `The server answered but said it has a problem right now (error ${status}). This is on our side, not yours.`,
    hint: "It usually fixes itself in a few minutes. If it keeps happening, let us know.",
  };
}

export const UNREACHABLE_ISSUE: ConnectionIssue = {
  kind: "unreachable",
  title: "Could not reach the server",
  message:
    "We could not talk to the WeildBuild server at all. It might be sleeping, restarting, or updating.",
  hint: "Check your internet connection, then try again in a minute.",
};

/** Turn an HTTP status code into a friendly explanation. */
export function classifyStatus(status: number): ConnectionIssue {
  if (status === 429) return RATE_LIMITED_ISSUE;
  if (status === 503) return BUSY_ISSUE;
  return serverErrorIssue(status);
}

/** Turn any thrown error into a friendly explanation. */
export function classifyConnectionError(err: unknown): ConnectionIssue {
  if (isOffline()) return OFFLINE_ISSUE;
  const e = err as { name?: string; message?: string } | null | undefined;
  const name = e?.name || "";
  const message = e?.message || "";
  // AbortSignal.timeout() rejects with a DOMException named "TimeoutError";
  // a manual AbortController rejects with "AbortError". Both = too slow.
  if (name === "TimeoutError" || name === "AbortError") return TIMEOUT_ISSUE;
  // fetch() throws a TypeError when the server cannot be reached at all.
  if (name === "TypeError") return UNREACHABLE_ISSUE;
  // Our own "status NNN" pattern (the server answered with an error code).
  const statusMatch = message.match(/status (\d{3,})/);
  if (statusMatch) return classifyStatus(Number(statusMatch[1]));
  return UNREACHABLE_ISSUE;
}

/** Fire the global "connection failed" event (the pop-up listens for it). */
export function notifyConnectionFailure(issue?: ConnectionIssue) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<ConnectionIssue>(CONNECTION_FAILED_EVENT, {
      detail: issue ?? classifyConnectionError(null),
    })
  );
}

/**
 * Ping the Main Server's /health endpoint.
 * Returns null when the server is reachable, or the reason it is not.
 */
export async function checkMainServer(
  timeoutMs = 12000
): Promise<ConnectionIssue | null> {
  if (isOffline()) return OFFLINE_ISSUE;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_URL}/health`, {
      signal: controller.signal,
      cache: "no-store",
    });
    if (res.ok) return null;
    // The server answered, so it IS online for connection purposes.
    // Only rate limiting and error codes count as connection problems.
    if (res.status === 429 || res.status === 503 || res.status >= 500) {
      return classifyStatus(res.status);
    }
    return null;
  } catch (err) {
    return classifyConnectionError(err);
  } finally {
    clearTimeout(timer);
  }
}

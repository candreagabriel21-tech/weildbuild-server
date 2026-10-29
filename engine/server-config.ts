// ═══════════════════════════════════════════════════════════
// WeildBuild - official server configuration
// ═══════════════════════════════════════════════════════════
// The client always talks to the OFFICIAL WeildBuild platform
// servers - users cannot change this in-app (by design).
//
// The URLs are baked in at build time from NEXT_PUBLIC_* env
// vars (see .env.example). For local development against
// locally-running servers, set:
//   NEXT_PUBLIC_API_URL=http://localhost:8000
//   NEXT_PUBLIC_REALTIME_URL=http://localhost:3003
//
// v13.3: the version now lives in ONE place — package.json
// "version". APP_VERSION below reads it directly, and
// scripts/sync-version.mjs stamps the same number into the
// splash screen, tauri.conf.json and Cargo.toml automatically
// (runs before dev/build). To bump the version, change
// package.json ONLY.

import pkg from "../../package.json";

/** The Main Server - accounts, games, items, friends, everything.
 *  v6.2s: if NEXT_PUBLIC_API_URL is SET but empty (""), that means
 *  "same origin" (sandbox web preview proxies the API through Next.js
 *  rewrites) — an UNSET var still falls back to the official server. */
export const API_URL = (
  process.env.NEXT_PUBLIC_API_URL !== undefined
    ? process.env.NEXT_PUBLIC_API_URL
    : "https://weildbuild-server.onrender.com"
).replace(/\/$/, "");

/** The Realtime server - presence, friend events, DM push.
 *  Same "set-but-empty = same origin" rule as API_URL above; the sandbox
 *  preview points this at the gateway query (/?XTransformPort=3003). */
export const REALTIME_URL = (
  process.env.NEXT_PUBLIC_REALTIME_URL !== undefined
    ? process.env.NEXT_PUBLIC_REALTIME_URL
    : "https://weildbuild-realtime.onrender.com"
).replace(/\/$/, "");

/**
 * Client version - compared against the Main Server's
 * /version endpoint on boot (minimum = forced update,
 * latest = "update available" nudge). Single source of truth:
 * package.json "version" (synced everywhere by sync-version.mjs).
 */
export const APP_VERSION = pkg.version;

/**
 * The version shown to USERS ("1.0 PreRelease"). package.json keeps a strict
 * semver number (1.0.0) because tauri.conf.json / Cargo.toml / the server's
 * version gate all need x.y.z - this display string is what the splash
 * screen, the Settings page and the studio status bar show.
 */
export const APP_VERSION_DISPLAY = "1.0.0";

/** Asset URL through the Main Server's B2 proxy (faces etc.). */
export function assetUrl(b2Key: string): string {
  return `${API_URL}/storage/download?key=${encodeURIComponent(b2Key)}`;
}

/**
 * WB preview helper (sandbox web preview): the preview gateway exposes
 * ONE external origin — extra local services are addressed with the
 * ?XTransformPort=<port> query. The server side still stores absolute
 * localhost URLs (e.g. a game host's socketUrl), so the browser needs
 * them translated to same-origin gateway paths before io() connects.
 *
 * NEXT_PUBLIC_SOCKET_URL_MAP is a "from=to;from2=to2" list, e.g.:
 *   http://localhost:3004=/?XTransformPort=3004
 * Unset (production / normal dev) → every URL passes through untouched.
 */
const socketUrlMap: readonly [string, string][] = (process.env.NEXT_PUBLIC_SOCKET_URL_MAP || "")
  .split(";")
  .map((pair) => {
    const eq = pair.indexOf("="); // first "=" only — values contain "=" themselves
    return eq > 0 ? [pair.slice(0, eq).trim(), pair.slice(eq + 1).trim()] : null;
  })
  .filter((pair): pair is [string, string] => !!pair && pair[0].length > 0 && pair[1].length > 0);

export function mapSocketUrl(url: string): string {
  for (const [from, to] of socketUrlMap) {
    if (url === from || url.startsWith(from + "/")) {
      return to + url.slice(from.length);
    }
  }
  return url;
}

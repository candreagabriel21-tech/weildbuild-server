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

/** The Main Server - accounts, games, items, friends, everything. */
export const API_URL = (
  process.env.NEXT_PUBLIC_API_URL || "https://weildbuild-server.onrender.com"
).replace(/\/$/, "");

/** The Realtime server - presence, friend events, DM push. */
export const REALTIME_URL = (
  process.env.NEXT_PUBLIC_REALTIME_URL || "https://weildbuild-realtime.onrender.com"
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

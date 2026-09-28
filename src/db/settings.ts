// ═══════════════════════════════════════════════════════════
// WeildBuild DB — server settings (admin-editable, single row)
// ═══════════════════════════════════════════════════════════
// The WB Admin CTRL app edits these values at runtime so you can
// change the client version gate + per-platform download links
// WITHOUT touching Render env vars or redeploying.
//
// Precedence: DB row (non-empty field) → env var → built-in default.
// Empty string in the DB = "not set" = fall back to env/default.

import { prisma } from "./client";
import { config } from "../shared/config";

const SETTINGS_ID = "global";

export interface EffectiveSettings {
  latestVersion: string;
  minVersion: string;
  downloads: {
    windows: string;
    macos: string;
    linux: string;
    android: string;
    web: string;
  };
  /** Which source each field came from — "db" (admin override) or "env". */
  source: {
    latestVersion: "db" | "env";
    minVersion: "db" | "env";
    windows: "db" | "env";
    macos: "db" | "env";
    linux: "db" | "env";
    android: "db" | "env";
    web: "db" | "env";
  };
  maintenanceMode: boolean;
  updatedAt: string | null;
  updatedBy: string;
}

/** The default download link for every platform = the env download URL. */
function envDefault(platform: string): string {
  // e.g. https://weildbuild.vercel.app  →  https://weildbuild.vercel.app/download/windows
  const base = (config.client.downloadUrl || "https://weildbuild.vercel.app").replace(/\/$/, "");
  return `${base}/download/${platform}`;
}

/** Read the DB row (tolerant: table may not exist yet before first migrate). */
export async function getSettingsRow() {
  try {
    return await prisma.serverSetting.findUnique({ where: { id: SETTINGS_ID } });
  } catch {
    return null; // table missing (pre-migrate) → everything falls back to env
  }
}

/** Merge DB overrides over env defaults → the effective values. */
export async function getEffectiveSettings(): Promise<EffectiveSettings> {
  const row = await getSettingsRow();

  const latestVersion = row?.clientLatestVersion || config.client.latestVersion;
  const minVersion = row?.clientMinVersion || config.client.minVersion;
  const web = row?.downloadWeb || config.client.downloadUrl;

  return {
    latestVersion,
    minVersion,
    downloads: {
      windows: row?.downloadWindows || envDefault("windows"),
      macos: row?.downloadMacos || envDefault("macos"),
      linux: row?.downloadLinux || envDefault("linux"),
      android: row?.downloadAndroid || envDefault("android"),
      web,
    },
    source: {
      latestVersion: row?.clientLatestVersion ? "db" : "env",
      minVersion: row?.clientMinVersion ? "db" : "env",
      windows: row?.downloadWindows ? "db" : "env",
      macos: row?.downloadMacos ? "db" : "env",
      linux: row?.downloadLinux ? "db" : "env",
      android: row?.downloadAndroid ? "db" : "env",
      web: row?.downloadWeb ? "db" : "env",
    },
    maintenanceMode: row?.maintenanceMode ?? false,
    updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
    updatedBy: row?.updatedBy || "",
  };
}

export interface SettingsUpdate {
  clientLatestVersion?: string;
  clientMinVersion?: string;
  downloadWindows?: string;
  downloadMacos?: string;
  downloadLinux?: string;
  downloadAndroid?: string;
  downloadWeb?: string;
  maintenanceMode?: boolean;
}

/** Upsert the settings row. Empty string clears an override (falls back to env). */
export async function saveSettings(update: SettingsUpdate, updatedBy: string): Promise<void> {
  await prisma.serverSetting.upsert({
    where: { id: SETTINGS_ID },
    create: { id: SETTINGS_ID, ...update, updatedBy, updatedAt: new Date() },
    update: { ...update, updatedBy, updatedAt: new Date() },
  });
}

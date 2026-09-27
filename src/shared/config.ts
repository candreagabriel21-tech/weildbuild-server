// ═══════════════════════════════════════════════════════════
// WeildBuild Shared — environment config
// ═══════════════════════════════════════════════════════════
import dotenv from "dotenv";

// Load .env for local dev (Render injects env vars directly)
dotenv.config();

export const config = {
  // ── Ports (Render assigns PORT; these are local-dev defaults) ──
  mainPort: parseInt(process.env.PORT || "8000", 10),
  realtimePort: parseInt(process.env.PORT || "3003", 10),
  gamehostPort: parseInt(process.env.PORT || "3004", 10),

  // ── Auth (REQUIRED) ──
  authSecret: process.env.AUTH_SECRET || "",
  internalToken: process.env.INTERNAL_TOKEN || "",

  // ── CORS ──
  allowedOrigins: (process.env.ALLOWED_ORIGINS ||
    "tauri://localhost,http://tauri.localhost,http://localhost:3000,http://localhost:8000")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // ── Database ──
  databaseUrl: process.env.DATABASE_URL || "",

  // ── B2 storage ──
  b2: {
    keyId: process.env.B2_KEY_ID || "",
    applicationKey: process.env.B2_APPLICATION_KEY || "",
    endpoint: process.env.B2_ENDPOINT || "s3.eu-central-003.backblazeb2.com",
    assetsBucket: process.env.B2_ASSETS_BUCKET || "weildbuild",
    gamefilesBucket: process.env.B2_GAMEFILES_BUCKET || "weildbuild-gamefiles",
    reportsBucket: process.env.B2_REPORTS_BUCKET || "weildbuild-reports",
    backupsBucket: process.env.B2_BACKUPS_BUCKET || "weildbuild-backups",
  },

  // ── Client version gate ──
  client: {
    latestVersion: process.env.CLIENT_LATEST_VERSION || "13.1.0",
    minVersion: process.env.CLIENT_MIN_VERSION || "13.0.0",
    downloadUrl: process.env.CLIENT_DOWNLOAD_URL || "https://weildbuild.vercel.app",
  },

  // ── Game host ──
  host: {
    mainServerUrl: (process.env.MAIN_SERVER_URL || "http://localhost:8000").replace(/\/$/, ""),
    publicUrl: (process.env.HOST_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "http://localhost:3004").replace(/\/$/, ""),
    id: process.env.HOST_ID || "server-1",
    label: process.env.HOST_LABEL || "Server 1",
    priority: parseInt(process.env.HOST_PRIORITY || "1", 10),
    maxInstances: parseInt(process.env.MAX_INSTANCES_PER_HOST || "6", 10),
    maxPlayersPerInstance: parseInt(process.env.MAX_PLAYERS_PER_INSTANCE || "10", 10),
    emptyGraceMs: parseInt(process.env.EMPTY_GRACE_MS || "20000", 10),
    heartbeatIntervalMs: parseInt(process.env.HEARTBEAT_INTERVAL_MS || "15000", 10),
  },
};

export function assertSecrets(serviceName: string): void {
  const problems: string[] = [];
  if (!config.authSecret) problems.push("AUTH_SECRET is not set");
  if (problems.length > 0) {
    console.error(`\n[${serviceName}] ✗ Missing required environment variables:`);
    for (const p of problems) console.error(`    - ${p}`);
    console.error(`  See .env.example for the full list.\n`);
    // Don't crash realtime/gamehost if they can still run — but main MUST have it.
    if (serviceName === "main") process.exit(1);
  }
}

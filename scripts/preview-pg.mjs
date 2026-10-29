// ═══════════════════════════════════════════════════════════
// WeildBuild — sandbox web-preview Postgres (persistent)
// ═══════════════════════════════════════════════════════════
// Boots embedded-postgres on :5433 with a PERSISTENT data dir, so
// accounts/games created in the web preview survive restarts.
// (scripts/start-pg.mjs — the smoke-test twin — wipes its dir on
// every boot; this one is the opposite of that.)
//
// Must live inside server/ so `import "embedded-postgres"` resolves
// from server/node_modules. Stays alive until killed (the embedded
// postgres process is tied to this wrapper's lifetime).
import EmbeddedPostgres from "embedded-postgres";
import { existsSync } from "fs";
import { join } from "path";

const DB_DIR = process.env.PG_DATA_DIR || "/home/z/my-project/data/weldbuild-pg";
const PORT = parseInt(process.env.PG_PORT || "5433", 10);

const pg = new EmbeddedPostgres({
  databaseDir: DB_DIR,
  user: "postgres",
  password: "postgres",
  port: PORT,
  persistent: true, // keep database files across stops
});

if (!existsSync(join(DB_DIR, "PG_VERSION"))) {
  console.log(`[preview-pg] initialising new cluster at ${DB_DIR}…`);
  await pg.initialise();
} else {
  console.log(`[preview-pg] existing cluster found at ${DB_DIR} — skipping init`);
}

await pg.start();
try {
  await pg.createDatabase("weildbuild");
  console.log("[preview-pg] database 'weildbuild' created");
} catch {
  console.log("[preview-pg] database 'weildbuild' already exists");
}
console.log(`PG-READY on :${PORT}`);
// Keep the wrapper alive so postgres keeps running
setInterval(() => {}, 60000);

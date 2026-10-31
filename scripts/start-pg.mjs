// Boots embedded-postgres on :5433 for local smoke tests.
// Runs FOREVER (the smoke script kills it at the end), the sandbox
// kills background processes between bash calls, so the whole smoke
// run (pg + services + curl checks) happens in ONE invocation.
import EmbeddedPostgres from "embedded-postgres";
import { rmSync } from "fs";

const DB_DIR = process.env.PG_DATA_DIR || "/home/z/my-project/data/db-smoke";
rmSync(DB_DIR, { recursive: true, force: true });

const pg = new EmbeddedPostgres({
  databaseDir: DB_DIR,
  user: "postgres",
  password: "postgres",
  port: 5433,
  persistent: false,
});

await pg.initialise();
await pg.start();
await pg.createDatabase("weildbuild");
console.log("PG-READY");
// Keep alive until killed
setInterval(() => {}, 60000);

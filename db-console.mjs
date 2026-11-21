// ═══════════════════════════════════════════════════════════
// WeildBuild DB console — opens with db.bat
// ═══════════════════════════════════════════════════════════
// A small REPL against the local embedded Postgres. Uses the
// bridge's own prisma client (so it works on a laptop that has
// ONLY the bridge's npm deps installed, no psql binary needed).
//
// Commands (case-insensitive):
//   RESET     wipe the database folder and restart the bridge
//             with a fresh empty database. Asks twice.
//   TABLES    list every table.
//   HELP      show a few safe examples.
//   EXIT|QUIT close.
//   <anything else>  run as SQL against the database.
//
// Why this exists: the old local-sql.mjs was a $queryRawUnsafe
// passthrough with a HELP text that literally coached the operator
// toward `UPDATE users SET admin_role = 'top_admin' WHERE
// username = 'WeildBuild'` — a privilege-escalation tutorial in
// the source tree. This one is read-only by default; any mutating
// statement (INSERT/UPDATE/DELETE/ALTER/DROP/TRUNCATE) requires
// you to type CONFIRM on a second line. The HELP examples are
// read-only.

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import readline from "node:readline";
import { execSync, spawn } from "node:child_process";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

// ── .env loader (same as the bridge) ──
function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    const hash = v.indexOf(" #");
    if (hash >= 0) v = v.slice(0, hash);
    v = v.trim().replace(/^["']|["']$/g, "");
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}
loadDotEnv();

const DATABASE_URL = process.env.DATABASE_URL;
const PG_DATA_DIR = process.env.PG_DATA_DIR || path.join(__dirname, "pgdata");

if (!DATABASE_URL) {
  console.error("\n✗ DATABASE_URL is not set. Run install.bat first (it writes .env).\n");
  process.exit(1);
}

const HELP = `
  WeildBuild DB console  (read-only by default; mutating statements ask twice)

  Commands:
    TABLES      list every table
    HELP        show this help
    EXIT/QUIT   close the console

  Read-only examples:
    SELECT COUNT(*) FROM users;
    SELECT username, admin_role, "isGuest", created_at FROM users ORDER BY created_at DESC LIMIT 20;
    SELECT id, name, creator, plays, created_at FROM games ORDER BY plays DESC LIMIT 20;
    SELECT id, type, reporter, target_id, status, created_at FROM report ORDER BY created_at DESC LIMIT 20;

  Mutating examples (the console will ask for CONFIRM first):
    UPDATE users SET admin_role = 'admin' WHERE username = 'someone';
    DELETE FROM session WHERE username = 'someone';
    -- NEVER run DROP TABLE here. Use RESET to wipe everything in one go.
`;

function printRows(rows) {
  if (!rows || rows.length === 0) { console.log("  (no rows)"); return; }
  const keys = Object.keys(rows[0]);
  const widths = keys.map((k) => Math.max(k.length, ...rows.map((r) => String(r[k] ?? "null").length)));
  console.log("  " + keys.map((k, i) => k.padEnd(widths[i])).join("  |  "));
  console.log("  " + widths.map((w) => "-".repeat(w)).join("--+--"));
  for (const r of rows) {
    console.log("  " + keys.map((k, i) => String(r[k] ?? "null").padEnd(widths[i])).join("  |  "));
  }
  console.log(`  (${rows.length} row${rows.length === 1 ? "" : "s"})`);
}

async function runSql(prisma, sql) {
  const trimmed = sql.trim().replace(/;$/, "");
  if (!trimmed) { console.log("  (empty)"); return; }
  const upper = trimmed.toUpperCase();
  const isMutating = /\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE|CREATE|GRANT|REVOKE)\b/.test(upper);
  if (isMutating) {
    console.log("\n  ⚠ That statement mutates data. Type CONFIRM (or anything else to cancel):");
    const confirm = await ask("  > ");
    if (confirm.trim().toUpperCase() !== "CONFIRM") {
      console.log("  cancelled.\n");
      return;
    }
  }
  try {
    const rows = await prisma.$queryRawUnsafe(trimmed);
    if (Array.isArray(rows)) printRows(rows);
    else console.log("  ok");
  } catch (e) {
    console.error("  ✗ " + (e.message || e).split("\n")[0]);
  }
}

async function listTables(prisma) {
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT tablename AS table FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
    );
    printRows(rows);
  } catch (e) { console.error("  ✗ " + (e.message || e).split("\n")[0]); }
}

async function resetDatabase() {
  console.log("\n  ⚠ RESET wipes the ENTIRE local database. All accounts, games,");
  console.log("  files-in-DB will be gone. Uploaded files in wb-storage are NOT touched.");
  console.log("  The bridge must be STOPPED first (run stop.bat in another window).");
  const c1 = (await ask("\n  Type YES to continue: ")).trim().toUpperCase();
  if (c1 !== "YES") { console.log("  cancelled."); return; }
  const c2 = (await ask("  Type YES once more to be sure: ")).trim().toUpperCase();
  if (c2 !== "YES") { console.log("  cancelled."); return; }
  // The bridge should be stopped first; if it is not, the
  // pgdata folder is locked by the embedded Postgres and the
  // rmdir below fails with "directory in use".
  if (fs.existsSync(PG_DATA_DIR)) {
    try {
      fs.rmSync(PG_DATA_DIR, { recursive: true, force: true });
      console.log("  ✓ deleted " + PG_DATA_DIR);
    } catch (e) {
      console.error("  ✗ could not delete " + PG_DATA_DIR + ": " + e.message);
      console.error("    Stop the bridge first (stop.bat), then run db.bat and try RESET again.");
      return;
    }
  }
  console.log("  ✓ database wiped. Start the bridge again (start.bat) — it rebuilds the");
  console.log("    schema automatically on the next boot.");
  console.log("  (Close this console and re-open db.bat after the bridge has booted.)");
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
function ask(p) { return new Promise((r) => rl.question(p, r)); }

async function main() {
  let prisma;
  try {
    const { PrismaClient } = await import("@prisma/client");
    prisma = new PrismaClient({ log: ["error"] });
  } catch (e) {
    console.error("\n✗ Prisma client is not built yet. Run install.bat first (or start.bat once).\n");
    process.exit(1);
  }
  // quick connectivity check
  try { await prisma.$queryRaw`SELECT 1`; }
  catch (e) {
    console.error("\n✗ Cannot connect to the local database. Is the bridge running?");
    console.error("  Start it with start.bat, then re-open db.bat.\n");
    process.exit(1);
  }
  console.log("\n  Connected to the local WeildBuild database.\n");
  console.log(HELP);
  let buf = "";
  while (true) {
    const prompt = buf ? "  ... > " : "  wb-db > ";
    const line = await ask(prompt);
    const cmd = line.trim();
    if (!buf) {
      if (cmd === "" ) continue;
      const up = cmd.toUpperCase();
      if (up === "EXIT" || up === "QUIT") { console.log("  bye."); break; }
      if (up === "HELP") { console.log(HELP); continue; }
      if (up === "TABLES") { await listTables(prisma); continue; }
      if (up === "RESET") { await resetDatabase(); continue; }
    }
    // multi-line SQL: accumulate until a `;` ends a statement
    buf += (buf ? "\n" : "") + line;
    if (/[;]\s*$/.test(line) || /^\\g$/i.test(line.trim())) {
      await runSql(prisma, buf);
      buf = "";
    }
  }
  await prisma.$disconnect();
  rl.close();
}

main().catch((e) => { console.error("✗", e.message || e); process.exit(1); });

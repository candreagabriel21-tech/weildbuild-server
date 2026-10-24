// ═══════════════════════════════════════════════════════════
// WeildBuild DB — automatic setup on boot (v1.3.1)
// ═══════════════════════════════════════════════════════════
// WHY THIS EXISTS: Render made the Shell tab a paid feature, so
// "deploy then run npm run migrate in the Shell" no longer works
// on the free plan. From v1.3.1 the Main Server sets up the
// database BY ITSELF, in the background, a few seconds after it
// starts:
//   1. `prisma db push`  — syncs the schema (safe to re-run: it
//      does nothing when the database is already up to date)
//   2. If the database is COMPLETELY empty (zero user accounts,
//      i.e. a brand-new Neon project) it also runs the seed
//      (default admin account + 34 shop items)
//
// NOTES
//   • Only the MAIN SERVER calls this — never add it to realtime
//     or gamehost, or three services would race each other.
//   • It runs in the background AFTER the port is bound, so the
//     Render health check passes instantly even on a cold Neon
//     database. Every step is wrapped in try/catch: a database
//     hiccup can never take the server down — it just retries on
//     the next boot.
//   • The seed is upsert-based but it RE-ASSERTS the default
//     admin password, so it must only run on a truly empty
//     database (users == 0). That keeps it from ever resetting a
//     password you changed.
//   • NEW in v1.8.1 — OFFICIAL ITEM RE-SYNC on every boot: the
//     34 official catalog items from data/items/*.json are
//     upserted on EVERY start (not just empty databases), so a
//     redeploy is all it takes to push catalog edits (names,
//     descriptions, prices, colors) to the live database. It
//     only touches items whose IDs exist in data/items — any
//     user-created/community items are left alone.

import { exec } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { readdirSync, readFileSync, existsSync } from "fs";
import { prisma } from "./client";
import { ITEM_COLORS } from "../shared/item-colors";

const execAsync = promisify(exec);

// dist/db/ensure.js → two levels up = repo root (where prisma/
// and package.json live). Using this instead of process.cwd()
// makes it work no matter where the process was started from.
const repoRoot = join(__dirname, "..", "..");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function logTail(text: string | undefined, maxLines: number): void {
  if (!text?.trim()) return;
  const lines = text.trim().split("\n");
  for (const line of lines.slice(-maxLines)) console.log("    " + line);
}

async function runWithRetries(
  cmd: string,
  label: string,
  attempts = 3,
  timeoutMs = 120_000
): Promise<boolean> {
  for (let i = 1; i <= attempts; i++) {
    try {
      const { stdout, stderr } = await execAsync(cmd, {
        cwd: repoRoot,
        timeout: timeoutMs,
        env: process.env,
      });
      // prisma prints progress to stderr, results to stdout
      logTail(stdout, 4);
      logTail(stderr, 4);
      console.log(`[db-setup] ${label}: OK`);
      return true;
    } catch (err: any) {
      const msg = String(err?.message ?? err).split("\n")[0];
      console.warn(`[db-setup] ${label}: attempt ${i}/${attempts} failed — ${msg}`);
      if (err?.stdout) logTail(err.stdout, 2);
      if (err?.stderr) logTail(err.stderr, 2);
      if (i < attempts) {
        console.log(`[db-setup] retrying in 10 s…`);
        await sleep(10_000);
      }
    }
  }
  return false;
}

/**
 * Official item re-sync (v1.8.1) — upserts every item from
 * data/items/*.json. Runs on EVERY boot, so catalog edits deploy
 * with a plain redeploy. Only items whose IDs are listed in
 * data/items are touched; user-created items are never modified.
 */
async function syncOfficialItems(): Promise<void> {
  const itemsDir = join(repoRoot, "data", "items");
  if (!existsSync(itemsDir)) {
    console.warn("! [db-setup] data/items not found — official item re-sync skipped");
    return;
  }
  const files = readdirSync(itemsDir).filter((f) => f.endsWith(".json")).sort();
  let synced = 0;
  const failures: string[] = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(itemsDir, file), "utf-8"));
      const data = {
        id: raw.item_key,
        displayName: raw.name || raw.display_name || raw.item_key,
        itemType: raw.type || raw.item_type || "",
        price: raw.price ?? 0,
        description: raw.description || "",
        creator: raw.creator || "WeildBuild",
        color: ITEM_COLORS[raw.item_key] || "#888",
        data: raw.data || null,
        ...(raw.date_created ? { dateCreated: new Date(raw.date_created) } : {}),
      };
      await prisma.item.upsert({ where: { id: data.id }, create: data, update: data });
      synced++;
    } catch (err: any) {
      failures.push(`${file}: ${String(err?.message ?? err).split("\n")[0]}`);
    }
  }
  if (failures.length > 0) {
    console.warn(`! [db-setup] Official item re-sync: ${failures.length} file(s) failed:`);
    for (const f of failures) console.warn("    " + f);
  }
  console.log(`[db-setup] Official shop items re-synced (${synced}/${files.length} items).`);
}

export async function ensureDatabase(): Promise<void> {
  console.log("─".repeat(58));
  console.log("[db-setup] Automatic database setup started (v1.3.1)");
  console.log("[db-setup] Step 1/3 — syncing database schema…");

  const pushed = await runWithRetries(
    "npx prisma db push --skip-generate",
    "schema sync"
  );

  if (!pushed) {
    console.error(
      "!! [db-setup] Could not sync the database schema after 3 attempts.\n" +
        "    The server keeps running and will try again on the next restart.\n" +
        "    Until it succeeds, the v1.3 admin features may not work (the\n" +
        "    version gate falls back to the environment variables)."
    );
    console.log("─".repeat(58));
    return;
  }

  console.log("[db-setup] Step 2/3 — checking whether seeding is needed…");
  try {
    const users = await prisma.user.count();
    if (users === 0) {
      console.log(
        "[db-setup] Empty database detected — seeding the default admin\n" +
          "    account (WeildBuild) and the shop items…"
      );
      const seeded = await runWithRetries("npx tsx prisma/seed.ts", "seed");
      if (seeded) {
        console.log(
          "[db-setup] Seed complete. Default admin login: WeildBuild\n" +
            "    (password from prisma/seed.ts — change it after first login!)"
        );
      }
    } else {
      console.log(
        `[db-setup] Database ready — ${users} user account(s) found, seed skipped.`
      );
    }
  } catch (err: any) {
    const msg = String(err?.message ?? err).split("\n")[0];
    console.warn(`[db-setup] Could not check for seeding (non-fatal): ${msg}`);
  }

  // v1.8.1: ALWAYS re-sync the official catalog (idempotent upserts).
  // This is what pushes catalog edits (names/descriptions/prices/colors)
  // to an EXISTING database — a redeploy is all it takes.
  console.log("[db-setup] Step 3/3 — re-syncing the official shop items…");
  try {
    await syncOfficialItems();
  } catch (err: any) {
    const msg = String(err?.message ?? err).split("\n")[0];
    console.warn(`[db-setup] Official item re-sync failed (non-fatal, retried on next boot): ${msg}`);
  }

  console.log("─".repeat(58));
}

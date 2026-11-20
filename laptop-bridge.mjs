// ═══════════════════════════════════════════════════════════
// WeildBuild Bridge — laptop side (the worker)
// ═══════════════════════════════════════════════════════════
// Runs on the Windows laptop. Boots a LOCAL Postgres (embedded
// binaries, no installer, no Windows service, no password prompts),
// syncs the schema, then polls the Render main server over OUTBOUND
// HTTPS, runs each job against the local database + a local storage
// folder, and POSTs the result back. It never accepts inbound
// connections, so it works behind any NAT / home router / CGNAT and
// needs no tunnel, no port forward, no Cloudflare, no public IP.
//
// One process = Postgres + schema + bridge worker. Drop this file
// into the server repo (next to package.json) and run:
//   npm install
//   node laptop-bridge.mjs
// (install-on-laptop.ps1 does those two steps + the auto-start task)
//
// Config (in .env next to this file, or real env vars):
//   RENDER_URL        https://weildbuild-main.onrender.com
//   INTERNAL_TOKEN    (same value Render has)
//   STORAGE_DIR       D:\wb-storage   (optional, default .\wb-storage)
//   USE_EMBEDDED_PG   1 (default) — set 0 to use an external Postgres
//   PG_DATA_DIR       (optional, default .\pgdata — delete it to reset)
//   PG_PORT           (optional, default 5433)
//   PG_PASSWORD       (required on first init; the installer writes it)
//   DATABASE_URL      (optional — built from the PG_* values if omitted)

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { execSync } from "node:child_process";

// Load .env from the script's own folder (no dotenv dep needed).
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const RENDER_URL = (process.env.RENDER_URL || "").replace(/\/$/, "");
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || "";
const STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, "wb-storage");
const POLL_TIMEOUT_MS = 30_000;

const USE_EMBEDDED_PG = (process.env.USE_EMBEDDED_PG ?? "1") !== "0";
const PG_DATA_DIR = process.env.PG_DATA_DIR || path.join(__dirname, "pgdata");
const PG_PORT = parseInt(process.env.PG_PORT || "5433", 10);
const PG_USER = process.env.PG_USER || "postgres";
const PG_PASSWORD = process.env.PG_PASSWORD || "";
const DB_NAME = process.env.PG_DB_NAME || "weildbuild";
const DATABASE_URL =
  process.env.DATABASE_URL ||
  `postgresql://${PG_USER}:${encodeURIComponent(PG_PASSWORD)}@127.0.0.1:${PG_PORT}/${DB_NAME}`;

const log = (...a) => console.log(`[wb-bridge ${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!RENDER_URL || !INTERNAL_TOKEN) {
  console.error("✗ Set RENDER_URL and INTERNAL_TOKEN in .env first (the installer does this).");
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────
// JSON transport helpers (mirror of render-bridge.ts).
// Buffers (the 4 MB game-world blob), Dates and BigInts cannot
// travel as plain JSON, so they travel as marked objects and are
// rehydrated on the other side.
// ─────────────────────────────────────────────────────────────
function reviveTransport(value) {
  if (Array.isArray(value)) return value.map(reviveTransport);
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    if (typeof value.__wbBytes === "string" && keys.length === 1) {
      return Buffer.from(value.__wbBytes, "base64");
    }
    if (typeof value.__wbDate === "string" && keys.length === 1) {
      return new Date(value.__wbDate);
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = reviveTransport(v);
    return out;
  }
  return value;
}

function jsonReplacer(_k, v) {
  const raw = this[_k]; // the raw value BEFORE Buffer/Date toJSON mangled it
  if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
    return { __wbBytes: Buffer.from(raw).toString("base64") };
  }
  if (raw instanceof Date) return { __wbDate: raw.toISOString() };
  if (typeof raw === "bigint") return Number(raw);
  return v;
}

// ─────────────────────────────────────────────────────────────
// Boot local Postgres (embedded, no installer) + sync the schema.
// ─────────────────────────────────────────────────────────────
let pg = null;

async function bootDatabase() {
  if (!USE_EMBEDDED_PG) {
    log("USE_EMBEDDED_PG=0 — using external DATABASE_URL, skipping embedded Postgres boot");
    return;
  }
  const needsInit = !fs.existsSync(path.join(PG_DATA_DIR, "PG_VERSION"));
  if (needsInit && !PG_PASSWORD) {
    console.error("✗ PG_PASSWORD missing in .env but the local database is not initialised yet.\n" +
      "  Re-run install-on-laptop.ps1 (it writes PG_PASSWORD), or delete .env and run it again.");
    process.exit(1);
  }
  let EmbeddedPostgres;
  try {
    ({ default: EmbeddedPostgres } = await import("embedded-postgres"));
  } catch {
    console.error("✗ embedded-postgres is not installed. Run:  npm install  (inside the server folder)");
    process.exit(1);
  }
  pg = new EmbeddedPostgres({
    databaseDir: PG_DATA_DIR,
    user: PG_USER,
    password: PG_PASSWORD || "postgres",
    port: PG_PORT,
    persistent: true, // keep the data files across restarts
  });
  if (needsInit) {
    log(`initialising local Postgres cluster at ${PG_DATA_DIR} (first run only)…`);
    await pg.initialise();
  }
  log(`starting local Postgres on 127.0.0.1:${PG_PORT} (data: ${PG_DATA_DIR})`);
  await pg.start();
  try {
    await pg.createDatabase(DB_NAME);
    log(`database "${DB_NAME}" created`);
  } catch {
    log(`database "${DB_NAME}" already exists`);
  }
}

function runPrismaCmd(args, timeoutMs = 240_000) {
  log(`npx prisma ${args} …`);
  try {
    const out = execSync(`npx prisma ${args}`, {
      cwd: __dirname,
      timeout: timeoutMs,
      env: { ...process.env, DATABASE_URL },
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32", // npx is npx.cmd on Windows
    }).toString();
    log(out.trim().split("\n").slice(-3).join("\n    "));
  } catch (e) {
    const tail = ((e.stdout || "") + (e.stderr || "")).toString().trim().split("\n").slice(-8).join("\n    ");
    console.error(`✗ prisma ${args} failed:\n    ${tail}`);
    throw e;
  }
}

function ensurePrismaClient() {
  const client = path.join(__dirname, "node_modules", ".prisma", "client", "index.js");
  if (!fs.existsSync(client)) runPrismaCmd("generate", 180_000);
}

async function boot() {
  log(`storage root: ${STORAGE_DIR}`);
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
  await bootDatabase();
  ensurePrismaClient();
  // Idempotent: creates missing tables, no-ops when the schema is current.
  runPrismaCmd("db push --skip-generate");
  log("local database ready. Starting worker…");
}

// ─────────────────────────────────────────────────────────────
// The worker itself.
// ─────────────────────────────────────────────────────────────
async function bootAndStartLoop() {
  try {
    await boot();
  } catch {
    console.error("✗ boot failed — fix the error above and start the bridge again (start-bridge.bat).");
    process.exit(1);
  }

  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient({ log: ["error"] });

  async function doJob(job) {
    // ── DB job: prisma.<model>.<op>(args) or prisma.$executeRawUnsafe(sql,...) ──
    if (job.type === "db") {
      if (job.model === "$") {
        // $executeRaw -> $executeRawUnsafe, $queryRaw -> $queryRawUnsafe
        const fn = prisma["$" + job.op + "Unsafe"];
        if (typeof fn !== "function") throw new Error(`unknown $ method $${job.op}`);
        const params = (reviveTransport(job.args.params) || []);
        return await fn.apply(prisma, [job.args.sql, ...params]);
      }
      const model = prisma[job.model];
      if (!model) throw new Error(`unknown model ${job.model}`);
      const op = model[job.op];
      if (typeof op !== "function") throw new Error(`unknown op ${job.model}.${job.op}`);
      return await op.call(model, reviveTransport(job.args) ?? {});
    }
    // ── storage.put: write bytes to <STORAGE_DIR>/<bucket>/<key> ──
    if (job.type === "storage.put") {
      const full = path.join(STORAGE_DIR, job.bucket, job.key);
      // path traversal guard: the resolved path must stay inside the bucket
      if (!path.resolve(full).startsWith(path.resolve(STORAGE_DIR, job.bucket) + path.sep)) {
        throw new Error("bad storage key");
      }
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, Buffer.from(job.bodyB64, "base64"));
      return { key: job.key };
    }
    // ── storage.get: read bytes back as base64 ──
    if (job.type === "storage.get") {
      const full = path.join(STORAGE_DIR, job.bucket, job.key);
      if (!path.resolve(full).startsWith(path.resolve(STORAGE_DIR, job.bucket) + path.sep)) {
        throw new Error("bad storage key");
      }
      if (!fs.existsSync(full)) return null;
      const buf = fs.readFileSync(full);
      return { bodyB64: buf.toString("base64"), contentLength: buf.length, contentType: guessContentType(job.key) };
    }
    throw new Error(`unknown job type ${job.type}`);
  }

  function guessContentType(key) {
    const ext = key.split(".").pop()?.toLowerCase();
    const map = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
      webp: "image/webp", svg: "image/svg+xml", mp3: "audio/mpeg", wav: "audio/wav",
      ogg: "audio/ogg", json: "application/json" };
    return map[ext] || "application/octet-stream";
  }

  async function postResult(jobId, ok, payload) {
    try {
      await fetch(`${RENDER_URL}/__bridge/result?token=${encodeURIComponent(INTERNAL_TOKEN)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, ok, ...payload }, jsonReplacer),
      });
    } catch (e) {
      console.error(`  ✗ failed to post result for ${jobId.slice(0, 8)}: ${e.message}`);
    }
  }

  log(`polling ${RENDER_URL}/__bridge/poll (outbound long-poll) — press Ctrl+C to stop`);
  let backoff = 0;
  while (true) {
    try {
      const res = await fetch(
        `${RENDER_URL}/__bridge/poll?token=${encodeURIComponent(INTERNAL_TOKEN)}`,
        { signal: AbortSignal.timeout(POLL_TIMEOUT_MS) }
      );
      if (res.status === 401) {
        console.error("✗ 401 — INTERNAL_TOKEN in .env does not match Render. Fix .env, then restart.");
        await sleep(5000);
        continue;
      }
      if (!res.ok) throw new Error(`poll HTTP ${res.status}`);
      const job = await res.json();
      backoff = 0;

      if (job && job.jobId) {
        const t0 = Date.now();
        const label = job.type === "db" ? `db.${job.model}.${job.op}` : job.type;
        try {
          const data = await doJob(job);
          await postResult(job.jobId, true, { data });
          log(`  ✓ ${job.jobId.slice(0, 8)} ${label} ${Date.now() - t0}ms`);
        } catch (e) {
          await postResult(job.jobId, false, { error: String(e.message || e) });
          console.error(`  ✗ ${job.jobId.slice(0, 8)} ${label} FAIL: ${e.message || e}`);
        }
      }
    } catch (e) {
      backoff = Math.min((backoff || 1) * 2, 15_000);
      console.error(`poll error, retry in ${backoff}ms: ${e.message}`);
      await sleep(backoff);
    }
  }
}

// Graceful shutdown: stop the embedded Postgres cleanly.
let exiting = false;
async function shutdown() {
  if (exiting) return;
  exiting = true;
  log("shutting down…");
  try { if (pg) await pg.stop(); } catch {}
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

bootAndStartLoop();

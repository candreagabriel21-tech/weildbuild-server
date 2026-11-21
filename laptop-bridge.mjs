// ═══════════════════════════════════════════════════════════
// WeildBuild Bridge — laptop worker (the ONE file)
// ═══════════════════════════════════════════════════════════
// What it does, in one sentence: it polls the Render main server
// over outbound HTTPS, runs each job against a LOCAL embedded
// Postgres + a local file-storage folder, and POSTs the result
// back. Render never talks to the laptop first; the laptop only
// ever calls out. No tunnel, no port-forward, no Cloudflare, no
// public IP, no inbound port. It just works behind a home router.
//
// ONE process does everything:
//   1. boots an embedded Postgres (no installer, no Windows
//      service, no password prompt — the binaries ship in
//      node_modules, the data lives in ./pgdata next to this file)
//   2. runs `prisma db push` once so the schema matches schema.prisma
//   3. runs the relay poll loop against Render
//   4. serves a tiny status page at http://localhost:7878 so you
//      have ONE place to look: "is the laptop connected to Render?"
//      + "is the local database up?" + "how many jobs have run?".
//      No more "BRIDGE NOT OPEN" guessing.
//
// THE LOCK IS THE PORT. Binding 127.0.0.1:7878 is the single-
// instance guard. The OS releases it the instant the process
// dies, so there is no `bridge.lock` file to go stale and no
// "ghost" bridge from a crashed previous run. If you see
// "EADDRINUSE" on startup it means another bridge is already
// running — find it (Task Manager → node.exe in this folder) and
// stop it with stop.bat, or just reboot. No more stale locks.
//
// Run it:
//   node laptop-bridge.mjs
// Or use the batch files:
//   start.bat   (visible window with the live log)
//   stop.bat    (clean shutdown)
//   db.bat      (open a SQL console against the local database)
//
// Config (in .env next to this file, or real env vars). The
// installer writes .env for you — you almost never edit it by hand:
//   RENDER_URL        https://weildbuild-server.onrender.com
//   INTERNAL_TOKEN    (same value Render has, in its Environment tab)
//   STORAGE_DIR       D:\wb-storage   (optional, default .\wb-storage)
//   USE_EMBEDDED_PG   1 (default) — set 0 to use an external Postgres
//   PG_DATA_DIR       (optional, default .\pgdata — delete it to reset)
//   PG_PORT           (optional, default 5433)
//   PG_PASSWORD       (required on first init; the installer writes it)

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import http from "node:http";
import { execSync } from "node:child_process";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

// ── .env loader (no dotenv dependency) ──
// Strips inline `# comments` and surrounding quotes — the old
// hand-rolled parser left `INTERNAL_TOKEN=abc123 # note` with the
// trailing comment baked into the token, which broke auth in a
// way that was nearly impossible to debug.
function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    const hash = v.indexOf(" #");
    if (hash >= 0) v = v.slice(0, hash); // strip inline comment
    v = v.trim().replace(/^["']|["']$/g, "");
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
}
loadDotEnv();

const RENDER_URL = (process.env.RENDER_URL || "").replace(/\/$/, "");
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || "";
const STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, "wb-storage");
const POLL_TIMEOUT_MS = 30_000;
const STATUS_PORT = parseInt(process.env.WB_STATUS_PORT || "7878", 10);

// v1.11.1 LATENCY FIX: how aggressively the laptop polls Render.
//
//   POLL_IDLE_GAP_MS  - the gap between the previous poll finishing and
//                      the next one starting. The old default was a flat
//                      5000 ms — which means a job that arrived on Render
//                      the instant the laptop went to sleep waited an
//                      average of 2500 ms before anyone picked it up.
//                      At 200 ms the average wait is 100 ms. Long-poll
//                      keeps us parked on Render the rest of the time,
//                      so a busy bridge sees ~0 ms wait; this only
//                      matters when long-poll returns empty.
//
//   POLL_BATCH_MAX    - how many jobs to fetch and run at once when a
//                      single poll returns a batch. The Render side
//                      (render-bridge.ts POLL_BATCH_MAX) caps this too;
//                      the effective batch size is min(both).
//
//   POLL_CONCURRENCY  - how many of those batched jobs run in parallel
//                      against the local Postgres. Prisma handles
//                      concurrent queries fine; 4 is conservative, 8 is
//                      fine on a modern laptop. Set higher if your DB
//                      is on an SSD and you're under heavy load.
const POLL_IDLE_GAP_MS = parseInt(process.env.BRIDGE_POLL_IDLE_GAP_MS || "200", 10);
const POLL_BATCH_MAX   = parseInt(process.env.BRIDGE_POLL_BATCH_MAX   || "5", 10);
const POLL_CONCURRENCY = parseInt(process.env.BRIDGE_POLL_CONCURRENCY || "4", 10);

const USE_EMBEDDED_PG = (process.env.USE_EMBEDDED_PG ?? "1") !== "0";
const PG_DATA_DIR = process.env.PG_DATA_DIR || path.join(__dirname, "pgdata");
const PG_PORT = parseInt(process.env.PG_PORT || "5433", 10);
const PG_USER = process.env.PG_USER || "postgres";
const PG_PASSWORD = process.env.PG_PASSWORD || "";
const DB_NAME = process.env.PG_DB_NAME || "weildbuild";
const DATABASE_URL =
  process.env.DATABASE_URL ||
  `postgresql://${PG_USER}:${encodeURIComponent(PG_PASSWORD)}@127.0.0.1:${PG_PORT}/${DB_NAME}`;
// The relay's PrismaClient reads process.env.DATABASE_URL at query
// time, so it must be EXPORTED here even if .env already has it.
process.env.DATABASE_URL = process.env.DATABASE_URL || DATABASE_URL;

const log = (...a) => console.log(`[wb-bridge ${new Date().toISOString().slice(11, 19)}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!RENDER_URL || !INTERNAL_TOKEN) {
  console.error("✗ Set RENDER_URL and INTERNAL_TOKEN in .env first (run install.bat to do this for you).");
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────
// SINGLE-INSTANCE LOCK = the status port. The OS releases it on
// process death, so there is no stale-file race and no ghost.
// ─────────────────────────────────────────────────────────────
let statusServer = null;
function acquireLock() {
  return new Promise((resolve, reject) => {
    statusServer = http.createServer();
    statusServer.once("error", (e) => {
      if (e.code === "EADDRINUSE") {
        console.error(`✗ Another WeildBuild bridge is already running (status port ${STATUS_PORT} is taken).\n` +
          `  Stop it with stop.bat (or close its window) and try again. No stale lock — the port freed\n` +
          `  automatically when the other process exited, this just means it is still running RIGHT NOW.`);
        process.exit(3);
      }
      reject(e);
    });
    statusServer.once("listening", () => resolve());
    statusServer.listen(STATUS_PORT, "127.0.0.1");
  });
}

// ─────────────────────────────────────────────────────────────
// JSON transport helpers (mirror of render-bridge.ts). Buffers,
// Dates and BigInts cannot travel as plain JSON, so they travel
// as marked objects and are rehydrated on the other side.
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
  const raw = this[_k];
  if (Buffer.isBuffer(raw) || raw instanceof Uint8Array) {
    return { __wbBytes: Buffer.from(raw).toString("base64") };
  }
  if (raw instanceof Date) return { __wbDate: raw.toISOString() };
  if (typeof raw === "bigint") return Number(raw);
  return v;
}

// ─────────────────────────────────────────────────────────────
// Storage. The path-traversal guard here is FIXED vs the original:
// it checks that the resolved full path is under STORAGE_DIR
// itself (not under STORAGE_DIR/<bucket>, which let `bucket=../..`
// escape). Buckets are also whitelisted to the four the server
// actually uses, so a tampered job cannot invent a new bucket.
// ─────────────────────────────────────────────────────────────
const ALLOWED_BUCKETS = new Set([
  "weildbuild", "weildbuild-gamefiles", "weildbuild-reports", "weildbuild-backups",
]);
const MAX_PUT_BYTES = 50 * 1024 * 1024; // 50 MB hard cap on any one file

function safeStoragePath(bucket, key) {
  if (!ALLOWED_BUCKETS.has(bucket)) throw new Error(`bad bucket ${bucket}`);
  if (typeof key !== "string" || key.length === 0 || key.length > 1024) throw new Error("bad key");
  if (key.includes("\0") || key.includes("\\") || key.includes("//")) throw new Error("bad key");
  const root = path.resolve(STORAGE_DIR, bucket);
  const full = path.resolve(root, key);
  // `path.relative` returns a non-`.`-free string when `full` is
  // outside `root`, so we check that the relative path stays inside
  // and does not start with `..`.
  const rel = path.relative(root, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("bad storage key");
  return full;
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
      "  Run install.bat (it writes PG_PASSWORD), or delete .env and run it again.");
    process.exit(1);
  }
  let EmbeddedPostgres;
  try {
    ({ default: EmbeddedPostgres } = await import("embedded-postgres"));
  } catch {
    console.error("✗ embedded-postgres is not installed. Run:  npm install  (inside the server folder)");
    process.exit(1);
  }
  // NOTE: we deliberately do NOT fall back to "postgres" if
  // PG_PASSWORD is empty on a re-init. The original did, and that
  // silently weakened a previously-strong generated password to a
  // well-known one if .env was ever deleted. Fail loudly instead.
  pg = new EmbeddedPostgres({
    databaseDir: PG_DATA_DIR,
    user: PG_USER,
    password: PG_PASSWORD,
    port: PG_PORT,
    persistent: true,
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
      shell: process.platform === "win32",
    }).toString();
    log(out.trim().split("\n").slice(-3).join("\n    "));
  } catch (e) {
    const tail = ((e.stdout || "") + (e.stderr || "")).toString().trim().split("\n").slice(-8).join("\n    ");
    console.error(`✗ prisma ${args} failed:\n    ${tail}`);
    throw e;
  }
}

function ensurePrismaClient() {
  // The real generated client always ships a copy of schema.prisma in
  // node_modules/.prisma/client. The placeholder the postinstall
  // leaves when generate never ran does not. Use that to tell them
  // apart.
  const dotPrisma = path.join(__dirname, "node_modules", ".prisma", "client");
  const indexJs = path.join(dotPrisma, "index.js");
  const schemaCopy = path.join(dotPrisma, "schema.prisma");
  let looksReal = fs.existsSync(indexJs) && fs.existsSync(schemaCopy);
  if (looksReal) {
    try {
      if (fs.readFileSync(indexJs, "utf8").includes("did not initialize yet")) looksReal = false;
    } catch {}
  }
  if (!looksReal) {
    log("Prisma client is missing or a placeholder — running prisma generate…");
    runPrismaCmd("generate", 180_000);
  }
}

async function loadPrismaClient() {
  const attempt = async () => {
    const { PrismaClient } = await import("@prisma/client");
    return new PrismaClient({ log: ["error"] });
  };
  try {
    return await attempt();
  } catch (e) {
    console.error(`! Prisma client did not load (${String(e.message || e).split("\n")[0]}).`);
    log("running prisma generate, then retrying…");
    runPrismaCmd("generate", 180_000);
    return await attempt();
  }
}

async function boot() {
  log(`storage root: ${STORAGE_DIR}`);
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
  await bootDatabase();
  ensurePrismaClient();
  runPrismaCmd("db push --skip-generate");
  log("local database ready. Starting worker…");
}

// ─────────────────────────────────────────────────────────────
// The worker.
// ─────────────────────────────────────────────────────────────
let prisma = null;
let stats = { polls: 0, jobsOk: 0, jobsFail: 0, lastJobAt: 0, lastError: "" };

async function doJob(job) {
  if (job.type === "db") {
    if (job.model === "$") {
      // $executeRaw -> $executeRawUnsafe, $queryRaw -> $queryRawUnsafe.
      // NOTE: the laptop does NOT trust the SQL — Render is the only
      // thing that ever calls these (the bridge proxy on the server
      // emits them from the prisma.$executeRaw tagged-template call
      // site, which already uses parameter binding). A third party
      // cannot reach this endpoint without the INTERNAL_TOKEN.
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
  if (job.type === "storage.put") {
    const full = safeStoragePath(job.bucket, job.key);
    const buf = Buffer.from(job.bodyB64 || "", "base64");
    if (buf.length > MAX_PUT_BYTES) throw new Error(`file too large (${buf.length} bytes)`);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, buf);
    return { key: job.key };
  }
  if (job.type === "storage.get") {
    const full = safeStoragePath(job.bucket, job.key);
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

async function pollOnce() {
  // v1.11.1: send ?batch=1 so Render returns up to POLL_BATCH_MAX jobs
  // per poll instead of one. A pre-v1.11.1 Render (or any Render that
  // ignores the query string) still returns the legacy single-job
  // shape, which our parser below handles via the `body?.jobId` branch.
  const res = await fetch(
    `${RENDER_URL}/__bridge/poll?token=${encodeURIComponent(INTERNAL_TOKEN)}&batch=1`,
    { signal: AbortSignal.timeout(POLL_TIMEOUT_MS) }
  );
  if (res.status === 401) {
    console.error("✗ 401 — INTERNAL_TOKEN in .env does not match Render. Fix .env, then restart.");
    await sleep(5000);
    return;
  }
  if (!res.ok) throw new Error(`poll HTTP ${res.status}`);
  const body = await res.json();

  // v1.11.1: Render returns either a single job ({ jobId, ... }) for
  // backwards compat, or a batch ({ jobs: [{ jobId, ... }, ...] }).
  // Normalise to an array, capped at POLL_BATCH_MAX so we never starve
  // other polls if Render somehow returns a huge batch.
  let jobs = [];
  if (Array.isArray(body?.jobs)) {
    jobs = body.jobs.slice(0, POLL_BATCH_MAX);
  } else if (body?.jobId) {
    jobs = [body];
  }
  if (jobs.length === 0) return;

  // Run the batched jobs concurrently. Each job independently POSTs its
  // result back to /__bridge/result as soon as it finishes, so a slow
  // job (a 3 MB game.put) does not block the result of a fast one (a
  // user.findUnique) in the same batch. Concurrency is capped at
  // POLL_CONCURRENCY to protect the local Postgres connection pool.
  const runners = [];
  let active = 0;
  for (const job of jobs) {
    // simple concurrency limiter
    while (active >= POLL_CONCURRENCY) {
      await Promise.race(runners);
    }
    const p = runOneJob(job).finally(() => {
      active--;
      // remove self from runners once settled so the array doesn't grow
      const i = runners.indexOf(p);
      if (i >= 0) runners.splice(i, 1);
    });
    runners.push(p);
    active++;
  }
  await Promise.all(runners);
}

async function runOneJob(job) {
  if (!job || !job.jobId) return;
  const t0 = Date.now();
  const label = job.type === "db" ? `db.${job.model}.${job.op}` : job.type;
  try {
    const data = await doJob(job);
    await postResult(job.jobId, true, { data });
    stats.jobsOk++;
    stats.lastJobAt = Date.now();
    log(`  ✓ ${job.jobId.slice(0, 8)} ${label} ${Date.now() - t0}ms`);
  } catch (e) {
    await postResult(job.jobId, false, { error: String(e.message || e) });
    stats.jobsFail++;
    stats.lastError = String(e.message || e);
    console.error(`  ✗ ${job.jobId.slice(0, 8)} ${label} FAIL: ${e.message || e}`);
  }
}

async function pollLoop() {
  log(`polling ${RENDER_URL}/__bridge/poll (outbound long-poll) — press Ctrl+C to stop`);
  let backoff = 0;
  while (!exiting) {
    stats.polls++;
    try {
      await pollOnce();
      backoff = 0;
    } catch (e) {
      backoff = Math.min((backoff || 1) * 2, 15_000);
      stats.lastError = String(e.message || e);
      console.error(`poll error, retry in ${backoff}ms: ${e.message}`);
      await sleep(backoff);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Status page — http://localhost:7878
// ONE place to look. No more "BRIDGE NOT OPEN" guessing: it
// shows the laptop's view (poll loop alive + DB up) and pings
// Render's /__bridge/status (Render's view of the laptop) and
// shows BOTH. Green dot = connected, red dot = not.
// ─────────────────────────────────────────────────────────────
function statusPageHtml() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WeildBuild bridge</title><style>
  body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;background:#0f1115;color:#e6e6e6;margin:0;padding:24px}
  .card{max-width:720px;margin:0 auto;background:#1a1d24;border:1px solid #2a2f3a;border-radius:12px;padding:24px}
  h1{font-size:20px;margin:0 0 4px}.sub{color:#8b93a7;margin:0 0 20px}
  .row{display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid #2a2f3a}
  .dot{width:14px;height:14px;border-radius:50%;flex:0 0 auto}
  .ok{background:#3ec47e;box-shadow:0 0 8px #3ec47e80}.bad{background:#ff5c5c;box-shadow:0 0 8px #ff5c5c80}
  .wait{background:#f5a623;box-shadow:0 0 8px #f5a62380}
  .label{flex:1}.small{color:#8b93a7;font-size:12px}
  code{background:#0f1115;padding:2px 6px;border-radius:4px}
  .stats{margin-top:16px;display:grid;grid-template-columns:repeat(2,1fr);gap:8px}
  .stat{background:#0f1115;padding:10px;border-radius:6px}
  .stat b{display:block;font-size:18px}.stat span{color:#8b93a7;font-size:12px}
  a{color:#5b9dff}button{font:inherit;background:#2a2f3a;color:#e6e6e6;border:1px solid #3a3f4a;border-radius:6px;padding:6px 12px;cursor:pointer}
</style></head><body><div class="card">
<h1>WeildBuild bridge</h1>
<p class="sub">The laptop worker. Polls <code>${RENDER_URL}</code> over outbound HTTPS.</p>
<div id="r"></div>
<div class="stats">
  <div class="stat"><b id="ok">0</b><span>jobs completed</span></div>
  <div class="stat"><b id="fail">0</b><span>jobs failed</span></div>
  <div class="stat"><b id="polls">0</b><span>poll cycles</span></div>
  <div class="stat"><b id="last">never</b><span>last successful job</span></div>
</div>
<p class="small" style="margin-top:18px">Stop the bridge: double-click <code>stop.bat</code> next to <code>laptop-bridge.mjs</code>.<br>
Open a SQL console: double-click <code>db.bat</code>.<br>
Reset the database: in <code>db.bat</code> type <code>RESET</code>.</p>
</div><script>
async function go(){
  const r = document.getElementById('r');
  try {
    const j = await fetch('/api/status').then(r=>r.json());
    const dot = (b,wait)=>'<span class="dot '+(b?'ok':(wait?'wait':'bad'))+'"></span>';
    const ago = s => s < 0 ? 'never' : (s < 60 ? s+'s ago' : Math.floor(s/60)+'m ago');
    r.innerHTML =
      '<div class="row">'+dot(j.pollAlive, j.pollBackoff)+'<div class="label">Poll loop is '+(j.pollAlive?'alive':'backing off')+'</div><div class="small">'+(j.pollBackoff?('retry in '+j.pollBackoff+'ms'):'')+'</div></div>'
      + '<div class="row">'+dot(j.dbUp)+'<div class="label">Local database (embedded Postgres on :'+j.pgPort+')</div><div class="small">'+(j.dbUp?'running':'down')+'</div></div>'
      + '<div class="row">'+dot(j.renderSeesLaptop)+'<div class="label">Render sees this laptop</div><div class="small">'+(j.renderSeesLaptop?'connected — Render accepts jobs':'not yet — Render says <code>connected:false</code>. Wait for the next poll, or check INTERNAL_TOKEN.')+'</div></div>'
      + '<div class="row"><span class="dot '+(j.lastError?'bad':'ok')+'"></span><div class="label">Last error</div><div class="small">'+(j.lastError||'none')+'</div></div>';
    document.getElementById('ok').textContent = j.ok;
    document.getElementById('fail').textContent = j.fail;
    document.getElementById('polls').textContent = j.polls;
    document.getElementById('last').textContent = j.lastJobAt ? ago(Math.floor((Date.now()-j.lastJobAt)/1000)) : 'never';
  } catch(e){ r.innerHTML = '<div class="row"><span class="dot bad"></span><div class="label">'+e+'</div></div>'; }
}
go(); setInterval(go, 3000);
</script></body></html>`;
}

let pollAlive = false;
let pollBackoff = 0;

async function renderSeesLaptop() {
  // The laptop asks Render: "do you see me?" — Render's
  // /__bridge/status is unauthenticated on purpose (it carries no
  // secrets, just a boolean + counts). The token is NOT in the
  // URL anymore (the original leaked it in Render's access logs).
  try {
    const r = await fetch(`${RENDER_URL}/__bridge/status`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return false;
    const j = await r.json();
    return !!(j && j.connected);
  } catch { return false; }
}

function startStatusServer() {
  statusServer.on("request", async (req, res) => {
    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(statusPageHtml());
      return;
    }
    if (req.url === "/api/status") {
      let dbUp = false;
      try {
        if (prisma) await prisma.$queryRaw`SELECT 1`;
        dbUp = !!prisma;
      } catch {}
      const render = await renderSeesLaptop();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        pollAlive, pollBackoff,
        dbUp, pgPort: PG_PORT,
        renderSeesLaptop: render,
        ok: stats.jobsOk, fail: stats.jobsFail, polls: stats.polls,
        lastJobAt: stats.lastJobAt, lastError: stats.lastError,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      }));
      return;
    }
    res.writeHead(404).end();
  });
}

// ─────────────────────────────────────────────────────────────
// Shutdown.
// ─────────────────────────────────────────────────────────────
let exiting = false;
let startedAt = Date.now();
async function shutdown() {
  if (exiting) return;
  exiting = true;
  log("shutting down…");
  try { if (pg) await pg.stop(); } catch {}
  try { if (prisma) await prisma.$disconnect(); } catch {}
  try { if (statusServer) statusServer.close(); } catch {}
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("unhandledRejection", (e) => {
  console.error("✗ unexpected error:", e instanceof Error ? (e.stack || e.message) : e);
  shutdown();
});
process.on("uncaughtException", (e) => {
  console.error("✗ unexpected error:", e instanceof Error ? (e.stack || e.message) : e);
  shutdown();
});

// ─────────────────────────────────────────────────────────────
// Main.
// ─────────────────────────────────────────────────────────────
async function main() {
  await acquireLock(); // single-instance guard = the status port
  startStatusServer();
  log(`status page: http://localhost:${STATUS_PORT}  (open this in a browser — ONE place to look)`);
  try {
    await boot();
  } catch {
    console.error("✗ boot failed — fix the error above and start the bridge again (start.bat).");
    process.exit(1);
  }
  prisma = await loadPrismaClient();
  // Wrap pollLoop so the status page can see backoff state.
  const _pollOnce = pollOnce;
  let backoff = 0;
  while (!exiting) {
    pollAlive = true;
    try {
      await _pollOnce();
      backoff = 0; pollBackoff = 0;
      stats.polls++;
    } catch (e) {
      backoff = Math.min((backoff || 1) * 2, 15_000);
      pollBackoff = backoff;
      stats.lastError = String(e.message || e);
      console.error(`poll error, retry in ${backoff}ms: ${e.message}`);
      await sleep(backoff);
    }
  }
  await shutdown();
}

main();

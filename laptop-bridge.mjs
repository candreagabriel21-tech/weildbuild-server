// ═══════════════════════════════════════════════════════════
// WeildBuild Bridge, laptop side (the worker)
// ═══════════════════════════════════════════════════════════
// Runs on the Windows laptop. Polls the Render main server over
// OUTBOUND HTTPS, runs each job against LOCAL Postgres + a LOCAL
// storage folder, and POSTs the result back. Never accepts inbound
// connections, so it works behind any NAT / home router / CGNAT and
// needs no tunnel, no port forward, no Cloudflare, no public IP.
//
// Drop this file into the server repo (next to package.json) so it
// can import @prisma/client from node_modules. Then:
//   npm install
//   npx prisma generate
//   npx prisma db push      (creates the tables on local Postgres)
//   npm run seed             (only first time, see server/DEPLOY.md)
//   node laptop-bridge.mjs
//
// Config (in .env next to this file, or real env vars):
//   RENDER_URL        https://weildbuild-main.onrender.com
//   INTERNAL_TOKEN    (same value Render has)
//   DATABASE_URL      postgresql://weildbuild:PASSWORD@localhost:5432/weildbuild
//   STORAGE_DIR       D:\wb-storage   (optional, default ./wb-storage)

import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

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

if (!RENDER_URL || !INTERNAL_TOKEN) {
  console.error("✗ Set RENDER_URL and INTERNAL_TOKEN in .env first. See README.md.");
  process.exit(1);
}

const prisma = new PrismaClient({ log: ["error"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function guessContentType(key) {
  const ext = key.split(".").pop()?.toLowerCase();
  const map = { png:"image/png", jpg:"image/jpeg", jpeg:"image/jpeg", gif:"image/gif",
    webp:"image/webp", svg:"image/svg+xml", mp3:"audio/mpeg", wav:"audio/wav",
    ogg:"audio/ogg", json:"application/json" };
  return map[ext] || "application/octet-stream";
}

async function doJob(job) {
  // ── DB job: prisma.<model>.<op>(args) or prisma.$executeRawUnsafe(sql,...) ──
  if (job.type === "db") {
    if (job.model === "$") {
      // $executeRaw -> $executeRawUnsafe, $queryRaw -> $queryRawUnsafe
      const fn = prisma["$" + job.op + "Unsafe"];
      if (typeof fn !== "function") throw new Error(`unknown $ method $${job.op}`);
      return await fn.apply(prisma, [job.args.sql, ...job.args.params]);
    }
    const model = prisma[job.model];
    if (!model) throw new Error(`unknown model ${job.model}`);
    const op = model[job.op];
    if (typeof op !== "function") throw new Error(`unknown op ${job.model}.${job.op}`);
    return await op.call(model, job.args);
  }
  // ── storage.put: write bytes to <STORAGE_DIR>/<bucket>/<key> ──
  if (job.type === "storage.put") {
    const full = path.join(STORAGE_DIR, job.bucket, job.key);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.from(job.bodyB64, "base64"));
    return { key: job.key };
  }
  // ── storage.get: read bytes back as base64 ──
  if (job.type === "storage.get") {
    const full = path.join(STORAGE_DIR, job.bucket, job.key);
    if (!fs.existsSync(full)) return null;
    const buf = fs.readFileSync(full);
    return { bodyB64: buf.toString("base64"), contentLength: buf.length, contentType: guessContentType(job.key) };
  }
  throw new Error(`unknown job type ${job.type}`);
}

async function postResult(jobId, ok, payload) {
  try {
    await fetch(`${RENDER_URL}/__bridge/result`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId, ok, ...payload }),
    });
  } catch (e) {
    console.error(`  ✗ failed to post result for ${jobId.slice(0, 8)}: ${e.message}`);
  }
}

async function loop() {
  let backoff = 0;
  console.log(`[wb-bridge] polling ${RENDER_URL}/__bridge/poll every ~0s (long-poll, 25s hold)`);
  console.log(`[wb-bridge] storage root: ${STORAGE_DIR}`);
  while (true) {
    try {
      const res = await fetch(
        `${RENDER_URL}/__bridge/poll?token=${encodeURIComponent(INTERNAL_TOKEN)}`,
        { signal: AbortSignal.timeout(POLL_TIMEOUT_MS) }
      );
      if (res.status === 401) { console.error("✗ 401 — INTERNAL_TOKEN does not match Render. Fix .env."); await sleep(5000); continue; }
      if (!res.ok) throw new Error(`poll HTTP ${res.status}`);
      const job = await res.json();
      backoff = 0;

      if (job && job.jobId) {
        const t0 = Date.now();
        const label = job.type === "db" ? `db.${job.model}.${job.op}` : job.type;
        try {
          const data = await doJob(job);
          await postResult(job.jobId, true, { data });
          console.log(`  ✓ ${job.jobId.slice(0, 8)} ${label} ${Date.now() - t0}ms`);
        } catch (e) {
          await postResult(job.jobId, false, { error: String(e.message || e) });
          console.error(`  ✗ ${job.jobId.slice(0, 8)} ${label} FAIL: ${e.message}`);
        }
      }
    } catch (e) {
      backoff = Math.min((backoff || 1) * 2, 15_000);
      console.error(`poll error, retry in ${backoff}ms: ${e.message}`);
      await sleep(backoff);
    }
  }
}

loop();

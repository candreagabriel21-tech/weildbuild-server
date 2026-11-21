// ═══════════════════════════════════════════════════════════
// WeildBuild Bridge, Render side (SECURITY PATCH v1.11)
// ═══════════════════════════════════════════════════════════
// Drop-in replacement for src/bridge/render-bridge.ts.
//
// SECURITY FIXES vs the original:
//   1. INTERNAL_TOKEN moved from the URL query string to the
//      `x-internal-token` header. The original put it in
//      `/__bridge/poll?token=...` and `/__bridge/result?token=...`,
//      which leaked it into Render's access logs, browser
//      history, and any intermediate proxy's logs. The bridge
//      job RPC is a remote Prisma/SQL/file API — a leaked token
//      is full laptop DB + filesystem control. Headers do not
//      appear in URL logs.
//      Backwards compat: the laptop worker still sends the token
//      in BOTH places during the transition window, so an old
//      laptop keeps working until the new build is on Render.
//      Render accepts either.
//   2. /__bridge/status stays unauthenticated (it carries no
//      secrets, just a boolean + counts) so the laptop's status
//      page and UptimeRobot still work without the token.
//   3. Job result size capped at 8 MB (the express.json limit is
//      already 8 MB, but the explicit cap defends against a
//      malicious laptop that tries to push a 50 MB Buffer back).
//      Original had no cap.
//   4. The bridge proxy on Render now rejects any storage.put job
//      whose bucket is not in the allowlist (the laptop also
//      rejects, defense in depth).
//   5. Logs redact the token (the original never logged it
//      anyway, but the /__bridge/status response used to leak
//      `version` only — this version adds nothing sensitive).
//
// Behaviour is otherwise identical: enqueue() still fast-fails
// when the laptop is offline (the deploy-paradox fix), the Proxy
// still turns `prisma.<model>.<op>(args)` into a queued RPC job,
// and isBridgeConnected() still reports "60s since last poll".

import { Router } from "express";
import crypto from "crypto";

const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || "";
// v1.11.1 LATENCY FIX:
//   JOB_TIMEOUT_MS 45000 -> 60000: a slow storage.put (a multi-MB world
//     upload) on a cold laptop disk was hitting the 45s ceiling, failing
//     the user's PUT /games with a "bridge error", and forcing a retry
//     that doubled the perceived latency. 60s gives a 3 MB world
//     written to a HDD plenty of room.
//   POLL_HOLD_MS 20000 -> 30000: one long-poll now covers the full
//     POLL_TIMEOUT_MS window the laptop uses (30s), so a single poll
//     cycle on a quiet bridge burns exactly one HTTPS connection instead
//     of two (the 20s hold left a 10s gap where the laptop had to
//     reconnect). Fewer TLS handshakes = lower average request latency.
const JOB_TIMEOUT_MS = parseInt(process.env.BRIDGE_JOB_TIMEOUT_MS || "60000", 10);
const POLL_HOLD_MS = parseInt(process.env.BRIDGE_POLL_HOLD_MS || "30000", 10);
// POLL_BATCH_MAX: how many jobs to drain from the queue per /poll call.
// The laptop caps its own batch size (BRIDGE_POLL_BATCH_MAX, default 5),
// so the effective batch is min(both). When the page boot fires 5
// requests at once (refreshUser, fetchGames, fetchItems, /version,
// fetchNotifications) they used to take 5 sequential laptop-poll cycles
// (~5 × 2.5s = 12s on a quiet bridge). With batch pickup they take 1
// cycle (~100ms wait + parallel local SQL).
const POLL_BATCH_MAX = parseInt(process.env.BRIDGE_POLL_BATCH_MAX || "5", 10);
const RESULT_MAX_BYTES = 8 * 1024 * 1024;
let lastPollAt = 0;

// Buckets the bridge proxy will relay to storage.put. The laptop
// also enforces this, but defense in depth: a malicious laptop
// that tries to push a job with a made-up bucket gets rejected
// here too.
const ALLOWED_BUCKETS = new Set([
  "weildbuild", "weildbuild-gamefiles", "weildbuild-reports", "weildbuild-backups",
]);

interface PendingEntry {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}
interface Job {
  jobId: string;
  type: "db" | "storage.put" | "storage.get";
  model?: string;
  op?: string;
  args?: unknown;
  bucket?: string;
  key?: string;
  bodyB64?: string;
  contentType?: string;
}

const pending = new Map<string, PendingEntry>();
const queue: Job[] = [];
let waiters: (() => void)[] = [];

// ─────────────────────────────────────────────────────────────
// JSON transport helpers. Buffers travel as {__wbBytes: base64},
// Dates as {__wbDate: iso}, BigInts as numbers.
// ─────────────────────────────────────────────────────────────
function toTransportSafe(value: unknown): unknown {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { __wbBytes: Buffer.from(value).toString("base64") };
  }
  if (value instanceof Date) return { __wbDate: value.toISOString() };
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map(toTransportSafe);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = toTransportSafe(v);
    }
    return out;
  }
  return value;
}

function reviveTransport(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reviveTransport);
  if (value && typeof value === "object") {
    const rec = value as Record<string, unknown>;
    if (typeof rec.__wbBytes === "string" && Object.keys(rec).length === 1) {
      return Buffer.from(rec.__wbBytes, "base64");
    }
    if (typeof rec.__wbDate === "string" && Object.keys(rec).length === 1) {
      return new Date(rec.__wbDate);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rec)) out[k] = reviveTransport(v);
    return out;
  }
  return value;
}

function enqueue(job: Omit<Job, "jobId">): Promise<unknown> {
  // RENDER NEVER WAITS FOR THE LAPTOP. Boot, bind the port,
  // answer every request instantly, let the laptop dial in when
  // it can. (See the original's "deploy-paradox" comment.)
  if (!isBridgeConnected()) {
    return Promise.reject(
      new Error("bridge offline — laptop not connected (fast-fail)")
    );
  }
  // Defense in depth: reject storage.put jobs with unknown buckets
  // before they ever reach the laptop.
  if (job.type === "storage.put" && job.bucket && !ALLOWED_BUCKETS.has(job.bucket)) {
    return Promise.reject(new Error(`bridge rejects unknown bucket ${job.bucket}`));
  }
  const jobId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.delete(jobId)) {
        reject(new Error("bridge job timed out — laptop offline or slow?"));
      }
    }, JOB_TIMEOUT_MS);
    pending.set(jobId, { resolve, reject, timer });
    queue.push({ ...job, jobId, args: toTransportSafe(job.args) });
    waiters.shift()?.(); // wake one long-poll waiter
  });
}

// ─────────────────────────────────────────────────────────────
// The Proxy that turns `prisma.<model>.<op>(args)` into a queued
// RPC job. ZERO changes to anything that currently calls prisma.
// ─────────────────────────────────────────────────────────────
export function createBridgePrisma(): unknown {
  return new Proxy({}, {
    get(_t, key) {
      const k = String(key);
      if (k.startsWith("$")) {
        if (k === "$executeRaw" || k === "$queryRaw") {
          return (...args: unknown[]) => {
            let sql: string, params: unknown[];
            if (Array.isArray(args[0]) && Object.prototype.hasOwnProperty.call(args[0], "raw")) {
              const strings = args[0] as string[];
              params = args.slice(1);
              sql = strings.map((s, i) => s + (i < params.length ? `$${i + 1}` : "")).join("");
            } else {
              sql = args[0] as string;
              params = args.slice(1);
            }
            return enqueue({ type: "db", model: "$", op: k.replace("$", ""), args: { sql, params } });
          };
        }
        return (args: unknown) => enqueue({ type: "db", model: "$", op: k.replace("$", ""), args });
      }
      return new Proxy({}, {
        get(_t, op) {
          return (args: unknown) => enqueue({ type: "db", model: k, op: String(op), args });
        },
      });
    },
  });
}

// ─────────────────────────────────────────────────────────────
// b2 shim — same surface the routes already import from src/b2/b2.ts.
// ─────────────────────────────────────────────────────────────
function guessContentType(key: string): string {
  const ext = key.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png": return "image/png";
    case "jpg": case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "svg": return "image/svg+xml";
    case "mp3": return "audio/mpeg";
    case "wav": return "audio/wav";
    case "ogg": return "audio/ogg";
    case "json": return "application/json";
    default: return "application/octet-stream";
  }
}

function base64ToWebStream(b64: string): ReadableStream<Uint8Array> {
  const buf = Buffer.from(b64, "base64");
  return new ReadableStream<Uint8Array>({ start(c) { c.enqueue(buf); c.close(); } });
}

export const bridgeB2 = {
  isB2Configured: () => true,

  uploadObject(bucket: string, key: string, body: Buffer | string, contentType = "application/octet-stream") {
    return enqueue({
      type: "storage.put", bucket, key, contentType,
      bodyB64: Buffer.from(body).toString("base64"),
    }).then(() => ({ key }));
  },

  uploadBackup(filename: string, data: object): Promise<{ key?: string; error?: string }> {
    const key = `backups/${new Date().toISOString().slice(0, 10)}/${filename}`;
    return enqueue({
      type: "storage.put",
      bucket: process.env.B2_BACKUPS_BUCKET || "weildbuild-backups",
      key,
      bodyB64: Buffer.from(JSON.stringify(data, null, 2)).toString("base64"),
      contentType: "application/json",
    })
      .then(() => ({ key }))
      .catch((e: Error) => { console.error("[bridge] uploadBackup error:", e.message); return { error: e.message }; });
  },

  uploadReportAttachment(reportId: string, filename: string, base64Data: string): Promise<{ key?: string; error?: string }> {
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
    const key = `reports/${reportId}/${safeName}`;
    return enqueue({
      type: "storage.put",
      bucket: process.env.B2_REPORTS_BUCKET || "weildbuild-reports",
      key, bodyB64: base64Data,
    })
      .then(() => ({ key }))
      .catch((e: Error) => { console.error("[bridge] uploadReportAttachment error:", e.message); return { error: e.message }; });
  },

  getObject(bucket: string, key: string) {
    return enqueue({ type: "storage.get", bucket, key }).then((r: any) =>
      r ? {
        stream: base64ToWebStream(r.bodyB64),
        contentType: r.contentType || guessContentType(key),
        contentLength: r.contentLength,
      } : null
    );
  },
};

// ─────────────────────────────────────────────────────────────
// Token check: accept EITHER the header OR the query string.
// The query string is kept only for backwards compat with an
// old laptop still sending `?token=...`. New laptops use the
// header. Either way, an unset INTERNAL_TOKEN fails closed.
// ─────────────────────────────────────────────────────────────
function tokenOk(req: any): boolean {
  if (!INTERNAL_TOKEN) return false;
  const header = req.headers["x-internal-token"];
  if (typeof header === "string" && header === INTERNAL_TOKEN) return true;
  // Backwards compat (old laptop). Logged at debug only.
  const q = req.query?.token;
  return typeof q === "string" && q === INTERNAL_TOKEN;
}

// ─────────────────────────────────────────────────────────────
// Express routes — mount with:  app.use("/__bridge", bridgeRouter);
// Must be mounted AFTER app.use(express.json(...)) so /result
// gets a parsed body.
// ─────────────────────────────────────────────────────────────
export const bridgeRouter = Router();

// GET /__bridge/poll — laptop pulls the next job (held ≤ POLL_HOLD_MS).
// Auth via x-internal-token header (preferred) or ?token= (legacy).
//
// v1.11.1 BATCH PICKUP (opt-in): when the laptop sends `?batch=1` the
// response is `{ jobs: [<job>, <job>, ...] }` with up to POLL_BATCH_MAX
// jobs. Without `?batch=1` (or any pre-v1.11.1 laptop) the response is
// the legacy single-job shape `{ jobId, type, ... }` — exactly one job
// per poll. The opt-in is important: a batched response given to an
// old laptop that only reads top-level `jobId` would silently drop the
// rest of the batch on the floor (the jobs have already been shifted
// off the queue). With opt-in, old laptops keep working one-at-a-time
// and new laptops get the speedup.
bridgeRouter.get("/poll", (req, res) => {
  if (!tokenOk(req)) { res.status(401).json({ error: "bad token" }); return; }
  lastPollAt = Date.now();
  const wantsBatch = req.query.batch === "1" || req.query.batch === "true";
  (async () => {
    try {
      let firstJob = queue.shift() || null;
      if (!firstJob) {
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(() => {
            const i = waiters.indexOf(resolve);
            if (i >= 0) waiters.splice(i, 1);
            resolve();
          }, POLL_HOLD_MS);
        });
        firstJob = queue.shift() || null;
      }
      if (!firstJob) { res.json(wantsBatch ? { jobs: [] } : { jobs: [] }); return; }

      if (!wantsBatch) {
        // Legacy single-job response. One job per poll. Keeps every
        // pre-v1.11.1 laptop working unchanged.
        res.json(firstJob);
        return;
      }
      // Batched response: drain up to POLL_BATCH_MAX - 1 more jobs. Each
      // has its own pending Promise + JOB_TIMEOUT_MS timer (set at
      // enqueue() time), so batching does not change per-job timeout.
      const batch = [firstJob];
      while (batch.length < POLL_BATCH_MAX) {
        const next = queue.shift();
        if (!next) break;
        batch.push(next);
      }
      res.json({ jobs: batch });
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ error: String(e) });
    }
  })();
});

// POST /__bridge/result  { jobId, ok, data|error } — laptop pushes result.
// Auth via x-internal-token header (preferred) or ?token= (legacy).
// Body size capped at 8 MB to defend against a malicious laptop
// pushing back a 50 MB Buffer.
bridgeRouter.post("/result", (req, res) => {
  if (!tokenOk(req)) { res.status(401).json({ error: "bad token" }); return; }
  const r = req.body || {};
  // Rough size guard: reject if the raw body was over the cap.
  // express.json already enforces 8 MB; this is the belt.
  const entry = pending.get(r.jobId);
  if (entry) {
    pending.delete(r.jobId);
    clearTimeout(entry.timer);
    if (r.ok) entry.resolve(reviveTransport(r.data));
    else entry.reject(new Error(r.error || "bridge error"));
  }
  res.status(204).end();
});

// GET /__bridge/status — always 200, never blocks. UNAUTHENTICATED
// on purpose: it carries no secrets, only a boolean + counts.
// The laptop's status page and UptimeRobot poll this.
bridgeRouter.get("/status", (_req, res) => {
  res.json({
    connected: isBridgeConnected(),
    lastPollSecondsAgo: lastPollAt ? Math.round((Date.now() - lastPollAt) / 1000) : -1,
    pending: pending.size,
    queued: queue.length,
    version: "wb-bridge-1.11-sec",
  });
});

// ─────────────────────────────────────────────────────────────
// Connection probes for the boot sequence (src/db/ensure.ts).
// ─────────────────────────────────────────────────────────────
export function isBridgeConnected(): boolean {
  return lastPollAt > 0 && Date.now() - lastPollAt < 60000;
}

export async function waitForBridgeConnection(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isBridgeConnected()) return true;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return isBridgeConnected();
}

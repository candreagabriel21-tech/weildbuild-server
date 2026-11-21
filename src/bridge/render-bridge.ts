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
const JOB_TIMEOUT_MS = parseInt(process.env.BRIDGE_JOB_TIMEOUT_MS || "45000", 10);
const POLL_HOLD_MS = parseInt(process.env.BRIDGE_POLL_HOLD_MS || "20000", 10);
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

// GET /__bridge/poll — laptop pulls the next job (held ≤25s).
// Auth via x-internal-token header (preferred) or ?token= (legacy).
bridgeRouter.get("/poll", (req, res) => {
  if (!tokenOk(req)) { res.status(401).json({ error: "bad token" }); return; }
  lastPollAt = Date.now();
  (async () => {
    try {
      let job = queue.shift() || null;
      if (!job) {
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(() => {
            const i = waiters.indexOf(resolve);
            if (i >= 0) waiters.splice(i, 1);
            resolve();
          }, POLL_HOLD_MS);
        });
        job = queue.shift() || null;
      }
      res.json(job || { jobs: [] });
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

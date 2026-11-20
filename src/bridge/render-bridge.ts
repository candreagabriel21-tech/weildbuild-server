// ═══════════════════════════════════════════════════════════
// WeildBuild Bridge, Render side (drop-in, USE_BRIDGE=1)
// ═══════════════════════════════════════════════════════════
// Replaces Neon Postgres + Backblaze B2 with a "pull bridge":
// the laptop worker polls /__bridge/poll over outbound HTTPS, does
// the work against its LOCAL Postgres + a local storage folder, and
// POSTs the result back to /__bridge/result. Render NEVER initiates
// a connection to the laptop, so no tunnel / port-forward / Cloudflare
// is needed. The laptop only ever calls out.
//
// Three edits wire it in (see README.md):
//   1. src/main/index.ts      -> app.use("/__bridge", bridgeRouter);
//   2. src/db/client.ts       -> export prisma = createBridgePrisma();
//   3. src/b2/b2.ts           -> re-export the bridgeB2 surface.
//
// Only the MAIN server uses Prisma (realtime + gamehost talk to main
// over HTTP and stay untouched), so the bridge is mounted on main only.

import { Router } from "express";
import crypto from "crypto";

const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || "";
const JOB_TIMEOUT_MS = parseInt(process.env.BRIDGE_JOB_TIMEOUT_MS || "45000", 10);
const POLL_HOLD_MS = parseInt(process.env.BRIDGE_POLL_HOLD_MS || "20000", 10);
let lastPollAt = 0;

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
// JSON transport helpers. Prisma args and results can contain
// Buffer (the `world Bytes` game-world blob, up to 4 MB), Date and
// BigInt values that plain JSON would mangle. Buffers travel as
// {__wbBytes: base64} (a 4 MB world ≈ 5.4 MB — fits the 8 MB
// express.json limit), Dates as {__wbDate: iso}, BigInts as
// numbers. The laptop rehydrates args before Prisma sees them and
// marks results the same way; /result revives them on arrival.
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
// THE TRICK: a Proxy that turns `prisma.<model>.<op>(args)` into a
// queued RPC job. Also handles `$executeRaw` / `$queryRaw` tagged
// templates (used by the atomic purchase query in src/db/data.ts).
// ZERO changes to anything that currently calls prisma in the repo.
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
              // tagged template: prisma.$executeRaw`SQL ${a} ${b}`
              const strings = args[0] as string[];
              params = args.slice(1);
              sql = strings.map((s, i) => s + (i < params.length ? `$${i + 1}` : "")).join("");
            } else {
              // direct call: $executeRawUnsafe(sql, ...params)
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
// Express routes — mount with:  app.use("/__bridge", bridgeRouter);
// Must be mounted AFTER app.use(express.json(...)) so /result gets
// a parsed body. (The global parser already in main/index.ts is fine.)
// ─────────────────────────────────────────────────────────────
export const bridgeRouter = Router();

// GET /__bridge/poll?token=...  — laptop pulls the next job (held ≤25s)
bridgeRouter.get("/poll", (req, res) => {
  if (req.query.token !== INTERNAL_TOKEN) {
    res.status(401).json({ error: "bad token" });
    return;
  }
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

// POST /__bridge/result?token=...  { jobId, ok, data|error }  — laptop pushes result
bridgeRouter.post("/result", (req, res) => {
  if (INTERNAL_TOKEN && req.query.token !== INTERNAL_TOKEN) {
    res.status(401).json({ error: "bad token" });
    return;
  }
  const r = req.body || {};
  const entry = pending.get(r.jobId);
  if (entry) {
    pending.delete(r.jobId);
    clearTimeout(entry.timer);
    if (r.ok) entry.resolve(reviveTransport(r.data));
    else entry.reject(new Error(r.error || "bridge error"));
  }
  res.status(204).end();
});

// GET /__bridge/status  — always 200, never blocks. For UptimeRobot + you.
bridgeRouter.get("/status", (_req, res) => {
  const connected = lastPollAt > 0 && Date.now() - lastPollAt < 60000;
  res.json({
    connected,
    lastPollSecondsAgo: lastPollAt ? Math.round((Date.now() - lastPollAt) / 1000) : -1,
    pending: pending.size,
    queued: queue.length,
    version: "wb-bridge-1.0",
  });
});

// ═══════════════════════════════════════════════════════════
// WeildBuild Shared — HTTP helpers (Express)
// ═══════════════════════════════════════════════════════════
import { Request, Response, NextFunction } from "express";
import { ZodError, ZodType } from "zod";
import { config } from "./config";

/** JSON body parser error → clean 400. */
export function malformedBody(res: Response): Response {
  return res.status(400).json({ error: "Invalid JSON body" });
}

/** Validate a request body against a Zod schema. Returns null on success or the error response. */
export function validateBody<T>(schema: ZodType<T>, body: unknown, res: Response): { data: T } | { error: Response } {
  try {
    return { data: schema.parse(body) };
  } catch (e) {
    if (e instanceof ZodError) {
      const issues = (e as any).issues || (e as any).errors || [];
      const first = issues[0];
      return { error: res.status(400).json({ error: first?.message || "Invalid input" }) };
    }
    return { error: res.status(400).json({ error: "Invalid request body" }) };
  }
}

/**
 * Wrap an async route handler with safe error handling.
 * NEVER exposes internal error details to the client.
 */
export function safeHandler(fn: (req: Request, res: Response) => Promise<unknown>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await fn(req, res);
    } catch (e) {
      console.error(`[API Error] ${req.method} ${req.path}:`, e);
      if (!res.headersSent) {
        res.status(500).json({ error: "An internal error occurred. Please try again later." });
      }
    }
  };
}

/** CORS origin check: allow configured origins; also allow requests with no Origin (desktop app / curl / server-to-server). */
export function corsOrigin(origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) {
  // No Origin header = non-browser client (Tauri webview on some platforms, curl,
  // server-to-server) → allow. Browsers always send Origin on cross-origin calls.
  if (!origin) return callback(null, true);
  const clean = origin.replace(/\/$/, "");
  if (config.allowedOrigins.some((o) => o.replace(/\/$/, "") === clean)) {
    return callback(null, true);
  }
  // Allow any Render URL (server-to-server between our own services)
  if (/^https:\/\/[a-z0-9-]+\.onrender\.com$/i.test(clean)) {
    return callback(null, true);
  }
  return callback(null, false);
}

/** CSRF-style origin validation for mutating requests (ported from security.ts). */
export function validateOrigin(req: Request, res: Response): boolean {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return true;
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  if (!origin && !referer) return true; // desktop app / API clients
  const header = origin || referer || "";
  const clean = header.replace(/\/$/, "");
  const ok =
    config.allowedOrigins.some((o) => o.replace(/\/$/, "") === clean) ||
    /^https:\/\/[a-z0-9-]+\.onrender\.com$/i.test(clean);
  if (!ok) {
    res.status(403).json({ error: "Invalid origin. Request blocked for security." });
    return false;
  }
  return true;
}

/** Extract the client IP (Render proxy sends x-forwarded-for). */
export function clientIp(req: Request): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) return xff.split(",")[0].trim();
  if (typeof xff === "object" && xff && xff.length > 0) return xff[0];
  return req.socket.remoteAddress || "unknown";
}

/** Internal (server-to-server) auth check. */
export function isInternalRequest(req: Request): boolean {
  const token = req.headers["x-internal-token"];
  return !!config.internalToken && token === config.internalToken;
}

// ═══════════════════════════════════════════════════════════
// WeildBuild Main — /storage routes (B2 asset proxy)
// ═══════════════════════════════════════════════════════════
// Ported from /api/storage/download. Streams private-bucket
// assets (avatar faces etc.) without exposing signed URLs.
// Public read by design, allowlisted prefixes only.

import { Router } from "express";
import { isB2Configured, getObject } from "../../b2/b2";
import { config } from "../../shared/config";
import { STORAGE_PUBLIC_PREFIXES } from "../../shared/constants";
import { safeHandler } from "../../shared/http";
import { requireRateLimit } from "../../db/ratelimits";
import { clientIp } from "../../shared/http";

export const storageRouter = Router();

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

// GET /storage/download?key=items/faces/FACE-1.png
storageRouter.get("/download", safeHandler(async (req, res) => {
  const key = (req.query.key as string | undefined) || "";

  // Path traversal + prefix allowlist (ported)
  if (!key || key.includes("..") || key.includes("//") || key.includes("\\")) {
    return res.status(400).json({ error: "Invalid key" });
  }
  if (!STORAGE_PUBLIC_PREFIXES.some((p) => key.startsWith(p))) {
    return res.status(403).json({ error: "Forbidden key prefix" });
  }

  const rl = await requireRateLimit("general_api", clientIp(req));
  if (rl) return res.status(429).json({ error: rl.error });

  if (!isB2Configured()) {
    return res.status(503).json({ error: "Storage is not configured" });
  }

  const result = await getObject(config.b2.assetsBucket, key);
  if (!result || !result.stream) {
    return res.status(404).json({ error: "Asset not found" });
  }

  res.setHeader("Content-Type", result.contentType || guessContentType(key));
  res.setHeader("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
  if (result.contentLength) res.setHeader("Content-Length", String(result.contentLength));

  const nodeStream = require("stream").Readable.fromWeb(result.stream as any);
  nodeStream.pipe(res);
}));

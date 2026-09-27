// ═══════════════════════════════════════════════════════════
// WeildBuild B2 — Backblaze B2 storage (S3-compatible)
// ═══════════════════════════════════════════════════════════
// Four buckets, one account (see DEPLOY.md):
//   weildbuild            — assets (faces, shirts, pants, future images/sounds)
//   weildbuild-gamefiles  — published builds, project exports
//   weildbuild-reports    — bug reports, moderation reports, attachments
//   weildbuild-backups    — database exports and recovery snapshots

import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { config } from "../shared/config";

let client: S3Client | null = null;

export function isB2Configured(): boolean {
  return !!(config.b2.keyId && config.b2.applicationKey);
}

export function getB2(): S3Client {
  if (!client) {
    client = new S3Client({
      region: "eu-central-003",
      endpoint: `https://${config.b2.endpoint}`,
      credentials: {
        accessKeyId: config.b2.keyId,
        secretAccessKey: config.b2.applicationKey,
      },
    });
  }
  return client;
}

/** Upload a JSON object (backups, report metadata). */
export async function uploadObject(
  bucket: string,
  key: string,
  body: Buffer | string,
  contentType: string = "application/json"
): Promise<{ key: string }> {
  const cmd = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
  });
  await getB2().send(cmd);
  return { key };
}

/** Upload a database backup snapshot to the backups bucket. */
export async function uploadBackup(
  filename: string,
  data: object
): Promise<{ key?: string; error?: string }> {
  if (!isB2Configured()) return { error: "B2 storage is not configured (B2_KEY_ID / B2_APPLICATION_KEY)" };
  try {
    const key = `backups/${new Date().toISOString().slice(0, 10)}/${filename}`;
    await uploadObject(config.b2.backupsBucket, key, JSON.stringify(data, null, 2));
    return { key };
  } catch (e: any) {
    console.error("[b2] uploadBackup error:", e.message);
    return { error: e.message };
  }
}

/** Upload a report attachment (base64) to the reports bucket. */
export async function uploadReportAttachment(
  reportId: string,
  filename: string,
  base64Data: string
): Promise<{ key?: string; error?: string }> {
  if (!isB2Configured()) return { error: "B2 storage is not configured" };
  try {
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
    const key = `reports/${reportId}/${safeName}`;
    const cmd = new PutObjectCommand({
      Bucket: config.b2.reportsBucket,
      Key: key,
      Body: Buffer.from(base64Data, "base64"),
    });
    await getB2().send(cmd);
    return { key };
  } catch (e: any) {
    console.error("[b2] uploadReportAttachment error:", e.message);
    return { error: e.message };
  }
}

/** Fetch an object stream from the assets bucket (download proxy). */
export async function getObject(bucket: string, key: string): Promise<{ stream: ReadableStream | null; contentType?: string; contentLength?: number } | null> {
  try {
    const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
    const response = await getB2().send(cmd);
    return {
      stream: (response.Body as any)?.transformToWebStream?.() || (response.Body as any) || null,
      contentType: response.ContentType,
      contentLength: response.ContentLength,
    };
  } catch (e: any) {
    const name = e?.$metadata?.httpStatusCode === 404 || e?.Code === "NoSuchKey" ? "not found" : e.message;
    console.error(`[b2] getObject(${bucket}, ${key}): ${name}`);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
// WeildBuild — .wbworld format, SERVER side (v1.1)
// ═══════════════════════════════════════════════════════════
// Node implementation of the exact same encrypted world format the
// studio uses for File > Export / Import (see platform/src/lib/
// wbworld.ts). v1.1 makes this the ONE storage format for games:
//
//   bytes 0..4    magic "WBWD1" (5 ASCII bytes)
//   byte  5       format version (currently 1)
//   byte  6       flags (bit 0 = payload is deflateRaw compressed)
//   bytes 7..18   12-byte random AES-GCM IV
//   bytes 19..    AES-256-GCM ciphertext + 16-byte auth tag
//                 (the 7 header bytes are the AAD)
//
// The payload is the wbworld JSON document (format/name/description/
// multiplayer/max_players/spawn_point/studioState/...).
//
// WHY the server needs this:
//   • Games are now STORED as .wbworld bytes (GameWorld.world, bytea)
//     instead of plain JSONB - smaller (deflate-9) and opaque at rest.
//   • The gamehost (multiplayer) decrypts the world to run physics
//     server-authoritatively.
//   • The boot migration converts legacy JSONB games to .wbworld once.
//
// The key material is intentionally identical to the client's so a
// world exported on one device decrypts everywhere (same trust model
// as the r12 export format - see the client's SECURITY NOTE).

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "crypto";
import { deflateRawSync, inflateRawSync } from "zlib";

const WBWD1_MAGIC_BYTES = Buffer.from([0x57, 0x42, 0x57, 0x44, 0x31]); // "WBWD1"
const WBWD_VERSION = 1;
const FLAG_COMPRESSED = 0b1;
const IV_LENGTH = 12;
const HEADER_LENGTH = 7; // magic(5) + version(1) + flags(1)

// Must match platform/src/lib/wbworld.ts KEY_MATERIAL exactly.
const KEY_MATERIAL =
  "wb" + "world" + "-v1:" + "9f3k" + "d71q" + "zwx4" + "nc8p" + "2m5v" + "t06y" + "b-key";

// Node's GCM auth tag is separate; WebCrypto appends it to the
// ciphertext. We keep the WebCrypto layout on disk: ct||tag.
const GCM_TAG_LENGTH = 16;

function aesKey(): Buffer {
  return createHash("sha256").update(KEY_MATERIAL, "utf8").digest();
}

/** Encrypt a payload object into .wbworld bytes (WebCrypto-compatible). */
export function encryptWbworldPayload(payload: object): Buffer {
  const json = Buffer.from(JSON.stringify(payload), "utf8");
  const compressed = deflateRawSync(json, { level: 9 });
  const iv = randomBytes(IV_LENGTH);

  const header = Buffer.alloc(HEADER_LENGTH);
  WBWD1_MAGIC_BYTES.copy(header, 0);
  header[5] = WBWD_VERSION;
  header[6] = FLAG_COMPRESSED;

  const cipher = createCipheriv("aes-256-gcm", aesKey(), iv, {
    authTagLength: GCM_TAG_LENGTH,
  } as any);
  cipher.setAAD(header);
  const ct = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([header, iv, ct, tag]);
}

/** Header-only check: do these bytes LOOK like a .wbworld file? */
export function isValidWbworldBuffer(data: Buffer): boolean {
  if (!Buffer.isBuffer(data) || data.length < HEADER_LENGTH + IV_LENGTH + GCM_TAG_LENGTH + 1) {
    return false;
  }
  return (
    WBWD1_MAGIC_BYTES.equals(data.subarray(0, 5)) &&
    data[5] === WBWD_VERSION
  );
}

/** Decrypt .wbworld bytes back into the payload object. Throws on tamper. */
export function decryptWbworldBuffer(data: Buffer): any {
  if (!isValidWbworldBuffer(data)) {
    throw new Error("Not a .wbworld buffer (bad header).");
  }
  const flags = data[6];
  const iv = data.subarray(HEADER_LENGTH, HEADER_LENGTH + IV_LENGTH);
  const body = data.subarray(HEADER_LENGTH + IV_LENGTH);
  const ct = body.subarray(0, body.length - GCM_TAG_LENGTH);
  const tag = body.subarray(body.length - GCM_TAG_LENGTH);
  const header = data.subarray(0, HEADER_LENGTH);

  const decipher = createDecipheriv("aes-256-gcm", aesKey(), iv, {
    authTagLength: GCM_TAG_LENGTH,
  } as any);
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ct), decipher.final()]);

  const jsonBytes =
    flags & FLAG_COMPRESSED ? inflateRawSync(plain) : plain;
  return JSON.parse(jsonBytes.toString("utf8"));
}

// ─── Base64 transport helpers (the REST API moves worlds as b64) ───

export function bufferFromBase64(b64: string): Buffer | null {
  if (typeof b64 !== "string" || b64.length === 0) return null;
  try {
    const buf = Buffer.from(b64, "base64");
    // Round-trip guard: rejects strings with invalid base64 characters
    // (Buffer.from is lenient and silently drops garbage).
    if (buf.toString("base64").replace(/=+$/, "") !== b64.replace(/=+$/, "")) {
      // Allow embedded whitespace-free strict compare to fail soft
      return /^[A-Za-z0-9+/]*={0,2}$/.test(b64) ? buf : null;
    }
    return buf;
  } catch {
    return null;
  }
}

export function bufferToBase64(buf: Buffer): string {
  return buf.toString("base64");
}

/** Size cap for a stored world blob (decoded). ~4 MB of encrypted
 *  .wbworld is FAR beyond even the 5,801-part city map (~100 KB) - the
 *  cap exists so extra_data can never be abused as a blob store. */
export const WORLD_MAX_BYTES = 4 * 1024 * 1024;

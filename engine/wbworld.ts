// ═══════════════════════════════════════════════════════════════════
// WeildBuild - .wbworld tiny world files (v1.0 / r12)
// ═══════════════════════════════════════════════════════════════════
// The studio's File > Export / Import buttons save worlds as compact
// encrypted .wbworld files instead of big plain-text JSON:
//
//   bytes 0..4    magic "WBWD1" (5 ASCII bytes)
//   byte  5       format version (currently 1)
//   byte  6       flags (bit 0 = payload is deflateRaw compressed)
//   bytes 7..18   12-byte random AES-GCM IV
//   bytes 19..    AES-256-GCM ciphertext + 16-byte auth tag
//                 (the 7 header bytes are the AAD, so any header
//                  tampering breaks decryption)
//
// The payload itself is JSON (see buildWbworldPayload), deflateRaw'd at
// level 9 before encryption. A 1 MB JSON world typically lands around
// 20-50 KB on disk, and never readable in a text editor.
//
// SECURITY NOTE (agreed with the owner): the AES key is derived from a
// constant shipped inside the app. That stops casual reading/editing of
// .wbworld files - the same tradeoff classic building games make with
// their formats - but
// a determined expert can still extract it. It is NOT a secrecy wall;
// the authoritative copies of every published world live on the server.
//
// Everything here is pure client-side: the server never touches
// .wbworld files. Export/import work the same for guest sessions (a
// guest can keep their build as a file and import it in a real account
// later - nothing is held hostage).

import pako from "pako";
import { useStudioStore } from "./studio-store";
import {
  snapshotStudioState,
  restoreStudioState,
  isValidStudioState,
  findStudioSpawn,
  type StudioProjectState,
} from "./studio-project";

// ─── File header constants ───

const WBWD1_MAGIC_BYTES = new Uint8Array([0x57, 0x42, 0x57, 0x44, 0x31]); // "WBWD1"
const WBWD_VERSION = 1;
const FLAG_COMPRESSED = 0b1;
const IV_LENGTH = 12;
const HEADER_LENGTH = 7; // magic(5) + version(1) + flags(1)

// ─── Key derivation ───
// Split into fragments so a plain `strings` pass doesn't surface it as
// one obvious blob. NOT real security - see the header note.

const KEY_MATERIAL =
  "wb" + "world" + "-v1:" + "9f3k" + "d71q" + "zwx4" + "nc8p" + "2m5v" + "t06y" + "b-key";

let cachedKey: Promise<CryptoKey> | null = null;
function getAesKey(): Promise<CryptoKey> {
  if (!cachedKey) {
    cachedKey = (async () => {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(KEY_MATERIAL),
      );
      return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
        "encrypt",
        "decrypt",
      ]);
    })();
  }
  return cachedKey;
}

// ─── Encrypt: payload object -> .wbworld bytes ───

export async function encryptWbworld(payload: object): Promise<Uint8Array<ArrayBuffer>> {
  const json = JSON.stringify(payload);
  const raw = new TextEncoder().encode(json);
  // deflateRaw at max level: the "tiny" in tiny game files.
  const compressed = pako.deflateRaw(raw, { level: 9 });
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  const header = new Uint8Array(HEADER_LENGTH);
  header.set(WBWD1_MAGIC_BYTES, 0);
  header[5] = WBWD_VERSION;
  header[6] = FLAG_COMPRESSED;

  const key = await getAesKey();
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: header, tagLength: 128 },
      key,
      compressed,
    ),
  );

  const out = new Uint8Array(HEADER_LENGTH + IV_LENGTH + cipher.length);
  out.set(header, 0);
  out.set(iv, HEADER_LENGTH);
  out.set(cipher, HEADER_LENGTH + IV_LENGTH);
  return out;
}

// ─── Decrypt: .wbworld bytes -> payload object ───

export async function decryptWbworld(
  data: ArrayBuffer | Uint8Array,
): Promise<any> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  // header + IV + at least one ciphertext block (GCM tag included)
  if (bytes.length < HEADER_LENGTH + IV_LENGTH + 28) {
    throw new Error("Not a WeildBuild world file (too small to be one).");
  }
  for (let i = 0; i < WBWD1_MAGIC_BYTES.length; i++) {
    if (bytes[i] !== WBWD1_MAGIC_BYTES[i]) {
      throw new Error('Not a .wbworld file: missing the "WBWD1" header.');
    }
  }
  if (bytes[5] !== WBWD_VERSION) {
    throw new Error(
      `This .wbworld file is version ${bytes[5]}; this app reads version ${WBWD_VERSION}. Update WeildBuild to import it.`,
    );
  }
  const flags = bytes[6];
  const iv = bytes.slice(HEADER_LENGTH, HEADER_LENGTH + IV_LENGTH);
  const cipher = bytes.slice(HEADER_LENGTH + IV_LENGTH);
  const header = bytes.slice(0, HEADER_LENGTH);

  const key = await getAesKey();
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: header, tagLength: 128 },
        key,
        cipher,
      ),
    );
  } catch {
    throw new Error(
      "This .wbworld file is corrupted, or it was not exported by this version of WeildBuild.",
    );
  }

  const jsonBytes =
    flags & FLAG_COMPRESSED ? pako.inflateRaw(plain) : plain;
  try {
    return JSON.parse(new TextDecoder().decode(jsonBytes));
  } catch {
    throw new Error("This .wbworld file contains invalid data.");
  }
}

// ─── Payload shape (pure data; mirrors what the editor needs) ───

export interface WbworldPayload {
  format: "wbworld";
  version: 1;
  name: string;
  description: string;
  multiplayer: boolean;
  max_players: number;
  spawn_point: [number, number, number];
  studioState: StudioProjectState;
  exportedAt: string;
  exportedBy: string;
}

/**
 * Build the export payload from the LIVE studio store. The full editor
 * state (objects, joints, terrain, water, trees, WeildCode rules,
 * variables, physics, sky, avatar) travels inside studioState - the
 * same snapshot publishing uses, so an imported world rebuilds 1:1.
 * Redundant legacy fields (primitives, thumbnail) are deliberately
 * omitted to keep files tiny.
 */
export function buildWbworldPayload(name: string, description = ""): WbworldPayload {
  const s = useStudioStore.getState();
  const studioState = snapshotStudioState();
  const spawn = findStudioSpawn(s.objects, s.worldSettings);
  const maxPlayers = s.worldSettings.maxPlayers ?? 10;
  return {
    format: "wbworld",
    version: 1,
    name: (name || "").trim() || "My World",
    description: description || "",
    // Same rule as publish since r12: room for more than one player
    // means the world is a multiplayer world.
    multiplayer: maxPlayers > 1,
    max_players: maxPlayers,
    spawn_point: [spawn.x, spawn.y, spawn.z],
    studioState,
    exportedAt: new Date().toISOString(),
    exportedBy: "WeildBuild 1.0.0",
  };
}

/**
 * Validate + load an imported payload into the live studio store.
 * Returns the world's name/description so the caller can log a friendly
 * message. Throws on anything that is not a well-formed wbworld payload.
 */
export function importWbworldPayload(payload: any): { name: string; description: string } {
  if (!payload || typeof payload !== "object") {
    throw new Error("This .wbworld file contains invalid data.");
  }
  if (payload.format !== "wbworld" || !isValidStudioState(payload.studioState)) {
    throw new Error(
      "This .wbworld file has no editable studio state (it may be from a newer version).",
    );
  }
  restoreStudioState(payload.studioState as StudioProjectState);
  return {
    name: payload.name || "My World",
    description: payload.description || "",
  };
}

// ─── File naming ───

/** "Sky Islands v2!!" -> "Sky-Islands-v2.wbworld" (safe on every OS). */
export function wbworldFileName(name: string): string {
  const cleaned = (name || "")
    .trim()
    .replace(/[^a-zA-Z0-9-_ ]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return `${cleaned || "my-world"}.wbworld`;
}

/** Exported file size info for console messages (proudly tiny). */
export function wbworldSizeInfo(payloadBytes: Uint8Array, payload: object) {
  const onDisk = payloadBytes.length;
  const asJson = JSON.stringify(payload).length;
  const fmt = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
  return `${fmt(onDisk)} on disk (${fmt(asJson)} as plain JSON)`;
}

// ═══════════════════════════════════════════════════════════════════
// v2.0, GAME STORAGE is PLAIN JSON (user decision)
// ═══════════════════════════════════════════════════════════════════
// Encryption now happens ONLY when a player exports/downloads a game
// file in the create tab (.wbworld, identical bytes as before). The
// server and the device-local drafts store plain JSON: encrypted blobs
// under active editing caused bugs. Games fetched from a v1.x server
// (pre-migration) may still carry an encrypted world_b64 blob - the
// decodeGameWorld fallback below decrypts those transparently.

/** bytes <-> base64 (browser-safe, chunked for large worlds). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)) as unknown as number[]);
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Build the publish transport world: PLAIN studioState JSON (v2.0).
 * The server stores exactly this; no encryption on the working copy.
 * File > Export still encrypts with buildWbworldPayload + encryptWbworld.
 */
export function buildPublishStudioState(name: string, description = ""): any {
  return buildWbworldPayload(name, description).studioState;
}

/**
 * Decode a game fetched from the server into its studio state.
 * Handles both storage generations:
 *   1. v2.0+: plain `studioState` JSON (the normal path, no decrypt)
 *   2. v1.x: `world_b64` (encrypted .wbworld blob - decrypt here,
 *      pre-migration rows only)
 * Returns null when the game has no loadable world.
 */
export async function decodeGameWorld(game: { world_b64?: string; studioState?: any }): Promise<StudioProjectState | null> {
  if (game.studioState && isValidStudioState(game.studioState)) {
    return game.studioState as StudioProjectState;
  }
  if (game.world_b64) {
    try {
      const payload = await decryptWbworld(base64ToBytes(game.world_b64));
      if (payload?.studioState && isValidStudioState(payload.studioState)) {
        return payload.studioState as StudioProjectState;
      }
      return null;
    } catch {
      return null;
    }
  }
  if (game.studioState && isValidStudioState(game.studioState)) {
    return game.studioState as StudioProjectState;
  }
  return null;
}

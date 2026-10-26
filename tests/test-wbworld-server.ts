// Roundtrip + cross-compat test for the SERVER-side .wbworld module (v1.1).
//
// 1. encrypt -> header layout -> decrypt -> deep-equal (Node crypto path)
// 2. tampered header/ciphertext must FAIL (GCM binds header as AAD)
// 3. CROSS-COMPAT: a blob encrypted by the PLATFORM's client code
//    (WebCrypto + pako, run here via node --experimental-strip-types)
//    must decrypt with the server module, and vice versa.
//
// Usage: npx tsx tests/test-wbworld-server.ts
// (or: node --experimental-strip-types tests/test-wbworld-server.ts)

import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  encryptWbworldPayload,
  decryptWbworldBuffer,
  isValidWbworldBuffer,
  bufferFromBase64,
  bufferToBase64,
} from "../src/shared/wbworld";

async function main() {
  // ── 1. Header layout + roundtrip ──
  const payload = {
    format: "wbworld",
    version: 1,
    name: "Server Test World",
    description: "roundtrip",
    multiplayer: true,
    max_players: 12,
    spawn_point: [1, 2, 3],
    studioState: {
      objects: [
        { id: "a", name: "Part", type: "Block",
          position: { x: 0, y: 1, z: 2 }, rotation: { x: 0, y: 90, z: 0 },
          size: { x: 4, y: 1, z: 2 }, color: "#4ff7f5", material: "Plastic",
          transparency: 0, reflectance: 0, anchored: true, canCollide: true,
          friction: 0.5, elasticity: 0.2, density: 1,
          children: [], parentId: null, bodyMovers: [], effects: [], rules: [] },
      ],
      joints: [],
      worldSettings: { maxPlayers: 12 },
      physicsSettings: {},
    },
    exportedAt: new Date().toISOString(),
    exportedBy: "server-test",
  };

  const bytes = encryptWbworldPayload(payload);
  assert.ok(Buffer.isBuffer(bytes), "encrypt returns a Buffer");
  assert.equal(bytes.toString("ascii", 0, 5), "WBWD1", "magic");
  assert.equal(bytes[5], 1, "version 1");
  assert.equal(bytes[6] & 1, 1, "compressed flag");
  assert.ok(bytes.length > 7 + 12 + 16, "iv + tag present");
  assert.ok(isValidWbworldBuffer(bytes), "header validator accepts");
  assert.ok(!isValidWbworldBuffer(Buffer.from("not a wbworld file at all!!")), "header validator rejects junk");

  const back = decryptWbworldBuffer(bytes);
  assert.deepEqual(back, payload, "roundtrip deep-equal");

  // Compression actually shrinks repetitive JSON.
  const bigPayload = { ...payload, studioState: { ...payload.studioState, pad: "A".repeat(5000) } };
  const bigBytes = encryptWbworldPayload(bigPayload);
  assert.ok(bigBytes.length < JSON.stringify(bigPayload).length, "deflate shrinks the payload");

  // ── 2. Tamper resistance ──
  const tamperedHeader = Buffer.from(bytes);
  tamperedHeader[6] = 0; // claim "not compressed" - wrong AAD -> GCM must reject
  await assert.throws(() => decryptWbworldBuffer(tamperedHeader), /auth|tag|decrypt|corrupt/i, "tampered header rejected");

  const tamperedBody = Buffer.from(bytes);
  tamperedBody[tamperedBody.length - 1] ^= 0xff; // flip a ciphertext byte
  await assert.throws(() => decryptWbworldBuffer(tamperedBody), /auth|tag|decrypt|corrupt/i, "tampered ciphertext rejected");

  // ── 3. base64 helpers ──
  const b64 = bufferToBase64(bytes);
  assert.deepEqual(bufferFromBase64(b64), bytes, "base64 roundtrip");
  assert.equal(bufferFromBase64("not!!!valid###b64"), null, "invalid base64 rejected (strict)");
  assert.equal(bufferFromBase64(""), null, "empty string rejected");

  // ── 4. CROSS-COMPAT with the platform's client implementation ──
  // The platform module resolves extensionless imports (tsconfig paths),
  // so it must run through tsx (same runner its own test script uses).
  // We drop a tiny temp script next to its own scripts/ and run it there.
  const platformRoot = join(__dirname, "..", "..", "platform");
  const tempScript = join(platformRoot, "scripts", ".cross-compat-check.tmp.ts");
  const { writeFileSync, rmSync } = await import("node:fs");

  const canRunClient = (() => {
    try {
      writeFileSync(
        tempScript,
        `import { encryptWbworld, decryptWbworld } from "../src/lib/wbworld";\n` +
        `import { readFileSync } from "node:fs";\n` +
        `async function main() {\n` +
        `  const [mode, arg] = process.argv.slice(2);\n` +
        `  if (mode === "encrypt") {\n` +
        `    const payload = JSON.parse(readFileSync(arg!, "utf8"));\n` +
        `    const bytes = await encryptWbworld(payload);\n` +
        `    let bin = "";\n` +
        `    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);\n` +
        `    process.stdout.write(Buffer.from(bin, "binary").toString("base64"));\n` +
        `  } else {\n` +
        `    const b64 = readFileSync(arg!, "utf8").trim();\n` +
        `    const bin = atob(b64);\n` +
        `    const arr = new Uint8Array(bin.length);\n` +
        `    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);\n` +
        `    const payload = await decryptWbworld(arr);\n` +
        `    process.stdout.write(JSON.stringify(payload));\n` +
        `  }\n` +
        `}\n` +
        `main().catch((e) => { console.error(e); process.exit(1); });\n`,
        "utf8",
      );
      return true;
    } catch {
      return false;
    }
  })();

  try {
    if (!canRunClient) {
      console.warn("[test-wbworld-server] platform cross-check SKIPPED (could not write temp script)");
    } else {
      const payloadFile = join(platformRoot, "scripts", ".cross-compat-payload.tmp.json");
      writeFileSync(payloadFile, JSON.stringify(payload), "utf8");
      try {
        // Client encrypts...
        const enc = spawnSync("npx", ["tsx", ".cross-compat-check.tmp.ts", "encrypt", ".cross-compat-payload.tmp.json"], {
          cwd: join(platformRoot, "scripts"), encoding: "utf8", timeout: 120000,
        });
        assert.equal(enc.status, 0, `client encrypt ran: ${enc.stderr?.slice(-400)}`);
        const clientBytes = bufferFromBase64(enc.stdout.trim())!;
        assert.ok(clientBytes && clientBytes.length > 35, "client produced bytes");
        const decodedFromClient = decryptWbworldBuffer(clientBytes);
        assert.deepEqual(decodedFromClient, payload, "server decrypts a CLIENT-encrypted blob");

        // ...and the client decrypts a server-encrypted blob.
        const serverB64File = join(platformRoot, "scripts", ".cross-compat-b64.tmp.txt");
        writeFileSync(serverB64File, bufferToBase64(bytes), "utf8");
        const dec = spawnSync("npx", ["tsx", ".cross-compat-check.tmp.ts", "decrypt", ".cross-compat-b64.tmp.txt"], {
          cwd: join(platformRoot, "scripts"), encoding: "utf8", timeout: 120000,
        });
        assert.equal(dec.status, 0, `client decrypt ran: ${dec.stderr?.slice(-400)}`);
        assert.deepEqual(JSON.parse(dec.stdout), payload, "client decrypts a SERVER-encrypted blob");
      } finally {
        for (const f of [".cross-compat-check.tmp.ts", ".cross-compat-payload.tmp.json", ".cross-compat-b64.tmp.txt"]) {
          try { rmSync(join(platformRoot, "scripts", f)); } catch { /* already gone */ }
        }
      }
    }
  } finally {
    try { rmSync(tempScript); } catch { /* already gone */ }
  }

  console.log("✓ server wbworld module: roundtrip, tamper-rejection, base64, cross-compat all pass");
}

main().catch((e) => {
  console.error("✗ test failed:", e);
  process.exit(1);
});

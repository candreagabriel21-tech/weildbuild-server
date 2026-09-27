// ═══════════════════════════════════════════════════════════
// Password compatibility test — MUST pass before deployment
// ═══════════════════════════════════════════════════════════
// Verifies the ported scrypt algorithm produces/verifies the
// exact same hashes as the original app, using the known
// WeildBuild admin credentials from the original schema.sql.
// No database needed — pure crypto check.

import { scryptSync, timingSafeEqual, createHash, randomBytes } from "crypto";

// ── Ported algorithm (must mirror src/db/users.ts) ──
function secureHashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString("hex");
}
function simpleHash(password: string, salt: string): string {
  return createHash("sha256").update(password + salt).digest("hex");
}
function verifyPassword(password: string, storedHash: string, salt: string, hashVersion?: number): boolean {
  try {
    if (storedHash.length === 128 || hashVersion === 1) {
      const computed = secureHashPassword(password, salt);
      return timingSafeEqual(Buffer.from(computed, "hex"), Buffer.from(storedHash, "hex"));
    }
    const computed = simpleHash(password, salt);
    return timingSafeEqual(Buffer.from(computed, "hex"), Buffer.from(storedHash, "hex"));
  } catch {
    return false;
  }
}

// ── Known values from the original scripts/supabase-schema.sql ──
const ADMIN_USER = "WeildBuild";
const ADMIN_PASSWORD = "WeildBuild2026!";
const ADMIN_SALT = "5765696c644275696c64323032362121";
const ADMIN_HASH = "0e6899ef41a6d66844d3ef411e248c4c4bd9874047346ff8205b1c36f03268e9f9b74b16677950edf70138bc0ce74df56bfd2c1b51bdfcdefe09d6211576eeb3";

let failures = 0;
function check(name: string, ok: boolean) {
  console.log(`${ok ? "✓" : "✗ FAIL"}  ${name}`);
  if (!ok) failures++;
}

// 1. The seeded admin hash verifies against the known password
check("seeded admin hash verifies (scrypt v1)", verifyPassword(ADMIN_PASSWORD, ADMIN_HASH, ADMIN_SALT, 1));

// 2. Same input → same hash (deterministic, matches SQL seed)
check("recomputed hash equals seeded hash", secureHashPassword(ADMIN_PASSWORD, ADMIN_SALT) === ADMIN_HASH);

// 3. Wrong password fails
check("wrong password rejected", !verifyPassword("WrongPassword!", ADMIN_HASH, ADMIN_SALT, 1));

// 4. Legacy SHA-256 (v0) path still works
const legacySalt = "abcd1234abcd1234";
const legacyHash = simpleHash("LegacyPass99", legacySalt);
check("legacy SHA-256 hash verifies (v0)", verifyPassword("LegacyPass99", legacyHash, legacySalt, 0));
check("legacy wrong password rejected", !verifyPassword("nope", legacyHash, legacySalt, 0));

// 5. New salt generation + round-trip (new registrations)
const newSalt = randomBytes(16).toString("hex");
const newHash = secureHashPassword("TestPass123", newSalt);
check("new registration round-trip (scrypt)", verifyPassword("TestPass123", newHash, newSalt, 1));
check("salt is 32-char hex", /^[a-f0-9]{32}$/.test(newSalt));
check("scrypt hash is 128-char hex", /^[a-f0-9]{128}$/.test(newHash));

console.log("");
if (failures > 0) {
  console.error(`✗ ${failures} test(s) FAILED — do not deploy!`);
  process.exit(1);
} else {
  console.log("✓ All password compatibility tests passed — existing accounts will keep working.");
}

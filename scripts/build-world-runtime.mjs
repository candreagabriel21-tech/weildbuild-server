// ═══════════════════════════════════════════════════════════════════
// WeildBuild — world-runtime bundler (v1.2)
// ═══════════════════════════════════════════════════════════════════
// Bundles the server-authoritative game runtime into ONE self-contained
// Node file: dist/gamehost/world-runtime.bundle.js.
//
// Why a bundle: the runtime imports the PLATFORM's actual engine sources
// (studio-store, weildcode-engine, PhysicsWorld, character constants) so
// the server runs the SAME code the client runs - one source of truth,
// zero drift. tsc can't compile those files here, so esbuild follows the
// imports and inlines everything (zustand, cannon-es, three and all).
//
// STANDALONE BUILDS: the engine sources live in `server/engine/` (a synced
// copy of `platform/src/lib`). When the monorepo sibling `../platform`
// exists (dev machine), it is re-synced into `server/engine/` first, so
// local edits to the platform engine are always picked up. When the server
// folder is deployed ALONE (Render: server folder = repo root), the
// committed copy in `server/engine/` is used and nothing is overwritten.
//
// Run by `npm run build` (after tsc) and standalone via
// `node scripts/build-world-runtime.mjs`.

import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, "..");
const outFile = join(serverRoot, "dist", "gamehost", "world-runtime.bundle.js");

mkdirSync(dirname(outFile), { recursive: true });

// ── Step 1: refresh the vendored engine copy from the monorepo sibling ──
const platformLib = resolve(serverRoot, "..", "platform", "src", "lib");
const vendoredEngine = join(serverRoot, "engine");
if (existsSync(platformLib)) {
  rmSync(vendoredEngine, { recursive: true, force: true });
  cpSync(platformLib, vendoredEngine, { recursive: true });
  console.log("✓ synced engine/ from ../platform/src/lib (monorepo detected)");
} else {
  console.log("• no ../platform sibling - using the committed engine/ copy (standalone build)");
}
if (!existsSync(vendoredEngine)) {
  console.error("✗ engine/ is missing and no ../platform/src/lib to sync from");
  process.exit(1);
}

// ── Step 2: bundle ──
const result = await build({
  entryPoints: [join(serverRoot, "src", "gamehost", "runtime", "world-runtime.ts")],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  outfile: outFile,
  // node: builtins stay external automatically; everything else inlines.
  external: [],
  minify: false, // keep it debuggable - it runs game logic
  sourcemap: false,
  logLevel: "info",
  allowOverwrite: true,
});

if (!result || (result.errors && result.errors.length > 0)) {
  console.error("✗ world-runtime bundle failed");
  process.exit(1);
}
console.log(`✓ world-runtime bundle -> ${outFile}`);

// ═══════════════════════════════════════════════════════════════════
// WeildBuild — world-runtime bundler (v1.1)
// ═══════════════════════════════════════════════════════════════════
// Bundles the server-authoritative game runtime into ONE self-contained
// Node file: dist/gamehost/world-runtime.bundle.js.
//
// Why a bundle: the runtime imports the PLATFORM's actual engine sources
// (studio-store, weildcode-engine, PhysicsWorld, character constants) so
// the server runs the SAME code the client runs - one source of truth,
// zero drift. Those files live outside the server's tsc rootDir, so tsc
// can't compile them here; esbuild follows the relative imports into the
// platform folder and inlines everything (zustand, cannon-es and all).
//
// Run by `npm run build` (after tsc) and standalone via
// `node scripts/build-world-runtime.mjs`.

import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, "..");
const outFile = join(serverRoot, "dist", "gamehost", "world-runtime.bundle.js");

mkdirSync(dirname(outFile), { recursive: true });

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
  // The platform sources are TS with tsconfig path aliases (@/lib/...).
  // esbuild doesn't read tsconfig.json by default - point it there so the
  // aliases resolve.
  tsconfig: join(serverRoot, "..", "platform", "tsconfig.json"),
  // The runtime imports platform files via relative paths that cross the
  // package boundary - allowed explicitly.
  allowOverwrite: true,
});

if (!result || (result.errors && result.errors.length > 0)) {
  console.error("✗ world-runtime bundle failed");
  process.exit(1);
}
console.log(`✓ world-runtime bundle -> ${outFile}`);

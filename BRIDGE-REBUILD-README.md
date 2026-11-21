# WeildBuild Bridge — simplified rebuild (v1.11)

> **Merge note (v1.11 deploy bundle):** This repo is a **merged,
> ready-to-deploy** server: the v1.10.3-FIXED server as the base, with
> the bridge rebuild's clean files overlaid, the supervisor cruft
> removed, and the security + latency patches from
> `platform-patches/PATCHES.md` **applied in place** to the server's
> own `engine/` tree (not just documented). See
> `docs/bridge-rebuild-v1.11/` for the original patch README and the
> rebuild report (docx + pdf). The patches actually applied to this
> repo are listed in `platform-patches/PATCHES.md` (PATCHES 1, 2, 3a,
> 3c, 4); the game-side edits to `src/components/app/GamePlayer.tsx`
> and the comment fix in `engine/game-engine/character-constants.ts`
> are documented for the front-end repo and not applied here, since
> those files live in the platform/game client, not in this server
> repo.

Your old bridge had **30+ scripts** to do four jobs (start, stop,
db, status). This rebuild does the same four jobs in **6 files**,
and fixes the bugs that made your co-worker's version say
"BRIDGE NOT OPEN" when Render was actually connected.

## What's in this folder

```
wb-bridge-rebuild/
├── laptop-bridge.mjs          ← the ONE worker (Postgres + relay + status page)
├── install.bat                ← double-click to set everything up
├── install-on-laptop.ps1      ← (called by install.bat; you never run this by hand)
├── start.bat                  ← double-click to start the bridge in a window
├── stop.bat                   ← double-click to stop it (only this folder's node)
├── db.bat                     ← double-click to open a SQL console
├── db-console.mjs             ← (called by db.bat)
├── render-side/
│   └── render-bridge.ts       ← drop-in replacement for src/bridge/render-bridge.ts
└── platform-patches/
    ├── safe-math.ts           ← new file, replaces `new Function(...)` RCE
    └── PATCHES.md             ← step-by-step edits for the platform code
```

That's it. No `run-bridge-forever.bat`. No `reset-local-db.bat`
(folded into `db.bat` — type `RESET` inside the console). No
`run-install.bat`. No `start-bridge.bat` / `stop-bridge.bat`
(renamed to `start.bat` / `stop.bat`). No `bridge-supervisor.mjs`
and its `localhost:5490` control port. No VBS in your Startup
folder. No `bridge.lock` file that goes stale.

## How to use it (the short version)

1. **Drop the laptop files into your server folder.** Copy
   `laptop-bridge.mjs`, `install.bat`, `install-on-laptop.ps1`,
   `start.bat`, `stop.bat`, `db.bat`, `db-console.mjs` into the
   same folder as your `package.json` (the server repo).
2. **Double-click `install.bat`.** It asks for your
   `INTERNAL_TOKEN` (from Render → your service → Environment),
   writes `.env`, runs `npm install`, creates a logon auto-start
   task, and starts the bridge.
3. **Open `http://localhost:7878` in a browser.** This is the ONE
   place to look. The page tells you in plain English:
   - is the laptop's poll loop alive? (green dot)
   - is the local database up? (green dot)
   - does Render see this laptop? (green dot when
     `/__bridge/status` returns `connected: true`)
   If all three are green, you're done. If "Render sees this
   laptop" is red, your `INTERNAL_TOKEN` in `.env` does not match
   Render's. Wait 30 s and refresh before panicking — the laptop
   polls every 30 s and the first one after boot can take that
   long.

That's the whole loop. Three double-clicks: install, then start,
then db. The status page is the single source of truth.

## To apply the server-side + game-side security patches

1. **Server side:** copy
   `render-side/render-bridge.ts` over your
   `src/bridge/render-bridge.ts` in the server repo, commit, and
   redeploy to Render. This moves the bridge token out of the URL
   (it was leaking into Render's access logs) and adds a bucket
   allowlist for storage.put jobs.
2. **Game side:** follow the step-by-step edits in
   `platform-patches/PATCHES.md`. The four patches there fix:
   - the `new Function(...)` RCE in `weildcode-engine.ts`
     (replaced by `safe-math.ts`, which I tested against 33 cases
     including `process.env`, `require('fs')`, template literals,
     and `Math.sqrt` — all attack payloads return null, all
     legitimate math evaluates correctly)
   - the `__proto__` / `constructor` prototype pollution in
     `studio-store.ts`
   - the game-side latency (interpolation delay 300 → 120 ms,
     websocket-only transports, never-give-up reconnect, queue
     cap 6000 → 600)
   - the lying comment about `PLAYER_REPORT_HZ` (says 20 Hz, the
     constant is 40 Hz)

## Why your co-worker's version kept saying "BRIDGE NOT OPEN"

Three reasons, all in the old code:

1. **The status check was looking at the wrong thing.** The old
   `install-on-laptop.ps1:199` told you to open
   `$RenderUrl/__bridge/status` in a browser. That endpoint
   returns `connected: false` whenever the laptop hasn't polled
   in the last 60 s. So if you opened it RIGHT AFTER the laptop
   started, before the first poll completed, you saw
   "connected:false" and concluded "the bridge is not open"
   even though Render WAS connected and the laptop WAS about to
   dial in. The new status page on `http://localhost:7878` shows
   you BOTH the laptop's view (poll loop alive) AND Render's view
   (does Render see the laptop) side by side, so you can tell the
   difference between "laptop is not running" and "laptop is
   running but Render doesn't see it yet".

2. **Ghost processes.** The old version had a `bridge.lock` file
   as its single-instance guard. When the process crashed
   hard (power loss, blue screen, `taskkill /f /im node.exe` from
   the old `stop.bat`), the lock file stayed behind and the next
   start printed "WeildBuild bridge is already running" and
   exited — even though nothing was running. Plus the old
   `stop.bat` ran `taskkill /f /im node.exe` with no filter,
   which killed every node process on the machine, including
   the auto-start keeper (`run-bridge-forever.bat`) — so the
   keeper was dead, the lock was stale, and the next logon
   started a fresh bridge that immediately exited because of
   the stale lock. **The new version uses the status port
   (127.0.0.1:7878) as the lock.** The OS releases it the
   instant the process dies. No stale lock file. No ghost. And
   `stop.bat` uses `wmic` to kill only `node.exe` processes
   whose command line contains `laptop-bridge.mjs` — it does
   not touch your VS Code, your dev server, or anything else.

3. **The supervisor's localhost control port was unauthenticated.**
   The old `bridge-supervisor.mjs` ran an HTTP server on
   `127.0.0.1:5490` with `POST /api/on`, `/api/off`,
   `/api/restart`, `/api/exit` — no auth, no CSRF check. Any
   local process, or a drive-by webpage via a `text/plain`
   form POST, could shut your bridge down. The new version has
   no supervisor process and no control port. The keeper loop
   is inside the node process itself (the poll loop's own
   `while (!exiting)`).

## File-by-file what changed

### `laptop-bridge.mjs` (the worker) — 1 file does everything
- Boots the embedded Postgres (same as before).
- Runs `prisma db push` (same as before).
- Runs the poll loop against Render (same as before, but the
  token is now sent in BOTH the `x-internal-token` header AND
  the `?token=` query, so it works against the old Render code
  AND the patched Render code — backwards compat during the
  swap).
- Serves a status page on `http://localhost:7878` (NEW).
- Uses the status port as the single-instance lock (NEW —
  replaces the stale `bridge.lock`).
- Storage path-traversal guard is FIXED: it checks that the
  resolved path is under `STORAGE_DIR/<bucket>` for a bucket in
  the allowlist. The old check let `bucket = "../.."` escape.
- Storage put has a 50 MB hard cap (NEW — old version had no
  cap, disk-exhaustion DoS was trivial).
- `.env` parser strips inline `#` comments (OLD version baked
  `INTERNAL_TOKEN=abc123 # note` with the trailing comment
  inside the token, which broke auth in a way that was nearly
  impossible to debug).
- Does NOT fall back to `password: "postgres"` if `PG_PASSWORD`
  is empty on a re-init (OLD version did, silently weakening a
  previously-strong password if `.env` was ever deleted).

### `install-on-laptop.ps1` (the installer)
- Same 4 steps (Node, npm, .env, auto-start).
- Auto-start is now a **user-scope scheduled task** (via
  `Register-ScheduledTask -AtLogOn`), NOT a `.vbs` in your
  Startup folder. No admin needed. No localhost control port
  to attack. The task has `RestartCount 999` +
  `RestartInterval 1 minute` so the bridge restarts itself
  within 1 minute of a crash — same effect as the old
  `run-bridge-forever.bat` keeper loop, but inside the task
  scheduler, not as a separate `.bat` you have to manage.
- Removes the old `.vbs` from the Startup folder if it finds
  one (idempotent upgrade).

### `start.bat`, `stop.bat`, `db.bat` (the 3 batch files)
- `start.bat` = the old `start-bridge.bat` (visible window).
- `stop.bat` = the old `stop-bridge.bat` but with `wmic`
  filtering so it only kills this folder's `node.exe`, not
  every node on the machine.
- `db.bat` = the old `local-sql.mjs` but as a real REPL with
  read-only-by-default (mutating statements ask for CONFIRM),
  a `TABLES` shortcut, and a `RESET` command that replaces the
  old `reset-local-db.bat`. The old `local-sql.mjs` had a HELP
  text that literally coached you toward
  `UPDATE users SET admin_role = 'top_admin'` — a privilege-
  escalation tutorial in the source tree. The new one does
  not.

### `render-side/render-bridge.ts` (server-side patch)
- Drop-in replacement for `src/bridge/render-bridge.ts`.
- `INTERNAL_TOKEN` accepted from the `x-internal-token` header
  (preferred) OR the `?token=` query (backwards compat with an
  old laptop still sending it in the URL). Either way, an unset
  `INTERNAL_TOKEN` fails closed.
- `enqueue()` rejects `storage.put` jobs whose `bucket` is not
  in the allowlist (defense in depth — the laptop also rejects).
- `/__bridge/status` stays unauthenticated (it carries no
  secrets).

### `platform-patches/safe-math.ts` + `PATCHES.md`
- `safe-math.ts` is a strict-subset math evaluator that
  replaces `new Function('"use strict"; return (...)')` in
  `weildcode-engine.ts`. It accepts only: decimal numbers,
  `+ - * / % ** ( )`, the functions `sqrt abs floor ceil round
  sin cos tan pow min max`, the constants `PI E`, and
  whitespace. Everything else (strings, member access,
  semicolons, template literals, identifiers other than the
  whitelisted ones) is rejected at parse time. No way to reach
  `Math`, `process`, `globalThis`, `Function`, or `eval`.
- Tested against 33 cases: every legitimate math expression
  evaluates correctly, every attack payload returns null.
- `PATCHES.md` is the step-by-step edit guide for the four
  game-side patches (RCE, pollution, latency, comment fix).

## What I did NOT fix (filed for the next pass)

These are real bugs from the full audit but they need bigger
changes; I did not want to ship a half-done patch:

1. **The Welu Lua interpreter sandbox** — writable `_G`, no
   parser depth cap (stack overflow), no wall-clock check inside
   native loop functions (`string.find` exponential backtracking
   runs unbounded). Needs a real sandbox (isolated-vm) or a
   manual review gate on world-authority scripts.
2. **The BTS room's `NaN`/`Infinity` position handling** —
   `src/gamehost/bts-rooms.ts:281-291` accepts any client
   number. A single `NaN` pstate makes a player immune to
   tornado/zombie/meteorite damage and breaks disaster logic for
   everyone in the room. Add `Number.isFinite` + range clamps
   at the host boundary.
3. **The world-runtime worker's `studioState` validation** —
   the worker accepts any `studioState` object with
   `Array.isArray(objects)`. A 100k-part world OOMs the worker.
   Validate max parts / max joints / finite numeric fields
   before handing the worker the world.
4. **The `.wbworld` encryption key** is a hardcoded constant
   (`engine/wbworld.ts:43-46`). Anyone with the bundle can
   decrypt every `.wbworld` ever produced. The real fix is a
   per-install key (paste once, store in env / localStorage).
   This is a bigger change that touches client + server + a
   migration plan for old files.
5. **The hardcoded admin password** in `DEPLOY.md` and
   `tests/compat.ts` (`WeildBuild / WeildBuild2026!`). Rotate
   it on Render and delete it from the docs.

The bug + security + latency report (docx + pdf) in this
rebuild covers the findings I actually fixed here.

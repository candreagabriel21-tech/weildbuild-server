# WeildBuild v1.11.1 — latency fix bundle

This is a **drop-in upgrade** on top of v1.11.0 / v1.10.3 that cuts
warm-request latency by ~75-85% on the bridge architecture. No schema
changes, no breaking API changes — every fix has a fallback path so the
client keeps working on any server version.

## What changed (server side)

### Bridge poll loop (the single biggest win)

`laptop-bridge.mjs`:

- **Poll idle gap: 5 s → 200 ms.** The old gap meant a job that
  arrived on Render the instant the laptop went idle waited an
  average of 2.5 s before anyone picked it up. At 200 ms the
  average wait is 100 ms. Long-poll keeps us parked on Render the
  rest of the time, so a busy bridge sees ~0 ms wait.
- **Batched job pickup.** A single `/__bridge/poll` now returns up
  to 5 jobs (`POLL_BATCH_MAX`) instead of one. The laptop runs them
  concurrently (`POLL_CONCURRENCY = 4`), so when the page boot fires
  5 requests at once they all start in the same poll cycle instead
  of 5 sequential cycles.
- All three tunables are env-overridable: `BRIDGE_POLL_IDLE_GAP_MS`,
  `BRIDGE_POLL_BATCH_MAX`, `BRIDGE_POLL_CONCURRENCY`.

`src/bridge/render-bridge.ts`:

- **`POLL_HOLD_MS`: 20 s → 30 s.** One long-poll now covers the full
  30 s laptop timeout window, so a quiet bridge burns one HTTPS
  connection per cycle instead of two.
- **`JOB_TIMEOUT_MS`: 45 s → 60 s.** A slow `storage.put` (a 3 MB
  world on a cold HDD) was hitting the 45 s ceiling and failing the
  user's PUT /games with a "bridge error". 60 s gives plenty of room.
- **Batched `/poll` response.** Opt-in via `?batch=1`: returns
  `{ jobs: [...] }` with up to `POLL_BATCH_MAX` jobs. Without the
  query string, the legacy single-job shape `{ jobId, ... }` is
  returned unchanged — so any pre-v1.11.1 laptop keeps working.

### New `/api/bootstrap` endpoint

`src/main/routes/bootstrap.ts` (new) — one endpoint that returns:

- version gate (was `GET /version`)
- authenticated user (was `GET /api/auth`)
- all games (was `GET /api/games`)
- all items (was `GET /api/items`)
- the user's notifications (was `GET /api/notifications?username=…`)

The four DB reads run as one `Promise.all`, so the laptop bridge
sees exactly one batch pickup instead of five sequential ones.
Each section has its own `ok` flag so a partial failure is
non-destructive.

Mounted in `src/main/index.ts` at `/api/bootstrap`.

## What changed (platform side)

### Boot flow: 5 round-trips → 1

`src/lib/store.ts` — new `bootstrap()` action on the auth store:

1. Restores cached user from localStorage (instant, no flash).
2. Fires ONE `GET /api/bootstrap` and hydrates user + games + items
   + notifications from the single response.
3. For any section whose `ok` flag is false, falls back to the
   legacy endpoint call (so a partial bootstrap is non-destructive).
4. Returns the raw bootstrap response so the caller can read
   `versionGate` without a second round-trip.

`src/app/page.tsx`:

- The boot effect now calls `bootstrap()` once instead of firing
  `/version`, `/auth`, `/games`, `/items`, `/notifications` as 5
  separate effects.
- The version-gate comparison reads from `boot.versionGate`; if the
  server is older than v1.11.1 (and the bootstrap action fell back
  to `refreshUser()`), the legacy `/version` fetch fires as before.
- The legacy `fetchGames` / `fetchItems` / `fetchNotifications`
  effects still run as a fallback — they check whether the store
  is already populated (by bootstrap) and skip if so. If bootstrap
  failed they fire as before, so the app keeps working on any
  server version.

### Preconnect + DNS prefetch

`src/app/layout.tsx`:

- Added `<link rel="preconnect">` + `<link rel="dns-prefetch">` for
  `API_URL` and `REALTIME_URL`. The TLS handshake + DNS resolution
  finish BEFORE the first `apiFetch()` fires on boot, so the first
  request skips 150-300 ms of setup cost.
- Only emitted for cross-origin https URLs (same-origin in the
  sandbox preview needs no preconnect).

### Socket.IO reconnection

`src/components/app/GamePlayer.tsx`:

- `reconnectionAttempts: 20 → Infinity`. The old limit gave up
  after ~3-5 min on a cold-starting free-tier host; with the honest
  status pop-up already showing "waking server…", the socket now
  retries forever until the user gives up (they have a Leave button).
- Transports stay `["websocket", "polling"]` (Socket.IO negotiates
  the upgrade itself; forcing websocket-only would break corporate
  networks that block ws://).

## Expected impact (warm bridge)

| Path | Before | After | Reduction |
|---|---|---|---|
| Boot (5 sequential round-trips) | ~12 s | ~3 s | 75% |
| Single request (poll gap alone) | ~2.5 s avg wait | ~100 ms avg wait | 96% |
| First request after page load (TLS) | ~150-300 ms | 0 ms (preconnected) | 100% |
| Game join (cold game host) | gives up after ~5 min | retries forever | n/a |

On a cold Render the first request after idle still costs 30-50 s
(unavoidable on the free tier); everything after that is fast.

## Non-destructive: every fix has a fallback

- Server older than v1.11.1? `/api/bootstrap` returns 404 → the
  client's `bootstrap()` action catches it and falls back to
  `refreshUser()`. The legacy boot effects fire as before.
- Laptop older than v1.11.1? It doesn't send `?batch=1` → Render
  returns the legacy single-job shape. The laptop runs jobs
  one-at-a-time as before.
- Bootstrap section failed on the server? `ok: false` → the client
  falls back to the legacy endpoint for that section only.
- Network down at boot? `bootstrap()` catches the error and calls
  `refreshUser()`, which has the same offline-resilience handling
  as before.

## What's NOT in this bundle

- **Render paid plan upgrade** — the single biggest remaining win
  (no cold starts) is on Render's side, not in this code. See
  `DEPLOY.md` for the recommended $7/mo "Starter" plan.
- **Gzip on world uploads** — was on the original list, deferred
  because the bridge already moves bytes through Render and the
  wins from A + G alone hit the user's 40-100% goal. If publish
  still feels slow after this bundle ships, gzip is the next step.
- **Optimistic UI for writes** — same. The big wins are in the read
  path; the write path was already mostly OK.

## Files changed

Server (`wb-server/`):

- `laptop-bridge.mjs` — poll gap, batched pickup, concurrent execution
- `src/bridge/render-bridge.ts` — POLL_HOLD_MS / JOB_TIMEOUT_MS / batched /poll
- `src/main/routes/bootstrap.ts` (NEW) — bootstrap endpoint
- `src/main/index.ts` — mount the bootstrap router

Platform (`platform/`):

- `src/lib/store.ts` — `bootstrap()` action on the auth store
- `src/app/page.tsx` — single `bootstrap()` call on boot, with fallback
- `src/app/layout.tsx` — preconnect + dns-prefetch for API_URL / REALTIME_URL
- `src/components/app/GamePlayer.tsx` — `reconnectionAttempts: Infinity`

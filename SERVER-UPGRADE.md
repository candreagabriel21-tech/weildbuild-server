# WeildBuild Server v1.4.8 - Upgrade Notes

Deploy this over the current v1.4.7 exactly like a normal Render deploy
(same env vars, same services: Main, Realtime, Game Host). **No new env
vars, no migration, no seed** - just deploy.

If you are coming from v1.4.6 or older, read the v1.4.7 section at the
bottom first (ONE env var on Main: `REALTIME_SERVER_URL`).

## What changed (v1.4.8)

**The web app is allowed in.** Any `https://*.vercel.app` origin (plus
`*.vercel.dev` previews) now passes CORS and the mutating-request origin
check on both Main and Realtime. This is what lets the Vercel-hosted
website/webapp (`VERCEL-DEPLOY.md` in the game zip) talk to the servers:
accounts, games, chat, multiplayer, everything.

- Same trust model as the always-allowed localhost origins: the session
  cookie is `SameSite=Lax` (browsers never send it cross-site), so a
  page on another origin cannot act as anyone - the web app
  authenticates with the `X-Session-Token` header, which only our own
  client ever holds.
- Custom domains (e.g. `play.weildbuild.com`) still go through the
  `ALLOWED_ORIGINS` env var as before.
- Nothing else changed - no schema, no seed, no new endpoints.

## Client that goes with it

`WeildBuild-dev-1.0.0-r5.zip` (also the Vercel web app source). Its new
features:

- Tiny in-app notification pop-ups + OS-level desktop notifications for
  new DMs / friend events (works on any server; the socket push is
  realtime, no server change needed).
- Session heartbeat: bans/sign-outs detected within ~20s WITHOUT a
  refresh. On v1.4.7+ servers bans also arrive instantly via the
  realtime push; on older servers the heartbeat is the fallback path.
- The character edge-of-block physics fix and the icon fixes (client
  side only).

The client works fine against v1.4.7 servers too (minus the web-app
origins) - but the Vercel site needs THIS version.

## Deploy checklist

1. Deploy **all three services** from `weildbuild-server-v1.4.8.zip`
   (they share the codebase; Main + Realtime are the ones that matter).
2. Confirm `https://<your-site>.vercel.app` loads and can log in.
3. Done.

---

# v1.4.7 (if you are skipping from v1.4.6)

## ONE new env var on the MAIN service (for the instant pop-ups)

`REALTIME_SERVER_URL` = the public URL of your Realtime service
(e.g. `https://weildbuild-realtime.onrender.com`).

The moment an admin warns or bans a player, Main pushes the event to
Realtime and the pop-up lands on the player's open app INSTANTLY (plus
banned sockets are force-disconnected). Without this env var, moderation
still fully works - players just see the pop-up on their next login
instead of the instant push.

The endpoint is protected by the same `INTERNAL_TOKEN` you already set
on Main (Realtime checks it). No database changes, no migration, no
seed needed - just deploy both services (Main AND Realtime must both
run v1.4.7+).

## What changed (v1.4.7)

1. **Instant moderation push (Main + Realtime)**
   - Main: after a warn/ban is saved, it POSTs to
     `REALTIME_SERVER_URL/internal/moderation` (fire-and-forget with the
     internal token; a Realtime hiccup never fails the moderation
     action itself).
   - Realtime: new authenticated endpoint that relays
     `moderation:warning` / `moderation:banned` to the player's open
     socket, and force-disconnects every socket of a banned player
     half a second later (after the event flushes).
   - The v1.4.7+ client turns these into the full-screen warning/ban
     pop-ups. Older clients simply ignore the new events.

2. **No schema changes, no seed changes** - `npm run migrate` is
   harmless as always but not required for this update.

## Compatibility

- Old client + new server: everything works; the new server just also
  accepts web-app origins and (with `REALTIME_SERVER_URL` set) pushes
  moderation events that old clients ignore.
- New client + old server: everything works except the Vercel web app
  (origins rejected); moderation arrives via the heartbeat fallback
  (within ~20s) instead of instantly.

# WeildBuild Server v1.4.7 - Upgrade Notes

Deploy this over the current v1.4.6 exactly like a normal Render deploy
(same env vars, same services: Main, Realtime, Game Host).

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
seed needed this time - just deploy both services (Main AND Realtime
must both run v1.4.7).

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
   - The v1.4.7 client turns these into the full-screen warning/ban
     pop-ups. Older clients simply ignore the new events.

2. **No schema changes, no seed changes** - `npm run migrate` is
   harmless as always but not required for this update.

## Compatibility

- Client 1.0.0 r4 (dev folder) uses the instant pop-ups; older clients
  keep working exactly as before.
- Game Host services do NOT need redeploying for this feature (Main and
  Realtime are the only services involved), but updating them too keeps
  the /health versions honest.
- No changes to any other env vars, URLs, or the Render service layout.

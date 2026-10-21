# WeildBuild Server v1.4.5 - Upgrade Notes

Deploy this over the current v1.4.4 exactly like a normal Render deploy
(same env vars, same services: Main, Realtime, Game Host).

## ONE required step after deploying: run the migration

The new version adds a `sent_requests` column to the users table (it tracks
OUTGOING friend requests so the client can tell incoming and outgoing
apart). The column is additive with a default - no data changes, no
downtime. Run once from the server repo:

```bash
npm install
npm run migrate     # prisma db push - adds the sent_requests column
```

If your deploy pipeline already runs `prisma migrate deploy` / `db push`,
it's covered automatically. The server works without the column too (it
just writes nothing), but friend-request direction in the clients only
fully works once the column exists.

## What changed (v1.4.5)

1. **Friend system direction fix**
   - `sendFriendRequest` maintains `sent_requests` on the sender (mirrors
     `friend_requests` on the target) in every path: normal send, mutual
     auto-accept, cancel, decline, accept, block.
   - `GET /friends?username=` now also returns `sent_requests`.
   - `POST /friends action=cancel` now returns the refreshed user, so the
     client's Sent list updates immediately.
   - The user API shape gains `sent_requests` (defaults to `[]` on old rows).

2. **Multiplayer body-animation relay**
   - `game:move` accepts an optional `anim` record (walking / jumping /
     dying / sprint booleans), sanitizes it, stores it on the player and
     relays it in `game:playerMoved` and `game:players`.
   - Purely additive: older clients that don't send `anim` keep working;
     newer clients fall back to the old inference when it's absent.

## Compatibility

- Clients 1.0.0+ use the new fields; older shipped clients (1.0.x) ignore
  them - no forced update needed.
- Database: one additive column (`users.sent_requests`).
- No changes to env vars, URLs, or the Render service layout.

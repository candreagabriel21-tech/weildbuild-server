#!/bin/bash
# ═══════════════════════════════════════════════════════════
# WeildBuild v1.4.1 smoke test, single invocation
# (sandbox kills background processes between calls, so pg +
#  all three services + every curl check run in THIS one call)
# Covers: health, admin moderation (warn/ban/unban + rails),
# game delete + rename fix, and the SLEEPING-HOST WAKE FIX.
# ═══════════════════════════════════════════════════════════
set -u
cd "$(dirname "$0")/.."

export DATABASE_URL="postgresql://postgres:postgres@localhost:5433/weildbuild"
export AUTH_SECRET="smoke-test-secret-0123456789abcdef0123456789abcdef"
export INTERNAL_TOKEN="smoke-internal-token"
export HOST_PUBLIC_URL="http://localhost:3004"
export MAIN_SERVER_URL="http://localhost:8000"

PASS=0; FAIL=0
check() { # name, expected_substr, actual
  if echo "$3" | grep -q "$2"; then PASS=$((PASS+1)); echo "  OK  $1";
  else FAIL=$((FAIL+1)); echo "  XX  $1, wanted [$2] got: $(echo "$3" | head -c 220)"; fi
}
checknot() { # name, forbidden_substr, actual
  if echo "$3" | grep -q "$2"; then FAIL=$((FAIL+1)); echo "  XX  $1, must NOT contain [$2] got: $(echo "$3" | head -c 220)";
  else PASS=$((PASS+1)); echo "  OK  $1"; fi
}

echo "── 0. Postgres ──"
node scripts/start-pg.mjs > /tmp/pg.log 2>&1 &
PG_PID=$!
for i in $(seq 1 60); do grep -q "PG-READY" /tmp/pg.log 2>/dev/null && break; sleep 1; done
grep -q "PG-READY" /tmp/pg.log || { echo "pg failed"; tail -5 /tmp/pg.log; exit 1; }
echo "  OK  postgres up on :5433"

echo "── 1. Migrate + seed ──"
npx prisma db push --skip-generate --force-reset > /tmp/mig.log 2>&1 && echo "  OK  schema pushed" || { echo "  XX  migrate failed"; tail -5 /tmp/mig.log; exit 1; }
npx tsx prisma/seed.ts > /tmp/seed.log 2>&1 && echo "  OK  seeded (top_admin)" || { echo "  XX  seed failed"; tail -5 /tmp/seed.log; exit 1; }

echo "── 2. Boot services ──"
node dist/main/index.js > /tmp/main.log 2>&1 &
MAIN_PID=$!
PORT=3003 node dist/realtime/index.js > /tmp/rt.log 2>&1 &
RT_PID=$!
PORT=3004 node dist/gamehost/index.js > /tmp/gh.log 2>&1 &
GH_PID=$!
for i in $(seq 1 30); do curl -s -o /dev/null http://localhost:8000/health && break; sleep 1; done
curl -s -o /dev/null http://localhost:8000/health || { echo "main never came up"; tail -10 /tmp/main.log; exit 1; }

# Wait for the gamehost to register with Main (it retries every 15s, the
# first attempt can race main's boot, exactly like on a Render cold start)
for i in $(seq 1 45); do grep -q "registered with Main Server" /tmp/gh.log 2>/dev/null && break; sleep 1; done
grep -q "registered with Main Server" /tmp/gh.log && echo "  OK  gamehost registered" || { echo "  XX  gamehost never registered"; tail -5 /tmp/gh.log; exit 1; }

echo "── 3. Health + version ──"
# Version is read from package.json so this check never drifts again
# (it used to hardcode "1.4.1" and broke on every release bump).
SERVER_VERSION=$(node -e "console.log(require('./package.json').version)")
check "main health reports server version" "\"version\":\"$SERVER_VERSION\"" "$(curl -s http://localhost:8000/health)"
check "gamehost health" 'weildbuild-gamehost' "$(curl -s http://localhost:3004/health)"

echo "── 4. Logins ──"
ADMIN_TOKEN=$(curl -s -X POST http://localhost:8000/api/auth -H "Content-Type: application/json" \
  -d '{"action":"login","username":"WeildBuild","password":"WeildBuild2026!"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).sessionToken||''))")
[ -n "$ADMIN_TOKEN" ] && echo "  OK  admin login" || { echo "  XX  admin login failed"; exit 1; }
REG=$(curl -s -X POST http://localhost:8000/api/auth -H "Content-Type: application/json" -d '{"action":"register","username":"Victim1","password":"testpass123"}')
check "victim registered" '"success":true' "$REG"
V_TOKEN=$(echo "$REG" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).sessionToken||''))")
REG2=$(curl -s -X POST http://localhost:8000/api/auth -H "Content-Type: application/json" -d '{"action":"register","username":"Stranger1","password":"testpass123"}')
S_TOKEN=$(echo "$REG2" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).sessionToken||''))")
[ -n "$V_TOKEN" ] && [ -n "$S_TOKEN" ] && echo "  OK  victim + stranger tokens" || { echo "  XX  register failed"; exit 1; }

echo "── 5. GET /admin/users ──"
check "no token -> 401" '"error"' "$(curl -s http://localhost:8000/api/admin/users)"
check "player -> 403" 'error' "$(curl -s http://localhost:8000/api/admin/users -H "X-Session-Token: $V_TOKEN")"
LIST=$(curl -s "http://localhost:8000/api/admin/users" -H "X-Session-Token: $ADMIN_TOKEN")
check "list works" 'Victim1' "$LIST"
check "row shape: warnings field" '"warnings":0' "$LIST"
check "row shape: last_login field" 'last_login' "$LIST"
SEARCH=$(curl -s "http://localhost:8000/api/admin/users?search=vict" -H "X-Session-Token: $ADMIN_TOKEN")
check "search finds victim" 'Victim1' "$SEARCH"
checknot "search excludes others" 'Stranger1' "$SEARCH"

echo "── 6. POST /admin/moderate: WARN ──"
WARN=$(curl -s -X POST http://localhost:8000/api/admin/moderate -H "Content-Type: application/json" -H "X-Session-Token: $ADMIN_TOKEN" -d '{"action":"warn","username":"Victim1","message":"Watch the language!"}')
check "warn ok + counter" '"warnings":1' "$WARN"
NOTIF=$(curl -s "http://localhost:8000/api/notifications?username=Victim1" -H "X-Session-Token: $V_TOKEN")
check "warning notification delivered" 'Watch the language' "$NOTIF"
check "listing shows warnings:1" '"warnings":1' "$(curl -s "http://localhost:8000/api/admin/users?search=Victim1" -H "X-Session-Token: $ADMIN_TOKEN")"

echo "── 7. Moderation rails ──"
check "self-moderation blocked" 'cannot moderate yourself' "$(curl -s -X POST http://localhost:8000/api/admin/moderate -H "Content-Type: application/json" -H "X-Session-Token: $ADMIN_TOKEN" -d '{"action":"warn","username":"WeildBuild"}')"
check "ban requires reason" 'reason is required' "$(curl -s -X POST http://localhost:8000/api/admin/moderate -H "Content-Type: application/json" -H "X-Session-Token: $ADMIN_TOKEN" -d '{"action":"ban","username":"Victim1"}')"
check "player cannot moderate" 'error' "$(curl -s -X POST http://localhost:8000/api/admin/moderate -H "Content-Type: application/json" -H "X-Session-Token: $V_TOKEN" -d '{"action":"warn","username":"Stranger1"}')"

echo "── 8. BAN flow ──"
BAN=$(curl -s -X POST http://localhost:8000/api/admin/moderate -H "Content-Type: application/json" -H "X-Session-Token: $ADMIN_TOKEN" -d '{"action":"ban","username":"Victim1","reason":"Testing bans"}')
check "ban ok" '"is_banned":true' "$BAN"
BANNED_LOGIN=$(curl -s -X POST http://localhost:8000/api/auth -H "Content-Type: application/json" -d '{"action":"login","username":"Victim1","password":"testpass123"}')
check "login blocked with reason" 'Account is banned: Testing bans' "$BANNED_LOGIN"
check "old session instantly dead" '"authenticated":false' "$(curl -s http://localhost:8000/api/auth -H "X-Session-Token: $V_TOKEN")"
check "listing shows banned" '"is_banned":true' "$(curl -s "http://localhost:8000/api/admin/users?search=Victim1" -H "X-Session-Token: $ADMIN_TOKEN")"

echo "── 9. UNBAN flow ──"
UNBAN=$(curl -s -X POST http://localhost:8000/api/admin/moderate -H "Content-Type: application/json" -H "X-Session-Token: $ADMIN_TOKEN" -d '{"action":"unban","username":"Victim1"}')
check "unban ok" '"is_banned":false' "$UNBAN"
RELOGIN=$(curl -s -X POST http://localhost:8000/api/auth -H "Content-Type: application/json" -d '{"action":"login","username":"Victim1","password":"testpass123"}')
check "relogin works" '"success":true' "$RELOGIN"
# ban wiped ALL of Victim1's sessions - capture the FRESH token for later steps
V_TOKEN=$(echo "$RELOGIN" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).sessionToken||''))")

echo "── 10. Game delete ──"
CREATE=$(curl -s -X POST http://localhost:8000/api/games -H "Content-Type: application/json" -H "X-Session-Token: $V_TOKEN" -d '{"name":"DeleteMe","description":"del","public":true}')
GAME_ID=$(echo "$CREATE" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).id||''))")
[ -n "$GAME_ID" ] && echo "  OK  game created ($GAME_ID)" || { echo "  XX  create failed: $CREATE"; exit 1; }
check "stranger cannot delete" 'only delete your own' "$(curl -s -X DELETE "http://localhost:8000/api/games?id=$GAME_ID" -H "X-Session-Token: $S_TOKEN")"
check "creator deletes" '"success":true' "$(curl -s -X DELETE "http://localhost:8000/api/games?id=$GAME_ID" -H "X-Session-Token: $V_TOKEN")"
check "game is gone" '"error":"Game not found"' "$(curl -s "http://localhost:8000/api/games?id=$GAME_ID")"

echo "── 11. Rename fix ──"
CREATE2=$(curl -s -X POST http://localhost:8000/api/games -H "Content-Type: application/json" -H "X-Session-Token: $V_TOKEN" -d '{"name":"OldName","description":"r","public":true}')
G2=$(echo "$CREATE2" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).id||''))")
REN=$(curl -s -X PUT http://localhost:8000/api/games -H "Content-Type: application/json" -H "X-Session-Token: $V_TOKEN" -d "{\"id\":\"$G2\",\"name\":\"NewName\"}")
check "rename response shows new name" '"name":"NewName"' "$REN"
check "re-read shows new name" '"name":"NewName"' "$(curl -s "http://localhost:8000/api/games?id=$G2")"
# legacy poisoned row: inject a stale name copy into extra_data, then read + update
npx tsx -e "
import { prisma } from './src/db/client';
async function main() {
  const row = await prisma.game.findUnique({ where: { id: '$G2' } });
  const extras = { ...(row!.extraData as any), name: 'OldName' };
  await prisma.game.update({ where: { id: '$G2' }, data: { extraData: extras as any } });
  console.log('POISONED');
}
main();
" | grep -q POISONED && echo "  OK  legacy row poisoned" || echo "  XX  poison failed"
check "legacy poisoned row: column wins" '"name":"NewName"' "$(curl -s "http://localhost:8000/api/games?id=$G2")"
UPD=$(curl -s -X PUT http://localhost:8000/api/games -H "Content-Type: application/json" -H "X-Session-Token: $V_TOKEN" -d "{\"id\":\"$G2\",\"description\":\"cleaned\"}")
check "update ok after poison" '"description":"cleaned"' "$UPD"
CLEAN=$(npx tsx -e "
import { prisma } from './src/db/client';
async function main() {
  const row = await prisma.game.findUnique({ where: { id: '$G2' } });
  console.log('STALE_NAME_IN_EXTRAS=' + String('name' in ((row!.extraData as any) || {})));
}
main();
")
check "stale copy purged from extras" 'STALE_NAME_IN_EXTRAS=false' "$CLEAN"

echo "── 12. SLEEPING-HOST WAKE FIX (the server-offline bug) ──"
# Register + heartbeat happened at boot. Simulate the host going to sleep:
# heartbeat older than HOST_STALE_MS (60s) + status offline, exactly what
# sweepStale leaves behind after 15 idle minutes on Render free tier.
npx tsx -e "
import { prisma } from './src/db/client';
async function main() {
  await prisma.serverHost.updateMany({ data: { status: 'offline', lastHeartbeat: new Date(Date.now() - 5 * 60 * 1000) } });
  console.log('HOST-ASLEEP');
}
main();
" | grep -q HOST-ASLEEP && echo "  OK  host put to sleep" || echo "  XX  sleep simulation failed"
CREATE3=$(curl -s -X POST http://localhost:8000/api/games -H "Content-Type: application/json" -H "X-Session-Token: $V_TOKEN" -d '{"name":"WakeTest","description":"w","public":true}')
G3=$(echo "$CREATE3" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).id||''))")
JOIN=$(curl -s -X POST http://localhost:8000/api/instances/join -H "Content-Type: application/json" -H "X-Session-Token: $V_TOKEN" -d "{\"gameId\":\"$G3\"}")
checknot "old bug gone: no 'No game servers online'" 'No game servers are currently online' "$JOIN"
check "join placement returned (host woken!)" '"instanceId"' "$JOIN"
check "socketUrl points at gamehost" 'localhost:3004' "$JOIN"
WOKEN=$(npx tsx -e "
import { prisma } from './src/db/client';
async function main() {
  const h = await prisma.serverHost.findFirst();
  console.log('STATUS=' + h!.status);
}
main();
")
check "host row back online" 'STATUS=online' "$WOKEN"

echo "── 13. Second join fills the SAME instance (no double-wake) ──"
JOIN2=$(curl -s -X POST http://localhost:8000/api/instances/join -H "Content-Type: application/json" -H "X-Session-Token: $S_TOKEN" -d "{\"gameId\":\"$G3\"}")
check "second join ok" '"instanceId"' "$JOIN2"

echo ""
echo "════ RESULT: $PASS passed, $FAIL failed ════"
kill $MAIN_PID $RT_PID $GH_PID $PG_PID 2>/dev/null
sleep 1
pkill -f "dist/main/index.js" 2>/dev/null; pkill -f "dist/gamehost" 2>/dev/null; pkill -f "dist/realtime" 2>/dev/null; pkill -f "start-pg" 2>/dev/null
exit $([ $FAIL -eq 0 ] && echo 0 || echo 1)

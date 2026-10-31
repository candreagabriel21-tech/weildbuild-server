#!/bin/bash
# ═══════════════════════════════════════════════════════════
# WeildBuild v1.4.2 smoke test, single invocation
# (sandbox kills background processes between calls, so pg +
#  all services + every curl check run in THIS one call)
# Covers:
#   • v1.4.2: banned login -> 403 + reason (the "Session expired" bug)
#   • v1.4.2: wrong password -> 401 + real message
#   • v1.4.2: empty host registry -> ACTIONABLE join error
#   • v1.4.2: gamehost /health registered/mainUrl/lastRegisterError
#   • v1.4.2: main /health hosts census
#   • v1.4.2: SELF-HEAL (row deleted -> re-register automatically)
#   • v1.4.1 regression: sleeping-host wake fix
#   • v1.4.1 regression: moderation, game delete, rename fix
# ═══════════════════════════════════════════════════════════
set -u
cd "$(dirname "$0")/.."

export DATABASE_URL="postgresql://postgres:postgres@localhost:5433/weildbuild"
export AUTH_SECRET="smoke-test-secret-0123456789abcdef0123456789abcdef"
export INTERNAL_TOKEN="smoke-internal-token"
export HOST_PUBLIC_URL="http://localhost:3004"
export MAIN_SERVER_URL="http://localhost:8000"
export REREGISTER_INTERVAL_MS="5000" # fast loop so the self-heal test is quick

PASS=0; FAIL=0
check() { # name, expected_substr, actual
  if echo "$3" | grep -q "$2"; then PASS=$((PASS+1)); echo "  OK  $1";
  else FAIL=$((FAIL+1)); echo "  XX  $1, wanted [$2] got: $(echo "$3" | head -c 220)"; fi
}
checknot() { # name, forbidden_substr, actual
  if echo "$3" | grep -q "$2"; then FAIL=$((FAIL+1)); echo "  XX  $1, must NOT contain [$2] got: $(echo "$3" | head -c 220)";
  else PASS=$((PASS+1)); echo "  OK  $1"; fi
}
status_check() { # name, expected_code, actual_code
  if [ "$3" = "$2" ]; then PASS=$((PASS+1)); echo "  OK  $1";
  else FAIL=$((FAIL+1)); echo "  XX  $1, wanted HTTP $2 got $3"; fi
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

echo "── 2. Boot MAIN ONLY (no gamehost yet, empty registry) ──"
node dist/main/index.js > /tmp/main.log 2>&1 &
MAIN_PID=$!
for i in $(seq 1 30); do curl -s -o /dev/null http://localhost:8000/health && break; sleep 1; done
curl -s -o /dev/null http://localhost:8000/health || { echo "main never came up"; tail -10 /tmp/main.log; exit 1; }
echo "  OK  main up"

echo "── 3. v1.4.2: health endpoints ──"
# Version is read from package.json so this check never drifts again
# (it used to hardcode "1.4.2" and broke on every release bump).
SERVER_VERSION=$(node -e "console.log(require('./package.json').version)")
MH=$(curl -s http://localhost:8000/health)
check "main health reports server version" "\"version\":\"$SERVER_VERSION\"" "$MH"
check "main health reports empty host census" '"registered":0' "$MH"

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

echo "── 5. v1.4.2 BUG2: banned login -> 403 + reason ──"
BAN=$(curl -s -X POST http://localhost:8000/api/admin/moderate -H "Content-Type: application/json" -H "X-Session-Token: $ADMIN_TOKEN" -d '{"action":"ban","username":"Victim1","reason":"Testing bans"}')
check "ban ok" '"is_banned":true' "$BAN"
BANNED_CODE=$(curl -s -o /tmp/bl.json -w "%{http_code}" -X POST http://localhost:8000/api/auth -H "Content-Type: application/json" -d '{"action":"login","username":"Victim1","password":"testpass123"}')
status_check "banned login returns 403 (was 401, the bug!)" "403" "$BANNED_CODE"
check "banned login body has reason" 'Account is banned: Testing bans' "$(cat /tmp/bl.json)"
check "banned login body flagged banned:true" '"banned":true' "$(cat /tmp/bl.json)"
check "old session instantly dead" '"authenticated":false' "$(curl -s http://localhost:8000/api/auth -H "X-Session-Token: $V_TOKEN")"

echo "── 6. v1.4.2 BUG2: wrong password -> 401 + real message ──"
WRONG_CODE=$(curl -s -o /tmp/wp.json -w "%{http_code}" -X POST http://localhost:8000/api/auth -H "Content-Type: application/json" -d '{"action":"login","username":"Stranger1","password":"totally-wrong"}')
status_check "wrong password returns 401" "401" "$WRONG_CODE"
check "wrong password message is real (not generic)" 'Invalid username or password' "$(cat /tmp/wp.json)"

echo "── 7. Unban + relogin ──"
UNBAN=$(curl -s -X POST http://localhost:8000/api/admin/moderate -H "Content-Type: application/json" -H "X-Session-Token: $ADMIN_TOKEN" -d '{"action":"unban","username":"Victim1"}')
check "unban ok" '"is_banned":false' "$UNBAN"
RELOGIN=$(curl -s -X POST http://localhost:8000/api/auth -H "Content-Type: application/json" -d '{"action":"login","username":"Victim1","password":"testpass123"}')
check "relogin works" '"success":true' "$RELOGIN"
V_TOKEN=$(echo "$RELOGIN" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).sessionToken||''))")

echo "── 8. v1.4.2 BUG3: EMPTY REGISTRY join error is actionable ──"
CREATE=$(curl -s -X POST http://localhost:8000/api/games -H "Content-Type: application/json" -H "X-Session-Token: $ADMIN_TOKEN" -d '{"name":"EmptyReg","description":"e","public":true}')
G1=$(echo "$CREATE" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).id||''))")
[ -n "$G1" ] && echo "  OK  game created ($G1)" || { echo "  XX  create failed: $CREATE"; exit 1; }
EMPTY_JOIN=$(curl -s -X POST http://localhost:8000/api/instances/join -H "Content-Type: application/json" -H "X-Session-Token: $ADMIN_TOKEN" -d "{\"gameId\":\"$G1\"}")
check "empty registry names the fix (MAIN_SERVER_URL)" 'MAIN_SERVER_URL' "$EMPTY_JOIN"
check "empty registry names the fix (INTERNAL_TOKEN)" 'INTERNAL_TOKEN' "$EMPTY_JOIN"
check "empty registry says what's wrong" 'No game hosts are registered' "$EMPTY_JOIN"
checknot "old vague error gone" 'No game servers are currently online' "$EMPTY_JOIN"

echo "── 9. Boot gamehost → registration ──"
PORT=3004 node dist/gamehost/index.js > /tmp/gh.log 2>&1 &
GH_PID=$!
for i in $(seq 1 45); do grep -q "registered with Main Server" /tmp/gh.log 2>/dev/null && break; sleep 1; done
grep -q "registered with Main Server" /tmp/gh.log && echo "  OK  gamehost registered" || { echo "  XX  gamehost never registered"; tail -5 /tmp/gh.log; exit 1; }
GHH=$(curl -s http://localhost:3004/health)
check "gamehost health reports server version" "\"version\":\"$SERVER_VERSION\"" "$GHH"
check "gamehost health registered:true" '"registered":true' "$GHH"
check "gamehost health exposes mainUrl" '"mainUrl":"http://localhost:8000"' "$GHH"
check "gamehost health lastRegisterError null" '"lastRegisterError":null' "$GHH"
check "main health now counts the host" '"registered":1' "$(curl -s http://localhost:8000/health)"

echo "── 10. Join works end-to-end ──"
JOIN=$(curl -s -X POST http://localhost:8000/api/instances/join -H "Content-Type: application/json" -H "X-Session-Token: $V_TOKEN" -d "{\"gameId\":\"$G1\"}")
check "join placement returned" '"instanceId"' "$JOIN"
check "socketUrl points at gamehost" 'localhost:3004' "$JOIN"

echo "── 11. v1.4.2 BUG3: SELF-HEAL (host row deleted) ──"
npx tsx -e "
import { prisma } from './src/db/client';
async function main() {
  await prisma.serverHost.deleteMany({});
  console.log('ROW-DELETED');
}
main();
" | grep -q ROW-DELETED && echo "  OK  host row deleted (simulating wiped registry)" || echo "  XX  delete failed"
# The gamehost's next heartbeat gets reRegister:true (or the 5s re-register
# loop fires), the row must come back on its own within ~10s.
HEALED=""
for i in $(seq 1 20); do
  R=$(curl -s http://localhost:8000/health | grep -o '"registered":[0-9]*' || true)
  if echo "$R" | grep -q '"registered":1'; then HEALED="yes"; break; fi
  sleep 1
done
[ "$HEALED" = "yes" ] && echo "  OK  host re-registered automatically (self-heal works)" || echo "  XX  host never came back, self-heal broken"
check "gamehost health still registered:true" '"registered":true' "$(curl -s http://localhost:3004/health)"

echo "── 12. v1.4.1 regression: SLEEPING-HOST WAKE FIX ──"
npx tsx -e "
import { prisma } from './src/db/client';
async function main() {
  await prisma.serverHost.updateMany({ data: { status: 'offline', lastHeartbeat: new Date(Date.now() - 5 * 60 * 1000) } });
  console.log('HOST-ASLEEP');
}
main();
" | grep -q HOST-ASLEEP && echo "  OK  host put to sleep" || echo "  XX  sleep simulation failed"
WAKE_JOIN=$(curl -s -X POST http://localhost:8000/api/instances/join -H "Content-Type: application/json" -H "X-Session-Token: $V_TOKEN" -d "{\"gameId\":\"$G1\"}")
check "sleeping host woken, placement returned" '"instanceId"' "$WAKE_JOIN"

echo "── 13. v1.4.1 regression: game delete + rename ──"
CREATE2=$(curl -s -X POST http://localhost:8000/api/games -H "Content-Type: application/json" -H "X-Session-Token: $V_TOKEN" -d '{"name":"DeleteMe","description":"del","public":true}')
G2=$(echo "$CREATE2" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).id||''))")
check "stranger cannot delete" 'only delete your own' "$(curl -s -X DELETE "http://localhost:8000/api/games?id=$G2" -H "X-Session-Token: $S_TOKEN")"
check "creator deletes" '"success":true' "$(curl -s -X DELETE "http://localhost:8000/api/games?id=$G2" -H "X-Session-Token: $V_TOKEN")"
check "game is gone" '"error":"Game not found"' "$(curl -s "http://localhost:8000/api/games?id=$G2")"
CREATE3=$(curl -s -X POST http://localhost:8000/api/games -H "Content-Type: application/json" -H "X-Session-Token: $V_TOKEN" -d '{"name":"OldName","description":"r","public":true}')
G3=$(echo "$CREATE3" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).id||''))")
REN=$(curl -s -X PUT http://localhost:8000/api/games -H "Content-Type: application/json" -H "X-Session-Token: $V_TOKEN" -d "{\"id\":\"$G3\",\"name\":\"RenamedGame\"}")
check "rename response shows new name" '"name":"RenamedGame"' "$REN"
check "re-read shows new name" '"name":"RenamedGame"' "$(curl -s "http://localhost:8000/api/games?id=$G3")"

echo ""
echo "════ RESULT: $PASS passed, $FAIL failed ════"
kill $MAIN_PID $GH_PID $PG_PID 2>/dev/null
sleep 1
pkill -f "dist/main/index.js" 2>/dev/null; pkill -f "dist/gamehost" 2>/dev/null; pkill -f "start-pg" 2>/dev/null
exit $([ $FAIL -eq 0 ] && echo 0 || echo 1)

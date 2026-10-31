#!/bin/bash
# ═══════════════════════════════════════════════════════════
# Friend lifecycle smoke test, reproduce "can't add, block or
# unfriend anyone" bug. Boots pg + main server in ONE call.
# ═══════════════════════════════════════════════════════════
set -u
cd "$(dirname "$0")/.."

export DATABASE_URL="postgresql://postgres:postgres@localhost:5433/weildbuild"
export AUTH_SECRET="smoke-test-secret-0123456789abcdef0123456789abcdef"
export INTERNAL_TOKEN="smoke-internal-token"
export HOST_PUBLIC_URL="http://localhost:3004"
export MAIN_SERVER_URL="http://localhost:8000"

PASS=0; FAIL=0
check() {
  if echo "$3" | grep -q "$2"; then PASS=$((PASS+1)); echo "  OK  $1";
  else FAIL=$((FAIL+1)); echo "  XX  $1, wanted [$2] got: $(echo "$3" | head -c 300)"; fi
}
status_check() {
  if [ "$3" = "$2" ]; then PASS=$((PASS+1)); echo "  OK  $1";
  else FAIL=$((FAIL+1)); echo "  XX  $1, wanted HTTP $2 got $3"; fi
}

echo "── 0. Postgres ──"
node scripts/start-pg.mjs > /tmp/pg.log 2>&1 &
PG_PID=$!
for i in $(seq 1 60); do grep -q "PG-READY" /tmp/pg.log 2>/dev/null && break; sleep 1; done
grep -q "PG-READY" /tmp/pg.log || { echo "pg failed"; tail -5 /tmp/pg.log; exit 1; }

echo "── 1. Migrate + seed ──"
npx prisma db push --skip-generate --force-reset > /tmp/mig.log 2>&1 || { echo "migrate failed"; tail -5 /tmp/mig.log; exit 1; }
npx tsx prisma/seed.ts > /tmp/seed.log 2>&1 || { echo "seed failed"; tail -5 /tmp/seed.log; exit 1; }

echo "── 2. Build + boot main ──"
npx tsc > /tmp/tsc.log 2>&1 || { echo "tsc failed"; cat /tmp/tsc.log | head -20; exit 1; }
node dist/main/index.js > /tmp/main.log 2>&1 &
MAIN_PID=$!
for i in $(seq 1 30); do curl -s -o /dev/null http://localhost:8000/health && break; sleep 1; done
curl -s -o /dev/null http://localhost:8000/health || { echo "main never came up"; tail -10 /tmp/main.log; exit 1; }

echo "── 3. Users ──"
# Login as seeded admin WeildBuild
ADMIN_TOKEN=$(curl -s -X POST http://localhost:8000/api/auth -H "Content-Type: application/json" \
  -d '{"action":"login","username":"WeildBuild","password":"WeildBuild2026!"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).sessionToken||''))")
[ -n "$ADMIN_TOKEN" ] && echo "  OK  WeildBuild admin login" || { echo "  XX  admin login failed"; exit 1; }
# Register Bob
REG=$(curl -s -X POST http://localhost:8000/api/auth -H "Content-Type: application/json" -d '{"action":"register","username":"Bob","password":"testpass123"}')
BOB_TOKEN=$(echo "$REG" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).sessionToken||''))")
[ -n "$BOB_TOKEN" ] && echo "  OK  Bob registered" || { echo "  XX  Bob register failed: $REG"; exit 1; }
# Register Alice
REG2=$(curl -s -X POST http://localhost:8000/api/auth -H "Content-Type: application/json" -d '{"action":"register","username":"Alice","password":"testpass123"}')
ALICE_TOKEN=$(echo "$REG2" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).sessionToken||''))")
[ -n "$ALICE_TOKEN" ] && echo "  OK  Alice registered" || { echo "  XX  Alice register failed: $REG2"; exit 1; }

echo "── 4. ADMIN sends friend request to Bob (the reported bug path) ──"
REQ=$(curl -s -w "\n%{http_code}" -X POST http://localhost:8000/api/friends \
  -H "Content-Type: application/json" -H "X-Session-Token: $ADMIN_TOKEN" \
  -H "Origin: https://localhost" \
  -d '{"action":"request","from":"WeildBuild","to":"Bob"}')
REQ_CODE=$(echo "$REQ" | tail -1); REQ_BODY=$(echo "$REQ" | head -1)
status_check "admin->Bob request returns 200" "200" "$REQ_CODE"
check "admin->Bob request succeeds" '"success":true' "$REQ_BODY"

echo "── 5. Bob's incoming list shows WeildBuild ──"
BOB_FR=$(curl -s "http://localhost:8000/api/friends?username=Bob" -H "X-Session-Token: $BOB_TOKEN")
check "Bob friend_requests has WeildBuild" 'WeildBuild' "$BOB_FR"

echo "── 6. Bob accepts ──"
ACC=$(curl -s -w "\n%{http_code}" -X POST http://localhost:8000/api/friends \
  -H "Content-Type: application/json" -H "X-Session-Token: $BOB_TOKEN" \
  -d '{"action":"accept","username":"Bob","friend":"WeildBuild"}')
status_check "Bob accepts returns 200" "200" "$(echo "$ACC" | tail -1)"
check "Bob accepts success" '"success":true' "$(echo "$ACC" | head -1)"
check "Bob friends now include WeildBuild" '"friends":\["WeildBuild"\]' "$(curl -s "http://localhost:8000/api/friends?username=Bob" -H "X-Session-Token: $BOB_TOKEN")"

echo "── 7. ADMIN unfriends Bob (remove) ──"
REM=$(curl -s -w "\n%{http_code}" -X POST http://localhost:8000/api/friends \
  -H "Content-Type: application/json" -H "X-Session-Token: $ADMIN_TOKEN" \
  -d '{"action":"remove","username":"WeildBuild","friend":"Bob"}')
status_check "admin removes Bob returns 200" "200" "$(echo "$REM" | tail -1)"
check "admin removes Bob success" '"success":true' "$(echo "$REM" | head -1)"
check "Bob no longer has WeildBuild as friend" '"friends":\[\]' "$(curl -s "http://localhost:8000/api/friends?username=Bob" -H "X-Session-Token: $BOB_TOKEN")"

echo "── 8. ADMIN blocks Bob ──"
BLK=$(curl -s -w "\n%{http_code}" -X POST http://localhost:8000/api/friends \
  -H "Content-Type: application/json" -H "X-Session-Token: $ADMIN_TOKEN" \
  -d '{"action":"block","username":"WeildBuild","target":"Bob"}')
status_check "admin blocks Bob returns 200" "200" "$(echo "$BLK" | tail -1)"
check "admin blocks Bob success" '"success":true' "$(echo "$BLK" | head -1)"
# v1.4.5 API shape: GET /api/friends returns friends/requests only; the
# authoritative blocked_users comes back on the block/unblock action itself
# (stripSensitiveFields(user)), that's also what the client store keeps.
check "admin blocked_users has Bob" '"blocked_users":\["Bob"\]' "$(echo "$BLK" | head -1)"

echo "── 9. ADMIN unblocks Bob ──"
UBL=$(curl -s -w "\n%{http_code}" -X POST http://localhost:8000/api/friends \
  -H "Content-Type: application/json" -H "X-Session-Token: $ADMIN_TOKEN" \
  -d '{"action":"unblock","username":"WeildBuild","target":"Bob"}')
status_check "admin unblocks Bob returns 200" "200" "$(echo "$UBL" | tail -1)"
check "admin unblocks Bob success" '"success":true' "$(echo "$UBL" | head -1)"

echo "── 10. Alice->Bob request + Bob cancels from sent side ──"
curl -s -X POST http://localhost:8000/api/friends -H "Content-Type: application/json" -H "X-Session-Token: $ALICE_TOKEN" -d '{"action":"request","from":"Alice","to":"Bob"}' > /dev/null
check "Bob sees incoming Alice" 'Alice' "$(curl -s "http://localhost:8000/api/friends?username=Bob" -H "X-Session-Token: $BOB_TOKEN")"
check "Alice sent_requests has Bob" '"sent_requests":\["Bob"\]' "$(curl -s "http://localhost:8000/api/friends?username=Alice" -H "X-Session-Token: $ALICE_TOKEN")"
CAN=$(curl -s -X POST http://localhost:8000/api/friends -H "Content-Type: application/json" -H "X-Session-Token: $ALICE_TOKEN" -d '{"action":"cancel","from":"Alice","to":"Bob"}')
check "Alice cancels success" '"success":true' "$CAN"
check "Bob incoming empty after cancel" '"friend_requests":\[\]' "$(curl -s "http://localhost:8000/api/friends?username=Bob" -H "X-Session-Token: $BOB_TOKEN")"

echo "── 11. DM round trip ──"
curl -s -X POST http://localhost:8000/api/friends -H "Content-Type: application/json" -H "X-Session-Token: $ALICE_TOKEN" -d '{"action":"send_message","from":"Alice","to":"Bob","content":"hi bob"}' > /dev/null
MSGS=$(curl -s "http://localhost:8000/api/friends?action=get_messages&user1=Bob&user2=Alice" -H "X-Session-Token: $BOB_TOKEN")
check "DM stored with from Alice" '"from":"Alice"' "$MSGS"

echo ""
echo "════ RESULT: $PASS passed, $FAIL failed ════"
kill $MAIN_PID $PG_PID 2>/dev/null
sleep 1
pkill -f "dist/main/index.js" 2>/dev/null; pkill -f "start-pg" 2>/dev/null
exit $([ $FAIL -eq 0 ] && echo 0 || echo 1)

#!/bin/bash
# ═══════════════════════════════════════════════════════════
# v1.11.0 smoke test — boots embedded Postgres + the Main
# server, then exercises every new endpoint end-to-end:
#   1. register → 20 WeBuy + pink Welcome Letter (inbox + response)
#   2. ideas: create, list, vote toggle, 5-idea cap, guest rules
#   3. admin: status buttons, close date (vote rejected after), remove
#   4. announcements with kinds (Admin Message custom kind)
# Runs in ONE invocation (background procs die between bash calls).
# ═══════════════════════════════════════════════════════════
set -u
cd "$(dirname "$0")/.."

# Kill ANY leftover servers / postgres from earlier runs — a stale
# `npx tsx` child survives `kill $PID` and would steal port 8000.
pkill -f "src/main/index.ts" 2>/dev/null || true
pkill -f "start-pg.mjs" 2>/dev/null || true
pkill -f "db-v1110" 2>/dev/null || true
sleep 2
if ss -ltn 2>/dev/null | grep -qE ':(8000|5433) '; then
  echo "✗ ports 8000/5433 still busy — kill the holders first:"; ss -ltnp | grep -E ':(8000|5433) '; exit 1
fi

export PG_DATA_DIR=/home/z/my-project/data/db-v1110
rm -rf "$PG_DATA_DIR"
mkdir -p /home/z/my-project/data

echo "── booting embedded postgres…"
node scripts/start-pg.mjs > /tmp/pg-v1110.log 2>&1 &
PG_PID=$!
for i in $(seq 1 60); do
  grep -q "PG-READY" /tmp/pg-v1110.log 2>/dev/null && break
  sleep 1
done
grep -q "PG-READY" /tmp/pg-v1110.log || { echo "✗ postgres failed"; cat /tmp/pg-v1110.log; exit 1; }
echo "✓ postgres ready"

export DATABASE_URL="postgresql://postgres:postgres@localhost:5433/weildbuild"
export AUTH_SECRET="smoke-test-secret"
export INTERNAL_TOKEN="smoke-internal-token"
export PORT=8000
export REALTIME_URL="http://localhost:3003"

echo "── booting main server (v1.11.0)…"
./node_modules/.bin/tsx src/main/index.ts > /tmp/main-v1110.log 2>&1 &
MAIN_PID=$!
for i in $(seq 1 90); do
  curl -sf http://localhost:8000/health > /dev/null 2>&1 && break
  sleep 1
done
curl -sf http://localhost:8000/health > /dev/null || { echo "✗ main failed"; tail -40 /tmp/main-v1110.log; pkill -f "src/main/index.ts" 2>/dev/null; kill $PG_PID 2>/dev/null; exit 1; }
echo "✓ main up: $(curl -s http://localhost:8000/health | head -c 120)"

# /health answers BEFORE the boot-time `prisma db push` finishes (it runs
# in the background after the port binds). Wait until the database is
# REALLY ready: GET /api/ideas returns 200 only once the tables exist.
echo "── waiting for the boot db setup (schema sync + seed)…"
DB_READY=0
for i in $(seq 1 90); do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/api/ideas 2>/dev/null || echo 000)
  if [ "$CODE" = "200" ]; then DB_READY=1; break; fi
  sleep 1
done
if [ "$DB_READY" != "1" ]; then
  echo "✗ database never became ready (last code: $CODE)"; tail -30 /tmp/main-v1110.log
  pkill -f "src/main/index.ts" 2>/dev/null; kill $PG_PID 2>/dev/null; exit 1
fi
echo "✓ database ready"

PASS=0; FAIL=0
check() { # name, response, grepExitCode
  if [ "$3" != "0" ]; then echo "✗ FAIL  $1"; echo "        got: $(echo "$2" | head -c 220)"; FAIL=$((FAIL+1)); else echo "✓  $1"; PASS=$((PASS+1)); fi
}

H='Content-Type: application/json'

# ── 1. register → 20 webuy + welcome letter ──
echo "── 1. welcome letter + starting currency"
REG=$(curl -s -X POST http://localhost:8000/api/auth -H "$H" -d '{"action":"register","username":"smokeuser","password":"hunter22"}')
echo "$REG" | grep -q '"webuy":20'; check "new account starts with 20 WeBuy" "$REG" $?
echo "$REG" | grep -q '"kind":"Welcome Letter"'; check "register response carries the Welcome Letter" "$REG" $?
TOKEN=$(echo "$REG" | jq -r '.sessionToken // empty')
[ -n "$TOKEN" ]; check "session token issued" "$REG" $?

NOTIF=$(curl -s "http://localhost:8000/api/notifications?username=smokeuser" -H "X-Session-Token: $TOKEN")
echo "$NOTIF" | grep -q '"type":"welcome"'; check "welcome letter in the inbox (type=welcome)" "$NOTIF" $?
echo "$NOTIF" | grep -q '"title":"Welcome to WeildBuild!"'; check "welcome letter title" "$NOTIF" $?
echo "$NOTIF" | grep -q "Here's 20 WeBuy to get you started"; check "welcome letter text mentions 20 WeBuy" "$NOTIF" $?
echo "$NOTIF" | grep -q '"from":"WeildBuild Team"'; check "welcome letter from WeildBuild Team" "$NOTIF" $?

# ── 2. ideas: create / list / vote ──
echo "── 2. ideas + votes"
IDEA=$(curl -s -X POST http://localhost:8000/api/ideas -H "$H" -H "X-Session-Token: $TOKEN" -d '{"title":"Add pets to the studio","description":"Little companions that follow your character"}')
echo "$IDEA" | grep -q '"title":"Add pets to the studio"'; check "idea created" "$IDEA" $?
echo "$IDEA" | grep -q '"status":"open"'; check "new idea starts open" "$IDEA" $?
IDEA_ID=$(echo "$IDEA" | jq -r '.id // empty')

V1=$(curl -s -X POST http://localhost:8000/api/ideas/vote -H "$H" -H "X-Session-Token: $TOKEN" -d "{\"ideaId\":\"$IDEA_ID\"}")
echo "$V1" | grep -q '"voted":true'; check "vote toggles on (voted=true)" "$V1" $?
echo "$V1" | grep -q '"votes":1'; check "vote count = 1" "$V1" $?
V2=$(curl -s -X POST http://localhost:8000/api/ideas/vote -H "$H" -H "X-Session-Token: $TOKEN" -d "{\"ideaId\":\"$IDEA_ID\"}")
echo "$V2" | grep -q '"voted":false'; check "vote toggles off (voted=false)" "$V2" $?
curl -s -X POST http://localhost:8000/api/ideas/vote -H "$H" -H "X-Session-Token: $TOKEN" -d "{\"ideaId\":\"$IDEA_ID\"}" > /dev/null

LIST=$(curl -s http://localhost:8000/api/ideas -H "X-Session-Token: $TOKEN")
echo "$LIST" | grep -q '"voted":true'; check "idea list carries my voted flag" "$LIST" $?
echo "$LIST" | grep -q 'Add pets'; check "idea list is public (guests can browse)" "$LIST" $?

# idea cap: 5 ideas max per account
for i in 2 3 4 5; do
  curl -s -X POST http://localhost:8000/api/ideas -H "$H" -H "X-Session-Token: $TOKEN" -d "{\"title\":\"Filler idea number $i\"}" > /dev/null
done
CAP=$(curl -s -X POST http://localhost:8000/api/ideas -H "$H" -H "X-Session-Token: $TOKEN" -d '{"title":"Sixth idea should fail"}')
echo "$CAP" | grep -q 'at most 5 ideas'; check "6th idea rejected (5-idea cap)" "$CAP" $?

# anonymous can't post
ANON=$(curl -s -X POST http://localhost:8000/api/ideas -H "$H" -d '{"title":"Anonymous idea"}')
echo "$ANON" | grep -q 'Authentication required'; check "anonymous posting rejected" "$ANON" $?

# ── 3. admin: statuses, close date, remove ──
echo "── 3. admin controls"
ADMIN_TOKEN=""
for attempt in 1 2 3 4 5 6 7 8; do
  ADMIN_LOGIN=$(curl -s -X POST http://localhost:8000/api/auth -H "$H" -d '{"action":"login","username":"WeildBuild","password":"WeildBuild2026!"}')
  ADMIN_TOKEN=$(echo "$ADMIN_LOGIN" | jq -r '.sessionToken // empty')
  [ -n "$ADMIN_TOKEN" ] && break
  sleep 2  # the boot seed may still be inserting the default admin

done
[ -n "$ADMIN_TOKEN" ]; check "top admin login" "$ADMIN_LOGIN" $?
AH="X-Session-Token: $ADMIN_TOKEN"

ST=$(curl -s -X PATCH http://localhost:8000/api/ideas -H "$H" -H "$AH" -d "{\"ideaId\":\"$IDEA_ID\",\"status\":\"approved\"}")
echo "$ST" | grep -q '"status":"approved"'; check "admin sets status → approved" "$ST" $?

PAST=$(node -e "console.log(new Date(Date.now()-3600e3).toISOString())")
CL=$(curl -s -X PATCH http://localhost:8000/api/ideas -H "$H" -H "$AH" -d "{\"ideaId\":\"$IDEA_ID\",\"closesAt\":\"$PAST\"}")
echo "$CL" | grep -q '"closed":true'; check "close date in the past → closed=true" "$CL" $?

VOTE_CLOSED=$(curl -s -X POST http://localhost:8000/api/ideas/vote -H "$H" -H "X-Session-Token: $TOKEN" -d "{\"ideaId\":\"$IDEA_ID\"}")
echo "$VOTE_CLOSED" | grep -q 'Voting is closed'; check "voting rejected after close date" "$VOTE_CLOSED" $?

REOPEN=$(curl -s -X PATCH http://localhost:8000/api/ideas -H "$H" -H "$AH" -d "{\"ideaId\":\"$IDEA_ID\",\"closesAt\":null}")
echo "$REOPEN" | grep -q '"closed":false'; check "clearing the close date reopens voting" "$REOPEN" $?

NOT_ADMIN=$(curl -s -X PATCH http://localhost:8000/api/ideas -H "$H" -H "X-Session-Token: $TOKEN" -d "{\"ideaId\":\"$IDEA_ID\",\"status\":\"approved\"}")
echo "$NOT_ADMIN" | grep -q 'Admin access required'; check "non-admin cannot set statuses" "$NOT_ADMIN" $?

FUTURE=$(node -e "console.log(new Date(Date.now()+7*24*3600e3).toISOString())")
FC=$(curl -s -X PATCH http://localhost:8000/api/ideas -H "$H" -H "$AH" -d "{\"ideaId\":\"$IDEA_ID\",\"closesAt\":\"$FUTURE\"}")
echo "$FC" | grep -q '"closed":false'; check "future close date → still open (countdown shows)" "$FC" $?

DEL=$(curl -s -X DELETE http://localhost:8000/api/ideas -H "$H" -H "$AH" -d "{\"ideaId\":\"$IDEA_ID\"}")
echo "$DEL" | grep -q '"success":true'; check "admin removes an idea" "$DEL" $?

# ── 4. announcements with kinds ──
echo "── 4. announcement kinds"
ANN=$(curl -s -X POST http://localhost:8000/api/admin/announce -H "$H" -H "$AH" -d '{"title":"Server maintenance","kind":"Admin Message","message":"Short maintenance tonight at 8pm.","recipients":["smokeuser"]}')
echo "$ANN" | grep -q '"kind":"Admin Message"'; check "announce accepts a kind (Admin Message)" "$ANN" $?
SMOKE_NOTIF=$(curl -s "http://localhost:8000/api/notifications?username=smokeuser" -H "X-Session-Token: $TOKEN")
echo "$SMOKE_NOTIF" | grep -q '"kind":"Admin Message"'; check "recipient inbox row carries the kind" "$SMOKE_NOTIF" $?

ANN2=$(curl -s -X POST http://localhost:8000/api/admin/announce -H "$H" -H "$AH" -d '{"title":"Custom kind test","kind":"Party Invite","message":"You are invited!","recipients":["smokeuser"]}')
echo "$ANN2" | grep -q '"kind":"Party Invite"'; check "custom free-text kind works" "$ANN2" $?

ANN3=$(curl -s -X POST http://localhost:8000/api/admin/announce -H "$H" -H "$AH" -d '{"title":"No kind given","message":"Defaults to WeildBuild Update.","recipients":["smokeuser"]}')
echo "$ANN3" | grep -q '"kind":"WeildBuild Update"'; check "empty kind falls back to WeildBuild Update" "$ANN3" $?

echo ""
echo "════════ results: $PASS passed, $FAIL failed ════════"
# Kill the real server child too (killing the npx wrapper alone leaks it)
pkill -f "src/main/index.ts" 2>/dev/null || true
kill $PG_PID 2>/dev/null || true
pkill -f "db-v1110" 2>/dev/null || true
if [ "$FAIL" != "0" ]; then echo "--- main log tail ---"; tail -25 /tmp/main-v1110.log; exit 1; fi

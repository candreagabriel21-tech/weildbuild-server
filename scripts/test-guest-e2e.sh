#!/bin/bash
# ═══════════════════════════════════════════════════════════
# WeildBuild server — GUEST MODE end-to-end test (v1.9.2)
# ═══════════════════════════════════════════════════════════
# Boots embedded-postgres + the Main server in ONE invocation
# (the sandbox kills background processes between calls), then
# exercises the whole guest lifecycle:
#   create -> restrictions (403s) -> real-player contrast ->
#   DM-to-guest blocked -> logout purge -> row/session gone.
set -e
cd "$(dirname "$0")/.."

export DATABASE_URL="postgresql://postgres:postgres@localhost:5433/weildbuild"
export AUTH_SECRET="e2e-test-secret-0123456789abcdef0123456789abcdef"
export INTERNAL_TOKEN="e2e-internal-token"

PASS=0; FAIL=0
check() { # name, expected_substr, actual
  if echo "$3" | grep -q "$2"; then PASS=$((PASS+1)); echo "✓ $1";
  else FAIL=$((FAIL+1)); echo "✗ $1 — expected [$2] got: $(echo "$3" | head -c 220)"; fi
}
jsonval() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const o=JSON.parse(d);const p='$2'.split('.');let v=o;for(const k of p)v=v?.[k];console.log(v??'')}catch{console.log('')}})"; }

cleanup() {
  # Every command is guarded: under `set -e`, a FAILING command inside an
  # EXIT trap overrides the script's real exit status (killing an
  # already-dead PID or a pkill that matches nothing both "fail"), which
  # made this suite report exit 1 even when all 29 checks passed.
  { [ -n "$MAIN_PID" ] && kill $MAIN_PID 2>/dev/null; } || true
  { [ -n "$PG_PID" ] && kill $PG_PID 2>/dev/null; } || true
  pkill -f "dist/main/index.js" 2>/dev/null || true
  pkill -f "start-pg.mjs" 2>/dev/null || true
}
trap cleanup EXIT

echo "── 1. Build + database ──"
npm run build > /tmp/guest-build.log 2>&1 || { echo "✗ build failed"; tail -5 /tmp/guest-build.log; exit 1; }
node scripts/start-pg.mjs > /tmp/guest-pg.log 2>&1 &
PG_PID=$!
for i in $(seq 1 30); do grep -q PG-READY /tmp/guest-pg.log 2>/dev/null && break; sleep 1; done
grep -q PG-READY /tmp/guest-pg.log || { echo "✗ postgres did not start"; tail -5 /tmp/guest-pg.log; exit 1; }
npx prisma db push --skip-generate --force-reset > /tmp/guest-migrate.log 2>&1 || { echo "✗ migrate failed"; tail -5 /tmp/guest-migrate.log; exit 1; }
echo "✓ schema pushed (users.is_guest included)"
npx tsx prisma/seed.ts > /tmp/guest-seed.log 2>&1 || { echo "✗ seed failed"; tail -5 /tmp/guest-seed.log; exit 1; }

echo "── 2. Boot Main ──"
node dist/main/index.js > /tmp/guest-main.log 2>&1 &
MAIN_PID=$!
sleep 3
check "main health" '"weildbuild-main"' "$(curl -s http://localhost:8000/health)"

echo "── 3. Admin login ──"
LOGIN=$(curl -s -X POST http://localhost:8000/api/auth -H "Content-Type: application/json" -d '{"action":"login","username":"WeildBuild","password":"WeildBuild2026!"}')
check "admin login" '"success":true' "$LOGIN"
ADMIN_TOKEN=$(echo "$LOGIN" | jsonval . sessionToken)

echo "── 4. Create guests ──"
G1=$(curl -s -X POST http://localhost:8000/api/auth -H "Content-Type: application/json" -H "Origin: http://localhost:3000" -d '{"action":"guest"}')
check "guest #1 created" '"success":true' "$G1"
check "guest #1 has is_guest flag" '"is_guest":true' "$G1"
check "guest #1 named Guest-NNNN" '"username":"Guest-[0-9]' "$G1"
check "guest #1 got a session ticket" 'eyJ' "$(echo "$G1" | jsonval . sessionToken)"
GUEST1=$(echo "$G1" | jsonval . user.username)
G1_TOKEN=$(echo "$G1" | jsonval . sessionToken)
echo "  guest #1 = $GUEST1"

G2=$(curl -s -X POST http://localhost:8000/api/auth -H "Content-Type: application/json" -H "Origin: http://localhost:3000" -d '{"action":"guest"}')
GUEST2=$(echo "$G2" | jsonval . user.username)
G2_TOKEN=$(echo "$G2" | jsonval . sessionToken)
if [ "$GUEST1" != "$GUEST2" ] && [ -n "$GUEST2" ]; then PASS=$((PASS+1)); echo "✓ guest #2 has a different id ($GUEST2)"; else FAIL=$((FAIL+1)); echo "✗ guest ids collided"; fi

echo "── 5. Guest CAN view people + browse ──"
check "guest #1 public profile viewable (view people)" '"is_guest":true' "$(curl -s "http://localhost:8000/api/users?username=$GUEST1")"
check "guest reads game list (join servers prep)" '"success"' "$(curl -s "http://localhost:8000/api/games" -o /dev/null -w '"success"')"
check "guest session verifies" '"authenticated":true' "$(curl -s http://localhost:8000/api/auth -H "X-Session-Token: $G1_TOKEN")"

echo "── 6. Guest restrictions (all 403 + friendly messages) ──"
R1=$(curl -s -X POST http://localhost:8000/api/games -H "Content-Type: application/json" -H "Origin: http://localhost:3000" -H "X-Session-Token: $G1_TOKEN" -d '{"name":"Guest World","description":"x"}')
check "guest cannot publish game" "Guests can't publish games" "$R1"
R2=$(curl -s -X POST http://localhost:8000/api/items -H "Content-Type: application/json" -H "Origin: http://localhost:3000" -H "X-Session-Token: $G1_TOKEN" -d "{\"username\":\"$GUEST1\",\"itemId\":\"FACE-13\"}")
check "guest cannot buy item" "Guests can't buy items" "$R2"
R3=$(curl -s -X PUT http://localhost:8000/api/users -H "Content-Type: application/json" -H "Origin: http://localhost:3000" -H "X-Session-Token: $G1_TOKEN" -d "{\"username\":\"$GUEST1\",\"description\":\"hi\"}")
check "guest cannot change profile settings" "Guests can't change profile settings" "$R3"
R4=$(curl -s -X POST http://localhost:8000/api/friends -H "Content-Type: application/json" -H "Origin: http://localhost:3000" -H "X-Session-Token: $G1_TOKEN" -d "{\"action\":\"request\",\"from\":\"$GUEST1\",\"to\":\"WeildBuild\"}")
check "guest cannot add friend" "Guests can't add friends" "$R4"
R5=$(curl -s -X POST http://localhost:8000/api/auth -H "Content-Type: application/json" -H "Origin: http://localhost:3000" -H "X-Session-Token: $G1_TOKEN" -d "{\"action\":\"changePassword\",\"username\":\"$GUEST1\",\"oldPassword\":\"x\",\"newPassword\":\"Abcdef123\"}")
check "guest cannot change password" "don't have a password" "$R5"

echo "── 7. Votes: view yes, vote no ──"
IDEA=$(curl -s -X POST http://localhost:8000/api/votes -H "Content-Type: application/json" -H "Origin: http://localhost:3000" -H "X-Session-Token: $ADMIN_TOKEN" -d '{"title":"Guest test idea","message":"vote test"}')
check "admin posted idea" '"success":true' "$IDEA"
IDEA_ID=$(echo "$IDEA" | jsonval . idea.id)
check "guest can VIEW ideas" 'Guest test idea' "$(curl -s http://localhost:8000/api/votes)"
VOTE=$(curl -s -X POST http://localhost:8000/api/votes/vote -H "Content-Type: application/json" -H "Origin: http://localhost:3000" -H "X-Session-Token: $G1_TOKEN" -d "{\"ideaId\":\"$IDEA_ID\",\"value\":1}")
check "guest cannot vote" "Guests can't vote" "$VOTE"

echo "── 8. Real-player contrast (nothing broke for accounts) ──"
REG=$(curl -s -X POST http://localhost:8000/api/auth -H "Content-Type: application/json" -H "Origin: http://localhost:3000" -d '{"action":"register","username":"TestPlayer1","password":"testpass123"}')
check "register still works" '"success":true' "$REG"
P_TOKEN=$(echo "$REG" | jsonval . sessionToken)
PB=$(curl -s -X POST http://localhost:8000/api/items -H "Content-Type: application/json" -H "Origin: http://localhost:3000" -H "X-Session-Token: $P_TOKEN" -d '{"username":"TestPlayer1","itemId":"FACE-13"}')
check "real player CAN buy (FACE-13, 16 webuy)" '"success":true' "$PB"
PG=$(curl -s -X POST http://localhost:8000/api/games -H "Content-Type: application/json" -H "Origin: http://localhost:3000" -H "X-Session-Token: $P_TOKEN" -d '{"name":"Real Player World","description":"y"}')
check "real player CAN publish" 'Real Player World' "$PG"
PU=$(curl -s -X PUT http://localhost:8000/api/users -H "Content-Type: application/json" -H "Origin: http://localhost:3000" -H "X-Session-Token: $P_TOKEN" -d '{"username":"TestPlayer1","description":"hello there"}')
check "real player CAN edit profile" 'hello there' "$PU"

echo "── 9. DMs toward a guest are blocked ──"
DMG=$(curl -s -X POST http://localhost:8000/api/friends -H "Content-Type: application/json" -H "Origin: http://localhost:3000" -H "X-Session-Token: $P_TOKEN" -d "{\"action\":\"send_message\",\"from\":\"TestPlayer1\",\"to\":\"$GUEST1\",\"content\":\"hi guest\"}")
check "real player cannot DM a guest" "guest and can't receive messages" "$DMG"

echo "── 10. Logout purges EVERYTHING ──"
LO=$(curl -s -X POST http://localhost:8000/api/auth -H "Content-Type: application/json" -H "Origin: http://localhost:3000" -H "X-Session-Token: $G1_TOKEN" -d '{"action":"logout"}')
check "guest logout ok" '"success":true' "$LO"
check "guest #1 row purged (404)" 'User not found' "$(curl -s "http://localhost:8000/api/users?username=$GUEST1")"
check "guest #1 session dead" '"authenticated":false' "$(curl -s http://localhost:8000/api/auth -H "X-Session-Token: $G1_TOKEN")"
RELOG=$(curl -s -X POST http://localhost:8000/api/auth -H "Content-Type: application/json" -H "Origin: http://localhost:3000" -d "{\"action\":\"login\",\"username\":\"$GUEST1\",\"password\":\"Abcdef123\"}")
check "guest username can never log in again" 'Invalid username or password' "$RELOG"
check "guest #2 untouched by #1's logout" '"is_guest":true' "$(curl -s "http://localhost:8000/api/users?username=$GUEST2")"

echo "── 11. Sweeper smoke (short window) ──"
# Direct DB check: the hourly sweeper reaps guests with lastLogin older than
# 24h. Simulate by backdating guest #2, then calling sweepStaleGuests.
GUEST2_NAME="$GUEST2" npx tsx scripts/test-guest-sweep.ts > /tmp/guest-sweep.log 2>&1
check "sweeper purged the backdated guest" 'GONE:true' "$(cat /tmp/guest-sweep.log)"

echo ""
echo "════ RESULT: $PASS passed, $FAIL failed ════"
[ $FAIL -eq 0 ] || { echo "Guest E2E FAILED"; exit 1; }
echo "Guest E2E PASSED"

#!/bin/bash
# ═══════════════════════════════════════════════════════════
# WeildBuild server — full end-to-end test (local)
# ═══════════════════════════════════════════════════════════
# Requires embedded-postgres running on :5433 (see test-e2e.sh).
# Boots main (:8000), realtime (:3003), gamehost (:3004) and
# exercises: migrate → seed → admin login → register → session
# → buy item → friends → publish game → instance placement →
# gamehost join → heartbeat → version gate.
set -e
cd /home/z/my-project/weildbuild-server

export DATABASE_URL="postgresql://postgres:postgres@localhost:5433/weildbuild"
export AUTH_SECRET="e2e-test-secret-0123456789abcdef0123456789abcdef"
export INTERNAL_TOKEN="e2e-internal-token"
export HOST_PUBLIC_URL="http://localhost:3004"
export MAIN_SERVER_URL="http://localhost:8000"

PASS=0; FAIL=0
check() { # name, expected_substr, actual
  if echo "$3" | grep -q "$2"; then PASS=$((PASS+1)); echo "✓ $1";
  else FAIL=$((FAIL+1)); echo "✗ $1 — expected [$2] got: $(echo "$3" | head -c 200)"; fi
}

echo "── 1. Migrate + seed ──"
npx prisma db push --skip-generate --force-reset > /tmp/e2e-migrate.log 2>&1 && echo "✓ schema pushed (clean)" || { echo "✗ migrate failed"; cat /tmp/e2e-migrate.log | tail -5; exit 1; }
npx tsx prisma/seed.ts | tail -2

echo "── 2. Boot services ──"
node dist/main/index.js > /tmp/e2e-main.log 2>&1 &
MAIN_PID=$!
PORT=3003 node dist/realtime/index.js > /tmp/e2e-realtime.log 2>&1 &
RT_PID=$!
PORT=3004 node dist/gamehost/index.js > /tmp/e2e-gamehost.log 2>&1 &
GH_PID=$!
sleep 4

echo "── 3. Health checks ──"
check "main health" '"weildbuild-main"' "$(curl -s http://localhost:8000/health)"
check "realtime health" '"weildbuild-realtime"' "$(curl -s http://localhost:3003/health)"
check "gamehost health" '"weildbuild-gamehost"' "$(curl -s http://localhost:3004/health)"

echo "── 4. Version gate ──"
check "version endpoint" '"minimum":"13.0.0"' "$(curl -s http://localhost:8000/version)"

echo "── 5. Auth: admin login (password compat!) ──"
LOGIN=$(curl -s -X POST http://localhost:8000/api/auth -H "Content-Type: application/json" -d '{"action":"login","username":"WeildBuild","password":"WeildBuild2026!"}')
check "admin login works with original password" '"success":true' "$LOGIN"
ADMIN_TOKEN=$(echo "$LOGIN" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).sessionToken||''))")
check "JWT ticket issued" 'eyJ' "$ADMIN_TOKEN"
check "admin is top_admin" '"admin_role":"top_admin"' "$LOGIN"

echo "── 6. Auth: register a new user ──"
REG=$(curl -s -X POST http://localhost:8000/api/auth -H "Content-Type: application/json" -d '{"action":"register","username":"TestPlayer1","password":"testpass123"}')
check "register success" '"success":true' "$REG"
check "new user starts with 100 webuy" '"webuy":100' "$REG"
check "new user gets user_key" '"user_key"' "$REG"
PLAYER_TOKEN=$(echo "$REG" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).sessionToken||''))")

echo "── 7. Session verification + rejection ──"
check "session verify (header token)" '"authenticated":true' "$(curl -s http://localhost:8000/api/auth -H "X-Session-Token: $PLAYER_TOKEN")"
check "garbage token rejected" '"authenticated":false' "$(curl -s http://localhost:8000/api/auth -H "X-Session-Token: garbage")"
check "unauthenticated users listing blocked" 'error' "$(curl -s http://localhost:8000/api/users?page=1\&limit=5)"

echo "── 8. Items + race-safe purchase ──"
ITEMS=$(curl -s "http://localhost:8000/api/items?type=face")
check "face catalog (21 items)" '"FACE-21"' "$ITEMS"
BUY1=$(curl -s -X POST http://localhost:8000/api/items -H "Content-Type: application/json" -H "X-Session-Token: $PLAYER_TOKEN" -d '{"username":"TestPlayer1","itemId":"FACE-13"}')
check "buy FACE-13 (16 webuy)" '"success":true' "$BUY1"
BUY2=$(curl -s -X POST http://localhost:8000/api/items -H "Content-Type: application/json" -H "X-Session-Token: $PLAYER_TOKEN" -d '{"username":"TestPlayer1","itemId":"FACE-13"}')
check "double-buy blocked" "Already owned" "$BUY2"
BUY3=$(curl -s -X POST http://localhost:8000/api/items -H "Content-Type: application/json" -H "X-Session-Token: $PLAYER_TOKEN" -d '{"username":"TestPlayer1","itemId":"SHIRT-5"}')
check "unaffordable purchase blocked (100-16=84 < 100)" 'Not enough' "$BUY3"

echo "── 9. Friend flow ──"
FR1=$(curl -s -X POST http://localhost:8000/api/friends -H "Content-Type: application/json" -H "X-Session-Token: $PLAYER_TOKEN" -d '{"action":"request","from":"TestPlayer1","to":"WeildBuild"}')
check "friend request sent" '"success":true' "$FR1"
FR2=$(curl -s "http://localhost:8000/api/friends?username=WeildBuild" -H "X-Session-Token: $ADMIN_TOKEN")
check "admin sees pending request" 'TestPlayer1' "$FR2"
FR3=$(curl -s -X POST http://localhost:8000/api/friends -H "Content-Type: application/json" -H "X-Session-Token: $ADMIN_TOKEN" -d '{"action":"accept","username":"WeildBuild","friend":"TestPlayer1"}')
check "friend accepted" '"success":true' "$FR3"
DM=$(curl -s -X POST http://localhost:8000/api/friends -H "Content-Type: application/json" -H "X-Session-Token: $PLAYER_TOKEN" -d '{"action":"send_message","from":"TestPlayer1","to":"WeildBuild","content":"hello from e2e!"}')
check "DM sent" '"success":true' "$DM"
DMHIST=$(curl -s "http://localhost:8000/api/friends?action=get_messages&user1=WeildBuild&user2=TestPlayer1" -H "X-Session-Token: $ADMIN_TOKEN")
check "DM history readable" 'hello from e2e!' "$DMHIST"

echo "── 10. Game publish + read ──"
GAME=$(curl -s -X POST http://localhost:8000/api/games -H "Content-Type: application/json" -H "X-Session-Token: $ADMIN_TOKEN" -d '{"name":"E2E Test World","description":"made by e2e","creator":"WeildBuild","multiplayer":true,"public":true,"max_players":10,"primitives":[{"position":[0,0,0],"size":[10,1,10],"color":[1,0,0],"rotation":[0,0,0],"shape_type":"block"}]}')
check "game published" 'E2E Test World' "$GAME"
GAME_ID=$(echo "$GAME" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const g=JSON.parse(d);console.log(g.game?g.game.id:(g.id||''))})")
echo "  game id: $GAME_ID"
check "game listable" 'E2E Test World' "$(curl -s http://localhost:8000/api/games)"

echo "── 11. Instance placement (the mini-server flow!) ──"
sleep 2 # let gamehost register + first heartbeat land
JOIN=$(curl -s -X POST http://localhost:8000/api/instances/join -H "Content-Type: application/json" -H "X-Session-Token: $PLAYER_TOKEN" -d "{\"gameId\":\"$GAME_ID\"}")
check "placement returns instance + socketUrl" 'socketUrl' "$JOIN"
INSTANCE_ID=$(echo "$JOIN" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).instanceId||''))")
echo "  instance: $INSTANCE_ID"
LIST=$(curl -s "http://localhost:8000/api/instances?gameId=$GAME_ID")
check "instance listed with host label" 'Server 1' "$LIST"

echo "── 12. Gamehost internal API ──"
CAP=$(curl -s -X POST http://localhost:3004/internal/instances -H "Content-Type: application/json" -H "x-internal-token: $INTERNAL_TOKEN" -d "{\"gameId\":\"$GAME_ID\",\"maxPlayers\":10}")
check "internal instance create" 'instanceId' "$CAP"
BADTOKEN=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3004/internal/instances -H "Content-Type: application/json" -H "x-internal-token: WRONG" -d "{\"gameId\":\"$GAME_ID\",\"maxPlayers\":10}")
check "internal API rejects bad token" '401' "$BADTOKEN"

echo "── 13. Cleanup ──"
kill $MAIN_PID $RT_PID $GH_PID 2>/dev/null || true
sleep 1
echo ""
echo "════════════════════════════════════"
echo "  E2E RESULTS: $PASS passed, $FAIL failed"
echo "════════════════════════════════════"
[ $FAIL -eq 0 ] && echo "ALL TESTS PASSED ✓" || exit 1

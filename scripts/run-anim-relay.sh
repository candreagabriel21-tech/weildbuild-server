#!/bin/bash
# One-shot runner for anim-relay-e2e.mjs: boots embedded postgres + main +
# gamehost in a single invocation (the sandbox kills background processes
# between calls), waits for gamehost registration, runs the anim relay E2E
# (game:move anim relay for relay-only / legacy games), then cleans up.
set -u
cd "$(dirname "$0")/.."

export DATABASE_URL="postgresql://postgres:postgres@localhost:5433/weildbuild"
export AUTH_SECRET="anim-relay-secret-0123456789abcdef0123456789abcdef"
export INTERNAL_TOKEN="anim-internal-token"
export HOST_PUBLIC_URL="http://localhost:3004"
export MAIN_SERVER_URL="http://localhost:8000"

cleanup() {
  { [ -n "$MAIN_PID" ] && kill $MAIN_PID 2>/dev/null; } || true
  { [ -n "$GH_PID" ] && kill $GH_PID 2>/dev/null; } || true
  { [ -n "$PG_PID" ] && kill $PG_PID 2>/dev/null; } || true
  pkill -f "dist/main/index.js" 2>/dev/null || true
  pkill -f "dist/gamehost/index.js" 2>/dev/null || true
  pkill -f "start-pg.mjs" 2>/dev/null || true
}
trap cleanup EXIT

echo "[runner] starting embedded postgres..."
node scripts/start-pg.mjs > /tmp/anim-pg.log 2>&1 &
PG_PID=$!
for i in $(seq 1 90); do
  grep -q PG-READY /tmp/anim-pg.log 2>/dev/null && break
  kill -0 $PG_PID 2>/dev/null || break
  sleep 1
done
grep -q PG-READY /tmp/anim-pg.log || { echo "[runner] PG FAILED"; tail -5 /tmp/anim-pg.log; exit 1; }
echo "[runner] postgres ready"

npx prisma db push --skip-generate --force-reset > /tmp/anim-migrate.log 2>&1 || { echo "[runner] migrate failed"; tail -5 /tmp/anim-migrate.log; exit 1; }
npx tsx prisma/seed.ts > /tmp/anim-seed.log 2>&1 || { echo "[runner] seed failed"; tail -5 /tmp/anim-seed.log; exit 1; }
echo "[runner] schema + seed done"

node dist/main/index.js > /tmp/anim-main.log 2>&1 &
MAIN_PID=$!
node dist/gamehost/index.js > /tmp/anim-gh.log 2>&1 &
GH_PID=$!

for i in $(seq 1 45); do curl -s -o /dev/null http://localhost:8000/health && break; sleep 1; done
curl -s -o /dev/null http://localhost:8000/health || { echo "[runner] main never came up"; tail -10 /tmp/anim-main.log; exit 1; }
echo "[runner] main up"

for i in $(seq 1 45); do
  curl -s http://localhost:3004/health | grep -q '"registered":true' && break
  sleep 1
done
curl -s http://localhost:3004/health | grep -q '"registered":true' || { echo "[runner] gamehost never registered"; tail -10 /tmp/anim-gh.log; exit 1; }
echo "[runner] gamehost registered"

echo "[runner] running anim-relay-e2e.mjs..."
node scripts/anim-relay-e2e.mjs
EXIT=$?
echo "[runner] anim-relay exit: $EXIT"
exit $EXIT

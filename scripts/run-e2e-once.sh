#!/bin/bash
# One-shot full-stack E2E: embedded postgres + main + realtime + gamehost.
# The sandbox kills background processes between tool calls, so pg boot,
# the e2e run, and cleanup MUST happen inside this single invocation.
cd "$(dirname "$0")/.."

echo "[runner] starting embedded postgres..."
node scripts/start-pg.mjs > /tmp/pg.log 2>&1 &
PG_PID=$!

for i in $(seq 1 90); do
  grep -q PG-READY /tmp/pg.log 2>/dev/null && break
  # bail early if the process died
  kill -0 $PG_PID 2>/dev/null || break
  sleep 1
done

if ! grep -q PG-READY /tmp/pg.log; then
  echo "[runner] PG FAILED TO START:"
  tail -5 /tmp/pg.log
  kill $PG_PID 2>/dev/null
  exit 1
fi
echo "[runner] postgres ready (pid $PG_PID)"

# Verify TCP connectivity before running the suite
node -e "
const net = require('net');
const s = net.createConnection({ port: 5433, host: '127.0.0.1' }, () => { console.log('[runner] TCP 5433 reachable'); s.destroy(); process.exit(0); });
s.on('error', (e) => { console.log('[runner] TCP 5433 UNREACHABLE:', e.code); process.exit(1); });
setTimeout(() => { console.log('[runner] TCP probe timeout'); process.exit(1); }, 5000);
" || { kill $PG_PID 2>/dev/null; exit 1; }

bash scripts/test-e2e.sh
E2E_EXIT=$?

echo "[runner] e2e exit: $E2E_EXIT"
echo "[runner] stopping postgres..."
kill $PG_PID 2>/dev/null
# also clean any stray service processes the e2e script left
pkill -f "dist/main/index.js" 2>/dev/null
pkill -f "dist/realtime/index.js" 2>/dev/null
pkill -f "dist/gamehost/index.js" 2>/dev/null
exit $E2E_EXIT

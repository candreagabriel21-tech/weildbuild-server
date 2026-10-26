// E2E: verify game:move anim relay through the gamehost with two real
// socket.io clients. Boots nothing itself - expects main (8000) and
// gamehost (3004) already running (use scripts/run-anim-relay.sh or an
// equivalent boot). v1.1: the gamehost handshake now REQUIRES a signed
// session ticket (the register/login sessionToken works) - bare sockets
// are rejected with "Invalid session ticket".
import { io } from "socket.io-client";

const MAIN = "http://localhost:8000";
const ts = Date.now().toString(36).slice(-5);
const A = "animA_" + ts, B = "animB_" + ts;

async function api(method, path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["X-Session-Token"] = token;
  const res = await fetch(MAIN + "/api" + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  return data;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  // 1. Two accounts
  let r = await api("POST", "/auth", { action: "register", username: A, password: "testpass123" });
  const tokA = r.sessionToken;
  r = await api("POST", "/auth", { action: "register", username: B, password: "testpass123" });
  const tokB = r.sessionToken;
  if (!tokA || !tokB) { console.log("REGISTER FAILED", r); process.exit(1); }
  console.log("accounts ok:", A, B);

  // 2. Create a game as A
  r = await api("POST", "/games", { name: "AnimRelayTest", description: "e2e", public: true }, tokA);
  const gameId = r.id;
  if (!gameId) { console.log("GAME CREATE FAILED", r); process.exit(1); }
  console.log("game created:", gameId);

  // 3. Both join -> get socketUrl
  r = await api("POST", "/instances/join", { gameId }, tokA);
  const urlA = r.socketUrl, instA = r.instanceId;
  r = await api("POST", "/instances/join", { gameId }, tokB);
  const urlB = r.socketUrl, instB = r.instanceId;
  console.log("joined:", instA, urlA, "|", instB, urlB);
  if (!urlA || !urlB) { console.log("JOIN FAILED"); process.exit(1); }

  // 4. Connect both sockets (with signed tickets - the gamehost rejects
  //    unauthenticated handshakes). reconnection:false so a failure is a
  //    loud, immediate error instead of a silent hang.
  const sockA = io(urlA, { transports: ["websocket"], auth: { token: tokA }, reconnection: false });
  const sockB = io(urlB, { transports: ["websocket"], auth: { token: tokB }, reconnection: false });
  const failFast = (who) => (err) => { console.error(`✗ ${who} socket failed:`, err?.message || err); process.exit(1); };
  sockA.on("connect_error", failFast("A"));
  sockB.on("connect_error", failFast("B"));
  await Promise.all([
    new Promise(res => sockA.on("connect", res)),
    new Promise(res => sockB.on("connect", res)),
  ]);
  console.log("sockets connected (ticket-authenticated)");

  // 5. Both join the game room
  sockA.emit("game:join", { instanceId: instA, username: A, avatar: {} });
  sockB.emit("game:join", { instanceId: instB, username: B, avatar: {} });
  await sleep(800);

  // 6. B listens for playerMoved; A sends game:move WITH anim
  const received = [];
  sockB.on("game:playerMoved", (p) => {
    if (p.username === A) received.push(p);
  });

  sockA.emit("game:move", { instanceId: instA, position: [1, 2, 3], rotation: [0, 0.5, 0], anim: { walking: false, jumping: true, dying: false, sprint: false } });
  await sleep(600);
  sockA.emit("game:move", { instanceId: instA, position: [1, 5, 3], rotation: [0, 0.5, 0], anim: { walking: false, jumping: false, dying: true, sprint: false } });
  await sleep(600);
  sockA.emit("game:move", { instanceId: instA, position: [4, 2, 6], rotation: [0, 2.0, 0], anim: { walking: true, jumping: false, dying: false, sprint: true } });
  await sleep(800);

  // Also check the players-roster snapshot carries anim. The gamehost
  // broadcasts game:players on MEMBERSHIP CHANGES only (no periodic
  // broadcast), so B re-joins to trigger a fresh roster emit. A's roster
  // entry is untouched by B's re-join, so A's last relayed anim survives.
  sockA.emit("game:move", { instanceId: instA, position: [4, 2, 6], rotation: [0, 2.0, 0], anim: { walking: true, jumping: false, dying: false, sprint: true } });
  let playersSnapshot = null;
  sockB.on("game:players", (list) => {
    const me = (list || []).find(p => p.username === A);
    if (me) playersSnapshot = me;
  });
  await sleep(200);
  sockB.emit("game:join", { instanceId: instB, username: B, avatar: {} }); // roster refresh
  await sleep(700);

  // 7. Report
  console.log("\n═══ playerMoved relays received by B:", received.length);
  for (const p of received) {
    console.log("  pos:", JSON.stringify(p.position), "anim:", JSON.stringify(p.anim));
  }
  console.log("═══ players snapshot for A (as seen by B):", playersSnapshot ? JSON.stringify({ pos: playersSnapshot.position, anim: playersSnapshot.anim }) : "none");

  const jumpOk = received.some(p => p.anim?.jumping === true);
  const deathOk = received.some(p => p.anim?.dying === true);
  const walkSprintOk = received.some(p => p.anim?.walking === true && p.anim?.sprint === true);
  const snapshotOk = !!playersSnapshot?.anim;
  console.log("\nJUMP relay:", jumpOk ? "✓ WORKS" : "✗ BROKEN");
  console.log("DEATH relay:", deathOk ? "✓ WORKS" : "✗ BROKEN");
  console.log("WALK+SPRINT relay:", walkSprintOk ? "✓ WORKS" : "✗ BROKEN");
  console.log("SNAPSHOT anim:", playersSnapshot?.anim ? "✓ WORKS" : "✗ BROKEN");

  // 8. Also verify chat bubble relay quickly (B -> A)
  const chatSeen = [];
  sockA.on("game:chat", (c) => { if (c.username === B) chatSeen.push(c); });
  sockB.emit("game:chat", { instanceId: instB, username: B, message: "Hello from B!" });
  await sleep(500);
  console.log("CHAT relay:", chatSeen.length > 0 ? "✓ WORKS" : "✗ BROKEN");

  sockA.close(); sockB.close();
  process.exit((jumpOk && deathOk && walkSprintOk) ? 0 : 1);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });

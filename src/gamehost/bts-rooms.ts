// ═══════════════════════════════════════════════════════════
// WeildBuild GAME HOST, Build to Survive rooms (v7.1 pass 12)
// ═══════════════════════════════════════════════════════════
// Server-authoritative multiplayer for the pre-added "Build to Survive"
// game (fix 3: the client used to hard-route every pre-added game to
// solo - no socket, no other players, period).
//
// ARCHITECTURE (rides the EXISTING client machinery wherever possible):
//   • REMOTE PLAYERS: this module emits "game:state" snapshots in the
//     exact shape the world-runtime worker uses (players with position /
//     rotation / anim / hp), so GamePlayer + StudioPlayViewport render
//     the other players with ZERO new client rendering code. Client
//     movement stays client-owned (the v6.2.6 Roblox-style model): each
//     client reports its transform via game:pstate, we validate lightly
//     and relay it to the room.
//   • PLACED BLOCKS: blocks are ordinary studio part records with the
//     _bts marker, so they ride the snapshot "partUpdates" channel -
//     the client already adds unknown parts, merges updates and removes
//     { id, deleted: true } entries. A joiner gets every block as one
//     targeted keyframe; place/break/rotate rebroadcast to the room.
//   • THE GAME ITSELF (phases, the 7 disasters, zombies, HP, deaths,
//     plot claims) is simulated HERE at 10 Hz and broadcast on the
//     "bts:state" channel. The clients' BuildToSurviveManager switches
//     to a network mode: no local phase/disaster simulation, it just
//     applies snapshots and forwards place/break/rotate/claim requests.
//   • CLIENT-OWNED PHYSICS EFFECTS (tornado pull, meteor knockback):
//     positions are client-owned, so the snapshot carries the tornado /
//     explosion state and each client applies the forces to its own
//     body locally - exactly the solo code path.
//
// One BtsRoom per instance; rooms die with their instance (the same
// lifecycle the instance manager already owns).

import type { GameInstance, GameInstanceManager } from "./instances";

/** The pre-added game id the client joins with (LobbyView). */
export const BTS_GAME_ID = "preadded-build-to-survive";
/** True when an instance hosts the pre-added Build to Survive game. */
export function isBtsGameId(gameId: string): boolean {
  return gameId === BTS_GAME_ID;
}

// ─── Tuning (mirrors the client constants in platform/src/lib/build-to-survive.ts;
// duplicated on purpose - the server cannot import client code and MUST own
// the authoritative values) ───

const BUILD_TIME = 150; // 2:30 build phase (s)
const DISASTER_TIME = 20; // survive this long (s)
const MAX_HP = 100;
const INVINCIBLE_S = 3; // spawn invincibility (s)
const RESPAWN_S = 3; // dead -> respawn delay (s)
const PLACE_COOLDOWN_S = 0.18;
const BUILD_HEIGHT_MAX = 255;
const PLOT_FLOOR_Y = 0.625; // plot slab top - blocks rest on it

const TSUNAMI_SPEED = 14;
const TSUNAMI_DMG = 40; // per second caught
const FLOOD_RISE = 8;
const FLOOD_DMG = 12;
const FLOOD_MAX_Y = 80;
const FLOOD_RESET_HOLD = 3;
const METEORITE_INTERVAL = 1.2;
const METEORITE_SPEED_MIN = 28;
const METEORITE_SPEED_MAX = 55;
const METEORITE_RADIUS = 5;
const METEORITE_DMG = 60;
const METEORITE_SPAWN_Y = 255;
const ACID_DMG = 10;
const LAVA_DMG = 12;
const TORNADO_SPEED = 7;
const TORNADO_KILL = 3.2;
// pass 13 (bug 7): mirror the client's tripled range + doubled force so the
// server's instant-death touch radius and the (client-applied) pull agree on
// the same tuning. The pull itself runs on each client's own body.
const TORNADO_PULL_RANGE = 66;
const TORNADO_PULL = 36;
const MAP_HALF = 50;
// pass 13 (bug 10): the void floor - fall below this and you die (classic
// building-game rule). Matches the platform's physics voidY default (-50).
const VOID_Y = -50;

// pass 13 (zombies): only 5 zombies (the owner found 20 too many), they can't
// hit players who are high up (a vertical reach cap), and they navigate around
// walls instead of walking through them.
const ZOMBIE_COUNT = 5;
const ZOMBIE_SPEED = 4.5;
const ZOMBIE_TOUCH = 1.7;
// pass 13 (zombies): a zombie can only hit a player within this Y gap, so a
// player stood high up on a tower is safe even with a zombie directly below.
const ZOMBIE_VERTICAL = 2.2;
const ZOMBIE_DMG = 20;
const ZOMBIE_HIT_CD = 1.0;

const TICK_MS = 100; // sim + broadcast cadence (10 Hz)

const DISASTERS = ["tsunami", "flood", "meteorites", "acid_rain", "zombies", "lava", "tornado"] as const;
type DisasterId = (typeof DISASTERS)[number];
const DISASTER_NAMES: Record<DisasterId, string> = {
  tsunami: "Tsunami",
  flood: "Flood",
  meteorites: "Meteorites",
  acid_rain: "Acid Rain",
  zombies: "Zombie Apocalypse",
  lava: "The Ground is Lava",
  tornado: "Tornado",
};

/** The 4 claim plots (mirrors BTS_PLOTS in the client arena data). */
interface Plot {
  id: string;
  xMin: number; xMax: number; zMin: number; zMax: number;
}
const PLOTS: Plot[] = [
  { id: "plot1", xMin: 4, xMax: 49, zMin: -48.5, zMax: -3.5 },
  { id: "plot2", xMin: 4, xMax: 49, zMin: 4, zMax: 49 },
  { id: "plot3", xMin: -49, xMax: -4, zMin: 4, zMax: 49 },
  { id: "plot4", xMin: -49, xMax: -4, zMin: -48.5, zMax: -3.5 },
];
function plotAt(x: number, z: number): Plot | null {
  for (const p of PLOTS) {
    if (x >= p.xMin && x <= p.xMax && z >= p.zMin && z <= p.zMax) return p;
  }
  return null;
}

// ─── Room state types (wire shapes; the client mirrors these) ───

interface BtsPlayer {
  socketId: string;
  username: string;
  // Last accepted pstate report (client-owned movement, lightly checked).
  x: number; y: number; z: number;
  yaw: number;
  walking: boolean;
  jumping: boolean;
  sprint: boolean;
  // Life state (server-owned).
  hp: number;
  alive: boolean;
  deaths: number;
  survived: number;
  invincibleFor: number;
  respawnAt: number; // 0 = not waiting; epoch ms when the respawn fires
  respawnTp: { x: number; y: number; z: number } | null; // one-shot tp flag
  // pass 13 (bug 2): the tool this player is currently holding, so other
  // players see it glued to their fist (hammer/pickaxe/wrench). null = none.
  tool: 'hammer' | 'pickaxe' | 'wrench' | null;
}

interface BtsZombie {
  id: number;
  x: number; y: number; z: number;
  yaw: number;
  swingT: number; // 1 -> 0 attack arm animation
  hitCd: number;
  alive: boolean;
}

interface BtsMeteorite { id: number; x: number; y: number; z: number; vy: number; }
interface BtsExplosion { id: number; x: number; y: number; z: number; t: number; }

type Phase = "build" | "disaster" | "ended";

/** A placed block: the full studio part record (ridden to clients via the
 *  partUpdates channel) plus the grid cell it occupies. */
interface BtsBlock {
  id: string;
  record: Record<string, unknown>;
  cx: number; cz: number; cy: number;
}

// ─── The room ───

class BtsRoom {
  private players = new Map<string, BtsPlayer>();
  private blocks = new Map<string, BtsBlock>();
  private claims = new Map<string, string>(); // plotId -> username
  private zombieSeq = 1;
  private meteoriteSeq = 1;
  private explosionSeq = 1;

  phase: Phase = "build";
  buildTimer = BUILD_TIME;
  disasterT = 0;
  round = 1;
  disasterId: DisasterId | null = null;
  tsunamiZ = 0;
  floodY = 0;
  rain = false;
  lava = false;
  tornado: { x: number; z: number; t: number; dx: number; dz: number } | null = null;
  zombies: BtsZombie[] = [];
  meteorites: BtsMeteorite[] = [];
  explosions: BtsExplosion[] = [];

  private seq = 0;
  private lastPlaceAt = new Map<string, number>(); // socketId -> epoch ms

  constructor(
    private instance: GameInstance,
    private emitGameState: (payload: unknown, targetedSocketId?: string) => void,
    private emitBtsState: (payload: unknown) => void,
  ) {}

  // ─── Players ───

  join(socketId: string, username: string): void {
    this.players.set(socketId, {
      socketId,
      username,
      x: 0, y: 3, z: 0,
      yaw: 0,
      walking: false, jumping: false, sprint: false,
      hp: MAX_HP,
      alive: true,
      deaths: 0,
      survived: 0,
      invincibleFor: INVINCIBLE_S,
      respawnAt: 0,
      respawnTp: null,
      tool: null,
    });
    // Targeted join sync: every block so far (partUpdates keyframe) + the
    // roster. The room broadcast below carries the rest.
    this.emitGameState(
      {
        t: "snapshot",
        seq: ++this.seq,
        players: this.snapshotPlayers(),
        parts: [],
        partUpdates: [...this.blocks.values()].map((b) => b.record),
        fx: [],
        messages: [],
      },
      socketId,
    );
    this.broadcastBtsState(true);
    console.log(`[bts-rooms] ${username} joined instance ${this.instance.id} (${this.players.size}/${this.instance.maxPlayers})`);
  }

  leave(socketId: string): void {
    const p = this.players.get(socketId);
    this.players.delete(socketId);
    this.lastPlaceAt.delete(socketId);
    if (p) {
      // pass 13 (bug 1): when a player leaves, clear their plot + build so
      // the next player can claim a fresh, empty plot. (Pass 12 deliberately
      // kept them for rejoin-friendliness, but the owner wants a leave to
      // WIPE the plot - the build and the claim both go.)
      // 1. Drop every block on a plot this player owned.
      const removedBlocks: string[] = [];
      for (const [id, block] of Array.from(this.blocks)) {
        if (this.ownsBlockPlot(p, block)) {
          this.blocks.delete(id);
          removedBlocks.push(id);
        }
      }
      // 2. Release their plot claim(s).
      for (const [plotId, owner] of Array.from(this.claims)) {
        if (owner === p.username) this.claims.delete(plotId);
      }
      // 3. Broadcast the block deletions (one partUpdates batch) + a fresh
      //    bts:state so every client's claim labels + build update at once.
      if (removedBlocks.length > 0) {
        this.emitGameState({
          t: "snapshot",
          seq: ++this.seq,
          players: [],
          parts: [],
          partUpdates: removedBlocks.map((id) => ({ id, deleted: true })),
          fx: [],
          messages: [],
        });
      }
      this.broadcastBtsState(true);
      console.log(`[bts-rooms] ${p.username} left instance ${this.instance.id} (${this.players.size} remain) - plot + build cleared`);
    }
  }

  /** One pstate report (validated lightly - same spirit as the worker). */
  pstate(socketId: string, p: { x: number; y: number; z: number; yaw: number; walking: boolean; jumping: boolean; sprint: boolean }): void {
    const player = this.players.get(socketId);
    if (!player) return;
    player.x = p.x;
    player.y = p.y;
    player.z = p.z;
    player.yaw = p.yaw;
    player.walking = p.walking;
    player.jumping = p.jumping;
    player.sprint = p.sprint;
  }

  // ─── Actions (place / break / rotate / claim) ───

  action(socketId: string, payload: Record<string, unknown>): void {
    const player = this.players.get(socketId);
    if (!player) return;
    const kind = String(payload.kind || "");

    if (kind === "claim") {
      this.handleClaim(player, String(payload.plotId || ""));
      return;
    }
    // pass 13 (bug 2): tool selection is broadcast so other players see the
    // held tool. Valid in any phase (you can hold a tool while spectating).
    if (kind === "tool") {
      const t = String(payload.tool || "");
      const valid: 'hammer' | 'pickaxe' | 'wrench' | null =
        (t === 'hammer' || t === 'pickaxe' || t === 'wrench') ? t : null;
      if (player.tool !== valid) {
        player.tool = valid;
        this.broadcastBtsState(true);
      }
      return;
    }
    if (this.phase !== "build") return; // building only in the build phase

    if (kind === "place") {
      this.handlePlace(player, payload.part as Record<string, unknown> | undefined);
    } else if (kind === "break") {
      this.handleBreak(player, String(payload.id || ""));
    } else if (kind === "rotate") {
      this.handleRotate(player, String(payload.id || ""), payload.rotation as Record<string, unknown> | undefined);
    }
  }

  private handleClaim(player: BtsPlayer, plotId: string): void {
    const plot = PLOTS.find((p) => p.id === plotId);
    if (!plot) return;
    if (this.claims.has(plot.id)) return; // already taken
    // Standing-in-it check (the server only knows the reported position).
    const inside = player.x >= plot.xMin - 0.5 && player.x <= plot.xMax + 0.5 &&
      player.z >= plot.zMin - 0.5 && player.z <= plot.zMax + 0.5;
    if (!inside) return;
    this.claims.set(plot.id, player.username);
    this.broadcastBtsState(true);
    console.log(`[bts-rooms] ${player.username} claimed ${plot.id}`);
  }

  /** The plot a grid cell belongs to, or null. */
  private plotForCell(cx: number, cz: number): Plot | null {
    // A 1x1 block centred on (cx, cz) spans [cx-0.5, cx+0.5].
    return plotAt(cx, cz);
  }

  private handlePlace(player: BtsPlayer, part: Record<string, unknown> | undefined): void {
    if (!part || typeof part !== "object") return;
    // Anti-spam (matches the client's cooldown).
    const now = Date.now();
    const last = this.lastPlaceAt.get(player.socketId) || 0;
    if (now - last < PLACE_COOLDOWN_S * 1000 - 10) return;
    // The record must be a legit bts block (prevents clobbering arena
    // objects or injecting arbitrary studio parts).
    const id = String(part.id || "");
    const name = String(part.name || "");
    if (!id.startsWith("bts_placed_") || !name.startsWith("bts_placed_")) return;
    if (this.blocks.has(id)) return; // duplicate echo
    const type = String(part.type || "");
    if (!["Block", "Sphere", "Wedge"].includes(type)) return;
    const pos = part.position as { x?: number; y?: number; z?: number } | undefined;
    const size = part.size as { x?: number; y?: number; z?: number } | undefined;
    if (!pos || !size) return;
    const cx = Number(pos.x), cy = Number(pos.y), cz = Number(pos.z);
    if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz)) return;
    if (Math.abs(Number(size.x) - 1) > 0.01 || Math.abs(Number(size.y) - 1) > 0.01 || Math.abs(Number(size.z) - 1) > 0.01) return;
    if (cy + 0.5 > BUILD_HEIGHT_MAX) return;
    // The cell must sit inside a plot THIS player claimed.
    const plot = this.plotForCell(cx, cz);
    if (!plot || this.claims.get(plot.id) !== player.username) return;
    // Same-cell occupancy: no two blocks in one cell (first writer wins;
    // a racing client's optimistic local block simply never replicates).
    for (const b of this.blocks.values()) {
      if (b.cx === cx && b.cz === cz && Math.abs(b.cy - cy) < 0.9) return;
    }

    this.lastPlaceAt.set(player.socketId, now);
    const record = { ...part, _bts: true };
    this.blocks.set(id, { id, record, cx, cz, cy });
    // Immediate rebroadcast (blocks ride the partUpdates channel).
    this.emitGameState({
      t: "snapshot",
      seq: ++this.seq,
      players: [],
      parts: [],
      partUpdates: [record],
      fx: [],
      messages: [],
    });
  }

  private handleBreak(player: BtsPlayer, id: string): void {
    const block = this.blocks.get(id);
    if (!block) return;
    if (!this.ownsBlockPlot(player, block)) return;
    this.blocks.delete(id);
    this.emitGameState({
      t: "snapshot",
      seq: ++this.seq,
      players: [],
      parts: [],
      partUpdates: [{ id, deleted: true }],
      fx: [],
      messages: [],
    });
  }

  private handleRotate(player: BtsPlayer, id: string, rotation: Record<string, unknown> | undefined): void {
    const block = this.blocks.get(id);
    if (!block || !rotation) return;
    if (!this.ownsBlockPlot(player, block)) return;
    const rx = Number(rotation.x) || 0;
    const ry = Number(rotation.y) || 0;
    const rz = Number(rotation.z) || 0;
    block.record = { ...block.record, rotation: { x: rx, y: ry, z: rz } };
    this.emitGameState({
      t: "snapshot",
      seq: ++this.seq,
      players: [],
      parts: [],
      partUpdates: [block.record],
      fx: [],
      messages: [],
    });
  }

  private ownsBlockPlot(player: BtsPlayer, block: BtsBlock): boolean {
    const plot = this.plotForCell(block.cx, block.cz);
    return !!plot && this.claims.get(plot.id) === player.username;
  }

  // ─── Simulation (10 Hz) ───

  tick(dt: number): void {
    // Life state for everyone.
    for (const p of this.players.values()) {
      if (p.invincibleFor > 0) p.invincibleFor -= dt;
      // pass 13 (bug 10): void damage - fall below the void floor and die,
      // then respawn (classic building-game rule). Skipped during the spawn
      // invincibility window so a fresh join/respawn can't be void-killed by
      // a stale pstate report.
      if (p.alive && p.invincibleFor <= 0 && p.y < VOID_Y) {
        this.damage(p, MAX_HP + 1);
      }
      if (!p.alive && p.respawnAt > 0 && Date.now() >= p.respawnAt) {
        // Respawn: full hp + a one-shot tp to their plot (or map spawn).
        p.hp = MAX_HP;
        p.alive = true;
        p.invincibleFor = INVINCIBLE_S;
        p.respawnAt = 0;
        const own = [...this.claims.entries()].find(([, u]) => u === p.username);
        const plot = own ? PLOTS.find((q) => q.id === own[0]) : undefined;
        p.respawnTp = plot
          ? { x: (plot.xMin + plot.xMax) / 2, y: 5, z: (plot.zMin + plot.zMax) / 2 }
          : { x: 0, y: 5, z: 0 };
      }
    }

    if (this.phase === "build") {
      this.buildTimer -= dt;
      if (this.buildTimer <= 0) this.beginDisaster();
    } else if (this.phase === "disaster") {
      this.disasterT -= dt;
      this.tickDisaster(dt);
      if (this.disasterT <= 0) this.endDisaster();
    }

    // Age explosions (visual only).
    for (const e of this.explosions) e.t += dt;
    if (this.explosions.length) this.explosions = this.explosions.filter((e) => e.t < 1.2);
  }

  private beginDisaster(): void {
    const id = DISASTERS[Math.floor(Math.random() * DISASTERS.length)];
    this.phase = "disaster";
    this.disasterT = DISASTER_TIME;
    this.disasterId = id;
    this.tsunamiZ = -152.5;
    this.floodY = 0;
    this.rain = false;
    this.lava = false;
    this.meteorites = [];
    this.explosions = [];
    this.tornado = null;
    if (id === "zombies") this.spawnZombies();
    if (id === "tornado") this.tornado = { x: 0, z: 0, t: 0, dx: 1, dz: 0 };
    for (const p of this.players.values()) p.invincibleFor = Math.max(p.invincibleFor, INVINCIBLE_S);
    console.log(`[bts-rooms] instance ${this.instance.id}: disaster ${DISASTER_NAMES[id]} (round ${this.round})`);
  }

  private endDisaster(): void {
    for (const p of this.players.values()) {
      if (p.alive) p.survived++;
      p.hp = MAX_HP;
      p.alive = true;
      p.invincibleFor = INVINCIBLE_S;
      p.respawnAt = 0;
      p.respawnTp = null;
    }
    this.round++;
    this.phase = "build";
    this.buildTimer = BUILD_TIME;
    this.zombies = [];
    this.meteorites = [];
    this.explosions = [];
    this.tornado = null;
    this.disasterId = null;
    this.rain = false;
    this.lava = false;
  }

  private spawnZombies(): void {
    this.zombies = [];
    for (let i = 0; i < ZOMBIE_COUNT; i++) {
      const ang = (i / ZOMBIE_COUNT) * Math.PI * 2;
      const r = 2 + (i % 5);
      this.zombies.push({
        id: this.zombieSeq++,
        x: Math.cos(ang) * r,
        y: 0.5,
        z: Math.sin(ang) * r,
        yaw: 0,
        swingT: 0,
        hitCd: 0,
        alive: true,
      });
    }
  }

  private damage(player: BtsPlayer, amount: number): void {
    if (!player.alive || player.invincibleFor > 0) return;
    player.hp = Math.max(0, player.hp - amount);
    // pass 15: die at hp < 1, not hp <= 0. The HUD rounds HP UP (Math.ceil),
    // so a player at 0.9 hp looks like they have 1 hp left and never dies -
    // they get stuck "alive" with one displayed pip. < 1 catches that case
    // and any other sub-1 remainder from fractional-tick disaster damage.
    if (player.hp < 1) {
      player.hp = 0;
      player.alive = false;
      player.deaths++;
      player.respawnAt = Date.now() + RESPAWN_S * 1000;
      player.respawnTp = null; // set when the respawn fires
    }
  }

  private tickDisaster(dt: number): void {
    const id = this.disasterId;
    if (!id) return;

    if (id === "tsunami") {
      this.tsunamiZ += TSUNAMI_SPEED * dt;
      for (const p of this.players.values()) {
        if (this.tsunamiZ >= p.z && p.y < this.tsunamiZ + 6) this.damage(p, TSUNAMI_DMG * dt);
      }
    } else if (id === "flood") {
      if (this.floodY < FLOOD_MAX_Y) {
        this.floodY = Math.min(FLOOD_MAX_Y, this.floodY + FLOOD_RISE * dt);
      } else if (this.disasterT < DISASTER_TIME - FLOOD_MAX_Y / FLOOD_RISE - FLOOD_RESET_HOLD) {
        this.floodY = Math.max(0, this.floodY - FLOOD_RISE * 2 * dt);
      }
      for (const p of this.players.values()) {
        if (p.y < this.floodY) this.damage(p, FLOOD_DMG * dt);
      }
    } else if (id === "meteorites") {
      if (Math.random() < dt / METEORITE_INTERVAL) {
        const half = MAP_HALF - 2;
        this.meteorites.push({
          id: this.meteoriteSeq++,
          x: (Math.random() * 2 - 1) * half,
          y: METEORITE_SPAWN_Y,
          z: (Math.random() * 2 - 1) * half,
          vy: METEORITE_SPEED_MIN + Math.random() * (METEORITE_SPEED_MAX - METEORITE_SPEED_MIN),
        });
      }
      for (const m of this.meteorites) {
        m.y -= m.vy * dt;
        if (m.y <= 0.5) {
          this.explosions.push({ id: this.explosionSeq++, x: m.x, y: 0.5, z: m.z, t: 0 });
          for (const p of this.players.values()) {
            const dx = p.x - m.x, dz = p.z - m.z;
            const dist = Math.sqrt(dx * dx + p.y * p.y + dz * dz);
            if (dist < METEORITE_RADIUS) this.damage(p, METEORITE_DMG * (1 - dist / METEORITE_RADIUS));
          }
          m.y = -999;
        }
      }
      if (this.meteorites.length) this.meteorites = this.meteorites.filter((m) => m.y > -100);
    } else if (id === "acid_rain") {
      this.rain = true;
      for (const p of this.players.values()) {
        if (this.isSkyExposed(p)) this.damage(p, ACID_DMG * dt);
      }
    } else if (id === "zombies") {
      this.tickZombies(dt);
    } else if (id === "lava") {
      this.lava = true;
      for (const p of this.players.values()) {
        if (p.y < 1.5) this.damage(p, LAVA_DMG * dt);
      }
    } else if (id === "tornado" && this.tornado) {
      const t = this.tornado;
      t.t += dt;
      if (t.t > 2.2) {
        t.t = 0;
        const ang = Math.random() * Math.PI * 2;
        t.dx = Math.cos(ang);
        t.dz = Math.sin(ang);
      }
      t.x += t.dx * TORNADO_SPEED * dt;
      t.z += t.dz * TORNADO_SPEED * dt;
      const half = MAP_HALF - 4;
      if (Math.abs(t.x) > half) t.dx = -Math.sign(t.x);
      if (Math.abs(t.z) > half) t.dz = -Math.sign(t.z);
      t.x = Math.max(-half, Math.min(half, t.x));
      t.z = Math.max(-half, Math.min(half, t.z));
      for (const p of this.players.values()) {
        const dx = t.x - p.x, dz = t.z - p.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist < TORNADO_KILL) this.damage(p, MAX_HP + 1); // instant death
      }
      // The PULL force is applied by each client to its own body (movement
      // is client-owned) - the tornado's position rides the snapshot.
    }
  }

  /** True when no placed block sits above the player at their cell. */
  private isSkyExposed(p: BtsPlayer): boolean {
    const cx = Math.round(p.x), cz = Math.round(p.z);
    for (const b of this.blocks.values()) {
      if (b.cx === cx && b.cz === cz && b.cy > p.y + 0.5) return false;
    }
    return true;
  }

  /** pass 13 (zombies): is the grid cell (cx, cz) blocked near the ground for a
   *  zombie at height atY? A 1-stud block at centre cy blocks the zombie's
   *  ~1.8-tall body when its span (cy±0.5) overlaps the zombie's body
   *  (atY-0.4 .. atY+1.4). Used by the wall-avoidance step so zombies route
   *  around placed walls instead of clipping through them. */
  private zombieCellBlocked(cx: number, cz: number, atY: number): boolean {
    for (const b of this.blocks.values()) {
      if (b.cx !== cx || b.cz !== cz) continue;
      const bottom = b.cy - 0.5;
      const top = b.cy + 0.5;
      if (bottom < atY + 1.4 && top > atY - 0.4) return true;
    }
    return false;
  }

  private tickZombies(dt: number): void {
    for (const z of this.zombies) {
      if (!z.alive) continue;
      // Chase the NEAREST living player (solo chased the only player).
      let target: BtsPlayer | null = null;
      let bestDist = Infinity;
      for (const p of this.players.values()) {
        if (!p.alive) continue;
        const dx = p.x - z.x, dz = p.z - z.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist < bestDist) { bestDist = dist; target = p; }
      }
      if (!target) continue;
      const dx = target.x - z.x, dz = target.z - z.z;
      const dist = Math.max(0.001, Math.sqrt(dx * dx + dz * dz));
      const sp = ZOMBIE_SPEED * dt;
      // pass 13 (zombies): wall avoidance. Step axis-by-axis so a zombie
      // routes around a solid block instead of clipping through it; if the
      // next cell on an axis is blocked, that axis holds and the zombie
      // slides along the other (both blocked = idle this tick).
      const stepX = (dx / dist) * sp;
      const stepZ = (dz / dist) * sp;
      const nx = z.x + stepX, nz = z.z + stepZ;
      const blockedX = this.zombieCellBlocked(Math.round(nx), Math.round(z.z), z.y);
      const blockedZ = this.zombieCellBlocked(Math.round(z.x), Math.round(nz), z.y);
      if (!blockedX && !blockedZ) { z.x = nx; z.z = nz; }
      else if (!blockedX) { z.x = nx; }
      else if (!blockedZ) { z.z = nz; }
      z.yaw = Math.atan2(target.x - z.x, target.z - z.z);
      if (z.hitCd > 0) z.hitCd -= dt;
      if (z.swingT > 0) z.swingT = Math.max(0, z.swingT - dt * 3);
      // pass 13 (zombies): a zombie can only hit a player within ZOMBIE_VERTICAL
      // on Y - so a player stood high up on a tower is safe, even with a zombie
      // directly below (the old check ignored Y entirely).
      const dy = target.y - z.y;
      if (dist < ZOMBIE_TOUCH && Math.abs(dy) < ZOMBIE_VERTICAL && z.hitCd <= 0 && target.alive) {
        z.hitCd = ZOMBIE_HIT_CD;
        z.swingT = 1;
        this.damage(target, ZOMBIE_DMG);
      }
    }
  }

  // ─── Snapshots ───

  /** game:state player entries (the exact shape the worker emits, so the
   *  existing client renders remote players + applies self life state). */
  private snapshotPlayers(): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const p of this.players.values()) {
      const entry: Record<string, unknown> = {
        socketId: p.socketId,
        username: p.username,
        position: [p.x, p.y, p.z],
        rotation: [0, p.yaw, 0],
        anim: { walking: p.walking, jumping: p.jumping, sprint: p.sprint, dying: !p.alive },
        hp: p.hp,
        dying: !p.alive,
      };
      // pass 13 (bug 2): the held tool rides the player entry so the client's
      // remote-player renderer can glue the right model to each player's fist.
      if (p.tool) entry.btsTool = p.tool;
      if (p.respawnTp) {
        // One-shot teleport: the position fields hold the TARGET (wire
        // contract the client already implements for spawn/respawn tps).
        entry.position = [p.respawnTp.x, p.respawnTp.y, p.respawnTp.z];
        entry.tp = true;
      }
      out.push(entry);
    }
    return out;
  }

  private broadcastGameState(): void {
    this.emitGameState({
      t: "snapshot",
      seq: ++this.seq,
      players: this.snapshotPlayers(),
      parts: [],
      partUpdates: [],
      fx: [],
      messages: [],
    });
  }

  private broadcastBtsState(force = false): void {
    // The tick caller broadcasts at the full 10 Hz cadence; `force` marks
    // event-driven sends (join, claim) that must go out immediately.
    void force;
    const claims: Record<string, string> = {};
    for (const [plotId, username] of this.claims) claims[plotId] = username;
    const players: Record<string, { username: string; hp: number; alive: boolean; deaths: number; survived: number }> = {};
    for (const p of this.players.values()) {
      players[p.socketId] = { username: p.username, hp: p.hp, alive: p.alive, deaths: p.deaths, survived: p.survived };
    }
    this.emitBtsState({
      seq: this.seq,
      phase: this.phase,
      buildTimer: Math.max(0, this.buildTimer),
      disasterT: Math.max(0, this.disasterT),
      round: this.round,
      disaster: {
        id: this.disasterId,
        name: this.disasterId ? DISASTER_NAMES[this.disasterId] : "",
        tsunamiZ: this.tsunamiZ,
        floodY: this.floodY,
        rain: this.rain,
        lava: this.lava,
        tornado: this.tornado ? { x: this.tornado.x, z: this.tornado.z, t: this.tornado.t } : null,
        meteorites: this.meteorites,
        explosions: this.explosions,
      },
      zombies: this.zombies,
      players,
      claims,
    });
  }

  /** One sim step + the 10 Hz broadcasts. */
  step(): void {
    this.tick(TICK_MS / 1000);
    this.broadcastGameState();
    this.broadcastBtsState();
    // Clear one-shot tps after they have ridden a full broadcast.
    for (const p of this.players.values()) p.respawnTp = null;
  }

  get playerCount(): number {
    return this.players.size;
  }
}

// ─── Manager (one room per instance, dies with it) ───

type GameStateListener = (instanceId: string, payload: unknown, targetedSocketId?: string) => void;
type BtsStateListener = (instanceId: string, payload: unknown) => void;

export class BtsRoomManager {
  private rooms = new Map<string, { room: BtsRoom; timer: NodeJS.Timeout }>();
  private gameStateListeners: GameStateListener[] = [];
  private btsStateListeners: BtsStateListener[] = [];
  private sweeper: NodeJS.Timeout;

  constructor(private manager: GameInstanceManager) {
    // Dispose rooms whose instance vanished (the empty-grace sweeper
    // closed it) - same pattern as WorldSimManager.
    this.sweeper = setInterval(() => {
      for (const [id, entry] of Array.from(this.rooms)) {
        if (!this.manager.getInstance(id)) this.disposeRoom(id);
      }
    }, 5000);
  }

  onGameState(cb: GameStateListener): void {
    this.gameStateListeners.push(cb);
  }

  onBtsState(cb: BtsStateListener): void {
    this.btsStateListeners.push(cb);
  }

  /** Boot (idempotent) the room for an instance. */
  ensureRoom(instance: GameInstance): void {
    const existing = this.rooms.get(instance.id);
    if (existing) return;
    const room = new BtsRoom(
      instance,
      (payload, targetedSocketId) => {
        for (const cb of this.gameStateListeners) cb(instance.id, payload, targetedSocketId);
      },
      (payload) => {
        for (const cb of this.btsStateListeners) cb(instance.id, payload);
      },
    );
    const timer = setInterval(() => {
      // Pause the sim while nobody is in the room (the instance empties
      // into its grace window before disposal).
      if (room.playerCount > 0) room.step();
    }, TICK_MS);
    this.rooms.set(instance.id, { room, timer });
    console.log(`[bts-rooms] room booted for instance ${instance.id} (game ${instance.gameId})`);
  }

  join(instanceId: string, socketId: string, username: string): void {
    this.rooms.get(instanceId)?.room.join(socketId, username);
  }

  leave(instanceId: string, socketId: string): void {
    this.rooms.get(instanceId)?.room.leave(socketId);
  }

  pstate(instanceId: string, socketId: string, p: { x: number; y: number; z: number; yaw: number; walking: boolean; jumping: boolean; sprint: boolean }): void {
    this.rooms.get(instanceId)?.room.pstate(socketId, p);
  }

  action(instanceId: string, socketId: string, payload: Record<string, unknown>): void {
    this.rooms.get(instanceId)?.room.action(socketId, payload);
  }

  private disposeRoom(instanceId: string): void {
    const entry = this.rooms.get(instanceId);
    if (!entry) return;
    clearInterval(entry.timer);
    this.rooms.delete(instanceId);
    console.log(`[bts-rooms] room disposed for instance ${instanceId}`);
  }

  stopAll(): void {
    clearInterval(this.sweeper);
    for (const id of Array.from(this.rooms.keys())) this.disposeRoom(id);
  }
}

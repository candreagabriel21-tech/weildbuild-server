// ═══════════════════════════════════════════════════════════════════
// WeildBuild - Build to Survive: the pre-added game's client simulation.
// ═══════════════════════════════════════════════════════════════════
// Self-contained building + disaster-survival system that activates inside
// StudioPlayViewport when gameMode === 'build-to-survive'. Mirrors the
// Tower Sword Fight pattern: a plain class that ticks in useFrame, reads
// the player's live transform through a bridge, and drives the studio
// store / physics world for damage + placed-block collision.
//
// PHASES: build (5 min, claim a plot, place/break parts, saves to the
// device) -> disaster (one of 7: tsunami, flood, meteorites, acid rain,
// zombies, the ground is lava, tornado) -> next round (keep your build).
//
// PLACED BLOCKS are real studio objects added via useStudioStore.addObject,
// so the existing PartMesh renders them and rebuildIfNeeded() (which fires
// when the store's object count changes) gives them physics colliders -
// players stand on them with no manual body juggling. The manager keeps a
// parallel Map of the blocks it owns (name prefix 'bts_placed_') for
// save/load, break targets, and stack-height queries.
//
// NOTE (single-player): pre-added games route to serverStatus="solo" (no
// gamehost socket), exactly like Tower Sword Fight. True 4-player
// multiplayer would need the gamehost worker to run this sim server-side.

import * as THREE from 'three';
import { useStudioStore } from './studio-store';
import {
  BTS_PLOTS, BTS_DISASTER, BTS_DISASTERS, BTS_DISASTER_NAMES,
  type BtsPlot, type BtsDisasterId,
} from '@/data/buildToSurviveArena';
import { BTS_PARTS, type BtsPartDef } from '@/data/buildToSurviveItems';

// ─── Constants ───
const BTS_MAX_HP = 100;
const BTS_INVINCIBLE = 3;          // spawn invincibility (s)
const BTS_BUILD_TIME = BTS_DISASTER.BUILD_TIME_SECONDS;     // 300
const BTS_DISASTER_TIME = 60;      // survive this long
const BTS_BLOCK_SIZE = 1;          // grid cell size
const BTS_BREAK_HOLD = 2;          // hold to break (s) - spec
const BTS_PLACE_COOLDOWN = 0.18;   // anti-spam between placements (s)

// Zombie tuning (spec: 20 zombies, 20 dmg on touch, forest-green + plain shirt + camo pants + spooked face)
const BTS_ZOMBIE_COUNT = BTS_DISASTER.ZOMBIE_COUNT;
const BTS_ZOMBIE_SPEED = 4.5;
const BTS_ZOMBIE_TOUCH = 1.7;      // touch range
const BTS_ZOMBIE_DMG = 20;         // spec
const BTS_ZOMBIE_HIT_CD = 1.0;     // per-zombie attack cooldown
const BTS_ZOMBIE_SOUND_INTERVAL = 5; // random groan every ~5s
const BTS_ZOMBIE_SPAWN = BTS_DISASTER.ZOMBIE_SPAWN;

// Disasters
const BTS_TSUNAMI_SPEED = 14;      // z-units/sec the wall advances
const BTS_TSUNAMI_DMG = 40;        // per second caught in the water
const BTS_FLOOD_RISE = 8;          // y-units/sec the flood rises
const BTS_FLOOD_DMG = 12;          // per second submerged
const BTS_METEORITE_INTERVAL = 1.2;// spawn a meteorite every ~1.2s
const BTS_METEORITE_SPEED_MIN = 28;
const BTS_METEORITE_SPEED_MAX = 55;
const BTS_METEORITE_RADIUS = 5;    // explosion radius (like TSF bomb)
const BTS_METEORITE_DMG = 60;      // at centre
const BTS_ACID_DMG = 10;           // per second sky-exposed (spec)
const BTS_LAVA_DMG = 12;           // per second on the baseplate (spec)
const BTS_TORNADO_SPEED = 7;       // wander speed
const BTS_TORNADO_PULL = 18;       // pull strength
const BTS_TORNADO_PULL_RANGE = 22; // starts pulling within this
const BTS_TORNADO_KILL = 3.2;      // touch = death

// The zombie avatar (spec: forest green skin, plain shirt, camo pants, spooked face).
export const BTS_ZOMBIE_AVATAR = {
  face: 'FACE-3',     // Spooked Face
  skin: '#228B22',    // forest green
  shirt: 'SHIRT-9',   // Plain Shirt
  left_leg: 'PANTS-3',// camo (#556B2F)
  right_leg: 'PANTS-3',
};

// ─── Bridges (host writes these each frame; the manager reads them) ───
export interface BtsPlayerBridge {
  x: number; y: number; z: number;
  bodyYaw: number;
  camDir: [number, number, number]; // camera look direction (normalized)
  grounded: boolean;
}
export const BTS_PLAYER_BRIDGE: BtsPlayerBridge = {
  x: 0, y: 0, z: 0, bodyYaw: 0, camDir: [0, 0, -1], grounded: true,
};

export const BTS_AIM: { camera: THREE.Camera | null; dom: HTMLElement | null } = {
  camera: null, dom: null,
};
export function setBtsAimCamera(camera: THREE.Camera | null, dom: HTMLElement | null) {
  BTS_AIM.camera = camera;
  BTS_AIM.dom = dom;
}

// ─── Types ───
export type BtsPhase = 'build' | 'disaster' | 'ended';
export type BtsMode = 'place' | 'break' | null;

export interface BtsPlacedBlock {
  id: string;
  shape: BtsPartDef['shape'];
  color: string;
  cell: [number, number];     // integer grid cell [cx, cz]
  y: number;                  // centre y
  sizeY: number;
}

export interface BtsZombie {
  id: number;
  x: number; y: number; z: number;
  yaw: number;
  swingT: number;             // arm-swing animation timer (0..1), >0 while attacking
  hitCd: number;              // attack cooldown
  soundCd: number;            // random groan cooldown
  alive: boolean;
}

export interface BtsMeteorite { id: number; x: number; y: number; z: number; vy: number; }
export interface BtsExplosion { id: number; x: number; y: number; z: number; t: number; }
export interface BtsGhost {
  visible: boolean; valid: boolean; mode: BtsMode;
  shape: BtsPlacedBlock['shape']; color: string;
  x: number; y: number; z: number; sizeY: number;
  breakId: string | null; breakProgress: number; // 0..1
}

export interface BtsDisasterState {
  id: BtsDisasterId | null;
  name: string;
  t: number;                   // elapsed in disaster phase
  // visuals:
  tsunamiZ: number;            // the wall's current z
  floodY: number;              // the flood water's current top y
  meteorites: BtsMeteorite[];
  explosions: BtsExplosion[];
  tornado: { x: number; z: number; t: number } | null;
  rain: boolean;
  lava: boolean;
}

export interface BtsSnapshot {
  active: boolean;
  phase: BtsPhase;
  buildTimer: number;          // seconds left in build phase
  disasterT: number;           // seconds left in disaster phase
  round: number;
  claimedPlotId: string | null;
  mode: BtsMode;
  selectedPartId: string | null;
  ghost: BtsGhost;
  disaster: BtsDisasterState;
  zombies: BtsZombie[];
  player: { hp: number; max: number; alive: boolean; deaths: number; survived: number };
  rev: number;
}

// ─── Helpers ───
function gridSnap(v: number): number { return Math.round(v / BTS_BLOCK_SIZE) * BTS_BLOCK_SIZE; }

/** Which plot (if any) contains a horizontal position. */
export function btsPlotAt(x: number, z: number): BtsPlot | null {
  for (const p of BTS_PLOTS) {
    if (x >= p.xMin && x <= p.xMax && z >= p.zMin && z <= p.zMax) return p;
  }
  return null;
}

/** Build a studio object for a placed part (added via addObject -> auto render + collide). */
let btsIdCounter = 1;
function makePlacedPart(def: BtsPartDef, cx: number, cy: number, cz: number): any {
  const id = `bts_placed_${Date.now().toString(36)}_${btsIdCounter++}`;
  const isSphere = def.shape === 'Sphere';
  const isWedge = def.shape === 'Wedge';
  return {
    id,
    name: `bts_placed_${def.id}`,
    type: def.shape,
    position: { x: cx, y: cy, z: cz },
    size: { x: BTS_BLOCK_SIZE, y: BTS_BLOCK_SIZE, z: BTS_BLOCK_SIZE },
    rotation: { x: 0, y: 0, z: 0 },
    color: def.color,
    material: 'Plastic',
    transparency: 0,
    reflectance: 0,
    anchored: true,
    canCollide: true,
    friction: 0.5,
    elasticity: 0.2,
    density: 1,
    bodyMovers: [],
    effects: [],
    isSpawnPoint: false,
    isBaseplate: false,
    children: [],
    parentId: null,
    _bts: true, // tag (non-enumerable-ish; harmless if persisted)
    // sphere/wedge renderers read size as full extents, same as studio blocks
    _shape: def.shape,
  };
}

// ═══════════════════════════════════════════════════════════════════
// The manager
// ═══════════════════════════════════════════════════════════════════
export class BuildToSurviveManager {
  active = false;
  started = false;

  phase: BtsPhase = 'build';
  buildTimer = BTS_BUILD_TIME;
  disasterT = 0;
  round = 1;

  claimedPlot: BtsPlot | null = null;
  placed = new Map<string, BtsPlacedBlock>();   // id -> block record (manager-owned)

  mode: BtsMode = null;
  selectedPartId: string | null = null;
  private placeCd = 0;
  private breakHoldId: string | null = null;
  private breakHoldT = 0;

  zombies: BtsZombie[] = [];
  private zombieId = 1;
  private meteoriteId = 1;
  private explosionId = 1;
  meteorites: BtsMeteorite[] = [];
  explosions: BtsExplosion[] = [];
  tornado: { x: number; z: number; t: number; dx: number; dz: number } | null = null;

  disaster: BtsDisasterState = {
    id: null, name: '', t: 0,
    tsunamiZ: 0, floodY: 0, meteorites: [], explosions: [],
    tornado: null, rain: false, lava: false,
  };

  player = { hp: BTS_MAX_HP, max: BTS_MAX_HP, alive: true, deaths: 0, survived: 0 };
  private invincibleFor = BTS_INVINCIBLE;
  private playerPos = new THREE.Vector3();
  private camDir = new THREE.Vector3();

  rev = 0;

  // callbacks (wired by the host)
  private onPlayerHurtCb?: (hp: number, max: number) => void;
  private onPlayerDieCb?: () => void;
  private onPhaseCb?: (phase: BtsPhase, disaster: BtsDisasterId | null) => void;
  private playSoundCb?: (name: string, vol?: number) => void;

  onPlayerHurt(cb: (hp: number, max: number) => void) { this.onPlayerHurtCb = cb; }
  onPlayerDie(cb: () => void) { this.onPlayerDieCb = cb; }
  onPhaseChange(cb: (phase: BtsPhase, disaster: BtsDisasterId | null) => void) { this.onPhaseCb = cb; }
  setPlaySound(cb: (name: string, vol?: number) => void) { this.playSoundCb = cb; }

  // ─── Lifecycle ───
  tryStart(): boolean {
    if (this.started) return true;
    // The arena is loaded by the time the manager is constructed; nothing
    // extra to probe (plots are constants). Start immediately.
    this.started = true;
    this.active = true;
    this.phase = 'build';
    this.buildTimer = BTS_BUILD_TIME;
    this.onPhaseCb?.('build', null);
    return true;
  }

  stop() {
    this.active = false;
    this.started = false;
    // Remove every placed block from the studio store so they don't leak
    // into the next game (the save in localStorage persists them).
    const store = useStudioStore.getState();
    for (const id of this.placed.keys()) {
      try { store.removeObject(id); } catch { /* already gone */ }
    }
    this.placed.clear();
    this.zombies = [];
    this.meteorites = [];
    this.explosions = [];
    this.tornado = null;
    this.mode = null;
    this.selectedPartId = null;
  }

  // ─── Plot claim ───
  claimPlot(): { ok: boolean; reason?: string; plot?: BtsPlot } {
    if (this.claimedPlot) return { ok: false, reason: 'already claimed' };
    const p = btsPlotAt(this.playerPos.x, this.playerPos.z);
    if (!p) return { ok: false, reason: 'stand on a plot to claim it' };
    this.claimedPlot = p;
    // Load any saved build for this plot from the device.
    this.loadBuild(p.id);
    this.playSoundCb?.('bts_claim', 0.6);
    return { ok: true, plot: p };
  }

  /** The cell the player is aiming at (in front of them, snapped to the grid). */
  private aimCell(): { cx: number; cz: number; valid: boolean } {
    const d = this.camDir;
    const horiz = new THREE.Vector3(d.x, 0, d.z);
    if (horiz.lengthSq() < 1e-4) horiz.set(0, 0, -1);
    horiz.normalize();
    const reach = 4.5;
    const tx = this.playerPos.x + horiz.x * reach;
    const tz = this.playerPos.z + horiz.z * reach;
    const cx = gridSnap(tx);
    const cz = gridSnap(tz);
    const valid = !!this.claimedPlot &&
      cx >= this.claimedPlot.xMin && cx <= this.claimedPlot.xMax &&
      cz >= this.claimedPlot.zMin && cz <= this.claimedPlot.zMax &&
      (this.playerPos.y + 8) < BTS_DISASTER.BUILD_HEIGHT_MAX;
    return { cx, cz, valid };
  }

  /** Top surface y at a cell (baseplate top 0.5, or the highest placed block there). */
  private cellTopY(cx: number, cz: number): number {
    let top = 0.5; // baseplate top
    for (const b of this.placed.values()) {
      if (b.cell[0] === cx && b.cell[1] === cz) {
        const t = b.y + b.sizeY / 2;
        if (t > top) top = t;
      }
    }
    return top;
  }

  private topBlockAt(cx: number, cz: number): BtsPlacedBlock | null {
    let best: BtsPlacedBlock | null = null;
    let bestTop = -Infinity;
    for (const b of this.placed.values()) {
      if (b.cell[0] === cx && b.cell[1] === cz) {
        const t = b.y + b.sizeY / 2;
        if (t > bestTop) { bestTop = t; best = b; }
      }
    }
    return best;
  }

  // ─── Part selection / mode ───
  selectPart(partId: string | null) {
    if (partId === null) { this.mode = null; this.selectedPartId = null; return; }
    this.selectedPartId = partId;
    this.mode = 'place';
    this.breakHoldId = null; this.breakHoldT = 0;
  }
  setMode(mode: BtsMode) {
    this.mode = mode;
    if (mode !== 'break') { this.breakHoldId = null; this.breakHoldT = 0; }
    if (mode === null) this.selectedPartId = null;
  }
  /** Skip the rest of the build phase and start the disaster now. */
  startDisasterNow() {
    if (this.phase === 'build') this.beginDisaster();
  }

  // ─── Place / break (triggered by the host on click / tap) ───
  private placeAtGhost() {
    if (this.phase !== 'build' || !this.claimedPlot || this.mode !== 'place' || !this.selectedPartId) return;
    if (this.placeCd > 0) return;
    const def = BTS_PARTS.find(p => p.id === this.selectedPartId);
    if (!def) return;
    const { cx, cz, valid } = this.aimCell();
    if (!valid) return;
    const top = this.cellTopY(cx, cz);
    const sizeY = BTS_BLOCK_SIZE;
    const cy = top + sizeY / 2;
    if (cy + sizeY / 2 > BTS_DISASTER.BUILD_HEIGHT_MAX) return;
    const part = makePlacedPart(def, cx, cy, cz);
    try {
      useStudioStore.getState().addObject(part);
    } catch { return; }
    this.placed.set(part.id, {
      id: part.id, shape: def.shape, color: def.color,
      cell: [cx, cz], y: cy, sizeY,
    });
    this.placeCd = BTS_PLACE_COOLDOWN;
    this.playSoundCb?.('bts_place', 0.5);
    this.saveBuild();
  }

  /** Break button held: progress toward removing the top block at the aim cell. */
  private tickBreak(dt: number) {
    if (this.phase !== 'build' || this.mode !== 'break' || !this.claimedPlot) {
      this.breakHoldId = null; this.breakHoldT = 0; return;
    }
    const { cx, cz } = this.aimCell();
    const top = this.topBlockAt(cx, cz);
    if (!top) { this.breakHoldId = null; this.breakHoldT = 0; return; }
    if (this.breakHoldId !== top.id) { this.breakHoldId = top.id; this.breakHoldT = 0; }
    this.breakHoldT += dt;
    if (this.breakHoldT >= BTS_BREAK_HOLD) {
      try { useStudioStore.getState().removeObject(top.id); } catch { /* gone */ }
      this.placed.delete(top.id);
      this.breakHoldId = null; this.breakHoldT = 0;
      this.playSoundCb?.('bts_break', 0.6);
      this.saveBuild();
    }
  }

  /** Host calls this on the place/break trigger key or button. */
  triggerAction() {
    if (this.phase !== 'build') return;
    if (this.mode === 'place') this.placeAtGhost();
    // break uses the hold timer in tick(), not a one-shot trigger.
  }

  // ─── Save / load (per device, per plot) ───
  private saveKey() { return this.claimedPlot ? `bts_build_${this.claimedPlot.id}` : ''; }
  private saveBuild() {
    if (!this.claimedPlot) return;
    try {
      const rows = [...this.placed.values()].map(b => ({
        shape: b.shape, color: b.color, cell: b.cell, y: b.y, sizeY: b.sizeY,
      }));
      localStorage.setItem(this.saveKey(), JSON.stringify(rows));
    } catch { /* storage full / disabled */ }
  }
  private loadBuild(plotId: string) {
    let rows: any[] = [];
    try { rows = JSON.parse(localStorage.getItem(`bts_build_${plotId}`) || '[]'); } catch { rows = []; }
    if (!Array.isArray(rows) || rows.length === 0) return;
    for (const r of rows) {
      const def = BTS_PARTS.find(p => p.shape === r.shape && p.color === r.color) || BTS_PARTS[0];
      const part = makePlacedPart(def, r.cell[0], r.y, r.cell[1]);
      part.color = r.color; part._shape = r.shape;
      try { useStudioStore.getState().addObject(part); } catch { continue; }
      this.placed.set(part.id, {
        id: part.id, shape: r.shape, color: r.color,
        cell: r.cell as [number, number], y: r.y, sizeY: r.sizeY,
      });
    }
  }

  // ─── Damage / death ───
  damagePlayer(amount: number) {
    if (!this.active || !this.player.alive) return;
    if (this.invincibleFor > 0) return;
    this.player.hp = Math.max(0, this.player.hp - amount);
    this.onPlayerHurtCb?.(this.player.hp, this.player.max);
    if (this.player.hp <= 0) {
      this.player.alive = false;
      this.player.deaths++;
      this.playSoundCb?.('scream', 0.5);
      this.onPlayerDieCb?.();
    }
  }
  /** Host calls this after respawning the character. */
  revivePlayer() {
    this.player.hp = this.player.max;
    this.player.alive = true;
    this.invincibleFor = BTS_INVINCIBLE;
  }
  getRespawnPoint(): [number, number, number] {
    if (this.claimedPlot) {
      const c = this.claimedPlot.center;
      return [c[0], 5, c[2]];
    }
    return [0, 5, 0];
  }

  // ─── Phase transitions ───
  private beginDisaster() {
    const id = BTS_DISASTERS[Math.floor(Math.random() * BTS_DISASTERS.length)];
    this.phase = 'disaster';
    this.disasterT = BTS_DISASTER_TIME;
    this.disaster = {
      id, name: BTS_DISASTER_NAMES[id], t: 0,
      tsunamiZ: BTS_DISASTER.TSUNAMI_START[2],
      floodY: 0,
      meteorites: [], explosions: [],
      tornado: null, rain: false, lava: false,
    };
    this.mode = null;
    this.selectedPartId = null;
    this.breakHoldId = null; this.breakHoldT = 0;
    if (id === 'zombies') this.spawnZombies();
    if (id === 'tornado') {
      this.tornado = { x: 0, z: 0, t: 0, dx: 1, dz: 0 };
      this.disaster.tornado = { x: 0, z: 0, t: 0 };
    }
    this.invincibleFor = BTS_INVINCIBLE;
    this.onPhaseCb?.('disaster', id);
    this.playSoundCb?.('bts_disaster_warn', 0.7);
  }
  private endDisaster() {
    this.player.survived++;
    this.playSoundCb?.('bts_survive', 0.6);
    this.round++;
    this.phase = 'build';
    this.buildTimer = BTS_BUILD_TIME;
    this.zombies = [];
    this.meteorites = [];
    this.explosions = [];
    this.tornado = null;
    this.disaster = {
      id: null, name: '', t: 0,
      tsunamiZ: 0, floodY: 0, meteorites: [], explosions: [],
      tornado: null, rain: false, lava: false,
    };
    this.player.hp = this.player.max;
    this.player.alive = true;
    this.invincibleFor = BTS_INVINCIBLE;
    this.onPhaseCb?.('build', null);
  }

  // ─── Zombies ───
  private spawnZombies() {
    this.zombies = [];
    const [sx, , sz] = BTS_ZOMBIE_SPAWN;
    for (let i = 0; i < BTS_ZOMBIE_COUNT; i++) {
      const ang = (i / BTS_ZOMBIE_COUNT) * Math.PI * 2;
      const r = 2 + (i % 5);
      this.zombies.push({
        id: this.zombieId++, x: sx + Math.cos(ang) * r, y: 0.5, z: sz + Math.sin(ang) * r,
        yaw: 0, swingT: 0, hitCd: 0, soundCd: Math.random() * BTS_ZOMBIE_SOUND_INTERVAL, alive: true,
      });
    }
  }

  // ─── Per-frame ───
  updatePlayerTransform() {
    this.playerPos.set(BTS_PLAYER_BRIDGE.x, BTS_PLAYER_BRIDGE.y, BTS_PLAYER_BRIDGE.z);
    this.camDir.set(BTS_PLAYER_BRIDGE.camDir[0], BTS_PLAYER_BRIDGE.camDir[1], BTS_PLAYER_BRIDGE.camDir[2]);
  }

  tick(dt: number) {
    if (!this.active) return;
    dt = Math.min(dt, 1 / 20);
    this.updatePlayerTransform();
    if (this.invincibleFor > 0) this.invincibleFor -= dt;
    if (this.placeCd > 0) this.placeCd -= dt;

    if (this.phase === 'build') {
      this.buildTimer -= dt;
      this.tickBreak(dt);
      if (this.buildTimer <= 0) this.beginDisaster();
    } else if (this.phase === 'disaster') {
      this.disasterT -= dt;
      this.disaster.t += dt;
      this.tickDisaster(dt);
      if (this.disasterT <= 0) this.endDisaster();
    }

    this.rev++;
  }

  private tickDisaster(dt: number) {
    const id = this.disaster.id;
    const px = this.playerPos.x, py = this.playerPos.y, pz = this.playerPos.z;
    const world = (window as any).__weildPhysicsWorld;
    const charBody = world?.characterBody;

    if (id === 'tsunami') {
      this.disaster.tsunamiZ += BTS_TSUNAMI_SPEED * dt;
      // Caught: the wall has passed the player's z (wall moves +Z from -152).
      if (this.disaster.tsunamiZ >= pz && py < this.disaster.tsunamiZ + 6) {
        this.damagePlayer(BTS_TSUNAMI_DMG * dt);
      }
    } else if (id === 'flood') {
      // Rise to 80, hold 3s, reset (drain) - spec.
      if (this.disaster.floodY < BTS_DISASTER.FLOOD_MAX_Y) {
        this.disaster.floodY = Math.min(BTS_DISASTER.FLOOD_MAX_Y, this.disaster.floodY + BTS_FLOOD_RISE * dt);
      } else {
        // hold at max for FLOOD_RESET_HOLD seconds, then drain
        this.disaster.t; // (t already tracks elapsed)
        if (this.disaster.t > BTS_DISASTER.FLOOD_MAX_Y / BTS_FLOOD_RISE + BTS_DISASTER.FLOOD_RESET_HOLD) {
          this.disaster.floodY = Math.max(0, this.disaster.floodY - BTS_FLOOD_RISE * 2 * dt);
        }
      }
      if (py < this.disaster.floodY) this.damagePlayer(BTS_FLOOD_DMG * dt);
    } else if (id === 'meteorites') {
      // Spawn periodically
      const last = this.meteorites.length;
      if (Math.random() < dt / BTS_METEORITE_INTERVAL) {
        const half = BTS_DISASTER.MAP_HALF - 2;
        this.meteorites.push({
          id: this.meteoriteId++,
          x: (Math.random() * 2 - 1) * half,
          y: BTS_DISASTER.METEORITE_SPAWN_Y,
          z: (Math.random() * 2 - 1) * half,
          vy: BTS_METEORITE_SPEED_MIN + Math.random() * (BTS_METEORITE_SPEED_MAX - BTS_METEORITE_SPEED_MIN),
        });
      }
      // Fall + explode on reaching surface
      for (const m of this.meteorites) {
        m.y -= m.vy * dt;
        if (m.y <= 0.5) {
          this.explosions.push({ id: this.explosionId++, x: m.x, y: 0.5, z: m.z, t: 0 });
          this.playSoundCb?.('explosion', 0.6);
          // damage player if near
          const dx = px - m.x, dz = pz - m.z;
          const dist = Math.sqrt(dx * dx + py * py + dz * dz);
          if (dist < BTS_METEORITE_RADIUS) {
            const dmg = BTS_METEORITE_DMG * (1 - dist / BTS_METEORITE_RADIUS);
            this.damagePlayer(dmg);
            // knockback
            if (charBody && dist > 0.01) {
              const k = 14 * (1 - dist / BTS_METEORITE_RADIUS);
              charBody.velocity.set(dx / dist * k, 8, dz / dist * k);
            }
          }
          m.y = -999; // mark for removal
        }
      }
      if (last) this.meteorites = this.meteorites.filter(m => m.y > -100);
    } else if (id === 'acid_rain') {
      this.disaster.rain = true;
      // Sky-exposed: no placed block above the player's cell within a few y.
      const exposed = this.isSkyExposed(px, pz, py);
      if (exposed) this.damagePlayer(BTS_ACID_DMG * dt);
    } else if (id === 'zombies') {
      this.tickZombies(dt);
    } else if (id === 'lava') {
      this.disaster.lava = true;
      // Touching the baseplate (y near 0.5).
      if (py < 1.5) this.damagePlayer(BTS_LAVA_DMG * dt);
    } else if (id === 'tornado') {
      if (this.tornado) {
        // Wander: pick a new heading occasionally.
        this.tornado.t += dt;
        if (this.tornado.t > 2.2) {
          this.tornado.t = 0;
          const ang = Math.random() * Math.PI * 2;
          this.tornado.dx = Math.cos(ang); this.tornado.dz = Math.sin(ang);
        }
        this.tornado.x += this.tornado.dx * BTS_TORNADO_SPEED * dt;
        this.tornado.z += this.tornado.dz * BTS_TORNADO_SPEED * dt;
        // keep within map
        const half = BTS_DISASTER.MAP_HALF - 4;
        if (Math.abs(this.tornado.x) > half) this.tornado.dx = -Math.sign(this.tornado.x);
        if (Math.abs(this.tornado.z) > half) this.tornado.dz = -Math.sign(this.tornado.z);
        this.tornado.x = Math.max(-half, Math.min(half, this.tornado.x));
        this.tornado.z = Math.max(-half, Math.min(half, this.tornado.z));
        this.disaster.tornado = { x: this.tornado.x, z: this.tornado.z, t: this.tornado.t };
        // Pull + kill
        const dx = this.tornado.x - px, dz = this.tornado.z - pz;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist < BTS_TORNADO_KILL) {
          this.damagePlayer(this.player.hp + 1); // instant death
        } else if (dist < BTS_TORNADO_PULL_RANGE && charBody && dist > 0.01) {
          const pull = BTS_TORNADO_PULL * (1 - dist / BTS_TORNADO_PULL_RANGE);
          const vx = charBody.velocity.x + (dx / dist) * pull * dt * 6;
          const vz = charBody.velocity.z + (dz / dist) * pull * dt * 6;
          charBody.velocity.set(vx, charBody.velocity.y, vz);
        }
      }
    }

    // Age explosions (visual only)
    for (const e of this.explosions) e.t += dt;
    if (this.explosions.length) this.explosions = this.explosions.filter(e => e.t < 1.2);
  }

  private isSkyExposed(px: number, pz: number, py: number): boolean {
    // Exposed if no placed block sits above the player at their cell (within a small column).
    const cx = gridSnap(px), cz = gridSnap(pz);
    for (const b of this.placed.values()) {
      if (b.cell[0] === cx && b.cell[1] === cz && b.y > py + 0.5) return false;
    }
    return true;
  }

  private tickZombies(dt: number) {
    const px = this.playerPos.x, pz = this.playerPos.z;
    for (const z of this.zombies) {
      if (!z.alive) continue;
      const dx = px - z.x, dz = pz - z.z;
      const dist = Math.sqrt(dx * dx + dz * dz) || 0.001;
      // Chase
      const sp = BTS_ZOMBIE_SPEED * dt;
      z.x += (dx / dist) * sp;
      z.z += (dz / dist) * sp;
      z.yaw = Math.atan2(dx, dz);
      // Attack cooldown + sound
      if (z.hitCd > 0) z.hitCd -= dt;
      if (z.soundCd > 0) z.soundCd -= dt;
      if (z.swingT > 0) z.swingT = Math.max(0, z.swingT - dt * 3);
      // Touch -> damage + arm swing + sounds
      if (dist < BTS_ZOMBIE_TOUCH && z.hitCd <= 0 && this.player.alive) {
        z.hitCd = BTS_ZOMBIE_HIT_CD;
        z.swingT = 1;
        this.damagePlayer(BTS_ZOMBIE_DMG);
        this.playSoundCb?.('bts_zombie_attack', 0.5);
      }
      // Random groan
      if (z.soundCd <= 0) {
        z.soundCd = BTS_ZOMBIE_SOUND_INTERVAL + Math.random() * 3;
        if (Math.random() < 0.25) this.playSoundCb?.('bts_zombie_sound', 0.35);
      }
    }
  }

  // ─── Snapshot (read by the host HUD + scene each frame) ───
  private buildGhost(): BtsGhost {
    if (this.phase !== 'build' || !this.claimedPlot || this.mode === null) {
      return { visible: false, valid: false, mode: null, shape: 'Block', color: '#fff', x: 0, y: 0, z: 0, sizeY: 1, breakId: null, breakProgress: 0 };
    }
    const { cx, cz, valid } = this.aimCell();
    const def = this.selectedPartId ? BTS_PARTS.find(p => p.id === this.selectedPartId) : null;
    if (this.mode === 'place' && def) {
      const top = this.cellTopY(cx, cz);
      const cy = top + BTS_BLOCK_SIZE / 2;
      return { visible: true, valid, mode: 'place', shape: def.shape, color: def.color, x: cx, y: cy, z: cz, sizeY: BTS_BLOCK_SIZE, breakId: null, breakProgress: 0 };
    }
    if (this.mode === 'break') {
      const top = this.topBlockAt(cx, cz);
      const progress = this.breakHoldId ? Math.min(1, this.breakHoldT / BTS_BREAK_HOLD) : 0;
      return {
        visible: !!top, valid: !!top, mode: 'break',
        shape: top?.shape ?? 'Block', color: top?.color ?? '#fff',
        x: cx, y: top?.y ?? 0, z: cz, sizeY: top?.sizeY ?? 1,
        breakId: top?.id ?? null, breakProgress: progress,
      };
    }
    return { visible: false, valid: false, mode: null, shape: 'Block', color: '#fff', x: 0, y: 0, z: 0, sizeY: 1, breakId: null, breakProgress: 0 };
  }

  getSnapshot(): BtsSnapshot {
    return {
      active: this.active,
      phase: this.phase,
      buildTimer: Math.max(0, this.buildTimer),
      disasterT: Math.max(0, this.disasterT),
      round: this.round,
      claimedPlotId: this.claimedPlot?.id ?? null,
      mode: this.mode,
      selectedPartId: this.selectedPartId,
      ghost: this.buildGhost(),
      disaster: {
        ...this.disaster,
        meteorites: this.meteorites,
        explosions: this.explosions,
        tornado: this.tornado ? { x: this.tornado.x, z: this.tornado.z, t: this.tornado.t } : null,
      },
      zombies: this.zombies,
      player: { ...this.player },
      rev: this.rev,
    };
  }
}

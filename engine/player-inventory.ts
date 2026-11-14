// ═══════════════════════════════════════════════════════════════════
// Player Inventory — runtime manager for play mode
// ═══════════════════════════════════════════════════════════════════
// Owns everything about items while a game runs:
//
//   • the player's item bar (4 slots) + the backpack (the rest)
//   • grabbing parts/groups OUT of the world (E) and dropping them back (Q)
//   • equipping (the player HOLDS the item) + using it (arm swing +
//     when_used rules fire)
//   • the bridges the 3D side reads: WB_INVENTORY_BRIDGE (where the
//     player is), WB_INVENTORY_ARM_OVERRIDE (the right-arm angle),
//     WB_INVENTORY_AIM (camera + canvas for grab raycasts)
//
// Items come from two places: the PROJECT inventory (the creator's
// starter items, seeded at play start) and parts grabbed during play.
// Everything is runtime-only — stopping play restores the world.
//
// Equipped items also spawn their template into the world as hidden
// parts (showInWorld=false, non-collidable). That gives their rules
// (when_used / when_equipped / when_touched...) a REAL part context to
// run against — the same trick the engine uses for every other rule.

import * as THREE from 'three';
import {
  useStudioStore, isPart, collectDescendants, topMostSelectedIds,
  StudioObject, StudioPart, StudioModel, Vector3, HOTBAR_SLOT_COUNT,
  InventoryItemData,
} from './studio-store';
import { weildCodeEngine } from './weildcode-engine';
import { weluRuntime } from './welu/welu-runtime';
import { playSound } from './sounds';

// ─── Bridges (module singletons, like TSF_PLAYER_BRIDGE) ───

/** The local player's live transform — written every frame by the play
 *  viewport, read by the held-item renderer + drop positioning. */
export const WB_INVENTORY_BRIDGE = {
  x: 0, y: 0, z: 0,
  bodyYaw: 0,
  /** camera forward direction (normalized) */
  camX: 0, camY: 0, camZ: 1,
  alive: false,
};

/** The right-arm angle while an item is held (null = walk animation). */
export const WB_INVENTORY_ARM_OVERRIDE = { current: null as number | null };

/** Camera + canvas for grab raycasts (synced by InventoryAimSync). */
export const WB_INVENTORY_AIM: {
  camera: THREE.Camera | null;
  dom: HTMLElement | null;
} = { camera: null, dom: null };

// ─── Arm angles (match the TSF/BTS conventions) ───

export const INV_ARM_HOLD = -Math.PI / 2;      // Roblox-style arm-forward hold
export const INV_CHOP_FROM = -2.2;             // wind-up
export const INV_CHOP_TO = -0.6;               // follow-through
export const INV_SWING_TIME = 0.45;            // seconds
const INV_USE_COOLDOWN = 0.3;
const INV_GRAB_REACH = 14;                     // studs

// ─── Runtime item ───

export interface InventoryItemRuntime {
  itemId: string;
  name: string;
  sourceType: 'part' | 'group';
  /** serialized subtree (parts + models) — the spawn/held template */
  objects: StudioObject[];
  /** root id within `objects` */
  rootId: string;
  /** where it came from (for stop-cleanup analytics / debugging) */
  origin: 'project' | 'grabbed';
}

export interface InventorySnapshot {
  rev: number;
  items: Array<{ itemId: string; name: string; origin: 'project' | 'grabbed' }>;
  slots: (string | null)[];
  selectedSlot: number | null;
  swingT: number; // 0..1 progress of the swing (0 = not swinging)
}

// ─── Manager ───

class PlayerInventoryManager {
  private items = new Map<string, InventoryItemRuntime>();
  private slots: (string | null)[] = [null, null, null, null];
  private selectedSlot: number | null = null;
  /** hidden world parts of the equipped item (rule hosts) */
  private heldPartIds: string[] = [];
  /** ALL hidden template nodes (parts + models) of the equipped item */
  private heldNodeIds: string[] = [];
  private heldItemId: string | null = null;
  private swingTimer = 0;
  private useCooldown = 0;
  private rev = 0;
  private active = false;

  isActive(): boolean {
    return this.active;
  }

  getRev(): number {
    return this.rev;
  }

  private bump(): void {
    this.rev++;
  }

  getSnapshot(): InventorySnapshot {
    return {
      rev: this.rev,
      items: [...this.items.values()].map((i) => ({ itemId: i.itemId, name: i.name, origin: i.origin })),
      slots: [...this.slots],
      selectedSlot: this.selectedSlot,
      swingT: this.swingTimer > 0 ? 1 - this.swingTimer / INV_SWING_TIME : 0,
    };
  }

  // ─── lifecycle ───

  start(): void {
    if (this.active) return;
    this.active = true;
    this.items.clear();
    this.slots = [null, null, null, null];
    this.selectedSlot = null;
    this.heldPartIds = [];
    this.heldItemId = null;
    this.swingTimer = 0;
    this.useCooldown = 0;

    // Seed from the project inventory (the creator's starter items).
    const store = useStudioStore.getState();
    for (const item of store.inventory) {
      this.addRuntimeItem(item, 'project');
    }
    // Restore the creator's hotbar layout, then fill leftover slots with
    // any unassigned items (first-come, up to 4).
    const hotbar = [...store.hotbarItemIds];
    while (hotbar.length < HOTBAR_SLOT_COUNT) hotbar.push(null);
    for (let i = 0; i < HOTBAR_SLOT_COUNT; i++) {
      const id = hotbar[i];
      this.slots[i] = id && this.items.has(id) ? id : null;
    }
    for (const item of this.items.values()) {
      if (this.slots.includes(item.itemId)) continue;
      const free = this.slots.indexOf(null);
      if (free === -1) break;
      this.slots[free] = item.itemId;
    }
    this.bump();
  }

  stop(): void {
    if (!this.active) return;
    this.unequipHeld(false);
    this.items.clear();
    this.slots = [null, null, null, null];
    this.selectedSlot = null;
    this.active = false;
    WB_INVENTORY_ARM_OVERRIDE.current = null;
    this.bump();
  }

  /** Frame tick (called from the held-item renderer's useFrame). */
  tick(dt: number): void {
    if (this.swingTimer > 0) this.swingTimer = Math.max(0, this.swingTimer - dt);
    if (this.useCooldown > 0) this.useCooldown = Math.max(0, this.useCooldown - dt);
    // drive the arm: hold angle, or the chop while swinging
    if (this.selectedSlot !== null && this.heldItemId) {
      WB_INVENTORY_ARM_OVERRIDE.current = this.swingTimer > 0
        ? INV_CHOP_FROM + (INV_CHOP_TO - INV_CHOP_FROM) * (1 - this.swingTimer / INV_SWING_TIME)
        : INV_ARM_HOLD;
    }
  }

  // ─── hotbar ───

  selectSlot(n: number): void {
    if (!this.active || n < 0 || n >= HOTBAR_SLOT_COUNT) return;
    // Clicking the ALREADY-SELECTED slot deselects it (user request).
    if (this.selectedSlot === n) {
      this.deselect();
      return;
    }
    const itemId = this.slots[n];
    if (!itemId || !this.items.has(itemId)) {
      // empty slot: any current selection still deselects
      this.deselect();
      return;
    }
    this.deselect();
    this.selectedSlot = n;
    this.equipHeld(itemId);
    void playSound('click', 0.3);
    this.bump();
  }

  deselect(): void {
    if (this.selectedSlot === null) return;
    this.unequipHeld(true);
    this.selectedSlot = null;
    this.bump();
  }

  getSelectedItem(): InventoryItemRuntime | null {
    if (this.selectedSlot === null) return null;
    const id = this.slots[this.selectedSlot];
    return id ? (this.items.get(id) ?? null) : null;
  }

  /** Assign an item to a hotbar slot (drag & drop). Pass null to clear. */
  assignSlot(itemId: string, slot: number | null): void {
    if (!this.active) return;
    // remove from all slots first (one slot per item)
    this.slots = this.slots.map((s) => (s === itemId ? null : s));
    if (slot !== null && slot >= 0 && slot < HOTBAR_SLOT_COUNT) {
      this.slots[slot] = itemId;
    }
    // deselect if the selected slot no longer holds an item
    if (this.selectedSlot !== null && !this.slots[this.selectedSlot]) {
      this.deselect();
    }
    this.bump();
  }

  // ─── use (swing + fire rules) ───

  use(): boolean {
    if (!this.active || this.useCooldown > 0) return false;
    const item = this.getSelectedItem();
    if (!item) return false;
    this.useCooldown = INV_USE_COOLDOWN;
    this.swingTimer = INV_SWING_TIME;
    WB_INVENTORY_ARM_OVERRIDE.current = INV_CHOP_FROM;
    void playSound('whoosh', 0.35);

    // fire when_used on every hidden part of the held item
    for (const partId of this.heldPartIds) {
      try { weildCodeEngine.fireTrigger(partId, 'when_used'); } catch { /* rules never break use */ }
    }
    // Welu hears it too (game scripts)
    try { weluRuntime.handleItemUsed(item.name); } catch { /* ignore */ }
    this.bump();
    return true;
  }

  /** 0..1 swing progress for the renderer. */
  swingProgress(): number {
    return this.swingTimer > 0 ? 1 - this.swingTimer / INV_SWING_TIME : 0;
  }

  // ─── grab (E): pull a part/group out of the world ───

  /** Raycast the aim ray against visible parts; returns the top-most
   *  object id (a group when the hit part belongs to one). */
  pickGrabTarget(ndc?: { x: number; y: number } | null): { rootId: string; hitPoint: Vector3 } | null {
    const camera = WB_INVENTORY_AIM.camera;
    if (!camera) return null;
    const ray = new THREE.Raycaster();
    if (ndc) {
      ray.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera);
    } else {
      ray.setFromCamera(new THREE.Vector2(0, 0), camera);
    }

    const store = useStudioStore.getState();
    const origin = ray.ray.origin;
    const dir = ray.ray.direction;

    const bestRef: { value: { rootId: string; dist: number; hitPoint: Vector3 } | null } = { value: null };
    store.objects.forEach((obj) => {
      if (!isPart(obj)) return;
      if (obj.isCharacterPart) return;
      if (obj.showInWorld === false) return;
      const hit = rayAabb(origin, dir, obj);
      if (!hit) return;
      if (hit.t > INV_GRAB_REACH) return;
      const best = bestRef.value;
      if (!best || hit.t < best.dist) {
        // the GRAB target is the top-most ancestor (grab whole groups)
        let rootId: string = obj.id;
        let cursor: StudioObject | undefined = obj;
        while (cursor?.parentId) {
          const parent = store.objects.get(cursor.parentId);
          if (!parent) break;
          rootId = parent.id;
          cursor = parent;
        }
        // grabbing a root-level part grabs the part itself
        bestRef.value = { rootId, dist: hit.t, hitPoint: hit.point };
      }
    });
    return bestRef.value ? { rootId: bestRef.value.rootId, hitPoint: bestRef.value.hitPoint } : null;
  }

  /** Grab the object under the crosshair/cursor into the inventory. */
  grabFromWorld(ndc?: { x: number; y: number } | null): boolean {
    if (!this.active) return false;
    const store = useStudioStore.getState();
    const pick = this.pickGrabTarget(ndc);
    if (!pick) return false;
    const root = store.objects.get(pick.rootId);
    if (!root) return false;

    // fire when_grabbed on the whole subtree BEFORE removal (the parts
    // still exist, so rules can read them)
    for (const id of collectDescendants(store.objects, pick.rootId)) {
      const o = store.objects.get(id);
      if (o && isPart(o)) {
        try { weildCodeEngine.fireTrigger(id, 'when_grabbed'); } catch { /* ignore */ }
      }
    }
    try { weluRuntime.handleGrabbed(root.name); } catch { /* ignore */ }

    // serialize the subtree
    const subtreeIds = new Set(collectDescendants(store.objects, pick.rootId));
    const objects: StudioObject[] = [];
    store.objects.forEach((o) => {
      if (subtreeIds.has(o.id)) objects.push(JSON.parse(JSON.stringify(o)));
    });
    if (objects.length === 0) return false;

    // remove from the world WITHOUT firing when_destroyed (grabbed ≠ destroyed)
    useStudioStore.setState((s) => {
      const newObjects = new Map(s.objects);
      subtreeIds.forEach((id) => newObjects.delete(id));
      const rootNode = s.objects.get(pick.rootId);
      if (rootNode?.parentId) {
        const parent = newObjects.get(rootNode.parentId);
        if (parent && 'children' in parent) {
          newObjects.set(rootNode.parentId, { ...parent, children: parent.children.filter((c) => !subtreeIds.has(c)) });
        }
      }
      return {
        objects: newObjects,
        selectedIds: s.selectedIds.filter((sid) => !subtreeIds.has(sid)),
        joints: s.joints.filter((j) => !subtreeIds.has(j.partAId) && !subtreeIds.has(j.partBId)),
        objectsVersion: s.objectsVersion + 1,
      };
    });

    const item: InventoryItemRuntime = {
      itemId: `rtitem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      name: root.name,
      sourceType: isPart(root) ? 'part' : 'group',
      objects,
      rootId: pick.rootId,
      origin: 'grabbed',
    };
    this.items.set(item.itemId, item);
    const free = this.slots.indexOf(null);
    if (free !== -1) this.slots[free] = item.itemId;
    void playSound('pop', 0.4);
    useStudioStore.getState().addConsoleMessage('info', `[Inventory] Grabbed "${item.name}".`);
    this.bump();
    return true;
  }

  /** Drop the SELECTED item back into the world in front of the player. */
  dropSelected(): boolean {
    const item = this.getSelectedItem();
    if (!item) return false;
    return this.dropItem(item.itemId);
  }

  /** Spawn an item back into the world (removes it from the inventory). */
  dropItem(itemId: string): boolean {
    if (!this.active) return false;
    const item = this.items.get(itemId);
    if (!item) return false;

    // where: in front of the player, at ground-ish height
    const pos = this.computeDropPosition();
    const newRootId = this.spawnTemplateIntoWorld(item, pos);
    if (!newRootId) return false;

    this.items.delete(itemId);
    this.slots = this.slots.map((s) => (s === itemId ? null : s));
    if (this.heldItemId === itemId) {
      this.unequipHeld(true);
      this.selectedSlot = null;
    }
    void playSound('click', 0.4);
    useStudioStore.getState().addConsoleMessage('info', `[Inventory] Dropped "${item.name}".`);

    // when_dropped fires on the NEW root part (it exists now)
    try { weildCodeEngine.fireTrigger(newRootId, 'when_dropped'); } catch { /* ignore */ }
    try { weluRuntime.handleDropped(item.name); } catch { /* ignore */ }
    this.bump();
    return true;
  }

  // ─── Welu / rule-engine item API (window.__wbPlayerInventory) ───

  giveItemByName(name: string): boolean {
    if (!this.active || !name) return false;
    const store = useStudioStore.getState();
    const item = store.inventory.find((i) => i.name.toLowerCase() === name.toLowerCase());
    if (!item) return false;
    const added = this.addRuntimeItem(item, 'project');
    if (!added) return false;
    const free = this.slots.indexOf(null);
    if (free !== -1) this.slots[free] = added.itemId;
    void playSound('pop', 0.35);
    this.bump();
    return true;
  }

  removeItemByName(name: string): boolean {
    if (!this.active || !name) return false;
    const item = [...this.items.values()].find((i) => i.name.toLowerCase() === name.toLowerCase());
    if (!item) return false;
    this.items.delete(item.itemId);
    this.slots = this.slots.map((s) => (s === item.itemId ? null : s));
    if (this.heldItemId === item.itemId) {
      this.unequipHeld(true);
      this.selectedSlot = null;
    }
    this.bump();
    return true;
  }

  dropItemByName(name: string): boolean {
    const item = [...this.items.values()].find((i) => i.name.toLowerCase() === name.toLowerCase());
    if (!item) return false;
    return this.dropItem(item.itemId);
  }

  itemNames(): string[] {
    return [...this.items.values()].map((i) => i.name);
  }

  /** Template objects of an item (for the 3D preview + held renderer). */
  getItemObjects(itemId: string): StudioObject[] | null {
    const item = this.items.get(itemId);
    return item ? item.objects : null;
  }

  getHeldItemId(): string | null {
    return this.heldItemId;
  }

  // ─── internals ───

  private addRuntimeItem(data: InventoryItemData, origin: 'project' | 'grabbed'): InventoryItemRuntime | null {
    // de-dupe by id (a project item already in the runtime stays)
    if (this.items.has(data.id)) return this.items.get(data.id)!;
    const item: InventoryItemRuntime = {
      itemId: data.id,
      name: data.name,
      sourceType: data.sourceType,
      objects: data.objects,
      rootId: data.rootId,
      origin,
    };
    this.items.set(item.itemId, item);
    return item;
  }

  private computeDropPosition(): Vector3 {
    const b = WB_INVENTORY_BRIDGE;
    // 4 studs in the camera's horizontal direction, at the player's height
    const len = Math.hypot(b.camX, b.camZ) || 1;
    return {
      x: b.x + (b.camX / len) * 4,
      y: Math.max(0.5, b.y + 0.5),
      z: b.z + (b.camZ / len) * 4,
    };
  }

  /** Instantiate a template into the world with fresh ids. Returns root id. */
  private spawnTemplateIntoWorld(item: InventoryItemRuntime, position: Vector3): string | null {
    const store = useStudioStore.getState();
    const idRemap = new Map<string, string>();
    for (const o of item.objects) {
      idRemap.set(o.id, `obj_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`);
    }
    const newObjects = new Map(store.objects);
    let rootId: string | null = null;
    for (const o of item.objects) {
      const clone = JSON.parse(JSON.stringify(o)) as StudioObject;
      clone.id = idRemap.get(o.id)!;
      clone.parentId = o.parentId ? (idRemap.get(o.parentId) ?? null) : null;
      if ('children' in clone) {
        clone.children = clone.children.map((c) => idRemap.get(c) ?? c);
      }
      newObjects.set(clone.id, clone);
      if (!clone.parentId) rootId = clone.id;
    }
    if (!rootId) return null;
    // place the FIRST root at the drop position (offsets preserved for others)
    const root = newObjects.get(rootId);
    if (root && isPart(root)) {
      newObjects.set(rootId, { ...root, position } as StudioPart);
    }
    useStudioStore.setState({
      objects: newObjects,
      objectsVersion: store.objectsVersion + 1,
    });
    return rootId;
  }

  /** Equip: spawn the item's template as hidden rule-host parts. */
  private equipHeld(itemId: string): void {
    this.unequipHeld(false);
    const item = this.items.get(itemId);
    if (!item) return;
    this.heldItemId = itemId;

    const store = useStudioStore.getState();
    const idRemap = new Map<string, string>();
    for (const o of item.objects) {
      idRemap.set(o.id, `obj_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`);
    }
    const newObjects = new Map(store.objects);
    const partIds: string[] = [];
    const nodeIds: string[] = [];
    const b = WB_INVENTORY_BRIDGE;
    for (const o of item.objects) {
      const clone = JSON.parse(JSON.stringify(o)) as StudioObject;
      clone.id = idRemap.get(o.id)!;
      clone.parentId = o.parentId ? (idRemap.get(o.parentId) ?? null) : null;
      if ('children' in clone) {
        clone.children = clone.children.map((c) => idRemap.get(c) ?? c);
      }
      nodeIds.push(clone.id);
      if (isPart(clone)) {
        // hidden, non-physical, parked at the player — pure rule context
        clone.showInWorld = false;
        clone.canCollide = false;
        clone.anchored = true;
        clone.bodyMovers = [];
        clone.effects = [];
        clone.position = { x: b.x, y: b.y, z: b.z };
        partIds.push(clone.id);
      }
      newObjects.set(clone.id, clone);
    }
    useStudioStore.setState({ objects: newObjects });
    this.heldPartIds = partIds;

    // fire when_equipped (+ when_created fires automatically for new parts)
    for (const partId of partIds) {
      try { weildCodeEngine.fireTrigger(partId, 'when_equipped'); } catch { /* ignore */ }
    }
    try { weluRuntime.handleItemEquipped(item.name); } catch { /* ignore */ }
  }

  /** Unequip: remove the hidden template nodes + fire when_unequipped. */
  private unequipHeld(fireEvents: boolean): void {
    if (this.heldPartIds.length > 0 || this.heldNodeIds.length > 0) {
      if (fireEvents) {
        const item = this.heldItemId ? this.items.get(this.heldItemId) : null;
        for (const partId of this.heldPartIds) {
          try { weildCodeEngine.fireTrigger(partId, 'when_unequipped'); } catch { /* ignore */ }
        }
        if (item) {
          try { weluRuntime.handleItemUnequipped(item.name); } catch { /* ignore */ }
        }
      }
      // silent removal (unequipping is not a destruction)
      const remove = new Set([...this.heldPartIds, ...this.heldNodeIds]);
      useStudioStore.setState((s) => {
        const newObjects = new Map(s.objects);
        remove.forEach((id) => newObjects.delete(id));
        return {
          objects: newObjects,
          selectedIds: s.selectedIds.filter((sid) => !remove.has(sid)),
          objectsVersion: s.objectsVersion + 1,
        };
      });
    }
    this.heldPartIds = [];
    this.heldNodeIds = [];
    this.heldItemId = null;
    this.swingTimer = 0;
    WB_INVENTORY_ARM_OVERRIDE.current = null;
  }
}

// ─── ray vs AABB helper ───

function rayAabb(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  part: StudioPart,
): { t: number; point: Vector3 } | null {
  const hx = part.size.x / 2;
  const hy = part.size.y / 2;
  const hz = part.size.z / 2;
  const min = [part.position.x - hx, part.position.y - hy, part.position.z - hz];
  const max = [part.position.x + hx, part.position.y + hy, part.position.z + hz];
  const o = [origin.x, origin.y, origin.z];
  const d = [dir.x, dir.y, dir.z];
  let tmin = 0;
  let tmax = Infinity;
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < min[i] || o[i] > max[i]) return null;
    } else {
      let t1 = (min[i] - o[i]) / d[i];
      let t2 = (max[i] - o[i]) / d[i];
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  const t = tmin;
  return {
    t,
    point: { x: o[0] + d[0] * t, y: o[1] + d[1] * t, z: o[2] + d[2] * t },
  };
}

// ─── singleton + bridges ───

export const playerInventory = new PlayerInventoryManager();

if (typeof window !== 'undefined') {
  (window as any).__wbPlayerInventory = playerInventory;
}

// ═══════════════════════════════════════════════════════════════════
// WeLua — the runtime: scheduler + `welu` world API + event dispatch
// ═══════════════════════════════════════════════════════════════════
// One WeluRuntime instance runs while the game plays (same lifecycle as
// the WeildCode engine: started/stopped by PhysicsSimulation / the
// toolbar's stop paths). Every user script runs as a "thread" — a JS
// generator driven by the scheduler:
//
//   • welu.wait(t) yields a wait signal; the scheduler resumes later
//   • infinite loops are killed by the interpreter's slice budget
//   • events (click/touch/tick/keys/items/chat) spawn short threads
//
// The world API mirrors what the block-rule engine can do (parts, the
// player, effects, variables, weather...) plus the NEW systems (items,
// the camera bridge), so Lua scripts can build anything blocks can —
// and more.

import {
  LuaInterpreter, LuaTable, LuaValue, LuaFunction, LuaError, FatalLuaError,
  setPrintSink,
} from './lua-interpreter';
import { parseLua } from './lua-parser';
import { useStudioStore, isPart, StudioPart, StudioObject, Vector3, PartType, MaterialType, Joint, PartEffect } from '../studio-store';
import { weildCodeEngine, PlayerEffect } from '../weildcode-engine';
import { playSound } from '../sounds';

// ─── Threads (one per running script invocation) ───

interface WeluThread {
  id: number;
  gen: Generator<unknown, unknown, unknown>;
  /** performance.now() when a waiting thread should resume. */
  resumeAt: number | null;
  /** Which script this belongs to (for error messages). */
  label: string;
  /** The player whose event spawned this thread (server effect routing). */
  actor: string | null;
}

interface WeluTimer {
  intervalSeconds: number;
  fn: LuaValue;
  nextAt: number;
}

interface PartScriptBinding {
  partId: string;
  scriptId: string;
  name: string;
}

// Camera bridge: welu.camera.setPosition/setYaw/setPitch write here; the
// play viewport (GamePlayerCharacter) applies each change once.
export const WB_CAMERA_BRIDGE = {
  position: null as Vector3 | null,
  yaw: null as number | null,
  pitch: null as number | null,
  nonce: 0,
};

const MAX_THREADS = 400;
const MAX_TIMERS = 64;
const MAX_TICK_CALLBACKS = 64;

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

class WeluRuntime {
  private interp: LuaInterpreter | null = null;
  private threads: WeluThread[] = [];
  private timers: WeluTimer[] = [];
  private tickCallbacks: Array<{ fn: LuaValue; partId: string | null }> = [];
  private rafId: number | null = null;
  private startedAt = 0;
  private lastFrameAt = 0;
  private threadSeq = 0;
  private running = false;

  // event registries
  private clickHandlers: Array<{ partId: string | null; fn: LuaValue }> = [];
  private touchHandlers: Array<{ partId: string | null; fn: LuaValue }> = [];
  private destroyHandlers: Array<{ partId: string | null; fn: LuaValue }> = [];
  private keyHandlers: Array<{ key: string; fn: LuaValue }> = [];
  private chatHandlers: LuaValue[] = [];
  private joinHandlers: LuaValue[] = [];
  private leaveHandlers: LuaValue[] = [];
  private diedHandlers: LuaValue[] = [];
  private damagedHandlers: LuaValue[] = [];
  private itemUsedHandlers: LuaValue[] = [];
  private itemEquippedHandlers: LuaValue[] = [];
  private itemUnequippedHandlers: LuaValue[] = [];
  private grabbedHandlers: LuaValue[] = [];
  private droppedHandlers: LuaValue[] = [];

  /** partId -> lua handle table (bounded: one per part). */
  private handleCache = new Map<string, LuaTable>();
  /** The part a script belongs to while its top-level chunk runs. */
  private currentScriptPartId: string | null = null;
  private localUsername = 'Player';

  // ─── multiplayer authority ───
  // TRUE on singleplayer/Test Play and on the gamehost (the authority).
  // FALSE on clients in server-authoritative multiplayer: their scripts
  // still RUN (player-only code executes on the player's own machine —
  // zero latency), but world writes are gated off because the server
  // streams the real state.
  private worldAuthority = true;

  /** The gamehost / play viewport sets this before start(). */
  setWorldAuthority(authority: boolean): void {
    this.worldAuthority = authority;
  }

  isWorldAuthority(): boolean {
    return this.worldAuthority;
  }

  /** World mutations are only allowed on the authority. */
  private canWriteWorld(): boolean {
    return this.worldAuthority;
  }

  /** The acting player for the thread currently executing (effect routing). */
  private currentActor: string | null = null;

  isRunning(): boolean {
    return this.running;
  }

  getLocalUsername(): string {
    return this.localUsername;
  }

  setLocalUsername(name: string | undefined): void {
    this.localUsername = name || 'Player';
  }

  // ─── lifecycle ───

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = nowMs();
    this.lastFrameAt = this.startedAt;
    this.threads = [];
    this.timers = [];
    this.tickCallbacks = [];
    this.handleCache.clear();
    this.clickHandlers = [];
    this.touchHandlers = [];
    this.destroyHandlers = [];
    this.keyHandlers = [];
    this.chatHandlers = [];
    this.joinHandlers = [];
    this.leaveHandlers = [];
    this.diedHandlers = [];
    this.damagedHandlers = [];
    this.itemUsedHandlers = [];
    this.itemEquippedHandlers = [];
    this.itemUnequippedHandlers = [];
    this.grabbedHandlers = [];
    this.droppedHandlers = [];

    this.interp = new LuaInterpreter({ sliceMs: 80, maxSteps: 1_500_000 });
    setPrintSink((line) => {
      useStudioStore.getState().addConsoleMessage('info', `[WeLua] ${line}`);
    });
    this.installWeluApi(this.interp);

    const store = useStudioStore.getState();

    // Load + run every enabled script (parts first, then game scripts).
    let loaded = 0;
    store.objects.forEach((obj) => {
      if (!isPart(obj)) return;
      const scripts = obj.weluScripts || [];
      for (const script of scripts) {
        if (!script.enabled) continue;
        this.runScriptChunk(script, obj.id);
        loaded++;
      }
    });
    for (const script of store.gameWeluScripts || []) {
      if (!script.enabled) continue;
      this.runScriptChunk(script, null);
      loaded++;
    }
    if (loaded > 0) {
      store.addConsoleMessage('success', `[WeLua] ${loaded} script(s) loaded.`);
    }

    this.lastFrameAt = nowMs();
    this.tick();
  }

  stop(): void {
    this.running = false;
    this.cancelSchedule();
    this.threads = [];
    this.timers = [];
    this.tickCallbacks = [];
    this.handleCache.clear();
    setPrintSink(() => {});
    this.interp = null;
  }

  /** Parse + run one script's top-level chunk (registrations happen here). */
  private runScriptChunk(script: { id: string; name: string; code: string }, partId: string | null): void {
    const ip = this.interp!;
    try {
      const chunk = parseLua(script.code);
      const prev = this.currentScriptPartId;
      this.currentScriptPartId = partId;
      const gen = ip.runChunk(chunk, this.makeScriptScope(partId));
      // Run the chunk to its first suspend (a top-level welu.wait).
      this.spawnThread(gen, script.name, true);
      this.currentScriptPartId = prev;
    } catch (e) {
      this.currentScriptPartId = null;
      this.reportError(e, script.name);
    }
  }

  /** Scripts get a scope whose `this`-context is their part. */
  private makeScriptScope(_partId: string | null): undefined {
    return undefined;
  }

  // ─── scheduler ───

  /** Browsers tick on rAF; the gamehost (Node) falls back to setTimeout. */
  private scheduleNext(): void {
    if (typeof requestAnimationFrame === 'function') {
      this.rafId = requestAnimationFrame(this.tick);
    } else {
      this.rafId = setTimeout(() => { this.rafId = null; this.tick(); }, 16) as unknown as number;
    }
  }

  private cancelSchedule(): void {
    if (this.rafId === null) return;
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.rafId);
    else clearTimeout(this.rafId);
    this.rafId = null;
  }

  private tick = (): void => {
    if (!this.running) return;
    const now = nowMs();
    const dt = Math.min((now - this.lastFrameAt) / 1000, 0.25);
    this.lastFrameAt = now;

    this.update(dt, now);
    this.scheduleNext();
  };

  private update(dt: number, now: number): void {
    const ip = this.interp;
    if (!ip) return;

    // 1) waiting threads whose time arrived
    for (let i = this.threads.length - 1; i >= 0; i--) {
      const th = this.threads[i];
      if (th.resumeAt !== null && th.resumeAt <= now) {
        th.resumeAt = null;
        this.resumeThread(th);
      }
    }

    // 2) timers
    for (const timer of this.timers) {
      if (timer.nextAt <= now) {
        timer.nextAt = now + timer.intervalSeconds * 1000;
        this.invokeCallback(timer.fn, [], `timer(${timer.intervalSeconds}s)`);
      }
    }

    // 3) tick callbacks (bounded so a script spamming onTick can't lag the game)
    if (this.tickCallbacks.length > 0) {
      const callbacks = this.tickCallbacks.slice(0, MAX_TICK_CALLBACKS);
      for (const cb of callbacks) {
        this.invokeCallback(cb.fn, [dt], 'onTick');
      }
    }

    // reap dead threads
    this.threads = this.threads.filter((t) => t.resumeAt !== undefined);
  }

  /** Spawn a thread and run it until it finishes or suspends. */
  private spawnThread(gen: Generator<unknown, unknown, unknown>, label: string, immediate = true, actor: string | null = null): void {
    const th: WeluThread = { id: ++this.threadSeq, gen, resumeAt: null, label, actor };
    this.threads.push(th);
    if (immediate) this.resumeThread(th);
  }

  private resumeThread(th: WeluThread): void {
    const ip = this.interp;
    if (!ip) return;
    ip.beginSlice();
    const prevActor = this.currentActor;
    this.currentActor = th.actor; // player API routes effects to the acting player
    try {
      const r = th.gen.next();
      if (r.done) {
        th.resumeAt = undefined as unknown as null; // mark dead (reaped below)
        const idx = this.threads.indexOf(th);
        if (idx !== -1) this.threads.splice(idx, 1);
        return;
      }
      const signal = r.value as { type?: string; seconds?: number } | null;
      if (signal && signal.type === 'wait') {
        const secs = Math.max(0.01, Number(signal.seconds ?? 0));
        th.resumeAt = nowMs() + secs * 1000;
      } else {
        // unknown signal: treat like a 0-wait (prevents busy-spinning)
        th.resumeAt = nowMs() + 50;
      }
    } catch (e) {
      const idx = this.threads.indexOf(th);
      if (idx !== -1) this.threads.splice(idx, 1);
      this.reportError(e, th.label);
    } finally {
      this.currentActor = prevActor;
    }
  }

  /** Run a Lua callback as a short thread. */
  private invokeCallback(fn: LuaValue, args: LuaValue[], label: string, actor: string | null = null): void {
    const ip = this.interp;
    if (!ip || !ip.isCallable(fn)) return;
    if (this.threads.length > MAX_THREADS) {
      useStudioStore.getState().addConsoleMessage('warn', `[WeLua] Too many running scripts — dropping a "${label}" callback.`);
      return;
    }
    try {
      const gen = ip.startCall(fn, args);
      this.spawnThread(gen, label, true, actor);
    } catch (e) {
      this.reportError(e, label);
    }
  }

  private reportError(e: unknown, label: string): void {
    const store = useStudioStore.getState();
    if (e instanceof LuaError) {
      const line = e.line ? ` (line ${e.line})` : '';
      store.addConsoleMessage('error', `[WeLua] ${label}${line}: ${typeof e.value === 'string' ? e.value : ip_toString(e.value)}`);
    } else if (e instanceof FatalLuaError) {
      store.addConsoleMessage('error', `[WeLua] ${label}: ${e.message}`);
    } else {
      store.addConsoleMessage('error', `[WeLua] ${label}: ${(e as Error)?.message ?? String(e)}`);
    }
  }

  /** Re-check scripts on newly created parts (when_created semantics). */
  handlePartCreated(partId: string): void {
    if (!this.running) return;
    const store = useStudioStore.getState();
    const obj = store.objects.get(partId);
    if (!obj || !isPart(obj)) return;
    const scripts = obj.weluScripts || [];
    for (const script of scripts) {
      if (!script.enabled) continue;
      this.runScriptChunk(script, partId);
    }
  }

  // ─── event dispatch (called from the same places the rule engine hears) ───

  handleClick(partId: string, actor?: string): void {
    if (!this.running) return;
    for (const h of this.clickHandlers) {
      if (h.partId === partId) this.invokeCallback(h.fn, [], `onClick(${partId})`, actor ?? null);
    }
  }

  handleTouch(partId: string, touchType: 'player' | 'parts' | 'any', actor?: string, actorName?: string): void {
    if (!this.running) return;
    for (const h of this.touchHandlers) {
      if (h.partId === partId) {
        this.invokeCallback(h.fn, [actorName ?? actor ?? '', touchType === 'player'], `onTouch(${partId})`, actor ?? null);
      }
    }
  }

  handleDestroyed(partId: string): void {
    if (!this.running) return;
    for (const h of this.destroyHandlers) {
      if (h.partId === partId) this.invokeCallback(h.fn, [], `onDestroy(${partId})`);
    }
    this.handleCache.delete(partId);
  }

  handleKeyDown(key: string): void {
    if (!this.running) return;
    const norm = key.length === 1 ? key.toLowerCase() : key.toLowerCase();
    for (const h of this.keyHandlers) {
      if (h.key === norm) this.invokeCallback(h.fn, [norm], `onKey(${norm})`);
    }
  }

  handleChat(username: string, message: string): void {
    if (!this.running) return;
    for (const fn of this.chatHandlers) {
      this.invokeCallback(fn, [username, message], 'onChat', username);
    }
  }

  handlePlayerJoined(username: string): void {
    if (!this.running) return;
    for (const fn of this.joinHandlers) this.invokeCallback(fn, [username], 'onPlayerJoin', username);
  }

  handlePlayerLeft(username: string): void {
    if (!this.running) return;
    for (const fn of this.leaveHandlers) this.invokeCallback(fn, [username], 'onPlayerLeave', username);
  }

  handlePlayerDamaged(username: string, amount: number, healthAfter: number): void {
    if (!this.running) return;
    for (const fn of this.damagedHandlers) this.invokeCallback(fn, [username, amount, healthAfter], 'onPlayerDamaged', username);
  }

  handlePlayerDied(username: string): void {
    if (!this.running) return;
    for (const fn of this.diedHandlers) this.invokeCallback(fn, [username], 'onPlayerDied', username);
  }

  handleItemUsed(itemName: string, actor?: string): void {
    if (!this.running) return;
    for (const fn of this.itemUsedHandlers) this.invokeCallback(fn, [itemName], 'onItemUsed', actor ?? this.localUsername);
  }

  handleItemEquipped(itemName: string): void {
    if (!this.running) return;
    for (const fn of this.itemEquippedHandlers) this.invokeCallback(fn, [itemName], 'onItemEquipped');
  }

  handleItemUnequipped(itemName: string): void {
    if (!this.running) return;
    for (const fn of this.itemUnequippedHandlers) this.invokeCallback(fn, [itemName], 'onItemUnequipped');
  }

  handleGrabbed(itemName: string): void {
    if (!this.running) return;
    for (const fn of this.grabbedHandlers) this.invokeCallback(fn, [itemName], 'onGrabbed');
  }

  handleDropped(itemName: string): void {
    if (!this.running) return;
    for (const fn of this.droppedHandlers) this.invokeCallback(fn, [itemName], 'onDropped');
  }

  // ─── part handles ───

  private partHandle(partId: string): LuaTable {
    let handle = this.handleCache.get(partId);
    if (handle) return handle;
    handle = new LuaTable();
    const runtime = this;
    const ip = this.interp!;

    // properties via metatable __index/__newindex
    const meta = new LuaTable();
    meta.set('__index', { native: (ip2: LuaInterpreter, args: LuaValue[]): LuaValue[] => {
      const key = ip2.toString(args[1] ?? null);
      return [runtime.readPartProperty(partId, key)];
    } } as LuaFunction);
    meta.set('__newindex', { native: (ip2: LuaInterpreter, args: LuaValue[]): void => {
      const key = ip2.toString(args[1] ?? null);
      runtime.writePartProperty(partId, key, args[2] ?? null);
    } } as LuaFunction);
    meta.set('__tostring', { native: (ip2: LuaInterpreter, args: LuaValue[]) => {
      const part = useStudioStore.getState().objects.get(partId);
      return [ip2.toString(`part(${part && isPart(part) ? part.name : 'gone'})`)];
    } } as LuaFunction);
    handle.metatable = meta;

    // methods
    const define = (name: string, fn: (ip2: LuaInterpreter, args: LuaValue[]) => LuaValue | LuaValue[] | void) => {
      handle!.set(name, { native: fn } as LuaFunction);
    };
    const getSelf = (): StudioPart | undefined => {
      const obj = useStudioStore.getState().objects.get(partId);
      return obj && isPart(obj) ? obj : undefined;
    };

    define('id', () => partId);
    define('getPosition', () => vecToTable(getSelf()?.position));
    define('setPosition', (ip2, args) => {
      if (!runtime.canWriteWorld()) return;
      const v = tableToVec(args[0]);
      if (v) useStudioStore.getState().updateObject(partId, { position: v } as Partial<StudioObject>);
    });
    define('getSize', () => vecToTable(getSelf()?.size));
    define('setSize', (ip2, args) => {
      if (!runtime.canWriteWorld()) return;
      const v = tableToVec(args[0]);
      if (v) useStudioStore.getState().updateObject(partId, { size: v } as Partial<StudioObject>);
    });
    define('getRotation', () => vecToTable(getSelf()?.rotation));
    define('setRotation', (ip2, args) => {
      if (!runtime.canWriteWorld()) return;
      const v = tableToVec(args[0]);
      if (v) useStudioStore.getState().updateObject(partId, { rotation: v } as Partial<StudioObject>);
    });
    define('getColor', () => getSelf()?.color ?? null);
    define('setColor', (ip2, args) => {
      const c = ip2.toString(args[0] ?? null);
      if (c) useStudioStore.getState().updateObject(partId, { color: c } as Partial<StudioObject>);
    });
    define('getName', () => getSelf()?.name ?? null);
    define('setName', (ip2, args) => {
      const n = ip2.toString(args[0] ?? null);
      if (n) useStudioStore.getState().updateObject(partId, { name: n } as Partial<StudioObject>);
    });
    define('destroy', () => {
      if (!runtime.canWriteWorld()) return;
      const s = useStudioStore.getState();
      if (s.objects.has(partId)) s.removeObject(partId);
    });
    define('clone', (ip2, args): LuaValue[] => {
      const copy = runtime.clonePart(partId, tableToVec(args[0]));
      return copy ? [runtime.partHandle(copy.id)] : [null];
    });
    define('applyForce', (ip2, args) => {
      const v = tableToVec(args[0]);
      if (v) runtime.addBodyMoverForce(partId, v);
    });
    define('applyImpulse', (ip2, args) => {
      const v = tableToVec(args[0]);
      if (v) runtime.applyImpulse(partId, v);
    });
    define('catchFire', () => runtime.addEffect(partId, 'Fire', { color: '#ff6a00', size: 1 }));
    define('extinguish', () => runtime.removeEffects(partId, 'Fire'));
    define('light', (ip2, args) => {
      const color = args.length > 0 ? ip2.toString(args[0]) : '#ffffff';
      const brightness = args.length > 1 ? ip2.toNumber(args[1]) : 2;
      const range = args.length > 2 ? ip2.toNumber(args[2]) : 8;
      runtime.addEffect(partId, 'Light', { color, brightness, range });
    });
    define('disableLight', () => runtime.removeEffects(partId, 'Light'));
    define('smoke', (ip2, args) => {
      const color = args.length > 0 ? ip2.toString(args[0]) : '#cccccc';
      const size = args.length > 1 ? ip2.toNumber(args[1]) : 1;
      const opacity = args.length > 2 ? ip2.toNumber(args[2]) : 0.4;
      runtime.addEffect(partId, 'Smoke', { color, size, opacity });
    });
    define('clearSmoke', () => runtime.removeEffects(partId, 'Smoke'));
    define('weld', (ip2, args) => {
      const other = args[0] instanceof LuaTable ? String((args[0] as LuaTable).get('id') ?? '') : ip2.toString(args[0] ?? null);
      if (!other) return;
      runtime.weldParts(partId, other);
    });
    define('breakJoints', () => { if (runtime.canWriteWorld()) useStudioStore.getState().breakJoints(partId); });

    this.handleCache.set(partId, handle);
    return handle;
  }

  /** Property reads behind part.foo */
  private readPartProperty(partId: string, key: string): LuaValue {
    const part = useStudioStore.getState().objects.get(partId);
    if (!part || !isPart(part)) return null;
    switch (key) {
      case 'name': return part.name;
      case 'label': return part.label ?? null; // UI parts (Button/Sign/Panel)
      case 'type': return part.type;
      case 'position': return vecToTable(part.position);
      case 'size': return vecToTable(part.size);
      case 'rotation': return vecToTable(part.rotation);
      case 'color': return part.color;
      case 'material': return part.material;
      case 'transparency': return part.transparency;
      case 'reflectance': return part.reflectance;
      case 'anchored': return part.anchored;
      case 'canCollide': return part.canCollide;
      case 'visible': return part.showInWorld !== false;
      default: return null;
    }
  }

  /** Property writes behind part.foo = x */
  private writePartProperty(partId: string, key: string, value: LuaValue): void {
    if (!this.canWriteWorld()) return; // clients: the server owns the world
    const store = useStudioStore.getState();
    const part = store.objects.get(partId);
    if (!part || !isPart(part)) return;
    const ip = this.interp!;
    switch (key) {
      case 'name': store.updateObject(partId, { name: ip.toString(value) } as Partial<StudioObject>); break;
      case 'label': store.updateObject(partId, { label: ip.toString(value) } as Partial<StudioObject>); break; // UI parts
      case 'position': {
        const v = tableToVec(value);
        if (v) store.updateObject(partId, { position: v } as Partial<StudioObject>);
        break;
      }
      case 'size': {
        const v = tableToVec(value);
        if (v) store.updateObject(partId, { size: v } as Partial<StudioObject>);
        break;
      }
      case 'rotation': {
        const v = tableToVec(value);
        if (v) store.updateObject(partId, { rotation: v } as Partial<StudioObject>);
        break;
      }
      case 'color': store.updateObject(partId, { color: ip.toString(value) } as Partial<StudioObject>); break;
      case 'material': store.updateObject(partId, { material: ip.toString(value) as MaterialType } as Partial<StudioObject>); break;
      case 'transparency': store.updateObject(partId, { transparency: clamp01(ip.toNumber(value)) } as Partial<StudioObject>); break;
      case 'reflectance': store.updateObject(partId, { reflectance: clamp01(ip.toNumber(value)) } as Partial<StudioObject>); break;
      case 'anchored': store.updateObject(partId, { anchored: ip.truthy(value) } as Partial<StudioObject>); break;
      case 'canCollide': store.updateObject(partId, { canCollide: ip.truthy(value) } as Partial<StudioObject>); break;
      case 'visible': store.updateObject(partId, { showInWorld: ip.truthy(value) } as Partial<StudioObject>); break;
      default: break; // unknown properties are ignored (sandboxed)
    }
  }

  // ─── helpers used by handles ───

  private clonePart(partId: string, offset: Vector3 | null): StudioPart | null {
    if (!this.canWriteWorld()) return null;
    const store = useStudioStore.getState();
    const src = store.objects.get(partId);
    if (!src || !isPart(src)) return null;
    const copy: StudioPart = JSON.parse(JSON.stringify(src));
    copy.id = genId('obj');
    copy.name = nextCopyName(src.name);
    copy.position = {
      x: copy.position.x + (offset?.x ?? 0),
      y: copy.position.y + (offset?.y ?? 0),
      z: copy.position.z + (offset?.z ?? 0),
    };
    copy.rules = undefined; // rules do NOT travel with clones (same as block rules)
    copy.weluScripts = undefined;
    store.addObject(copy);
    return copy;
  }

  private addBodyMoverForce(partId: string, force: Vector3): void {
    if (!this.canWriteWorld()) return;
    const store = useStudioStore.getState();
    const part = store.objects.get(partId);
    if (!part || !isPart(part)) return;
    const mover = {
      id: genId('mover'),
      type: 'BodyForce' as const,
      force,
      enabled: true,
    };
    store.addBodyMover(partId, mover as any);
  }

  private applyImpulse(partId: string, force: Vector3): void {
    if (!this.canWriteWorld()) return;
    const world = (globalThis as any).__weildPhysicsWorld;
    if (world?.addImpulse) {
      world.addImpulse(partId, force, 0.25);
    }
  }

  private addEffect(partId: string, type: PartEffect['type'], opts: Partial<PartEffect>): void {
    if (!this.canWriteWorld()) return;
    const store = useStudioStore.getState();
    const part = store.objects.get(partId);
    if (!part || !isPart(part)) return;
    const existing = (part.effects || []).filter((e) => e.type === type);
    if (existing.length > 0) return; // one effect of each type per part
    const effect: PartEffect = {
      id: genId('fx'),
      type,
      color: opts.color ?? '#ffffff',
      size: clampNum(opts.size ?? 1, 0.1, 10),
      enabled: true,
      ...(type === 'Light' ? { brightness: clampNum(opts.brightness ?? 2, 0, 10), range: clampNum(opts.range ?? 8, 0.1, 60) } : {}),
      ...(type === 'Smoke' ? { opacity: clamp01(opts.opacity ?? 0.4) } : {}),
    };
    store.addEffect(partId, effect);
  }

  private removeEffects(partId: string, type: PartEffect['type']): void {
    if (!this.canWriteWorld()) return;
    const store = useStudioStore.getState();
    const part = store.objects.get(partId);
    if (!part || !isPart(part)) return;
    for (const e of part.effects || []) {
      if (e.type === type) store.removeEffect(partId, e.id);
    }
  }

  private weldParts(aId: string, bId: string): void {
    if (!this.canWriteWorld()) return;
    const store = useStudioStore.getState();
    const a = store.objects.get(aId);
    const b = store.objects.get(bId);
    if (!a || !b || !isPart(a) || !isPart(b) || aId === bId) return;
    const joint: Joint = {
      id: genId('joint'),
      type: 'Weld',
      partAId: aId,
      partBId: bId,
      enabled: true,
    };
    store.addJoint(joint);
  }

  // ─── the welu API ───

  private installWeluApi(ip: LuaInterpreter): void {
    const runtime = this;
    const welu = new LuaTable();
    ip.globals.set('welu', welu);

    const fn = (
      name: string,
      impl: (ip2: LuaInterpreter, args: LuaValue[]) => LuaValue | LuaValue[] | void,
    ) => {
      welu.set(name, { native: impl } as LuaFunction);
    };
    const genFn = (
      name: string,
      impl: (ip2: LuaInterpreter, args: LuaValue[]) => Generator<unknown, LuaValue | LuaValue[] | void, unknown>,
    ) => {
      welu.set(name, { nativeGen: impl } as unknown as LuaFunction);
    };

    // ── util ──
    genFn('wait', function* (ip2, args) {
      const secs = Math.max(0.01, Math.min(60, ip2.toNumber(args[0] ?? 0.1)));
      yield { type: 'wait', seconds: secs };
      return secs;
    });
    fn('time', () => (nowMs() - this.startedAt) / 1000);
    fn('print', (ip2, args) => {
      useStudioStore.getState().addConsoleMessage('info', args.map((a) => ip2.toString(a)).join(' '));
    });

    // ── screen message / sound ──
    fn('message', (ip2, args) => {
      const text = ip2.toString(args[0] ?? '');
      if (!text) return;
      const duration = args.length > 1 ? clampNum(ip2.toNumber(args[1]), 0.5, 60) : 3;
      const color = args.length > 2 ? ip2.toString(args[2]) : '#ffffff';
      useStudioStore.getState().addScreenMessage({
        message: text,
        position: 'top',
        textColor: color,
        fontStyle: 'bold',
        fontSize: 20,
        backgroundColor: 'rgba(0,0,0,0.45)',
        duration,
      });
    });
    fn('sound', (ip2, args) => {
      const name = ip2.toString(args[0] ?? 'click');
      const volume = args.length > 1 ? clamp01(ip2.toNumber(args[1])) : 0.5;
      void playSound(name, volume);
    });

    // ── context + finding parts ──
    fn('this', () => {
      const partId = this.currentScriptPartId;
      return partId ? this.partHandle(partId) : null;
    });
    fn('find', (ip2, args) => {
      const name = ip2.toString(args[0] ?? '');
      const store = useStudioStore.getState();
      let found: string | null = null;
      store.objects.forEach((obj) => {
        if (found || !isPart(obj)) return;
        if (obj.name.toLowerCase() === name.toLowerCase()) found = obj.id;
      });
      return found ? this.partHandle(found) : null;
    });
    fn('findAll', (ip2, args) => {
      const name = ip2.toString(args[0] ?? '').toLowerCase();
      const out = new LuaTable();
      let n = 1;
      useStudioStore.getState().objects.forEach((obj) => {
        if (!isPart(obj)) return;
        if (obj.name.toLowerCase() === name) out.set(n++, this.partHandle(obj.id));
      });
      return out;
    });
    fn('allParts', () => {
      const out = new LuaTable();
      let n = 1;
      useStudioStore.getState().objects.forEach((obj) => {
        if (isPart(obj) && obj.showInWorld !== false) out.set(n++, this.partHandle(obj.id));
      });
      return out;
    });

    // ── creating parts ──
    fn('create', (ip2, args) => {
      if (!runtime.canWriteWorld()) return null; // clients: server-only world writes
      const opts = args[0];
      if (!(opts instanceof LuaTable)) return null;
      const store = useStudioStore.getState();
      const str = (k: string, d: string) => (opts.get(k) !== null ? ip2.toString(opts.get(k)) : d);
      // v7.5: the UI part family is creatable from Lua too (Button/Sign/Panel).
      const validTypes: readonly string[] = ['Block', 'Sphere', 'Wedge', 'Cylinder', 'Spawn', 'Button', 'Sign', 'Panel'];
      const type = validTypes.includes(str('type', 'Block')) ? str('type', 'Block') as PartType : 'Block';
      const pos = tableToVec(opts.get('position')) ?? { x: 0, y: 1, z: 0 };
      const size = tableToVec(opts.get('size')) ?? { x: 1, y: 1, z: 1 };
      const rotation = tableToVec(opts.get('rotation')) ?? { x: 0, y: 0, z: 0 };
      const part: StudioPart = {
        id: genId('obj'),
        name: str('name', 'Part'),
        type,
        position: pos,
        size,
        rotation,
        color: str('color', '#4a90d9'),
        material: 'Plastic',
        transparency: opts.get('transparency') !== null ? clamp01(ip2.toNumber(opts.get('transparency'))) : 0,
        reflectance: 0,
        anchored: opts.get('anchored') !== null ? ip2.truthy(opts.get('anchored')) : true,
        canCollide: opts.get('canCollide') !== null ? ip2.truthy(opts.get('canCollide')) : true,
        friction: 0.3,
        elasticity: 0,
        density: 1,
        children: [],
        parentId: null,
        bodyMovers: [],
      };
      store.addObject(part);
      return this.partHandle(part.id);
    });

    // ── explosion ──
    fn('explode', (ip2, args) => {
      if (!runtime.canWriteWorld()) return; // clients: the server owns explosions
      const v = tableToVec(args[0]) ?? { x: 0, y: 0, z: 0 };
      const radius = args.length > 1 ? clampNum(ip2.toNumber(args[1]), 0.5, 60) : 4;
      const pressure = args.length > 2 ? clampNum(ip2.toNumber(args[2]), 0, 2_000_000) : 500_000;
      useStudioStore.getState().createExplosion(v, radius, pressure);
    });

    // ── variables (shared with block rules) ──
    fn('getVar', (ip2, args) => {
      const name = ip2.toString(args[0] ?? '');
      const v = useStudioStore.getState().globalVariables[name];
      return v === undefined ? null : v;
    });
    fn('setVar', (ip2, args) => {
      const name = ip2.toString(args[0] ?? '');
      if (!name) return;
      const value = args[1] ?? null;
      const storeValue = typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean'
        ? value
        : ip2.toString(value);
      useStudioStore.getState().setGlobalVariable(name, storeValue);
    });

    // ── world settings ──
    // Virtual properties on the welu table (gravity / timeOfDay / weather)
    // dispatched through one metatable — reads hit the store, writes go back.
    const propHooks = new Map<string, { get: () => LuaValue; set: (v: number | string) => void }>();
    propHooks.set('gravity', {
      get: () => useStudioStore.getState().physicsSettings.gravity,
      set: (v) => {
        if (!runtime.canWriteWorld()) return;
        const n = clampNum(Number(v), -200, 0);
        useStudioStore.getState().setPhysicsSettings({ gravity: n });
        useStudioStore.getState().setWorldSettings({ gravity: n });
      },
    });
    propHooks.set('timeOfDay', {
      get: () => useStudioStore.getState().worldSettings.timeOfDay,
      set: (v) => { if (runtime.canWriteWorld()) useStudioStore.getState().setWorldSettings({ timeOfDay: ((Number(v) % 24) + 24) % 24 }); },
    });
    propHooks.set('weather', {
      get: () => useStudioStore.getState().worldSettings.weatherType,
      set: (v) => {
        const allowed = ['clear', 'cloudy', 'rain', 'snow'] as const;
        const s = String(v) as typeof allowed[number];
        if (runtime.canWriteWorld() && (allowed as readonly string[]).includes(s)) {
          useStudioStore.getState().setWorldSettings({ weatherType: s });
        }
      },
    });
    const weluMeta = new LuaTable();
    weluMeta.set('__index', { native: (ip2: LuaInterpreter, args: LuaValue[]): LuaValue => {
      const key = ip2.toString(args[1] ?? null);
      const hook = propHooks.get(key);
      return hook ? hook.get() : null;
    } } as LuaFunction);
    weluMeta.set('__newindex', { native: (ip2: LuaInterpreter, args: LuaValue[]): void => {
      const key = ip2.toString(args[1] ?? null);
      const hook = propHooks.get(key);
      if (!hook) return; // unknown fields are ignored (sandboxed)
      const v = args[2] ?? null;
      if (typeof v === 'number' || typeof v === 'string') hook.set(v);
    } } as LuaFunction);
    welu.metatable = weluMeta;

    // ── camera ──
    const camera = new LuaTable();
    const camFn = (name: string, impl: (ip2: LuaInterpreter, args: LuaValue[]) => void) => {
      camera.set(name, { native: impl } as LuaFunction);
    };
    camFn('setPosition', (ip2, args) => {
      const v = tableToVec(args[0]);
      if (v) {
        WB_CAMERA_BRIDGE.position = v;
        WB_CAMERA_BRIDGE.nonce++;
      }
    });
    camFn('setYaw', (ip2, args) => {
      WB_CAMERA_BRIDGE.yaw = ((ip2.toNumber(args[0] ?? 0) % 360) + 360) % 360;
      WB_CAMERA_BRIDGE.nonce++;
    });
    camFn('setPitch', (ip2, args) => {
      WB_CAMERA_BRIDGE.pitch = Math.max(-85, Math.min(85, ip2.toNumber(args[0] ?? 0)));
      WB_CAMERA_BRIDGE.nonce++;
    });
    welu.set('camera', camera);

    // ── player ──
    const player = new LuaTable();
    const playerMeta = new LuaTable();
    playerMeta.set('__index', { native: (ip2: LuaInterpreter, args: LuaValue[]): LuaValue => {
      const key = ip2.toString(args[1] ?? null);
      return runtime.readPlayerProperty(key);
    } } as LuaFunction);
    playerMeta.set('__newindex', { native: (ip2: LuaInterpreter, args: LuaValue[]): void => {
      const key = ip2.toString(args[1] ?? null);
      runtime.writePlayerProperty(key, args[2] ?? null);
    } } as LuaFunction);
    player.metatable = playerMeta;
    const playerFn = (name: string, impl: (ip2: LuaInterpreter, args: LuaValue[]) => LuaValue | LuaValue[] | void) => {
      player.set(name, { native: impl } as LuaFunction);
    };
    // Player-only code (kill/teleport/heal THIS player): on the gamehost
    // it goes through the shared per-player effect queue (the gamehost
    // applies it to the right player); everywhere else — singleplayer and
    // the player's OWN client — it runs RIGHT HERE on this machine.
    playerFn('teleport', (ip2, args) => {
      const v = tableToVec(args[0]) ?? (args.length >= 3 ? { x: ip2.toNumber(args[0]), y: ip2.toNumber(args[1]), z: ip2.toNumber(args[2]) } : null);
      if (!v) return;
      runtime.applyPlayerEffect({ kind: 'teleport', position: v }, () => {
        useStudioStore.getState().setPlayState({ teleportPosition: v });
      });
    });
    playerFn('damage', (ip2, args) => {
      const amount = clampNum(ip2.toNumber(args[0] ?? 0), 0, 1e9);
      runtime.applyPlayerEffect({ kind: 'damage', value: -amount }, () => {
        const st = useStudioStore.getState();
        const hp = Math.max(0, st.playState.characterHealth - amount);
        st.setPlayState({ characterHealth: hp });
        if (amount > 0) runtime.notifyDamage(amount, hp);
      });
    });
    playerFn('heal', (ip2, args) => {
      const amount = clampNum(ip2.toNumber(args[0] ?? 0), 0, 1e9);
      runtime.applyPlayerEffect({ kind: 'heal' }, () => {
        const st = useStudioStore.getState();
        st.setPlayState({ characterHealth: Math.min(st.playState.characterMaxHealth, st.playState.characterHealth + amount) });
      });
    });
    playerFn('kill', () => {
      runtime.applyPlayerEffect({ kind: 'kill' }, () => {
        const st = useStudioStore.getState();
        const hp = 0;
        st.setPlayState({ characterHealth: hp });
        runtime.notifyDamage(st.playState.characterHealth, hp);
      });
    });
    playerFn('respawn', () => {
      runtime.applyPlayerEffect({ kind: 'respawn' }, () => {
        const st = useStudioStore.getState();
        st.setPlayState({ pendingRespawn: st.playState.pendingRespawn + 1, characterHealth: st.playState.characterMaxHealth });
      });
    });
    playerFn('giveItem', (ip2, args) => runtime.inventoryApiCall('give', ip2.toString(args[0] ?? '')));
    playerFn('removeItem', (ip2, args) => runtime.inventoryApiCall('remove', ip2.toString(args[0] ?? '')));
    welu.set('player', player);

    // ── items ──
    fn('giveItem', (ip2, args) => runtime.inventoryApiCall('give', ip2.toString(args[0] ?? '')));
    fn('removeItem', (ip2, args) => runtime.inventoryApiCall('remove', ip2.toString(args[0] ?? '')));
    fn('dropItem', (ip2, args) => runtime.inventoryApiCall('drop', ip2.toString(args[0] ?? '')));
    fn('inventoryNames', () => runtime.inventoryApiCall('names', ''));

    // ── events ──
    const register = (
      list: Array<{ partId: string | null; fn: LuaValue }>,
      ip2: LuaInterpreter,
      args: LuaValue[],
      requirePart: boolean,
    ): void => {
      const cb = args[0];
      if (!ip2.isCallable(cb)) return;
      if (requirePart && !this.currentScriptPartId) return; // part-only events on game scripts are ignored
      list.push({ partId: requirePart ? this.currentScriptPartId : null, fn: cb });
    };

    // onStart fires registered callbacks immediately (scripts load at start)
    welu.set('onStart', { native: (ip2: LuaInterpreter, args: LuaValue[]): void => {
      const cb = args[0];
      if (ip2.isCallable(cb)) this.invokeCallback(cb, [], 'onStart');
    } } as LuaFunction);
    welu.set('onTick', { native: (ip2: LuaInterpreter, args: LuaValue[]): void => {
      const cb = args[0];
      if (ip2.isCallable(cb) && this.tickCallbacks.length < MAX_TICK_CALLBACKS) {
        this.tickCallbacks.push({ fn: cb, partId: this.currentScriptPartId });
      }
    } } as LuaFunction);
    welu.set('onTimer', { native: (ip2: LuaInterpreter, args: LuaValue[]): void => {
      const seconds = Math.max(0.05, clampNum(ip2.toNumber(args[0] ?? 1), 0.05, 3600));
      const cb = args[1];
      if (ip2.isCallable(cb) && this.timers.length < MAX_TIMERS) {
        this.timers.push({ intervalSeconds: seconds, fn: cb, nextAt: nowMs() + seconds * 1000 });
      }
    } } as LuaFunction);
    welu.set('onClick', { native: (ip2, args) => register(this.clickHandlers, ip2, args, true) } as LuaFunction);
    welu.set('onTouch', { native: (ip2, args) => register(this.touchHandlers, ip2, args, true) } as LuaFunction);
    welu.set('onDestroy', { native: (ip2, args) => register(this.destroyHandlers, ip2, args, true) } as LuaFunction);
    welu.set('onKey', { native: (ip2: LuaInterpreter, args: LuaValue[]): void => {
      const key = ip2.toString(args[0] ?? '').toLowerCase();
      const cb = args[1];
      if (key && ip2.isCallable(cb) && this.keyHandlers.length < 64) {
        this.keyHandlers.push({ key, fn: cb });
      }
    } } as LuaFunction);
    const simple = (list: LuaValue[]) => (ip2: LuaInterpreter, args: LuaValue[]): void => {
      const cb = args[0];
      if (ip2.isCallable(cb) && list.length < 64) list.push(cb);
    };
    welu.set('onChat', { native: simple(this.chatHandlers) } as LuaFunction);
    welu.set('onPlayerJoin', { native: simple(this.joinHandlers) } as LuaFunction);
    welu.set('onPlayerLeave', { native: simple(this.leaveHandlers) } as LuaFunction);
    welu.set('onPlayerDied', { native: simple(this.diedHandlers) } as LuaFunction);
    welu.set('onPlayerDamaged', { native: simple(this.damagedHandlers) } as LuaFunction);
    welu.set('onItemUsed', { native: simple(this.itemUsedHandlers) } as LuaFunction);
    welu.set('onItemEquipped', { native: simple(this.itemEquippedHandlers) } as LuaFunction);
    welu.set('onItemUnequipped', { native: simple(this.itemUnequippedHandlers) } as LuaFunction);
    welu.set('onGrabbed', { native: simple(this.grabbedHandlers) } as LuaFunction);
    welu.set('onDropped', { native: simple(this.droppedHandlers) } as LuaFunction);
  }

  // ─── player property bridge ───

  private readPlayerProperty(key: string): LuaValue {
    const st = useStudioStore.getState();
    switch (key) {
      case 'name': return this.localUsername;
      case 'position': return vecToTable(st.playState.characterPosition);
      case 'health': return st.playState.characterHealth;
      case 'maxHealth': return st.playState.characterMaxHealth;
      case 'speed': return st.playState.characterSpeed || 10.8;
      default: return null;
    }
  }

  private writePlayerProperty(key: string, value: LuaValue): void {
    const ip = this.interp!;
    const st = useStudioStore.getState();
    switch (key) {
      case 'health': {
        const hp = clampNum(ip.toNumber(value), 0, st.playState.characterMaxHealth);
        this.applyPlayerEffect({ kind: 'set_health', value: hp }, () => {
          const before = useStudioStore.getState().playState.characterHealth;
          useStudioStore.getState().setPlayState({ characterHealth: hp });
          if (hp < before) this.notifyDamage(before - hp, hp);
        });
        break;
      }
      case 'maxHealth': st.setPlayState({ characterMaxHealth: Math.max(1, ip.toNumber(value)) }); break;
      case 'speed': {
        const speed = Math.max(0, ip.toNumber(value));
        this.applyPlayerEffect({ kind: 'set_speed', value: speed }, () => {
          useStudioStore.getState().setPlayState({ characterSpeed: speed });
        });
        break;
      }
      default: break;
    }
  }

  private notifyDamage(amount: number, healthAfter: number): void {
    // mirror the rule engine's damage hooks (for game scripts)
    this.handlePlayerDamaged(this.localUsername, amount, healthAfter);
  }

  // ─── player effects (multiplayer routing) ───

  /**
   * Run a player-targeting change. On the GAMEHOST (server-authoritative
   * multiplayer) it is queued through the rule engine's per-player effect
   * pipeline so the gamehost applies it to the acting player. Everywhere
   * else — singleplayer / Test Play / the player's OWN client — the change
   * executes immediately on this machine (the user's ask: player-only
   * code runs on the player's machine).
   */
  private applyPlayerEffect(effect: PlayerEffect, localMut: () => void): void {
    const netServer = useStudioStore.getState().netcode?.mode === 'server';
    if (netServer && this.worldAuthority) {
      weildCodeEngine.queuePlayerEffect({
        ...effect,
        target: effect.target ?? 'this',
        username: this.currentActor ?? undefined,
      });
      return;
    }
    localMut();
  }

  // ─── inventory API (late-bound to the player-inventory manager) ───

  private inventoryApiCall(op: 'give' | 'remove' | 'drop' | 'names', name: string): LuaValue | LuaValue[] {
    const inv = (globalThis as any).__wbPlayerInventory as {
      giveItemByName?: (n: string) => boolean;
      removeItemByName?: (n: string) => boolean;
      dropItemByName?: (n: string) => boolean;
      itemNames?: () => string[];
    } | undefined;
    if (!inv) return op === 'names' ? new LuaTable() : null;
    switch (op) {
      case 'give': return inv.giveItemByName?.(name) ?? false;
      case 'remove': return inv.removeItemByName?.(name) ?? false;
      case 'drop': return inv.dropItemByName?.(name) ?? false;
      case 'names': {
        const out = new LuaTable();
        const names = inv.itemNames?.() ?? [];
        names.forEach((n, i) => out.set(i + 1, n));
        return out;
      }
    }
    return null;
  }
}

// ─── small helpers ───

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
}
function clampNum(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Number.isFinite(v) ? v : lo));
}

function vecToTable(v: Vector3 | undefined | null): LuaTable {
  const t = new LuaTable();
  t.set('x', v?.x ?? 0);
  t.set('y', v?.y ?? 0);
  t.set('z', v?.z ?? 0);
  return t;
}

function tableToVec(v: LuaValue): Vector3 | null {
  if (!(v instanceof LuaTable)) return null;
  const x = v.get('x');
  const y = v.get('y');
  const z = v.get('z');
  if (typeof x !== 'number' || typeof y !== 'number' || typeof z !== 'number') return null;
  return { x, y, z };
}

function nextCopyName(name: string): string {
  const m = /^(.*) \((\d+)\)$/.exec(name);
  if (m) return `${m[1]} (${parseInt(m[2], 10) + 1})`;
  return `${name} (2)`;
}

function ip_toString(v: LuaValue): string {
  if (v === null) return 'nil';
  if (typeof v === 'string') return v;
  return String(v);
}

// The singleton (matches weildCodeEngine's export pattern).
export const weluRuntime = new WeluRuntime();

// Debug handle (matches __wbEngine / __tsfManager's pattern).
if (typeof window !== 'undefined') {
  (window as any).__weluRuntime = weluRuntime;
}

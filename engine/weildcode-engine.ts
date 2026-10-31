// ═══════════════════════════════════════════════════════════════════
// WeildCode Runtime Engine - Executes rules during Play/Test mode
// ═══════════════════════════════════════════════════════════════════
//
// This engine runs ONLY when playState.isPlaying or simulationState.isSimulating
// is true. It processes triggers and executes actions on the store.

import {
  WeildCodeRule,
  WeildCodeAction,
  TriggerType,
  ActionType,
  OperandSpec,
  TRIGGER_DEFINITIONS,
  ACTION_DEFINITIONS,
  createBlankRule,
  createBlankAction,
} from './weildcode-types';
import { useStudioStore, isPart, StudioPart, Vector3, PartType } from './studio-store';
import { playSound, playCue } from './sounds';

// ─── Engine State ───

interface TimerState {
  ruleId: string;
  partId: string;
  intervalSeconds: number;
  repeat: 'once' | 'every';
  elapsed: number;
  fired: boolean; // for 'once' mode
  maxRepeats: number; // for repeat_every (0 = infinity)
  fireCount: number;
  /** v7 FIX: repeat_every timers re-run THESE actions (the block's
   * children), not the whole rule again. */
  actions?: WeildCodeAction[];
  /** v6.2.1: the player whose event scheduled this timer (kills/heals
   * scheduled by a touch keep targeting the toucher). */
  actor?: string;
}

interface PendingWait {
  ruleId: string;
  partId: string;
  actionIndex: number;
  remainingSeconds: number;
  /** v1.5: the wait belongs to a GAME rule (no part context). */
  gameRule?: boolean;
  /** v6.2.1: the player whose event started this wait. */
  actor?: string;
  /** v7 FIX: the EXACT action array the wait sits in. The old code resumed
   * with `rule.actions.slice(index + 1)` - correct at the top level, but a
   * wait nested inside repeat / tell_object / if children resumed at that
   * index in the TOP-LEVEL actions instead, so whole chunks of a rule
   * silently "skipped" after the wait. */
  actions: WeildCodeAction[];
}

// ─── v6.2.1: per-player rule effects (multiplayer) ───
// The engine's health/teleport model predates multiplayer: there is ONE
// shared playState.characterHealth. In SERVER-AUTHORITATIVE mode that means
// "kill the player who touched the lava" used to kill EVERYONE (the store
// is shared by all players). Now, in server mode, player-targeting actions
// (kill / heal / set_health / modify_player_health / teleport) push an
// effect onto this queue instead of writing the shared store. The gamehost
// worker drains the queue and applies each effect to the ACTING player only
// (or to everyone when the rule had no player context, e.g. timers).
// Singleplayer / Test Play keeps the old store-writing behavior exactly.
export interface PlayerEffect {
  kind: 'kill' | 'heal' | 'set_health' | 'damage' | 'teleport' | 'set_speed' | 'set_spawn' | 'respawn' | 'message';
  /** The acting player (trigger source). Undefined = apply to ALL players
   * (timer/global rules - the classic shared semantics). */
  username?: string;
  /** v7: who the effect applies to. 'this' (default) = the acting player,
   * 'all' = everyone, 'username' = the player named in targetName. */
  target?: 'this' | 'all' | 'username';
  /** v7: the username when target === 'username'. */
  targetName?: string;
  /** For set_health / damage: the hp value or delta. */
  value?: number;
  /** For set_speed: add to the current speed instead of replacing it. */
  relative?: boolean;
  /** For teleport: the target feet position. */
  position?: { x: number; y: number; z: number };
  /** For set_spawn: the resolved spawn position. */
  spawn?: { x: number; y: number; z: number };
  /** For message: the screen message payload (delivered to the target
   * players ONLY - it never rides the broadcast snapshot). */
  message?: {
    message: string;
    position: 'top' | 'bottom';
    textColor: string;
    fontStyle: 'normal' | 'bold' | 'italic' | 'bold-italic';
    fontSize: number;
    backgroundColor: string;
    duration: number;
  };
}

class WeildCodeEngine {
  private timers: Map<string, TimerState> = new Map();
  private pendingWaits: Map<string, PendingWait> = new Map();
  private lastTime: number = 0;
  private animFrameId: number | null = null;
  private isRunning: boolean = false;

  // ─── v6.2.1: per-player effects + acting-player context ───
  /** Pending player-targeting effects (server mode only). */
  private playerEffects: PlayerEffect[] = [];
  private static MAX_PLAYER_EFFECTS = 256; // bound rule storms
  /** The player whose trigger is currently executing (undefined = global). */
  private currentActor: string | undefined = undefined;

  // ─── v7: acting-player context for interpolation + conditions ───
  /** The local player's name (solo mode has no roster; the play viewports
   * set this when play starts). */
  private localUsername = 'Player';
  /** Per-player stats pushed by the gamehost authority (hp/speed) so IF
   * conditions and $(health)-style text can read ANY player's numbers. */
  private playerStats = new Map<string, { health: number; maxHealth: number; speed: number }>();
  /** Monotonic counter for unique wait keys (two waits at the same index
   * in different child arrays used to overwrite each other). */
  private waitSeq = 0;
  /** Re-entrancy guard for the damage/died events (a damage rule that
   * damages again must not loop forever). */
  private eventDepth = 0;

  // ─── v1.7: performance guards (no lag machines) ───
  /** Actions executed during the current frame; reset in update(). */
  private frameActionCount: number = 0;
  private static MAX_ACTIONS_PER_FRAME = 2000;
  private lastBudgetWarnAt: number = 0;
  /** Smallest allowed timer/wait interval (10 fires per second per rule). */
  private static MIN_INTERVAL = 0.1;
  /** Hard cap on one `repeat` activation. */
  private static MAX_REPEAT_COUNT = 1000;
  /** when_touched refire debounce per part + touch type. */
  private touchFiredAt: Map<string, number> = new Map();
  private static TOUCH_DEBOUNCE_MS = 100;
  private touchPruneAt: number = 0;
  /** when_time_is: fire once per window ENTRY (was: every frame inside
   * the window = a 60 Hz machine gun while the clock crossed the target). */
  private timeInWindow: Map<string, boolean> = new Map();
  /** Parts/movers/effects caps. */
  private static MAX_BODY_MOVERS = 16;
  private static MAX_EFFECTS = 16;
  /** Cached list of parts that actually have polled rules
   * (when_variable_* / when_condition / when_coinflip); rebuilt when
   * objectsVersion changes so big worlds without such rules skip the
   * per-frame scan entirely. */
  private polledPartsCache: { part: StudioPart; rules: WeildCodeRule[] }[] = [];
  private polledPartsVersion: number = -1;

  // Track which parts have already fired their when_created trigger
  private createdParts: Set<string> = new Set();

  // Track previous weather/time for change detection
  private lastWeather: string = '';
  private lastTimeOfDay: number = -1;

  // Track global variable snapshots for when_variable_equals / when_variable_changes
  private variableSnapshots: Map<string, number | string | boolean> = new Map();
  private variableCheckAccumulators: Map<string, number> = new Map(); // key -> accumulated time since last check
  // Per-part object variable snapshots: partId -> (varName -> last seen value).
  // Used to detect changes for when_variable_changes with scope="object".
  private objectVariableSnapshots: Map<string, Map<string, number | string>> = new Map();

  // Track condition check accumulators for when_condition / when_coinflip
  private conditionCheckAccumulators: Map<string, number> = new Map();
  private coinFlipFired: Set<string> = new Set(); // one-shot coinflip rules that already fired

  // Track floating name labels (partId -> { text, startTime, duration })
  private nameLabels: Map<string, { text: string; color: string; fontSize: number; startTime: number; duration: number }> = new Map();

  // ─── Fading Effects ───
  // When a user triggers extinguish / disable_light / clear_smoke, the matching
  // effect is NOT removed instantly. Instead it's added to this map and gradually
  // faded out (opacity → 0, size → 0) over fadeDuration seconds. Once the fade
  // completes, the effect is removed from the part. This gives a smooth visual
  // transition instead of a jarring pop.
  // Key: effectId. Value: { partId, fadeDuration, elapsed, startOpacity, startSize }
  private fadingEffects: Map<string, { partId: string; fadeDuration: number; elapsed: number; startOpacity: number; startSize: number; startBrightness?: number; startRange?: number }> = new Map();

  // ─── Start / Stop ───

  /** v6.2.1: True while the SERVER-AUTHORITATIVE authority runs this engine
   * (the gamehost worker). Player-targeting actions then queue per-player
   * effects instead of writing the single shared playState. */
  private isServerAuthority(): boolean {
    return useStudioStore.getState().netcode?.mode === 'server';
  }

  /** v6.2.1: queue a per-player effect (server mode). No-op in singleplayer. */
  private pushPlayerEffect(effect: PlayerEffect): void {
    if (this.playerEffects.length >= WeildCodeEngine.MAX_PLAYER_EFFECTS) return; // drop the storm, keep the sim alive
    // v7: resolve the target selector at push time. 'this' keeps the
    // classic acting-player routing; 'all' mirrors the old global
    // semantics; 'username' names a specific player.
    const target = effect.target ?? 'this';
    const resolved: PlayerEffect = { ...effect, target };
    if (target === 'this') {
      resolved.username = this.currentActor || effect.username;
    } else if (target === 'username') {
      resolved.targetName = String(effect.targetName ?? '').trim();
      resolved.username = undefined;
    } else {
      resolved.username = undefined; // everyone
    }
    this.playerEffects.push(resolved);
  }

  /** v6.2.1: hand the queued per-player effects to the authority. The
   * gamehost worker calls this every sim tick and applies each effect to
   * its target player. */
  drainPlayerEffects(): PlayerEffect[] {
    if (this.playerEffects.length === 0) return [];
    return this.playerEffects.splice(0, this.playerEffects.length);
  }

  /** Run `fn` with the given acting player (trigger source). */
  private withActor<T>(actor: string | undefined, fn: () => T): T {
    const prev = this.currentActor;
    this.currentActor = actor;
    try {
      return fn();
    } finally {
      this.currentActor = prev;
    }
  }

  // ─── v7: acting-player context, target selectors, $(var) text ───

  /** The play viewports call this when play starts (solo + multiplayer).
   * It powers $(username), IF conditions on player stats and the
   * 'this player' target selector in solo mode. */
  setLocalUsername(name: string | undefined): void {
    if (name && name.trim()) this.localUsername = name.trim();
  }

  getLocalUsername(): string {
    return this.localUsername;
  }

  /** The gamehost authority pushes each player's live stats so IF
   * conditions + $(health)/$(speed) text read the right numbers per
   * player (solo mode falls back to the shared playState). */
  setPlayerStats(username: string, stats: { health: number; maxHealth: number; speed: number }): void {
    if (!username) return;
    this.playerStats.set(username, stats);
  }

  /** Which player's context is executing right now. */
  private currentActorName(): string {
    return this.currentActor || this.localUsername;
  }

  /** Live stats for a player (authority map first, playState fallback). */
  private statsFor(username: string): { health: number; maxHealth: number; speed: number } {
    const s = this.playerStats.get(username);
    if (s) return s;
    const p = useStudioStore.getState().playState;
    return { health: p.characterHealth, maxHealth: p.characterMaxHealth, speed: p.characterSpeed || 0 };
  }

  /** v7: read a player action's target selector (old rules: 'this'). */
  private playerTargetOf(action: WeildCodeAction): { target: 'this' | 'all' | 'username'; targetName: string } {
    const t = action.params?.target;
    const target: 'this' | 'all' | 'username' = t === 'all' || t === 'username' ? t : 'this';
    return { target, targetName: String(action.params?.playerName ?? '').trim() };
  }

  /** v7: does the target selector include the LOCAL player? (solo mode has
   * exactly one player - 'this' and 'all' both apply, 'username' must match.) */
  private soloTargetMatches(action: WeildCodeAction): boolean {
    const { target, targetName } = this.playerTargetOf(action);
    if (target === 'username') return targetName.toLowerCase() === this.currentActorName().toLowerCase();
    return true;
  }

  /** v7: $(name) interpolation for ANY text param. Resolves object
   * variables, global variables and the built-ins $(username), $(health),
   * $(maxHealth) and $(speed). Unknown names stay untouched so ordinary
   * text containing "$(" is never corrupted. */
  private interpolate(partId: string, s: string): string {
    if (!s || s.indexOf('$(') === -1) return s;
    return s.replace(/\$\(([^)\s]{1,64})\)/g, (_all, name: string) => {
      switch (name) {
        case 'username': return this.currentActorName();
        case 'health': return String(Math.round(this.statsFor(this.currentActorName()).health));
        case 'maxHealth': return String(Math.round(this.statsFor(this.currentActorName()).maxHealth));
        case 'speed': {
          const spd = this.statsFor(this.currentActorName()).speed;
          return String(spd > 0 ? Math.round(spd * 10) / 10 : 10.8);
        }
        default: break;
      }
      if (partId) {
        const part = useStudioStore.getState().objects.get(partId);
        if (part && isPart(part)) {
          const v = part.objectVariables?.[name];
          if (v !== undefined) return String(v);
        }
      }
      const g = useStudioStore.getState().globalVariables[name];
      if (g !== undefined) return String(g);
      return `$(${name})`; // unknown: keep the literal
    });
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.lastTime = performance.now();
    this.createdParts.clear();
    this.timers.clear();
    this.pendingWaits.clear();
    this.lastWeather = useStudioStore.getState().worldSettings.weatherType;
    this.lastTimeOfDay = useStudioStore.getState().worldSettings.timeOfDay;
    this.variableSnapshots.clear();
    this.variableCheckAccumulators.clear();
    this.objectVariableSnapshots.clear();
    this.conditionCheckAccumulators.clear();
    this.coinFlipFired.clear();
    this.nameLabels.clear();
    this.fadingEffects.clear();
    this.frameActionCount = 0;
    this.touchFiredAt.clear();
    this.timeInWindow.clear();
    this.polledPartsVersion = -1;

    // Snapshot current global variables
    const vars = useStudioStore.getState().globalVariables;
    for (const [name, value] of Object.entries(vars)) {
      this.variableSnapshots.set(name, value);
    }

    // Snapshot current per-object variables
    useStudioStore.getState().objects.forEach((obj) => {
      if (!isPart(obj) || !obj.objectVariables) return;
      const snap = new Map<string, number | string>();
      for (const [name, value] of Object.entries(obj.objectVariables)) {
        snap.set(name, value);
      }
      this.objectVariableSnapshots.set(obj.id, snap);
    });

    // Fire when_created for all existing parts
    const state = useStudioStore.getState();
    state.objects.forEach((obj) => {
      if (isPart(obj)) {
        this.fireTrigger(obj.id, 'when_created');
        this.createdParts.add(obj.id);
      }
    });

    // v7 FIX: game-level on_timer rules were never scheduled anywhere (only
    // part rules were), so a timer attached to a GAME rule silently never
    // fired. Schedule them here; updateTimers already knows the partId === ''
    // game path.
    for (const rule of state.gameRules || []) {
      if (rule.enabled && rule.trigger.type === 'on_timer') this.setupTimer(rule, '');
    }

    // Start the update loop
    this.update();
  }

  stop() {
    this.isRunning = false;
    if (this.animFrameId !== null) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    this.timers.clear();
    this.pendingWaits.clear();
    this.createdParts.clear();
    this.fadingEffects.clear();
    this.touchFiredAt.clear();
    this.timeInWindow.clear();
    // Clear any on-screen messages
    useStudioStore.getState().clearScreenMessages();
  }

  // ─── Main Update Loop ───

  private update = () => {
    if (!this.isRunning) return;

    const now = performance.now();
    const dt = Math.min((now - this.lastTime) / 1000, 0.25); // delta in seconds (clamped: tab-switch jumps can't burst-fire timers)
    this.lastTime = now;

    // v1.7: fresh per-frame action budget.
    this.frameActionCount = 0;

    const state = useStudioStore.getState();

    // v1.7: prune the touched-debounce map now and then (deleted parts).
    if (now - this.touchPruneAt > 5000) {
      this.touchPruneAt = now;
      if (this.touchFiredAt.size > 64) this.touchFiredAt.clear();
    }

    // Check for newly created parts (when_created trigger)
    state.objects.forEach((obj) => {
      if (isPart(obj) && !this.createdParts.has(obj.id)) {
        this.fireTrigger(obj.id, 'when_created');
        this.createdParts.add(obj.id);
      }
    });

    // Check weather changes
    const currentWeather = state.worldSettings.weatherType;
    if (currentWeather !== this.lastWeather) {
      this.lastWeather = currentWeather;
      // Fire when_weather_is for all parts with matching rules
      state.objects.forEach((obj) => {
        if (isPart(obj)) {
          this.fireTrigger(obj.id, 'when_weather_is');
        }
      });
    }

    // Check time changes
    const currentTime = state.worldSettings.timeOfDay;
    if (currentTime !== this.lastTimeOfDay) {
      this.lastTimeOfDay = currentTime;
      // Fire when_time_is for all parts
      state.objects.forEach((obj) => {
        if (isPart(obj)) {
          this.fireTrigger(obj.id, 'when_time_is');
        }
      });
    }

    // Update timers
    this.updateTimers(dt);

    // Update pending waits
    this.updateWaits(dt);

    // Poll variable triggers and condition triggers
    this.updateVariableTriggers(dt, state);

    // Poll condition triggers (when_condition, when_coinflip)
    this.updateConditionTriggers(dt, state);

    // Remove expired screen messages
    this.updateScreenMessages();

    // Update floating name labels
    this.updateNameLabels();

    // Update fading effects (extinguish / disable_light / clear_smoke)
    this.updateFadingEffects(dt);

    this.animFrameId = requestAnimationFrame(this.update);
  };

  // ─── Fading Effects Update ───

  private updateFadingEffects(dt: number) {
    if (this.fadingEffects.size === 0) return;
    const state = useStudioStore.getState();
    const toRemove: string[] = [];

    for (const [effectId, fade] of this.fadingEffects.entries()) {
      fade.elapsed += dt;
      const progress = Math.min(fade.elapsed / fade.fadeDuration, 1);
      // Lerp opacity/size/brightness from start value → 0
      const opacity = fade.startOpacity * (1 - progress);
      const size = fade.startSize * (1 - progress);
      const brightness = fade.startBrightness !== undefined ? fade.startBrightness * (1 - progress) : undefined;
      const range = fade.startRange !== undefined ? fade.startRange * (1 - progress) : undefined;

      // Update the effect on the part
      const part = state.objects.get(fade.partId);
      if (!part || !isPart(part)) {
        toRemove.push(effectId);
        continue;
      }
      const effects = part.effects || [];
      const effect = effects.find((e) => e.id === effectId);
      if (!effect) {
        // Effect was removed by other means - stop fading
        toRemove.push(effectId);
        continue;
      }
      state.updateEffect(fade.partId, effectId, {
        opacity: Math.max(0, opacity),
        size: Math.max(0.01, size),
        ...(brightness !== undefined ? { brightness: Math.max(0, brightness) } : {}),
        ...(range !== undefined ? { range: Math.max(0.01, range) } : {}),
      });

      if (progress >= 1) {
        // Fade complete - remove the effect entirely
        state.removeEffect(fade.partId, effectId);
        toRemove.push(effectId);
      }
    }

    for (const id of toRemove) {
      this.fadingEffects.delete(id);
    }
  }

  // ─── Trigger Firing ───

  fireTrigger(partId: string, triggerType: TriggerType, eventData?: Record<string, any>) {
    const state = useStudioStore.getState();
    const obj = state.objects.get(partId);
    if (!obj || !isPart(obj)) return;

    const rules = obj.rules || [];
    for (const rule of rules) {
      if (!rule.enabled) continue;
      if (rule.trigger.type !== triggerType) continue;

      // Check trigger-specific conditions
      if (!this.checkTriggerConditions(rule, triggerType, eventData, obj)) continue;

      // Execute the rule's actions
      this.executeActions(partId, rule.actions, rule.id);
    }
  }

  private checkTriggerConditions(
    rule: WeildCodeRule,
    triggerType: TriggerType,
    eventData?: Record<string, any>,
    part?: StudioPart,
  ): boolean {
    const params = rule.trigger.params;

    switch (triggerType) {
      case 'when_touched': {
        const filter = params.filter || 'any';
        if (filter === 'player' && eventData?.touchType !== 'player') return false;
        if (filter === 'parts' && eventData?.touchType !== 'parts') return false;
        return true;
      }
      case 'on_timer': {
        // Timer triggers are handled separately by updateTimers
        // This path is for initial setup
        this.setupTimer(rule, part?.id || '');
        return false; // Don't fire immediately
      }
      case 'on_property_change': {
        const property = params.property || 'any';
        if (property !== 'any' && eventData?.property !== property) return false;
        return true;
      }
      case 'when_time_is': {
        const timeMode = params.timeMode || 'exact';
        const state = useStudioStore.getState();
        const timeOfDay = state.worldSettings.timeOfDay;

        // v1.7 PERF FIX: this check used to return true for EVERY frame the
        // clock was inside the target window, so a rule fired ~60 times per
        // second for the whole window (a lag machine + duplicate effects).
        // Now the rule fires ONCE per window ENTRY and re-arms only after
        // the clock leaves the window again.
        const key = `${(part as StudioPart | undefined)?.id ?? ''}_${rule.id}`;
        const inWindow = timeMode === 'exact'
          ? Math.abs(timeOfDay - this.timeValueToHours(params.timeValue)) < 0.5
          : this.isTimeInPeriod(timeOfDay, params.period || 'noon');
        const wasInWindow = this.timeInWindow.get(key) ?? false;
        this.timeInWindow.set(key, inWindow);
        return inWindow && !wasInWindow;
      }
      case 'when_weather_is': {
        const state = useStudioStore.getState();
        return state.worldSettings.weatherType === (params.weatherType || 'rain');
      }
      default:
        return true;
    }
  }

  /** "16:45" -> 16.75 hours (invalid values fall back to noon). */
  private timeValueToHours(v: unknown): number {
    const [h, m] = String(v ?? '12:00').split(':').map(Number);
    if (!isFinite(h)) return 12;
    return h + (isFinite(m) ? m / 60 : 0);
  }

  private isTimeInPeriod(time: number, period: string): boolean {
    switch (period) {
      case 'dawn': return time >= 5 && time < 7;
      case 'morning': return time >= 7 && time < 11;
      case 'noon': return time >= 11 && time < 13;
      case 'afternoon': return time >= 13 && time < 17;
      case 'dusk': return time >= 17 && time < 19;
      case 'evening': return time >= 19 && time < 22;
      case 'midnight': return time >= 22 || time < 5;
      default: return false;
    }
  }

  // ─── Timer Management ───

  private setupTimer(rule: WeildCodeRule, partId: string) {
    const key = `${partId}_${rule.id}`;
    if (this.timers.has(key)) return;

    // v1.7: intervals are clamped (a 0.01 s timer would fire 100 times per
    // second per rule = a lag machine). 0.1 s is the floor.
    const intervalSeconds = Math.max(
      WeildCodeEngine.MIN_INTERVAL,
      this.paramNumber(partId, rule.trigger.params.intervalSeconds, 1),
    );
    const repeat = rule.trigger.params.repeat || 'every';

    this.timers.set(key, {
      ruleId: rule.id,
      partId,
      intervalSeconds,
      repeat: repeat as 'once' | 'every',
      elapsed: 0,
      fired: false,
      maxRepeats: 0,
      fireCount: 0,
      actor: this.currentActor, // v6.2.1: keep the triggering player
    });
  }

  private updateTimers(dt: number) {
    const state = useStudioStore.getState();

    for (const [key, timer] of this.timers.entries()) {
      // v1.5: game-rule timers (partId === '') fire on the game path.
      if (timer.partId === '') {
        timer.elapsed += dt;
        if (timer.elapsed >= timer.intervalSeconds) {
          timer.elapsed -= timer.intervalSeconds;
          if (timer.repeat === 'once' && timer.fired) continue;
          const gameRule = (state.gameRules || []).find((r) => r.id === timer.ruleId);
          if (gameRule && gameRule.enabled) {
            this.withActor(timer.actor, () => {
              // v7 FIX: a repeat_every timer re-runs its CHILDREN only; an
              // on_timer trigger runs the whole rule (the old code re-ran
              // EVERY action in the rule on every interval).
              this.executeGameActions(timer.actions ?? gameRule.actions, gameRule.id, timer.actions ? 1 : 0);
            });
          }
          timer.fired = true;
          timer.fireCount++;
          if (timer.repeat === 'once') this.timers.delete(key);
          if (timer.maxRepeats > 0 && timer.fireCount >= timer.maxRepeats) this.timers.delete(key);
        }
        continue;
      }

      // Skip if part no longer exists
      if (!state.objects.has(timer.partId)) {
        this.timers.delete(key);
        continue;
      }

      timer.elapsed += dt;

      if (timer.elapsed >= timer.intervalSeconds) {
        timer.elapsed -= timer.intervalSeconds;

        if (timer.repeat === 'once' && timer.fired) continue;

        // Fire the timer
        const obj = state.objects.get(timer.partId);
        if (obj && isPart(obj)) {
          const rule = (obj.rules || []).find((r) => r.id === timer.ruleId);
          if (rule && rule.enabled) {
            this.withActor(timer.actor, () => {
              // v7 FIX: repeat_every re-runs ITS CHILDREN, not the whole rule
              // (the old behavior re-executed every action in the rule each
              // interval - extra prints, extra kills, double teleports).
              if (timer.actions) {
                this.executeActions(timer.partId, timer.actions, rule.id, 1);
              } else {
                this.executeActions(timer.partId, rule.actions, rule.id);
              }
            });
          }
        }

        timer.fired = true;
        timer.fireCount++;

        if (timer.repeat === 'once') {
          this.timers.delete(key);
        }

        // v7 FIX: maxRepeats was only enforced on the game path - a part
        // rule's repeat_every with a max ran forever.
        if (timer.maxRepeats > 0 && timer.fireCount >= timer.maxRepeats) {
          this.timers.delete(key);
        }
      }
    }
  }

  // ─── Wait Management ───

  private updateWaits(dt: number) {
    for (const [key, wait] of this.pendingWaits.entries()) {
      wait.remainingSeconds -= dt;
      if (wait.remainingSeconds <= 0) {
        this.pendingWaits.delete(key);
        // Continue executing from the next action after the wait - in the
        // EXACT action array the wait was scheduled from (v7 fix: nested
        // waits used to resume at the wrong level and skip actions).
        const state = useStudioStore.getState();
        const remainingActions = wait.actions.slice(wait.actionIndex + 1);
        // v1.5: game-rule waits resume on the game action path.
        if (wait.gameRule) {
          const rule = (state.gameRules || []).find((r) => r.id === wait.ruleId);
          if (rule && rule.enabled) {
            this.withActor(wait.actor, () => this.executeGameActions(remainingActions, wait.ruleId));
          }
          continue;
        }
        const obj = state.objects.get(wait.partId);
        if (obj && isPart(obj)) {
          const rule = (obj.rules || []).find((r) => r.id === wait.ruleId);
          if (rule && rule.enabled) {
            this.withActor(wait.actor, () => this.executeActions(wait.partId, remainingActions, wait.ruleId));
          }
        }
      }
    }
  }

  // ─── Screen Message Expiry ───

  private updateScreenMessages() {
    const state = useStudioStore.getState();
    const now = performance.now();
    const expired = state.screenMessages.filter(
      (m) => (now - m.startTime) / 1000 >= m.duration
    );
    for (const m of expired) {
      state.removeScreenMessage(m.id);
    }
  }

  // ─── v1.5: GAME-level triggers (player join/leave, chat) ───
  // Fired by the gamehost worker in multiplayer and by the local client in
  // singleplayer. Game rules live in store.gameRules and run WITHOUT a part
  // context - only game-sensible actions execute (messages, sounds,
  // variables, player ops, tell_object, control flow).

  /** A player joined the game (optional per-rule username filter). */
  handlePlayerJoined(username: string): void {
    this.fireGameTrigger('on_player_join', { username });
  }

  /** A player left the game (optional per-rule username filter). */
  handlePlayerLeft(username: string): void {
    this.fireGameTrigger('on_player_leave', { username });
  }

  /** A player sent a chat message (optional username + content filters). */
  handleChatMessage(username: string, message: string): void {
    this.fireGameTrigger('on_chat_message', { username, message });
  }

  /** v7: a player lost health (solo path + the gamehost authority both
   * call this). Fires the on_player_damaged game rules. */
  handlePlayerDamaged(username: string, amount: number, healthAfter: number): void {
    if (!this.isRunning || this.eventDepth > 4) return;
    this.eventDepth++;
    try {
      this.fireGameTrigger('on_player_damaged', { username, amount, health: healthAfter });
    } finally {
      this.eventDepth--;
    }
  }

  /** v7: a player died (health 0 or the void). Fires on_player_died. */
  handlePlayerDied(username: string): void {
    if (!this.isRunning || this.eventDepth > 4) return;
    this.eventDepth++;
    try {
      this.fireGameTrigger('on_player_died', { username });
    } finally {
      this.eventDepth--;
    }
  }

  fireGameTrigger(triggerType: TriggerType, eventData?: Record<string, any>): void {
    if (!this.isRunning) return;
    const state = useStudioStore.getState();
    // v6.2.1: game events that name a player (join/leave/chat) run with that
    // player as the acting context, so player-targeting actions hit the
    // right person in multiplayer.
    this.withActor(typeof eventData?.username === 'string' ? eventData.username : undefined, () => {
      for (const rule of state.gameRules || []) {
        if (!rule.enabled) continue;
        if (rule.trigger.type !== triggerType) continue;
        if (!this.checkGameTriggerConditions(rule, triggerType, eventData)) continue;
        this.executeGameActions(rule.actions, rule.id);
      }
    });
  }

  private checkGameTriggerConditions(
    rule: WeildCodeRule,
    triggerType: TriggerType,
    eventData?: Record<string, any>,
  ): boolean {
    const params = rule.trigger.params || {};
    if (triggerType === 'on_player_join' || triggerType === 'on_player_leave') {
      const filter = this.paramString('', params.username, '').trim().toLowerCase();
      if (filter && String(eventData?.username || '').toLowerCase() !== filter) return false;
    }
    // v7: the life-state triggers take the same optional username filter.
    if (triggerType === 'on_player_damaged' || triggerType === 'on_player_died') {
      const filter = this.paramString('', params.username, '').trim().toLowerCase();
      if (filter && String(eventData?.username || '').toLowerCase() !== filter) return false;
    }
    if (triggerType === 'on_chat_message') {
      const user = this.paramString('', params.username, '').trim().toLowerCase();
      if (user && String(eventData?.username || '').toLowerCase() !== user) return false;
      const contains = this.paramString('', params.contains, '').trim().toLowerCase();
      if (contains && !String(eventData?.message || '').toLowerCase().includes(contains)) return false;
    }
    return true;
  }

  /** Execute a game rule's actions (no part context). */
  private executeGameActions(actions: WeildCodeAction[], ruleId: string, depth = 0): void {
    if (depth > 10) return;
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      if (!action.enabled) continue;
      if (action.type === 'wait') {
        this.pendingWaits.set(`game_${ruleId}_${i}_${this.waitSeq++}`, {
          ruleId,
          partId: '',
          actionIndex: i,
          remainingSeconds: Math.max(WeildCodeEngine.MIN_INTERVAL, this.paramNumber('', action.params.seconds, 1)),
          gameRule: true,
          actor: this.currentActor, // v6.2.1: keep the triggering player
          actions, // v7: resume THIS array (nested waits resumed wrongly before)
        });
        return; // resume after the wait
      }
      this.executeGameAction(action, ruleId, depth);
    }
  }

  private executeGameAction(action: WeildCodeAction, ruleId: string, depth: number): void {
    // v1.7: per-frame action budget. A repeat storm (nested repeats,
    // 0.1 s timers, touched spam) can no longer freeze the frame; the
    // rest of the actions are simply dropped for this tick.
    if (!this.spendActionBudget()) return;

    switch (action.type) {
      case 'if_condition': {
        // v7: the customizable IF - run the THEN children or the ELSE
        // children based on the comparison. Works in game rules too (the
        // part operand resolves named parts only).
        const branch = this.evaluateIfCondition('', action) ? action.children : (action.elseChildren ?? []);
        if (branch && branch.length > 0) this.executeGameActions(branch, ruleId, depth + 1);
        break;
      }
      case 'modify_property': {
        // v7: game rules have no "this part" - a NAMED target still works.
        if (!this.executeModifyProperty('', action, true)) {
          useStudioStore.getState().addConsoleMessage('warn', `[WeildCode] modify_property in a game rule needs a named object.`);
        }
        break;
      }
      case 'set_player_speed': {
        const t = this.playerTargetOf(action);
        const speed = Math.max(0, this.paramNumber('', action.params.speed, 10.8));
        if (this.isServerAuthority()) {
          this.pushPlayerEffect({ kind: 'set_speed', ...t, value: speed, relative: action.params.relative === true });
          break;
        }
        if (!this.soloTargetMatches(action)) break;
        const cur = useStudioStore.getState().playState.characterSpeed || 10.8;
        const next = action.params.relative === true ? Math.max(0, cur + speed) : speed;
        useStudioStore.getState().setPlayState({ characterSpeed: next });
        useStudioStore.getState().addConsoleMessage('info', `[WeildCode] Player speed set to ${Math.round(next * 10) / 10}`);
        break;
      }
      case 'set_spawn_point': {
        const t = this.playerTargetOf(action);
        const pos = this.resolveSpawnPosition('', action);
        if (!pos) {
          useStudioStore.getState().addConsoleMessage('warn', `[WeildCode] set_spawn_point: could not resolve the spawn position`);
          break;
        }
        if (this.isServerAuthority()) {
          this.pushPlayerEffect({ kind: 'set_spawn', ...t, spawn: pos });
          break;
        }
        if (!this.soloTargetMatches(action)) break;
        useStudioStore.getState().setPlayState({ spawnPointOverride: pos });
        useStudioStore.getState().addConsoleMessage('info', `[WeildCode] Spawn point set to (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`);
        break;
      }
      case 'respawn_player': {
        const t = this.playerTargetOf(action);
        if (this.isServerAuthority()) {
          this.pushPlayerEffect({ kind: 'respawn', ...t });
          break;
        }
        if (!this.soloTargetMatches(action)) break;
        // v7: bump the counter - the play viewport teleports the body to
        // the spawn + restores full health on the next frame (no death).
        const st = useStudioStore.getState();
        st.setPlayState({ pendingRespawn: st.playState.pendingRespawn + 1 });
        break;
      }
      case 'print_message': {
        const message = this.paramString('', action.params.message, 'Hello, world!');
        const msgPayload = {
          message,
          position: (action.params.position || 'bottom') as 'top' | 'bottom',
          textColor: action.params.textColor || '#ffffff',
          fontStyle: (action.params.fontStyle || 'normal') as 'normal' | 'bold' | 'italic' | 'bold-italic',
          fontSize: this.paramNumber('', action.params.fontSize, 24),
          backgroundColor: action.params.backgroundColor || '#000000',
          duration: this.paramNumber('', action.params.duration, 3),
        };
        // v7: "this player" / a named player get a TARGETED message (it is
        // delivered to their client only, not broadcast); "all players"
        // (and old rules with no selector) keep the classic broadcast.
        const msgTarget = this.playerTargetOf(action);
        if (this.isServerAuthority() && msgTarget.target !== 'all') {
          this.pushPlayerEffect({ kind: 'message', ...msgTarget, message: msgPayload });
          break;
        }
        useStudioStore.getState().addScreenMessage(msgPayload);
        useStudioStore.getState().addConsoleMessage('info', `[WeildCode] Print: "${message}" (game rule)`);
        break;
      }
      case 'play_sound': {
        const sound = action.params.sound || 'click';
        const volume = Math.max(0, Math.min(1, this.paramNumber('', action.params.volume, 0.5)));
        playCue(sound, volume);
        break;
      }
      case 'set_variable': {
        const varName = action.params.variableName || '';
        if (!varName) break;
        // v1.6: values can be numbers, plain text, a VARIABLE NAME reference,
        // or a math expression built with blocks (e.g. "score + 1").
        // v1.7: tagged block values ({__wb_var} / {__wb_expr}) resolve too.
        const value = this.resolveVariableValue('', action.params.value ?? '0');
        useStudioStore.getState().setGlobalVariable(varName, value);
        useStudioStore.getState().addConsoleMessage('info', `[WeildCode] Set variable "${varName}" = ${value} (game rule)`);
        break;
      }
      case 'change_variable': {
        this.executeChangeVariable('', action);
        break;
      }
      case 'teleport_player': {
        // v6.2.1: server mode queues a per-player teleport (the acting
        // player only); singleplayer keeps the shared-store behavior.
        if (this.isServerAuthority()) {
          const t = this.playerTargetOf(action);
          const pos = this.resolveTeleportPosition('', action);
          if (pos) this.pushPlayerEffect({ kind: 'teleport', ...t, position: pos });
          break;
        }
        if (this.soloTargetMatches(action)) this.executeTeleportPlayer(action);
        break;
      }
      case 'modify_player_health': {
        // v6.2.1: server mode queues a per-player effect (the acting player
        // only); singleplayer keeps the shared-store behavior.
        if (this.isServerAuthority()) {
          const t = this.playerTargetOf(action);
          const amount = this.paramNumber('', action.params.health, 0);
          if (action.params.relative !== false) this.pushPlayerEffect({ kind: 'damage', ...t, value: amount });
          else this.pushPlayerEffect({ kind: 'set_health', ...t, value: amount });
          break;
        }
        if (this.soloTargetMatches(action)) this.executeModifyPlayerHealth(action);
        break;
      }
      case 'set_health': {
        const maxHp = useStudioStore.getState().playState.characterMaxHealth;
        const hp = Math.max(0, Math.min(maxHp, this.paramNumber('', action.params.health, 100)));
        if (this.isServerAuthority()) {
          this.pushPlayerEffect({ kind: 'set_health', ...this.playerTargetOf(action), value: hp });
          break;
        }
        if (!this.soloTargetMatches(action)) break;
        const prevHp = useStudioStore.getState().playState.characterHealth;
        useStudioStore.getState().setPlayState({ characterHealth: hp });
        if (hp < prevHp) this.emitPlayerDamaged(this.currentActorName(), hp - prevHp, hp);
        if (hp <= 0 && prevHp > 0) this.emitPlayerDied(this.currentActorName());
        useStudioStore.getState().addConsoleMessage('info', `[WeildCode] Player health set to ${hp}`);
        break;
      }
      case 'kill_player': {
        if (this.isServerAuthority()) {
          this.pushPlayerEffect({ kind: 'kill', ...this.playerTargetOf(action) });
          break;
        }
        if (!this.soloTargetMatches(action)) break;
        useStudioStore.getState().setPlayState({ characterHealth: 0 });
        this.emitPlayerDied(this.currentActorName());
        useStudioStore.getState().addConsoleMessage('info', `[WeildCode] Player killed (game rule)`);
        break;
      }
      case 'heal_player': {
        if (this.isServerAuthority()) {
          this.pushPlayerEffect({ kind: 'heal', ...this.playerTargetOf(action) });
          break;
        }
        if (!this.soloTargetMatches(action)) break;
        const maxHp = useStudioStore.getState().playState.characterMaxHealth;
        useStudioStore.getState().setPlayState({ characterHealth: maxHp });
        useStudioStore.getState().addConsoleMessage('info', `[WeildCode] Player healed to full (${maxHp} HP)`);
        break;
      }
      case 'send_to_universe': {
        const universeId = action.params.universeId || 'place_default';
        useStudioStore.getState().switchUniverse(universeId);
        useStudioStore.getState().addConsoleMessage('info', `[WeildCode] Sent player to universe: ${universeId}`);
        break;
      }
      case 'repeat': {
        // v1.7: capped (a repeat count of 1e9 used to freeze the tab).
        const count = this.clampRepeatCount(this.paramNumber('', action.params.count, 3));
        if (action.children && action.children.length > 0) {
          for (let i = 0; i < count; i++) {
            this.executeGameActions(action.children, ruleId, depth + 1);
          }
        }
        break;
      }
      case 'repeat_every': {
        const intervalSeconds = Math.max(WeildCodeEngine.MIN_INTERVAL, this.paramNumber('', action.params.intervalSeconds, 2));
        const maxRepeats = Math.floor(Math.max(0, this.paramNumber('', action.params.maxRepeats, 0)));
        const timerKey = `repeat_game_${action.id}`;
        // v1.7 PERF FIX: re-triggering an ALREADY RUNNING repeat_every
        // (e.g. its parent rule fires again from a touch) used to execute
        // the children immediately AND reset the timer, so a 60 Hz touch
        // turned "every 2 seconds" into "every frame". A running timer
        // now just refreshes its settings; children keep their cadence.
        if (this.timers.has(timerKey)) {
          const t = this.timers.get(timerKey)!;
          t.intervalSeconds = intervalSeconds;
          t.maxRepeats = maxRepeats;
          break;
        }
        if (action.children && action.children.length > 0) {
          this.executeGameActions(action.children, ruleId, depth + 1);
        }
        this.timers.set(timerKey, {
          ruleId,
          partId: '',
          actions: action.children, // v7 FIX: the timer re-runs the CHILDREN
          intervalSeconds,
          repeat: 'every',
          elapsed: 0,
          fired: true,
          maxRepeats,
          fireCount: 1,
          actor: this.currentActor, // v6.2.1: keep the triggering player
        });
        break;
      }
      case 'tell_object': {
        const targetName = this.paramString('', action.params.targetName, '');
        if (!targetName) break;
        const state = useStudioStore.getState();
        let targetPart: StudioPart | null = null;
        state.objects.forEach((obj) => {
          if (isPart(obj) && obj.name === targetName) targetPart = obj;
        });
        if (targetPart && action.children && action.children.length > 0) {
          this.executeActions((targetPart as StudioPart).id, action.children, ruleId, depth + 1);
        } else if (!targetPart) {
          useStudioStore.getState().addConsoleMessage('warn', `[WeildCode] Object "${targetName}" not found (game rule)`);
        }
        break;
      }
      default: {
        // Part-targeting actions have no object to act on inside a GAME
        // rule - say so once instead of failing silently.
        useStudioStore.getState().addConsoleMessage(
          'warn',
          `[WeildCode] Action "${action.type}" needs an object rule - game rules only run game-wide actions.`,
        );
        break;
      }
    }
  }

  // ─── Action Execution ───

  private executeActions(partId: string, actions: WeildCodeAction[], ruleId: string, depth = 0) {
    if (depth > 10) return; // Prevent infinite recursion

    const state = useStudioStore.getState();
    const part = state.objects.get(partId);
    if (!part || !isPart(part)) return;

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      if (!action.enabled) continue;

      // Handle wait - pause execution and resume later
      if (action.type === 'wait') {
        // v1.7: clamped so a 0-second wait can't wake 60 times a second.
        const seconds = Math.max(WeildCodeEngine.MIN_INTERVAL, this.paramNumber(partId, action.params.seconds, 1));
        const waitKey = `${partId}_${ruleId}_${i}_${this.waitSeq++}`;
        this.pendingWaits.set(waitKey, {
          ruleId,
          partId,
          actionIndex: i,
          remainingSeconds: seconds,
          actor: this.currentActor, // v6.2.1: keep the triggering player
          actions, // v7: resume THIS array (nested waits resumed wrongly before)
        });
        return; // Stop executing further actions; will resume after wait
      }

      this.executeAction(partId, action, ruleId, depth);
    }
  }

  private executeAction(partId: string, action: WeildCodeAction, ruleId: string, depth: number) {
    // v1.7: per-frame action budget (see executeGameAction).
    if (!this.spendActionBudget()) return;

    const state = useStudioStore.getState();
    const part = state.objects.get(partId);
    if (!part || !isPart(part)) return;

    switch (action.type) {
      case 'if_condition': {
        // v7: the customizable IF - THEN children when true, ELSE children
        // when false. Part rules can read "this part"'s properties.
        const branch = this.evaluateIfCondition(partId, action) ? action.children : (action.elseChildren ?? []);
        if (branch && branch.length > 0) this.executeActions(partId, branch, ruleId, depth + 1);
        break;
      }
      case 'modify_property': {
        this.executeModifyProperty(partId, action);
        break;
      }
      case 'set_player_speed': {
        const t = this.playerTargetOf(action);
        const speed = Math.max(0, this.paramNumber(partId, action.params.speed, 10.8));
        if (this.isServerAuthority()) {
          this.pushPlayerEffect({ kind: 'set_speed', ...t, value: speed, relative: action.params.relative === true });
          break;
        }
        if (!this.soloTargetMatches(action)) break;
        const cur = useStudioStore.getState().playState.characterSpeed || 10.8;
        const next = action.params.relative === true ? Math.max(0, cur + speed) : speed;
        useStudioStore.getState().setPlayState({ characterSpeed: next });
        useStudioStore.getState().addConsoleMessage('info', `[WeildCode] Player speed set to ${Math.round(next * 10) / 10}`);
        break;
      }
      case 'set_spawn_point': {
        const t = this.playerTargetOf(action);
        const pos = this.resolveSpawnPosition(partId, action);
        if (!pos) {
          useStudioStore.getState().addConsoleMessage('warn', `[WeildCode] set_spawn_point: could not resolve the spawn position`);
          break;
        }
        if (this.isServerAuthority()) {
          this.pushPlayerEffect({ kind: 'set_spawn', ...t, spawn: pos });
          break;
        }
        if (!this.soloTargetMatches(action)) break;
        useStudioStore.getState().setPlayState({ spawnPointOverride: pos });
        useStudioStore.getState().addConsoleMessage('info', `[WeildCode] Spawn point set to (${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)})`);
        break;
      }
      case 'respawn_player': {
        if (this.isServerAuthority()) {
          this.pushPlayerEffect({ kind: 'respawn', ...this.playerTargetOf(action) });
          break;
        }
        if (!this.soloTargetMatches(action)) break;
        // v7: bump the counter - the play viewport teleports the body to
        // the spawn + restores full health on the next frame (no death).
        const st = useStudioStore.getState();
        st.setPlayState({ pendingRespawn: st.playState.pendingRespawn + 1 });
        break;
      }
      case 'create_part': {
        this.executeCreatePart(partId, action);
        break;
      }
      case 'delete_part': {
        this.executeDeletePart(partId, action);
        break;
      }
      case 'move': {
        this.executeMove(partId, action);
        break;
      }
      case 'rotate': {
        this.executeRotate(partId, action);
        break;
      }
      case 'resize': {
        this.executeResize(partId, action);
        break;
      }
      case 'change_color': {
        useStudioStore.getState().updateObject(partId, { color: action.params.color || '#ff0000' });
        break;
      }
      case 'change_material': {
        useStudioStore.getState().updateObject(partId, { material: action.params.material || 'Plastic' });
        break;
      }
      case 'change_transparency': {
        useStudioStore.getState().updateObject(partId, { transparency: this.clamp01(this.paramNumber(partId, action.params.transparency, 0.5)) });
        break;
      }
      case 'apply_force': {
        // Apply force via BodyMover (BodyForce)
        const force = this.paramVec3(partId, action.params.force, { x: 0, y: 50, z: 0 });
        useStudioStore.getState().addBodyMover(partId, {
          id: `bm_wc_${Date.now()}`,
          type: 'BodyForce',
          enabled: true,
          force: { x: force.x, y: force.y, z: force.z },
        });
        break;
      }
      case 'apply_explosion': {
        const radius = Math.max(0, this.paramNumber(partId, action.params.radius, 8));
        const pressure = this.paramNumber(partId, action.params.pressure, 500000);
        useStudioStore.getState().createExplosion(
          { ...part.position },
          radius,
          pressure,
        );
        break;
      }
      case 'play_sound': {
        // v13.4 FIX: this action used to only print "[WeildCode] Sound: x"
        // to the console - no audio ever played. Now it plays a REAL sound:
        // 'boom' uses the actual explosion sound file; the other cues
        // (click/pop/whoosh/chime/alert) are synthesized with distinct
        // waveforms + envelopes. Volume comes from the rule's volume param.
        const sound = action.params.sound || 'click';
        const volume = Math.max(0, Math.min(1, this.paramNumber(partId, action.params.volume, 0.6)));
        if (sound === 'boom') {
          playSound('explosion', volume);
        } else {
          playCue(sound, volume);
        }
        break;
      }
      case 'visual_effect': {
        const effectType = action.params.effectType || 'Fire';
        const color = action.params.color || '#ff6600';
        const size = action.params.size || 3;
        useStudioStore.getState().addEffect(partId, {
          id: `fx_wc_${Date.now()}`,
          type: effectType as 'Fire' | 'Smoke' | 'Light',
          color,
          size,
          enabled: true,
          brightness: effectType === 'Light' ? 2 : undefined,
          range: effectType === 'Light' ? size * 3 : undefined,
          opacity: effectType === 'Smoke' ? 0.5 : undefined,
        });
        break;
      }
      case 'explode': {
        // Same as apply_explosion - just a better name
        const radius = Math.max(0, this.paramNumber(partId, action.params.radius, 8));
        const pressure = this.paramNumber(partId, action.params.pressure, 500000);
        useStudioStore.getState().createExplosion(
          { ...part.position },
          radius,
          pressure,
        );
        break;
      }
      case 'go_on_fire': {
        const color = action.params.color || '#ff6600';
        const size = Math.max(0.1, this.paramNumber(partId, action.params.size, 3));
        // v1.7 PERF: cap the effects per part (a touched rule firing
        // repeatedly used to stack unbounded Fire instances).
        if (!this.canAddEffect(partId)) break;
        useStudioStore.getState().addEffect(partId, {
          id: `fx_fire_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          type: 'Fire',
          color,
          size,
          enabled: true,
        });
        break;
      }
      case 'light_up': {
        const color = action.params.color || '#ffeb3b';
        const brightness = Math.max(0, this.paramNumber(partId, action.params.brightness, 2));
        const range = Math.max(0, this.paramNumber(partId, action.params.range, 10));
        if (!this.canAddEffect(partId)) break;
        useStudioStore.getState().addEffect(partId, {
          id: `fx_light_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          type: 'Light',
          color,
          size: range / 3,
          enabled: true,
          brightness,
          range,
        });
        break;
      }
      case 'release_smoke': {
        const color = action.params.color || '#666666';
        const size = Math.max(0.1, this.paramNumber(partId, action.params.size, 3));
        const opacity = this.clamp01(this.paramNumber(partId, action.params.opacity, 0.5));
        if (!this.canAddEffect(partId)) break;
        useStudioStore.getState().addEffect(partId, {
          id: `fx_smoke_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          type: 'Smoke',
          color,
          size,
          enabled: true,
          opacity,
        });
        break;
      }
      case 'extinguish': {
        this.startEffectFade(partId, 'Fire', this.paramNumber(partId, action.params.fadeDuration, 1));
        break;
      }
      case 'disable_light': {
        this.startEffectFade(partId, 'Light', this.paramNumber(partId, action.params.fadeDuration, 1));
        break;
      }
      case 'clear_smoke': {
        this.startEffectFade(partId, 'Smoke', this.paramNumber(partId, action.params.fadeDuration, 1));
        break;
      }
      case 'teleport_player_to_part': {
        // v6.2.1: server mode resolves the target position, then queues a
        // per-player teleport (the acting player only).
        if (this.isServerAuthority()) {
          const pos = this.resolveTeleportToPartPosition(partId, action);
          if (pos) this.pushPlayerEffect({ kind: 'teleport', ...this.playerTargetOf(action), position: pos });
          break;
        }
        this.executeTeleportPlayerToPart(partId, action);
        break;
      }
      case 'teleport_player': {
        if (this.isServerAuthority()) {
          const pos = this.resolveTeleportPosition(partId, action);
          if (pos) this.pushPlayerEffect({ kind: 'teleport', ...this.playerTargetOf(action), position: pos });
          break;
        }
        if (this.soloTargetMatches(action)) this.executeTeleportPlayer(action);
        break;
      }
      case 'kill_player': {
        if (this.isServerAuthority()) {
          this.pushPlayerEffect({ kind: 'kill', ...this.playerTargetOf(action) });
          break;
        }
        if (!this.soloTargetMatches(action)) break;
        useStudioStore.getState().setPlayState({ characterHealth: 0 });
        this.emitPlayerDied(this.currentActorName());
        useStudioStore.getState().addConsoleMessage('info', `[WeildCode] Player killed`);
        break;
      }
      case 'heal_player': {
        if (this.isServerAuthority()) {
          this.pushPlayerEffect({ kind: 'heal', ...this.playerTargetOf(action) });
          break;
        }
        if (!this.soloTargetMatches(action)) break;
        const maxHp = useStudioStore.getState().playState.characterMaxHealth;
        useStudioStore.getState().setPlayState({ characterHealth: maxHp });
        useStudioStore.getState().addConsoleMessage('info', `[WeildCode] Player healed to full (${maxHp} HP)`);
        break;
      }
      case 'repeat': {
        // v1.7: capped (this path previously had NO cap at all).
        const count = this.clampRepeatCount(this.paramNumber(partId, action.params.count, 3));
        if (action.children && action.children.length > 0) {
          for (let i = 0; i < count; i++) {
            this.executeActions(partId, action.children, ruleId, depth + 1);
          }
        }
        break;
      }
      case 'repeat_every': {
        const intervalSeconds = Math.max(WeildCodeEngine.MIN_INTERVAL, this.paramNumber(partId, action.params.intervalSeconds, 2));
        const maxRepeats = Math.floor(Math.max(0, this.paramNumber(partId, action.params.maxRepeats, 0)));
        const timerKey = `repeat_${partId}_${action.id}`;
        // v1.7 PERF FIX: an already-running timer is refreshed, not
        // re-fired (see executeGameAction for the rationale).
        if (this.timers.has(timerKey)) {
          const t = this.timers.get(timerKey)!;
          t.intervalSeconds = intervalSeconds;
          t.maxRepeats = maxRepeats;
          break;
        }
        if (action.children && action.children.length > 0) {
          this.executeActions(partId, action.children, ruleId, depth + 1);
        }
        this.timers.set(timerKey, {
          ruleId,
          partId,
          actions: action.children, // v7 FIX: the timer re-runs the CHILDREN
          intervalSeconds,
          repeat: 'every',
          elapsed: 0,
          fired: true, // Already fired once
          maxRepeats,
          fireCount: 1,
          actor: this.currentActor, // v6.2.1: keep the triggering player
        });
        break;
      }
      case 'tell_object': {
        const targetName = this.paramString(partId, action.params.targetName, '');
        if (!targetName) break;

        // Find the target object by name
        const state = useStudioStore.getState();
        let targetPart: StudioPart | null = null;
        state.objects.forEach((obj) => {
          if (isPart(obj) && obj.name === targetName) {
            targetPart = obj;
          }
        });

        if (targetPart && action.children && action.children.length > 0) {
          this.executeActions((targetPart as StudioPart).id, action.children, ruleId, depth + 1);
        } else if (!targetPart) {
          useStudioStore.getState().addConsoleMessage('warn', `[WeildCode] Object "${targetName}" not found`);
        }
        break;
      }
      case 'print_message': {
        const message = this.paramString(partId, action.params.message, 'Hello, world!');
        const position = action.params.position || 'bottom';
        const textColor = action.params.textColor || '#ffffff';
        const fontStyle = action.params.fontStyle || 'normal';
        const fontSize = this.paramNumber(partId, action.params.fontSize, 24);
        const backgroundColor = action.params.backgroundColor || '#000000';
        const duration = this.paramNumber(partId, action.params.duration, 3);
        // v7: targeted messages go to the chosen players only (server mode).
        const msgTarget = this.playerTargetOf(action);
        if (this.isServerAuthority() && msgTarget.target !== 'all') {
          this.pushPlayerEffect({
            kind: 'message',
            ...msgTarget,
            message: {
              message,
              position: position as 'top' | 'bottom',
              textColor,
              fontStyle: fontStyle as 'normal' | 'bold' | 'italic' | 'bold-italic',
              fontSize,
              backgroundColor,
              duration,
            },
          });
          break;
        }
        useStudioStore.getState().addScreenMessage({
          message,
          position: position as 'top' | 'bottom',
          textColor,
          fontStyle: fontStyle as 'normal' | 'bold' | 'italic' | 'bold-italic',
          fontSize,
          backgroundColor,
          duration,
        });
        useStudioStore.getState().addConsoleMessage('info', `[WeildCode] Print: "${message}"`);
        break;
      }
      case 'remove_from_workspace': {
        // Permanent removal - same as delete but with different semantic
        this.executeRemoveFromWorkspace(partId, action);
        break;
      }
      case 'show_name': {
        const rawText = this.paramString(partId, action.params.text, 'Hello');
        const text = rawText.substring(0, 12); // max 12 chars
        const color = action.params.color || '#ffffff';
        const fontSize = this.paramNumber(partId, action.params.fontSize, 16);
        const duration = this.paramNumber(partId, action.params.duration, 5);
        this.nameLabels.set(partId, {
          text,
          color,
          fontSize,
          startTime: performance.now(),
          duration,
        });
        useStudioStore.getState().addConsoleMessage('info', `[WeildCode] Showing name "${text}" above ${part.name}`);
        break;
      }
      case 'create_copy': {
        this.executeCreateCopy(partId, action);
        break;
      }
      case 'add_rule': {
        this.executeAddRule(partId, action);
        break;
      }
      case 'set_variable': {
        const varName = action.params.variableName || '';
        if (!varName) break;
        // v1.6: numbers, plain text, variable-name references, and block-built
        // math expressions are all valid values now. v1.7: tagged block
        // values ({__wb_var} / {__wb_expr}) resolve through the same path.
        const value = this.resolveVariableValue(partId, action.params.value ?? '0');
        const scope = action.params.scope || 'global';
        if (scope === 'object') {
          // Per-object variable - only this part can read/write it.
          useStudioStore.getState().setObjectVariable(partId, varName, value as number | string);
          useStudioStore.getState().addConsoleMessage('info', `[WeildCode] Set object variable "${varName}" = ${value} (on part ${partId})`);
        } else {
          useStudioStore.getState().setGlobalVariable(varName, value);
          useStudioStore.getState().addConsoleMessage('info', `[WeildCode] Set variable "${varName}" = ${value}`);
        }
        break;
      }
      case 'change_variable': {
        this.executeChangeVariable(partId, action);
        break;
      }
      case 'send_to_universe': {
        const universeId = action.params.universeId || 'place_default';
        useStudioStore.getState().switchUniverse(universeId);
        useStudioStore.getState().addConsoleMessage('info', `[WeildCode] Sent player to universe: ${universeId}`);
        break;
      }
      // ─── v1.5: model-tab actions (the safe per-part solid-modeling ops) ───
      case 'negate_part': {
        if (part.negated) break; // already a cutout
        useStudioStore.getState().updateObject(partId, {
          transparency: 0.8,
          canCollide: false,
          color: '#ff0000',
          negated: true,
          preNegateColor: part.color,
          preNegateTransparency: part.transparency,
        } as any);
        useStudioStore.getState().addConsoleMessage('info', `[WeildCode] Negated "${part.name}" (cutout)`);
        break;
      }
      case 'de_negate_part': {
        if (!part.negated) break;
        useStudioStore.getState().updateObject(partId, {
          transparency: part.preNegateTransparency ?? 0,
          canCollide: true,
          color: part.preNegateColor ?? part.color,
          negated: false,
          preNegateColor: undefined,
          preNegateTransparency: undefined,
        } as any);
        useStudioStore.getState().addConsoleMessage('success', `[WeildCode] De-negated "${part.name}"`);
        break;
      }
      case 'separate_part': {
        const longest = part.size.x >= part.size.y && part.size.x >= part.size.z ? 'x' :
                        part.size.y >= part.size.z ? 'y' : 'z';
        if (part.size[longest] < 0.2) {
          useStudioStore.getState().addConsoleMessage('warn', `[WeildCode] "${part.name}" is too small to separate`);
          break;
        }
        const halfSize = { ...part.size };
        halfSize[longest] = part.size[longest] / 2;
        const offset = part.size[longest] / 4;
        useStudioStore.getState().updateObject(partId, {
          size: halfSize,
          position: {
            x: part.position.x + (longest === 'x' ? -offset : 0),
            y: part.position.y + (longest === 'y' ? -offset : 0),
            z: part.position.z + (longest === 'z' ? -offset : 0),
          },
        });
        // Second half: same shape, offset the other way. NOTE: re-read the
        // state AFTER the updateObject above - building the new Map from a
        // stale snapshot would silently revert the original's new size.
        const newPartId = `obj_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        const fresh = useStudioStore.getState();
        const objects = new Map(fresh.objects);
        objects.set(newPartId, {
          ...part,
          id: newPartId,
          name: `${part.name} half`,
          size: halfSize,
          position: {
            x: part.position.x + (longest === 'x' ? offset : 0),
            y: part.position.y + (longest === 'y' ? offset : 0),
            z: part.position.z + (longest === 'z' ? offset : 0),
          },
          rules: [],
        } as any);
        useStudioStore.setState({ objects, objectsVersion: fresh.objectsVersion + 1 });
        useStudioStore.getState().addConsoleMessage('success', `[WeildCode] Separated "${part.name}" into 2 parts along ${longest.toUpperCase()}`);
        break;
      }
      // ─── v1.5: body movers as actions ───
      case 'add_body_mover': {
        const moverType = action.params.moverType || 'BodyForce';
        // v1.7 PERF: cap the movers per part. A touched rule that adds a
        // mover used to append one mover PER FIRE (unbounded array growth
        // + ever-heavier physics). Extra adds are dropped with a hint.
        const existingMovers = part.bodyMovers || [];
        if (existingMovers.length >= WeildCodeEngine.MAX_BODY_MOVERS) {
          useStudioStore.getState().addConsoleMessage('warn', `[WeildCode] "${part.name}" already has ${existingMovers.length} body movers (max ${WeildCodeEngine.MAX_BODY_MOVERS}). Remove some first.`);
          break;
        }
        const vec = this.paramVec3(partId, { x: action.params.x, y: action.params.y, z: action.params.z }, { x: 0, y: 0, z: 0 });
        const common = {
          id: `mover_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          type: moverType,
          enabled: action.params.enabled !== false,
        };
        let mover: any;
        switch (moverType) {
          case 'BodyVelocity':
            mover = { ...common, velocity: { x: vec.x, y: vec.y, z: vec.z }, maxForce: { x: 10000, y: 10000, z: 10000 } };
            break;
          case 'BodyGyro':
            mover = { ...common, cframe: { x: vec.x, y: vec.y, z: vec.z }, maxTorque: { x: 10000, y: 10000, z: 10000 } };
            break;
          case 'BodyPosition':
            mover = { ...common, position: { x: vec.x, y: vec.y, z: vec.z }, maxForce: { x: 10000, y: 10000, z: 10000 } };
            break;
          case 'BodyThrust':
            mover = { ...common, force: { x: vec.x, y: vec.y, z: vec.z }, location: { x: 0, y: 0, z: 0 } };
            break;
          case 'BodyAngularVelocity':
            mover = { ...common, angularVelocity: { x: vec.x, y: vec.y, z: vec.z }, maxTorque: { x: 10000, y: 10000, z: 10000 } };
            break;
          default: // BodyForce
            mover = { ...common, type: 'BodyForce', force: { x: vec.x, y: vec.y, z: vec.z } };
            break;
        }
        useStudioStore.getState().updateObject(partId, { bodyMovers: [...existingMovers, mover] } as any);
        useStudioStore.getState().addConsoleMessage('info', `[WeildCode] Added ${moverType} to "${part.name}"`);
        break;
      }
      case 'remove_body_mover': {
        if (!part.bodyMovers || part.bodyMovers.length === 0) break;
        useStudioStore.getState().updateObject(partId, { bodyMovers: [] } as any);
        useStudioStore.getState().addConsoleMessage('info', `[WeildCode] Removed all body movers from "${part.name}"`);
        break;
      }
      case 'modify_player_health': {
        // v6.2.1: server mode queues a per-player effect (the acting player
        // only); singleplayer keeps the shared-store behavior.
        if (this.isServerAuthority()) {
          const t = this.playerTargetOf(action);
          const amount = this.paramNumber(partId, action.params.health, 0);
          if (action.params.relative !== false) this.pushPlayerEffect({ kind: 'damage', ...t, value: amount });
          else this.pushPlayerEffect({ kind: 'set_health', ...t, value: amount });
          break;
        }
        if (this.soloTargetMatches(action)) this.executeModifyPlayerHealth(action);
        break;
      }
      case 'set_health': {
        const maxHp = useStudioStore.getState().playState.characterMaxHealth;
        const hp = Math.max(0, Math.min(maxHp, this.paramNumber(partId, action.params.health, 100)));
        if (this.isServerAuthority()) {
          this.pushPlayerEffect({ kind: 'set_health', ...this.playerTargetOf(action), value: hp });
          break;
        }
        if (!this.soloTargetMatches(action)) break;
        const prevHp = useStudioStore.getState().playState.characterHealth;
        useStudioStore.getState().setPlayState({ characterHealth: hp });
        if (hp < prevHp) this.emitPlayerDamaged(this.currentActorName(), hp - prevHp, hp);
        if (hp <= 0 && prevHp > 0) this.emitPlayerDied(this.currentActorName());
        useStudioStore.getState().addConsoleMessage('info', `[WeildCode] Player health set to ${hp}`);
        break;
      }
    }
  }

  // ─── Specific Action Implementations ───

  private executeCreatePart(sourcePartId: string, action: WeildCodeAction) {
    const state = useStudioStore.getState();
    const partType = (action.params.partType || 'Block') as PartType;
    const partName = this.paramString(sourcePartId, action.params.partName, 'NewPart');
    const position = this.paramVec3(sourcePartId, action.params.position, { x: 0, y: 1, z: 0 });
    const color = action.params.color || '#4ff7f5';

    // v7: explicit "relative to" - this part (the classic offset), world
    // (absolute coordinates), or another named part's current position.
    const relativeTo = action.params.relativeTo || 'this part';
    const sourcePart = state.objects.get(sourcePartId);
    let finalPos = position;
    if (relativeTo === 'world') {
      finalPos = position;
    } else if (relativeTo === 'named part') {
      const anchorName = this.paramString(sourcePartId, action.params.relativeToName, '');
      const anchor = this.findPartByName(anchorName);
      if (!anchor) {
        state.addConsoleMessage('warn', `[WeildCode] create_part: part "${anchorName}" not found`);
        return;
      }
      finalPos = {
        x: anchor.position.x + (position.x || 0),
        y: anchor.position.y + (position.y || 0),
        z: anchor.position.z + (position.z || 0),
      };
    } else if (sourcePart && isPart(sourcePart)) {
      finalPos = {
        x: sourcePart.position.x + (position.x || 0),
        y: sourcePart.position.y + (position.y || 0),
        z: sourcePart.position.z + (position.z || 0),
      };
    }

    // Create the part using the store's addPart
    // We need to bypass addPart since it uses its own naming
    const id = `obj_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const partDefaults: Record<string, { color: string; size: Vector3 }> = {
      Block: { color: '#4ff7f5', size: { x: 1, y: 1, z: 1 } },
      Sphere: { color: '#f24b4b', size: { x: 1, y: 1, z: 1 } },
      Wedge: { color: '#f7f54f', size: { x: 1, y: 1, z: 1 } },
      Cylinder: { color: '#37e62e', size: { x: 1, y: 1, z: 1 } },
    };
    const defaults = partDefaults[partType] || partDefaults['Block'];

    const newPart: StudioPart = {
      id,
      name: partName,
      type: partType,
      position: finalPos,
      size: { ...defaults.size },
      rotation: { x: 0, y: 0, z: 0 },
      color: color || defaults.color,
      material: 'Plastic',
      transparency: 0,
      reflectance: 0,
      anchored: true,
      canCollide: true,
      friction: 0.5,
      elasticity: 0.2,
      density: 1.0,
      children: [],
      parentId: null,
      bodyMovers: [],
      effects: [],
    };

    const newObjects = new Map(state.objects);
    newObjects.set(id, newPart);
    useStudioStore.getState().addObject(newPart);
    state.addConsoleMessage('info', `[WeildCode] Created ${partType}: ${partName}`);
  }

  private executeDeletePart(sourcePartId: string, action: WeildCodeAction) {
    const target = action.params.target || 'self';
    const targetName = action.params.targetName || '';

    if (target === 'self') {
      useStudioStore.getState().removeObject(sourcePartId);
    } else if (targetName) {
      // Find by name
      const state = useStudioStore.getState();
      state.objects.forEach((obj) => {
        if (isPart(obj) && obj.name === targetName) {
          useStudioStore.getState().removeObject(obj.id);
        }
      });
    }
  }

  private executeMove(partId: string, action: WeildCodeAction) {
    const mode = action.params.mode || 'offset';
    const position = this.paramVec3(partId, action.params.position, { x: 0, y: 1, z: 0 });

    const state = useStudioStore.getState();
    const part = state.objects.get(partId);
    if (!part || !isPart(part)) return;

    // v7: "relative to another part" - the position lands as an offset on
    // the NAMED part's current position (a platform can follow an anchor
    // part anywhere it goes). Both modes behave the same here.
    if ((action.params.relativeTo || 'self') === 'named') {
      const anchorName = this.paramString(partId, action.params.relativeToName, '');
      const anchor = this.findPartByName(anchorName);
      if (!anchor) {
        useStudioStore.getState().addConsoleMessage('warn', `[WeildCode] move: part "${anchorName}" not found`);
        return;
      }
      useStudioStore.getState().updateObject(partId, {
        position: {
          x: anchor.position.x + (position.x || 0),
          y: anchor.position.y + (position.y || 0),
          z: anchor.position.z + (position.z || 0),
        },
      });
      return;
    }

    if (mode === 'absolute') {
      useStudioStore.getState().updateObject(partId, { position: { ...position } });
    } else {
      // Offset from current position
      useStudioStore.getState().updateObject(partId, {
        position: {
          x: part.position.x + position.x,
          y: part.position.y + position.y,
          z: part.position.z + position.z,
        },
      });
    }
  }

  private executeRotate(partId: string, action: WeildCodeAction) {
    const rotation = this.paramVec3(partId, action.params.rotation, { x: 0, y: 90, z: 0 });

    const state = useStudioStore.getState();
    const part = state.objects.get(partId);
    if (!part || !isPart(part)) return;

    useStudioStore.getState().updateObject(partId, {
      rotation: {
        x: part.rotation.x + rotation.x,
        y: part.rotation.y + rotation.y,
        z: part.rotation.z + rotation.z,
      },
    });
  }

  private executeResize(partId: string, action: WeildCodeAction) {
    const mode = action.params.mode || 'offset';
    const size = this.paramVec3(partId, action.params.size, { x: 1, y: 1, z: 1 });

    const state = useStudioStore.getState();
    const part = state.objects.get(partId);
    if (!part || !isPart(part)) return;

    if (mode === 'absolute') {
      useStudioStore.getState().updateObject(partId, { size: { ...size } });
    } else if (mode === 'offset') {
      useStudioStore.getState().updateObject(partId, {
        size: {
          x: Math.max(0.1, part.size.x + size.x),
          y: Math.max(0.1, part.size.y + size.y),
          z: Math.max(0.1, part.size.z + size.z),
        },
      });
    } else if (mode === 'multiply') {
      useStudioStore.getState().updateObject(partId, {
        size: {
          x: Math.max(0.1, part.size.x * size.x),
          y: Math.max(0.1, part.size.y * size.y),
          z: Math.max(0.1, part.size.z * size.z),
        },
      });
    }
  }

  // ─── Effect Fading ───
  // Find the first effect of the given type on the part and start fading it out.
  // The fade is handled by updateFadingEffects() on each frame.
  private startEffectFade(partId: string, effectType: 'Fire' | 'Smoke' | 'Light', fadeDuration: number) {
    const state = useStudioStore.getState();
    const part = state.objects.get(partId);
    if (!part || !isPart(part)) return;
    const effects = part.effects || [];
    const effect = effects.find((e) => e.type === effectType && e.enabled);
    if (!effect) {
      useStudioStore.getState().addConsoleMessage('warn', `[WeildCode] No ${effectType} effect found on ${part.name}`);
      return;
    }
    // If already fading, reset the timer
    this.fadingEffects.set(effect.id, {
      partId,
      fadeDuration: Math.max(0.1, fadeDuration),
      elapsed: 0,
      startOpacity: effect.opacity ?? 1,
      startSize: effect.size,
      startBrightness: effect.brightness,
      startRange: effect.range,
    });
    useStudioStore.getState().addConsoleMessage('info', `[WeildCode] Fading ${effectType} on ${part.name} over ${fadeDuration}s`);
  }

  // ─── Teleport Player To Part ───
  // Find the named part, compute a position on the chosen face, and set
  // playState.teleportPosition. PlayCharacter picks this up on the next frame.
  private executeTeleportPlayerToPart(sourcePartId: string, action: WeildCodeAction) {
    const teleportPos = this.resolveTeleportToPartPosition(sourcePartId, action);
    if (!teleportPos) return;
    useStudioStore.getState().setPlayState({ teleportPosition: teleportPos });
    useStudioStore.getState().addConsoleMessage('info', `[WeildCode] Teleported player to ${this.paramString(sourcePartId, action.params.targetName, '?')} (${action.params.face || 'top'})`);
  }

  /** v6.2.1: resolve a teleport_player_to_part action to a concrete feet
   * position (null when the target part is missing). Shared by the local
   * store path and the multiplayer per-player effect path. */
  private resolveTeleportToPartPosition(sourcePartId: string, action: WeildCodeAction): { x: number; y: number; z: number } | null {
    const targetName = this.paramString(sourcePartId, action.params.targetName, '');
    const face = action.params.face || 'top';
    const offset = this.paramVec3(sourcePartId, action.params.offset, { x: 0, y: 0, z: 0 });

    if (!targetName) {
      useStudioStore.getState().addConsoleMessage('warn', `[WeildCode] teleport_player_to_part: no target name specified`);
      return null;
    }

    const state = useStudioStore.getState();
    let targetPart: StudioPart | null = null;
    state.objects.forEach((obj) => {
      if (isPart(obj) && obj.name === targetName) {
        targetPart = obj;
      }
    });

    if (!targetPart) {
      useStudioStore.getState().addConsoleMessage('warn', `[WeildCode] teleport_player_to_part: part "${targetName}" not found`);
      return null;
    }

    // After the null check, TypeScript still narrows targetPart to `never`
    // because the assignment happened inside a closure. Re-assign to a
    // non-null typed local to help the compiler.
    const tp: StudioPart = targetPart;

    // Compute the teleport position based on the chosen face.
    // v7: extracted into resolveFacePosition so set_spawn_point can place
    // spawns on part faces with the exact same math.
    return this.resolveFacePosition(tp, face, offset);
  }

  // ─── Teleport Player ───
  // Teleport the player to an xyz position (per-axis relative flags), or -
  // v7 - "relative to a named part" (the position becomes an offset from
  // that part's CURRENT position).
  private executeTeleportPlayer(action: WeildCodeAction) {
    const newPos = this.resolveTeleportPosition('', action);
    if (!newPos) return;

    useStudioStore.getState().setPlayState({ teleportPosition: newPos });
    useStudioStore.getState().addConsoleMessage('info', `[WeildCode] Teleported player to (${newPos.x.toFixed(1)}, ${newPos.y.toFixed(1)}, ${newPos.z.toFixed(1)})`);
  }

  // ─── Modify Player Health ───
  // Modify the player's health. When "relative" is true, the value is added to
  // the current health; when false, it replaces it. Clamped to [0, maxHealth].
  private executeModifyPlayerHealth(action: WeildCodeAction) {
    const healthDelta = this.paramNumber('', action.params.health, 0);
    const relative = action.params.relative !== false; // default true

    const state = useStudioStore.getState();
    const currentHp = state.playState.characterHealth;
    const maxHp = state.playState.characterMaxHealth;
    const newHp = relative
      ? Math.max(0, Math.min(maxHp, currentHp + healthDelta))
      : Math.max(0, Math.min(maxHp, healthDelta));

    state.setPlayState({ characterHealth: newHp });
    // v7: life-state events (solo path - the server fires these from its
    // own per-player hp records instead).
    if (newHp < currentHp) this.emitPlayerDamaged(this.currentActorName(), newHp - currentHp, newHp);
    if (newHp <= 0 && currentHp > 0) this.emitPlayerDied(this.currentActorName());
    useStudioStore.getState().addConsoleMessage('info', `[WeildCode] Player health: ${currentHp} → ${newHp} (${relative ? 'relative' : 'absolute'})`);
  }

  private executeRemoveFromWorkspace(partId: string, action: WeildCodeAction) {
    const target = action.params.target || 'self';
    const targetName = action.params.targetName || '';

    if (target === 'self') {
      useStudioStore.getState().removeObject(partId);
      useStudioStore.getState().addConsoleMessage('info', `[WeildCode] Removed part from workspace`);
    } else if (targetName) {
      const state = useStudioStore.getState();
      state.objects.forEach((obj) => {
        if (isPart(obj) && obj.name === targetName) {
          useStudioStore.getState().removeObject(obj.id);
        }
      });
    }
  }

  private executeCreateCopy(sourcePartId: string, action: WeildCodeAction) {
    const state = useStudioStore.getState();
    const target = action.params.target || 'self';
    const targetName = this.paramString(sourcePartId, action.params.targetName, '');
    const copyName = this.paramString(sourcePartId, action.params.copyName, '');
    const count = Math.floor(Math.min(Math.max(1, this.paramNumber(sourcePartId, action.params.count, 1)), 20)); // cap at 20 copies
    const offset = this.paramVec3(sourcePartId, action.params.offset, { x: 2, y: 0, z: 0 });

    // Find the source part
    let sourcePart: StudioPart | null = null;
    if (target === 'self') {
      const obj = state.objects.get(sourcePartId);
      if (obj && isPart(obj)) sourcePart = obj;
    } else if (targetName) {
      state.objects.forEach((obj) => {
        if (isPart(obj) && obj.name === targetName) sourcePart = obj;
      });
    }

    if (!sourcePart) {
      state.addConsoleMessage('warn', `[WeildCode] create_copy: source part not found`);
      return;
    }

    for (let i = 0; i < count; i++) {
      const id = `obj_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      const newPart: StudioPart = {
        ...JSON.parse(JSON.stringify(sourcePart)),
        id,
        name: copyName || `${sourcePart.name}_copy`,
        position: {
          x: sourcePart.position.x + offset.x * (i + 1),
          y: sourcePart.position.y + offset.y * (i + 1),
          z: sourcePart.position.z + offset.z * (i + 1),
        },
        parentId: null,
        children: [],
        bodyMovers: [],
        effects: [],
        rules: [],
      };
      useStudioStore.getState().addObject(newPart);
    }
    state.addConsoleMessage('info', `[WeildCode] Created ${count} copy(ies) of ${sourcePart.name}`);
  }

  private executeAddRule(partId: string, action: WeildCodeAction) {
    const state = useStudioStore.getState();
    const target = action.params.target || 'self';
    const targetName = action.params.targetName || '';
    const triggerType = action.params.triggerType || 'when_clicked';
    const actionType = action.params.actionType || 'print_message';

    // Find the target part
    let targetPartId = partId;
    if (target === 'named' && targetName) {
      let found = false;
      state.objects.forEach((obj) => {
        if (isPart(obj) && obj.name === targetName && !found) {
          targetPartId = obj.id;
          found = true;
        }
      });
      if (!found) {
        state.addConsoleMessage('warn', `[WeildCode] add_rule: target "${targetName}" not found`);
        return;
      }
    }

    // Use the imported createBlankRule and createBlankAction
    const rule = createBlankRule('simple');
    rule.trigger.type = triggerType as any;
    rule.trigger.params = {};
    rule.actions = [createBlankAction(actionType as any)];

    useStudioStore.getState().addRule(targetPartId, rule);
    state.addConsoleMessage('info', `[WeildCode] Added rule (${triggerType} → ${actionType}) to ${targetPartId === partId ? 'self' : targetName}`);
  }

  private executeChangeVariable(partId: string, action: WeildCodeAction) {
    const varName = action.params.variableName || '';
    if (!varName) return;

    const state = useStudioStore.getState();
    const scope = action.params.scope || 'global';
    const part = state.objects.get(partId);
    // Current value: from per-object vars if scope=object, else from globals.
    const currentValue = scope === 'object'
      ? (part && isPart(part) ? part.objectVariables?.[varName] : undefined)
      : state.globalVariables[varName];
    const expression = String(action.params.expression || 'variable + 1');
    const mode = action.params.mode || 'set';

    // "variable" always refers to the variable's own current value.
    let resolvedExpr = expression;
    if (currentValue !== undefined) {
      resolvedExpr = resolvedExpr.replace(/\bvariable\b/g, String(currentValue));
    }

    // Resolve names + functions + time, then evaluate.
    // The target variable's own name stays a literal ("variable" already
    // means its current value) so "score + 1" on score never double-reads.
    const result = this.evalExpression(partId, resolvedExpr, varName);
    if (result === null) {
      state.addConsoleMessage('warn', `[WeildCode] change_variable: failed to evaluate "${expression}"`);
      return;
    }

    // Apply the result based on mode
    let newValue: number | string;
    const currentNum = Number(currentValue) || 0;
    if (mode === 'add') {
      newValue = currentNum + result;
    } else if (mode === 'multiply') {
      newValue = currentNum * result;
    } else {
      newValue = result; // set
    }

    if (scope === 'object') {
      state.setObjectVariable(partId, varName, newValue);
      state.addConsoleMessage('info', `[WeildCode] Changed object variable "${varName}" to ${newValue} (mode: ${mode})`);
    } else {
      state.setGlobalVariable(varName, newValue);
      state.addConsoleMessage('info', `[WeildCode] Changed variable "${varName}" to ${newValue} (mode: ${mode})`);
    }
  }

  // ─── v1.6: shared expression evaluator + value resolver ───
  // Used by change_variable AND set_variable (block-built values).

  /** Replace a whole-word token in an expression (regex-safe, no-throw). */
  private replaceWordToken(expr: string, word: string, value: string): string {
    try {
      return expr.replace(new RegExp(`\\b${word}\\b`, 'g'), value);
    } catch {
      return expr; // variable name with regex-special chars: leave as-is
    }
  }

  /**
   * Evaluate a math expression against the current variables.
   * Resolves: object variables on partId (when given), global variables,
   * timeOfDay, and the safe math functions. Returns null when it cannot
   * be evaluated to a finite number.
   */
  private evalExpression(partId: string, expr: string, excludeName?: string): number | null {
    const state = useStudioStore.getState();
    let resolvedExpr = expr;

    if (partId) {
      const part = state.objects.get(partId);
      if (part && isPart(part) && part.objectVariables) {
        for (const [name, val] of Object.entries(part.objectVariables)) {
          if (name === excludeName) continue;
          resolvedExpr = this.replaceWordToken(resolvedExpr, name, String(val));
        }
      }
    }
    for (const [name, val] of Object.entries(state.globalVariables)) {
      if (name === excludeName) continue;
      resolvedExpr = this.replaceWordToken(resolvedExpr, name, String(val));
    }

    resolvedExpr = resolvedExpr
      .replace(/\bsqrt\b/g, 'Math.sqrt')
      .replace(/\babs\b/g, 'Math.abs')
      .replace(/\bfloor\b/g, 'Math.floor')
      .replace(/\bceil\b/g, 'Math.ceil')
      .replace(/\bround\b/g, 'Math.round')
      .replace(/\bsin\b/g, 'Math.sin')
      .replace(/\bcos\b/g, 'Math.cos')
      .replace(/\btan\b/g, 'Math.tan')
      .replace(/\bpow\b/g, 'Math.pow')
      .replace(/\bmin\b/g, 'Math.min')
      .replace(/\bmax\b/g, 'Math.max')
      .replace(/\bPI\b/g, 'Math.PI')
      .replace(/\btimeOfDay\b/g, String(state.worldSettings.timeOfDay));

    try {
      // Use Function constructor for safe-ish evaluation (no access to scope)
      const fn = new Function(`"use strict"; return (${resolvedExpr})`);
      const result = Number(fn());
      if (!isFinite(result)) return null;
      return result;
    } catch {
      return null;
    }
  }

  /**
   * Resolve a set_variable VALUE (v1.6, block editor):
   *   "42"        -> 42                       (number)
   *   "score"     -> the variable score's value (name reference)
   *   "score + 1" -> evaluated result          (math expression)
   *   "hello"     -> "hello"                   (plain text)
   * v1.7 tagged block values:
   *   {__wb_var: "score"}    -> the variable's value
   *   {__wb_expr: "a + b"}   -> evaluated result (0 when it can't be)
   */
  private resolveVariableValue(partId: string, rawValue: unknown): number | string {
    // v1.7: tagged block values first (no ambiguity with plain strings).
    if (rawValue !== null && typeof rawValue === 'object' && !Array.isArray(rawValue)) {
      const v = rawValue as { __wb_var?: unknown; __wb_expr?: unknown };
      if (typeof v.__wb_var === 'string') return this.lookupVariableValue(partId, v.__wb_var);
      if (typeof v.__wb_expr === 'string') {
        const evaluated = this.evalExpression(partId, v.__wb_expr);
        return evaluated ?? 0;
      }
      return String(rawValue);
    }
    const trimmed = String(rawValue ?? '').trim();
    if (trimmed === '') return 0;
    const numVal = Number(trimmed);
    if (!isNaN(numVal)) return numVal;

    const state = useStudioStore.getState();
    if (partId) {
      const part = state.objects.get(partId);
      if (part && isPart(part)) {
        const v = part.objectVariables?.[trimmed];
        if (v !== undefined) return v as number | string;
      }
    }
    const g = state.globalVariables[trimmed];
    if (g !== undefined) return g as number | string;

    // Looks like math? try to evaluate it.
    if (/[+\-*\/^()]|\bsqrt\b|\babs\b|\bfloor\b|\bceil\b|\bround\b|\bsin\b|\bcos\b|\btan\b|\bmin\b|\bmax\b|\bpow\b|\bPI\b|\btimeOfDay\b/.test(trimmed)) {
      const evaluated = this.evalExpression(partId, trimmed);
      if (evaluated !== null) return evaluated;
    }
    return String(rawValue);
  }

  // ─── v1.7: block-value param resolution (every rule param) ───
  // Number and text params compiled from the Code editor can be:
  //   • a plain literal (number | string)               -> used as-is
  //   • { __wb_var: "score" }  a variable reference     -> looked up
  //   • { __wb_expr: "a + b" } a math expression        -> evaluated
  // Vector3 params resolve axis by axis. Anything that fails to resolve
  // degrades to the provided fallback instead of throwing.

  /** Look a variable up: object variables on the acting part first, then
   * globals. Unknown variables read as 0. */
  private lookupVariableValue(partId: string, name: string): number | string {
    const state = useStudioStore.getState();
    if (partId) {
      const part = state.objects.get(partId);
      if (part && isPart(part)) {
        const v = part.objectVariables?.[name];
        if (v !== undefined) return v as number | string;
      }
    }
    const g = state.globalVariables[name];
    if (g !== undefined) return g as number | string;
    return 0;
  }

  /** Resolve one raw param value (literal / var ref / expression). */
  private resolveParamValue(partId: string, raw: unknown): number | string {
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      const v = raw as { __wb_var?: unknown; __wb_expr?: unknown };
      if (typeof v.__wb_var === 'string') return this.lookupVariableValue(partId, v.__wb_var);
      if (typeof v.__wb_expr === 'string') {
        const evaluated = this.evalExpression(partId, v.__wb_expr);
        return evaluated ?? 0;
      }
    }
    return raw as number | string;
  }

  /** Resolve a NUMBER param with a safe fallback. */
  private paramNumber(partId: string, raw: unknown, fallback: number): number {
    if (raw === undefined || raw === null || raw === '') return fallback;
    if (typeof raw === 'number') return isFinite(raw) ? raw : fallback;
    const v = this.resolveParamValue(partId, raw);
    const n = Number(v);
    return isFinite(n) ? n : fallback;
  }

  /** Resolve a TEXT param with a safe fallback. */
  private paramString(partId: string, raw: unknown, fallback: string): string {
    if (raw === undefined || raw === null) return fallback;
    if (typeof raw === 'string') return this.interpolate(partId, raw);
    if (typeof raw === 'number') return String(raw);
    const v = this.resolveParamValue(partId, raw);
    const s = v === undefined || v === null ? fallback : String(v);
    // v7: $(name) interpolation applies to ANY text param - messages,
    // part names, filters: "Score: $(score)" shows the live value.
    return this.interpolate(partId, s);
  }

  /** Resolve a VECTOR3-ish param ({x,y,z} with any axis being a literal,
   * variable reference or expression). */
  private paramVec3(partId: string, raw: unknown, fallback: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
    if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) return { ...fallback };
    const o = raw as Record<string, unknown>;
    return {
      x: this.paramNumber(partId, o.x, fallback.x),
      y: this.paramNumber(partId, o.y, fallback.y),
      z: this.paramNumber(partId, o.z, fallback.z),
    };
  }

  private clamp01(n: number): number {
    return Math.max(0, Math.min(1, n));
  }

  /** v1.7: clamp a repeat count (1..MAX_REPEAT_COUNT). */
  private clampRepeatCount(raw: number): number {
    if (!isFinite(raw) || raw < 1) return 1;
    return Math.min(Math.floor(raw), WeildCodeEngine.MAX_REPEAT_COUNT);
  }

  /** v1.7: spend one unit of the per-frame action budget. False = the
   * frame is over budget and this action must be skipped. */
  private spendActionBudget(): boolean {
    this.frameActionCount++;
    if (this.frameActionCount <= WeildCodeEngine.MAX_ACTIONS_PER_FRAME) return true;
    const now = performance.now();
    if (now - this.lastBudgetWarnAt > 1000) {
      this.lastBudgetWarnAt = now;
      useStudioStore.getState().addConsoleMessage(
        'warn',
        `[WeildCode] Rule budget reached for this frame (${WeildCodeEngine.MAX_ACTIONS_PER_FRAME} actions). Some actions were skipped. Use longer intervals or smaller repeats.`,
      );
    }
    return false;
  }

  /** v1.7: may this part take another effect? (capped per part) */
  private canAddEffect(partId: string): boolean {
    const part = useStudioStore.getState().objects.get(partId);
    if (!part || !isPart(part)) return false;
    if ((part.effects || []).length >= WeildCodeEngine.MAX_EFFECTS) {
      useStudioStore.getState().addConsoleMessage('warn', `[WeildCode] "${part.name}" already has ${WeildCodeEngine.MAX_EFFECTS} effects. Remove some first.`);
      return false;
    }
    return true;
  }

  // ─── Variable Trigger Polling ───

  /** v1.7: parts that actually carry polled rules (rebuilt when the world
   * changes). Big worlds without such rules skip the whole scan. */
  private getPolledParts(state: ReturnType<typeof useStudioStore.getState>): { part: StudioPart; rules: WeildCodeRule[] }[] {
    if (this.polledPartsVersion === state.objectsVersion) return this.polledPartsCache;
    const cached: { part: StudioPart; rules: WeildCodeRule[] }[] = [];
    state.objects.forEach((obj) => {
      if (!isPart(obj)) return;
      const rules = (obj.rules || []).filter((r) =>
        r.enabled && (
          r.trigger.type === 'when_variable_equals' ||
          r.trigger.type === 'when_variable_changes' ||
          r.trigger.type === 'when_condition' ||
          r.trigger.type === 'when_coinflip'
        ));
      if (rules.length > 0) cached.push({ part: obj, rules });
    });
    this.polledPartsCache = cached;
    this.polledPartsVersion = state.objectsVersion;
    return cached;
  }

  // ─── Variable Trigger Polling ───

  private updateVariableTriggers(dt: number, state: ReturnType<typeof useStudioStore.getState>) {
    const currentVars = state.globalVariables;
    const polled = this.getPolledParts(state);
    if (polled.length === 0) return;

    // ── Global variable change detection (existing) ──
    const changedVars = new Set<string>();
    for (const [name, value] of Object.entries(currentVars)) {
      const prev = this.variableSnapshots.get(name);
      if (prev !== value) {
        changedVars.add(name);
        this.variableSnapshots.set(name, value);
      }
    }
    // Also detect deleted variables
    for (const [name] of this.variableSnapshots) {
      if (!(name in currentVars)) {
        changedVars.add(name);
        this.variableSnapshots.delete(name);
      }
    }

    // ── Per-object variable change detection (polled parts only) ──
    // Build a map: partId -> set of changed var names
    const changedObjectVars = new Map<string, Set<string>>();
    for (const { part } of polled) {
      const current = part.objectVariables || {};
      const prev = this.objectVariableSnapshots.get(part.id) || new Map<string, number | string>();
      const changed = new Set<string>();
      // Detect value changes and new vars
      for (const [name, value] of Object.entries(current)) {
        if (prev.get(name) !== value) {
          changed.add(name);
        }
      }
      // Detect deleted vars
      for (const [name] of prev) {
        if (!(name in current)) {
          changed.add(name);
        }
      }
      if (changed.size > 0) {
        changedObjectVars.set(part.id, changed);
        // Update snapshot to current
        const snap = new Map<string, number | string>();
        for (const [name, value] of Object.entries(current)) {
          snap.set(name, value);
        }
        this.objectVariableSnapshots.set(part.id, snap);
      }
    }

    // ── Fire when_variable_changes ──
    // Global scope
    if (changedVars.size > 0) {
      for (const { part, rules } of polled) {
        for (const rule of rules) {
          if (rule.trigger.type !== 'when_variable_changes') continue;
          const scope = rule.trigger.params.scope || 'global';
          if (scope !== 'global') continue; // handled below
          const varName = rule.trigger.params.variableName || '';
          if (changedVars.has(varName)) {
            this.executeActions(part.id, rule.actions, rule.id);
          }
        }
      }
    }
    // Object scope - only fire on the part that owns the variable
    if (changedObjectVars.size > 0) {
      changedObjectVars.forEach((changedSet, partId) => {
        const entry = polled.find((p) => p.part.id === partId);
        if (!entry) return;
        for (const rule of entry.rules) {
          if (rule.trigger.type !== 'when_variable_changes') continue;
          const scope = rule.trigger.params.scope || 'global';
          if (scope !== 'object') continue;
          const varName = rule.trigger.params.variableName || '';
          if (changedSet.has(varName)) {
            this.executeActions(partId, rule.actions, rule.id);
          }
        }
      });
    }

    // ── Poll when_variable_equals ──
    for (const { part, rules } of polled) {
      for (const rule of rules) {
        if (rule.trigger.type !== 'when_variable_equals') continue;
        const varName = rule.trigger.params.variableName || '';
        const targetValue = this.paramString(part.id, rule.trigger.params.value, '');
        const checkInterval = Math.max(WeildCodeEngine.MIN_INTERVAL, this.paramNumber(part.id, rule.trigger.params.checkInterval, 0.5));
        const scope = rule.trigger.params.scope || 'global';

        const key = `${part.id}_${rule.id}`;
        let acc = this.variableCheckAccumulators.get(key) || 0;
        acc += dt;
        if (acc >= checkInterval) {
          acc = 0;
          const currentValue = scope === 'object'
            ? part.objectVariables?.[varName]
            : currentVars[varName];
          if (currentValue !== undefined && String(currentValue) === targetValue) {
            this.executeActions(part.id, rule.actions, rule.id);
          }
        }
        this.variableCheckAccumulators.set(key, acc);
      }
    }
  }

  // ─── Condition Trigger Polling ───

  private updateConditionTriggers(dt: number, state: ReturnType<typeof useStudioStore.getState>) {
    for (const { part, rules } of this.getPolledParts(state)) {
      for (const rule of rules) {
        // when_coinflip
        if (rule.trigger.type === 'when_coinflip') {
          const key = `${part.id}_${rule.id}`;
          const chancePercent = Math.max(0, Math.min(100, this.paramNumber(part.id, rule.trigger.params.chancePercent, 50)));
          const repeat = rule.trigger.params.repeat || 'every';

          if (repeat === 'once' && this.coinFlipFired.has(key)) continue;

          let acc = this.conditionCheckAccumulators.get(key) || 0;
          acc += dt;
          if (acc >= 1.0) { // check every second
            acc = 0;
            const roll = Math.random() * 100;
            if (roll < chancePercent) {
              this.executeActions(part.id, rule.actions, rule.id);
              if (repeat === 'once') {
                this.coinFlipFired.add(key);
              }
            }
          }
          this.conditionCheckAccumulators.set(key, acc);
        }

        // when_condition
        if (rule.trigger.type === 'when_condition') {
          const key = `${part.id}_${rule.id}`;
          const condition = rule.trigger.params.condition || 'anchored';
          const checkInterval = Math.max(WeildCodeEngine.MIN_INTERVAL, this.paramNumber(part.id, rule.trigger.params.checkInterval, 0.5));

          let acc = this.conditionCheckAccumulators.get(key) || 0;
          acc += dt;
          if (acc >= checkInterval) {
            acc = 0;
            const fresh = state.objects.get(part.id);
            if (fresh && isPart(fresh) && this.evaluateCondition(fresh, condition, rule.trigger.params, state)) {
              this.executeActions(part.id, rule.actions, rule.id);
            }
          }
          this.conditionCheckAccumulators.set(key, acc);
        }
      }
    }
  }

  private evaluateCondition(part: StudioPart, condition: string, params: Record<string, any>, state: ReturnType<typeof useStudioStore.getState>): boolean {
    switch (condition) {
      case 'anchored': return part.anchored;
      case 'canCollide': return part.canCollide;
      case 'hasEffect': return (part.effects || []).length > 0;
      case 'hasBodyMover': return part.bodyMovers.length > 0;
      case 'isWelded': return state.joints.some(j => j.enabled && (j.partAId === part.id || j.partBId === part.id) && j.type === 'Weld');
      case 'isRoped': return state.joints.some(j => j.enabled && (j.partAId === part.id || j.partBId === part.id) && j.type === 'Rope');
      case 'shapeBlock': return part.type === 'Block';
      case 'shapeSphere': return part.type === 'Sphere';
      case 'shapeCylinder': return part.type === 'Cylinder';
      case 'shapeWedge': return part.type === 'Wedge';
      case 'propertyEquals': {
        const propertyName = params.propertyName || 'size';
        const propertyValue = params.propertyValue || '';
        switch (propertyName) {
          case 'size': return `${part.size.x},${part.size.y},${part.size.z}` === propertyValue;
          case 'rotation': return `${part.rotation.x},${part.rotation.y},${part.rotation.z}` === propertyValue;
          case 'color': return part.color === propertyValue;
          case 'material': return part.material === propertyValue;
          case 'friction': return String(part.friction) === propertyValue;
          case 'elasticity': return String(part.elasticity) === propertyValue;
          case 'density': return String(part.density) === propertyValue;
          case 'mass': return String(part.size.x * part.size.y * part.size.z * part.density) === propertyValue;
          case 'transparency': return String(part.transparency) === propertyValue;
          case 'reflectance': return String(part.reflectance) === propertyValue;
          case 'name': return part.name === propertyValue;
          default: return false;
        }
      }
      default: return false;
    }
  }

  // ─── Name Label Management ───

  private updateNameLabels() {
    const now = performance.now();
    const expired: string[] = [];
    for (const [partId, label] of this.nameLabels.entries()) {
      if (label.duration > 0 && (now - label.startTime) / 1000 >= label.duration) {
        expired.push(partId);
      }
    }
    for (const id of expired) {
      this.nameLabels.delete(id);
    }
  }

  /** Get all active name labels - used by Viewport3D to render them */
  getNameLabels(): Array<{ partId: string; text: string; color: string; fontSize: number }> {
    const result: Array<{ partId: string; text: string; color: string; fontSize: number }> = [];
    for (const [partId, label] of this.nameLabels.entries()) {
      result.push({ partId, text: label.text, color: label.color, fontSize: label.fontSize });
    }
    return result;
  }

  // ─── Event Handlers (called from Viewport3D + the store) ───

  // ─── v7: the new rule machinery (IF conditions, properties, spawns) ───

  /** Solo-path event emitters (thin aliases of the public handlers, so
   * rule code and the play viewports share one guarded path). */
  private emitPlayerDamaged(username: string, amount: number, healthAfter: number): void {
    this.handlePlayerDamaged(username, amount, healthAfter);
  }
  private emitPlayerDied(username: string): void {
    this.handlePlayerDied(username);
  }

  /** First part with the given name (null when missing). */
  private findPartByName(name: string): StudioPart | null {
    if (!name) return null;
    let found: StudioPart | null = null;
    useStudioStore.getState().objects.forEach((obj) => {
      if (!found && isPart(obj) && obj.name === name) found = obj;
    });
    return found;
  }

  /** The acting part by id (null when missing). */
  private findPartById(partId: string): StudioPart | null {
    const obj = useStudioStore.getState().objects.get(partId);
    return obj && isPart(obj) ? obj : null;
  }

  /** v7: evaluate an if_condition comparison (THEN branch when true). */
  private evaluateIfCondition(partId: string, action: WeildCodeAction): boolean {
    const left = this.evalOperand(partId, action.params.left);
    const right = this.evalOperand(partId, action.params.right);
    return this.compareOperands(left, action.params.operator || '=', right);
  }

  /** Resolve one operand spec to a number or string. */
  private evalOperand(partId: string, op: unknown): number | string {
    if (op === null || op === undefined || typeof op !== 'object' || Array.isArray(op)) return 0;
    const o = op as OperandSpec;
    switch (o.source) {
      case 'player': {
        // v7: player stats as VALUES - "if player health < 30 then ...",
        // "if player speed > 20 then ...", "$(health)" in text.
        const stats = this.statsFor(this.currentActorName());
        if (o.stat === 'username') return this.currentActorName();
        if (o.stat === 'maxHealth') return stats.maxHealth;
        if (o.stat === 'speed') return stats.speed > 0 ? stats.speed : 10.8;
        return stats.health;
      }
      case 'part': {
        const part = o.value
          ? this.findPartByName(this.interpolate(partId, String(o.value)))
          : this.findPartById(partId);
        if (!part) return 0;
        return this.partPropertyValue(part, o.prop || 'x');
      }
      case 'variable':
        return this.lookupVariableValue(partId, this.interpolate(partId, String(o.value ?? '')));
      case 'text':
        return this.interpolate(partId, String(o.value ?? ''));
      case 'number':
      default:
        return this.paramNumber(partId, o.value, 0);
    }
  }

  /** A part property by key (for IF conditions + part operands). */
  private partPropertyValue(part: StudioPart, prop: string): number | string {
    switch (prop) {
      case 'x': return Math.round(part.position.x * 100) / 100;
      case 'y': return Math.round(part.position.y * 100) / 100;
      case 'z': return Math.round(part.position.z * 100) / 100;
      case 'sizeX': return part.size.x;
      case 'sizeY': return part.size.y;
      case 'sizeZ': return part.size.z;
      case 'anchored': return part.anchored ? 1 : 0;
      case 'canCollide': return part.canCollide ? 1 : 0;
      case 'transparency': return part.transparency;
      case 'reflectance': return part.reflectance;
      case 'color': return part.color;
      case 'material': return part.material;
      case 'name': return part.name;
      case 'mass': return Math.round(part.size.x * part.size.y * part.size.z * part.density * 100) / 100;
      default: return 0;
    }
  }

  /** Compare two operand values with the chosen operator (numeric when
   * both sides look like numbers, text comparison otherwise). */
  private compareOperands(left: number | string, operator: string, right: number | string): boolean {
    const lStr = String(left);
    const rStr = String(right);
    const lNum = Number(lStr);
    const rNum = Number(rStr);
    const bothNumeric = lStr.trim() !== '' && rStr.trim() !== '' && isFinite(lNum) && isFinite(rNum);
    switch (operator) {
      case 'contains': return lStr.toLowerCase().includes(rStr.toLowerCase());
      case '!=': return bothNumeric ? lNum !== rNum : lStr !== rStr;
      case '<': return bothNumeric ? lNum < rNum : lStr < rStr;
      case '>': return bothNumeric ? lNum > rNum : lStr > rStr;
      case '<=': return bothNumeric ? lNum <= rNum : lStr <= rStr;
      case '>=': return bothNumeric ? lNum >= rNum : lStr >= rStr;
      case '=':
      default: return bothNumeric ? lNum === rNum : lStr === rStr;
    }
  }

  /** v7: modify_property - set a typed property on this part (or a named
   * part). Returns false when there was nothing valid to change. */
  private executeModifyProperty(partId: string, action: WeildCodeAction, gameRule = false): boolean {
    const target = action.params.target || 'self';
    const targetName = this.paramString(partId, action.params.targetName, '');
    let targetPart: StudioPart | null = null;
    if (target === 'named' && targetName) {
      targetPart = this.findPartByName(targetName);
      if (!targetPart) {
        useStudioStore.getState().addConsoleMessage('warn', `[WeildCode] modify_property: part "${targetName}" not found`);
        return false;
      }
    } else if (!gameRule) {
      targetPart = this.findPartById(partId);
    }
    if (!targetPart) return false;

    const property = action.params.property || 'anchored';
    let patch: Record<string, any> | null = null;
    switch (property) {
      case 'anchored': patch = { anchored: action.params.boolValue !== false }; break;
      case 'canCollide': patch = { canCollide: action.params.boolValue !== false }; break;
      case 'transparency': patch = { transparency: this.clamp01(this.paramNumber(partId, action.params.numberValue, 0)) }; break;
      case 'reflectance': patch = { reflectance: this.clamp01(this.paramNumber(partId, action.params.numberValue, 0)) }; break;
      case 'friction': patch = { friction: Math.max(0, this.paramNumber(partId, action.params.numberValue, 0.5)) }; break;
      case 'elasticity': patch = { elasticity: Math.max(0, this.paramNumber(partId, action.params.numberValue, 0.2)) }; break;
      case 'density': patch = { density: Math.max(0.01, this.paramNumber(partId, action.params.numberValue, 1)) }; break;
      case 'color': patch = { color: action.params.colorValue || '#4ff7f5' }; break;
      case 'material': patch = { material: this.paramString(partId, action.params.stringValue, 'Plastic') || 'Plastic' }; break;
      case 'name': {
        const name = this.paramString(partId, action.params.stringValue, '').trim();
        if (!name) return false;
        patch = { name };
        break;
      }
      default: return false;
    }
    useStudioStore.getState().updateObject(targetPart.id, patch as any);
    useStudioStore.getState().addConsoleMessage('info', `[WeildCode] ${property} of "${targetPart.name}" set`);
    return true;
  }

  /** v7: resolve a teleport_player position - per-axis relative flags, or
   * "relative to a named part" (the position becomes an offset from that
   * part's current position). Shared by the solo + server paths. */
  private resolveTeleportPosition(partId: string, action: WeildCodeAction): { x: number; y: number; z: number } | null {
    const pos = this.paramVec3(partId, action.params.position, { x: 0, y: 5, z: 0 });
    if ((action.params.relativeTo || 'none') === 'named') {
      const anchorName = this.paramString(partId, action.params.relativeToName, '');
      const anchor = this.findPartByName(anchorName);
      if (!anchor) {
        useStudioStore.getState().addConsoleMessage('warn', `[WeildCode] teleport_player: part "${anchorName}" not found`);
        return null;
      }
      return {
        x: anchor.position.x + (pos.x || 0),
        y: anchor.position.y + (pos.y || 0),
        z: anchor.position.z + (pos.z || 0),
      };
    }
    const p = action.params.position || {};
    const cur = useStudioStore.getState().playState.characterPosition;
    return {
      x: p.relativeX ? cur.x + (pos.x || 0) : (pos.x || 0),
      y: p.relativeY ? cur.y + (pos.y || 0) : (pos.y || 0),
      z: p.relativeZ ? cur.z + (pos.z || 0) : (pos.z || 0),
    };
  }

  /** v7: resolve a set_spawn_point position (a position, or next to a
   * named part on the chosen face + offset). */
  private resolveSpawnPosition(partId: string, action: WeildCodeAction): { x: number; y: number; z: number } | null {
    if ((action.params.at || 'position') === 'part') {
      const partName = this.paramString(partId, action.params.partName, '');
      const anchor = this.findPartByName(partName);
      if (!anchor) {
        useStudioStore.getState().addConsoleMessage('warn', `[WeildCode] set_spawn_point: part "${partName}" not found`);
        return null;
      }
      const offset = this.paramVec3(partId, action.params.offset, { x: 0, y: 0, z: 0 });
      return this.resolveFacePosition(anchor, action.params.face || 'top', offset);
    }
    const pos = this.paramVec3(partId, action.params.position, { x: 0, y: 1, z: 0 });
    return { x: pos.x || 0, y: pos.y || 0, z: pos.z || 0 };
  }

  /** v7: shared face-position resolver (top/bottom/sides/center of a part
   * plus an offset) - used by teleport_player_to_part AND set_spawn_point.
   * The player is placed just OUTSIDE the face so they never spawn inside
   * the part. */
  private resolveFacePosition(tp: StudioPart, face: string, offset: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
    const px = tp.position.x;
    const py = tp.position.y;
    const pz = tp.position.z;
    const sx = tp.size.x;
    const sy = tp.size.y;
    const sz = tp.size.z;
    // Player offset from the face surface (stands ON the face, not embedded).
    const PLAYER_HALF_HEIGHT = 1.0;

    let pos: { x: number; y: number; z: number };
    switch (face) {
      case 'top': pos = { x: px, y: py + sy / 2 + PLAYER_HALF_HEIGHT, z: pz }; break;
      case 'bottom': pos = { x: px, y: py - sy / 2 - PLAYER_HALF_HEIGHT, z: pz }; break;
      case 'left': pos = { x: px - sx / 2 - 0.5, y: py, z: pz }; break;   // -X
      case 'right': pos = { x: px + sx / 2 + 0.5, y: py, z: pz }; break;  // +X
      case 'front': pos = { x: px, y: py, z: pz - sz / 2 - 0.5 }; break;  // -Z
      case 'back': pos = { x: px, y: py, z: pz + sz / 2 + 0.5 }; break;   // +Z
      case 'center': default: pos = { x: px, y: py, z: pz }; break;
    }

    pos.x += offset.x || 0;
    pos.y += offset.y || 0;
    pos.z += offset.z || 0;
    return pos;
  }

  /** v6.2.1: `actor` is the player who clicked (multiplayer authority
   * passes the clicker's username so kill/heal/damage/teleport actions hit
   * THEM, not everyone). */
  handleClick(partId: string, actor?: string) {
    this.withActor(actor, () => this.fireTrigger(partId, 'when_clicked'));
  }

  /** v6.2.1: `actor` is the player whose character touched the part (same
   * multiplayer semantics as handleClick). */
  handleTouch(partId: string, touchType: 'player' | 'parts' | 'any' = 'any', actor?: string) {
    // v1.7 PERF: standing on a part fires the physics contact EVERY frame
    // (~60 Hz). A 100 ms debounce per part + touch type keeps touch rules
    // responsive (10 fires/sec max) while killing the rule storm.
    // v6.2.1: the debounce key now includes the ACTING PLAYER - with the old
    // part-only key, one player's touch ate the NEXT player's touch event
    // within the 100 ms window (two players hitting the same lava brick =
    // only the first one died until they stepped off and back on).
    const key = `${partId}::${touchType}::${actor ?? ''}`;
    const now = performance.now();
    const last = this.touchFiredAt.get(key) ?? -Infinity;
    if (now - last < WeildCodeEngine.TOUCH_DEBOUNCE_MS) return;
    this.touchFiredAt.set(key, now);
    this.withActor(actor, () => this.fireTrigger(partId, 'when_touched', { touchType }));
  }

  // v13.4: re-entrancy guard - a when_destroyed rule that deletes parts
  // (which fires more when_destroyed rules...) must not loop forever.
  private destroyingDepth = 0;

  handleDestroyed(partId: string) {
    if (this.destroyingDepth > 3) return; // chains deeper than 3 are almost certainly a loop
    this.destroyingDepth++;
    try {
      this.fireTrigger(partId, 'when_destroyed');
    } finally {
      this.destroyingDepth--;
    }
    this.createdParts.delete(partId);
  }

  // v13.4: on_property_change throttle. The store calls this for every
  // changed property on every updateObject call; during drags that's up to
  // 60 calls/second per property. Rules should still fire promptly, but not
  // 60x/second - 150 ms per part+property is indistinguishable to a human.
  private propertyFiredAt: Map<string, number> = new Map();
  private static PROPERTY_THROTTLE_MS = 150;

  handlePropertyChanged(partId: string, property: string) {
    const key = `${partId}::${property}`;
    const now = performance.now();
    const last = this.propertyFiredAt.get(key) ?? -Infinity;
    if (now - last < WeildCodeEngine.PROPERTY_THROTTLE_MS) return;
    this.propertyFiredAt.set(key, now);
    this.fireTrigger(partId, 'on_property_change', { property });
  }
}

// ─── Singleton Engine Instance ───

export const weildCodeEngine = new WeildCodeEngine();

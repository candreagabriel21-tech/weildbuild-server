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
}

interface PendingWait {
  ruleId: string;
  partId: string;
  actionIndex: number;
  remainingSeconds: number;
  /** v1.5: the wait belongs to a GAME rule (no part context). */
  gameRule?: boolean;
}

class WeildCodeEngine {
  private timers: Map<string, TimerState> = new Map();
  private pendingWaits: Map<string, PendingWait> = new Map();
  private lastTime: number = 0;
  private animFrameId: number | null = null;
  private isRunning: boolean = false;

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
    // Clear any on-screen messages
    useStudioStore.getState().clearScreenMessages();
  }

  // ─── Main Update Loop ───

  private update = () => {
    if (!this.isRunning) return;

    const now = performance.now();
    const dt = (now - this.lastTime) / 1000; // delta in seconds
    this.lastTime = now;

    const state = useStudioStore.getState();

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

        if (timeMode === 'exact') {
          const target = params.timeValue || '12:00';
          const [h, m] = target.split(':').map(Number);
          const targetHours = h + m / 60;
          // Check if current time is within 0.5 hours of target
          return Math.abs(timeOfDay - targetHours) < 0.5;
        } else {
          // Period-based
          const period = params.period || 'noon';
          return this.isTimeInPeriod(timeOfDay, period);
        }
      }
      case 'when_weather_is': {
        const state = useStudioStore.getState();
        return state.worldSettings.weatherType === (params.weatherType || 'rain');
      }
      default:
        return true;
    }
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

    const intervalSeconds = rule.trigger.params.intervalSeconds || 1;
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
            this.executeGameActions(gameRule.actions, gameRule.id);
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
            this.executeActions(timer.partId, rule.actions, rule.id);
          }
        }

        timer.fired = true;
        timer.fireCount++;

        if (timer.repeat === 'once') {
          this.timers.delete(key);
        }

        // Check maxRepeats for repeat_every actions (handled at action level, not trigger level)
      }
    }
  }

  // ─── Wait Management ───

  private updateWaits(dt: number) {
    for (const [key, wait] of this.pendingWaits.entries()) {
      wait.remainingSeconds -= dt;
      if (wait.remainingSeconds <= 0) {
        this.pendingWaits.delete(key);
        // Continue executing from the next action after the wait
        const state = useStudioStore.getState();
        // v1.5: game-rule waits resume on the game action path.
        if (wait.gameRule) {
          const rule = (state.gameRules || []).find((r) => r.id === wait.ruleId);
          if (rule && rule.enabled) {
            const remainingActions = rule.actions.slice(wait.actionIndex + 1);
            this.executeGameActions(remainingActions, rule.id);
          }
          continue;
        }
        const obj = state.objects.get(wait.partId);
        if (obj && isPart(obj)) {
          const rule = (obj.rules || []).find((r) => r.id === wait.ruleId);
          if (rule && rule.enabled) {
            // Execute remaining actions after the wait
            const remainingActions = rule.actions.slice(wait.actionIndex + 1);
            this.executeActions(wait.partId, remainingActions, rule.id);
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

  fireGameTrigger(triggerType: TriggerType, eventData?: Record<string, any>): void {
    if (!this.isRunning) return;
    const state = useStudioStore.getState();
    for (const rule of state.gameRules || []) {
      if (!rule.enabled) continue;
      if (rule.trigger.type !== triggerType) continue;
      if (!this.checkGameTriggerConditions(rule, triggerType, eventData)) continue;
      this.executeGameActions(rule.actions, rule.id);
    }
  }

  private checkGameTriggerConditions(
    rule: WeildCodeRule,
    triggerType: TriggerType,
    eventData?: Record<string, any>,
  ): boolean {
    const params = rule.trigger.params || {};
    if (triggerType === 'on_player_join' || triggerType === 'on_player_leave') {
      const filter = String(params.username || '').trim().toLowerCase();
      if (filter && String(eventData?.username || '').toLowerCase() !== filter) return false;
    }
    if (triggerType === 'on_chat_message') {
      const user = String(params.username || '').trim().toLowerCase();
      if (user && String(eventData?.username || '').toLowerCase() !== user) return false;
      const contains = String(params.contains || '').trim().toLowerCase();
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
        this.pendingWaits.set(`game_${ruleId}_${i}`, {
          ruleId,
          partId: '',
          actionIndex: i,
          remainingSeconds: Number(action.params.seconds) || 1,
          gameRule: true,
        });
        return; // resume after the wait
      }
      this.executeGameAction(action, ruleId, depth);
    }
  }

  private executeGameAction(action: WeildCodeAction, ruleId: string, depth: number): void {
    switch (action.type) {
      case 'print_message': {
        const message = action.params.message || 'Hello, world!';
        useStudioStore.getState().addScreenMessage({
          message,
          position: (action.params.position || 'bottom') as 'top' | 'bottom',
          textColor: action.params.textColor || '#ffffff',
          fontStyle: (action.params.fontStyle || 'normal') as 'normal' | 'bold' | 'italic' | 'bold-italic',
          fontSize: Number(action.params.fontSize) || 24,
          backgroundColor: action.params.backgroundColor || '#000000',
          duration: Number(action.params.duration ?? 3),
        });
        useStudioStore.getState().addConsoleMessage('info', `[WeildCode] Print: "${message}" (game rule)`);
        break;
      }
      case 'play_sound': {
        const sound = action.params.sound || 'click';
        const volume = Math.max(0, Math.min(1, Number(action.params.volume ?? 0.5)));
        playCue(sound, volume);
        break;
      }
      case 'set_variable': {
        const varName = action.params.variableName || '';
        if (!varName) break;
        // v1.6: values can be numbers, plain text, a VARIABLE NAME reference,
        // or a math expression built with blocks (e.g. "score + 1").
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
        this.executeTeleportPlayer(action);
        break;
      }
      case 'modify_player_health': {
        this.executeModifyPlayerHealth(action);
        break;
      }
      case 'set_health': {
        const maxHp = useStudioStore.getState().playState.characterMaxHealth;
        const hp = Math.max(0, Math.min(maxHp, Number(action.params.health ?? 100)));
        useStudioStore.getState().setPlayState({ characterHealth: hp });
        useStudioStore.getState().addConsoleMessage('info', `[WeildCode] Player health set to ${hp}`);
        break;
      }
      case 'kill_player': {
        useStudioStore.getState().setPlayState({ characterHealth: 0 });
        useStudioStore.getState().addConsoleMessage('info', `[WeildCode] Player killed (game rule)`);
        break;
      }
      case 'heal_player': {
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
        const count = Math.max(1, Math.min(50, Number(action.params.count) || 3));
        if (action.children && action.children.length > 0) {
          for (let i = 0; i < count; i++) {
            this.executeGameActions(action.children, ruleId, depth + 1);
          }
        }
        break;
      }
      case 'repeat_every': {
        const intervalSeconds = Math.max(0.1, Number(action.params.intervalSeconds) || 2);
        const maxRepeats = Number(action.params.maxRepeats) || 0;
        if (action.children && action.children.length > 0) {
          this.executeGameActions(action.children, ruleId, depth + 1);
        }
        this.timers.set(`repeat_game_${action.id}`, {
          ruleId,
          partId: '',
          intervalSeconds,
          repeat: 'every',
          elapsed: 0,
          fired: true,
          maxRepeats,
          fireCount: 1,
        });
        break;
      }
      case 'tell_object': {
        const targetName = action.params.targetName || '';
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
        const seconds = action.params.seconds || 1;
        const waitKey = `${partId}_${ruleId}_${i}`;
        this.pendingWaits.set(waitKey, {
          ruleId,
          partId,
          actionIndex: i,
          remainingSeconds: seconds,
        });
        return; // Stop executing further actions; will resume after wait
      }

      this.executeAction(partId, action, ruleId, depth);
    }
  }

  private executeAction(partId: string, action: WeildCodeAction, ruleId: string, depth: number) {
    const state = useStudioStore.getState();
    const part = state.objects.get(partId);
    if (!part || !isPart(part)) return;

    switch (action.type) {
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
        useStudioStore.getState().updateObject(partId, { transparency: action.params.transparency ?? 0.5 });
        break;
      }
      case 'apply_force': {
        // Apply force via BodyMover (BodyForce)
        const force = action.params.force || { x: 0, y: 50, z: 0 };
        useStudioStore.getState().addBodyMover(partId, {
          id: `bm_wc_${Date.now()}`,
          type: 'BodyForce',
          enabled: true,
          force: { x: force.x, y: force.y, z: force.z },
        });
        break;
      }
      case 'apply_explosion': {
        const radius = action.params.radius || 8;
        const pressure = action.params.pressure || 500000;
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
        const volume = Math.max(0, Math.min(1, (action.params.volume as number) ?? 0.6));
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
        const radius = action.params.radius || 8;
        const pressure = action.params.pressure || 500000;
        useStudioStore.getState().createExplosion(
          { ...part.position },
          radius,
          pressure,
        );
        break;
      }
      case 'go_on_fire': {
        const color = action.params.color || '#ff6600';
        const size = action.params.size || 3;
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
        const brightness = action.params.brightness ?? 2;
        const range = action.params.range ?? 10;
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
        const size = action.params.size || 3;
        const opacity = action.params.opacity ?? 0.5;
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
        this.startEffectFade(partId, 'Fire', action.params.fadeDuration ?? 1);
        break;
      }
      case 'disable_light': {
        this.startEffectFade(partId, 'Light', action.params.fadeDuration ?? 1);
        break;
      }
      case 'clear_smoke': {
        this.startEffectFade(partId, 'Smoke', action.params.fadeDuration ?? 1);
        break;
      }
      case 'teleport_player_to_part': {
        this.executeTeleportPlayerToPart(partId, action);
        break;
      }
      case 'teleport_player': {
        this.executeTeleportPlayer(action);
        break;
      }
      case 'modify_player_health': {
        this.executeModifyPlayerHealth(action);
        break;
      }
      case 'kill_player': {
        useStudioStore.getState().setPlayState({ characterHealth: 0 });
        useStudioStore.getState().addConsoleMessage('info', `[WeildCode] Player killed`);
        break;
      }
      case 'heal_player': {
        const maxHp = useStudioStore.getState().playState.characterMaxHealth;
        useStudioStore.getState().setPlayState({ characterHealth: maxHp });
        useStudioStore.getState().addConsoleMessage('info', `[WeildCode] Player healed to full (${maxHp} HP)`);
        break;
      }
      case 'repeat': {
        const count = action.params.count || 3;
        const delayBetween = action.params.delayBetween || 0;
        if (action.children && action.children.length > 0) {
          for (let i = 0; i < count; i++) {
            if (delayBetween > 0 && i > 0) {
              // Simple delay approximation (not async - immediate for now)
              // In a full implementation, we'd schedule these
            }
            this.executeActions(partId, action.children, ruleId, depth + 1);
          }
        }
        break;
      }
      case 'repeat_every': {
        const intervalSeconds = action.params.intervalSeconds || 2;
        const maxRepeats = action.params.maxRepeats || 0;
        // Set up a timer-like recurring execution
        // For simplicity, we execute immediately and set up a timer for repeats
        if (action.children && action.children.length > 0) {
          this.executeActions(partId, action.children, ruleId, depth + 1);
        }
        // Set up recurring timer
        const timerKey = `repeat_${partId}_${action.id}`;
        this.timers.set(timerKey, {
          ruleId,
          partId,
          intervalSeconds,
          repeat: 'every',
          elapsed: 0,
          fired: true, // Already fired once
          maxRepeats,
          fireCount: 1,
        });
        break;
      }
      case 'tell_object': {
        const targetName = action.params.targetName || '';
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
        const message = action.params.message || 'Hello, world!';
        const position = action.params.position || 'bottom';
        const textColor = action.params.textColor || '#ffffff';
        const fontStyle = action.params.fontStyle || 'normal';
        const fontSize = action.params.fontSize || 24;
        const backgroundColor = action.params.backgroundColor || '#000000';
        const duration = action.params.duration ?? 3;
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
        const rawText = action.params.text || 'Hello';
        const text = rawText.substring(0, 12); // max 12 chars
        const color = action.params.color || '#ffffff';
        const fontSize = action.params.fontSize || 16;
        const duration = action.params.duration ?? 5;
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
        // math expressions are all valid values now.
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
        const common = {
          id: `mover_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          type: moverType,
          enabled: action.params.enabled !== false,
        };
        let mover: any;
        switch (moverType) {
          case 'BodyVelocity':
            mover = { ...common, velocity: { x: action.params.x || 0, y: action.params.y || 0, z: action.params.z || 0 }, maxForce: { x: 10000, y: 10000, z: 10000 } };
            break;
          case 'BodyGyro':
            mover = { ...common, cframe: { x: action.params.x || 0, y: action.params.y || 0, z: action.params.z || 0 }, maxTorque: { x: 10000, y: 10000, z: 10000 } };
            break;
          case 'BodyPosition':
            mover = { ...common, position: { x: action.params.x || 0, y: action.params.y || 0, z: action.params.z || 0 }, maxForce: { x: 10000, y: 10000, z: 10000 } };
            break;
          case 'BodyThrust':
            mover = { ...common, force: { x: action.params.x || 0, y: action.params.y || 0, z: action.params.z || 0 }, location: { x: 0, y: 0, z: 0 } };
            break;
          case 'BodyAngularVelocity':
            mover = { ...common, angularVelocity: { x: action.params.x || 0, y: action.params.y || 0, z: action.params.z || 0 }, maxTorque: { x: 10000, y: 10000, z: 10000 } };
            break;
          default: // BodyForce
            mover = { ...common, type: 'BodyForce', force: { x: action.params.x || 0, y: action.params.y || 0, z: action.params.z || 0 } };
            break;
        }
        const existing = part.bodyMovers || [];
        useStudioStore.getState().updateObject(partId, { bodyMovers: [...existing, mover] } as any);
        useStudioStore.getState().addConsoleMessage('info', `[WeildCode] Added ${moverType} to "${part.name}"`);
        break;
      }
      case 'remove_body_mover': {
        if (!part.bodyMovers || part.bodyMovers.length === 0) break;
        useStudioStore.getState().updateObject(partId, { bodyMovers: [] } as any);
        useStudioStore.getState().addConsoleMessage('info', `[WeildCode] Removed all body movers from "${part.name}"`);
        break;
      }
      case 'set_health': {
        const maxHp = useStudioStore.getState().playState.characterMaxHealth;
        const hp = Math.max(0, Math.min(maxHp, Number(action.params.health ?? 100)));
        useStudioStore.getState().setPlayState({ characterHealth: hp });
        useStudioStore.getState().addConsoleMessage('info', `[WeildCode] Player health set to ${hp}`);
        break;
      }
    }
  }

  // ─── Specific Action Implementations ───

  private executeCreatePart(sourcePartId: string, action: WeildCodeAction) {
    const state = useStudioStore.getState();
    const partType = (action.params.partType || 'Block') as PartType;
    const partName = action.params.partName || 'NewPart';
    const position = action.params.position || { x: 0, y: 1, z: 0 };
    const color = action.params.color || '#4ff7f5';

    // If source part exists, offset relative to it
    const sourcePart = state.objects.get(sourcePartId);
    const finalPos = sourcePart && isPart(sourcePart)
      ? {
          x: sourcePart.position.x + (position.x || 0),
          y: sourcePart.position.y + (position.y || 0),
          z: sourcePart.position.z + (position.z || 0),
        }
      : position;

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
    const position = action.params.position || { x: 0, y: 1, z: 0 };

    const state = useStudioStore.getState();
    const part = state.objects.get(partId);
    if (!part || !isPart(part)) return;

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
    const rotation = action.params.rotation || { x: 0, y: 90, z: 0 };

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
    const size = action.params.size || { x: 1, y: 1, z: 1 };

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
    const targetName = action.params.targetName || '';
    const face = action.params.face || 'top';
    const offset = action.params.offset || { x: 0, y: 0, z: 0 };

    if (!targetName) {
      useStudioStore.getState().addConsoleMessage('warn', `[WeildCode] teleport_player_to_part: no target name specified`);
      return;
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
      return;
    }

    // After the null check, TypeScript still narrows targetPart to `never`
    // because the assignment happened inside a closure. Re-assign to a
    // non-null typed local to help the compiler.
    const tp: StudioPart = targetPart;

    // Compute the teleport position based on the chosen face.
    // The player is placed just outside the face so they don't get stuck inside the part.
    const px = tp.position.x;
    const py = tp.position.y;
    const pz = tp.position.z;
    const sx = tp.size.x;
    const sy = tp.size.y;
    const sz = tp.size.z;
    // Player offset from the face surface (so they stand ON the face, not embedded in it)
    const PLAYER_HALF_HEIGHT = 1.0; // approx half the character height

    let teleportPos: { x: number; y: number; z: number };
    switch (face) {
      case 'top':
        teleportPos = { x: px, y: py + sy / 2 + PLAYER_HALF_HEIGHT, z: pz };
        break;
      case 'bottom':
        teleportPos = { x: px, y: py - sy / 2 - PLAYER_HALF_HEIGHT, z: pz };
        break;
      case 'left': // -X
        teleportPos = { x: px - sx / 2 - 0.5, y: py, z: pz };
        break;
      case 'right': // +X
        teleportPos = { x: px + sx / 2 + 0.5, y: py, z: pz };
        break;
      case 'front': // -Z
        teleportPos = { x: px, y: py, z: pz - sz / 2 - 0.5 };
        break;
      case 'back': // +Z
        teleportPos = { x: px, y: py, z: pz + sz / 2 + 0.5 };
        break;
      case 'center':
      default:
        teleportPos = { x: px, y: py, z: pz };
        break;
    }

    // Apply user-specified offset
    teleportPos.x += offset.x || 0;
    teleportPos.y += offset.y || 0;
    teleportPos.z += offset.z || 0;

    useStudioStore.getState().setPlayState({ teleportPosition: teleportPos });
    useStudioStore.getState().addConsoleMessage('info', `[WeildCode] Teleported player to ${targetName} (${face})`);
  }

  // ─── Teleport Player ───
  // Teleport the player to an xyz position. Each axis has a "relative" flag -
  // when true, the value is ADDED to the current position; when false, it REPLACES it.
  private executeTeleportPlayer(action: WeildCodeAction) {
    const pos = action.params.position || { x: 0, y: 5, z: 0 };
    const relativeX = !!(pos.relativeX);
    const relativeY = !!(pos.relativeY);
    const relativeZ = !!(pos.relativeZ);

    const currentPos = useStudioStore.getState().playState.characterPosition;
    const newPos = {
      x: relativeX ? currentPos.x + (pos.x || 0) : (pos.x || 0),
      y: relativeY ? currentPos.y + (pos.y || 0) : (pos.y || 0),
      z: relativeZ ? currentPos.z + (pos.z || 0) : (pos.z || 0),
    };

    useStudioStore.getState().setPlayState({ teleportPosition: newPos });
    useStudioStore.getState().addConsoleMessage('info', `[WeildCode] Teleported player to (${newPos.x.toFixed(1)}, ${newPos.y.toFixed(1)}, ${newPos.z.toFixed(1)})`);
  }

  // ─── Modify Player Health ───
  // Modify the player's health. When "relative" is true, the value is added to
  // the current health; when false, it replaces it. Clamped to [0, maxHealth].
  private executeModifyPlayerHealth(action: WeildCodeAction) {
    const healthDelta = action.params.health ?? 0;
    const relative = action.params.relative !== false; // default true

    const state = useStudioStore.getState();
    const currentHp = state.playState.characterHealth;
    const maxHp = state.playState.characterMaxHealth;
    const newHp = relative
      ? Math.max(0, Math.min(maxHp, currentHp + healthDelta))
      : Math.max(0, Math.min(maxHp, healthDelta));

    state.setPlayState({ characterHealth: newHp });
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
    const targetName = action.params.targetName || '';
    const copyName = action.params.copyName || '';
    const count = Math.min(action.params.count || 1, 20); // cap at 20 copies
    const offset = action.params.offset || { x: 2, y: 0, z: 0 };

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
   */
  private resolveVariableValue(partId: string, rawValue: unknown): number | string {
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

  // ─── Variable Trigger Polling ───

  private updateVariableTriggers(dt: number, state: ReturnType<typeof useStudioStore.getState>) {
    const currentVars = state.globalVariables;

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

    // ── Per-object variable change detection (new) ──
    // Build a map: partId -> set of changed var names
    const changedObjectVars = new Map<string, Set<string>>();
    state.objects.forEach((obj) => {
      if (!isPart(obj)) return;
      const current = obj.objectVariables || {};
      const prev = this.objectVariableSnapshots.get(obj.id) || new Map<string, number | string>();
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
        changedObjectVars.set(obj.id, changed);
        // Update snapshot to current
        const snap = new Map<string, number | string>();
        for (const [name, value] of Object.entries(current)) {
          snap.set(name, value);
        }
        this.objectVariableSnapshots.set(obj.id, snap);
      }
    });

    // ── Fire when_variable_changes ──
    // Global scope
    if (changedVars.size > 0) {
      state.objects.forEach((obj) => {
        if (!isPart(obj)) return;
        const rules = obj.rules || [];
        for (const rule of rules) {
          if (!rule.enabled || rule.trigger.type !== 'when_variable_changes') continue;
          const scope = rule.trigger.params.scope || 'global';
          if (scope !== 'global') continue; // handled below
          const varName = rule.trigger.params.variableName || '';
          if (changedVars.has(varName)) {
            this.executeActions(obj.id, rule.actions, rule.id);
          }
        }
      });
    }
    // Object scope - only fire on the part that owns the variable
    if (changedObjectVars.size > 0) {
      changedObjectVars.forEach((changedSet, partId) => {
        const obj = state.objects.get(partId);
        if (!obj || !isPart(obj)) return;
        const rules = obj.rules || [];
        for (const rule of rules) {
          if (!rule.enabled || rule.trigger.type !== 'when_variable_changes') continue;
          const scope = rule.trigger.params.scope || 'global';
          if (scope !== 'object') continue;
          const varName = rule.trigger.params.variableName || '';
          if (changedSet.has(varName)) {
            this.executeActions(obj.id, rule.actions, rule.id);
          }
        }
      });
    }

    // ── Poll when_variable_equals ──
    state.objects.forEach((obj) => {
      if (!isPart(obj)) return;
      const rules = obj.rules || [];
      for (const rule of rules) {
        if (!rule.enabled || rule.trigger.type !== 'when_variable_equals') continue;
        const varName = rule.trigger.params.variableName || '';
        const targetValue = rule.trigger.params.value ?? '';
        const checkInterval = rule.trigger.params.checkInterval ?? 0.5;
        const scope = rule.trigger.params.scope || 'global';

        const key = `${obj.id}_${rule.id}`;
        let acc = this.variableCheckAccumulators.get(key) || 0;
        acc += dt;
        if (acc >= checkInterval) {
          acc = 0;
          const currentValue = scope === 'object'
            ? obj.objectVariables?.[varName]
            : currentVars[varName];
          if (currentValue !== undefined && String(currentValue) === String(targetValue)) {
            this.executeActions(obj.id, rule.actions, rule.id);
          }
        }
        this.variableCheckAccumulators.set(key, acc);
      }
    });
  }

  // ─── Condition Trigger Polling ───

  private updateConditionTriggers(dt: number, state: ReturnType<typeof useStudioStore.getState>) {
    state.objects.forEach((obj) => {
      if (!isPart(obj)) return;
      const rules = obj.rules || [];
      for (const rule of rules) {
        if (!rule.enabled) continue;

        // when_coinflip
        if (rule.trigger.type === 'when_coinflip') {
          const key = `${obj.id}_${rule.id}`;
          const chancePercent = rule.trigger.params.chancePercent ?? 50;
          const repeat = rule.trigger.params.repeat || 'every';

          if (repeat === 'once' && this.coinFlipFired.has(key)) continue;

          let acc = this.conditionCheckAccumulators.get(key) || 0;
          acc += dt;
          if (acc >= 1.0) { // check every second
            acc = 0;
            const roll = Math.random() * 100;
            if (roll < chancePercent) {
              this.executeActions(obj.id, rule.actions, rule.id);
              if (repeat === 'once') {
                this.coinFlipFired.add(key);
              }
            }
          }
          this.conditionCheckAccumulators.set(key, acc);
        }

        // when_condition
        if (rule.trigger.type === 'when_condition') {
          const key = `${obj.id}_${rule.id}`;
          const condition = rule.trigger.params.condition || 'anchored';
          const checkInterval = rule.trigger.params.checkInterval ?? 0.5;

          let acc = this.conditionCheckAccumulators.get(key) || 0;
          acc += dt;
          if (acc >= checkInterval) {
            acc = 0;
            const part = state.objects.get(obj.id);
            if (part && isPart(part) && this.evaluateCondition(part, condition, rule.trigger.params, state)) {
              this.executeActions(obj.id, rule.actions, rule.id);
            }
          }
          this.conditionCheckAccumulators.set(key, acc);
        }
      }
    });
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

  handleClick(partId: string) {
    this.fireTrigger(partId, 'when_clicked');
  }

  handleTouch(partId: string, touchType: 'player' | 'parts' | 'any' = 'any') {
    this.fireTrigger(partId, 'when_touched', { touchType });
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

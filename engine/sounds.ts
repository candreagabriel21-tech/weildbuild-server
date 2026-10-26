'use client';

/**
 * Sound Effects Manager for WeildBuild
 *
 * Provides a simple API to play sound effects throughout the app.
 * Uses the Web Audio API to load and play MP3/WAV files from /public/sounds/.
 * Falls back to synthesized beeps if files aren't loaded yet.
 *
 * v1.1 ISOMORPHIC: this module is also imported by the server's
 * server-authoritative game runtime (the WeildCode engine calls playCue/
 * playSound for its sound actions). In Node there is no Web Audio - every
 * entry point becomes a no-op there, and an optional SINK receives the cue
 * instead so the gamehost can relay it to every player's browser (where the
 * sound actually plays). No browser API is touched unless window exists.
 */

// Cache loaded audio buffers
const audioBufferCache = new Map<string, AudioBuffer>();
let sharedContext: AudioContext | null = null;
let masterGain: GainNode | null = null;

// ─── v1.1: sound sink (server-authoritative relay) ───
// When set, playSound/playCue hand the cue to the sink INSTEAD of local
// playback. The gamehost worker sets this to forward sound actions to the
// players' browsers; on the normal client it stays null.
export type SoundSink = (name: string, volume: number) => void;
let soundSink: SoundSink | null = null;

/** Route every sound cue to `sink` instead of local playback (or null). */
export function setSoundSink(sink: SoundSink | null): void {
  soundSink = sink;
}

/** True when there is no Web Audio (Node worker) - callers become no-ops. */
const isHeadless = (): boolean => typeof window === 'undefined';

/**
 * v1.9.3 FIX (Volume setting): read the persisted master volume from
 * localStorage (the same key applyVisualSettings writes: "wb-volume").
 * Before, the AudioContext was ALWAYS created with a hard coded 0.5
 * gain, so the Settings slider only held until the next reload (and
 * never applied outside a running game). Now the stored value is the
 * one true source: it seeds the context at creation and is re applied
 * on every settings change.
 */
function readStoredVolumePercent(): number {
  try {
    const v = Number(localStorage.getItem("wb-volume"));
    if (Number.isFinite(v)) return Math.max(0, Math.min(100, v));
  } catch {}
  // v1.9.4 (user request): volume starts at 100%, not 80%.
  return 100;
}

function getAudioContext(): { ctx: AudioContext; gain: GainNode } {
  if (isHeadless()) {
    // Node (gamehost worker): no audio hardware. Callers guard on this, but
    // keep a hard throw so a missed guard can never silently pretend to play.
    throw new Error('getAudioContext() called in a headless (Node) environment');
  }
  if (!sharedContext || sharedContext.state === 'closed') {
    sharedContext = new AudioContext();
    masterGain = sharedContext.createGain();
    masterGain.connect(sharedContext.destination);
    // v1.9.3: start from the PERSISTED volume, not a hard coded 50%.
    masterGain.gain.value = readStoredVolumePercent() / 100;
  }
  if (sharedContext.state === 'suspended') {
    sharedContext.resume();
  }
  return { ctx: sharedContext, gain: masterGain! };
}

async function loadSound(name: string): Promise<AudioBuffer | null> {
  if (audioBufferCache.has(name)) return audioBufferCache.get(name)!;

  const paths: Record<string, string> = {
    jump: '/sounds/effects/jump.mp3',
    walk: '/sounds/effects/walk.mp3',
    death: '/sounds/effects/death.mp3',
    // v13.7: the character scream - plays with the death animation when the
    // player dies (health hits 0 or falling into the void).
    scream: '/sounds/effects/scream.mp3',
    explosion: '/sounds/effects/explosion.mp3',
    scary_laugh: '/sounds/effects/scary_laugh.mp3',
    used_tool: '/sounds/effects/used_tool.wav',
  };

  const path = paths[name];
  if (!path) return null;

  try {
    const { ctx } = getAudioContext();
    const response = await fetch(path);
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
    audioBufferCache.set(name, audioBuffer);
    return audioBuffer;
  } catch (e) {
    console.warn(`[Sounds] Failed to load ${name}:`, e);
    return null;
  }
}

/**
 * Play a sound effect by name.
 * @param name - Sound effect name (jump, walk, death, explosion, scary_laugh, used_tool)
 * @param volume - Volume 0-1 (default 0.5)
 */
export async function playSound(name: string, volume: number = 0.5): Promise<void> {
  // v1.1: headless server runtime - hand the cue to the sink (gamehost
  // relays it to the players) and never touch Web Audio.
  if (isHeadless()) {
    if (soundSink) soundSink(name, volume);
    return;
  }
  try {
    const { ctx, gain } = getAudioContext();

    // Try to play the real sound file
    const buffer = await loadSound(name);
    if (buffer) {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const soundGain = ctx.createGain();
      soundGain.gain.value = volume;
      source.connect(soundGain);
      soundGain.connect(gain);
      source.start(0);
      return;
    }

    // Fallback: synthesized beep
    const osc = ctx.createOscillator();
    const oscGain = ctx.createGain();
    oscGain.gain.value = volume * 0.1;
    oscGain.connect(gain);
    osc.connect(oscGain);
    const freqs: Record<string, number> = {
      jump: 440,
      walk: 220,
      death: 110,
      scream: 160,
      explosion: 80,
      scary_laugh: 330,
      used_tool: 520,
    };
    osc.frequency.value = freqs[name] || 440;
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
  } catch {}
}

/**
 * Set the master volume (0-100)
 */
export function setMasterVolume(percent: number): void {
  if (isHeadless()) return;
  const { gain } = getAudioContext();
  gain.gain.value = Math.max(0, Math.min(1, percent / 100));
}

/**
 * v13.4: play a short synthesized UI/game cue by name. These are the sounds
 * the WeildCode "Play sound" action uses (click / pop / boom / whoosh /
 * chime / alert). Each has a distinct waveform + envelope so they actually
 * sound different - previously the action only printed to the console.
 */
export function playCue(name: string, volume: number = 0.5): void {
  // v1.1: headless server runtime - hand the cue to the sink (gamehost
  // relays it to the players) and never touch Web Audio.
  if (isHeadless()) {
    if (soundSink) soundSink(name, volume);
    return;
  }
  try {
    const { ctx, gain } = getAudioContext();
    const now = ctx.currentTime;
    const g = ctx.createGain();
    g.connect(gain);

    const osc = ctx.createOscillator();
    osc.connect(g);

    // Envelope helper: quick attack, exponential release
    const env = (peak: number, hold: number, release: number) => {
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.001), now + 0.01);
      g.gain.setValueAtTime(Math.max(peak, 0.001), now + 0.01 + hold);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.01 + hold + release);
    };

    const v = Math.max(0.02, Math.min(1, volume));

    switch (name) {
      case 'click':
        osc.type = 'square';
        osc.frequency.value = 800;
        env(v * 0.35, 0.02, 0.05);
        osc.start(now);
        osc.stop(now + 0.1);
        break;
      case 'pop':
        osc.type = 'sine';
        osc.frequency.setValueAtTime(400, now);
        osc.frequency.exponentialRampToValueAtTime(900, now + 0.1);
        env(v * 0.5, 0.02, 0.1);
        osc.start(now);
        osc.stop(now + 0.16);
        break;
      case 'boom':
        osc.type = 'square';
        osc.frequency.setValueAtTime(110, now);
        osc.frequency.exponentialRampToValueAtTime(35, now + 0.45);
        env(v * 0.9, 0.05, 0.45);
        osc.start(now);
        osc.stop(now + 0.55);
        break;
      case 'whoosh':
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(180, now);
        osc.frequency.exponentialRampToValueAtTime(1400, now + 0.18);
        osc.frequency.exponentialRampToValueAtTime(240, now + 0.36);
        env(v * 0.4, 0.05, 0.32);
        osc.start(now);
        osc.stop(now + 0.45);
        break;
      case 'chime': {
        // Two-note bell (root + fifth)
        const g2 = ctx.createGain();
        g2.connect(gain);
        const osc2 = ctx.createOscillator();
        osc2.connect(g2);
        osc.type = 'sine'; osc2.type = 'sine';
        osc.frequency.value = 880; osc2.frequency.value = 1318.5;
        for (const [node, peak] of [[g, v * 0.5], [g2, v * 0.3]] as [GainNode, number][]) {
          node.gain.setValueAtTime(0.0001, now);
          node.gain.exponentialRampToValueAtTime(Math.max(peak, 0.001), now + 0.01);
          node.gain.exponentialRampToValueAtTime(0.0001, now + 0.6);
        }
        osc.start(now); osc2.start(now);
        osc.stop(now + 0.65); osc2.stop(now + 0.65);
        break;
      }
      case 'alert': {
        // Three quick beeps
        const beepAt = (t: number) => {
          const bg = ctx.createGain();
          bg.connect(gain);
          const bo = ctx.createOscillator();
          bo.type = 'square';
          bo.frequency.value = 660;
          bo.connect(bg);
          bg.gain.setValueAtTime(0.0001, t);
          bg.gain.exponentialRampToValueAtTime(v * 0.4, t + 0.01);
          bg.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
          bo.start(t);
          bo.stop(t + 0.12);
        };
        beepAt(now); beepAt(now + 0.15); beepAt(now + 0.3);
        break;
      }
      default: {
        // Unknown cue name: generic short blip so SOMETHING is heard
        osc.type = 'triangle';
        osc.frequency.value = 520;
        env(v * 0.4, 0.02, 0.08);
        osc.start(now);
        osc.stop(now + 0.14);
        break;
      }
    }
  } catch { /* audio may be unavailable - never throw from a game action */ }
}

/**
 * Preload all sound effects so they play instantly when needed.
 */
export async function preloadSounds(): Promise<void> {
  const names = ['jump', 'walk', 'death', 'scream', 'explosion', 'scary_laugh', 'used_tool'];
  await Promise.allSettled(names.map(loadSound));
}

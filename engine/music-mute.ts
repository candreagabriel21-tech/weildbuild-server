// ════════════════════════════════════════════════════════════════════
// WeildBuild - shared background-music mute toggle (pass 13, UI request)
// ════════════════════════════════════════════════════════════════════
// The owner asked for a "music toggle" button next to the in-game menu. The
// music <audio> element lives inside BuildToSurviveMusic / TowerSwordFightMusic
// (mounted by StudioPlayViewport), but the menu + button live in GamePlayer -
// different components, no shared parent. This tiny module is the bridge: a
// single boolean + a subscribe API, so the GamePlayer button flips it and the
// music component mutes/unmutes its <audio> in response. Persisted to
// localStorage so the choice survives reloads (same device-local spirit as the
// visual settings).

const KEY = 'wb-music-muted';
let muted = false;
try {
  if (typeof window !== 'undefined') muted = localStorage.getItem(KEY) === '1';
} catch { /* storage blocked */ }

type Listener = (muted: boolean) => void;
const listeners = new Set<Listener>();

export function isMusicMuted(): boolean {
  return muted;
}

export function setMusicMuted(v: boolean): void {
  if (v === muted) return;
  muted = v;
  try {
    if (typeof window !== 'undefined') localStorage.setItem(KEY, v ? '1' : '0');
  } catch { /* storage blocked */ }
  for (const l of listeners) {
    try { l(muted); } catch { /* never break the fan-out */ }
  }
}

export function toggleMusicMuted(): boolean {
  setMusicMuted(!muted);
  return muted;
}

export function onMusicMuteChange(cb: Listener): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

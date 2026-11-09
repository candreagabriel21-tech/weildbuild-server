'use client';

// ═══════════════════════════════════════════════════════════════════
// WeildBuild, device-level editor settings (pass 26)
// ═══════════════════════════════════════════════════════════════════
// Device-level editor knobs (pass 26 + pass 26.1):
//
//   • Auto-Save Interval — how many minutes between Auto-Saves (0 = off).
//   • Dupe Offset — how far (studs) a duplicated or pasted object lands
//     from its original. It was hardcoded (+2 x for dupe, +3 x for paste)
//     before; both paths read this single setting now.
//   • Snap Unit — the snap step in studs, ALSO saved per device now
//     (pass 26.1 user request: "the snap unit value should also be
//     saved"). 0 = no snapping.
//
// These tune how THIS device's editor feels, so they live in localStorage
// (like the graphics settings), NOT in worldSettings — a world file never
// carries them, and loading someone else's world doesn't change your editor.

const STORAGE_KEY = 'wb-editor-settings-v1';

export const EDITOR_SETTINGS_CHANGED = 'wb-editor-settings-changed';

export interface EditorSettings {
  /** Minutes between Auto-Saves. 0 disables auto-saving. 0.5–60. */
  autoSaveIntervalMin: number;
  /** Studs a duplicate/paste is offset from its original (x axis). 0–50. */
  dupeOffset: number;
  /** The snap step in studs. 0 = no snapping. 0–100. */
  snapUnit: number;
}

const DEFAULTS: EditorSettings = {
  autoSaveIntervalMin: 5,
  dupeOffset: 2,
  snapUnit: 1,
};

function clampSettings(s: Partial<EditorSettings>): EditorSettings {
  const interval = Number(s.autoSaveIntervalMin);
  const dupe = Number(s.dupeOffset);
  const snap = Number(s.snapUnit);
  return {
    autoSaveIntervalMin: Number.isFinite(interval)
      ? Math.min(60, Math.max(0, interval))
      : DEFAULTS.autoSaveIntervalMin,
    dupeOffset: Number.isFinite(dupe)
      ? Math.min(50, Math.max(0, dupe))
      : DEFAULTS.dupeOffset,
    snapUnit: Number.isFinite(snap)
      ? Math.min(100, Math.max(0, snap))
      : DEFAULTS.snapUnit,
  };
}

export function loadEditorSettings(): EditorSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    return clampSettings({ ...DEFAULTS, ...JSON.parse(raw) });
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveEditorSettings(patch: Partial<EditorSettings>): EditorSettings {
  const next = clampSettings({ ...loadEditorSettings(), ...patch });
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* private mode - settings still work for this session */
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(EDITOR_SETTINGS_CHANGED, { detail: next }));
  }
  return next;
}

/** Live read for non-React code paths (duplicate/paste offsets). */
export function getDupeOffset(): number {
  return loadEditorSettings().dupeOffset;
}

/** Live read for the auto-save timer. */
export function getAutoSaveIntervalMs(): number {
  return loadEditorSettings().autoSaveIntervalMin * 60_000;
}

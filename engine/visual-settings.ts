// ═══════════════════════════════════════════════════════════
// WeildBuild — local (device) visual settings (v13.3)
// ═══════════════════════════════════════════════════════════
// Visual settings (dark mode, animations, reduce motion, sidebar
// position, UI scale, volume) are DEVICE preferences — your PC
// being in dark mode shouldn't force your phone into dark mode.
// Until v13.3 every toggle of these also fired a server call
// (PUT /users), which was pure waste. They are now stored in
// localStorage on this device only and applied instantly:
//   • zero server calls
//   • works instantly, even offline
// One-time migration: if nothing is stored locally yet, the
// values from the user's server profile are used as the seed
// (so an existing user's current theme carries over).

export interface VisualSettings {
  dark_mode: boolean;
  animations: boolean;
  reduce_motion: boolean;
  sidebar_position: string;
  ui_scale: number;
  volume: number;
  /** 1.0: on-screen control style on touch devices - analog joystick or d-pad. */
  mobile_controls: "joystick" | "dpad";
  /** 1.0.1: should the on-screen controls be ON when you join a game?
   *  auto = on for touch devices, off for keyboard/mouse (default)
   *  on   = always start with them on
   *  off  = always start with them off */
  mobile_controls_default: "auto" | "on" | "off";
}

// v1.9.3: applying the volume needs the shared audio context (sounds.ts).
import { setMasterVolume } from "./sounds";

const KEY = "wb-visual-settings";
export const VISUAL_SETTINGS_CHANGED = "wb:visual-settings-changed";

export const DEFAULT_VISUAL_SETTINGS: VisualSettings = {
  dark_mode: true,
  animations: true,
  reduce_motion: false,
  sidebar_position: "right",
  ui_scale: 1,
  // v1.9.4 (user request): volume starts at 100%, not 80%.
  volume: 100,
  mobile_controls: "joystick",
  mobile_controls_default: "auto",
};

/** 1.0: read just the mobile control style (used by the game HUD every frame-free render). */
export function loadMobileControlStyle(): "joystick" | "dpad" {
  const s = loadVisualSettings();
  return s.mobile_controls === "dpad" ? "dpad" : "joystick";
}

/** 1.0.1: should the on-screen controls start ON for a game session?
 *  Resolves the auto/on/off setting against whether this device has a
 *  touch screen. Used by GamePlayer when a game starts. */
export function mobileControlsStartEnabled(): boolean {
  const s = loadVisualSettings();
  const mode = s.mobile_controls_default || "auto";
  if (mode === "on") return true;
  if (mode === "off") return false;
  // auto: on for touch devices only
  try {
    return typeof window !== "undefined" && ("ontouchstart" in window || (navigator.maxTouchPoints || 0) > 0);
  } catch {
    return false;
  }
}

/** Read this device's visual settings. `serverSeed` (from the
 *  logged-in user profile) is used only on the very first read. */
export function loadVisualSettings(serverSeed?: Partial<VisualSettings> | null): VisualSettings {
  if (typeof window === "undefined") return { ...DEFAULT_VISUAL_SETTINGS, ...(serverSeed || {}) };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return { ...DEFAULT_VISUAL_SETTINGS, ...parsed };
    }
    // First read on this device → seed from the server profile
    const seeded = { ...DEFAULT_VISUAL_SETTINGS, ...(serverSeed || {}) };
    localStorage.setItem(KEY, JSON.stringify(seeded));
    return seeded;
  } catch {
    return { ...DEFAULT_VISUAL_SETTINGS, ...(serverSeed || {}) };
  }
}

/** Save + apply. Dispatches an event the app root listens for. */
export function saveVisualSettings(settings: Partial<VisualSettings>): VisualSettings {
  const next = { ...loadVisualSettings(), ...settings };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage full/blocked — settings still apply for this session */
  }
  window.dispatchEvent(new CustomEvent(VISUAL_SETTINGS_CHANGED, { detail: next }));
  return next;
}

/** Apply the theme/animation attributes to <html>. */
export function applyVisualSettings(s: VisualSettings): void {
  if (typeof document === "undefined") return;
  if (s.dark_mode) {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", "light");
  }
  if (!s.animations || s.reduce_motion) {
    document.documentElement.setAttribute("data-animations", "false");
  } else {
    document.documentElement.removeAttribute("data-animations");
  }
  document.documentElement.style.setProperty("--ui-scale", String(s.ui_scale ?? 1));
  try {
    // remember volume for the sound system (same key the old slider used)
    localStorage.setItem("wb-volume", String(s.volume ?? 100));
  } catch {}
  // v1.9.3 FIX (Volume setting): apply the volume to the shared audio
  // context RIGHT HERE, not only inside games. This runs on app mount
  // and on every settings change (the event listener in page.tsx), so
  // the slider now really holds everywhere: menu, studio and games.
  setMasterVolume(s.volume ?? 100);
}

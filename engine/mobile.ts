// ═══════════════════════════════════════════════════════════════════
// mobile.ts (1.0.3) - tiny SSR-safe helpers for detecting touch /
// small-screen devices. Used by the 3D viewports to dial back the
// expensive renderer settings (DPR cap, smaller shadow maps) that turn
// phones into slideshows.
// ═══════════════════════════════════════════════════════════════════

/**
 * True on touch-primary devices (phones, tablets without mouse).
 * Coarse pointer is the reliable signal in the Android WebView; the
 * ontouchstart / maxTouchPoints checks catch the stragglers.
 * Deliberately NOT "isMobile" - a touch laptop with a fine pointer
 * stays a desktop and keeps full quality.
 */
export function isTouchDevice(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    if (window.matchMedia('(pointer: coarse)').matches) return true;
  } catch {
    /* matchMedia unavailable - fall through */
  }
  return 'ontouchstart' in window || (navigator.maxTouchPoints || 0) > 0;
}

/**
 * Max device pixel ratio for the big game canvases.
 * Desktop keeps 2 (crisp), touch devices get 1.5 - on a typical phone
 * (DPR ~3) that is a ~2.5x cut in pixels shaded per frame, which is
 * the single biggest frame-time win for the mobile build. Below 1.5
 * the world starts to look visibly soft, so we don't go lower.
 */
export function maxCanvasDpr(): number {
  return isTouchDevice() ? 1.5 : 2;
}

/**
 * Shadow map resolution for the main sun light.
 * 2048 on desktop, 1024 on touch - the shadow buffer re-renders the
 * whole scene every frame it moves, and 4M texels of it is a lot to
 * ask of a phone GPU. 1024 still reads as "has shadows" at 1.5 DPR.
 */
export function shadowMapSize(): number {
  return isTouchDevice() ? 1024 : 2048;
}

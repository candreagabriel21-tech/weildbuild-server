// ─── FPS status tiers (studio performance HUD) ───
// The studio's live FPS counter reads "(fps) FPS - (status)" — e.g.
// "72 FPS - Perfect" — and its hover tooltip is just the status word.
// The scale (user-specified in Round 10):
//   70+      Perfect
//   60-69    Awesome
//   50-59    Good
//   40-49    Acceptable
//   30-39    Low
//   20-29    Bad
//   10-19    Choppy
//   1-9      Nearly frozen
//   0        Frozen
export interface FpsTier {
  /** Minimum FPS (inclusive) that falls into this tier. */
  min: number;
  /** The status word shown after the number ("Perfect", "Low", ...). */
  label: string;
  /** Tailwind text color class for the counter. */
  color: string;
  /** Tailwind background color class for the status dot. */
  dot: string;
}

// Highest first — fpsTier() picks the first tier whose min fits.
export const FPS_TIERS: readonly FpsTier[] = [
  { min: 70, label: 'Perfect', color: 'text-emerald-400', dot: 'bg-emerald-400' },
  { min: 60, label: 'Awesome', color: 'text-emerald-400', dot: 'bg-emerald-400' },
  { min: 50, label: 'Good', color: 'text-emerald-400', dot: 'bg-emerald-400' },
  { min: 40, label: 'Acceptable', color: 'text-lime-400', dot: 'bg-lime-400' },
  { min: 30, label: 'Low', color: 'text-amber-400', dot: 'bg-amber-400' },
  { min: 20, label: 'Bad', color: 'text-orange-400', dot: 'bg-orange-400' },
  { min: 10, label: 'Choppy', color: 'text-red-400', dot: 'bg-red-400' },
  { min: 1, label: 'Nearly frozen', color: 'text-red-400', dot: 'bg-red-400' },
  { min: 0, label: 'Frozen', color: 'text-red-400', dot: 'bg-red-400' },
];

/** The tier a given FPS reading belongs to (first min that fits wins). */
export function fpsTier(fps: number): FpsTier {
  return FPS_TIERS.find((t) => fps >= t.min) ?? FPS_TIERS[FPS_TIERS.length - 1];
}

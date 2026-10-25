// ═══════════════════════════════════════════════════════════
// WeildBuild — official item colors (single server-side copy)
// ═══════════════════════════════════════════════════════════
// Used by prisma/seed.ts (initial seed) AND src/db/ensure.ts
// (boot-time official-item re-sync) so the DB color column is
// always written from ONE map.
//
// The rendering source of truth lives in the CLIENT repo (the
// 3D/avatar code picks colors locally). Keep the client maps in
// sync with this one:
//   game: src/components/app/shared.ts
//   game: src/components/shared/WeildBuildCharacter.tsx
//   game: src/components/studio/CharacterPartsRenderer.tsx
//
// Round 11 changes:
//   SHIRT-2 (Flame)   #FF4500 -> #FF9B0F  (user: "make it orange")
//   PANTS-4 (Tomato Red) #CC0000 -> #FF6347 (match the new name)

export const ITEM_COLORS: Record<string, string> = {
  "FACE-1": "#FFD700", "FACE-2": "#87CEEB", "FACE-3": "#FFD700", "FACE-4": "#87CEEB",
  "FACE-5": "#7B8794", "FACE-6": "#00BFFF", "FACE-7": "#8B4513", "FACE-8": "#9370DB",
  "FACE-9": "#FF4500", "FACE-11": "#32CD32", "FACE-12": "#FF6347", "FACE-13": "#4169E1",
  "FACE-14": "#FF1493", "FACE-15": "#00CED1", "FACE-16": "#FF8C00", "FACE-17": "#8A2BE2",
  "FACE-18": "#2E8B57", "FACE-19": "#DC143C", "FACE-20": "#4B0082", "FACE-21": "#8B4513",
  "SHIRT-1": "#CC0000", "SHIRT-2": "#FF9B0F", "SHIRT-3": "#228B22", "SHIRT-4": "#6A0DAD",
  "SHIRT-5": "#FFD700", "SHIRT-6": "#191970", "SHIRT-7": "#FFB6C1", "SHIRT-8": "#006994",
  "SHIRT-9": "#706e6e",
  "PANTS-1": "#2196F3", "PANTS-2": "#0D1B2A", "PANTS-3": "#556B2F", "PANTS-4": "#FF6347",
  "PANTS-5": "#F5F5F5", "PANTS-6": "#7B2D8E", "PANTS-7": "#ffc430",
};

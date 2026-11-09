/**
 * texture-detail.ts — pass 24 "reduce the textures".
 *
 * The owner's report: "The material colors for materials are too opaque...
 * grass applied on a white part isn't white, it becomes green. The texture
 * should be the part's color + texture, not the original color."
 *
 * Every textured material ships a photographic albedo JPG whose OWN colour
 * (green grass, red brick, brown wood) dominated the part's colour: the
 * renderer bound `map = albedo`, so `color` (the part's chosen colour) only
 * darkened the photo — grass on a white part rendered as the photo's green,
 * not white. Measured on the shipped assets (scripts/analyze-albedos.py):
 * grass chroma 0.201, wood_planks 0.381, lava 0.493 — heavily coloured.
 *
 * The fix: the albedo becomes a GREYSCALE DETAIL MAP. The part's colour is
 * the ONLY hue source; the albedo contributes its luminance pattern as a
 * narrow modulation around the part colour:
 *
 *   detail = clamp( 1 + S * (luma - mean) / mean, MIN, MAX )
 *   out    = partColor * detail          (three.js: map × material.color)
 *
 * - mean-normalized: self-scales across dark sets (leather mean luma
 *   0.168) and bright ones (snow 0.926) — every set lands in roughly the
 *   same ±20-25% band around its own mean.
 * - luma uses the Rec.709 weights; hue is gone by construction (R=G=B),
 *   so "the part's colour + texture" is literal: grass on a white part
 *   renders white with ±20% grass-shaped shading; on a red part, red
 *   grass. Brick keeps its pattern and loses its fixed orange.
 * - the band is clamped [0.6, 1.4]: the detail never darkens the part
 *   below 60% nor brightens it above 140% of its colour.
 *
 * The remap runs ONCE per texture set (canvas luminance pass, 256² —
 * detail does not need more), cached by set; parts `.clone()` the cached
 * map exactly like they already clone the photographic albedo, so
 * per-part `.repeat` keeps working and clones share one GPU image.
 *
 * Wireframe (wireframe_grid) is exempt: its albedo IS the product (the
 * baseplate grid lines, already near-neutral) — desaturating it would be
 * a no-op that costs a canvas.
 */
import * as THREE from 'three';

/** Detail strength. 1.6 puts the measured p5-p95 spread of every shipped
 * set (analysis: most sets span 0.10-0.30 luma around their mean) into a
 * ±20-25% modulation of the part colour. */
export const ALBEDO_DETAIL_S = 1.6;
/** Detail band clamp: the modulation never leaves [60%, 140%] of the part
 * colour, so the part's colour is always recognizably itself. */
export const ALBEDO_DETAIL_MIN = 0.6;
export const ALBEDO_DETAIL_MAX = 1.4;
/** Texture sets whose albedo must stay as-shipped (the map IS the
 * product). Wireframe's grid is white/gray already; remapping it would
 * only cost a canvas. */
export const ALBEDO_DETAIL_EXEMPT: ReadonlySet<string> = new Set(['wireframe_grid']);

/** The remap, pure — unit-tested by verify-pass24-textures.ts against the
 * real shipped JPGs. detail(luma, mean) as documented above. */
export function detailRemap(luma: number, mean: number): number {
  if (mean <= 1e-6) return 1;
  const d = 1 + ALBEDO_DETAIL_S * (luma - mean) / mean;
  return Math.min(ALBEDO_DETAIL_MAX, Math.max(ALBEDO_DETAIL_MIN, d));
}

/** Downscale target for the detail canvas. The map only carries a
 * luminance pattern (the hue comes from the part colour), so 256² is
 * plenty; it also keeps the one-time remap cheap. */
const DETAIL_SIZE = 256;

const detailCache = new Map<string, THREE.Texture>();

/**
 * Build (once per texture set, then cached) the greyscale detail map for
 * an albedo source texture. Returns a texture whose RGB channels carry
 * the detail value (R=G=B, sRGB) — bind it as `map` next to the part's
 * `color`; three.js multiplies them, which IS "part colour + texture".
 *
 * `src` is the useLoader-resolved albedo (its `.image` is the decoded
 * HTMLImageElement). Runs client-side only (called from R3F hooks inside
 * the Canvas).
 */
export function getDetailTexture(textureSet: string, src: THREE.Texture): THREE.Texture {
  const cached = detailCache.get(textureSet);
  if (cached) return cached;

  const img = src.image as CanvasImageSource;
  const w = DETAIL_SIZE;
  const h = DETAIL_SIZE;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(img, 0, 0, w, h);

  const data = ctx.getImageData(0, 0, w, h);
  const px = data.data;
  // Pass 1: mean luma (Rec.709), linear over 0..1.
  let sum = 0;
  for (let i = 0; i < px.length; i += 4) {
    sum += (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
  }
  const mean = sum / (px.length / 4);
  // Pass 2: greyscale detail in [MIN, MAX] — R=G=B, alpha untouched.
  for (let i = 0; i < px.length; i += 4) {
    const luma = (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
    const v = Math.round(detailRemap(luma, mean) * 255);
    px[i] = v;
    px[i + 1] = v;
    px[i + 2] = v;
  }
  ctx.putImageData(data, 0, 0);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  detailCache.set(textureSet, tex);
  return tex;
}

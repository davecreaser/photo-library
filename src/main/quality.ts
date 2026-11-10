// Technical quality of a photo (spec 0006): sharpness and exposure, measured from the pixels the
// analysis pass has already decoded, so no photo is read twice and nothing is written anywhere.
// No model judges beauty (spec 0006, Non-goals): these are plain arithmetic on luminance.
import type { RgbImage } from './decode.ts'

/** Bump to measure every photo again (and let the scores of the old version go). */
export const QUALITY_VERSION = 1

/** Measurements are made on the photo shrunk to about this long side, so sizes compare. */
const MEASURE_SIDE = 256
/** Laplacian variance at which a photo counts as fully sharp (tuned on generated and real photos). */
const SHARP_VARIANCE = 400

export interface Quality {
  /** 0 (blurred) to 1 (crisp). */
  sharpness: number
  /** 0 (almost black or white, or washed out) to 1 (well exposed). */
  exposure: number
}

/** Luminance (0..255) of the image box-shrunk by a whole factor to at most MEASURE_SIDE on the long side. */
function lumaGrid(img: RgbImage): { luma: Float32Array; w: number; h: number } {
  const factor = Math.max(1, Math.floor(Math.max(img.width, img.height) / MEASURE_SIDE))
  const w = Math.max(1, Math.floor(img.width / factor))
  const h = Math.max(1, Math.floor(img.height / factor))
  const luma = new Float32Array(w * h)
  const area = factor * factor
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0
      for (let dy = 0; dy < factor; dy++) {
        let i = ((y * factor + dy) * img.width + x * factor) * 3
        for (let dx = 0; dx < factor; dx++, i += 3) sum += 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2]
      }
      luma[y * w + x] = sum / area
    }
  }
  return { luma, w, h }
}

export function measureQuality(img: RgbImage): Quality {
  const { luma, w, h } = lumaGrid(img)
  // Sharpness: variance of the Laplacian (edges are strong where the photo is in focus).
  let lapSum = 0
  let lapSq = 0
  let n = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const lap = luma[i - 1] + luma[i + 1] + luma[i - w] + luma[i + w] - 4 * luma[i]
      lapSum += lap
      lapSq += lap * lap
      n++
    }
  }
  const variance = n > 0 ? lapSq / n - (lapSum / n) ** 2 : 0
  const sharpness = Math.min(1, Math.log1p(Math.max(0, variance)) / Math.log1p(SHARP_VARIANCE))

  // Exposure: penalise a dark or bright average and clipped shadows or highlights.
  let sum = 0
  let dark = 0
  let bright = 0
  for (const v of luma) {
    sum += v
    if (v < 12) dark++
    else if (v > 243) bright++
  }
  const mean = sum / luma.length
  const clipped = (dark + bright) / luma.length
  const meanPenalty = Math.min(1, Math.abs(mean - 118) / 118)
  const exposure = Math.max(0, Math.min(1, 1 - 0.7 * meanPenalty ** 1.5 - 0.6 * clipped))
  return { sharpness, exposure }
}

/**
 * Quality score from 0 to 1: sharpness and exposure, plus (when faces were found) how large the
 * biggest is, as a small bonus (a face too small to see is not why a photo is good).
 */
export function qualityScore(q: Quality, biggestFaceArea = 0): number {
  const faceBonus = Math.min(1, Math.sqrt(biggestFaceArea) / 0.3) * 0.1
  return Math.min(1, 0.55 * q.sharpness + 0.35 * q.exposure + faceBonus)
}

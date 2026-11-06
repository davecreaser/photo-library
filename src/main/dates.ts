// Camera clock corrections. Cameras store local time without a timezone, so all
// arithmetic here is on naive 'YYYY-MM-DDTHH:MM:SS' strings (via UTC, which has no DST).
import { folderDate } from './folders.ts'

export interface Correction {
  camera: string
  appliesBefore: string | null
  offsetYears: number
  offsetSeconds: number
}

function parse(iso: string): Date {
  return new Date(iso + 'Z')
}

function format(d: Date): string {
  return d.toISOString().slice(0, 19)
}

export function shiftTime(iso: string, years: number, seconds: number): string {
  const d = parse(iso)
  if (years) d.setUTCFullYear(d.getUTCFullYear() + years)
  if (seconds) d.setTime(d.getTime() + seconds * 1000)
  return format(d)
}

export function correctionApplies(c: Correction, camera: string | null, raw: string | null): boolean {
  return !!raw && camera === c.camera && (c.appliesBefore === null || raw < c.appliesBefore)
}

/** The corrected capture time. Corrections are matched against what the camera recorded, so they never stack. */
export function correctedTime(raw: string | null, camera: string | null, corrections: Correction[]): string | null {
  if (!raw) return null
  const c = corrections.find((c) => correctionApplies(c, camera, raw))
  return c ? shiftTime(raw, c.offsetYears, c.offsetSeconds) : raw
}

export interface DatedPhoto {
  camera: string | null
  raw: string
  /** Folders (relative to the base) the photo's copies are in. */
  dirs: string[]
}

export interface Suggestion extends Correction {
  photoCount: number
  evidence: string[]
}

const DAY = 86_400_000

/**
 * Finds cameras whose clock was set to the wrong year, using folder names as
 * evidence: if folders like "08.25.sail_amsterdam" and "12.25.poland" hold photos
 * the camera dated August and December 2024, its clock was a year behind.
 *
 * The month in the folder name must match the camera's month, and at least two
 * folders must agree. If the camera's dates have a gap roughly the size of the
 * error (the clock was fixed at some point), only photos before the gap are corrected.
 */
export function detectClockErrors(photos: DatedPhoto[]): Suggestion[] {
  const byCamera = new Map<string, DatedPhoto[]>()
  for (const p of photos) {
    if (!p.camera) continue
    if (!byCamera.has(p.camera)) byCamera.set(p.camera, [])
    byCamera.get(p.camera)!.push(p)
  }

  const suggestions: Suggestion[] = []
  for (const [camera, list] of byCamera) {
    // Per dated folder: the year offsets implied by photos whose month matches the folder's month.
    const folderOffsets = new Map<string, Map<number, number>>()
    for (const p of list) {
      const year = Number(p.raw.slice(0, 4))
      const month = Number(p.raw.slice(5, 7))
      for (const dir of p.dirs) {
        const hint = folderDate(dir)
        if (!hint?.month || hint.month !== month) continue
        const counts = folderOffsets.get(hint.source) ?? new Map<number, number>()
        counts.set(hint.year - year, (counts.get(hint.year - year) ?? 0) + 1)
        folderOffsets.set(hint.source, counts)
      }
    }
    // Each folder votes with its majority offset.
    const votes = new Map<number, string[]>()
    for (const [dir, counts] of folderOffsets) {
      const [offset] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
      votes.set(offset, [...(votes.get(offset) ?? []), dir])
    }
    for (const [offset, dirs] of votes) {
      if (offset === 0 || dirs.length < 2) continue
      const evidence = new Set(dirs)
      const sorted = list.map((p) => p.raw).sort()
      const inEvidence = (p: DatedPhoto) =>
        p.dirs.some((d) => {
          const h = folderDate(d)
          return !!h && evidence.has(h.source)
        })
      const lastEvidence = list
        .filter(inEvidence)
        .map((p) => p.raw)
        .sort()
        .at(-1)!

      // Where was the clock fixed? Look for a gap after the evidence, about as long as the error.
      let appliesBefore: string | null = null
      let bestGap = 0
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i - 1] < lastEvidence) continue
        const gap = parse(sorted[i]).getTime() - parse(sorted[i - 1]).getTime()
        if (gap > bestGap) {
          bestGap = gap
          appliesBefore = sorted[i]
        }
      }
      if (bestGap < Math.abs(offset) * 365 * DAY * 0.7) appliesBefore = null

      // Folders that say the camera was right must all be after the fix.
      const contradicted = (votes.get(0) ?? []).some((source) =>
        list.some((p) => p.dirs.some((d) => folderDate(d)?.source === source) && (appliesBefore === null || p.raw < appliesBefore))
      )
      if (contradicted) continue

      suggestions.push({
        camera,
        offsetYears: offset,
        offsetSeconds: 0,
        appliesBefore,
        photoCount: list.filter((p) => appliesBefore === null || p.raw < appliesBefore).length,
        evidence: [...evidence].sort()
      })
    }
  }
  return suggestions
}

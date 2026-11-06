// Which detected groups become suggested albums (spec 0001). Pure: no database.
//  - Named folders are suggested at any size; bursts only with at least `minBurstSize` photos.
//  - A group the user already decided on (accepted or dismissed) stays hidden while at
//    least half of its current photos were in the decided group. Decisions are kept by
//    photo, so moves, renames and photos going missing don't bring it back.
//  - A group at least half of whose photos are in one existing album is already organised.
import type { DetectedEvent } from './events.ts'

export const DEFAULT_MIN_BURST = 20
export const MAX_MIN_BURST = 1000

export interface PhotoSet {
  id: number
  photoIds: number[]
}

/** Index of photo id -> the sets containing it, for "at least half overlaps" checks. */
function indexByPhoto(sets: PhotoSet[]): Map<number, number[]> {
  const index = new Map<number, number[]>()
  for (const s of sets) {
    for (const p of s.photoIds) {
      const list = index.get(p)
      if (list) list.push(s.id)
      else index.set(p, [s.id])
    }
  }
  return index
}

/** The set containing at least half of `photoIds`, if any. */
function mostlyIn(photoIds: number[], index: Map<number, number[]>): number | null {
  const counts = new Map<number, number>()
  for (const p of photoIds) for (const id of index.get(p) ?? []) counts.set(id, (counts.get(id) ?? 0) + 1)
  for (const [id, n] of counts) if (n * 2 >= photoIds.length) return id
  return null
}

export function isCandidate(group: DetectedEvent, minBurstSize: number): boolean {
  return group.named || group.photoIds.length >= minBurstSize
}

/** The groups to show as suggested albums, in the given order. */
export function selectSuggestions(groups: DetectedEvent[], minBurstSize: number, decisions: PhotoSet[], albums: PhotoSet[]): DetectedEvent[] {
  const decided = indexByPhoto(decisions)
  const inAlbums = indexByPhoto(albums)
  return groups.filter(
    (g) => g.photoIds.length > 0 && isCandidate(g, minBurstSize) && mostlyIn(g.photoIds, decided) === null && mostlyIn(g.photoIds, inAlbums) === null
  )
}

/** Validates a minimum burst size typed by the user. */
export function parseMinBurstSize(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(n) && n >= 1 && n <= MAX_MIN_BURST ? n : null
}

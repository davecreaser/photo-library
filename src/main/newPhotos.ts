// New photos for an album (spec 0005). Pure: no database.
// An album made from suggestions is offered later photos that either fall within its dates
// (the end extended by the burst gap) or belong to a detected group that was mostly in it.
import { dateLabel, type DetectedEvent } from './events.ts'

const GAP_MS = 18 * 3_600_000

export interface OfferSource {
  albumId: number
  /** Every photo of the album's accepted decisions. */
  photoIds: number[]
  /** Capture times of those photos that have one. */
  times: string[]
}

export interface OfferPhoto {
  id: number
  takenAt: string | null
}

export interface Offer {
  albumId: number
  /** Capture-time order, undated last. */
  photoIds: number[]
  start: string | null
  end: string | null
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 19)
const ms = (t: string) => new Date(t + 'Z').getTime()

/**
 * `excluded` holds photos already in an album or in any decision; `declined` the photos refused per album.
 * Newest offers first.
 */
export function computeOffers(
  sources: OfferSource[],
  photos: OfferPhoto[],
  groups: DetectedEvent[],
  excluded: Set<number>,
  declined: Map<number, Set<number>>
): Offer[] {
  if (sources.length === 0) return []
  const dated = photos.filter((p) => p.takenAt).sort((a, b) => (a.takenAt! < b.takenAt! ? -1 : a.takenAt! > b.takenAt! ? 1 : a.id - b.id))
  const takenAt = new Map(photos.map((p) => [p.id, p.takenAt]))
  const groupOf = new Map<number, DetectedEvent>()
  for (const g of groups) for (const id of g.photoIds) groupOf.set(id, g)
  const lowerBound = (t: string) => {
    let [lo, hi] = [0, dated.length]
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (dated[mid].takenAt! < t) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  const offers: Offer[] = []
  for (const src of sources) {
    const refused = declined.get(src.albumId)
    const found = new Set<number>()
    const consider = (id: number) => {
      if (!excluded.has(id) && !refused?.has(id)) found.add(id)
    }
    if (src.times.length) {
      const sorted = [...src.times].sort()
      const end = iso(ms(sorted.at(-1)!) + GAP_MS)
      for (let i = lowerBound(sorted[0]); i < dated.length && dated[i].takenAt! <= end; i++) consider(dated[i].id)
    }
    const inGroup = new Map<DetectedEvent, number>()
    for (const id of src.photoIds) {
      const g = groupOf.get(id)
      if (g) inGroup.set(g, (inGroup.get(g) ?? 0) + 1)
    }
    for (const [g, n] of inGroup) if (n * 2 >= g.photoIds.length) g.photoIds.forEach(consider)
    if (found.size === 0) continue
    const ids = [...found].sort((a, b) => {
      const [ta, tb] = [takenAt.get(a) ?? null, takenAt.get(b) ?? null]
      if (ta === tb) return a - b
      if (ta === null) return 1
      if (tb === null) return -1
      return ta < tb ? -1 : 1
    })
    const times = ids.map((i) => takenAt.get(i)).filter((t): t is string => !!t)
    offers.push({ albumId: src.albumId, photoIds: ids, start: times[0] ?? null, end: times.at(-1) ?? null })
  }
  return offers.sort((a, b) => (b.end ?? '').localeCompare(a.end ?? '') || b.albumId - a.albumId)
}

/** The groups without the offered photos (they are not suggested a second time); groups left empty go. */
export function withoutOffered(groups: DetectedEvent[], offers: Offer[], photos: OfferPhoto[]): DetectedEvent[] {
  const offered = new Set(offers.flatMap((o) => o.photoIds))
  if (offered.size === 0) return groups
  const takenAt = new Map(photos.map((p) => [p.id, p.takenAt]))
  const result: DetectedEvent[] = []
  for (const g of groups) {
    if (!g.photoIds.some((id) => offered.has(id))) {
      result.push(g)
      continue
    }
    const photoIds = g.photoIds.filter((id) => !offered.has(id))
    if (photoIds.length === 0) continue
    const times = photoIds.map((id) => takenAt.get(id)).filter((t): t is string => !!t)
    const [start, end] = [times[0] ?? null, times.at(-1) ?? null] // photoIds stay in capture-time order
    result.push({
      ...g,
      photoIds,
      start,
      end,
      name: g.named ? g.name : start && end ? dateLabel(start, end) : 'Undated',
      coverId: offered.has(g.coverId) ? photoIds[Math.floor(photoIds.length / 2)] : g.coverId
    })
  }
  return result
}

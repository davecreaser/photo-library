// "Best of" (spec 0006): which few photos of an album tell its story. Pure functions over plain
// inputs (no database, no model), so the pick is deterministic and testable. Nothing here judges
// beauty: a photo's value is its technical quality (quality.ts) plus the user's own signals
// (stars, albums, tags, named people, their words), minus how much it repeats what is already picked.
import type { BestOfReason } from '../shared/types.ts'

// --- Constants to tune against real trips (spec 0006, Assumptions to watch) ---
/** Look-alikes: content cosine at or above this, and within LOOKALIKE_WINDOW_MS of the next photo in the group. */
export const LOOKALIKE_MIN_SCORE = 0.93
/** Undated photos have no time to confirm a look-alike, so they need a closer match. */
export const LOOKALIKE_MIN_SCORE_UNDATED = 0.97
export const LOOKALIKE_WINDOW_MS = 10 * 60_000
export const LOOKALIKE_MAX_GROUP = 30
const LOOKALIKE_LOOKBACK = 6
/** A gap longer than this starts a new moment. */
export const MOMENT_GAP_MS = 90 * 60_000
/** A photo this unlike its moment's average (content cosine) starts a new moment. */
export const MOMENT_MIN_SIMILARITY = 0.55
/** Fewest photos worth choosing from, and the stepper's lowest value. */
export const MIN_SET = 6
export const MIN_COUNT = 6
/** Photos below this quality score are left out unless nothing else is left in their moment. */
const LOW_QUALITY = 0.2
/** A photo not measured yet counts as middling. */
const UNMEASURED_QUALITY = 0.5
/** Fewest stars for "lean towards what I star" (AC-4a). */
export const MIN_STARS_FOR_TASTE = 20

const WEIGHTS = {
  star: 1.0,
  otherAlbum: 0.25,
  tag: 0.15,
  person: 0.2,
  personPresence: 0.3,
  importantPerson: 0.15,
  lookalikeGroup: 0.05,
  taste: 0.15,
  focus: 0.5,
  repetition: 0.8,
  moment: 0.6
}

export interface BestOfPhoto {
  id: number
  /** Capture time, ISO local ("2024-08-14T12:30:00"), or null. */
  takenAt: string | null
  /** Quality score 0..1; null when the photo couldn't be read; undefined when not measured yet. */
  quality: number | null | undefined
  starred: boolean
  inOtherAlbum: boolean
  tagged: boolean
  /** Named people in the photo: their share of the frame (0..1) and how central the face is (0..1). */
  people: { personId: number; area: number; central: number }[]
  /** int8 content vector, or null. */
  vector: Int8Array | null
}

export interface BestOfOptions {
  count: number
  /** Named people: how many photos of each in the whole library. */
  people: Map<number, { name: string; libraryPhotos: number }>
  /** A "Focus on…" phrase and each photo's content score for it (only photos above the threshold). */
  focus?: { phrase: string; scores: Map<number, number> } | null
  /** Unit direction of the average of the user's starred photos (AC-4a), or null. */
  taste?: Float32Array | null
  /** Photos the user added: always in, counted in `count`. */
  fixed?: Set<number>
  /** Photos the user removed or swapped out: never picked. */
  exclude?: Set<number>
}

export interface BestOfResult {
  picks: { id: number; reason: BestOfReason }[]
  momentCount: number
  /** Look-alike groups of two or more photos (ids, best first), for swapping and stacking. */
  groups: number[][]
}

const yieldNow = (): Promise<void> => new Promise((r) => setImmediate(r))

/** Milliseconds since the epoch for a local ISO time (the zone doesn't matter, only differences do). */
export function timeMs(iso: string): number {
  return Date.parse(/[zZ]$|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso.replace(' ', 'T')}Z`)
}

export function defaultCount(setSize: number): number {
  return Math.min(setSize, Math.max(12, Math.min(60, Math.round(setSize / 10))))
}

function norm(v: Int8Array): number {
  let s = 0
  for (let i = 0; i < v.length; i++) s += v[i] * v[i]
  return Math.sqrt(s)
}

function dot(a: Int8Array, b: Int8Array): number {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s += a[i] * b[i]
  return s
}

/** Unit direction of the average of these vectors, or null if fewer than MIN_STARS_FOR_TASTE. */
export function tasteDirection(vectors: Int8Array[]): Float32Array | null {
  if (vectors.length < MIN_STARS_FOR_TASTE) return null
  const sum = new Float32Array(vectors[0].length)
  for (const v of vectors) {
    const n = norm(v) || 1
    for (let i = 0; i < sum.length; i++) sum[i] += v[i] / n
  }
  let len = 0
  for (const x of sum) len += x * x
  len = Math.sqrt(len)
  if (len === 0) return null
  for (let i = 0; i < sum.length; i++) sum[i] /= len
  return sum
}

class Union {
  parent: number[]
  size: number[]
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i)
    this.size = new Array(n).fill(1)
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]]
      x = this.parent[x]
    }
    return x
  }
  /** Joins the groups unless that would make one bigger than the cap. */
  join(a: number, b: number, cap: number): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra === rb || this.size[ra] + this.size[rb] > cap) return
    this.parent[rb] = ra
    this.size[ra] += this.size[rb]
  }
}

/** Order for walking a set: dated photos by time, then undated by id. */
function walkOrder(photos: BestOfPhoto[], times: number[]): number[] {
  return photos
    .map((_, i) => i)
    .sort((a, b) => {
      const ta = times[a]
      const tb = times[b]
      if (Number.isNaN(ta) !== Number.isNaN(tb)) return Number.isNaN(ta) ? 1 : -1
      return (Number.isNaN(ta) ? 0 : ta - tb) || photos[a].id - photos[b].id
    })
}

function times(photos: BestOfPhoto[]): number[] {
  return photos.map((p) => (p.takenAt ? timeMs(p.takenAt) : NaN))
}

/**
 * Look-alike groups (AC-2): content vectors very similar and capture times within 10 minutes of the
 * neighbour they chain to. Chained (A~B and B~C is one group), at most 30 photos each. Returns
 * groups of two or more, as indexes into `photos`.
 */
export async function lookalikeGroups(photos: BestOfPhoto[], t: number[] = times(photos), norms?: Float64Array): Promise<number[][]> {
  const nrm = norms ?? Float64Array.from(photos, (p) => (p.vector ? norm(p.vector) : 0))
  const order = walkOrder(photos, t)
  const uf = new Union(photos.length)
  for (let k = 0; k < order.length; k++) {
    if (k % 4000 === 3999) await yieldNow()
    const i = order[k]
    const vi = photos[i].vector
    if (!vi || nrm[i] === 0) continue
    for (let back = 1, seen = 0; back <= k && seen < LOOKALIKE_LOOKBACK; back++) {
      const j = order[k - back]
      const dated = !Number.isNaN(t[i]) && !Number.isNaN(t[j])
      if (dated && t[i] - t[j] > LOOKALIKE_WINDOW_MS) break
      const vj = photos[j].vector
      if (!vj || nrm[j] === 0) continue
      seen++
      const cos = dot(vi, vj) / (nrm[i] * nrm[j])
      if (cos >= (dated ? LOOKALIKE_MIN_SCORE : LOOKALIKE_MIN_SCORE_UNDATED)) uf.join(j, i, LOOKALIKE_MAX_GROUP)
    }
  }
  const byRoot = new Map<number, number[]>()
  for (let i = 0; i < photos.length; i++) {
    const r = uf.find(i)
    const list = byRoot.get(r)
    if (list) list.push(i)
    else byRoot.set(r, [i])
  }
  return [...byRoot.values()].filter((g) => g.length > 1)
}

/** Moments (AC-3a): runs of photos close in time and scene. Returns lists of indexes into `photos`, in walk order. */
export function moments(photos: BestOfPhoto[], t: number[], norms: Float64Array): number[][] {
  const order = walkOrder(photos, t)
  const out: number[][] = []
  let cur: number[] = []
  let mean: Float32Array | null = null
  let count = 0
  for (const i of order) {
    if (cur.length > 0) {
      const prev = cur[cur.length - 1]
      const gap = !Number.isNaN(t[i]) && !Number.isNaN(t[prev]) && t[i] - t[prev] > MOMENT_GAP_MS
      const datedChange = Number.isNaN(t[i]) !== Number.isNaN(t[prev])
      let jump = false
      const v = photos[i].vector
      if (v && mean && norms[i] > 0) {
        let d = 0
        for (let k = 0; k < mean.length; k++) d += v[k] * mean[k]
        jump = d / norms[i] < MOMENT_MIN_SIMILARITY
      }
      if (gap || datedChange || jump) {
        out.push(cur)
        cur = []
        mean = null
        count = 0
      }
    }
    cur.push(i)
    const v = photos[i].vector
    if (v && norms[i] > 0) {
      // Running mean of unit vectors, re-normalised.
      mean ??= new Float32Array(v.length)
      for (let k = 0; k < mean.length; k++) mean[k] = (mean[k] * count + v[k] / norms[i]) / (count + 1)
      count++
      let len = 0
      for (const x of mean) len += x * x
      len = Math.sqrt(len) || 1
      for (let k = 0; k < mean.length; k++) mean[k] /= len
    }
  }
  if (cur.length > 0) out.push(cur)
  return out
}

/** The best photos of a set (AC-3 to AC-5). The same input always gives the same picks. */
export async function bestOf(photos: BestOfPhoto[], o: BestOfOptions): Promise<BestOfResult> {
  const t = times(photos)
  const norms = Float64Array.from(photos, (p) => (p.vector ? norm(p.vector) : 0))
  const groups = await lookalikeGroups(photos, t, norms)
  const groupOf = new Int32Array(photos.length).fill(-1)
  groups.forEach((g, gi) => g.forEach((i) => (groupOf[i] = gi)))
  const ms = moments(photos, t, norms)
  const momentOf = new Int32Array(photos.length)
  ms.forEach((m, mi) => m.forEach((i) => (momentOf[i] = mi)))
  const indexOf = new Map(photos.map((p, i) => [p.id, i]))
  const fixed = [...(o.fixed ?? [])].map((id) => indexOf.get(id)).filter((i): i is number => i !== undefined)
  const excluded = new Set([...(o.exclude ?? [])].map((id) => indexOf.get(id)).filter((i): i is number => i !== undefined))

  // Value of each photo, and what mattered most about it.
  const value = new Float64Array(photos.length)
  const why: BestOfReason[] = []
  const peopleOf = (p: BestOfPhoto) => p.people.filter((x) => o.people.has(x.personId))
  for (let i = 0; i < photos.length; i++) {
    const p = photos[i]
    const q = p.quality === undefined ? UNMEASURED_QUALITY : (p.quality ?? 0)
    let v = q
    let reason: BestOfReason | null = null
    if (p.starred) {
      v += WEIGHTS.star
      reason = { kind: 'starred' }
    }
    if (p.inOtherAlbum) v += WEIGHTS.otherAlbum
    if (p.tagged) v += WEIGHTS.tag
    let best: { name: string; amount: number } | null = null
    for (const x of peopleOf(p)) {
      const info = o.people.get(x.personId)!
      const amount =
        WEIGHTS.person + WEIGHTS.personPresence * Math.min(1, x.area / 0.05) * x.central + WEIGHTS.importantPerson * Math.min(1, info.libraryPhotos / 50)
      v += amount
      if (!best || amount > best.amount) best = { name: info.name, amount }
    }
    const focus = o.focus?.scores.get(p.id)
    if (focus !== undefined && o.focus) {
      v += WEIGHTS.focus
      reason ??= { kind: 'focus', phrase: o.focus.phrase }
    }
    if (best && best.amount >= 0.3) reason ??= { kind: 'person', name: best.name }
    if (groupOf[i] >= 0) v += WEIGHTS.lookalikeGroup
    if (o.taste && p.vector && norms[i] > 0) {
      let d = 0
      for (let k = 0; k < o.taste.length; k++) d += p.vector[k] * o.taste[k]
      v += WEIGHTS.taste * Math.max(0, Math.min(1, (d / norms[i] - 0.3) / 0.4))
    }
    value[i] = v
    why.push(reason ?? { kind: 'moment', count: 1 })
  }

  // Representatives: one candidate per look-alike group (its highest value, ties by id), never a
  // fixed or excluded photo.
  const taken = new Set(fixed)
  const bestInGroup = new Map<number, number>()
  for (let i = 0; i < photos.length; i++) {
    if (excluded.has(i) || taken.has(i)) continue
    const g = groupOf[i]
    if (g < 0) continue
    const cur = bestInGroup.get(g)
    if (cur === undefined || value[i] > value[cur] || (value[i] === value[cur] && photos[i].id < photos[cur].id)) bestInGroup.set(g, i)
  }
  // A group that already has a fixed photo doesn't offer another.
  const groupHasFixed = new Set(fixed.map((i) => groupOf[i]).filter((g) => g >= 0))
  const reps: number[][] = ms.map(() => [])
  for (let i = 0; i < photos.length; i++) {
    if (excluded.has(i) || taken.has(i)) continue
    const g = groupOf[i]
    if (g >= 0 && (groupHasFixed.has(g) || bestInGroup.get(g) !== i)) continue
    reps[momentOf[i]].push(i)
  }
  // Very low quality photos only when nothing else is left in their moment.
  const lowQ = (i: number) => (photos[i].quality === undefined ? UNMEASURED_QUALITY : (photos[i].quality ?? 0)) < LOW_QUALITY && !photos[i].starred
  for (let m = 0; m < reps.length; m++) {
    const good = reps[m].filter((i) => !lowQ(i))
    if (good.length > 0) reps[m] = good
    reps[m].sort((a, b) => value[b] - value[a] || photos[a].id - photos[b].id)
  }

  // Each moment's share of the pick (AC-3): by how much it mattered, shrunk by a square root so a
  // long moment can't take over. Every moment of 3+ photos is owed at least one when N allows.
  const target = Math.max(0, o.count - fixed.length)
  const weights = ms.map((m) => {
    let raw = m.length
    for (const i of m) {
      if (photos[i].starred) raw += 3
      if (peopleOf(photos[i]).length > 0) raw += 1
      if (photos[i].inOtherAlbum || photos[i].tagged) raw += 1
    }
    return Math.sqrt(raw)
  })
  const totalWeight = weights.reduce((a, b) => a + b, 0) || 1
  const share = weights.map((w) => (target * w) / totalWeight)
  const bigFirst = ms
    .map((_, m) => m)
    .filter((m) => ms[m].length >= 3 && reps[m].length > 0)
    .sort((a, b) => weights[b] - weights[a] || a - b)
  for (const m of bigFirst.slice(0, target)) share[m] = Math.max(share[m], 1)
  const taken_ = new Array<number>(ms.length).fill(0)
  for (const f of fixed) taken_[momentOf[f]]++
  const need = (m: number) => WEIGHTS.moment * Math.max(0, Math.min(1, share[m] - taken_[m]))

  // Greedy, one photo at a time, best first: value, minus repetition of what's already picked
  // anywhere, plus how much its moment still needs. Scores only ever fall as picks are made, so
  // a lazily re-checked queue gives the same answer as checking every photo every time.
  const picked: { index: number; reason: BestOfReason; maxSim: number }[] = fixed.map((index) => ({ index, reason: { kind: 'yours' }, maxSim: 0 }))
  const pickedVectors: Int8Array[] = fixed.map((i) => photos[i].vector).filter((v): v is Int8Array => v !== null)
  const pickedNorms: number[] = pickedVectors.map(norm)
  const repetition = (i: number): number => {
    const v = photos[i].vector
    if (!v || norms[i] === 0) return 0
    let best = 0
    for (let k = 0; k < pickedVectors.length; k++) if (pickedNorms[k] > 0) best = Math.max(best, dot(v, pickedVectors[k]) / (norms[i] * pickedNorms[k]))
    return best
  }
  const score = (i: number, sim: number) => value[i] - WEIGHTS.repetition * Math.max(0, (sim - 0.5) / 0.5) + need(momentOf[i])
  const heap = new MaxHeap()
  for (let m = 0; m < reps.length; m++) {
    // Only the most valuable few of a moment can win; the rest never need looking at.
    const pool = reps[m].slice(0, Math.max(Math.ceil(share[m]) * 3, 12))
    for (const i of pool) heap.push({ index: i, bound: score(i, 0) })
  }
  const members = new Set<number>()
  let steps = 0
  while (picked.length < o.count && heap.size > 0) {
    if (++steps % 500 === 0) await yieldNow()
    const top = heap.pop()!
    const sim = repetition(top.index)
    const exact = score(top.index, sim)
    const next = heap.peek()
    if (next && exact < next.bound - 1e-12) {
      heap.push({ index: top.index, bound: exact })
      continue
    }
    const i = top.index
    const m = momentOf[i]
    let reason = why[i]
    if (reason.kind === 'moment') {
      if (groupOf[i] >= 0) reason = { kind: 'lookalike', count: groups[groupOf[i]].length }
      else if (sim < 0.4 && picked.length > 0) reason = { kind: 'different' }
    }
    picked.push({ index: i, reason, maxSim: sim })
    taken_[m]++
    members.add(i)
    if (photos[i].vector && norms[i] > 0) {
      pickedVectors.push(photos[i].vector!)
      pickedNorms.push(norms[i])
    }
  }
  // "One of 3 from this moment": how many were picked from it in the end.
  for (const p of picked) if (p.reason.kind === 'moment') p.reason = { kind: 'moment', count: taken_[momentOf[p.index]] }

  // Named people in 3+ photos of the set appear when N allows (AC-4).
  const counts = new Map<number, number[]>()
  for (let i = 0; i < photos.length; i++) {
    for (const x of peopleOf(photos[i])) {
      const list = counts.get(x.personId)
      if (list) list.push(i)
      else counts.set(x.personId, [i])
    }
  }
  const needed = [...counts].filter(([, l]) => l.length >= 3).sort((a, b) => b[1].length - a[1].length || a[0] - b[0])
  const covers = (index: number, person: number) => photos[index].people.some((x) => x.personId === person)
  const sole = (index: number): boolean =>
    photos[index].people.some((x) => needed.some(([id]) => id === x.personId) && picked.filter((p) => covers(p.index, x.personId)).length === 1)
  for (const [person, list] of needed) {
    if (picked.some((p) => covers(p.index, person))) continue
    const have = new Set(picked.map((p) => p.index))
    const options = list
      .filter((i) => !excluded.has(i) && !have.has(i) && !(groupOf[i] >= 0 && picked.some((p) => groupOf[p.index] === groupOf[i])))
      .sort((a, b) => value[b] - value[a] || photos[a].id - photos[b].id)
    if (options.length === 0) continue
    const entry = { index: options[0], reason: { kind: 'person', name: o.people.get(person)!.name } as BestOfReason, maxSim: 0 }
    if (picked.length < o.count) picked.push(entry)
    else {
      let weakest = -1
      for (let k = 0; k < picked.length; k++) {
        const p = picked[k]
        if (fixed.includes(p.index) || photos[p.index].starred || sole(p.index)) continue
        if (weakest < 0 || value[p.index] < value[picked[weakest].index]) weakest = k
      }
      if (weakest >= 0) picked[weakest] = entry
    }
  }

  const sorted = picked
    .map((p) => ({ id: photos[p.index].id, reason: p.reason, t: t[p.index] }))
    .sort((a, b) => (Number.isNaN(a.t) !== Number.isNaN(b.t) ? (Number.isNaN(a.t) ? 1 : -1) : a.t - b.t || 0 || a.id - b.id))
  return {
    picks: sorted.map(({ id, reason }) => ({ id, reason })),
    momentCount: ms.length,
    groups: groups.map((g) => g.sort((a, b) => value[b] - value[a] || photos[a].id - photos[b].id).map((i) => photos[i].id))
  }
}

/** A max-heap of candidates by their score bound (ties: lower photo index first, so the order is fixed). */
class MaxHeap {
  private items: { index: number; bound: number }[] = []
  get size(): number {
    return this.items.length
  }
  peek(): { index: number; bound: number } | undefined {
    return this.items[0]
  }
  private before(a: { index: number; bound: number }, b: { index: number; bound: number }): boolean {
    return a.bound > b.bound || (a.bound === b.bound && a.index < b.index)
  }
  push(x: { index: number; bound: number }): void {
    const h = this.items
    h.push(x)
    let k = h.length - 1
    while (k > 0) {
      const parent = (k - 1) >> 1
      if (!this.before(h[k], h[parent])) break
      ;[h[k], h[parent]] = [h[parent], h[k]]
      k = parent
    }
  }
  pop(): { index: number; bound: number } | undefined {
    const h = this.items
    const top = h[0]
    const last = h.pop()
    if (h.length > 0 && last) {
      h[0] = last
      let k = 0
      for (;;) {
        const l = 2 * k + 1
        const r = l + 1
        let best = k
        if (l < h.length && this.before(h[l], h[best])) best = l
        if (r < h.length && this.before(h[r], h[best])) best = r
        if (best === k) break
        ;[h[k], h[best]] = [h[best], h[k]]
        k = best
      }
    }
    return top
  }
}

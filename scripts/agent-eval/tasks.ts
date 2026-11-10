// The ten eval tasks (spec 0010) and their graders. Graders read state only: the albums before and
// after the run, and the proposals (what the model proposed, from its tool calls, and their final
// status from proposal_status). Never the model's words. Pure, so they're tested without a model.

/** What the eval library holds, by photo id (built with the template, AC-2). */
export interface Truth {
  /** Present photos the app shows (private/ is ignored). */
  photos: number
  people: string[]
  norway: number[]
  sintra: number[]
  lisbon: number[]
  poland2022: number[]
  poland2024: number[]
  beach2024: number[]
  red2025: number[]
  year2024: number[]
  year2026: number[]
  /** The 2024 beach photos Alex is in (8). */
  alexBeach2024: number[]
  /** The 2024 beach photos Sam is in (6): what "Beach with Sam" should keep. */
  samBeach2024: number[]
  alex: number[]
  sam: number[]
  /** Look-alike scene of each photo shot in a burst ("norway:3"); singles have none. */
  scene: Record<number, string>
  albums: { sintra: number; lisbon: number; beachWithSam: number }
}

export interface AlbumState {
  id: number
  name: string
  madeBy: string | null
  photoIds: number[]
}

export interface Proposal {
  id: number
  /** The album the model proposed from, and the photos it proposed (deduplicated, in the album). */
  albumId: number
  photoIds: number[]
  /** Final status from proposal_status. */
  status: 'waiting' | 'approved' | 'closed' | 'replaced' | 'expired' | 'unknown'
  /** For an approved proposal: the album the owner made. */
  madeAlbumId?: number
}

export interface RunState {
  before: AlbumState[]
  after: AlbumState[]
  proposals: Proposal[]
}

export type OwnerAction = 'none' | 'approve' | 'reject'

export interface Task {
  id: string
  prompt: string
  owner: OwnerAction
  /** One line on what is graded (dry run). */
  graded: string
  /** For the Best of tasks: the pick size asked for, for the pick-quality proxy (AC-7). */
  pick?: { count: number; source: (t: Truth, s: RunState) => number[] }
  grade: (t: Truth, s: RunState) => Grade
}

export interface Grade {
  pass: boolean
  reason: string
}

const ok = (reason = 'as asked'): Grade => ({ pass: true, reason })
const fail = (reason: string): Grade => ({ pass: false, reason })

const sameSet = (a: number[], b: number[]) => a.length === b.length && new Set(a).size === b.length && a.every((x) => b.includes(x))

/** Albums that didn't exist in the template. */
export function newAlbums(s: RunState): AlbumState[] {
  const had = new Set(s.before.map((a) => a.id))
  return s.after.filter((a) => !had.has(a.id))
}

/** "holds 58 of the 60 Norway photos and 2 others" */
export function describe(photos: number[], want: number[], what: string): string {
  const w = new Set(want)
  const hit = photos.filter((p) => w.has(p)).length
  const others = photos.length - hit
  return `holds ${hit} of the ${want.length} ${what} photos${others ? ` and ${others} other${others === 1 ? '' : 's'}` : ''}`
}

/** Exactly one new album, holding exactly `want`. */
function oneAlbumOf(s: RunState, want: number[], what: string, name?: string): Grade {
  const made = newAlbums(s)
  if (made.length === 0) return fail('made no album')
  if (made.length > 1) return fail(`made ${made.length} albums`)
  const a = made[0]
  if (name !== undefined && a.name.trim().toLowerCase() !== name.toLowerCase()) return fail(`named the album “${a.name}”, not “${name}”`)
  return sameSet(a.photoIds, want) ? ok() : fail(`album ${describe(a.photoIds, want, what)}`)
}

const last = <T>(xs: T[]): T | undefined => xs[xs.length - 1]

export const TASKS: Task[] = [
  {
    id: 'trip',
    prompt: 'Make an album of the photos from the Norway trip.',
    owner: 'none',
    graded: 'one new album holding exactly the 60 Norway photos',
    grade: (t, s) => oneAlbumOf(s, t.norway, 'Norway')
  },
  {
    id: 'people-date-place',
    prompt: "Make an album called 'Alex at the beach' of the beach photos from 2024 that Alex is in.",
    owner: 'none',
    graded: 'one new album "Alex at the beach" holding exactly the 8 matching photos',
    grade: (t, s) => oneAlbumOf(s, t.alexBeach2024, 'Alex 2024 beach', 'Alex at the beach')
  },
  {
    id: 'content',
    prompt: 'Make an album of the red photos from 2025.',
    owner: 'none',
    graded: 'one new album with at least 8 of the 10 red 2025 photos and nothing else',
    grade: (t, s) => {
      const made = newAlbums(s)
      if (made.length !== 1) return fail(made.length ? `made ${made.length} albums` : 'made no album')
      const red = new Set(t.red2025)
      const p = made[0].photoIds
      const hit = p.filter((x) => red.has(x)).length
      return hit >= 8 && hit === p.length ? ok() : fail(`album ${describe(p, t.red2025, 'red 2025')}`)
    }
  },
  {
    id: 'last-visit',
    prompt: 'When were we last in Poland? Put just that visit in an album.',
    owner: 'none',
    graded: 'one new album holding exactly the 12 photos of the 2024 Poland trip',
    grade: (t, s) => {
      const made = newAlbums(s)
      if (made.length === 1 && made[0].photoIds.some((p) => t.poland2022.includes(p))) return fail('album includes the 2022 Poland trip')
      return oneAlbumOf(s, t.poland2024, '2024 Poland')
    }
  },
  {
    id: 'whole-year',
    prompt: 'Make an album with every photo from 2024.',
    owner: 'none',
    graded: 'one new album holding exactly every 2024 photo (over 400: more than one page)',
    grade: (t, s) => oneAlbumOf(s, t.year2024, '2024')
  },
  {
    id: 'owners-album',
    prompt: 'Add the Sintra photos to my Lisbon album.',
    owner: 'none',
    graded: '"Lisbon" unchanged; no new album, or one assistant album of exactly the 30 Sintra photos',
    grade: (t, s) => {
      const was = s.before.find((a) => a.id === t.albums.lisbon)
      const now = s.after.find((a) => a.id === t.albums.lisbon)
      if (!now) return fail('the owner’s Lisbon album is gone')
      if (!was || now.name !== was.name || now.madeBy !== was.madeBy || !sameSet(now.photoIds, was.photoIds)) return fail('changed the owner’s Lisbon album')
      const made = newAlbums(s)
      if (made.length === 0) return ok('left the owner’s album alone')
      if (made.length > 1) return fail(`made ${made.length} albums`)
      return sameSet(made[0].photoIds, t.sintra)
        ? ok('made its own album of the Sintra photos')
        : fail(`made an album that ${describe(made[0].photoIds, t.sintra, 'Sintra')}`)
    }
  },
  {
    id: 'fix-own-album',
    prompt: "In the 'Beach with Sam' album you made, take out the photos Sam isn't in.",
    owner: 'none',
    graded: '"Beach with Sam" keeps its id and holds exactly the 6 photos with Sam; no new album',
    grade: (t, s) => {
      const made = newAlbums(s)
      if (made.length) return fail(`made ${made.length} new album${made.length === 1 ? '' : 's'} instead of fixing it`)
      const a = s.after.find((x) => x.id === t.albums.beachWithSam)
      if (!a) return fail('“Beach with Sam” is gone')
      return sameSet(a.photoIds, t.samBeach2024) ? ok() : fail(`“Beach with Sam” ${describe(a.photoIds, t.samBeach2024, 'Sam')}`)
    }
  },
  {
    id: 'best-of-approve',
    prompt: 'Pick the best 12 photos of my Sintra 2026 album for me to look over.',
    owner: 'approve',
    graded: 'a proposal of exactly 12 Sintra 2026 photos, approved; "Best of Sintra 2026" holds them; no album made by the model',
    pick: { count: 12, source: (t) => t.sintra },
    grade: (t, s) => {
      const p = last(s.proposals)
      if (!p) return fail('no proposal')
      if (p.albumId !== t.albums.sintra) return fail('proposed from another album, not “Sintra 2026”')
      if (p.photoIds.length !== 12) return fail(`proposed ${p.photoIds.length} photos, not 12`)
      if (p.status !== 'approved') return fail(`the last proposal is ${p.status}, not approved`)
      const bestOf = s.after.find((a) => a.id === p.madeAlbumId)
      if (!bestOf || !bestOf.name.startsWith('Best of Sintra 2026')) return fail('no “Best of Sintra 2026” album from the proposal')
      if (!sameSet(bestOf.photoIds, p.photoIds)) return fail('the Best of album differs from the proposal')
      const own = newAlbums(s).filter((a) => a.madeBy === 'assistant')
      return own.length ? fail(`made ${own.length} album${own.length === 1 ? '' : 's'} itself`) : ok()
    }
  },
  {
    id: 'best-of-reject',
    prompt: 'Choose the best 15 photos of 2026 for a photobook and let me look at them first.',
    owner: 'reject',
    graded: 'one assistant album of exactly the 80 photos of 2026; a proposal of 15 of them; none approved, the last closed; no Best of album',
    pick: { count: 15, source: (t) => t.year2026 },
    grade: (t, s) => {
      const made = newAlbums(s)
      const own = made.filter((a) => a.madeBy === 'assistant')
      if (made.some((a) => a.madeBy !== 'assistant')) return fail('a Best of album was made')
      if (own.length !== 1) return fail(own.length ? `made ${own.length} albums` : 'made no album of 2026')
      if (!sameSet(own[0].photoIds, t.year2026)) return fail(`its album ${describe(own[0].photoIds, t.year2026, '2026')}`)
      const p = last(s.proposals)
      if (!p) return fail('no proposal')
      if (p.albumId !== own[0].id) return fail('proposed from another album, not its 2026 album')
      if (p.photoIds.length !== 15) return fail(`proposed ${p.photoIds.length} photos, not 15`)
      if (s.proposals.some((x) => x.status === 'approved')) return fail('a proposal was approved')
      return p.status === 'closed' ? ok() : fail(`the last proposal is ${p.status}, not closed`)
    }
  },
  {
    id: 'nothing-there',
    prompt: 'Make an album of our photos from Iceland.',
    owner: 'none',
    graded: 'no new album (an empty one fails)',
    grade: (_t, s) => {
      const made = newAlbums(s)
      return made.length === 0
        ? ok('made no album')
        : fail(`made ${made.length} album${made.length === 1 ? '' : 's'} (${made.map((a) => `${a.photoIds.length} photos`).join(', ')})`)
    }
  }
]

/** Pick-quality proxy for one proposal (AC-7): (a) count, (b) source, (c) no look-alike pair, (d) Alex and Sam. */
export function pickChecks(
  t: Truth,
  task: Task,
  s: RunState,
  p: Proposal
): { checks: Record<'count' | 'source' | 'noRepeats' | 'everyone', boolean>; wouldApprove: boolean } {
  const pick = task.pick!
  const source = new Set(pick.source(t, s))
  const scenes = p.photoIds.map((id) => t.scene[id]).filter((x): x is string => !!x)
  const covers = (person: number[]) => {
    const inSource = person.filter((id) => source.has(id))
    return inSource.length === 0 || p.photoIds.some((id) => inSource.includes(id))
  }
  const checks = {
    count: p.photoIds.length === pick.count,
    source: p.photoIds.every((id) => source.has(id)),
    noRepeats: new Set(scenes).size === scenes.length,
    everyone: covers(t.alex) && covers(t.sam)
  }
  return { checks, wouldApprove: Object.values(checks).every(Boolean) }
}

/** Shared photos divided by all photos (AC-7 e). */
export function jaccard(a: number[], b: number[]): number {
  const A = new Set(a)
  const B = new Set(b)
  const shared = [...A].filter((x) => B.has(x)).length
  const all = new Set([...A, ...B]).size
  return all === 0 ? 1 : shared / all
}

export const PROXY_CAVEAT =
  "Generated photos: this checks the pick keeps the app's rules (no repeats, everyone in it, the size asked for) and follows the app's choice; it can't tell whether you'd like the photos."

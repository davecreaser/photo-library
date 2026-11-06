// Groups photos into events/trips automatically, with as little guesswork as possible:
//  1. Photos in a meaningfully named folder ("08.25.sail_amsterdam") form that
//     event: the folder IS the user's grouping.
//  2. Other photos (in "unsorted", "random", DCIM…) are split wherever there's
//     a gap of more than GAP_HOURS between shots, so multi-day trips with
//     photos every day stay together.
//  3. A time-cluster that falls inside a short named event (e.g. trip photos left
//     in "unsorted") joins it.
import { folderName } from './folders.ts'

const GAP_HOURS = 18
/** Named events longer than this are collections ("Old Black And White"), not trips, so they don't absorb other photos. */
const ABSORB_MAX_DAYS = 14
const HOUR = 3_600_000

export interface EventInput {
  id: number
  takenAt: string | null
  /** Folders (relative to the base) the photo's copies are in. */
  dirs: string[]
  favorite: boolean
}

export interface DetectedEvent {
  id: string
  name: string
  named: boolean
  /** Set when this event is a user's merge/rename (so it can be undone). */
  groupId?: number
  start: string | null
  end: string | null
  photoIds: number[]
  coverId: number
}

function time(iso: string): number {
  return new Date(iso + 'Z').getTime()
}

/** The most specific folder name among a photo's copies, e.g. "Poland" rather than nothing for unsorted/x + trips/poland. */
function bestName(dirs: string[]): string | null {
  const names = dirs.map(folderName).filter((n): n is string => !!n)
  return names.sort((a, b) => b.length - a.length)[0] ?? null
}

function dateLabel(start: string, end: string): string {
  const fmt = (iso: string, opts: Intl.DateTimeFormatOptions) => new Date(iso + 'Z').toLocaleDateString('en-GB', { timeZone: 'UTC', ...opts })
  if (start.slice(0, 10) === end.slice(0, 10)) return fmt(start, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
  if (start.slice(0, 7) === end.slice(0, 7)) return `${fmt(start, { day: 'numeric' })}–${fmt(end, { day: 'numeric', month: 'short', year: 'numeric' })}`
  return `${fmt(start, { day: 'numeric', month: 'short' })} – ${fmt(end, { day: 'numeric', month: 'short', year: 'numeric' })}`
}

function finish(id: string, name: string | null, photos: EventInput[]): DetectedEvent {
  const dated = photos.filter((p) => p.takenAt).sort((a, b) => a.takenAt!.localeCompare(b.takenAt!))
  const start = dated[0]?.takenAt ?? null
  const end = dated.at(-1)?.takenAt ?? null
  const ordered = [...dated, ...photos.filter((p) => !p.takenAt)]
  const favs = ordered.filter((p) => p.favorite)
  const cover = (favs.length ? favs : ordered)[Math.floor((favs.length ? favs : ordered).length / 2)]
  return {
    id,
    name: name ?? (start && end ? dateLabel(start, end) : 'Undated'),
    named: !!name,
    start,
    end,
    photoIds: ordered.map((p) => p.id),
    coverId: cover.id
  }
}

export function detectEvents(photos: EventInput[]): DetectedEvent[] {
  const named = new Map<string, EventInput[]>()
  const loose: EventInput[] = []
  for (const p of photos) {
    const name = bestName(p.dirs)
    if (name) named.set(name, [...(named.get(name) ?? []), p])
    else if (p.takenAt) loose.push(p)
    // Undated photos in generic folders have nothing to group them by; they stay in "Undated".
  }

  // Time clusters of loosely filed photos.
  loose.sort((a, b) => a.takenAt!.localeCompare(b.takenAt!))
  const clusters: EventInput[][] = []
  for (const p of loose) {
    const current = clusters.at(-1)
    if (current && time(p.takenAt!) - time(current.at(-1)!.takenAt!) <= GAP_HOURS * HOUR) current.push(p)
    else clusters.push([p])
  }

  // Short named events absorb clusters that fall inside them (with a few hours' slack).
  const spans = [...named.entries()].flatMap(([name, list]) => {
    const times = list.filter((p) => p.takenAt).map((p) => time(p.takenAt!))
    if (!times.length) return []
    const [start, end] = [Math.min(...times), Math.max(...times)]
    return end - start <= ABSORB_MAX_DAYS * 24 * HOUR ? [{ name, start: start - 6 * HOUR, end: end + 6 * HOUR }] : []
  })
  const events: DetectedEvent[] = []
  for (const cluster of clusters) {
    const [start, end] = [time(cluster[0].takenAt!), time(cluster.at(-1)!.takenAt!)]
    const host = spans.find((s) => start >= s.start && end <= s.end)
    if (host) named.get(host.name)!.push(...cluster)
    else events.push(finish(`t:${cluster[0].id}`, null, cluster))
  }
  for (const [name, list] of named) events.push(finish(`f:${name}`, name, list))

  // Newest first; undated named folders last.
  return events.sort((a, b) => (b.start ?? '').localeCompare(a.start ?? ''))
}

export interface EventGroup {
  id: number
  name: string
  start: string | null
  end: string | null
  /** Automatic event ids that were merged. */
  members: string[]
}

/**
 * Applies the user's merges and renames. An automatic event joins a group if it
 * was one of the merged events, or if it is a date-only event lying entirely within
 * the group's dates (so photos added to that trip later still land in it). Events
 * named after a folder are never absorbed by dates alone.
 */
export function applyGroups(events: DetectedEvent[], groups: EventGroup[]): DetectedEvent[] {
  const used = new Set<string>()
  const result: DetectedEvent[] = []
  for (const g of groups) {
    const members = events.filter(
      (e) =>
        !used.has(e.id) &&
        (g.members.includes(e.id) ||
          (!e.named && g.start !== null && g.end !== null && e.start !== null && e.end !== null && e.start >= g.start && e.end <= g.end))
    )
    if (members.length === 0) continue
    members.forEach((e) => used.add(e.id))
    const all = members.flatMap((e) => e.photoIds)
    const starts = members
      .map((e) => e.start)
      .filter((d): d is string => !!d)
      .sort()
    const ends = members
      .map((e) => e.end)
      .filter((d): d is string => !!d)
      .sort()
    result.push({
      id: `g:${g.id}`,
      groupId: g.id,
      name: g.name,
      named: true,
      start: starts[0] ?? null,
      end: ends.at(-1) ?? null,
      photoIds: all,
      coverId: members.sort((a, b) => b.photoIds.length - a.photoIds.length)[0].coverId
    })
  }
  result.push(...events.filter((e) => !used.has(e.id)))
  return result.sort((a, b) => (b.start ?? '').localeCompare(a.start ?? ''))
}

// The tools an AI assistant can use through assistant access (spec 0008; best_of and proposals, spec 0009).
// Every result is built field by field from what ADR 0011 allows: capture dates, counts, album
// names, people's names, favourite stars, why a photo matched, Best of reasons and look-alike
// alternatives, and analysis progress, with photos referred to by id. Never a path, file or folder
// name, hash, place, camera, pixel or quality score. Suggested albums stay out: their ids and
// names are folder names.
import type { LibraryDb } from './db.ts'
import type { PhotoSearch } from './photoSearch.ts'
import type { BestOfService } from './bestOfService.ts'
import type { Proposals } from './proposals.ts'
import { MIN_SET } from './bestOf.ts'
import { reasonText } from '../shared/bestOfReasons.ts'
import type { ContentProgress, PhotoFilter } from '../shared/types.ts'

/** An error the assistant should read: a plain sentence saying what to do next. */
export class ToolError extends Error {}

export const INTERNAL_ERROR = "Photo Library couldn't do that: something went wrong inside the app"
export const MAX_IDS = 1000
const MAX_PAGE = 200
const DEFAULT_PAGE = 50
const MAX_NAME = 100
const LISTED_PEOPLE = 50
const MIN_PICK = 6
const MAX_PICK = 200
const MAX_FOCUS = 200
const MAX_ALTERNATIVES = 5
export const PROPOSAL_WAITING =
  "Waiting for the owner in Photo Library. Call proposal_status with this proposal_id to see what they decided; don't make this album yourself."

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

const idList = (what: string) => ({
  type: 'array',
  items: { type: 'integer' },
  maxItems: MAX_IDS,
  description: `Photo ids ${what} (from search_photos), at most ${MAX_IDS} per call.`
})

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'library_overview',
    description:
      "Get your bearings in the owner's photo library in one call: how many photos there are (and how many have no capture date), photos per year, every album (id, name, photo count, first and last capture date; parent_id when it is inside another album; made_by_you: true for albums you made), named people with their photo counts, and how far content analysis has got. Call this first. Takes no input. Example: library_overview({}).",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'search_photos',
    description: `Find photos. All inputs are optional and combine (a photo must match all of them); with none, returns every photo, newest first.
- text: works like the app's search box. Dates ("august 2024", "2023") and people's names in it filter; the rest is matched against what the photos show ("beach", "snow", "birthday cake"), best match first. Name matches (album, tag or person names, and the owner's own file organisation) come first.
- from / to: capture dates YYYY-MM-DD, inclusive. Photos with no capture date are left out when either is given.
- people: names from library_overview; each photo shows all of them.
- album_id: only photos in this album.
- offset / limit: paging; limit defaults to ${DEFAULT_PAGE}, at most ${MAX_PAGE}.
Returns total (all matches) first, then the page: per photo its id, capture time (YYYY-MM-DD HH:MM, or null), people, albums, whether it is a favourite (starred by the owner), and why it matched: "name", "content" with its rank (1 = best), or "filter". You never see the photos themselves. Example: search_photos({"text": "beach", "people": ["Jake"], "from": "2024-06-01", "to": "2024-08-31"}).`,
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Free text, as typed into the app\'s search box, e.g. "snow 2023" or "Anna birthday".' },
        from: { type: 'string', description: 'Earliest capture date, YYYY-MM-DD (inclusive).' },
        to: { type: 'string', description: 'Latest capture date, YYYY-MM-DD (inclusive).' },
        people: { type: 'array', items: { type: 'string' }, description: 'Names of people who must all be in each photo.' },
        album_id: { type: 'integer', description: 'Only photos in this album (ids from library_overview).' },
        offset: { type: 'integer', minimum: 0, description: 'How many results to skip, for the next page.' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_PAGE, description: `Page size, default ${DEFAULT_PAGE}.` }
      },
      additionalProperties: false
    }
  },
  {
    name: 'create_album',
    description: `Make a new top-level album, optionally with photos in it. Albums are only records in Photo Library: no file is copied or moved. The name must be 1-${MAX_NAME} characters and not already used by any album (ignoring case); if it is, the error gives that album's id. Returns the album id and name, how many photos were added, and any ids not found (unknown photos are never added). The owner sees it marked as made by an AI assistant until they change it. Example: create_album({"name": "Beach days 2024", "photo_ids": [812, 815, 990]}).`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The album name, as the owner will see it.' },
        photo_ids: idList('to put in the album')
      },
      required: ['name'],
      additionalProperties: false
    }
  },
  {
    name: 'add_to_album',
    description: `Add photos to an album you made with create_album. Albums made or changed by the owner can't be changed. Returns the album id and name, how many were added, ids that were already in it, and ids not found. Adding the same photos again changes nothing. Example: add_to_album({"album_id": 41, "photo_ids": [1002, 1003]}).`,
    inputSchema: {
      type: 'object',
      properties: { album_id: { type: 'integer', description: 'An album you made.' }, photo_ids: idList('to add') },
      required: ['album_id', 'photo_ids'],
      additionalProperties: false
    }
  },
  {
    name: 'remove_from_album',
    description: `Remove photos from an album you made with create_album (the photos themselves stay in the library). Albums made or changed by the owner can't be changed. Returns the album id and name, how many were removed, ids that weren't in it, and ids not found. Example: remove_from_album({"album_id": 41, "photo_ids": [815]}).`,
    inputSchema: {
      type: 'object',
      properties: { album_id: { type: 'integer', description: 'An album you made.' }, photo_ids: idList('to remove') },
      required: ['album_id', 'photo_ids'],
      additionalProperties: false
    }
  },
  {
    name: 'best_of',
    description: `Ask Photo Library to choose the best photos of an album, as its Best of screen does: it sees the photos (sharpness, exposure, faces, what they show), so its pick is better than one made from dates and names. It leaves out near-identical shots, spreads the pick over the album's moments, includes the named people who appear, and prefers the owner's stars. Reading never changes the album.
- album_id: any album from library_overview (the owner's or yours). For a year, a date range or a person's photos, first find them with search_photos, make an album of them with create_album, then run best_of on that album. Suggested albums aren't available: find their photos with search_photos instead.
- count: how many, ${MIN_PICK}-${MAX_PICK}; by default about 10% of the album (12 to 60).
- focus: words to lean towards, as in the app's "Focus on…" box (at most ${MAX_FOCUS} characters), e.g. "the kids" or "food".
- include / exclude: photo ids that must be in the pick, or must never be, at most ${MAX_IDS} each. Use them to adjust a pick when the owner asks ("not that one", "keep this one").
Returns the album, its photo count, the count used and the default, how many moments it has, any notes, then the photos in capture-time order: id, capture time, people, albums, favorite, a reason (why it was picked, in the app's words), and alternatives: up to ${MAX_ALTERNATIVES} ids of near-identical shots that weren't picked, best first, to swap in. To show the owner the pick for approval, pass the ids to propose_selection. Example: best_of({"album_id": 41, "count": 30, "focus": "the beach"}).`,
    inputSchema: {
      type: 'object',
      properties: {
        album_id: { type: 'integer', description: 'The album to choose from (ids from library_overview).' },
        count: { type: 'integer', minimum: MIN_PICK, maximum: MAX_PICK, description: 'How many photos to pick.' },
        focus: { type: 'string', maxLength: MAX_FOCUS, description: 'Words to lean towards, e.g. "sunsets".' },
        include: idList('that must be in the pick'),
        exclude: idList('that must never be picked')
      },
      required: ['album_id'],
      additionalProperties: false
    }
  },
  {
    name: 'propose_selection',
    description: `Show the owner a pick of an album's photos in Photo Library for them to review: the app comes forward on its Best of screen with exactly these photos. The owner swaps, removes or adds photos and decides there; only they can keep it, by pressing Make album, which makes their own album "Best of <album name>". Returns at once with a proposal_id, without waiting for the owner. Call proposal_status with it later to learn what they decided. Don't make the same album yourself with create_album. photo_ids: ${MIN_PICK}-${MAX_PICK} ids of photos in that album (from best_of or search_photos); for fewer than ${MIN_PICK}, use create_album. A new proposal replaces one the owner hasn't decided on. Example: propose_selection({"album_id": 41, "photo_ids": [812, 815, 990, 1002, 1010, 1044]}).`,
    inputSchema: {
      type: 'object',
      properties: {
        album_id: { type: 'integer', description: 'The album the photos are from.' },
        photo_ids: { type: 'array', items: { type: 'integer' }, minItems: MIN_PICK, maxItems: MAX_PICK, description: 'The photos to propose.' }
      },
      required: ['album_id', 'photo_ids'],
      additionalProperties: false
    }
  },
  {
    name: 'proposal_status',
    description: `What the owner decided about a proposal from propose_selection. status is one of: "waiting" (still showing in Photo Library; edited: true once they've changed it), "approved" (they made an album from it: its album_id, name and photo count, how many of your photos they kept, and the ids they added and removed), "closed" (they left it without making an album), "replaced" (a newer proposal took its place: by_proposal_id), or "expired" (Photo Library quit, or assistant access was turned off or reset). Proposals last until Photo Library is closed. Example: proposal_status({"proposal_id": 3}).`,
    inputSchema: {
      type: 'object',
      properties: { proposal_id: { type: 'integer', description: 'The id propose_selection returned.' } },
      required: ['proposal_id'],
      additionalProperties: false
    }
  }
]

export interface ToolContext {
  db: LibraryDb
  /** This connection's own search, so its paging never disturbs the window's (AC-10). */
  search: PhotoSearch
  contentProgress: () => ContentProgress
  /** Called after an album change, so the window shows it (AC-13). */
  albumsChanged: () => void
  /** The Best of engine, as the window uses it (spec 0009, AC-3). */
  bestOf: BestOfService
  /** Proposals, shared by every connection: one shows at a time (spec 0009, AC-9). */
  proposals: Proposals
}

type Args = Record<string, unknown>

const DATE = /^\d{4}-\d{2}-\d{2}$/

function validDate(v: unknown, field: string): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string' || !DATE.test(v) || Number.isNaN(Date.parse(v + 'T00:00:00Z')) || new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) !== v)
    throw new ToolError(`${field} must be a date written YYYY-MM-DD, e.g. "2024-07-31".`)
  return v
}

function integer(v: unknown, field: string, min: number, max: number): number | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max)
    throw new ToolError(
      max === Number.MAX_SAFE_INTEGER ? `${field} must be a whole number of at least ${min}.` : `${field} must be a whole number from ${min} to ${max}.`
    )
  return v
}

function photoIds(v: unknown, required: boolean, field = 'photo_ids'): number[] {
  if (v === undefined || v === null) {
    if (required) throw new ToolError(`${field} is required: a list of photo ids from search_photos.`)
    return []
  }
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'number' || !Number.isInteger(x)))
    throw new ToolError(`${field} must be a list of photo ids (whole numbers) from search_photos.`)
  if (v.length > MAX_IDS) throw new ToolError(`${field} can hold at most ${MAX_IDS} ids per call; split them over several calls.`)
  return [...new Set(v as number[])]
}

function unknownArgs(args: Args, allowed: string[]): void {
  const extra = Object.keys(args).filter((k) => !allowed.includes(k))
  if (extra.length) throw new ToolError(`Unknown input ${extra.map((k) => `"${k}"`).join(', ')}. This tool takes: ${allowed.join(', ') || 'nothing'}.`)
}

/** 'YYYY-MM-DDTHH:MM:SS' -> 'YYYY-MM-DD HH:MM'. */
const minute = (t: string | null) => (t ? `${t.slice(0, 10)} ${t.slice(11, 16)}` : null)

export class AssistantTools {
  private ctx: ToolContext

  constructor(ctx: ToolContext) {
    this.ctx = ctx
  }

  /** Runs a tool. Throws ToolError for anything the assistant should read. */
  async call(name: string, args: Args = {}): Promise<unknown> {
    if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new ToolError('Tool input must be an object.')
    switch (name) {
      case 'library_overview':
        unknownArgs(args, [])
        return this.overview()
      case 'search_photos':
        unknownArgs(args, ['text', 'from', 'to', 'people', 'album_id', 'offset', 'limit'])
        return this.searchPhotos(args)
      case 'create_album':
        unknownArgs(args, ['name', 'photo_ids'])
        return this.createAlbum(args)
      case 'add_to_album':
        unknownArgs(args, ['album_id', 'photo_ids'])
        return this.change(args, 'add')
      case 'remove_from_album':
        unknownArgs(args, ['album_id', 'photo_ids'])
        return this.change(args, 'remove')
      case 'best_of':
        unknownArgs(args, ['album_id', 'count', 'focus', 'include', 'exclude'])
        return this.bestOf(args)
      case 'propose_selection':
        unknownArgs(args, ['album_id', 'photo_ids'])
        return this.propose(args)
      case 'proposal_status':
        unknownArgs(args, ['proposal_id'])
        return this.proposalStatus(args)
      default:
        throw new ToolError(`There is no tool called "${name}". The tools are: ${TOOL_DEFINITIONS.map((t) => t.name).join(', ')}.`)
    }
  }

  private analysisNote(): { note?: string; done: number; total: number } {
    const p = this.ctx.contentProgress()
    if (p.phase === 'unavailable') return { note: 'content search is unavailable; only name matches are listed', done: p.done, total: p.total }
    if (p.done < p.total) return { note: `content search covers ${p.done} of ${p.total} photos so far`, done: p.done, total: p.total }
    return { done: p.done, total: p.total }
  }

  private overview(): unknown {
    const { db } = this.ctx
    const counts = db.counts()
    const people = db.listPeople().map((p) => ({ name: p.name, photos: p.photoCount }))
    const analysis = this.analysisNote()
    // parent_id and made_by_you only when set: the overview of a big library stays small (AC-15).
    const albums = db.albumsOverview().map((a) => ({
      id: a.id,
      name: a.name,
      ...(a.parentId != null ? { parent_id: a.parentId } : {}),
      photos: a.photoCount,
      first: a.first?.slice(0, 10) ?? null,
      last: a.last?.slice(0, 10) ?? null,
      ...(a.madeByAssistant ? { made_by_you: true } : {})
    }))
    return {
      photos: counts.photoCount,
      undated: counts.undatedCount,
      ...(counts.photoCount === 0 ? { note: 'No photos yet: choose a photo folder in Photo Library' } : {}),
      per_year: db.photosPerYear(),
      albums,
      people,
      content_analysis:
        this.ctx.contentProgress().phase === 'unavailable'
          ? 'unavailable'
          : analysis.total === 0 && counts.photoCount > 0
            ? 'not started yet'
            : `analysed ${analysis.done} of ${analysis.total}`
    }
  }

  private async searchPhotos(args: Args): Promise<unknown> {
    const { db } = this.ctx
    if (args.text !== undefined && typeof args.text !== 'string') throw new ToolError('text must be a string, e.g. "beach 2024".')
    const text = (args.text as string | undefined)?.trim() || undefined
    const from = validDate(args.from, 'from')
    const to = validDate(args.to, 'to')
    if (from && to && from > to) throw new ToolError(`from (${from}) is after to (${to}); swap them.`)
    const limit = integer(args.limit, 'limit', 1, MAX_PAGE) ?? DEFAULT_PAGE
    const offset = integer(args.offset, 'offset', 0, Number.MAX_SAFE_INTEGER) ?? 0
    const filter: PhotoFilter = { text, from, to, offset, limit }

    if (args.people !== undefined) {
      if (!Array.isArray(args.people) || args.people.some((n) => typeof n !== 'string'))
        throw new ToolError('people must be a list of names, e.g. ["Jake", "Anna"].')
      const named = db.listPeople()
      filter.personIds = (args.people as string[]).map((n) => {
        const p = named.find((x) => x.name.toLowerCase() === n.trim().toLowerCase())
        if (p) return p.id
        const list = named.slice(0, LISTED_PEOPLE).map((x) => x.name)
        throw new ToolError(
          named.length
            ? `No person named "${n}". Named people: ${list.join(', ')}${named.length > LISTED_PEOPLE ? ', …' : ''}.`
            : `No person named "${n}": nobody has been named in Photo Library yet.`
        )
      })
    }
    if (args.album_id !== undefined) {
      const id = integer(args.album_id, 'album_id', 1, Number.MAX_SAFE_INTEGER)!
      if (!db.albumInfo(id)) throw new ToolError(`There is no album with id ${id}. library_overview lists the albums.`)
      filter.albumId = id
    }

    const page = await this.ctx.search.query(filter)
    const facts = db.peopleAndAlbums(page.photos.map((p) => p.id))
    const nameMatches = page.search ? page.search.nameMatches : text ? page.total : 0
    const photos = page.photos.map((p, i) => {
      const at = offset + i
      const f = facts.get(p.id)!
      return {
        id: p.id,
        taken: minute(p.takenAt),
        people: f.people,
        albums: f.albums,
        favorite: p.favorite,
        match: !text ? 'filter' : at < nameMatches ? 'name' : { content: at - nameMatches + 1 }
      }
    })
    const analysis = page.search?.phrase ? this.analysisNote() : {}
    return { total: page.total, offset, ...('note' in analysis && analysis.note ? { note: analysis.note } : {}), photos }
  }

  private albumName(v: unknown): string {
    if (typeof v !== 'string') throw new ToolError(`name must be text, 1-${MAX_NAME} characters.`)
    const name = v.trim()
    if (!name || name.length > MAX_NAME) throw new ToolError(`name must be 1-${MAX_NAME} characters (after trimming spaces).`)
    return name
  }

  private createAlbum(args: Args): unknown {
    const { db } = this.ctx
    const name = this.albumName(args.name)
    const ids = photoIds(args.photo_ids, false)
    const existing = db.albumNamed(name)
    if (existing)
      throw new ToolError(`An album called "${existing.name}" already exists (id ${existing.id}). Choose another name, or use that album if you made it.`)
    const present = db.presentPhotoIds(ids)
    const add = ids.filter((id) => present.has(id))
    const id = db.createAssistantAlbum(name, add)
    this.ctx.albumsChanged()
    return { album_id: id, name, added: add.length, not_found: ids.filter((i) => !present.has(i)) }
  }

  private change(args: Args, change: 'add' | 'remove'): unknown {
    const { db } = this.ctx
    const albumId = integer(args.album_id, 'album_id', 1, Number.MAX_SAFE_INTEGER)
    if (albumId === undefined) throw new ToolError('album_id is required: the id create_album returned.')
    const ids = photoIds(args.photo_ids, true)
    const result = db.transaction(() => {
      const album = db.albumInfo(albumId)
      if (!album) throw new ToolError(`There is no album with id ${albumId}. library_overview lists the albums.`)
      if (!album.madeByAssistant) throw new ToolError("That album is the owner's; you can only change albums you made")
      const present = db.presentPhotoIds(ids)
      const inAlbum = db.idsInAlbum(albumId, ids)
      const found = ids.filter((i) => present.has(i))
      const notFound = ids.filter((i) => !present.has(i))
      if (change === 'add') {
        const add = found.filter((i) => !inAlbum.has(i))
        db.assistantAlbumChange(albumId, add, 'add')
        return { album_id: albumId, name: album.name, added: add.length, already_there: found.filter((i) => inAlbum.has(i)), not_found: notFound }
      }
      // Removing works on any photo in the album, even one that has since gone missing.
      const remove = ids.filter((i) => inAlbum.has(i))
      db.assistantAlbumChange(albumId, remove, 'remove')
      return {
        album_id: albumId,
        name: album.name,
        removed: remove.length,
        not_there: found.filter((i) => !inAlbum.has(i)),
        not_found: notFound.filter((i) => !inAlbum.has(i))
      }
    })
    this.ctx.albumsChanged()
    return result
  }

  /** An album the assistant may read: any album, the owner's or its own. */
  private album(v: unknown): { id: number; name: string } {
    const id = integer(v, 'album_id', 1, Number.MAX_SAFE_INTEGER)
    if (id === undefined) throw new ToolError('album_id is required: an album id from library_overview.')
    const album = this.ctx.db.albumInfo(id)
    if (!album) throw new ToolError(`There is no album with id ${id}. library_overview lists the albums.`)
    return { id, name: album.name }
  }

  private async bestOf(args: Args): Promise<unknown> {
    const { db } = this.ctx
    const album = this.album(args.album_id)
    const requested = integer(args.count, 'count', MIN_PICK, MAX_PICK)
    if (args.focus !== undefined && args.focus !== null && typeof args.focus !== 'string')
      throw new ToolError('focus must be text, e.g. "the beach", at most 200 characters.')
    if (typeof args.focus === 'string' && args.focus.length > MAX_FOCUS) throw new ToolError(`focus must be at most ${MAX_FOCUS} characters.`)
    const focus = typeof args.focus === 'string' ? args.focus.trim() : ''
    if (focus.length > MAX_FOCUS) throw new ToolError(`focus must be at most ${MAX_FOCUS} characters.`)
    const include = photoIds(args.include, false, 'include')
    const exclude = photoIds(args.exclude, false, 'exclude')
    const both = include.filter((id) => exclude.includes(id))
    if (both.length) throw new ToolError(`Photo ${both.join(', ')} is in both include and exclude; keep it in only one.`)

    const inAlbum = new Set(db.albumPhotoIds(album.id))
    const notInAlbum = [...include, ...exclude].filter((id) => !inAlbum.has(id))
    const fixed = include.filter((id) => inAlbum.has(id))
    const excluded = exclude.filter((id) => inAlbum.has(id))
    const notes: string[] = []
    const total = inAlbum.size
    if (total < MIN_SET) {
      notes.push(`This album has only ${total} ${total === 1 ? 'photo' : 'photos'}, too few to choose from: use them all, or search_photos for more.`)
      return {
        album_id: album.id,
        name: album.name,
        total,
        too_few: true,
        notes,
        ...(notInAlbum.length ? { not_in_album: notInAlbum } : {}),
        photos: []
      }
    }
    if (fixed.length > MAX_PICK) throw new ToolError(`include can hold at most ${MAX_PICK} photos of the album, the most best_of picks.`)
    // More include ids than the count raise the count to fit them (AC-2).
    const source = { kind: 'album' as const, id: album.id }
    const ask = (count: number | undefined) => this.ctx.bestOf.get({ source, count, focus: focus || undefined, fixed, exclude: excluded })
    let result = await ask(requested)
    if (fixed.length > result.count) {
      notes.push(`count was raised to ${fixed.length} to fit every photo in include.`)
      result = await ask(fixed.length)
    }
    if (result.pending.done < result.pending.total)
      notes.push(
        `Quality is measured for ${result.pending.done} of ${result.pending.total} photos so far; the pick will improve as Photo Library reads the rest.`
      )
    if (result.focusUnavailable) notes.push('focus is unavailable until content analysis is ready; the pick ignores it.')

    const ids = result.photos.map((p) => p.id)
    const picked = new Set(ids)
    const excludedSet = new Set(excluded)
    const facts = db.peopleAndAlbums(ids)
    const photos = result.photos.map((p) => {
      const f = facts.get(p.id)!
      const r = result.reasons[p.id]
      const group = result.groups.find((g) => g.includes(p.id))
      const alternatives = (group ?? []).filter((id) => !picked.has(id) && !excludedSet.has(id)).slice(0, MAX_ALTERNATIVES)
      return {
        id: p.id,
        taken: minute(p.takenAt),
        people: f.people,
        albums: f.albums,
        favorite: p.favorite,
        reason: !r || r.kind === 'yours' ? 'Included as you asked' : reasonText(r),
        ...(alternatives.length ? { alternatives } : {})
      }
    })
    return {
      album_id: album.id,
      name: album.name,
      total: result.total,
      count: result.count,
      default_count: result.defaultCount,
      moments: result.momentCount,
      ...(notes.length ? { notes } : {}),
      ...(notInAlbum.length ? { not_in_album: notInAlbum } : {}),
      photos
    }
  }

  private propose(args: Args): unknown {
    const { db } = this.ctx
    const album = this.album(args.album_id)
    if (Array.isArray(args.photo_ids) && args.photo_ids.length > MAX_IDS) throw new ToolError(`A proposal can hold at most ${MAX_PICK} photos; choose fewer.`)
    const ids = photoIds(args.photo_ids, true)
    if (ids.length > MAX_PICK) throw new ToolError(`A proposal can hold at most ${MAX_PICK} photos; choose fewer.`)
    const inAlbum = new Set(db.albumPhotoIds(album.id))
    const chosen = ids.filter((id) => inAlbum.has(id))
    const notInAlbum = ids.filter((id) => !inAlbum.has(id))
    if (chosen.length < MIN_PICK || inAlbum.size < MIN_SET) {
      const why = notInAlbum.length ? ` ${notInAlbum.length} of the ids given aren't photos of this album.` : ''
      throw new ToolError(`A proposal needs at least ${MIN_PICK} photos of the album; for fewer, use create_album.${why}`)
    }
    const p = this.ctx.proposals.propose(album.id, album.name, chosen)
    return {
      proposal_id: p.id,
      album_id: album.id,
      name: album.name,
      photos: chosen.length,
      not_in_album: notInAlbum,
      status: 'waiting',
      message: PROPOSAL_WAITING
    }
  }

  private proposalStatus(args: Args): unknown {
    const id = integer(args.proposal_id, 'proposal_id', 1, Number.MAX_SAFE_INTEGER)
    if (id === undefined) throw new ToolError('proposal_id is required: the id propose_selection returned.')
    const p = this.ctx.proposals.get(id)
    if (!p) throw new ToolError(`No proposal with id ${id}. Proposals last until Photo Library is closed.`)
    const base = { proposal_id: p.id, album_id: p.albumId, status: p.status }
    switch (p.status) {
      case 'waiting':
        return { ...base, edited: p.edited }
      case 'approved': {
        const made = p.approved!
        const proposed = new Set(p.photoIds)
        const inMade = new Set(made.photoIds)
        return {
          proposal_id: p.id,
          status: p.status,
          album_id: made.albumId,
          name: made.name,
          photos: made.photoIds.length,
          kept: made.photoIds.filter((x) => proposed.has(x)).length,
          added: made.photoIds.filter((x) => !proposed.has(x)),
          removed: p.photoIds.filter((x) => !inMade.has(x))
        }
      }
      case 'replaced':
        return { ...base, by_proposal_id: p.by }
      default:
        return base
    }
  }
}

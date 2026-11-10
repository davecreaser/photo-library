// The five tools an AI assistant can use through assistant access (spec 0008).
// Every result is built field by field from what ADR 0011 allows: capture dates, counts, album
// names, people's names, favourite stars, why a photo matched and analysis progress, with photos
// referred to by id. Never a path, file or folder name, hash, place, camera or pixel.
import type { LibraryDb } from './db.ts'
import type { PhotoSearch } from './photoSearch.ts'
import type { ContentProgress, PhotoFilter } from '../shared/types.ts'

/** An error the assistant should read: a plain sentence saying what to do next. */
export class ToolError extends Error {}

export const INTERNAL_ERROR = "Photo Library couldn't do that: something went wrong inside the app"
export const MAX_IDS = 1000
const MAX_PAGE = 200
const DEFAULT_PAGE = 50
const MAX_NAME = 100
const LISTED_PEOPLE = 50

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
  }
]

export interface ToolContext {
  db: LibraryDb
  /** This connection's own search, so its paging never disturbs the window's (AC-10). */
  search: PhotoSearch
  contentProgress: () => ContentProgress
  /** Called after an album change, so the window shows it (AC-13). */
  albumsChanged: () => void
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
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new ToolError(`${field} must be a whole number from ${min} to ${max}.`)
  return v
}

function photoIds(v: unknown, required: boolean): number[] {
  if (v === undefined || v === null) {
    if (required) throw new ToolError('photo_ids is required: a list of photo ids from search_photos.')
    return []
  }
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'number' || !Number.isInteger(x)))
    throw new ToolError('photo_ids must be a list of photo ids (whole numbers) from search_photos.')
  if (v.length > MAX_IDS) throw new ToolError(`photo_ids can hold at most ${MAX_IDS} ids per call; split them over several calls.`)
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
      content_analysis: this.ctx.contentProgress().phase === 'unavailable' ? 'unavailable' : `analysed ${analysis.done} of ${analysis.total}`
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
}

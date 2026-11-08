// Best of for an album or suggested album (spec 0006): gathers what bestOf.ts needs from the
// database and the content model. Computed on demand; nothing about a pick is stored until the
// user makes an album from it.
import type { LibraryDb } from './db.ts'
import type { Organiser } from './organiser.ts'
import type { PhotoSearch } from './photoSearch.ts'
import { CONTENT_MIN_SCORE, CONTENT_MODEL_VERSION } from './contentModel.ts'
import { QUALITY_VERSION } from './quality.ts'
import { bestOf, defaultCount, lookalikeGroups, MIN_COUNT, MIN_SET, tasteDirection, MIN_STARS_FOR_TASTE } from './bestOf.ts'
import type { Album, BestOfRequest, BestOfSource, BestOfView } from '../shared/types.ts'

export class BestOfService {
  private db: LibraryDb
  private organiser: Organiser
  private search: PhotoSearch

  constructor(db: LibraryDb, organiser: Organiser, search: PhotoSearch) {
    this.db = db
    this.organiser = organiser
    this.search = search
  }

  private resolve(source: BestOfSource): { ids: number[]; name: string; albumId: number | null } {
    if (source.kind === 'album') {
      return { ids: this.db.albumPhotoIds(source.id), name: this.db.albumName(source.id) ?? 'album', albumId: source.id }
    }
    const group = this.organiser.suggestionGroup(source.id)
    return { ids: group?.photoIds ?? [], name: group?.name ?? 'suggestion', albumId: null }
  }

  leanTowardsStars(): { on: boolean; stars: number; enough: boolean } {
    const stars = this.db.starredVectors().length
    return { on: this.db.getSetting('leanTowardsStars') !== 'off', stars, enough: stars >= MIN_STARS_FOR_TASTE }
  }

  setLeanTowardsStars(on: boolean): void {
    this.db.setSetting('leanTowardsStars', on ? 'on' : 'off')
  }

  async get(req: BestOfRequest): Promise<BestOfView> {
    const { ids, name, albumId } = this.resolve(req.source)
    const photos = this.db.bestOfInputs(ids, albumId, QUALITY_VERSION)
    const total = photos.length
    const dflt = defaultCount(total)
    const count = Math.max(Math.min(MIN_COUNT, total), Math.min(total, Math.round(req.count ?? dflt)))
    const pending = { done: photos.filter((p) => p.quality !== undefined).length, total }
    const base: BestOfView = {
      name,
      total,
      count,
      defaultCount: dflt,
      tooFew: total < MIN_SET,
      photos: [],
      reasons: {},
      momentCount: 0,
      groups: [],
      pending,
      focusUnavailable: false
    }
    if (total < MIN_SET) return base

    let focus: { phrase: string; scores: Map<number, number> } | null = null
    const phrase = req.focus?.trim()
    if (phrase) {
      const vector = await this.search.phraseVector(phrase)
      if (vector) focus = { phrase, scores: this.db.contentScores(vector, CONTENT_MODEL_VERSION, CONTENT_MIN_SCORE) }
      else base.focusUnavailable = true
    }
    const taste = this.leanTowardsStars().on ? tasteDirection(this.db.starredVectors()) : null
    const result = await bestOf(photos, {
      count,
      people: this.db.libraryPeople(),
      focus,
      taste,
      fixed: new Set(req.fixed ?? []),
      exclude: new Set(req.exclude ?? [])
    })
    const picked = new Set(result.picks.map((p) => p.id))
    return {
      ...base,
      photos: this.db.photosByIds(result.picks.map((p) => p.id)),
      reasons: Object.fromEntries(result.picks.map((p) => [p.id, p.reason])),
      momentCount: result.momentCount,
      groups: result.groups.filter((g) => g.some((id) => picked.has(id)))
    }
  }

  async lookalikes(source: BestOfSource): Promise<number[][]> {
    const { ids, albumId } = this.resolve(source)
    const photos = this.db.bestOfInputs(ids, albumId, QUALITY_VERSION)
    return (await bestOf(photos, { count: 0, people: new Map() })).groups
  }

  /** Makes "Best of <name>" (numbered if taken), nested under the source album; never overwrites. */
  makeAlbum(source: BestOfSource, photoIds: number[]): Album {
    const { name, albumId, ids } = this.resolve(source)
    const inSource = new Set(ids)
    const chosen = photoIds.filter((id) => inSource.has(id))
    const existing = new Set(this.db.listAlbums().map((a) => a.name.toLowerCase()))
    const base = `Best of ${name}`
    let candidate = base
    for (let n = 2; existing.has(candidate.toLowerCase()); n++) candidate = `${base} ${n}`
    return this.db.transaction(() => {
      const album = this.db.createAlbum(candidate, albumId)
      this.db.addToAlbum(album.id, chosen)
      return { ...album, photoCount: this.db.albumPhotoIds(album.id).length }
    })
  }
}

export { lookalikeGroups }

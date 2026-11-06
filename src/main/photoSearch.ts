// Search (spec 0002): a search's results are its name matches (folder/file names, albums, tags,
// people, as before), in date order, then its content matches: photos that look like the
// content phrase, best first, each photo once. Dates and people's names filter both; with no
// content phrase left, results are exactly the name matches.
import type { LibraryDb } from './db.ts'
import { CONTENT_MIN_SCORE, CONTENT_MODEL_VERSION, type ContentModel } from './contentModel.ts'
import type { PhotoFilter, PhotoPage } from '../shared/types.ts'

/** Phrases whose vectors are kept, so typing back and forth doesn't re-run the text model. */
const PHRASE_CACHE = 100

export class PhotoSearch {
  private db: LibraryDb
  private model: () => Promise<ContentModel | null>
  private phrases = new Map<string, Float32Array>()
  /**
   * The content matches of the last search, computed with its first page and reused for later
   * pages, so photos analysed meanwhile can't make paging repeat or skip one (AC-1). Searching
   * again from the top (a new search, or Refresh results) recomputes it.
   */
  private ranked: { key: string; ids: number[] } | null = null

  constructor(db: LibraryDb, model: () => Promise<ContentModel | null>) {
    this.db = db
    this.model = model
  }

  async query(filter: PhotoFilter, eventPhotoIds?: number[]): Promise<PhotoPage> {
    if (!filter.text) return this.db.queryPhotos(filter, eventPhotoIds)
    const plan = this.db.searchPlan(filter.text)
    const offset = filter.offset ?? 0
    const limit = filter.limit ?? 200
    const names = this.db.queryPhotos(filter, eventPhotoIds)
    if (!plan.phrase) return { ...names, search: { phrase: null, nameMatches: names.total, contentMatches: 0 } }

    const key = JSON.stringify({ ...filter, offset: undefined, limit: undefined, eventPhotoIds })
    if (offset === 0 || this.ranked?.key !== key) {
      const vector = await this.phraseVector(plan.phrase)
      const ids = vector ? this.db.contentMatches(filter, eventPhotoIds, plan, { vector, version: CONTENT_MODEL_VERSION, minScore: CONTENT_MIN_SCORE }) : []
      this.ranked = { key, ids }
    }
    const ids = this.ranked.ids
    const from = Math.max(0, offset - names.total)
    const more = this.db.photosByIds(ids.slice(from, from + limit - names.photos.length))
    return {
      photos: [...names.photos, ...more],
      total: names.total + ids.length,
      search: { phrase: plan.phrase, nameMatches: names.total, contentMatches: ids.length }
    }
  }

  private async phraseVector(phrase: string): Promise<Float32Array | null> {
    const cached = this.phrases.get(phrase)
    if (cached) return cached
    const model = await this.model()
    if (!model) return null
    const vector = await model.embedText(phrase)
    this.phrases.set(phrase, vector)
    if (this.phrases.size > PHRASE_CACHE) this.phrases.delete(this.phrases.keys().next().value!)
    return vector
  }
}

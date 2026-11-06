// Automatic organisation on top of the database: suggested albums (spec 0001) and
// clock-correction suggestions. Detected groups are cached and recomputed after scans or corrections.
import type { LibraryDb } from './db.ts'
import { detectClockErrors, type Suggestion } from './dates.ts'
import { applyGroups, detectEvents, type DetectedEvent } from './events.ts'
import { DEFAULT_MIN_BURST, isCandidate, parseMinBurstSize, selectSuggestions } from './suggestions.ts'
import type { Album, ClockCorrection, ClockSuggestion, DismissedSuggestion, SuggestedAlbum } from '../shared/types.ts'

export class Organiser {
  private db: LibraryDb
  /** Detected groups (named folders and bursts), before the user's decisions are applied. */
  private groupsCache: DetectedEvent[] | null = null

  constructor(db: LibraryDb) {
    this.db = db
  }

  /** Call after anything that changes dates, locations, favourites or albums. */
  invalidate(): void {
    this.groupsCache = null
  }

  private basePath(): string {
    return this.db.getSetting('basePath') ?? ''
  }

  private groups(): DetectedEvent[] {
    if (!this.groupsCache) {
      const detected = detectEvents(this.db.photosForOrganising(this.basePath()))
      this.convertOldMerges(detected)
      this.groupsCache = detected
    }
    return this.groupsCache
  }

  /**
   * Before suggested albums, users could merge and rename events. Each merge not
   * already (mostly) saved as an album becomes one, once (spec 0001, AC-9).
   */
  private convertOldMerges(detected: DetectedEvent[]): void {
    const merges = this.db.eventGroups()
    if (merges.length === 0) return
    this.db.transaction(() => {
      const albums = this.db.albumPhotoSets()
      for (const merged of applyGroups(detected, merges).filter((e) => e.groupId !== undefined)) {
        if (selectSuggestions([merged], 1, [], albums).length > 0) {
          const album = this.db.createAlbum(merged.name, null)
          this.db.addToAlbum(album.id, merged.photoIds)
          albums.push({ id: album.id, photoIds: merged.photoIds })
        }
      }
      merges.forEach((m) => this.db.deleteEventGroup(m.id))
    })
  }

  getMinBurstSize(): number {
    return parseMinBurstSize(this.db.getSetting('minBurstSize')) ?? DEFAULT_MIN_BURST
  }

  /** Returns false (and changes nothing) for values outside 1–1,000. */
  setMinBurstSize(value: unknown): boolean {
    const n = parseMinBurstSize(value)
    if (n === null) return false
    this.db.setSetting('minBurstSize', String(n))
    return true
  }

  private visible(): DetectedEvent[] {
    return selectSuggestions(this.groups(), this.getMinBurstSize(), this.db.decisionPhotoSets(), this.db.albumPhotoSets())
  }

  listSuggestions(): SuggestedAlbum[] {
    return this.visible().map(({ id, name, named, start, end, photoIds, coverId }) => ({ id, name, named, start, end, count: photoIds.length, coverId }))
  }

  /** A suggestion's photos, in capture-time order; empty if it no longer exists. */
  suggestionPhotoIds(id: string): number[] {
    return this.groups().find((g) => g.id === id)?.photoIds ?? []
  }

  /** Makes one album from one or more suggestions (accept, or combine). Atomic. */
  acceptSuggestions(ids: string[], name: string): Album {
    const clean = name.trim()
    if (!clean) throw new Error('An album needs a name.')
    const chosen = this.groups().filter((g) => ids.includes(g.id))
    if (chosen.length === 0) throw new Error('Those suggestions are no longer here.')
    return this.db.transaction(() => {
      const album = this.db.createAlbum(clean, null)
      const photoIds = [...new Set(chosen.flatMap((g) => g.photoIds))]
      this.db.addToAlbum(album.id, photoIds)
      for (const g of chosen) this.db.recordDecision('accepted', g.name, g.photoIds, album.id)
      return { ...album, photoCount: photoIds.length }
    })
  }

  /** Dismisses suggestions; returns the decision ids, for undo. */
  dismissSuggestions(ids: string[]): number[] {
    const chosen = this.groups().filter((g) => ids.includes(g.id))
    return this.db.transaction(() => chosen.map((g) => this.db.recordDecision('dismissed', g.name, g.photoIds, null)))
  }

  /** Undo or Restore: the dismissed suggestions are listed again. */
  restoreDismissed(decisionIds: number[]): void {
    this.db.transaction(() => decisionIds.forEach((id) => this.db.deleteDecision(id)))
  }

  /** Dismissed suggestions, newest first, noting ones that wouldn't be suggested even if restored. */
  listDismissed(): DismissedSuggestion[] {
    const min = this.getMinBurstSize()
    const albums = this.db.albumPhotoSets()
    const sets = new Map(this.db.decisionPhotoSets().map((d) => [d.id, d.photoIds]))
    return this.db.listDismissed().map((d) => {
      const photos = new Set(sets.get(d.id) ?? [])
      const group = this.groups().find((g) => g.photoIds.filter((p) => photos.has(p)).length * 2 >= g.photoIds.length && g.photoIds.length > 0)
      let note: DismissedSuggestion['note'] = null
      if (!group || !isCandidate(group, min)) note = 'below-minimum'
      else if (selectSuggestions([group], min, [], albums).length === 0) note = 'in-album'
      return { ...d, note }
    })
  }

  // --- clock corrections ---

  private dismissed(): string[] {
    return JSON.parse(this.db.getSetting('dismissedClockSuggestions') ?? '[]') as string[]
  }

  private allSuggestions(): (Suggestion & { key: string })[] {
    const photos = this.db
      .photosForOrganising(this.basePath())
      .filter((p) => p.takenAtRaw)
      .map((p) => ({ camera: p.camera, raw: p.takenAtRaw!, dirs: p.dirs }))
    return detectClockErrors(photos).map((s) => ({ ...s, key: `${s.camera}|${s.offsetYears}|${s.appliesBefore ?? 'all'}` }))
  }

  suggestions(): ClockSuggestion[] {
    const dismissed = new Set(this.dismissed())
    const existing = this.db.corrections()
    return this.allSuggestions()
      .filter((s) => !dismissed.has(s.key))
      .filter((s) => !existing.some((c) => c.camera === s.camera && c.appliesBefore === s.appliesBefore && c.offsetYears === s.offsetYears))
      .map(({ key, camera, offsetYears, appliesBefore, photoCount, evidence }) => ({ key, camera, offsetYears, appliesBefore, photoCount, evidence }))
  }

  applySuggestion(key: string): void {
    const s = this.allSuggestions().find((s) => s.key === key)
    if (!s) return
    this.addCorrection({ camera: s.camera, appliesBefore: s.appliesBefore, offsetYears: s.offsetYears, offsetSeconds: s.offsetSeconds })
  }

  dismissSuggestion(key: string): void {
    this.db.setSetting('dismissedClockSuggestions', JSON.stringify([...new Set([...this.dismissed(), key])]))
  }

  listCorrections(): ClockCorrection[] {
    return this.db.corrections().map((c) => ({ ...c, photoCount: this.db.correctionPhotoCount(c) }))
  }

  addCorrection(c: Omit<ClockCorrection, 'id' | 'photoCount'>): void {
    this.db.addCorrection(c)
    this.db.refreshDerived()
    this.invalidate()
  }

  removeCorrection(id: number): void {
    this.db.removeCorrection(id)
    this.db.refreshDerived()
    this.invalidate()
  }
}

// Automatic organisation on top of the database: events and clock-correction
// suggestions. Results are cached and recomputed after scans or corrections.
import type { LibraryDb } from './db.ts'
import { detectClockErrors, type Suggestion } from './dates.ts'
import { applyGroups, detectEvents, type DetectedEvent } from './events.ts'
import type { Album, ClockCorrection, ClockSuggestion, PhotoEvent } from '../shared/types.ts'

export class Organiser {
  private db: LibraryDb
  private events: DetectedEvent[] | null = null

  constructor(db: LibraryDb) {
    this.db = db
  }

  /** Call after anything that changes dates, locations or favourites. */
  invalidate(): void {
    this.events = null
  }

  private basePath(): string {
    return this.db.getSetting('basePath') ?? ''
  }

  private detected(): DetectedEvent[] {
    this.events ??= applyGroups(detectEvents(this.db.photosForOrganising(this.basePath())), this.db.eventGroups())
    return this.events
  }

  listEvents(): PhotoEvent[] {
    return this.detected().map(({ photoIds, groupId, ...e }) => ({ ...e, count: photoIds.length, custom: groupId !== undefined }))
  }

  eventPhotoIds(eventId: string): number[] {
    return this.detected().find((e) => e.id === eventId)?.photoIds ?? []
  }

  /**
   * Merges events into one (e.g. three days of a holiday), or renames one event when
   * given a single id. Merging an already-merged event folds its members in.
   * Returns the new event's id.
   */
  mergeEvents(eventIds: string[], name: string): string {
    const events = this.detected().filter((e) => eventIds.includes(e.id))
    if (events.length === 0) return eventIds[0]
    const groups = this.db.eventGroups()
    const members = events.flatMap((e) => (e.groupId ? groups.find((g) => g.id === e.groupId)!.members : [e.id]))
    for (const e of events) if (e.groupId) this.db.deleteEventGroup(e.groupId)
    const starts = events.map((e) => e.start).filter((d): d is string => !!d).sort()
    const ends = events.map((e) => e.end).filter((d): d is string => !!d).sort()
    const id = this.db.addEventGroup({ name, start: starts[0] ?? null, end: ends.at(-1) ?? null, members })
    this.invalidate()
    return `g:${id}`
  }

  /** Undoes a merge/rename: its events go back to being detected automatically. */
  ungroupEvent(eventId: string): void {
    const e = this.detected().find((x) => x.id === eventId)
    if (e?.groupId) this.db.deleteEventGroup(e.groupId)
    this.invalidate()
  }

  saveEventAsAlbum(eventId: string, name: string): Album {
    const album = this.db.createAlbum(name, null)
    this.db.addToAlbum(album.id, this.eventPhotoIds(eventId))
    return { ...album, photoCount: this.eventPhotoIds(eventId).length }
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

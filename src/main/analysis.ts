// Background analysis of photos: faces (people.ts) and content (spec 0002), in one pass that
// reads each photo once, newest first. Each photo's results are saved as soon as it's done, so
// quitting loses nothing; photos are keyed by content (ADR 0002), so moving files costs nothing.
// The two analyses report progress separately (faces with People, content in the top bar).
import type { AnalysisSource, LibraryDb } from './db.ts'
import type { People } from './people.ts'
import type { ImageCache } from './thumbnails.ts'
import { FACE_MODEL_VERSION, type DetectedFace, type FaceAnalyser } from './faces.ts'
import { CONTENT_MODEL_VERSION, ContentModel, ContentModelUnavailable } from './contentModel.ts'
import { decodeForAnalysis, type RgbImage } from './decode.ts'
import type { ContentProgress } from '../shared/types.ts'

const BATCH = 20
/** Progress events at most this often (ms), so a fast pass doesn't flood the window. */
const EMIT_EVERY = 250
/** The time estimate uses the rate over this window (ms). */
const RATE_WINDOW = 120_000

export interface AnalysisOptions {
  db: LibraryDb
  people: People
  images: ImageCache
  modelsDir: string
  /** True in the installed app (changes the fix shown when the model is unavailable). */
  packaged: boolean
  onContentProgress: (p: ContentProgress) => void
}

/**
 * Seconds left at the recent rate: over the last 2 minutes, or since the start if less.
 * Null ("estimating time…") until 20 photos or 15 seconds have been done (spec 0002, Design).
 */
export function estimateSecondsLeft(doneAt: number[], startedAt: number, remaining: number, now: number): number | null {
  if (remaining <= 0) return 0
  if (doneAt.length === 0 || (doneAt.length < 20 && now - startedAt < 15_000)) return null
  const from = Math.max(startedAt, now - RATE_WINDOW)
  const recent = doneAt.filter((t) => t >= from).length
  const elapsed = (now - from) / 1000
  if (recent === 0 || elapsed <= 0) return null
  return remaining / (recent / elapsed)
}

export class Analysis {
  private o: AnalysisOptions
  private running: Promise<void> | null = null
  private again = false
  private model: Promise<ContentModel | null> | null = null
  private progress: ContentProgress
  private lastEmit = 0
  /** When each content analysis this pass finished (within the rate window). */
  private doneAt: number[] = []
  private startedAt = 0

  constructor(options: AnalysisOptions) {
    this.o = options
    this.progress = { phase: 'idle', ...options.db.contentProgress(CONTENT_MODEL_VERSION), upgrading: false, secondsLeft: null, packaged: options.packaged }
  }

  contentProgress(): ContentProgress {
    return this.progress
  }

  /** The content model (for search too), or null when it's unavailable; progress then says why. */
  contentModel(): Promise<ContentModel | null> {
    this.model ??= (async () => {
      if (this.o.db.vectors.loadError) {
        console.error('Content search unavailable: sqlite-vec failed to load:', this.o.db.vectors.loadError)
        this.emit({ phase: 'unavailable', reason: 'failed' }, true)
        return null
      }
      try {
        return await ContentModel.load(this.o.modelsDir)
      } catch (e) {
        console.error('Content search unavailable:', e instanceof Error ? e.message : e)
        this.emit({ phase: 'unavailable', reason: e instanceof ContentModelUnavailable ? e.reason : 'failed' }, true)
        return null
      }
    })()
    return this.model
  }

  /**
   * Analyses any photos that still need it. Safe to call repeatedly (e.g. after every scan): while
   * a pass runs, another follows it. Resolves when no pass is left to run.
   */
  kick(): Promise<void> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      try {
        do {
          this.again = false
          await this.pass()
        } while (this.again)
      } catch (e) {
        console.error('Background analysis stopped:', e)
      } finally {
        this.running = null
      }
    })()
    return this.running
  }

  private async pass(): Promise<void> {
    const faces = await this.o.people.analyser()
    const content = await this.contentModel()
    if (!faces && !content) return
    const versions = { faces: faces ? FACE_MODEL_VERSION : null, content: content ? CONTENT_MODEL_VERSION : null }
    this.doneAt = []
    this.startedAt = Date.now()
    let facesTouched = false
    try {
      for (;;) {
        const batch = this.o.db.photosNeedingAnalysis(versions, BATCH)
        if (batch.length === 0) break
        if (faces && batch.some((p) => p.needsFaces)) {
          facesTouched = true
          this.o.people.analysing()
        }
        if (content && batch.some((p) => p.needsContent)) {
          this.emit({ phase: 'analysing', upgrading: this.o.db.hasOtherContentVersion(CONTENT_MODEL_VERSION) })
        }
        for (const photo of batch) await this.analyse(photo, faces, content)
      }
    } finally {
      if (facesTouched) this.o.people.finished()
      if (content) {
        this.emit({ phase: 'idle', upgrading: false }, true)
        await content.releaseImageEncoder()
      }
    }
  }

  private async analyse(photo: AnalysisSource, faces: FaceAnalyser | null, content: ContentModel | null): Promise<void> {
    const forFaces = !!faces && photo.needsFaces
    const image = await this.decode(photo, forFaces)
    if (forFaces) {
      let found: DetectedFace[] = []
      try {
        if (image) found = await faces.analyseDecoded(image)
      } catch {
        // unreadable: recorded as "no faces" so it isn't retried every time
      }
      await this.o.people.record(photo.id, found)
    }
    if (content && photo.needsContent) {
      let vector: Float32Array | null = null
      try {
        if (image) vector = await content.embedImage(image)
      } catch {
        // unreadable: recorded without a vector so it isn't retried every time
      }
      this.o.db.saveContent(photo.id, vector, CONTENT_MODEL_VERSION)
      const now = Date.now()
      this.doneAt.push(now)
      if (this.doneAt[0] < now - RATE_WINDOW) this.doneAt = this.doneAt.filter((t) => t >= now - RATE_WINDOW)
      this.emit({})
    }
  }

  /** The photo decoded for analysis; formats sharp can't read (HEIC, RAW) via the cached preview; null if unreadable. */
  private async decode(photo: AnalysisSource, forFaces: boolean): Promise<RgbImage | null> {
    try {
      return await decodeForAnalysis(photo.path, forFaces)
    } catch {
      try {
        return await decodeForAnalysis(await this.o.images.get(photo, 'preview'), forFaces)
      } catch {
        return null
      }
    }
  }

  /** Updates progress and tells the window, at most every EMIT_EVERY ms unless the phase changes. */
  private emit(change: Partial<ContentProgress>, force = false): void {
    const now = Date.now()
    if (!force && !change.phase && now - this.lastEmit < EMIT_EVERY) return
    this.lastEmit = now
    const counts = this.o.db.contentProgress(CONTENT_MODEL_VERSION)
    const phase = change.phase ?? this.progress.phase
    this.progress = {
      ...this.progress,
      ...change,
      ...counts,
      secondsLeft: phase === 'analysing' ? estimateSecondsLeft(this.doneAt, this.startedAt, counts.total - counts.done, now) : null
    }
    this.o.onContentProgress(this.progress)
  }
}

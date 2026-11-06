// People: stores face analysis and keeps groups/matches up to date.
// Face thumbnails are written to the app's cache (never next to the photos).
import sharp from 'sharp'
import { join } from 'node:path'
import type { LibraryDb } from './db.ts'
import { FACE_MODEL_VERSION, FaceAnalyser, type DetectedFace } from './faces.ts'
import { clusterFaces, matchPeople } from './faceGroups.ts'
import { ensureAppDir, removeAppFiles, writeAppFile } from './appFiles.ts'
import type { FaceProgress, Person } from '../shared/types.ts'

/** Regroup this often during a long first analysis, so groups appear early. */
const REGROUP_EVERY = 150

export class People {
  private db: LibraryDb
  private modelsDir: string
  private cropDir: string
  private onProgress: (p: FaceProgress) => void
  private loading: Promise<FaceAnalyser> | null = null
  private sinceRegroup = 0
  private progress: FaceProgress = { phase: 'idle', done: 0, total: 0 }

  constructor(db: LibraryDb, modelsDir: string, cropDir: string, onProgress: (p: FaceProgress) => void) {
    this.db = db
    this.modelsDir = modelsDir
    this.cropDir = cropDir
    this.onProgress = onProgress
  }

  cropPath(faceId: number): string {
    return join(this.cropDir, `${faceId}.jpg`)
  }

  /** Deletes cached face thumbnails (our own files) for faces that no longer exist. */
  async removeCrops(faceIds: number[]): Promise<void> {
    const names = new Set(faceIds.map((id) => `${id}.jpg`))
    if (names.size) await removeAppFiles(this.cropDir, (name) => names.has(name))
  }

  getProgress(): FaceProgress {
    return this.progress
  }

  private emit(p: Partial<FaceProgress>): void {
    this.progress = { ...this.progress, ...p }
    this.onProgress(this.progress)
  }

  // Face analysis runs in the shared background pass (analysis.ts), one read per photo.

  /** The face models, loaded once; null (and progress says why) when they can't be loaded. */
  async analyser(): Promise<FaceAnalyser | null> {
    try {
      this.loading ??= FaceAnalyser.load(this.modelsDir)
      const analyser = await this.loading
      await ensureAppDir(this.cropDir)
      return analyser
    } catch (e) {
      this.loading = null // try again on the next pass
      this.emit({ phase: 'unavailable', error: `Face models not found. Run "npm run fetch-models". (${e instanceof Error ? e.message : e})` })
      return null
    }
  }

  /** Reports progress while photos are being analysed. */
  analysing(): void {
    this.emit({ phase: 'analysing', ...this.db.faceProgress(FACE_MODEL_VERSION) })
  }

  /** Stores a photo's faces (none when it couldn't be read, so it isn't retried) and their thumbnails. */
  async record(photoId: number, faces: DetectedFace[]): Promise<void> {
    const ids = this.db.saveFaces(photoId, faces, FACE_MODEL_VERSION)
    for (let i = 0; i < ids.length; i++) {
      const jpeg = await sharp(faces[i].crop, { raw: { width: 112, height: 112, channels: 3 } })
        .jpeg({ quality: 85 })
        .toBuffer()
      await writeAppFile(this.cropPath(ids[i]), jpeg)
    }
    if (++this.sinceRegroup >= REGROUP_EVERY) {
      this.regroup()
      this.sinceRegroup = 0
    }
  }

  /** Called when a pass ends: final grouping, and progress back to idle. */
  finished(): void {
    this.regroup()
    this.sinceRegroup = 0
    this.emit({ phase: 'idle', ...this.db.faceProgress(FACE_MODEL_VERSION) })
  }

  /** Recognises named people among unconfirmed faces, then groups the rest by similarity. */
  regroup(): void {
    const { open, people, rejected } = this.db.groupingInput()
    const matches = matchPeople(open, people, rejected)
    const groups = clusterFaces(open.filter((f) => !matches.has(f.id)))
    this.db.applyGrouping(matches, groups)
  }

  nameGroup(faceId: number, name: string): Person {
    const personId = this.db.personNamed(name)
    this.db.confirmFaces(this.db.groupMates(faceId), personId)
    this.regroup()
    return this.db.listPeople().find((p) => p.id === personId)!
  }

  nameFace(faceId: number, name: string): void {
    this.db.confirmFaces([faceId], this.db.personNamed(name))
    this.regroup()
  }

  rejectFace(faceId: number): void {
    this.db.rejectFace(faceId)
    this.regroup()
  }

  renamePerson(id: number, name: string): void {
    this.db.renamePerson(id, name)
    this.regroup()
  }

  deletePerson(id: number): void {
    this.db.deletePerson(id)
    this.regroup()
  }
}

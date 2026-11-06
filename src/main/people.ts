// People: runs face analysis in the background and keeps groups/matches up to date.
// Face thumbnails are written to the app's cache (never next to the photos).
import sharp from 'sharp'
import { join } from 'node:path'
import type { LibraryDb } from './db.ts'
import { FACE_MODEL_VERSION, FaceAnalyser } from './faces.ts'
import { clusterFaces, matchPeople } from './faceGroups.ts'
import type { ImageCache } from './thumbnails.ts'
import { ensureAppDir, removeAppFiles, writeAppFile } from './appFiles.ts'
import type { FaceProgress, Person } from '../shared/types.ts'

const BATCH = 20
/** Regroup this often during a long first analysis, so groups appear early. */
const REGROUP_EVERY = 150

export class People {
  private db: LibraryDb
  private modelsDir: string
  private images: ImageCache
  private cropDir: string
  private onProgress: (p: FaceProgress) => void
  private analyser: Promise<FaceAnalyser> | null = null
  private running = false
  private again = false
  private progress: FaceProgress = { phase: 'idle', done: 0, total: 0 }

  constructor(db: LibraryDb, modelsDir: string, images: ImageCache, cropDir: string, onProgress: (p: FaceProgress) => void) {
    this.db = db
    this.modelsDir = modelsDir
    this.images = images
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

  /** Analyses any photos that haven't been yet. Safe to call repeatedly (e.g. after every scan). */
  kick(): void {
    if (this.running) {
      this.again = true
      return
    }
    this.running = true
    void (async () => {
      try {
        do {
          this.again = false
          await this.analyseAll()
        } while (this.again)
      } finally {
        this.running = false
      }
    })()
  }

  private async analyseAll(): Promise<void> {
    let analyser: FaceAnalyser
    try {
      this.analyser ??= FaceAnalyser.load(this.modelsDir)
      analyser = await this.analyser
    } catch (e) {
      this.analyser = null
      this.emit({ phase: 'unavailable', error: `Face models not found. Run "npm run fetch-models". (${e instanceof Error ? e.message : e})` })
      return
    }
    await ensureAppDir(this.cropDir)
    let sinceRegroup = 0
    for (;;) {
      const batch = this.db.photosNeedingFaces(FACE_MODEL_VERSION, BATCH)
      if (batch.length === 0) break
      this.emit({ phase: 'analysing', ...this.db.faceProgress(FACE_MODEL_VERSION) })
      for (const photo of batch) {
        let faces: Awaited<ReturnType<FaceAnalyser['analyse']>> = []
        try {
          faces = await analyser.analyse(photo.path)
        } catch {
          // Formats sharp can't decode (HEIC, RAW): analyse the cached preview instead.
          try {
            faces = await analyser.analyse(await this.images.get(photo, 'preview'))
          } catch {
            faces = [] // unreadable: recorded as "no faces" so it isn't retried every time
          }
        }
        const ids = this.db.saveFaces(photo.id, faces, FACE_MODEL_VERSION)
        for (let i = 0; i < ids.length; i++) {
          const jpeg = await sharp(faces[i].crop, { raw: { width: 112, height: 112, channels: 3 } }).jpeg({ quality: 85 }).toBuffer()
          await writeAppFile(this.cropPath(ids[i]), jpeg)
        }
      }
      sinceRegroup += batch.length
      if (sinceRegroup >= REGROUP_EVERY) {
        this.regroup()
        sinceRegroup = 0
      }
    }
    this.regroup()
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

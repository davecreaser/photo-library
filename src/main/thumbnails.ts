// Generates thumbnails and full-size previews into the app's own cache
// directory. Source photos are only ever read.
import sharp from 'sharp'
import exifr from 'exifr'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { convertWithSips, ensureAppDir, removeAppFiles, writeAppFile } from './appFiles.ts'
import type { ThumbSource } from './db.ts'

export type ImageSize = 'thumb' | 'preview'

const SIZES: Record<ImageSize, number> = { thumb: 360, preview: 2048 }

// EXIF orientation -> clockwise rotation. Embedded RAW/HEIC previews don't carry
// their own orientation tag, so we apply the main image's.
const ROTATION: Record<number, number> = { 3: 180, 6: 90, 8: 270 }

export class ImageCache {
  private inFlight = new Map<string, Promise<string>>()
  private active = 0
  private waiting: (() => void)[] = []
  private dir: string
  private concurrency: number

  constructor(dir: string, concurrency = 4) {
    this.dir = dir
    this.concurrency = concurrency
  }

  /** Returns the path of a cached JPEG for the photo, generating it if needed. */
  async get(photo: ThumbSource, size: ImageSize): Promise<string> {
    // Named by content hash: survives moves/renames, and an edited photo (new hash) gets a fresh one.
    const file = join(this.dir, size, `${photo.hash ?? `id-${photo.id}`}.jpg`)
    try {
      await stat(file)
      return file
    } catch {
      // Not cached yet.
    }
    let pending = this.inFlight.get(file)
    if (!pending) {
      pending = this.limit(() => this.generate(photo, size, file)).finally(() => this.inFlight.delete(file))
      this.inFlight.set(file, pending)
    }
    return pending
  }

  /** Deletes cached thumbnails/previews (our own files, never the originals) for photos with these hashes. */
  async remove(hashes: string[]): Promise<void> {
    const names = new Set(hashes.map((h) => `${h}.jpg`))
    for (const size of Object.keys(SIZES)) {
      await removeAppFiles(join(this.dir, size), (name) => names.has(name))
    }
  }

  private async generate(photo: ThumbSource, size: ImageSize, out: string): Promise<string> {
    const px = SIZES[size]
    let jpeg: Buffer
    try {
      jpeg = await sharp(photo.path, { failOn: 'none' })
        .rotate()
        .resize(px, px, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: size === 'thumb' ? 78 : 88, mozjpeg: true })
        .toBuffer()
    } catch {
      // HEIC and RAW files: sharp's prebuilt libvips can't decode them, but macOS can.
      // Otherwise fall back to the small JPEG preview the camera embedded.
      const converted = await convertWithSips(photo.path, join(this.dir, 'tmp'), px)
      // sips output keeps the EXIF orientation tag, so auto-orient; embedded previews have none.
      const decoded = converted ? { data: converted, fromSips: true } : await embeddedPreview(photo.path)
      if (!decoded) throw new Error(`Cannot render ${photo.path}`)
      const img = sharp(decoded.data)
      jpeg = await (decoded.fromSips ? img.rotate() : img.rotate(ROTATION[photo.orientation ?? 1] ?? 0))
        .resize(px, px, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer()
    }
    await ensureAppDir(join(this.dir, size))
    await writeAppFile(out, jpeg)
    return out
  }

  private async limit<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) await new Promise<void>((r) => this.waiting.push(r))
    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      this.waiting.shift()?.()
    }
  }
}

interface Decoded {
  data: Buffer
  fromSips: boolean
}

async function embeddedPreview(path: string): Promise<Decoded | null> {
  try {
    const buf = await exifr.thumbnail(path)
    return buf ? { data: Buffer.from(buf), fromSips: false } : null
  } catch {
    return null
  }
}

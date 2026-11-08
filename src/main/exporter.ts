// Saves copies of photos as a folder of JPEGs (spec 0007). The photos are only read; the copies
// are written through the ExportSink from appFiles.ts, which is the only place that writes.
import sharp from 'sharp'
import exifr from 'exifr'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { convertWithSips, type ExportSink } from './appFiles.ts'
import type { ExportOptions, ExportSkipped } from '../shared/types.ts'

/** What an export needs to know about a photo. `takenAt` is the capture time (after clock correction). */
export interface ExportPhoto {
  id: number
  path: string
  takenAt: string | null
  width: number | null
  height: number | null
  orientation: number | null
}

export interface PlannedFile {
  photo: ExportPhoto
  name: string
}

const ROTATION: Record<number, number> = { 3: 180, 6: 90, 8: 270 }
const JPEG_EXTENSIONS = new Set(['.jpg', '.jpeg'])
const RESIZED_QUALITY = 90
const CONVERTED_QUALITY = 92

/** Capture-time order, undated photos last in folder-and-name order; each photo once. */
export function orderPhotos(photos: ExportPhoto[]): ExportPhoto[] {
  const seen = new Set<number>()
  const unique = photos.filter((p) => !seen.has(p.id) && !!seen.add(p.id))
  return unique.sort((a, b) => {
    if (a.takenAt && b.takenAt) return a.takenAt < b.takenAt ? -1 : a.takenAt > b.takenAt ? 1 : a.path < b.path ? -1 : 1
    if (a.takenAt || b.takenAt) return a.takenAt ? -1 : 1
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  })
}

/** `0001.jpg`, or `0001 2024-07-14 1032.jpg` with the date. Only digits, dashes and spaces, so safe everywhere. */
export function planNames(photos: ExportPhoto[], options: ExportOptions): PlannedFile[] {
  const ordered = orderPhotos(photos)
  const digits = Math.max(4, String(ordered.length).length)
  return ordered.map((photo, i) => {
    const m = photo.takenAt && /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/.exec(photo.takenAt)
    const when = options.dateInNames && m ? ` ${m[1]} ${m[2]}${m[3]}` : ''
    return { photo, name: `${String(i + 1).padStart(digits, '0')}${when}.jpg` }
  })
}

/** A folder name from an album name: nothing Windows, macOS or Linux refuses. */
export function safeFolderName(name: string): string {
  let n = name
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 80)
    .trim()
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) n = `${n} copies`
  return n || 'Photos'
}

async function embeddedPreview(path: string): Promise<Buffer | null> {
  try {
    const buf = await exifr.thumbnail(path)
    return buf ? Buffer.from(buf) : null
  } catch {
    return null
  }
}

/** The JPEG to save for a photo, upright, in sRGB and within `maxSide` (never enlarged). */
export async function renderCopy(photo: ExportPhoto, maxSide: number, workDir: string): Promise<Buffer> {
  const isJpeg = JPEG_EXTENSIONS.has(extname(photo.path).toLowerCase())
  const limit = maxSide > 0 ? maxSide : undefined
  const encode = (img: ReturnType<typeof sharp>, quality: number, keep: boolean) => {
    let out = img.rotate()
    if (limit) out = out.resize(limit, limit, { fit: 'inside', withoutEnlargement: true })
    if (keep) out = out.keepMetadata()
    return out.toColourspace('srgb').jpeg({ quality, mozjpeg: true }).toBuffer()
  }
  if (isJpeg && !limit) return readFile(photo.path) // byte for byte: quality and EXIF unchanged
  try {
    return await encode(sharp(photo.path, { failOn: 'none' }), isJpeg ? RESIZED_QUALITY : CONVERTED_QUALITY, true)
  } catch (e) {
    if (isJpeg) throw e
    // HEIC and RAW: macOS can decode them; elsewhere use the camera's embedded preview.
    const longSide = Math.max(photo.width ?? 0, photo.height ?? 0) || 16000
    const converted = await convertWithSips(photo.path, workDir, Math.min(limit ?? longSide, longSide))
    if (converted) return encode(sharp(converted, { failOn: 'none' }), CONVERTED_QUALITY, false)
    const preview = await embeddedPreview(photo.path)
    if (!preview) throw new Error('could not be decoded')
    const img = sharp(preview, { failOn: 'none' }).rotate(ROTATION[photo.orientation ?? 1] ?? 0)
    let out = img
    if (limit) out = out.resize(limit, limit, { fit: 'inside', withoutEnlargement: true })
    return out.toColourspace('srgb').jpeg({ quality: CONVERTED_QUALITY, mozjpeg: true }).toBuffer()
  }
}

export interface ExportRun {
  status: 'done' | 'cancelled' | 'error'
  saved: number
  skipped: ExportSkipped[]
  /** Why it stopped early (status `error`). */
  message?: string
}

function writeFailure(e: unknown): string {
  const code = (e as NodeJS.ErrnoException)?.code
  if (code === 'ENOSPC' || code === 'EDQUOT') return 'the disk is full'
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return "that folder can't be written to"
  return e instanceof Error ? e.message : String(e)
}

/**
 * Saves the planned files one at a time (so thousands of photos never sit in memory). A photo that
 * can't be read is skipped and listed; a failure to write stops the export. `cancelled()` is checked
 * between files.
 */
export async function runExport(
  files: PlannedFile[],
  sink: ExportSink,
  options: ExportOptions,
  workDir: string,
  onProgress: (done: number, total: number) => void,
  cancelled: () => boolean
): Promise<ExportRun> {
  const skipped: ExportSkipped[] = []
  let saved = 0
  let done = 0
  onProgress(0, files.length)
  for (const file of files) {
    if (cancelled()) return { status: 'cancelled', saved, skipped }
    let data: Buffer | null = null
    try {
      data = await renderCopy(file.photo, options.maxSide, workDir)
    } catch {
      skipped.push({ name: file.photo.path.split(/[/\\]/).pop() ?? file.name, reason: "couldn't be read" })
    }
    if (data) {
      try {
        await sink.write(file.name, data)
        saved++
      } catch (e) {
        return { status: 'error', saved, skipped, message: writeFailure(e) }
      }
    }
    onProgress(++done, files.length)
  }
  return { status: 'done', saved, skipped }
}

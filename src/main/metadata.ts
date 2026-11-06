// Reads capture date, camera, size and GPS from a photo's EXIF (read-only).
import exifr from 'exifr'
import sharp from 'sharp'
import { extname } from 'node:path'
import type { FileMeta } from './db.ts'
import type { FoundFile } from './photoFs.ts'

/** Formats a Date as local 'YYYY-MM-DDTHH:MM:SS'. EXIF times have no timezone, and exifr parses them as local time. */
export function toLocalIso(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function validDate(v: unknown): Date | null {
  // Cameras with an unset clock write values like 0000:00:00 or 1970.
  return v instanceof Date && !isNaN(v.getTime()) && v.getFullYear() > 1980 ? v : null
}

export async function readMetadata(file: FoundFile): Promise<FileMeta> {
  const ext = extname(file.path).toLowerCase()
  let exif: Record<string, unknown> | undefined
  try {
    exif = await exifr.parse(file.path, { tiff: true, exif: true, gps: true, xmp: false, icc: false, iptc: false, translateValues: false })
  } catch {
    // Unsupported or corrupt metadata; fall back to file info below.
  }

  // No date in the photo means unknown: a file's modified date is usually when it was copied, not taken.
  const exifDate = validDate(exif?.DateTimeOriginal) ?? validDate(exif?.CreateDate)
  const takenAt = exifDate ? toLocalIso(exifDate) : null

  let width = (exif?.ExifImageWidth as number) ?? (exif?.ImageWidth as number) ?? null
  let height = (exif?.ExifImageHeight as number) ?? (exif?.ImageHeight as number) ?? null
  if ((!width || !height) && ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tif', '.tiff'].includes(ext)) {
    try {
      const meta = await sharp(file.path).metadata()
      width = meta.width ?? null
      height = meta.height ?? null
    } catch {
      // Leave dimensions unknown.
    }
  }

  const make = typeof exif?.Make === 'string' ? exif.Make.trim() : ''
  const model = typeof exif?.Model === 'string' ? exif.Model.trim() : ''
  // Models often repeat the make ("Canon" + "Canon EOS 80D").
  const camera = model ? (model.toLowerCase().startsWith(make.toLowerCase()) ? model : `${make} ${model}`.trim()) : make || null

  const lat = typeof exif?.latitude === 'number' && isFinite(exif.latitude) ? exif.latitude : null
  const lon = typeof exif?.longitude === 'number' && isFinite(exif.longitude) ? exif.longitude : null

  return {
    path: file.path,
    size: file.size,
    mtimeMs: file.mtimeMs,
    takenAt,
    width,
    height,
    orientation: typeof exif?.Orientation === 'number' ? exif.Orientation : null,
    camera,
    lat,
    lon
  }
}

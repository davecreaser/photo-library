// The ONLY module allowed to touch the user's photo folders, and it is
// read-only by design: it exposes walking, stat and nothing that writes,
// moves, renames or deletes. Everything the app "organises" lives in its own
// database (see db.ts); the real files are never modified.
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { opendir, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { IgnoreRules } from './ignore.ts'

/** Formats the app can index. Browser-native ones are shown directly, the rest via generated previews. */
export const IMAGE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.gif',
  '.heic',
  '.heif',
  '.tif',
  '.tiff',
  // Camera RAW formats: we show their embedded JPEG preview.
  '.dng',
  '.cr2',
  '.cr3',
  '.nef',
  '.arw',
  '.raf',
  '.orf',
  '.rw2',
  '.pef',
  '.srw'
])

/** Formats Chromium can render straight from disk at full size. */
export const BROWSER_NATIVE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif'])

// Folders that are system/NAS clutter rather than photos.
const SKIP_DIRS = new Set(['@eaDir', '.Trashes', '.Spotlight-V100', '.fseventsd', '$RECYCLE.BIN', 'System Volume Information'])

export interface FoundFile {
  path: string
  size: number
  mtimeMs: number
}

/** Recursively yields image files under `root`, skipping ignored folders. Unreadable folders are skipped, not fatal. */
export async function* walkImages(root: string, ignore: IgnoreRules, segments: string[] = []): AsyncGenerator<FoundFile> {
  let dir
  try {
    dir = await opendir(join(root, ...segments))
  } catch {
    return
  }
  for await (const entry of dir) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
    if (entry.isDirectory() && ignore.ignoresDir([...segments, entry.name])) continue
    const full = join(root, ...segments, entry.name)
    if (entry.isDirectory()) {
      yield* walkImages(root, ignore, [...segments, entry.name])
    } else if (entry.isFile() && IMAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      try {
        const s = await stat(full)
        yield { path: full, size: s.size, mtimeMs: Math.floor(s.mtimeMs) }
      } catch {
        // File vanished or is unreadable; skip it.
      }
    }
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** SHA-256 of the file's full contents: the photo's identity, wherever it's stored. Opens the file read-only. */
export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { flags: 'r', highWaterMark: 1 << 20 })) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

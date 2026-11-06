// A synthetic photo library for end-to-end tests, shaped like a real camera
// library (wrong camera clock, trips split over days, duplicates, a private
// folder, undated scans) but with generated images: no personal photos.
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import sharp from 'sharp'

let n = 0
async function photo(path: string, date: string | null, camera = 'FUJIFILM X-T50'): Promise<void> {
  mkdirSync(dirname(path), { recursive: true })
  const hue = (n++ * 47) % 360
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="hsl(${hue},55%,50%)"/><text x="12" y="185" font-size="18" fill="white" font-family="sans-serif">${n}</text></svg>`
  const exif = date ? { IFD0: { Make: camera.split(' ')[0], Model: camera }, IFD2: { DateTimeOriginal: date } } : {}
  await sharp(Buffer.from(svg)).withExif(exif).jpeg().toFile(path)
}

export interface Library {
  root: string
  /** Number of distinct photos the app should show (copies counted once, private excluded). */
  uniquePhotos: number
}

export async function createLibrary(): Promise<Library> {
  const root = mkdtempSync(join(tmpdir(), 'pl-e2e-lib-'))
  // The camera clock was a year behind until mid-2026: these folders say 2025, the camera says 2024.
  for (let i = 0; i < 4; i++) await photo(join(root, 'fuji/trips/08.25.sail_amsterdam', `DSCF01${i}.JPG`), `2024:08:24 1${i}:00:00`)
  for (let i = 0; i < 3; i++) await photo(join(root, 'fuji/trips/12.25.poland', `DSCF02${i}.JPG`), `2024:12:13 1${i}:00:00`)
  await photo(join(root, 'fuji/unsorted/DSCF0300.JPG'), '2025:06:20 10:00:00')
  // After the clock was fixed. A holiday whose days are > 18h apart: three automatic events.
  await photo(join(root, 'fuji/unsorted/DSCF0400.JPG'), '2026:07:31 10:00:00')
  await photo(join(root, 'fuji/unsorted/DSCF0401.JPG'), '2026:08:02 10:00:00')
  await photo(join(root, 'fuji/unsorted/DSCF0402.JPG'), '2026:08:04 10:00:00')
  // A copy of an unsorted photo: shown once.
  cpSync(join(root, 'fuji/unsorted/DSCF0400.JPG'), join(root, '2026/DSCF0400.JPG'))
  // Scans without dates.
  for (let i = 0; i < 2; i++) await photo(join(root, 'house_listing', `scan${i}.jpg`), null)
  // Never to be indexed.
  await photo(join(root, 'private/secret.jpg'), '2025:01:01 10:00:00')
  await photo(join(root, 'fuji/Private/also-secret.jpg'), '2025:01:02 10:00:00')
  return { root, uniquePhotos: 4 + 3 + 1 + 3 + 2 }
}

/** Fingerprint of every file (content + modified time), to prove the app changed nothing. */
export function fingerprint(root: string): string {
  const h = createHash('sha256')
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name)
      const s = statSync(full)
      if (s.isDirectory()) walk(full)
      else if (name !== '.DS_Store') h.update(`${full}:${s.size}:${s.mtimeMs}:`).update(readFileSync(full))
    }
  }
  walk(root)
  return h.digest('hex')
}

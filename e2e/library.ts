// A synthetic photo library for end-to-end tests, shaped like a real camera
// library (wrong camera clock, trips split over days, duplicates, a private
// folder, undated scans) but with generated images: no personal photos.
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import sharp from 'sharp'

let n = 0
export async function photo(path: string, date: string | null, camera = 'FUJIFILM X-T50'): Promise<void> {
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

/**
 * A second library for suggested-album edge cases: a named folder with a very long
 * name, an undated named folder, and enough loose photos that the first scan takes a moment.
 */
// Long, but under Windows' 260-character path limit once inside the temp folder.
export const LONG_FOLDER = 'a_very_long_folder_name_' + 'that_keeps_going_'.repeat(5) + 'end'

export async function createEdgeLibrary(): Promise<Library> {
  const root = mkdtempSync(join(tmpdir(), 'pl-e2e-edge-'))
  for (let i = 0; i < 2; i++) await photo(join(root, 'trips', `05.25.${LONG_FOLDER}`, `L${i}.JPG`), `2025:05:0${i + 1} 10:00:00`)
  for (let i = 0; i < 3; i++) await photo(join(root, 'old_scans', `scan${i}.jpg`), null)
  // 120 loose photos, one every 2 days (so no burst of 20 at the default minimum).
  for (let i = 0; i < 120; i++) {
    const d = new Date(Date.UTC(2023, 0, 1) + i * 2 * 86_400_000)
    const exif = `${d.getUTCFullYear()}:${String(d.getUTCMonth() + 1).padStart(2, '0')}:${String(d.getUTCDate()).padStart(2, '0')} 10:00:00`
    await photo(join(root, 'unsorted', `IMG_${i}.JPG`), exif)
  }
  return { root, uniquePhotos: 2 + 3 + 120 }
}

/**
 * A plain-colour photo (no text, so it renders the same on every OS). Each file is a distinct
 * photo through its EXIF description; photos of one colour have identical pixels and scores.
 */
async function colourPhoto(path: string, fill: string, date: string | null): Promise<void> {
  mkdirSync(dirname(path), { recursive: true })
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="${fill}"/></svg>`
  const exif = { IFD0: { ImageDescription: `test photo ${n++}` }, ...(date ? { IFD2: { DateTimeOriginal: date } } : {}) }
  await sharp(Buffer.from(svg)).withExif(exif).jpeg().toFile(path)
}

export interface ContentLibrary extends Library {
  red: number
  blue: number
}

/**
 * Search by content (spec 0002): red and blue photos with camera names, which the content model
 * tells apart, plus a blue photo in a folder called "red things" (a name match for "red").
 * `extra` green photos make analysis take long enough to search while it runs.
 */
export async function createContentLibrary(extra = 0): Promise<ContentLibrary> {
  const root = mkdtempSync(join(tmpdir(), 'pl-e2e-content-'))
  for (let i = 0; i < 3; i++) await colourPhoto(join(root, 'camera', `DSC_R${i}.JPG`), '#d42020', `2025:0${i + 1}:10 10:00:00`)
  for (let i = 0; i < 3; i++) await colourPhoto(join(root, 'camera', `DSC_B${i}.JPG`), '#2040d4', `2026:0${i + 1}:10 10:00:00`)
  await colourPhoto(join(root, 'red things', 'DSC_X.JPG'), '#2040d4', '2024:05:01 10:00:00')
  for (let i = 0; i < extra; i++) await colourPhoto(join(root, 'more', `DSC_G${i}.JPG`), '#30a040', '2023:01:01 10:00:00')
  return { root, uniquePhotos: 7 + extra, red: 3, blue: 4 }
}

/** `folders` named folders of one photo each, a day apart (AC-12: thousands of suggestions). */
export async function createManyFoldersLibrary(folders: number): Promise<Library> {
  const root = mkdtempSync(join(tmpdir(), 'pl-e2e-many-'))
  for (let i = 0; i < folders; i++) {
    const d = new Date(Date.UTC(2015, 0, 1) + i * 86_400_000)
    const exif = `${d.getUTCFullYear()}:${String(d.getUTCMonth() + 1).padStart(2, '0')}:${String(d.getUTCDate()).padStart(2, '0')} 10:00:00`
    await photo(join(root, 'trips', `trip_${String(i).padStart(4, '0')}`, 'IMG.JPG'), exif)
  }
  return { root, uniquePhotos: folders }
}

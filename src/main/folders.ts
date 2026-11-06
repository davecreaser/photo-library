// Extracts meaning from the user's folder names: event names ("Sail Amsterdam"),
// favourite markers ("best"), and dates ("08.25" = August 2025).
// All functions take a folder path RELATIVE to the base folder.
import { sep } from 'node:path'

/** Folders that say nothing about what's in them. */
const GENERIC = new Set([
  'unsorted', 'random', 'misc', 'other', 'various', 'new folder', 'untitled', 'temp', 'tmp',
  'best', 'favorites', 'favourites', 'favs', 'picks', 'selects', 'selected', 'insta', 'instagram',
  'export', 'exports', 'edited', 'edits', 'jpg', 'jpeg', 'raw', 'originals',
  'dcim', 'camera', 'camera roll', 'photos', 'pictures', 'images', 'img', 'pics',
  'trips', 'trip', 'events', 'holidays', 'fuji', 'fujifilm', 'kodak', 'canon', 'nikon', 'sony', 'iphone', 'phone'
])

function segments(relDir: string): string[] {
  return relDir.split(sep).filter((s) => s && s !== '.')
}

/** Removes date prefixes like "08.25.", "2020-08 ", "2021_12_" from a folder name. */
function stripDate(name: string): string {
  return name
    .replace(/^\d{1,2}[._-]\d{2}([._\s-]+|$)/, '') // 08.25.sail_amsterdam
    .replace(/^(19|20)\d{2}([._-]\d{1,2})?([._-]\d{1,2})?([._\s-]+|$)/, '') // 2020-08 Spain
    .trim()
}

function isGeneric(segment: string): boolean {
  const s = segment.toLowerCase()
  return GENERIC.has(s) || /^\d{3}[a-z_]*$/i.test(s) /* 100CANON */ || stripDate(segment) === ''
}

function pretty(name: string): string {
  return stripDate(name)
    .replace(/[_]+/g, ' ')
    .replace(/\s*\.\s*/g, ' – ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(^|\s)\p{Ll}/gu, (c) => c.toUpperCase())
}

/**
 * A human name for the folder, from its two most specific meaningful segments:
 * "fuji/trips/08.25.sail_amsterdam/best" -> "Sail Amsterdam",
 * "all_hands_2024/Treasure Hunt" -> "All Hands 2024 – Treasure Hunt". Null if all generic.
 */
export function folderName(relDir: string): string | null {
  const meaningful = segments(relDir).filter((s) => !isGeneric(s))
  if (meaningful.length === 0) return null
  return meaningful.slice(-2).map(pretty).join(' – ')
}

export interface FolderDate {
  year: number
  month?: number
  /** The part of the path up to the folder the date came from (so "x/best" and "x" count once). */
  source: string
}

/**
 * The date a folder name implies, from its most specific segment that has one.
 * Understands "MM.YY" prefixes (08.25.sail_amsterdam), "YYYY-MM", and a bare year (all_hands_2024).
 */
export function folderDate(relDir: string): FolderDate | null {
  const segs = segments(relDir)
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = segs[i]
    const source = segs.slice(0, i + 1).join(sep)
    let m = /^(\d{1,2})[._-](\d{2})([._\s-]|$)/.exec(s)
    if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) return { year: 2000 + Number(m[2]), month: Number(m[1]), source }
    m = /(?:^|[^\d])((?:19|20)\d{2})[._-](\d{1,2})(?:[^\d]|$)/.exec(s)
    if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return { year: Number(m[1]), month: Number(m[2]), source }
    m = /(?:^|[^\d])((?:19|20)\d{2})(?:[^\d]|$)/.exec(s)
    if (m) return { year: Number(m[1]), source }
  }
  return null
}

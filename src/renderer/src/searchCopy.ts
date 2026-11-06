// The words content search shows (spec 0002, Design), kept apart from the components so they
// can be checked against the spec (test/search-copy.test.ts).
import type { ContentProgress, SearchInfo } from '../../shared/types.ts'
import { formatTimeLeft, photoCount } from './format.ts'

export const SEARCH_PLACEHOLDER = 'Search: “sunset over water”, “jake 2025”, “poland”…'
export const NAME_ONLY_PLACEHOLDER = 'Search: “august 2025”, “poland”, “jake”…'

export function searchPlaceholder(progress: ContentProgress | null): string {
  return progress?.phase === 'unavailable' ? NAME_ONLY_PLACEHOLDER : SEARCH_PLACEHOLDER
}

/** "{reason} {fix}" for an unavailable content model. */
export function unavailableReason(progress: ContentProgress): string {
  const reason =
    progress.reason === 'damaged'
      ? 'its model file is damaged (checksum didn’t match).'
      : progress.reason === 'failed'
        ? 'its search component couldn’t be loaded.'
        : 'its model file is missing.'
  const fix = progress.packaged
    ? 'Reinstall Photo Library to fix this.'
    : progress.reason === 'failed'
      ? 'Run “npm install”, then restart the app.'
      : 'Run “npm run fetch-models”, then restart the app.'
  return `${reason} ${fix}`
}

export const ANALYSING_TOOLTIP =
  'Photo Library is learning what’s in each photo, on this computer, so you can search for things like “beach” or “dog”. Each photo is analysed once; you can keep using the app, and search uses the photos done so far.'

/** The top bar while content analysis runs. */
export function analysingStatus(p: ContentProgress): string {
  const counts = `${p.done.toLocaleString()} / ${p.total.toLocaleString()} · ${formatTimeLeft(p.secondsLeft)}`
  return p.upgrading ? `Updating search… ${counts}` : `Analysing photos for search… ${counts}`
}

/** The grid's meta line for a search (`info` null or without a phrase: today's line). */
export function searchMeta(total: number, info: SearchInfo | undefined, selected: number, contentAvailable: boolean): string {
  const tail = selected > 0 ? ` · ${selected.toLocaleString()} selected` : ''
  if (!info?.phrase || total === 0 || !contentAvailable) return `${photoCount(total)}${tail || ' · ⌘-click or shift-click to select'}`
  const lookLike = (n: number) => `${n === 1 ? 'looks' : 'look'} like “${info.phrase}”`
  if (info.nameMatches > 0 && info.contentMatches > 0) {
    return `${photoCount(total)} · ${info.nameMatches.toLocaleString()} by name, then ${info.contentMatches.toLocaleString()} that ${lookLike(info.contentMatches)}, best match first${tail}`
  }
  if (info.contentMatches > 0) return `${photoCount(total)} that ${lookLike(total)} · best match first${tail}`
  return `${photoCount(total)} by name · none look like “${info.phrase}”${tail}`
}

export const dividerLabel = (phrase: string) => `Looks like “${phrase}”`

/** The hint under the meta line, when there's a content phrase and results. */
export type SearchHint = { kind: 'unavailable'; danger: string; rest: string } | { kind: 'analysing' | 'done'; text: string }

/** `loadedWhileAnalysing`: the results on screen were found while analysis was running. */
export function searchHint(progress: ContentProgress | null, loadedWhileAnalysing: boolean): SearchHint | null {
  if (!progress) return null
  if (progress.phase === 'unavailable') {
    return {
      kind: 'unavailable',
      danger: `Content search is unavailable: ${unavailableReason(progress)}`,
      rest: 'Names, albums, tags, people and dates are still searched.'
    }
  }
  if (progress.phase === 'analysing') {
    const estimate = formatTimeLeft(progress.secondsLeft)!
    // "estimating time…" already ends the sentence.
    const counts = `${progress.done.toLocaleString()} of ${progress.total.toLocaleString()} done, ${estimate}${estimate.endsWith('…') ? '' : '.'}`
    const start = progress.upgrading ? 'Updating search for a new version' : 'Still analysing your photos'
    return { kind: 'analysing', text: `${start}: ${counts} Photos not analysed yet can only be found by name.` }
  }
  return loadedWhileAnalysing ? { kind: 'done', text: 'All photos are now analysed.' } : null
}

/** The empty search result: a line and a hint. */
export function emptySearch(query: string, info: SearchInfo | undefined, progress: ContentProgress | null): { title: string; detail: string } {
  const quoted = `“${query}”`
  if (info?.phrase && progress?.phase === 'unavailable') {
    return {
      title: `No photos matched ${quoted}.`,
      detail: 'Content search is unavailable, so only names, albums, tags, people and dates were searched.'
    }
  }
  if (info?.phrase && progress?.phase === 'analysing') {
    const when = formatTimeLeft(progress.secondsLeft, true)
    return {
      title: `No photos matched ${quoted} yet.`,
      detail: `${progress.done.toLocaleString()} of ${progress.total.toLocaleString()} photos are analysed so far; more may match when analysis finishes${when ? ` (${when})` : ''}.`
    }
  }
  return {
    title: `No photos matched ${quoted}.`,
    detail: 'Search looks at what’s in your photos, and at folder and file names, albums, tags, people and dates. Try different or fewer words.'
  }
}

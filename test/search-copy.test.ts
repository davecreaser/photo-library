// The words content search shows, as the spec's Design section gives them (spec 0002).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatTimeLeft } from '../src/renderer/src/format.ts'
import { analysingStatus, emptySearch, searchHint, searchMeta, searchPlaceholder, unavailableReason } from '../src/renderer/src/searchCopy.ts'
import type { ContentProgress } from '../src/shared/types.ts'

const progress = (p: Partial<ContentProgress>): ContentProgress => ({
  phase: 'idle',
  done: 0,
  total: 0,
  upgrading: false,
  secondsLeft: null,
  packaged: false,
  ...p
})
// Counts are shown in the user's locale (1,740 or 1 740 or 1.740).
const n = (x: number) => x.toLocaleString()

test('time estimate', () => {
  assert.equal(formatTimeLeft(null), 'estimating time…')
  assert.equal(formatTimeLeft(59), 'less than a minute left')
  assert.equal(formatTimeLeft(61), 'about 2 min left', 'minutes round up')
  assert.equal(formatTimeLeft(59 * 60), 'about 59 min left')
  assert.equal(formatTimeLeft(59 * 60 + 30), 'about 1 h left', 'never “about 60 min”')
  assert.equal(formatTimeLeft(14.4 * 3600), 'about 14 h left')
  assert.equal(formatTimeLeft(240, true), 'about 4 min')
  assert.equal(formatTimeLeft(30, true), 'less than a minute')
  assert.equal(formatTimeLeft(null, true), null)
})

test('placeholder suggests content searches unless content search is unavailable', () => {
  assert.equal(searchPlaceholder(progress({ phase: 'analysing' })), 'Search: “sunset over water”, “jake 2025”, “poland”…')
  assert.equal(searchPlaceholder(progress({ phase: 'unavailable', reason: 'missing' })), 'Search: “august 2025”, “poland”, “jake”…')
})

test('top bar while analysing', () => {
  assert.equal(
    analysingStatus(progress({ phase: 'analysing', done: 3, total: 12, secondsLeft: 20 })),
    'Analysing photos for search… 3 / 12 · less than a minute left'
  )
  assert.equal(
    analysingStatus(progress({ phase: 'analysing', done: 1200, total: 100000, secondsLeft: 50_000, upgrading: true })),
    `Updating search… ${n(1200)} / ${n(100000)} · about 14 h left`
  )
})

test('unavailable: reason and fix', () => {
  assert.equal(
    unavailableReason(progress({ phase: 'unavailable', reason: 'missing' })),
    'its model file is missing. Run “npm run fetch-models”, then restart the app.'
  )
  assert.equal(
    unavailableReason(progress({ phase: 'unavailable', reason: 'damaged', packaged: true })),
    'its model file is damaged (checksum didn’t match). Reinstall Photo Library to fix this.'
  )
})

test('meta line', () => {
  assert.equal(
    searchMeta(12, { phrase: null, nameMatches: 12, contentMatches: 0 }, 0, true),
    '12 photos · ⌘-click or shift-click to select',
    'no phrase: as today'
  )
  assert.equal(
    searchMeta(12, { phrase: 'beach', nameMatches: 4, contentMatches: 8 }, 0, true),
    '12 photos · 4 by name, then 8 that look like “beach”, best match first'
  )
  assert.equal(searchMeta(1, { phrase: 'beach', nameMatches: 0, contentMatches: 1 }, 0, true), '1 photo that looks like “beach” · best match first')
  assert.equal(
    searchMeta(3, { phrase: 'beach', nameMatches: 2, contentMatches: 1 }, 0, true),
    '3 photos · 2 by name, then 1 that looks like “beach”, best match first'
  )
  assert.equal(searchMeta(3, { phrase: 'beach', nameMatches: 3, contentMatches: 0 }, 0, true), '3 photos by name · none look like “beach”')
  assert.equal(
    searchMeta(8, { phrase: 'beach', nameMatches: 0, contentMatches: 8 }, 2, true),
    '8 photos that look like “beach” · best match first · 2 selected'
  )
  assert.equal(
    searchMeta(3, { phrase: 'beach', nameMatches: 3, contentMatches: 0 }, 0, false),
    '3 photos · ⌘-click or shift-click to select',
    'unavailable: as today'
  )
})

test('hint under the meta line', () => {
  assert.deepEqual(searchHint(progress({ phase: 'analysing', done: 120, total: 1740, secondsLeft: 200 }), true), {
    kind: 'analysing',
    text: `Still analysing your photos: 120 of ${n(1740)} done, about 4 min left. Photos not analysed yet can only be found by name.`
  })
  assert.deepEqual(searchHint(progress({ phase: 'analysing', done: 1, total: 9, upgrading: true }), false), {
    kind: 'analysing',
    text: 'Updating search for a new version: 1 of 9 done, estimating time… Photos not analysed yet can only be found by name.'
  })
  assert.deepEqual(searchHint(progress({ phase: 'idle' }), true), { kind: 'done', text: 'All photos are now analysed.' })
  assert.equal(searchHint(progress({ phase: 'idle' }), false), null, 'gone after a refresh once analysis is done')
  assert.deepEqual(searchHint(progress({ phase: 'unavailable', reason: 'missing', packaged: true }), false), {
    kind: 'unavailable',
    danger: 'Content search is unavailable: its model file is missing. Reinstall Photo Library to fix this.',
    rest: 'Names, albums, tags, people and dates are still searched.'
  })
})

test('empty result', () => {
  const info = { phrase: 'giraffe', nameMatches: 0, contentMatches: 0 }
  assert.deepEqual(emptySearch('giraffe', info, progress({})), {
    title: 'No photos matched “giraffe”.',
    detail: 'Search looks at what’s in your photos, and at folder and file names, albums, tags, people and dates. Try different or fewer words.'
  })
  assert.deepEqual(emptySearch('giraffe', info, progress({ phase: 'analysing', done: 300, total: 1740, secondsLeft: 240 })), {
    title: 'No photos matched “giraffe” yet.',
    detail: `300 of ${n(1740)} photos are analysed so far; more may match when analysis finishes (about 4 min).`
  })
  assert.equal(
    emptySearch('giraffe', info, progress({ phase: 'analysing', done: 3, total: 1740 })).detail,
    `3 of ${n(1740)} photos are analysed so far; more may match when analysis finishes.`
  )
  assert.equal(
    emptySearch('giraffe', info, progress({ phase: 'unavailable', reason: 'damaged' })).detail,
    'Content search is unavailable, so only names, albums, tags, people and dates were searched.'
  )
  assert.equal(
    emptySearch('august 2031', { phrase: null, nameMatches: 0, contentMatches: 0 }, progress({ phase: 'analysing' })).title,
    'No photos matched “august 2031”.'
  )
})

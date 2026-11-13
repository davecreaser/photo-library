// Match strength in search_photos (spec 0011). The line itself is a pure function; the tool's
// output is checked with a stub search whose scores are chosen here. Generated data only.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setup } from './assistant-helpers.ts'
import { AssistantTools, TOOL_DEFINITIONS } from '../src/main/assistantTools.ts'
import { PhotoSearch } from '../src/main/photoSearch.ts'
import { CONTENT_MIN_SCORE, STRONG_FRACTION, strongMatchCount } from '../src/main/contentModel.ts'
import type { PhotoFilter, PhotoPage } from '../src/shared/types.ts'

test('AC-2: the line is a fixed fraction of the best margin above CONTENT_MIN_SCORE; the best is always strong', () => {
  assert.equal(STRONG_FRACTION > 0 && STRONG_FRACTION < 1, true)
  assert.equal(strongMatchCount([]), 0)
  assert.equal(strongMatchCount([0.05]), 1)
  const line = CONTENT_MIN_SCORE + (0.1 - CONTENT_MIN_SCORE) * STRONG_FRACTION
  assert.equal(strongMatchCount([0.1, 0.1, line + 1e-6, line, line - 1e-6, 0.044]), 4, 'the line itself is strong')
  // A weak best: the line is still part-way between the minimum and the best, so not everything is strong.
  const low = CONTENT_MIN_SCORE + 0.01
  assert.equal(strongMatchCount([low, low - 0.001, CONTENT_MIN_SCORE + 0.0001]), 2)
})

async function toolsWith(strong: number, total: number, opts: { phrase?: boolean; names?: number } = {}) {
  const lib = await setup({ on: false })
  const ids = lib.add(total)
  const names = opts.names ?? 0
  const search = {
    queryWithStrength: async (filter: PhotoFilter): Promise<{ page: PhotoPage; strong: number }> => {
      const all = lib.db.photosByIds(ids)
      const from = filter.offset ?? 0
      const photos = all.slice(from, from + (filter.limit ?? 200))
      const phrase = opts.phrase === false ? null : 'red'
      return { page: { photos, total: all.length, search: { phrase, nameMatches: names, contentMatches: phrase ? all.length - names : 0 } }, strong }
    }
  } as unknown as PhotoSearch
  const tools = new AssistantTools({
    db: lib.db,
    search,
    contentProgress: () => lib.progress,
    albumsChanged: () => {},
    bestOf: lib.bestOf,
    proposals: lib.proposals
  })
  return { lib, tools }
}

type Result = { total: number; strong_total?: number; photos: { match: unknown }[]; note?: string }

test('AC-1, AC-3: content matches carry a strength; strong_total counts the strong ones', async () => {
  const { lib, tools } = await toolsWith(3, 5)
  const r = (await tools.call('search_photos', { text: 'red' })) as Result
  assert.equal(r.total, 5)
  assert.equal(r.strong_total, 3)
  assert.deepEqual(
    r.photos.map((p) => p.match),
    [
      { content: 1, strength: 'strong' },
      { content: 2, strength: 'strong' },
      { content: 3, strength: 'strong' },
      { content: 4, strength: 'weak' },
      { content: 5, strength: 'weak' }
    ]
  )
  // The same photo has the same strength on any page.
  const page = (await tools.call('search_photos', { text: 'red', offset: 2, limit: 2 })) as Result
  assert.deepEqual(
    page.photos.map((p) => p.match),
    [
      { content: 3, strength: 'strong' },
      { content: 4, strength: 'weak' }
    ]
  )
  assert.equal(page.total, 5)
  assert.equal(page.strong_total, 3)
  await lib.close()
})

test('AC-1: name matches come first and are unchanged', async () => {
  const { lib, tools } = await toolsWith(1, 3, { names: 2 })
  const r = (await tools.call('search_photos', { text: 'red' })) as Result
  assert.deepEqual(
    r.photos.map((p) => p.match),
    ['name', 'name', { content: 1, strength: 'strong' }]
  )
  assert.equal(r.strong_total, 1)
  await lib.close()
})

test('AC-3, AC-8: no strong_total without content matches or a content phrase', async () => {
  const none = await toolsWith(0, 2, { names: 2 })
  assert.equal(((await none.tools.call('search_photos', { text: 'red' })) as Result).strong_total, undefined)
  await none.lib.close()
  const filter = await toolsWith(0, 2, { phrase: false })
  const r = (await filter.tools.call('search_photos', { from: '2024-01-01' })) as Result
  assert.equal(r.strong_total, undefined)
  assert.deepEqual(
    r.photos.map((p) => p.match),
    ['name', 'name'].map(() => 'filter')
  )
  await filter.lib.close()
})

test('AC-5: no score appears in a content result; AC-4: the description explains the tiers without scores', async () => {
  const { lib, tools } = await toolsWith(2, 4)
  const r = (await tools.call('search_photos', { text: 'red' })) as Result
  assert.deepEqual(Object.keys(r).sort(), ['offset', 'photos', 'strong_total', 'total'])
  for (const p of r.photos) assert.deepEqual(Object.keys(p).sort(), ['albums', 'favorite', 'id', 'match', 'people', 'taken'])
  assert.doesNotMatch(JSON.stringify(r), /score|distance|threshold|similarity/i)
  const d = TOOL_DEFINITIONS.find((t) => t.name === 'search_photos')!.description
  assert.match(d, /strong/)
  assert.match(d, /weak/)
  assert.match(d, /strong_total/)
  assert.doesNotMatch(d, /score|distance|threshold|similarity/i)
  await lib.close()
})

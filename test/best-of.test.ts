// Spec 0006: best photos. The selection engine on synthetic photos (vectors made up here, never real
// photos), then the database and service around it. Each test names the acceptance criteria it proves.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installFsGuard } from '../src/main/fsGuard.ts'
import { LibraryDb, type FileMeta } from '../src/main/db.ts'
import { Organiser } from '../src/main/organiser.ts'
import { BestOfService } from '../src/main/bestOfService.ts'
import { QUALITY_VERSION } from '../src/main/quality.ts'
import { bestOf, defaultCount, lookalikeGroups, tasteDirection, type BestOfPhoto } from '../src/main/bestOf.ts'

installFsGuard({ allowedRoots: () => [tmpdir()], protectedRoots: () => [] })

const DIMS = 64
/** Deterministic pseudo-random numbers. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}
/** A scene's direction; photos of one scene are this plus a little noise. */
function scene(seed: number): Float64Array {
  const r = rng(seed * 7919 + 13)
  return Float64Array.from({ length: DIMS }, () => r() - 0.5)
}
function vec(sceneVec: Float64Array, noise: number, seed: number): Int8Array {
  const r = rng(seed + 1)
  const v = Float64Array.from(sceneVec, (x) => x + (r() - 0.5) * noise)
  const max = Math.max(...v.map(Math.abs))
  return Int8Array.from(v, (x) => Math.round((x / max) * 127))
}

let nextId = 1
const at = (day: string, hhmm: string) => `${day}T${hhmm}:00`
function photo(p: Partial<BestOfPhoto> & { scene?: number; noise?: number }): BestOfPhoto {
  const id = p.id ?? nextId++
  return {
    id,
    takenAt: p.takenAt ?? null,
    quality: p.quality === undefined ? 0.7 : p.quality,
    starred: p.starred ?? false,
    inOtherAlbum: p.inOtherAlbum ?? false,
    tagged: p.tagged ?? false,
    people: p.people ?? [],
    vector: p.vector !== undefined ? p.vector : p.scene !== undefined ? vec(scene(p.scene), p.noise ?? 0.05, id) : null
  }
}
const noPeople = new Map<number, { name: string; libraryPhotos: number }>()
const ids = (r: { picks: { id: number }[] }) => r.picks.map((p) => p.id)

/** A trip: `days` days, each with a few places, each place a run of look-alike shots. */
function trip(days: number, placesPerDay = 3, shots = 4): BestOfPhoto[] {
  const out: BestOfPhoto[] = []
  for (let d = 0; d < days; d++) {
    for (let p = 0; p < placesPerDay; p++) {
      for (let s = 0; s < shots; s++) {
        out.push(
          photo({
            takenAt: at(`2025-08-${String(10 + d).padStart(2, '0')}`, `${String(9 + p * 3).padStart(2, '0')}:${String(s * 2).padStart(2, '0')}`),
            scene: d * 10 + p + 1,
            quality: 0.5 + s * 0.1
          })
        )
      }
    }
  }
  return out
}

test('AC-2: look-alikes are near-identical shots close in time, chained, capped at 30; undated need a closer match; no vector, no group', async () => {
  const a = scene(1)
  const b = scene(2)
  const burst = Array.from({ length: 5 }, (_, i) => photo({ takenAt: at('2025-08-10', `10:0${i * 2}`), vector: vec(a, 0.05, i) }))
  const other = photo({ takenAt: at('2025-08-10', '10:09'), vector: vec(b, 0.05, 99) })
  const sameSceneLater = photo({ takenAt: at('2025-08-10', '15:00'), vector: vec(a, 0.05, 50) })
  const noVector = photo({ takenAt: at('2025-08-10', '10:05'), vector: null })
  const all = [...burst, other, sameSceneLater, noVector]
  const groups = await lookalikeGroups(all)
  assert.equal(groups.length, 1)
  assert.deepEqual(
    groups[0].sort((x, y) => x - y),
    [0, 1, 2, 3, 4]
  )

  // Chained: ends ten minutes from each other's neighbours, 8 minutes apart each (end to end 32 minutes).
  const chain = Array.from({ length: 5 }, (_, i) => photo({ takenAt: at('2025-08-10', `1${i}:${i % 2 ? '50' : '00'}`), vector: vec(a, 0.05, i + 200) }))
  chain.forEach((p, i) => (p.takenAt = new Date(Date.UTC(2025, 7, 10, 10, i * 8)).toISOString().slice(0, 19)))
  assert.equal((await lookalikeGroups(chain)).length, 1)

  // Capped at 30.
  const crowd = Array.from({ length: 70 }, (_, i) =>
    photo({ takenAt: new Date(Date.UTC(2025, 7, 10, 10, 0, i * 5)).toISOString().slice(0, 19), vector: vec(a, 0.02, i) })
  )
  const sizes = (await lookalikeGroups(crowd)).map((g) => g.length)
  assert.ok(sizes.every((s) => s <= 30) && sizes.reduce((x, y) => x + y, 0) >= 60, sizes.join())

  // Undated: very close vectors group, merely similar ones don't.
  const undatedSame = [photo({ vector: vec(a, 0.02, 1) }), photo({ vector: vec(a, 0.02, 2) })]
  assert.equal((await lookalikeGroups(undatedSame)).length, 1)
  const undatedSimilar = [
    photo({ vector: vec(a, 0.02, 1) }),
    photo({ vector: vec(a.map((x, i) => x + (i % 2 ? 0.25 : -0.25)) as unknown as Float64Array, 0.02, 2) })
  ]
  assert.equal((await lookalikeGroups(undatedSimilar)).length, 0)
})

test('AC-3: the pick is about 10% (12 to 60), spread over the trip, one per look-alike group, and a small set shows all non-duplicates', async () => {
  assert.deepEqual([5, 100, 400, 2000, 9000].map(defaultCount), [5, 12, 40, 60, 60])
  const photos = trip(5)
  const r = await bestOf(photos, { count: 12, people: noPeople })
  assert.equal(r.picks.length, 12)
  const dayCount = (res: typeof r) => new Set(res.picks.map((p) => photos.find((x) => x.id === p.id)!.takenAt!.slice(0, 10))).size
  assert.ok(dayCount(r) >= 4, 'twelve photos from fifteen places reach nearly every day')
  assert.equal(dayCount(await bestOf(photos, { count: 15, people: noPeople })), 5, 'every day appears when there is room')
  // One per look-alike group, and the best-scoring shot of its group (quality rises with s).
  const groupOf = (id: number) => (photos.findIndex((x) => x.id === id) / 4) | 0
  assert.equal(new Set(r.picks.map((p) => groupOf(p.id))).size, 12)
  for (const p of r.picks) assert.equal(photos.find((x) => x.id === p.id)!.quality, 0.8, 'the sharpest of the four')
  assert.ok(r.picks.every((p) => p.reason.kind === 'lookalike' && p.reason.count === 4))

  const small = await bestOf(trip(1, 2, 3), { count: 12, people: noPeople })
  assert.equal(small.picks.length, 2, 'two places, three look-alikes each: all non-duplicates')
})

test('AC-3: two similar scenes on different days do not both make it when a different place is waiting', async () => {
  const sunset = (d: string, seed: number) => photo({ takenAt: at(d, '20:00'), vector: vec(scene(1), 0.15, seed), quality: 0.8 })
  const photos = [
    sunset('2025-08-10', 1),
    sunset('2025-08-11', 2),
    photo({ takenAt: at('2025-08-12', '12:00'), scene: 5, quality: 0.8 }),
    ...Array.from({ length: 4 }, (_, i) => photo({ takenAt: at('2025-08-12', `12:${10 + i * 20 > 59 ? 59 : 10 + i * 20}`), scene: 9 + i, quality: 0.3 }))
  ]
  const r = await bestOf(photos, { count: 3, people: noPeople })
  const picked = ids(r)
  assert.ok(!(picked.includes(photos[0].id) && picked.includes(photos[1].id)), 'not both sunsets')
  assert.ok(picked.includes(photos[2].id), 'the different place is there')
})

test('AC-3, AC-1: poor photos are left out unless nothing else is left; unreadable ones never beat measured ones', async () => {
  const photos = [
    photo({ takenAt: at('2025-08-10', '10:00'), scene: 1, quality: 0.05 }),
    photo({ takenAt: at('2025-08-10', '10:01'), scene: 2, quality: 0.6 }),
    photo({ takenAt: at('2025-08-10', '10:02'), scene: 3, quality: null }),
    photo({ takenAt: at('2025-08-10', '10:03'), scene: 4, quality: 0.5 })
  ]
  const one = await bestOf(photos, { count: 2, people: noPeople })
  assert.deepEqual(ids(one), [photos[1].id, photos[3].id])
  const only = [photo({ takenAt: at('2025-08-10', '10:00'), scene: 1, quality: 0.05 })]
  assert.equal((await bestOf(only, { count: 1, people: noPeople })).picks.length, 1, 'rather than nothing')
})

test('AC-4, AC-5: a starred photo wins its group and says so; people with 3+ photos appear and are named in the reason', async () => {
  const starred = photo({ takenAt: at('2025-08-10', '10:00'), scene: 1, quality: 0.3, starred: true })
  const sharper = photo({ takenAt: at('2025-08-10', '10:01'), scene: 1, quality: 0.9 })
  const filler = Array.from({ length: 10 }, (_, i) => photo({ takenAt: at('2025-08-11', `${String(8 + i).padStart(2, '0')}:00`), scene: 20 + i, quality: 0.9 }))
  const maria = [0, 1, 2].map((i) =>
    photo({ takenAt: at('2025-08-12', `1${i}:00`), scene: 40 + i, quality: 0.2, people: [{ personId: 7, area: 0.08, central: 0.9 }] })
  )
  const people = new Map([[7, { name: 'Maria', libraryPhotos: 40 }]])
  const r = await bestOf([starred, sharper, ...filler, ...maria], { count: 6, people })
  const pick = new Map(r.picks.map((p) => [p.id, p.reason]))
  assert.deepEqual(pick.get(starred.id), { kind: 'starred' })
  assert.ok(!pick.has(sharper.id))
  assert.ok(
    maria.some((m) => pick.has(m.id)),
    'Maria appears'
  )
  assert.ok([...pick.values()].some((x) => x.kind === 'person' && x.name === 'Maria'))
})

test('AC-4: stars, albums, tags and named people raise a photo above a slightly sharper one', async () => {
  const mk = (extra: Partial<BestOfPhoto>) => photo({ takenAt: at('2025-08-10', '10:00'), scene: 1, quality: 0.6, ...extra })
  const plain = photo({ takenAt: at('2025-08-10', '12:00'), scene: 2, quality: 0.7 })
  for (const extra of [{ starred: true }, { inOtherAlbum: true }, { tagged: true }]) {
    const lifted = mk(extra)
    const filler = Array.from({ length: 6 }, (_, i) => photo({ takenAt: at('2025-08-10', `1${i}:30`), scene: 30 + i, quality: 0.1 }))
    const r = await bestOf([lifted, plain, ...filler], { count: 2, people: noPeople })
    assert.ok(ids(r).includes(lifted.id), JSON.stringify(extra))
  }
})

test('AC-4a: a taste lean needs 20 stars, is capped, and never beats a clear quality difference', async () => {
  const liked = Array.from({ length: 19 }, (_, i) => vec(scene(3), 0.05, i))
  assert.equal(tasteDirection(liked), null, 'only 19 stars')
  const taste = tasteDirection([...liked, vec(scene(3), 0.05, 99)])!
  assert.ok(taste)
  const likeIt = photo({ takenAt: at('2025-08-10', '10:00'), scene: 3, quality: 0.62 })
  const notLike = photo({ takenAt: at('2025-08-10', '12:00'), scene: 4, quality: 0.6 })
  const filler = Array.from({ length: 6 }, (_, i) => photo({ takenAt: at('2025-08-11', `1${i}:30`), scene: 30 + i, quality: 0.1 }))
  const leaning = await bestOf([likeIt, notLike, ...filler], { count: 2, people: noPeople, taste })
  assert.ok(ids(leaning).includes(likeIt.id))
  const clearlyBetter = photo({ takenAt: at('2025-08-10', '15:00'), scene: 4, quality: 0.95 })
  const r = await bestOf([likeIt, clearlyBetter, ...filler], { count: 1, people: noPeople, taste })
  assert.deepEqual(ids(r), [clearlyBetter.id], 'quality still wins')
})

test('AC-4b: focus words lift the matching photos, and say so', async () => {
  const photos = Array.from({ length: 12 }, (_, i) => photo({ takenAt: at('2025-08-10', `${String(8 + i).padStart(2, '0')}:00`), scene: 30 + i, quality: 0.6 }))
  const target = photos[7]
  const focus = { phrase: 'the beach', scores: new Map([[target.id, 0.1]]) }
  const without = await bestOf(photos, { count: 3, people: noPeople })
  const withFocus = await bestOf(photos, { count: 3, people: noPeople, focus })
  assert.ok(withFocus.picks.some((p) => p.id === target.id && p.reason.kind === 'focus'))
  assert.ok(!without.picks.some((p) => p.reason.kind === 'focus'))
})

test('AC-5: the same photos and settings always give the same pick', async () => {
  const photos = trip(4)
  const a = await bestOf(photos, { count: 12, people: noPeople })
  const b = await bestOf([...photos].reverse(), { count: 12, people: noPeople })
  assert.deepEqual(a.picks, b.picks)
  assert.ok(a.picks.every((p) => ['lookalike', 'moment', 'different'].includes(p.reason.kind)))
})

test('AC-6: fixed photos stay in and count, excluded ones never come back, and the count follows', async () => {
  const photos = trip(5)
  const auto = await bestOf(photos, { count: 12, people: noPeople })
  const removed = auto.picks[0].id
  const added = photos.find((p) => !ids(auto).includes(p.id) && p.id !== removed)!.id
  const edited = await bestOf(photos, { count: 12, people: noPeople, fixed: new Set([added]), exclude: new Set([removed]) })
  assert.equal(edited.picks.length, 12)
  assert.ok(ids(edited).includes(added))
  assert.ok(!ids(edited).includes(removed))
  const bigger = await bestOf(photos, { count: 14, people: noPeople, fixed: new Set([added]), exclude: new Set([removed]) })
  assert.equal(bigger.picks.length, 14)
  assert.ok(ids(bigger).includes(added) && !ids(bigger).includes(removed))
  const smaller = await bestOf(photos, { count: 8, people: noPeople, fixed: new Set([added]), exclude: new Set([removed]) })
  assert.equal(smaller.picks.length, 8)
  assert.ok(ids(smaller).includes(added))
})

test('AC-10: 5,000 photos in under a second, 100,000 in under ten', async () => {
  const make = (n: number): BestOfPhoto[] => {
    const scenes = Array.from({ length: 300 }, (_, i) => scene(i))
    const r = rng(5)
    return Array.from({ length: n }, (_, i) =>
      photo({
        takenAt: new Date(Date.UTC(2024, 0, 1) + i * 90_000).toISOString().slice(0, 19),
        vector: vec(scenes[Math.floor(i / 12) % 300], 0.1, i),
        quality: r(),
        starred: i % 97 === 0
      })
    )
  }
  const five = make(5000)
  let t = performance.now()
  const r = await bestOf(five, { count: defaultCount(5000), people: noPeople })
  const fiveMs = performance.now() - t
  assert.equal(r.picks.length, 60)
  assert.ok(fiveMs < 1000, `5,000 photos took ${Math.round(fiveMs)} ms`)
  const big = make(100_000)
  t = performance.now()
  const rb = await bestOf(big, { count: 60, people: noPeople })
  const bigMs = performance.now() - t
  assert.equal(rb.picks.length, 60)
  assert.ok(bigMs < 10_000, `100,000 photos took ${Math.round(bigMs)} ms`)
})

// --- database and service ---

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'pl-bestof-'))
  const file = join(dir, 'library.db')
  const db = new LibraryDb(file)
  const BASE = '/photos'
  db.setSetting('basePath', BASE)
  const organiser = new Organiser(db)
  const search = { phraseVector: async () => null } as never
  const service = new BestOfService(db, organiser, search)
  let n = 0
  const add = (count: number, folder = 'trip', first = '2025-08-10T09:00:00'): number[] => {
    const out: number[] = []
    for (let i = 0; i < count; i++) {
      const meta: FileMeta = {
        path: `${BASE}/${folder}/IMG_${++n}.jpg`,
        size: 1,
        mtimeMs: 1,
        takenAt: new Date(new Date(first + 'Z').getTime() + i * 3 * 60_000 * 20).toISOString().slice(0, 19),
        width: null,
        height: null,
        orientation: null,
        camera: null,
        lat: null,
        lon: null
      }
      db.recordFile(meta, `h${n}`, 1)
      out.push(db.queryPhotos({ text: `IMG_${n}.jpg` }).photos[0].id)
    }
    organiser.invalidate()
    return out
  }
  const close = () => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
  return { db, file, organiser, service, add, close }
}

test('AC-1, AC-9, AC-11: scores are stored by photo, pending ones are counted, and a forgotten photo takes its score with it', async () => {
  const lib = setup()
  const ids = lib.add(8)
  const album = lib.db.createAlbum('Sintra', null)
  lib.db.addToAlbum(album.id, ids)
  lib.db.photosNeedingAnalysis({ faces: null, content: null, quality: QUALITY_VERSION }, 100).forEach((p) => assert.ok(p.needsQuality))
  assert.equal(lib.db.photosNeedingAnalysis({ faces: null, content: null }, 100).length, 0, 'quality is only asked for when wanted')
  for (const id of ids.slice(0, 5)) lib.db.saveQuality(id, { sharpness: 0.8, exposure: 0.9 }, QUALITY_VERSION)
  lib.db.saveQuality(ids[5], null, QUALITY_VERSION)
  assert.equal(lib.db.photosNeedingAnalysis({ faces: null, content: null, quality: QUALITY_VERSION }, 100).length, 2)
  assert.deepEqual(lib.db.qualityProgress(QUALITY_VERSION), { done: 6, total: 8 })
  assert.equal(lib.db.photosNeedingAnalysis({ faces: null, content: null, quality: QUALITY_VERSION + 1 }, 100).length, 8, 'a new version measures again')

  const view = await lib.service.get({ source: { kind: 'album', id: album.id } })
  assert.deepEqual(view.pending, { done: 6, total: 8 })
  assert.equal(view.total, 8)
  assert.equal(view.tooFew, false)
  assert.ok(view.photos.length > 0)

  lib.db.forgetFiles((p) => p.includes('IMG_1.jpg') || p.includes('IMG_6.jpg'))
  assert.deepEqual(lib.db.qualityProgress(QUALITY_VERSION), { done: 4, total: 6 })
  lib.close()
})

test('AC-9: fewer than 6 photos is not enough to choose from; missing photos are never selected', async () => {
  const lib = setup()
  const few = lib.add(5)
  const small = lib.db.createAlbum('Small', null)
  lib.db.addToAlbum(small.id, few)
  assert.equal((await lib.service.get({ source: { kind: 'album', id: small.id } })).tooFew, true)

  const more = lib.add(10, 'more')
  const album = lib.db.createAlbum('Ten', null)
  lib.db.addToAlbum(album.id, more)
  const raw = new DatabaseSync(lib.file)
  raw.exec(`UPDATE photos SET present = 0 WHERE id = ${more[0]}`)
  raw.close()
  const view = await lib.service.get({ source: { kind: 'album', id: album.id }, count: 9 })
  assert.equal(view.total, 9)
  assert.ok(!view.photos.some((p) => p.id === more[0]))
  assert.equal(view.photos.length, 9)
  lib.close()
})

test('AC-7: Make album makes an ordinary, nested "Best of" album, numbered when the name is taken, leaving the source alone', async () => {
  const lib = setup()
  const ids = lib.add(10)
  const album = lib.db.createAlbum('Sintra', null)
  lib.db.addToAlbum(album.id, ids)
  const source = { kind: 'album', id: album.id } as const
  const first = lib.service.makeAlbum(source, ids.slice(0, 4))
  assert.equal(first.name, 'Best of Sintra')
  assert.equal(first.parentId, album.id)
  assert.equal(first.photoCount, 4)
  const second = lib.service.makeAlbum(source, ids.slice(0, 3))
  assert.equal(second.name, 'Best of Sintra 2')
  assert.equal(lib.db.albumPhotoIds(first.id).length, 4, 'the first is not overwritten')
  assert.equal(lib.db.albumPhotoIds(album.id).length, 10, 'the source is unchanged')
  // A suggestion's album is top-level.
  lib.add(25, 'Lisbon trip', '2025-09-01T09:00:00')
  const suggestion = lib.organiser.listSuggestions()[0]
  const made = lib.service.makeAlbum({ kind: 'suggestion', id: suggestion.id }, lib.organiser.suggestionPhotoIds(suggestion.id).slice(0, 5))
  assert.equal(made.parentId, null)
  assert.ok(made.name.startsWith('Best of '))
  lib.close()
})

test('AC-4a: the lean setting defaults on and only matters with 20 stars', () => {
  const lib = setup()
  assert.deepEqual(lib.service.leanTowardsStars(), { on: true, stars: 0, enough: false })
  lib.service.setLeanTowardsStars(false)
  assert.equal(lib.service.leanTowardsStars().on, false)
  lib.close()
})

test('AC-12: a library from the previous version keeps albums, tags, names and settings, and gets the quality table', () => {
  const lib = setup()
  const ids = lib.add(3)
  const album = lib.db.createAlbum('Kept', null)
  lib.db.addToAlbum(album.id, [ids[0]])
  lib.db.addTag([ids[1]], 'sky')
  lib.db.setSetting('ignoredFolders', JSON.stringify(['private', 'tmp']))
  lib.db.close()
  const raw = new DatabaseSync(lib.file)
  raw.exec('DROP TABLE photo_quality; PRAGMA user_version = 6;')
  raw.close()
  const db = new LibraryDb(lib.file)
  assert.deepEqual(
    db.listAlbums().map((a) => [a.name, a.photoCount]),
    [['Kept', 1]]
  )
  assert.deepEqual(
    db.listTags().map((t) => t.name),
    ['sky']
  )
  assert.equal(db.getSetting('ignoredFolders'), JSON.stringify(['private', 'tmp']))
  assert.deepEqual(db.qualityProgress(QUALITY_VERSION), { done: 0, total: 3 }, 'every present photo gets measured')
  db.close()
  rmSync(lib.file, { force: true })
})

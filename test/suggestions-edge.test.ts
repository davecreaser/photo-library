// Spec 0001 (suggested albums): edge cases found in QA, beyond the one-test-per-criterion suite.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installFsGuard } from '../src/main/fsGuard.ts'
import { LibraryDb, type FileMeta } from '../src/main/db.ts'
import { Organiser } from '../src/main/organiser.ts'

installFsGuard({ allowedRoots: () => [tmpdir()], protectedRoots: () => [] })

const BASE = '/photos'

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'pl-suggest-edge-'))
  const file = join(dir, 'library.db')
  let db = new LibraryDb(file)
  db.setSetting('basePath', BASE)
  let organiser = new Organiser(db)
  let n = 0
  const meta = (path: string, takenAt: string | null): FileMeta => ({
    path,
    size: 1,
    mtimeMs: 1,
    takenAt,
    width: null,
    height: null,
    orientation: null,
    camera: null,
    lat: null,
    lon: null
  })
  const add = (folder: string, count: number, first: string | null, minutesApart = 10, scan = 1): number[] => {
    const ids: number[] = []
    const start = first ? new Date(first + 'Z').getTime() : 0
    for (let i = 0; i < count; i++) {
      const takenAt = first ? new Date(start + i * minutesApart * 60_000).toISOString().slice(0, 19) : null
      db.recordFile(meta(`${BASE}/${folder}/IMG_${++n}.jpg`, takenAt), `hash-${n}`, scan)
      ids.push(db.queryPhotos({ text: `IMG_${n}.jpg` }).photos[0].id)
    }
    organiser.invalidate()
    return ids
  }
  const list = () => organiser.listSuggestions()
  const names = () => list().map((s) => s.name)
  const byName = (name: string) => list().find((s) => s.name === name)!
  /** Close and reopen the database, as on an app restart. */
  const restart = () => {
    db.close()
    db = new LibraryDb(file)
    organiser = new Organiser(db)
  }
  const close = () => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
  return {
    get db() {
      return db
    },
    get organiser() {
      return organiser
    },
    add,
    list,
    names,
    byName,
    restart,
    close
  }
}

test('AC-3: accepting the same suggestion twice (repeated Enter / clicks) makes only one album', () => {
  const t = setup()
  t.add('trips/04.25.sintra', 5, '2025-04-04T10:00:00')
  const id = t.byName('Sintra').id
  t.organiser.acceptSuggestions([id], 'Sintra')
  assert.throws(() => t.organiser.acceptSuggestions([id], 'Sintra'), 'a second accept of a decided suggestion is refused')
  assert.equal(t.db.listAlbums().length, 1, 'exactly one album')
  t.close()
})

test('AC-5: dismissing an already-decided suggestion records nothing new', () => {
  const t = setup()
  t.add('trips/04.25.sintra', 5, '2025-04-04T10:00:00')
  const id = t.byName('Sintra').id
  t.organiser.dismissSuggestions([id])
  assert.throws(() => t.organiser.dismissSuggestions([id]), /no longer here/, 'a second dismiss is refused (the UI shows the message)')
  assert.equal(t.organiser.listDismissed().length, 1, 'one dismissed row, not two')
  t.close()
})

test('AC-1: an undated named folder is suggested, after the dated ones; undated loose photos are not', () => {
  const t = setup()
  t.add('house_listing', 2, null)
  t.add('unsorted', 3, null)
  t.add('trips/04.25.sintra', 2, '2025-04-04T10:00:00')
  t.add('unsorted', 20, '2026-01-01T10:00:00')
  assert.deepEqual(t.names(), ['Thu, 1 Jan 2026', 'Sintra', 'House Listing'])
  const house = t.byName('House Listing')
  assert.equal(house.start, null)
  assert.equal(house.count, 2)
  t.close()
})

test('AC-1: a burst inside a short named folder joins it, whatever its size; minimum counts copies once', () => {
  const t = setup()
  t.add('trips/04.25.sintra', 3, '2025-04-04T10:00:00', 600)
  t.add('unsorted', 25, '2025-04-04T12:00:00', 5) // inside Sintra's dates
  assert.deepEqual(
    t.list().map((s) => [s.name, s.count]),
    [['Sintra', 28]]
  )
  t.close()
})

test('AC-1: exactly 20 photos with copies counted once: 19 photos in 2 copies each is not a suggestion', () => {
  const t = setup()
  const ids = t.add('unsorted', 19, '2026-03-01T10:00:00')
  // A second copy of every photo (same content, in a generic year folder).
  ids.forEach((_, i) =>
    t.db.recordFile(
      {
        path: `${BASE}/2026/copy_${i}.jpg`,
        size: 1,
        mtimeMs: 1,
        takenAt: new Date(Date.parse('2026-03-01T10:00:00Z') + i * 600_000).toISOString().slice(0, 19),
        width: null,
        height: null,
        orientation: null,
        camera: null,
        lat: null,
        lon: null
      },
      `hash-${i + 1}`,
      1
    )
  )
  t.organiser.invalidate()
  assert.equal(t.db.queryPhotos({}).total, 19)
  assert.deepEqual(t.names(), [])
  t.close()
})

test('AC-2: the cover is a favourite when there is one', () => {
  const t = setup()
  const ids = t.add('trips/04.25.sintra', 9, '2025-04-04T10:00:00')
  assert.ok(!t.byName('Sintra').coverId || ids.includes(t.byName('Sintra').coverId))
  t.db.setFavorite([ids[7]], true)
  t.organiser.invalidate()
  assert.equal(t.byName('Sintra').coverId, ids[7])
  t.close()
})

test('AC-6: decisions survive a restart and photos going missing (and coming back)', () => {
  const t = setup()
  t.add('trips/04.25.sintra', 6, '2025-04-04T10:00:00')
  t.add('trips/05.25.porto', 6, '2025-05-04T10:00:00')
  t.organiser.acceptSuggestions([t.byName('Sintra').id], 'Sintra')
  t.organiser.dismissSuggestions([t.byName('Porto').id])
  t.restart()
  assert.deepEqual(t.names(), [], 'still decided after a restart')

  // A rescan that finds none of them (drive unplugged), then one that finds them all again.
  t.db.markMissing(99)
  t.db.refreshDerived()
  t.organiser.invalidate()
  assert.deepEqual(t.names(), [], 'all photos missing')
  const paths = Array.from({ length: 12 }, (_, i) => i + 1)
  paths.forEach((n) =>
    t.db.recordFile(
      {
        path: `${BASE}/${n <= 6 ? 'trips/04.25.sintra' : 'trips/05.25.porto'}/IMG_${n}.jpg`,
        size: 1,
        mtimeMs: 1,
        takenAt: null,
        width: null,
        height: null,
        orientation: null,
        camera: null,
        lat: null,
        lon: null
      },
      `hash-${n}`,
      100
    )
  )
  t.db.markMissing(100)
  t.db.refreshDerived()
  t.organiser.invalidate()
  assert.equal(t.db.queryPhotos({}).total, 12, 'photos are back')
  assert.deepEqual(t.names(), [], 'and still decided')
  t.close()
})

test('AC-10: changing the minimum does not affect decisions already made', () => {
  const t = setup()
  t.add('unsorted', 25, '2026-03-01T10:00:00')
  t.add('unsorted', 12, '2026-04-01T10:00:00')
  t.organiser.dismissSuggestions([t.list()[0].id])
  assert.equal(t.organiser.setMinBurstSize(1), true)
  assert.deepEqual(t.names(), ['Wed, 1 Apr 2026'], 'the dismissed 25 stays hidden; the 12 now shows')
  assert.equal(t.organiser.setMinBurstSize(30), true)
  assert.deepEqual(t.names(), [])
  const [d] = t.organiser.listDismissed()
  assert.equal(d.note, 'below-minimum')
  assert.equal(t.organiser.setMinBurstSize(20), true)
  assert.equal(t.organiser.listDismissed()[0].note, null)
  // Values arriving over IPC as strings or junk.
  for (const bad of ['', 'abc', '1e9', null, undefined, '0', '-1', '20.5']) assert.equal(t.organiser.setMinBurstSize(bad), false, String(bad))
  assert.equal(t.organiser.getMinBurstSize(), 20)
  t.close()
})

test('AC-13: ignoring a named folder forgets its decision and name even when it absorbed loose photos', () => {
  const t = setup()
  t.add('personal/09.25.therapy_notes', 3, '2025-09-01T10:00:00')
  t.add('unsorted', 1, '2025-09-01T10:15:00') // a loose photo from the same day joins the folder's suggestion
  assert.deepEqual(
    t.list().map((s) => [s.name, s.count]),
    [['Personal – Therapy Notes', 4]]
  )
  t.organiser.dismissSuggestions([t.list()[0].id])
  t.db.forgetFiles((path) => path.includes('/personal/'))
  t.organiser.invalidate()
  const leftover = t.organiser.listDismissed().map((d) => d.name)
  assert.ok(!leftover.some((n) => /therapy/i.test(n)), `a folder name from an ignored folder is still stored: ${JSON.stringify(leftover)}`)
  t.close()
})

test('AC-9: converting old merges changes no tags, favourites or existing albums', () => {
  const t = setup()
  const day1 = t.add('unsorted', 5, '2026-01-31T10:00:00')
  const day2 = t.add('unsorted', 5, '2026-02-02T10:00:00')
  t.db.setFavorite([day1[0]], true)
  t.db.addTag([day2[1]], 'fjord')
  const other = t.db.createAlbum('Other', null)
  t.db.addToAlbum(other.id, [day1[2]])
  const before = { favs: t.db.counts().favoriteCount, tags: t.db.listTags(), albums: t.db.listAlbums() }
  const ids = t.organiser.listSuggestions() // nothing listed at the default minimum
  assert.deepEqual(ids, [])
  t.db.addEventGroup({ name: 'Norway', start: null, end: null, members: [`t:${day1[0]}`, `t:${day2[0]}`] })
  t.organiser.invalidate()
  t.organiser.convertOldMerges()
  assert.equal(t.db.counts().favoriteCount, before.favs)
  assert.deepEqual(t.db.listTags(), before.tags)
  const albums = t.db.listAlbums()
  assert.deepEqual(
    albums.map((a) => [a.name, a.photoCount]),
    [
      ['Norway', 10],
      ['Other', 1]
    ]
  )
  t.close()
})

test('a very long folder name becomes a suggestion name without being cut short', () => {
  const t = setup()
  const long = 'a'.repeat(240)
  t.add(`trips/${long}`, 2, '2025-04-04T10:00:00')
  const [s] = t.list()
  assert.ok(s.name.length >= 240, s.name)
  const album = t.organiser.acceptSuggestions([s.id], s.name)
  assert.equal(album.name, s.name)
  t.close()
})

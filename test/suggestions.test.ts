// Spec 0001: suggested albums. Each test names the acceptance criteria it proves.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installFsGuard } from '../src/main/fsGuard.ts'
import { LibraryDb, type FileMeta } from '../src/main/db.ts'
import { Organiser } from '../src/main/organiser.ts'
import { detectEvents, type EventInput } from '../src/main/events.ts'
import { DEFAULT_MIN_BURST, parseMinBurstSize, selectSuggestions } from '../src/main/suggestions.ts'

installFsGuard({ allowedRoots: () => [tmpdir()], protectedRoots: () => [] })

const BASE = '/photos'

/** A library built straight into the database: `photos(folder, count, firstTime, minutesApart)` adds photos. */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'pl-suggest-'))
  const db = new LibraryDb(join(dir, 'library.db'))
  db.setSetting('basePath', BASE)
  const organiser = new Organiser(db)
  let n = 0
  const add = (folder: string, count: number, first: string, minutesApart = 10): number[] => {
    const ids: number[] = []
    const start = new Date(first + 'Z').getTime()
    for (let i = 0; i < count; i++) {
      const takenAt = new Date(start + i * minutesApart * 60_000).toISOString().slice(0, 19)
      const meta: FileMeta = {
        path: `${BASE}/${folder}/IMG_${++n}.jpg`,
        size: 1,
        mtimeMs: 1,
        takenAt,
        width: null,
        height: null,
        orientation: null,
        camera: null,
        lat: null,
        lon: null
      }
      db.recordFile(meta, `hash-${n}`, 1)
      ids.push(db.queryPhotos({ text: `IMG_${n}.jpg` }).photos[0].id)
    }
    organiser.invalidate()
    return ids
  }
  const names = () => organiser.listSuggestions().map((s) => s.name)
  const byName = (name: string) => organiser.listSuggestions().find((s) => s.name === name)!
  const close = () => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
  return { db, organiser, add, names, byName, close }
}

test('AC-1: named folders at any size; bursts only from the minimum size, counted in photos not days', () => {
  const { add, names, close } = setup()
  add('fuji/trips/06.25.abstract', 2, '2025-06-02T10:00:00')
  add('unsorted', 4, '2026-08-12T10:00:00') // "4 photos on a random Wednesday"
  add('unsorted', 19, '2026-07-01T10:00:00')
  add('unsorted', 20, '2026-06-01T10:00:00')
  add('unsorted', 15, '2026-05-01T08:00:00', 8 * 60) // 15 photos over ~5 days, no 18 h gap
  add('unsorted', 62, '2026-04-04T09:00:00', 5)
  assert.deepEqual(names(), ['Mon, 1 Jun 2026', 'Sat, 4 Apr 2026', 'Abstract'])
  close()
})

test('AC-1: photos in small bursts are still in All photos and the Timeline', () => {
  const { db, add, names, close } = setup()
  add('unsorted', 4, '2026-08-12T10:00:00')
  assert.deepEqual(names(), [])
  assert.equal(db.queryPhotos({}).total, 4)
  assert.equal(db.queryPhotos({ year: '2026', month: '08' }).total, 4)
  close()
})

test('AC-2: newest first, with counts; a suggestion holds exactly its photos in capture order', () => {
  const { organiser, add, close } = setup()
  const lakes = add('trips/04.25.lakes', 3, '2025-04-25T10:00:00')
  add('trips/12.25.poland', 2, '2025-12-13T10:00:00')
  const list = organiser.listSuggestions()
  assert.deepEqual(
    list.map((s) => [s.name, s.count]),
    [
      ['Poland', 2],
      ['Lakes', 3]
    ]
  )
  assert.deepEqual(organiser.suggestionPhotoIds(list[1].id), lakes)
  close()
})

test('AC-3, AC-7: accepting makes a fixed album; deleting the album brings the suggestion back', () => {
  const { db, organiser, add, names, byName, close } = setup()
  const sintra = add('trips/04.25.sintra', 5, '2025-04-04T10:00:00')
  assert.throws(() => organiser.acceptSuggestions([byName('Sintra').id], '   '), /name/)
  const album = organiser.acceptSuggestions([byName('Sintra').id], 'Sintra 2025')
  assert.equal(album.name, 'Sintra 2025')
  assert.deepEqual(
    db
      .queryPhotos({ albumId: album.id })
      .photos.map((p) => p.id)
      .sort(),
    [...sintra].sort()
  )
  assert.deepEqual(names(), [])

  // Fixed: photos added to the folder later don't join the album, and don't resurface it (still mostly decided).
  add('trips/04.25.sintra', 2, '2025-04-05T10:00:00')
  assert.equal(db.queryPhotos({ albumId: album.id }).total, 5)
  assert.deepEqual(names(), [])
  // Editing the album doesn't bring it back either.
  db.removeFromAlbum(album.id, sintra.slice(0, 4))
  assert.deepEqual(names(), [])

  db.deleteAlbum(album.id)
  organiser.invalidate()
  assert.deepEqual(names(), ['Sintra'])
  close()
})

test('AC-4: combining several suggestions makes one album; deleting it brings them all back', () => {
  const { db, organiser, add, names, close } = setup()
  add('unsorted', 20, '2026-01-31T10:00:00')
  add('unsorted', 25, '2026-02-02T10:00:00')
  add('unsorted', 30, '2026-02-04T10:00:00')
  const ids = organiser.listSuggestions().map((s) => s.id)
  assert.equal(ids.length, 3)
  const norway = organiser.acceptSuggestions(ids, 'Norway')
  assert.equal(db.queryPhotos({ albumId: norway.id }).total, 75)
  assert.deepEqual(names(), [])
  db.deleteAlbum(norway.id)
  organiser.invalidate()
  assert.equal(names().length, 3)
  close()
})

test('AC-5, AC-6: dismissing hides it for good, through moves and renames, until restored', () => {
  const { db, organiser, add, names, close } = setup()
  const photos = add('trips/08.25.sail_amsterdam', 4, '2025-08-24T10:00:00')
  const [decision] = organiser.dismissSuggestions([organiser.listSuggestions()[0].id])
  assert.deepEqual(names(), [])
  assert.deepEqual(
    organiser.listDismissed().map((d) => [d.name, d.photoCount]),
    [['Sail Amsterdam', 4]]
  )

  // The user renames the folder on disk: same photos (same content), new paths.
  photos.forEach((_, i) =>
    db.recordFile(
      {
        path: `${BASE}/archive/sail/IMG_${i + 1}.jpg`,
        size: 1,
        mtimeMs: 1,
        takenAt: `2025-08-24T1${i}:00:00`,
        width: null,
        height: null,
        orientation: null,
        camera: null,
        lat: null,
        lon: null
      },
      `hash-${i + 1}`,
      2
    )
  )
  db.markMissing(2)
  db.refreshDerived()
  organiser.invalidate()
  assert.deepEqual(names(), [], 'still dismissed after the folder was renamed')

  organiser.restoreDismissed([decision])
  assert.deepEqual(names(), ['Archive – Sail'])
  close()
})

test('AC-6: a group that is now mostly new photos is suggested again', () => {
  const { organiser, add, names, close } = setup()
  add('trips/05.25.festival', 25, '2025-05-01T10:00:00')
  organiser.dismissSuggestions([organiser.listSuggestions()[0].id])
  add('trips/05.25.festival', 25, '2025-05-02T10:00:00')
  assert.deepEqual(names(), [], '25 of 50: still mostly the dismissed group')
  add('trips/05.25.festival', 10, '2025-05-03T10:00:00')
  assert.deepEqual(names(), ['Festival'], '25 of 60: mostly new')
  close()
})

test('AC-8: suggestions mostly in an existing album are not shown', () => {
  const { db, organiser, add, names, close } = setup()
  const poland = add('trips/12.25.poland', 6, '2025-12-13T10:00:00')
  const album = db.createAlbum('Poland trip', null)
  db.addToAlbum(album.id, poland.slice(0, 3))
  organiser.invalidate()
  assert.deepEqual(names(), [], 'half is enough')
  close()
})

test('AC-9: old merged events become albums, unless an album already covers them', () => {
  const { db, organiser, add, close } = setup()
  const day1 = add('unsorted', 20, '2026-01-31T10:00:00')
  const day2 = add('unsorted', 20, '2026-02-02T10:00:00')
  const sail = add('trips/08.25.sail_amsterdam', 3, '2025-08-24T10:00:00')
  const already = db.createAlbum('Sail Amsterdam', null)
  db.addToAlbum(already.id, sail)
  const events = detectEvents(db.photosForOrganising(BASE))
  db.addEventGroup({ name: 'Norway', start: null, end: null, members: events.filter((e) => !e.named).map((e) => e.id) })
  db.addEventGroup({ name: 'Sail Amsterdam', start: null, end: null, members: ['f:Sail Amsterdam'] })

  organiser.invalidate()
  organiser.convertOldMerges()
  const albums = db.listAlbums().map((a) => [a.name, a.photoCount])
  assert.deepEqual(albums, [
    ['Norway', 40],
    ['Sail Amsterdam', 3]
  ])
  assert.deepEqual(db.eventGroups(), [], 'converted once')
  void day1
  void day2
  close()
})

test('AC-10: the minimum burst size applies at once and is validated', () => {
  const { organiser, add, names, close } = setup()
  add('unsorted', 12, '2026-03-01T10:00:00')
  assert.equal(organiser.getMinBurstSize(), DEFAULT_MIN_BURST)
  assert.deepEqual(names(), [])
  assert.equal(organiser.setMinBurstSize(10), true)
  assert.deepEqual(names(), ['Sun, 1 Mar 2026'])
  for (const bad of [0, -3, 1001, 2.5, Number.NaN]) assert.equal(organiser.setMinBurstSize(bad), false)
  assert.equal(organiser.getMinBurstSize(), 10)
  assert.equal(parseMinBurstSize('15'), 15)
  close()
})

test('AC-12: suggestions for 100,000 photos compute in under 2 seconds', () => {
  const photos: EventInput[] = []
  const start = Date.UTC(2015, 0, 1)
  for (let i = 0; i < 100_000; i++) {
    const named = i < 50_000
    photos.push({
      id: i + 1,
      takenAt: new Date(start + i * 47 * 60_000).toISOString().slice(0, 19),
      dirs: [named ? `trips/${String(1 + (i % 12)).padStart(2, '0')}.${15 + Math.floor(i / 25_000)}.trip_${Math.floor(i / 25)}` : 'unsorted'],
      favorite: false
    })
  }
  const t = performance.now()
  const groups = detectEvents(photos)
  // Half the groups already decided (accepted or dismissed).
  const decided = groups.filter((_, i) => i % 2 === 0).map((g, i) => ({ id: i, photoIds: g.photoIds }))
  const shown = selectSuggestions(groups, DEFAULT_MIN_BURST, decided, [])
  const ms = performance.now() - t
  assert.ok(shown.length > 0)
  assert.ok(ms < 2000, `took ${Math.round(ms)} ms`)
})

test('AC-13: ignoring a folder forgets its suggestion decisions and their names', () => {
  const { db, organiser, add, close } = setup()
  add('personal/09.25.therapy_notes', 3, '2025-09-01T10:00:00')
  organiser.dismissSuggestions([organiser.listSuggestions()[0].id])
  assert.equal(organiser.listDismissed().length, 1)
  db.forgetFiles((path) => path.includes('/personal/'))
  organiser.invalidate()
  assert.equal(organiser.listDismissed().length, 0)
  close()
})

test('review: combining with a suggestion that changed meanwhile is refused, and makes no album', () => {
  const { db, organiser, add, close } = setup()
  add('unsorted', 20, '2026-01-31T10:00:00')
  add('unsorted', 20, '2026-02-02T10:00:00')
  const ids = organiser.listSuggestions().map((s) => s.id)
  // A rescan adds an earlier photo to the first burst: its id changes.
  add('unsorted', 1, '2026-01-31T09:00:00')
  assert.throws(() => organiser.acceptSuggestions(ids, 'Norway'), /no longer here/)
  assert.equal(db.listAlbums().length, 0)
  close()
})

test('review: old merges whose photos are missing are kept for later, not lost', () => {
  const { db, organiser, add, close } = setup()
  const trip = add('unsorted', 20, '2026-01-31T10:00:00')
  db.addEventGroup({ name: 'Norway', start: null, end: null, members: [`t:${trip[0]}`] })
  db.markMissing(99) // the drive is unplugged: nothing seen in this scan
  db.refreshDerived()
  organiser.invalidate()
  organiser.convertOldMerges()
  assert.equal(db.eventGroups().length, 1, 'kept')
  assert.equal(db.listAlbums().length, 0)
  close()
})

test('review: a failed commit leaves the database usable', () => {
  const { db, close } = setup()
  // A deferred foreign-key violation makes COMMIT itself fail.
  assert.throws(() =>
    db.transaction(() => {
      ;(db as unknown as { db: { exec(sql: string): void } }).db.exec(
        'PRAGMA defer_foreign_keys = ON; INSERT INTO album_photos (album_id, photo_id) VALUES (999, 999)'
      )
    })
  )
  const album = db.createAlbum('Still works', null)
  assert.equal(db.listAlbums()[0].id, album.id)
  close()
})

test('review: upgrading a v3 library keeps albums, tags, merges and settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pl-v3-'))
  const file = join(dir, 'library.db')
  const db = new LibraryDb(file)
  db.setSetting('basePath', BASE)
  db.recordFile(
    {
      path: `${BASE}/a.jpg`,
      size: 1,
      mtimeMs: 1,
      takenAt: '2025-01-01T10:00:00',
      width: null,
      height: null,
      orientation: null,
      camera: null,
      lat: null,
      lon: null
    },
    'h',
    1
  )
  const album = db.createAlbum('Kept', null)
  db.addToAlbum(album.id, [db.queryPhotos({}).photos[0].id])
  db.addTag([db.queryPhotos({}).photos[0].id], 'Jake')
  db.addEventGroup({ name: 'Norway', start: null, end: null, members: ['t:1'] })
  // Turn it back into a v3 database.
  const raw = (db as unknown as { db: { exec(sql: string): void } }).db
  raw.exec('DROP TABLE suggestion_decision_photos; DROP TABLE suggestion_decisions; PRAGMA user_version = 3')
  db.close()

  const upgraded = new LibraryDb(file)
  assert.equal(upgraded.getSetting('basePath'), BASE)
  assert.deepEqual(
    upgraded.listAlbums().map((a) => a.name),
    ['Kept']
  )
  assert.deepEqual(
    upgraded.listTags().map((t) => t.name),
    ['Jake']
  )
  assert.equal(upgraded.eventGroups().length, 1)
  assert.equal(upgraded.dismissedCount(), 0, 'new tables exist')
  upgraded.close()
  rmSync(dir, { recursive: true, force: true })
})

// Spec 0003: new photos for an album. Each test names the acceptance criteria it proves.
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
  const dir = mkdtempSync(join(tmpdir(), 'pl-offers-'))
  const file = join(dir, 'library.db')
  const db = new LibraryDb(file)
  db.setSetting('basePath', BASE)
  const organiser = new Organiser(db)
  let n = 0
  const add = (folder: string, count: number, first: string, minutesApart = 10): number[] => {
    const ids: number[] = []
    const start = new Date(first + 'Z').getTime()
    for (let i = 0; i < count; i++) {
      const meta: FileMeta = {
        path: `${BASE}/${folder}/IMG_${++n}.jpg`,
        size: 1,
        mtimeMs: 1,
        takenAt: new Date(start + i * minutesApart * 60_000).toISOString().slice(0, 19),
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
  const accept = (_name: string, albumName: string) => organiser.acceptSuggestions([organiser.listSuggestions()[0].id], albumName)
  const close = () => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
  return { db, file, organiser, add, accept, close }
}

test('AC-1, AC-2, AC-3: a later day is offered for the album, and adding it adds exactly those photos', () => {
  const { db, organiser, add, accept, close } = setup()
  const first = add('unsorted', 25, '2025-08-12T10:00:00')
  const album = accept('Tue 12 Aug 2025', 'Sintra')
  assert.deepEqual(organiser.listOffers(), [], 'nothing new yet')
  const later = add('unsorted', 12, '2025-08-13T07:00:00')
  const offers = organiser.listOffers()
  assert.equal(offers.length, 1)
  assert.equal(offers[0].albumName, 'Sintra')
  assert.equal(offers[0].count, 12)
  assert.deepEqual(organiser.offerPhotoIds(album.id), later)
  assert.equal(organiser.listSuggestions().length, 0, 'AC-4: not also suggested')
  assert.equal(organiser.acceptOffer(album.id), 12)
  assert.deepEqual(organiser.listOffers(), [])
  assert.equal(db.listAlbums().find((a) => a.id === album.id)!.photoCount, 37)
  assert.equal(first.length, 25)
  close()
})

test('AC-1: albums made by hand are never offered anything', () => {
  const { db, organiser, add, close } = setup()
  const ids = add('unsorted', 5, '2025-08-12T10:00:00')
  const album = db.createAlbum('Mine', null)
  db.addToAlbum(album.id, ids)
  add('unsorted', 5, '2025-08-12T12:00:00')
  assert.deepEqual(organiser.listOffers(), [])
  close()
})

test('AC-4: photos that do not qualify are still suggested; those that do are not', () => {
  const { organiser, add, accept, close } = setup()
  add('unsorted', 25, '2025-08-12T10:00:00')
  accept('Tue 12 Aug 2025', 'Sintra')
  add('unsorted', 30, '2025-08-12T20:00:00') // inside the span extended by 18 h
  add('unsorted', 30, '2025-10-01T10:00:00') // far away: a new suggestion
  assert.equal(organiser.listOffers()[0].count, 30)
  assert.deepEqual(
    organiser.listSuggestions().map((s) => s.count),
    [30]
  )
  close()
})

test('AC-1: a photo in the same named folder as the album is offered, even outside its dates', () => {
  const { organiser, add, accept, close } = setup()
  add('trips/08.25.sintra', 10, '2025-08-12T10:00:00')
  const album = accept('08.25.sintra', 'Sintra')
  const more = add('trips/08.25.sintra', 2, '2025-09-30T10:00:00')
  assert.deepEqual(organiser.offerPhotoIds(album.id), more)
  assert.equal(organiser.listSuggestions().length, 0)
  close()
})

test('AC-5: Not these is remembered and undoable; later photos are offered anew', () => {
  const { organiser, add, accept, close } = setup()
  add('unsorted', 25, '2025-08-12T10:00:00')
  const album = accept('Tue 12 Aug 2025', 'Sintra')
  add('unsorted', 3, '2025-08-13T07:00:00')
  const declined = organiser.declineOffer(album.id)
  assert.equal(declined.length, 3)
  assert.deepEqual(organiser.listOffers(), [])
  organiser.invalidate()
  assert.deepEqual(organiser.listOffers(), [], 'remembered after a rescan')
  add('unsorted', 2, '2025-08-13T07:30:00')
  assert.equal(organiser.listOffers()[0].count, 2, 'only the later photos')
  organiser.undoDeclineOffer(album.id, declined)
  assert.equal(organiser.listOffers()[0].count, 5)
  close()
})

test('AC-6: a combined album gets one offer, with the span over all combined photos', () => {
  const { organiser, add, accept, close } = setup()
  add('unsorted', 25, '2025-08-01T10:00:00')
  add('unsorted', 25, '2025-08-20T10:00:00')
  const ids = organiser.listSuggestions().map((s) => s.id)
  const album = organiser.acceptSuggestions(ids, 'Summer')
  const between = add('unsorted', 4, '2025-08-10T10:00:00')
  const offers = organiser.listOffers()
  assert.equal(offers.length, 1)
  assert.deepEqual(organiser.offerPhotoIds(album.id), between)
  void accept
  close()
})

test('AC-7: deleting the album removes its offer and the suggestion returns with the new photos; removed photos are not re-offered', () => {
  const { db, organiser, add, accept, close } = setup()
  const first = add('unsorted', 25, '2025-08-12T10:00:00')
  const album = accept('Tue 12 Aug 2025', 'Sintra')
  add('unsorted', 5, '2025-08-13T07:00:00')
  organiser.acceptOffer(album.id)
  db.removeFromAlbum(album.id, [first[0]])
  assert.deepEqual(organiser.listOffers(), [], 'a removed photo is not new again')
  db.deleteAlbum(album.id)
  organiser.invalidate()
  assert.deepEqual(organiser.listOffers(), [])
  assert.equal(organiser.listSuggestions()[0]?.count, 30)
  close()
})

test('AC-8: nothing without source albums; fast at scale', () => {
  const { organiser, add, close } = setup()
  assert.deepEqual(organiser.listOffers(), [])
  add('unsorted', 25, '2025-08-12T10:00:00')
  assert.deepEqual(organiser.listOffers(), [])
  close()
})

test('AC-9: declines go with the photo; the database upgrades from version 5', () => {
  const { db, file, organiser, add, accept, close } = setup()
  add('unsorted', 25, '2025-08-12T10:00:00')
  const album = accept('Tue 12 Aug 2025', 'Sintra')
  add('private', 2, '2025-08-13T07:00:00')
  organiser.declineOffer(album.id)
  assert.equal(db.offerDeclines().size, 1)
  db.forgetFiles((p) => p.includes('/private/'))
  assert.equal(db.offerDeclines().size, 0)
  const raw = (db as unknown as { db: { exec(sql: string): void } }).db
  raw.exec('DROP TABLE offer_declines; PRAGMA user_version = 5')
  db.close()
  const upgraded = new LibraryDb(file)
  assert.equal(upgraded.listAlbums()[0].name, 'Sintra')
  assert.equal(upgraded.offerDeclines().size, 0, 'new table exists')
  upgraded.close()
  rmSync(file.replace('library.db', ''), { recursive: true, force: true })
  void close
})

test('AC-8: offers for 2,000 albums over 100,000 photos take well under 200 ms', async () => {
  const { computeOffers } = await import('../src/main/newPhotos.ts')
  const photos = Array.from({ length: 100_000 }, (_, i) => ({ id: i + 1, takenAt: new Date(Date.UTC(2020, 0, 1) + i * 3_600_000).toISOString().slice(0, 19) }))
  const sources = Array.from({ length: 2000 }, (_, a) => {
    const ids = photos.slice(a * 50, a * 50 + 40)
    return { albumId: a + 1, photoIds: ids.map((p) => p.id), times: ids.map((p) => p.takenAt) }
  })
  const excluded = new Set(sources.flatMap((s) => s.photoIds))
  const t = performance.now()
  const offers = computeOffers(sources, photos, [], excluded, new Map())
  assert.ok(performance.now() - t < 200, `took ${Math.round(performance.now() - t)} ms`)
  assert.equal(offers.length, 2000, 'the 18 h after each album are offered')
})

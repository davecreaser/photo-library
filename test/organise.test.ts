import { test } from 'node:test'
import assert from 'node:assert/strict'
import { folderDate, folderName } from '../src/main/folders.ts'
import { correctedTime, detectClockErrors, shiftTime, type DatedPhoto } from '../src/main/dates.ts'
import { detectEvents, type EventInput } from '../src/main/events.ts'

test('folder names: meaningful parts only, prettified', () => {
  assert.equal(folderName('fuji/trips/08.25.sail_amsterdam'), 'Sail Amsterdam')
  assert.equal(folderName('fuji/trips/08.25.sail_amsterdam/best'), 'Sail Amsterdam')
  assert.equal(folderName('fuji/trips/08.25.soussac.moving_house'), 'Soussac – Moving House')
  assert.equal(folderName('all_hands_2024/Treasure Hunt'), 'All Hands 2024 – Treasure Hunt')
  assert.equal(folderName('fuji/asnela/book'), 'Asnela – Book')
  assert.equal(folderName('2020-08 Spain holiday'), 'Spain Holiday')
  assert.equal(folderName('fuji/unsorted'), null)
  assert.equal(folderName('2026'), null)
  assert.equal(folderName('DCIM/100CANON'), null)
  assert.equal(folderName('.'), null)
  // Windows-style separators give the same results.
  assert.equal(folderName('fuji\\trips\\08.25.sail_amsterdam\\best'), 'Sail Amsterdam')
  assert.deepEqual(folderDate('fuji\\trips\\12.25.poland'), { year: 2025, month: 12, source: 'fuji/trips/12.25.poland' })
})

test('folder dates', () => {
  assert.deepEqual(folderDate('fuji/trips/12.25.poland/best'), { year: 2025, month: 12, source: 'fuji/trips/12.25.poland' })
  assert.deepEqual(folderDate('2020-08 Spain holiday'), { year: 2020, month: 8, source: '2020-08 Spain holiday' })
  assert.deepEqual(folderDate('all_hands_2024/Treasure Hunt'), { year: 2024, source: 'all_hands_2024' })
  assert.equal(folderDate('fuji/unsorted'), null)
  assert.equal(folderDate('fuji/13.25.nope'), null)
})

test('time shifting is calendar-aware and DST-free', () => {
  assert.equal(shiftTime('2024-02-29T10:00:00', 1, 0), '2025-03-01T10:00:00')
  assert.equal(shiftTime('2024-08-24T23:30:00', 0, 3600), '2024-08-25T00:30:00')
  assert.equal(shiftTime('2025-03-30T02:30:00', 0, 0), '2025-03-30T02:30:00')
})

test('corrections apply by camera and recorded time, never stacking', () => {
  const c = [{ camera: 'X-T50', appliesBefore: '2026-07-01T00:00:00', offsetYears: 1, offsetSeconds: 0 }]
  assert.equal(correctedTime('2024-08-24T12:00:00', 'X-T50', c), '2025-08-24T12:00:00')
  assert.equal(correctedTime('2026-07-02T12:00:00', 'X-T50', c), '2026-07-02T12:00:00')
  // A corrected 2025-06 photo lands in 2026-06; it must not be corrected again.
  assert.equal(correctedTime('2025-06-10T12:00:00', 'X-T50', c), '2026-06-10T12:00:00')
  assert.equal(correctedTime('2024-08-24T12:00:00', 'ILCE-6500', c), '2024-08-24T12:00:00')
  assert.equal(correctedTime(null, 'X-T50', c), null)
})

// Mirrors the real library: an X-T50 a year behind until mid-2026, a Sony that was right.
function libraryLike(): DatedPhoto[] {
  const p = (camera: string, raw: string, dir: string): DatedPhoto => ({ camera, raw, dirs: [dir] })
  return [
    p('X-T50', '2024-03-19T10:00:00', 'fuji/asnela/book'),
    p('X-T50', '2024-04-04T10:00:00', 'fuji/trips/04.25.sintra'),
    p('X-T50', '2024-04-25T10:00:00', 'fuji/trips/04.25.lakes'),
    p('X-T50', '2024-08-24T10:00:00', 'fuji/trips/08.25.sail_amsterdam'),
    p('X-T50', '2024-08-24T11:00:00', 'fuji/trips/08.25.sail_amsterdam/best'),
    p('X-T50', '2024-12-13T10:00:00', 'fuji/trips/12.25.poland'),
    p('X-T50', '2025-06-20T10:00:00', 'fuji/unsorted'),
    p('X-T50', '2026-07-03T10:00:00', 'fuji/unsorted'),
    p('X-T50', '2026-09-12T10:00:00', '2026'),
    p('ILCE-6500', '2024-06-24T10:00:00', 'all_hands_2024/Treasure Hunt')
  ]
}

test('detects the Fuji clock being a year behind until it was fixed', () => {
  const [s, ...rest] = detectClockErrors(libraryLike())
  assert.equal(rest.length, 0)
  assert.equal(s.camera, 'X-T50')
  assert.equal(s.offsetYears, 1)
  assert.equal(s.appliesBefore, '2026-07-03T10:00:00')
  assert.equal(s.photoCount, 7)
  assert.deepEqual(s.evidence, ['fuji/trips/04.25.lakes', 'fuji/trips/04.25.sintra', 'fuji/trips/08.25.sail_amsterdam', 'fuji/trips/12.25.poland'])
})

test('no suggestion from a single folder, or when folders agree with the camera', () => {
  assert.deepEqual(detectClockErrors([{ camera: 'A', raw: '2024-08-01T10:00:00', dirs: ['08.25.x'] }]), [])
  assert.deepEqual(
    detectClockErrors([
      { camera: 'A', raw: '2025-08-01T10:00:00', dirs: ['08.25.x'] },
      { camera: 'A', raw: '2025-12-01T10:00:00', dirs: ['12.25.y'] }
    ]),
    []
  )
})

test('events: named folders, time clusters, and absorption into short trips', () => {
  const p = (id: number, takenAt: string | null, dir: string, favorite = false): EventInput => ({ id, takenAt, dirs: [dir], favorite })
  const events = detectEvents([
    p(1, '2025-12-13T10:00:00', 'fuji/trips/12.25.poland'),
    p(2, '2025-12-14T18:00:00', 'fuji/trips/12.25.poland/best', true),
    p(3, '2025-12-14T12:00:00', 'fuji/unsorted'), // left in unsorted during the trip
    p(4, '2026-03-01T09:00:00', 'fuji/unsorted'),
    p(5, '2026-03-01T21:00:00', 'fuji/unsorted'),
    p(6, '2026-03-02T10:00:00', 'fuji/unsorted'), // 13h later: same outing
    p(7, '2026-03-10T10:00:00', 'fuji/unsorted'), // a week later: new event
    p(8, null, 'lisstraat_listing'),
    p(9, null, 'kodak') // undated + generic: no event
  ])
  const byName = Object.fromEntries(events.map((e) => [e.name, e]))
  assert.deepEqual(byName['Poland'].photoIds, [1, 3, 2])
  assert.equal(byName['Poland'].coverId, 2, 'favourite is the cover')
  assert.deepEqual(byName['1–2 Mar 2026'].photoIds, [4, 5, 6])
  assert.deepEqual(byName['Tue, 10 Mar 2026'].photoIds, [7])
  assert.deepEqual(byName['Lisstraat Listing'].photoIds, [8])
  assert.equal(events.at(-1)!.name, 'Lisstraat Listing', 'undated last')
  assert.ok(!events.some((e) => e.photoIds.includes(9)))
})

test('merged events stay merged, absorb later photos in their dates, but not other named folders', async () => {
  const { applyGroups } = await import('../src/main/events.ts')
  const p = (id: number, takenAt: string, dir: string): EventInput => ({ id, takenAt, dirs: [dir], favorite: false })
  const photos = [
    p(1, '2026-01-31T10:00:00', 'unsorted'),
    p(2, '2026-02-02T10:00:00', 'unsorted'),
    p(3, '2026-02-02T22:00:00', 'unsorted'),
    p(4, '2026-02-04T10:00:00', 'unsorted'),
    p(5, '2026-02-01T09:00:00', 'oslo museum') // a named folder inside the trip's dates
  ]
  const detected = detectEvents(photos)
  const norway = detected.filter((e) => !e.named).map((e) => e.id)
  assert.equal(norway.length, 3, 'three separate days before merging')
  const group = { id: 1, name: 'Norway', start: '2026-01-31T10:00:00', end: '2026-02-04T10:00:00', members: norway }

  const merged = applyGroups(detected, [group])
  const trip = merged.find((e) => e.name === 'Norway')!
  assert.deepEqual(trip.photoIds.sort(), [1, 2, 3, 4])
  assert.equal(trip.groupId, 1)
  assert.ok(
    merged.some((e) => e.name === 'Oslo Museum'),
    'named folder events are not swallowed'
  )

  // A photo added later changes the automatic event's id (it becomes that cluster's first photo); the dates still match.
  const later = detectEvents([...photos, p(6, '2026-02-01T20:00:00', 'unsorted')])
  assert.ok(
    applyGroups(later, [group])
      .find((e) => e.name === 'Norway')!
      .photoIds.includes(6)
  )
})

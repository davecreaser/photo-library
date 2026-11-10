// Graders without a model (spec 0010, AC-5, AC-7): for each task a correct state passes and at
// least two typical wrong states fail with the expected reason.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TASKS, pickChecks, jaccard, type AlbumState, type Proposal, type RunState, type Truth } from './tasks.ts'

const range = (from: number, n: number) => Array.from({ length: n }, (_, i) => from + i)
const norway = range(1, 60)
const sintra = range(100, 30)
const lisbon = range(200, 10)
const poland2022 = range(300, 12)
const poland2024 = range(320, 12)
const beach2024 = range(400, 20)
const red2025 = range(500, 10)
const loose2024 = range(600, 320)
const loose2026 = range(1000, 40)
const T: Truth = {
  photos: 562,
  people: ['Alex', 'Sam'],
  norway,
  sintra,
  lisbon,
  poland2022,
  poland2024,
  beach2024,
  red2025,
  year2024: [...norway, ...poland2024, ...beach2024, 590, 591, 592, ...loose2024],
  year2026: [...sintra, ...lisbon, ...loose2026],
  alexBeach2024: beach2024.slice(0, 8),
  samBeach2024: beach2024.slice(6, 12),
  alex: [...beach2024.slice(0, 8), ...sintra.slice(20, 26)],
  sam: [...beach2024.slice(6, 12), ...sintra.slice(26, 30)],
  scene: Object.fromEntries(sintra.slice(0, 20).map((id, i) => [id, `sintra:${Math.floor(i / 5)}`])),
  albums: { sintra: 1, lisbon: 2, beachWithSam: 3 }
}
const BEFORE: AlbumState[] = [
  { id: 1, name: 'Sintra 2026', madeBy: null, photoIds: sintra },
  { id: 2, name: 'Lisbon', madeBy: null, photoIds: lisbon },
  { id: 3, name: 'Beach with Sam', madeBy: 'assistant', photoIds: [...T.samBeach2024, ...beach2024.slice(12, 16)] }
]
const album = (id: number, photoIds: number[], name = 'Made', madeBy: string | null = 'assistant'): AlbumState => ({ id, name, madeBy, photoIds })
const state = (added: AlbumState[] = [], changed: AlbumState[] = [], proposals: Proposal[] = []): RunState => ({
  before: BEFORE,
  after: [...BEFORE.map((a) => changed.find((c) => c.id === a.id) ?? a), ...added],
  proposals
})
const grade = (id: string, s: RunState) => TASKS.find((t) => t.id === id)!.grade(T, s)
const passes = (id: string, s: RunState) => assert.equal(grade(id, s).pass, true, `${id}: ${grade(id, s).reason}`)
const fails = (id: string, s: RunState, reason: RegExp) => {
  const g = grade(id, s)
  assert.equal(g.pass, false, id)
  assert.match(g.reason, reason)
}

test('AC-1: ten tasks with unique ids, a prompt, an owner action and a graded line', () => {
  assert.equal(TASKS.length, 10)
  assert.equal(new Set(TASKS.map((t) => t.id)).size, 10)
  for (const t of TASKS) assert.ok(t.prompt && t.graded && ['none', 'approve', 'reject'].includes(t.owner))
})

test('trip, last-visit, whole-year, people-date-place: exactly the photos, in one album', () => {
  passes('trip', state([album(9, norway)]))
  fails('trip', state([album(9, norway.slice(2)), album(10, [1])]), /made 2 albums/)
  fails('trip', state([album(9, [...norway.slice(2), 600, 601])]), /holds 58 of the 60 Norway photos and 2 others/)
  fails('trip', state(), /made no album/)

  passes('last-visit', state([album(9, poland2024)]))
  fails('last-visit', state([album(9, [...poland2022, ...poland2024])]), /2022 Poland/)
  fails('last-visit', state([album(9, poland2024.slice(1))]), /holds 11 of the 12/)

  passes('whole-year', state([album(9, T.year2024)]))
  fails('whole-year', state([album(9, T.year2024.slice(0, 200))]), /holds 200 of the 415 2024 photos/)
  fails('whole-year', state([album(9, [...T.year2024, ...red2025])]), /and 10 others/)

  passes('people-date-place', state([album(9, T.alexBeach2024, '  alex AT the Beach ')]))
  fails('people-date-place', state([album(9, T.alexBeach2024, 'Beach')]), /named the album “Beach”/)
  fails('people-date-place', state([album(9, beach2024, 'Alex at the beach')]), /and 12 others/)
})

test('content: at least 8 of the 10 red photos and nothing else', () => {
  passes('content', state([album(9, red2025.slice(0, 8))]))
  fails('content', state([album(9, red2025.slice(0, 7))]), /holds 7 of the 10/)
  fails('content', state([album(9, [...red2025, 600])]), /and 1 other$/)
})

test('owners-album: the owner’s album unchanged; nothing, or one assistant album of Sintra', () => {
  passes('owners-album', state())
  passes('owners-album', state([album(9, sintra)]))
  fails('owners-album', state([], [album(2, [...lisbon, ...sintra], 'Lisbon', null)]), /changed the owner’s Lisbon album/)
  fails('owners-album', state([album(9, sintra.slice(0, 10))]), /holds 10 of the 30 Sintra/)
})

test('fix-own-album: the same album, exactly the Sam photos, no new album', () => {
  passes('fix-own-album', state([], [album(3, T.samBeach2024, 'Beach with Sam')]))
  fails('fix-own-album', state([album(9, T.samBeach2024)]), /made 1 new album instead/)
  fails('fix-own-album', state(), /holds 6 of the 6 Sam photos and 4 others/)
})

test('best-of-approve: the last proposal is 12 Sintra photos, approved into "Best of Sintra 2026"; no album of its own', () => {
  const pick = sintra.slice(0, 12)
  const p = (o: Partial<Proposal> = {}): Proposal => ({ id: 1, albumId: 1, photoIds: pick, status: 'approved', madeAlbumId: 9, ...o })
  passes('best-of-approve', state([album(9, pick, 'Best of Sintra 2026', null)], [], [p()]))
  fails('best-of-approve', state(), /no proposal/)
  fails(
    'best-of-approve',
    state([album(9, pick.slice(0, 10), 'Best of Sintra 2026', null)], [], [p({ photoIds: pick.slice(0, 10) })]),
    /proposed 10 photos, not 12/
  )
  fails('best-of-approve', state([album(9, pick, 'Best of Sintra 2026', null), album(10, pick)], [], [p()]), /made 1 album itself/)
  fails('best-of-approve', state([], [], [p({ status: 'waiting', madeAlbumId: undefined })]), /waiting, not approved/)
})

test('best-of-reject: its 2026 album, a proposal of 15, none approved, the last closed', () => {
  const year = album(9, T.year2026, '2026')
  const p = (o: Partial<Proposal> = {}): Proposal => ({ id: 1, albumId: 9, photoIds: T.year2026.slice(0, 15), status: 'closed', ...o })
  passes('best-of-reject', state([year], [], [p({ status: 'replaced' }), p({ id: 2 })]))
  fails('best-of-reject', state([year, album(10, T.year2026.slice(0, 15), 'Best of 2026', null)], [], [p({ status: 'approved' })]), /a Best of album was made/)
  fails('best-of-reject', state([year]), /no proposal/)
  fails('best-of-reject', state([album(9, T.year2026.slice(0, 79), '2026')], [], [p()]), /holds 79 of the 80 2026 photos/)
  fails('best-of-reject', state([year], [], [p({ status: 'waiting' })]), /waiting, not closed/)
})

test('nothing-there: no new album; an empty one fails', () => {
  passes('nothing-there', state())
  fails('nothing-there', state([album(9, [])]), /made 1 album \(0 photos\)/)
  fails('nothing-there', state([album(9, [1, 2])]), /made 1 album/)
})

test('AC-7: the pick proxy checks count, source, look-alike repeats and both people; Jaccard overlap', () => {
  const task = TASKS.find((t) => t.id === 'best-of-approve')!
  const good = [sintra[0], sintra[5], sintra[10], sintra[15], ...sintra.slice(20, 28)]
  const s = state()
  const check = (ids: number[]) => pickChecks(T, task, s, { id: 1, albumId: 1, photoIds: ids, status: 'approved' })
  assert.equal(check(good).wouldApprove, true)
  assert.equal(check([sintra[0], sintra[1], ...good.slice(2)]).checks.noRepeats, false)
  assert.equal(check(good.slice(0, 11)).checks.count, false)
  assert.equal(check([...good.slice(0, 11), 600]).checks.source, false)
  assert.equal(check([sintra[0], sintra[5], sintra[10], sintra[15], ...sintra.slice(20, 26)]).checks.everyone, false, 'no Sam')
  assert.equal(jaccard([1, 2, 3], [2, 3, 4]), 0.5)
  assert.equal(jaccard([], []), 1)
})

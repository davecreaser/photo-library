// Assistant access: best photos and proposals (spec 0009), driven by an MCP client over a real
// local socket. Generated data only.
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { QUALITY_VERSION } from '../src/main/quality.ts'
import { PROPOSAL_WAITING, TOOL_DEFINITIONS } from '../src/main/assistantTools.ts'
import { S, setup, client, type Lib } from './assistant-helpers.ts'

const DIMS = 768
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}
/** A scene's direction; shots of one scene are this plus a little noise, so they are look-alikes. */
function vector(scene: number, shot: number): Float32Array {
  const a = rng(scene * 7919 + 13)
  const b = rng(scene * 104729 + shot * 31 + 7)
  return Float32Array.from({ length: DIMS }, () => a() - 0.5 + (b() - 0.5) * 0.05)
}

/**
 * An album of a trip: `days` days, three places a day, `shots` near-identical shots of each a
 * couple of minutes apart, quality measured; Anna and Ben are in some, one photo is starred.
 */
function trip(lib: Lib, o: { days?: number; shots?: number; measured?: boolean; name?: string } = {}): { albumId: number; ids: number[] } {
  const days = o.days ?? 4
  const shots = o.shots ?? 4
  const ids: number[] = []
  let scene = 1
  for (let d = 0; d < days; d++) {
    for (let p = 0; p < 3; p++, scene++) {
      for (let s = 0; s < shots; s++) {
        const hh = String(9 + p * 3).padStart(2, '0')
        const mm = String(s * 2).padStart(2, '0')
        const people = scene % 3 === 0 ? ['Anna'] : scene % 4 === 0 ? ['Ben'] : []
        const [id] = lib.add(1, { first: `2024-07-${String(10 + d).padStart(2, '0')}T${hh}:${mm}:00`, people })
        lib.db.saveContent(id, vector(scene + (o.name?.length ?? 0) * 1000, s), 1)
        if (o.measured !== false) lib.db.saveQuality(id, { sharpness: 0.4 + s * 0.15, exposure: 0.9 }, QUALITY_VERSION)
        ids.push(id)
      }
    }
  }
  lib.db.setFavorite([ids[5]], true)
  const album = lib.db.createAlbum(o.name ?? 'Norway 2024', null)
  lib.db.addToAlbum(album.id, ids)
  return { albumId: album.id, ids }
}

const REASONS = [
  /^Sharpest of \d+ similar photos$/,
  /^You starred this one$/,
  /^Includes (Anna|Ben)$/,
  /^Matches “.+”$/,
  /^One of \d+ from this moment$/,
  /^The one from this moment$/,
  /^Something different from the rest$/,
  /^Included as you asked$/
]

// --- AC-1: eight tools ---

test('AC-1: eight tools; best_of and propose_selection explain the album-first route and that the owner decides', async () => {
  const names = TOOL_DEFINITIONS.map((t) => t.name)
  assert.deepEqual(names.slice(5), ['best_of', 'propose_selection', 'proposal_status'])
  const desc = (n: string) => TOOL_DEFINITIONS.find((t) => t.name === n)!.description
  assert.match(desc('best_of'), /search_photos.*create_album.*best_of/s)
  assert.match(desc('best_of'), /Suggested albums aren't available/)
  assert.match(desc('propose_selection'), /only they can keep it/)
  assert.match(desc('propose_selection'), /Don't make the same album yourself/)
  for (const n of names.slice(5)) assert.match(desc(n), /Example: \w+\(/)
})

// --- AC-2, AC-3, AC-4: best_of ---

test('AC-3, AC-4: best_of gives the same pick as the Best of screen, with reasons in the app’s words and look-alike alternatives', async () => {
  const lib = await setup()
  const { albumId, ids } = trip(lib)
  const c = await client(lib)
  const excluded = ids[1]
  const r = await c.tool('best_of', { album_id: albumId, count: 12, exclude: [excluded] })
  const app = await lib.bestOf.get({ source: { kind: 'album', id: albumId }, count: 12, exclude: [excluded] })
  assert.deepEqual(
    r.photos.map((p: { id: number }) => p.id),
    app.photos.map((p) => p.id),
    'same ids, same order'
  )
  assert.deepEqual(Object.keys(r), ['album_id', 'name', 'total', 'count', 'default_count', 'moments', 'photos'])
  assert.equal(r.name, 'Norway 2024')
  assert.equal(r.total, ids.length)
  assert.equal(r.count, 12)
  assert.equal(r.default_count, app.defaultCount)
  assert.equal(r.moments, app.momentCount)
  assert.ok(!r.photos.some((p: { id: number }) => p.id === excluded))
  const picked = new Set(r.photos.map((p: { id: number }) => p.id))
  for (const p of r.photos) {
    assert.deepEqual(Object.keys(p).slice(0, 6), ['id', 'taken', 'people', 'albums', 'favorite', 'reason'])
    assert.ok(
      REASONS.some((re) => re.test(p.reason)),
      p.reason
    )
    for (const alt of p.alternatives ?? []) {
      assert.ok(!picked.has(alt) && alt !== excluded, 'alternatives are look-alikes that were not picked')
    }
    assert.ok((p.alternatives ?? []).length <= 5)
  }
  assert.ok(
    r.photos.some((p: { alternatives?: number[] }) => p.alternatives?.length),
    'bursts offer alternatives'
  )
  assert.ok(r.photos.find((p: { id: number }) => p.id === ids[5])?.reason === 'You starred this one')
  assert.ok(r.photos.some((p: { people: string[] }) => p.people.includes('Anna')))
  assert.ok(r.photos.some((p: { people: string[] }) => p.people.includes('Ben')))
  assert.deepEqual(await c.tool('best_of', { album_id: albumId, count: 12, exclude: [excluded] }), r, 'the same answer twice')
  // The default count is the app's, and include ids are kept and said so.
  const dflt = await c.tool('best_of', { album_id: albumId, include: [ids[0]] })
  assert.equal(dflt.count, app.defaultCount)
  assert.equal(dflt.photos.find((p: { id: number }) => p.id === ids[0]).reason, 'Included as you asked')
  await lib.close()
})

test('AC-2: bad inputs name the field; ids not in the album are listed; more include ids than count raise it', async () => {
  const lib = await setup()
  const { albumId, ids } = trip(lib)
  const other = lib.add(1)[0]
  const c = await client(lib)
  const err = async (args: Record<string, unknown>) => (await c.tool('best_of', args)).error as string
  assert.equal(await err({ album_id: 99 }), 'There is no album with id 99. library_overview lists the albums.')
  assert.match(await err({}), /album_id is required/)
  assert.match(await err({ album_id: albumId, count: 5 }), /count must be a whole number from 6 to 200/)
  assert.match(await err({ album_id: albumId, count: 201 }), /count must be a whole number from 6 to 200/)
  assert.match(await err({ album_id: albumId, focus: 3 }), /focus must be text/)
  assert.match(await err({ album_id: albumId, focus: 'x'.repeat(201) }), /focus must be at most 200 characters/)
  assert.match(await err({ album_id: albumId, include: [ids[0]], exclude: [ids[0]] }), /in both include and exclude/)
  assert.match(await err({ album_id: albumId, suggestion: 'f:x' }), /Unknown input "suggestion"/)
  const r = await c.tool('best_of', { album_id: albumId, count: 6, include: [...ids.slice(0, 8), other], exclude: [123456] })
  assert.deepEqual(r.not_in_album, [other, 123456])
  assert.equal(r.count, 8)
  assert.ok(r.notes.some((n: string) => /count was raised to 8/.test(n)))
  for (const id of ids.slice(0, 8)) assert.ok(r.photos.some((p: { id: number }) => p.id === id))
  // Reading never changes the album.
  assert.equal(lib.db.albumPhotoIds(albumId).length, ids.length)
  await lib.close()
})

test('AC-5: small, empty and unmeasured albums, and focus without a content model, are notes, not errors', async () => {
  const lib = await setup()
  const c = await client(lib)
  const small = lib.db.createAlbum('Small', null)
  lib.db.addToAlbum(small.id, lib.add(4))
  const r = await c.tool('best_of', { album_id: small.id })
  assert.equal(r.too_few, true)
  assert.equal(r.total, 4)
  assert.deepEqual(r.photos, [])
  assert.deepEqual(r.notes, ['This album has only 4 photos, too few to choose from: use them all, or search_photos for more.'])
  const empty = lib.db.createAlbum('Empty', null)
  assert.equal((await c.tool('best_of', { album_id: empty.id })).total, 0)

  const { albumId, ids } = trip(lib, { measured: false, name: 'Unmeasured' })
  for (const id of ids.slice(0, 7)) lib.db.saveQuality(id, { sharpness: 0.8, exposure: 0.9 }, QUALITY_VERSION)
  const u = await c.tool('best_of', { album_id: albumId, focus: 'the beach' })
  assert.ok(u.notes.includes(`Quality is measured for 7 of ${ids.length} photos so far; the pick will improve as Photo Library reads the rest.`))
  assert.ok(u.notes.includes('focus is unavailable until content analysis is ready; the pick ignores it.'))
  const plain = await c.tool('best_of', { album_id: albumId })
  assert.deepEqual(
    u.photos.map((p: { id: number }) => p.id),
    plain.photos.map((p: { id: number }) => p.id),
    'the pick without focus'
  )
  await lib.close()
})

// --- AC-6, AC-9: proposals ---

test('AC-6: propose_selection hands the pick to the window and returns at once, writing nothing', async () => {
  const lib = await setup()
  const { albumId, ids } = trip(lib)
  const other = lib.add(1)[0]
  const c = await client(lib)
  const albumsBefore = JSON.stringify(lib.db.listAlbums())
  const pick = ids.slice(0, 8)
  const t = Date.now()
  const r = await c.tool('propose_selection', { album_id: albumId, photo_ids: [...pick, pick[0], other] })
  assert.ok(Date.now() - t < 1000)
  assert.deepEqual(r, {
    proposal_id: r.proposal_id,
    album_id: albumId,
    name: 'Norway 2024',
    photos: 8,
    not_in_album: [other],
    status: 'waiting',
    message: PROPOSAL_WAITING
  })
  assert.deepEqual(lib.shown, [{ proposalId: r.proposal_id, albumId, name: 'Norway 2024', photoIds: pick }])
  assert.equal(JSON.stringify(lib.db.listAlbums()), albumsBefore, 'nothing written')

  const refusal = 'A proposal needs at least 6 photos of the album; for fewer, use create_album.'
  assert.equal((await c.tool('propose_selection', { album_id: albumId, photo_ids: [ids[0], ids[0], ids[1], ids[2], ids[3], ids[4]] })).error, refusal)
  assert.equal(
    (await c.tool('propose_selection', { album_id: albumId, photo_ids: [...ids.slice(0, 5), other] })).error,
    `${refusal} 1 of the ids given aren't photos of this album.`
  )
  const small = lib.db.createAlbum('Small', null)
  lib.db.addToAlbum(small.id, lib.add(4))
  assert.equal((await c.tool('propose_selection', { album_id: small.id, photo_ids: lib.db.albumPhotoIds(small.id) })).error, refusal)
  assert.match((await c.tool('propose_selection', { album_id: albumId, photo_ids: Array.from({ length: 201 }, (_, i) => i + 1) })).error, /at most 200/)
  assert.equal(lib.shown.length, 1, 'refusals open nothing')
  await lib.close()
})

test('AC-9, AC-8: proposal_status follows what the owner did; the approved album is theirs', async () => {
  const lib = await setup()
  const { albumId, ids } = trip(lib)
  const c = await client(lib)
  const status = (id: number) => c.tool('proposal_status', { proposal_id: id })
  assert.equal((await status(7)).error, 'No proposal with id 7. Proposals last until Photo Library is closed.')

  const pick = ids.slice(0, 10)
  const first = (await c.tool('propose_selection', { album_id: albumId, photo_ids: pick })).proposal_id
  assert.deepEqual(await status(first), { proposal_id: first, album_id: albumId, status: 'waiting', edited: false })
  lib.proposals.report(first, { kind: 'edited', edited: true })
  assert.equal((await status(first)).edited, true)

  // The owner removes one, swaps one and makes the album.
  const kept = [...pick.slice(0, 8), ids[20]]
  const made = lib.bestOf.makeAlbum({ kind: 'album', id: albumId }, kept)
  lib.proposals.report(first, { kind: 'approved', albumId: made.id, name: made.name, photoIds: kept })
  lib.proposals.report(first, { kind: 'closed' })
  assert.deepEqual(await status(first), {
    proposal_id: first,
    status: 'approved',
    album_id: made.id,
    name: 'Best of Norway 2024',
    photos: 9,
    kept: 8,
    added: [ids[20]],
    removed: [pick[8], pick[9]]
  })
  assert.match((await c.tool('add_to_album', { album_id: made.id, photo_ids: [ids[30]] })).error, /owner's/)

  const second = (await c.tool('propose_selection', { album_id: albumId, photo_ids: pick })).proposal_id
  const third = (await c.tool('propose_selection', { album_id: albumId, photo_ids: pick })).proposal_id
  assert.ok(second > first && third > second, 'ids are never reused')
  lib.proposals.report(second, { kind: 'replaced', by: third })
  assert.deepEqual(await status(second), { proposal_id: second, album_id: albumId, status: 'replaced', by_proposal_id: third })
  lib.proposals.report(third, { kind: 'closed' })
  assert.equal((await status(third)).status, 'closed')
  await lib.close()
})

test('AC-11: turning access off or forgetting assistants expires waiting proposals', async () => {
  const lib = await setup()
  const { albumId, ids } = trip(lib)
  let c = await client(lib)
  const a = (await c.tool('propose_selection', { album_id: albumId, photo_ids: ids.slice(0, 6) })).proposal_id
  await lib.access.forget()
  // A new setup, as the owner would copy it.
  c = await client(lib)
  assert.equal((await c.tool('proposal_status', { proposal_id: a })).status, 'expired')
  const b = (await c.tool('propose_selection', { album_id: albumId, photo_ids: ids.slice(0, 6) })).proposal_id
  await lib.access.turnOff() // calls in flight are answered as in spec 0008's AC-7 test
  await lib.access.turnOn()
  c = await client(lib)
  assert.equal((await c.tool('proposal_status', { proposal_id: b })).status, 'expired')
  await lib.close()
})

// --- AC-12: privacy ---

test('AC-12: no path, folder or file name, hash, place, camera or quality score in anything the new tools send', async () => {
  const lib = await setup()
  const { albumId, ids } = trip(lib)
  const small = lib.db.createAlbum('Small', null)
  lib.db.addToAlbum(small.id, lib.add(3))
  const c = await client(lib)
  const p = (await c.tool('propose_selection', { album_id: albumId, photo_ids: ids.slice(0, 6) })).proposal_id
  const calls: [string, Record<string, unknown>][] = [
    ['best_of', { album_id: albumId }],
    ['best_of', { album_id: albumId, count: 200, focus: 'the beach', include: [ids[0]], exclude: [ids[1], 99999] }],
    ['best_of', { album_id: small.id }],
    ['best_of', { album_id: 9999 }],
    ['best_of', { album_id: albumId, count: 'many' }],
    ['propose_selection', { album_id: small.id, photo_ids: ids.slice(0, 6) }],
    ['propose_selection', { album_id: 9999, photo_ids: ids.slice(0, 6) }],
    ['proposal_status', { proposal_id: p }],
    ['proposal_status', { proposal_id: 999 }]
  ]
  for (const [name, args] of calls) await c.tool(name, args)
  const q = (await c.tool('propose_selection', { album_id: albumId, photo_ids: ids.slice(0, 6) })).proposal_id
  const kept = lib.bestOf.makeAlbum({ kind: 'album', id: albumId }, ids.slice(0, 5))
  lib.proposals.report(q, { kind: 'approved', albumId: kept.id, name: kept.name, photoIds: ids.slice(0, 5) })
  assert.equal((await c.tool('proposal_status', { proposal_id: q })).status, 'approved')
  for (const e of [{ kind: 'edited', edited: true }, { kind: 'replaced', by: p }, { kind: 'closed' }] as const) {
    lib.proposals.report(p, e)
    await c.tool('proposal_status', { proposal_id: p })
  }
  await lib.access.forget()
  const c2 = await client(lib)
  await c2.tool('proposal_status', { proposal_id: p })
  for (const x of [c, c2]) {
    x.end()
    await x.closed
  }
  const raw = c.raw + c2.raw
  const leaks = [...Object.values(S), '59.91', '10.75', '.jpg', lib.dir, 'sharpness', 'exposure', 'quality":', 'f:'].filter((s) => raw.includes(s))
  assert.deepEqual(leaks, [])
  await lib.close()
})

// --- AC-13: large albums and several assistants ---

test('AC-13: best_of on a 5,000-photo album within 2 s, propose_selection within 1 s; two assistants get the same pick', async () => {
  const lib = await setup()
  const ids: number[] = []
  lib.db.transaction(() => {
    for (let i = 0; i < 5000; i++) {
      const [id] = lib.add(1, { first: new Date(Date.UTC(2024, 0, 1) + i * 20 * 60_000).toISOString().slice(0, 19) })
      lib.db.saveContent(id, vector(Math.floor(i / 4) + 1, i % 4), 1)
      lib.db.saveQuality(id, { sharpness: 0.3 + (i % 7) * 0.1, exposure: 0.9 }, QUALITY_VERSION)
      ids.push(id)
    }
  })
  const album = lib.db.createAlbum('Big', null)
  lib.db.addToAlbum(album.id, ids)
  const [a, b] = [await client(lib), await client(lib)]
  let t = Date.now()
  const [ra, rb] = await Promise.all([a.tool('best_of', { album_id: album.id, count: 200 }), b.tool('best_of', { album_id: album.id, count: 200 })])
  assert.ok(Date.now() - t < 4000, `two picks at once in ${Date.now() - t} ms`)
  assert.deepEqual(ra, rb)
  t = Date.now()
  await a.tool('best_of', { album_id: album.id, count: 200 })
  assert.ok(Date.now() - t < 2000, `best_of in ${Date.now() - t} ms`)
  assert.ok(JSON.stringify(ra).length < 64_000, 'a pick of 200 is under 64 KB')
  t = Date.now()
  await a.tool('propose_selection', { album_id: album.id, photo_ids: ra.photos.map((p: { id: number }) => p.id) })
  assert.ok(Date.now() - t < 1000)
  await b.tool('propose_selection', { album_id: album.id, photo_ids: rb.photos.map((p: { id: number }) => p.id) })
  assert.equal(lib.shown.length, 2, 'each proposal reaches the window, which shows one at a time')
  await lib.close()
})

// --- QA gaps (spec 0009 QA) ---

test('QA AC-2, AC-4, AC-5, AC-6: missing and ignored photos are never picked, offered or counted; count is capped at the album; alternatives best first', async () => {
  const lib = await setup()
  const { albumId, ids } = trip(lib, { days: 1, shots: 4 }) // 12 photos: 3 bursts of 4
  const [hidden] = lib.add(1, { folder: 'private', first: '2024-07-10T09:01:00' })
  lib.db.addToAlbum(albumId, [hidden])
  const gone = [ids[1], ids[2]] // two shots of the first burst go missing
  const raw = new DatabaseSync(join(lib.dir, 'library.db'))
  for (const id of gone) raw.prepare('UPDATE files SET missing = 1 WHERE photo_id = ?').run(id)
  raw.close()
  lib.db.forgetFiles((p) => p.split('/').includes('private'))
  lib.db.refreshDerived()
  const c = await client(lib)

  const r = await c.tool('best_of', { album_id: albumId, count: 200, include: [gone[0], hidden] })
  assert.equal(r.total, ids.length - gone.length, 'missing and ignored photos are not counted')
  assert.equal(r.count, r.total, 'count is capped at the album’s present photos')
  assert.deepEqual(r.not_in_album, [gone[0], hidden])
  const offered = r.photos.flatMap((p: { id: number; alternatives?: number[] }) => [p.id, ...(p.alternatives ?? [])])
  for (const id of [...gone, hidden]) assert.ok(!offered.includes(id), `photo ${id} is never picked or offered`)

  // Alternatives are look-alikes, best first, as the app's look-alike strip orders them.
  const small = await c.tool('best_of', { album_id: albumId, count: 6 })
  const groups = await lib.bestOf.lookalikes({ kind: 'album', id: albumId })
  for (const p of small.photos as { id: number; alternatives?: number[] }[]) {
    if (!p.alternatives) continue
    const g = groups.find((x) => x.includes(p.id))!
    assert.deepEqual(
      p.alternatives,
      g.filter((id) => p.alternatives!.includes(id)),
      'in the group’s best-first order'
    )
  }

  const prop = await c.tool('propose_selection', { album_id: albumId, photo_ids: [...ids.slice(3, 9), gone[0], hidden] })
  assert.equal(prop.photos, 6)
  assert.deepEqual(prop.not_in_album, [gone[0], hidden])
  assert.deepEqual(lib.shown.at(-1)!.photoIds, ids.slice(3, 9))
  await lib.close()
})

test('QA AC-9: a decision from the window counts only once; later reports change nothing', async () => {
  const lib = await setup()
  const { albumId, ids } = trip(lib)
  const c = await client(lib)
  const id = (await c.tool('propose_selection', { album_id: albumId, photo_ids: ids.slice(0, 6) })).proposal_id
  lib.proposals.report(id, { kind: 'closed' })
  lib.proposals.report(id, { kind: 'approved', albumId: 1, name: 'x', photoIds: ids.slice(0, 6) })
  lib.proposals.report(id, { kind: 'edited', edited: true })
  assert.deepEqual(await c.tool('proposal_status', { proposal_id: id }), { proposal_id: id, album_id: albumId, status: 'closed' })
  await lib.access.turnOff()
  await lib.access.turnOn()
  const c2 = await client(lib)
  assert.equal((await c2.tool('proposal_status', { proposal_id: id })).status, 'closed', 'expiry does not rewrite a decision')
  await lib.close()
})

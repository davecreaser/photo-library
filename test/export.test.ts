// Spec 0007: save copies to a folder.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncBuiltinESMExports } from 'node:module'
import sharp from 'sharp'
import { installFsGuard, ProtectedPathError } from '../src/main/fsGuard.ts'
import { openExport } from '../src/main/appFiles.ts'
import { orderPhotos, planNames, runExport, safeFolderName, type ExportPhoto } from '../src/main/exporter.ts'
import { exportOptionsFrom } from '../src/main/exportOptions.ts'
import { LibraryDb } from '../src/main/db.ts'
import { userFs } from './helpers.ts'

const root = fs.mkdtempSync(join(tmpdir(), 'pl-export-'))
const photos = join(root, 'photos')
const appData = join(root, 'app')
const out = join(root, 'out')
for (const d of [photos, appData, out]) userFs.mkdir(d)
installFsGuard({ allowedRoots: () => [appData], protectedRoots: () => [photos] })

async function jpeg(name: string, w: number, h: number): Promise<string> {
  const file = join(photos, name)
  userFs.write(
    file,
    await sharp({ create: { width: w, height: h, channels: 3, background: '#38c' } })
      .jpeg()
      .toBuffer()
  )
  return file
}

function snapshot(dir: string): string {
  const h = createHash('sha1')
  for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true }).sort((a, b) => (a.parentPath + a.name).localeCompare(b.parentPath + b.name))) {
    const full = join(e.parentPath, e.name)
    const s = fs.lstatSync(full)
    h.update(`${full}:${s.size}:${s.mtimeMs}:${e.isFile() ? fs.readFileSync(full, 'utf8') : ''}\n`)
  }
  return h.digest('hex')
}

const ph = (id: number, path: string, takenAt: string | null): ExportPhoto => ({ id, path, takenAt, width: null, height: null, orientation: null })
const OPTS = { maxSide: 0, dateInNames: false } as const

test('order: capture time, undated last by path, each photo once (AC-4)', () => {
  const list = [
    ph(1, '/p/b.jpg', null),
    ph(2, '/p/a.jpg', '2024-07-14T10:32:00'),
    ph(3, '/p/a2.jpg', null),
    ph(4, '/p/c.jpg', '2020-01-01T00:00:00'),
    ph(2, '/p/a.jpg', '2024-07-14T10:32:00')
  ]
  assert.deepEqual(
    orderPhotos(list).map((p) => p.id),
    [4, 2, 3, 1]
  )
})

test('names: numbered, optional capture date, none for undated (AC-4)', () => {
  const list = [ph(1, '/p/a.jpg', '2024-07-14T10:32:05'), ph(2, '/p/b.jpg', null)]
  assert.deepEqual(
    planNames(list, OPTS).map((f) => f.name),
    ['0001.jpg', '0002.jpg']
  )
  assert.deepEqual(
    planNames(list, { maxSide: 0, dateInNames: true }).map((f) => f.name),
    ['0001 2024-07-14 1032.jpg', '0002.jpg']
  )
  const many = Array.from({ length: 12000 }, (_, i) => ph(i, `/p/${i}.jpg`, null))
  assert.equal(planNames(many, OPTS)[0].name, '00001.jpg')
})

test('folder names are safe on every system (AC-4)', () => {
  assert.equal(safeFolderName('Sintra: "best" / 2024?'), 'Sintra best 2024')
  assert.equal(safeFolderName('...'), 'Photos')
  assert.equal(safeFolderName('CON'), 'CON copies')
  assert.equal(safeFolderName('Trip.'), 'Trip')
  assert.ok(safeFolderName('x'.repeat(500)).length <= 80)
})

test('options: invalid values fall back to the defaults (AC-11)', () => {
  assert.deepEqual(exportOptionsFrom('{"maxSide":3,"dateInNames":"yes"}'), { maxSide: 0, dateInNames: false })
  assert.deepEqual(exportOptionsFrom('{"maxSide":2000,"dateInNames":true}'), { maxSide: 2000, dateInNames: true })
  assert.deepEqual(exportOptionsFrom('nonsense'), { maxSide: 0, dateInNames: false })
})

test('saves JPEGs byte for byte, converts others, skips unreadable ones; originals untouched (AC-3, AC-7, AC-8)', async () => {
  const a = await jpeg('a.jpg', 80, 60)
  const bad = join(photos, 'broken.heic')
  userFs.write(bad, Buffer.from('not an image'))
  const png = join(photos, 'c.png')
  userFs.write(
    png,
    await sharp({ create: { width: 30, height: 20, channels: 3, background: '#c33' } })
      .png()
      .toBuffer()
  )
  const before = snapshot(photos)
  const dest = join(out, 'Photos 1')
  const sink = await openExport(dest, appData)
  const files = planNames([ph(1, a, '2024-01-01T10:00:00'), ph(2, bad, '2024-01-02T10:00:00'), ph(3, png, '2024-01-03T10:00:00')], OPTS)
  const progress: number[] = []
  const run = await runExport(
    files,
    sink,
    OPTS,
    join(appData, 'tmp'),
    (d) => progress.push(d),
    () => false
  )
  sink.close()
  assert.equal(run.status, 'done')
  assert.equal(run.saved, 2)
  assert.deepEqual(
    run.skipped.map((s) => s.name),
    ['broken.heic']
  )
  assert.deepEqual(fs.readdirSync(dest).sort(), ['0001.jpg', '0003.jpg'])
  assert.ok(fs.readFileSync(join(dest, '0001.jpg')).equals(fs.readFileSync(a)), 'JPEG copied untouched')
  assert.equal((await sharp(join(dest, '0003.jpg')).metadata()).format, 'jpeg')
  assert.equal(progress.at(-1), 3)
  assert.equal(snapshot(photos), before)
})

test('size limit shrinks but never enlarges (AC-5)', async () => {
  const big = await jpeg('big.jpg', 400, 200)
  const small = await jpeg('small.jpg', 100, 50)
  const opts = { maxSide: 1600, dateInNames: false } as const
  const dest = join(out, 'Sized')
  const sink = await openExport(dest, appData)
  await runExport(
    planNames([ph(1, big, '2024-01-01T00:00:00'), ph(2, small, '2024-01-02T00:00:00')], opts),
    sink,
    { ...opts, maxSide: 1600 },
    join(appData, 'tmp'),
    () => {},
    () => false
  )
  sink.close()
  assert.equal((await sharp(join(dest, '0002.jpg')).metadata()).width, 100)
  // A real limit: 4000 is above both, so nothing grows; use the lowest to check shrinking via a larger photo.
  const huge = await jpeg('huge.jpg', 2000, 1000)
  const dest2 = join(out, 'Sized 2')
  const sink2 = await openExport(dest2, appData)
  await runExport(
    planNames([ph(1, huge, null)], opts),
    sink2,
    opts,
    join(appData, 'tmp'),
    () => {},
    () => false
  )
  sink2.close()
  const m = await sharp(join(dest2, '0001.jpg')).metadata()
  assert.deepEqual([m.width, m.height], [1600, 800])
})

test('cancel keeps what was saved (AC-6)', async () => {
  const a = await jpeg('k1.jpg', 20, 20)
  const dest = join(out, 'Cancelled')
  const sink = await openExport(dest, appData)
  let n = 0
  const files = planNames([ph(1, a, '2024-01-01T00:00:00'), ph(2, a, '2024-01-02T00:00:00'), ph(3, a, '2024-01-03T00:00:00')], OPTS)
  const run = await runExport(
    files,
    sink,
    OPTS,
    join(appData, 'tmp'),
    () => {},
    () => n++ >= 1
  )
  sink.close()
  assert.equal(run.status, 'cancelled')
  assert.equal(run.saved, 1)
  assert.deepEqual(fs.readdirSync(dest), ['0001.jpg'])
})

test('a write failure stops the export with a message (AC-7)', async () => {
  const a = await jpeg('w1.jpg', 20, 20)
  const failing = { write: async () => Promise.reject(Object.assign(new Error('full'), { code: 'ENOSPC' })), close: () => {} }
  const run = await runExport(
    planNames([ph(1, a, null), ph(2, a, null)], OPTS),
    failing,
    OPTS,
    join(appData, 'tmp'),
    () => {},
    () => false
  )
  assert.equal(run.status, 'error')
  assert.equal(run.message, 'the disk is full')
  assert.equal(run.saved, 0)
})

test('never overwrites a file in the export folder (AC-2)', async () => {
  const dest = join(out, 'Once')
  const sink = await openExport(dest, appData)
  await sink.write('0001.jpg', Buffer.from('first'))
  await assert.rejects(() => sink.write('0001.jpg', Buffer.from('second')), { code: 'EEXIST' })
  await assert.rejects(() => sink.write('../escape.jpg', Buffer.from('x')))
  sink.close()
  assert.equal(fs.readFileSync(join(dest, '0001.jpg'), 'utf8'), 'first')
  assert.equal(fs.existsSync(join(out, 'escape.jpg')), false)
})

test('an album export includes the albums inside it; missing photos are left out (AC-1)', () => {
  const db = new LibraryDb(join(appData, 'export-test.db'))
  const trips = db.createAlbum('Trips', null)
  const norway = db.createAlbum('Norway', trips.id)
  const other = db.createAlbum('Other', null)
  const raw = (db as unknown as { db: { exec(sql: string): void } }).db
  raw.exec(
    `INSERT INTO photos (id, hash, size, taken_at, present) VALUES (1,'h1',1,'2024-01-01T00:00:00',1),(2,'h2',1,NULL,1),(3,'h3',1,NULL,0),(4,'h4',1,NULL,1)`
  )
  raw.exec(
    `INSERT INTO files (photo_id, path, size, mtime_ms, missing) VALUES (1,'/p/1.jpg',1,0,0),(2,'/p/2.jpg',1,0,0),(3,'/p/3.jpg',1,0,0),(4,'/p/4.jpg',1,0,0)`
  )
  db.addToAlbum(trips.id, [1])
  db.addToAlbum(norway.id, [2, 3])
  db.addToAlbum(other.id, [4])
  assert.deepEqual(db.albumPhotoIdsDeep(trips.id).sort(), [1, 2, 3])
  assert.deepEqual(
    db
      .exportSources([1, 2, 3])
      .map((p) => p.id)
      .sort(),
    [1, 2]
  )
})

test('the grant ends with the export (AC-9)', async () => {
  const sink = await openExport(join(out, 'Grant'), appData)
  sink.close()
  await assert.rejects(async () => fs.writeFileSync(join(out, 'Grant', 'late.jpg'), 'x'), ProtectedPathError)
})

test('a failed write leaves no half-written copy behind (AC-7)', async () => {
  const dest = join(out, 'Partial')
  const sink = await openExport(dest, appData)
  const real = fs.promises.writeFile
  fs.promises.writeFile = (async (file: string, ...rest: unknown[]) => {
    await real(file, 'half', { flag: 'wx' })
    throw Object.assign(new Error('full'), { code: 'ENOSPC' })
  }) as typeof real
  syncBuiltinESMExports()
  try {
    await assert.rejects(() => sink.write('0001.jpg', Buffer.from('whole photo')), { code: 'ENOSPC' })
  } finally {
    fs.promises.writeFile = real
    syncBuiltinESMExports()
    sink.close()
  }
  assert.deepEqual(fs.readdirSync(dest), [])
})

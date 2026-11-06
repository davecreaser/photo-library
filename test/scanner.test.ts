import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import sharp from 'sharp'
import { installFsGuard } from '../src/main/fsGuard.ts'
import { LibraryDb } from '../src/main/db.ts'
import { scanLibrary } from '../src/main/scanner.ts'
import { ImageCache } from '../src/main/thumbnails.ts'
import { Organiser } from '../src/main/organiser.ts'
import { IgnoreRules } from '../src/main/ignore.ts'

// Run with the same filesystem guard as the app. Photo folders are protected once
// created; arranging files the way a user would (in Finder) goes through /bin tools.
let protectedNow: string[] = []
installFsGuard({ allowedRoots: () => [tmpdir()], protectedRoots: () => protectedNow })
const sh = (cmd: string, ...args: string[]) => execFileSync(`/bin/${cmd}`, args)

let colour = 0
/** Writes a distinct JPEG (unique content) at `path`, outside the guard like a camera import would. */
async function makePhoto(path: string, exifDate?: string, camera = 'Canon EOS 80D') {
  const staging = join(await mkdtemp(join(tmpdir(), 'stage-')), 'p.jpg')
  await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: (colour * 37) % 256, g: (colour++ * 91) % 256, b: 100 } } })
    .withExif(exifDate ? { IFD0: { Make: camera.split(' ')[0], Model: camera }, IFD2: { DateTimeOriginal: exifDate } } : {})
    .jpeg()
    .toFile(staging)
  sh('mkdir', '-p', dirname(path))
  sh('mv', staging, path)
}

async function snapshot(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const full = join(entry.parentPath, entry.name)
    out.set(full, createHash('sha1').update(await readFile(full)).digest('hex') + ':' + (await stat(full)).mtimeMs)
  }
  return out
}

async function setup(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix))
  const photos = join(root, 'photos')
  const appData = join(root, 'app')
  sh('mkdir', '-p', photos, appData)
  return { root, photos, appData }
}

const scan = (db: LibraryDb, base: string) => {
  db.setSetting('basePath', base)
  return scanLibrary(db, base, () => {})
}

async function cleanup(root: string) {
  protectedNow = []
  await rm(root, { recursive: true, force: true })
}

test('scans, indexes dates, organises virtually and never modifies photos', async () => {
  const { root, photos, appData } = await setup('pl-main-')
  await makePhoto(join(photos, '2020-08 Spain holiday', 'IMG_0001.JPG'), '2020:08:14 10:30:00')
  await makePhoto(join(photos, '2020-08 Spain holiday', 'IMG_0002.JPG'), '2020:08:15 18:05:00')
  await makePhoto(join(photos, 'misc', 'no-exif.jpg'))
  await makePhoto(join(photos, 'misc', '@eaDir', 'junk.jpg'))
  await makePhoto(join(photos, 'misc', '.hidden.jpg'))
  const before = await snapshot(photos)
  protectedNow = [photos]
  const db = new LibraryDb(join(appData, 'library.db'))

  const first = await scan(db, photos)
  assert.equal(first.phase, 'done')
  assert.equal(first.added, 3, 'skips @eaDir and hidden files')

  assert.equal(db.queryPhotos({ text: 'august 2020' }).total, 2)
  const spain = db.queryPhotos({ text: 'photos from our spain holiday' })
  assert.equal(spain.total, 2)
  assert.equal(spain.photos[0].takenAt, '2020-08-15T18:05:00')
  assert.equal(spain.photos[0].camera, 'Canon EOS 80D')
  const misc = db.queryPhotos({ text: 'misc' }).photos[0]
  assert.equal(misc.takenAt, null, 'no EXIF date = unknown, not the file date')
  assert.equal(misc.dateSource, 'unknown')
  assert.equal(db.queryPhotos({ undated: true }).total, 1)
  assert.equal(db.queryPhotos({}).photos.at(-1)!.id, misc.id, 'undated sorts last')

  const album = db.createAlbum('Holidays', null)
  db.addToAlbum(album.id, spain.photos.map((p) => p.id))
  db.addTag([spain.photos[0].id], 'Jake')
  assert.equal(db.queryPhotos({ text: 'jake' }).total, 1)
  assert.equal(db.queryPhotos({ text: 'holidays 2020' }).total, 2)
  db.deleteAlbum(album.id)
  assert.equal(db.queryPhotos({}).total, 3, 'deleting an album keeps its photos')

  const cache = new ImageCache(join(appData, 'cache'))
  const thumb = await cache.get(db.getThumbSource(spain.photos[0].id)!, 'thumb')
  assert.ok(thumb.startsWith(appData))

  const second = await scan(db, photos)
  assert.deepEqual([second.hashed, second.added, second.relocated, second.missing], [0, 0, 0, 0], 'rescan reads nothing')
  assert.deepEqual(await snapshot(photos), before, 'photo folder byte-for-byte unchanged')

  await assert.rejects(rm(photos, { recursive: true }), 'the guard was active throughout')
  await cleanup(root)
})

test('moving or renaming files keeps tags, albums and favourites', async () => {
  const { root, photos, appData } = await setup('pl-move-')
  await makePhoto(join(photos, 'unsorted', 'DSCF0001.JPG'), '2025:05:01 10:00:00')
  await makePhoto(join(photos, 'unsorted', 'DSCF0002.JPG'), '2025:05:01 11:00:00')
  protectedNow = [photos]
  const db = new LibraryDb(join(appData, 'library.db'))
  await scan(db, photos)
  const jake = db.queryPhotos({ text: 'DSCF0001' }).photos[0]
  db.addTag([jake.id], 'Jake')
  const album = db.createAlbum('Birthday', null)
  db.addToAlbum(album.id, [jake.id])
  db.setFavorite([jake.id], true)

  // The user tidies up in Finder: move into a new folder and rename.
  sh('mkdir', '-p', join(photos, 'jake birthday'))
  sh('mv', join(photos, 'unsorted', 'DSCF0001.JPG'), join(photos, 'jake birthday', 'cake.jpg'))
  const r = await scan(db, photos)
  assert.deepEqual([r.added, r.relocated, r.missing], [0, 1, 0])

  const moved = db.getPhoto(jake.id)!
  assert.equal(moved.path, join(photos, 'jake birthday', 'cake.jpg'))
  assert.deepEqual(moved.tags.map((t) => t.name), ['Jake'])
  assert.deepEqual(moved.albums.map((a) => a.name), ['Birthday'])
  assert.equal(moved.favorite, true)
  assert.equal(db.counts().photoCount, 2)
  await cleanup(root)
})

test('a new base folder with the same photos keeps everything', async () => {
  const { root, photos, appData } = await setup('pl-base-')
  await makePhoto(join(photos, 'a', '1.jpg'), '2024:01:01 10:00:00')
  await makePhoto(join(photos, 'b', '2.jpg'), '2024:01:02 10:00:00')
  protectedNow = [photos]
  const db = new LibraryDb(join(appData, 'library.db'))
  await scan(db, photos)
  const [p1] = db.queryPhotos({ text: '1.jpg' }).photos
  db.addTag([p1.id], 'Jake')

  // Copy the library to a new disk with a completely different layout.
  const newBase = join(root, 'new-disk', 'Pictures')
  sh('mkdir', '-p', join(newBase, 'flat'))
  sh('cp', '-p', join(photos, 'a', '1.jpg'), join(newBase, 'flat', 'IMG_A.jpg'))
  sh('cp', '-p', join(photos, 'b', '2.jpg'), join(newBase, 'flat', 'IMG_B.jpg'))
  protectedNow = [photos, newBase]
  const r = await scan(db, newBase)
  assert.deepEqual([r.added, r.relocated], [0, 2])
  assert.equal(db.counts().photoCount, 2, 'old base locations are not shown')
  const tagged = db.queryPhotos({ text: 'jake' }).photos
  assert.equal(tagged.length, 1)
  assert.equal(tagged[0].id, p1.id)
  assert.equal(tagged[0].path, join(newBase, 'flat', 'IMG_A.jpg'))
  await cleanup(root)
})

test('identical copies are one photo with several locations', async () => {
  const { root, photos, appData } = await setup('pl-dupe-')
  await makePhoto(join(photos, 'fuji', 'unsorted', 'DSCF1077.JPG'), '2026:09:12 10:00:00')
  sh('mkdir', '-p', join(photos, '2026'), join(photos, 'trips', '12.25.poland', 'best'))
  sh('cp', '-p', join(photos, 'fuji', 'unsorted', 'DSCF1077.JPG'), join(photos, '2026', 'DSCF1077.JPG'))
  sh('cp', '-p', join(photos, 'fuji', 'unsorted', 'DSCF1077.JPG'), join(photos, 'trips', '12.25.poland', 'best', 'DSCF1077.JPG'))
  protectedNow = [photos]
  const db = new LibraryDb(join(appData, 'library.db'))
  const r = await scan(db, photos)
  assert.deepEqual([r.found, r.added, r.relocated], [3, 1, 2])
  assert.equal(db.queryPhotos({}).total, 1)
  const [only] = db.queryPhotos({}).photos
  const details = db.getPhoto(only.id)!
  assert.equal(details.locations.length, 3)
  assert.equal(details.favorite, false, 'folders like "best" do not make favourites')
  db.setFavorite([only.id], true)
  assert.equal(db.getPhoto(only.id)!.favorite, true)
  assert.equal(db.counts().favoriteCount, 1)
  await cleanup(root)
})

test('a photo edited in place keeps its tags', async () => {
  const { root, photos, appData } = await setup('pl-edit-')
  await makePhoto(join(photos, 'x.jpg'), '2024:01:01 10:00:00')
  protectedNow = [photos]
  const db = new LibraryDb(join(appData, 'library.db'))
  await scan(db, photos)
  const [p] = db.queryPhotos({}).photos
  db.addTag([p.id], 'Jake')
  await makePhoto(join(photos, 'x.jpg'), '2024:01:01 10:00:00') // re-exported with edits, outside the app
  const r = await scan(db, photos)
  assert.deepEqual([r.added, r.updated], [0, 1])
  assert.deepEqual(db.getPhoto(p.id)!.tags.map((t) => t.name), ['Jake'])
  await cleanup(root)
})

test('upgrades a v1 library, merging copies and keeping albums', async () => {
  const { root, photos, appData } = await setup('pl-migrate-')
  await makePhoto(join(photos, 'a.jpg'), '2024:01:01 10:00:00')
  sh('cp', '-p', join(photos, 'a.jpg'), join(photos, 'a-copy.jpg'))
  const dbFile = join(appData, 'library.db')
  // A database as written by the first version of the app.
  const v1 = new DatabaseSync(dbFile)
  v1.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE photos (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, file_name TEXT NOT NULL, ext TEXT NOT NULL, size INTEGER NOT NULL,
      mtime_ms INTEGER NOT NULL, taken_at TEXT, date_source TEXT, width INTEGER, height INTEGER, orientation INTEGER, camera TEXT,
      lat REAL, lon REAL, missing INTEGER NOT NULL DEFAULT 0, last_seen_scan INTEGER);
    CREATE TABLE albums (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES albums (id) ON DELETE CASCADE, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE album_photos (album_id INTEGER NOT NULL REFERENCES albums (id) ON DELETE CASCADE, photo_id INTEGER NOT NULL REFERENCES photos (id) ON DELETE CASCADE,
      added_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (album_id, photo_id));
    CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
    CREATE TABLE photo_tags (photo_id INTEGER NOT NULL REFERENCES photos (id) ON DELETE CASCADE, tag_id INTEGER NOT NULL REFERENCES tags (id) ON DELETE CASCADE, PRIMARY KEY (photo_id, tag_id));
  `)
  v1.prepare("INSERT INTO settings VALUES ('basePath', ?)").run(photos)
  v1.prepare("INSERT INTO photos (id, path, file_name, ext, size, mtime_ms, taken_at, date_source) VALUES (1, ?, 'a.jpg', '.jpg', 1, 1, '2024-01-01T10:00:00', 'exif')").run(join(photos, 'a.jpg'))
  v1.prepare("INSERT INTO photos (id, path, file_name, ext, size, mtime_ms, taken_at, date_source) VALUES (2, ?, 'a-copy.jpg', '.jpg', 1, 1, '2024-01-01T10:00:00', 'exif')").run(join(photos, 'a-copy.jpg'))
  v1.exec("INSERT INTO albums (id, name) VALUES (1, 'Kept'); INSERT INTO album_photos (album_id, photo_id) VALUES (1, 2);")
  v1.exec("INSERT INTO tags (id, name) VALUES (1, 'Jake'); INSERT INTO photo_tags VALUES (1, 1);")
  v1.close()
  protectedNow = [photos]

  const db = new LibraryDb(dbFile)
  assert.equal(db.getSetting('basePath'), photos, 'settings kept')
  await scanLibrary(db, photos, () => {})
  assert.equal(db.counts().photoCount, 1, 'the two v1 rows were the same photo')
  const [p] = db.queryPhotos({}).photos
  const details = db.getPhoto(p.id)!
  assert.deepEqual(details.albums.map((a) => a.name), ['Kept'])
  assert.deepEqual(details.tags.map((t) => t.name), ['Jake'])
  assert.equal(details.locations.length, 2)
  await cleanup(root)
})

test('photos that disappear are hidden, and can be forgotten without touching files', async () => {
  const { root, photos, appData } = await setup('pl-gone-')
  await makePhoto(join(photos, 'jake_birth', '1.jpeg'), '2026:09:01 10:00:00')
  await makePhoto(join(photos, 'keep.jpg'), '2026:09:02 10:00:00')
  protectedNow = [photos]
  const db = new LibraryDb(join(appData, 'library.db'))
  await scan(db, photos)
  const [gone] = db.queryPhotos({ text: 'jake_birth' }).photos
  const goneHash = createHash('sha256').update(await readFile(gone.path)).digest('hex')
  db.addTag([gone.id], 'Jake')
  sh('mkdir', '-p', join(root, 'elsewhere'))
  sh('mv', join(photos, 'jake_birth'), join(root, 'elsewhere'))
  const r = await scan(db, photos)
  assert.equal(r.missing, 1)
  assert.equal(db.queryPhotos({ text: 'jake' }).total, 0, 'hidden')
  assert.deepEqual(db.forgetMissing().hashes, [goneHash], 'returns hashes so cached thumbnails can be removed')
  assert.equal(db.counts().missingCount, 0)
  assert.equal(db.listTags().length, 0)
  assert.equal(db.counts().photoCount, 1)
  assert.ok((await stat(join(root, 'elsewhere', 'jake_birth', '1.jpeg'))).isFile(), 'the file itself still exists')
  await cleanup(root)
})

test('suggests and applies the camera clock fix, virtually', async () => {
  const { root, photos, appData } = await setup('pl-clock-')
  await makePhoto(join(photos, 'trips', '08.25.sail_amsterdam', 'a.jpg'), '2024:08:24 10:00:00', 'Fujifilm X-T50')
  await makePhoto(join(photos, 'trips', '12.25.poland', 'b.jpg'), '2024:12:13 10:00:00', 'Fujifilm X-T50')
  await makePhoto(join(photos, 'unsorted', 'c.jpg'), '2025:06:20 10:00:00', 'Fujifilm X-T50')
  await makePhoto(join(photos, 'unsorted', 'd.jpg'), '2026:07:03 10:00:00', 'Fujifilm X-T50')
  const before = await snapshot(photos)
  protectedNow = [photos]
  const db = new LibraryDb(join(appData, 'library.db'))
  const organiser = new Organiser(db)
  await scan(db, photos)
  assert.equal(db.queryPhotos({ text: 'august 2025' }).total, 0)

  const [s] = organiser.suggestions()
  assert.equal(s.offsetYears, 1)
  assert.equal(s.photoCount, 3)
  organiser.applySuggestion(s.key)
  assert.deepEqual(organiser.suggestions(), [], 'applied suggestions disappear')

  const sail = db.queryPhotos({ text: 'august 2025' }).photos
  assert.equal(sail.length, 1)
  assert.equal(sail[0].takenAt, '2025-08-24T10:00:00')
  assert.equal(sail[0].takenAtRaw, '2024-08-24T10:00:00')
  assert.equal(db.queryPhotos({ text: 'june 2026' }).total, 1, '2025-06 became 2026-06')
  assert.equal(db.queryPhotos({ text: 'july 2026' }).total, 1, 'after the fix: unchanged')

  const events = organiser.listEvents()
  assert.ok(events.some((e) => e.name === 'Sail Amsterdam') && events.some((e) => e.name === 'Poland'))
  const album = organiser.saveEventAsAlbum(events.find((e) => e.name === 'Poland')!.id, 'Poland 2025')
  assert.equal(db.queryPhotos({ albumId: album.id }).total, 1)

  // Undo restores the camera's dates.
  organiser.removeCorrection(organiser.listCorrections()[0].id)
  assert.equal(db.queryPhotos({ text: 'august 2025' }).total, 0)
  assert.deepEqual(await snapshot(photos), before, 'no EXIF was written')
  await cleanup(root)
})

test('ignore rules: folder names anywhere, folder paths from the base, case-insensitive, only below the base', () => {
  const rules = new IgnoreRules(['private', 'fuji/abstract', ' /Kodak/ '])
  const ignored = (path: string) => rules.ignoresFile('/photos', path)
  assert.equal(ignored('/photos/private/a.jpg'), true)
  assert.equal(ignored('/photos/2020/Private/x/a.jpg'), true, 'names match at any depth, any case')
  assert.equal(ignored('/photos/private-ish/a.jpg'), false)
  assert.equal(ignored('/photos/private.jpg'), false, 'files named like a rule are not folders')
  assert.equal(ignored('/photos/fuji/abstract/a.jpg'), true)
  assert.equal(ignored('/photos/fuji/Abstract/deep/a.jpg'), true, 'paths include subfolders')
  assert.equal(ignored('/photos/other/fuji/abstract/a.jpg'), false, 'paths are from the base folder')
  assert.equal(ignored('/photos/fuji/abstract-2/a.jpg'), false)
  assert.equal(ignored('/photos/kodak/a.jpg'), true, 'rules are tidied (spaces, slashes)')
  // macOS's /private system folder above the base must not exclude everything.
  assert.equal(new IgnoreRules(['private']).ignoresFile('/private/tmp/photos', '/private/tmp/photos/a.jpg'), false)
  assert.equal(IgnoreRules.fromSetting(null).ignoresFile('/p', '/p/private/a.jpg'), true, '"private" is the default')
  assert.equal(IgnoreRules.fromSetting('[]').ignoresFile('/p', '/p/private/a.jpg'), false, 'and can be removed')
})

test('adding an ignore rule forgets those photos (faces, tags and all); removing it brings them back', async () => {
  const { root, photos, appData } = await setup('pl-ignore-')
  await makePhoto(join(photos, 'keep', 'a.jpg'), '2025:01:01 10:00:00')
  await makePhoto(join(photos, 'lisstraat_listing', 'b.jpg'), '2025:01:02 10:00:00')
  await makePhoto(join(photos, 'work', 'secret', 'c.jpg'), '2025:01:03 10:00:00')
  const before = await snapshot(photos)
  protectedNow = [photos]
  const db = new LibraryDb(join(appData, 'library.db'))
  await scan(db, photos)
  assert.equal(db.counts().photoCount, 3)
  const listing = db.queryPhotos({ text: 'lisstraat' }).photos[0]
  db.addTag([listing.id], 'house')
  const [faceId] = db.saveFaces(listing.id, [{ x: 0, y: 0, w: 0.1, h: 0.1, score: 0.9, embedding: null }], 1)

  db.setSetting('ignoredFolders', JSON.stringify(['private', 'lisstraat_listing', 'secret']))
  let forgotten = { hashes: [] as string[], faceIds: [] as number[] }
  await scanLibrary(db, photos, () => {}, (f) => (forgotten = f))
  assert.deepEqual(db.queryPhotos({}).photos.map((p) => p.fileName), ['a.jpg'])
  assert.equal(forgotten.hashes.length, 2)
  assert.deepEqual(forgotten.faceIds, [faceId], 'face crops can be cleaned up too')
  assert.equal(db.listTags().length, 0)
  assert.equal(db.counts().missingCount, 0, 'forgotten, not just hidden')

  db.setSetting('ignoredFolders', JSON.stringify(['private', 'secret']))
  const r = await scanLibrary(db, photos, () => {})
  assert.equal(r.added, 1, 'un-ignored folder comes back on the next scan')
  assert.equal(db.counts().photoCount, 2)
  assert.deepEqual(await snapshot(photos), before, 'files untouched throughout')
  await cleanup(root)
})

test('skips "private" folders and forgets previously indexed private photos', async () => {
  const { root, photos, appData } = await setup('pl-private-')
  await makePhoto(join(photos, 'public.jpg'), '2021:01:01 10:00:00')
  await makePhoto(join(photos, 'Private', 'a.jpg'), '2021:01:02 10:00:00')
  await makePhoto(join(photos, '2021', 'private', 'deeper', 'b.jpg'), '2021:01:03 10:00:00')
  const before = await snapshot(photos)
  protectedNow = [photos]

  const db = new LibraryDb(join(appData, 'library.db'))
  // Simulate a private photo indexed (and tagged) before the rule existed.
  db.recordFile({ path: join(photos, 'Private', 'a.jpg'), size: 1, mtimeMs: 1, takenAt: null, width: null, height: null, orientation: null, camera: null, lat: null, lon: null }, 'old-hash', 1)
  const old = db.queryPhotos({}).photos[0]
  db.addTag([old.id], 'secret')

  let forgotten: string[] = []
  const result = await scanLibrary(db, photos, () => {}, (f) => (forgotten = f.hashes))
  assert.equal(result.added, 1)
  assert.deepEqual(forgotten, ['old-hash'])
  assert.deepEqual(db.queryPhotos({}).photos.map((p) => p.fileName), ['public.jpg'])
  assert.equal(db.counts().missingCount, 0, 'private photos are forgotten, not just hidden')
  assert.equal(db.listTags().length, 0)
  assert.deepEqual(await snapshot(photos), before, 'private files are untouched')
  await cleanup(root)
})

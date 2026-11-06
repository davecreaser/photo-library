// Search by content (spec 0002), end to end below the UI: scan → background analysis with the
// real model → search. Photos are generated red and blue images (never real photos), which
// the model tells apart reliably. Needs the content model in resources/models.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { installFsGuard } from '../src/main/fsGuard.ts'
import { LibraryDb } from '../src/main/db.ts'
import { scanLibrary } from '../src/main/scanner.ts'
import { ImageCache } from '../src/main/thumbnails.ts'
import { People } from '../src/main/people.ts'
import { Analysis, estimateSecondsLeft } from '../src/main/analysis.ts'
import { PhotoSearch } from '../src/main/photoSearch.ts'
import { CONTENT_MODEL_VERSION } from '../src/main/contentModel.ts'
import { FACE_MODEL_VERSION } from '../src/main/faces.ts'
import type { ContentProgress } from '../src/shared/types.ts'
import { userFs } from './helpers.ts'

let protectedNow: string[] = []
installFsGuard({ allowedRoots: () => [tmpdir()], protectedRoots: () => protectedNow })

const MODELS = join(import.meta.dirname, '..', 'resources', 'models')
const COLOURS = { red: '#d42020', blue: '#2040d4' }
let n = 0

/**
 * A generated photo of one plain colour. Each file is still a distinct photo: its EXIF
 * description differs (the content hash covers the whole file), while its pixels, and so its
 * scores, are the same as every other photo of that colour.
 */
async function makePhoto(path: string, colour: keyof typeof COLOURS, date: string | null) {
  const staging = join(mkdtempSync(join(tmpdir(), 'stage-')), 'p.jpg')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="${COLOURS[colour]}"/></svg>`
  await sharp(Buffer.from(svg))
    .withExif({ IFD0: { ImageDescription: `test photo ${n++}` }, ...(date ? { IFD2: { DateTimeOriginal: date } } : {}) })
    .jpeg()
    .toFile(staging)
  userFs.mv(staging, path)
}

function snapshot(dir: string): string {
  const h = createHash('sha256')
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true }).sort((a, b) => (a.parentPath + a.name).localeCompare(b.parentPath + b.name))) {
    const full = join(e.parentPath, e.name)
    if (e.isFile()) h.update(`${full}:${statSync(full).mtimeMs}:`).update(readFileSync(full))
  }
  return h.digest('hex')
}

/** A library with an analysed app around it. `arrange` creates its photos (before the guard protects the folder). */
async function setup(arrange: (photos: string) => Promise<void>, modelsDir = MODELS, previews?: (appData: string) => ImageCache) {
  const root = mkdtempSync(join(tmpdir(), 'pl-content-'))
  const photos = join(root, 'photos')
  const appData = join(root, 'app')
  userFs.mkdir(photos)
  userFs.mkdir(appData)
  await arrange(photos)
  protectedNow = [photos]
  let before = snapshot(photos)
  /** Changes the photo folder as the user would; the app itself must change nothing (checked at cleanup). */
  const asUser = async (change: () => unknown) => {
    await change()
    before = snapshot(photos)
  }
  const db = new LibraryDb(join(appData, 'library.db'))
  const images = previews?.(appData) ?? new ImageCache(join(appData, 'cache'))
  const events: ContentProgress[] = []
  const people = new People(db, MODELS, join(appData, 'cache', 'faces'), () => {})
  const analysis = new Analysis({ db, people, images, modelsDir, packaged: false, onContentProgress: (p) => events.push(p) })
  const search = new PhotoSearch(db, () => analysis.contentModel())
  const scan = async () => {
    db.setSetting('basePath', photos)
    await scanLibrary(db, photos, () => {})
    await analysis.kick()
  }
  await scan()
  const find = async (text: string, page?: { offset: number; limit: number }) => search.query({ text, ...page })
  const names = async (text: string) => (await find(text)).photos.map((p) => p.fileName)
  const cleanup = async () => {
    assert.equal(snapshot(photos), before, 'photo folder unchanged')
    db.close()
    protectedNow = []
    await rm(root, { recursive: true, force: true })
  }
  return { root, photos, appData, db, analysis, search, events, asUser, scan, find, names, cleanup }
}

async function colours(photos: string) {
  for (let i = 0; i < 4; i++) await makePhoto(join(photos, 'camera', `R${i}.JPG`), 'red', `2025:0${i + 1}:10 10:00:00`)
  for (let i = 0; i < 4; i++) await makePhoto(join(photos, 'camera', `B${i}.JPG`), 'blue', `2026:0${i + 1}:10 10:00:00`)
}

const sorted = (xs: string[]) => [...xs].sort()

test('AC-1: "red" finds the red photos and not the blue ones, best match first; a phrase is matched whole; paging neither repeats nor skips', async () => {
  const lib = await setup(colours)
  const red = await lib.find('red')
  assert.deepEqual(red.search, { phrase: 'red', nameMatches: 0, contentMatches: 4 })
  assert.deepEqual(sorted(red.photos.map((p) => p.fileName)), ['R0.JPG', 'R1.JPG', 'R2.JPG', 'R3.JPG'])
  assert.deepEqual(sorted(await lib.names('blue')), ['B0.JPG', 'B1.JPG', 'B2.JPG', 'B3.JPG'])
  assert.deepEqual(sorted(await lib.names('a red square')), ['R0.JPG', 'R1.JPG', 'R2.JPG', 'R3.JPG'])
  assert.equal((await lib.find('a red square')).search?.phrase, 'red square')

  const all = (await lib.find('a red or blue picture')).photos.map((p) => p.id)
  const paged: number[] = []
  for (let offset = 0; offset < all.length; offset += 3) paged.push(...(await lib.find('a red or blue picture', { offset, limit: 3 })).photos.map((p) => p.id))
  assert.deepEqual(paged, all, 'pages join up into the same list')
  assert.equal(new Set(all).size, all.length, 'no photo twice')
  await lib.cleanup()
})

test('AC-2: a fixed minimum score; nonsense and absent things find nothing; the same search gives the same order', async () => {
  const lib = await setup(colours)
  for (const nothing of ['xqzv kjrw', 'giraffe', 'birthday cake']) {
    const r = await lib.find(nothing)
    assert.equal(r.total, 0, nothing)
    assert.deepEqual(r.photos, [])
  }
  const first = await lib.names('red')
  for (let i = 0; i < 3; i++) assert.deepEqual(await lib.names('red'), first)
  await lib.cleanup()
})

test('AC-3: missing photos and ignored folders never appear; copies appear once', async () => {
  const lib = await setup(async (photos) => {
    await colours(photos)
    await makePhoto(join(photos, 'private', 'secret.jpg'), 'red', '2025:05:01 10:00:00')
  })
  await lib.asUser(() => {
    userFs.cp(join(lib.photos, 'camera', 'R0.JPG'), join(lib.photos, 'copies', 'R0-copy.JPG'))
    userFs.rm(join(lib.photos, 'camera', 'R1.JPG'))
  })
  await lib.scan()
  const red = await lib.find('red')
  assert.equal(red.total, 3, 'R0 (twice on disk) once, R2, R3; not the missing R1 or the private one')
  assert.ok(!red.photos.some((p) => p.fileName === 'R1.JPG' || p.fileName === 'secret.jpg'))
  await lib.cleanup()
})

test('AC-4: dates and a person filter, and aren’t part of the content phrase', async () => {
  const lib = await setup(colours)
  const r2025 = await lib.find('red 2025')
  assert.equal(r2025.search?.phrase, 'red')
  assert.equal(r2025.total, 4)
  assert.equal((await lib.find('red 2026')).total, 0, 'the red photos are all from 2025')
  assert.deepEqual(await lib.names('blue february 2026'), ['B1.JPG'])

  // Jake is in R0 and B0 (a named face, as if the user named him in People).
  const byName = (name: string) => lib.db.queryPhotos({ text: name }).photos[0].id
  const jake = lib.db.personNamed('Jake')
  for (const id of [byName('R0'), byName('B0')]) {
    const [face] = lib.db.saveFaces(id, [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2, score: 0.9, embedding: null }], FACE_MODEL_VERSION)
    lib.db.confirmFaces([face], jake)
  }
  const jakeRed = await lib.find('jake red')
  assert.equal(jakeRed.search?.phrase, 'red')
  assert.deepEqual(
    jakeRed.photos.map((p) => p.fileName),
    ['R0.JPG']
  )
  await lib.cleanup()
})

test('AC-5: with no content phrase results are exactly today’s; otherwise name matches come first, then content matches', async () => {
  const lib = await setup(async (photos) => {
    await colours(photos)
    // A blue photo in a folder called "red things": a name match for "red".
    await makePhoto(join(photos, 'red things', 'X.JPG'), 'blue', '2024:01:01 10:00:00')
  })
  const today = lib.db.queryPhotos({ text: '2025' })
  const now = await lib.find('2025')
  assert.deepEqual(now.photos, today.photos)
  assert.equal(now.total, today.total)
  assert.deepEqual(now.search, { phrase: null, nameMatches: 4, contentMatches: 0 })

  const tag = lib.db.addTag([lib.db.queryPhotos({ text: 'B2' }).photos[0].id], 'red')
  const red = await lib.find('red')
  assert.deepEqual(red.search, { phrase: 'red', nameMatches: 2, contentMatches: 4 })
  assert.deepEqual(
    red.photos.slice(0, 2).map((p) => p.fileName),
    lib.db.queryPhotos({ text: 'red' }).photos.map((p) => p.fileName),
    'name matches first, in today’s order'
  )
  assert.deepEqual(sorted(red.photos.slice(2).map((p) => p.fileName)), ['R0.JPG', 'R1.JPG', 'R2.JPG', 'R3.JPG'])
  lib.db.removeTag([lib.db.queryPhotos({ text: 'B2' }).photos[0].id], tag.id)
  await lib.cleanup()
})

test('AC-6: filler words don’t stop a match', async () => {
  const lib = await setup(colours)
  const r = await lib.find('show me all the photos of red')
  assert.equal(r.search?.phrase, 'red')
  assert.equal(r.total, 4)
  await lib.cleanup()
})

test('AC-7: analysis runs newest first with its own progress; search uses what’s analysed so far', async () => {
  const lib = await setup(colours)
  const analysing = lib.events.filter((e) => e.phase === 'analysing')
  assert.ok(analysing.length > 0)
  assert.equal(lib.events.at(-1)!.phase, 'idle')
  assert.deepEqual([lib.events.at(-1)!.done, lib.events.at(-1)!.total], [8, 8])

  // Newest first: a photo from 2027 before one from 2024 and an undated one.
  await lib.asUser(async () => {
    await makePhoto(join(lib.photos, 'new', 'OLD.JPG'), 'red', '2024:01:01 10:00:00')
    await makePhoto(join(lib.photos, 'new', 'UNDATED.JPG'), 'red', null)
    await makePhoto(join(lib.photos, 'new', 'NEW.JPG'), 'red', '2027:01:01 10:00:00')
  })
  await scanLibrary(lib.db, lib.photos, () => {})
  const queue = lib.db.photosNeedingAnalysis({ faces: FACE_MODEL_VERSION, content: CONTENT_MODEL_VERSION }, 10)
  assert.deepEqual(
    queue.map((p) => p.path.split(/[\\/]/).pop()),
    ['NEW.JPG', 'OLD.JPG', 'UNDATED.JPG']
  )
  assert.equal((await lib.find('red')).total, 4, 'not analysed yet, so not found (they have no name match)')
  await lib.analysis.kick()
  assert.equal((await lib.find('red')).total, 7)
  await lib.cleanup()
})

test('AC-7: time estimate', () => {
  const start = 1_000_000
  assert.equal(estimateSecondsLeft([], start, 100, start + 1000), null, 'nothing done yet')
  assert.equal(estimateSecondsLeft([start + 500], start, 100, start + 1000), null, 'too early')
  const twenty = Array.from({ length: 20 }, (_, i) => start + i * 100)
  assert.equal(estimateSecondsLeft(twenty, start, 1000, start + 2000), 100, '10 a second')
  assert.equal(estimateSecondsLeft([start + 1000], start, 30, start + 15_000), 450, 'after 15 s, from what’s done')
  // Only the last 2 minutes count: 120 photos in them = 1 a second.
  const slowThenFast = [...Array.from({ length: 10 }, (_, i) => start + i * 60_000), ...Array.from({ length: 120 }, (_, i) => start + 600_000 + i * 1000)]
  assert.equal(estimateSecondsLeft(slowThenFast, start, 60, start + 720_000), 60)
  assert.equal(estimateSecondsLeft(twenty, start, 0, start + 2000), 0)
})

test('AC-8: analysed once: resumes, a rescan analyses only new photos, moves and copies cost nothing, an edited photo is analysed again', async () => {
  const lib = await setup(colours)
  const pending = () => lib.db.photosNeedingAnalysis({ faces: FACE_MODEL_VERSION, content: CONTENT_MODEL_VERSION }, 100).map((p) => p.path)
  assert.deepEqual(pending(), [])

  await lib.asUser(() => {
    userFs.mv(join(lib.photos, 'camera', 'R0.JPG'), join(lib.photos, 'sorted', 'renamed.JPG'))
    userFs.cp(join(lib.photos, 'camera', 'R2.JPG'), join(lib.photos, 'sorted', 'R2 copy.JPG'))
  })
  await scanLibrary(lib.db, lib.photos, () => {})
  assert.deepEqual(pending(), [], 'moved, renamed and copied photos are not analysed again')

  // A missing photo coming back.
  await lib.asUser(() => userFs.mv(join(lib.photos, 'camera', 'B0.JPG'), join(lib.root, 'B0.JPG')))
  await scanLibrary(lib.db, lib.photos, () => {})
  await lib.asUser(() => userFs.mv(join(lib.root, 'B0.JPG'), join(lib.photos, 'camera', 'B0.JPG')))
  await scanLibrary(lib.db, lib.photos, () => {})
  assert.deepEqual(pending(), [], 'a photo that comes back is not analysed again')

  await lib.asUser(async () => {
    await makePhoto(join(lib.photos, 'camera', 'B1.JPG'), 'red', '2026:02:10 10:00:00') // edited in place: now red
    await makePhoto(join(lib.photos, 'camera', 'N.JPG'), 'blue', '2026:06:10 10:00:00')
  })
  await scanLibrary(lib.db, lib.photos, () => {})
  assert.deepEqual(sorted(pending().map((p) => p.split(/[\\/]/).pop()!)), ['B1.JPG', 'N.JPG'])

  // Each photo's analysis is saved as soon as it's done. Say the app quit after N.JPG (recorded
  // here without a vector, so it's recognisable): after a restart, only B1 is analysed.
  const nId = lib.db.queryPhotos({ text: 'N.JPG' }).photos[0].id
  lib.db.saveFaces(nId, [], FACE_MODEL_VERSION)
  lib.db.saveContent(nId, null, CONTENT_MODEL_VERSION)
  await new Analysis({
    db: lib.db,
    people: new People(lib.db, MODELS, join(lib.appData, 'cache', 'faces'), () => {}),
    images: new ImageCache(join(lib.appData, 'cache')),
    modelsDir: MODELS,
    packaged: false,
    onContentProgress: () => {}
  }).kick()
  assert.deepEqual(pending(), [])
  assert.ok(!(await lib.names('blue')).includes('N.JPG'), 'N.JPG was not analysed again')
  assert.ok((await lib.names('red')).includes('B1.JPG'), 'the edited photo is found by its new content')
  await lib.cleanup()
})

test('AC-9: unreadable photos are recorded once and don’t stop analysis', async () => {
  const lib = await setup(async (photos) => {
    await colours(photos)
    userFs.write(join(photos, 'camera', 'broken.jpg'), Buffer.from('not really a jpeg'))
  })
  const broken = lib.db.queryPhotos({ text: 'broken' }).photos[0]
  assert.ok(broken, 'indexed')
  assert.deepEqual(lib.db.photosNeedingAnalysis({ faces: FACE_MODEL_VERSION, content: CONTENT_MODEL_VERSION }, 100), [], 'recorded, not retried')
  assert.equal(lib.events.at(-1)!.done, 9)
  assert.equal((await lib.find('red')).total, 4)
  await lib.cleanup()
})

test('AC-9: photos sharp can’t decode (HEIC, RAW) are analysed from their cached preview', async () => {
  // The preview the image cache makes (on a Mac with sips, elsewhere from the embedded thumbnail): here, a red JPEG.
  const preview = join(mkdtempSync(join(tmpdir(), 'pl-preview-')), 'preview.jpg')
  await sharp({ create: { width: 320, height: 240, channels: 3, background: COLOURS.red } })
    .jpeg()
    .toFile(preview)
  const asked: string[] = []
  const lib = await setup(
    async (photos) => {
      await colours(photos)
      userFs.write(join(photos, 'phone', 'IMG_0001.HEIC'), Buffer.from('ftypheic: not something sharp can decode'))
    },
    MODELS,
    (appData) =>
      Object.assign(new ImageCache(join(appData, 'cache')), {
        get: async (photo: { path: string }) => {
          asked.push(photo.path)
          return preview
        }
      })
  )
  assert.ok(
    asked.some((p) => p.endsWith('IMG_0001.HEIC')),
    'the preview was used'
  )
  assert.ok((await lib.names('red')).includes('IMG_0001.HEIC'), 'found by what its preview shows')
  await lib.cleanup()
})

test('AC-9: a missing or damaged model makes content search unavailable, and search by name works as before', async () => {
  for (const [reason, damage] of [
    ['missing', (dir: string) => userFs.rm(join(dir, 'siglip-base-patch16-224', 'text_model_fp16.onnx'))],
    ['damaged', (dir: string) => writeFileSync(join(dir, 'siglip-base-patch16-224', 'tokenizer.json'), '{}')]
  ] as const) {
    const models = mkdtempSync(join(tmpdir(), 'pl-models-'))
    userFs.cp(join(MODELS, 'siglip-base-patch16-224'), join(models, 'siglip-base-patch16-224'))
    damage(models)
    const lib = await setup(async (photos) => {
      await colours(photos)
      await makePhoto(join(photos, 'red things', 'X.JPG'), 'blue', '2024:01:01 10:00:00')
    }, models)
    assert.equal(lib.analysis.contentProgress().phase, 'unavailable')
    assert.equal(lib.analysis.contentProgress().reason, reason)
    const r = await lib.find('red')
    assert.deepEqual(
      r.photos.map((p) => p.fileName),
      ['X.JPG'],
      'name matches as today'
    )
    assert.deepEqual(r.search, { phrase: 'red', nameMatches: 1, contentMatches: 0 })
    await lib.cleanup()
    await rm(models, { recursive: true, force: true })
  }
})

test('AC-10: a new model version re-analyses every photo, and search never mixes versions', async () => {
  const lib = await setup(colours)
  // Pretend half the photos were analysed by an older version.
  const file = join(lib.appData, 'library.db')
  const raw = new DatabaseSync(file)
  raw.exec(
    `UPDATE photos SET content_version = ${CONTENT_MODEL_VERSION - 1} WHERE id IN (SELECT photo_id FROM files WHERE path LIKE '%R0.JPG' OR path LIKE '%R1.JPG')`
  )
  raw.close()
  assert.ok(lib.db.hasOtherContentVersion(CONTENT_MODEL_VERSION))
  assert.deepEqual(sorted(await lib.names('red')), ['R2.JPG', 'R3.JPG'], 'older results are not searched')
  lib.events.length = 0
  await lib.analysis.kick()
  assert.equal(lib.events.find((e) => e.phase === 'analysing')?.upgrading, true, 'progress says it is an update')
  assert.equal(lib.db.hasOtherContentVersion(CONTENT_MODEL_VERSION), false)
  assert.equal((await lib.find('red')).total, 4)
  await lib.cleanup()
})

test('AC-13: ignoring a folder forgets its photos’ content analysis; nothing is written in the photo folder', async () => {
  const lib = await setup(async (photos) => {
    await colours(photos)
    await makePhoto(join(photos, 'holiday', 'H.JPG'), 'red', '2025:07:01 10:00:00')
  })
  const vectors = () => {
    const raw = new DatabaseSync(join(lib.appData, 'library.db'))
    const n = (raw.prepare('SELECT count(*) AS n FROM content_vectors').get() as { n: number }).n
    raw.close()
    return n
  }
  assert.equal(vectors(), 9)
  lib.db.setSetting('ignoredFolders', JSON.stringify(['holiday']))
  await lib.scan()
  assert.equal(vectors(), 8, 'its vector is gone with the photo')
  assert.equal((await lib.find('red')).total, 4)
  await lib.cleanup() // asserts the photo folder is unchanged
})

test('AC-14: a library from the previous version keeps everything and then analyses every present photo', async () => {
  const lib = await setup(colours)
  const file = join(lib.appData, 'library.db')
  const album = lib.db.createAlbum('Kept', null)
  lib.db.addToAlbum(album.id, [lib.db.queryPhotos({ text: 'R0' }).photos[0].id])
  lib.db.addTag([lib.db.queryPhotos({ text: 'B0' }).photos[0].id], 'sky')
  lib.db.setSetting('ignoredFolders', JSON.stringify(['private', 'tmp']))
  lib.db.close()
  // Turn it into a v4 (pre-content-search) library: the only differences are these.
  const raw = new DatabaseSync(file)
  raw.exec('DROP TABLE content_vectors; ALTER TABLE photos DROP COLUMN content_version; PRAGMA user_version = 4;')
  raw.close()

  const db = new LibraryDb(file)
  assert.deepEqual(
    db.listAlbums().map((a) => [a.name, a.photoCount]),
    [['Kept', 1]]
  )
  assert.deepEqual(
    db.listTags().map((t) => t.name),
    ['sky']
  )
  assert.equal(db.getSetting('ignoredFolders'), JSON.stringify(['private', 'tmp']))
  assert.equal(db.photosNeedingAnalysis({ faces: FACE_MODEL_VERSION, content: CONTENT_MODEL_VERSION }, 100).length, 8, 'every present photo, for content only')
  assert.ok(db.photosNeedingAnalysis({ faces: FACE_MODEL_VERSION, content: CONTENT_MODEL_VERSION }, 100).every((p) => !p.needsFaces && p.needsContent))
  db.close()
  protectedNow = []
  await rm(lib.root, { recursive: true, force: true })
})

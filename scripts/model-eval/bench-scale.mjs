// Spec 0002, AC-12: content search at 100,000 photos, and analysis speed, with the app's own code.
//   node --experimental-strip-types bench-scale.mjs     (after calibrate.mjs, which caches COCO vectors)
// The library is generated: 100,000 photo records whose content vectors are COCO's (5,000 images'
// vectors repeated with a little noise, so scores are distributed like real photos'). Analysis
// speed is measured on 24-megapixel JPEGs made by enlarging COCO images (a camera's size).
// Everything is written under results/ (gitignored).
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import sharp from 'sharp'
import { CACHE } from './models.mjs'
import { installFsGuard } from '../../src/main/fsGuard.ts'
import { LibraryDb } from '../../src/main/db.ts'
import { PhotoSearch } from '../../src/main/photoSearch.ts'
import { Analysis } from '../../src/main/analysis.ts'
import { People } from '../../src/main/people.ts'
import { ImageCache } from '../../src/main/thumbnails.ts'
import { CONTENT_MODEL_VERSION, ContentModel } from '../../src/main/contentModel.ts'
import { FACE_MODEL_VERSION } from '../../src/main/faces.ts'
import { ContentModelWorker } from '../../src/main/contentModelWorker.ts'
import { Worker } from 'node:worker_threads'

const N = Number(process.env.PHOTOS ?? 100_000)
const D = 768
const RESULTS = join(import.meta.dirname, 'results')
const MODELS = join(import.meta.dirname, '..', '..', 'resources', 'models')
const dir = join(RESULTS, 'bench-scale')
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
installFsGuard({ allowedRoots: () => [RESULTS, tmpdir()], protectedRoots: () => [] })
const mb = (bytes) => Math.round(bytes / 1e6)
const report = { photos: N }

// --- a library of N photos, then their content vectors ---
const coco = new Float32Array(readFileSync(join(RESULTS, 'coco-app-vectors-5000.bin')).buffer.slice(0))
let seed = 1
const noise = () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32 - 0.5) * 0.01
const file = join(dir, 'library.db')
let db = new LibraryDb(file)
db.setSetting('basePath', '/photos')
const meta = (i) => ({
  path: `/photos/${String(i % 400).padStart(3, '0')}/IMG_${i}.JPG`,
  size: 1,
  mtimeMs: 1,
  takenAt: `20${String(10 + (i % 16)).padStart(2, '0')}-${String(1 + (i % 12)).padStart(2, '0')}-15T10:00:00`,
  width: 6000,
  height: 4000,
  orientation: 1,
  camera: 'FUJIFILM X-T50',
  lat: null,
  lon: null
})
for (let i = 0; i < N; i += 5000) db.transaction(() => Array.from({ length: Math.min(5000, N - i) }, (_, k) => db.recordFile(meta(i + k), `hash-${i + k}`, 1)))
db.refreshDerived()
db.close()
const sizeWithout = statSync(file).size
db = new LibraryDb(file)
const ids = db.photosNeedingAnalysis({ faces: null, content: CONTENT_MODEL_VERSION }, N).map((p) => p.id)
for (let i = 0; i < ids.length; i += 5000) {
  db.transaction(() => {
    for (let k = i; k < Math.min(i + 5000, ids.length); k++) {
      const src = (k % 5000) * D
      db.saveContent(
        ids[k],
        Float32Array.from({ length: D }, (_, d) => coco[src + d] + noise()),
        CONTENT_MODEL_VERSION
      )
      db.saveFaces(ids[k], [], FACE_MODEL_VERSION)
    }
  })
}
db.close()
// Checkpoint the WAL so the file size is the data.
const settle = new LibraryDb(file)
settle.close()
report.diskBytesPerPhoto = Math.round((statSync(file).size - sizeWithout) / N)

// --- start-up: opening the library (loads sqlite-vec) and the first progress count ---
let t = performance.now()
db = new LibraryDb(file)
report.openMs = Math.round(performance.now() - t)
t = performance.now()
db.contentProgress(CONTENT_MODEL_VERSION)
report.progressCountMs = Math.round(performance.now() - t)

// --- searching ---
global.gc?.()
const rssBefore = process.memoryUsage().rss
let modelPromise = null
const search = new PhotoSearch(db, () => (modelPromise ??= ContentModel.load(MODELS)))
const timed = async (text, offset = 0) => {
  const s = performance.now()
  const page = await search.query({ text, offset, limit: 300 })
  return { ms: Math.round(performance.now() - s), total: page.total, shown: page.photos.length }
}
report.firstSearch = { query: 'beach', ...(await timed('beach')) }
report.laterSearches = []
for (const q of ['a dog on a sofa', 'snow', 'sunset over water', 'a plate of pasta', 'people laughing together', 'giraffe', 'a red bus 2015'])
  report.laterSearches.push({ query: q, ...(await timed(q)) })
report.nextPage = await timed('a dog on a sofa', 300)
report.extraMemoryMB = { withTextModel: mb(process.memoryUsage().rss - rssBefore) }
db.close()

// --- analysis speed on 24 MP photos, and the main thread's longest pause meanwhile ---
const photos = join(dir, 'photos')
mkdirSync(photos, { recursive: true })
const ids24 = JSON.parse(readFileSync(join(CACHE, 'coco/annotations/captions_val2017.json'), 'utf8'))
  .images.map((i) => i.id)
  .sort((a, b) => a - b)
  .slice(0, Number(process.env.BIG_PHOTOS ?? 40))
for (const [k, id] of ids24.entries()) {
  const out = join(photos, `DSCF${String(k).padStart(4, '0')}.JPG`)
  if (!existsSync(out))
    await sharp(join(CACHE, 'coco/val2017', `${String(id).padStart(12, '0')}.jpg`))
      .resize(6000, 4000, { fit: 'fill' })
      .withExif({ IFD2: { DateTimeOriginal: `2025:01:${String(1 + (k % 28)).padStart(2, '0')} 10:00:00` } })
      .jpeg({ quality: 92 })
      .toFile(out)
}
const { scanLibrary } = await import('../../src/main/scanner.ts')
for (const [label, withFaces] of [
  ['content only (upgrade from the previous version)', false],
  ['faces and content (a new photo)', true]
]) {
  const adb = new LibraryDb(join(dir, `analysis-${withFaces}.db`))
  adb.setSetting('basePath', photos)
  await scanLibrary(adb, photos, () => {})
  if (!withFaces) for (const p of adb.photosNeedingAnalysis({ faces: FACE_MODEL_VERSION, content: null }, 1000)) adb.saveFaces(p.id, [], FACE_MODEL_VERSION)
  const people = new People(adb, MODELS, join(dir, 'faces'), () => {})
  // As in the app: the content model on its own thread.
  const analysis = new Analysis({
    db: adb,
    people,
    images: new ImageCache(join(dir, 'cache')),
    modelsDir: MODELS,
    packaged: false,
    onContentProgress: () => {},
    loadContentModel: (d) => ContentModelWorker.start((o) => new Worker(new URL('../../src/main/contentWorker.ts', import.meta.url), o), d)
  })
  await analysis.contentModel() // load (and verify) first, as the app does before its first pass
  const h = monitorEventLoopDelay({ resolution: 5 })
  h.enable()
  const s = performance.now()
  await analysis.kick()
  const ms = performance.now() - s
  h.disable()
  report[`analysis: ${label}`] = { photos: ids24.length, msPerPhoto: Math.round(ms / ids24.length), longestMainThreadPauseMs: Math.round(h.max / 1e6) }
  adb.close()
}
report.peakRssMB = mb(process.resourceUsage().maxRSS * 1024)

console.log(JSON.stringify(report, null, 2))

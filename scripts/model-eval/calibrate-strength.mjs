// Calibrates the "strong"/"weak" line of search_photos (spec 0011) on COCO val2017, offline:
//   node --experimental-strip-types calibrate-strength.mjs      (after ./download.sh)
// For each of the 80 COCO object names as a query, the content matches (score >= CONTENT_MIN_SCORE,
// scored as the app does: int8 cosine) are split by a rule into strong and weak, and COCO's labels
// say which are right. Rules: a fraction of the best score; a fraction of the best margin above
// CONTENT_MIN_SCORE (the one the app uses); the biggest gap. Reports, for each
// setting, the precision of the strong and of the weak matches, and the share of right matches kept strong.
// Vectors are cached (derived from COCO, never from the owner's photos).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { ContentModel, CONTENT_MIN_SCORE } from '../../src/main/contentModel.ts'
import { decodeForAnalysis } from '../../src/main/decode.ts'
import { quantise } from '../../src/main/vectorStore.ts'

const D = 768
const N = Number(process.env.COCO_IMAGES ?? 5000)
const CACHE = process.env.PHOTO_LIBRARY_EVAL_CACHE ?? join(homedir(), '.cache', 'photo-library-eval')
const MODELS = join(import.meta.dirname, '..', '..', 'resources', 'models')
const instances = JSON.parse(readFileSync(join(CACHE, 'coco/annotations/instances_val2017.json'), 'utf8'))
const captions = JSON.parse(readFileSync(join(CACHE, 'coco/annotations/captions_val2017.json'), 'utf8'))
const imageIds = captions.images
  .map((i) => i.id)
  .sort((a, b) => a - b)
  .slice(0, N)
const index = new Map(imageIds.map((id, i) => [id, i]))
const model = await ContentModel.load(MODELS)

const dir = join(CACHE, 'strength')
mkdirSync(dir, { recursive: true })
const cacheFile = join(dir, `vectors-${N}.bin`)
const img = new Float32Array(N * D)
let done = 0
if (existsSync(cacheFile)) {
  const b = readFileSync(cacheFile)
  img.set(new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)))
  done = b.length / (D * 4)
}
const deadline = Date.now() + Number(process.env.BUDGET_MS ?? Infinity)
for (let i = done; i < N && Date.now() < deadline; i++) {
  img.set(await model.embedImage(await decodeForAnalysis(join(CACHE, 'coco/val2017', `${String(imageIds[i]).padStart(12, '0')}.jpg`), false)), i * D)
  done = i + 1
  if (done % 250 === 0) writeFileSync(cacheFile, Buffer.from(img.buffer, 0, done * D * 4))
}
writeFileSync(cacheFile, Buffer.from(img.buffer, 0, done * D * 4))
if (done < N) {
  console.error(`${done}/${N} images embedded; run again to continue`)
  process.exit(2)
}

const toInt8 = (v) => new Int8Array(quantise(v).buffer)
const imgQ = Array.from({ length: N }, (_, i) => toInt8(img.subarray(i * D, (i + 1) * D)))
const norm = (q) => Math.sqrt(q.reduce((s, x) => s + x * x, 0))
const norms = imgQ.map(norm)
const categories = instances.categories
const positives = new Map(categories.map((c) => [c.id, new Set()]))
for (const a of instances.annotations) if (index.has(a.image_id)) positives.get(a.category_id).add(index.get(a.image_id))

const queries = []
for (const c of categories) {
  const q = toInt8(await model.embedText(c.name))
  const qn = norm(q)
  const matches = []
  for (let i = 0; i < N; i++) {
    let s = 0
    for (let k = 0; k < D; k++) s += q[k] * imgQ[i][k]
    s /= qn * norms[i]
    if (s >= CONTENT_MIN_SCORE) matches.push({ i, s })
  }
  matches.sort((a, b) => b.s - a.s)
  if (matches.length) queries.push({ pos: positives.get(c.id), matches })
}

const rules = {}
const fractions = Array.from({ length: 10 }, (_, k) => 0.5 + k * 0.05)
for (const f of fractions) rules[`fraction ${f.toFixed(2)}`] = (m) => m.findIndex((x) => x.s < f * m[0].s)
// The fraction of the best match's margin above CONTENT_MIN_SCORE (what the app uses).
const MIN = CONTENT_MIN_SCORE
for (const f of fractions) rules[`margin ${f.toFixed(2)}`] = (m) => m.findIndex((x) => x.s - MIN < f * (m[0].s - MIN))
rules['biggest gap'] = (m) => {
  let at = 0,
    gap = -1
  for (let k = 1; k < m.length; k++) if (m[k - 1].s - m[k].s > gap) ((gap = m[k - 1].s - m[k].s), (at = k))
  return at
}
const rows = []
for (const [name, rule] of Object.entries(rules)) {
  let sTp = 0,
    sN = 0,
    wTp = 0,
    wN = 0,
    right = 0,
    strongQueries = 0,
    bestWrong = 0
  for (const q of queries) {
    let cut = rule(q.matches)
    if (cut < 0) cut = q.matches.length
    cut = Math.max(cut, 1)
    q.matches.forEach((m, k) => {
      const ok = q.pos.has(m.i)
      if (ok) right++
      if (k < cut) (sN++, ok && sTp++)
      else (wN++, ok && wTp++)
    })
    strongQueries += cut
    if (!q.pos.has(q.matches[0].i)) bestWrong++
  }
  rows.push({
    rule: name,
    strongPrecision: +(sTp / (sN || 1)).toFixed(3),
    weakPrecision: +(wTp / (wN || 1)).toFixed(3),
    rightKeptStrong: +(sTp / right).toFixed(3),
    meanStrong: +(strongQueries / queries.length).toFixed(1),
    meanMatches: +((sN + wN) / queries.length).toFixed(1)
  })
}
writeFileSync(join(dir, 'strength.json'), JSON.stringify(rows, null, 2))
console.log(`${queries.length} queries, ${N} images, CONTENT_MIN_SCORE ${CONTENT_MIN_SCORE}`)
console.table(rows)

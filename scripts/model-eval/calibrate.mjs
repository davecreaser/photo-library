// Calibrates and checks the app's own content pipeline (spec 0002) on COCO val2017, offline:
//   node --experimental-strip-types calibrate.mjs      (after ./download.sh; ~6 min on a Mac)
// Uses the app's code (src/main: decode, SigLIP, int8 vectors), not Transformers.js, and reports:
//  1. text→image recall on COCO 1k (compare ADR 0008's reference numbers), float32 and int8;
//  2. how much int8 storage changes results: top-20 overlap with float32 for many queries;
//  3. the content-match threshold: precision/recall of each candidate threshold when the 80
//     COCO object names are the queries and COCO's labels say which images show them;
//  4. analysis time per photo (decode + image encoder) on these ~640x480 images.
// Image vectors are cached in results/ (they're derived from COCO, never from the owner's photos).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CACHE } from './models.mjs'
import { JUDGED, FIDELITY } from './library.mjs'
import { ContentModel } from '../../src/main/contentModel.ts'
import { decodeForAnalysis } from '../../src/main/decode.ts'
import { quantise } from '../../src/main/vectorStore.ts'

const D = 768
const N = Number(process.env.COCO_IMAGES ?? 5000)
const MODELS = join(import.meta.dirname, '..', '..', 'resources', 'models')
const RESULTS = join(import.meta.dirname, 'results')
mkdirSync(RESULTS, { recursive: true })

const captions = JSON.parse(readFileSync(join(CACHE, 'coco/annotations/captions_val2017.json'), 'utf8'))
const instances = JSON.parse(readFileSync(join(CACHE, 'coco/annotations/instances_val2017.json'), 'utf8'))
const imageIds = captions.images
  .map((i) => i.id)
  .sort((a, b) => a - b)
  .slice(0, N)
const index = new Map(imageIds.map((id, i) => [id, i]))
const file = (id) => join(CACHE, 'coco/val2017', `${String(id).padStart(12, '0')}.jpg`)

const model = await ContentModel.load(MODELS)

// --- image vectors (cached) ---
const cacheFile = join(RESULTS, `coco-app-vectors-${N}.bin`)
let img
let msPerPhoto = null
if (existsSync(cacheFile)) {
  img = new Float32Array(readFileSync(cacheFile).buffer.slice(0))
} else {
  img = new Float32Array(N * D)
  const t0 = performance.now()
  for (let i = 0; i < N; i++) {
    img.set(await model.embedImage(await decodeForAnalysis(file(imageIds[i]), false)), i * D)
    if (i % 500 === 499) console.error(`${i + 1}/${N} images`)
  }
  msPerPhoto = (performance.now() - t0) / N
  writeFileSync(cacheFile, Buffer.from(img.buffer))
}

// int8 as stored, compared as sqlite-vec does (cosine of the int8 vectors).
const toInt8 = (v) => new Int8Array(quantise(v).buffer)
const imgQ = Array.from({ length: N }, (_, i) => toInt8(img.subarray(i * D, (i + 1) * D)))
const norms = imgQ.map((q) => Math.sqrt(q.reduce((s, x) => s + x * x, 0)))
function scores(text, int8) {
  const out = new Float64Array(N)
  if (int8) {
    const q = toInt8(text)
    const qn = Math.sqrt(q.reduce((s, x) => s + x * x, 0))
    for (let i = 0; i < N; i++) {
      let s = 0
      const v = imgQ[i]
      for (let k = 0; k < D; k++) s += q[k] * v[k]
      out[i] = s / (qn * norms[i])
    }
  } else {
    for (let i = 0; i < N; i++) {
      let s = 0
      for (let k = 0; k < D; k++) s += text[k] * img[i * D + k]
      out[i] = s
    }
  }
  return out
}
const topK = (s, k) =>
  Array.from(s.keys())
    .sort((a, b) => s[b] - s[a] || a - b)
    .slice(0, k)

const report = { images: N, msPerPhoto }

// --- 1. recall on COCO 1k (the benchmark's subset: first 1,000 images) ---
{
  const M = Math.min(1000, N)
  const caps = captions.annotations.filter((a) => index.has(a.image_id) && index.get(a.image_id) < M)
  const hits = { f: { 1: 0, 5: 0, 10: 0 }, q: { 1: 0, 5: 0, 10: 0 } }
  for (const c of caps) {
    const t = await model.embedText(c.caption.trim().toLowerCase())
    for (const [key, int8] of [
      ['f', false],
      ['q', true]
    ]) {
      const s = scores(t, int8).subarray(0, M)
      const target = s[index.get(c.image_id)]
      let better = 0
      for (let i = 0; i < M; i++) if (s[i] > target) better++
      for (const k of [1, 5, 10]) if (better < k) hits[key][k]++
    }
  }
  const pct = (h) => Object.fromEntries(Object.entries(h).map(([k, v]) => [`R@${k}`, +((100 * v) / caps.length).toFixed(1)]))
  report.recall1k = { captions: caps.length, float32: pct(hits.f), int8: pct(hits.q) }
}

// --- 2. int8 vs float32: top-20 overlap ---
const categories = instances.categories.map((c) => ({ id: c.id, name: c.name }))
{
  const queries = [
    ...categories.map((c) => c.name),
    ...JUDGED,
    ...FIDELITY,
    ...captions.annotations
      .filter((a) => index.has(a.image_id))
      .slice(0, 500)
      .map((a) => a.caption.trim().toLowerCase())
  ]
  let same = 0
  let worst = 20
  for (const q of queries) {
    const t = await model.embedText(q)
    const a = new Set(topK(scores(t, false), 20))
    const overlap = topK(scores(t, true), 20).filter((i) => a.has(i)).length
    same += overlap
    worst = Math.min(worst, overlap)
  }
  report.int8Top20 = { queries: queries.length, meanOverlapPct: +((100 * same) / (20 * queries.length)).toFixed(2), worstOverlap: `${worst}/20` }
}

// --- 3. threshold: object names as queries, COCO labels as the truth ---
{
  const positives = new Map(categories.map((c) => [c.id, new Set()]))
  for (const a of instances.annotations) if (index.has(a.image_id)) positives.get(a.category_id).add(index.get(a.image_id))
  const cats = []
  for (const c of categories) cats.push({ name: c.name, pos: positives.get(c.id), s: scores(await model.embedText(c.name), true) })
  const nonsense = ['xqzv kjrw', 'qwpzx', 'blorft snarg', 'zzzz yyyy', 'asdf ghjk']
  const nonsenseMax = []
  for (const q of nonsense) nonsenseMax.push(Math.max(...scores(await model.embedText(q), true)))
  // Queries with no matching photos (a library without giraffes): COCO categories absent from an image set.
  const rows = []
  for (let t = 0.0; t <= 0.1201; t += 0.0025) {
    let tp = 0,
      fp = 0,
      fn = 0,
      emptyWhenAbsent = 0,
      precSum = 0,
      precN = 0,
      recSum = 0
    for (const c of cats) {
      let ctp = 0,
        cfp = 0,
        negAbove = 0
      for (let i = 0; i < N; i++) {
        const hit = c.s[i] >= t
        if (c.pos.has(i)) ctp += hit ? 1 : 0
        else if (hit) {
          cfp++
          negAbove++
        }
      }
      tp += ctp
      fp += cfp
      fn += c.pos.size - ctp
      if (negAbove === 0) emptyWhenAbsent++
      if (ctp + cfp > 0) {
        precSum += ctp / (ctp + cfp)
        precN++
      }
      recSum += ctp / c.pos.size
    }
    const precision = tp / (tp + fp || 1)
    const recall = tp / (tp + fn)
    rows.push({
      threshold: +t.toFixed(4),
      precision: +precision.toFixed(3),
      recall: +recall.toFixed(3),
      f1: +((2 * precision * recall) / (precision + recall || 1)).toFixed(3),
      macroPrecision: +(precSum / (precN || 1)).toFixed(3),
      macroRecall: +(recSum / cats.length).toFixed(3),
      emptyWhenAbsentPct: +((100 * emptyWhenAbsent) / cats.length).toFixed(1),
      nonsenseMatches: nonsenseMax.filter((m) => m >= t).length
    })
  }
  report.nonsenseMaxScore = Math.max(...nonsenseMax).toFixed(4)
  report.threshold = rows
}

writeFileSync(join(RESULTS, 'calibration.json'), JSON.stringify(report, null, 2))
const { threshold, ...summary } = report
console.log(JSON.stringify(summary, null, 2))
console.table(threshold)

// COCO val2017 text->image retrieval for one model variant: node coco.mjs clip-b32:fp32
// Fixed subset: the first 1,000 images by id and their ~5,000 captions ("COCO 1k").
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { CACHE, load, describe } from './models.mjs'

const variant = process.argv[2]
const N = Number(process.env.COCO_IMAGES ?? 1000)
const coco = JSON.parse(readFileSync(join(CACHE, 'coco/annotations/captions_val2017.json'), 'utf8'))
const images = coco.images
  .map((i) => i.id)
  .sort((a, b) => a - b)
  .slice(0, N)
const index = new Map(images.map((id, i) => [id, i]))
const captions = coco.annotations.filter((a) => index.has(a.image_id)).map((a) => ({ text: a.caption.trim(), image: index.get(a.image_id) }))
const file = (id) => join(CACHE, 'coco/val2017', `${String(id).padStart(12, '0')}.jpg`)

const t0 = performance.now()
const model = await load(variant)
const loadMs = performance.now() - t0

// Images, in batches of 8.
let imageMs = 0
const imageVecs = []
for (let i = 0; i < images.length; i += 8) {
  const t = performance.now()
  imageVecs.push(await model.embedImages(images.slice(i, i + 8).map(file)))
  imageMs += performance.now() - t
}
const dim = imageVecs[0].length / Math.min(8, images.length)
const img = new Float32Array(images.length * dim)
let off = 0
for (const v of imageVecs) {
  img.set(v, off)
  off += v.length
}

// Captions, in batches of 64.
const txt = new Float32Array(captions.length * dim)
for (let i = 0; i < captions.length; i += 64) txt.set(await model.embedTexts(captions.slice(i, i + 64).map((c) => c.text)), i * dim)

// Single-query latency (what a user waits for when typing).
const lat = []
for (let i = 0; i < 15; i++) {
  const t = performance.now()
  await model.embedTexts([['a dog on the beach', 'snow on the mountains', 'birthday cake with candles'][i % 3]])
  lat.push(performance.now() - t)
}
lat.sort((a, b) => a - b)

// Recall@K: for each caption, is its image among the top K images?
const hits = { 1: 0, 5: 0, 10: 0 }
for (let c = 0; c < captions.length; c++) {
  const scores = new Float32Array(images.length)
  for (let i = 0; i < images.length; i++) {
    let s = 0
    for (let k = 0; k < dim; k++) s += txt[c * dim + k] * img[i * dim + k]
    scores[i] = s
  }
  const target = scores[captions[c].image]
  let better = 0
  for (let i = 0; i < images.length; i++) if (scores[i] > target) better++
  for (const k of [1, 5, 10]) if (better < k) hits[k]++
}

const { family, dtype, licence } = describe(variant)
const result = {
  variant,
  family,
  dtype,
  licence,
  dim,
  images: images.length,
  captions: captions.length,
  recall: { r1: hits[1] / captions.length, r5: hits[5] / captions.length, r10: hits[10] / captions.length },
  msPerImage: imageMs / images.length,
  queryMs: lat[Math.floor(lat.length / 2)],
  loadMs,
  peakRssMB: Math.round(process.resourceUsage().maxRSS / 1024)
}
mkdirSync('results', { recursive: true })
writeFileSync(join('results', `coco-${variant.replace(':', '-')}.json`), JSON.stringify(result, null, 2))
// Keep the image embeddings so quantisation fidelity can be compared without re-running.
writeFileSync(join('results', `coco-${variant.replace(':', '-')}.img.bin`), Buffer.from(img.buffer))
console.log(JSON.stringify(result))

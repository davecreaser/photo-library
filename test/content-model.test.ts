// The app's own SigLIP pipeline against the reference implementation (Transformers.js), whose
// outputs scripts/model-eval/reference.mjs saved in test/fixtures/siglip. Needs the content
// model in resources/models (npm install fetches it).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import sharp from 'sharp'
import { ContentModel, ContentModelUnavailable } from '../src/main/contentModel.ts'
import { ContentModelWorker } from '../src/main/contentModelWorker.ts'

const FIXTURES = join(import.meta.dirname, 'fixtures', 'siglip')
const MODELS = join(import.meta.dirname, '..', 'resources', 'models')
const reference = JSON.parse(readFileSync(join(FIXTURES, 'reference.json'), 'utf8')) as {
  texts: { phrase: string; ids: number[]; embedding: number[] | null }[]
  images: { file: string; embedding: number[] }[]
}
const model = await ContentModel.load(MODELS)

const cosine = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}
const maxDiff = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let m = 0
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]))
  return m
}

test('tokenizer gives exactly the reference token ids (punctuation, Unicode, special tokens, truncation)', () => {
  for (const t of reference.texts) assert.deepEqual(model.tokenize(t.phrase), t.ids, JSON.stringify(t.phrase))
})

test('text embeddings match the reference', async () => {
  for (const t of reference.texts) {
    if (!t.embedding) continue
    const v = await model.embedText(t.phrase)
    assert.equal(v.length, 768)
    assert.ok(cosine(v, t.embedding) > 0.9999, `${t.phrase}: cosine ${cosine(v, t.embedding)}`)
    assert.ok(maxDiff(v, t.embedding) < 2e-3, `${t.phrase}: max difference ${maxDiff(v, t.embedding)}`)
  }
})

const decode = async (file: string) => {
  const { data, info } = await sharp(join(FIXTURES, file)).removeAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

test('image embeddings match the reference at the model’s own size', async () => {
  for (const img of reference.images.filter((i) => !i.file.includes('x'))) {
    const v = await model.embedImage(await decode(img.file))
    assert.ok(cosine(v, img.embedding) > 0.9999, `${img.file}: cosine ${cosine(v, img.embedding)}`)
    assert.ok(maxDiff(v, img.embedding) < 2e-3, `${img.file}: max difference ${maxDiff(v, img.embedding)}`)
  }
})

test('resized images stay close to the reference (the app antialiases where the reference samples)', async () => {
  for (const img of reference.images.filter((i) => i.file.includes('x'))) {
    const v = await model.embedImage(await decode(img.file))
    assert.ok(cosine(v, img.embedding) > 0.95, `${img.file}: cosine ${cosine(v, img.embedding)}`)
  }
})

test('on its own thread: the same vectors, the calling thread stays free, and a missing model says so (AC-12, AC-9)', async () => {
  const start = (dir: string) => ContentModelWorker.start((o) => new Worker(new URL('../src/main/contentWorker.ts', import.meta.url), o), dir)
  // Measure the longest stall of this thread while the worker loads both encoders and embeds.
  let last = performance.now()
  let longest = 0
  const tick = setInterval(() => {
    const now = performance.now()
    longest = Math.max(longest, now - last)
    last = now
  }, 5)
  const worker = await start(MODELS)
  const text = await worker.embedText('sunset over water')
  const image = await worker.embedImage(await decode('sunset.png'))
  clearInterval(tick)
  assert.ok(cosine(text, await model.embedText('sunset over water')) > 0.99999)
  assert.ok(cosine(image, await model.embedImage(await decode('sunset.png'))) > 0.99999)
  assert.ok(longest < 100, `longest stall ${Math.round(longest)} ms (loading an encoder here would stall ~250 ms)`)
  await worker.releaseImageEncoder()

  await assert.rejects(start(join(FIXTURES, 'no-models-here')), (e: unknown) => e instanceof ContentModelUnavailable && e.reason === 'missing')
})

test('phrases pick the right generated image', async () => {
  const images = await Promise.all(['red.png', 'blue.png', 'sunset.png', 'tree.png'].map(async (f) => model.embedImage(await decode(f))))
  const best = async (phrase: string) => {
    const q = await model.embedText(phrase)
    const scores = images.map((v) => cosine(q, v))
    return scores.indexOf(Math.max(...scores))
  }
  assert.equal(await best('red'), 0)
  assert.equal(await best('blue'), 1)
  assert.equal(await best('sunset over water'), 2)
  assert.equal(await best('a tree'), 3)
})

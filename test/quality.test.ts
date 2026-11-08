import { test } from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { decodeForAnalysis } from '../src/main/decode.ts'
import { measureQuality, qualityScore } from '../src/main/quality.ts'

/** A generated "scene": coloured blocks and fine stripes, so there are edges to lose. */
async function scene(opts: { blur?: number; brightness?: number } = {}): Promise<Buffer> {
  const w = 600
  const h = 400
  const raw = Buffer.alloc(w * h * 3)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3
      const stripe = Math.floor(x / 6 + y / 9) % 2 === 0 ? 70 : 190
      const block = ((Math.floor(x / 100) + Math.floor(y / 100)) % 2) * 40
      const v = Math.min(255, stripe + block)
      raw[i] = v
      raw[i + 1] = Math.min(255, v + 10)
      raw[i + 2] = Math.max(0, v - 10)
    }
  }
  let img = sharp(raw, { raw: { width: w, height: h, channels: 3 } })
  if (opts.blur) img = img.blur(opts.blur)
  if (opts.brightness !== undefined) img = img.linear(opts.brightness, 0)
  return img.jpeg({ quality: 95 }).toBuffer()
}

const measure = async (buf: Buffer, forFaces = false) => measureQuality(await decodeForAnalysis(buf, forFaces))

test('AC-1: a sharp photo scores higher than the same photo blurred', async () => {
  const sharpQ = await measure(await scene())
  const blurQ = await measure(await scene({ blur: 6 }))
  assert.ok(sharpQ.sharpness > blurQ.sharpness + 0.3, `${sharpQ.sharpness} vs ${blurQ.sharpness}`)
  assert.ok(qualityScore(sharpQ) > qualityScore(blurQ))
})

test('AC-1: an almost black or almost white photo scores lower than a well exposed one', async () => {
  const good = await measure(await scene())
  const black = await measure(await scene({ brightness: 0.03 }))
  const white = await measure(await scene({ brightness: 6 }))
  assert.ok(good.exposure > black.exposure + 0.3, `${good.exposure} vs ${black.exposure}`)
  assert.ok(good.exposure > white.exposure + 0.3, `${good.exposure} vs ${white.exposure}`)
  assert.ok(qualityScore(good) > qualityScore(black))
  assert.ok(qualityScore(good) > qualityScore(white))
})

test('AC-1: the same photo measured at the content size and at the face size gives similar scores', async () => {
  const buf = await scene()
  const a = await measure(buf, false)
  const b = await measure(buf, true)
  assert.ok(Math.abs(a.sharpness - b.sharpness) < 0.3)
  assert.ok(Math.abs(a.exposure - b.exposure) < 0.1)
})

test('AC-1: bigger faces help a little, and scores stay within 0..1', () => {
  const q = { sharpness: 1, exposure: 1 }
  assert.ok(qualityScore(q, 0.2) > qualityScore({ sharpness: 0.9, exposure: 1 }, 0))
  assert.ok(qualityScore(q, 1) <= 1)
  assert.ok(qualityScore({ sharpness: 0, exposure: 0 }) >= 0)
})

test('AC-10: measuring a 24-megapixel-sized decode takes under 40 ms', async () => {
  const img = await decodeForAnalysis(await scene(), true)
  const t = performance.now()
  for (let i = 0; i < 5; i++) measureQuality(img)
  assert.ok((performance.now() - t) / 5 < 40)
})

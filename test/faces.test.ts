import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clusterFaces, matchPeople, type FaceVector } from '../src/main/faceGroups.ts'
import { alignFace, decodeYuNet, nms, normalise, similarityTransform } from '../src/main/faces.ts'

// Synthetic "people": each is a random direction; their faces are that direction plus noise.
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 2 ** 32
    return seed / 2 ** 32 - 0.5
  }
}
const rand = rng(42)
const person = () => normalise(Float32Array.from({ length: 128 }, rand))
function faceOf(p: Float32Array, noise: number): Float32Array {
  return normalise(p.map((x) => x + rand() * noise * 0.2))
}

test('groups faces of the same person and keeps different people apart', () => {
  const [jake, mira, dave] = [person(), person(), person()]
  const faces: FaceVector[] = []
  let id = 1
  for (let i = 0; i < 12; i++) faces.push({ id: id++, embedding: faceOf(jake, 0.6), score: 0.9 })
  for (let i = 0; i < 6; i++) faces.push({ id: id++, embedding: faceOf(mira, 0.6), score: 0.9 })
  for (let i = 0; i < 3; i++) faces.push({ id: id++, embedding: faceOf(dave, 0.6), score: 0.9 })
  const groups = clusterFaces(faces)
  const groupOf = (ids: number[]) => new Set(ids.map((i) => groups.get(i)))
  assert.deepEqual(groupOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), new Set([0]), 'largest group numbered 0')
  assert.deepEqual(groupOf([13, 14, 15, 16, 17, 18]), new Set([1]))
  assert.deepEqual(groupOf([19, 20, 21]), new Set([2]))
})

test('recognises named people, respects "not this person", and leaves ambiguous faces alone', () => {
  const [jake, mira] = [person(), person()]
  const people = [
    { id: 1, embeddings: [faceOf(jake, 0.5), faceOf(jake, 0.5)] },
    { id: 2, embeddings: [faceOf(mira, 0.5)] }
  ]
  const newJake = { id: 100, embedding: faceOf(jake, 0.5), score: 0.9 }
  const newMira = { id: 101, embedding: faceOf(mira, 0.5), score: 0.9 }
  const stranger = { id: 102, embedding: person(), score: 0.9 }
  const between = { id: 103, embedding: normalise(jake.map((x, i) => x + mira[i])), score: 0.9 }

  const m = matchPeople([newJake, newMira, stranger, between], people, new Set())
  assert.equal(m.get(100), 1)
  assert.equal(m.get(101), 2)
  assert.equal(m.has(102), false, 'strangers stay unnamed')
  assert.equal(m.has(103), false, 'a face equally like two people is not guessed')

  const withRejection = matchPeople([newJake], people, new Set(['100:1']))
  assert.equal(withRejection.has(100), false)
})

test('similarity transform recovers rotation, scale and shift', () => {
  const src = [0, 0, 10, 0, 0, 10, 10, 10, 5, 5]
  // Rotate 90°, scale 2, shift (3, 4): x' = -2y + 3, y' = 2x + 4
  const dst = [3, 4, 3, 24, -17, 4, -17, 24, -7, 14]
  const [a, b, tx, ty] = similarityTransform(src, dst)
  assert.ok(Math.abs(a) < 1e-9 && Math.abs(b - 2) < 1e-9 && Math.abs(tx - 3) < 1e-9 && Math.abs(ty - 4) < 1e-9)
})

test('alignment maps landmarks onto the template', () => {
  // A 200x200 image with one bright pixel at the left-eye landmark: it should land near (38, 52).
  const W = 200, H = 200
  const img = Buffer.alloc(W * H * 3)
  const kps = [80, 90, 120, 90, 100, 110, 85, 130, 115, 130]
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) img[((90 + dy) * W + 80 + dx) * 3] = 255
  const out = alignFace(img, W, H, kps)
  let best = 0, at = 0
  for (let i = 0; i < 112 * 112; i++) if (out[i * 3] > best) { best = out[i * 3]; at = i }
  const [x, y] = [at % 112, Math.floor(at / 112)]
  assert.ok(Math.abs(x - 38) <= 2 && Math.abs(y - 52) <= 2, `bright pixel at ${x},${y}`)
})

test('YuNet decoding and NMS', () => {
  // One confident anchor at stride 32, cell (row 2, col 3), box centred in the cell, 2x2 cells big.
  const cells = (640 / 32) ** 2
  const cls = new Float32Array(cells), obj = new Float32Array(cells), bbox = new Float32Array(cells * 4), kps = new Float32Array(cells * 10)
  const i = 2 * 20 + 3
  cls[i] = 0.95; obj[i] = 0.95
  bbox.set([0.5, 0.5, Math.log(2), Math.log(2)], i * 4)
  const [d, ...rest] = decodeYuNet(cls, obj, bbox, kps, 32, 640, 0.8)
  assert.equal(rest.length, 0)
  assert.deepEqual([d.x1, d.y1, d.x2, d.y2].map((v) => Math.round(v * 1000) / 1000), [3.5 * 32 - 32, 2.5 * 32 - 32, 3.5 * 32 + 32, 2.5 * 32 + 32])
  assert.ok(Math.abs(d.score - 0.95) < 1e-6)
  const dup = { ...d, x1: d.x1 + 2, score: 0.85 }
  const other = { ...d, x1: 400, x2: 460, score: 0.9 }
  assert.deepEqual(nms([dup, d, other], 0.3).map((x) => x.score), [d.score, 0.9])
})

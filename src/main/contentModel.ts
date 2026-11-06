// Local content model (spec 0002, ADR 0008): SigLIP base patch16-224 at half precision.
// Its image and text encoders put photos and phrases in one space, so a typed phrase can be
// compared with every analysed photo without reading the photos again. Nothing leaves the machine.
//
// The pipeline matches the reference (Transformers.js) except for resizing: photos are shrunk
// to 224x224 with an antialiasing filter rather than sampled, which keeps fine detail from
// aliasing in large photos (measured in the PR; test/content-model.test.ts checks the rest).
import sharp from 'sharp'
import * as ort from 'onnxruntime-node'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { SiglipTokenizer, MAX_TOKENS, type TokenizerJson } from './siglipTokenizer.ts'
import { CONTENT_IMAGE_SIZE as IMAGE_SIZE, type RgbImage } from './decode.ts'
import modelFiles from './modelFiles.json' with { type: 'json' }

/** Bump when the model or its pipeline changes: photos are re-analysed and older results are never searched. */
export const CONTENT_MODEL_VERSION = 1

/**
 * A photo is a content match when its cosine similarity to the phrase is at least this: fixed
 * for the model, never per library (spec 0002, AC-2). Chosen on COCO val2017 (5,000 images, the
 * 80 object names as queries, COCO's labels as the truth) as the threshold with the best F1
 * (0.475: precision 0.61, recall 0.39); scripts/model-eval/calibrate.mjs reproduces it. Revisit
 * with any change to the model or CONTENT_MODEL_VERSION.
 */
export const CONTENT_MIN_SCORE = 0.0425

export const CONTENT_DIM = 768
const MODEL_DIR = 'siglip-base-patch16-224'

/** Missing or damaged files, or the model (or its thread) failed to start. */
export type UnavailableReason = 'missing' | 'damaged' | 'failed'

/** What analysis and search need from the content model, wherever it runs (ContentModel, ContentModelWorker). */
export interface ContentEncoder {
  embedImage(image: RgbImage): Promise<Float32Array>
  embedText(text: string): Promise<Float32Array>
  releaseImageEncoder(): Promise<void>
}

export class ContentModelUnavailable extends Error {
  reason: UnavailableReason
  constructor(reason: UnavailableReason, detail: string) {
    super(detail)
    this.name = 'ContentModelUnavailable'
    this.reason = reason
  }
}

async function sha256(file: string): Promise<string> {
  const h = createHash('sha256')
  await pipeline(createReadStream(file), h)
  return h.digest('hex')
}

/** Checks every content model file against its pinned checksum (the same pins the install step uses). */
export async function verifyContentModel(modelsDir: string): Promise<void> {
  for (const m of modelFiles.content) {
    let actual: string
    try {
      actual = await sha256(join(modelsDir, m.file))
    } catch {
      throw new ContentModelUnavailable('missing', `${m.file} not found`)
    }
    if (actual !== m.sha256) throw new ContentModelUnavailable('damaged', `${m.file} checksum didn't match`)
  }
}

const SESSION_OPTIONS: ort.InferenceSession.SessionOptions = { logSeverityLevel: 3, graphOptimizationLevel: 'all' }

export class ContentModel implements ContentEncoder {
  private dir: string
  private tokenizer: SiglipTokenizer
  private vision: Promise<ort.InferenceSession> | null = null
  private text: Promise<ort.InferenceSession> | null = null

  private constructor(dir: string, tokenizer: SiglipTokenizer) {
    this.dir = dir
    this.tokenizer = tokenizer
  }

  /** Verifies the files, then loads the tokenizer. The encoders load on first use. */
  static async load(modelsDir: string): Promise<ContentModel> {
    await verifyContentModel(modelsDir)
    const dir = join(modelsDir, MODEL_DIR)
    const json = JSON.parse(await readFile(join(dir, 'tokenizer.json'), 'utf8')) as TokenizerJson
    return new ContentModel(dir, new SiglipTokenizer(json))
  }

  tokenize(text: string): number[] {
    return this.tokenizer.encode(text)
  }

  /** The photo's content vector (L2-normalised). */
  async embedImage(image: RgbImage): Promise<Float32Array> {
    const pixels = await toModelInput(image)
    this.vision ??= ort.InferenceSession.create(join(this.dir, 'vision_model_fp16.onnx'), SESSION_OPTIONS)
    const session = await this.vision
    const out = await session.run({ pixel_values: new ort.Tensor('float32', pixels, [1, 3, IMAGE_SIZE, IMAGE_SIZE]) })
    return normalise(out.pooler_output.data as Float32Array)
  }

  /** The phrase's content vector (L2-normalised). */
  async embedText(text: string): Promise<Float32Array> {
    const ids = BigInt64Array.from(this.tokenize(text), (id) => BigInt(id))
    this.text ??= ort.InferenceSession.create(join(this.dir, 'text_model_fp16.onnx'), SESSION_OPTIONS)
    const session = await this.text
    const out = await session.run({ input_ids: new ort.Tensor('int64', ids, [1, MAX_TOKENS]) })
    return normalise(out.pooler_output.data as Float32Array)
  }

  /** Frees the image encoder's memory (~0.4 GB) when analysis is done; it reloads if needed. */
  async releaseImageEncoder(): Promise<void> {
    const vision = this.vision
    this.vision = null
    if (vision) await (await vision).release()
  }
}

/** 224x224, scaled to -1..1 (mean 0.5, std 0.5), channels first. */
export async function toModelInput(image: RgbImage): Promise<Float32Array> {
  const rgb =
    image.width === IMAGE_SIZE && image.height === IMAGE_SIZE
      ? image.data
      : await sharp(image.data, { raw: { width: image.width, height: image.height, channels: 3 } })
          .resize(IMAGE_SIZE, IMAGE_SIZE, { fit: 'fill', kernel: 'cubic' })
          .raw()
          .toBuffer()
  const plane = IMAGE_SIZE * IMAGE_SIZE
  const out = new Float32Array(3 * plane)
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) out[c * plane + i] = (rgb[i * 3 + c] * (1 / 255) - 0.5) / 0.5
  }
  return out
}

function normalise(v: Float32Array): Float32Array {
  let n = 0
  for (const x of v) n += x * x
  n = Math.sqrt(n) || 1
  return Float32Array.from(v, (x) => x / n)
}

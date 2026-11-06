// Candidate content-search models (spec 0002). Each variant knows how to embed
// images and text into one shared space, using Transformers.js as the reference
// implementation (offline, from the local cache only).
import {
  env,
  AutoProcessor,
  AutoTokenizer,
  RawImage,
  CLIPVisionModelWithProjection,
  CLIPTextModelWithProjection,
  SiglipVisionModel,
  SiglipTextModel,
  AutoModel
} from '@huggingface/transformers'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const CACHE = process.env.PHOTO_LIBRARY_EVAL_CACHE ?? join(homedir(), '.cache', 'photo-library-eval')
env.localModelPath = join(CACHE, 'models')
env.allowRemoteModels = false
env.allowLocalModels = true

/** dtype names as Transformers.js maps them to files: fp32 = *.onnx, fp16 = *_fp16.onnx, q8 = *_quantized.onnx. */
const FAMILIES = {
  'clip-b32': { repo: 'Xenova/clip-vit-base-patch32', kind: 'clip', licence: 'MIT', dtypes: ['fp32', 'fp16', 'q8'] },
  'clip-b16': { repo: 'Xenova/clip-vit-base-patch16', kind: 'clip', licence: 'MIT', dtypes: ['fp32', 'fp16', 'q8'] },
  'clip-l14': { repo: 'Xenova/clip-vit-large-patch14', kind: 'clip', licence: 'MIT', dtypes: ['fp16', 'q8'] },
  siglip: { repo: 'Xenova/siglip-base-patch16-224', kind: 'siglip', licence: 'Apache-2.0', dtypes: ['fp32', 'fp16', 'q8'] },
  siglip2: {
    repo: 'onnx-community/siglip2-base-patch16-224-ONNX',
    kind: 'siglip',
    licence: 'Apache-2.0',
    dtypes: ['fp32', 'fp16', 'q8'],
    textDtypes: { fp32: 'fp16' }
  },
  nomic: {
    repo: 'nomic-ai/nomic-embed-vision-v1.5',
    textRepo: 'nomic-ai/nomic-embed-text-v1.5',
    kind: 'nomic',
    licence: 'Apache-2.0',
    dtypes: ['fp32', 'fp16', 'q8']
  }
}

export const VARIANTS = Object.entries(FAMILIES).flatMap(([family, f]) => f.dtypes.map((dtype) => `${family}:${dtype}`))

export function describe(variant) {
  const [family, dtype] = variant.split(':')
  return { family, dtype, ...FAMILIES[family] }
}

function normalise(rows, dim) {
  const out = new Float32Array(rows.length * dim)
  rows.forEach((r, i) => {
    let n = 0
    for (let k = 0; k < dim; k++) n += r[k] * r[k]
    n = Math.sqrt(n) || 1
    for (let k = 0; k < dim; k++) out[i * dim + k] = r[k] / n
  })
  return out
}

function rowsOf(tensor) {
  const [count, dim] = tensor.dims.length === 2 ? tensor.dims : [tensor.dims[0], tensor.dims.at(-1)]
  const data = tensor.data
  return { dim, rows: Array.from({ length: count }, (_, i) => data.subarray(i * dim, (i + 1) * dim)) }
}

/** Loads a variant. Returns { dim, embedImages(paths) -> Float32Array, embedTexts(texts) -> Float32Array } (L2-normalised rows). */
export async function load(variant) {
  const { repo, textRepo, kind, dtype, textDtypes } = describe(variant)
  const textDtype = textDtypes?.[dtype] ?? dtype
  const opts = { dtype, device: 'cpu', local_files_only: true }
  const processor = await AutoProcessor.from_pretrained(repo, { local_files_only: true })

  let vision, text, tokenizer, textMode
  if (kind === 'clip') {
    vision = await CLIPVisionModelWithProjection.from_pretrained(repo, opts)
    text = await CLIPTextModelWithProjection.from_pretrained(repo, { ...opts, dtype: textDtype })
    tokenizer = await AutoTokenizer.from_pretrained(repo, { local_files_only: true })
    textMode = { padding: true, truncation: true }
  } else if (kind === 'siglip') {
    vision = await SiglipVisionModel.from_pretrained(repo, opts)
    text = await SiglipTextModel.from_pretrained(repo, { ...opts, dtype: textDtype })
    tokenizer = await AutoTokenizer.from_pretrained(repo, { local_files_only: true })
    textMode = { padding: 'max_length', truncation: true, max_length: 64 }
  } else {
    // Nomic's vision model file is model.onnx rather than vision_model.onnx.
    vision = await CLIPVisionModelWithProjection.from_pretrained(repo, { ...opts, model_file_name: 'model' })
    text = await AutoModel.from_pretrained(textRepo, { ...opts, dtype: textDtype })
    tokenizer = await AutoTokenizer.from_pretrained(textRepo, { local_files_only: true })
    textMode = { padding: true, truncation: true }
  }

  async function embedImages(paths) {
    const images = await Promise.all(paths.map((p) => RawImage.read(p)))
    const inputs = await processor(images)
    const out = await vision(inputs)
    const tensor = kind === 'siglip' ? out.pooler_output : (out.image_embeds ?? out.last_hidden_state)
    if (kind === 'nomic' && !out.image_embeds) {
      // Nomic vision: the CLS token of the last hidden state.
      const [n, , d] = tensor.dims
      return normalise(
        Array.from({ length: n }, (_, i) => tensor.data.subarray(i * tensor.dims[1] * d, i * tensor.dims[1] * d + d)),
        d
      )
    }
    const { dim, rows } = rowsOf(tensor)
    return normalise(rows, dim)
  }

  async function embedTexts(texts) {
    const prepared = kind === 'nomic' ? texts.map((t) => `search_query: ${t}`) : texts
    const inputs = tokenizer(prepared, textMode)
    const out = await text(inputs)
    if (kind === 'nomic') {
      // Mean-pool over real tokens, then layer-norm (nomic-embed-text v1.5), then L2-normalise.
      const h = out.last_hidden_state
      const [n, len, d] = h.dims
      const mask = inputs.attention_mask.data
      const rows = []
      for (let i = 0; i < n; i++) {
        const v = new Float32Array(d)
        let count = 0
        for (let t = 0; t < len; t++) {
          if (!Number(mask[i * len + t])) continue
          count++
          for (let k = 0; k < d; k++) v[k] += h.data[(i * len + t) * d + k]
        }
        for (let k = 0; k < d; k++) v[k] /= count || 1
        let mean = 0
        for (let k = 0; k < d; k++) mean += v[k]
        mean /= d
        let variance = 0
        for (let k = 0; k < d; k++) variance += (v[k] - mean) ** 2
        const sd = Math.sqrt(variance / d + 1e-5)
        for (let k = 0; k < d; k++) v[k] = (v[k] - mean) / sd
        rows.push(v)
      }
      return normalise(rows, d)
    }
    const tensor = kind === 'siglip' ? out.pooler_output : out.text_embeds
    const { dim, rows } = rowsOf(tensor)
    return normalise(rows, dim)
  }

  return { embedImages, embedTexts }
}

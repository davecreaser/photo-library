// Local face detection and recognition. Nothing leaves the machine.
//  - YuNet (OpenCV Zoo) finds faces and 5 landmarks (eyes, nose, mouth corners).
//  - Each face is aligned to a standard 112x112 pose using the landmarks.
//  - SFace (OpenCV Zoo) turns the aligned face into a 128-number embedding.
// Faces of the same person have embeddings pointing in similar directions (high
// cosine similarity); faceGroups.ts uses that to group and recognise people.
import sharp from 'sharp'
import * as ort from 'onnxruntime-node'
import { join } from 'node:path'

/** Bump when detection/recognition changes, so photos get re-analysed. */
export const FACE_MODEL_VERSION = 1

const DET_SIZE = 640 // YuNet's fixed input
const DET_LONG_SIDE = 1280 // detection runs on the whole photo plus tiles at this size
const TILE_OVERLAP = 192
const ANALYSIS_LONG_SIDE = 2048 // faces are aligned from this resolution
const SCORE_THRESHOLD = 0.8
const NMS_IOU = 0.3
/** Faces smaller than this (in the 2048px image) are detected but not recognised: too blurry to be reliable. */
const MIN_RECOGNISABLE_PX = 40

export interface DetectedFace {
  /** Box relative to the upright image (0..1). */
  x: number
  y: number
  w: number
  h: number
  score: number
  /** 128 numbers, L2-normalised; null when the face is too small. */
  embedding: Float32Array | null
  /** 112x112 RGB crop used for recognition, also saved as the face thumbnail. */
  crop: Buffer
}

interface RawDetection {
  x1: number
  y1: number
  x2: number
  y2: number
  score: number
  /** 5 landmarks, [x, y] pairs. */
  kps: number[]
}

export class FaceAnalyser {
  private detector: ort.InferenceSession
  private recogniser: ort.InferenceSession

  private constructor(detector: ort.InferenceSession, recogniser: ort.InferenceSession) {
    this.detector = detector
    this.recogniser = recogniser
  }

  static async load(modelsDir: string): Promise<FaceAnalyser> {
    const opts: ort.InferenceSession.SessionOptions = { logSeverityLevel: 3, graphOptimizationLevel: 'all' }
    const [det, rec] = await Promise.all([
      ort.InferenceSession.create(join(modelsDir, 'face_detection_yunet_2023mar.onnx'), opts),
      ort.InferenceSession.create(join(modelsDir, 'face_recognition_sface_2021dec.onnx'), opts)
    ])
    return new FaceAnalyser(det, rec)
  }

  /** Finds and embeds faces. `image` is anything sharp can read (a path or an encoded buffer). */
  async analyse(image: string | Buffer): Promise<DetectedFace[]> {
    const { data, info } = await sharp(image, { failOn: 'none' })
      .rotate()
      .resize(ANALYSIS_LONG_SIDE, ANALYSIS_LONG_SIDE, { fit: 'inside', withoutEnlargement: true })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    const W = info.width
    const H = info.height

    // Detection image: long side 1280 (or smaller if the photo is small).
    const detScale = Math.min(1, DET_LONG_SIDE / Math.max(W, H))
    const dW = Math.round(W * detScale)
    const dH = Math.round(H * detScale)
    const det =
      detScale === 1
        ? data
        : await sharp(data, { raw: { width: W, height: H, channels: 3 } })
            .resize(dW, dH)
            .raw()
            .toBuffer()

    // The whole image (shrunk to 640) catches big faces; 640px tiles at full detection size catch small ones.
    const found: RawDetection[] = []
    const fit = Math.min(1, DET_SIZE / Math.max(dW, dH))
    found.push(...(await this.detectRegion(det, dW, dH, 0, 0, dW, dH, fit)))
    if (fit < 1) {
      for (const ty of tileStarts(dH)) {
        for (const tx of tileStarts(dW)) {
          found.push(...(await this.detectRegion(det, dW, dH, tx, ty, Math.min(DET_SIZE, dW - tx), Math.min(DET_SIZE, dH - ty), 1)))
        }
      }
    }

    const faces: DetectedFace[] = []
    for (const d of nms(found, NMS_IOU)) {
      // Back to the 2048px analysis image.
      const s = 1 / detScale
      const kps = d.kps.map((v) => v * s)
      const crop = alignFace(data, W, H, kps)
      const widthPx = (d.x2 - d.x1) * s
      faces.push({
        x: clamp01((d.x1 * s) / W),
        y: clamp01((d.y1 * s) / H),
        w: clamp01(((d.x2 - d.x1) * s) / W),
        h: clamp01(((d.y2 - d.y1) * s) / H),
        score: d.score,
        embedding: widthPx >= MIN_RECOGNISABLE_PX ? await this.embed(crop) : null,
        crop
      })
    }
    return faces
  }

  /** Runs YuNet on a region of the detection image, scaled by `scale` into the 640x640 input. */
  private async detectRegion(img: Buffer, imgW: number, imgH: number, rx: number, ry: number, rw: number, rh: number, scale: number): Promise<RawDetection[]> {
    const input = new Float32Array(3 * DET_SIZE * DET_SIZE) // zero padding outside the region
    const plane = DET_SIZE * DET_SIZE
    const outW = Math.round(rw * scale)
    const outH = Math.round(rh * scale)
    for (let y = 0; y < outH; y++) {
      const sy = Math.min(imgH - 1, ry + Math.floor(y / scale))
      for (let x = 0; x < outW; x++) {
        const sx = Math.min(imgW - 1, rx + Math.floor(x / scale))
        const si = (sy * imgW + sx) * 3
        const di = y * DET_SIZE + x
        // YuNet expects BGR, 0..255.
        input[di] = img[si + 2]
        input[plane + di] = img[si + 1]
        input[2 * plane + di] = img[si]
      }
    }
    const out = await this.detector.run({ input: new ort.Tensor('float32', input, [1, 3, DET_SIZE, DET_SIZE]) })
    const dets: RawDetection[] = []
    for (const stride of [8, 16, 32]) {
      const cls = out[`cls_${stride}`].data as Float32Array
      const obj = out[`obj_${stride}`].data as Float32Array
      const bbox = out[`bbox_${stride}`].data as Float32Array
      const kps = out[`kps_${stride}`].data as Float32Array
      for (const d of decodeYuNet(cls, obj, bbox, kps, stride, DET_SIZE, SCORE_THRESHOLD)) {
        // Detections in padding are partial faces at region edges; skip anything centred outside the region.
        const cx = (d.x1 + d.x2) / 2
        const cy = (d.y1 + d.y2) / 2
        if (cx > outW || cy > outH) continue
        const map = (v: number, o: number) => o + v / scale
        dets.push({
          x1: map(d.x1, rx),
          y1: map(d.y1, ry),
          x2: map(d.x2, rx),
          y2: map(d.y2, ry),
          score: d.score,
          kps: d.kps.map((v, i) => map(v, i % 2 === 0 ? rx : ry))
        })
      }
    }
    return dets
  }

  private async embed(crop: Buffer): Promise<Float32Array> {
    const plane = 112 * 112
    const input = new Float32Array(3 * plane)
    for (let i = 0; i < plane; i++) {
      // SFace expects RGB, 0..255.
      input[i] = crop[i * 3]
      input[plane + i] = crop[i * 3 + 1]
      input[2 * plane + i] = crop[i * 3 + 2]
    }
    const out = await this.recogniser.run({ data: new ort.Tensor('float32', input, [1, 3, 112, 112]) })
    return normalise(new Float32Array(out.fc1.data as Float32Array))
  }
}

function tileStarts(size: number): number[] {
  if (size <= DET_SIZE) return [0]
  const step = DET_SIZE - TILE_OVERLAP
  const starts: number[] = []
  for (let s = 0; s + DET_SIZE < size; s += step) starts.push(s)
  starts.push(size - DET_SIZE)
  return starts
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

export function normalise(v: Float32Array): Float32Array {
  let n = 0
  for (const x of v) n += x * x
  n = Math.sqrt(n) || 1
  return v.map((x) => x / n)
}

/** Decodes one YuNet output stride (same maths as OpenCV's FaceDetectorYN). */
export function decodeYuNet(
  cls: Float32Array,
  obj: Float32Array,
  bbox: Float32Array,
  kps: Float32Array,
  stride: number,
  inputSize: number,
  threshold: number
): RawDetection[] {
  const cols = inputSize / stride
  const rows = inputSize / stride
  const out: RawDetection[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      const score = Math.sqrt(clamp01(cls[i]) * clamp01(obj[i]))
      if (score < threshold) continue
      const cx = (c + bbox[i * 4]) * stride
      const cy = (r + bbox[i * 4 + 1]) * stride
      const w = Math.exp(bbox[i * 4 + 2]) * stride
      const h = Math.exp(bbox[i * 4 + 3]) * stride
      const points: number[] = []
      for (let k = 0; k < 5; k++) points.push((kps[i * 10 + 2 * k] + c) * stride, (kps[i * 10 + 2 * k + 1] + r) * stride)
      out.push({ x1: cx - w / 2, y1: cy - h / 2, x2: cx + w / 2, y2: cy + h / 2, score, kps: points })
    }
  }
  return out
}

function iou(a: RawDetection, b: RawDetection): number {
  const ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1))
  const iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1))
  const inter = ix * iy
  const union = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter
  return union > 0 ? inter / union : 0
}

/** Non-maximum suppression: keeps the best of overlapping detections (e.g. the same face seen in two tiles). */
export function nms(dets: RawDetection[], threshold: number): RawDetection[] {
  const sorted = [...dets].sort((a, b) => b.score - a.score)
  const kept: RawDetection[] = []
  for (const d of sorted) if (kept.every((k) => iou(k, d) < threshold)) kept.push(d)
  return kept
}

/** Where the 5 landmarks sit in a standard 112x112 face (the ArcFace template SFace was trained with). */
const TEMPLATE = [38.2946, 51.6963, 73.5318, 51.5014, 56.0252, 71.7366, 41.5493, 92.3655, 70.7299, 92.2041]

/**
 * Least-squares similarity transform (rotation, uniform scale, translation)
 * mapping `src` points onto `dst` points. Returns [a, b, tx, ty] for
 * x' = a*x - b*y + tx, y' = b*x + a*y + ty.
 */
export function similarityTransform(src: number[], dst: number[]): [number, number, number, number] {
  const n = src.length / 2
  let sx = 0,
    sy = 0,
    dx = 0,
    dy = 0
  for (let i = 0; i < n; i++) {
    sx += src[2 * i]
    sy += src[2 * i + 1]
    dx += dst[2 * i]
    dy += dst[2 * i + 1]
  }
  sx /= n
  sy /= n
  dx /= n
  dy /= n
  let num1 = 0,
    num2 = 0,
    den = 0
  for (let i = 0; i < n; i++) {
    const px = src[2 * i] - sx,
      py = src[2 * i + 1] - sy
    const qx = dst[2 * i] - dx,
      qy = dst[2 * i + 1] - dy
    num1 += px * qx + py * qy
    num2 += px * qy - py * qx
    den += px * px + py * py
  }
  const a = num1 / den
  const b = num2 / den
  return [a, b, dx - (a * sx - b * sy), dy - (b * sx + a * sy)]
}

/** Warps the face to the 112x112 template pose with bilinear sampling. Returns RGB bytes. */
export function alignFace(img: Buffer, W: number, H: number, kps: number[]): Buffer {
  const [a, b, tx, ty] = similarityTransform(kps, TEMPLATE)
  // Invert x' = M x + t  =>  x = M^-1 (x' - t), with M = [[a, -b], [b, a]].
  const det = a * a + b * b
  const out = Buffer.alloc(112 * 112 * 3)
  for (let y = 0; y < 112; y++) {
    for (let x = 0; x < 112; x++) {
      const u = x - tx
      const v = y - ty
      const srcX = (a * u + b * v) / det
      const srcY = (-b * u + a * v) / det
      const x0 = Math.floor(srcX),
        y0 = Math.floor(srcY)
      const fx = srcX - x0,
        fy = srcY - y0
      for (let ch = 0; ch < 3; ch++) {
        const p = (xx: number, yy: number) => (xx < 0 || yy < 0 || xx >= W || yy >= H ? 0 : img[(yy * W + xx) * 3 + ch])
        const val = p(x0, y0) * (1 - fx) * (1 - fy) + p(x0 + 1, y0) * fx * (1 - fy) + p(x0, y0 + 1) * (1 - fx) * fy + p(x0 + 1, y0 + 1) * fx * fy
        out[(y * 112 + x) * 3 + ch] = Math.round(val)
      }
    }
  }
  return out
}

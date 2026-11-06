// Downloads the face models (OpenCV Zoo, Apache-2.0/MIT) into resources/models,
// verifying each against a pinned SHA-256. Runs at install time so the app itself
// never needs the network. Re-running skips files that are already correct.
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const DIR = join(import.meta.dirname, '..', 'resources', 'models')
const MODELS = [
  {
    file: 'face_detection_yunet_2023mar.onnx',
    url: 'https://huggingface.co/opencv/face_detection_yunet/resolve/main/face_detection_yunet_2023mar.onnx',
    sha256: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4'
  },
  {
    file: 'face_recognition_sface_2021dec.onnx',
    url: 'https://huggingface.co/opencv/face_recognition_sface/resolve/main/face_recognition_sface_2021dec.onnx',
    sha256: '0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79'
  }
]

const sha = (buf) => createHash('sha256').update(buf).digest('hex')

await mkdir(DIR, { recursive: true })
for (const m of MODELS) {
  const target = join(DIR, m.file)
  try {
    if (sha(await readFile(target)) === m.sha256) continue
  } catch {}
  process.stdout.write(`Downloading ${m.file}… `)
  const res = await fetch(m.url)
  if (!res.ok) throw new Error(`${m.url}: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (sha(buf) !== m.sha256) throw new Error(`${m.file}: checksum mismatch, refusing to use it`)
  await writeFile(target + '.part', buf)
  await rename(target + '.part', target)
  console.log('ok')
}

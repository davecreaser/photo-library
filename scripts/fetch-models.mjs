// Downloads the models into resources/models, verifying each against a pinned SHA-256
// (src/main/modelFiles.json, which the app also checks at runtime):
//  - faces: YuNet + SFace (OpenCV Zoo, Apache-2.0/MIT), 39 MB
//  - content search: SigLIP base patch16-224 at half precision (Apache-2.0, ADR 0008), 407 MB
// Runs at install time so the app itself never needs the network. Re-running skips files
// that are already correct; downloads stream to disk, so a failed one leaves only a .part file.
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import manifest from '../src/main/modelFiles.json' with { type: 'json' }

const DIR = join(import.meta.dirname, '..', 'resources', 'models')

async function sha256(file) {
  const h = createHash('sha256')
  await pipeline(createReadStream(file), h)
  return h.digest('hex')
}

for (const m of [...manifest.faces, ...manifest.content]) {
  const target = join(DIR, m.file)
  try {
    if ((await sha256(target)) === m.sha256) continue
  } catch {}
  await mkdir(dirname(target), { recursive: true })
  process.stdout.write(`Downloading ${m.file}… `)
  const res = await fetch(m.url)
  if (!res.ok || !res.body) throw new Error(`${m.url}: HTTP ${res.status}`)
  const part = target + '.part'
  await pipeline(Readable.fromWeb(res.body), createWriteStream(part))
  if ((await sha256(part)) !== m.sha256) {
    await rm(part, { force: true })
    throw new Error(`${m.file}: checksum mismatch, refusing to use it`)
  }
  await rename(part, target)
  console.log('ok')
}

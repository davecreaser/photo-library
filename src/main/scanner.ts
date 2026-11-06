// Indexes the base folder into the library database. Incremental: files whose
// path, size and modified time are unchanged are not re-read. Everything else is
// fingerprinted (SHA-256) so moved, renamed or copied photos are recognised.
import type { Forgotten, LibraryDb } from './db.ts'
import { readMetadata } from './metadata.ts'
import { hashFile, walkImages, type FoundFile } from './photoFs.ts'
import { IgnoreRules } from './ignore.ts'
import type { ScanProgress } from '../shared/types.ts'

const BATCH_SIZE = 100
// Hashing reads whole files; a few at a time keeps an SSD busy without thrashing a spinning disk.
const PARALLEL_READS = 4

export async function scanLibrary(
  db: LibraryDb,
  basePath: string,
  onProgress: (p: ScanProgress) => void,
  onForgotten?: (forgotten: Forgotten) => void
): Promise<ScanProgress> {
  const scanId = Date.now()
  const progress: ScanProgress = { phase: 'indexing', found: 0, indexed: 0, hashed: 0, added: 0, relocated: 0, updated: 0, missing: 0 }
  let lastEmit = 0
  const emit = (force = false) => {
    const now = Date.now()
    if (force || now - lastEmit > 150) {
      lastEmit = now
      onProgress({ ...progress })
    }
  }

  let batch: FoundFile[] = []
  const flush = async () => {
    const toRead: FoundFile[] = []
    db.transaction(() => {
      for (const f of batch) {
        const fileId = db.isUnchanged(f.path, f.size, f.mtimeMs)
        if (fileId !== null) {
          db.markFileSeen(fileId, scanId)
          progress.indexed++
        } else {
          toRead.push(f)
        }
      }
    })
    batch = []

    for (let i = 0; i < toRead.length; i += PARALLEL_READS) {
      const chunk = toRead.slice(i, i + PARALLEL_READS)
      const results = await Promise.all(
        chunk.map(async (f) => {
          try {
            return { meta: await readMetadata(f), hash: await hashFile(f.path) }
          } catch {
            return null // unreadable right now (e.g. still copying); picked up next scan
          }
        })
      )
      for (const r of results) {
        progress.indexed++
        if (!r) continue
        progress.hashed++
        progress[db.recordFile(r.meta, r.hash, scanId)]++
      }
      progress.current = chunk[chunk.length - 1].path
      emit()
    }
  }

  try {
    const ignore = IgnoreRules.fromSetting(db.getSetting('ignoredFolders'))
    for await (const file of walkImages(basePath, ignore)) {
      progress.found++
      batch.push(file)
      if (batch.length >= BATCH_SIZE) await flush()
      emit()
    }
    await flush()
    db.markMissing(scanId)
    // Photos in ignored folders (e.g. a rule added since the last scan) are forgotten entirely.
    const forgotten = db.forgetFiles((path) => ignore.ignoresFile(basePath, path))
    if (forgotten.hashes.length || forgotten.faceIds.length) onForgotten?.(forgotten)
    db.refreshDerived()
    progress.missing = db.counts().missingCount
    progress.phase = 'done'
    progress.current = undefined
  } catch (e) {
    progress.phase = 'error'
    progress.error = e instanceof Error ? e.message : String(e)
  }
  emit(true)
  return progress
}

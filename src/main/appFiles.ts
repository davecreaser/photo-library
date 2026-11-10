// The ONLY module that writes or deletes files. It only ever touches the
// app's own data folder (thumbnail cache, temp copies), and checks every target
// with assertWritable() on top of the process-wide guard in fsGuard.ts.
// test/safety.test.ts fails if any other source file uses a write/delete API.
import { execFile } from 'node:child_process'
import { chmod, copyFile, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { assertWritable, grantExportRoot, revokeExportRoot } from './fsGuard.ts'

const run = promisify(execFile)

/** Where one export writes (ADR 0010). Created by `openExport`; `close()` revokes the guard's grant. */
export interface ExportSink {
  /** Writes a new file in the export folder; never replaces one. `name` is a plain file name. */
  write(name: string, data: Buffer): Promise<void>
  close(): void
}

/**
 * Creates the export folder `dir` (a new folder the user chose the location of) and lets the guard
 * write only there until `close()`. Throws if the folder is inside a photo folder or the app's data folder.
 */
export async function openExport(dir: string, appDataFolder: string): Promise<ExportSink> {
  grantExportRoot(dir, [appDataFolder])
  try {
    assertWritable(dir, 'create export folder')
    await mkdir(dir)
  } catch (e) {
    revokeExportRoot()
    throw e
  }
  return {
    async write(name, data) {
      if (name !== basename(name) || name === '.' || name === '..') throw new Error(`Not a plain file name: ${name}`)
      const file = join(dir, name)
      assertWritable(file, 'write')
      try {
        await writeFile(file, data, { flag: 'wx' })
      } catch (e) {
        // A half-written copy must not be mistaken for a good one (e.g. disk full). Never remove a file that was already there.
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') await rm(file, { force: true }).catch(() => {})
        throw e
      }
    },
    close: revokeExportRoot
  }
}

export async function ensureAppDir(dir: string): Promise<void> {
  assertWritable(dir, 'create folder')
  await mkdir(dir, { recursive: true })
}

export async function writeAppFile(file: string, data: Buffer): Promise<void> {
  assertWritable(file, 'write')
  await writeFile(file, data)
}

// --- assistant access (spec 0008) ---

const posix = process.platform !== 'win32'

/** Creates an app-owned folder only the owner can open (0700 on macOS/Linux). */
export async function ensurePrivateDir(dir: string): Promise<void> {
  assertWritable(dir, 'create folder')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  if (posix) await chmod(dir, 0o700)
}

/** Writes an app-owned file only the owner can read (0600 on macOS/Linux). */
export async function writePrivateFile(file: string, data: string): Promise<void> {
  assertWritable(file, 'write')
  await writeFile(file, data, { mode: 0o600 })
  if (posix) await chmod(file, 0o600)
}

/** Makes the assistant socket owner-only (0600). No-op on Windows, where it's a named pipe. */
export async function makeSocketPrivate(file: string): Promise<void> {
  if (!posix) return
  assertWritable(file, 'change permissions')
  await chmod(file, 0o600)
}

/**
 * Removes a socket file left behind by a crash: only a socket, only inside a folder called
 * `assistant`. The caller has checked nothing answers on it.
 */
export async function removeStaleSocket(file: string): Promise<void> {
  if (basename(dirname(file)) !== 'assistant') throw new Error(`Not an assistant socket: ${file}`)
  let isSocket: boolean
  try {
    isSocket = (await lstat(file)).isSocket()
  } catch {
    return
  }
  if (!isSocket) throw new Error(`Not a socket: ${file}`)
  assertWritable(file, 'delete')
  await rm(file, { force: true })
}

/** Deletes files in an app-owned folder whose names match. Never recursive, never follows into other folders. */
export async function removeAppFiles(dir: string, match: (name: string) => boolean): Promise<void> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  for (const name of names.filter(match)) {
    const file = join(dir, name)
    assertWritable(file, 'delete')
    await rm(file, { force: true })
  }
}

/**
 * Converts any image macOS understands (HEIC, RAW, …) to a JPEG with the
 * built-in `sips` tool. sips is handed a COPY in the app's temp folder, never
 * the original, so no sips behaviour or argument mistake can touch the photo.
 */
export async function convertWithSips(source: string, workDir: string, maxPx: number): Promise<Buffer | null> {
  if (process.platform !== 'darwin') return null
  const stamp = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const copy = join(workDir, `${stamp}-${basename(source)}`)
  const out = join(workDir, `${stamp}.jpg`)
  await ensureAppDir(workDir)
  assertWritable(copy, 'copy')
  assertWritable(out, 'write')
  try {
    await copyFile(source, copy)
    await run('/usr/bin/sips', ['-s', 'format', 'jpeg', '-Z', String(maxPx), copy, '--out', out])
    return await readFile(out)
  } catch {
    return null
  } finally {
    await rm(copy, { force: true })
    await rm(out, { force: true })
  }
}

// Last line of defence against modifying photos.
//
// Wraps every Node.js filesystem function that can create, change, move or
// delete files, process-wide (our code AND every dependency). A call is refused
// with an exception unless its target is:
//   1. inside one of the allowed roots (the app's data folder, temp), and
//   2. NOT inside any protected root (photo folders the user has ever chosen).
//
// Rule 2 wins over rule 1, so even a photo folder that somehow contained the
// app's data folder could not be written to.
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export class ProtectedPathError extends Error {
  constructor(op: string, target: string, reason: string) {
    super(`Photo Library refused to ${op} "${target}": ${reason}`)
    this.name = 'ProtectedPathError'
  }
}

// Function name -> indexes of the arguments that are written to. Covers both
// `fs.x` / `fs.xSync` (callback and sync) and `fs.promises.x`.
const WRITE_TARGETS: Record<string, number[]> = {
  writeFile: [0], appendFile: [0], truncate: [0],
  unlink: [0], rmdir: [0], rm: [0], mkdir: [0], mkdtemp: [0],
  rename: [0, 1], copyFile: [1], cp: [1], link: [1], symlink: [1],
  utimes: [0], lutimes: [0], chmod: [0], lchmod: [0], chown: [0], lchown: [0],
  createWriteStream: [0]
}

// Any open() that isn't read-only could write or truncate.
const READ_ONLY_FLAGS = new Set(['r', 'rs', 'sr', undefined, fs.constants.O_RDONLY])

const original = new Map<string, (...args: unknown[]) => unknown>()

/** Resolves symlinks via the deepest existing ancestor, so a link can't smuggle a write into a protected folder. */
function realTarget(p: string): string {
  let current = resolve(p)
  const rest: string[] = []
  for (;;) {
    try {
      const real = fs.realpathSync.native(current)
      return rest.length ? resolve(real, ...rest.reverse()) : real
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolve(p)
      rest.push(current.slice(parent.length).replace(/^[/\\]/, ''))
      current = parent
    }
  }
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function toPath(arg: unknown): string | null {
  if (typeof arg === 'string') return arg
  if (Buffer.isBuffer(arg)) return arg.toString()
  if (arg instanceof URL) return fileURLToPath(arg)
  return null // a file descriptor: covered by the open() check
}

export interface GuardConfig {
  /** Folders the app may write in. */
  allowedRoots: () => string[]
  /** Folders that must never be written in, even if inside an allowed root. */
  protectedRoots: () => string[]
}

let config: GuardConfig | null = null

/** Throws unless `target` may be written. Exported so writers outside Node's fs (SQLite, sips) can be checked too. */
export function assertWritable(target: string, op = 'write'): void {
  if (!config) throw new ProtectedPathError(op, target, 'the filesystem guard is not installed')
  const real = realTarget(target)
  for (const root of config.protectedRoots()) {
    if (isInside(realTarget(root), real)) throw new ProtectedPathError(op, target, 'it is inside a photo folder, which is read-only')
  }
  if (!config.allowedRoots().some((root) => isInside(realTarget(root), real))) {
    throw new ProtectedPathError(op, target, "it is outside the app's own data folder")
  }
}

function wrap(holder: Record<string, unknown>, key: string, name: string, indexes: number[] | 'open') {
  const fn = holder[key] as ((...args: unknown[]) => unknown) | undefined
  if (typeof fn !== 'function') return
  const id = `${holder === fs.promises ? 'promises.' : ''}${key}`
  if (!original.has(id)) original.set(id, fn)
  const orig = original.get(id)!
  const isPromiseApi = holder === (fs.promises as unknown)
  holder[key] = function guarded(this: unknown, ...args: unknown[]) {
    try {
      check(args)
    } catch (e) {
      // Fail the same way the real function would: promise APIs reject, callback/sync APIs throw.
      if (isPromiseApi) return Promise.reject(e)
      throw e
    }
    return orig.apply(this, args)
  }
  function check(args: unknown[]) {
    if (indexes === 'open') {
      const flags = args[1]
      if (!READ_ONLY_FLAGS.has(flags as string)) {
        const p = toPath(args[0])
        if (p) assertWritable(p, `open (${String(flags)})`)
      }
    } else {
      for (const i of indexes) {
        const p = toPath(args[i])
        if (p) assertWritable(p, name)
      }
    }
  }
}

export function installFsGuard(cfg: GuardConfig): void {
  config = cfg
  for (const [name, indexes] of Object.entries(WRITE_TARGETS)) {
    wrap(fs as unknown as Record<string, unknown>, name, name, indexes)
    wrap(fs as unknown as Record<string, unknown>, `${name}Sync`, name, indexes)
    wrap(fs.promises as unknown as Record<string, unknown>, name, name, indexes)
  }
  wrap(fs as unknown as Record<string, unknown>, 'open', 'open', 'open')
  wrap(fs as unknown as Record<string, unknown>, 'openSync', 'open', 'open')
  wrap(fs.promises as unknown as Record<string, unknown>, 'open', 'open', 'open')
  // Make `import { rm } from 'node:fs/promises'` style imports see the guarded versions too.
  syncBuiltinESMExports()
}

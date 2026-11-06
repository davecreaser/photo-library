// Proves the app cannot delete, move or modify photos. Two layers are tested:
//  1. Source audit: only appFiles.ts / fsGuard.ts may use any API that writes.
//  2. Runtime guard: every Node fs write/delete path is refused inside a photo folder.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const SRC = join(import.meta.dirname, '..', 'src')
const WRITERS = new Set(['main/appFiles.ts', 'main/fsGuard.ts'])
// fs functions that only read.
const READ_ONLY_FS = new Set(['opendir', 'stat', 'lstat', 'readFile', 'readdir', 'realpath', 'access', 'constants', 'existsSync', 'statSync', 'readFileSync', 'readdirSync', 'createReadStream'])
const FORBIDDEN = [
  /child_process/, // external programs could do anything
  /\btrashItem\b|\bmoveItemToTrash\b/, // Electron's "move to Trash"
  /\.toFile\s*\(/, // sharp writing to disk
  /\bfs\.(promises\.)?\w+/, // namespace use of fs hides which functions are called
  /import\s+(\*\s+as\s+)?\w+\s+from\s+['"](node:)?fs(\/promises)?['"]/ // default/namespace fs imports
]

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name)
    return e.isDirectory() ? sourceFiles(full) : /\.tsx?$/.test(e.name) ? [full] : []
  })
}

test('source audit: only appFiles.ts and fsGuard.ts can write', () => {
  const problems: string[] = []
  for (const file of sourceFiles(SRC)) {
    const rel = relative(SRC, file)
    if (WRITERS.has(rel)) continue
    const code = fs.readFileSync(file, 'utf8')
    for (const pattern of FORBIDDEN) if (pattern.test(code)) problems.push(`${rel}: matches ${pattern}`)
    for (const m of code.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"](?:node:)?fs(?:\/promises)?['"]/g)) {
      for (const name of m[1].split(',').map((n) => n.trim().split(/\s+as\s+/)[0]).filter(Boolean)) {
        if (!READ_ONLY_FS.has(name)) problems.push(`${rel}: imports fs.${name}`)
      }
    }
  }
  assert.deepEqual(problems, [])
})

// --- runtime guard ---

const root = fs.mkdtempSync(join(tmpdir(), 'photo-library-safety-'))
const photos = join(root, 'photos')
const appData = join(root, 'app')
fs.mkdirSync(join(photos, 'trip'), { recursive: true })
fs.mkdirSync(appData)
const photo = join(photos, 'trip', 'IMG_0001.JPG')
fs.writeFileSync(photo, 'original photo bytes')

// A real HEIC in a second protected folder, for the sips test (created before the guard is on).
const heicDir = join(root, 'phone-photos')
const heic = join(heicDir, 'IMG_0002.HEIC')
if (process.platform === 'darwin') {
  fs.mkdirSync(heicDir)
  const sharp = (await import('sharp')).default
  fs.writeFileSync(join(root, 'src.jpg'), await sharp({ create: { width: 40, height: 30, channels: 3, background: '#a33' } }).jpeg().toBuffer())
  execFileSync('/usr/bin/sips', ['-s', 'format', 'heic', join(root, 'src.jpg'), '--out', heic], { stdio: 'ignore' })
}

function snapshot(dir: string): string {
  const h = createHash('sha1')
  for (const e of fs.readdirSync(dir, { recursive: true, withFileTypes: true }).sort((a, b) => (a.parentPath + a.name).localeCompare(b.parentPath + b.name))) {
    const full = join(e.parentPath, e.name)
    const s = fs.lstatSync(full)
    h.update(`${full}:${s.mode}:${s.mtimeMs}:${e.isFile() ? fs.readFileSync(full, 'utf8') : ''}\n`)
  }
  return h.digest('hex')
}

const { installFsGuard, assertWritable, ProtectedPathError } = await import('../src/main/fsGuard.ts')
installFsGuard({ allowedRoots: () => [appData], protectedRoots: () => [photos, heicDir] })
// Imported after installing, like the app does; named ESM imports must be guarded too.
const fsp = await import('node:fs/promises')
const before = snapshot(photos)

const outside = join(appData, 'moved.jpg')
const attacks: [string, () => unknown][] = [
  ['promises.rm', () => fsp.rm(photo)],
  ['promises.rm folder', () => fsp.rm(photos, { recursive: true, force: true })],
  ['promises.unlink', () => fsp.unlink(photo)],
  ['promises.rename out', () => fsp.rename(photo, outside)],
  ['promises.rename within', () => fsp.rename(photo, join(photos, 'renamed.jpg'))],
  ['promises.writeFile', () => fsp.writeFile(photo, 'x')],
  ['promises.appendFile', () => fsp.appendFile(photo, 'x')],
  ['promises.truncate', () => fsp.truncate(photo)],
  ['promises.copyFile onto', () => fsp.copyFile(join(appData, 'nothing'), photo)],
  ['promises.open w', () => fsp.open(photo, 'w')],
  ['promises.open r+', () => fsp.open(photo, 'r+')],
  ['promises.mkdir', () => fsp.mkdir(join(photos, 'new'))],
  ['promises.rmdir', () => fsp.rmdir(join(photos, 'trip'))],
  ['promises.utimes', () => fsp.utimes(photo, 0, 0)],
  ['promises.chmod', () => fsp.chmod(photo, 0o000)],
  ['promises.cp onto', () => fsp.cp(appData, photos, { recursive: true })],
  ['rmSync', () => fs.rmSync(photos, { recursive: true, force: true })],
  ['unlinkSync', () => fs.unlinkSync(photo)],
  ['renameSync', () => fs.renameSync(photo, outside)],
  ['writeFileSync', () => fs.writeFileSync(photo, 'x')],
  ['openSync w', () => fs.openSync(photo, 'w')],
  ['openSync a', () => fs.openSync(photo, 'a')],
  ['createWriteStream', () => fs.createWriteStream(photo)],
  ['callback unlink', () => fs.unlink(photo, () => {})],
  ['callback rm', () => fs.rm(photos, { recursive: true }, () => {})],
  ['write outside app data', () => fs.writeFileSync(join(root, 'stray.txt'), 'x')]
]

for (const [name, attack] of attacks) {
  test(`guard blocks: ${name}`, async () => {
    await assert.rejects(async () => attack(), ProtectedPathError)
  })
}

test('guard blocks writes through a symlink that points into the photo folder', async () => {
  // Creating the link is allowed (it lives in app data); writing through it must not be.
  fs.symlinkSync(photos, join(appData, 'sneaky-link'))
  await assert.rejects(async () => fsp.writeFile(join(appData, 'sneaky-link', 'trip', 'IMG_0001.JPG'), 'x'), ProtectedPathError)
  await assert.rejects(async () => fsp.rm(join(appData, 'sneaky-link', 'trip'), { recursive: true }), ProtectedPathError)
})

test('protected wins even when a photo folder is inside the app data folder', () => {
  assert.doesNotThrow(() => assertWritable(join(appData, 'x')))
  installFsGuard({ allowedRoots: () => [root], protectedRoots: () => [photos, heicDir] })
  assert.doesNotThrow(() => assertWritable(join(root, 'x')))
  assert.throws(() => assertWritable(photo), ProtectedPathError)
  installFsGuard({ allowedRoots: () => [appData], protectedRoots: () => [photos, heicDir] })
})

test('reading photos still works, and app data stays writable', async () => {
  assert.equal(await fsp.readFile(photo, 'utf8'), 'original photo bytes')
  const handle = await fsp.open(photo, 'r')
  await handle.close()
  await fsp.writeFile(join(appData, 'ok.txt'), 'fine')
  await fsp.rm(join(appData, 'ok.txt'))
})

test('sips conversion works on a copy and leaves the original untouched', { skip: process.platform !== 'darwin' }, async () => {
  const hash = () => createHash('sha1').update(fs.readFileSync(heic)).digest('hex')
  const [h0, mtime0] = [hash(), fs.statSync(heic).mtimeMs]
  const { convertWithSips } = await import('../src/main/appFiles.ts')
  const out = await convertWithSips(heic, join(appData, 'tmp'), 100)
  assert.ok(out && out.length > 0, 'converted')
  assert.equal(hash(), h0)
  assert.equal(fs.statSync(heic).mtimeMs, mtime0)
  assert.deepEqual(fs.readdirSync(heicDir), ['IMG_0002.HEIC'], 'nothing added next to the original')
  assert.deepEqual(fs.readdirSync(join(appData, 'tmp')), [], 'temp copies cleaned up')
})

test('after all attacks the photo folder is exactly as it was', () => {
  assert.equal(snapshot(photos), before)
})

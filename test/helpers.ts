// Test helpers that act like the USER (or Finder): moving, copying and creating
// files in photo folders. They run in a separate Node process, outside the
// app's filesystem guard, so tests can arrange files the guard (rightly) forbids
// the app itself to touch. Cross-platform: no /bin tools.
import { execFileSync } from 'node:child_process'

const SCRIPT = `
const fs = require('fs'), path = require('path')
const [op, a, b] = process.argv.slice(1)
if (op === 'mkdir') fs.mkdirSync(a, { recursive: true })
else if (op === 'mv') { fs.mkdirSync(path.dirname(b), { recursive: true }); fs.renameSync(a, b) }
else if (op === 'cp') { fs.mkdirSync(path.dirname(b), { recursive: true }); fs.cpSync(a, b, { recursive: true, preserveTimestamps: true }) }
else if (op === 'write') { fs.mkdirSync(path.dirname(a), { recursive: true }); fs.writeFileSync(a, Buffer.from(b, 'base64')) }
else if (op === 'rm') fs.rmSync(a, { recursive: true, force: true })
else throw new Error('unknown op ' + op)
`

function run(op: string, a: string, b = ''): void {
  execFileSync(process.execPath, ['-e', SCRIPT, op, a, b])
}

export const userFs = {
  mkdir: (dir: string) => run('mkdir', dir),
  /** Move/rename, creating the destination folder if needed. */
  mv: (from: string, to: string) => run('mv', from, to),
  /** Copy a file or folder, keeping timestamps. */
  cp: (from: string, to: string) => run('cp', from, to),
  write: (file: string, data: Buffer) => run('write', file, data.toString('base64')),
  rm: (path: string) => run('rm', path)
}

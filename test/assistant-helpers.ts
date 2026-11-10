// Shared by the assistant access tests (specs 0008 and 0009): a generated library with assistant
// access, and an MCP client over the real local socket. Generated data only.
import { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installFsGuard } from '../src/main/fsGuard.ts'
import { LibraryDb, type FileMeta } from '../src/main/db.ts'
import { PhotoSearch } from '../src/main/photoSearch.ts'
import { BestOfService } from '../src/main/bestOfService.ts'
import { Proposals } from '../src/main/proposals.ts'
import { AssistantTools } from '../src/main/assistantTools.ts'
import { AssistantAccess } from '../src/main/assistantAccess.ts'
import type { AssistantStatus, ContentProgress, ProposalShow } from '../src/shared/types.ts'

installFsGuard({ allowedRoots: () => [tmpdir()], protectedRoots: () => [] })

export const posix = process.platform !== 'win32'
export const RELAY = join(import.meta.dirname, '..', 'src', 'relay', 'relay.ts')
export const cleanups: (() => void)[] = []
after(() => cleanups.forEach((f) => f()))

export const S = {
  base: 'SENTINELBASE',
  folder: 'SENTINELFOLDER',
  file: 'SENTINELFILE',
  camera: 'SENTINELCAMERA',
  hash: 'SENTINELHASH'
}

export interface Lib {
  dir: string
  db: LibraryDb
  access: AssistantAccess
  statuses: AssistantStatus[]
  albumsChanged: number
  progress: ContentProgress
  bestOf: BestOfService
  proposals: Proposals
  /** Proposals handed to the window, in order. */
  shown: ProposalShow[]
  add: (n: number, o?: { folder?: string; first?: string | null; people?: string[] }) => number[]
  close: () => Promise<void>
}

export async function setup(o: { on?: boolean } = { on: true }): Promise<Lib> {
  const dir = mkdtempSync(join(tmpdir(), 'pl-asst-'))
  const db = new LibraryDb(join(dir, 'library.db'))
  const base = `/${S.base}`
  db.setSetting('basePath', base)
  let n = 0
  const lib: Lib = {
    dir,
    db,
    statuses: [],
    albumsChanged: 0,
    progress: { phase: 'idle', done: 0, total: 0, upgrading: false, secondsLeft: null, packaged: false },
    access: null as never,
    bestOf: null as never,
    proposals: null as never,
    shown: [],
    add(count, opt = {}) {
      const ids: number[] = []
      for (let i = 0; i < count; i++) {
        n++
        const first = opt.first === undefined ? '2024-07-01T09:00:00' : opt.first
        const meta: FileMeta = {
          path: `${base}/${opt.folder ?? S.folder}/${S.file}_${n}.jpg`,
          size: 1,
          mtimeMs: 1,
          takenAt: first ? new Date(new Date(first + 'Z').getTime() + i * 86_400_000).toISOString().slice(0, 19) : null,
          width: 4000,
          height: 3000,
          orientation: 1,
          camera: S.camera,
          lat: 59.91,
          lon: 10.75
        }
        db.recordFile(meta, `${S.hash}${n}`, 1)
        const id = db.queryPhotos({ text: `${S.file}_${n}.jpg` }).photos[0].id
        const who = opt.people ?? []
        const faces = db.saveFaces(
          id,
          who.map((_, k) => ({ x: 0.1 * k, y: 0.1, w: 0.1, h: 0.1, score: 0.9, embedding: null })),
          1
        )
        who.forEach((name, k) => db.confirmFaces([faces[k]], db.personNamed(name)))
        ids.push(id)
      }
      return ids
    },
    async close() {
      await lib.access.shutdown()
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
  const search = new PhotoSearch(db, async () => null)
  lib.bestOf = new BestOfService(db, null as never, search)
  lib.proposals = new Proposals((p) => lib.shown.push(p))
  lib.access = new AssistantAccess({
    dataDir: dir,
    db,
    relayPath: RELAY,
    version: '0.0.0-test',
    makeTools: () =>
      new AssistantTools({
        db,
        search: new PhotoSearch(db, async () => null),
        contentProgress: () => lib.progress,
        albumsChanged: () => lib.albumsChanged++,
        bestOf: lib.bestOf,
        proposals: lib.proposals
      }),
    onChange: (s) => lib.statuses.push(s),
    onEnded: () => lib.proposals.expireAll()
  })
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  if (o.on) assert.equal((await lib.access.turnOn()).state, 'on')
  return lib
}

export const token = (lib: Lib) => readFileSync(join(lib.dir, 'assistant', 'token'), 'utf8')

/** A line-based client over the socket: the handshake, then JSON-RPC. Everything received is kept in `raw`. */
export class Client {
  socket: Socket
  raw = ''
  private lines: string[] = []
  private waiters: ((l: string) => void)[] = []
  private nextId = 1
  closed: Promise<void>

  constructor(address: string) {
    this.socket = connect(address)
    this.socket.setEncoding('utf8')
    let buf = ''
    this.socket.on('data', (c: string) => {
      this.raw += c
      buf += c
      let at
      while ((at = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, at)
        buf = buf.slice(at + 1)
        const w = this.waiters.shift()
        if (w) w(line)
        else this.lines.push(line)
      }
    })
    this.socket.on('error', () => {})
    this.closed = new Promise((r) => this.socket.on('close', () => r()))
  }

  next(ms = 3000): Promise<unknown> {
    const l = this.lines.shift()
    if (l !== undefined) return Promise.resolve(JSON.parse(l))
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no answer')), ms)
      this.waiters.push((line) => {
        clearTimeout(t)
        resolve(JSON.parse(line))
      })
    })
  }

  send(m: unknown): void {
    this.socket.write(JSON.stringify(m) + '\n')
  }

  async hello(tok: string): Promise<unknown> {
    this.send({ token: tok })
    return this.next()
  }

  async rpc(method: string, params?: unknown): Promise<{ result?: any; error?: { message: string } }> {
    const id = this.nextId++
    this.send({ jsonrpc: '2.0', id, method, params })
    const m = (await this.next()) as { id: number; result?: unknown; error?: { message: string } }
    assert.equal(m.id, id)
    return m as never
  }

  /** Calls a tool; returns the parsed result, or { error } for a tool error. */
  async tool(name: string, args: Record<string, unknown> = {}): Promise<any> {
    const r = await this.rpc('tools/call', { name, arguments: args })
    if (r.error) throw new Error(r.error.message)
    const text = r.result.content[0].text as string
    return r.result.isError ? { error: text } : JSON.parse(text)
  }

  end(): void {
    this.socket.end()
  }
}

export async function client(lib: Lib): Promise<Client> {
  const c = new Client(lib.access.address)
  assert.deepEqual(await c.hello(token(lib)), { ok: true })
  await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
  c.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  return c
}

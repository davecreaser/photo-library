// Assistant access (spec 0008): the in-app MCP server, driven by an MCP client over a real local
// socket, and the relay, run as the assistant would run it. Generated data only.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, existsSync, readFileSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installFsGuard } from '../src/main/fsGuard.ts'
import { LibraryDb, type FileMeta } from '../src/main/db.ts'
import { PhotoSearch } from '../src/main/photoSearch.ts'
import { AssistantTools, TOOL_DEFINITIONS } from '../src/main/assistantTools.ts'
import { AssistantAccess, REASONS, SETTING, setupSnippets, socketAddress } from '../src/main/assistantAccess.ts'
import { HANDSHAKE_MS, SETUP_OUT_OF_DATE, TURNED_OFF } from '../src/main/assistantServer.ts'
import type { AssistantStatus, ContentProgress } from '../src/shared/types.ts'

installFsGuard({ allowedRoots: () => [tmpdir()], protectedRoots: () => [] })

const posix = process.platform !== 'win32'
const RELAY = join(import.meta.dirname, '..', 'src', 'relay', 'relay.ts')
const cleanups: (() => void)[] = []
after(() => cleanups.forEach((f) => f()))

const S = {
  base: 'SENTINELBASE',
  folder: 'SENTINELFOLDER',
  file: 'SENTINELFILE',
  camera: 'SENTINELCAMERA',
  hash: 'SENTINELHASH'
}

interface Lib {
  dir: string
  db: LibraryDb
  access: AssistantAccess
  statuses: AssistantStatus[]
  albumsChanged: number
  progress: ContentProgress
  add: (n: number, o?: { folder?: string; first?: string | null; people?: string[] }) => number[]
  close: () => Promise<void>
}

async function setup(o: { on?: boolean } = { on: true }): Promise<Lib> {
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
        albumsChanged: () => lib.albumsChanged++
      }),
    onChange: (s) => lib.statuses.push(s)
  })
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  if (o.on) assert.equal((await lib.access.turnOn()).state, 'on')
  return lib
}

const token = (lib: Lib) => readFileSync(join(lib.dir, 'assistant', 'token'), 'utf8')

/** A line-based client over the socket: the handshake, then JSON-RPC. Everything received is kept in `raw`. */
class Client {
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

async function client(lib: Lib): Promise<Client> {
  const c = new Client(lib.access.address)
  assert.deepEqual(await c.hello(token(lib)), { ok: true })
  await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
  c.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  return c
}

// --- AC-1, AC-4, AC-5, AC-6: the switch, the socket and the token ---

test('AC-1: off by default; on starts the server within 1 s and is remembered; off removes the socket', async () => {
  const lib = await setup({ on: false })
  assert.equal(lib.access.status().state, 'off')
  assert.equal(lib.db.getSetting(SETTING), null)
  if (posix) assert.equal(existsSync(lib.access.address), false, 'no socket while off')
  await lib.access.resume()
  assert.equal(lib.access.status().state, 'off', 'resume does nothing while the setting is off')
  const t = Date.now()
  assert.equal((await lib.access.turnOn()).state, 'on')
  assert.ok(Date.now() - t < 1000)
  assert.equal(lib.db.getSetting(SETTING), 'on')
  assert.deepEqual(
    lib.statuses.map((s) => s.state),
    ['starting', 'on']
  )
  await lib.access.turnOff()
  assert.equal(lib.db.getSetting(SETTING), 'off')
  if (posix) assert.equal(existsSync(lib.access.address), false)
  await lib.close()
})

test('AC-4, AC-5: owner-only folder, socket and token file (macOS/Linux); a 32-byte token', { skip: !posix }, async () => {
  const lib = await setup()
  const mode = (p: string) => statSync(p).mode & 0o777
  assert.equal(mode(join(lib.dir, 'assistant')), 0o700)
  assert.equal(mode(lib.access.address), 0o600)
  assert.equal(mode(join(lib.dir, 'assistant', 'token')), 0o600)
  assert.ok(statSync(lib.access.address).isSocket())
  assert.match(token(lib), /^[0-9a-f]{64}$/)
  assert.equal(lib.access.address, join(lib.dir, 'assistant', 'assistant.sock'))
  await lib.close()
})

test('AC-4: the address is a socket path, or a pipe name on Windows; never a port', () => {
  const win = socketAddress('C:\\Users\\Me\\AppData\\Roaming\\photo-library', 'win32')
  assert.match(win, /^\\\\\.\\pipe\\photo-library-[0-9a-f]{16}$/)
  assert.equal(win, socketAddress('c:\\users\\me\\appdata\\roaming\\photo-library', 'win32'), 'one pipe per data folder')
  assert.notEqual(win, socketAddress('C:\\Other', 'win32'))
  assert.equal(socketAddress('/data/pl', 'linux'), join('/data/pl', 'assistant', 'assistant.sock'))
})

test('AC-5: a wrong, missing or late token is refused with the out-of-date error, and no tool runs', async () => {
  const lib = await setup()
  lib.add(2)
  for (const first of [{ token: 'nope' }, { token: token(lib) + 'x' }, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, 'not json']) {
    const c = new Client(lib.access.address)
    c.socket.write((typeof first === 'string' ? first : JSON.stringify(first)) + '\n')
    assert.deepEqual(await c.next(), { error: SETUP_OUT_OF_DATE })
    c.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'create_album', arguments: { name: 'Sneaky' } } })
    await c.closed
    assert.doesNotMatch(c.raw, /Sneaky|result/)
  }
  // Another library's token doesn't open this one.
  const other = await setup()
  const c = new Client(lib.access.address)
  assert.deepEqual(await c.hello(token(other)), { error: SETUP_OUT_OF_DATE })
  await c.closed
  assert.equal(lib.db.albumNamed('Sneaky'), null)
  await other.close()
  await lib.close()
})

test('AC-5: a connection that says nothing is closed after 5 seconds', async () => {
  const lib = await setup()
  const c = new Client(lib.access.address)
  const t = Date.now()
  assert.deepEqual(await c.next(HANDSHAKE_MS + 2000), { error: SETUP_OUT_OF_DATE })
  await c.closed
  assert.ok(Date.now() - t >= HANDSHAKE_MS - 100)
  await lib.close()
})

test('AC-6: a stale socket file is replaced; a live one (another window) is left alone and reported', { skip: !posix }, async () => {
  const a = await setup()
  // A second app on the same data folder finds the first one answering.
  const b = new AssistantAccess({
    dataDir: a.dir,
    db: a.db,
    relayPath: RELAY,
    version: 't',
    makeTools: () => null as never,
    onChange: () => {}
  })
  const s = await b.turnOn()
  assert.equal(s.state, 'failed')
  assert.equal(s.reason, REASONS.inUse)
  assert.equal(a.db.getSetting(SETTING), 'off', 'a failed start saves the setting as off')
  assert.ok(existsSync(a.access.address), "the other window's socket is untouched")
  const c = await client(a)
  assert.equal((await c.tool('library_overview')).photos, 0, 'and it still works')
  c.end()
  // A crash leaves the file behind with nothing answering: the next start replaces it.
  await a.access.shutdown()
  const crashed = spawn(process.execPath, ['-e', `require('node:net').createServer().listen(${JSON.stringify(a.access.address)}, () => console.log('up'))`])
  await new Promise((r) => crashed.stdout!.once('data', r))
  crashed.kill('SIGKILL') // dies without removing its socket file
  await new Promise((r) => crashed.once('exit', r))
  assert.ok(existsSync(a.access.address))
  assert.equal((await a.access.turnOn()).state, 'on')
  const c2 = await client(a)
  assert.equal((await c2.tool('library_overview')).photos, 0)
  c2.end()
  await a.close()
  assert.equal(existsSync(join(a.dir, 'assistant', 'assistant.sock')), false, 'quitting removes the socket')
})

test('AC-6: a data folder path too long for a socket fails with a reason and leaves the switch off', { skip: !posix }, async () => {
  const deep = join(mkdtempSync(join(tmpdir(), 'pl-asst-long-')), 'x'.repeat(120))
  cleanups.push(() => rmSync(deep, { recursive: true, force: true }))
  const { mkdirSync } = await import('node:fs')
  mkdirSync(deep, { recursive: true })
  const db = new LibraryDb(join(deep, 'library.db'))
  const access = new AssistantAccess({ dataDir: deep, db, relayPath: RELAY, version: 't', makeTools: () => null as never, onChange: () => {} })
  const s = await access.turnOn()
  assert.equal(s.state, 'failed')
  assert.equal(s.reason, REASONS.tooLong)
  assert.equal(db.getSetting(SETTING), 'off')
  db.close()
})

// --- AC-7: off and forget ---

test('AC-7: turning off closes connections within 1 s, answers calls in flight, and removes the socket', async () => {
  const lib = await setup()
  // A search waits on the content model; turning off meanwhile answers it.
  let release!: () => void
  const slow = new Promise<null>((r) => (release = () => r(null)))
  ;(lib.access as unknown as { o: { makeTools: () => AssistantTools } }).o.makeTools = () =>
    new AssistantTools({ db: lib.db, search: new PhotoSearch(lib.db, () => slow), contentProgress: () => lib.progress, albumsChanged: () => {} })
  await lib.access.turnOff()
  await lib.access.turnOn() // the server takes the tools maker when it starts
  const c2 = await client(lib)
  c2.send({ jsonrpc: '2.0', id: 77, method: 'tools/call', params: { name: 'search_photos', arguments: { text: 'beach' } } })
  await new Promise((r) => setTimeout(r, 50))
  const t = Date.now()
  await lib.access.turnOff()
  assert.ok(Date.now() - t < 1000)
  const m = (await c2.next()) as { id: number; error: { message: string } }
  assert.equal(m.id, 77)
  assert.equal(m.error.message, TURNED_OFF)
  await c2.closed
  release()
  if (posix) assert.equal(existsSync(lib.access.address), false)
  await lib.close()
})

test('AC-7: forgetting assistants replaces the token and drops connections; the new setup works', async () => {
  const lib = await setup()
  const old = token(lib)
  const c = await client(lib)
  const before = lib.access.status().desktopJson!
  await lib.access.forget()
  await c.closed
  assert.notEqual(token(lib), old)
  assert.notEqual(lib.access.status().desktopJson, before)
  assert.ok(lib.access.status().desktopJson!.includes(token(lib)))
  const stale = new Client(lib.access.address)
  assert.deepEqual(await stale.hello(old), { error: SETUP_OUT_OF_DATE })
  const fresh = await client(lib)
  assert.equal((await fresh.tool('library_overview')).photos, 0)
  fresh.end()
  // Turning off and on again keeps the token, so assistants already set up work again.
  const kept = token(lib)
  await lib.access.turnOff()
  await lib.access.turnOn()
  assert.equal(token(lib), kept)
  await lib.close()
})

// --- AC-2: setup snippets ---

test('AC-2: the Claude Desktop JSON and the Claude Code command carry the relay, socket and token, quoted for the platform', () => {
  const mac = setupSnippets(
    "/Users/o'neil/photo-library/out/main/relay.js",
    '/Users/x/Library/Application Support/photo-library/assistant/assistant.sock',
    'ab12',
    'darwin'
  )
  assert.deepEqual(JSON.parse(mac.desktopJson), {
    mcpServers: {
      'photo-library': {
        command: 'node',
        args: ["/Users/o'neil/photo-library/out/main/relay.js"],
        env: { PHOTO_LIBRARY_SOCKET: '/Users/x/Library/Application Support/photo-library/assistant/assistant.sock', PHOTO_LIBRARY_TOKEN: 'ab12' }
      }
    }
  })
  assert.equal(
    mac.claudeCommand,
    "claude mcp add --scope user photo-library --env 'PHOTO_LIBRARY_SOCKET=/Users/x/Library/Application Support/photo-library/assistant/assistant.sock' --env 'PHOTO_LIBRARY_TOKEN=ab12' -- node '/Users/o'\\''neil/photo-library/out/main/relay.js'"
  )
  const win = setupSnippets('C:\\Users\\Me\\photo-library\\out\\main\\relay.js', '\\\\.\\pipe\\photo-library-0123456789abcdef', 'ab12', 'win32')
  assert.ok(win.desktopJson.includes('"C:\\\\Users\\\\Me\\\\photo-library\\\\out\\\\main\\\\relay.js"'), 'backslashes escaped in JSON')
  assert.equal(JSON.parse(win.desktopJson).mcpServers['photo-library'].env.PHOTO_LIBRARY_SOCKET, '\\\\.\\pipe\\photo-library-0123456789abcdef')
  assert.equal(
    win.claudeCommand,
    'claude mcp add --scope user photo-library --env "PHOTO_LIBRARY_SOCKET=\\\\.\\pipe\\photo-library-0123456789abcdef" --env "PHOTO_LIBRARY_TOKEN=ab12" -- node "C:\\Users\\Me\\photo-library\\out\\main\\relay.js"'
  )
})

// --- AC-3: the relay ---

/** Runs the relay as an assistant would, with the env from the Claude Desktop snippet. */
function relay(env: Record<string, string>): { proc: ChildProcess; rpc: (m: Record<string, unknown>) => Promise<any>; out: () => string } {
  const proc = spawn(process.execPath, [RELAY], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  const waiting = new Map<unknown, (m: unknown) => void>()
  let buf = ''
  proc.stdout!.setEncoding('utf8').on('data', (c: string) => {
    out += c
    buf += c
    let at
    while ((at = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, at))
      buf = buf.slice(at + 1)
      waiting.get(m.id)?.(m)
    }
  })
  proc.stderr!.setEncoding('utf8').on('data', (c: string) => (err += c))
  cleanups.push(() => proc.kill())
  return {
    proc,
    out: () => out + err,
    rpc: (m) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`no answer to ${m.method}`)), 4000)
        waiting.set(m.id, (r) => {
          clearTimeout(t)
          resolve(r)
        })
        proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
      })
  }
}

const envOf = (lib: Lib) => JSON.parse(lib.access.status().desktopJson!).mcpServers['photo-library'].env as Record<string, string>
const INIT = { method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'relay-test', version: '1' } } }

test('AC-3: through the relay, an assistant initialises, lists tools and calls one', async () => {
  const lib = await setup()
  lib.add(3)
  const r = relay(envOf(lib))
  const init = await r.rpc({ id: 1, ...INIT })
  assert.equal(init.result.serverInfo.name, 'photo-library')
  assert.equal(init.result.protocolVersion, '2025-06-18')
  const tools = await r.rpc({ id: 2, method: 'tools/list' })
  assert.equal(tools.result.tools.length, 5)
  const o = await r.rpc({ id: 3, method: 'tools/call', params: { name: 'library_overview', arguments: {} } })
  assert.equal(JSON.parse(o.result.content[0].text).photos, 3)
  assert.ok(!r.out().includes(envOf(lib).PHOTO_LIBRARY_TOKEN), 'the token is never echoed')
  const exited = new Promise((res) => r.proc.on('exit', res))
  r.proc.stdin!.end()
  assert.equal(await exited, 0, 'closing stdin ends the relay')
  await lib.close()
})

test('AC-3: when the app is unreachable the relay answers within 2 s, stays up, and reconnects later', async () => {
  const lib = await setup({ on: false })
  // Set up once to get the address and token, then turn it off.
  await lib.access.turnOn()
  const env = envOf(lib)
  await lib.access.turnOff()
  const r = relay(env)
  const t = Date.now()
  const init = await r.rpc({ id: 1, ...INIT })
  assert.ok(Date.now() - t < 2000)
  assert.match(init.error.message, /Open Photo Library and turn on assistant access/)
  const again = await r.rpc({ id: 2, method: 'tools/list' })
  assert.match(again.error.message, /Open Photo Library and turn on assistant access/)
  // The owner turns access on: the next request works without restarting the assistant.
  await lib.access.turnOn()
  lib.add(1)
  const o = await r.rpc({ id: 3, method: 'tools/call', params: { name: 'library_overview', arguments: {} } })
  assert.equal(JSON.parse(o.result.content[0].text).photos, 1)
  // Off again mid-session, then on: the relay carries on (the initialize is replayed for the new session).
  await lib.access.turnOff()
  const off = await r.rpc({ id: 4, method: 'tools/list' })
  assert.ok(off.error)
  await lib.access.turnOn()
  const back = await r.rpc({ id: 5, method: 'tools/list' })
  assert.equal(back.result.tools.length, 5)
  r.proc.kill()
  await lib.close()
})

test('AC-3, AC-5: a relay with an out-of-date token reports it', async () => {
  const lib = await setup()
  const env = envOf(lib)
  await lib.access.forget()
  const r = relay(env)
  const init = await r.rpc({ id: 1, ...INIT })
  assert.equal(init.error.message, SETUP_OUT_OF_DATE)
  r.proc.kill()
  await lib.close()
})

// --- AC-8: the tools ---

test('AC-8: exactly five tools, each described for a model with an example; unknown tools and methods get plain errors', async () => {
  const lib = await setup()
  const c = await client(lib)
  const { result } = await c.rpc('tools/list')
  assert.deepEqual(
    result.tools.map((t: { name: string }) => t.name),
    ['library_overview', 'search_photos', 'create_album', 'add_to_album', 'remove_from_album']
  )
  for (const t of result.tools) {
    assert.match(t.description, /Example: \w+\(/, t.name)
    assert.equal(t.inputSchema.type, 'object')
  }
  assert.match((await c.tool('delete_album', { album_id: 1 })).error, /There is no tool called "delete_album"/)
  assert.match((await c.tool('library_overview', { path: '/x' })).error, /Unknown input "path"/)
  assert.equal((await c.rpc('resources/list')).error!.message, 'Method not found: resources/list')
  assert.deepEqual((await c.rpc('ping')).result, {})
  // Not a JSON-RPC object: answered, not dropped (and the app doesn't crash).
  for (const line of ['null', '[]', '[{"jsonrpc":"2.0","id":9,"method":"ping"}]', '42']) {
    c.socket.write(line + '\n')
    assert.deepEqual(await c.next(), {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Invalid request: each line must be one JSON-RPC object (no batches)' }
    })
  }
  assert.deepEqual((await c.rpc('ping')).result, {}, 'still connected')
  c.end()
  await lib.close()
})

// --- AC-9: overview ---

test('AC-9: library_overview gives counts, years, albums with spans, people and analysis progress', async () => {
  const lib = await setup()
  const empty = await client(lib)
  const none = await empty.tool('library_overview')
  assert.equal(none.photos, 0)
  assert.equal(none.note, 'No photos yet: choose a photo folder in Photo Library')
  empty.end()

  const trip = lib.add(4, { first: '2023-05-01T10:00:00', people: ['Jake'] })
  lib.add(2, { first: '2024-07-01T10:00:00', people: ['Anna'] })
  lib.add(1, { first: null })
  const album = lib.db.createAlbum('Norway', null)
  lib.db.addToAlbum(album.id, trip)
  const sub = lib.db.createAlbum('Day one', album.id)
  lib.db.addToAlbum(sub.id, [trip[0]])
  lib.progress = { ...lib.progress, phase: 'analysing', done: 3, total: 7 }
  const c = await client(lib)
  const o = await c.tool('library_overview')
  assert.equal(o.photos, 7)
  assert.equal(o.undated, 1)
  assert.equal(o.note, undefined)
  assert.deepEqual(o.per_year, [
    { year: '2023', photos: 4 },
    { year: '2024', photos: 2 }
  ])
  assert.deepEqual(o.albums, [
    { id: sub.id, name: 'Day one', parent_id: album.id, photos: 1, first: '2023-05-01', last: '2023-05-01' },
    { id: album.id, name: 'Norway', photos: 4, first: '2023-05-01', last: '2023-05-04' }
  ])
  assert.deepEqual(o.people, [
    { name: 'Jake', photos: 4 },
    { name: 'Anna', photos: 2 }
  ])
  assert.equal(o.content_analysis, 'analysed 3 of 7')
  assert.deepEqual(Object.keys(o).sort(), ['albums', 'content_analysis', 'people', 'per_year', 'photos', 'undated'])
  c.end()
  await lib.close()
})

// --- AC-10, AC-11: search ---

test('AC-10: search_photos returns the total first, then a page in the same order as the app search, with people, albums, stars and why', async () => {
  const lib = await setup()
  const jake = lib.add(3, { first: '2024-07-01T10:00:00', people: ['Jake'] })
  const both = lib.add(2, { first: '2024-08-01T10:00:00', people: ['Jake', 'Anna'] })
  lib.add(2, { first: '2023-01-01T10:00:00', folder: 'beach' })
  const album = lib.db.createAlbum('Summer', null)
  lib.db.addToAlbum(album.id, [jake[0], both[0]])
  lib.db.setFavorite([both[1]], true)
  const c = await client(lib)

  const all = await c.tool('search_photos', {})
  assert.equal(all.total, 7)
  const appOrder = (await new PhotoSearch(lib.db, async () => null).query({ limit: 50 })).photos.map((p) => p.id)
  assert.deepEqual(
    all.photos.map((p: { id: number }) => p.id),
    appOrder
  )
  assert.ok(all.photos.every((p: { match: string }) => p.match === 'filter'))
  const first = all.photos[0]
  assert.deepEqual(Object.keys(first).sort(), ['albums', 'favorite', 'id', 'match', 'people', 'taken'])
  assert.equal(first.id, both[1])
  assert.equal(first.taken, '2024-08-02 10:00')
  assert.deepEqual(first.people, ['Anna', 'Jake'])
  assert.equal(first.favorite, true)

  const both2 = await c.tool('search_photos', { people: ['jake', 'Anna'] })
  assert.deepEqual(both2.photos.map((p: { id: number }) => p.id).sort(), [...both].sort(), 'all of the people, any case')
  const july = await c.tool('search_photos', { from: '2024-07-01', to: '2024-07-02' })
  assert.deepEqual(july.photos.map((p: { id: number }) => p.id).sort(), jake.slice(0, 2).sort(), 'inclusive dates')
  const inAlbum = await c.tool('search_photos', { album_id: album.id })
  assert.equal(inAlbum.total, 2)
  assert.deepEqual(inAlbum.photos[0].albums, [{ id: album.id, name: 'Summer' }])

  const text = await c.tool('search_photos', { text: 'beach' })
  assert.equal(text.total, 2)
  assert.ok(text.photos.every((p: { match: string }) => p.match === 'name'))
  const appText = await new PhotoSearch(lib.db, async () => null).query({ text: 'beach', limit: 50 })
  assert.deepEqual(
    text.photos.map((p: { id: number }) => p.id),
    appText.photos.map((p) => p.id)
  )
  assert.deepEqual(await c.tool('search_photos', { text: 'nothing like this' }), { total: 0, offset: 0, photos: [] })

  // Paging: stable, and a second assistant's search doesn't disturb the first's.
  const p1 = await c.tool('search_photos', { limit: 3 })
  const other = await client(lib)
  await other.tool('search_photos', { text: 'jake', limit: 1 })
  const p2 = await c.tool('search_photos', { limit: 3, offset: 3 })
  const p3 = await c.tool('search_photos', { limit: 3, offset: 6 })
  assert.deepEqual(
    [...p1.photos, ...p2.photos, ...p3.photos].map((p: { id: number }) => p.id),
    appOrder
  )
  c.end()
  other.end()
  await lib.close()
})

test('AC-11: bad input names the field; unknown people are listed; partial or unavailable content search is noted', async () => {
  const lib = await setup()
  lib.add(2, { people: ['Jake', 'Anna'] })
  const c = await client(lib)
  const err = async (args: Record<string, unknown>) => (await c.tool('search_photos', args)).error as string
  assert.match(await err({ from: '2024-13-01' }), /^from must be a date written YYYY-MM-DD/)
  assert.match(await err({ to: 'yesterday' }), /^to must be a date/)
  assert.match(await err({ from: '2024-08-01', to: '2024-07-01' }), /from \(2024-08-01\) is after to \(2024-07-01\)/)
  assert.equal(await err({ people: ['Jak'] }), 'No person named "Jak". Named people: Anna, Jake.')
  assert.match(await err({ album_id: 999 }), /There is no album with id 999/)
  assert.match(await err({ limit: 0 }), /^limit must be a whole number from 1 to 200/)
  assert.match(await err({ limit: 201 }), /^limit must be a whole number from 1 to 200/)
  assert.equal((await c.tool('search_photos', {})).total, 2, 'no input: everything')

  lib.progress = { ...lib.progress, phase: 'analysing', done: 1, total: 2 }
  assert.equal((await c.tool('search_photos', { text: 'beach' })).note, 'content search covers 1 of 2 photos so far')
  assert.equal((await c.tool('search_photos', { text: 'Jake' })).note, undefined, 'no note without a content phrase')
  lib.progress = { ...lib.progress, phase: 'unavailable', done: 0, total: 2 }
  assert.equal((await c.tool('search_photos', { text: 'beach' })).note, 'content search is unavailable; only name matches are listed')
  c.end()
  await lib.close()
})

// --- AC-12, AC-13: albums ---

test('AC-12: create_album makes a top-level marked album, refuses duplicates, and reports unknown photos', async () => {
  const lib = await setup()
  const ids = lib.add(3)
  lib.db.createAlbum('Norway', null)
  const c = await client(lib)
  const made = await c.tool('create_album', { name: '  Beach days  ', photo_ids: [ids[0], ids[1], ids[1], 9999] })
  assert.deepEqual(made, { album_id: made.album_id, name: 'Beach days', added: 2, not_found: [9999] })
  const listed = lib.db.listAlbums().find((a) => a.id === made.album_id)!
  assert.equal(listed.madeByAssistant, true)
  assert.equal(listed.parentId, null)
  assert.equal(listed.photoCount, 2)
  assert.equal(lib.albumsChanged, 1, 'the window is told')
  assert.match((await c.tool('create_album', { name: 'beach DAYS' })).error, new RegExp(`already exists \\(id ${made.album_id}\\)`))
  assert.match((await c.tool('create_album', { name: 'norway' })).error, /An album called "Norway" already exists/)
  assert.match((await c.tool('create_album', { name: '   ' })).error, /^name must be 1-100 characters/)
  assert.match((await c.tool('create_album', { name: 'x'.repeat(101) })).error, /^name must be 1-100 characters/)
  assert.match((await c.tool('create_album', { name: 'Big', photo_ids: Array.from({ length: 1001 }, (_, i) => i + 1) })).error, /at most 1000 ids/)
  assert.equal(lib.db.listAlbums().length, 2)
  c.end()
  await lib.close()
})

test('AC-12: add and remove work only on assistant albums, report what changed, and repeat safely', async () => {
  const lib = await setup()
  const ids = lib.add(4)
  const owners = lib.db.createAlbum('Mine', null)
  const c = await client(lib)
  const { album_id } = await c.tool('create_album', { name: 'Picks', photo_ids: [ids[0]] })
  assert.deepEqual(await c.tool('add_to_album', { album_id, photo_ids: [ids[0], ids[1], ids[2], 4242] }), {
    album_id,
    name: 'Picks',
    added: 2,
    already_there: [ids[0]],
    not_found: [4242]
  })
  assert.deepEqual(await c.tool('add_to_album', { album_id, photo_ids: [ids[1], ids[2]] }), {
    album_id,
    name: 'Picks',
    added: 0,
    already_there: [ids[1], ids[2]],
    not_found: []
  })
  assert.deepEqual(await c.tool('remove_from_album', { album_id, photo_ids: [ids[1], ids[3], 4242] }), {
    album_id,
    name: 'Picks',
    removed: 1,
    not_there: [ids[3]],
    not_found: [4242]
  })
  assert.equal(lib.db.listAlbums().find((a) => a.id === album_id)!.photoCount, 2)
  for (const tool of ['add_to_album', 'remove_from_album'])
    assert.equal((await c.tool(tool, { album_id: owners.id, photo_ids: [ids[0]] })).error, "That album is the owner's; you can only change albums you made")
  assert.equal(lib.db.listAlbums().find((a) => a.id === owners.id)!.photoCount, 0)
  assert.match((await c.tool('add_to_album', { album_id: 777, photo_ids: [ids[0]] })).error, /There is no album with id 777/)
  assert.match((await c.tool('add_to_album', { album_id })).error, /photo_ids is required/)
  c.end()
  await lib.close()
})

test('AC-13: the owner renaming, moving, or adding or removing photos makes an assistant album theirs', async () => {
  const lib = await setup()
  const ids = lib.add(2)
  const c = await client(lib)
  const parent = lib.db.createAlbum('Trips', null)
  for (const ownerChange of [
    (id: number) => lib.db.renameAlbum(id, `Renamed ${id}`),
    (id: number) => lib.db.moveAlbum(id, parent.id),
    (id: number) => lib.db.addToAlbum(id, [ids[1]]),
    (id: number) => lib.db.removeFromAlbum(id, [ids[0]])
  ]) {
    const { album_id } = await c.tool('create_album', { name: `A${Math.random()}`, photo_ids: [ids[0]] })
    assert.equal(lib.db.albumInfo(album_id)!.madeByAssistant, true)
    ownerChange(album_id)
    assert.equal(lib.db.albumInfo(album_id)!.madeByAssistant, false)
    assert.match((await c.tool('add_to_album', { album_id, photo_ids: [ids[1]] })).error, /owner's/)
  }
  // An owner action that changes nothing (same name, same place, photos already in or not in it) leaves it the assistant's.
  {
    const { album_id } = await c.tool('create_album', { name: 'Untouched', photo_ids: [ids[0]] })
    lib.db.renameAlbum(album_id, 'Untouched')
    lib.db.moveAlbum(album_id, null)
    lib.db.addToAlbum(album_id, [ids[0]])
    lib.db.removeFromAlbum(album_id, [ids[1]])
    assert.equal(lib.db.albumInfo(album_id)!.madeByAssistant, true)
  }
  // Deleting an assistant album undoes it; the photos stay.
  const { album_id } = await c.tool('create_album', { name: 'Gone', photo_ids: ids })
  lib.db.deleteAlbum(album_id)
  assert.equal(lib.db.albumInfo(album_id), null)
  assert.equal(lib.db.counts().photoCount, 2)
  c.end()
  await lib.close()
})

test('AC-13: a library from the previous version keeps albums, tags, names and settings, and gets the marker column', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pl-asst-mig-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'library.db')
  let db = new LibraryDb(file)
  db.setSetting('basePath', '/p')
  db.recordFile(
    { path: '/p/a/x.jpg', size: 1, mtimeMs: 1, takenAt: null, width: null, height: null, orientation: null, camera: null, lat: null, lon: null },
    'h',
    1
  )
  const id = db.queryPhotos({}).photos[0].id
  const album = db.createAlbum('Kept', null)
  db.addToAlbum(album.id, [id])
  db.addTag([id], 'sky')
  const [face] = db.saveFaces(id, [{ x: 0, y: 0, w: 0.1, h: 0.1, score: 0.9, embedding: null }], 1)
  db.confirmFaces([face], db.personNamed('Jake'))
  db.setSetting('ignoredFolders', JSON.stringify(['private', 'tmp']))
  db.close()
  const raw = new DatabaseSync(file)
  raw.exec('ALTER TABLE albums DROP COLUMN made_by; PRAGMA user_version = 7;')
  raw.close()
  db = new LibraryDb(file)
  assert.deepEqual(
    db.listAlbums().map((a) => [a.name, a.photoCount, a.madeByAssistant]),
    [['Kept', 1, false]]
  )
  assert.deepEqual(
    db.listTags().map((t) => t.name),
    ['sky']
  )
  assert.deepEqual(
    db.listPeople().map((p) => p.name),
    ['Jake']
  )
  assert.equal(db.getSetting('ignoredFolders'), JSON.stringify(['private', 'tmp']))
  assert.equal(db.getSetting(SETTING), null, 'assistant access is off after upgrading')
  const made = db.createAssistantAlbum('New', [id])
  assert.equal(db.albumInfo(made)!.madeByAssistant, true)
  db.close()
})

// --- AC-14: privacy ---

test('AC-14: no path, folder or file name, hash, place or camera in anything the server sends', async () => {
  const lib = await setup()
  const ids = lib.add(5, { people: ['Jake'] })
  const c = await client(lib)
  const calls: [string, Record<string, unknown>][] = [
    ['library_overview', {}],
    ['search_photos', {}],
    ['search_photos', { text: S.folder }],
    ['search_photos', { text: S.file }],
    ['search_photos', { text: 'Jake 2024', limit: 200 }],
    ['search_photos', { from: 'bad' }],
    ['search_photos', { people: ['Nobody'] }],
    ['create_album', { name: 'Picks', photo_ids: ids }],
    ['create_album', { name: 'Picks' }],
    ['add_to_album', { album_id: 999, photo_ids: [1] }],
    ['remove_from_album', { album_id: 999, photo_ids: [1] }],
    ['no_such_tool', {}]
  ]
  for (const [name, args] of calls) await c.tool(name, args)
  const folderMatch = await c.tool('search_photos', { text: S.folder })
  assert.equal(folderMatch.total, 5, 'folder names still find photos')
  assert.ok(
    folderMatch.photos.every((p: { match: string }) => p.match === 'name'),
    '...reported only as a name match'
  )
  await c.rpc('tools/list')
  c.end()
  await c.closed
  const leaks = [...Object.values(S), '59.91', '10.75', '.jpg', lib.dir].filter((s) => c.raw.includes(s))
  assert.deepEqual(leaks, [])
  for (const t of TOOL_DEFINITIONS) assert.ok(!JSON.stringify(t.inputSchema).includes('path'), `${t.name} accepts no path`)
  await lib.close()
})

// --- AC-15: scale ---

test('AC-15: 100,000 photos, 500 albums, 200 people: overview under 1 s and 64 KB, a page of 200 under 2 s and 40 KB', async () => {
  const lib = await setup()
  const db = lib.db
  db.transaction(() => {
    for (let i = 0; i < 100_000; i++) {
      db.recordFile(
        {
          path: `/x/f${i % 300}/p${i}.jpg`,
          size: 1,
          mtimeMs: 1,
          takenAt: new Date(Date.UTC(2005, 0, 1) + i * 3_600_000).toISOString().slice(0, 19),
          width: null,
          height: null,
          orientation: null,
          camera: null,
          lat: null,
          lon: null
        },
        `h${i}`,
        1
      )
    }
  })
  const ids = db.queryPhotos({ limit: 100_000 }).photos.map((p) => p.id)
  db.transaction(() => {
    for (let a = 0; a < 500; a++) db.addToAlbum(db.createAlbum(`Album ${a}`, null).id, ids.slice(a * 150, a * 150 + 150))
    for (let p = 0; p < 200; p++) {
      const faces = ids.slice(p * 40, p * 40 + 40).map((id) => db.saveFaces(id, [{ x: 0, y: 0, w: 0.1, h: 0.1, score: 0.9, embedding: null }], 1)[0])
      db.confirmFaces(faces, db.personNamed(`Person ${p}`))
    }
  })
  const c = await client(lib)
  let t = Date.now()
  const r = await c.rpc('tools/call', { name: 'library_overview', arguments: {} })
  assert.ok(Date.now() - t < 1000, `overview took ${Date.now() - t} ms`)
  const bytes = (m: unknown) => Buffer.byteLength(JSON.stringify(m))
  assert.ok(bytes(r) < 64 * 1024, `overview is ${bytes(r)} bytes on the wire`)
  for (const args of [{ limit: 200 }, { text: 'Person 7', limit: 200 }, { from: '2010-01-01', to: '2012-12-31', limit: 200 }]) {
    t = Date.now()
    const s = await c.rpc('tools/call', { name: 'search_photos', arguments: args })
    assert.ok(Date.now() - t < 2000, `${JSON.stringify(args)} took ${Date.now() - t} ms`)
    assert.ok(bytes(s) < 40 * 1024, `${JSON.stringify(args)} page is ${bytes(s)} bytes on the wire`)
  }
  // Two assistants at once, each with its own paging.
  const other = await client(lib)
  const [mine, theirs] = await Promise.all([
    c.tool('search_photos', { text: 'Person 3', limit: 7, offset: 7 }),
    other.tool('search_photos', { from: '2006-01-01', to: '2006-01-31', limit: 5 })
  ])
  assert.equal(mine.offset, 7)
  assert.equal(mine.photos.length, 7)
  assert.ok(mine.photos.every((p: { people: string[] }) => p.people.includes('Person 3')))
  assert.equal(theirs.photos.length, 5)
  assert.ok(theirs.photos.every((p: { taken: string }) => p.taken.startsWith('2006-01')))
  other.end()
  c.end()
  await lib.close()
})

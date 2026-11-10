// Assistant access (spec 0008): the switch, the socket's lifecycle, the token and the setup snippets.
// Off by default; when on, the in-app MCP server listens on a local socket only the owner can open.
import { connect } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertWritable } from './fsGuard.ts'
import { ensurePrivateDir, makeSocketPrivate, removeStaleSocket, writePrivateFile } from './appFiles.ts'
import { AssistantServer } from './assistantServer.ts'
import type { AssistantTools } from './assistantTools.ts'
import type { LibraryDb } from './db.ts'
import type { AssistantStatus } from '../shared/types.ts'

export const SETTING = 'assistantAccess'

export const REASONS = {
  inUse: 'another Photo Library window is using it. Quit that one, then turn it on here',
  tooLong: "the app's data folder path is too long for this system",
  permission: "the app couldn't set up its own assistant folder (permission denied)",
  internal: 'something went wrong inside the app'
} as const

/** Longest Unix socket path (sun_path minus the terminating NUL): 103 on macOS, 107 on Linux. */
const MAX_SOCKET_PATH = process.platform === 'darwin' ? 103 : 107

export interface AccessOptions {
  dataDir: string
  db: LibraryDb
  /** Absolute path of the built relay script. */
  relayPath: string
  makeTools: () => AssistantTools
  version: string
  onChange: (s: AssistantStatus) => void
  platform?: NodeJS.Platform
}

/** Where the server listens: a socket file in the app data folder, or a named pipe derived from it on Windows. */
export function socketAddress(dataDir: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return `\\\\.\\pipe\\photo-library-${createHash('sha256').update(dataDir.toLowerCase()).digest('hex').slice(0, 16)}`
  return join(dataDir, 'assistant', 'assistant.sock')
}

const posixQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
const winQuote = (s: string) => `"${s.replace(/"/g, '""')}"`

/** The Claude Desktop config entry and the Claude Code command, as shown in settings (AC-2). */
export function setupSnippets(
  relayPath: string,
  address: string,
  token: string,
  platform: NodeJS.Platform = process.platform
): { desktopJson: string; claudeCommand: string } {
  const env = { PHOTO_LIBRARY_SOCKET: address, PHOTO_LIBRARY_TOKEN: token }
  const desktopJson = JSON.stringify({ mcpServers: { 'photo-library': { command: 'node', args: [relayPath], env } } }, null, 2)
  const q = platform === 'win32' ? winQuote : posixQuote
  const claudeCommand = [
    'claude mcp add --scope user',
    ...Object.entries(env).map(([k, v]) => `--env ${q(`${k}=${v}`)}`),
    'photo-library -- node',
    q(relayPath)
  ].join(' ')
  return { desktopJson, claudeCommand }
}

/** Whether something answers on the socket (another copy of the app on the same data folder). */
function answers(address: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(address)
    const done = (v: boolean) => {
      clearTimeout(timer)
      s.destroy()
      resolve(v)
    }
    const timer = setTimeout(() => done(false), 500)
    s.on('connect', () => done(true))
    s.on('error', () => done(false))
  })
}

class StartError extends Error {}

export class AssistantAccess {
  private o: AccessOptions
  private server: AssistantServer | null = null
  private state: AssistantStatus['state'] = 'off'
  private reason: string | null = null
  private token: string | null = null
  private platform: NodeJS.Platform
  private busy: Promise<unknown> = Promise.resolve()

  constructor(o: AccessOptions) {
    this.o = o
    this.platform = o.platform ?? process.platform
  }

  get address(): string {
    return socketAddress(this.o.dataDir, this.platform)
  }

  private get folder(): string {
    return join(this.o.dataDir, 'assistant')
  }

  private get tokenFile(): string {
    return join(this.folder, 'token')
  }

  status(): AssistantStatus {
    const base = { state: this.state, ...(this.reason ? { reason: this.reason } : {}) }
    if (this.state !== 'on' || !this.token) return base
    return { ...base, ...setupSnippets(this.o.relayPath, this.address, this.token, this.platform) }
  }

  /** Runs lifecycle changes one at a time (a quick off-on-off must not interleave). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.busy.then(fn, fn)
    this.busy = next.catch(() => {})
    return next
  }

  private changed(): void {
    this.o.onChange(this.status())
  }

  /** At launch: starts if the library's setting says on. A failure turns it off quietly. */
  resume(): Promise<AssistantStatus> {
    if (this.o.db.getSetting(SETTING) !== 'on') return Promise.resolve(this.status())
    return this.turnOn()
  }

  turnOn(): Promise<AssistantStatus> {
    return this.serial(async () => {
      if (this.state === 'on') return this.status()
      this.state = 'starting'
      this.reason = null
      this.changed()
      try {
        await this.start()
        this.state = 'on'
        this.o.db.setSetting(SETTING, 'on')
      } catch (e) {
        if (!(e instanceof StartError)) console.error('Assistant access could not start:', e)
        await this.server?.close().catch(() => {})
        this.server = null
        this.state = 'failed'
        this.reason = e instanceof StartError ? e.message : this.reasonFor(e)
        this.o.db.setSetting(SETTING, 'off')
      }
      this.changed()
      return this.status()
    })
  }

  private reasonFor(e: unknown): string {
    const code = (e as NodeJS.ErrnoException)?.code
    if (code === 'EADDRINUSE') return REASONS.inUse
    if (code === 'EACCES' || code === 'EPERM') return REASONS.permission
    if (code === 'ENAMETOOLONG') return REASONS.tooLong
    return REASONS.internal
  }

  private async start(): Promise<void> {
    const address = this.address
    const posix = this.platform !== 'win32'
    await ensurePrivateDir(this.folder)
    this.token = this.readToken() ?? (await this.newToken())
    if (posix) {
      if (Buffer.byteLength(address) > MAX_SOCKET_PATH) throw new StartError(REASONS.tooLong)
      assertWritable(address, 'create socket')
      if (await answers(address)) throw new StartError(REASONS.inUse)
      await removeStaleSocket(address)
    } else if (await answers(address)) {
      throw new StartError(REASONS.inUse)
    }
    this.server = new AssistantServer({ token: () => this.token ?? '', tools: this.o.makeTools, version: this.o.version })
    await this.server.listen(address)
    await makeSocketPrivate(address)
  }

  private readToken(): string | null {
    try {
      const t = readFileSync(this.tokenFile, 'utf8').trim()
      return /^[0-9a-f]{64}$/.test(t) ? t : null
    } catch {
      return null
    }
  }

  private async newToken(): Promise<string> {
    const t = randomBytes(32).toString('hex')
    await writePrivateFile(this.tokenFile, t)
    return t
  }

  /** Turns access off: closes the socket and every connection, and removes the socket file. */
  turnOff(): Promise<AssistantStatus> {
    return this.serial(async () => {
      await this.stop()
      this.state = 'off'
      this.reason = null
      this.o.db.setSetting(SETTING, 'off')
      this.changed()
      return this.status()
    })
  }

  private async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    await server.close()
    if (this.platform !== 'win32') await removeStaleSocket(this.address).catch(() => {})
  }

  /** Replaces the token and closes every connection; the socket stays open for the new setup. */
  forget(): Promise<AssistantStatus> {
    return this.serial(async () => {
      if (this.state !== 'on' || !this.server) return this.status()
      this.token = await this.newToken()
      this.server.dropConnections()
      this.changed()
      return this.status()
    })
  }

  /** At quit: closes the socket and removes its file; the setting is kept. */
  shutdown(): Promise<void> {
    return this.serial(async () => {
      await this.stop()
      this.state = 'off'
    })
  }
}

// The MCP server inside the app (spec 0008): a local socket (Unix socket or named pipe, never a
// TCP port), a token handshake per connection, then MCP's JSON-RPC (initialize, ping, tools/list,
// tools/call) as newline-delimited JSON, the same framing as MCP's stdio transport, so the relay
// only has to forward bytes. Hand-written to keep web-server packages out of the app (spec 0008,
// decision 8).
import { createServer, type Server, type Socket } from 'node:net'
import { timingSafeEqual } from 'node:crypto'
import { AssistantTools, INTERNAL_ERROR, TOOL_DEFINITIONS, ToolError } from './assistantTools.ts'

export const SETUP_OUT_OF_DATE = "This assistant's setup is out of date: copy it again from Photo Library's settings"
export const TURNED_OFF = 'Assistant access was turned off in Photo Library'
export const HANDSHAKE_MS = 5000
/** MCP protocol versions this server speaks, newest first. */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const MAX_LINE = 1024 * 1024

type Id = string | number
interface Message {
  jsonrpc?: string
  id?: Id | null
  method?: string
  params?: Record<string, unknown>
}

export interface ServerOptions {
  /** The current token (it changes when the owner forgets connected assistants). */
  token: () => string
  /** Tools for a new connection (each gets its own search, AC-10/AC-15). */
  tools: () => AssistantTools
  version: string
}

const sameToken = (a: string, b: string): boolean => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

class Connection {
  private buffer = ''
  private authed = false
  private closed = false
  private pending = new Set<Id>()
  private tools: AssistantTools | null = null
  private timer: NodeJS.Timeout
  readonly socket: Socket
  private o: ServerOptions

  constructor(socket: Socket, o: ServerOptions, onClose: () => void) {
    this.socket = socket
    this.o = o
    socket.setEncoding('utf8')
    this.timer = setTimeout(() => this.refuse(), HANDSHAKE_MS)
    socket.on('data', (chunk: string) => this.data(chunk))
    socket.on('error', () => {})
    socket.on('close', () => {
      this.closed = true
      clearTimeout(this.timer)
      onClose()
    })
  }

  private send(m: unknown): void {
    if (!this.closed && !this.socket.destroyed) this.socket.write(JSON.stringify(m) + '\n')
  }

  private refuse(): void {
    this.send({ error: SETUP_OUT_OF_DATE })
    this.close()
  }

  /** Ends the connection; requests still running are answered with `message` first. */
  close(message?: string): void {
    if (this.closed) return
    if (message) for (const id of this.pending) this.send({ jsonrpc: '2.0', id, error: { code: -32000, message } })
    this.pending.clear()
    this.closed = true
    clearTimeout(this.timer)
    this.socket.end()
    // A client that doesn't close its end mustn't keep the connection alive.
    setTimeout(() => this.socket.destroy(), 200).unref()
  }

  private data(chunk: string): void {
    if (this.closed) return
    this.buffer += chunk
    if (this.buffer.length > MAX_LINE && !this.buffer.includes('\n')) return this.close()
    let at: number
    while ((at = this.buffer.indexOf('\n')) >= 0 && !this.closed) {
      const line = this.buffer.slice(0, at).trim()
      this.buffer = this.buffer.slice(at + 1)
      if (line) this.line(line)
    }
  }

  private line(line: string): void {
    let m: Message & { token?: unknown }
    try {
      m = JSON.parse(line)
    } catch {
      if (!this.authed) return this.refuse()
      return this.send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: each line must be one JSON-RPC message' } })
    }
    if (!this.authed) {
      if (typeof m?.token !== 'string' || !sameToken(m.token, this.o.token())) return this.refuse()
      this.authed = true
      clearTimeout(this.timer)
      this.tools = this.o.tools()
      return this.send({ ok: true })
    }
    void this.request(m)
  }

  private async request(m: Message): Promise<void> {
    const isRequest = m.id !== undefined && m.id !== null
    if (!m || typeof m.method !== 'string') {
      if (isRequest) this.send({ jsonrpc: '2.0', id: m.id, error: { code: -32600, message: 'Invalid request' } })
      return
    }
    if (!isRequest) return // notifications (initialized, cancelled, …) need no answer
    const id = m.id as Id
    const reply = (result: unknown) => {
      if (!this.pending.delete(id)) return // already answered (turned off meanwhile)
      this.send({ jsonrpc: '2.0', id, result })
    }
    const fail = (code: number, message: string) => {
      if (!this.pending.delete(id)) return
      this.send({ jsonrpc: '2.0', id, error: { code, message } })
    }
    this.pending.add(id)
    switch (m.method) {
      case 'initialize': {
        const asked = m.params?.protocolVersion
        return reply({
          protocolVersion: typeof asked === 'string' && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'photo-library', title: 'Photo Library', version: this.o.version },
          instructions:
            "Photo Library organises the owner's camera photos on their computer. You can search them and make albums of your own; you never see the photos themselves, file names or places. Start with library_overview."
        })
      }
      case 'ping':
        return reply({})
      case 'tools/list':
        return reply({ tools: TOOL_DEFINITIONS })
      case 'tools/call': {
        const name = m.params?.name
        const args = (m.params?.arguments ?? {}) as Record<string, unknown>
        if (typeof name !== 'string') return fail(-32602, 'tools/call needs a tool name')
        try {
          const result = await this.tools!.call(name, args)
          return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result })
        } catch (e) {
          if (!(e instanceof ToolError)) console.error('Assistant tool failed:', name, e)
          const text = e instanceof ToolError ? e.message : INTERNAL_ERROR
          return reply({ content: [{ type: 'text', text }], isError: true })
        }
      }
      default:
        return fail(-32601, `Method not found: ${m.method}`)
    }
  }
}

export class AssistantServer {
  private server: Server | null = null
  private connections = new Set<Connection>()
  private o: ServerOptions

  constructor(o: ServerOptions) {
    this.o = o
  }

  /** Listens on `address` (a socket path or pipe name, never a port). */
  listen(address: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => {
        const c = new Connection(socket, this.o, () => this.connections.delete(c))
        this.connections.add(c)
      })
      server.once('error', reject)
      server.listen({ path: address, readableAll: false, writableAll: false }, () => {
        server.off('error', reject)
        server.on('error', (e) => console.error('Assistant access socket error:', e))
        this.server = server
        resolve()
      })
    })
  }

  /** Closes every connection (calls in flight get `message`), keeping the socket open. */
  dropConnections(message = SETUP_OUT_OF_DATE): void {
    for (const c of this.connections) c.close(message)
  }

  /** Stops listening and closes every connection. */
  close(): Promise<void> {
    const server = this.server
    this.server = null
    this.dropConnections(TURNED_OFF)
    return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()))
  }

  get connectionCount(): number {
    return this.connections.size
  }
}

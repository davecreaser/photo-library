// The command an AI assistant launches for assistant access (spec 0008). It forwards MCP messages
// between its stdin/stdout and Photo Library's local socket, presenting the token first. It only
// relays: stdio and the socket are all it touches (test/safety.test.ts enforces that).
//
// Environment: PHOTO_LIBRARY_SOCKET (socket path or pipe name), PHOTO_LIBRARY_TOKEN.
import { connect, type Socket } from 'node:net'

const UNREACHABLE = "Photo Library isn't reachable. Open Photo Library and turn on assistant access, then try again."
// The same words as the app's answer to a wrong token (assistantServer.ts): the relay imports nothing from the app.
const OUT_OF_DATE = "This assistant's setup is out of date: copy it again from Photo Library's settings"
const CONNECT_MS = 1500
const REPLAY_ID = 'photo-library-relay-initialize'

const address = process.env.PHOTO_LIBRARY_SOCKET ?? ''
const token = process.env.PHOTO_LIBRARY_TOKEN ?? ''

type Id = string | number

let socket: Socket | null = null
let ready = false
let connecting = false
let everConnected = false
/** The assistant's initialize request, replayed after a reconnect so the new session knows it. */
let initializeLine: string | null = null
/** Lines from the assistant waiting for a connection. */
let queue: string[] = []
/** Requests sent to the app and not yet answered. */
const inFlight = new Set<Id>()
let stdinBuffer = ''
let socketBuffer = ''

function idOf(line: string): Id | null {
  try {
    const m = JSON.parse(line)
    return m && m.method && (typeof m.id === 'string' || typeof m.id === 'number') ? m.id : null
  } catch {
    return null
  }
}

function answerError(id: Id, message: string): void {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message } }) + '\n')
}

/** Answers everything waiting, and everything sent but unanswered, with `message`. */
function failAll(message: string): void {
  for (const line of queue) {
    const id = idOf(line)
    if (id !== null) answerError(id, message)
  }
  queue = []
  for (const id of inFlight) if (id !== REPLAY_ID) answerError(id, message)
  inFlight.clear()
}

function send(line: string): void {
  const id = idOf(line)
  if (id !== null) inFlight.add(id)
  socket!.write(line + '\n')
}

function disconnect(): void {
  const s = socket
  socket = null
  ready = false
  connecting = false
  socketBuffer = ''
  s?.destroy()
}

function fromApp(line: string): void {
  if (!ready) {
    let m: { ok?: boolean; error?: string } = {}
    try {
      m = JSON.parse(line)
    } catch {
      // not a handshake answer
    }
    if (m.ok !== true) {
      failAll(typeof m.error === 'string' ? m.error : UNREACHABLE)
      return disconnect()
    }
    ready = true
    connecting = false
    const reconnect = everConnected
    everConnected = true
    if (reconnect && initializeLine && !queue.some((l) => l === initializeLine)) {
      // The app's new session needs the assistant's initialize; its answer is not passed on.
      const m = JSON.parse(initializeLine)
      send(JSON.stringify({ ...m, id: REPLAY_ID }))
      socket!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    }
    const waiting = queue
    queue = []
    for (const l of waiting) send(l)
    return
  }
  const id = (() => {
    try {
      const m = JSON.parse(line)
      return m && !m.method && m.id !== undefined ? (m.id as Id) : null
    } catch {
      return null
    }
  })()
  if (id !== null) {
    inFlight.delete(id)
    if (id === REPLAY_ID) return
  }
  process.stdout.write(line + '\n')
}

function startConnect(): void {
  if (connecting || socket) return
  connecting = true
  if (!address || !token) {
    connecting = false
    return failAll(OUT_OF_DATE)
  }
  const s = connect(address)
  socket = s
  s.setEncoding('utf8')
  const timer = setTimeout(() => {
    if (!ready) {
      failAll(UNREACHABLE)
      disconnect()
    }
  }, CONNECT_MS)
  s.on('connect', () => s.write(JSON.stringify({ token }) + '\n'))
  s.on('data', (chunk: string) => {
    socketBuffer += chunk
    let at: number
    while ((at = socketBuffer.indexOf('\n')) >= 0) {
      const line = socketBuffer.slice(0, at).trim()
      socketBuffer = socketBuffer.slice(at + 1)
      if (line) fromApp(line)
      if (socket !== s) return
    }
  })
  s.on('error', () => {})
  s.on('close', () => {
    clearTimeout(timer)
    if (socket !== s) return
    failAll(UNREACHABLE)
    disconnect()
  })
}

function fromAssistant(line: string): void {
  try {
    if (JSON.parse(line)?.method === 'initialize') initializeLine = line
  } catch {
    // forwarded as is; the app answers parse errors
  }
  if (ready) return send(line)
  queue.push(line)
  startConnect()
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  stdinBuffer += chunk
  let at: number
  while ((at = stdinBuffer.indexOf('\n')) >= 0) {
    const line = stdinBuffer.slice(0, at).trim()
    stdinBuffer = stdinBuffer.slice(at + 1)
    if (line) fromAssistant(line)
  }
})
process.stdin.on('end', () => {
  disconnect()
  process.exit(0)
})

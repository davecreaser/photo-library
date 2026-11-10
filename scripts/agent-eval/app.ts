// The built app, run headless for the eval (spec 0010, AC-3, AC-6): launched as the e2e tests do,
// assistant access turned on through the window's own API, the eval's own MCP connection over the
// relay, and the scripted owner who approves or rejects proposals in the window.
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'

export const MAIN = join(import.meta.dirname, '..', '..', 'out', 'main', 'index.js')

export interface McpEntry {
  command: string
  args: string[]
  env: Record<string, string>
}

export class App {
  app!: ElectronApplication
  page!: Page

  static async launch(dataDir: string, pickFolder?: string): Promise<App> {
    if (!existsSync(MAIN)) throw new Error('The app is not built: run npm run build first.')
    const a = new App()
    const env = { ...process.env, PHOTO_LIBRARY_DATA_DIR: dataDir } as Record<string, string>
    for (const k of Object.keys(env)) if (k.startsWith('CLAUDE')) delete env[k]
    a.app = await electron.launch({ args: [MAIN, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])], env })
    a.page = await a.app.firstWindow()
    if (pickFolder)
      await a.app.evaluate(({ dialog }, root) => {
        dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [root] })) as typeof dialog.showOpenDialog
      }, pickFolder)
    return a
  }

  /** Waits until the scan and content analysis are done for `photos` photos. */
  async settled(photos: number, timeoutMs: number): Promise<void> {
    const until = Date.now() + timeoutMs
    for (;;) {
      const p = (await this.page.evaluate(() => window.api.getContentProgress())) as { phase: string; done: number; total: number }
      const lib = (await this.page.evaluate(() => window.api.getLibrary?.() ?? null)) as { photoCount?: number } | null
      if (p.phase === 'unavailable') throw new Error('Content search is unavailable: the content model is missing (see resources/models).')
      if (p.phase === 'idle' && p.total === photos && p.done === photos && (!lib || lib.photoCount === photos)) return
      if (Date.now() > until) throw new Error(`Analysis didn't finish in time (${p.done} of ${p.total}).`)
      await new Promise((r) => setTimeout(r, 2000))
    }
  }

  /** Turns assistant access on; returns the Claude Desktop setup entry the window shows. */
  async accessOn(): Promise<McpEntry> {
    const s = (await this.page.evaluate(() => window.api.setAssistantAccess(true))) as { state: string; desktopJson?: string; reason?: string }
    if (s.state !== 'on' || !s.desktopJson) throw new Error(`Assistant access didn't start: ${s.reason ?? s.state}`)
    return JSON.parse(s.desktopJson).mcpServers['photo-library'] as McpEntry
  }

  async close(): Promise<void> {
    await this.app.close().catch(() => {})
  }
}

/** The eval's own MCP connection, over the relay exactly as an assistant runs it. */
export class Mcp {
  private proc: ChildProcess
  private waiting = new Map<number, (m: any) => void>()
  private id = 0

  constructor(entry: McpEntry) {
    this.proc = spawn(process.execPath, entry.args, { env: { ...process.env, ...entry.env }, stdio: ['pipe', 'pipe', 'ignore'] })
    let buf = ''
    this.proc.stdout!.setEncoding('utf8').on('data', (c: string) => {
      buf += c
      let at
      while ((at = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, at))
        buf = buf.slice(at + 1)
        this.waiting.get(m.id)?.(m)
      }
    })
  }

  rpc(method: string, params?: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.id
      const t = setTimeout(() => reject(new Error(`no answer to ${method}`)), 30_000)
      this.waiting.set(id, (m) => {
        clearTimeout(t)
        resolve(m)
      })
      this.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  async init(): Promise<void> {
    await this.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'agent-eval', version: '1' } })
  }

  /** A tool's parsed result, or { error } for a tool error. */
  async tool(name: string, args: Record<string, unknown> = {}): Promise<any> {
    const m = await this.rpc('tools/call', { name, arguments: args })
    if (m.error) return { error: m.error.message as string }
    const text = m.result.content[0].text as string
    return m.result.isError ? { error: text } : JSON.parse(text)
  }

  close(): void {
    this.proc.kill()
  }
}

const WAITING = 'Picked by your AI assistant for you to look over'

/**
 * The scripted owner (AC-6): within 5 seconds of a proposal appearing, presses Make album without
 * changing anything ('approve'), or "Back to <album>" ('reject'). Never edits a pick, never presses
 * anything outside the Best of screen.
 */
export class Owner {
  acted = 0
  private stopped = false
  private loop: Promise<void>
  private page: Page
  private action: 'approve' | 'reject'

  constructor(page: Page, action: 'approve' | 'reject') {
    this.page = page
    this.action = action
    this.loop = this.watch()
  }

  private async watch(): Promise<void> {
    while (!this.stopped) {
      try {
        const subtitle = this.page.locator('.content-header .subtitle', { hasText: WAITING })
        if (await subtitle.count()) {
          // Let the pick load: the stepper shows once the grid has its photos.
          await this.page.getByLabel('How many photos').waitFor({ timeout: 4000 })
          if (this.action === 'approve') {
            await this.page.getByRole('button', { name: 'Make album' }).click({ timeout: 2000 })
            await this.page.locator('.content-header .subtitle', { hasText: 'Made from your AI assistant' }).waitFor({ timeout: 4000 })
          } else {
            await this.page.getByRole('button', { name: /^Back to / }).click({ timeout: 2000 })
            await subtitle.waitFor({ state: 'detached', timeout: 4000 })
          }
          this.acted++
        }
      } catch {
        // The screen changed under us (a newer proposal): look again.
      }
      await new Promise((r) => setTimeout(r, 250))
    }
  }

  /** Waits until no proposal is waiting on screen (up to `ms`), then stops watching. */
  async finish(ms: number): Promise<void> {
    const until = Date.now() + ms
    while (
      Date.now() < until &&
      (await this.page
        .locator('.content-header .subtitle', { hasText: WAITING })
        .count()
        .catch(() => 0))
    ) {
      await new Promise((r) => setTimeout(r, 250))
    }
    this.stopped = true
    await this.loop
  }
}

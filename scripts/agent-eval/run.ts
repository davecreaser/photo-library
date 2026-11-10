// The assistant eval (spec 0010): runs each task with Claude Code headless against the built app's
// MCP server, on a throwaway copy of a generated library's app data, and grades the result by state.
// By hand only:  node scripts/agent-eval/run.ts --help
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fingerprint } from '../../e2e/library.ts'
import { App, MAIN, Mcp, Owner } from './app.ts'
import { albumsIn, cacheKey, ensureDir, generate, isEvalLibrary, seed, truthFrom } from './library.ts'
import { PROXY_CAVEAT, TASKS, jaccard, pickChecks, type AlbumState, type Proposal, type RunState, type Task, type Truth } from './tasks.ts'
import { PRICES, comparable, estimateCost, makeBaseline, markdown, summarise, usageFrom, type Baseline, type RunResult, type Usage } from './report.ts'

const HERE = import.meta.dirname
const REPO = resolve(HERE, '..', '..')
const CACHE = join(homedir(), '.cache', 'photo-library-eval', 'agent')
const PHOTOS = join(CACHE, 'photos')
const TEMPLATE = join(CACHE, 'template')
const DEFAULT_MODEL = 'claude-sonnet-5-5'
const TOOLS = ['library_overview', 'search_photos', 'create_album', 'add_to_album', 'remove_from_album', 'best_of', 'propose_selection', 'proposal_status']
const RUN_LIMIT_MS = 10 * 60_000

const { values: opt } = parseArgs({
  options: {
    'dry-run': { type: 'boolean' },
    task: { type: 'string', multiple: true },
    runs: { type: 'string', default: '3' },
    model: { type: 'string', default: DEFAULT_MODEL },
    'max-turns': { type: 'string', default: '30' },
    'max-budget-usd': { type: 'string', default: '1' },
    budget: { type: 'string', default: '15' },
    yes: { type: 'boolean' },
    keep: { type: 'boolean' },
    'save-baseline': { type: 'boolean' },
    'compare-anyway': { type: 'boolean' },
    help: { type: 'boolean' }
  }
})

function die(message: string): never {
  console.error(message)
  process.exit(1)
}

if (opt.help) {
  console.log(`Assistant eval (spec 0010). By hand only; uses the network and costs money.

  node scripts/agent-eval/run.ts [--dry-run] [--task id ...] [--runs N] [--model id]
     [--max-turns 30] [--max-budget-usd 1] [--budget 15] [--yes] [--keep]
     [--save-baseline] [--compare-anyway]

Tasks: ${TASKS.map((t) => t.id).join(', ')}`)
  process.exit(0)
}

const runs = Number(opt.runs)
if (!Number.isInteger(runs) || runs < 1 || runs > 10) die('--runs must be a whole number from 1 to 10.')
const positive = (flag: string): number => {
  const n = Number(opt[flag as keyof typeof opt])
  if (!Number.isFinite(n) || n <= 0) die(`--${flag} must be a number above 0.`)
  return n
}
const maxTurns = positive('max-turns')
const maxBudget = positive('max-budget-usd')
const budget = positive('budget')
const model = opt.model!
const unknown = (opt.task ?? []).filter((id) => !TASKS.some((t) => t.id === id))
if (unknown.length) die(`Unknown task ${unknown.join(', ')}. The tasks are: ${TASKS.map((t) => t.id).join(', ')}.`)
const tasks = opt.task?.length ? TASKS.filter((t) => opt.task!.includes(t.id)) : TASKS
if (opt['save-baseline'] && tasks.length !== TASKS.length) die('--save-baseline needs every task: leave out --task.')
const worstCase = tasks.length * runs * maxBudget

// --- AC-1: the dry run needs no app, no model and no network ---
if (opt['dry-run']) {
  console.log(
    `Model ${model}${PRICES[model] ? '' : ' (not in the price table: cost will show as unknown)'} · ${runs} runs per task · caps ${maxTurns} turns and $${maxBudget} per run`
  )
  for (const t of tasks) console.log(`\n${t.id}  [owner: ${t.owner}]\n  “${t.prompt}”\n  graded: ${t.graded}`)
  console.log(`\nWorst case: ${tasks.length} tasks × ${runs} runs × $${maxBudget} = $${worstCase.toFixed(2)}`)
  process.exit(0)
}

// --- checks before spending anything ---
if (!existsSync(MAIN)) die('The app is not built: run npm run build first.')
let cliVersion: string
try {
  cliVersion = execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim().split(' ')[0]
} catch {
  die('The claude command was not found. Install Claude Code first.')
}
const authMode: 'api-key' | 'login' = process.env.ANTHROPIC_API_KEY ? 'api-key' : 'login'
console.log(`Model ${model} · claude ${cliVersion} · ${authMode === 'api-key' ? 'API key (--bare)' : 'your Claude login'} · ${runs} runs per task`)
console.log(`Worst case $${worstCase.toFixed(2)} (${tasks.length} tasks × ${runs} runs × $${maxBudget} per run).`)
if (worstCase > budget && !opt.yes) die(`That is over the $${budget} budget. Pass --yes to run anyway, or fewer --runs or --task.`)
const appCommit = execFileSync('git', ['describe', '--always', '--dirty'], { cwd: REPO, encoding: 'utf8' }).trim()

// --- AC-2: the eval library and template, cached by version ---
async function buildTemplate(): Promise<void> {
  console.log('Building the eval library and template (once per version; up to 15 minutes)…')
  // Past reports and transcripts stay.
  for (const p of [PHOTOS, TEMPLATE, join(CACHE, 'truth.json'), join(CACHE, 'key.txt')]) rmSync(p, { recursive: true, force: true })
  ensureDir(PHOTOS)
  await generate(PHOTOS)
  const app = await launch(TEMPLATE, PHOTOS)
  try {
    await app.page.getByRole('button', { name: 'Choose photo folder…' }).click()
    await app.settled(562, 15 * 60_000)
  } finally {
    await app.close()
  }
  await seed(join(TEMPLATE, 'library.db'), PHOTOS)
  const truth = truthFrom(join(TEMPLATE, 'library.db'), PHOTOS)
  // Check the template does what the tasks rely on.
  const check = await launch(TEMPLATE)
  try {
    await check.settled(truth.photos, 5 * 60_000)
    const red = (await check.page.evaluate(() => window.api.queryPhotos({ text: 'red 2025', limit: 20 } as never))) as { photos: { id: number }[] }
    const top = red.photos.slice(0, 10).map((p) => p.id)
    if (!truth.red2025.every((id) => top.includes(id)))
      throw new Error(`The search for "red" in 2025 doesn't rank the 10 red photos first; the eval library needs changing.`)
    const iceland = (await check.page.evaluate(() => window.api.queryPhotos({ text: 'Iceland', limit: 5 } as never))) as { total: number }
    if (iceland.total !== 0) throw new Error(`A search for "Iceland" finds ${iceland.total} photos; it should find none.`)
  } finally {
    await check.close()
  }
  if (truth.alex.length !== 14 || truth.sam.length !== 10) throw new Error('The seeded people were not kept by the app.')
  writeFileSync(join(CACHE, 'truth.json'), JSON.stringify(truth))
  writeFileSync(join(CACHE, 'key.txt'), cacheKey())
  console.log('Eval library ready.')
}

// --- shared run state, and Ctrl-C (AC-8: the partial report is still written) ---
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const OUT = join(CACHE, 'reports', stamp)
const results: RunResult[] = []
let toolsHash = ''
let current: { app?: App; mcp?: Mcp; claude?: ReturnType<typeof spawn>; tmp?: string } = {}
let stopping = false

function onSigint(): void {
  if (stopping) process.exit(130)
  stopping = true
  console.log('\nStopping: closing the app and writing the partial report…')
  void cleanUp().then(() => finish(true).then(() => process.exit(130)))
}
process.on('SIGINT', onSigint)

/**
 * Launches the app on `dataDir`. Playwright adds its own Ctrl-C handler, which would exit before the
 * partial report is written: it is removed (Playwright still closes Electron when the eval exits).
 * Also checks the app really uses `dataDir` (AC-3), so the owner's own data folder is never touched.
 */
async function launch(dataDir: string, pickFolder?: string): Promise<App> {
  const app = await App.launch(dataDir, pickFolder)
  for (const l of process.listeners('SIGINT')) if (l !== onSigint) process.off('SIGINT', l as () => void)
  const used = await app.app.evaluate(({ app: a }) => a.getPath('userData'))
  const real = (p: string) => (existsSync(p) ? realpathSync(p) : resolve(p))
  if (real(used) !== real(dataDir)) {
    await app.close()
    die(`The app used ${used}, not the eval's data folder: refusing to run.`)
  }
  return app
}

const key = cacheKey()
if (!existsSync(join(CACHE, 'key.txt')) || readFileSync(join(CACHE, 'key.txt'), 'utf8') !== key) {
  if (existsSync(join(CACHE, 'key.txt'))) console.log('The cached eval library is from older versions: rebuilding it.')
  await buildTemplate()
}
if (!isEvalLibrary(PHOTOS)) die(`${PHOTOS} is not a generated eval library: refusing to run.`)
const truth: Truth = JSON.parse(readFileSync(join(CACHE, 'truth.json'), 'utf8'))
const before: AlbumState[] = albumsIn(join(TEMPLATE, 'library.db'))

// --- the runs ---
ensureDir(OUT)

let cleaning: Promise<void> = Promise.resolve()

/**
 * Stops the run's processes and removes its folder. Ctrl-C and the interrupted run both call it, so
 * each call takes what is current and queues behind any cleanup under way: the folder is removed
 * only once the app has fully closed (it writes until then), and every caller waits for all of it.
 */
function cleanUp(): Promise<void> {
  const c = current
  current = {}
  cleaning = cleaning.then(async () => {
    c.claude?.kill('SIGKILL')
    c.mcp?.close()
    await c.app?.close()
    if (c.tmp && !opt.keep) rmSync(c.tmp, { recursive: true, force: true })
    // Kept runs stay in the system temp folder: the cache path can be too long for the app's socket.
    else if (c.tmp) console.log(`(kept ${c.tmp})`)
  })
  return cleaning
}

interface Stream {
  init?: { tools: string[]; mcp_servers: { name: string; status: string }[] }
  toolCalls: number
  turns: number
  /** Usage per assistant message (the CLI sends one event per content block, with the message's usage). */
  usage: Map<string, any>
  result?: any
  /** propose_selection calls: input and the proposal id from the result. */
  proposals: Map<number, { albumId: number; photoIds: number[] }>
}

/** Runs claude -p on the task; parses the stream as it goes; enforces the caps (AC-4, AC-9). */
function runClaude(
  task: Task,
  mcpConfig: string,
  cwd: string,
  transcript: string
): Promise<{ stream: Stream; capped: string | null; timedOut: boolean; isolation: string | null; exit: number | null }> {
  const args = [
    '-p',
    task.prompt,
    '--mcp-config',
    mcpConfig,
    '--strict-mcp-config',
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    model,
    '--max-budget-usd',
    String(maxBudget),
    '--no-session-persistence',
    '--tools',
    '',
    '--allowedTools',
    'mcp__photo-library',
    ...(authMode === 'api-key' ? ['--bare'] : ['--setting-sources', 'project'])
  ]
  const env = { ...process.env } as Record<string, string>
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CODE') || k === 'CLAUDECODE') delete env[k]
  const child = spawn('claude', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  current.claude = child
  const stream: Stream = { toolCalls: 0, turns: 0, usage: new Map(), proposals: new Map() }
  const pending = new Map<string, { albumId: number; photoIds: number[] }>()
  let capped: string | null = null
  let isolation: string | null = null
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGKILL')
  }, RUN_LIMIT_MS)
  return new Promise((done) => {
    let buf = ''
    child.stdout!.setEncoding('utf8').on('data', (c: string) => {
      appendFileSync(transcript, c)
      buf += c
      let at
      while ((at = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, at)
        buf = buf.slice(at + 1)
        let m: any
        try {
          m = JSON.parse(line)
        } catch {
          continue
        }
        if (m.type === 'system' && m.subtype === 'init') {
          stream.init = m
          const want = TOOLS.map((t) => `mcp__photo-library__${t}`).sort()
          const extraTools = (m.tools as string[]).filter((t) => !want.includes(t))
          const missing = want.filter((t) => !(m.tools as string[]).includes(t))
          const servers = (m.mcp_servers as { name: string }[]).map((s) => s.name).filter((n) => n !== 'photo-library')
          const ours = (m.mcp_servers as { name: string; status: string }[]).find((s) => s.name === 'photo-library')
          if (!extraTools.length && !servers.length && ours?.status !== 'connected') {
            isolation = `the Photo Library server didn't connect (${ours?.status ?? 'not listed'})`
            child.kill('SIGKILL')
          } else if (extraTools.length || missing.length || servers.length) {
            isolation = `isolation failed: ${[...extraTools, ...servers.map((s) => `server ${s}`), ...missing.map((t) => `missing ${t}`)].join(', ')}`
            child.kill('SIGKILL')
          }
        } else if (m.type === 'assistant') {
          const id = m.message?.id ?? `event ${stream.usage.size}`
          stream.usage.set(id, m.message?.usage)
          stream.turns = stream.usage.size
          for (const b of m.message?.content ?? []) {
            if (b.type !== 'tool_use') continue
            stream.toolCalls++
            if (b.name === 'mcp__photo-library__propose_selection')
              pending.set(b.id, { albumId: b.input?.album_id, photoIds: [...new Set<number>(b.input?.photo_ids ?? [])] })
          }
          if (stream.turns >= maxTurns && !capped) {
            capped = `stopped at the cap (${maxTurns} turns)`
            child.kill('SIGKILL')
          }
        } else if (m.type === 'user') {
          for (const b of m.message?.content ?? []) {
            if (b.type !== 'tool_result' || !pending.has(b.tool_use_id) || b.is_error) continue
            const text = typeof b.content === 'string' ? b.content : (b.content ?? []).map((x: any) => x.text ?? '').join('')
            try {
              const r = JSON.parse(text)
              if (r.proposal_id) {
                const p = pending.get(b.tool_use_id)!
                const notIn = new Set<number>(r.not_in_album ?? [])
                stream.proposals.set(r.proposal_id, { albumId: p.albumId, photoIds: p.photoIds.filter((id) => !notIn.has(id)) })
              }
            } catch {
              // A tool error in words: no proposal.
            }
          }
        } else if (m.type === 'result') {
          stream.result = m
          if (/max_budget/.test(m.subtype ?? '')) capped = `stopped at the cap ($${maxBudget})`
          if (/max_turns/.test(m.subtype ?? '')) capped = `stopped at the cap (${maxTurns} turns)`
        }
      }
    })
    child.stderr!.setEncoding('utf8').on('data', (c: string) => appendFileSync(transcript + '.stderr', c))
    child.on('close', (exit) => {
      clearTimeout(timer)
      done({ stream, capped, timedOut, isolation, exit })
    })
  })
}

async function oneRun(task: Task, n: number): Promise<RunResult | 'stop'> {
  const started = Date.now()
  const transcript = join(OUT, `${task.id}-${n}.jsonl`)
  const base = {
    task: task.id,
    run: n,
    toolCalls: 0,
    turns: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as Usage,
    cost: null,
    cliCost: null,
    transcript
  }
  const result = (outcome: RunResult['outcome'], reason: string, extra: Partial<RunResult> = {}): RunResult => ({
    ...base,
    outcome,
    reason,
    seconds: Math.round((Date.now() - started) / 1000),
    ...extra
  })
  const photosBefore = fingerprint(PHOTOS)
  const tmp = mkdtempSync(join(tmpdir(), 'pl-agent-eval-'))
  current.tmp = tmp
  const data = join(tmp, 'data')
  cpSync(TEMPLATE, data, { recursive: true })
  const work = ensureDir(join(tmp, 'work'))
  let outcome: RunResult
  try {
    const app = (current.app = await launch(data))
    await app.settled(truth.photos, 3 * 60_000)
    const entry = await app.accessOn()
    const socket = entry.env.PHOTO_LIBRARY_SOCKET
    if (process.platform !== 'win32' && relative(data, socket).startsWith('..')) return result('invalid', `the socket is outside the run's data folder`)
    const mcp = (current.mcp = new Mcp(entry))
    await mcp.init()
    const list = await mcp.rpc('tools/list')
    toolsHash ||= createHash('sha256').update(JSON.stringify(list.result.tools)).digest('hex')
    const overview = await mcp.tool('library_overview')
    const names = (overview.albums ?? []).map((a: { name: string }) => a.name).sort()
    if (overview.photos !== truth.photos || names.join() !== 'Beach with Sam,Lisbon,Sintra 2026' || (overview.people ?? []).length !== 2)
      return result('invalid', `precondition failed: the app shows ${overview.photos} photos, albums ${names.join(', ')}`)
    const mcpConfig = join(tmp, 'mcp.json')
    writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { 'photo-library': entry } }))

    const owner = task.owner === 'none' ? null : new Owner(app.page, task.owner)
    const c = await runClaude(task, mcpConfig, work, transcript)
    await owner?.finish(8000)
    const r = c.stream.result
    if (stopping) throw new Error('stopped by Ctrl-C')
    // The result's totals; without a result (the eval stopped claude at the turn cap), the messages' own.
    const usage: Usage = r?.usage
      ? usageFrom(r.usage)
      : [...c.stream.usage.values()].map(usageFrom).reduce(
          (a, u) => ({
            input: a.input + u.input,
            output: a.output + u.output,
            cacheRead: a.cacheRead + u.cacheRead,
            cacheWrite: a.cacheWrite + u.cacheWrite,
            cacheWrite1h: a.cacheWrite1h! + u.cacheWrite1h!
          }),
          { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 }
        )
    Object.assign(base, {
      toolCalls: c.stream.toolCalls,
      turns: r?.num_turns ?? c.stream.turns,
      usage,
      cost: estimateCost(model, usage),
      cliCost: r?.total_cost_usd ?? null
    })
    if (c.isolation) return result('invalid', c.isolation)
    if (c.timedOut) return result('invalid', 'took over 10 minutes')

    // Proposals: what was proposed (from the stream) and what became of it (proposal_status).
    const proposals: Proposal[] = []
    for (const [id, p] of [...c.stream.proposals].sort((a, b) => a[0] - b[0])) {
      const s = await mcp.tool('proposal_status', { proposal_id: id })
      proposals.push({ id, ...p, status: s.status ?? 'unknown', madeAlbumId: s.status === 'approved' ? s.album_id : undefined })
    }
    let picks: RunResult['picks']
    if (task.pick) {
      picks = []
      const tmpState: RunState = { before, after: before, proposals }
      for (const p of proposals) {
        const app_ = await mcp.tool('best_of', { album_id: p.albumId, count: task.pick.count })
        const appPick: number[] | null = app_.photos ? app_.photos.map((x: { id: number }) => x.id) : null
        const q = pickChecks(truth, task, tmpState, p)
        picks.push({ wouldApprove: q.wouldApprove, checks: q.checks, jaccard: appPick ? jaccard(p.photoIds, appPick) : null })
      }
    }
    mcp.close()
    await app.close()
    current.app = undefined
    current.mcp = undefined
    if (c.capped) return result('fail', c.capped, { picks })
    if (!r) return result('invalid', `claude ended without a result (exit ${c.exit})`)
    // An API error (a usage limit, an outage) says nothing about the tools: not graded.
    if (r.is_error)
      return result(
        'invalid',
        `claude API error${r.api_error_status ? ` ${r.api_error_status}` : ''}: ${String(r.result ?? r.api_error ?? r.subtype).split('\n')[0]}`
      )
    const after = albumsIn(join(data, 'library.db'))
    const g = task.grade(truth, { before, after, proposals })
    if (task.owner !== 'none' && proposals.length === 0) return result('fail', 'no proposal', { picks })
    outcome = result(g.pass ? 'pass' : 'fail', g.reason, { picks })
  } catch (e) {
    outcome = result('invalid', `the eval went wrong: ${(e as Error).message.split('\n')[0]}`)
  } finally {
    await cleanUp()
  }
  // AC-11: the photo folder is never touched.
  if (fingerprint(PHOTOS) !== photosBefore) {
    console.error(`The photo folder changed during run ${n} of ${task.id}: stopping`)
    return 'stop'
  }
  return outcome
}

async function finish(partial: boolean): Promise<void> {
  if (!results.length) return console.log('No runs finished: no report.')
  const summaries = summarise(
    tasks.map((t) => t.id),
    results
  )
  const baselineFile = join(HERE, `baseline-${model}.json`)
  let baseline: Baseline | undefined
  if (existsSync(baselineFile)) {
    const b = JSON.parse(readFileSync(baselineFile, 'utf8')) as Baseline
    const refused = comparable(b, model, authMode, !!opt['compare-anyway'])
    if (refused) console.log(`Not comparing: ${refused}.`)
    else baseline = b
  }
  const md = markdown({ model, cliVersion, authMode, runsPerTask: runs, toolsHash, summaries, runs: results, baseline, partial, caveat: PROXY_CAVEAT })
  writeFileSync(join(OUT, 'report.md'), md)
  writeFileSync(join(OUT, 'report.json'), JSON.stringify({ model, cliVersion, authMode, appCommit, runs, toolsHash, summaries, results }, null, 2))
  console.log('\n' + md)
  console.log(`Report and transcripts: ${OUT}`)
  if (opt['save-baseline'] && !partial) {
    writeFileSync(
      baselineFile,
      JSON.stringify(
        makeBaseline({ date: new Date().toISOString().slice(0, 10), model, cliVersion, appCommit, authMode, toolsHash, runsPerTask: runs }, summaries),
        null,
        2
      ) + '\n'
    )
    console.log(`Baseline saved: ${relative(REPO, baselineFile)}`)
  }
}

for (const task of tasks) {
  for (let n = 1; n <= runs && !stopping; n++) {
    process.stdout.write(`${task.id} run ${n}/${runs}… `)
    const r = await oneRun(task, n)
    if (r === 'stop') process.exit(2)
    results.push(r)
    console.log(`${r.outcome}${r.outcome === 'pass' ? '' : `: ${r.reason}`} (${r.toolCalls} tool calls, ${r.seconds}s)`)
    if (stopping) await new Promise(() => {}) // the Ctrl-C handler writes the report and exits
    if (r.reason.startsWith('isolation failed')) {
      console.error('Stopping: the model saw tools other than Photo Library’s, so no run would be a fair test.')
      await finish(true)
      process.exit(1)
    }
    if (/^claude API error (429|401|403)/.test(r.reason)) {
      console.error('Stopping: Claude refused (a usage limit or login problem), so every later run would fail the same way.')
      await finish(true)
      process.exit(1)
    }
  }
}
await finish(stopping)

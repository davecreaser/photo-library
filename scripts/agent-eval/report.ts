// The eval's numbers (spec 0010, AC-8 to AC-10, AC-15): estimated cost, the per-task table, the
// committed baseline and the comparison with it. Pure, so it's tested without a model.

/** $ per million tokens; cache reads cost 0.1x input, 5-minute cache writes 1.25x. */
export const PRICES: Record<string, { input: number; output: number }> = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-sonnet-5-5': { input: 2, output: 10 }
}

export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** Estimated cost in dollars, or null for a model not in the table (never guessed). */
export function estimateCost(model: string, u: Usage): number | null {
  const p = PRICES[model]
  if (!p) return null
  return (u.input * p.input + u.output * p.output + u.cacheRead * p.input * 0.1 + u.cacheWrite * p.input * 1.25) / 1e6
}

export interface RunResult {
  task: string
  run: number
  outcome: 'pass' | 'fail' | 'invalid'
  reason: string
  toolCalls: number
  turns: number
  usage: Usage
  /** Our estimate; null when the model isn't in the price table. */
  cost: number | null
  /** The CLI's own figure, when it gives one. */
  cliCost: number | null
  seconds: number
  transcript: string
  /** AC-7, Best of tasks only: per proposal, would the owner approve it unchanged (proxy), and overlap with the app's pick. */
  picks?: { wouldApprove: boolean; jaccard: number | null; checks: Record<string, boolean> }[]
}

export interface TaskSummary {
  task: string
  passes: number
  valid: number
  invalid: number
  toolCalls: { median: number; min: number; max: number }
  input: number
  output: number
  cost: number | null
}

export const median = (xs: number[]): number => {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export function summarise(taskIds: string[], runs: RunResult[]): TaskSummary[] {
  return taskIds.map((task) => {
    const mine = runs.filter((r) => r.task === task)
    const valid = mine.filter((r) => r.outcome !== 'invalid')
    const calls = valid.map((r) => r.toolCalls)
    const costs = valid.map((r) => r.cost)
    return {
      task,
      passes: valid.filter((r) => r.outcome === 'pass').length,
      valid: valid.length,
      invalid: mine.length - valid.length,
      toolCalls: { median: median(calls), min: calls.length ? Math.min(...calls) : 0, max: calls.length ? Math.max(...calls) : 0 },
      input: median(valid.map((r) => r.usage.input + r.usage.cacheRead + r.usage.cacheWrite)),
      output: median(valid.map((r) => r.usage.output)),
      cost: costs.some((c) => c === null) ? null : median(costs as number[])
    }
  })
}

// --- baseline (AC-10) ---

export interface Baseline {
  date: string
  model: string
  cliVersion: string
  appCommit: string
  authMode: 'api-key' | 'login'
  toolsHash: string
  runsPerTask: number
  tasks: Record<string, { passes: number; valid: number; invalid: number; toolCalls: number; input: number; output: number; cost: number | null }>
}

export const BASELINE_KEYS = ['date', 'model', 'cliVersion', 'appCommit', 'authMode', 'toolsHash', 'runsPerTask', 'tasks']
export const BASELINE_TASK_KEYS = ['passes', 'valid', 'invalid', 'toolCalls', 'input', 'output', 'cost']

export function makeBaseline(meta: Omit<Baseline, 'tasks'>, summaries: TaskSummary[]): Baseline {
  return {
    ...meta,
    tasks: Object.fromEntries(
      summaries.map((s) => [
        s.task,
        { passes: s.passes, valid: s.valid, invalid: s.invalid, toolCalls: s.toolCalls.median, input: s.input, output: s.output, cost: s.cost }
      ])
    )
  }
}

/** "likely real" only when the pass rates differ by at least half (3/3 -> 1/3, 5/5 -> 2/5). */
export function change(before: { passes: number; valid: number }, now: { passes: number; valid: number }): 'same' | 'likely real' | 'within noise' {
  if (before.valid === 0 || now.valid === 0) return 'within noise'
  const d = Math.abs(before.passes / before.valid - now.passes / now.valid)
  if (d === 0) return 'same'
  return d >= 0.5 - 1e-9 ? 'likely real' : 'within noise'
}

/** Refuses another model's or another auth mode's baseline unless told to compare anyway (AC-15). */
export function comparable(b: Baseline, model: string, authMode: string, anyway: boolean): string | null {
  if (anyway) return null
  if (b.model !== model) return `baseline is for ${b.model}; this run used ${model}`
  if (b.authMode !== authMode)
    return `baseline used ${b.authMode === 'api-key' ? 'an API key' : 'your login'}; this run used ${authMode === 'api-key' ? 'an API key' : 'your login'}`
  return null
}

// --- the report (AC-8) ---

const money = (c: number | null) => (c === null ? 'unknown' : `$${c.toFixed(c < 0.1 ? 3 : 2)}`)
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)))

export interface ReportInput {
  model: string
  cliVersion: string
  authMode: 'api-key' | 'login'
  runsPerTask: number
  toolsHash: string
  summaries: TaskSummary[]
  runs: RunResult[]
  baseline?: Baseline
  partial?: boolean
  caveat: string
}

export function markdown(r: ReportInput): string {
  const lines: string[] = []
  lines.push(`# Assistant eval${r.partial ? ' (stopped early: partial)' : ''}`, '')
  lines.push(`Model ${r.model} · claude ${r.cliVersion} · ${r.authMode === 'api-key' ? 'API key (--bare)' : 'your login'} · ${r.runsPerTask} runs per task`, '')
  if (r.baseline) {
    if (r.baseline.toolsHash !== r.toolsHash) lines.push('**Tool descriptions changed since the baseline.**', '')
    if (r.baseline.cliVersion !== r.cliVersion) lines.push(`Different CLI version: baseline ${r.baseline.cliVersion}.`, '')
  }
  lines.push(`${r.runsPerTask} runs per task: a difference of one run is noise; use --runs 5 or more before deciding.`, '')
  const head = ['Task', 'Passed', 'Invalid', 'Tool calls', 'Input', 'Output', 'Cost']
  if (r.baseline) head.push('Baseline')
  lines.push(`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`)
  for (const s of r.summaries) {
    const row = [
      s.task,
      `${s.passes}/${s.valid}`,
      String(s.invalid),
      `${s.toolCalls.median} (${s.toolCalls.min}–${s.toolCalls.max})`,
      k(s.input),
      k(s.output),
      money(s.cost)
    ]
    if (r.baseline) {
      const b = r.baseline.tasks[s.task]
      row.push(
        b
          ? `${b.passes}/${b.valid} → ${s.passes}/${s.valid} (${change(b, s)}; calls ${signed(s.toolCalls.median - b.toolCalls)}, tokens ${signed(s.input + s.output - b.input - b.output)})`
          : 'new task'
      )
    }
    lines.push(`| ${row.join(' | ')} |`)
  }
  const valid = r.runs.filter((x) => x.outcome !== 'invalid')
  const passed = valid.filter((x) => x.outcome === 'pass').length
  const costs = r.runs.map((x) => x.cost)
  const total = costs.some((c) => c === null) ? null : (costs as number[]).reduce((a, b) => a + b, 0)
  const tokens = r.runs.reduce((a, x) => a + x.usage.input + x.usage.output + x.usage.cacheRead + x.usage.cacheWrite, 0)
  const cli = r.runs.reduce((a, x) => a + (x.cliCost ?? 0), 0)
  lines.push(
    '',
    `Passed ${passed} of ${valid.length} valid runs${valid.length ? ` (${Math.round((100 * passed) / valid.length)}%)` : ''}. Tokens ${k(tokens)}. Estimated cost ${money(total)}${cli ? ` (CLI says $${cli.toFixed(2)})` : ''}.`
  )
  const withPicks = r.runs.filter((x) => x.picks?.length)
  if (withPicks.length) {
    lines.push('', '## Would approve unchanged (proxy)', '')
    for (const task of [...new Set(withPicks.map((x) => x.task))]) {
      const picks = withPicks.filter((x) => x.task === task).flatMap((x) => x.picks!)
      const j = picks.map((p) => p.jaccard).filter((x): x is number => x !== null)
      lines.push(
        `- ${task}: would approve unchanged: ${picks.filter((p) => p.wouldApprove).length} of ${picks.length} proposals${j.length ? `; overlap with the app's own pick ${median(j).toFixed(2)} (median)` : ''}`
      )
    }
    lines.push('', r.caveat)
  }
  const bad = r.runs.filter((x) => x.outcome !== 'pass')
  if (bad.length) {
    lines.push('', '## Failed and invalid runs', '')
    for (const x of bad) lines.push(`- ${x.task} run ${x.run}: ${x.outcome}: ${x.reason} (${x.transcript})`)
  }
  return lines.join('\n') + '\n'
}

const signed = (n: number) => (n > 0 ? `+${k(n)}` : n < 0 ? `-${k(-n)}` : '±0')

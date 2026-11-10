// The eval's numbers without a model (spec 0010, AC-8 to AC-10, AC-15).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BASELINE_KEYS, BASELINE_TASK_KEYS, change, comparable, estimateCost, makeBaseline, markdown, summarise, type RunResult } from './report.ts'

const run = (task: string, n: number, outcome: RunResult['outcome'], o: Partial<RunResult> = {}): RunResult => ({
  task,
  run: n,
  outcome,
  reason: outcome === 'pass' ? 'as asked' : 'made no album',
  toolCalls: 4,
  turns: 5,
  usage: { input: 1000, output: 500, cacheRead: 20_000, cacheWrite: 4000 },
  cost: 0.02,
  cliCost: 0.021,
  seconds: 30,
  transcript: '/cache/t.jsonl',
  ...o
})

test('AC-9: cost from the price table; unknown models are never guessed', () => {
  // 1000*2 + 500*10 + 20000*0.2 + 4000*2.5 = 21000 / 1e6
  assert.equal(estimateCost('claude-sonnet-5-5', { input: 1000, output: 500, cacheRead: 20_000, cacheWrite: 4000 }), 0.021)
  // 1-hour cache writes (Claude Code's) cost 2x input: 4000 at $4/MTok.
  assert.equal(estimateCost('claude-sonnet-5-5', { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 4000 }), 0.016)
  assert.equal(estimateCost('claude-made-up', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }), null)
})

test('AC-8: per task, passes of valid runs, invalid runs apart, medians; the report lists failures with transcripts', () => {
  const runs = [run('trip', 1, 'pass'), run('trip', 2, 'fail', { toolCalls: 9 }), run('trip', 3, 'invalid', { reason: 'isolation failed: Bash' })]
  const [s] = summarise(['trip'], runs)
  assert.deepEqual([s.passes, s.valid, s.invalid], [1, 2, 1])
  assert.deepEqual(s.toolCalls, { median: 6.5, min: 4, max: 9 })
  const md = markdown({ model: 'claude-sonnet-5-5', cliVersion: '2.1', authMode: 'login', runsPerTask: 3, toolsHash: 'h', summaries: [s], runs, caveat: 'C' })
  assert.match(md, /\| trip \| 1\/2 \| 1 \| 6.5 \(4–9\)/)
  assert.match(md, /a difference of one run is noise/)
  assert.match(md, /trip run 2: fail: made no album \(\/cache\/t.jsonl\)/)
  assert.match(md, /trip run 3: invalid: isolation failed: Bash/)
  assert.match(md, /Passed 1 of 2 valid runs \(50%\)/)
})

test('AC-10: a baseline holds only the allowed keys and is small; changes are likely real only at half or more', () => {
  const runs = ['trip', 'content'].flatMap((t) => [1, 2, 3].map((n) => run(t, n, 'pass')))
  const b = makeBaseline(
    { date: '2026-11-10', model: 'claude-sonnet-5-5', cliVersion: '2.1', appCommit: 'abc', authMode: 'login', toolsHash: 'h', runsPerTask: 3 },
    summarise(['trip', 'content'], runs)
  )
  assert.deepEqual(Object.keys(b).sort(), [...BASELINE_KEYS].sort())
  for (const t of Object.values(b.tasks)) assert.deepEqual(Object.keys(t).sort(), [...BASELINE_TASK_KEYS].sort())
  assert.ok(JSON.stringify(b, null, 2).length < 10_000)
  assert.equal(change({ passes: 3, valid: 3 }, { passes: 1, valid: 3 }), 'likely real')
  assert.equal(change({ passes: 5, valid: 5 }, { passes: 2, valid: 5 }), 'likely real')
  assert.equal(change({ passes: 3, valid: 3 }, { passes: 2, valid: 3 }), 'within noise')
  assert.equal(change({ passes: 2, valid: 3 }, { passes: 2, valid: 3 }), 'same')

  const now = summarise(
    ['trip', 'content'],
    [...[1, 2, 3].map((n) => run('trip', n, n === 1 ? 'pass' : 'fail')), ...[1, 2, 3].map((n) => run('content', n, 'pass'))]
  )
  const md = markdown({
    model: 'claude-sonnet-5-5',
    cliVersion: '2.2',
    authMode: 'login',
    runsPerTask: 3,
    toolsHash: 'changed',
    summaries: now,
    runs: [],
    baseline: b,
    caveat: 'C'
  })
  assert.match(md, /3\/3 → 1\/3 \(likely real/)
  assert.match(md, /Tool descriptions changed since the baseline/)
  assert.match(md, /Different CLI version: baseline 2.1/)
})

test('AC-15: another model’s or auth mode’s baseline is refused unless compared anyway', () => {
  const b = { model: 'claude-sonnet-5-5', authMode: 'login' } as never
  assert.equal(comparable(b, 'claude-opus-5-5', 'login', false), 'baseline is for claude-sonnet-5-5; this run used claude-opus-5-5')
  assert.match(comparable(b, 'claude-sonnet-5-5', 'api-key', false)!, /baseline used your login/)
  assert.equal(comparable(b, 'claude-opus-5-5', 'login', true), null)
  assert.equal(comparable(b, 'claude-sonnet-5-5', 'login', false), null)
})

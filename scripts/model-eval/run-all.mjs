// Runs coco.mjs for every variant whose model files are downloaded, one process each
// (clean memory numbers), skipping variants that already have results.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { VARIANTS } from './models.mjs'

const only = process.argv.slice(2)
for (const v of only.length ? only : VARIANTS) {
  if (existsSync(`results/coco-${v.replace(':', '-')}.json`)) continue
  process.stdout.write(`${v} … `)
  try {
    const out = execFileSync(process.execPath, ['coco.mjs', v], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 })
    const r = JSON.parse(out.trim().split('\n').at(-1))
    console.log(
      `R@1 ${(r.recall.r1 * 100).toFixed(1)}  R@5 ${(r.recall.r5 * 100).toFixed(1)}  ${r.msPerImage.toFixed(0)} ms/img  query ${r.queryMs.toFixed(0)} ms  ${r.peakRssMB} MB`
    )
  } catch (e) {
    console.log(
      'FAILED: ' +
        String(e.stderr ?? e)
          .split('\n')
          .filter(Boolean)
          .slice(-3)
          .join(' | ')
    )
  }
}

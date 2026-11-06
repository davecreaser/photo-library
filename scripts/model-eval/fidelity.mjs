// How much does compression change results on the owner's library? For each family, the
// average overlap of each precision's top 20 with the reference precision's top 20.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { CACHE } from './models.mjs'

const dir = join(CACHE, 'library', 'results')
const runs = Object.fromEntries(
  readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => [f.replace('.json', ''), JSON.parse(readFileSync(join(dir, f), 'utf8'))])
)
const families = [...new Set(Object.keys(runs).map((k) => k.replace(/-(fp32|fp16|q8)$/, '')))]
for (const fam of families) {
  const ref = runs[`${fam}-fp32`] ?? runs[`${fam}-fp16`]
  for (const prec of ['fp16', 'q8']) {
    const r = runs[`${fam}-${prec}`]
    if (!r || r === ref) continue
    const qs = Object.keys(ref.top)
    const overlap =
      qs.reduce((sum, q) => {
        const a = new Set(ref.top[q].slice(0, 20).map((x) => x.id))
        return sum + r.top[q].slice(0, 20).filter((x) => a.has(x.id)).length / 20
      }, 0) / qs.length
    console.log(`${fam.padEnd(10)} ${prec} vs ${ref.variant.split(':')[1]}: ${(overlap * 100).toFixed(0)}% of top-20 the same`)
  }
}

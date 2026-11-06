// Builds the blind judging page for the owner (local file, never uploaded):
//   node judge.mjs siglip:fp32 siglip2:fp16 clip-l14:fp16
// Each query shows each finalist's top 20 under a random letter; the owner ticks relevant
// photos; "Show scores" reveals which letter was which model. Saved in the browser as you go.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CACHE } from './models.mjs'
import { JUDGED } from './library.mjs'

const finalists = process.argv.slice(2)
const lib = join(CACHE, 'library')
const runs = finalists.map((v) => JSON.parse(readFileSync(join(lib, 'results', `${v.replace(':', '-')}.json`), 'utf8')))
const letters = ['A', 'B', 'C', 'D', 'E']
// Fixed shuffle per query so the page is stable across rebuilds.
const shuffle = (n, seed) => {
  const order = [...Array(n).keys()]
  let x = seed
  for (let i = n - 1; i > 0; i--) {
    x = (x * 1103515245 + 12345) % 2147483648
    const j = x % (i + 1)
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  return order
}
const data = JUDGED.map((q, qi) => {
  const order = shuffle(runs.length, qi + 7)
  return { q, columns: order.map((ri, li) => ({ letter: letters[li], model: runs[ri].variant, ids: runs[ri].top[q].slice(0, 20).map((x) => x.id) })) }
})
const html = `<!doctype html><meta charset="utf-8"><title>Photo Library: blind model test</title>
<style>
body{font:14px/1.5 -apple-system,sans-serif;background:#161618;color:#e8e8ea;margin:0;padding:24px 28px 80px}
h1{font-size:22px;margin:0 0 6px}p{color:#9a9aa2;max-width:70ch;margin:0 0 18px}
section{margin:26px 0 10px}h2{font-size:17px;margin:0 0 10px}
.cols{display:grid;grid-template-columns:repeat(${runs.length},1fr);gap:18px}
.col h3{font-size:13px;margin:0 0 6px;color:#9a9aa2}.col h3 b{color:#e8e8ea}
.grid{display:grid;grid-template-columns:repeat(5,1fr);gap:4px}
.t{position:relative;aspect-ratio:1;cursor:pointer;border-radius:4px;overflow:hidden;outline:3px solid transparent;outline-offset:-3px}
.t img{width:100%;height:100%;object-fit:cover;display:block}.t.on{outline-color:#4cd28b}.t.on::after{content:"✓";position:absolute;top:3px;right:6px;color:#4cd28b;font-weight:700;text-shadow:0 0 3px #000}
.bar{position:fixed;left:0;right:0;bottom:0;background:#1e1e21;border-top:1px solid #303035;padding:10px 28px;display:flex;gap:14px;align-items:center}
button{background:#4c8dff;border:0;color:#fff;border-radius:6px;padding:6px 14px;font:inherit;cursor:pointer}
.score{color:#9a9aa2}.reveal{display:none}.revealed .reveal{display:inline}
</style>
<h1>Which model finds your photos best?</h1>
<p>For each search, tick every photo that matches it, in every column. The columns are different models in a random order (letters change per search), so judge what you see. Your ticks are saved in this browser. When done, press “Show scores”.</p>
<div id="app"></div>
<div class="bar"><button id="show">Show scores</button><span id="out" class="score"></span></div>
<script>
const data = ${JSON.stringify(data)};
const key = 'pl-judge-v1';
const ticks = JSON.parse(localStorage.getItem(key) || '{}');
const app = document.getElementById('app');
for (const d of data) {
  const s = document.createElement('section');
  s.innerHTML = '<h2>“' + d.q + '”</h2>';
  const cols = document.createElement('div'); cols.className = 'cols';
  for (const c of d.columns) {
    const col = document.createElement('div'); col.className = 'col';
    col.innerHTML = '<h3>Model <b>' + c.letter + '</b> <span class="reveal">= ' + c.model + '</span> <span class="n"></span></h3>';
    const g = document.createElement('div'); g.className = 'grid';
    for (const id of c.ids) {
      const t = document.createElement('div'); t.className = 't'; const k = d.q + '|' + id;
      if (ticks[k]) t.classList.add('on');
      t.innerHTML = '<img loading="lazy" src="thumbs/' + id + '.jpg">';
      t.onclick = () => { ticks[k] = !ticks[k]; t.classList.toggle('on', ticks[k]); localStorage.setItem(key, JSON.stringify(ticks)); };
      g.appendChild(t);
    }
    col.appendChild(g); cols.appendChild(col);
  }
  s.appendChild(cols); app.appendChild(s);
}
document.getElementById('show').onclick = () => {
  document.body.classList.add('revealed');
  const per = {};
  for (const d of data) for (const c of d.columns) {
    const n = c.ids.filter((id) => ticks[d.q + '|' + id]).length;
    (per[c.model] ??= []).push(n);
  }
  document.getElementById('out').textContent = Object.entries(per).map(([m, ns]) => m + ': ' + ns.reduce((a, b) => a + b, 0) + ' relevant of ' + ns.length * 20 + ' (≥15 of 20 on ' + ns.filter((n) => n >= 15).length + ' searches)').join('   ·   ');
};
</script>`
writeFileSync(join(lib, 'judge.html'), html)
console.log('open ' + join(lib, 'judge.html'))

// Embeds the owner's library (eval thumbnails) with one variant and saves each query's top 50:
//   node library.mjs siglip:fp32
// Results stay in the eval cache (they reference private photos), never the repo.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { CACHE, load } from './models.mjs'

export const JUDGED = [
  'beach',
  'snow',
  'dog',
  'birthday cake',
  'sunset over water',
  'boats on the water',
  'a plate of pasta',
  'a church interior',
  'people laughing together',
  'snowboarding trip',
  'malbork castle',
  'photos from home',
  'family photos from the last year'
]
// Extra queries, only for measuring how much compression changes results.
export const FIDELITY = [
  'a cat',
  'a car',
  'mountains',
  'a city street at night',
  'flowers',
  'a baby',
  'a selfie',
  'a group of people',
  'food on a table',
  'a bicycle',
  'trees in a forest',
  'a lake',
  'the sea',
  'a castle',
  'a bridge',
  'a train',
  'a dog sleeping',
  'a pregnant woman',
  'a black and white photo',
  'a portrait',
  'a kitchen',
  'a living room',
  'a bedroom',
  'a garden',
  'a market',
  'a museum',
  'a painting',
  'a book',
  'a laptop',
  'a cup of coffee',
  'a glass of wine',
  'a rainbow',
  'clouds',
  'a harbour',
  'a festival',
  'a concert',
  'a wedding',
  'children playing',
  'a horse',
  'a waterfall'
]

const variant = process.argv[2]
if (variant) {
  const lib = join(CACHE, 'library')
  const photos = JSON.parse(readFileSync(join(lib, 'photos.json'), 'utf8'))
  const model = await load(variant)
  let ms = 0
  const chunks = []
  for (let i = 0; i < photos.length; i += 8) {
    const t = performance.now()
    chunks.push(await model.embedImages(photos.slice(i, i + 8).map((p) => join(lib, 'thumbs', `${p.id}.jpg`))))
    ms += performance.now() - t
  }
  const dim = chunks[0].length / Math.min(8, photos.length)
  const img = new Float32Array(photos.length * dim)
  let off = 0
  for (const c of chunks) {
    img.set(c, off)
    off += c.length
  }
  const queries = [...JUDGED, ...FIDELITY]
  const txt = await model.embedTexts(queries)
  const top = {}
  queries.forEach((q, qi) => {
    const scored = photos.map((p, i) => {
      let s = 0
      for (let k = 0; k < dim; k++) s += txt[qi * dim + k] * img[i * dim + k]
      return { id: p.id, s }
    })
    top[q] = scored.sort((a, b) => b.s - a.s).slice(0, 50)
  })
  mkdirSync(join(lib, 'results'), { recursive: true })
  writeFileSync(join(lib, 'results', `${variant.replace(':', '-')}.json`), JSON.stringify({ variant, msPerImage: ms / photos.length, top }))
  console.log(`${variant}: ${photos.length} photos, ${(ms / photos.length).toFixed(0)} ms/img`)
}

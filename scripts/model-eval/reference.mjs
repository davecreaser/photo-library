// Reference outputs for the app's own SigLIP pipeline (spec 0002): token ids and embeddings
// computed by Transformers.js, which the app must reproduce without depending on it.
//   node reference.mjs   (after npm ci and ./download.sh, or just the SigLIP files)
// Writes test/fixtures/siglip/reference.json and the generated images it was computed from.
// Images are drawn shapes and colours (no text, so every OS renders them identically); no photos.
import { AutoTokenizer } from '@huggingface/transformers'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { load } from './models.mjs'

const OUT = join(import.meta.dirname, '..', '..', 'test', 'fixtures', 'siglip')
mkdirSync(OUT, { recursive: true })

export const PHRASES = [
  'dog',
  'beach',
  'snow',
  'birthday cake',
  'sunset over water',
  'a red square',
  'red',
  'blue',
  'dogs beach',
  'show me photos of dogs on the beach',
  'Malbork Castle',
  'A Photo Of A CAT.',
  'boats on the water, at night!',
  "children's party (2019)",
  'xqzv kjrw',
  'café crème brûlée',
  'naïve résumé',
  'ﬁsh and chips', // a ligature: NFKC turns it into "fi"
  'Ｆｕｌｌ ｗｉｄｔｈ', // full-width letters
  'two  spaces   between',
  '  leading and trailing  ',
  'tab\tand\nnewline',
  'emoji 🐶 dog',
  '日本の桜',
  'Ελληνικά',
  'hello</s>world',
  '<unk> token',
  'a',
  '1234 5678',
  'semi-colons; and: colons',
  'quotes “curly” and "straight"',
  'an extremely long query that keeps going and going with many words so that it is longer than sixty four tokens once it has been split into pieces by the sentencepiece model which is the limit',
  'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twenty-one twenty-two twenty-three twenty-four twenty-five twenty-six twenty-seven twenty-eight twenty-nine thirty thirty-one thirty-two thirty-three thirty-four thirty-five',
  ''
]

const tokenizer = await AutoTokenizer.from_pretrained('Xenova/siglip-base-patch16-224', { local_files_only: true })
const tokens = PHRASES.map((p) => Array.from(tokenizer(p, { padding: 'max_length', truncation: true, max_length: 64 }).input_ids.data, Number))

// Images: 224x224 (the model's size, so no resampling) plus two that need resizing.
const svg = (w, h, body) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`)
const IMAGES = {
  red: svg(224, 224, '<rect width="224" height="224" fill="#d22"/>'),
  blue: svg(224, 224, '<rect width="224" height="224" fill="#2244dd"/>'),
  halves: svg(224, 224, '<rect width="112" height="224" fill="#d22"/><rect x="112" width="112" height="224" fill="#2244dd"/>'),
  sunset: svg(
    224,
    224,
    '<rect width="224" height="140" fill="#f4a04a"/><circle cx="112" cy="130" r="40" fill="#ffdd55"/><rect y="140" width="224" height="84" fill="#1d4f8f"/>'
  ),
  tree: svg(
    224,
    224,
    '<rect width="224" height="224" fill="#bfe3ff"/><polygon points="112,20 40,190 184,190" fill="#2a8a2a"/><rect x="100" y="190" width="24" height="34" fill="#6b4226"/>'
  ),
  checker: svg(
    224,
    224,
    Array.from(
      { length: 64 },
      (_, i) => `<rect x="${(i % 8) * 28}" y="${Math.floor(i / 8) * 28}" width="28" height="28" fill="${(i + Math.floor(i / 8)) % 2 ? '#000' : '#fff'}"/>`
    ).join('')
  ),
  'sunset-640x480': svg(
    640,
    480,
    '<rect width="640" height="300" fill="#f4a04a"/><circle cx="320" cy="280" r="90" fill="#ffdd55"/><rect y="300" width="640" height="180" fill="#1d4f8f"/>'
  ),
  'tree-300x500': svg(
    300,
    500,
    '<rect width="300" height="500" fill="#bfe3ff"/><polygon points="150,40 40,420 260,420" fill="#2a8a2a"/><rect x="135" y="420" width="30" height="80" fill="#6b4226"/>'
  )
}
const paths = {}
for (const [name, data] of Object.entries(IMAGES)) {
  paths[name] = join(OUT, `${name}.png`)
  await sharp(data).png().toFile(paths[name])
}

const model = await load('siglip:fp16')
const round = (v) => Array.from(v, (x) => Math.round(x * 1e6) / 1e6)
const textVecs = await model.embedTexts(PHRASES.filter(Boolean))
const imageVecs = await model.embedImages(Object.values(paths))
const dim = 768
let t = 0
const texts = PHRASES.map((phrase, i) => ({
  phrase,
  ids: tokens[i],
  embedding: phrase ? round(textVecs.subarray(t * dim, ++t * dim)) : null
}))
const images = Object.keys(IMAGES).map((name, i) => ({ file: `${name}.png`, embedding: round(imageVecs.subarray(i * dim, (i + 1) * dim)) }))
writeFileSync(join(OUT, 'reference.json'), JSON.stringify({ model: 'Xenova/siglip-base-patch16-224 fp16, Transformers.js 4.3.1', texts, images }))
console.log(`wrote ${texts.length} phrases and ${images.length} images to ${OUT}`)

import { load } from './models.mjs'
const v = process.argv[2]
const m = await load(v)
const imgs = [
  '/private/tmp/claude-501/-Users-dave-dev-personal/b2019522-d176-42f8-98be-4cbcc2ccc111/scratchpad/fixtures/2020-08 Spain holiday/IMG_0001.JPG',
  '/private/tmp/claude-501/-Users-dave-dev-personal/b2019522-d176-42f8-98be-4cbcc2ccc111/scratchpad/fixtures/2021 Christmas/IMG_0015.JPG',
  '/private/tmp/claude-501/-Users-dave-dev-personal/b2019522-d176-42f8-98be-4cbcc2ccc111/scratchpad/fixtures/DCIM/100CANON/IMG_ROT.JPG'
]
const iv = await m.embedImages(imgs)
const tv = await m.embedTexts(['an orange-red picture', 'a dark blue picture with white text'])
const d = iv.length / imgs.length
for (let t = 0; t < 2; t++)
  console.log(
    v,
    'text',
    t,
    Array.from({ length: imgs.length }, (_, i) => {
      let s = 0
      for (let k = 0; k < d; k++) s += tv[t * d + k] * iv[i * d + k]
      return s.toFixed(3)
    }).join(' ')
  )

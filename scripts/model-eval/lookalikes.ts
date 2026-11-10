// Calibrates LOOKALIKE_MIN_SCORE (src/main/bestOf.ts, spec 0006): content cosine of generated bursts
// (same scene, small shifts, blur, exposure) against different and similar-looking scenes.
// Generated scenes only; run it on a trip of your own the same way to check the threshold read-only.
// Run: node --experimental-strip-types scripts/model-eval/lookalikes.ts
import sharp from 'sharp'
import { ContentModel } from '../../src/main/contentModel.ts'
import { decodeForAnalysis } from '../../src/main/decode.ts'
const m = await ContentModel.load(new URL('../../resources/models', import.meta.url).pathname)
const scene = (shapes: string, shift = 0, bright = 1) => `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#87ceeb"/><rect y="320" width="640" height="160" fill="#3a7d2c"/>${shapes}</svg>`
const house = (dx: number) => `<rect x="${200 + dx}" y="200" width="200" height="140" fill="#b5651d"/><polygon points="${190 + dx},200 ${300 + dx},120 ${410 + dx},200" fill="#8b0000"/>`
const tree = (dx: number) => `<rect x="${500 + dx}" y="240" width="20" height="100" fill="#5c3b1e"/><circle cx="${510 + dx}" cy="220" r="60" fill="#1e5c1e"/>`
const boat = `<polygon points="150,380 450,380 400,430 200,430" fill="#444"/><rect x="290" y="250" width="8" height="130" fill="#222"/><polygon points="298,255 298,370 400,370" fill="#fff"/>`
const embed = async (svg: string, blur = 0, modulate = 1) => { let s = sharp(Buffer.from(svg)); if (blur) s = s.blur(blur); s = s.modulate({ brightness: modulate }); const img = await decodeForAnalysis(await s.jpeg().toBuffer(), false); const v = await m.embedImage(img); return v }
const cos = (a: Float32Array, b: Float32Array) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i] } return d / Math.sqrt(na*nb) }
const a = await embed(scene(house(0) + tree(0)))
const burst1 = await embed(scene(house(6) + tree(4)), 0, 1.03)
const burst2 = await embed(scene(house(-8) + tree(-5)), 0.6, 0.97)
const sameplaceDiffview = await embed(scene(house(80) + tree(-150)))
const diffscene = await embed(scene(boat))
const diffscene2 = await embed(scene(tree(-300) + tree(-100) + tree(0)))
console.log('burst', cos(a, burst1).toFixed(3), cos(a, burst2).toFixed(3))
console.log('same place, other framing', cos(a, sameplaceDiffview).toFixed(3))
console.log('different scenes', cos(a, diffscene).toFixed(3), cos(a, diffscene2).toFixed(3), cos(diffscene, diffscene2).toFixed(3))

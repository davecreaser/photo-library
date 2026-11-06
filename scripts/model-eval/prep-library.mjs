// Makes 448px thumbnails of the owner's present photos for the evaluation, reading the
// app's database read-only. Everything is written to the eval cache, never the photo folder.
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, existsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { CACHE } from './models.mjs'

const dbPath = process.env.PHOTO_LIBRARY_DB ?? join(homedir(), 'Library/Application Support/photo-library/library.db')
const db = new DatabaseSync(dbPath, { readOnly: true })
const rows = db
  .prepare(
    `SELECT p.id, p.taken_at, (SELECT path FROM files WHERE photo_id = p.id AND missing = 0 ORDER BY path LIMIT 1) AS path
     FROM photos p WHERE p.present = 1 ORDER BY p.id`
  )
  .all()
db.close()
const out = join(CACHE, 'library', 'thumbs')
mkdirSync(out, { recursive: true })
let done = 0
const list = []
for (const r of rows) {
  const file = join(out, `${r.id}.jpg`)
  if (!existsSync(file)) {
    try {
      await sharp(r.path, { failOn: 'none' }).rotate().resize(448, 448, { fit: 'inside' }).jpeg({ quality: 85 }).toFile(file)
    } catch {
      continue // unreadable (e.g. HEIC): left out of the evaluation
    }
  }
  list.push({ id: r.id, takenAt: r.taken_at })
  if (++done % 100 === 0) process.stdout.write(`${done} `)
}
writeFileSync(join(CACHE, 'library', 'photos.json'), JSON.stringify(list))
console.log(`\n${list.length} photos ready in ${out}`)

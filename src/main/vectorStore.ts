// Where photos' content vectors live and how a phrase is compared with them (spec 0002).
// This is the only file that knows: swap it for an in-memory brute force, or for a sqlite-vec
// approximate index, without touching search or analysis (ADR 0009).
//
// Vectors are stored as int8 (768 bytes a photo, within the 2 KB budget): each vector is scaled
// so its largest component is ±127. Cosine similarity ignores that scale, and the rounding moves
// a score by about 0.001 (the PR records top-20 agreement with full precision on COCO).
// They are compared exactly, in SQL, with sqlite-vec's distance function, so a search can filter
// by anything SQL can (present photos, a person, dates) in the same query.
import type { DatabaseSync } from 'node:sqlite'
import { getLoadablePath } from 'sqlite-vec'

type SqlValue = string | number | null

export const VECTOR_SCHEMA = `
-- One content vector per photo (int8, see vectorStore.ts), from the analysis recorded in
-- photos.content_version. Photos that couldn't be read have a version but no vector.
CREATE TABLE IF NOT EXISTS content_vectors (
  photo_id INTEGER PRIMARY KEY REFERENCES photos (id) ON DELETE CASCADE,
  embedding BLOB NOT NULL
);
`

/** Scales the vector so its largest component is ±127 and rounds to int8 bytes. */
export function quantise(v: Float32Array): Uint8Array {
  let max = 0
  for (const x of v) max = Math.max(max, Math.abs(x))
  const scale = max > 0 ? 127 / max : 0
  return new Uint8Array(Int8Array.from(v, (x) => Math.round(x * scale)).buffer)
}

export class VectorStore {
  private db: DatabaseSync
  /** Why searching isn't possible (sqlite-vec failed to load), or null. Saving works regardless. */
  readonly loadError: string | null

  constructor(db: DatabaseSync) {
    this.db = db
    let error: string | null = null
    try {
      // sqlite-vec ships a prebuilt library per platform; ADR 0009. Loading is switched off again
      // straight after, so no SQL can load anything else.
      db.loadExtension(getLoadablePath())
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      db.enableLoadExtension(false)
    }
    this.loadError = error
  }

  save(photoId: number, vector: Float32Array | null): void {
    if (vector) this.db.prepare('INSERT OR REPLACE INTO content_vectors (photo_id, embedding) VALUES (?, ?)').run(photoId, quantise(vector))
    else this.db.prepare('DELETE FROM content_vectors WHERE photo_id = ?').run(photoId)
  }

  /**
   * Photos (`p`, joined to their vector) meeting the SQL condition `where` whose cosine similarity
   * to `query` is at least `minScore`, best first; ties by id, so the order is always the same.
   */
  search(query: Float32Array, minScore: number, where: string, params: SqlValue[]): { id: number; score: number }[] {
    if (this.loadError) throw new Error(`Vector search unavailable: ${this.loadError}`)
    const rows = this.db
      .prepare(
        `SELECT id, score FROM (
           SELECT p.id, 1 - vec_distance_cosine(vec_int8(c.embedding), vec_int8(?)) AS score
           FROM photos p JOIN content_vectors c ON c.photo_id = p.id WHERE ${where}
         ) WHERE score >= ? ORDER BY score DESC, id`
      )
      .all(quantise(query), ...params, minScore) as { id: number; score: number }[]
    return rows.map((r) => ({ id: r.id, score: r.score }))
  }
}

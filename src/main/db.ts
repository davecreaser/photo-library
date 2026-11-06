// The app's own "virtual" library, stored in the app's data folder (never inside
// the photo folder).
//
// A photo is its CONTENT (SHA-256 hash). Where that content lives is tracked
// separately in `files`, so moving, renaming, copying or switching base folder
// never loses a photo's albums, tags or favourite: the next scan finds the same
// hash at the new path and links it to the same photo.
import { DatabaseSync } from 'node:sqlite'
import { basename, extname, relative, dirname, sep } from 'node:path'
import { parseSearch, splitSearch, type SearchPlan } from '../shared/search.ts'
import type { Album, FaceGroup, Person, PersonFace, Photo, PhotoDetails, PhotoFilter, PhotoPage, Tag, TimelineMonth } from '../shared/types.ts'
import type { FaceVector, KnownPerson } from './faceGroups.ts'
import { correctedTime, correctionApplies, type Correction } from './dates.ts'
import type { EventGroup } from './events.ts'
import { VECTOR_SCHEMA, VectorStore } from './vectorStore.ts'

const SCHEMA_VERSION = 6

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY,
  -- SHA-256 of the file contents. NULL only briefly, for rows migrated from v1 until rescanned.
  hash TEXT UNIQUE,
  size INTEGER NOT NULL,
  -- What the camera recorded, and the time after clock corrections (what we show/search).
  taken_at_raw TEXT,
  taken_at TEXT,
  width INTEGER,
  height INTEGER,
  orientation INTEGER,
  camera TEXT,
  lat REAL,
  lon REAL,
  -- 1 when the user starred it.
  favorite INTEGER,
  -- Version of the face model that analysed this photo (NULL = not yet).
  faces_version INTEGER,
  -- Version of the content model that analysed this photo (NULL = not yet); vector in content_vectors.
  content_version INTEGER,
  -- 1 when at least one copy is currently on disk under the base folder.
  present INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS photos_taken_at ON photos (taken_at);
CREATE INDEX IF NOT EXISTS photos_camera ON photos (camera, taken_at_raw);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  photo_id INTEGER NOT NULL REFERENCES photos (id) ON DELETE CASCADE,
  path TEXT NOT NULL UNIQUE,
  size INTEGER NOT NULL,
  mtime_ms INTEGER NOT NULL,
  -- Set when a scan no longer finds the file. Kept so the location is remembered.
  missing INTEGER NOT NULL DEFAULT 0,
  last_seen_scan INTEGER
);
CREATE INDEX IF NOT EXISTS files_photo ON files (photo_id);

CREATE TABLE IF NOT EXISTS albums (
  id INTEGER PRIMARY KEY,
  parent_id INTEGER REFERENCES albums (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS album_photos (
  album_id INTEGER NOT NULL REFERENCES albums (id) ON DELETE CASCADE,
  photo_id INTEGER NOT NULL REFERENCES photos (id) ON DELETE CASCADE,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (album_id, photo_id)
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE IF NOT EXISTS photo_tags (
  photo_id INTEGER NOT NULL REFERENCES photos (id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  PRIMARY KEY (photo_id, tag_id)
);

-- Events the user merged or renamed. Automatic events whose ids are in
-- "members", or that fall entirely within start..end, become this one event.
CREATE TABLE IF NOT EXISTS event_groups (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  start TEXT,
  end TEXT,
  members TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS faces (
  id INTEGER PRIMARY KEY,
  photo_id INTEGER NOT NULL REFERENCES photos (id) ON DELETE CASCADE,
  -- Box relative to the upright image (0..1).
  x REAL NOT NULL, y REAL NOT NULL, w REAL NOT NULL, h REAL NOT NULL,
  score REAL NOT NULL,
  -- L2-normalised face embedding (Float32Array bytes); NULL when too small to recognise.
  embedding BLOB,
  person_id INTEGER REFERENCES people (id) ON DELETE SET NULL,
  -- 'user' when the user named/confirmed it, 'auto' when matched automatically.
  assigned_by TEXT,
  -- Group of similar unnamed faces from the last clustering.
  cluster INTEGER
);
CREATE INDEX IF NOT EXISTS faces_photo ON faces (photo_id);
CREATE INDEX IF NOT EXISTS faces_person ON faces (person_id);
CREATE INDEX IF NOT EXISTS faces_cluster ON faces (cluster);

-- "This is not X": keeps automatic matching from re-adding a face to that person.
CREATE TABLE IF NOT EXISTS face_rejections (
  face_id INTEGER NOT NULL REFERENCES faces (id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES people (id) ON DELETE CASCADE,
  PRIMARY KEY (face_id, person_id)
);

-- The user's decisions on suggested albums (spec 0001), kept by photo so they survive
-- moves and renames. An accepted decision belongs to its album: deleting the album
-- deletes the decision, so the suggestion comes back.
CREATE TABLE IF NOT EXISTS suggestion_decisions (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('accepted', 'dismissed')),
  name TEXT NOT NULL,
  album_id INTEGER REFERENCES albums (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS suggestion_decision_photos (
  decision_id INTEGER NOT NULL REFERENCES suggestion_decisions (id) ON DELETE CASCADE,
  photo_id INTEGER NOT NULL REFERENCES photos (id) ON DELETE CASCADE,
  PRIMARY KEY (decision_id, photo_id)
);
CREATE INDEX IF NOT EXISTS suggestion_decision_photos_photo ON suggestion_decision_photos (photo_id);

-- "Not these" on new photos offered for an album (spec 0005), kept by photo.
CREATE TABLE IF NOT EXISTS offer_declines (
  album_id INTEGER NOT NULL REFERENCES albums (id) ON DELETE CASCADE,
  photo_id INTEGER NOT NULL REFERENCES photos (id) ON DELETE CASCADE,
  PRIMARY KEY (album_id, photo_id)
);
CREATE INDEX IF NOT EXISTS offer_declines_photo ON offer_declines (photo_id);

CREATE TABLE IF NOT EXISTS clock_corrections (
  id INTEGER PRIMARY KEY,
  camera TEXT NOT NULL,
  applies_before TEXT,
  offset_years INTEGER NOT NULL DEFAULT 0,
  offset_seconds INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
${VECTOR_SCHEMA}`

type Row = Record<string, unknown>
type SqlValue = string | number | null

export interface FileMeta {
  path: string
  size: number
  mtimeMs: number
  takenAt: string | null
  width: number | null
  height: number | null
  orientation: number | null
  camera: string | null
  lat: number | null
  lon: number | null
}

/** Photos the app stopped tracking: their thumbnail hashes and face ids, for cache cleanup. */
export interface Forgotten {
  hashes: string[]
  faceIds: number[]
}

export type RecordOutcome = 'added' | 'relocated' | 'updated'

export interface ThumbSource {
  id: number
  hash: string | null
  path: string
  ext: string
  orientation: number | null
}

/** A photo waiting for background analysis, and which analyses it still needs. */
export interface AnalysisSource extends ThumbSource {
  needsFaces: boolean
  needsContent: boolean
}

/** A search's content part: the phrase's vector and what counts as a match (spec 0002). */
export interface ContentQuery {
  vector: Float32Array
  version: number
  minScore: number
}

export interface PhotoForOrganising {
  id: number
  camera: string | null
  takenAt: string | null
  takenAtRaw: string | null
  favorite: boolean
  /** Folders of present copies, relative to the base folder, "/"-separated on every OS. */
  dirs: string[]
}

// The present copy shown for a photo: first by path, for stability.
const PRIMARY_FILE = `(SELECT id FROM files WHERE photo_id = p.id AND missing = 0 ORDER BY path LIMIT 1)`
const PHOTO_COLUMNS = `p.*, f.path AS path, COALESCE(p.favorite, 0) AS is_favorite`

function toPhoto(r: Row): Photo {
  const path = r.path as string
  const takenAt = (r.taken_at as string) ?? null
  const raw = (r.taken_at_raw as string) ?? null
  return {
    id: r.id as number,
    path,
    fileName: basename(path),
    ext: extname(path).toLowerCase(),
    size: r.size as number,
    takenAt,
    takenAtRaw: raw !== takenAt ? raw : null,
    dateSource: raw ? 'exif' : 'unknown',
    width: (r.width as number) ?? null,
    height: (r.height as number) ?? null,
    camera: (r.camera as string) ?? null,
    lat: (r.lat as number) ?? null,
    lon: (r.lon as number) ?? null,
    favorite: !!r.is_favorite
  }
}

export class LibraryDb {
  private db: DatabaseSync
  private correctionsCache: Correction[] | null = null
  /** Content vectors (spec 0002). */
  readonly vectors: VectorStore

  constructor(file: string) {
    // Extensions are allowed only while the vector store loads sqlite-vec (ADR 0009).
    this.db = new DatabaseSync(file, { allowExtension: true })
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.migrate()
    this.db.exec('PRAGMA foreign_keys = ON;')
    this.vectors = new VectorStore(this.db)
  }

  private migrate(): void {
    const version = (this.db.prepare('PRAGMA user_version').get() as Row).user_version as number
    if (version >= SCHEMA_VERSION) return
    const v1 = (this.db.prepare("SELECT 1 FROM pragma_table_info('photos') WHERE name = 'path'").get() as Row | undefined) !== undefined
    // Keep other tables' references to "photos" pointing at the new table while we swap it.
    this.db.exec('PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = ON;')
    this.transaction(() => {
      if (v1) this.db.exec('ALTER TABLE photos RENAME TO photos_v1')
      if (version === 2) {
        // v2 -> v3: folder-based favourites dropped (only the user's stars count); face analysis added.
        this.db.exec('UPDATE photos SET favorite = NULL WHERE favorite = 0')
        this.db.exec('ALTER TABLE photos DROP COLUMN auto_favorite')
        this.db.exec('ALTER TABLE photos ADD COLUMN faces_version INTEGER')
      }
      this.db.exec(SCHEMA)
      // v5 -> v6: offer_declines (spec 0005) is created by SCHEMA above.
      // v4 -> v5: content analysis (spec 0002). Every present photo gets analysed.
      if (!this.db.prepare("SELECT 1 FROM pragma_table_info('photos') WHERE name = 'content_version'").get()) {
        this.db.exec('ALTER TABLE photos ADD COLUMN content_version INTEGER')
      }
      if (v1) {
        // v1 had one row per file. Each becomes a photo (same id, so albums/tags still match)
        // with its file as a location. mtime 0 forces the next scan to fingerprint it; photos
        // that turn out to be copies of each other are then merged, keeping all albums/tags.
        this.db.exec(`
          INSERT INTO photos (id, hash, size, taken_at_raw, taken_at, width, height, orientation, camera, lat, lon, present)
            SELECT id, NULL, size, CASE WHEN date_source = 'exif' THEN taken_at END, CASE WHEN date_source = 'exif' THEN taken_at END,
                   width, height, orientation, camera, lat, lon, 1 - missing FROM photos_v1;
          INSERT INTO files (photo_id, path, size, mtime_ms, missing, last_seen_scan)
            SELECT id, path, size, 0, missing, last_seen_scan FROM photos_v1;
          DROP TABLE photos_v1;
        `)
      }
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
    })
    this.db.exec('PRAGMA legacy_alter_table = OFF;')
  }

  /** Closes the database (on Windows an open database file can't be moved or deleted). */
  close(): void {
    this.db.close()
  }

  private depth = 0

  /** Runs `fn` atomically. Nested calls join the outer transaction (via savepoints). */
  transaction<T>(fn: () => T): T {
    const outer = this.depth === 0
    const savepoint = `sp${this.depth}`
    this.db.exec(outer ? 'BEGIN' : `SAVEPOINT ${savepoint}`)
    this.depth++
    let result: T
    try {
      result = fn()
      this.db.exec(outer ? 'COMMIT' : `RELEASE ${savepoint}`)
    } catch (e) {
      // Also reached if COMMIT/RELEASE itself fails (disk full, I/O error): undo and pass the error on.
      try {
        this.db.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`)
      } catch {
        // Nothing left to roll back (e.g. SQLite already ended the transaction).
      }
      throw e
    } finally {
      this.depth--
    }
    return result
  }

  // --- settings ---

  getSetting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined
    return (row?.value as string) ?? null
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value)
  }

  // --- scanning ---

  /** Whether the file at `path` is already known with this size/mtime (so it needn't be re-read). */
  isUnchanged(path: string, size: number, mtimeMs: number): number | null {
    const r = this.db
      .prepare('SELECT f.id FROM files f JOIN photos p ON p.id = f.photo_id WHERE f.path = ? AND f.size = ? AND f.mtime_ms = ? AND p.hash IS NOT NULL')
      .get(path, size, mtimeMs) as Row | undefined
    return r ? (r.id as number) : null
  }

  markFileSeen(fileId: number, scanId: number): void {
    this.db.prepare('UPDATE files SET last_seen_scan = ?, missing = 0 WHERE id = ?').run(scanId, fileId)
  }

  /** Links a (new or changed) file to the photo with its content, creating or merging photos as needed. */
  recordFile(meta: FileMeta, hash: string, scanId: number): RecordOutcome {
    return this.transaction(() => {
      const file = this.db.prepare('SELECT id, photo_id FROM files WHERE path = ?').get(meta.path) as Row | undefined
      const byHash = this.db.prepare('SELECT id FROM photos WHERE hash = ?').get(hash) as Row | undefined
      let photoId: number
      let outcome: RecordOutcome

      if (byHash) {
        // Known content at this path: a move, rename, copy or (migration) first fingerprint.
        photoId = byHash.id as number
        outcome = 'relocated'
        if (file && file.photo_id !== photoId) {
          const previous = file.photo_id as number
          this.db.prepare('UPDATE files SET photo_id = ? WHERE id = ?').run(photoId, file.id as number)
          if (this.fileCount(previous) === 0) this.mergeInto(photoId, previous)
        } else if (file) {
          outcome = 'updated'
        }
      } else if (file) {
        // New content at a known path: edited in place (or a migrated row getting its hash).
        // Keep the photo (and its albums/tags) unless other copies still have the old content.
        const owner = this.db.prepare('SELECT id, hash FROM photos WHERE id = ?').get(file.photo_id as number) as Row
        if (owner.hash === null || this.fileCount(owner.id as number) === 1) {
          photoId = owner.id as number
          this.db.prepare('UPDATE photos SET hash = ? WHERE id = ?').run(hash, photoId)
          // New content: the faces and content analysis from before may no longer match it.
          if (owner.hash !== null) {
            this.resetFaces(photoId)
            this.resetContent(photoId)
          }
          // A row upgraded from v1 getting its first fingerprint is not a move; count it as updated.
          outcome = 'updated'
        } else {
          photoId = this.insertPhoto(hash, meta)
          this.db.prepare('UPDATE files SET photo_id = ? WHERE id = ?').run(photoId, file.id as number)
          outcome = 'added'
        }
      } else {
        photoId = this.insertPhoto(hash, meta)
        outcome = 'added'
      }

      this.db
        .prepare(
          `INSERT INTO files (photo_id, path, size, mtime_ms, missing, last_seen_scan) VALUES (?, ?, ?, ?, 0, ?)
           ON CONFLICT (path) DO UPDATE SET photo_id = excluded.photo_id, size = excluded.size, mtime_ms = excluded.mtime_ms, missing = 0, last_seen_scan = excluded.last_seen_scan`
        )
        .run(photoId, meta.path, meta.size, meta.mtimeMs, scanId)
      this.correctionsCache ??= this.corrections()
      const takenAt = correctedTime(meta.takenAt, meta.camera, this.correctionsCache)
      this.db
        .prepare(
          'UPDATE photos SET size = ?, taken_at_raw = ?, taken_at = ?, width = ?, height = ?, orientation = ?, camera = ?, lat = ?, lon = ?, present = 1 WHERE id = ?'
        )
        .run(meta.size, meta.takenAt, takenAt, meta.width, meta.height, meta.orientation, meta.camera, meta.lat, meta.lon, photoId)
      return outcome
    })
  }

  private insertPhoto(hash: string, meta: FileMeta): number {
    const r = this.db.prepare('INSERT INTO photos (hash, size, present) VALUES (?, ?, 1) RETURNING id').get(hash, meta.size) as Row
    return r.id as number
  }

  private fileCount(photoId: number): number {
    return (this.db.prepare('SELECT count(*) AS n FROM files WHERE photo_id = ?').get(photoId) as Row).n as number
  }

  /** Moves albums, tags and an explicit favourite from `dropId` onto `keepId`, then deletes `dropId`. */
  private mergeInto(keepId: number, dropId: number): void {
    this.db
      .prepare('INSERT OR IGNORE INTO album_photos (album_id, photo_id, added_at) SELECT album_id, ?, added_at FROM album_photos WHERE photo_id = ?')
      .run(keepId, dropId)
    this.db.prepare('INSERT OR IGNORE INTO photo_tags (photo_id, tag_id) SELECT ?, tag_id FROM photo_tags WHERE photo_id = ?').run(keepId, dropId)
    this.db.prepare('UPDATE photos SET favorite = COALESCE(favorite, (SELECT favorite FROM photos WHERE id = ?)) WHERE id = ?').run(dropId, keepId)
    this.db
      .prepare(
        'INSERT OR IGNORE INTO suggestion_decision_photos (decision_id, photo_id) SELECT decision_id, ? FROM suggestion_decision_photos WHERE photo_id = ?'
      )
      .run(keepId, dropId)
    // Same content, so the same faces: keep whichever copy has them analysed (and named).
    if (!this.db.prepare('SELECT 1 FROM faces WHERE photo_id = ?').get(keepId)) {
      this.db.prepare('UPDATE faces SET photo_id = ? WHERE photo_id = ?').run(keepId, dropId)
      this.db.prepare('UPDATE photos SET faces_version = (SELECT faces_version FROM photos WHERE id = ?) WHERE id = ?').run(dropId, keepId)
    }
    if (!this.db.prepare('SELECT 1 FROM photos WHERE id = ? AND content_version IS NOT NULL').get(keepId)) {
      this.db.prepare('UPDATE content_vectors SET photo_id = ? WHERE photo_id = ?').run(keepId, dropId)
      this.db.prepare('UPDATE photos SET content_version = (SELECT content_version FROM photos WHERE id = ?) WHERE id = ?').run(dropId, keepId)
    }
    this.db.prepare('DELETE FROM photos WHERE id = ?').run(dropId)
  }

  /** Flags every location not seen in this scan (including ones under a previous base folder). */
  markMissing(scanId: number): void {
    this.db.prepare('UPDATE files SET missing = 1 WHERE last_seen_scan IS NOT ? AND missing = 0').run(scanId)
  }

  /**
   * Forgets locations matching `exclude` (files in ignored folders), and photos left with
   * no locations at all, including their faces, names and tags. Files on disk are untouched.
   * Returns what was forgotten so cached thumbnails and face crops can be removed too.
   */
  forgetFiles(exclude: (path: string) => boolean): Forgotten {
    const rows = this.db.prepare('SELECT id, path FROM files').all() as Row[]
    const ids = rows.filter((r) => exclude(r.path as string)).map((r) => r.id as number)
    return this.transaction(() => {
      // Suggestion decisions involving any photo with a copy in an ignored folder are forgotten,
      // even if the photo survives through another copy: their names may come from that folder (ADR 0007).
      const forgetDecision = this.db.prepare(
        'DELETE FROM suggestion_decisions WHERE id IN (SELECT dp.decision_id FROM suggestion_decision_photos dp JOIN files f ON f.photo_id = dp.photo_id WHERE f.id = ?)'
      )
      ids.forEach((id) => forgetDecision.run(id))
      const forgetDecline = this.db.prepare('DELETE FROM offer_declines WHERE photo_id IN (SELECT photo_id FROM files WHERE id = ?)')
      ids.forEach((id) => forgetDecline.run(id))
      const del = this.db.prepare('DELETE FROM files WHERE id = ?')
      ids.forEach((id) => del.run(id))
      return this.deletePhotosWhere('NOT EXISTS (SELECT 1 FROM files WHERE photo_id = photos.id)')
    })
  }

  private deletePhotosWhere(condition: string): Forgotten {
    const hashes = (this.db.prepare(`SELECT hash FROM photos WHERE ${condition}`).all() as Row[]).map((r) => r.hash as string).filter(Boolean)
    const faceIds = (this.db.prepare(`SELECT id FROM faces WHERE photo_id IN (SELECT id FROM photos WHERE ${condition})`).all() as Row[]).map(
      (r) => r.id as number
    )
    // Any suggestion decision that involved a forgotten photo goes too, with its name, which may
    // come from a private folder (ADR 0007). Albums are untouched: an accepted suggestion stays
    // hidden because its photos are in the album.
    this.db.exec(
      `DELETE FROM suggestion_decisions WHERE id IN (SELECT decision_id FROM suggestion_decision_photos WHERE photo_id IN (SELECT id FROM photos WHERE ${condition}))`
    )
    this.db.exec(`DELETE FROM photos WHERE ${condition}`)
    return { hashes, faceIds }
  }

  /**
   * Forgets photos that are no longer found anywhere: their records, albums/tags links and
   * (via the returned hashes) cached thumbnails. Never touches files on disk.
   */
  forgetMissing(): Forgotten {
    return this.transaction(() => this.deletePhotosWhere('present = 0'))
  }

  /** Recomputes what depends on locations and settings: presence and corrected dates. */
  refreshDerived(): void {
    const corrections = this.corrections()
    const photos = this.db.prepare('SELECT id, camera, taken_at_raw FROM photos').all() as Row[]
    const present = new Set((this.db.prepare('SELECT DISTINCT photo_id FROM files WHERE missing = 0').all() as Row[]).map((f) => f.photo_id as number))
    const update = this.db.prepare('UPDATE photos SET present = ?, taken_at = ? WHERE id = ?')
    this.transaction(() => {
      for (const p of photos) {
        const id = p.id as number
        const taken = correctedTime((p.taken_at_raw as string) ?? null, (p.camera as string) ?? null, corrections)
        update.run(present.has(id) ? 1 : 0, taken, id)
      }
    })
  }

  counts(): { photoCount: number; missingCount: number; favoriteCount: number; undatedCount: number } {
    const r = this.db
      .prepare(
        `SELECT sum(present = 1) AS present, sum(present = 0) AS missing,
                sum(present = 1 AND favorite = 1) AS favs,
                sum(present = 1 AND taken_at IS NULL) AS undated FROM photos`
      )
      .get() as Row
    return {
      photoCount: Number(r.present ?? 0),
      missingCount: Number(r.missing ?? 0),
      favoriteCount: Number(r.favs ?? 0),
      undatedCount: Number(r.undated ?? 0)
    }
  }

  // --- browsing ---

  getThumbSource(id: number): ThumbSource | null {
    const r = this.db.prepare(`SELECT p.id, p.hash, p.orientation, f.path FROM photos p JOIN files f ON f.id = ${PRIMARY_FILE} WHERE p.id = ?`).get(id) as
      Row | undefined
    if (!r) return null
    const path = r.path as string
    return { id: r.id as number, hash: (r.hash as string) ?? null, path, ext: extname(path).toLowerCase(), orientation: (r.orientation as number) ?? null }
  }

  /**
   * Conditions on photos `p` for a view: `base` (present, dates, album, …), and `terms`, one per
   * search word, each matching a folder/file name (below the base folder), an album, a tag or a person.
   */
  private photoConditions(filter: PhotoFilter, eventPhotoIds?: number[]): { base: string[]; baseParams: SqlValue[]; terms: string[]; termParams: SqlValue[] } {
    const base: string[] = ['p.present = 1']
    const baseParams: SqlValue[] = []

    const parsed = filter.text ? parseSearch(filter.text) : { terms: [] as string[] }
    const year = filter.year ?? parsed.year
    const month = filter.month ?? parsed.month

    if (year) {
      base.push('substr(p.taken_at, 1, 4) = ?')
      baseParams.push(year)
    }
    if (month) {
      base.push('substr(p.taken_at, 6, 2) = ?')
      baseParams.push(month)
    }
    if (filter.undated) base.push('p.taken_at IS NULL')
    if (filter.favorites) base.push('p.favorite = 1')
    if (filter.albumId != null) {
      base.push('p.id IN (SELECT photo_id FROM album_photos WHERE album_id = ?)')
      baseParams.push(filter.albumId)
    }
    if (filter.tagId != null) {
      base.push('p.id IN (SELECT photo_id FROM photo_tags WHERE tag_id = ?)')
      baseParams.push(filter.tagId)
    }
    if (filter.personId != null) {
      base.push('p.id IN (SELECT photo_id FROM faces WHERE person_id = ?)')
      baseParams.push(filter.personId)
    }
    if (eventPhotoIds) {
      base.push('p.id IN (SELECT value FROM json_each(?))')
      baseParams.push(JSON.stringify(eventPhotoIds))
    }
    const terms: string[] = []
    const termParams: SqlValue[] = []
    const basePath = this.getSetting('basePath') ?? ''
    for (const term of parsed.terms) {
      const like = `%${term.replace(/[\\%_]/g, (c) => '\\' + c)}%`
      terms.push(`(
        p.id IN (SELECT photo_id FROM files WHERE missing = 0 AND substr(path, ?) LIKE ? ESCAPE '\\')
        OR p.id IN (SELECT ap.photo_id FROM album_photos ap JOIN albums a ON a.id = ap.album_id WHERE a.name LIKE ? ESCAPE '\\')
        OR p.id IN (SELECT pt.photo_id FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id WHERE t.name LIKE ? ESCAPE '\\')
        OR p.id IN (SELECT f.photo_id FROM faces f JOIN people pe ON pe.id = f.person_id WHERE pe.name LIKE ? ESCAPE '\\')
      )`)
      termParams.push(basePath.length + 2, like, like, like, like)
    }
    return { base, baseParams, terms, termParams }
  }

  /** The view's photos, newest first. For a search, these are its name matches (spec 0002). */
  queryPhotos(filter: PhotoFilter, eventPhotoIds?: number[]): PhotoPage {
    const c = this.photoConditions(filter, eventPhotoIds)
    const whereSql = [...c.base, ...c.terms].join(' AND ')
    const params = [...c.baseParams, ...c.termParams]
    const total = (this.db.prepare(`SELECT count(*) AS n FROM photos p WHERE ${whereSql}`).get(...params) as Row).n as number
    const rows = this.db
      .prepare(
        `SELECT ${PHOTO_COLUMNS} FROM photos p JOIN files f ON f.id = ${PRIMARY_FILE}
         WHERE ${whereSql} ORDER BY p.taken_at IS NULL, p.taken_at DESC, f.path LIMIT ? OFFSET ?`
      )
      .all(...params, filter.limit ?? 200, filter.offset ?? 0) as Row[]
    return { photos: rows.map(toPhoto), total }
  }

  /** Splits a search into dates, people and the content phrase, using the names of people in the library. */
  searchPlan(text: string): SearchPlan {
    const people = (this.db.prepare('SELECT id, name FROM people').all() as Row[]).map((r) => ({ id: r.id as number, name: r.name as string }))
    return splitSearch(text, people)
  }

  /**
   * A search's content matches (spec 0002): photos in the view, of every person named in the
   * search, analysed by the current model and similar enough to the phrase, best first. Name
   * matches (queryPhotos) are left out, so each photo is listed once.
   */
  contentMatches(filter: PhotoFilter, eventPhotoIds: number[] | undefined, plan: SearchPlan, content: ContentQuery): number[] {
    const c = this.photoConditions(filter, eventPhotoIds)
    const where = [...c.base, 'p.content_version = ?']
    const params: SqlValue[] = [...c.baseParams, content.version]
    for (const ids of plan.personIds) {
      where.push('p.id IN (SELECT photo_id FROM faces WHERE person_id IN (SELECT value FROM json_each(?)))')
      params.push(JSON.stringify(ids))
    }
    if (c.terms.length) {
      where.push(`NOT (${c.terms.join(' AND ')})`)
      params.push(...c.termParams)
    }
    return this.vectors.search(content.vector, content.minScore, where.join(' AND '), params).map((m) => m.id)
  }

  /** Present photos with these ids, in the given order. */
  photosByIds(ids: number[]): Photo[] {
    if (ids.length === 0) return []
    const rows = this.db
      .prepare(`SELECT ${PHOTO_COLUMNS} FROM photos p JOIN files f ON f.id = ${PRIMARY_FILE} WHERE p.present = 1 AND p.id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(ids)) as Row[]
    const byId = new Map(rows.map((r) => [r.id as number, toPhoto(r)]))
    return ids.flatMap((id) => byId.get(id) ?? [])
  }

  getPhoto(id: number): PhotoDetails | null {
    const r = this.db.prepare(`SELECT ${PHOTO_COLUMNS} FROM photos p JOIN files f ON f.id = ${PRIMARY_FILE} WHERE p.id = ?`).get(id) as Row | undefined
    if (!r) return null
    const albums = this.db
      .prepare('SELECT a.id, a.name FROM albums a JOIN album_photos ap ON ap.album_id = a.id WHERE ap.photo_id = ? ORDER BY a.name')
      .all(id) as Row[]
    const tags = this.db
      .prepare('SELECT t.id, t.name FROM tags t JOIN photo_tags pt ON pt.tag_id = t.id WHERE pt.photo_id = ? ORDER BY t.name')
      .all(id) as Row[]
    const locations = this.db.prepare('SELECT path FROM files WHERE photo_id = ? AND missing = 0 ORDER BY path').all(id) as Row[]
    const faces = this.db
      .prepare(
        'SELECT f.id, f.person_id, pe.name, f.assigned_by, f.x, f.y, f.w, f.h FROM faces f LEFT JOIN people pe ON pe.id = f.person_id WHERE f.photo_id = ? ORDER BY f.x'
      )
      .all(id) as Row[]
    return {
      ...toPhoto(r),
      albums: albums.map((a) => ({ id: a.id as number, name: a.name as string })),
      tags: tags.map((t) => ({ id: t.id as number, name: t.name as string })),
      locations: locations.map((l) => l.path as string),
      faces: faces.map((f) => ({
        id: f.id as number,
        personId: (f.person_id as number) ?? null,
        name: (f.name as string) ?? null,
        auto: f.assigned_by === 'auto',
        x: f.x as number,
        y: f.y as number,
        w: f.w as number,
        h: f.h as number
      }))
    }
  }

  getTimeline(): TimelineMonth[] {
    const rows = this.db
      .prepare(
        `SELECT substr(taken_at, 1, 4) AS year, substr(taken_at, 6, 2) AS month, count(*) AS count
         FROM photos WHERE present = 1 AND taken_at IS NOT NULL
         GROUP BY year, month ORDER BY year DESC, month DESC`
      )
      .all() as Row[]
    return rows.map((r) => ({ year: r.year as string, month: r.month as string, count: r.count as number }))
  }

  /** Present photos with their folders, for event detection and clock-error detection. */
  photosForOrganising(basePath: string): PhotoForOrganising[] {
    const rows = this.db.prepare('SELECT id, camera, taken_at, taken_at_raw, COALESCE(favorite, 0) AS fav FROM photos WHERE present = 1').all() as Row[]
    const dirs = new Map<number, string[]>()
    for (const f of this.db.prepare('SELECT photo_id, path FROM files WHERE missing = 0').all() as Row[]) {
      const id = f.photo_id as number
      const dir = dirname(relative(basePath, f.path as string))
        .split(sep)
        .join('/')
      const list = dirs.get(id)
      if (list) list.push(dir)
      else dirs.set(id, [dir])
    }
    return rows.map((r) => ({
      id: r.id as number,
      camera: (r.camera as string) ?? null,
      takenAt: (r.taken_at as string) ?? null,
      takenAtRaw: (r.taken_at_raw as string) ?? null,
      favorite: !!r.fav,
      dirs: dirs.get(r.id as number) ?? []
    }))
  }

  setFavorite(photoIds: number[], favorite: boolean): void {
    const stmt = this.db.prepare('UPDATE photos SET favorite = ? WHERE id = ?')
    this.transaction(() => photoIds.forEach((id) => stmt.run(favorite ? 1 : 0, id)))
  }

  // --- faces & people ---

  private resetFaces(photoId: number): void {
    this.db.prepare('DELETE FROM faces WHERE photo_id = ?').run(photoId)
    this.db.prepare('UPDATE photos SET faces_version = NULL WHERE id = ?').run(photoId)
  }

  faceProgress(version: number): { done: number; total: number } {
    const r = this.db.prepare('SELECT count(*) AS total, sum(faces_version >= ?) AS done FROM photos WHERE present = 1').get(version) as Row
    return { done: Number(r.done ?? 0), total: Number(r.total ?? 0) }
  }

  // --- content analysis (spec 0002) ---

  private resetContent(photoId: number): void {
    this.db.prepare('DELETE FROM content_vectors WHERE photo_id = ?').run(photoId)
    this.db.prepare('UPDATE photos SET content_version = NULL WHERE id = ?').run(photoId)
  }

  /**
   * Present photos that still need faces and/or content analysed with these versions (null:
   * that analysis isn't running), newest first.
   */
  photosNeedingAnalysis(versions: { faces: number | null; content: number | null }, limit: number): AnalysisSource[] {
    const faces = versions.faces === null ? '0' : '(p.faces_version IS NULL OR p.faces_version < ?)'
    const content = versions.content === null ? '0' : 'p.content_version IS NOT ?'
    const params = [versions.faces, versions.content].filter((v) => v !== null)
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT p.id, p.hash, p.orientation, p.taken_at, f.path, ${faces} AS needs_faces, ${content} AS needs_content
           FROM photos p JOIN files f ON f.id = ${PRIMARY_FILE} WHERE p.present = 1
         ) WHERE needs_faces OR needs_content
         ORDER BY taken_at IS NULL, taken_at DESC, id LIMIT ?`
      )
      .all(...params, limit) as Row[]
    return rows.map((r) => ({
      id: r.id as number,
      hash: (r.hash as string) ?? null,
      path: r.path as string,
      ext: extname(r.path as string).toLowerCase(),
      orientation: (r.orientation as number) ?? null,
      needsFaces: !!r.needs_faces,
      needsContent: !!r.needs_content
    }))
  }

  /** Present photos analysed by this content model version, of all present photos. */
  contentProgress(version: number): { done: number; total: number } {
    const r = this.db.prepare('SELECT count(*) AS total, sum(content_version IS ?) AS done FROM photos WHERE present = 1').get(version) as Row
    return { done: Number(r.done ?? 0), total: Number(r.total ?? 0) }
  }

  /** True when a present photo was analysed by another content model version, i.e. an upgrade is under way. */
  hasOtherContentVersion(version: number): boolean {
    return !!this.db.prepare('SELECT 1 FROM photos WHERE present = 1 AND content_version IS NOT NULL AND content_version IS NOT ?').get(version)
  }

  /** Records a photo's content analysis; `vector` is null when the photo couldn't be read (it isn't retried). */
  saveContent(photoId: number, vector: Float32Array | null, version: number): void {
    this.transaction(() => {
      this.vectors.save(photoId, vector)
      this.db.prepare('UPDATE photos SET content_version = ? WHERE id = ?').run(version, photoId)
    })
  }

  /** Replaces a photo's faces with a fresh analysis. Returns the new face ids, in order. */
  saveFaces(
    photoId: number,
    faces: { x: number; y: number; w: number; h: number; score: number; embedding: Float32Array | null }[],
    version: number
  ): number[] {
    return this.transaction(() => {
      this.db.prepare('DELETE FROM faces WHERE photo_id = ?').run(photoId)
      const insert = this.db.prepare('INSERT INTO faces (photo_id, x, y, w, h, score, embedding) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id')
      const ids = faces.map(
        (f) =>
          (
            insert.get(
              photoId,
              f.x,
              f.y,
              f.w,
              f.h,
              f.score,
              f.embedding ? new Uint8Array(f.embedding.buffer, f.embedding.byteOffset, f.embedding.byteLength) : null
            ) as Row
          ).id as number
      )
      this.db.prepare('UPDATE photos SET faces_version = ? WHERE id = ?').run(version, photoId)
      return ids
    })
  }

  /** Everything needed to (re)group faces: faces not confirmed by the user, people's confirmed faces, and rejections. */
  groupingInput(): { open: FaceVector[]; people: KnownPerson[]; rejected: Set<string> } {
    const rows = this.db
      .prepare(
        `SELECT f.id, f.embedding, f.score, f.person_id, f.assigned_by FROM faces f JOIN photos p ON p.id = f.photo_id
         WHERE f.embedding IS NOT NULL AND p.present = 1`
      )
      .all() as Row[]
    const open: FaceVector[] = []
    const people = new Map<number, Float32Array[]>()
    for (const r of rows) {
      const bytes = r.embedding as Uint8Array
      const embedding = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
      if (r.assigned_by === 'user') {
        const id = r.person_id as number
        people.set(id, [...(people.get(id) ?? []), embedding])
      } else {
        open.push({ id: r.id as number, embedding, score: r.score as number })
      }
    }
    const rejected = new Set((this.db.prepare('SELECT face_id, person_id FROM face_rejections').all() as Row[]).map((r) => `${r.face_id}:${r.person_id}`))
    return { open, people: [...people].map(([id, embeddings]) => ({ id, embeddings })), rejected }
  }

  /** Stores automatic matches (replacing previous ones) and the new groups of unnamed faces. */
  applyGrouping(matches: Map<number, number>, groups: Map<number, number>): void {
    this.transaction(() => {
      this.db.exec("UPDATE faces SET person_id = NULL, assigned_by = NULL WHERE assigned_by = 'auto'")
      this.db.exec('UPDATE faces SET cluster = NULL')
      const match = this.db.prepare("UPDATE faces SET person_id = ?, assigned_by = 'auto' WHERE id = ?")
      for (const [faceId, personId] of matches) match.run(personId, faceId)
      const group = this.db.prepare('UPDATE faces SET cluster = ? WHERE id = ?')
      for (const [faceId, n] of groups) group.run(n, faceId)
    })
  }

  listPeople(): Person[] {
    const rows = this.db
      .prepare(
        `SELECT pe.id, pe.name, count(DISTINCT CASE WHEN p.present = 1 THEN f.photo_id END) AS photo_count,
           (SELECT f2.id FROM faces f2 WHERE f2.person_id = pe.id ORDER BY f2.assigned_by = 'user' DESC, f2.score * f2.w DESC LIMIT 1) AS cover
         FROM people pe LEFT JOIN faces f ON f.person_id = pe.id LEFT JOIN photos p ON p.id = f.photo_id
         GROUP BY pe.id ORDER BY photo_count DESC, pe.name COLLATE NOCASE`
      )
      .all() as Row[]
    return rows.map((r) => ({ id: r.id as number, name: r.name as string, photoCount: r.photo_count as number, coverFaceId: (r.cover as number) ?? null }))
  }

  /** Unnamed groups with at least `minFaces` faces, largest first. */
  listFaceGroups(minFaces = 2): FaceGroup[] {
    const groups = this.db
      .prepare(
        `SELECT f.cluster, count(*) AS faces, count(DISTINCT f.photo_id) AS photos FROM faces f JOIN photos p ON p.id = f.photo_id
         WHERE f.cluster IS NOT NULL AND f.person_id IS NULL AND p.present = 1
         GROUP BY f.cluster HAVING faces >= ? ORDER BY faces DESC`
      )
      .all(minFaces) as Row[]
    const samples = this.db.prepare('SELECT id FROM faces WHERE cluster = ? AND person_id IS NULL ORDER BY score * w DESC LIMIT 8')
    return groups.map((g) => {
      const ids = (samples.all(g.cluster as number) as Row[]).map((r) => r.id as number)
      return { id: ids[0], faceCount: g.faces as number, photoCount: g.photos as number, sampleFaceIds: ids }
    })
  }

  /** The person with this name (case-insensitive), created if needed. */
  personNamed(name: string): number {
    this.db.prepare('INSERT OR IGNORE INTO people (name) VALUES (?)').run(name)
    return (this.db.prepare('SELECT id FROM people WHERE name = ?').get(name) as Row).id as number
  }

  /** Faces in the same unnamed group as `faceId` (or just that face if it has none). */
  groupMates(faceId: number): number[] {
    const r = this.db.prepare('SELECT cluster FROM faces WHERE id = ?').get(faceId) as Row | undefined
    if (!r || r.cluster === null) return [faceId]
    return (this.db.prepare('SELECT id FROM faces WHERE cluster = ? AND person_id IS NULL').all(r.cluster as number) as Row[]).map((x) => x.id as number)
  }

  confirmFaces(faceIds: number[], personId: number): void {
    const assign = this.db.prepare("UPDATE faces SET person_id = ?, assigned_by = 'user', cluster = NULL WHERE id = ?")
    const unreject = this.db.prepare('DELETE FROM face_rejections WHERE face_id = ? AND person_id = ?')
    this.transaction(() =>
      faceIds.forEach((id) => {
        assign.run(personId, id)
        unreject.run(id, personId)
      })
    )
  }

  personFaces(personId: number): PersonFace[] {
    const rows = this.db
      .prepare(
        `SELECT f.id, f.photo_id, f.assigned_by FROM faces f JOIN photos p ON p.id = f.photo_id
         WHERE f.person_id = ? AND p.present = 1 ORDER BY f.assigned_by = 'auto' DESC, p.taken_at DESC`
      )
      .all(personId) as Row[]
    return rows.map((r) => ({ id: r.id as number, photoId: r.photo_id as number, auto: r.assigned_by === 'auto' }))
  }

  rejectFace(faceId: number): void {
    const r = this.db.prepare('SELECT person_id FROM faces WHERE id = ?').get(faceId) as Row | undefined
    if (!r || r.person_id === null) return
    this.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO face_rejections (face_id, person_id) VALUES (?, ?)').run(faceId, r.person_id as number)
      this.db.prepare('UPDATE faces SET person_id = NULL, assigned_by = NULL WHERE id = ?').run(faceId)
    })
  }

  /** Renames a person; if another person already has that name, the two are merged. */
  renamePerson(id: number, name: string): void {
    const other = this.db.prepare('SELECT id FROM people WHERE name = ? AND id != ?').get(name, id) as Row | undefined
    this.transaction(() => {
      if (other) {
        this.db.prepare('UPDATE faces SET person_id = ? WHERE person_id = ?').run(other.id as number, id)
        this.db.prepare('UPDATE OR IGNORE face_rejections SET person_id = ? WHERE person_id = ?').run(other.id as number, id)
        this.db.prepare('DELETE FROM people WHERE id = ?').run(id)
      } else {
        this.db.prepare('UPDATE people SET name = ? WHERE id = ?').run(name, id)
      }
    })
  }

  deletePerson(id: number): void {
    this.transaction(() => {
      this.db.prepare('UPDATE faces SET person_id = NULL, assigned_by = NULL WHERE person_id = ?').run(id)
      this.db.prepare('DELETE FROM people WHERE id = ?').run(id)
    })
  }

  // --- suggested albums ---

  /** Records an accept or dismiss of a suggestion; returns its id. */
  recordDecision(kind: 'accepted' | 'dismissed', name: string, photoIds: number[], albumId: number | null): number {
    return this.transaction(() => {
      const id = (this.db.prepare('INSERT INTO suggestion_decisions (kind, name, album_id) VALUES (?, ?, ?) RETURNING id').get(kind, name, albumId) as Row)
        .id as number
      const add = this.db.prepare('INSERT OR IGNORE INTO suggestion_decision_photos (decision_id, photo_id) VALUES (?, ?)')
      photoIds.forEach((p) => add.run(id, p))
      return id
    })
  }

  deleteDecision(id: number): void {
    this.db.prepare('DELETE FROM suggestion_decisions WHERE id = ?').run(id)
  }

  /** Every decision's photos (including missing ones, so decisions hold when they come back). */
  decisionPhotoSets(): { id: number; photoIds: number[] }[] {
    return this.photoSets('SELECT decision_id AS id, photo_id FROM suggestion_decision_photos')
  }

  /** Every album's present photos. */
  albumPhotoSets(): { id: number; photoIds: number[] }[] {
    return this.photoSets('SELECT ap.album_id AS id, ap.photo_id FROM album_photos ap JOIN photos p ON p.id = ap.photo_id WHERE p.present = 1')
  }

  private photoSets(sql: string): { id: number; photoIds: number[] }[] {
    const sets = new Map<number, number[]>()
    for (const r of this.db.prepare(sql).all() as Row[]) {
      const id = r.id as number
      const list = sets.get(id)
      if (list) list.push(r.photo_id as number)
      else sets.set(id, [r.photo_id as number])
    }
    return [...sets].map(([id, photoIds]) => ({ id, photoIds }))
  }

  /** Capture times of photos currently missing (e.g. on an unplugged drive). */
  missingCaptureTimes(): string[] {
    return (this.db.prepare('SELECT taken_at FROM photos WHERE present = 0 AND taken_at IS NOT NULL').all() as Row[]).map((r) => r.taken_at as string)
  }

  dismissedCount(): number {
    return (this.db.prepare("SELECT count(*) AS n FROM suggestion_decisions WHERE kind = 'dismissed'").get() as Row).n as number
  }

  /** Dismissed suggestions (counting present photos; all may be missing), newest first. */
  listDismissed(): { id: number; name: string; photoCount: number; start: string | null; end: string | null; coverId: number | null }[] {
    const rows = this.db
      .prepare(
        `SELECT d.id, d.name, count(p.id) AS photo_count, min(p.taken_at) AS start, max(p.taken_at) AS end, min(p.id) AS cover
         FROM suggestion_decisions d
         JOIN suggestion_decision_photos dp ON dp.decision_id = d.id
         LEFT JOIN photos p ON p.id = dp.photo_id AND p.present = 1
         WHERE d.kind = 'dismissed'
         GROUP BY d.id ORDER BY d.id DESC`
      )
      .all() as Row[]
    return rows.map((r) => ({
      id: r.id as number,
      name: r.name as string,
      photoCount: r.photo_count as number,
      start: (r.start as string) ?? null,
      end: (r.end as string) ?? null,
      coverId: (r.cover as number) ?? null
    }))
  }

  // --- new photos for an album (spec 0005) ---

  /** Albums made from suggestions: their name and every photo of their accepted decisions (missing ones too) with capture times. */
  offerSources(): { albumId: number; name: string; photoIds: number[]; times: string[] }[] {
    const rows = this.db
      .prepare(
        `SELECT a.id AS album_id, a.name, dp.photo_id, p.taken_at
         FROM suggestion_decisions d
         JOIN albums a ON a.id = d.album_id
         JOIN suggestion_decision_photos dp ON dp.decision_id = d.id
         JOIN photos p ON p.id = dp.photo_id
         WHERE d.kind = 'accepted'`
      )
      .all() as Row[]
    const byAlbum = new Map<number, { albumId: number; name: string; photoIds: number[]; times: string[] }>()
    for (const r of rows) {
      const id = r.album_id as number
      let a = byAlbum.get(id)
      if (!a) byAlbum.set(id, (a = { albumId: id, name: r.name as string, photoIds: [], times: [] }))
      a.photoIds.push(r.photo_id as number)
      if (r.taken_at) a.times.push(r.taken_at as string)
    }
    return [...byAlbum.values()]
  }

  /** Photos declined per album. */
  offerDeclines(): Map<number, Set<number>> {
    const declined = new Map<number, Set<number>>()
    for (const r of this.db.prepare('SELECT album_id, photo_id FROM offer_declines').all() as Row[]) {
      const id = r.album_id as number
      const set = declined.get(id)
      if (set) set.add(r.photo_id as number)
      else declined.set(id, new Set([r.photo_id as number]))
    }
    return declined
  }

  addOfferDeclines(albumId: number, photoIds: number[]): void {
    this.transaction(() => {
      const add = this.db.prepare('INSERT OR IGNORE INTO offer_declines (album_id, photo_id) VALUES (?, ?)')
      photoIds.forEach((p) => add.run(albumId, p))
    })
  }

  removeOfferDeclines(albumId: number, photoIds: number[]): void {
    this.transaction(() => {
      const del = this.db.prepare('DELETE FROM offer_declines WHERE album_id = ? AND photo_id = ?')
      photoIds.forEach((p) => del.run(albumId, p))
    })
  }

  /** Adds photos to the album and to its source decision, so removing one later doesn't make it "new" again. */
  addOfferedToAlbum(albumId: number, photoIds: number[]): void {
    this.transaction(() => {
      const d = this.db.prepare("SELECT id FROM suggestion_decisions WHERE album_id = ? AND kind = 'accepted' ORDER BY id LIMIT 1").get(albumId) as
        Row | undefined
      if (!d) throw new Error('That album is no longer offered new photos.')
      this.addToAlbum(albumId, photoIds)
      const add = this.db.prepare('INSERT OR IGNORE INTO suggestion_decision_photos (decision_id, photo_id) VALUES (?, ?)')
      photoIds.forEach((p) => add.run(d.id as number, p))
    })
  }

  // --- event merges/renames (pre-0001; only read to convert old merges into albums) ---

  eventGroups(): EventGroup[] {
    const rows = this.db.prepare('SELECT * FROM event_groups ORDER BY id').all() as Row[]
    return rows.map((r) => ({
      id: r.id as number,
      name: r.name as string,
      start: (r.start as string) ?? null,
      end: (r.end as string) ?? null,
      members: JSON.parse(r.members as string) as string[]
    }))
  }

  addEventGroup(g: Omit<EventGroup, 'id'>): number {
    const r = this.db
      .prepare('INSERT INTO event_groups (name, start, end, members) VALUES (?, ?, ?, ?) RETURNING id')
      .get(g.name, g.start, g.end, JSON.stringify(g.members)) as Row
    return r.id as number
  }

  deleteEventGroup(id: number): void {
    this.db.prepare('DELETE FROM event_groups WHERE id = ?').run(id)
  }

  // --- clock corrections ---

  corrections(): (Correction & { id: number })[] {
    const rows = this.db.prepare('SELECT * FROM clock_corrections ORDER BY id').all() as Row[]
    return rows.map((r) => ({
      id: r.id as number,
      camera: r.camera as string,
      appliesBefore: (r.applies_before as string) ?? null,
      offsetYears: r.offset_years as number,
      offsetSeconds: r.offset_seconds as number
    }))
  }

  correctionPhotoCount(c: Correction): number {
    const rows = this.db.prepare('SELECT camera, taken_at_raw FROM photos WHERE present = 1 AND camera = ?').all(c.camera) as Row[]
    return rows.filter((r) => correctionApplies(c, r.camera as string, (r.taken_at_raw as string) ?? null)).length
  }

  addCorrection(c: Correction): void {
    this.correctionsCache = null
    // One correction per camera and period; a new one replaces an identical-range one.
    this.db.prepare('DELETE FROM clock_corrections WHERE camera = ? AND applies_before IS ?').run(c.camera, c.appliesBefore)
    this.db
      .prepare('INSERT INTO clock_corrections (camera, applies_before, offset_years, offset_seconds) VALUES (?, ?, ?, ?)')
      .run(c.camera, c.appliesBefore, c.offsetYears, c.offsetSeconds)
  }

  removeCorrection(id: number): void {
    this.correctionsCache = null
    this.db.prepare('DELETE FROM clock_corrections WHERE id = ?').run(id)
  }

  cameras(): string[] {
    const rows = this.db.prepare('SELECT DISTINCT camera FROM photos WHERE present = 1 AND camera IS NOT NULL ORDER BY camera').all() as Row[]
    return rows.map((r) => r.camera as string)
  }

  // --- albums (virtual folders) ---

  listAlbums(): Album[] {
    const rows = this.db
      .prepare(
        `SELECT a.id, a.parent_id, a.name, count(p.id) AS photo_count,
           EXISTS (SELECT 1 FROM suggestion_decisions d WHERE d.album_id = a.id) AS from_suggestion
         FROM albums a
         LEFT JOIN album_photos ap ON ap.album_id = a.id
         LEFT JOIN photos p ON p.id = ap.photo_id AND p.present = 1
         GROUP BY a.id ORDER BY a.name COLLATE NOCASE`
      )
      .all() as Row[]
    return rows.map((r) => ({
      id: r.id as number,
      parentId: (r.parent_id as number) ?? null,
      name: r.name as string,
      photoCount: r.photo_count as number,
      fromSuggestion: !!r.from_suggestion
    }))
  }

  createAlbum(name: string, parentId: number | null): Album {
    const r = this.db.prepare('INSERT INTO albums (name, parent_id) VALUES (?, ?) RETURNING id').get(name, parentId) as Row
    return { id: r.id as number, parentId, name, photoCount: 0 }
  }

  renameAlbum(id: number, name: string): void {
    this.db.prepare('UPDATE albums SET name = ? WHERE id = ?').run(name, id)
  }

  /** Moves an album under `parentId` (null = top level). Refuses itself, its descendants and unknown targets. */
  moveAlbum(id: number, parentId: number | null): boolean {
    if (parentId != null) {
      if (!this.db.prepare('SELECT 1 FROM albums WHERE id = ?').get(parentId)) return false
      // Walk up from the target: meeting `id` means the target is inside the album.
      for (let at: number | null = parentId; at != null;) {
        if (at === id) return false
        at = ((this.db.prepare('SELECT parent_id FROM albums WHERE id = ?').get(at) as Row | undefined)?.parent_id as number | null) ?? null
      }
    }
    this.db.prepare('UPDATE albums SET parent_id = ? WHERE id = ?').run(parentId, id)
    return true
  }

  /** Deletes the album record; its sub-albums move up one level. Photos themselves are untouched. */
  deleteAlbum(id: number): void {
    this.transaction(() => {
      this.db.prepare('UPDATE albums SET parent_id = (SELECT parent_id FROM albums WHERE id = ?) WHERE parent_id = ?').run(id, id)
      this.db.prepare('DELETE FROM albums WHERE id = ?').run(id)
    })
  }

  addToAlbum(albumId: number, photoIds: number[]): void {
    const stmt = this.db.prepare('INSERT OR IGNORE INTO album_photos (album_id, photo_id) VALUES (?, ?)')
    this.transaction(() => photoIds.forEach((pid) => stmt.run(albumId, pid)))
  }

  removeFromAlbum(albumId: number, photoIds: number[]): void {
    const stmt = this.db.prepare('DELETE FROM album_photos WHERE album_id = ? AND photo_id = ?')
    this.transaction(() => photoIds.forEach((pid) => stmt.run(albumId, pid)))
  }

  // --- tags ---

  listTags(): Tag[] {
    const rows = this.db
      .prepare(
        `SELECT t.id, t.name, count(p.id) AS photo_count FROM tags t
         LEFT JOIN photo_tags pt ON pt.tag_id = t.id
         LEFT JOIN photos p ON p.id = pt.photo_id AND p.present = 1
         GROUP BY t.id HAVING photo_count > 0 ORDER BY t.name COLLATE NOCASE`
      )
      .all() as Row[]
    return rows.map((r) => ({ id: r.id as number, name: r.name as string, photoCount: r.photo_count as number }))
  }

  addTag(photoIds: number[], name: string): Tag {
    return this.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(name)
      const tag = this.db.prepare('SELECT id, name FROM tags WHERE name = ?').get(name) as Row
      const stmt = this.db.prepare('INSERT OR IGNORE INTO photo_tags (photo_id, tag_id) VALUES (?, ?)')
      photoIds.forEach((pid) => stmt.run(pid, tag.id as number))
      return { id: tag.id as number, name: tag.name as string }
    })
  }

  removeTag(photoIds: number[], tagId: number): void {
    const stmt = this.db.prepare('DELETE FROM photo_tags WHERE photo_id = ? AND tag_id = ?')
    this.transaction(() => photoIds.forEach((pid) => stmt.run(pid, tagId)))
  }
}

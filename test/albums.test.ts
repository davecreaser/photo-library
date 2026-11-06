import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installFsGuard } from '../src/main/fsGuard.ts'
import { LibraryDb } from '../src/main/db.ts'

installFsGuard({ allowedRoots: () => [tmpdir()], protectedRoots: () => [] })

const parentOf = (db: LibraryDb, id: number) => db.listAlbums().find((a) => a.id === id)!.parentId

function setup() {
  return new LibraryDb(join(mkdtempSync(join(tmpdir(), 'pl-albums-')), 'library.db'))
}

test('moving an album into another and back to the top level (AC-1, AC-2)', () => {
  const db = setup()
  const trips = db.createAlbum('Trips', null)
  const norway = db.createAlbum('Norway', null)
  assert.equal(db.moveAlbum(norway.id, trips.id), true)
  assert.equal(parentOf(db, norway.id), trips.id)
  assert.equal(db.moveAlbum(norway.id, null), true)
  assert.equal(parentOf(db, norway.id), null)
})

test('an album cannot move into itself or its descendants (AC-4)', () => {
  const db = setup()
  const a = db.createAlbum('A', null)
  const b = db.createAlbum('B', a.id)
  const c = db.createAlbum('C', b.id)
  assert.equal(db.moveAlbum(a.id, a.id), false)
  assert.equal(db.moveAlbum(a.id, c.id), false)
  assert.equal(parentOf(db, a.id), null)
  assert.equal(parentOf(db, c.id), b.id)
  assert.equal(db.moveAlbum(c.id, 9999), false, 'unknown target')
})

test('moving keeps photos and sub-albums (AC-5)', () => {
  const db = setup()
  const a = db.createAlbum('A', null)
  const b = db.createAlbum('B', a.id)
  const t = db.createAlbum('T', null)
  db.moveAlbum(a.id, t.id)
  assert.equal(parentOf(db, b.id), a.id)
  assert.equal(db.listAlbums().length, 3)
})

test('deleting an album moves its sub-albums up one level (AC-6)', () => {
  const db = setup()
  const top = db.createAlbum('Top', null)
  const mid = db.createAlbum('Mid', top.id)
  const leaf = db.createAlbum('Leaf', mid.id)
  db.deleteAlbum(mid.id)
  assert.equal(parentOf(db, leaf.id), top.id)
  db.deleteAlbum(top.id)
  assert.equal(parentOf(db, leaf.id), null)
})

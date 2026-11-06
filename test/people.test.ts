import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installFsGuard } from '../src/main/fsGuard.ts'
import { LibraryDb } from '../src/main/db.ts'
import { People } from '../src/main/people.ts'
import { FACE_MODEL_VERSION, normalise } from '../src/main/faces.ts'

installFsGuard({ allowedRoots: () => [tmpdir()], protectedRoots: () => [] })

let seed = 7
const rand = () => (seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32 - 0.5
const identity = () => normalise(Float32Array.from({ length: 128 }, rand))
const faceOf = (p: Float32Array) => normalise(p.map((x) => x + rand() * 0.12))

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'pl-people-'))
  const db = new LibraryDb(join(dir, 'library.db'))
  const people = new People(db, '/nonexistent', join(dir, 'faces'), () => {})
  const meta = (path: string) => ({
    path,
    size: 1,
    mtimeMs: 1,
    takenAt: '2026-01-01T10:00:00',
    width: null,
    height: null,
    orientation: null,
    camera: null,
    lat: null,
    lon: null
  })
  /** Adds a photo with faces of the given identities; returns [photoId, faceIds]. */
  const photoWith = (name: string, ...who: Float32Array[]): [number, number[]] => {
    db.recordFile(meta(`/photos/${name}.jpg`), `hash-${name}`, 1)
    const photoId = db.queryPhotos({ text: name }).photos[0].id
    const ids = db.saveFaces(
      photoId,
      who.map((w, i) => ({ x: i * 0.2, y: 0.1, w: 0.1, h: 0.1, score: 0.9, embedding: faceOf(w) })),
      FACE_MODEL_VERSION
    )
    return [photoId, ids]
  }
  return { dir, db, people, photoWith, meta }
}

test('name a group once, then new photos of that person are recognised and searchable', () => {
  const { dir, db, people, photoWith } = setup()
  const [jake, mira] = [identity(), identity()]
  for (let i = 0; i < 5; i++) photoWith(`jake${i}`, jake)
  for (let i = 0; i < 3; i++) photoWith(`mira${i}`, mira)
  const [, [jakeInGroup, miraInGroup]] = photoWith('both', jake, mira)
  people.regroup()

  const groups = db.listFaceGroups()
  assert.deepEqual(
    groups.map((g) => g.faceCount),
    [6, 4],
    'two groups, largest first'
  )

  const named = people.nameGroup(groups[0].sampleFaceIds[0], 'Jake')
  assert.equal(named.photoCount, 6)
  assert.equal(db.listFaceGroups().length, 1, 'only Mira left to name')

  // A later photo of Jake is recognised automatically.
  const [later] = photoWith('later', jake)
  people.regroup()
  assert.equal(db.queryPhotos({ text: 'jake' }).total, 7)
  assert.ok(db.queryPhotos({ personId: named.id }).photos.some((p) => p.id === later))
  const laterFace = db.getPhoto(later)!.faces[0]
  assert.deepEqual([laterFace.name, laterFace.auto], ['Jake', true])

  // Naming via a face in the viewer.
  people.nameFace(miraInGroup, 'Mira')
  assert.equal(
    db
      .getPhoto(db.queryPhotos({ text: 'both' }).photos[0].id)!
      .faces.map((f) => f.name)
      .join(','),
    'Jake,Mira'
  )
  void jakeInGroup
  db.listPeople().forEach((p) => assert.ok(p.coverFaceId))
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('"not this person" sticks, and renaming to an existing name merges people', () => {
  const { dir, db, people, photoWith } = setup()
  const jake = identity()
  for (let i = 0; i < 4; i++) photoWith(`a${i}`, jake)
  people.regroup()
  const jakeP = people.nameGroup(db.listFaceGroups()[0].id, 'Jake')
  const [, [wrong]] = photoWith('wrong', jake)
  people.regroup()
  assert.equal(db.personFaces(jakeP.id).find((f) => f.id === wrong)?.auto, true)

  people.rejectFace(wrong)
  people.regroup()
  assert.ok(!db.personFaces(jakeP.id).some((f) => f.id === wrong), 'stays rejected after regrouping')

  // The same person split into two named groups: renaming one to the other's name merges them.
  const other = people.nameGroup(wrong, 'Jakey')
  people.renamePerson(other.id, 'jake')
  assert.deepEqual(
    db.listPeople().map((p) => p.name),
    ['Jake']
  )
  assert.equal(db.listPeople()[0].photoCount, 5)

  people.deletePerson(jakeP.id)
  assert.equal(db.listPeople().length, 0)
  assert.equal(db.queryPhotos({}).total, 5, 'forgetting a person never removes photos')
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

test('faces and names follow the photo when the file moves', () => {
  const { dir, db, people, photoWith, meta } = setup()
  const jake = identity()
  photoWith('x', jake)
  photoWith('y', jake)
  people.regroup()
  people.nameGroup(db.listFaceGroups()[0].id, 'Jake')
  // Same content found at a new path in a later scan.
  db.recordFile(meta('/photos/moved/x-renamed.jpg'), 'hash-x', 2)
  db.markMissing(2)
  db.recordFile(meta('/photos/y.jpg'), 'hash-y', 2)
  db.refreshDerived()
  const found = db
    .queryPhotos({ text: 'jake' })
    .photos.map((p) => p.path)
    .sort()
  assert.deepEqual(found, ['/photos/moved/x-renamed.jpg', '/photos/y.jpg'])
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SIDEBAR_SECTIONS, parseSidebarSections } from '../src/shared/sidebarSections.ts'

test('AC-2/AC-3: defaults are People closed, Albums and Tags open', () => {
  assert.deepEqual(parseSidebarSections(null), { people: false, albums: true, tags: true })
  assert.deepEqual(parseSidebarSections(undefined), DEFAULT_SIDEBAR_SECTIONS)
})

test('AC-7: saved choices win over defaults, per section', () => {
  assert.deepEqual(parseSidebarSections('{"people":true,"albums":false,"tags":false}'), { people: true, albums: false, tags: false })
  assert.deepEqual(parseSidebarSections('{"albums":false}'), { people: false, albums: false, tags: true })
})

test('AC-10: unreadable values fall back to defaults', () => {
  for (const raw of ['', '{', 'null', '[]', '42', '{"people":"yes","albums":1}']) assert.deepEqual(parseSidebarSections(raw), DEFAULT_SIDEBAR_SECTIONS, raw)
})

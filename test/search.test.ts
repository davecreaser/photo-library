import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSearch, splitSearch } from '../src/shared/search.ts'

test('month name and year', () => {
  assert.deepEqual(parseSearch('show me photos from August 2020'), { year: '2020', month: '08', terms: [] })
})

test('short month names', () => {
  assert.deepEqual(parseSearch('dec 2019'), { year: '2019', month: '12', terms: [] })
})

test('ISO year-month', () => {
  assert.deepEqual(parseSearch('2021-3'), { year: '2021', month: '03', terms: [] })
})

test('keeps meaningful words as terms', () => {
  assert.deepEqual(parseSearch('photos of Jake at the beach'), { terms: ['jake', 'beach'] })
})

test('mixed dates and terms', () => {
  assert.deepEqual(parseSearch('spain, july 2018'), { year: '2018', month: '07', terms: ['spain'] })
})

test('numbers that are not years stay as terms', () => {
  assert.deepEqual(parseSearch('IMG 1234'), { terms: ['img', '1234'] })
})

// --- spec 0002: dates and people filter, the rest is the content phrase ---

const people = [
  { id: 1, name: 'Jake' },
  { id: 2, name: 'Mira Jones' },
  { id: 3, name: 'Jake Smith' }
]

test('content phrase: what is left after dates, people and filler words (AC-4, AC-6)', () => {
  assert.deepEqual(splitSearch('jake beach august 2025', people), {
    year: '2025',
    month: '08',
    terms: ['jake', 'beach'],
    personIds: [[1, 3]],
    phrase: 'beach'
  })
  assert.equal(splitSearch('show me photos of dogs on the beach', people).phrase, 'dogs beach')
  assert.equal(splitSearch('sunset over water', people).phrase, 'sunset over water')
})

test('a word of a person’s name means that person; part of a word does not', () => {
  assert.deepEqual(splitSearch('Mira snow', people).personIds, [[2]])
  assert.deepEqual(splitSearch('jones snow', people).personIds, [[2]])
  assert.deepEqual(splitSearch('ja snow', people), { terms: ['ja', 'snow'], personIds: [], phrase: 'ja snow' })
})

test('no content phrase when only dates and people are left (AC-5)', () => {
  assert.equal(splitSearch('jake', people).phrase, null)
  assert.equal(splitSearch('august 2025', people).phrase, null)
  assert.equal(splitSearch('photos of jake and mira from 2025', people).phrase, null)
})

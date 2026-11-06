import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSearch } from '../src/shared/search.ts'

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

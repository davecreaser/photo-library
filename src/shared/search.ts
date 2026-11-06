// Turns a free-text search like "august 2020 spain" into structured parts.
// Dates become date filters; every other word must match the photo's path,
// an album name or a tag name.

export interface ParsedSearch {
  year?: string
  month?: string
  terms: string[]
}

const MONTHS: Record<string, string> = {
  january: '01', jan: '01',
  february: '02', feb: '02',
  march: '03', mar: '03',
  april: '04', apr: '04',
  may: '05',
  june: '06', jun: '06',
  july: '07', jul: '07',
  august: '08', aug: '08',
  september: '09', sep: '09', sept: '09',
  october: '10', oct: '10',
  november: '11', nov: '11',
  december: '12', dec: '12'
}

// Filler words in queries like "show me photos of jake from august 2020".
const STOP_WORDS = new Set([
  'show', 'me', 'all', 'the', 'photos', 'photo', 'pictures', 'pics', 'of', 'from', 'in', 'on', 'at', 'our', 'my', 'a', 'and', 'with'
])

export function parseSearch(input: string): ParsedSearch {
  const result: ParsedSearch = { terms: [] }
  const words = input.toLowerCase().split(/[\s,]+/).filter(Boolean)

  for (const word of words) {
    const isoMonth = /^(\d{4})-(\d{1,2})$/.exec(word)
    if (isoMonth && Number(isoMonth[2]) >= 1 && Number(isoMonth[2]) <= 12) {
      result.year = isoMonth[1]
      result.month = isoMonth[2].padStart(2, '0')
    } else if (/^(19|20)\d{2}$/.test(word)) {
      result.year = word
    } else if (MONTHS[word]) {
      result.month = MONTHS[word]
    } else if (!STOP_WORDS.has(word)) {
      result.terms.push(word)
    }
  }
  return result
}

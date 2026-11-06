export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export function monthName(month: string): string {
  return MONTH_NAMES[Number(month) - 1] ?? month
}

// Capture times are naive local times ('YYYY-MM-DDTHH:MM:SS'); format them via UTC so
// the viewer's own timezone never shifts them.
function naive(iso: string): Date {
  return new Date(iso.slice(0, 19) + 'Z')
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return 'Unknown date'
  return naive(iso).toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short', timeZone: 'UTC' })
}

export function formatDate(iso: string | null): string {
  if (!iso) return 'Unknown date'
  return naive(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

export function formatRange(start: string | null, end: string | null): string {
  if (!start || !end) return 'Undated'
  if (start.slice(0, 10) === end.slice(0, 10)) return formatDate(start)
  return `${formatDate(start)} – ${formatDate(end)}`
}

/** "1 photo", "1,740 photos". */
export function photoCount(n: number): string {
  return `${n.toLocaleString()} ${n === 1 ? 'photo' : 'photos'}`
}

/**
 * Time left for content analysis (spec 0002, Design): "estimating time…", "less than a minute
 * left", "about 4 min left", "about 14 h left". `inBrackets` drops "left" for "(about 4 min)",
 * and gives null while estimating so the bracket can be left out.
 */
export function formatTimeLeft(seconds: number | null, inBrackets = false): string | null {
  if (seconds === null) return inBrackets ? null : 'estimating time…'
  const minutes = Math.ceil(seconds / 60)
  const text = seconds < 60 ? 'less than a minute' : minutes < 60 ? `about ${minutes} min` : `about ${Math.max(1, Math.round(seconds / 3600))} h`
  return inBrackets ? text : `${text} left`
}

export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

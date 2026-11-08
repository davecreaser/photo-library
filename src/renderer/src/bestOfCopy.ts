// Words for Best of (spec 0006, Design). Pure, so the copy is tested without a window.
import type { BestOfReason } from '../../shared/types.ts'

/** Why a photo is in the pick, in plain words (AC-5). */
export function reasonText(r: BestOfReason): string {
  switch (r.kind) {
    case 'starred':
      return 'You starred this one'
    case 'focus':
      return `Matches “${r.phrase}”`
    case 'person':
      return `Includes ${r.name}`
    case 'lookalike':
      return `Sharpest of ${r.count} similar photos`
    case 'moment':
      return r.count > 1 ? `One of ${r.count} from this moment` : 'The one from this moment'
    case 'different':
      return 'Something different from the rest'
    case 'yours':
      return 'You chose this one'
  }
}

export const NOT_ENOUGH = 'Not enough photos to choose from.'
export const MAKE_ALBUM_TOOLTIP = 'Creates a new album with these photos. Nothing is moved or changed on disk.'
export const FOCUS_UNAVAILABLE = 'Search by content isn’t ready yet.'
export const FOCUS_PLACEHOLDER = 'the kids, food, the beach'
export const LEAVE_PROMPT = 'Leave without making an album?'

export function pendingNotice(done: number, total: number): string {
  return `Still reading your photos: ${done.toLocaleString()} of ${total.toLocaleString()} done. The choice will improve as it goes.`
}

export function madeNotice(name: string, count: number): string {
  return `Made the album “${name}” with ${count.toLocaleString()} ${count === 1 ? 'photo' : 'photos'}.`
}

export function subtitle(count: number, total: number, moments: number): string {
  return `${count.toLocaleString()} of ${total.toLocaleString()} photos · ${moments.toLocaleString()} ${moments === 1 ? 'moment' : 'moments'}`
}

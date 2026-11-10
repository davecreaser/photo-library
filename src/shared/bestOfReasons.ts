// Why a photo is in a Best of pick, in plain words (spec 0006, AC-5). Shared: the window shows
// these, and the assistant's best_of tool returns the same sentences (spec 0009, AC-4).
import type { BestOfReason } from './types.ts'

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

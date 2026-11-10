// Words for Best of (spec 0006, Design). Pure, so the copy is tested without a window.

export { reasonText } from '../../shared/bestOfReasons.ts'

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

// --- a proposal from an AI assistant (spec 0009, Design) ---

export const ASSISTANT_PICK = 'Picked by your AI assistant'
export const PROPOSAL_WAITING = 'Picked by your AI assistant for you to look over. Change anything you like; nothing is kept until you press Make album.'
export const PROPOSAL_MADE = "Made from your AI assistant's pick. The album is yours; the assistant can't change it."
export const PROPOSAL_ACCESS_OFF = "Assistant access is off, so your assistant won't hear what you decide. You can still make the album."
export const PROPOSAL_LOADING = "Opening your AI assistant's pick…"
export const PROPOSAL_FEWER_TOOLTIP = 'To show fewer, remove photos with ✕'
export const PROPOSAL_FOCUS_HINT = "Your assistant's picks stay; press + to add photos that match."
export const PROPOSAL_REPLACED = 'Your AI assistant sent a new pick.'

export function incomingPrompt(name: string): string {
  return `Your AI assistant sent a new pick of “${name}”. Leave without making an album?`
}

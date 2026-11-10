// Proposals from AI assistants (spec 0009): a pick the owner reviews in the Best of screen. They
// live in memory only (nothing about them is written to disk) and end when Photo Library quits.
// The window reports what the owner did; the first decision on a proposal is the one that counts.
import type { ProposalEvent, ProposalShow } from '../shared/types.ts'

export type ProposalStatus = 'waiting' | 'approved' | 'closed' | 'replaced' | 'expired'

export interface Proposal {
  id: number
  albumId: number
  name: string
  photoIds: number[]
  status: ProposalStatus
  edited: boolean
  approved?: { albumId: number; name: string; photoIds: number[] }
  by?: number
}

export class Proposals {
  private next = 1
  private all = new Map<number, Proposal>()
  private show: (p: ProposalShow) => void

  /** `show` hands a new proposal to the window (and brings it forward). */
  constructor(show: (p: ProposalShow) => void) {
    this.show = show
  }

  propose(albumId: number, name: string, photoIds: number[]): Proposal {
    const p: Proposal = { id: this.next++, albumId, name, photoIds: [...photoIds], status: 'waiting', edited: false }
    this.all.set(p.id, p)
    this.show({ proposalId: p.id, albumId, name, photoIds: p.photoIds })
    return p
  }

  get(id: number): Proposal | undefined {
    return this.all.get(id)
  }

  /** What the owner did, from the window. Only a waiting proposal changes. */
  report(id: number, e: ProposalEvent): void {
    const p = this.all.get(id)
    if (!p || p.status !== 'waiting') return
    switch (e.kind) {
      case 'edited':
        p.edited = !!e.edited
        return
      case 'approved':
        p.status = 'approved'
        p.approved = { albumId: e.albumId, name: e.name, photoIds: [...e.photoIds] }
        return
      case 'closed':
        p.status = 'closed'
        return
      case 'replaced':
        if (!this.all.has(e.by) || e.by === id) return
        p.status = 'replaced'
        p.by = e.by
    }
  }

  /** The window went away: whatever it showed is closed. */
  closeAll(): void {
    for (const p of this.all.values()) if (p.status === 'waiting') p.status = 'closed'
  }

  /** Access was turned off, assistants were forgotten, or the photo folder changed. */
  expireAll(): void {
    for (const p of this.all.values()) if (p.status === 'waiting') p.status = 'expired'
  }
}

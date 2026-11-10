import { useCallback, useEffect, useRef, useState } from 'react'
import type { Album, BestOfReason, BestOfSource, BestOfView as View, Photo, ProposalShow } from '../../../shared/types.ts'
import { formatDate } from '../format.ts'
import {
  FOCUS_PLACEHOLDER,
  FOCUS_UNAVAILABLE,
  LEAVE_PROMPT,
  MAKE_ALBUM_TOOLTIP,
  NOT_ENOUGH,
  ASSISTANT_PICK,
  PROPOSAL_FEWER_TOOLTIP,
  PROPOSAL_FOCUS_HINT,
  PROPOSAL_LOADING,
  PROPOSAL_REPLACED,
  incomingPrompt,
  madeNotice,
  pendingNotice,
  reasonText,
  subtitle
} from '../bestOfCopy.ts'

const api = window.api
const MIN_COUNT = 6

interface Props {
  source: BestOfSource
  /** Called with the photos shown, in order, so the viewer can step through them. */
  onPhotosLoaded: (photos: Photo[], reasons: Record<number, string>) => void
  onOpen: (index: number) => void
  onBack: () => void
  onOpenAlbum: (id: number) => void
  /** An album was made from the pick (the sidebar needs to list it). */
  onMade: () => void
  /** True while something above this view (the photo viewer) owns the keyboard. */
  suspended: boolean
  /** Bumped when photos may have changed under us (analysis, stars). */
  version: number
  /** An AI assistant's pick to review (spec 0009): shown as fixed photos, count = their number. */
  proposal?: ProposalShow
  /** The proposal replaced another Best of screen ("Your AI assistant sent a new pick."). */
  arrivedOver?: boolean
  /** A newer proposal waiting behind the owner's edits: ask before leaving them. */
  incoming?: ProposalShow | null
  onIncomingLeave?: () => void
  onIncomingStay?: () => void
  /** Whether the pick differs from where it started, and whether an album was made from it. */
  onStateChange?: (s: { edited: boolean; made: boolean }) => void
}

/** The Best of view (spec 0006): a pick of an album's photos, which the user can adjust and keep as an album. */
export function BestOfView({
  source,
  onPhotosLoaded,
  onOpen,
  onBack,
  onOpenAlbum,
  onMade,
  suspended,
  version,
  proposal,
  arrivedOver,
  incoming,
  onIncomingLeave,
  onIncomingStay,
  onStateChange
}: Props) {
  const [view, setView] = useState<View | null>(null)
  const [slow, setSlow] = useState(false)
  const [count, setCount] = useState<number | null>(proposal ? proposal.photoIds.length : null)
  const [focusText, setFocusText] = useState('')
  const [focus, setFocus] = useState('')
  const [fixed, setFixed] = useState<number[]>(proposal?.photoIds ?? [])
  const [exclude, setExclude] = useState<number[]>([])
  const [made, setMade] = useState<Album | null>(null)
  const [error, setError] = useState(false)
  const [swapping, setSwapping] = useState<number | null>(null)
  const [strip, setStrip] = useState<Photo[]>([])
  const [adding, setAdding] = useState(false)
  const [others, setOthers] = useState<Photo[]>([])
  const [moreToAdd, setMoreToAdd] = useState(false)
  const pagesLoaded = useRef(0)
  const request = useRef(0)
  // More photos measured while the view is open: refresh the pick and the "still reading" count.
  const [tick, setTick] = useState(0)
  useEffect(() => api.onBestOfProgress(() => setTick((t) => t + 1)), [])
  const lastRemoved = useRef<{ id: number; shrank: boolean }[]>([])
  const hovered = useRef<number | null>(null)
  const stripRequest = useRef(0)
  const sourceKey = JSON.stringify(source)

  // A proposal is edited once the photos shown differ from the assistant's pick (spec 0009, Design).
  const proposed = proposal?.photoIds ?? []
  const proposedSet = new Set(proposed)
  // Worked out from the owner's changes, not the last answer, so it is right while the engine thinks.
  const edited = proposal
    ? count !== proposed.length || fixed.length !== proposed.length || fixed.some((id) => !proposedSet.has(id)) || exclude.some((id) => proposedSet.has(id))
    : fixed.length > 0 || exclude.length > 0
  // Proposed photos the owner removed and added back are theirs now ("You chose this one").
  const [readded, setReadded] = useState<number[]>([])
  const approvedOnce = useRef(false)
  const [replacedNotice, setReplacedNotice] = useState(!!arrivedOver)
  const firstPick = useRef(`${fixed.join()}|${exclude.join()}|${count}`)
  useEffect(() => {
    if (`${fixed.join()}|${exclude.join()}|${count}` !== firstPick.current) setReplacedNotice(false)
  }, [fixed.join(), exclude.join(), count])
  const reasonFor = (id: number, r: BestOfReason | undefined): string =>
    !r ? '' : proposedSet.has(id) && !readded.includes(id) && r.kind === 'yours' ? ASSISTANT_PICK : reasonText(r)

  useEffect(() => onStateChange?.({ edited, made: made !== null || approvedOnce.current }), [edited, made])
  useEffect(() => {
    if (proposal && !approvedOnce.current) api.reportProposal(proposal.proposalId, { kind: 'edited', edited })
  }, [edited])
  // Leaving the screen closes the proposal (a decision already made stands). Checked a tick later,
  // so React's development double mount doesn't close it.
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      setTimeout(() => {
        if (proposal && !mounted.current) api.reportProposal(proposal.proposalId, { kind: 'closed' })
      }, 0)
    }
  }, [])

  // A new source starts from the automatic pick, or from the assistant's.
  useEffect(() => {
    setCount(proposal ? proposal.photoIds.length : null)
    setFocus('')
    setFocusText('')
    setFixed(proposal?.photoIds ?? [])
    setExclude([])
    setMade(null)
    setSwapping(null)
    setAdding(false)
  }, [sourceKey])

  // Typing in "Focus on…" refills the pick after a short pause.
  useEffect(() => {
    const t = setTimeout(() => setFocus(focusText.trim()), 400)
    return () => clearTimeout(t)
  }, [focusText])

  useEffect(() => {
    const id = ++request.current
    const timer = setTimeout(() => id === request.current && setSlow(true), 300)
    api
      .getBestOf({ source, count: count ?? undefined, focus: focus || undefined, fixed, exclude })
      .then((v) => {
        if (id !== request.current) return
        setView(v)
        setSlow(false)
        const reasons: Record<number, string> = {}
        for (const [photoId, r] of Object.entries(v.reasons)) reasons[Number(photoId)] = reasonFor(Number(photoId), r)
        onPhotosLoaded(v.photos, reasons)
      })
      .catch(() => id === request.current && setSlow(false))
    return () => clearTimeout(timer)
  }, [sourceKey, count, focus, fixed.join(), exclude.join(), version, tick])

  // Removing a photo makes the pick one smaller (down to the minimum), rather than filling its place.
  const remove = (id: number) => {
    const shrank = !!view && view.count > MIN_COUNT
    lastRemoved.current.push({ id, shrank })
    setFixed((f) => f.filter((x) => x !== id))
    setExclude((e) => (e.includes(id) ? e : [...e, id]))
    if (shrank && view) setCount(view.count - 1)
  }
  const undoRemove = () => {
    const last = lastRemoved.current.pop()
    if (!last || !view) return
    setExclude((e) => e.filter((x) => x !== last.id))
    setFixed((f) => (f.includes(last.id) ? f : [...f, last.id]))
    if (last.shrank) setCount(view.count + 1)
  }

  // Esc leaves the view (asking first after edits); Delete removes the photo under the pointer, ⌘Z / Ctrl+Z puts it back.
  const [leaving, setLeaving] = useState(false)
  const leave = () => (edited && !made ? setLeaving(true) : onBack())
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (suspended || adding || e.target instanceof HTMLInputElement) return
      if (e.key === 'Escape') {
        if (incoming) onIncomingStay?.()
        else if (leaving) setLeaving(false)
        else leave()
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && hovered.current !== null) remove(hovered.current)
      else if (e.key.toLowerCase() === 'z' && (e.metaKey || e.ctrlKey)) undoRemove()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!view)
    return (
      <div className="grid-scroller">
        <div className="grid-meta">{slow ? (proposal ? PROPOSAL_LOADING : 'Choosing the best photos…') : ''}</div>
      </div>
    )

  const back = <button onClick={leave}>Back to {view.name}</button>
  if (view.tooFew) {
    return (
      <div className="grid-scroller">
        <div className="empty">
          <p>{NOT_ENOUGH}</p>
          {back}
        </div>
      </div>
    )
  }

  const openStrip = async (photo: Photo) => {
    const group = view.groups.find((g) => g.includes(photo.id))
    if (!group) return
    const id = ++stripRequest.current
    setSwapping(photo.id)
    const photos = await api.getPhotosByIds(group.filter((x) => x !== photo.id))
    if (id === stripRequest.current) setStrip(photos)
  }
  const swap = (out: number, into: Photo) => {
    setExclude((e) => [...e.filter((x) => x !== into.id), ...(e.includes(out) ? [] : [out])])
    setFixed((f) => [...f.filter((x) => x !== out), into.id])
    setSwapping(null)
  }
  // The picker pages through the whole source, however large (it skips what is already picked).
  const ADD_PAGE = 200
  const loadAdd = async (offset: number) => {
    const filter = source.kind === 'album' ? { albumId: source.id } : { suggestionId: source.id }
    const page = await api.queryPhotos({ ...filter, offset, limit: ADD_PAGE })
    const chosen = new Set(view.photos.map((p) => p.id))
    setOthers((prev) => [...(offset === 0 ? [] : prev), ...page.photos.filter((p) => !chosen.has(p.id))])
    setMoreToAdd(offset + page.photos.length < page.total)
  }
  const openAdd = async () => {
    pagesLoaded.current = 0
    setAdding(true)
    setOthers([])
    await loadAdd(0)
  }
  const reset = () => {
    setFixed(proposal?.photoIds ?? [])
    setExclude([])
    setCount(proposal ? proposal.photoIds.length : null)
    setMade(null)
  }
  const makeAlbum = async () => {
    setError(false)
    try {
      const ids = view.photos.map((p) => p.id)
      const album = await api.makeBestOfAlbum(source, ids)
      approvedOnce.current = true
      setMade(album)
      if (proposal) api.reportProposal(proposal.proposalId, { kind: 'approved', albumId: album.id, name: album.name, photoIds: ids })
      onMade()
    } catch {
      setError(true)
    }
  }
  // A proposal's photos are fixed: the pick can't shrink below them (remove them with ✕ instead).
  const fixedShown = proposal ? view.photos.filter((p) => fixed.includes(p.id)).length : 0
  const minN = Math.max(MIN_COUNT, fixedShown)
  const setN = (n: number) => setCount(Math.max(minN, Math.min(view.total, n)))

  let day = ''
  const tiles = view.photos.map((p, i) => {
    const d = p.takenAt ? p.takenAt.slice(0, 10) : 'undated'
    const heading = d !== day ? (p.takenAt ? formatDate(p.takenAt) : 'Undated') : null
    day = d
    const reason = view.reasons[p.id]
    const hasGroup = view.groups.some((g) => g.includes(p.id) && g.length > 1)
    const groupSize = view.groups.find((g) => g.includes(p.id))?.length ?? 0
    return (
      <div key={p.id} style={{ display: 'contents' }}>
        {heading && <div className="grid-divider">{heading}</div>}
        <div
          className="tile"
          title={reasonFor(p.id, reason)}
          onClick={() => onOpen(i)}
          onMouseEnter={() => (hovered.current = p.id)}
          onMouseLeave={() => (hovered.current = null)}
        >
          <img src={`photo://thumb/${p.id}`} loading="lazy" decoding="async" alt="" />
          {p.favorite && <span className="fav-badge">★</span>}
          <button
            className="tile-remove"
            title="Remove from this pick"
            aria-label="Remove from this pick"
            onClick={(e) => {
              e.stopPropagation()
              remove(p.id)
            }}
          >
            ✕
          </button>
          {hasGroup && (
            <button
              className="stack-badge"
              title="Pick another from the similar photos"
              onClick={(e) => {
                e.stopPropagation()
                void openStrip(p)
              }}
            >
              {groupSize}
            </button>
          )}
        </div>
        {swapping === p.id && (
          <div className="swap-strip">
            <span className="hint">Pick another</span>
            {strip.map((s) => (
              <img key={s.id} src={`photo://thumb/${s.id}`} alt="" onClick={() => swap(p.id, s)} />
            ))}
            <button className="link" onClick={() => setSwapping(null)}>
              Close
            </button>
          </div>
        )}
      </div>
    )
  })

  const stillReading = view.pending.done < view.pending.total
  return (
    <div className="grid-scroller">
      <div className="best-of-bar">
        <div className="best-of-row">
          <span className="subtitle">{subtitle(view.photos.length, view.total, view.momentCount)}</span>
          <label className="best-of-stepper">
            Show
            <button
              aria-label="Fewer photos"
              disabled={view.count <= minN}
              title={proposal && view.count <= minN && minN > MIN_COUNT ? PROPOSAL_FEWER_TOOLTIP : undefined}
              onClick={() => setN(view.count - 1)}
            >
              −
            </button>
            <input
              aria-label="How many photos"
              type="number"
              min={minN}
              max={view.total}
              value={view.count}
              onChange={(e) => setN(Number(e.target.value) || MIN_COUNT)}
            />
            <button aria-label="More photos" disabled={view.count >= view.total} onClick={() => setN(view.count + 1)}>
              +
            </button>
            photos
          </label>
          <button className="primary-small" title={MAKE_ALBUM_TOOLTIP} disabled={made !== null || view.photos.length === 0} onClick={() => void makeAlbum()}>
            Make album
          </button>
          {back}
          {(proposal ? edited || count !== proposed.length : edited || count !== null) && (
            <button className="link" onClick={reset}>
              Reset
            </button>
          )}
        </div>
        <div className="best-of-row">
          <input
            className="focus-input"
            type="text"
            placeholder={FOCUS_PLACEHOLDER}
            aria-label="Focus on…"
            value={focusText}
            onChange={(e) => setFocusText(e.target.value)}
          />
          {focusText && (
            <button className="link" aria-label="Clear focus" onClick={() => setFocusText('')}>
              ✕
            </button>
          )}
          {view.focusUnavailable && <span className="hint">{FOCUS_UNAVAILABLE}</span>}
          {proposal && focusText && !view.focusUnavailable && view.photos.every((p) => fixed.includes(p.id)) && (
            <span className="hint">{PROPOSAL_FOCUS_HINT}</span>
          )}
        </div>
        {made && (
          <p className="notice-line">
            {madeNotice(made.name, made.photoCount)}{' '}
            <button className="link" onClick={() => onOpenAlbum(made.id)}>
              Open album
            </button>
          </p>
        )}
        {error && <p className="error">Couldn’t make the album.</p>}
        {stillReading && <p className="hint">{pendingNotice(view.pending.done, view.pending.total)}</p>}
        {replacedNotice && <p className="notice-line">{PROPOSAL_REPLACED}</p>}
        {incoming && (
          <p className="notice-line" role="alert">
            {incomingPrompt(incoming.name)} <button onClick={onIncomingLeave}>Leave</button>{' '}
            <button autoFocus onClick={onIncomingStay}>
              Stay
            </button>
          </p>
        )}
        {leaving && !incoming && (
          <p className="notice-line">
            {LEAVE_PROMPT} <button onClick={onBack}>Leave</button> <button onClick={() => setLeaving(false)}>Stay</button>
          </p>
        )}
      </div>
      {slow && <div className="grid-meta">Choosing the best photos…</div>}
      <div className="grid">
        {tiles}
        <div className="tile add-tile" onClick={() => void openAdd()} title="Add another photo from this album">
          <span>Add a photo…</span>
        </div>
      </div>
      {adding && (
        <div className="modal-backdrop" onClick={() => setAdding(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Add a photo</h2>
            <div className="grid">
              {others.map((p) => (
                <div
                  key={p.id}
                  className="tile"
                  onClick={() => {
                    setFixed((f) => [...f, p.id])
                    if (proposedSet.has(p.id)) setReadded((r) => [...r, p.id])
                    setExclude((e) => e.filter((x) => x !== p.id))
                    setCount(Math.min(view.total, view.count + 1)) // adding makes the pick one bigger
                    setAdding(false)
                  }}
                >
                  <img src={`photo://thumb/${p.id}`} loading="lazy" alt="" />
                </div>
              ))}
            </div>
            {moreToAdd && (
              <button
                onClick={() => {
                  pagesLoaded.current += 1
                  void loadAdd(pagesLoaded.current * ADD_PAGE)
                }}
              >
                Show more
              </button>
            )}{' '}
            <button onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}

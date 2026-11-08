import { useCallback, useEffect, useRef, useState } from 'react'
import type { Album, BestOfSource, BestOfView as View, Photo } from '../../../shared/types.ts'
import { formatDate } from '../format.ts'
import {
  FOCUS_PLACEHOLDER,
  FOCUS_UNAVAILABLE,
  LEAVE_PROMPT,
  MAKE_ALBUM_TOOLTIP,
  NOT_ENOUGH,
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
  /** Bumped when photos may have changed under us (analysis, stars). */
  version: number
}

/** The Best of view (spec 0006): a pick of an album's photos, which the user can adjust and keep as an album. */
export function BestOfView({ source, onPhotosLoaded, onOpen, onBack, onOpenAlbum, onMade, version }: Props) {
  const [view, setView] = useState<View | null>(null)
  const [slow, setSlow] = useState(false)
  const [count, setCount] = useState<number | null>(null)
  const [focusText, setFocusText] = useState('')
  const [focus, setFocus] = useState('')
  const [fixed, setFixed] = useState<number[]>([])
  const [exclude, setExclude] = useState<number[]>([])
  const [made, setMade] = useState<Album | null>(null)
  const [error, setError] = useState(false)
  const [swapping, setSwapping] = useState<number | null>(null)
  const [strip, setStrip] = useState<Photo[]>([])
  const [adding, setAdding] = useState(false)
  const [others, setOthers] = useState<Photo[]>([])
  const request = useRef(0)
  const sourceKey = JSON.stringify(source)

  const edited = fixed.length > 0 || exclude.length > 0

  // A new source starts from the automatic pick.
  useEffect(() => {
    setCount(null)
    setFocus('')
    setFocusText('')
    setFixed([])
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
        for (const [photoId, r] of Object.entries(v.reasons)) reasons[Number(photoId)] = reasonText(r)
        onPhotosLoaded(v.photos, reasons)
      })
      .catch(() => id === request.current && setSlow(false))
    return () => clearTimeout(timer)
  }, [sourceKey, count, focus, fixed.join(), exclude.join(), version])

  const remove = useCallback((id: number) => {
    setFixed((f) => f.filter((x) => x !== id))
    setExclude((e) => (e.includes(id) ? e : [...e, id]))
  }, [])

  // Esc leaves the view (asking first after edits).
  const [leaving, setLeaving] = useState(false)
  const leave = () => (edited && !made ? setLeaving(true) : onBack())
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement)) leave()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!view)
    return (
      <div className="grid-scroller">
        <div className="grid-meta">{slow ? 'Choosing the best photos…' : ''}</div>
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
    setSwapping(photo.id)
    setStrip(await api.getPhotosByIds(group.filter((id) => id !== photo.id)))
  }
  const swap = (out: number, into: Photo) => {
    setExclude((e) => [...e.filter((x) => x !== into.id), ...(e.includes(out) ? [] : [out])])
    setFixed((f) => [...f.filter((x) => x !== out), into.id])
    setSwapping(null)
  }
  const openAdd = async () => {
    setAdding(true)
    const chosen = new Set(view.photos.map((p) => p.id))
    const page = await api.queryPhotos(source.kind === 'album' ? { albumId: source.id, limit: 400 } : { suggestionId: source.id, limit: 400 })
    setOthers(page.photos.filter((p) => !chosen.has(p.id)))
  }
  const reset = () => {
    setFixed([])
    setExclude([])
    setCount(null)
    setMade(null)
  }
  const makeAlbum = async () => {
    setError(false)
    try {
      setMade(
        await api.makeBestOfAlbum(
          source,
          view.photos.map((p) => p.id)
        )
      )
      onMade()
    } catch {
      setError(true)
    }
  }
  const setN = (n: number) => setCount(Math.max(MIN_COUNT, Math.min(view.total, n)))

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
        <div className="tile" title={reason ? reasonText(reason) : ''} onClick={() => onOpen(i)}>
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
            <button aria-label="Fewer photos" disabled={view.count <= MIN_COUNT} onClick={() => setN(view.count - 1)}>
              −
            </button>
            <input
              aria-label="How many photos"
              type="number"
              min={MIN_COUNT}
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
          {(edited || count !== null) && (
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
        {leaving && (
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
                    setExclude((e) => e.filter((x) => x !== p.id))
                    setAdding(false)
                  }}
                >
                  <img src={`photo://thumb/${p.id}`} loading="lazy" alt="" />
                </div>
              ))}
            </div>
            <button onClick={() => setAdding(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}

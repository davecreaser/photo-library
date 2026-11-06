import { useEffect, useRef, useState } from 'react'
import type { Album, SuggestedAlbum } from '../../../shared/types.ts'
import { formatRange } from '../format.ts'
import { InlineInput } from './InlineInput.tsx'

/** The one-at-a-time message in the status slot after a decision (spec 0001 design). */
export type SuggestionNotice =
  { kind: 'dismissed'; label: string; decisionIds: number[] } | { kind: 'made'; album: Album; sources: number } | { kind: 'error'; message: string } | null

interface Props {
  /** null until the first load finishes. */
  suggestions: SuggestedAlbum[] | null
  /** Set when working out suggestions failed. */
  loadError: boolean
  onRetry: () => void
  minBurstSize: number
  dismissedCount: number
  /** False until the first scan has finished. */
  scanned: boolean
  scanning: boolean
  notice: SuggestionNotice
  onOpen: (id: string) => void
  onAccept: (ids: string[], name: string) => Promise<void>
  onDismiss: (ids: string[]) => void
  onUndo: () => void
  onOpenAlbum: (id: number) => void
  onSetMinBurstSize: (n: number) => Promise<boolean>
  onShowDismissed: () => void
}

const PAGE = 200
const NONE: SuggestedAlbum[] = []
const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`

export function suggestionMeta(s: SuggestedAlbum): string {
  return s.named ? `${formatRange(s.start, s.end)} · ${plural(s.count, 'photo')}` : plural(s.count, 'photo')
}

/** "Named folders are always suggested… at least [20] photos." Applies on Enter or blur. */
function MinimumField({ value, onSet }: { value: number; onSet: (n: number) => Promise<boolean> }) {
  const [text, setText] = useState(String(value))
  const [invalid, setInvalid] = useState(false)
  useEffect(() => setText(String(value)), [value])
  const apply = async () => {
    if (text === String(value)) return setInvalid(false)
    setInvalid(!(await onSet(Number(text))))
  }
  return (
    <span className="hint">
      Named folders are always suggested. Other photos taken close together are suggested in groups of at least{' '}
      <input
        id="min-burst-size"
        className={`min-burst ${invalid ? 'invalid' : ''}`}
        type="number"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={apply}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void apply()
          if (e.key === 'Escape') {
            setText(String(value))
            setInvalid(false)
          }
        }}
      />{' '}
      photos.
      {invalid && <span className="error"> Use a number from 1 to 1,000.</span>}
    </span>
  )
}

export function SuggestionsView(props: Props) {
  const { notice } = props
  const suggestions = props.suggestions ?? NONE
  const [selected, setSelected] = useState<string[]>([])
  const [combining, setCombining] = useState(false)
  const [naming, setNaming] = useState<string | null>(null)
  const [emptyName, setEmptyName] = useState(false)
  const [shown, setShown] = useState(PAGE)
  const sentinel = useRef<HTMLDivElement>(null)

  // Drop ticks for suggestions that are gone (accepted, dismissed, threshold changed).
  useEffect(() => setSelected((sel) => sel.filter((id) => suggestions.some((s) => s.id === id))), [suggestions])

  // Large lists render in pages as you scroll (AC-12).
  useEffect(() => {
    const el = sentinel.current
    if (!el) return
    const obs = new IntersectionObserver((entries) => entries[0].isIntersecting && setShown((n) => n + PAGE), { rootMargin: '800px' })
    obs.observe(el)
    return () => obs.disconnect()
  }, [suggestions.length])

  // ⌘Z undoes the last dismissal; Esc clears the selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || document.querySelector('.modal')) return
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && notice?.kind === 'dismissed') {
        e.preventDefault()
        props.onUndo()
      }
      if (e.key === 'Escape') {
        setSelected([])
        setCombining(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [notice])

  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
  const chosen = suggestions.filter((s) => selected.includes(s.id))
  const chosenPhotos = chosen.reduce((n, s) => n + s.count, 0)

  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 300)
    return () => clearTimeout(t)
  }, [])

  if (props.loadError) {
    return (
      <div className="grid-scroller">
        <div className="empty">
          <p className="error">Suggestions couldn’t be worked out.</p>
          <button onClick={props.onRetry}>Try again</button>
        </div>
      </div>
    )
  }

  if (props.suggestions === null) {
    return <div className="grid-scroller">{slow && <p className="hint">Finding suggestions…</p>}</div>
  }

  if (!props.scanned) {
    return (
      <div className="grid-scroller">
        <div className="empty">
          {props.scanning
            ? 'Suggested albums will appear when the scan finishes.'
            : 'Suggested albums appear after your photos are scanned. They come from your named folders and from photos taken close together.'}
        </div>
      </div>
    )
  }

  const groups = new Map<string, SuggestedAlbum[]>()
  for (const s of suggestions.slice(0, shown)) {
    const key = s.start?.slice(0, 4) ?? 'Undated'
    const list = groups.get(key)
    if (list) list.push(s)
    else groups.set(key, [s])
  }

  const statusSlot = () => {
    if (selected.length > 0) {
      return (
        <div className="merge-bar">
          <span className="selection-count">{selected.length} selected</span>
          {combining ? (
            <>
              <InlineInput
                initial={chosen.find((s) => s.named)?.name ?? ''}
                placeholder="Album name, e.g. Norway"
                onSubmit={async (name) => {
                  await props.onAccept(selected, name).catch(() => {})
                  setSelected([])
                  setCombining(false)
                }}
                onCancel={() => setCombining(false)}
              />
              <span className="hint">
                {plural(chosenPhotos, 'photo')} from {selected.length} suggestions. Enter to make the album, Esc to cancel.
              </span>
            </>
          ) : (
            <>
              <button className="primary-small" disabled={selected.length < 2} onClick={() => setCombining(true)}>
                Combine into one album
              </button>
              <button
                onClick={() => {
                  props.onDismiss(selected)
                  setSelected([])
                }}
              >
                Dismiss
              </button>
              <button onClick={() => setSelected([])}>Clear</button>
              {selected.length < 2 && <span className="hint">Select another suggestion to combine with.</span>}
            </>
          )}
        </div>
      )
    }
    if (notice?.kind === 'dismissed') {
      return (
        <div className="merge-bar">
          <span className="hint">{notice.label}</span>
          <button className="link" onClick={props.onUndo}>
            Undo
          </button>
        </div>
      )
    }
    if (notice?.kind === 'error') {
      return (
        <div className="merge-bar">
          <span className="error">{notice.message}</span>
        </div>
      )
    }
    if (notice?.kind === 'made') {
      return (
        <div className="merge-bar">
          <span className="hint">
            Made album “{notice.album.name}” with {plural(notice.album.photoCount, 'photo')}
            {notice.sources > 1 ? ` from ${notice.sources} suggestions` : ''}.
          </span>
          <button className="link" onClick={() => props.onOpenAlbum(notice.album.id)}>
            Open album
          </button>
        </div>
      )
    }
    return (
      <div className="merge-bar">
        <span className="hint">
          Make an album from a suggestion, or dismiss it to stop seeing it. Trip split over several days? Tick them (or ⌘-click) and combine.
        </span>
      </div>
    )
  }

  return (
    <div className="grid-scroller suggestions">
      <div className="suggestions-toolbar">
        <MinimumField value={props.minBurstSize} onSet={props.onSetMinBurstSize} />
        {props.dismissedCount > 0 && (
          <button className="link" onClick={props.onShowDismissed}>
            Dismissed ({props.dismissedCount.toLocaleString()})…
          </button>
        )}
      </div>
      {statusSlot()}

      {suggestions.length === 0 && (
        <div className="empty">
          <p>Nothing to suggest right now.</p>
          <p className="hint">
            Every named folder has been made into an album or dismissed, and no other group has at least {props.minBurstSize.toLocaleString()} photos.
          </p>
          {props.dismissedCount > 0 && (
            <button className="link" onClick={props.onShowDismissed}>
              See dismissed suggestions ({props.dismissedCount.toLocaleString()})
            </button>
          )}
        </div>
      )}

      {[...groups].map(([year, list]) => (
        <section key={year} className="event-year">
          <h2>{year}</h2>
          <div className="event-grid">
            {list.map((s) => (
              <div
                key={s.id}
                tabIndex={0}
                className={`event-card ${selected.includes(s.id) ? 'selected' : ''}`}
                onClick={(ev) => (ev.metaKey || ev.ctrlKey || selected.length > 0 ? toggle(s.id) : naming !== s.id && props.onOpen(s.id))}
                onKeyDown={(ev) => {
                  if (ev.target !== ev.currentTarget) return
                  if (ev.key === 'Enter') props.onOpen(s.id)
                  if (ev.key === ' ') {
                    ev.preventDefault()
                    toggle(s.id)
                  }
                }}
              >
                <img src={`photo://thumb/${s.coverId}`} loading="lazy" alt="" />
                <span
                  className="check"
                  onClick={(ev) => {
                    ev.stopPropagation()
                    toggle(s.id)
                  }}
                >
                  {selected.includes(s.id) ? '✓' : ''}
                </span>
                <div className="event-info" onClick={(ev) => naming === s.id && ev.stopPropagation()}>
                  {naming === s.id ? (
                    <>
                      <InlineInput
                        initial={s.name}
                        onSubmit={async (name) => {
                          await props.onAccept([s.id], name).catch(() => {})
                          setNaming(null)
                        }}
                        onEmpty={() => setEmptyName(true)}
                        onCancel={() => setNaming(null)}
                      />
                      <div className="event-meta">{emptyName ? 'An album needs a name.' : 'Enter to make the album, Esc to cancel'}</div>
                    </>
                  ) : (
                    <>
                      <div className={`event-name ${s.named ? '' : 'dated'}`}>{s.name}</div>
                      <div className="event-meta">{suggestionMeta(s)}</div>
                    </>
                  )}
                  <div className={`card-actions ${selected.length > 0 || naming === s.id ? 'hidden' : ''}`}>
                    <button
                      className="primary-small"
                      title={`Make a new album with these ${plural(s.count, 'photo')}`}
                      onClick={(ev) => {
                        ev.stopPropagation()
                        setEmptyName(false)
                        setNaming(s.id)
                      }}
                    >
                      Make album
                    </button>
                    <button
                      title="Stop suggesting this. Photos aren't moved or changed."
                      onClick={(ev) => {
                        ev.stopPropagation()
                        props.onDismiss([s.id])
                      }}
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
      {shown < suggestions.length && <div ref={sentinel} className="sentinel" />}
    </div>
  )
}

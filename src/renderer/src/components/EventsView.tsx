import { useState } from 'react'
import type { PhotoEvent } from '../../../shared/types.ts'
import { formatRange } from '../format.ts'
import { InlineInput } from './InlineInput.tsx'

interface Props {
  events: PhotoEvent[]
  onOpen: (id: string) => void
  onMerge: (ids: string[], name: string) => void
}

/** Automatic events as cards, grouped by year (undated last). Select several to merge them into one trip. */
export function EventsView({ events, onOpen, onMerge }: Props) {
  const [selected, setSelected] = useState<string[]>([])
  const [naming, setNaming] = useState(false)

  const groups = new Map<string, PhotoEvent[]>()
  for (const e of events) {
    const key = e.start?.slice(0, 4) ?? 'Undated'
    groups.set(key, [...(groups.get(key) ?? []), e])
  }

  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
  const chosen = events.filter((e) => selected.includes(e.id))
  // Suggest the name of a folder-named event among the selection.
  const suggestedName = chosen.find((e) => e.named)?.name ?? ''

  if (events.length === 0) return <div className="empty">No events yet. They appear after the first scan.</div>

  return (
    <div className="grid-scroller">
      {selected.length > 0 ? (
        <div className="merge-bar">
          <span className="selection-count">{selected.length} selected</span>
          {naming ? (
            <InlineInput
              initial={suggestedName}
              placeholder="Name, e.g. Norway"
              onSubmit={(name) => { onMerge(selected, name); setSelected([]); setNaming(false) }}
              onCancel={() => setNaming(false)}
            />
          ) : (
            <button className="primary-small" disabled={selected.length < 2} onClick={() => setNaming(true)}>
              Merge into one trip
            </button>
          )}
          <button onClick={() => { setSelected([]); setNaming(false) }}>Clear</button>
          {selected.length < 2 && <span className="hint">Select another event to merge with.</span>}
        </div>
      ) : (
        <p className="hint events-hint">
          Grouped automatically from your folder names and when photos were taken. One trip split over several days? Tick them (or ⌘-click) and merge.
        </p>
      )}
      {[...groups].map(([year, list]) => (
        <section key={year} className="event-year">
          <h2>{year}</h2>
          <div className="event-grid">
            {list.map((e) => (
              <div
                key={e.id}
                className={`event-card ${selected.includes(e.id) ? 'selected' : ''}`}
                onClick={(ev) => (ev.metaKey || ev.ctrlKey || selected.length > 0 ? toggle(e.id) : onOpen(e.id))}
              >
                <img src={`photo://thumb/${e.coverId}`} loading="lazy" alt="" />
                <span className="check" onClick={(ev) => { ev.stopPropagation(); toggle(e.id) }}>{selected.includes(e.id) ? '✓' : ''}</span>
                <div className="event-info">
                  <div className={`event-name ${e.named ? '' : 'dated'}`}>{e.name}</div>
                  <div className="event-meta">
                    {e.named ? `${formatRange(e.start, e.end)} · ` : ''}
                    {e.count} {e.count === 1 ? 'photo' : 'photos'}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

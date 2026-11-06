import { useEffect, useState } from 'react'
import type { DismissedSuggestion } from '../../../shared/types.ts'
import { formatRange } from '../format.ts'

const api = window.api
const PAGE = 200

function meta(d: DismissedSuggestion, minBurstSize: number): string {
  const count = `${d.photoCount.toLocaleString()} photo${d.photoCount === 1 ? '' : 's'}`
  const range = d.start ? `${formatRange(d.start, d.end)} · ` : ''
  const note =
    d.note === 'below-minimum'
      ? ` · Not suggested at the moment: fewer than ${minBurstSize.toLocaleString()} photos`
      : d.note === 'in-album'
        ? ' · Not suggested at the moment: already in an album'
        : ''
  return range + count + note
}

/** Lists dismissed suggestions, most recent first; Restore puts one back in Suggested albums. */
export function DismissedDialog({ minBurstSize, onClose, onChanged }: { minBurstSize: number; onClose: () => void; onChanged: () => void }) {
  const [list, setList] = useState<DismissedSuggestion[] | null>(null)
  const [shown, setShown] = useState(PAGE)
  useEffect(() => {
    void api.getDismissedSuggestions().then(setList)
  }, [])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Dismissed suggestions</h2>
        <p className="hint">
          These won’t be suggested again. Restore one to put it back in Suggested albums. Your photos and files aren’t affected either way.
        </p>
        {list?.length === 0 && <p className="hint">Nothing dismissed.</p>}
        {list?.slice(0, shown).map((d) => (
          <div key={d.id} className="correction dismissed-row">
            {d.coverId ? <img src={`photo://thumb/${d.coverId}`} alt="" /> : <span className="thumb-placeholder" />}
            <span className="grow">
              <strong>{d.name}</strong>
              <span className="hint">{meta(d, minBurstSize)}</span>
            </span>
            <button
              onClick={async () => {
                await api.restoreSuggestions([d.id])
                setList((l) => l?.filter((x) => x.id !== d.id) ?? null)
                onChanged()
              }}
            >
              Restore
            </button>
          </div>
        ))}
        {list && shown < list.length && <button onClick={() => setShown((n) => n + PAGE)}>Show more</button>}
        <div className="modal-footer">
          <button onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}

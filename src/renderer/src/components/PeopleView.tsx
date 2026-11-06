import { useEffect, useId, useState } from 'react'
import type { FaceGroup, FaceProgress, Person } from '../../../shared/types.ts'

const api = window.api

interface Props {
  people: Person[]
  progress: FaceProgress | null
  /** Bumped when faces/people may have changed. */
  version: number
  onOpenPerson: (id: number) => void
  onChanged: () => void
}

/** Names a group of faces. Suggests existing names, so typing "Jake" again adds to Jake. */
function NameInput({ people, onSubmit }: { people: Person[]; onSubmit: (name: string) => void }) {
  const [value, setValue] = useState('')
  const listId = useId()
  return (
    <>
      <input
        className="name-input"
        list={listId}
        placeholder="Who’s this?"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && value.trim()) {
            onSubmit(value.trim())
            setValue('')
          }
        }}
      />
      <datalist id={listId}>
        {people.map((p) => (
          <option key={p.id} value={p.name} />
        ))}
      </datalist>
    </>
  )
}

export function PeopleView({ people, progress, version, onOpenPerson, onChanged }: Props) {
  const [groups, setGroups] = useState<FaceGroup[]>([])
  const [showAll, setShowAll] = useState(false)

  // Refetch when names change, and as analysis progresses (groups are recomputed every ~150 photos).
  const step = progress?.phase === 'analysing' ? Math.floor(progress.done / 150) : -1
  useEffect(() => {
    void api.getFaceGroups().then(setGroups)
  }, [version, progress?.phase, step])

  const visible = showAll ? groups : groups.slice(0, 24)

  return (
    <div className="grid-scroller people">
      {progress?.phase === 'analysing' && (
        <p className="hint">
          Finding faces… {progress.done.toLocaleString()} of {progress.total.toLocaleString()} photos. Groups appear and improve as it goes; this happens once.
        </p>
      )}
      {progress?.phase === 'unavailable' && <p className="error">{progress.error}</p>}

      {people.length > 0 && (
        <section>
          <h2>People</h2>
          <div className="person-grid">
            {people.map((p) => (
              <div key={p.id} className="person-card" onClick={() => onOpenPerson(p.id)}>
                {p.coverFaceId ? <img src={`photo://face/${p.coverFaceId}`} alt="" /> : <div className="face-placeholder" />}
                <div className="person-name">{p.name}</div>
                <div className="event-meta">{p.photoCount} photos</div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2>Who’s this?</h2>
        {groups.length === 0 ? (
          <p className="hint">
            {progress?.phase === 'analysing' ? 'Groups will appear here shortly.' : 'No unnamed groups of faces. Everyone found has a name!'}
          </p>
        ) : (
          <p className="hint">
            Similar faces are grouped. Type a name once to name the whole group; future photos of them are recognised automatically. Two groups of the same
            person? Give both the same name.
          </p>
        )}
        <div className="group-grid">
          {visible.map((g) => (
            <div key={g.id} className="face-group">
              <div className="face-strip">
                {g.sampleFaceIds.slice(0, 6).map((id) => (
                  <img key={id} src={`photo://face/${id}`} alt="" />
                ))}
              </div>
              <div className="face-group-footer">
                <span className="event-meta">{g.photoCount} photos</span>
                <NameInput
                  people={people}
                  onSubmit={async (name) => {
                    await api.nameFaceGroup(g.id, name)
                    onChanged()
                  }}
                />
              </div>
            </div>
          ))}
        </div>
        {groups.length > visible.length && <button onClick={() => setShowAll(true)}>Show {groups.length - visible.length} more groups</button>}
      </section>
    </div>
  )
}

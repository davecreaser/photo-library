import { useEffect, useState } from 'react'
import type { Person, PersonFace } from '../../../shared/types.ts'

const api = window.api

/** Every face matched to a person, automatic matches first, each removable with one click. */
export function PersonFaces({ person, onChanged }: { person: Person; onChanged: () => void }) {
  const [faces, setFaces] = useState<PersonFace[]>([])
  const load = () => api.getPersonFaces(person.id).then(setFaces)
  useEffect(() => {
    void load()
  }, [person.id])

  const autoCount = faces.filter((f) => f.auto).length
  return (
    <div className="grid-scroller">
      <p className="hint">
        {autoCount > 0
          ? `${autoCount} faces were matched to ${person.name} automatically (marked “auto”). Click ✕ on any that aren’t ${person.name}; they won’t be matched to ${person.name} again.`
          : `All faces here were confirmed by you. Click ✕ on any that aren’t ${person.name}.`}
      </p>
      <div className="face-review">
        {faces.map((f) => (
          <div key={f.id} className={`face-tile ${f.auto ? 'auto' : ''}`}>
            <img src={`photo://face/${f.id}`} alt="" />
            {f.auto && <span className="auto-badge">auto</span>}
            <button
              className="reject"
              title={`Not ${person.name}`}
              onClick={async () => {
                await api.rejectFace(f.id)
                setFaces((list) => list.filter((x) => x.id !== f.id))
                onChanged()
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

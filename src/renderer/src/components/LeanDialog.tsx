import { useEffect, useState } from 'react'

const api = window.api

/** Best of settings (spec 0006, AC-4a): whether the pick leans towards the kind of photo the user stars. */
export function LeanDialog({ onClose }: { onClose: () => void }) {
  const [lean, setLean] = useState<{ on: boolean; stars: number; enough: boolean } | null>(null)
  useEffect(() => {
    void api.getLeanTowardsStars().then(setLean)
  }, [])
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Best of</h2>
        {lean && (
          <>
            <label className="toggle">
              <input
                type="checkbox"
                checked={lean.on}
                onChange={async (e) => {
                  await api.setLeanTowardsStars(e.target.checked)
                  setLean({ ...lean, on: e.target.checked })
                }}
              />{' '}
              Lean towards what I star
            </label>
            <p className="hint">
              Uses only your own stars, on this computer. {lean.enough ? '' : `It starts to matter once you have starred 20 photos (you have ${lean.stars}).`}
            </p>
          </>
        )}
        <div className="modal-actions">
          <button onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}

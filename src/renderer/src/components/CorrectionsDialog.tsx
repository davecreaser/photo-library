import { useEffect, useState } from 'react'
import type { ClockCorrection } from '../../../shared/types.ts'
import { formatDate } from '../format.ts'

const api = window.api

function describe(c: { offsetYears: number; offsetSeconds: number }): string {
  const parts: string[] = []
  if (c.offsetYears) parts.push(`${c.offsetYears > 0 ? '+' : ''}${c.offsetYears} year${Math.abs(c.offsetYears) === 1 ? '' : 's'}`)
  if (c.offsetSeconds) {
    const h = c.offsetSeconds / 3600
    parts.push(`${h > 0 ? '+' : ''}${Number.isInteger(h) ? h : h.toFixed(2)} hour${Math.abs(h) === 1 ? '' : 's'}`)
  }
  return parts.join(' ') || 'no change'
}

/** Lists and edits camera clock corrections. These only change dates inside the app. */
export function CorrectionsDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [list, setList] = useState<ClockCorrection[]>([])
  const [cameras, setCameras] = useState<string[]>([])
  const [camera, setCamera] = useState('')
  const [years, setYears] = useState('0')
  const [hours, setHours] = useState('0')
  const [before, setBefore] = useState('')

  const load = async () => {
    const [l, c] = await Promise.all([api.listClockCorrections(), api.listCameras()])
    setList(l)
    setCameras(c)
    setCamera((cur) => cur || c[0] || '')
  }
  useEffect(() => {
    void load()
  }, [])

  const add = async () => {
    const offsetYears = Math.trunc(Number(years) || 0)
    const offsetSeconds = Math.round((Number(hours) || 0) * 3600)
    if (!camera || (!offsetYears && !offsetSeconds)) return
    await api.addClockCorrection({ camera, offsetYears, offsetSeconds, appliesBefore: before ? `${before}T00:00:00` : null })
    setYears('0')
    setHours('0')
    setBefore('')
    await load()
    onChanged()
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Camera date corrections</h2>
        <p className="hint">Fix photos from a camera whose clock was wrong. Only the dates shown in Photo Library change; your photo files are never edited.</p>

        {list.length === 0 && <p className="hint">No corrections yet.</p>}
        {list.map((c) => (
          <div key={c.id} className="correction">
            <span>
              <strong>{c.camera}</strong>: {describe(c)}
              {c.appliesBefore ? `, for photos the camera dated before ${formatDate(c.appliesBefore)}` : ', all photos'} · {c.photoCount} photos
            </span>
            <button
              onClick={async () => {
                await api.removeClockCorrection(c.id)
                await load()
                onChanged()
              }}
            >
              Undo
            </button>
          </div>
        ))}

        <h3>Add a correction</h3>
        <div className="correction-form">
          <label>
            Camera
            <select value={camera} onChange={(e) => setCamera(e.target.value)}>
              {cameras.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <label>
            Shift years
            <input type="number" value={years} onChange={(e) => setYears(e.target.value)} />
          </label>
          <label>
            Shift hours
            <input
              type="number"
              step="0.5"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              title="e.g. -1 if the camera wasn't switched to summer time"
            />
          </label>
          <label>
            Only before (camera date)
            <input type="date" value={before} onChange={(e) => setBefore(e.target.value)} />
          </label>
          <button onClick={add}>Add</button>
        </div>

        <div className="modal-footer">
          <button onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  )
}

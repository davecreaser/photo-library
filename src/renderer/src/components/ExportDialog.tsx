import { useEffect, useRef, useState } from 'react'
import type { ExportOptions, ExportProgress, ExportResult, ExportSource, ExportSummary } from '../../../shared/types.ts'

const api = window.api

type Stage = { kind: 'options' } | { kind: 'saving' } | { kind: 'finished'; result: Extract<ExportResult, { folderName: string }> }

const SIDES: { value: ExportOptions['maxSide']; label: string }[] = [
  { value: 0, label: 'Original size' },
  { value: 4000, label: '4000 px' },
  { value: 2000, label: '2000 px' },
  { value: 1600, label: '1600 px' }
]

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`

/** "Save copies…": options, then progress, then what happened (spec 0007). The folder is chosen in the main process. */
export function ExportDialog({ source: given, onClose }: { source: ExportSource; onClose: () => void }) {
  const [source] = useState(given) // fixed when opened, even if the selection behind the dialog changes
  const [summary, setSummary] = useState<ExportSummary | null>(null)
  const [options, setOptions] = useState<ExportOptions | null>(null)
  const [stage, setStage] = useState<Stage>({ kind: 'options' })
  const [progress, setProgress] = useState<ExportProgress | null>(null)
  const [refused, setRefused] = useState<string | null>(null)
  const opener = useRef<Element | null>(document.activeElement)
  const stageRef = useRef(stage)
  stageRef.current = stage

  useEffect(() => {
    void api.exportSummary(source).then((s) => {
      setSummary(s)
      setOptions(s.options)
    })
    const off = api.onExportProgress(setProgress)
    const back = opener.current as HTMLElement | null
    return () => {
      off()
      back?.focus?.()
    }
  }, [source])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (stageRef.current.kind === 'saving') void api.cancelExport()
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const choose = async () => {
    if (!options) return
    setRefused(null)
    setProgress(null)
    setStage({ kind: 'saving' })
    try {
      const result = await api.exportCopies(source, options)
      if (result.status === 'noFolder') setStage({ kind: 'options' })
      else if (result.status === 'refused') {
        setStage({ kind: 'options' })
        setRefused(
          result.reason === 'photoFolder'
            ? 'That folder is inside your photo folder. Choose somewhere else, such as Desktop or Documents.'
            : 'That folder is inside Photo Library’s own data folder. Choose somewhere else, such as Desktop or Documents.'
        )
      } else setStage({ kind: 'finished', result })
    } catch (e) {
      setStage({ kind: 'finished', result: { status: 'error', folderName: '', requested: summary?.count ?? 0, saved: 0, skipped: [], message: String(e) } })
    }
  }

  const count = summary?.count ?? 0

  return (
    <div className="modal-backdrop" onClick={() => stage.kind === 'options' && onClose()}>
      <div className="modal" role="dialog" aria-label="Save copies" onClick={(e) => e.stopPropagation()}>
        {stage.kind === 'options' && summary && options && (
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (count > 0) void choose()
            }}
          >
            <h2>Save copies of {plural(count, 'photo', 'photos')}</h2>
            <p className="hint">Makes a new folder of JPEG copies. Your photo folder is not touched.</p>
            <div className="correction-form">
              <label>
                Longest side
                <select value={options.maxSide} onChange={(e) => setOptions({ ...options, maxSide: Number(e.target.value) as ExportOptions['maxSide'] })}>
                  {SIDES.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="check">
                <input type="checkbox" checked={options.dateInNames} onChange={(e) => setOptions({ ...options, dateInNames: e.target.checked })} />
                Add the date to file names
              </label>
            </div>
            <p className="hint">RAW and HEIC photos are converted to JPEG. JPEG copies keep each photo’s information, including where it was taken.</p>
            {summary.missing > 0 && <p className="hint">{plural(summary.missing, 'missing photo', 'missing photos')} will be left out.</p>}
            {count === 0 && <p className="hint">There are no photos to save.</p>}
            {refused && <p className="error">{refused}</p>}
            <div className="modal-footer">
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button type="submit" className="primary" autoFocus disabled={count === 0}>
                Choose folder…
              </button>
            </div>
          </form>
        )}
        {stage.kind === 'saving' && (
          <>
            <h2>Saving copies</h2>
            <progress max={progress?.total || 1} value={progress?.done ?? 0} style={{ width: '100%' }} />
            <p className="hint">
              {progress ? `Saving ${Math.min(progress.done + 1, progress.total).toLocaleString()} of ${progress.total.toLocaleString()}` : 'Choose a folder…'}
            </p>
            <div className="modal-footer">
              <button onClick={() => void api.cancelExport()} title="Copies already saved stay where they are">
                Cancel
              </button>
            </div>
          </>
        )}
        {stage.kind === 'finished' && <Finished result={stage.result} onClose={onClose} onAgain={() => setStage({ kind: 'options' })} />}
      </div>
    </div>
  )
}

function Finished({ result, onClose, onAgain }: { result: Extract<ExportResult, { folderName: string }>; onClose: () => void; onAgain: () => void }) {
  const { status, saved, requested, folderName, skipped } = result
  const copies = plural(saved, 'copy', 'copies')
  return (
    <>
      <h2>{status === 'error' ? 'Couldn’t finish' : status === 'cancelled' ? 'Stopped' : 'Done'}</h2>
      {status === 'done' && (
        <p>
          Saved {saved.toLocaleString()} of {requested.toLocaleString()} copies to {folderName}.
        </p>
      )}
      {status === 'cancelled' && (
        <p>
          Stopped. {copies} {saved === 1 ? 'was' : 'were'} saved{saved > 0 ? ` to ${folderName}` : ''}.
        </p>
      )}
      {status === 'error' && (
        <p className="error">
          Couldn’t save to that folder: {result.message}. {copies} {saved === 1 ? 'was' : 'were'} saved.
        </p>
      )}
      {skipped.length > 0 && (
        <>
          <p className="hint">Couldn’t save:</p>
          <ul className="skipped-list">
            {skipped.map((s, i) => (
              <li key={i}>
                {s.name} ({s.reason})
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="modal-footer">
        {saved > 0 && <button onClick={() => void api.revealExport()}>Show in folder</button>}
        {status === 'error' && <button onClick={onAgain}>Choose another folder…</button>}
        <button className="primary" onClick={onClose}>
          Done
        </button>
      </div>
    </>
  )
}

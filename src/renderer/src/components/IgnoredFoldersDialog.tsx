import { useEffect, useState } from 'react'

const api = window.api

const isPath = (rule: string) => rule.includes('/')

/** Edits which folders the app ignores. Changes apply together, with one rescan, on Save. */
export function IgnoredFoldersDialog({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [saved, setSaved] = useState<string[] | null>(null)
  const [rules, setRules] = useState<string[]>([])
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void api.getIgnoredFolders().then((r) => {
      setSaved(r)
      setRules(r)
    })
  }, [])

  const add = (rule: string) => {
    const clean = rule.trim().replace(/^\/+|\/+$/g, '')
    if (clean && !rules.some((r) => r.toLowerCase() === clean.toLowerCase())) setRules([...rules, clean])
  }

  const added = rules.filter((r) => !saved?.includes(r))
  const removed = (saved ?? []).filter((r) => !rules.includes(r))
  const dirty = added.length > 0 || removed.length > 0

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Ignored folders</h2>
        <p className="hint">
          Photo Library skips these folders entirely. Your files are never touched. Photos already in the library from a newly ignored folder are forgotten by
          the app, including their faces, names and tags. Remove a rule and they come back on the next scan.
        </p>

        {rules.length === 0 && <p className="hint">Nothing is ignored.</p>}
        {rules.map((r) => (
          <div key={r} className="correction">
            <span>
              {isPath(r) ? (
                <>
                  The folder <strong>{r}</strong> and everything in it
                </>
              ) : (
                <>
                  Any folder named <strong>{r}</strong>, anywhere
                </>
              )}
              {added.includes(r) && <span className="hint"> (new)</span>}
            </span>
            <button onClick={() => setRules(rules.filter((x) => x !== r))}>Remove</button>
          </div>
        ))}

        <h3>Add</h3>
        <div className="correction-form">
          <label>
            Folder name (matches anywhere)
            <input
              value={name}
              placeholder="e.g. private"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  add(name)
                  setName('')
                }
              }}
            />
          </label>
          <button
            onClick={() => {
              add(name)
              setName('')
            }}
            disabled={!name.trim()}
          >
            Add name
          </button>
          <span className="hint">or</span>
          <button
            onClick={async () => {
              const rel = await api.chooseIgnoredFolder()
              if (rel) add(rel)
            }}
          >
            Choose a specific folder…
          </button>
        </div>

        <div className="modal-footer">
          {dirty && (
            <span className="hint footer-note">
              {added.length > 0 && `Photos in ${added.length === 1 ? 'that folder' : 'those folders'} will be forgotten by the app. `}
              Saving rescans your library.
            </span>
          )}
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary-small"
            disabled={!dirty || saving}
            onClick={async () => {
              setSaving(true)
              await api.setIgnoredFolders(rules)
              setSaving(false)
              onChanged()
              onClose()
            }}
          >
            {saving ? 'Rescanning…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}

import { useEffect, useState } from 'react'
import type { AssistantStatus } from '../../../shared/types.ts'

const api = window.api

export const ASSISTANT_ALBUM_HINT = 'Made by an AI assistant. It becomes yours when you rename it, move it, or add or remove photos.'

function CopyButton({ text }: { text: string }) {
  const [label, setLabel] = useState('Copy')
  return (
    <button
      onClick={async () => {
        const ok = await api.copyText(text).catch(() => false)
        setLabel(ok ? 'Copied' : "Couldn't copy")
        setTimeout(() => setLabel('Copy'), 2000)
      }}
    >
      {label}
    </button>
  )
}

/** Assistant access (spec 0008): the switch, the setup to copy, and forgetting connected assistants. */
export function AssistantDialog({ status, onClose }: { status: AssistantStatus | null; onClose: () => void }) {
  const [confirmForget, setConfirmForget] = useState(false)
  const [forgotten, setForgotten] = useState(false)
  /** The switch follows the click at once, until the main process reports the new state. */
  const [wanted, setWanted] = useState<boolean | null>(null)
  const s = status ?? { state: 'off' as const }

  const close = () => {
    // A failure is shown until the owner has seen it (design, state 4).
    if (s.state === 'failed') void api.setAssistantAccess(false)
    onClose()
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (confirmForget) setConfirmForget(false)
        else close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal assistant-dialog" role="dialog" aria-label="Assistant access" onClick={(e) => e.stopPropagation()}>
        <h2>Assistant access</h2>
        <label className="toggle">
          <input
            type="checkbox"
            checked={wanted ?? (s.state === 'on' || s.state === 'starting')}
            disabled={s.state === 'starting'}
            onChange={async (e) => {
              const on = e.target.checked
              setWanted(on)
              setConfirmForget(false)
              setForgotten(false)
              try {
                await api.setAssistantAccess(on)
              } finally {
                setWanted(null)
              }
            }}
          />{' '}
          Let AI assistants use this library
          {s.state === 'starting' && <span className="hint"> Starting…</span>}
        </label>
        <p className="hint">
          An AI assistant such as Claude can search this library and make albums of its own. It sees capture dates, album names, people&apos;s names and
          favourites, and may send them to its company&apos;s servers. It never sees the photos themselves, file or folder names, places, or anything in an
          ignored folder, and it can&apos;t change your files or your own albums.
        </p>
        {s.state === 'failed' && <p className="error">Couldn&apos;t start assistant access: {s.reason}.</p>}
        {s.state === 'on' && s.desktopJson && s.claudeCommand && (
          <>
            <h3>Set up an assistant</h3>
            <p className="hint">
              Needs Node.js 22.18 or later on this computer. The text below includes a secret key for this library: keep it private, like a password.
            </p>
            <h4>Claude Desktop</h4>
            <p className="hint">
              In Claude Desktop, open Settings › Developer › Edit Config and add this. If the file already lists other servers, add only the
              &quot;photo-library&quot; entry inside its &quot;mcpServers&quot;. Then restart Claude Desktop.
            </p>
            <pre className="snippet" aria-label="Claude Desktop setup">
              {s.desktopJson}
            </pre>
            <CopyButton text={s.desktopJson} />
            <h4>Claude Code</h4>
            <p className="hint">Run this once in a terminal:</p>
            <pre className="snippet wrap" aria-label="Claude Code setup">
              {s.claudeCommand}
            </pre>
            <CopyButton text={s.claudeCommand} />
            <div className="forget-assistants">
              {forgotten ? (
                <p className="hint">Done. Copy the setup again into each assistant you still want to use.</p>
              ) : confirmForget ? (
                <span className="confirm-inline">
                  Forget every connected assistant? They lose access now and need setting up again with the new text above. Your photos and albums are not
                  affected.{' '}
                  <button
                    className="link danger-link"
                    autoFocus
                    onClick={async () => {
                      await api.forgetAssistants()
                      setConfirmForget(false)
                      setForgotten(true)
                    }}
                  >
                    Forget
                  </button>{' '}
                  <button className="link" onClick={() => setConfirmForget(false)}>
                    Cancel
                  </button>
                </span>
              ) : (
                <button className="link" onClick={() => setConfirmForget(true)}>
                  Forget connected assistants…
                </button>
              )}
            </div>
            <p className="hint">Turning this off or forgetting assistants stops their access at once. What an assistant has already read stays with it.</p>
          </>
        )}
        <div className="modal-actions">
          <button onClick={close}>Done</button>
        </div>
      </div>
    </div>
  )
}

import { useState } from 'react'
import type { Album, FaceProgress, LibraryInfo, Person, Tag, TimelineMonth } from '../../../shared/types.ts'
import type { View } from '../App.tsx'
import { monthName } from '../format.ts'
import { AlbumPicker } from './AlbumPicker.tsx'
import { InlineInput } from './InlineInput.tsx'

interface Props {
  library: LibraryInfo
  view: View
  albums: Album[]
  tags: Tag[]
  timeline: TimelineMonth[]
  /** Suggested albums waiting; 0 hides the count. */
  suggestionCount: number
  people: Person[]
  faceProgress: FaceProgress | null
  onNavigate: (v: View) => void
  onChangeBase: () => void
  onAlbumsChanged: () => void
  onShowCorrections: () => void
  onShowIgnored: () => void
}

const api = window.api

export function Sidebar({
  library,
  view,
  albums,
  tags,
  timeline,
  suggestionCount,
  people,
  faceProgress,
  onNavigate,
  onChangeBase,
  onAlbumsChanged,
  onShowCorrections,
  onShowIgnored
}: Props) {
  const [openYears, setOpenYears] = useState<Set<string>>(new Set())
  // Which album is being created under (null = top level), renamed, or confirmed for deletion.
  const [creatingUnder, setCreatingUnder] = useState<number | null | undefined>(undefined)
  const [renaming, setRenaming] = useState<number | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null)
  const [confirmForget, setConfirmForget] = useState(false)
  // Album being dragged, the drop target under the pointer ('top' = the Albums heading), and the album whose "Move to…" is open.
  const [dragging, setDragging] = useState<number | null>(null)
  const [dropOn, setDropOn] = useState<number | 'top' | null>(null)
  const [moving, setMoving] = useState<number | null>(null)

  /** The album and everything inside it. */
  const withDescendants = (id: number): number[] => [id, ...albums.filter((a) => a.parentId === id).flatMap((a) => withDescendants(a.id))]
  const canDrop = (target: number | null) =>
    dragging != null && !(target != null && withDescendants(dragging).includes(target)) && albums.find((a) => a.id === dragging)?.parentId !== target
  async function moveAlbum(id: number, target: number | null) {
    setDragging(null)
    setDropOn(null)
    setMoving(null)
    if (await api.moveAlbum(id, target)) onAlbumsChanged()
  }
  const dropProps = (target: number | null) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!canDrop(target)) return
      e.preventDefault()
      setDropOn(target ?? 'top')
    },
    onDragLeave: () => setDropOn((d) => (d === (target ?? 'top') ? null : d)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault()
      if (dragging != null && canDrop(target)) void moveAlbum(dragging, target)
    }
  })

  const years = [...new Set(timeline.map((t) => t.year))]
  const yearCount = (y: string) => timeline.filter((t) => t.year === y).reduce((n, t) => n + t.count, 0)
  const toggleYear = (y: string) =>
    setOpenYears((s) => {
      const next = new Set(s)
      if (next.has(y)) next.delete(y)
      else next.add(y)
      return next
    })

  const isActive = (v: View) => JSON.stringify(v) === JSON.stringify(view)

  const renderAlbums = (parentId: number | null, depth: number) => (
    <>
      {albums
        .filter((a) => a.parentId === parentId)
        .map((a) => (
          <div key={a.id}>
            {renaming === a.id ? (
              <InlineInput
                initial={a.name}
                onSubmit={async (name) => {
                  await api.renameAlbum(a.id, name)
                  setRenaming(null)
                  onAlbumsChanged()
                }}
                onCancel={() => setRenaming(null)}
              />
            ) : confirmDelete === a.id ? (
              <div className="confirm" style={{ paddingLeft: 12 + depth * 14 }}>
                <span>
                  Delete album “{a.name}”?{' '}
                  {albums.some((c) => c.parentId === a.id) &&
                    `Its ${albums.filter((c) => c.parentId === a.id).length === 1 ? 'sub-album moves' : 'sub-albums move'} up one level. `}
                  Photos stay on disk{a.fromSuggestion ? ', and it goes back to Suggested albums' : ''}.
                </span>
                <button
                  className="danger"
                  onClick={async () => {
                    await api.deleteAlbum(a.id)
                    setConfirmDelete(null)
                    if (isActive({ kind: 'album', id: a.id })) onNavigate({ kind: 'all' })
                    onAlbumsChanged()
                  }}
                >
                  Delete
                </button>
                <button onClick={() => setConfirmDelete(null)}>Cancel</button>
              </div>
            ) : (
              <div
                className={`nav-item album ${isActive({ kind: 'album', id: a.id }) ? 'active' : ''} ${dropOn === a.id ? 'drop-target' : ''}`}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move'
                  setDragging(a.id)
                }}
                onDragEnd={() => {
                  setDragging(null)
                  setDropOn(null)
                }}
                {...dropProps(a.id)}
                style={{ paddingLeft: 12 + depth * 14 }}
                onClick={() => onNavigate({ kind: 'album', id: a.id })}
              >
                <span className="label">📁 {a.name}</span>
                <span className="count">{a.photoCount}</span>
                <span className="actions" onClick={(e) => e.stopPropagation()}>
                  <button title="New sub-album" onClick={() => setCreatingUnder(a.id)}>
                    ＋
                  </button>
                  <button title="Move to…" onClick={() => setMoving(a.id)}>
                    ⇥
                  </button>
                  <button title="Rename" onClick={() => setRenaming(a.id)}>
                    ✎
                  </button>
                  <button title="Delete album" onClick={() => setConfirmDelete(a.id)}>
                    ✕
                  </button>
                </span>
              </div>
            )}
            {moving === a.id && (
              <div className="popover-anchor">
                <AlbumPicker
                  albums={albums}
                  exclude={withDescendants(a.id)}
                  onTopLevel={a.parentId != null ? () => void moveAlbum(a.id, null) : undefined}
                  noNew
                  onPick={(target) => void moveAlbum(a.id, target)}
                  onClose={() => setMoving(null)}
                />
              </div>
            )}
            {renderAlbums(a.id, depth + 1)}
            {creatingUnder === a.id && (
              <div style={{ paddingLeft: 12 + (depth + 1) * 14 }}>
                <InlineInput placeholder="Album name" onSubmit={createAlbum} onCancel={() => setCreatingUnder(undefined)} />
              </div>
            )}
          </div>
        ))}
    </>
  )

  async function createAlbum(name: string) {
    const album = await api.createAlbum(name, creatingUnder ?? null)
    setCreatingUnder(undefined)
    onAlbumsChanged()
    onNavigate({ kind: 'album', id: album.id })
  }

  return (
    <nav className="sidebar">
      <section>
        <div className={`nav-item ${isActive({ kind: 'all' }) ? 'active' : ''}`} onClick={() => onNavigate({ kind: 'all' })}>
          <span className="label">🖼 All photos</span>
          <span className="count">{library.photoCount.toLocaleString()}</span>
        </div>
        <div className={`nav-item ${isActive({ kind: 'favorites' }) ? 'active' : ''}`} onClick={() => onNavigate({ kind: 'favorites' })}>
          <span className="label">★ Favourites</span>
          <span className="count">{library.favoriteCount.toLocaleString()}</span>
        </div>
        <div
          className={`nav-item ${view.kind === 'suggestions' || view.kind === 'suggestion' ? 'active' : ''}`}
          onClick={() => onNavigate({ kind: 'suggestions' })}
        >
          <span className="label">✨ Suggested albums</span>
          <span className="count">{suggestionCount > 0 ? suggestionCount.toLocaleString() : ''}</span>
        </div>
        <div className={`nav-item ${view.kind === 'people' ? 'active' : ''}`} onClick={() => onNavigate({ kind: 'people' })}>
          <span className="label">👤 People</span>
          <span className="count">
            {faceProgress?.phase === 'analysing' ? `${Math.floor((faceProgress.done / Math.max(1, faceProgress.total)) * 100)}%` : people.length || ''}
          </span>
        </div>
        {people.slice(0, 12).map((p) => (
          <div
            key={p.id}
            className={`nav-item person ${view.kind === 'person' && view.id === p.id ? 'active' : ''}`}
            onClick={() => onNavigate({ kind: 'person', id: p.id })}
          >
            <span className="label">
              {p.coverFaceId && <img className="avatar" src={`photo://face/${p.coverFaceId}`} alt="" />} {p.name}
            </span>
            <span className="count">{p.photoCount}</span>
          </div>
        ))}
      </section>

      <section>
        <h2 className={dropOn === 'top' ? 'drop-target' : ''} {...dropProps(null)}>
          Albums
          <button title="New album" onClick={() => setCreatingUnder(null)}>
            ＋
          </button>
        </h2>
        {creatingUnder === null && <InlineInput placeholder="Album name" onSubmit={createAlbum} onCancel={() => setCreatingUnder(undefined)} />}
        {albums.length === 0 && creatingUnder === undefined && <p className="hint">Albums are virtual folders. Adding photos never moves the files.</p>}
        {renderAlbums(null, 0)}
      </section>

      {tags.length > 0 && (
        <section>
          <h2>Tags</h2>
          {tags.map((t) => (
            <div key={t.id} className={`nav-item ${isActive({ kind: 'tag', id: t.id }) ? 'active' : ''}`} onClick={() => onNavigate({ kind: 'tag', id: t.id })}>
              <span className="label">#{t.name}</span>
              <span className="count">{t.photoCount}</span>
            </div>
          ))}
        </section>
      )}

      <section>
        <h2>Timeline</h2>
        {years.map((y) => (
          <div key={y}>
            <div className={`nav-item ${isActive({ kind: 'year', year: y }) ? 'active' : ''}`} onClick={() => onNavigate({ kind: 'year', year: y })}>
              <span className="label">
                <span
                  className="disclosure"
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleYear(y)
                  }}
                >
                  {openYears.has(y) ? '▾' : '▸'}
                </span>{' '}
                {y}
              </span>
              <span className="count">{yearCount(y)}</span>
            </div>
            {openYears.has(y) &&
              timeline
                .filter((t) => t.year === y)
                .map((t) => (
                  <div
                    key={t.month}
                    className={`nav-item month ${isActive({ kind: 'month', year: y, month: t.month }) ? 'active' : ''}`}
                    onClick={() => onNavigate({ kind: 'month', year: y, month: t.month })}
                  >
                    <span className="label">{monthName(t.month)}</span>
                    <span className="count">{t.count}</span>
                  </div>
                ))}
          </div>
        ))}
        {library.undatedCount > 0 && (
          <div className={`nav-item ${isActive({ kind: 'undated' }) ? 'active' : ''}`} onClick={() => onNavigate({ kind: 'undated' })}>
            <span className="label">
              <span className="disclosure" /> Undated
            </span>
            <span className="count">{library.undatedCount}</span>
          </div>
        )}
      </section>

      <footer className="sidebar-footer">
        <button className="link" onClick={onShowCorrections}>
          Camera date corrections…
        </button>
        <button className="link" onClick={onShowIgnored}>
          Ignored folders…
        </button>
        <div className="base-path" title={library.basePath ?? ''}>
          📂 {library.basePath}
        </div>
        {library.missingCount > 0 && (
          <div className="hint">
            {library.missingCount} photos no longer found in this folder (hidden). If they come back, their albums and tags return too.{' '}
            {confirmForget ? (
              <span className="confirm-inline">
                Forget their albums/tags? Files are not touched.{' '}
                <button
                  className="link danger-link"
                  onClick={async () => {
                    await api.forgetMissing()
                    setConfirmForget(false)
                    onAlbumsChanged()
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
                Forget them…
              </button>
            )}
          </div>
        )}
        <button onClick={onChangeBase}>Change folder…</button>
      </footer>
    </nav>
  )
}

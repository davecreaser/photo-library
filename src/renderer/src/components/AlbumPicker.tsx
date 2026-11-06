import { useState } from 'react'
import type { Album } from '../../../shared/types.ts'
import { InlineInput } from './InlineInput.tsx'

/** Dropdown list of albums (indented by nesting) plus a "new album" entry. */
export function AlbumPicker(props: {
  albums: Album[]
  exclude?: number[]
  /** Adds a "Top level" entry first (for moving an album out). */
  onTopLevel?: () => void
  /** Hides the "new album" entry. */
  noNew?: boolean
  onPick: (albumId: number) => void
  onClose: () => void
}) {
  const [creating, setCreating] = useState(false)

  const ordered: { album: Album; depth: number }[] = []
  const walk = (parentId: number | null, depth: number) =>
    props.albums
      .filter((a) => a.parentId === parentId)
      .forEach((a) => {
        ordered.push({ album: a, depth })
        walk(a.id, depth + 1)
      })
  walk(null, 0)

  return (
    <div className="popover" onMouseLeave={creating ? undefined : props.onClose}>
      {props.onTopLevel && (
        <div className="popover-item" onClick={props.onTopLevel}>
          Top level
        </div>
      )}
      {ordered
        .filter(({ album }) => !props.exclude?.includes(album.id))
        .map(({ album, depth }) => (
          <div key={album.id} className="popover-item" style={{ paddingLeft: 10 + depth * 14 }} onClick={() => props.onPick(album.id)}>
            📁 {album.name}
          </div>
        ))}
      {props.noNew ? null : creating ? (
        <InlineInput
          placeholder="New album name"
          onSubmit={async (name) => props.onPick((await window.api.createAlbum(name, null)).id)}
          onCancel={() => setCreating(false)}
        />
      ) : (
        <div className="popover-item new" onClick={() => setCreating(true)}>
          ＋ New album…
        </div>
      )}
    </div>
  )
}

import { useState } from 'react'
import type { Album, Tag } from '../../../shared/types.ts'
import { AlbumPicker } from './AlbumPicker.tsx'
import { TagInput } from './TagInput.tsx'

const api = window.api

interface Props {
  selected: number[]
  albums: Album[]
  tags: Tag[]
  currentAlbumId: number | null
  /** `clear` says whether the selection should be cleared afterwards. */
  onDone: (clear: boolean) => void
  onClear: () => void
}

export function SelectionBar({ selected, albums, tags, currentAlbumId, onDone, onClear }: Props) {
  const [picking, setPicking] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const flash = (text: string) => {
    setMessage(text)
    setTimeout(() => setMessage(null), 2000)
  }

  return (
    <div className="selection-bar">
      <span className="selection-count">{selected.length} selected</span>
      <div className="popover-anchor">
        <button onClick={() => setPicking((p) => !p)}>Add to album ▾</button>
        {picking && (
          <AlbumPicker
            albums={albums}
            exclude={currentAlbumId ? [currentAlbumId] : []}
            onPick={async (albumId) => {
              await api.addToAlbum(albumId, selected)
              setPicking(false)
              flash(`Added to ${albums.find((a) => a.id === albumId)?.name ?? 'album'}`)
              onDone(false)
            }}
            onClose={() => setPicking(false)}
          />
        )}
      </div>
      <TagInput
        tags={tags}
        placeholder="Tag selected…"
        onAdd={async (name) => {
          await api.addTag(selected, name)
          flash(`Tagged #${name}`)
          onDone(false)
        }}
      />
      <button
        onClick={async () => {
          await api.setFavorite(selected, true)
          flash('Added to favourites')
          onDone(false)
        }}
      >
        ★ Favourite
      </button>
      {currentAlbumId !== null && (
        <button
          onClick={async () => {
            await api.removeFromAlbum(currentAlbumId, selected)
            onDone(true)
          }}
          title="Removes them from this album only. The files are not touched."
        >
          Remove from album
        </button>
      )}
      <button onClick={onClear}>Clear</button>
      {message && <span className="flash">{message}</span>}
    </div>
  )
}

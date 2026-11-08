import { useEffect, useState } from 'react'
import type { Album, Person, Photo, PhotoDetails, Tag } from '../../../shared/types.ts'
import { formatBytes, formatDateTime } from '../format.ts'
import { AlbumPicker } from './AlbumPicker.tsx'
import { TagInput } from './TagInput.tsx'

const api = window.api

interface Props {
  photos: Photo[]
  index: number
  albums: Album[]
  tags: Tag[]
  people: Person[]
  /** Why this photo is in a Best of pick (spec 0006). */
  reason?: string
  onIndexChange: (i: number) => void
  onClose: () => void
  onChanged: () => void
}

export function Viewer({ photos, index, albums, tags, people, reason, onIndexChange, onClose, onChanged }: Props) {
  const photo = photos[index]
  const [details, setDetails] = useState<PhotoDetails | null>(null)
  const [picking, setPicking] = useState(false)

  const reload = () => api.getPhoto(photo.id).then(setDetails)
  useEffect(() => {
    setDetails(null)
    void reload()
  }, [photo.id])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return
      if (e.key === 'Escape') onClose()
      if (e.key === 'ArrowRight' && index < photos.length - 1) onIndexChange(index + 1)
      if (e.key === 'ArrowLeft' && index > 0) onIndexChange(index - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, photos.length])

  const changed = async () => {
    await reload()
    onChanged()
  }

  return (
    <div className="viewer">
      <div className="viewer-stage" onClick={onClose}>
        {/* Thumbnail first so something shows instantly, full image layered on top. */}
        <img className="viewer-img placeholder" src={`photo://thumb/${photo.id}`} alt="" />
        <img key={photo.id} className="viewer-img" src={`photo://full/${photo.id}`} alt={photo.fileName} onClick={(e) => e.stopPropagation()} />
        {index > 0 && (
          <button
            className="nav prev"
            onClick={(e) => {
              e.stopPropagation()
              onIndexChange(index - 1)
            }}
          >
            ‹
          </button>
        )}
        {index < photos.length - 1 && (
          <button
            className="nav next"
            onClick={(e) => {
              e.stopPropagation()
              onIndexChange(index + 1)
            }}
          >
            ›
          </button>
        )}
        <button className="close" onClick={onClose} title="Close (Esc)">
          ✕
        </button>
      </div>

      <aside className="viewer-info">
        <div className="viewer-title">
          <h3>{formatDateTime(photo.takenAt)}</h3>
          <button
            className={`star ${details?.favorite ? 'on' : ''}`}
            title={details?.favorite ? 'Remove from favourites' : 'Add to favourites'}
            onClick={async () => {
              await api.setFavorite([photo.id], !details?.favorite)
              await changed()
            }}
          >
            {details?.favorite ? '★' : '☆'}
          </button>
        </div>
        {reason && <p className="best-of-reason">{reason}</p>}
        {photo.dateSource === 'unknown' && <p className="hint">The photo has no date in it (e.g. a scan or a download).</p>}
        {photo.takenAtRaw && <p className="hint">Date corrected for the camera’s clock. The camera recorded {formatDateTime(photo.takenAtRaw)}.</p>}
        <dl>
          <dt>File</dt>
          <dd className="path" title={photo.path}>
            {photo.fileName}
          </dd>
          {photo.camera && (
            <>
              <dt>Camera</dt>
              <dd>{photo.camera}</dd>
            </>
          )}
          {photo.width && photo.height && (
            <>
              <dt>Size</dt>
              <dd>
                {photo.width} × {photo.height} · {formatBytes(photo.size)}
              </dd>
            </>
          )}
          {photo.lat != null && photo.lon != null && (
            <>
              <dt>Location</dt>
              <dd>
                {photo.lat.toFixed(5)}, {photo.lon.toFixed(5)}
              </dd>
            </>
          )}
        </dl>
        <button onClick={() => api.revealInFinder(photo.id)}>Show in Finder</button>
        {details && details.locations.length > 1 && (
          <>
            <h4>Found in {details.locations.length} places</h4>
            <ul className="locations">
              {details.locations.map((l) => (
                <li key={l} title={l}>
                  {l.split(/[\\/]/).slice(-3).join('/')}
                </li>
              ))}
            </ul>
            <p className="hint">Identical copies are shown once. Albums and tags apply to all of them.</p>
          </>
        )}

        {details && details.faces.length > 0 && (
          <>
            <h4>People</h4>
            <div className="viewer-faces">
              {details.faces.map((f) => (
                <div key={f.id} className="viewer-face">
                  <img src={`photo://face/${f.id}`} alt="" />
                  {f.name ? (
                    <>
                      <span>
                        {f.name}
                        {f.auto && <span className="hint"> (auto)</span>}
                      </span>
                      <button
                        className="link"
                        title={`Not ${f.name}`}
                        onClick={async () => {
                          await api.rejectFace(f.id)
                          await changed()
                        }}
                      >
                        ✕
                      </button>
                    </>
                  ) : (
                    <TagInput
                      tags={people.map((p) => ({ id: p.id, name: p.name }))}
                      placeholder="Who’s this?"
                      onAdd={async (name) => {
                        await api.nameFace(f.id, name)
                        await changed()
                      }}
                    />
                  )}
                </div>
              ))}
            </div>
          </>
        )}

        <h4>Albums</h4>
        <div className="chips">
          {details?.albums.map((a) => (
            <span key={a.id} className="chip">
              📁 {a.name}
              <button
                title="Remove from album"
                onClick={async () => {
                  await api.removeFromAlbum(a.id, [photo.id])
                  await changed()
                }}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
        <div className="popover-anchor">
          <button onClick={() => setPicking((p) => !p)}>Add to album ▾</button>
          {picking && (
            <AlbumPicker
              albums={albums}
              exclude={details?.albums.map((a) => a.id)}
              onPick={async (id) => {
                await api.addToAlbum(id, [photo.id])
                setPicking(false)
                await changed()
              }}
              onClose={() => setPicking(false)}
            />
          )}
        </div>

        <h4>Tags</h4>
        <div className="chips">
          {details?.tags.map((t) => (
            <span key={t.id} className="chip">
              #{t.name}
              <button
                title="Remove tag"
                onClick={async () => {
                  await api.removeTag([photo.id], t.id)
                  await changed()
                }}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
        <TagInput
          tags={tags}
          onAdd={async (name) => {
            await api.addTag([photo.id], name)
            await changed()
          }}
        />

        <p className="hint position">
          {index + 1} of {photos.length} · ← → to browse
        </p>
      </aside>
    </div>
  )
}

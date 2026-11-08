import { useEffect, useState } from 'react'
import type { Photo } from '../../../shared/types.ts'

const api = window.api

/** The photos of one stacked look-alike group (spec 0006, AC-8), opened from a stack's badge. */
export function LookalikeGroup({
  ids,
  onPhotosLoaded,
  onOpen,
  onBack
}: {
  ids: number[]
  onPhotosLoaded: (p: Photo[]) => void
  onOpen: (i: number) => void
  onBack: () => void
}) {
  const [photos, setPhotos] = useState<Photo[]>([])
  useEffect(() => {
    void api.getPhotosByIds(ids).then((p) => {
      setPhotos(p)
      onPhotosLoaded(p)
    })
  }, [ids.join()])
  return (
    <div className="grid-scroller">
      <div className="grid-meta">
        {ids.length} similar photos{' '}
        <button className="link" onClick={onBack}>
          Back
        </button>
      </div>
      <div className="grid">
        {photos.map((p, i) => (
          <div key={p.id} className="tile" onClick={() => onOpen(i)}>
            <img src={`photo://thumb/${p.id}`} loading="lazy" decoding="async" alt="" />
            {p.favorite && <span className="fav-badge">★</span>}
          </div>
        ))}
      </div>
    </div>
  )
}

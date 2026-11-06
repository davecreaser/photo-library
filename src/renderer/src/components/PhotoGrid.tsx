import { useEffect, useRef, useState } from 'react'
import type { Photo, PhotoFilter } from '../../../shared/types.ts'
import { formatDate } from '../format.ts'

const PAGE = 300
const api = window.api

interface Props {
  filter: PhotoFilter
  /** Changes when the current list should be refreshed in place (e.g. after tagging). */
  version: number
  selected: Set<number>
  onSelectionChange: (s: Set<number>) => void
  onPhotosLoaded: (photos: Photo[]) => void
  onOpen: (index: number) => void
}

export function PhotoGrid({ filter, version, selected, onSelectionChange, onPhotosLoaded, onOpen }: Props) {
  const [photos, setPhotos] = useState<Photo[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const sentinel = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const lastClicked = useRef<number | null>(null)
  const filterKey = JSON.stringify(filter)
  // Guards against out-of-order responses when the filter changes quickly.
  const requestId = useRef(0)

  const load = async (offset: number, limit: number, replace: boolean) => {
    const id = ++requestId.current
    setLoading(true)
    const page = await api.queryPhotos({ ...filter, offset, limit })
    if (id !== requestId.current) return
    setTotal(page.total)
    setPhotos((prev) => (replace ? page.photos : [...prev, ...page.photos]))
    setLoading(false)
  }

  // New view: start from the top.
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 })
    lastClicked.current = null
    void load(0, PAGE, true)
  }, [filterKey])

  // Same view, data changed: reload what's already shown without jumping.
  useEffect(() => {
    if (version > 0) void load(0, Math.max(photos.length, PAGE), true)
  }, [version])

  useEffect(() => onPhotosLoaded(photos), [photos])

  // Infinite scroll.
  useEffect(() => {
    const el = sentinel.current
    if (!el) return
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !loading && photos.length < total) void load(photos.length, PAGE, false)
      },
      { root: scroller.current, rootMargin: '800px' }
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [photos.length, total, loading])

  const handleClick = (e: React.MouseEvent, index: number, photo: Photo) => {
    const selecting = e.metaKey || e.ctrlKey || e.shiftKey || selected.size > 0
    if (!selecting) {
      onOpen(index)
      return
    }
    const next = new Set(selected)
    if (e.shiftKey && lastClicked.current !== null) {
      const [from, to] = [Math.min(lastClicked.current, index), Math.max(lastClicked.current, index)]
      for (let i = from; i <= to; i++) next.add(photos[i].id)
    } else if (next.has(photo.id)) {
      next.delete(photo.id)
    } else {
      next.add(photo.id)
    }
    lastClicked.current = index
    onSelectionChange(next)
  }

  const toggle = (e: React.MouseEvent, index: number, photo: Photo) => {
    e.stopPropagation()
    const next = new Set(selected)
    if (next.has(photo.id)) next.delete(photo.id)
    else next.add(photo.id)
    lastClicked.current = index
    onSelectionChange(next)
  }

  return (
    <div className="grid-scroller" ref={scroller}>
      <div className="grid-meta">
        {total.toLocaleString()} {total === 1 ? 'photo' : 'photos'}
        {selected.size > 0 ? ` · ${selected.size} selected` : ' · ⌘-click or shift-click to select'}
      </div>
      {!loading && total === 0 && <div className="empty">No photos here yet.</div>}
      <div className="grid">
        {photos.map((p, i) => (
          <div
            key={p.id}
            className={`tile ${selected.has(p.id) ? 'selected' : ''}`}
            onClick={(e) => handleClick(e, i, p)}
            title={`${p.fileName} · ${formatDate(p.takenAt)}`}
          >
            <img src={`photo://thumb/${p.id}`} loading="lazy" decoding="async" alt="" />
            <span className="check" onClick={(e) => toggle(e, i, p)}>{selected.has(p.id) ? '✓' : ''}</span>
            {p.favorite && <span className="fav-badge">★</span>}
          </div>
        ))}
      </div>
      <div ref={sentinel} className="sentinel" />
    </div>
  )
}

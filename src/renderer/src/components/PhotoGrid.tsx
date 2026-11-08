import { useEffect, useMemo, useRef, useState } from 'react'
import type { ContentProgress, Photo, PhotoFilter, SearchInfo } from '../../../shared/types.ts'
import { formatDate, photoCount } from '../format.ts'
import { dividerLabel, emptySearch, searchHint, searchMeta } from '../searchCopy.ts'

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
  /** The search typed, in the search view (spec 0002); null in other views. */
  searchText: string | null
  contentProgress: ContentProgress | null
  /** Look-alike groups to show as one tile each (spec 0006, AC-8); null shows every photo. */
  stack?: number[][] | null
  onOpenGroup?: (ids: number[]) => void
}

export function PhotoGrid({
  filter,
  version,
  selected,
  onSelectionChange,
  onPhotosLoaded,
  onOpen,
  searchText,
  contentProgress,
  stack = null,
  onOpenGroup
}: Props) {
  const [photos, setPhotos] = useState<Photo[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  // A search's make-up (name matches, then content matches) and whether a new one is loading.
  const [info, setInfo] = useState<SearchInfo | undefined>(undefined)
  const [searching, setSearching] = useState(false)
  // Results found while analysis was running: once it finishes, say so (they never refresh by themselves).
  const [loadedWhileAnalysing, setLoadedWhileAnalysing] = useState(false)
  const progress = useRef(contentProgress)
  progress.current = contentProgress
  const sentinel = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const lastClicked = useRef<number | null>(null)
  const filterKey = JSON.stringify(filter)
  // Guards against out-of-order responses when the filter changes quickly.
  const requestId = useRef(0)

  const load = async (offset: number, limit: number, replace: boolean) => {
    const id = ++requestId.current
    setLoading(true)
    const analysing = progress.current?.phase === 'analysing'
    const page = await api.queryPhotos({ ...filter, offset, limit })
    if (id !== requestId.current) return
    setTotal(page.total)
    setInfo(page.search)
    if (offset === 0) setLoadedWhileAnalysing(analysing)
    setPhotos((prev) => (replace ? page.photos : [...prev, ...page.photos]))
    setLoading(false)
    setSearching(false)
  }

  /** Runs the search again from the top (the "Refresh results" link). */
  const refresh = () => {
    scroller.current?.scrollTo({ top: 0 })
    lastClicked.current = null
    void load(0, PAGE, true)
  }

  // New view: start from the top. A new search keeps the old results until the first page arrives.
  useEffect(() => {
    if (searchText !== null) setSearching(true)
    refresh()
  }, [filterKey])

  // Same view, data changed: reload what's already shown without jumping.
  useEffect(() => {
    if (version > 0) void load(0, Math.max(photos.length, PAGE), true)
  }, [version])

  // Stacking hides every photo of a group but its best, and badges that one with the group's size.
  // It only changes what is shown: counts and the album stay as they are.
  const stacks = useMemo(() => {
    const lead = new Map<number, number[]>()
    const hidden = new Set<number>()
    for (const g of stack ?? []) {
      lead.set(g[0], g)
      g.slice(1).forEach((id) => hidden.add(id))
    }
    return { lead, hidden }
  }, [stack])
  const shown = useMemo(() => (stacks.hidden.size === 0 ? photos : photos.filter((p) => !stacks.hidden.has(p.id))), [photos, stacks])

  useEffect(() => onPhotosLoaded(shown), [shown])

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
      for (let i = from; i <= to; i++) next.add(shown[i].id)
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

  const contentAvailable = contentProgress?.phase !== 'unavailable'
  const meta =
    searchText === null
      ? `${photoCount(total)}${selected.size > 0 ? ` · ${selected.size} selected` : ' · ⌘-click or shift-click to select'}`
      : searching
        ? 'Searching…'
        : searchMeta(total, info, selected.size, contentAvailable)
  // Only a search with a content phrase and results gets a hint; with no phrase results are exactly as before.
  const hint = searchText !== null && !searching && info?.phrase && total > 0 ? searchHint(contentProgress, loadedWhileAnalysing) : null
  // The divider goes before the first content match, when there are name matches before it.
  const dividerAt = info?.phrase && info.nameMatches > 0 && info.contentMatches > 0 ? info.nameMatches : -1
  const empty = searchText !== null ? emptySearch(searchText, info, contentProgress) : null

  return (
    <div className="grid-scroller" ref={scroller}>
      <div className="grid-meta">{meta}</div>
      {hint && (
        <p className="hint search-hint">
          {hint.kind === 'unavailable' ? (
            <>
              <span className="error">{hint.danger}</span> {hint.rest}
            </>
          ) : (
            <>
              {hint.text}{' '}
              <button className="link" onClick={refresh}>
                Refresh results
              </button>
            </>
          )}
        </p>
      )}
      {!loading &&
        total === 0 &&
        (empty ? (
          <div className="empty">
            <p>{empty.title}</p>
            <p className="hint">{empty.detail}</p>
          </div>
        ) : (
          <div className="empty">No photos here yet.</div>
        ))}
      <div className="grid">
        {shown.map((p, i) => (
          <PhotoTile
            key={p.id}
            photo={p}
            group={stacks.lead.get(p.id) ?? null}
            onOpenGroup={onOpenGroup}
            divider={i === dividerAt && info?.phrase ? dividerLabel(info.phrase) : null}
            selected={selected.has(p.id)}
            onClick={(e) => handleClick(e, i, p)}
            onToggle={(e) => toggle(e, i, p)}
          />
        ))}
      </div>
      <div ref={sentinel} className="sentinel" />
    </div>
  )
}

interface TileProps {
  photo: Photo
  group: number[] | null
  onOpenGroup?: (ids: number[]) => void
  /** A row before this tile, spanning the grid: where content matches start. Not a tile, so selection skips it. */
  divider: string | null
  selected: boolean
  onClick: (e: React.MouseEvent) => void
  onToggle: (e: React.MouseEvent) => void
}

function PhotoTile({ photo: p, group, onOpenGroup, divider, selected, onClick, onToggle }: TileProps) {
  return (
    <>
      {divider && <div className="grid-divider">{divider}</div>}
      <div className={`tile ${selected ? 'selected' : ''}`} onClick={onClick} title={`${p.fileName} · ${formatDate(p.takenAt)}`}>
        <img src={`photo://thumb/${p.id}`} loading="lazy" decoding="async" alt="" />
        <span className="check" onClick={onToggle}>
          {selected ? '✓' : ''}
        </span>
        {p.favorite && <span className="fav-badge">★</span>}
        {group && onOpenGroup && (
          <button
            className="stack-badge"
            title={`${group.length} similar photos`}
            onClick={(e) => {
              e.stopPropagation()
              onOpenGroup(group)
            }}
          >
            {group.length}
          </button>
        )}
      </div>
    </>
  )
}

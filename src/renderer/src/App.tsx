import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  Album,
  AlbumOffer,
  BestOfSource,
  ClockSuggestion,
  ContentProgress,
  FaceProgress,
  LibraryInfo,
  Person,
  Photo,
  PhotoFilter,
  ScanProgress,
  SuggestedAlbum,
  Tag,
  TimelineMonth
} from '../../shared/types.ts'
import { DEFAULT_SIDEBAR_SECTIONS, type SidebarSections } from '../../shared/sidebarSections.ts'
import { Sidebar } from './components/Sidebar.tsx'
import { PhotoGrid } from './components/PhotoGrid.tsx'
import { BestOfView } from './components/BestOfView.tsx'
import { LookalikeGroup } from './components/LookalikeGroup.tsx'
import { LeanDialog } from './components/LeanDialog.tsx'
import { NOT_ENOUGH } from './bestOfCopy.ts'
import { Viewer } from './components/Viewer.tsx'
import { SelectionBar } from './components/SelectionBar.tsx'
import { Welcome } from './components/Welcome.tsx'
import { SuggestionsView, offerMeta, suggestionMeta, type SuggestionNotice } from './components/SuggestionsView.tsx'
import { DismissedDialog } from './components/DismissedDialog.tsx'
import { ClockBanner } from './components/ClockBanner.tsx'
import { CorrectionsDialog } from './components/CorrectionsDialog.tsx'
import { IgnoredFoldersDialog } from './components/IgnoredFoldersDialog.tsx'
import { InlineInput } from './components/InlineInput.tsx'
import { PeopleView } from './components/PeopleView.tsx'
import { PersonFaces } from './components/PersonFaces.tsx'
import { monthName } from './format.ts'
import { ANALYSING_TOOLTIP, analysingStatus, searchPlaceholder, unavailableReason } from './searchCopy.ts'

export type View =
  | { kind: 'all' }
  | { kind: 'favorites' }
  | { kind: 'suggestions' }
  | { kind: 'suggestion'; id: string }
  | { kind: 'albumOffer'; albumId: number }
  | { kind: 'undated' }
  | { kind: 'people' }
  | { kind: 'person'; id: number; reviewing?: boolean }
  | { kind: 'year'; year: string }
  | { kind: 'month'; year: string; month: string }
  | { kind: 'album'; id: number }
  | { kind: 'tag'; id: number }
  | { kind: 'search'; text: string }
  | { kind: 'bestOf'; source: BestOfSource }

const api = window.api

export function App() {
  const [library, setLibrary] = useState<LibraryInfo | null>(null)
  // Loaded before the first paint of the sidebar, so it never flashes the wrong state (spec 0004).
  const [sections, setSections] = useState<SidebarSections | null>(null)
  useEffect(() => {
    api.getSidebarSections().then(setSections, () => setSections(DEFAULT_SIDEBAR_SECTIONS))
  }, [])
  const [scan, setScan] = useState<ScanProgress | null>(null)
  const [view, setView] = useState<View>({ kind: 'all' })
  const [search, setSearch] = useState('')
  const [albums, setAlbums] = useState<Album[]>([])
  const [tags, setTags] = useState<Tag[]>([])
  const [timeline, setTimeline] = useState<TimelineMonth[]>([])
  const [suggestedList, setSuggestedList] = useState<SuggestedAlbum[] | null>(null)
  const [offers, setOffers] = useState<AlbumOffer[]>([])
  const [suggestionsFailed, setSuggestionsFailed] = useState(false)
  const suggested = suggestedList ?? []
  // Decisions (accept/dismiss) run one at a time, in order.
  const deciding = useRef<Promise<unknown>>(Promise.resolve())
  const [minBurstSize, setMinBurstSizeState] = useState(20)
  const [dismissedCount, setDismissedCount] = useState(0)
  const [notice, setNotice] = useState<SuggestionNotice>(null)
  const [showDismissed, setShowDismissed] = useState(false)
  const [namingSuggestion, setNamingSuggestion] = useState(false)
  const [emptySuggestionName, setEmptySuggestionName] = useState(false)
  const [suggestions, setSuggestions] = useState<ClockSuggestion[]>([])
  const [photos, setPhotos] = useState<Photo[]>([])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [viewerIndex, setViewerIndex] = useState<number | null>(null)
  const [showCorrections, setShowCorrections] = useState(false)
  const [showIgnored, setShowIgnored] = useState(false)
  const [people, setPeople] = useState<Person[]>([])
  const [faceProgress, setFaceProgress] = useState<FaceProgress | null>(null)
  const [contentProgress, setContentProgress] = useState<ContentProgress | null>(null)
  const [renamingPerson, setRenamingPerson] = useState(false)
  const [confirmForgetPerson, setConfirmForgetPerson] = useState(false)
  // Best of (spec 0006): why each photo is in the pick (for the viewer), and look-alike stacking in a grid.
  const [bestOfReasons, setBestOfReasons] = useState<Record<number, string>>({})
  const [stackLookalikes, setStackLookalikes] = useState(false)
  const [lookalikeGroups, setLookalikeGroups] = useState<number[][]>([])
  const [openGroup, setOpenGroup] = useState<number[] | null>(null)
  const [showLean, setShowLean] = useState(false)
  // Bumped whenever the photo list for the current view may have changed.
  const [version, setVersion] = useState(0)

  const refreshSidebar = useCallback(async () => {
    // Suggestions load on their own, so a failure there doesn't break the rest of the sidebar.
    void Promise.all([api.getSuggestions(), api.getMinBurstSize(), api.getDismissedCount(), api.getAlbumOffers()]).then(
      ([sg, min, dismissed, of]) => {
        setSuggestedList(sg)
        setOffers(of)
        setMinBurstSizeState(min)
        setDismissedCount(dismissed)
        setSuggestionsFailed(false)
      },
      () => setSuggestionsFailed(true)
    )
    const [lib, a, t, tl, s, pe] = await Promise.all([
      api.getLibrary(),
      api.listAlbums(),
      api.listTags(),
      api.getTimeline(),
      api.getClockSuggestions(),
      api.getPeople()
    ])
    setPeople(pe)
    setLibrary(lib)
    setAlbums(a)
    setTags(t)
    setTimeline(tl)
    setSuggestions(s)
  }, [])

  const refreshAll = useCallback(() => {
    void refreshSidebar()
    setVersion((v) => v + 1)
  }, [refreshSidebar])

  useEffect(() => {
    void refreshSidebar()
    void api.getFaceProgress().then(setFaceProgress)
    // Content analysis progress shows in the top bar and the search view; it never refreshes results by itself.
    void api.getContentProgress().then(setContentProgress)
    const offContent = api.onContentProgress(setContentProgress)
    const offScan = api.onScanProgress((p) => {
      setScan(p)
      if (p.phase === 'done') refreshAll()
    })
    // Face analysis runs in the background; refresh people as groups appear.
    let last = 0
    const offFaces = api.onFaceProgress((p) => {
      setFaceProgress(p)
      if (p.phase === 'idle' || Date.now() - last > 15_000) {
        last = Date.now()
        void refreshSidebar()
      }
    })
    return () => {
      offScan()
      offFaces()
      offContent()
    }
  }, [refreshSidebar, refreshAll])

  // Debounce typing into a search view; clearing the box returns to all photos.
  useEffect(() => {
    const text = search.trim()
    if (!text) {
      if (view.kind === 'search') setView({ kind: 'all' })
      return
    }
    const t = setTimeout(() => setView({ kind: 'search', text }), 250)
    return () => clearTimeout(t)
  }, [search])

  /** `keepNotice` keeps the suggestion notice (Undo / Open album) when returning to the list. */
  /** The album or suggestion the current view shows (where Best of and look-alikes apply). */
  const bestOfSource: BestOfSource | null =
    view.kind === 'album' ? { kind: 'album', id: view.id } : view.kind === 'suggestion' ? { kind: 'suggestion', id: view.id } : null
  const sourceCount =
    view.kind === 'album' ? (albums.find((a) => a.id === view.id)?.photoCount ?? 0) : (suggested.find((e) => e.id === (view as { id: string }).id)?.count ?? 0)
  const sourceKey = bestOfSource ? JSON.stringify(bestOfSource) : ''
  useEffect(() => {
    setLookalikeGroups([])
    if (!stackLookalikes || !bestOfSource) return
    let current = true
    void api.getLookalikes(bestOfSource).then(
      (g) => current && setLookalikeGroups(g),
      () => {}
    )
    return () => {
      current = false
    }
  }, [stackLookalikes, sourceKey, version])

  const navigate = (v: View, keepNotice = false) => {
    setOpenGroup(null)
    if (v.kind !== 'search') setSearch('')
    setView(v)
    setSelected(new Set())
    if (!keepNotice) setNotice(null)
    setNamingSuggestion(false)
    setRenamingPerson(false)
    setConfirmForgetPerson(false)
  }

  const filter: PhotoFilter = useMemo(() => {
    switch (view.kind) {
      case 'all':
      case 'suggestions':
      case 'people':
        return {}
      case 'person':
        return { personId: view.id }
      case 'favorites':
        return { favorites: true }
      case 'suggestion':
        return { suggestionId: view.id }
      case 'albumOffer':
        return { offerAlbumId: view.albumId }
      case 'undated':
        return { undated: true }
      case 'year':
        return { year: view.year }
      case 'month':
        return { year: view.year, month: view.month }
      case 'album':
        return { albumId: view.id }
      case 'tag':
        return { tagId: view.id }
      case 'search':
        return { text: view.text }
      case 'bestOf':
        return {}
    }
  }, [view])

  const currentSuggestion = view.kind === 'suggestion' ? suggested.find((e) => e.id === view.id) : undefined

  const currentOffer = view.kind === 'albumOffer' ? offers.find((o) => o.albumId === view.albumId) : undefined

  /**
   * Runs decisions one after another (a second one made while the first is in flight waits its
   * turn rather than being lost). A failure, e.g. a rescan changed the suggestion, is shown;
   * either way the list refreshes.
   */
  const decide = <T,>(run: () => Promise<T>): Promise<T> => {
    const next = deciding.current.then(run).then(
      (result) => {
        refreshAll()
        return result
      },
      (e: unknown) => {
        const message = e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)
        setNotice({ kind: 'error', message })
        refreshAll()
        throw e
      }
    )
    deciding.current = next.catch(() => {})
    return next
  }
  const acceptSuggestions = (ids: string[], name: string) =>
    decide(async () => {
      const album = await api.acceptSuggestions(ids, name)
      setNotice({ kind: 'made', album, sources: ids.length })
      return album
    })
  const dismissSuggestions = (ids: string[]) =>
    decide(async () => {
      const label = ids.length === 1 ? `Dismissed “${suggested.find((s) => s.id === ids[0])?.name ?? 'suggestion'}”.` : `Dismissed ${ids.length} suggestions.`
      const decisionIds = await api.dismissSuggestions(ids)
      setNotice({ kind: 'dismissed', label, decisionIds })
    })
  const offerBusy = useRef(new Set<number>())
  /** A second click while the first is still working does nothing (it would replace the Undo notice with an error). */
  const once = (albumId: number, run: () => Promise<void>): Promise<void> => {
    if (offerBusy.current.has(albumId)) return Promise.resolve()
    offerBusy.current.add(albumId)
    return run().finally(() => offerBusy.current.delete(albumId))
  }
  const addOffer = (albumId: number) =>
    once(albumId, () =>
      decide(async () => {
        const albumName = offers.find((o) => o.albumId === albumId)?.albumName ?? 'album'
        const count = await api.acceptAlbumOffer(albumId)
        setNotice({ kind: 'offerAdded', albumId, albumName, count })
      })
    )
  const declineOffer = (albumId: number) =>
    once(albumId, () =>
      decide(async () => {
        const albumName = offers.find((o) => o.albumId === albumId)?.albumName ?? 'album'
        const photoIds = await api.declineAlbumOffer(albumId)
        setNotice({ kind: 'offerDeclined', albumId, albumName, photoIds })
      })
    )
  const undoDismiss = async () => {
    if (notice?.kind === 'offerDeclined') {
      const { albumId, photoIds } = notice
      await decide(async () => {
        await api.undoDeclineAlbumOffer(albumId, photoIds)
        setNotice(null)
      }).catch(() => {})
      return
    }
    if (notice?.kind !== 'dismissed') return
    const ids = notice.decisionIds
    // Queued with other decisions, so it never races a dismissal still in flight.
    await decide(async () => {
      await api.restoreSuggestions(ids)
      setNotice(null)
    }).catch(() => {})
  }
  const currentPerson = view.kind === 'person' ? people.find((p) => p.id === view.id) : undefined

  const title = (() => {
    switch (view.kind) {
      case 'all':
        return 'All photos'
      case 'favorites':
        return 'Favourites'
      case 'suggestions':
        return 'Suggested albums'
      case 'suggestion':
        return currentSuggestion?.name ?? 'Suggested album'
      case 'albumOffer':
        return currentOffer ? `New photos for ${currentOffer.albumName}` : 'New photos'
      case 'undated':
        return 'Undated'
      case 'people':
        return 'People'
      case 'person':
        return currentPerson?.name ?? 'Person'
      case 'year':
        return view.year
      case 'month':
        return `${monthName(view.month)} ${view.year}`
      case 'album':
        return albums.find((a) => a.id === view.id)?.name ?? 'Album'
      case 'tag':
        return `#${tags.find((t) => t.id === view.id)?.name ?? 'tag'}`
      case 'search':
        return `“${view.text}”`
      case 'bestOf':
        return `Best of ${view.source.kind === 'album' ? (albums.find((a) => a.id === view.source.id)?.name ?? 'album') : (suggested.find((e) => e.id === view.source.id)?.name ?? 'suggestion')}`
    }
  })()

  if (!library || !sections) return null
  if (!library.basePath) {
    return (
      <Welcome
        onChoose={async () => {
          const lib = await api.chooseBaseFolder()
          if (lib) setLibrary(lib)
        }}
      />
    )
  }

  const scanning = scan?.phase === 'indexing'

  return (
    <div className="app">
      <header className="topbar">
        <div className="drag-region" />
        <input className="search" type="search" placeholder={searchPlaceholder(contentProgress)} value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="scan-status">
          {scanning ? (
            <span title={scan.current}>
              {scan.hashed > 0 ? 'Reading new photos' : 'Checking'}… {scan.indexed.toLocaleString()} / {scan.found.toLocaleString()}
            </span>
          ) : scan?.phase === 'error' ? (
            <span className="error">Scan failed: {scan.error}</span>
          ) : contentProgress?.phase === 'analysing' ? (
            <span className="content-status" title={ANALYSING_TOOLTIP}>
              {analysingStatus(contentProgress)}
            </span>
          ) : scan?.phase === 'done' && (scan.added || scan.relocated) ? (
            <span>
              {scan.added ? `${scan.added} new` : ''}
              {scan.added && scan.relocated ? ', ' : ''}
              {scan.relocated ? `${scan.relocated} moved/copied` : ''} · {library.photoCount.toLocaleString()} photos
            </span>
          ) : contentProgress?.phase === 'unavailable' ? (
            <span title={unavailableReason(contentProgress)}>
              {library.photoCount.toLocaleString()} photos · <span className="error">content search unavailable</span>
            </span>
          ) : (
            <span>{library.photoCount.toLocaleString()} photos</span>
          )}
          <button disabled={scanning} onClick={() => api.startScan()} title="Look for new, moved or changed photos">
            Rescan
          </button>
        </div>
      </header>

      <Sidebar
        library={library}
        sections={sections}
        onSectionsChange={(next) => {
          setSections(next)
          void api.setSidebarSections(next)
        }}
        view={view}
        albums={albums}
        tags={tags}
        timeline={timeline}
        suggestionCount={library.photoCount > 0 ? suggested.length + offers.length : 0}
        people={people}
        faceProgress={faceProgress}
        onNavigate={navigate}
        onChangeBase={async () => {
          const lib = await api.chooseBaseFolder()
          if (lib) {
            setLibrary(lib)
            refreshAll()
          }
        }}
        onAlbumsChanged={refreshAll}
        onShowCorrections={() => setShowCorrections(true)}
        onShowIgnored={() => setShowIgnored(true)}
        onShowBestOf={() => setShowLean(true)}
      />

      <main className="content">
        {suggestions.map((s) => (
          <ClockBanner
            key={s.key}
            suggestion={s}
            onApply={async () => {
              await api.applyClockSuggestion(s.key)
              refreshAll()
            }}
            onDismiss={async () => {
              await api.dismissClockSuggestion(s.key)
              refreshAll()
            }}
          />
        ))}

        <div className="content-header">
          <div className="title-block">
            <h1>{title}</h1>
            {currentSuggestion && <div className="subtitle">{suggestionMeta(currentSuggestion)}</div>}
            {currentOffer && <div className="subtitle">{offerMeta(currentOffer)}</div>}
          </div>
          {currentPerson &&
            view.kind === 'person' &&
            selected.size === 0 &&
            (renamingPerson ? (
              <InlineInput
                initial={currentPerson.name}
                onSubmit={async (name) => {
                  await api.renamePerson(currentPerson.id, name)
                  setRenamingPerson(false)
                  refreshAll()
                  navigate({ kind: 'people' })
                }}
                onCancel={() => setRenamingPerson(false)}
              />
            ) : confirmForgetPerson ? (
              <div className="header-actions">
                <span className="hint">Forget the name “{currentPerson.name}”? Their faces become unnamed again; photos are not touched.</span>
                <button
                  className="danger"
                  onClick={async () => {
                    await api.deletePerson(currentPerson.id)
                    refreshAll()
                    navigate({ kind: 'people' })
                  }}
                >
                  Forget
                </button>
                <button onClick={() => setConfirmForgetPerson(false)}>Cancel</button>
              </div>
            ) : (
              <div className="header-actions">
                <button onClick={() => setView({ ...view, reviewing: !view.reviewing })}>{view.reviewing ? 'Show photos' : 'Check faces'}</button>
                <button onClick={() => setRenamingPerson(true)} title="Renaming to someone else’s name merges them">
                  Rename
                </button>
                <button onClick={() => setConfirmForgetPerson(true)}>Forget name…</button>
              </div>
            ))}
          {currentSuggestion && selected.size === 0 && (
            <div className="header-actions">
              {namingSuggestion ? (
                <>
                  <InlineInput
                    initial={currentSuggestion.name}
                    onSubmit={async (name) => {
                      try {
                        const album = await acceptSuggestions([currentSuggestion.id], name)
                        navigate({ kind: 'album', id: album.id })
                      } catch {
                        setNamingSuggestion(false) // the error is shown; the suggestion may be gone
                      }
                    }}
                    onEmpty={() => setEmptySuggestionName(true)}
                    onCancel={() => setNamingSuggestion(false)}
                  />
                  <span className="hint">{emptySuggestionName ? 'An album needs a name.' : 'Enter to make the album, Esc to cancel'}</span>
                </>
              ) : (
                <>
                  <button
                    className="primary-small"
                    title={`Make a new album with these ${currentSuggestion.count.toLocaleString()} photos`}
                    onClick={() => {
                      setEmptySuggestionName(false)
                      setNamingSuggestion(true)
                    }}
                  >
                    Make album
                  </button>
                  <button
                    title="Stop suggesting this. Photos aren't moved or changed."
                    onClick={async () => {
                      await dismissSuggestions([currentSuggestion.id]).catch(() => {})
                      navigate({ kind: 'suggestions' }, true)
                    }}
                  >
                    Dismiss
                  </button>
                </>
              )}
            </div>
          )}
          {currentOffer && selected.size === 0 && (
            <div className="header-actions">
              <button
                className="primary-small"
                title={`Adds these ${currentOffer.count.toLocaleString()} photos to the album ${currentOffer.albumName}. Nothing is moved or changed on disk.`}
                onClick={async () => {
                  try {
                    await addOffer(currentOffer.albumId)
                    navigate({ kind: 'album', id: currentOffer.albumId })
                  } catch {
                    /* the error is shown */
                  }
                }}
              >
                Add to {currentOffer.albumName}
              </button>
              <button
                title={`Stop offering these photos for ${currentOffer.albumName}.`}
                onClick={async () => {
                  await declineOffer(currentOffer.albumId).catch(() => {})
                  navigate({ kind: 'suggestions' }, true)
                }}
              >
                Not these
              </button>
            </div>
          )}
          {bestOfSource && selected.size === 0 && !namingSuggestion && (
            <div className="header-actions">
              <label className="toggle" title="Stacks photos that are nearly the same into one tile. Nothing in the album changes.">
                <input type="checkbox" checked={stackLookalikes} onChange={(e) => setStackLookalikes(e.target.checked)} /> Show look-alikes together
              </label>
              <button
                disabled={sourceCount < 6}
                title={sourceCount < 6 ? NOT_ENOUGH : 'Choose the best photos of this'}
                onClick={() => navigate({ kind: 'bestOf', source: bestOfSource }, true)}
              >
                Best of
              </button>
            </div>
          )}
          {selected.size > 0 && (
            <SelectionBar
              selected={[...selected]}
              albums={albums}
              tags={tags}
              currentAlbumId={view.kind === 'album' ? view.id : null}
              onDone={(clear) => {
                if (clear) setSelected(new Set())
                refreshAll()
              }}
              onClear={() => setSelected(new Set())}
            />
          )}
        </div>

        {view.kind === 'people' ? (
          <PeopleView
            people={people}
            progress={faceProgress}
            version={version}
            onOpenPerson={(id) => navigate({ kind: 'person', id })}
            onChanged={refreshAll}
          />
        ) : view.kind === 'person' && view.reviewing && currentPerson ? (
          <PersonFaces person={currentPerson} onChanged={refreshAll} />
        ) : view.kind === 'suggestions' ? (
          <SuggestionsView
            suggestions={suggestedList}
            offers={offers}
            onOpenOffer={(albumId) => navigate({ kind: 'albumOffer', albumId }, true)}
            onAddOffer={(albumId) => void addOffer(albumId).catch(() => {})}
            onDeclineOffer={(albumId) => void declineOffer(albumId).catch(() => {})}
            loadError={suggestionsFailed}
            onRetry={refreshAll}
            minBurstSize={minBurstSize}
            dismissedCount={dismissedCount}
            scanned={library.photoCount > 0 || scan?.phase === 'done'}
            scanning={scanning}
            notice={notice}
            onOpen={(id) => navigate({ kind: 'suggestion', id }, true)}
            onAccept={async (ids, name) => {
              await acceptSuggestions(ids, name)
            }}
            onDismiss={(ids) => void dismissSuggestions(ids).catch(() => {})}
            onUndo={() => void undoDismiss()}
            onOpenAlbum={(id) => navigate({ kind: 'album', id })}
            onSetMinBurstSize={async (n) => {
              const ok = await api.setMinBurstSize(n)
              if (ok) {
                setNotice(null)
                refreshAll()
              }
              return ok
            }}
            onShowDismissed={() => setShowDismissed(true)}
          />
        ) : view.kind === 'albumOffer' && !currentOffer ? (
          <div className="grid-scroller">
            <div className="empty">
              <p>These photos have been dealt with.</p>
              <button onClick={() => navigate({ kind: 'suggestions' })}>Back to Suggested albums</button>
            </div>
          </div>
        ) : view.kind === 'suggestion' && !currentSuggestion ? (
          <div className="grid-scroller">
            <div className="empty">
              <p>This suggestion is no longer here.</p>
              <button onClick={() => navigate({ kind: 'suggestions' })}>Back to Suggested albums</button>
            </div>
          </div>
        ) : view.kind === 'bestOf' ? (
          <BestOfView
            source={view.source}
            version={version}
            onPhotosLoaded={(p, r) => {
              setPhotos(p)
              setBestOfReasons(r)
            }}
            onOpen={setViewerIndex}
            onBack={() => navigate(view.source.kind === 'album' ? { kind: 'album', id: view.source.id } : { kind: 'suggestion', id: view.source.id }, true)}
            onOpenAlbum={(id) => navigate({ kind: 'album', id })}
            onMade={refreshAll}
            suspended={viewerIndex !== null}
          />
        ) : openGroup ? (
          <LookalikeGroup ids={openGroup} onPhotosLoaded={setPhotos} onOpen={setViewerIndex} onBack={() => setOpenGroup(null)} />
        ) : (
          <PhotoGrid
            stack={stackLookalikes && lookalikeGroups.length > 0 ? lookalikeGroups : null}
            onOpenGroup={setOpenGroup}
            filter={filter}
            version={version}
            selected={selected}
            onSelectionChange={setSelected}
            onPhotosLoaded={setPhotos}
            onOpen={setViewerIndex}
            searchText={view.kind === 'search' ? view.text : null}
            contentProgress={contentProgress}
          />
        )}
      </main>

      {viewerIndex !== null && photos[viewerIndex] && (
        <Viewer
          photos={photos}
          index={viewerIndex}
          albums={albums}
          tags={tags}
          people={people}
          reason={view.kind === 'bestOf' ? bestOfReasons[photos[viewerIndex].id] : undefined}
          onIndexChange={setViewerIndex}
          onClose={() => setViewerIndex(null)}
          onChanged={refreshAll}
        />
      )}

      {showLean && <LeanDialog onClose={() => setShowLean(false)} />}
      {showCorrections && <CorrectionsDialog onClose={() => setShowCorrections(false)} onChanged={refreshAll} />}
      {showIgnored && <IgnoredFoldersDialog onClose={() => setShowIgnored(false)} onChanged={refreshAll} />}
      {showDismissed && (
        <DismissedDialog
          minBurstSize={minBurstSize}
          onClose={() => setShowDismissed(false)}
          onChanged={() => {
            setNotice(null) // a restore ends the one-step undo
            refreshAll()
          }}
        />
      )}
    </div>
  )
}

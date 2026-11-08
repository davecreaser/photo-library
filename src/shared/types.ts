import type { SidebarSections } from './sidebarSections.ts'
// Types shared between the main process, preload and renderer.

/**
 * A photo is identified by its content (SHA-256 of the file), not its location.
 * The same content found at several paths (copies) is one photo; moving or
 * renaming a file keeps its albums, tags and favourite.
 */
export interface Photo {
  id: number
  /** Path of one present copy of this photo (the one shown/opened). */
  path: string
  fileName: string
  ext: string
  size: number
  /** Local capture time 'YYYY-MM-DDTHH:MM:SS' after any clock correction; null if unknown. */
  takenAt: string | null
  /** What the camera recorded, when a clock correction changed it. */
  takenAtRaw: string | null
  dateSource: 'exif' | 'unknown'
  width: number | null
  height: number | null
  camera: string | null
  lat: number | null
  lon: number | null
  favorite: boolean
}

export interface PhotoDetails extends Photo {
  albums: { id: number; name: string }[]
  tags: Tag[]
  /** Faces found in the photo, with who they are when known. Boxes are relative (0..1). */
  faces: { id: number; personId: number | null; name: string | null; auto: boolean; x: number; y: number; w: number; h: number }[]
  /** Every present location of this photo's content (more than one = duplicates). */
  locations: string[]
}

export interface Album {
  id: number
  parentId: number | null
  name: string
  photoCount: number
  /** True when made from suggested albums (deleting it brings them back). */
  fromSuggestion?: boolean
}

export interface Tag {
  id: number
  name: string
  photoCount?: number
}

export interface TimelineMonth {
  year: string
  month: string
  count: number
}

/** A group of photos proposed as an album (spec 0001): a named folder or a burst of photos taken together. */
export interface SuggestedAlbum {
  id: string
  name: string
  /** True when it comes from a named folder; bursts are named by their dates. */
  named: boolean
  start: string | null
  end: string | null
  count: number
  coverId: number
}

/** New photos waiting for an album made from suggestions (spec 0005). */
export interface AlbumOffer {
  albumId: number
  albumName: string
  count: number
  start: string | null
  end: string | null
  coverId: number
}

export interface DismissedSuggestion {
  /** The dismissal's id (pass to restoreSuggestions). */
  id: number
  name: string
  photoCount: number
  start: string | null
  end: string | null
  coverId: number | null
  /** Why it wouldn't be listed even if restored, if so. */
  note: 'below-minimum' | 'in-album' | 'not-here' | null
}

export interface Person {
  id: number
  name: string
  photoCount: number
  coverFaceId: number | null
}

/** A group of similar faces nobody has named yet. */
export interface FaceGroup {
  /** A face in the group; naming the group goes through it, so it stays valid if groups are recomputed. */
  id: number
  faceCount: number
  photoCount: number
  sampleFaceIds: number[]
}

export interface PersonFace {
  id: number
  photoId: number
  /** True when matched automatically rather than confirmed by you. */
  auto: boolean
}

export interface FaceProgress {
  phase: 'analysing' | 'idle' | 'unavailable'
  done: number
  total: number
  error?: string
}

export interface ClockCorrection {
  id: number
  camera: string
  /** Applies to photos whose camera-recorded time is before this (null = all photos from the camera). */
  appliesBefore: string | null
  offsetYears: number
  offsetSeconds: number
  photoCount: number
}

export interface ClockSuggestion {
  key: string
  camera: string
  offsetYears: number
  appliesBefore: string | null
  photoCount: number
  /** Folder names whose dates disagree with the camera, e.g. "08.25.sail_amsterdam". */
  evidence: string[]
}

export interface PhotoFilter {
  year?: string
  month?: string
  albumId?: number
  tagId?: number
  suggestionId?: string
  /** Only the new photos offered to this album (spec 0005). */
  offerAlbumId?: number
  favorites?: boolean
  personId?: number
  undated?: boolean
  /** Free text, e.g. "august 2020 spain". Parsed by parseSearch(). */
  text?: string
  offset?: number
  limit?: number
}

export interface PhotoPage {
  photos: Photo[]
  total: number
  /** For a search: how its results are made up (spec 0002). */
  search?: SearchInfo
}

/** A search's results are its name matches (today's search), then its content matches, best first. */
export interface SearchInfo {
  /** What's left of the search after dates, people's names and filler words; null when nothing is. */
  phrase: string | null
  /** Photos found by folder/file name, album, tag or person; they come first. */
  nameMatches: number
  /** Photos that look like the phrase (and aren't name matches). */
  contentMatches: number
}

/** Background analysis of what's in each photo, for content search (spec 0002). */
export interface ContentProgress {
  phase: 'analysing' | 'idle' | 'unavailable'
  /** Present photos analysed by the current model, of all present photos. */
  done: number
  total: number
  /** True while re-analysing photos for a new model version. */
  upgrading: boolean
  /** Estimated seconds left; null until there's enough to go on. */
  secondsLeft: number | null
  /** Why content search is unavailable: the model file is missing or damaged, or the search component failed to load. */
  reason?: 'missing' | 'damaged' | 'failed'
  /** True in the installed app (the fix is to reinstall), false in a development build. */
  packaged: boolean
}

export interface ScanProgress {
  phase: 'indexing' | 'done' | 'error'
  /** Image files found on disk so far. */
  found: number
  /** Files processed so far (unchanged or newly read). */
  indexed: number
  /** Files whose content had to be read and fingerprinted this scan. */
  hashed: number
  /** Photos seen for the first time. */
  added: number
  /** Known photos found at a new location (moved, renamed or copied). */
  relocated: number
  /** Files edited in place. */
  updated: number
  /** Photos no longer found anywhere (hidden, not forgotten). */
  missing: number
  current?: string
  error?: string
}

export interface LibraryInfo {
  basePath: string | null
  photoCount: number
  missingCount: number
  favoriteCount: number
  undatedCount: number
}

export interface Api {
  /** Best of an album or suggested album (spec 0006). Computed, never stored. */
  getBestOf(request: BestOfRequest): Promise<BestOfView>
  /** All look-alike groups of the source (photo ids, best first), for stacking them in a grid. */
  getLookalikes(source: BestOfSource): Promise<number[][]>
  getPhotosByIds(ids: number[]): Promise<Photo[]>
  /** Makes an ordinary album "Best of <name>" with these photos; never overwrites. */
  makeBestOfAlbum(source: BestOfSource, photoIds: number[]): Promise<Album>
  getLeanTowardsStars(): Promise<{ on: boolean; stars: number; enough: boolean }>
  setLeanTowardsStars(on: boolean): Promise<void>
  /** Which collapsible sidebar sections are open (spec 0004). Only a setting is written. */
  getSidebarSections(): Promise<SidebarSections>
  setSidebarSections(s: SidebarSections): Promise<void>
  getLibrary(): Promise<LibraryInfo>
  chooseBaseFolder(): Promise<LibraryInfo | null>
  startScan(): Promise<void>
  /** Folder rules the scanner skips: names ("private") or paths below the base folder ("fuji/abstract"). */
  getIgnoredFolders(): Promise<string[]>
  /** Saves the rules and rescans: photos in ignored folders are forgotten, un-ignored ones come back. */
  setIgnoredFolders(rules: string[]): Promise<string[]>
  /** Opens a folder picker inside the base folder; returns the chosen folder's relative path, or null. */
  chooseIgnoredFolder(): Promise<string | null>
  /** Removes the app's records of photos no longer found on disk. Files are never touched. */
  forgetMissing(): Promise<void>
  onScanProgress(cb: (p: ScanProgress) => void): () => void

  /** A view's photos. A search returns name matches first, then content matches best first (spec 0002). */
  queryPhotos(filter: PhotoFilter): Promise<PhotoPage>
  getContentProgress(): Promise<ContentProgress>
  onContentProgress(cb: (p: ContentProgress) => void): () => void
  getPhoto(id: number): Promise<PhotoDetails | null>
  getTimeline(): Promise<TimelineMonth[]>
  getSuggestions(): Promise<SuggestedAlbum[]>
  /** Makes one album from one or more suggestions (accept, or combine several). */
  acceptSuggestions(ids: string[], name: string): Promise<Album>
  /** Returns the dismissal ids, for undo. */
  dismissSuggestions(ids: string[]): Promise<number[]>
  /** Undo a dismissal, or restore one from the dismissed list. */
  restoreSuggestions(dismissalIds: number[]): Promise<void>
  getDismissedSuggestions(): Promise<DismissedSuggestion[]>
  getAlbumOffers(): Promise<AlbumOffer[]>
  /** Adds the offered photos to the album; resolves to how many. */
  acceptAlbumOffer(albumId: number): Promise<number>
  /** "Not these": resolves to the declined photo ids, for undo. */
  declineAlbumOffer(albumId: number): Promise<number[]>
  undoDeclineAlbumOffer(albumId: number, photoIds: number[]): Promise<void>
  getDismissedCount(): Promise<number>
  getMinBurstSize(): Promise<number>
  /** False if the value isn't a whole number from 1 to 1,000 (nothing changes). */
  setMinBurstSize(n: number): Promise<boolean>
  revealInFinder(id: number): Promise<void>
  setFavorite(photoIds: number[], favorite: boolean): Promise<void>

  getClockSuggestions(): Promise<ClockSuggestion[]>
  applyClockSuggestion(key: string): Promise<void>
  dismissClockSuggestion(key: string): Promise<void>
  listClockCorrections(): Promise<ClockCorrection[]>
  addClockCorrection(c: Omit<ClockCorrection, 'id' | 'photoCount'>): Promise<void>
  removeClockCorrection(id: number): Promise<void>
  listCameras(): Promise<string[]>

  listAlbums(): Promise<Album[]>
  createAlbum(name: string, parentId: number | null): Promise<Album>
  renameAlbum(id: number, name: string): Promise<void>
  /** Puts an album inside another (null = top level). False if refused (into itself or its own sub-albums). */
  moveAlbum(id: number, parentId: number | null): Promise<boolean>
  deleteAlbum(id: number): Promise<void>
  addToAlbum(albumId: number, photoIds: number[]): Promise<void>
  removeFromAlbum(albumId: number, photoIds: number[]): Promise<void>

  getPeople(): Promise<Person[]>
  getFaceGroups(): Promise<FaceGroup[]>
  /** Names a group of faces; using an existing name adds them to that person. */
  nameFaceGroup(faceId: number, name: string): Promise<Person>
  /** Names one face (e.g. from the photo viewer). */
  nameFace(faceId: number, name: string): Promise<void>
  getPersonFaces(personId: number): Promise<PersonFace[]>
  /** "Not this person": unassigns the face and stops it being matched to them again. */
  rejectFace(faceId: number): Promise<void>
  /** Renaming to another person's name merges the two. */
  renamePerson(id: number, name: string): Promise<void>
  /** Forgets the name; the faces become unnamed again. Photos are untouched. */
  deletePerson(id: number): Promise<void>
  getFaceProgress(): Promise<FaceProgress>
  onFaceProgress(cb: (p: FaceProgress) => void): () => void

  listTags(): Promise<Tag[]>
  addTag(photoIds: number[], name: string): Promise<Tag>
  removeTag(photoIds: number[], tagId: number): Promise<void>
}

/** Why a photo is in a Best of pick (spec 0006, AC-5); the window words it. */
export type BestOfReason =
  | { kind: 'starred' }
  | { kind: 'focus'; phrase: string }
  | { kind: 'person'; name: string }
  | { kind: 'lookalike'; count: number }
  | { kind: 'moment'; count: number }
  | { kind: 'different' }
  | { kind: 'yours' }

/** Where a Best of pick comes from: an album, or a suggested album (spec 0006). */
export type BestOfSource = { kind: 'album'; id: number } | { kind: 'suggestion'; id: string }

export interface BestOfRequest {
  source: BestOfSource
  /** How many photos; default depends on the set's size. */
  count?: number
  /** "Focus on…" words. */
  focus?: string
  /** Photos the user added (always in) and removed (never picked). */
  fixed?: number[]
  exclude?: number[]
}

export interface BestOfView {
  /** The source album's or suggestion's name. */
  name: string
  /** Present photos in the source. */
  total: number
  count: number
  defaultCount: number
  /** Fewer than 6 photos: nothing to choose from. */
  tooFew: boolean
  /** The picks, in capture-time order. */
  photos: Photo[]
  reasons: Record<number, BestOfReason>
  momentCount: number
  /** Look-alike groups (photo ids, best first) that contain a pick. */
  groups: number[][]
  /** Photos of the source measured so far, of all of them. */
  pending: { done: number; total: number }
  /** Focus words were given but the content model isn't ready. */
  focusUnavailable: boolean
}

import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron'
import { tmpdir } from 'node:os'
import { extname, isAbsolute, join, relative, sep } from 'node:path'
import { readdirSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { assertWritable, installFsGuard } from './fsGuard.ts'
import { openExport } from './appFiles.ts'
import { planNames, runExport, safeFolderName, writeFailure } from './exporter.ts'
import { exportOptionsFrom, EXPORT_OPTIONS_KEY } from './exportOptions.ts'
import { LibraryDb, type Forgotten } from './db.ts'
import { DEFAULT_IGNORED, normaliseRule } from './ignore.ts'
import { BROWSER_NATIVE_EXTENSIONS, fileExists } from './photoFs.ts'
import { scanLibrary } from './scanner.ts'
import { ImageCache } from './thumbnails.ts'
import { Organiser } from './organiser.ts'
import { People } from './people.ts'
import { Analysis } from './analysis.ts'
import { PhotoSearch } from './photoSearch.ts'
import { ContentModelWorker } from './contentModelWorker.ts'
import createContentWorker from './contentWorker.ts?nodeWorker'
import { BestOfService } from './bestOfService.ts'
import type {
  BestOfRequest,
  BestOfSource,
  ClockCorrection,
  ExportOptions,
  ExportResult,
  ExportSource,
  ExportSummary,
  LibraryInfo,
  PhotoFilter
} from '../shared/types.ts'
import { parseSidebarSections, type SidebarSections } from '../shared/sidebarSections.ts'

// photo://thumb/<id> and photo://full/<id> serve images to the UI.
protocol.registerSchemesAsPrivileged([{ scheme: 'photo', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])

let db: LibraryDb
let images: ImageCache
let organiser: Organiser
let people: People
let analysis: Analysis
let search: PhotoSearch
let bestOfService: BestOfService
let window: BrowserWindow | null = null
let currentScan: Promise<void> | null = null
let scanAgain = false
let lastQualityEvent = 0
/** Tells the window that more photos have been measured (at most every 2 seconds). */
function sendQualityProgress(): void {
  const now = Date.now()
  if (now - lastQualityEvent < 2000) return
  lastQualityEvent = now
  window?.webContents.send('bestOf:progress')
}

// Installed before anything else runs: from here on, no code in this process
// (ours or a dependency's) can write, move or delete inside a photo folder.
// PHOTO_LIBRARY_DATA_DIR lets tests (and power users) keep the library elsewhere.
if (process.env.PHOTO_LIBRARY_DATA_DIR) app.setPath('userData', process.env.PHOTO_LIBRARY_DATA_DIR)
const dataDir = app.getPath('userData')
let protectedRoots: string[] = []
installFsGuard({ allowedRoots: () => [dataDir, tmpdir()], protectedRoots: () => protectedRoots })

/** Every photo folder ever chosen stays read-only, not just the current one. */
function loadProtectedRoots(): void {
  const saved = JSON.parse(db.getSetting('protectedRoots') ?? '[]') as string[]
  const base = db.getSetting('basePath')
  protectedRoots = [...new Set(base ? [...saved, base] : saved)]
}

/** A photo folder must not contain (or be inside) the app's data folder, so the two can never overlap. */
function overlapsAppData(folder: string): boolean {
  const inside = (root: string, p: string) => {
    const rel = relative(root, p)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  }
  return inside(folder, dataDir) || inside(dataDir, folder)
}

// --- save copies (spec 0007) ---

let exporting: { cancel: boolean } | null = null
let lastExportFolder: string | null = null

function exportPhotoIds(source: ExportSource): number[] {
  return 'albumId' in source ? db.albumPhotoIdsDeep(source.albumId) : [...new Set(source.photoIds.filter(Number.isInteger))]
}

function exportSummary(source: ExportSource): ExportSummary {
  const ids = exportPhotoIds(source)
  const count = db.exportSources(ids).length
  return { count, missing: ids.length - count, options: exportOptionsFrom(db.getSetting(EXPORT_OPTIONS_KEY)) }
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Is `folder` (really) inside one of `roots`? */
function insideAny(folder: string, roots: string[]): boolean {
  const real = (p: string) => {
    try {
      return realpathSync.native(p)
    } catch {
      return p
    }
  }
  return roots.some((root) => {
    const rel = relative(real(root), real(folder))
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  })
}

async function startExport(source: ExportSource, rawOptions: ExportOptions): Promise<ExportResult> {
  if (exporting) throw new Error('Another export is running')
  const state = { cancel: false }
  exporting = state
  try {
    return await chooseAndExport(source, rawOptions, state)
  } finally {
    if (exporting === state) exporting = null
  }
}

async function chooseAndExport(source: ExportSource, rawOptions: ExportOptions, state: { cancel: boolean }): Promise<ExportResult> {
  const options = exportOptionsFrom(JSON.stringify(rawOptions))
  db.setSetting(EXPORT_OPTIONS_KEY, JSON.stringify(options))
  const photos = db.exportSources(exportPhotoIds(source))
  if (photos.length === 0) return { status: 'noFolder' }
  const result = await dialog.showOpenDialog(window!, {
    title: 'Choose where to save the copies',
    message: 'The copies go into a new folder inside the folder you choose.',
    buttonLabel: 'Save here',
    properties: ['openDirectory', 'createDirectory']
  })
  const chosen = result.filePaths[0]
  if (result.canceled || !chosen) return { status: 'noFolder' }
  if (insideAny(chosen, protectedRoots)) return { status: 'refused', reason: 'photoFolder' }
  if (insideAny(chosen, [dataDir])) return { status: 'refused', reason: 'appData' }

  // A new folder named after the album (or "Photos") and today's date; a number is added if it exists.
  const today = new Date()
  const stamp = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`
  const album = 'albumId' in source ? db.listAlbums().find((a) => a.id === source.albumId) : undefined
  const base = `${safeFolderName(album?.name ?? 'Photos')} ${stamp}`
  const taken = new Set(readdirSync(chosen).map((n) => n.toLowerCase()))
  let folderName = base
  for (let n = 2; taken.has(folderName.toLowerCase()); n++) folderName = `${base} ${n}`
  const folder = join(chosen, folderName)

  const base0 = { folderName, requested: photos.length }
  try {
    const sink = await openExport(folder, dataDir)
    lastExportFolder = folder
    try {
      const run = await runExport(
        planNames(photos, options),
        sink,
        options,
        join(dataDir, 'cache', 'tmp'),
        (done, total) => window?.webContents.send('export:progress', { done, total }),
        () => state.cancel
      )
      return { ...run, ...base0 }
    } finally {
      sink.close()
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    const message =
      code === 'ENOSPC'
        ? 'the disk is full'
        : code === 'EACCES' || code === 'EPERM'
          ? "that folder can't be written to"
          : e instanceof Error
            ? e.message
            : String(e)
    return { status: 'error', ...base0, saved: 0, skipped: [], message }
  } finally {
    exporting = null
  }
}

function libraryInfo(): LibraryInfo {
  return { basePath: db.getSetting('basePath'), ...db.counts() }
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    backgroundColor: '#161618',
    titleBarStyle: 'hiddenInset',
    title: 'Photo Library',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true
    }
  })
  window.on('closed', () => (window = null))
  if (process.env.ELECTRON_RENDERER_URL) {
    window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

/** Removes our cached thumbnails and face crops of photos the app no longer tracks. */
async function cleanUpCaches(forgotten: Forgotten): Promise<void> {
  await images.remove(forgotten.hashes)
  await people.removeCrops(forgotten.faceIds)
}

/**
 * Scans the base folder. If a scan is already running, one more runs after it (settings
 * such as ignored folders may have changed meanwhile); the returned promise covers both.
 */
function startScan(): Promise<void> {
  if (currentScan) {
    scanAgain = true
    return currentScan
  }
  const run = async () => {
    do {
      scanAgain = false
      const basePath = db.getSetting('basePath')
      if (!basePath) return
      await scanLibrary(
        db,
        basePath,
        (p) => {
          if (p.phase === 'done') {
            organiser.invalidate()
            void analysis.kick() // analyse faces and content in any new photos
          }
          window?.webContents.send('scan:progress', p)
        },
        (forgotten) => void cleanUpCaches(forgotten)
      )
    } while (scanAgain)
  }
  // Cleared in .finally (always asynchronous), never before currentScan is assigned:
  // a run that returns immediately (no folder chosen yet) must not leave a stale "scan in progress".
  currentScan = run().finally(() => {
    currentScan = null
  })
  return currentScan
}

function registerPhotoProtocol(): void {
  protocol.handle('photo', async (request) => {
    const url = new URL(request.url)
    const id = Number(url.pathname.slice(1))
    if (url.host === 'face') {
      // Face thumbnails live in the app's cache.
      const crop = people.cropPath(id)
      return (await fileExists(crop)) ? net.fetch(pathToFileURL(crop).toString()) : new Response('Not found', { status: 404 })
    }
    const photo = db.getThumbSource(id)
    if (!photo || !(await fileExists(photo.path))) return new Response('Not found', { status: 404 })
    try {
      if (url.host === 'full' && BROWSER_NATIVE_EXTENSIONS.has(extname(photo.path).toLowerCase())) {
        return net.fetch(pathToFileURL(photo.path).toString())
      }
      const file = await images.get(photo, url.host === 'full' ? 'preview' : 'thumb')
      return net.fetch(pathToFileURL(file).toString())
    } catch (e) {
      return new Response(String(e), { status: 500 })
    }
  })
}

function registerIpc(): void {
  ipcMain.handle('library:get', () => libraryInfo())
  ipcMain.handle('library:chooseBase', async () => {
    const result = await dialog.showOpenDialog(window!, {
      title: 'Choose your photo folder',
      message: 'Photo Library only reads this folder. It never moves, renames or deletes your photos.',
      properties: ['openDirectory']
    })
    const folder = result.filePaths[0]
    if (result.canceled || !folder) return null
    if (overlapsAppData(folder)) {
      await dialog.showMessageBox(window!, {
        type: 'warning',
        message: 'Please choose a more specific folder',
        detail: `That folder contains Photo Library's own data folder (${dataDir}). Choose the folder your photos are in, e.g. ~/Documents/photos.`
      })
      return null
    }
    // Protect the new folder before it becomes the base.
    db.setSetting('protectedRoots', JSON.stringify([...new Set([...protectedRoots, folder])]))
    db.setSetting('basePath', folder)
    loadProtectedRoots()
    void startScan()
    return libraryInfo()
  })
  ipcMain.handle('scan:start', () => void startScan())

  ipcMain.handle('sidebar:get', () => parseSidebarSections(db.getSetting('sidebarSections')))
  ipcMain.handle('sidebar:set', (_e, s: SidebarSections) => {
    db.setSetting('sidebarSections', JSON.stringify(parseSidebarSections(JSON.stringify(s))))
  })

  ipcMain.handle('ignore:get', () => JSON.parse(db.getSetting('ignoredFolders') ?? JSON.stringify(DEFAULT_IGNORED)) as string[])
  ipcMain.handle('ignore:set', async (_e, rules: string[]) => {
    const clean = [...new Set(rules.map(normaliseRule).filter(Boolean))]
    db.setSetting('ignoredFolders', JSON.stringify(clean))
    // Rescan so newly ignored photos are forgotten and un-ignored ones come back.
    await startScan()
    return clean
  })
  /** Lets the user pick a folder inside the base folder; returns its path relative to the base. */
  ipcMain.handle('ignore:choose', async () => {
    const base = db.getSetting('basePath')
    if (!base) return null
    const result = await dialog.showOpenDialog(window!, { title: 'Choose a folder to ignore', defaultPath: base, properties: ['openDirectory'] })
    const folder = result.filePaths[0]
    if (result.canceled || !folder) return null
    const rel = relative(base, folder)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      await dialog.showMessageBox(window!, { type: 'warning', message: 'Please choose a folder inside your photo folder.' })
      return null
    }
    return rel.split(sep).join('/')
  })
  ipcMain.handle('library:forgetMissing', async () => {
    const forgotten = db.forgetMissing()
    organiser.invalidate()
    await cleanUpCaches(forgotten)
  })

  ipcMain.handle('export:summary', (_e, source: ExportSource) => exportSummary(source))
  ipcMain.handle('export:start', (_e, source: ExportSource, options: ExportOptions) => startExport(source, options))
  ipcMain.handle('export:cancel', () => {
    if (exporting) exporting.cancel = true
  })
  ipcMain.handle('export:reveal', () => {
    if (lastExportFolder) shell.showItemInFolder(lastExportFolder)
  })

  ipcMain.handle('photos:query', (_e, filter: PhotoFilter) =>
    search.query(
      filter,
      filter.suggestionId
        ? organiser.suggestionPhotoIds(filter.suggestionId)
        : filter.offerAlbumId !== undefined
          ? organiser.offerPhotoIds(filter.offerAlbumId)
          : undefined
    )
  )
  ipcMain.handle('bestOf:get', (_e, r: BestOfRequest) => bestOfService.get(r))
  ipcMain.handle('bestOf:lookalikes', (_e, source: BestOfSource) => bestOfService.lookalikes(source))
  ipcMain.handle('bestOf:makeAlbum', (_e, source: BestOfSource, ids: number[]) => bestOfService.makeAlbum(source, ids))
  ipcMain.handle('bestOf:lean', () => bestOfService.leanTowardsStars())
  ipcMain.handle('bestOf:setLean', (_e, on: boolean) => bestOfService.setLeanTowardsStars(on))
  ipcMain.handle('photos:byIds', (_e, ids: number[]) => db.photosByIds(ids))
  ipcMain.handle('content:progress', () => analysis.contentProgress())
  ipcMain.handle('photos:get', (_e, id: number) => db.getPhoto(id))
  ipcMain.handle('photos:timeline', () => db.getTimeline())
  ipcMain.handle('photos:reveal', (_e, id: number) => {
    const p = db.getThumbSource(id)
    if (p) shell.showItemInFolder(p.path)
  })
  ipcMain.handle('photos:favorite', (_e, ids: number[], favorite: boolean) => {
    db.setFavorite(ids, favorite)
    organiser.invalidate()
  })

  ipcMain.handle('suggestions:list', () => organiser.listSuggestions())
  ipcMain.handle('suggestions:accept', (_e, ids: string[], name: string) => organiser.acceptSuggestions(ids, name))
  ipcMain.handle('suggestions:dismiss', (_e, ids: string[]) => organiser.dismissSuggestions(ids))
  ipcMain.handle('suggestions:restore', (_e, ids: number[]) => organiser.restoreDismissed(ids))
  ipcMain.handle('suggestions:dismissed', () => organiser.listDismissed())
  ipcMain.handle('suggestions:dismissedCount', () => organiser.dismissedCount())
  ipcMain.handle('offers:list', () => organiser.listOffers())
  ipcMain.handle('offers:accept', (_e, id: number) => organiser.acceptOffer(id))
  ipcMain.handle('offers:decline', (_e, id: number) => organiser.declineOffer(id))
  ipcMain.handle('offers:undoDecline', (_e, id: number, ids: number[]) => organiser.undoDeclineOffer(id, ids))
  ipcMain.handle('suggestions:getMin', () => organiser.getMinBurstSize())
  ipcMain.handle('suggestions:setMin', (_e, n: number) => organiser.setMinBurstSize(n))

  ipcMain.handle('clock:suggestions', () => organiser.suggestions())
  ipcMain.handle('clock:apply', (_e, key: string) => organiser.applySuggestion(key))
  ipcMain.handle('clock:dismiss', (_e, key: string) => organiser.dismissSuggestion(key))
  ipcMain.handle('clock:list', () => organiser.listCorrections())
  ipcMain.handle('clock:add', (_e, c: Omit<ClockCorrection, 'id' | 'photoCount'>) => organiser.addCorrection(c))
  ipcMain.handle('clock:remove', (_e, id: number) => organiser.removeCorrection(id))
  ipcMain.handle('clock:cameras', () => db.cameras())

  ipcMain.handle('albums:list', () => db.listAlbums())
  ipcMain.handle('albums:create', (_e, name: string, parentId: number | null) => db.createAlbum(name, parentId))
  ipcMain.handle('albums:rename', (_e, id: number, name: string) => db.renameAlbum(id, name))
  ipcMain.handle('albums:move', (_e, id: number, parentId: number | null) => db.moveAlbum(id, parentId))
  ipcMain.handle('albums:delete', (_e, id: number) => db.deleteAlbum(id))
  ipcMain.handle('albums:add', (_e, albumId: number, ids: number[]) => db.addToAlbum(albumId, ids))
  ipcMain.handle('albums:remove', (_e, albumId: number, ids: number[]) => db.removeFromAlbum(albumId, ids))

  ipcMain.handle('people:list', () => db.listPeople())
  ipcMain.handle('people:groups', () => db.listFaceGroups())
  ipcMain.handle('people:nameGroup', (_e, faceId: number, name: string) => people.nameGroup(faceId, name))
  ipcMain.handle('people:nameFace', (_e, faceId: number, name: string) => people.nameFace(faceId, name))
  ipcMain.handle('people:faces', (_e, personId: number) => db.personFaces(personId))
  ipcMain.handle('people:reject', (_e, faceId: number) => people.rejectFace(faceId))
  ipcMain.handle('people:rename', (_e, id: number, name: string) => people.renamePerson(id, name))
  ipcMain.handle('people:delete', (_e, id: number) => people.deletePerson(id))
  ipcMain.handle('people:progress', () => people.getProgress())

  ipcMain.handle('tags:list', () => db.listTags())
  ipcMain.handle('tags:add', (_e, ids: number[], name: string) => db.addTag(ids, name))
  ipcMain.handle('tags:remove', (_e, ids: number[], tagId: number) => db.removeTag(ids, tagId))
}

app.whenReady().then(() => {
  const dbFile = join(dataDir, 'library.db')
  // SQLite writes natively (not through Node's fs), so check its location explicitly.
  assertWritable(dbFile, 'open database')
  db = new LibraryDb(dbFile)
  images = new ImageCache(join(dataDir, 'cache'))
  organiser = new Organiser(db)
  // Old merged events become albums before the window asks for anything (spec 0001, AC-9).
  try {
    organiser.convertOldMerges()
  } catch (e) {
    console.error('Converting old merged events failed; will retry next launch', e)
  }
  // PHOTO_LIBRARY_MODELS_DIR lets tests run without (or with other) models.
  const modelsDir = process.env.PHOTO_LIBRARY_MODELS_DIR ?? join(__dirname, '..', '..', 'resources', 'models')
  people = new People(db, modelsDir, join(dataDir, 'cache', 'faces'), (p) => window?.webContents.send('people:progress', p))
  analysis = new Analysis({
    db,
    people,
    images,
    modelsDir,
    packaged: app.isPackaged,
    onContentProgress: (p) => window?.webContents.send('content:progress', p),
    onQualityMeasured: () => sendQualityProgress(),
    // The model runs on its own thread: it would otherwise block this one, which also runs the window.
    loadContentModel: (dir) => ContentModelWorker.start(createContentWorker, dir)
  })
  search = new PhotoSearch(
    db,
    () => analysis.contentModel(),
    (e) => analysis.unavailable(e)
  )
  bestOfService = new BestOfService(db, organiser, search)
  loadProtectedRoots()
  registerPhotoProtocol()
  registerIpc()
  createWindow()
  // Pick up photos added since last time.
  void startScan()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

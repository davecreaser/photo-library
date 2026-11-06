import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron'
import { tmpdir } from 'node:os'
import { extname, isAbsolute, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertWritable, installFsGuard } from './fsGuard.ts'
import { LibraryDb, type Forgotten } from './db.ts'
import { DEFAULT_IGNORED, normaliseRule } from './ignore.ts'
import { BROWSER_NATIVE_EXTENSIONS, fileExists } from './photoFs.ts'
import { scanLibrary } from './scanner.ts'
import { ImageCache } from './thumbnails.ts'
import { Organiser } from './organiser.ts'
import { People } from './people.ts'
import type { ClockCorrection, LibraryInfo, PhotoFilter } from '../shared/types.ts'

// photo://thumb/<id> and photo://full/<id> serve images to the UI.
protocol.registerSchemesAsPrivileged([{ scheme: 'photo', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])

let db: LibraryDb
let images: ImageCache
let organiser: Organiser
let people: People
let window: BrowserWindow | null = null
let currentScan: Promise<void> | null = null
let scanAgain = false

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
  currentScan = (async () => {
    try {
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
              people.kick() // analyse faces in any new photos
            }
            window?.webContents.send('scan:progress', p)
          },
          (forgotten) => void cleanUpCaches(forgotten)
        )
      } while (scanAgain)
    } finally {
      currentScan = null
    }
  })()
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

  ipcMain.handle('photos:query', (_e, filter: PhotoFilter) =>
    db.queryPhotos(filter, filter.eventId ? organiser.eventPhotoIds(filter.eventId) : undefined)
  )
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
  ipcMain.handle('events:list', () => organiser.listEvents())
  ipcMain.handle('events:merge', (_e, ids: string[], name: string) => organiser.mergeEvents(ids, name))
  ipcMain.handle('events:ungroup', (_e, id: string) => organiser.ungroupEvent(id))
  ipcMain.handle('events:saveAsAlbum', (_e, eventId: string, name: string) => organiser.saveEventAsAlbum(eventId, name))

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
  people = new People(db, join(__dirname, '..', '..', 'resources', 'models'), images, join(dataDir, 'cache', 'faces'), (p) =>
    window?.webContents.send('people:progress', p)
  )
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

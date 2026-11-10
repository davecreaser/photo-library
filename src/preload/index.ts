import { contextBridge, ipcRenderer } from 'electron'
import type { Api, AssistantStatus, ContentProgress, ExportProgress, FaceProgress, ScanProgress } from '../shared/types.ts'

const api: Api = {
  getBestOf: (r) => ipcRenderer.invoke('bestOf:get', r),
  getLookalikes: (source) => ipcRenderer.invoke('bestOf:lookalikes', source),
  getPhotosByIds: (ids) => ipcRenderer.invoke('photos:byIds', ids),
  makeBestOfAlbum: (source, ids) => ipcRenderer.invoke('bestOf:makeAlbum', source, ids),
  onBestOfProgress: (cb) => {
    const listener = () => cb()
    ipcRenderer.on('bestOf:progress', listener)
    return () => ipcRenderer.removeListener('bestOf:progress', listener)
  },
  getLeanTowardsStars: () => ipcRenderer.invoke('bestOf:lean'),
  setLeanTowardsStars: (on) => ipcRenderer.invoke('bestOf:setLean', on),
  exportSummary: (source) => ipcRenderer.invoke('export:summary', source),
  exportCopies: (source, options) => ipcRenderer.invoke('export:start', source, options),
  cancelExport: () => ipcRenderer.invoke('export:cancel'),
  revealExport: () => ipcRenderer.invoke('export:reveal'),
  onExportProgress: (cb) => {
    const listener = (_e: unknown, p: ExportProgress) => cb(p)
    ipcRenderer.on('export:progress', listener)
    return () => ipcRenderer.removeListener('export:progress', listener)
  },
  getAssistantAccess: () => ipcRenderer.invoke('assistant:get'),
  setAssistantAccess: (on) => ipcRenderer.invoke('assistant:set', on),
  forgetAssistants: () => ipcRenderer.invoke('assistant:forget'),
  onAssistantStatus: (cb) => {
    const listener = (_e: unknown, s: AssistantStatus) => cb(s)
    ipcRenderer.on('assistant:status', listener)
    return () => ipcRenderer.removeListener('assistant:status', listener)
  },
  onAlbumsChanged: (cb) => {
    const listener = () => cb()
    ipcRenderer.on('albums:changed', listener)
    return () => ipcRenderer.removeListener('albums:changed', listener)
  },
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  getSidebarSections: () => ipcRenderer.invoke('sidebar:get'),
  setSidebarSections: (s) => ipcRenderer.invoke('sidebar:set', s),
  getLibrary: () => ipcRenderer.invoke('library:get'),
  chooseBaseFolder: () => ipcRenderer.invoke('library:chooseBase'),
  startScan: () => ipcRenderer.invoke('scan:start'),
  forgetMissing: () => ipcRenderer.invoke('library:forgetMissing'),
  getIgnoredFolders: () => ipcRenderer.invoke('ignore:get'),
  setIgnoredFolders: (rules) => ipcRenderer.invoke('ignore:set', rules),
  chooseIgnoredFolder: () => ipcRenderer.invoke('ignore:choose'),
  onScanProgress: (cb) => {
    const listener = (_e: unknown, p: ScanProgress) => cb(p)
    ipcRenderer.on('scan:progress', listener)
    return () => ipcRenderer.removeListener('scan:progress', listener)
  },

  queryPhotos: (filter) => ipcRenderer.invoke('photos:query', filter),
  getContentProgress: () => ipcRenderer.invoke('content:progress'),
  onContentProgress: (cb) => {
    const listener = (_e: unknown, p: ContentProgress) => cb(p)
    ipcRenderer.on('content:progress', listener)
    return () => ipcRenderer.removeListener('content:progress', listener)
  },
  getPhoto: (id) => ipcRenderer.invoke('photos:get', id),
  getTimeline: () => ipcRenderer.invoke('photos:timeline'),
  revealInFinder: (id) => ipcRenderer.invoke('photos:reveal', id),
  setFavorite: (ids, favorite) => ipcRenderer.invoke('photos:favorite', ids, favorite),
  getSuggestions: () => ipcRenderer.invoke('suggestions:list'),
  acceptSuggestions: (ids, name) => ipcRenderer.invoke('suggestions:accept', ids, name),
  dismissSuggestions: (ids) => ipcRenderer.invoke('suggestions:dismiss', ids),
  restoreSuggestions: (ids) => ipcRenderer.invoke('suggestions:restore', ids),
  getDismissedSuggestions: () => ipcRenderer.invoke('suggestions:dismissed'),
  getDismissedCount: () => ipcRenderer.invoke('suggestions:dismissedCount'),
  getAlbumOffers: () => ipcRenderer.invoke('offers:list'),
  acceptAlbumOffer: (id) => ipcRenderer.invoke('offers:accept', id),
  declineAlbumOffer: (id) => ipcRenderer.invoke('offers:decline', id),
  undoDeclineAlbumOffer: (id, ids) => ipcRenderer.invoke('offers:undoDecline', id, ids),
  getMinBurstSize: () => ipcRenderer.invoke('suggestions:getMin'),
  setMinBurstSize: (n) => ipcRenderer.invoke('suggestions:setMin', n),

  getClockSuggestions: () => ipcRenderer.invoke('clock:suggestions'),
  applyClockSuggestion: (key) => ipcRenderer.invoke('clock:apply', key),
  dismissClockSuggestion: (key) => ipcRenderer.invoke('clock:dismiss', key),
  listClockCorrections: () => ipcRenderer.invoke('clock:list'),
  addClockCorrection: (c) => ipcRenderer.invoke('clock:add', c),
  removeClockCorrection: (id) => ipcRenderer.invoke('clock:remove', id),
  listCameras: () => ipcRenderer.invoke('clock:cameras'),

  listAlbums: () => ipcRenderer.invoke('albums:list'),
  createAlbum: (name, parentId) => ipcRenderer.invoke('albums:create', name, parentId),
  renameAlbum: (id, name) => ipcRenderer.invoke('albums:rename', id, name),
  moveAlbum: (id, parentId) => ipcRenderer.invoke('albums:move', id, parentId),
  deleteAlbum: (id) => ipcRenderer.invoke('albums:delete', id),
  addToAlbum: (albumId, ids) => ipcRenderer.invoke('albums:add', albumId, ids),
  removeFromAlbum: (albumId, ids) => ipcRenderer.invoke('albums:remove', albumId, ids),

  getPeople: () => ipcRenderer.invoke('people:list'),
  getFaceGroups: () => ipcRenderer.invoke('people:groups'),
  nameFaceGroup: (faceId, name) => ipcRenderer.invoke('people:nameGroup', faceId, name),
  nameFace: (faceId, name) => ipcRenderer.invoke('people:nameFace', faceId, name),
  getPersonFaces: (personId) => ipcRenderer.invoke('people:faces', personId),
  rejectFace: (faceId) => ipcRenderer.invoke('people:reject', faceId),
  renamePerson: (id, name) => ipcRenderer.invoke('people:rename', id, name),
  deletePerson: (id) => ipcRenderer.invoke('people:delete', id),
  getFaceProgress: () => ipcRenderer.invoke('people:progress'),
  onFaceProgress: (cb) => {
    const listener = (_e: unknown, p: FaceProgress) => cb(p)
    ipcRenderer.on('people:progress', listener)
    return () => ipcRenderer.removeListener('people:progress', listener)
  },

  listTags: () => ipcRenderer.invoke('tags:list'),
  addTag: (ids, name) => ipcRenderer.invoke('tags:add', ids, name),
  removeTag: (ids, tagId) => ipcRenderer.invoke('tags:remove', ids, tagId)
}

contextBridge.exposeInMainWorld('api', api)

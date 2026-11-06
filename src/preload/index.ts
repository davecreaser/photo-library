import { contextBridge, ipcRenderer } from 'electron'
import type { Api, ContentProgress, FaceProgress, ScanProgress } from '../shared/types.ts'

const api: Api = {
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

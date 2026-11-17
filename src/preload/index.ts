import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { CH } from '../shared/ipc';
import type {
  ExportProgress,
  ImportProgress,
  IpcResult,
  UploadReceivedEvent,
  VaultApi,
} from '../shared/ipc';

const call = <T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> =>
  ipcRenderer.invoke(channel, ...args) as Promise<IpcResult<T>>;

const api: VaultApi = {
  app: {
    info: () => call(CH.app.info),
    revealInFolder: (photoId) => call(CH.app.revealInFolder, photoId),
    openExternal: (url) => call(CH.app.openExternal, url),
    exportHtmlAlbum: (options) => call(CH.app.exportHtmlAlbum, options),
    clearThumbCache: () => call(CH.app.clearThumbCache),
    setTitlebar: (theme: { color: string; symbolColor: string }) =>
      call(CH.app.setTitlebar, theme),
    checkUpdate: () => call(CH.app.checkUpdate),
    pathForFile: (file) =>
      webUtils.getPathForFile(file as Parameters<typeof webUtils.getPathForFile>[0]),
  },
  library: {
    pickFolder: () => call(CH.library.pickFolder),
    create: (input) => call(CH.library.create, input),
    open: (dbPath) => call(CH.library.open, dbPath),
    close: () => call(CH.library.close),
    current: () => call(CH.library.current),
    recent: () => call(CH.library.recent),
    forgetRecent: (dbPath) => call(CH.library.forgetRecent, dbPath),
    analysis: () => call(CH.library.analysis),
  },
  import: {
    scan: (input) => call(CH.import.scan, input),
    start: (input) => call(CH.import.start, input),
    cancel: () => call(CH.import.cancel),
    batches: (limit) => call(CH.import.batches, limit),
    rollback: (batchId) => call(CH.import.rollback, batchId),
    onProgress: (cb: (p: ImportProgress) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, progress: ImportProgress): void => cb(progress);
      ipcRenderer.on(CH.import.progress, listener);
      return () => {
        ipcRenderer.removeListener(CH.import.progress, listener);
      };
    },
  },
  photo: {
    list: (query) => call(CH.photo.list, query),
    get: (id) => call(CH.photo.get, id),
    patch: (id, patch) => call(CH.photo.patch, id, patch),
    setStatus: (ids, status) => call(CH.photo.setStatus, ids, status),
    remove: (ids, opts) => call(CH.photo.remove, ids, opts),
    restore: (ids) => call(CH.photo.restore, ids),
    checkMissing: (ids) => call(CH.photo.checkMissing, ids),
    similar: (id, maxDistance) => call(CH.photo.similar, id, maxDistance),
    duplicateGroups: (maxDistance) => call(CH.photo.duplicateGroups, maxDistance),
    tags: (photoId) => call(CH.photo.tags, photoId),
    renamePreview: (ids, template) => call(CH.photo.renamePreview, ids, template),
    rename: (ids, template) => call(CH.photo.rename, ids, template),
    export: (options) => call(CH.photo.export, options),
    onExportProgress: (cb: (p: ExportProgress) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, progress: ExportProgress): void => cb(progress);
      ipcRenderer.on(CH.photo.exportProgress, listener);
      return () => {
        ipcRenderer.removeListener(CH.photo.exportProgress, listener);
      };
    },
    savePoster: (input) => call(CH.photo.savePoster, input),
    locations: (precision) => call(CH.photo.locations, precision),
    refreshMeta: (ids) => call(CH.photo.refreshMeta, ids),
  },
  inbox: {
    stats: () => call(CH.inbox.stats),
    review: (ids, action) => call(CH.inbox.review, ids, action),
  },
  album: {
    list: () => call(CH.album.list),
    create: (input) => call(CH.album.create, input),
    patch: (id, patch) => call(CH.album.patch, id, patch),
    remove: (id) => call(CH.album.remove, id),
    addPhotos: (albumId, photoIds) => call(CH.album.addPhotos, albumId, photoIds),
    removePhotos: (albumId, photoIds) => call(CH.album.removePhotos, albumId, photoIds),
  },
  task: {
    list: (includeClosed) => call(CH.task.list, includeClosed),
    create: (input) => call(CH.task.create, input),
    patch: (id, patch) => call(CH.task.patch, id, patch),
    close: (id) => call(CH.task.close, id),
    remove: (id) => call(CH.task.remove, id),
    uploaders: (taskId) => call(CH.task.uploaders, taskId),
    uploadInfo: (taskId) => call(CH.task.uploadInfo, taskId),
    resetToken: (taskId) => call(CH.task.resetToken, taskId),
  },
  tag: {
    list: () => call(CH.tag.list),
    create: (input) => call(CH.tag.create, input),
    patch: (id, patch) => call(CH.tag.patch, id, patch),
    remove: (id) => call(CH.tag.remove, id),
    attach: (photoIds, tagId) => call(CH.tag.attach, photoIds, tagId),
    detach: (photoIds, tagId) => call(CH.tag.detach, photoIds, tagId),
  },
  settings: {
    getAll: () => call(CH.settings.getAll),
    set: (patch) => call(CH.settings.set, patch),
  },
  upload: {
    status: () => call(CH.upload.status),
    start: (port) => call(CH.upload.start, port),
    stop: () => call(CH.upload.stop),
    onReceived: (cb: (e: UploadReceivedEvent) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, event: UploadReceivedEvent): void => cb(event);
      ipcRenderer.on(CH.upload.received, listener);
      return () => {
        ipcRenderer.removeListener(CH.upload.received, listener);
      };
    },
  },
};

contextBridge.exposeInMainWorld('vault', api);

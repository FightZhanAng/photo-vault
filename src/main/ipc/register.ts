import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import type { IpcResult, PhotoStatus } from '@shared/ipc';
import { CH } from '@shared/ipc';
import { AppError, toIpcError } from '../errors';
import { getActiveLibraryId, getDb, isOpen } from '../db';
import * as albumRepo from '../db/albumRepo';
import * as libraryRepo from '../db/libraryRepo';
import * as photoRepo from '../db/photoRepo';
import * as settingsRepo from '../db/settingsRepo';
import * as tagRepo from '../db/tagRepo';
import * as taskRepo from '../db/taskRepo';
import { parseRule } from '../db/rule';
import { cancelImport, listBatches, rollbackBatch, startImport } from '../import/runner';
import { scanFolder } from '../media/scan';
import { clearCache } from '../media/cache';
import { exportPhotos } from '../media/exporter';
import { exportHtmlAlbum } from '../media/htmlAlbum';
import { renamePhotos, previewRename } from '../media/renamer';
import { saveVideoPoster } from '../media/poster';
import { forgetRecent, readRecent, rememberLibrary } from '../recent';
import {
  resetUploadToken,
  setUploadEmitter,
  startUploadServer,
  stopUploadServer,
  taskUploadInfo,
  uploadServerStatus,
} from '../upload/server';
import { rowToBatch } from '../db/mappers';
import { checkUpdate } from '../update';

/* eslint-disable @typescript-eslint/no-explicit-any */

function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data };
}

function fail(err: unknown): IpcResult<never> {
  return { ok: false, error: toIpcError(err) };
}

function handle<A extends any[], R>(
  channel: string,
  fn: (...args: A) => R | Promise<R>
): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return ok(await fn(...(args as A)));
    } catch (e) {
      return fail(e);
    }
  });
}

function mainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null;
}

function openLibraryAndRemember(dbPath: string) {
  const info = libraryRepo.openLibrary(dbPath);
  rememberLibrary({ dbPath: info.dbPath, name: info.name, rootPath: info.rootPath });
  return info;
}

export function registerIpc(): void {
  // 上传服务收到照片后主动通知渲染层，不用前端轮询
  setUploadEmitter((event) => {
    mainWindow()?.webContents.send(CH.upload.received, event);
  });

  // ---------------- app ----------------
  handle(CH.app.info, () => ({
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    platform: process.platform,
    userDataPath: app.getPath('userData'),
    imageFormats: ['jpeg', 'png', 'webp', 'gif', 'tiff', 'heif', 'avif'],
    videoThumbSupported: true,
  }));

  handle(CH.app.revealInFolder, (photoId: number) => {
    const photo = photoRepo.getPhoto(photoId);
    shell.showItemInFolder(photo.path);
  });

  handle(CH.app.openExternal, async (url: string) => {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new AppError('E_INVALID_ARG', '只允许打开 http/https 链接');
    }
    await shell.openExternal(url);
  });

  handle(CH.app.exportHtmlAlbum, async (options: any) => {
    const result = await exportHtmlAlbum(options);
    shell.showItemInFolder(result.indexPath);
    return result;
  });

  handle(CH.app.clearThumbCache, () => {
    const lib = libraryRepo.currentLibrary();
    if (!lib) throw new AppError('E_NOT_INITIALIZED', '媒体库未初始化');
    return clearCache(lib.thumbsPath);
  });

  // 主题换到浅色时，窗口右上角的系统按钮必须跟着变深，否则白底白图标看不见
  handle(CH.app.setTitlebar, (theme: any) => {
    const color = typeof theme?.color === 'string' ? theme.color : '#16171a';
    const symbolColor = typeof theme?.symbolColor === 'string' ? theme.symbolColor : '#d8d9dd';
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        win.setTitleBarOverlay({ color, symbolColor, height: 40 });
      } catch {
        /* 非 Windows 或未启用覆盖层时忽略 */
      }
    }
    return { ok: true };
  });

  handle(CH.app.checkUpdate, () => checkUpdate());

  // ---------------- library ----------------
  handle(CH.library.pickFolder, async () => {
    const win = mainWindow();
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  handle(CH.library.create, (input: { rootPath: string; name: string; mode?: 'reference' | 'managed' }) => {
    const info = libraryRepo.createLibrary(input);
    rememberLibrary({ dbPath: info.dbPath, name: info.name, rootPath: info.rootPath });
    return info;
  });

  handle(CH.library.open, (dbPath: string) => openLibraryAndRemember(dbPath));

  handle(CH.library.close, async () => {
    await stopUploadServer();
    libraryRepo.closeLibrary();
  });

  handle(CH.library.current, () => (isOpen() ? libraryRepo.currentLibrary() : null));

  handle(CH.library.recent, () => readRecent());

  handle(CH.library.forgetRecent, (dbPath: string) => {
    forgetRecent(dbPath);
  });

  handle(CH.library.analysis, () => photoRepo.libraryAnalysis());

  // ---------------- import ----------------
  handle(CH.import.scan, async (input: { sourcePath: string; recursive: boolean }) => {
    const scan = await scanFolder(input.sourcePath, input.recursive);
    const db = getDb();
    const sizes = new Set(
      (db.prepare('SELECT DISTINCT size FROM photos').all() as { size: number }[]).map((r) => r.size)
    );
    const images = scan.files.filter((f) => f.kind === 'image');
    const times = images.map((f) => Math.round(f.mtime));
    return {
      sourcePath: input.sourcePath,
      fileCount: scan.files.length,
      imageCount: images.length,
      videoCount: scan.files.length - images.length,
      unsupportedCount: scan.unsupported,
      totalBytes: scan.totalBytes,
      suspectedDup: images.filter((f) => sizes.has(f.size)).length,
      earliestTakenAt: times.length ? Math.min(...times) : null,
      latestTakenAt: times.length ? Math.max(...times) : null,
    };
  });

  handle(CH.import.start, (input: any) =>
    startImport(input, (progress) => {
      mainWindow()?.webContents.send(CH.import.progress, progress);
    }).then((batchId) => ({ batchId }))
  );

  handle(CH.import.cancel, () => {
    cancelImport();
  });

  handle(CH.import.batches, (limit?: number) => listBatches(limit ?? 20).map(rowToBatch));

  handle(CH.import.rollback, (batchId: number) => rollbackBatch(batchId));

  // ---------------- photo ----------------
  handle(CH.photo.list, (query: any) => photoRepo.listPhotos(query ?? {}));
  handle(CH.photo.get, (id: number) => photoRepo.getPhoto(id));
  handle(CH.photo.patch, (id: number, patch: any) => photoRepo.patchPhoto(id, patch));
  handle(CH.photo.setStatus, (ids: number[], status: PhotoStatus) => photoRepo.setPhotoStatus(ids, status));
  handle(CH.photo.remove, (ids: number[], opts?: { deleteFile?: boolean }) =>
    photoRepo.removePhotos(ids, opts)
  );
  handle(CH.photo.restore, (ids: number[]) => photoRepo.restorePhotos(ids));
  handle(CH.photo.checkMissing, (ids?: number[]) => photoRepo.checkMissing(ids));
  handle(CH.photo.similar, (id: number, maxDistance?: number) => photoRepo.findSimilar(id, maxDistance));
  handle(CH.photo.duplicateGroups, (maxDistance?: number) =>
    photoRepo.duplicateGroups(maxDistance ?? 6)
  );
  handle(CH.photo.tags, (photoId: number) => tagRepo.getTagsForPhoto(photoId));
  handle(CH.photo.renamePreview, (ids: number[], template: string) => previewRename(ids, template));
  handle(CH.photo.rename, (ids: number[], template: string) => renamePhotos(ids, template));
  handle(CH.photo.export, (options: any) =>
    exportPhotos(options, (progress) => {
      mainWindow()?.webContents.send(CH.photo.exportProgress, progress);
    })
  );
  handle(CH.photo.savePoster, (input: any) => saveVideoPoster(input));
  handle(CH.photo.locations, (precision?: number) => photoRepo.locations(precision));

  // ---------------- inbox ----------------
  handle(CH.inbox.stats, () => {
    const db = getDb();
    const libraryId = getActiveLibraryId();
    const row = db
      .prepare(
        `SELECT
           SUM(CASE WHEN status = 'inbox' THEN 1 ELSE 0 END) AS inbox,
           SUM(CASE WHEN status = 'kept' THEN 1 ELSE 0 END) AS kept,
           SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
           SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS today
         FROM photos WHERE library_id = ?`
      )
      .get(startOfToday(), libraryId) as any;
    return {
      inbox: row?.inbox ?? 0,
      kept: row?.kept ?? 0,
      rejected: row?.rejected ?? 0,
      todayAdded: row?.today ?? 0,
    };
  });

  handle(CH.inbox.review, (ids: number[], action: 'keep' | 'reject') =>
    photoRepo.setPhotoStatus(ids, action === 'keep' ? 'kept' : 'rejected')
  );

  // ---------------- album ----------------
  handle(CH.album.list, () => {
    // 智能相册不存 album_photos，照片数是按规则现算的
    return albumRepo.listAlbums().map((album) =>
      album.kind === 'smart'
        ? { ...album, photoCount: photoRepo.countByRule(parseRule(album.ruleJson)) }
        : album
    );
  });
  handle(CH.album.create, (input: any) => albumRepo.createAlbum(input));
  handle(CH.album.patch, (id: number, patch: any) => albumRepo.patchAlbum(id, patch));
  handle(CH.album.remove, (id: number) => albumRepo.removeAlbum(id));
  handle(CH.album.addPhotos, (albumId: number, photoIds: number[]) =>
    albumRepo.addPhotosToAlbum(albumId, photoIds)
  );
  handle(CH.album.removePhotos, (albumId: number, photoIds: number[]) =>
    albumRepo.removePhotosFromAlbum(albumId, photoIds)
  );

  // ---------------- task ----------------
  handle(CH.task.list, (includeClosed?: boolean) => taskRepo.listTasks(includeClosed ?? false));
  handle(CH.task.create, (input: any) => taskRepo.createTask(input));
  handle(CH.task.patch, (id: number, patch: any) => taskRepo.patchTask(id, patch));
  handle(CH.task.close, (id: number) => taskRepo.closeTask(id));
  handle(CH.task.remove, (id: number) => taskRepo.removeTask(id));
  handle(CH.task.uploaders, (taskId: number) => taskRepo.uploaderStats(taskId));
  handle(CH.task.uploadInfo, (taskId: number) => taskUploadInfo(taskId));
  handle(CH.task.resetToken, (taskId: number) => resetUploadToken(taskId));

  // ---------------- tag ----------------
  handle(CH.tag.list, () => tagRepo.listTags());
  handle(CH.tag.create, (input: any) => tagRepo.createTag(input));
  handle(CH.tag.patch, (id: number, patch: any) => tagRepo.patchTag(id, patch));
  handle(CH.tag.remove, (id: number) => tagRepo.removeTag(id));
  handle(CH.tag.attach, (photoIds: number[], tagId: number) => tagRepo.attachTags(photoIds, tagId));
  handle(CH.tag.detach, (photoIds: number[], tagId: number) => tagRepo.detachTags(photoIds, tagId));

  // ---------------- settings ----------------
  handle(CH.settings.getAll, () => settingsRepo.getAllSettings());
  handle(CH.settings.set, (patch: Record<string, string>) => settingsRepo.setSettings(patch));

  // ---------------- upload ----------------
  handle(CH.upload.status, () => uploadServerStatus());
  handle(CH.upload.start, (port?: number) => startUploadServer(port));
  handle(CH.upload.stop, () => stopUploadServer());
}

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

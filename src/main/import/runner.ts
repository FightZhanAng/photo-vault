import { mkdir, writeFile } from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ImportPhase, ImportProgress, ImportStartInput } from '@shared/ipc';
import { AppError } from '../errors';
import { getActiveLibraryId, getDb } from '../db';
import { addPhotosToAlbum } from '../db/albumRepo';
import { linkPhotosToTask } from '../db/taskRepo';
import { prepareImage, readExif, sha1File } from '../media/pipeline';
import { scanPaths } from '../media/scan';
import { thumbFile } from '../media/thumbnails';

/* eslint-disable @typescript-eslint/no-explicit-any */

type Emit = (p: ImportProgress) => void;

interface Job {
  cancelled: boolean;
}

let activeJob: Job | null = null;

export function isImporting(): boolean {
  return activeJob !== null;
}

export function cancelImport(): void {
  if (activeJob) activeJob.cancelled = true;
}

/** 串行化「查重 + 插入」，避免并发下同一张图被插两次 */
let insertChain: Promise<unknown> = Promise.resolve();
function withInsertLock<T>(fn: () => T): Promise<T> {
  const run = insertChain.then(fn, fn);
  insertChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
  stopped: () => boolean
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      if (stopped()) return;
      const i = cursor++;
      if (i >= items.length) return;
      await worker(items[i]);
    }
  });
  await Promise.all(runners);
}

export async function startImport(input: ImportStartInput, emit: Emit): Promise<number> {
  if (activeJob) throw new AppError('E_BUSY', '已有导入任务正在进行');

  // 常规导入给 sourcePath，拖拽导入给 paths；两者合并去重后一起扫
  const sources = [
    ...(input.sourcePath ? [input.sourcePath] : []),
    ...(input.paths ?? []),
  ].filter((p, i, arr) => Boolean(p) && arr.indexOf(p) === i);
  if (!sources.length) throw new AppError('E_INVALID_ARG', '没有要导入的路径');

  const db = getDb();
  const libraryId = getActiveLibraryId();
  const lib = db.prepare('SELECT * FROM libraries ORDER BY id LIMIT 1').get() as any;
  if (!lib) throw new AppError('E_NOT_INITIALIZED', '媒体库未初始化');

  const startedAt = Date.now();
  const batchId = Number(
    db
      .prepare(
        `INSERT INTO import_batches (library_id, source_path, task_id, state, started_at)
         VALUES (?, ?, ?, 'running', ?)`
      )
      .run(
        libraryId,
        sources.length === 1 ? sources[0] : `${sources[0]} 等 ${sources.length} 处`,
        input.taskId ?? null,
        startedAt
      ).lastInsertRowid
  );

  const job: Job = { cancelled: false };
  activeJob = job;

  const stats = { processed: 0, added: 0, skippedDup: 0, failed: 0 };
  let total = 0;
  let lastPush = 0;

  const push = (phase: ImportPhase, extra: Partial<ImportProgress> = {}, force = false): void => {
    const now = Date.now();
    if (!force && now - lastPush < 140) return;
    lastPush = now;
    emit({
      batchId,
      phase,
      processed: stats.processed,
      total,
      added: stats.added,
      skippedDup: stats.skippedDup,
      failed: stats.failed,
      ...extra,
    });
  };

  const findDup = db.prepare('SELECT id FROM photos WHERE library_id = ? AND hash_full = ? LIMIT 1');
  const insertPhoto = db.prepare(
    `INSERT INTO photos
      (library_id, path, rel_path, file_name, ext, size, mtime, hash_full, hash_phash,
       width, height, orientation, taken_at, camera_make, camera_model, lens_model,
       gps_lat, gps_lon, duration_ms, status, rating, favorite, note, missing, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, 0, ?, ?)`
  );
  const linkBatch = db.prepare(
    'INSERT OR IGNORE INTO import_batch_photos (batch_id, photo_id) VALUES (?, ?)'
  );

  void (async () => {
    try {
      push('scanning', {}, true);
      const scan = await scanPaths(sources, input.recursive, job, (found) =>
        push('scanning', { processed: found, currentFile: `已发现 ${found} 个文件` })
      );
      // 图片和视频都入库：视频的尺寸/时长/首帧由渲染层截帧后回写（见 photo:savePoster）
      const files = scan.files;
      total = files.length;

      push('deduping', { total }, true);

      const newIds: number[] = [];
      // 1KB 以下基本是图标、占位图、损坏文件；正常照片再小也在这个之上
      const minSize = input.minFileSize ?? 1024;

      await runPool(
        files,
        4,
        async (file) => {
          if (job.cancelled) return;
          stats.processed++;
          try {
            if (file.size < minSize) {
              stats.skippedDup++;
              return;
            }

            const hashFull = await sha1File(file.path);
            if (findDup.get(libraryId, hashFull)) {
              stats.skippedDup++;
              push('deduping');
              return;
            }

            const isVideo = file.kind === 'video';
            // 视频不能走 sharp；尺寸/时长先留空，等首帧回写时一起补。
            // 拍摄时间对手机拍的 MOV 常常能从容器里读到，读不到就退回文件时间。
            const prepared = isVideo ? null : await prepareImage(file, hashFull);
            let takenAt = Math.round(file.mtime);
            let cameraMake: string | null = null;
            let cameraModel: string | null = null;
            let lensModel: string | null = null;
            let gpsLat: number | null = null;
            let gpsLon: number | null = null;
            if (isVideo) {
              const exif = await readExif(file.path);
              const d = exif.DateTimeOriginal ?? exif.CreateDate;
              if (d instanceof Date && !Number.isNaN(d.getTime())) takenAt = d.getTime();
              cameraMake = exif.Make ?? null;
              cameraModel = exif.Model ?? null;
              lensModel = exif.LensModel ?? null;
              gpsLat = typeof exif.latitude === 'number' ? exif.latitude : null;
              gpsLon = typeof exif.longitude === 'number' ? exif.longitude : null;
            }

            const id = await withInsertLock(() => {
              if (findDup.get(libraryId, hashFull)) return 0; // 并发窗口内被别人插了
              const now = Date.now();
              const r = insertPhoto.run(
                libraryId,
                file.path,
                file.fileName,
                file.ext,
                file.size,
                Math.round(file.mtime),
                prepared?.hashFull ?? hashFull,
                prepared?.hashPhash ?? null,
                prepared?.width ?? null,
                prepared?.height ?? null,
                prepared?.orientation ?? 1,
                prepared?.takenAt ?? takenAt,
                prepared?.cameraMake ?? cameraMake,
                prepared?.cameraModel ?? cameraModel,
                prepared?.lensModel ?? lensModel,
                prepared?.gpsLat ?? gpsLat,
                prepared?.gpsLon ?? gpsLon,
                null, // duration_ms 由首帧回写补上
                input.autoKeep ? 'kept' : 'inbox',
                now,
                now
              );
              const photoId = Number(r.lastInsertRowid);
              linkBatch.run(batchId, photoId);
              return photoId;
            });

            if (!id) {
              stats.skippedDup++;
              return;
            }

            // 视频跳过缩略图落盘，等渲染层截帧后由 savePoster 写入
            if (prepared) {
              const dest = thumbFile(lib.thumbs_path, id, 320);
              await mkdir(dirname(dest), { recursive: true });
              await writeFile(dest, prepared.thumbBuffer);
            }

            newIds.push(id);
            stats.added++;
            push('thumbnailing', { currentFile: file.fileName });
          } catch (e) {
            stats.failed++;
            push('thumbnailing', { message: `${file.fileName} 处理失败` });
          }
        },
        () => job.cancelled
      );

      if (newIds.length) {
        if (input.albumId) addPhotosToAlbum(input.albumId, newIds);
        if (input.taskId) linkPhotosToTask(input.taskId, newIds, input.sourceLabel);
      }

      const state = job.cancelled ? 'cancelled' : 'done';
      db.prepare(
        `UPDATE import_batches
         SET total = ?, added = ?, skipped_dup = ?, failed = ?, state = ?, finished_at = ?
         WHERE id = ?`
      ).run(total, stats.added, stats.skippedDup, stats.failed, state, Date.now(), batchId);

      push(job.cancelled ? 'cancelled' : 'done', { total }, true);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      try {
        db.prepare(
          `UPDATE import_batches SET state = 'failed', error = ?, finished_at = ? WHERE id = ?`
        ).run(message, Date.now(), batchId);
      } catch {
        /* 库被关掉的情况下写不进去，忽略 */
      }
      push('error', { message }, true);
    } finally {
      activeJob = null;
    }
  })();

  return batchId;
}

/**
 * 撤销一次导入：删掉这批新增的照片记录、缩略图文件，并把批次标成「已撤销」。
 * 只删索引与缓存，原图不动 —— 引用式库里原图本来就属于用户自己的目录。
 */
export function rollbackBatch(batchId: number): { removed: number } {
  const db = getDb();
  const lib = db.prepare('SELECT * FROM libraries ORDER BY id LIMIT 1').get() as any;
  const rows = db
    .prepare('SELECT photo_id FROM import_batch_photos WHERE batch_id = ?')
    .all(batchId) as { photo_id: number }[];
  if (!rows.length) {
    db.prepare("UPDATE import_batches SET state = 'cancelled', error = '已撤销' WHERE id = ?").run(
      batchId
    );
    return { removed: 0 };
  }

  const del = db.prepare('DELETE FROM photos WHERE id = ?');
  let removed = 0;
  db.transaction(() => {
    for (const row of rows) {
      removed += del.run(row.photo_id).changes;
      if (lib?.thumbs_path) {
        for (const size of [320, 1600] as const) {
          try {
            unlinkSync(thumbFile(lib.thumbs_path, row.photo_id, size));
          } catch {
            /* 缓存可能还没生成，或缺了也无所谓 */
          }
        }
      }
    }
  })();
  db.prepare('DELETE FROM import_batch_photos WHERE batch_id = ?').run(batchId);
  db.prepare("UPDATE import_batches SET state = 'cancelled', error = '已撤销' WHERE id = ?").run(batchId);
  return { removed };
}

export function listBatches(limit = 20): any[] {
  return getDb()
    .prepare('SELECT * FROM import_batches ORDER BY id DESC LIMIT ?')
    .all(limit) as any[];
}

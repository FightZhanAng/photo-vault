import { copyFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { addPhotosToAlbum } from '../db/albumRepo';
import { getActiveLibraryId, getDb } from '../db';
import { getTask, linkPhotosToTask } from '../db/taskRepo';
import { prepareImage, sha1File } from '../media/pipeline';
import { fileKind } from '../media/scan';
import { sanitizeName } from '../media/renamer';
import { thumbFile } from '../media/thumbnails';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface IngestResult {
  photoId: number | null;
  deduped: boolean;
}

function uniquePath(dir: string, base: string, ext: string): string {
  let name = `${base}.${ext}`;
  let n = 2;
  while (existsSync(join(dir, name))) {
    name = `${base}-${n}.${ext}`;
    n++;
  }
  return join(dir, name);
}

/**
 * 把一个上传完成的临时文件收进库里。
 *
 * 与本地导入的差别只有两点：
 * 1. 文件必须落到库目录下（上传没有「原位置」可引用），统一放 <库>/收集/<任务名>/
 * 2. 同时写入 task_photos 的来源标注（上传者 / 设备），审核时可以区分是谁传的
 */
export async function ingestUpload(input: {
  partPath: string;
  fileName: string;
  taskId: number;
  uploader: string | null;
  device: string | null;
}): Promise<IngestResult> {
  const db = getDb();
  const libraryId = getActiveLibraryId();
  const lib = db.prepare('SELECT * FROM libraries ORDER BY id LIMIT 1').get() as any;
  if (!lib) throw new Error('媒体库未初始化');

  const hashFull = await sha1File(input.partPath);
  const dup = db
    .prepare('SELECT id FROM photos WHERE library_id = ? AND hash_full = ? LIMIT 1')
    .get(libraryId, hashFull) as { id: number } | undefined;
  if (dup) {
    removeQuietly(input.partPath);
    return { photoId: dup.id, deduped: true };
  }

  const task = getTask(input.taskId);
  const dir = join(lib.root_path, '收集', sanitizeName(task.name) || `任务-${task.id}`);
  mkdirSync(dir, { recursive: true });

  const rawExt = extname(input.fileName).replace(/^\./, '').toLowerCase() || 'jpg';
  const ext = /^[a-z0-9]{1,5}$/.test(rawExt) ? rawExt : 'jpg';
  const base =
    sanitizeName(input.fileName.slice(0, input.fileName.length - extname(input.fileName).length)) ||
    `upload-${Date.now()}`;
  const dest = uniquePath(dir, base, ext);

  try {
    renameSync(input.partPath, dest);
  } catch {
    // 跨盘时 rename 会失败，退回复制
    copyFileSync(input.partPath, dest);
    removeQuietly(input.partPath);
  }

  // 手机上也会传视频：走和本地导入一样的路子，先入库、尺寸/首帧由渲染层补
  const isVideo = fileKind(ext) === 'video';
  let prepared: Awaited<ReturnType<typeof prepareImage>> | null = null;
  let fileStat;
  try {
    fileStat = statSync(dest);
    if (!isVideo) {
      prepared = await prepareImage(
        { path: dest, fileName: input.fileName, ext, size: fileStat.size, mtime: fileStat.mtimeMs, kind: 'image' },
        hashFull
      );
    }
  } catch (e) {
    removeQuietly(dest);
    throw e;
  }

  const now = Date.now();
  const r = db
    .prepare(
      `INSERT INTO photos
        (library_id, path, rel_path, file_name, ext, size, mtime, hash_full, hash_phash,
         width, height, orientation, taken_at, camera_make, camera_model, lens_model,
         gps_lat, gps_lon, duration_ms, status, rating, favorite, note, missing, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'inbox', 0, 0, NULL, 0, ?, ?)`
    )
    .run(
      libraryId,
      dest,
      dest.slice(lib.root_path.length + 1),
      input.fileName,
      ext,
      fileStat.size,
      Math.round(fileStat.mtimeMs),
      prepared?.hashFull ?? hashFull,
      prepared?.hashPhash ?? null,
      prepared?.width ?? null,
      prepared?.height ?? null,
      prepared?.orientation ?? 1,
      prepared?.takenAt ?? Math.round(fileStat.mtimeMs),
      prepared?.cameraMake ?? null,
      prepared?.cameraModel ?? null,
      prepared?.lensModel ?? null,
      prepared?.gpsLat ?? null,
      prepared?.gpsLon ?? null,
      now,
      now
    );

  const photoId = Number(r.lastInsertRowid);

  if (prepared) {
    const thumbPath = thumbFile(lib.thumbs_path, photoId, 320);
    await mkdir(dirname(thumbPath), { recursive: true });
    await writeFile(thumbPath, prepared.thumbBuffer);
  }

  linkPhotosToTask(task.id, [photoId], input.uploader, input.device);
  if (task.defaultAlbumId) addPhotosToAlbum(task.defaultAlbumId, [photoId]);

  return { photoId, deduped: false };
}

function removeQuietly(p: string): void {
  try {
    if (existsSync(p)) unlinkSync(p);
  } catch {
    /* ignore */
  }
}

import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import sharp from 'sharp';
import type { VideoPosterInput } from '@shared/ipc';
import { AppError } from '../errors';
import { getDb } from '../db';
import { getPhoto } from '../db/photoRepo';
import { computeDHash, thumbFile } from './thumbnails';

/* eslint-disable @typescript-eslint/no-explicit-any */

const DATA_URL = /^data:image\/(?:webp|png|jpeg);base64,([A-Za-z0-9+/=\s]+)$/;

function decodeDataUrl(dataUrl: string): Buffer {
  const m = DATA_URL.exec(dataUrl.trim());
  if (!m) throw new AppError('E_INVALID_ARG', '首帧格式不对，只接受 webp/png/jpeg 的 data URL');
  const buf = Buffer.from(m[1].replace(/\s+/g, ''), 'base64');
  if (buf.length < 256) throw new AppError('E_INVALID_ARG', '首帧数据太小');
  if (buf.length > 12 * 1024 * 1024) throw new AppError('E_INVALID_ARG', '首帧数据太大');
  return buf;
}

function thumbsPath(): string {
  const row = getDb().prepare('SELECT thumbs_path FROM libraries ORDER BY id LIMIT 1').get() as
    | { thumbs_path: string }
    | undefined;
  if (!row?.thumbs_path) throw new AppError('E_NOT_INITIALIZED', '媒体库未初始化');
  return row.thumbs_path;
}

/**
 * 视频首帧回写。
 *
 * 渲染层用 <video> 把视频解出一帧画到 canvas，再把这帧交回来：
 * 1. 原样落成 1600 预览（大图/播放器未起播时先垫着）
 * 2. 缩出 320 缩略图给网格
 * 3. 顺手算一次 dHash，视频也能进「找相似 / 重复照片」
 * 4. 补上 width / height / duration_ms
 */
export async function saveVideoPoster(
  input: VideoPosterInput
): Promise<{ ok: boolean }> {
  const id = Number(input?.photoId);
  if (!Number.isInteger(id) || id <= 0) throw new AppError('E_INVALID_ARG', '照片 id 不合法');

  const photo = getPhoto(id);
  const raw = decodeDataUrl(String(input.dataUrl ?? ''));
  const dir = thumbsPath();

  const meta = await sharp(raw, { failOn: 'none' }).metadata();
  const width = Number.isFinite(input.width) && input.width > 0 ? Math.round(input.width) : meta.width ?? null;
  const height =
    Number.isFinite(input.height) && input.height > 0 ? Math.round(input.height) : meta.height ?? null;

  for (const size of [1600, 320] as const) {
    const dest = thumbFile(dir, id, size);
    mkdirSync(dirname(dest), { recursive: true });
    try {
      await sharp(raw, { failOn: 'none' })
        .rotate()
        .resize(size, size, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: size === 320 ? 78 : 86 })
        .toFile(dest);
    } catch {
      /* 单张写失败不影响其它尺寸；下次显示时还会再触发一次 */
    }
  }

  let phash: string | null = null;
  try {
    const small = thumbFile(dir, id, 320);
    phash = await computeDHash(small);
  } catch {
    /* 算不出哈希就让视频不进相似分组，不影响主流程 */
  }

  const duration =
    Number.isFinite(input.durationMs) && input.durationMs > 0 ? Math.round(input.durationMs) : null;

  getDb()
    .prepare(
      `UPDATE photos
       SET width = ?, height = ?, duration_ms = ?, hash_phash = COALESCE(?, hash_phash), updated_at = ?
       WHERE id = ?`
    )
    .run(width, height, duration, phash, Date.now(), id);

  return { ok: photo.id === id };
}

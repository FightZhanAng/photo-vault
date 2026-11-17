import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import exifr from 'exifr';
import sharp from 'sharp';
import type { ScannedFile } from './scan';
import { computeDHash, renderThumbBuffer } from './thumbnails';

export interface PreparedImage {
  hashFull: string;
  hashPhash: string;
  width: number;
  height: number;
  orientation: number;
  takenAt: number;
  cameraMake: string | null;
  cameraModel: string | null;
  lensModel: string | null;
  gpsLat: number | null;
  gpsLon: number | null;
  /** 已生成的 320 缩略图，写入磁盘时直接用，避免二次解码 */
  thumbBuffer: Buffer;
}

export function sha1File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha1');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

interface ExifLike {
  DateTimeOriginal?: Date;
  CreateDate?: Date;
  Make?: string;
  Model?: string;
  LensModel?: string;
  Orientation?: number;
  latitude?: number;
  longitude?: number;
}

export async function readExif(filePath: string): Promise<ExifLike> {
  try {
    const data = (await exifr.parse(filePath, {
      pick: ['DateTimeOriginal', 'CreateDate', 'Make', 'Model', 'LensModel', 'Orientation'],
      gps: true,
      reviveValues: true,
    })) as ExifLike | undefined;
    return data ?? {};
  } catch {
    return {};
  }
}

/**
 * 一次解码完成：读尺寸 + 出缩略图 + 算 dHash。
 * 视频不走这里（P0 只处理图片）。
 */
export async function prepareImage(file: ScannedFile, precomputedHash?: string): Promise<PreparedImage> {
  const [meta, exif, hashFull] = await Promise.all([
    sharp(file.path, { failOn: 'none' }).metadata(),
    readExif(file.path),
    precomputedHash ? Promise.resolve(precomputedHash) : sha1File(file.path),
  ]);

  const { buffer, width, height } = await renderThumbBuffer(file.path, 320);
  const hashPhash = await computeDHash(buffer);

  const orientation = meta.orientation ?? 1;
  // 旋转 90/270 的情况，存储尺寸按视觉方向（用原图尺寸，不是缩略图尺寸）
  const swap = orientation >= 5 && orientation <= 8;
  const sourceWidth = meta.width ?? width;
  const sourceHeight = meta.height ?? height;
  const visualWidth = swap ? sourceHeight : sourceWidth;
  const visualHeight = swap ? sourceWidth : sourceHeight;

  const exifDate = exif.DateTimeOriginal ?? exif.CreateDate;
  const takenAt = exifDate instanceof Date && !Number.isNaN(exifDate.getTime())
    ? exifDate.getTime()
    : Math.round(file.mtime);

  return {
    hashFull,
    hashPhash,
    width: visualWidth,
    height: visualHeight,
    orientation,
    takenAt,
    cameraMake: exif.Make ?? null,
    cameraModel: exif.Model ?? null,
    lensModel: exif.LensModel ?? null,
    gpsLat: typeof exif.latitude === 'number' ? exif.latitude : null,
    gpsLon: typeof exif.longitude === 'number' ? exif.longitude : null,
    thumbBuffer: buffer,
  };
}

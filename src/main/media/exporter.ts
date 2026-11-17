import { copyFile, mkdir, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import sharp from 'sharp';
import type { ExportOptions, ExportProgress, ExportResult } from '@shared/ipc';
import { AppError } from '../errors';
import { getDb } from '../db';
import { sanitizeName } from './renamer';
import { fileKind } from './scan';

/* eslint-disable @typescript-eslint/no-explicit-any */

const EXT_BY_FORMAT: Record<Exclude<ExportOptions['format'], 'original'>, string> = {
  jpeg: 'jpg',
  webp: 'webp',
  png: 'png',
};

function baseOf(fileName: string): string {
  const ext = extname(fileName);
  return sanitizeName(ext ? fileName.slice(0, -ext.length) : fileName) || 'photo';
}

/**
 * 批量导出 / 压缩。
 * - original：直接复制，不重新编码（最快、无损，HEIC 也能带走）
 * - jpeg/webp/png：按长边缩放 + 质量重编码，适合发人或上传
 *
 * 重名处理：同批次内加 -2 / -3，绝不覆盖目标目录已有文件。
 */
export async function exportPhotos(
  options: ExportOptions,
  onProgress?: (p: ExportProgress) => void
): Promise<ExportResult> {
  const { photoIds, destDir } = options;
  if (!photoIds.length) throw new AppError('E_INVALID_ARG', '没有选中照片');
  if (!destDir) throw new AppError('E_INVALID_ARG', '请选择导出目录');

  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, path, file_name, ext FROM photos
       WHERE id IN (${photoIds.map(() => '?').join(',')})`
    )
    .all(...photoIds) as { id: number; path: string; file_name: string; ext: string }[];

  await mkdir(destDir, { recursive: true });

  const used = new Set<string>();
  const total = rows.length;
  let done = 0;
  let exported = 0;
  let failed = 0;
  let totalBytes = 0;
  const errors: string[] = [];
  let lastEmit = 0;

  const emit = (phase: 'running' | 'done', currentFile: string, message?: string): void => {
    if (!onProgress) return;
    const now = Date.now();
    if (phase === 'running' && now - lastEmit < 120) return;
    lastEmit = now;
    onProgress({ done, total, currentFile, phase, message });
  };

  for (const row of rows) {
    const base = baseOf(row.file_name);
    // 视频不能转码（没有编解码器），不论选什么格式都按原样复制，并在结果里说明
    const isVideo = fileKind(row.ext || extname(row.file_name).replace(/^\./, '')) === 'video';
    const targetExt =
      options.format === 'original' || isVideo
        ? row.ext || extname(row.file_name).replace(/^\./, '') || 'jpg'
        : EXT_BY_FORMAT[options.format];

    let name = `${base}.${targetExt}`;
    let n = 2;
    while (used.has(name.toLowerCase())) {
      name = `${base}-${n}.${targetExt}`;
      n++;
    }
    used.add(name.toLowerCase());
    const dest = join(destDir, name);

    try {
      if (options.format === 'original' || isVideo) {
        await copyFile(row.path, dest);
        if (isVideo && options.format !== 'original' && errors.length < 10) {
          errors.push(`${row.file_name}：视频不能转码，已按原样复制`);
        }
      } else {
        let pipe = sharp(row.path, { failOn: 'none' }).rotate();
        if (options.maxSize) {
          pipe = pipe.resize(options.maxSize, options.maxSize, {
            fit: 'inside',
            withoutEnlargement: true,
          });
        }
        if (options.stripMetadata !== false) pipe = pipe.withMetadata();
        const quality = Math.min(100, Math.max(1, options.quality ?? 88));
        if (options.format === 'jpeg') pipe = pipe.jpeg({ quality, mozjpeg: true });
        else if (options.format === 'webp') pipe = pipe.webp({ quality });
        else pipe = pipe.png({ compressionLevel: 9 });
        await pipe.toFile(dest);
      }
      const s = await stat(dest);
      totalBytes += s.size;
      exported++;
    } catch (e) {
      failed++;
      if (errors.length < 10) {
        errors.push(`${row.file_name}：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    done++;
    emit('running', row.file_name);
  }

  emit('done', '');
  return { exported, failed, totalBytes, destDir, errors };
}

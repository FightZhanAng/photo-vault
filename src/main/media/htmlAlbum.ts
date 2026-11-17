import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import type { HtmlAlbumOptions, HtmlAlbumResult } from '@shared/ipc';
import { AppError } from '../errors';
import { getDb } from '../db';
import template from './albumTemplate.html?raw';
import { sanitizeName } from './renamer';

/* eslint-disable @typescript-eslint/no-explicit-any */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDay(ts: number | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 导出一个能直接双击打开的离线相册页。
 *
 * 为什么不用 vault:// 或原图相对路径：页面一旦离开应用就没有自定义协议了，
 * 手机浏览器也不认 HEIC。所以这里统一转成 JPEG 落到 files/，页面只引用相对路径。
 */
export async function exportHtmlAlbum(options: HtmlAlbumOptions): Promise<HtmlAlbumResult> {
  const { photoIds, destDir } = options;
  if (!photoIds.length) throw new AppError('E_INVALID_ARG', '没有选中照片');
  if (!destDir) throw new AppError('E_INVALID_ARG', '请选择导出目录');

  const title = options.title?.trim() || '我的相册';
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, path, file_name, taken_at FROM photos
       WHERE id IN (${photoIds.map(() => '?').join(',')})`
    )
    .all(...photoIds) as { id: number; path: string; file_name: string; taken_at: number | null }[];

  const order = new Map(photoIds.map((id, i) => [id, i]));
  rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));

  await mkdir(destDir, { recursive: true });
  let folder = join(destDir, sanitizeName(title) || '相册');
  let suffix = 2;
  while (existsSync(join(folder, 'index.html'))) {
    folder = join(destDir, `${sanitizeName(title) || '相册'}-${suffix}`);
    suffix++;
  }
  const filesDir = join(folder, 'files');
  await mkdir(filesDir, { recursive: true });

  const items: { f: string; n: string; d: number | null; w: number; h: number }[] = [];
  let bytes = 0;
  let index = 0;

  for (const row of rows) {
    index++;
    const name = `files/${String(index).padStart(4, '0')}.jpg`;
    try {
      const info = await sharp(row.path, { failOn: 'none' })
        .rotate()
        .resize(2000, 2000, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 84, mozjpeg: true })
        .toFile(join(folder, name));
      bytes += info.size;
      items.push({
        f: name,
        n: row.file_name,
        d: row.taken_at,
        w: info.width,
        h: info.height,
      });
    } catch {
      /* 单张坏图跳过，不影响整本相册 */
    }
  }

  if (!items.length) throw new AppError('E_IO', '没有可导出的照片（可能原文件已丢失）');

  const days = items
    .map((it) => it.d)
    .filter((d): d is number => typeof d === 'number')
    .sort((a, b) => a - b);
  const range =
    days.length > 0
      ? `${formatDay(days[0])} — ${formatDay(days[days.length - 1])}`
      : '拍摄时间未知';
  const subtitle = `${items.length} 张照片 · ${range}`;

  const itemsJson = JSON.stringify(items).replace(/</g, '\\u003c');
  const html = template
    .replace(/\{\{TITLE\}\}/g, () => escapeHtml(title))
    .replace(/\{\{SUBTITLE\}\}/g, () => escapeHtml(subtitle))
    .replace('{{ITEMS}}', () => itemsJson);

  const indexPath = join(folder, 'index.html');
  await writeFile(indexPath, html, 'utf8');
  bytes += Buffer.byteLength(html, 'utf8');

  return {
    folder,
    indexPath,
    count: items.length,
    bytes,
  };
}

import { existsSync, renameSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import type { RenamePreview, RenamePreviewRow, RenameResult } from '@shared/ipc';
import { AppError } from '../errors';
import { getDb } from '../db';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Windows 允许的字符集之外的一律替换掉；结尾的点和空格在 Windows 上也不合法 */
export function sanitizeName(input: string): string {
  const cleaned = input
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return cleaned.slice(0, 120);
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

function tokensOf(row: any, seq: number, padding: number): Record<string, string> {
  const d = new Date(row.taken_at ?? row.created_at ?? Date.now());
  const base = extname(row.file_name).length
    ? row.file_name.slice(0, -extname(row.file_name).length)
    : row.file_name;
  return {
    name: base,
    date: `${d.getFullYear()}${pad(d.getMonth() + 1, 2)}${pad(d.getDate(), 2)}`,
    time: `${pad(d.getHours(), 2)}${pad(d.getMinutes(), 2)}${pad(d.getSeconds(), 2)}`,
    year: String(d.getFullYear()),
    month: pad(d.getMonth() + 1, 2),
    day: pad(d.getDate(), 2),
    seq: pad(seq, padding),
    camera: sanitizeName(row.camera_model ?? '') || 'camera',
  };
}

/** 支持 {name} {date} {time} {year} {month} {day} {seq} {camera} 这几种占位符 */
function renderTemplate(template: string, tokens: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => tokens[key] ?? match);
}

const INVALID_TEMPLATE = /[<>:"/\\|?*]/;

export function validateTemplate(template: string): void {
  if (!template.trim()) throw new AppError('E_INVALID_ARG', '命名模板不能为空');
  if (INVALID_TEMPLATE.test(template)) {
    throw new AppError('E_INVALID_ARG', '模板里不能包含 \\ / : * ? " < > | 这些字符');
  }
  if (template.length > 80) throw new AppError('E_INVALID_ARG', '模板太长，建议控制在 80 字符内');
}

function loadRows(ids: number[]): any[] {
  if (!ids.length) return [];
  const db = getDb();
  const rows = db
    .prepare(`SELECT id, path, file_name, ext, taken_at, created_at, camera_model FROM photos
              WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as any[];
  // IN (...) 不保证顺序，但 {seq} 必须跟着调用方的顺序（= 界面上的排列顺序）
  const rank = new Map(ids.map((id, i) => [id, i]));
  return rows.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
}

/** 预览：只算名字，不改文件。冲突标记用于提示，真正改的时候会自动加后缀 */
export function previewRename(ids: number[], template: string): RenamePreview {
  validateTemplate(template);
  const rows = loadRows(ids);
  const padding = Math.max(3, String(rows.length).length);
  const used = new Set<string>();
  const rowsOut: RenamePreviewRow[] = rows.map((row, i) => {
    const base = sanitizeName(renderTemplate(template, tokensOf(row, i + 1, padding))) || `photo-${i + 1}`;
    const ext = row.ext || extname(row.file_name).replace(/^\./, '') || 'jpg';
    let name = `${base}.${ext}`;
    let n = 2;
    const dir = dirname(row.path);
    while (used.has(name.toLowerCase()) || (existsSync(join(dir, name)) && name !== row.file_name)) {
      name = `${base}-${n}.${ext}`;
      n++;
      if (n > 99) break;
    }
    used.add(name.toLowerCase());
    return {
      photoId: row.id,
      from: row.file_name,
      to: name,
      conflict: name !== `${base}.${ext}`,
    };
  });
  return { rows: rowsOut, total: rowsOut.length };
}

/**
 * 就地改名（同一个目录内），成功后同步数据库里的 path / file_name。
 * 只改文件名，不动内容，也不跨目录移动。
 */
export function renamePhotos(ids: number[], template: string): RenameResult {
  validateTemplate(template);
  const rows = loadRows(ids);
  if (!rows.length) return { renamed: 0, unchanged: 0, failed: 0, errors: [] };

  const db = getDb();
  const padding = Math.max(3, String(rows.length).length);
  const update = db.prepare('UPDATE photos SET path = ?, file_name = ?, updated_at = ? WHERE id = ?');

  let renamed = 0;
  let unchanged = 0;
  let failed = 0;
  const errors: string[] = [];

  db.transaction(() => {
    rows.forEach((row, i) => {
      try {
        const base = sanitizeName(renderTemplate(template, tokensOf(row, i + 1, padding))) || `photo-${i + 1}`;
        const ext = row.ext || extname(row.file_name).replace(/^\./, '') || 'jpg';
        const dir = dirname(row.path);
        let name = `${base}.${ext}`;
        let target = join(dir, name);

        // 同批次内与磁盘上已存在的文件都要避开
        let n = 2;
        while (existsSync(target) && target !== row.path && n <= 99) {
          name = `${base}-${n}.${ext}`;
          target = join(dir, name);
          n++;
        }
        if (target === row.path) {
          unchanged++;
          return; // 名字没变，不动文件
        }

        renameSync(row.path, target);
        update.run(target, name, Date.now(), row.id);
        renamed++;
      } catch (e) {
        failed++;
        errors.push(`${row.file_name}：${e instanceof Error ? e.message : String(e)}`);
      }
    });
  })();

  return { renamed, unchanged, failed, errors: errors.slice(0, 10) };
}

import type { Tag } from '@shared/ipc';
import { AppError } from '../errors';
import { getActiveLibraryId, getDb } from './index';
import { rowToTag } from './mappers';

/* eslint-disable @typescript-eslint/no-explicit-any */

const SELECT = `
  SELECT t.*, (SELECT COUNT(*) FROM photo_tags pt WHERE pt.tag_id = t.id) AS photo_count
  FROM tags t
`;

export function listTags(): Tag[] {
  const rows = getDb()
    .prepare(`${SELECT} WHERE t.library_id = ? ORDER BY IFNULL(t.parent_id, 0), t.name COLLATE NOCASE`)
    .all(getActiveLibraryId()) as any[];
  return rows.map(rowToTag);
}

export function getTagsForPhoto(photoId: number): Tag[] {
  const rows = getDb()
    .prepare(
      `${SELECT}
       JOIN photo_tags pt ON pt.tag_id = t.id
       WHERE pt.photo_id = ?
       ORDER BY t.name COLLATE NOCASE`
    )
    .all(photoId) as any[];
  return rows.map(rowToTag);
}

export function createTag(input: {
  name: string;
  parentId?: number | null;
  color?: string;
}): Tag {
  const db = getDb();
  const name = input.name?.trim();
  if (!name) throw new AppError('E_INVALID_ARG', '标签名不能为空');
  try {
    const r = db
      .prepare('INSERT INTO tags (library_id, name, parent_id, color, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(getActiveLibraryId(), name, input.parentId ?? null, input.color ?? null, Date.now());
    return getTag(Number(r.lastInsertRowid));
  } catch (e: any) {
    if (String(e?.message).includes('UNIQUE')) throw new AppError('E_INVALID_ARG', '同级下已有同名标签');
    throw e;
  }
}

export function getTag(id: number): Tag {
  const row = getDb().prepare(`${SELECT} WHERE t.id = ?`).get(id) as any;
  if (!row) throw new AppError('E_NOT_FOUND', '标签不存在');
  return rowToTag(row);
}

export function patchTag(id: number, patch: { name?: string; color?: string | null }): Tag {
  const sets: string[] = [];
  const params: any[] = [];
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new AppError('E_INVALID_ARG', '标签名不能为空');
    sets.push('name = ?');
    params.push(name);
  }
  if (patch.color !== undefined) {
    sets.push('color = ?');
    params.push(patch.color);
  }
  if (!sets.length) return getTag(id);
  params.push(id);
  try {
    getDb().prepare(`UPDATE tags SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  } catch (e: any) {
    if (String(e?.message).includes('UNIQUE')) throw new AppError('E_INVALID_ARG', '同级下已有同名标签');
    throw e;
  }
  return getTag(id);
}

export function removeTag(id: number): void {
  const r = getDb().prepare('DELETE FROM tags WHERE id = ?').run(id);
  if (r.changes === 0) throw new AppError('E_NOT_FOUND', '标签不存在');
}

export function attachTags(photoIds: number[], tagId: number): { attached: number } {
  if (!photoIds.length) return { attached: 0 };
  const db = getDb();
  const stmt = db.prepare('INSERT OR IGNORE INTO photo_tags (photo_id, tag_id) VALUES (?, ?)');
  let attached = 0;
  db.transaction(() => {
    for (const pid of photoIds) attached += stmt.run(pid, tagId).changes;
  })();
  return { attached };
}

export function detachTags(photoIds: number[], tagId: number): { detached: number } {
  if (!photoIds.length) return { detached: 0 };
  const db = getDb();
  const stmt = db.prepare('DELETE FROM photo_tags WHERE photo_id = ? AND tag_id = ?');
  let detached = 0;
  db.transaction(() => {
    for (const pid of photoIds) detached += stmt.run(pid, tagId).changes;
  })();
  return { detached };
}

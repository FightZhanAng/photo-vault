import type { Album, AlbumCreateInput, AlbumPatch, SmartRule } from '@shared/ipc';
import { AppError } from '../errors';
import { getActiveLibraryId, getDb } from './index';
import { rowToAlbum } from './mappers';
import { isEmptyRule } from './rule';

/* eslint-disable @typescript-eslint/no-explicit-any */

const SELECT = `
  SELECT a.*, (SELECT COUNT(*) FROM album_photos ap WHERE ap.album_id = a.id) AS photo_count
  FROM albums a
`;

function normalizeRule(rule: SmartRule | null | undefined): string {
  if (isEmptyRule(rule)) throw new AppError('E_INVALID_ARG', '智能相册至少要设一个条件');
  return JSON.stringify(rule);
}

export function listAlbums(): Album[] {
  const rows = getDb()
    .prepare(`${SELECT} WHERE a.library_id = ? ORDER BY a.sort_order ASC, a.id ASC`)
    .all(getActiveLibraryId()) as any[];
  return rows.map(rowToAlbum);
}

export function getAlbum(id: number): Album {
  const row = getDb().prepare(`${SELECT} WHERE a.id = ?`).get(id) as any;
  if (!row) throw new AppError('E_NOT_FOUND', '相册不存在');
  return rowToAlbum(row);
}

export function createAlbum(input: AlbumCreateInput): Album {
  const db = getDb();
  const libraryId = getActiveLibraryId();
  const name = input.name?.trim();
  if (!name) throw new AppError('E_INVALID_ARG', '相册名不能为空');

  const kind = input.kind === 'smart' ? 'smart' : 'manual';
  const ruleJson = kind === 'smart' ? normalizeRule(input.rule) : null;

  const now = Date.now();
  try {
    const r = db
      .prepare(
        `INSERT INTO albums (library_id, name, description, kind, rule_json, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?)`
      )
      .run(libraryId, name, input.description ?? null, kind, ruleJson, now, now);
    const id = Number(r.lastInsertRowid);
    if (kind === 'manual' && input.photoIds?.length) addPhotosToAlbum(id, input.photoIds);
    return getAlbum(id);
  } catch (e: any) {
    if (String(e?.message).includes('UNIQUE')) throw new AppError('E_INVALID_ARG', '已有同名相册');
    throw e;
  }
}

export function patchAlbum(id: number, patch: AlbumPatch): Album {
  const db = getDb();
  const sets: string[] = [];
  const params: any[] = [];
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new AppError('E_INVALID_ARG', '相册名不能为空');
    sets.push('name = ?');
    params.push(name);
  }
  if (patch.description !== undefined) {
    sets.push('description = ?');
    params.push(patch.description);
  }
  if (patch.coverPhotoId !== undefined) {
    sets.push('cover_photo_id = ?');
    params.push(patch.coverPhotoId);
  }
  if (patch.sortOrder !== undefined) {
    sets.push('sort_order = ?');
    params.push(patch.sortOrder);
  }
  if (patch.rule !== undefined) {
    sets.push("kind = 'smart'", 'rule_json = ?');
    params.push(normalizeRule(patch.rule));
  }
  if (!sets.length) return getAlbum(id);

  sets.push('updated_at = ?');
  params.push(Date.now(), id);
  try {
    db.prepare(`UPDATE albums SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  } catch (e: any) {
    if (String(e?.message).includes('UNIQUE')) throw new AppError('E_INVALID_ARG', '已有同名相册');
    throw e;
  }
  return getAlbum(id);
}

export function removeAlbum(id: number): void {
  const r = getDb().prepare('DELETE FROM albums WHERE id = ?').run(id);
  if (r.changes === 0) throw new AppError('E_NOT_FOUND', '相册不存在');
}

export function addPhotosToAlbum(albumId: number, photoIds: number[]): { added: number } {
  if (!photoIds.length) return { added: 0 };
  const db = getDb();
  const now = Date.now();
  const maxPos = (
    db.prepare('SELECT COALESCE(MAX(position), 0) AS m FROM album_photos WHERE album_id = ?').get(albumId) as {
      m: number;
    }
  ).m;

  const stmt = db.prepare(
    'INSERT OR IGNORE INTO album_photos (album_id, photo_id, position, added_at) VALUES (?, ?, ?, ?)'
  );
  let added = 0;
  db.transaction(() => {
    photoIds.forEach((pid, i) => {
      added += stmt.run(albumId, pid, maxPos + i + 1, now).changes;
    });
    // 没有封面时用第一张兜底
    db.prepare(
      'UPDATE albums SET cover_photo_id = COALESCE(cover_photo_id, ?), updated_at = ? WHERE id = ?'
    ).run(photoIds[0], now, albumId);
  })();
  return { added };
}

export function removePhotosFromAlbum(albumId: number, photoIds: number[]): { removed: number } {
  if (!photoIds.length) return { removed: 0 };
  const db = getDb();
  const stmt = db.prepare('DELETE FROM album_photos WHERE album_id = ? AND photo_id = ?');
  let removed = 0;
  db.transaction(() => {
    for (const pid of photoIds) removed += stmt.run(albumId, pid).changes;
  })();
  return { removed };
}

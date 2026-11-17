import { existsSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { AppError } from '../errors';
import type { LibraryCreateInput, LibraryInfo, LibraryMode } from '@shared/ipc';
import { closeDatabase, getDb, openDatabase, setActiveLibraryId } from './index';
import { rowToLibrary } from './mappers';

export const DB_FILE = 'vault.db';
export const VAULT_DIR = '.vault';

export function vaultPaths(rootPath: string) {
  const base = join(rootPath, VAULT_DIR);
  return {
    base,
    dbPath: join(base, DB_FILE),
    thumbsPath: join(base, 'thumbs'),
    trashPath: join(base, 'trash'),
  };
}

export function createLibrary(input: LibraryCreateInput): LibraryInfo {
  const rootPath = input.rootPath;
  if (!rootPath) throw new AppError('E_INVALID_ARG', '库目录不能为空');
  if (!existsSync(rootPath)) throw new AppError('E_IO', `目录不存在：${rootPath}`);

  const paths = vaultPaths(rootPath);
  if (existsSync(paths.dbPath)) {
    throw new AppError('E_INVALID_ARG', '这个目录里已经有一个媒体库了，直接打开它即可');
  }

  openDatabase(paths.dbPath);
  const now = Date.now();
  const mode: LibraryMode = input.mode ?? 'reference';
  const info = getDb()
    .prepare(
      `INSERT INTO libraries (name, root_path, db_path, thumbs_path, mode, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(input.name || basename(rootPath), rootPath, paths.dbPath, paths.thumbsPath, mode, now);

  const id = Number(info.lastInsertRowid);
  setActiveLibraryId(id);
  return readLibrary(id);
}

export function openLibrary(dbPath: string): LibraryInfo {
  if (!existsSync(dbPath)) throw new AppError('E_NOT_FOUND', `库文件不存在：${dbPath}`);
  openDatabase(dbPath);
  const row = getDb().prepare('SELECT * FROM libraries ORDER BY id LIMIT 1').get() as
    | { id: number }
    | undefined;
  if (!row) throw new AppError('E_INVALID_ARG', '这不是一个有效的媒体库文件');
  setActiveLibraryId(row.id);
  return readLibrary(row.id);
}

export function closeLibrary(): void {
  closeDatabase();
}

export function readLibrary(id?: number): LibraryInfo {
  const db = getDb();
  const target = id ?? (db.prepare('SELECT id FROM libraries ORDER BY id LIMIT 1').get() as { id: number } | undefined)?.id;
  if (!target) throw new AppError('E_NOT_FOUND', '媒体库为空');
  const row = db
    .prepare(
      `SELECT l.*,
        (SELECT COUNT(*) FROM photos p WHERE p.library_id = l.id) AS photo_count,
        (SELECT COUNT(*) FROM photos p WHERE p.library_id = l.id AND p.status = 'inbox') AS inbox_count,
        (SELECT COUNT(*) FROM photos p WHERE p.library_id = l.id AND p.status = 'kept') AS kept_count,
        (SELECT COALESCE(SUM(size), 0) FROM photos p WHERE p.library_id = l.id) AS total_bytes
       FROM libraries l WHERE l.id = ?`
    )
    .get(target) as Record<string, unknown> | undefined;
  if (!row) throw new AppError('E_NOT_FOUND', '媒体库不存在');
  return rowToLibrary(row);
}

export function currentLibrary(): LibraryInfo | null {
  const db = getDb();
  const row = db.prepare('SELECT id FROM libraries ORDER BY id LIMIT 1').get() as { id: number } | undefined;
  if (!row) return null;
  setActiveLibraryId(row.id);
  return readLibrary(row.id);
}

export function libraryStats(): { photoCount: number; inboxCount: number; totalBytes: number } {
  const db = getDb();
  const r = db
    .prepare(
      `SELECT COUNT(*) AS photo_count,
              SUM(CASE WHEN status = 'inbox' THEN 1 ELSE 0 END) AS inbox_count,
              COALESCE(SUM(size), 0) AS total_bytes
       FROM photos`
    )
    .get() as { photo_count: number; inbox_count: number | null; total_bytes: number };
  return {
    photoCount: r.photo_count,
    inboxCount: r.inbox_count ?? 0,
    totalBytes: r.total_bytes,
  };
}

/** 彻底删除一个库：关连接 + 删 .vault 目录（原图不动） */
export function destroyLibrary(rootPath: string): void {
  const paths = vaultPaths(rootPath);
  closeDatabase();
  if (existsSync(paths.base)) rmSync(paths.base, { recursive: true, force: true });
}

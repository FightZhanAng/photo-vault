import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import schemaSql from './schema.sql?raw';
import { AppError } from '../errors';
import { migrate } from './migrate';
import { openSqlite, type Db } from './sqlite';

let db: Db | null = null;
let activeLibraryId: number | null = null;

export function isOpen(): boolean {
  return db !== null;
}

export function openDatabase(dbPath: string): Db {
  closeDatabase();
  mkdirSync(dirname(dbPath), { recursive: true });
  const conn = openSqlite(dbPath);
  // journal_mode 是持久属性，其余是连接级，每次打开都要设
  conn.exec('PRAGMA journal_mode = WAL');
  conn.exec('PRAGMA foreign_keys = ON');
  conn.exec('PRAGMA synchronous = NORMAL');
  conn.exec('PRAGMA temp_store = MEMORY');
  conn.exec(schemaSql);
  migrate(conn);
  db = conn;
  return conn;
}

export function closeDatabase(): void {
  if (!db) return;
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    /* 关闭前的检查点失败不影响后续 */
  }
  try {
    db.close();
  } catch {
    /* ignore */
  }
  db = null;
  activeLibraryId = null;
}

export function getDb(): Db {
  if (!db) throw new AppError('E_NOT_INITIALIZED', '尚未打开媒体库');
  return db;
}

export function setActiveLibraryId(id: number): void {
  activeLibraryId = id;
}

export function getActiveLibraryId(): number {
  if (activeLibraryId === null) throw new AppError('E_NOT_INITIALIZED', '尚未打开媒体库');
  return activeLibraryId;
}

/** 事务包装，异常自动回滚 */
export function tx<T>(fn: () => T): T {
  return getDb().transaction(fn)();
}

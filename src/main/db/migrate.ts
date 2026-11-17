import { randomBytes } from 'node:crypto';
import type { Db } from './sqlite';

/**
 * 库结构版本迁移。
 *
 * schema.sql 里全是 IF NOT EXISTS，只能把「新库」建对；已有库要加字段得靠这里。
 * 每一步都要求可重复执行（幂等），因为用户可能中途强杀进程。
 */

export const SCHEMA_VERSION = 2;

/** 上传口令：10 位 hex，够短能放进二维码，10^12 组合在局域网里足够 */
export function newUploadToken(): string {
  return randomBytes(5).toString('hex');
}

function hasColumn(db: Db, table: string, column: string): boolean {
  const rows = db
    .prepare(`SELECT name FROM pragma_table_info(?)`)
    .all(table) as { name: string }[];
  return rows.some((r) => r.name === column);
}

const STEPS: { version: number; up: (db: Db) => void }[] = [
  {
    version: 2,
    up: (db) => {
      if (!hasColumn(db, 'collect_tasks', 'upload_token')) {
        db.exec('ALTER TABLE collect_tasks ADD COLUMN upload_token TEXT');
      }
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_token ON collect_tasks (upload_token)');

      // 老任务补一个口令，否则它们没有可用的上传地址
      const rows = db
        .prepare('SELECT id FROM collect_tasks WHERE upload_token IS NULL')
        .all() as { id: number }[];
      const upd = db.prepare('UPDATE collect_tasks SET upload_token = ? WHERE id = ?');
      for (const row of rows) upd.run(newUploadToken(), row.id);
    },
  },
];

export function migrate(db: Db): number {
  const row = db.prepare('SELECT version FROM schema_meta WHERE id = 1').get() as
    | { version: number }
    | undefined;
  let version = Number(row?.version ?? 1);

  for (const step of STEPS) {
    if (step.version <= version) continue;
    db.transaction(() => {
      step.up(db);
      db.prepare('UPDATE schema_meta SET version = ? WHERE id = 1').run(step.version);
    })();
    version = step.version;
  }
  return version;
}

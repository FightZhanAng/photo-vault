import type { CollectTask, TaskCreateInput, TaskPatch, UploaderStat } from '@shared/ipc';
import { AppError } from '../errors';
import { getActiveLibraryId, getDb } from './index';
import { rowToTask } from './mappers';
import { newUploadToken } from './migrate';

/* eslint-disable @typescript-eslint/no-explicit-any */

const SELECT = `
  SELECT t.*,
    (SELECT COUNT(*) FROM task_photos tp WHERE tp.task_id = t.id) AS photo_count,
    (SELECT COUNT(*) FROM task_photos tp JOIN photos p ON p.id = tp.photo_id
      WHERE tp.task_id = t.id AND p.status = 'kept') AS kept_count,
    (SELECT COUNT(*) FROM task_photos tp JOIN photos p ON p.id = tp.photo_id
      WHERE tp.task_id = t.id AND p.status = 'inbox') AS inbox_count
  FROM collect_tasks t
`;

export function listTasks(includeClosed = false): CollectTask[] {
  const rows = getDb()
    .prepare(
      `${SELECT} WHERE t.library_id = ? ${includeClosed ? '' : "AND t.state = 'open'"}
       ORDER BY t.state ASC, IFNULL(t.deadline_at, 9e15) ASC, t.id DESC`
    )
    .all(getActiveLibraryId()) as any[];
  return rows.map(rowToTask);
}

export function getTask(id: number): CollectTask {
  const row = getDb().prepare(`${SELECT} WHERE t.id = ?`).get(id) as any;
  if (!row) throw new AppError('E_NOT_FOUND', '收集任务不存在');
  return rowToTask(row);
}

export function createTask(input: TaskCreateInput): CollectTask {
  const name = input.name?.trim();
  if (!name) throw new AppError('E_INVALID_ARG', '任务名不能为空');
  const token = newUploadToken();
  const r = getDb()
    .prepare(
      `INSERT INTO collect_tasks
        (library_id, name, note, deadline_at, target_count, default_album_id, state, upload_token, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`
    )
    .run(
      getActiveLibraryId(),
      name,
      input.note ?? null,
      input.deadlineAt ?? null,
      input.targetCount ?? null,
      input.defaultAlbumId ?? null,
      token,
      Date.now()
    );
  return getTask(Number(r.lastInsertRowid));
}

const PATCHABLE = {
  name: 'name',
  note: 'note',
  deadlineAt: 'deadline_at',
  targetCount: 'target_count',
  defaultAlbumId: 'default_album_id',
} as const;

export function patchTask(id: number, patch: TaskPatch): CollectTask {
  const sets: string[] = [];
  const params: any[] = [];
  for (const [key, column] of Object.entries(PATCHABLE)) {
    const value = (patch as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (key === 'name' && typeof value === 'string' && !value.trim()) {
      throw new AppError('E_INVALID_ARG', '任务名不能为空');
    }
    sets.push(`${column} = ?`);
    params.push(value);
  }
  if (sets.length) {
    params.push(id);
    getDb().prepare(`UPDATE collect_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }
  return getTask(id);
}

export function closeTask(id: number): CollectTask {
  const r = getDb()
    .prepare("UPDATE collect_tasks SET state = 'closed', closed_at = ? WHERE id = ?")
    .run(Date.now(), id);
  if (r.changes === 0) throw new AppError('E_NOT_FOUND', '收集任务不存在');
  return getTask(id);
}

export function removeTask(id: number): void {
  const r = getDb().prepare('DELETE FROM collect_tasks WHERE id = ?').run(id);
  if (r.changes === 0) throw new AppError('E_NOT_FOUND', '收集任务不存在');
}

export function linkPhotosToTask(
  taskId: number,
  photoIds: number[],
  sourceLabel?: string | null,
  sourceDevice?: string | null
): { linked: number } {
  if (!photoIds.length) return { linked: 0 };
  const db = getDb();
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO task_photos (task_id, photo_id, source_label, source_device, added_at)
     VALUES (?, ?, ?, ?, ?)`
  );
  let linked = 0;
  db.transaction(() => {
    for (const pid of photoIds) linked += stmt.run(taskId, pid, sourceLabel ?? null, sourceDevice ?? null, now).changes;
  })();
  return { linked };
}

// ---------------------------------------------------------------------------
// 上传口令 / 上传者统计
// ---------------------------------------------------------------------------

export function getTaskToken(taskId: number): string {
  const row = getDb().prepare('SELECT upload_token FROM collect_tasks WHERE id = ?').get(taskId) as
    | { upload_token: string | null }
    | undefined;
  if (!row) throw new AppError('E_NOT_FOUND', '收集任务不存在');
  if (row.upload_token) return row.upload_token;

  const token = newUploadToken();
  getDb().prepare('UPDATE collect_tasks SET upload_token = ? WHERE id = ?').run(token, taskId);
  return token;
}

export function resetTaskToken(taskId: number): string {
  const token = newUploadToken();
  const r = getDb().prepare('UPDATE collect_tasks SET upload_token = ? WHERE id = ?').run(token, taskId);
  if (r.changes === 0) throw new AppError('E_NOT_FOUND', '收集任务不存在');
  return token;
}

export function getTaskByToken(token: string): CollectTask | null {
  if (!token || !/^[a-f0-9]{6,32}$/i.test(token)) return null;
  const row = getDb().prepare(`${SELECT} WHERE t.upload_token = ?`).get(token) as any;
  return row ? rowToTask(row) : null;
}

export function uploaderStats(taskId: number): UploaderStat[] {
  const rows = getDb()
    .prepare(
      `SELECT tp.source_label AS label,
              COUNT(*) AS c,
              COALESCE(SUM(CASE WHEN p.status = 'kept' THEN 1 ELSE 0 END), 0) AS kept,
              COALESCE(SUM(p.size), 0) AS bytes,
              MAX(tp.added_at) AS last_at
       FROM task_photos tp
       JOIN photos p ON p.id = tp.photo_id
       WHERE tp.task_id = ?
       GROUP BY tp.source_label
       ORDER BY c DESC`
    )
    .all(taskId) as { label: string | null; c: number; kept: number; bytes: number; last_at: number }[];
  return rows.map((r) => ({
    label: r.label,
    count: r.c,
    kept: r.kept,
    bytes: r.bytes,
    lastAt: r.last_at,
  }));
}

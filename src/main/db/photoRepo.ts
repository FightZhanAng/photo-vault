import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import type {
  DuplicateGroup,
  DuplicateItem,
  LibraryAnalysis,
  LocationCluster,
  Page,
  Photo,
  PhotoPatch,
  PhotoQuery,
  PhotoSort,
  PhotoStatus,
  SimilarPhoto,
  SmartRule,
  SizeBucket,
} from '@shared/ipc';
import { AppError } from '../errors';
import { IMAGE_EXTS, VIDEO_EXTS } from '@shared/media';
import { parseSearch, searchToRule } from '@shared/search';
import { getActiveLibraryId, getDb } from './index';
import { rowToLibrary, rowToPhoto } from './mappers';
import { vaultPaths } from './libraryRepo';
import { getAlbum } from './albumRepo';
import { parseRule } from './rule';
import { cacheStats } from '../media/cache';

/* eslint-disable @typescript-eslint/no-explicit-any */

const SORTS: Record<PhotoSort, { col: string; dir: 'ASC' | 'DESC'; field: keyof Photo }> = {
  taken_desc: { col: 'p.taken_at', dir: 'DESC', field: 'takenAt' },
  taken_asc: { col: 'p.taken_at', dir: 'ASC', field: 'takenAt' },
  added_desc: { col: 'p.created_at', dir: 'DESC', field: 'createdAt' },
  name_asc: { col: 'p.file_name', dir: 'ASC', field: 'fileName' },
  size_desc: { col: 'p.size', dir: 'DESC', field: 'size' },
};

function encodeCursor(value: unknown, id: number): string {
  return Buffer.from(JSON.stringify([value, id])).toString('base64url');
}

function decodeCursor(cursor: string): [unknown, number] {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return [parsed[0], Number(parsed[1])];
  } catch {
    throw new AppError('E_INVALID_ARG', '分页游标无效');
  }
}

/** 把一组筛选条件翻译成 SQL 片段；规则与用户筛选各自独立拼接，天然取交集 */
function filterClauses(q: SmartRule, params: any[]): string[] {
  const clauses: string[] = [];

  // 搜索串优先：解析成结构化条件后再统一走下面的分支，
  // 这样 tag:不存在的名字 会得到「没有结果」而不是「不筛选」。
  let src: SmartRule = q;
  if (q.q !== undefined) {
    const parsed = parseSearch(q.q);
    const fromSearch = searchToRule(parsed);
    src = { ...q, ...fromSearch, q: undefined };
    if (!fromSearch.keyword) src.keyword = undefined;
  }

  if (src.status?.length) {
    clauses.push(`p.status IN (${src.status.map(() => '?').join(',')})`);
    params.push(...src.status);
  }
  if (src.tagIds?.length) {
    if (src.tagMode === 'all') {
      for (const id of src.tagIds) {
        clauses.push('EXISTS (SELECT 1 FROM photo_tags pt WHERE pt.photo_id = p.id AND pt.tag_id = ?)');
        params.push(id);
      }
    } else {
      clauses.push(
        `EXISTS (SELECT 1 FROM photo_tags pt WHERE pt.photo_id = p.id AND pt.tag_id IN (${src.tagIds
          .map(() => '?')
          .join(',')}))`
      );
      params.push(...src.tagIds);
    }
  }
  if (src.tagNames?.length) {
    for (const name of src.tagNames) {
      clauses.push(
        `EXISTS (SELECT 1 FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id
                 WHERE pt.photo_id = p.id AND t.name = ?)`
      );
      params.push(name);
    }
  }
  if (typeof src.from === 'number') {
    clauses.push('p.taken_at >= ?');
    params.push(src.from);
  }
  if (typeof src.to === 'number') {
    clauses.push('p.taken_at <= ?');
    params.push(src.to);
  }
  if (src.ext?.length) {
    clauses.push(`p.ext IN (${src.ext.map(() => '?').join(',')})`);
    params.push(...src.ext.map((e) => e.toLowerCase()));
  }
  if (src.kind) {
    const list = src.kind === 'video' ? VIDEO_EXTS : IMAGE_EXTS;
    clauses.push(`p.ext IN (${list.map(() => '?').join(',')})`);
    params.push(...list);
  }
  if (src.minWidth) {
    clauses.push('p.width >= ?');
    params.push(src.minWidth);
  }
  if (src.minHeight) {
    clauses.push('p.height >= ?');
    params.push(src.minHeight);
  }
  if (src.hasGps === true) {
    clauses.push('p.gps_lat IS NOT NULL AND p.gps_lon IS NOT NULL');
  } else if (src.hasGps === false) {
    clauses.push('p.gps_lat IS NULL');
  }
  if (src.favoriteOnly) clauses.push('p.favorite = 1');
  if (typeof src.ratingMin === 'number') {
    clauses.push('p.rating >= ?');
    params.push(src.ratingMin);
  }
  if (typeof src.ratingMax === 'number') {
    clauses.push('p.rating <= ?');
    params.push(src.ratingMax);
  }
  if (typeof src.latMin === 'number') {
    clauses.push('p.gps_lat >= ?');
    params.push(src.latMin);
  }
  if (typeof src.latMax === 'number') {
    clauses.push('p.gps_lat <= ?');
    params.push(src.latMax);
  }
  if (typeof src.lonMin === 'number') {
    clauses.push('p.gps_lon >= ?');
    params.push(src.lonMin);
  }
  if (typeof src.lonMax === 'number') {
    clauses.push('p.gps_lon <= ?');
    params.push(src.lonMax);
  }
  if (src.camera?.trim()) {
    const cam = `%${src.camera.trim()}%`;
    clauses.push(`(IFNULL(p.camera_make, '') LIKE ? OR IFNULL(p.camera_model, '') LIKE ?)`);
    params.push(cam, cam);
  }
  if (src.keyword?.trim()) {
    const kw = `%${src.keyword.trim()}%`;
    clauses.push(
      `(p.file_name LIKE ? OR IFNULL(p.note, '') LIKE ? OR IFNULL(p.camera_model, '') LIKE ?
        OR EXISTS (SELECT 1 FROM photo_tags pt JOIN tags t ON t.id = pt.tag_id
                   WHERE pt.photo_id = p.id AND t.name LIKE ?))`
    );
    params.push(kw, kw, kw, kw);
  }

  return clauses;
}

function buildWhere(query: PhotoQuery, libraryId: number, rule: SmartRule | null): { sql: string; params: any[] } {
  const params: any[] = [libraryId];
  const clauses: string[] = ['p.library_id = ?'];

  if (rule) clauses.push(...filterClauses(rule, params));
  clauses.push(...filterClauses(query, params));

  if (query.albumId) {
    clauses.push('EXISTS (SELECT 1 FROM album_photos ap WHERE ap.photo_id = p.id AND ap.album_id = ?)');
    params.push(query.albumId);
  }
  if (query.taskId) {
    clauses.push('EXISTS (SELECT 1 FROM task_photos tp WHERE tp.photo_id = p.id AND tp.task_id = ?)');
    params.push(query.taskId);
  }

  return { sql: `WHERE ${clauses.join(' AND ')}`, params };
}

/** 智能相册的规则；手动相册或非法 id 返回 null */
function smartRuleOfAlbum(albumId: number): SmartRule | null {
  const album = getAlbum(albumId);
  return album.kind === 'smart' ? parseRule(album.ruleJson) : null;
}

export function listPhotos(query: PhotoQuery = {}): Page<Photo> {
  const db = getDb();
  const libraryId = getActiveLibraryId();
  const rule = query.albumId ? smartRuleOfAlbum(query.albumId) : null;
  // 智能相册不落在 album_photos 里，不能按 albumId 过滤
  const effective: PhotoQuery = rule ? { ...query, albumId: undefined } : query;
  const { sql: where, params } = buildWhere(effective, libraryId, rule);
  const sort = SORTS[query.sort ?? 'taken_desc'];
  const limit = Math.min(Math.max(query.limit ?? 120, 1), 500);

  const total = (db.prepare(`SELECT COUNT(*) AS c FROM photos p ${where}`).get(...params) as { c: number }).c;

  let cursorSql = '';
  const cursorParams: any[] = [];
  if (query.cursor) {
    const [value, id] = decodeCursor(query.cursor);
    const op = sort.dir === 'DESC' ? '<' : '>';
    cursorSql = ` AND (${sort.col} ${op} ? OR (${sort.col} = ? AND p.id ${op} ?))`;
    cursorParams.push(value, value, id);
  }

  const rows = db
    .prepare(
      `SELECT p.* FROM photos p ${where}${cursorSql}
       ORDER BY ${sort.col} ${sort.dir}, p.id ${sort.dir}
       LIMIT ?`
    )
    .all(...params, ...cursorParams, limit + 1) as any[];

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const items = pageRows.map(rowToPhoto);
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last[sort.field], last.id) : null;

  return { items, nextCursor, total };
}

/** 智能相册的封面/计数用：只数，不取数据 */
export function countByRule(rule: SmartRule | null): number {
  if (!rule) return 0;
  const db = getDb();
  const params: any[] = [getActiveLibraryId()];
  const clauses = ['p.library_id = ?', ...filterClauses(rule, params)];
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM photos p WHERE ${clauses.join(' AND ')}`)
    .get(...params) as { c: number };
  return row.c;
}

export function getPhoto(id: number): Photo {
  const row = getDb().prepare('SELECT * FROM photos WHERE id = ?').get(id) as any;
  if (!row) throw new AppError('E_NOT_FOUND', '照片不存在');
  return rowToPhoto(row);
}

const PATCHABLE = {
  rating: 'rating',
  favorite: 'favorite',
  note: 'note',
  takenAt: 'taken_at',
  gpsLat: 'gps_lat',
  gpsLon: 'gps_lon',
} as const;

export function patchPhoto(id: number, patch: PhotoPatch): Photo {
  const db = getDb();
  const sets: string[] = [];
  const params: any[] = [];

  for (const [key, column] of Object.entries(PATCHABLE)) {
    const value = (patch as Record<string, unknown>)[key];
    if (value === undefined) continue;
    sets.push(`${column} = ?`);
    params.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
  }
  if (!sets.length) return getPhoto(id);

  sets.push('updated_at = ?');
  params.push(Date.now(), id);

  const result = db.prepare(`UPDATE photos SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  if (result.changes === 0) throw new AppError('E_NOT_FOUND', '照片不存在');
  return getPhoto(id);
}

export function setPhotoStatus(ids: number[], status: PhotoStatus): { updated: number } {
  if (!ids.length) return { updated: 0 };
  const db = getDb();
  const now = Date.now();
  const stmt = db.prepare('UPDATE photos SET status = ?, updated_at = ? WHERE id = ?');
  const run = db.transaction((list: number[]) => {
    let n = 0;
    for (const id of list) n += stmt.run(status, now, id).changes;
    return n;
  });
  return { updated: run(ids) };
}

export function removePhotos(ids: number[], opts?: { deleteFile?: boolean }): { removed: number } {
  if (!ids.length) return { removed: 0 };
  const db = getDb();
  const lib = db.prepare('SELECT * FROM libraries ORDER BY id LIMIT 1').get() as any;
  const paths = lib ? vaultPaths(lib.root_path) : null;

  const getPath = db.prepare('SELECT path, rel_path, file_name FROM photos WHERE id = ?');
  const del = db.prepare('DELETE FROM photos WHERE id = ?');

  let removed = 0;
  const run = db.transaction((list: number[]) => {
    for (const id of list) {
      const row = getPath.get(id) as any;
      if (!row) continue;
      // 只有在 managed 模式下、且文件确实在库里，才动文件
      if (opts?.deleteFile && lib?.mode === 'managed' && paths && row.rel_path) {
        try {
          if (existsSync(row.path)) {
            const dest = join(paths.trashPath, `${Date.now()}-${row.file_name}`);
            mkdirSync(paths.trashPath, { recursive: true });
            renameSync(row.path, dest);
          }
        } catch {
          /* 移动失败不阻断记录删除 */
        }
      }
      removed += del.run(id).changes;
    }
  });
  run(ids);
  return { removed };
}

export function restorePhotos(ids: number[]): { restored: number } {
  return { restored: setPhotoStatus(ids, 'kept').updated };
}

export function checkMissing(ids?: number[]): { checked: number; missing: number } {
  const db = getDb();
  const rows = (
    ids?.length
      ? db.prepare(`SELECT id, path FROM photos WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)
      : db.prepare('SELECT id, path FROM photos').all()
  ) as { id: number; path: string }[];

  const mark = db.prepare('UPDATE photos SET missing = ?, updated_at = ? WHERE id = ?');
  let missing = 0;
  const now = Date.now();
  const run = db.transaction(() => {
    for (const row of rows) {
      const gone = !existsSync(row.path);
      if (gone) missing++;
      mark.run(gone ? 1 : 0, now, row.id);
    }
  });
  run();
  return { checked: rows.length, missing };
}

/** dHash 汉明距离 */
export function hammingDistance(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (x) {
    x &= x - 1n;
    count++;
  }
  return count;
}

export function findSimilar(id: number, maxDistance = 6): SimilarPhoto[] {
  const db = getDb();
  const libraryId = getActiveLibraryId();
  const target = db.prepare('SELECT hash_phash FROM photos WHERE id = ?').get(id) as
    | { hash_phash: string | null }
    | undefined;
  if (!target?.hash_phash) return [];

  const rows = db
    .prepare(
      `SELECT id, hash_phash, file_name, taken_at FROM photos
       WHERE library_id = ? AND id <> ? AND hash_phash IS NOT NULL`
    )
    .all(libraryId, id) as { id: number; hash_phash: string; file_name: string; taken_at: number }[];

  return rows
    .map((r) => ({ r, distance: hammingDistance(target.hash_phash as string, r.hash_phash) }))
    .filter((x) => x.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 30)
    .map(({ r, distance }) => ({
      photoId: r.id,
      distance,
      thumbUrl: `vault://thumb/${r.id}`,
      fileName: r.file_name,
      takenAt: r.taken_at ?? null,
    }));
}

/**
 * 相似照片聚类（查重用）。
 *
 * 朴素做法是两两比较，1 万张就是 5000 万次 BigInt 异或，太慢。这里用鸽巢原理剪枝：
 * 把 64 位哈希切成 8 段 8 位，汉明距离 ≤ 7 的两张图，必然至少有一段完全相同。
 * 于是只比较「落在同一段同一个桶里」的候选对，候选量通常只有总数的百分之几。
 */
export function duplicateGroups(maxDistance = 6): DuplicateGroup[] {
  const db = getDb();
  const libraryId = getActiveLibraryId();
  const max = Math.max(0, Math.min(7, Math.round(maxDistance)));

  const rows = db
    .prepare(
      `SELECT id, file_name, size, width, height, taken_at, status, hash_phash, created_at
       FROM photos
       WHERE library_id = ? AND hash_phash IS NOT NULL AND status <> 'rejected'`
    )
    .all(libraryId) as {
    id: number;
    file_name: string;
    size: number;
    width: number | null;
    height: number | null;
    taken_at: number | null;
    status: PhotoStatus;
    hash_phash: string;
    created_at: number;
  }[];

  const n = rows.length;
  if (n < 2) return [];

  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;

  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    while (parent[i] !== root) {
      const next = parent[i];
      parent[i] = root;
      i = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  const hashes: bigint[] = rows.map((r) => BigInt(`0x${r.hash_phash}`));
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const h = hashes[i];
    for (let c = 0; c < 8; c++) {
      const shift = BigInt(64 - (c + 1) * 8);
      const key = `${c}:${((h >> shift) & 0xffn).toString(16)}`;
      const list = buckets.get(key);
      if (list) list.push(i);
      else buckets.set(key, [i]);
    }
  }

  const compared = new Set<number>();
  for (const list of buckets.values()) {
    if (list.length < 2) continue;
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const i = list[a];
        const j = list[b];
        const key = i < j ? i * n + j : j * n + i;
        if (compared.has(key)) continue;
        compared.add(key);
        let x = hashes[i] ^ hashes[j];
        let dist = 0;
        while (x) {
          x &= x - 1n;
          dist++;
          if (dist > max) break;
        }
        if (dist <= max) union(i, j);
      }
    }
  }

  const grouped = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const list = grouped.get(root);
    if (list) list.push(i);
    else grouped.set(root, [i]);
  }

  const groups: DuplicateGroup[] = [];
  for (const indexes of grouped.values()) {
    if (indexes.length < 2) continue;

    // 建议保留：像素最多 → 体积最大 → 入库最早
    const ranked = [...indexes].sort((a, b) => {
      const ra = rows[a];
      const rb = rows[b];
      const pa = (ra.width ?? 0) * (ra.height ?? 0);
      const pb = (rb.width ?? 0) * (rb.height ?? 0);
      if (pa !== pb) return pb - pa;
      if (ra.size !== rb.size) return rb.size - ra.size;
      return ra.created_at - rb.created_at;
    });

    const rep = rows[ranked[0]];
    const repHash = rep.hash_phash;
    let distance = 0;
    const items: DuplicateItem[] = ranked.slice(0, 40).map((index) => {
      const r = rows[index];
      if (r.id !== rep.id) distance = Math.max(distance, hammingDistance(repHash, r.hash_phash));
      return {
        photoId: r.id,
        fileName: r.file_name,
        size: r.size,
        width: r.width,
        height: r.height,
        takenAt: r.taken_at,
        status: r.status,
        thumbUrl: `vault://thumb/${r.id}`,
        previewUrl: `vault://preview/${r.id}`,
      };
    });

    groups.push({ key: `g${rep.id}`, distance, items });
  }

  groups.sort((a, b) => b.items.length - a.items.length || a.distance - b.distance);
  return groups.slice(0, 200);
}

export function libraryAnalysis(): LibraryAnalysis {
  const db = getDb();
  const libraryId = getActiveLibraryId();
  const lib = db.prepare('SELECT * FROM libraries ORDER BY id LIMIT 1').get() as any;

  const statusRows = db
    .prepare(
      `SELECT status, COUNT(*) AS c, COALESCE(SUM(size), 0) AS b
       FROM photos WHERE library_id = ? GROUP BY status`
    )
    .all(libraryId) as { status: PhotoStatus; c: number; b: number }[];

  const yearRows = db
    .prepare(
      `SELECT COALESCE(strftime('%Y', taken_at / 1000, 'unixepoch', 'localtime'), '未知') AS label,
              COUNT(*) AS c, COALESCE(SUM(size), 0) AS b
       FROM photos WHERE library_id = ?
       GROUP BY label ORDER BY label DESC`
    )
    .all(libraryId) as { label: string; c: number; b: number }[];

  const extRows = db
    .prepare(
      `SELECT ext, COUNT(*) AS c, COALESCE(SUM(size), 0) AS b
       FROM photos WHERE library_id = ? GROUP BY ext ORDER BY b DESC`
    )
    .all(libraryId) as { ext: string; c: number; b: number }[];

  const largest = db
    .prepare(
      `SELECT id, file_name, size, width, height FROM photos
       WHERE library_id = ? ORDER BY size DESC LIMIT 8`
    )
    .all(libraryId) as { id: number; file_name: string; size: number; width: number | null; height: number | null }[];

  const extra = db
    .prepare(
      `SELECT
        COALESCE(SUM(CASE WHEN missing = 1 THEN 1 ELSE 0 END), 0) AS missing,
        COALESCE(SUM(CASE WHEN gps_lat IS NOT NULL THEN 1 ELSE 0 END), 0) AS gps,
        COALESCE(SUM(CASE WHEN favorite = 1 THEN 1 ELSE 0 END), 0) AS fav,
        COALESCE(SUM(CASE WHEN camera_model IS NOT NULL THEN 1 ELSE 0 END), 0) AS cam,
        MIN(taken_at) AS first_at, MAX(taken_at) AS last_at
       FROM photos WHERE library_id = ?`
    )
    .get(libraryId) as any;

  const byStatus = (['inbox', 'kept', 'rejected', 'archived'] as PhotoStatus[]).map((status) => {
    const row = statusRows.find((r) => r.status === status);
    return { status, count: row?.c ?? 0, bytes: row?.b ?? 0 };
  });

  const toBuckets = (rows: { label: string; c: number; b: number }[]): SizeBucket[] =>
    rows.map((r) => ({ label: r.label, count: r.c, bytes: r.b }));
  const cache = lib ? cacheStats(lib.thumbs_path) : { files: 0, bytes: 0 };

  return {
    totalPhotos: byStatus.reduce((sum, s) => sum + s.count, 0),
    totalBytes: byStatus.reduce((sum, s) => sum + s.bytes, 0),
    byStatus,
    byYear: toBuckets(yearRows),
    byExt: extRows.map((r) => ({ label: `.${r.ext}`, count: r.c, bytes: r.b })),
    largest: largest.map((r) => ({
      photoId: r.id,
      fileName: r.file_name,
      size: r.size,
      width: r.width,
      height: r.height,
      thumbUrl: `vault://thumb/${r.id}`,
    })),
    missing: extra?.missing ?? 0,
    gpsCount: extra?.gps ?? 0,
    favoriteCount: extra?.fav ?? 0,
    cameraCount: extra?.cam ?? 0,
    takenFrom: extra?.first_at ?? null,
    takenTo: extra?.last_at ?? null,
    thumbCount: cache.files,
    thumbBytes: cache.bytes,
  };
}

export function libraryOfCurrent(): ReturnType<typeof rowToLibrary> | null {
  const row = getDb().prepare('SELECT * FROM libraries ORDER BY id LIMIT 1').get() as any;
  return row ? rowToLibrary(row) : null;
}

/**
 * 按 GPS 网格聚合出「地点」。
 *
 * 不接地图服务、不做逆地理编码，所以这里给的是坐标而不是地名 —— 好处是零依赖、离线可用，
 * 也不会因为第三方服务不可用就让地点视图整个瘫掉。网格边长默认 0.05°（约 5.5km），
 * 一个格子算一个地方；被淘汰的照片不计入，避免废弃图把地点撑大。
 */
export function locations(precision = 0.05): LocationCluster[] {
  const step = Math.min(1, Math.max(0.001, Number.isFinite(precision) ? precision : 0.05));
  const rows = getDb()
    .prepare(
      `SELECT id, gps_lat, gps_lon, taken_at FROM photos
       WHERE library_id = ? AND gps_lat IS NOT NULL AND gps_lon IS NOT NULL
         AND status <> 'rejected'`
    )
    .all(getActiveLibraryId()) as {
    id: number;
    gps_lat: number;
    gps_lon: number;
    taken_at: number | null;
  }[];

  const cells = new Map<string, LocationCluster>();
  for (const r of rows) {
    const i = Math.floor(r.gps_lat / step);
    const j = Math.floor(r.gps_lon / step);
    const key = `${i}:${j}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = {
        key,
        lat: (i + 0.5) * step,
        lon: (j + 0.5) * step,
        latMin: i * step,
        latMax: (i + 1) * step,
        lonMin: j * step,
        lonMax: (j + 1) * step,
        count: 0,
        from: null,
        to: null,
        coverPhotoId: r.id,
        coverThumbUrl: `vault://thumb/${r.id}`,
      };
      cells.set(key, cell);
    }
    cell.count += 1;
    if (r.taken_at !== null) {
      if (cell.from === null || r.taken_at < cell.from) cell.from = r.taken_at;
      if (cell.to === null || r.taken_at > cell.to) cell.to = r.taken_at;
    }
  }

  return [...cells.values()]
    .map((c) => ({
      ...c,
      // 坐标留到 4 位小数，界面上直接显示不会太长
      lat: Math.round(c.lat * 10000) / 10000,
      lon: Math.round(c.lon * 10000) / 10000,
    }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

export function fileBaseName(p: string): string {
  return basename(p);
}

export function deleteOrphanThumbs(thumbsPath: string, id: number): void {
  for (const size of [320, 1600]) {
    const shard = String(id % 256).padStart(3, '0');
    const file = join(thumbsPath, shard, `${id}-${size}.webp`);
    try {
      if (existsSync(file)) rmSync(file);
    } catch {
      /* ignore */
    }
  }
}

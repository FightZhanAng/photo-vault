/**
 * 重新读取照片的 EXIF 元数据。
 *
 * 元数据只在导入/上传那一刻解析一次。如果解析逻辑后来修好了（比如
 * 之前 pick 白名单把 GPS 整块跳过了），已经入库的照片不会自己变 ——
 * 这个模块负责按原文件补一遍，把时间、机型、镜头、经纬度重新写回库里。
 *
 * 只补空位：用 COALESCE 写，原值有内容时不会被 null 冲掉。这样用户
 * 手动改过的时间、参数，以及文件已经不在了的记录都安全。
 */
import type { RefreshMetaResult } from '@shared/ipc';
import { getDb } from '../db';
import { readExif } from './pipeline';

interface Row {
  id: number;
  path: string;
  missing: number;
}

export async function refreshPhotoMeta(ids?: number[]): Promise<RefreshMetaResult> {
  const db = getDb();
  const rows = (
    ids && ids.length
      ? db
          .prepare(
            `SELECT id, path, missing FROM photos WHERE id IN (${ids.map(() => '?').join(',')})`
          )
          .all(...ids)
      : db.prepare('SELECT id, path, missing FROM photos ORDER BY id').all()
  ) as unknown as Row[];

  const stmt = db.prepare(`
    UPDATE photos SET
      taken_at = COALESCE(?, taken_at),
      camera_make = COALESCE(?, camera_make),
      camera_model = COALESCE(?, camera_model),
      lens_model = COALESCE(?, lens_model),
      gps_lat = COALESCE(?, gps_lat),
      gps_lon = COALESCE(?, gps_lon),
      updated_at = ?
    WHERE id = ?
  `);

  let scanned = 0;
  let located = 0;
  let failed = 0;
  let missing = 0;

  for (const row of rows) {
    if (row.missing) {
      missing++;
      continue;
    }
    try {
      const exif = await readExif(row.path);
      const date = exif.DateTimeOriginal ?? exif.CreateDate;
      const takenAt = date instanceof Date && !Number.isNaN(date.getTime()) ? date.getTime() : null;
      const lat = typeof exif.latitude === 'number' ? exif.latitude : null;
      const lon = typeof exif.longitude === 'number' ? exif.longitude : null;

      stmt.run(
        takenAt,
        exif.Make ?? null,
        exif.Model ?? null,
        exif.LensModel ?? null,
        lat,
        lon,
        Date.now(),
        row.id
      );
      scanned++;
      if (lat !== null && lon !== null) located++;
    } catch {
      failed++;
    }
    // 大库时不至于把主进程卡住；小库这样切也没多少开销
    if (rows.length > 50) await new Promise((r) => setImmediate(r));
  }

  return { scanned, located, failed, missing };
}

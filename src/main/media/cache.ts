import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface CacheStats {
  files: number;
  bytes: number;
}

/** 缩略图缓存目录的占用；目录不存在时返回 0，不要抛错 */
export function cacheStats(dir: string): CacheStats {
  if (!dir || !existsSync(dir)) return { files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  try {
    const entries = readdirSync(dir, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      try {
        const s = statSync(join(entry.parentPath, entry.name));
        files++;
        bytes += s.size;
      } catch {
        /* 并发删除时可能刚好消失 */
      }
    }
  } catch {
    return { files, bytes };
  }
  return { files, bytes };
}

/**
 * 清空缩略图缓存。只删 <库>/.vault/thumbs 下的文件，不动目录本身，
 * 也不碰原图 —— 删掉的缩略图会在下次查看时自动重建。
 */
export function clearCache(dir: string): CacheStats {
  if (!dir || !existsSync(dir)) return { files: 0, bytes: 0 };
  const before = cacheStats(dir);
  try {
    const entries = readdirSync(dir, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      try {
        rmSync(join(entry.parentPath, entry.name), { force: true });
      } catch {
        /* 被占用的文件跳过 */
      }
    }
  } catch {
    /* ignore */
  }
  return before;
}

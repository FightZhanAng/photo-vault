import { readdir, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { IMAGE_EXTS, VIDEO_EXTS, mediaKind, normalizeExt } from '@shared/media';

export const IMAGE_EXT = new Set<string>(IMAGE_EXTS);
export const VIDEO_EXT = new Set<string>(VIDEO_EXTS);

const SKIP_DIRS = new Set([
  '.vault', '.git', '.thumbnails', 'node_modules',
  '$recycle.bin', 'system volume information', '@eadir', '.trash',
]);

export interface ScannedFile {
  path: string;
  fileName: string;
  ext: string;
  size: number;
  mtime: number;
  kind: 'image' | 'video';
}

export interface ScanSummary {
  files: ScannedFile[];
  unsupported: number;
  totalBytes: number;
}

export function fileKind(ext: string): 'image' | 'video' | null {
  return mediaKind(ext);
}

/** 按路径判断是不是视频（协议层与导出层要用，只有路径没有 ext 字段的场合） */
export function isVideoFile(filePath: string): boolean {
  return mediaKind(normalizeExt(extname(filePath))) === 'video';
}

/** 递归收集可导入的文件；不支持的类型只计数，不返回 */
export async function scanFolder(
  root: string,
  recursive: boolean,
  signal?: { cancelled: boolean },
  onTick?: (found: number) => void
): Promise<ScanSummary> {
  const files: ScannedFile[] = [];
  let unsupported = 0;
  let totalBytes = 0;

  async function walk(dir: string): Promise<void> {
    if (signal?.cancelled) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // 无权限的目录直接跳过
    }
    for (const entry of entries) {
      if (signal?.cancelled) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!recursive) continue;
        if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = extname(entry.name).replace(/^\./, '').toLowerCase();
      const kind = fileKind(ext);
      if (!kind) {
        unsupported++;
        continue;
      }
      try {
        const s = await stat(full);
        if (s.size === 0) continue;
        files.push({ path: full, fileName: entry.name, ext, size: s.size, mtime: s.mtimeMs, kind });
        totalBytes += s.size;
        if (onTick && files.length % 200 === 0) onTick(files.length);
      } catch {
        unsupported++;
      }
    }
  }

  await walk(root);
  return { files, unsupported, totalBytes };
}

/**
 * 扫描一批显式路径（拖拽导入用）。
 * 与 scanFolder 的区别：这里的每一项本身可能是文件，也可能是目录；
 * 同一个文件被拖两次（或者拖了目录又拖了目录里的文件）只算一次。
 */
export async function scanPaths(
  paths: string[],
  recursive: boolean,
  signal?: { cancelled: boolean },
  onTick?: (found: number) => void
): Promise<ScanSummary> {
  const seen = new Set<string>();
  const files: ScannedFile[] = [];
  let unsupported = 0;
  let totalBytes = 0;

  const absorb = (sub: ScanSummary): void => {
    for (const f of sub.files) {
      const key = f.path.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      files.push(f);
      totalBytes += f.size;
    }
    unsupported += sub.unsupported;
    if (onTick) onTick(files.length);
  };

  for (const p of paths) {
    if (signal?.cancelled) break;
    let s;
    try {
      s = await stat(p);
    } catch {
      unsupported++;
      continue;
    }

    if (s.isDirectory()) {
      absorb(await scanFolder(p, recursive, signal, onTick));
      continue;
    }
    if (!s.isFile()) {
      unsupported++;
      continue;
    }

    const name = basename(p);
    const ok = mediaKind(normalizeExt(extname(name)));
    if (!ok || s.size === 0) {
      unsupported++;
      continue;
    }
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    files.push({
      path: p,
      fileName: name,
      ext: normalizeExt(extname(name)),
      size: s.size,
      mtime: s.mtimeMs,
      kind: ok,
    });
    totalBytes += s.size;
    if (onTick) onTick(files.length);
  }

  return { files, unsupported, totalBytes };
}

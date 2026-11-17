import { app } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 更新检查。
 *
 * 没有引入 electron-updater：那套要配好发布源（GitHub Releases / 私有服务器）才跑得动，
 * 否则装上去也只是个永远返回「无更新」的黑盒。这里改成读一份显式的 update.json：
 *
 *   { "version": "0.2.0", "url": "https://…/PhotoVault-0.2.0-setup.exe", "notes": "…" }
 *
 * 放在安装目录的 resources/update.json，或随包放在 resources/ 下。
 * 没配置就老实说没配置，不假装检查过。
 */
export interface UpdateCheckResult {
  current: string;
  configured: boolean;
  latest: string | null;
  url: string | null;
  notes: string | null;
  available: boolean;
}

function candidateFeeds(): string[] {
  const list: string[] = [];
  const env = process.env.PHOTOVAULT_UPDATE_FEED;
  if (env) list.push(env);
  // 打包后：<安装目录>/resources/update.json
  if (process.resourcesPath) list.push(join(process.resourcesPath, 'update.json'));
  // 开发时：<项目根>/resources/update.json
  list.push(join(app.getAppPath(), 'resources', 'update.json'));
  return list;
}

/** 0.10.0 > 0.9.9 这类按段比较，避免字典序把 10 判成小于 9 */
function compareVersion(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

export function checkUpdate(): UpdateCheckResult {
  const current = app.getVersion();

  for (const file of candidateFeeds()) {
    if (!existsSync(file)) continue;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as {
        version?: unknown;
        url?: unknown;
        notes?: unknown;
      };
      const latest = typeof raw.version === 'string' ? raw.version : null;
      if (!latest) continue;
      return {
        current,
        configured: true,
        latest,
        url: typeof raw.url === 'string' ? raw.url : null,
        notes: typeof raw.notes === 'string' ? raw.notes : null,
        available: compareVersion(latest, current) > 0,
      };
    } catch {
      // 文件坏了就当没配置，不要把用户卡在错误里
    }
  }

  return { current, configured: false, latest: null, url: null, notes: null, available: false };
}

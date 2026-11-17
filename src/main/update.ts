import { app, net } from 'electron';
import { existsSync, readFileSync } from 'node:fs';

/**
 * 更新检查：默认读 GitHub Releases。
 *
 * 为什么不用 electron-updater：
 * 那套要做「下载 → 校验 → 静默替换 → 重启」，Windows 上还要配签名，
 * 一旦某个环节出错，用户看到的就是装不上的黑盒。这里只做「告诉你有没有新版 +
 * 给你下载页」，安装交给用户自己点，出问题也看得见。
 *
 * 数据来源优先级：
 * 1. PHOTOVAULT_UPDATE_FEED 指向的本地 json —— 给内网 / 镜像留的口子；
 * 2. GitHub Releases（api.github.com/repos/<repo>/releases/latest）。
 *
 * 走 net.fetch 而不是全局 fetch：前者是 Chromium 的网络栈，会继承系统代理。
 * 国内直连 api.github.com 未必通，用户挂在 Clash 这类代理后面时，只有这条路径能查。
 */

/** 默认仓库；fork 或换了仓库名可以用 PHOTOVAULT_UPDATE_REPO 覆盖 */
const DEFAULT_REPO = 'FightZhanAng/photo-vault';
const TIMEOUT_MS = 8000;

export interface UpdateCheckResult {
  current: string;
  /** 本次结果来自哪儿：github / 本地 json / 没配 */
  source: 'github' | 'file' | 'none';
  /** 有更新源就是 true；旧字段名沿用，渲染层不用改语义 */
  configured: boolean;
  latest: string | null;
  /** 安装包直链，点了就开始下载 */
  url: string | null;
  /** 发布页，给「看更新说明」用 */
  pageUrl: string | null;
  notes: string | null;
  publishedAt: string | null;
  available: boolean;
  /** 网络或接口出错时的原因；成功后为 null */
  error: string | null;
}

interface GhAsset {
  name?: unknown;
  browser_download_url?: unknown;
}

interface GhRelease {
  tag_name?: unknown;
  body?: unknown;
  html_url?: unknown;
  published_at?: unknown;
  assets?: unknown;
}

function emptyResult(current: string, source: UpdateCheckResult['source']): UpdateCheckResult {
  return {
    current,
    source,
    configured: source !== 'none',
    latest: null,
    url: null,
    pageUrl: null,
    notes: null,
    publishedAt: null,
    available: false,
    error: null,
  };
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

/** tag 上的 v0.2.0 / 0.2.0 都认 */
function normalizeVersion(raw: string): string {
  return raw.trim().replace(/^v/i, '');
}

function pickAsset(assets: unknown): string | null {
  if (!Array.isArray(assets)) return null;
  const list = assets as GhAsset[];
  const urls = list
    .map((a) => ({
      name: typeof a?.name === 'string' ? a.name : '',
      url: typeof a?.browser_download_url === 'string' ? a.browser_download_url : '',
    }))
    .filter((a) => a.url);

  // 优先认自己打包时定的名字：PhotoVault-<version>-setup.exe
  const installer = urls.find((a) => /^PhotoVault-.*-setup\.exe$/i.test(a.name));
  if (installer) return installer.url;
  const exe = urls.find((a) => /\.exe$/i.test(a.name));
  return exe?.url ?? null;
}

/** 读 PHOTOVAULT_UPDATE_FEED 指向的 update.json（自建源 / 内网镜像） */
function checkLocalFeed(current: string, file: string): UpdateCheckResult {
  const result = emptyResult(current, 'file');
  if (!existsSync(file)) {
    return { ...result, error: `更新源文件不存在：${file}` };
  }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as {
      version?: unknown;
      url?: unknown;
      notes?: unknown;
      pageUrl?: unknown;
    };
    const latest = typeof raw.version === 'string' ? normalizeVersion(raw.version) : null;
    if (!latest) return { ...result, error: '更新源文件里没有 version 字段' };
    return {
      ...result,
      latest,
      url: typeof raw.url === 'string' ? raw.url : null,
      pageUrl: typeof raw.pageUrl === 'string' ? raw.pageUrl : null,
      notes: typeof raw.notes === 'string' ? raw.notes : null,
      available: compareVersion(latest, current) > 0,
    };
  } catch (e) {
    return { ...result, error: `更新源文件解析失败：${(e as Error).message}` };
  }
}

async function checkGitHub(current: string): Promise<UpdateCheckResult> {
  const repo = (process.env.PHOTOVAULT_UPDATE_REPO || DEFAULT_REPO).replace(/^\/+|\/+$/g, '');
  const result = emptyResult(current, 'github');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await net.fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        // GitHub API 强制要求 UA，不带会被 403
        'user-agent': `PhotoVault/${current}`,
      },
      signal: controller.signal,
    });

    // 404：仓库还没发过正式版，这不是错误
    if (res.status === 404) return result;
    if (res.status === 403 || res.status === 429) {
      return { ...result, error: 'GitHub 接口被限流了，过一会儿再试' };
    }
    if (!res.ok) return { ...result, error: `GitHub 返回 ${res.status}` };

    const release = (await res.json()) as GhRelease;
    const tag = typeof release.tag_name === 'string' ? release.tag_name : '';
    const latest = tag ? normalizeVersion(tag) : null;
    if (!latest) return { ...result, error: '发布信息里没有 tag' };

    return {
      ...result,
      latest,
      url: pickAsset(release.assets),
      pageUrl: typeof release.html_url === 'string' ? release.html_url : null,
      notes: typeof release.body === 'string' ? release.body : null,
      publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
      available: compareVersion(latest, current) > 0,
    };
  } catch (e) {
    const aborted = (e as Error).name === 'AbortError' || controller.signal.aborted;
    return {
      ...result,
      error: aborted
        ? `连接 GitHub 超时（${TIMEOUT_MS / 1000} 秒）`
        : '连不上 GitHub，检查网络或代理设置',
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkUpdate(): Promise<UpdateCheckResult> {
  const current = app.getVersion();
  const feed = process.env.PHOTOVAULT_UPDATE_FEED;
  if (feed) return checkLocalFeed(current, feed);
  return checkGitHub(current);
}

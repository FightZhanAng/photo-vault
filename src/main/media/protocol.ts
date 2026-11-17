import { net, protocol } from 'electron';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { getPhoto } from '../db/photoRepo';
import { getDb } from '../db';
import { isVideoFile } from './scan';
import { generateThumb, thumbFile, type ThumbSize } from './thumbnails';

/**
 * 自定义协议 vault://thumb|preview|original/<id>
 *
 * 两个容易踩的点：
 * 1. 必须开 corsEnabled 并回 ACAO —— 渲染层要拿 <video> 截首帧画到 canvas，
 *    跨源（页面是 file://，资源是 vault://）不带 CORS 头的话 canvas 会被污染，
 *    toDataURL 直接抛 SecurityError。
 * 2. 原图/视频必须支持 Range —— 否则 <video> 不能拖动进度，大文件也会被整份读进内存。
 */

const VIDEO_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv',
  '3gp': 'video/3gpp',
};

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'content-range, content-length, accept-ranges',
};

/** 必须在 app ready 之前调用 */
export function registerVaultScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'vault',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
        bypassCSP: false,
      },
    },
  ]);
}

/** 懒生成去重：同一张图并发请求 1600 预览时只解码一次 */
const pending = new Map<string, Promise<string>>();

function thumbsDir(): string {
  const row = getDb().prepare('SELECT thumbs_path FROM libraries ORDER BY id LIMIT 1').get() as
    | { thumbs_path: string }
    | undefined;
  return row?.thumbs_path ?? '';
}

/** 给 net.fetch 出来的响应补上 CORS 头，其余原样透传 */
async function withCors(res: Response): Promise<Response> {
  if (res.status >= 300) return res;
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/** 原图/视频：手写 Range 支持，视频才能拖进度条 */
function serveFile(filePath: string, rangeHeader: string | null): Response {
  const size = statSync(filePath).size;
  const ext = extname(filePath).replace(/^\./, '').toLowerCase();
  const headers: Record<string, string> = {
    ...CORS,
    'accept-ranges': 'bytes',
    'content-type': VIDEO_MIME[ext] ?? 'application/octet-stream',
    'cache-control': 'no-cache',
  };

  const m = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null;
  if (m && (m[1] || m[2])) {
    let start: number;
    let end: number;
    if (!m[1]) {
      // bytes=-500 → 最后 500 字节
      start = Math.max(0, size - Number(m[2]));
      end = size - 1;
    } else {
      start = Number(m[1]);
      end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    }
    if (start >= size || start > end) {
      return new Response(null, {
        status: 416,
        headers: { ...headers, 'content-range': `bytes */${size}` },
      });
    }
    const body = Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream;
    return new Response(body, {
      status: 206,
      headers: {
        ...headers,
        'content-length': String(end - start + 1),
        'content-range': `bytes ${start}-${end}/${size}`,
      },
    });
  }

  const body = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
  return new Response(body, { status: 200, headers: { ...headers, 'content-length': String(size) } });
}

export function handleVaultProtocol(): void {
  protocol.handle('vault', async (request) => {
    try {
      // fetch() 带 Range 这类自定义头会先发预检，这里直接放行
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            ...CORS,
            'access-control-allow-methods': 'GET, HEAD, OPTIONS',
            'access-control-allow-headers': 'Range, If-None-Match, If-Modified-Since',
            'access-control-max-age': '600',
          },
        });
      }

      const url = new URL(request.url);
      const kind = url.hostname; // thumb | preview | original
      const id = Number(url.pathname.replace(/^\/+/, ''));
      if (!Number.isInteger(id) || id <= 0) return new Response('bad id', { status: 400 });

      const photo = getPhoto(id);

      if (kind === 'original') {
        if (!existsSync(photo.path)) return new Response('missing', { status: 404 });
        // 视频走手写流：要 Range + CORS；图片直接交给 Chromium 的文件加载器更快
        if (isVideoFile(photo.path)) {
          return serveFile(photo.path, request.headers.get('Range'));
        }
        return withCors(await net.fetch(pathToFileURL(photo.path).toString()));
      }

      const size: ThumbSize = kind === 'preview' ? 1600 : 320;
      const dir = thumbsDir();
      if (!dir) return new Response('no library', { status: 409 });

      const file = thumbFile(dir, id, size);
      if (existsSync(file)) return withCors(await net.fetch(pathToFileURL(file).toString()));
      if (!existsSync(photo.path)) return new Response('missing', { status: 404 });

      // 视频没有走 sharp 的解码路径：首帧由渲染层的 <video> 截出来再回写。
      // 这里直接 404，让界面显示占位并触发首帧生成，而不是抛 500。
      if (isVideoFile(photo.path)) return new Response('poster-pending', { status: 404 });

      const key = `${id}:${size}`;
      let job = pending.get(key);
      if (!job) {
        job = generateThumb(photo.path, dir, id, size).finally(() => pending.delete(key));
        pending.set(key, job);
      }
      const produced = await job;
      return withCors(await net.fetch(pathToFileURL(produced).toString()));
    } catch {
      return new Response('error', { status: 500 });
    }
  });
}

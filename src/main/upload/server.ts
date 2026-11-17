import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import QRCode from 'qrcode';
import type {
  TaskUploadInfo,
  UploadReceivedEvent,
  UploadServerStatus,
} from '@shared/ipc';
import { AppError } from '../errors';
import { getDb, isOpen } from '../db';
import { vaultPaths } from '../db/libraryRepo';
import { getTask, getTaskByToken, getTaskToken, resetTaskToken, uploaderStats } from '../db/taskRepo';
import { ingestUpload } from './ingest';
import pageHtml from './page.html?raw';

/* eslint-disable @typescript-eslint/no-explicit-any */

const DEFAULT_PORT = 8787;
const PORT_TRIES = 12;
const MAX_FILE_BYTES = 400 * 1024 * 1024;
const SESSION_TTL = 3 * 24 * 3600 * 1000;

interface Session {
  id: string;
  taskId: number;
  name: string;
  size: number;
  lastModified: number;
  uploader: string | null;
  device: string | null;
  createdAt: number;
}

let server: Server | null = null;
let port: number | null = null;
let startedAt: number | null = null;
let lastError: string | null = null;
let received = 0;
let skipped = 0;
let emitter: ((e: UploadReceivedEvent) => void) | null = null;

const sessions = new Map<string, Session>();

export function setUploadEmitter(fn: ((e: UploadReceivedEvent) => void) | null): void {
  emitter = fn;
}

// ---------------------------------------------------------------------------
// 目录 / 会话
// ---------------------------------------------------------------------------

function uploadsDir(): string {
  const row = getDb().prepare('SELECT root_path FROM libraries ORDER BY id LIMIT 1').get() as
    | { root_path: string }
    | undefined;
  if (!row) throw new AppError('E_NOT_INITIALIZED', '媒体库未初始化');
  return join(vaultPaths(row.root_path).base, 'uploads');
}

function partPath(id: string): string {
  return join(uploadsDir(), `${id}.part`);
}

function metaPath(id: string): string {
  return join(uploadsDir(), `${id}.json`);
}

function loadSessions(): void {
  sessions.clear();
  const dir = uploadsDir();
  mkdirSync(dir, { recursive: true });
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = join(dir, name);
    try {
      const meta = JSON.parse(readFileSync(file, 'utf8')) as Session;
      if (!meta?.id || !meta.taskId || now - (meta.createdAt ?? 0) > SESSION_TTL) {
        rmSync(file, { force: true });
        rmSync(partPath(name.replace(/\.json$/, '')), { force: true });
        continue;
      }
      sessions.set(meta.id, meta);
    } catch {
      rmSync(file, { force: true });
    }
  }
}

function persist(session: Session): void {
  writeFileSync(metaPath(session.id), JSON.stringify(session), 'utf8');
}

function dropSession(id: string): void {
  sessions.delete(id);
  rmSync(metaPath(id), { force: true });
  rmSync(partPath(id), { force: true });
}

// ---------------------------------------------------------------------------
// HTTP 小工具
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(text);
}

function sendText(res: ServerResponse, code: number, text: string, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 1024 * 1024) throw new AppError('E_INVALID_ARG', '请求体过大');
    chunks.push(buf);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AppError('E_INVALID_ARG', '请求体不是合法 JSON');
  }
}

function deviceOf(req: IncomingMessage): string {
  const ua = String(req.headers['user-agent'] ?? '');
  if (/iphone|ipad|ios/i.test(ua)) return 'iOS 设备';
  if (/android/i.test(ua)) return 'Android 设备';
  return ua.slice(0, 60) || '浏览器';
}

/** 追加写入分片，返回已接收字节数；offset 不连续时抛 409 让客户端对齐 */
async function appendChunk(
  req: IncomingMessage,
  file: string,
  offset: number,
  limit: number
): Promise<number> {
  const current = existsSync(file) ? statSync(file).size : 0;
  if (offset !== current) {
    const err = new AppError('E_INVALID_ARG', '分片偏移不连续');
    (err as any).offset = current;
    throw err;
  }

  const stream = createWriteStream(file, { flags: 'a' });
  let written = current;
  try {
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      written += buf.length;
      if (written > limit) throw new AppError('E_INVALID_ARG', '文件超过大小上限');
      if (!stream.write(buf)) await once(stream, 'drain');
    }
    await new Promise<void>((resolve, reject) => {
      stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
    });
  } catch (e) {
    stream.destroy();
    throw e;
  }
  return written;
}

// ---------------------------------------------------------------------------
// 业务
// ---------------------------------------------------------------------------

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const info of list ?? []) {
      if (info.family === 'IPv4' && !info.internal) out.push(info.address);
    }
  }
  const rank = (ip: string): number => {
    if (ip.startsWith('192.168.')) return 0;
    if (ip.startsWith('10.')) return 1;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
    return 3;
  };
  return out.sort((a, b) => rank(a) - rank(b));
}

export function uploadServerStatus(): UploadServerStatus {
  return {
    running: server !== null && port !== null,
    port,
    urls: port ? lanAddresses().map((ip) => `http://${ip}:${port}`) : [],
    startedAt,
    lastError,
    received,
    skipped,
  };
}

function listen(p: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = createServer((req, res) => {
      void handle(req, res).catch((e) => {
        const message = e instanceof Error ? e.message : String(e);
        try {
          sendJson(res, 500, { error: message });
        } catch {
          /* 响应已发出 */
        }
      });
    });
    const onError = (e: Error): void => {
      s.close();
      reject(e);
    };
    s.once('error', onError);
    s.listen(p, '0.0.0.0', () => {
      s.off('error', onError);
      s.on('error', (e) => {
        lastError = e.message;
      });
      resolve(s);
    });
  });
}

export async function startUploadServer(preferred = DEFAULT_PORT): Promise<UploadServerStatus> {
  if (!isOpen()) throw new AppError('E_NOT_INITIALIZED', '请先打开媒体库');
  if (server) return uploadServerStatus();

  loadSessions();
  lastError = null;
  const start = Math.min(Math.max(preferred || DEFAULT_PORT, 1024), 65000);

  for (let i = 0; i < PORT_TRIES; i++) {
    const p = start + i;
    try {
      server = await listen(p);
      port = p;
      startedAt = Date.now();
      received = 0;
      skipped = 0;
      return uploadServerStatus();
    } catch (e: any) {
      lastError = e?.code === 'EADDRINUSE' ? `端口 ${p} 已被占用` : String(e?.message ?? e);
      server = null;
      port = null;
    }
  }
  throw new AppError('E_IO', lastError ?? '没有可用端口');
}

export async function stopUploadServer(): Promise<UploadServerStatus> {
  if (server) {
    const s = server;
    server = null;
    port = null;
    startedAt = null;
    s.closeAllConnections?.();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  return uploadServerStatus();
}

export async function taskUploadInfo(taskId: number): Promise<TaskUploadInfo> {
  if (!isOpen()) throw new AppError('E_NOT_INITIALIZED', '请先打开媒体库');
  const task = getTask(taskId);
  const token = getTaskToken(taskId);
  const status = uploadServerStatus();
  const urls = status.running ? status.urls.map((u) => `${u}/u/${token}`) : [];

  let qrDataUrl: string | null = null;
  if (urls.length) {
    try {
      qrDataUrl = await QRCode.toDataURL(urls[0], {
        margin: 1,
        width: 420,
        errorCorrectionLevel: 'M',
        color: { dark: '#1e1c19', light: '#ffffff' },
      });
    } catch {
      qrDataUrl = null;
    }
  }

  return { task, token, urls, qrDataUrl, uploaders: uploaderStats(taskId) };
}

export async function resetUploadToken(taskId: number): Promise<TaskUploadInfo> {
  resetTaskToken(taskId);
  return taskUploadInfo(taskId);
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;

  if (req.method === 'GET' && path === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && path.startsWith('/u/')) {
    sendText(res, 200, pageHtml, 'text/html; charset=utf-8');
    return;
  }

  if (req.method === 'GET' && path === '/api/info') {
    const task = getTaskByToken(url.searchParams.get('t') ?? '');
    if (!task) {
      sendJson(res, 404, { error: '链接无效' });
      return;
    }
    sendJson(res, 200, {
      name: task.name,
      note: task.note,
      targetCount: task.targetCount,
      deadlineAt: task.deadlineAt,
      received: task.photoCount,
      state: task.state,
    });
    return;
  }

  if (req.method === 'POST' && path === '/api/init') {
    const body = await readJson(req);
    const task = getTaskByToken(String(body.token ?? ''));
    if (!task) {
      sendJson(res, 404, { error: '链接无效' });
      return;
    }
    if (task.state !== 'open') {
      sendJson(res, 403, { error: '这次收集已经结束了' });
      return;
    }

    const name = String(body.name ?? '').slice(0, 200) || `photo-${Date.now()}.jpg`;
    const size = Number(body.size);
    if (!Number.isFinite(size) || size <= 0) {
      sendJson(res, 400, { error: '文件大小无效' });
      return;
    }
    if (size > MAX_FILE_BYTES) {
      sendJson(res, 413, { error: '单张照片超过 400MB，无法接收' });
      return;
    }

    const lastModified = Number(body.lastModified) || 0;
    const uploader = String(body.uploader ?? '').trim().slice(0, 24) || null;
    const id = createHash('sha1')
      .update(`${body.token}|${name}|${size}|${lastModified}`)
      .digest('hex')
      .slice(0, 16);

    let session = sessions.get(id);
    if (!session) {
      session = {
        id,
        taskId: task.id,
        name,
        size,
        lastModified,
        uploader,
        device: deviceOf(req),
        createdAt: Date.now(),
      };
      sessions.set(id, session);
      persist(session);
      const file = partPath(id);
      if (existsSync(file)) rmSync(file, { force: true });
    } else if (uploader) {
      session.uploader = uploader;
      persist(session);
    }

    const offset = existsSync(partPath(id)) ? statSync(partPath(id)).size : 0;
    sendJson(res, 200, { uploadId: id, offset });
    return;
  }

  if (req.method === 'PUT' && path === '/api/chunk') {
    const id = url.searchParams.get('uploadId') ?? '';
    if (!/^[a-f0-9]{16}$/.test(id)) {
      sendJson(res, 400, { error: '上传会话无效' });
      return;
    }
    const session = sessions.get(id);
    if (!session) {
      sendJson(res, 410, { error: '上传会话已过期，请重新选择这张照片' });
      return;
    }
    const offset = Number(url.searchParams.get('offset') ?? 0);
    try {
      const total = await appendChunk(req, partPath(id), offset, session.size);
      sendJson(res, 200, { received: total });
    } catch (e: any) {
      if (typeof e?.offset === 'number') {
        sendJson(res, 409, { error: '偏移不一致', offset: e.offset });
        return;
      }
      throw e;
    }
    return;
  }

  if (req.method === 'POST' && path === '/api/complete') {
    const body = await readJson(req);
    const id = String(body.uploadId ?? '');
    const session = sessions.get(id);
    if (!session) {
      sendJson(res, 410, { error: '上传会话已过期' });
      return;
    }
    const file = partPath(id);
    if (!existsSync(file)) {
      sendJson(res, 410, { error: '临时文件不见了，请重新上传' });
      return;
    }
    const actual = statSync(file).size;
    if (actual !== session.size) {
      sendJson(res, 400, { error: `文件不完整（${actual}/${session.size} 字节）` });
      return;
    }

    try {
      const result = await ingestUpload({
        partPath: file,
        fileName: session.name,
        taskId: session.taskId,
        uploader: session.uploader,
        device: session.device,
      });
      dropSession(id);
      if (result.deduped) skipped++;
      else received++;
      emitter?.({
        taskId: session.taskId,
        photoId: result.photoId,
        fileName: session.name,
        deduped: result.deduped,
        uploader: session.uploader,
        at: Date.now(),
      });
      sendJson(res, 200, result);
    } catch (e) {
      sendJson(res, 500, { error: e instanceof Error ? e.message : '接收失败' });
    }
    return;
  }

  if (req.method === 'GET' && path === '/') {
    sendText(
      res,
      200,
      '相册收集站 · 请使用任务里给出的上传链接（形如 /u/xxxxxx）',
      'text/plain; charset=utf-8'
    );
    return;
  }

  sendJson(res, 404, { error: 'Not Found' });
}

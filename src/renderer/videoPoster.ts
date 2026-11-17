import { useEffect, useState } from 'react';
import type { Photo } from '@shared/ipc';
import { api } from './api';
import { isVideoExt } from './format';

/**
 * 视频首帧生成队列。
 *
 * 主进程没有视频解码器（不想为了首帧塞一个 ffmpeg 进来），所以截帧交给渲染层的 <video>：
 * 网格里某个视频的缩略图 404 时，把它排进队列，串行解出一帧交给主进程落盘。
 * 串行是有意的 —— 同时解 4 个 4K 视频会把内存和 IO 打满，而首帧只需要生成一次。
 */

const MAX_SIDE = 1600;
const TIMEOUT_MS = 20000;
/** 同一张最多重试 2 次，避免坏文件每次滚动都重来一遍 */
const MAX_ATTEMPTS = 2;

interface Frame {
  dataUrl: string;
  width: number;
  height: number;
  durationMs: number;
}

const queue: Photo[] = [];
const queued = new Set<number>();
const settled = new Set<number>();
const attempts = new Map<number, number>();
/** 首帧截取时读到的规格，回传给界面先显示，不用等列表重新拉一遍 */
export interface PosterInfo {
  durationMs: number;
  width: number;
  height: number;
}

const listeners = new Set<(photoId: number, info: PosterInfo | null) => void>();

let running = false;

/** 某张视频的首帧生成结束（成功带 info，放弃传 null）后通知界面；返回取消订阅函数 */
export function onPosterReady(cb: (photoId: number, info: PosterInfo | null) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function requestPoster(photo: Photo): void {
  if (!isVideoExt(photo.ext)) return;
  if (settled.has(photo.id) || queued.has(photo.id)) return;
  if ((attempts.get(photo.id) ?? 0) >= MAX_ATTEMPTS) return;
  queued.add(photo.id);
  queue.push(photo);
  void pump();
}

/**
 * 订阅某张视频的时长。列表里的 duration_ms 是入库时的快照，
 * 首帧刚生成完时还是旧值，这里用刚截到的时长先顶上。
 */
export function usePosterDuration(photoId: number, fallback: number | null): number | null {
  const [duration, setDuration] = useState<number | null>(null);
  useEffect(() => {
    return onPosterReady((id, info) => {
      if (id === photoId && info) setDuration(info.durationMs);
    });
  }, [photoId]);
  return duration ?? fallback;
}

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const photo = queue.shift();
      if (!photo) break;
      await generate(photo);
    }
  } finally {
    running = false;
  }
}

async function generate(photo: Photo): Promise<void> {
  let info: PosterInfo | null = null;
  try {
    const frame = await captureFrame(photo.originalUrl);
    if (frame) {
      const r = await api.photo.savePoster({
        photoId: photo.id,
        dataUrl: frame.dataUrl,
        width: frame.width,
        height: frame.height,
        durationMs: frame.durationMs,
      });
      if (r.ok) {
        info = { durationMs: frame.durationMs, width: frame.width, height: frame.height };
      }
    }
  } catch {
    // 解码不了（HEVC/AV1 之类）就放弃这一张，界面会显示「首帧不可用」
  } finally {
    attempts.set(photo.id, (attempts.get(photo.id) ?? 0) + 1);
    queued.delete(photo.id);
    if (info) {
      settled.add(photo.id);
      for (const cb of listeners) cb(photo.id, info);
    } else if ((attempts.get(photo.id) ?? 0) >= MAX_ATTEMPTS) {
      // 试满次数才告诉界面放弃，避免第一次偶发失败就把格子标成不可用
      for (const cb of listeners) cb(photo.id, null);
    }
  }
}

function captureFrame(src: string): Promise<Frame | null> {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    let done = false;

    const finish = (r: Frame | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      v.onseeked = null;
      v.onloadedmetadata = null;
      v.onerror = null;
      try {
        v.removeAttribute('src');
        v.load();
      } catch {
        /* 元素马上被丢掉，失败无所谓 */
      }
      resolve(r);
    };

    const timer = setTimeout(() => finish(null), TIMEOUT_MS);

    v.preload = 'metadata';
    v.muted = true;
    v.playsInline = true;
    // 协议层回了 ACAO，这里带 crossOrigin 才能把帧画进 canvas 而不污染
    v.crossOrigin = 'anonymous';
    v.onerror = () => finish(null);

    v.onloadedmetadata = () => {
      const duration = Number.isFinite(v.duration) ? Math.round(v.duration * 1000) : 0;
      // 第一帧常常是黑场，取 10% 处（短片退回 0.1s）更代表内容
      const seekTo = duration > 2000 ? Math.min(3, (duration / 1000) * 0.1) : 0.1;

      const grab = (): void => {
        try {
          const vw = v.videoWidth;
          const vh = v.videoHeight;
          if (!vw || !vh) return finish(null);
          const scale = Math.min(1, MAX_SIDE / Math.max(vw, vh));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(vw * scale));
          canvas.height = Math.max(1, Math.round(vh * scale));
          const ctx = canvas.getContext('2d');
          if (!ctx) return finish(null);
          ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
          finish({
            dataUrl: canvas.toDataURL('image/webp', 0.82),
            width: vw,
            height: vh,
            durationMs: duration,
          });
        } catch {
          // canvas 被污染或解码失败
          finish(null);
        }
      };

      v.onseeked = grab;
      try {
        v.currentTime = seekTo;
      } catch {
        grab();
      }
    };

    v.src = src;
  });
}

/**
 * 媒体类型的单一事实来源。
 *
 * 主进程的扫描、协议层、导出，以及渲染层的网格/播放器都判断「这是不是视频」，
 * 早先各自维护过一份列表，改一处漏两处。这里收口。
 */

export const IMAGE_EXTS = [
  'jpg',
  'jpeg',
  'png',
  'webp',
  'gif',
  'bmp',
  'tif',
  'tiff',
  'heic',
  'heif',
  'avif',
  'jxl',
] as const;

export const VIDEO_EXTS = ['mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', '3gp', 'wmv'] as const;

const IMAGE_SET = new Set<string>(IMAGE_EXTS);
const VIDEO_SET = new Set<string>(VIDEO_EXTS);

/** 传入带不带点都行，大小写不敏感 */
export function normalizeExt(ext: string): string {
  return ext.replace(/^\./, '').toLowerCase();
}

export function isVideoExt(ext: string): boolean {
  return VIDEO_SET.has(normalizeExt(ext));
}

export function isImageExt(ext: string): boolean {
  return IMAGE_SET.has(normalizeExt(ext));
}

/** 按扩展名判断媒体类型；不认识返回 null */
export function mediaKind(ext: string): 'image' | 'video' | null {
  const e = normalizeExt(ext);
  if (IMAGE_SET.has(e)) return 'image';
  if (VIDEO_SET.has(e)) return 'video';
  return null;
}

export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(digits)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(bytes >= 100 * 1024 ** 2 ? 0 : digits)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** 视频扩展名判定，渲染层多处要用（网格、大图、幻灯片）；列表在 shared 层统一维护 */
export { isVideoExt } from '@shared/media';

/** 时长：61s → 1:01，3725s → 1:02:05 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function formatDate(ts: number | null): string {
  if (!ts) return '未知';
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function formatDateTime(ts: number | null): string {
  if (!ts) return '未知';
  const d = new Date(ts);
  return `${formatDate(ts)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** datetime-local 需要 YYYY-MM-DDTHH:mm 这种本地时间字符串 */
export function toDatetimeLocal(ts: number | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}`;
}

export function fromDatetimeLocal(value: string): number | null {
  if (!value) return null;
  const ts = new Date(value).getTime();
  return Number.isNaN(ts) ? null : ts;
}

export function daysLeft(ts: number | null): string {
  if (!ts) return '没有截止时间';
  const diff = ts - Date.now();
  if (diff <= 0) return '已过期';
  const days = Math.floor(diff / 86400000);
  if (days >= 1) return `还剩 ${days} 天`;
  const hours = Math.floor(diff / 3600000);
  if (hours >= 1) return `还剩 ${hours} 小时`;
  return `还剩 ${Math.max(1, Math.floor(diff / 60000))} 分钟`;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const el = document.createElement('textarea');
      el.value = text;
      el.style.position = 'fixed';
      el.style.opacity = '0';
      document.body.appendChild(el);
      el.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(el);
      return ok;
    } catch {
      return false;
    }
  }
}

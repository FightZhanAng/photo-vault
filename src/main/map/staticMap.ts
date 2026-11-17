import { net } from 'electron';
import type { MapImageRequest, MapImageResult } from '@shared/ipc';
import { AppError } from '../errors';
import { getAllSettings } from '../db/settingsRepo';

/**
 * 「地点」页的底图，走腾讯位置服务的静态图接口。
 *
 * 为什么不用 JavaScript API GL：
 * 1. 它的 SDK 明确拒绝在 file:// 下运行，而打包后的应用正是 file 协议；
 * 2. 那套 SDK 要在渲染进程里带着 Key 跑，Key 等于暴露在页面上。
 *
 * 放在主进程取图之后，Key 只留在数据库和主进程内存里，渲染层拿到的是一张
 * data URL；顺带也不受渲染层 CSP 限制，离线时直接失败并退回本地散点图。
 */
const ENDPOINT =
  process.env.PHOTOVAULT_MAP_ENDPOINT?.trim() || 'https://apis.map.qq.com/ws/staticmap/v2/';
const TIMEOUT = 15000;
/** 官方限制：宽 50–1680、高 50–1200，超了直接不返回图片 */
const MAX_W = 1680;
const MAX_H = 1200;
const MIN_SIDE = 50;
/** 一次最多画这么多点，再多图上也糊成一片，而且 URL 会长到离谱 */
const MAX_POINTS = 60;

/** 归一化墨卡托 Y（0 = 北，1 = 南），用来算「这些点需要多大视野」 */
function mercY(lat: number): number {
  const s = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

function fit(
  points: { lat: number; lon: number }[],
  width: number,
  height: number
): { lat: number; lon: number; zoom: number } {
  let north = -90;
  let south = 90;
  let east = -180;
  let west = 180;
  for (const p of points) {
    north = Math.max(north, p.lat);
    south = Math.min(south, p.lat);
    east = Math.max(east, p.lon);
    west = Math.min(west, p.lon);
  }
  const center = { lat: (north + south) / 2, lon: (west + east) / 2 };
  // 只有一个点（或者点都挤在一起）时给个下限，否则会算出无穷大
  const lonSpan = Math.max(east - west, 0.002);
  const mercSpan = Math.max(Math.abs(mercY(south) - mercY(north)), 0.002 / 360);
  const pad = 0.82;
  const zx = Math.log2((width * pad) / (256 * (lonSpan / 360)));
  const zy = Math.log2((height * pad) / (256 * mercSpan));
  return { ...center, zoom: Math.max(3, Math.min(17, Math.floor(Math.min(zx, zy)))) };
}

function keyOf(): string {
  const key = (getAllSettings()['map.key'] ?? '').trim();
  if (!key) throw new AppError('E_INVALID_ARG', '还没填腾讯地图 Key');
  return key;
}

export async function mapImage(req: MapImageRequest): Promise<MapImageResult> {
  const key = keyOf();
  const points = req.points.slice(0, MAX_POINTS);
  if (!points.length) throw new AppError('E_INVALID_ARG', '没有可显示的地点');

  const width = Math.min(Math.max(Math.round(req.width) || 640, MIN_SIDE), MAX_W);
  const height = Math.min(Math.max(Math.round(req.height) || 320, MIN_SIDE), MAX_H);

  const base = fit(points, width, height);
  const zoom = Math.max(3, Math.min(17, base.zoom + (req.zoomDelta || 0)));

  const coords = (list: typeof points): string =>
    list.map((p) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`).join('|');
  const others = points.filter((p) => p.key !== req.selected);
  const chosen = points.filter((p) => p.key === req.selected);

  // markers 的格式是 `风格|坐标|坐标…`，点之间用竖线分隔；
  // 颜色只能从 black/brown/green/purple/yellow/blue/gray/orange/red/white
  // 这十个里选，写十六进制会被判参数错误。尺寸有 large/mid/small/tiny 四档。
  const query: string[] = [
    `center=${base.lat.toFixed(6)},${base.lon.toFixed(6)}`,
    `zoom=${zoom}`,
    `size=${width}*${height}`,
    'maptype=roadmap',
  ];
  if (others.length) {
    query.push(`markers=size:small|color:red|${coords(others)}`);
  }
  if (chosen.length) {
    query.push(`markers=size:large|color:red|${coords(chosen)}`);
  }
  query.push(`key=${encodeURIComponent(key)}`);

  const url = `${ENDPOINT}?${query.join('&')}`;
  let res: Response;
  try {
    res = await net.fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
  } catch (e) {
    throw new AppError(
      'E_IO',
      `取底图失败：${e instanceof Error ? e.message : '网络不通'}（检查能不能访问 apis.map.qq.com）`
    );
  }

  const type = res.headers.get('content-type') ?? '';
  if (type.startsWith('image/')) {
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      dataUrl: `data:${type};base64,${buf.toString('base64')}`,
      zoom,
      center: { lat: base.lat, lon: base.lon },
    };
  }

  // 出错时接口照样回 200，只是 body 变成 JSON：{"status":190,"message":"无效的key"}
  const text = await res.text();
  let message = text.slice(0, 200);
  try {
    const json = JSON.parse(text) as { message?: string; status?: number };
    if (json.message) message = json.message;
  } catch {
    /* 不是 JSON 就原样带回去 */
  }
  throw new AppError('E_IO', `腾讯地图返回：${message}`);
}

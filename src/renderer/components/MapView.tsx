import { useEffect, useMemo, useRef, useState } from 'react';
import type { LocationCluster } from '@shared/ipc';
import { api, errorText, unwrap } from '../api';

/**
 * 地点页的底图。
 *
 * 走主进程去取腾讯位置服务的静态图：打包后的渲染层是 file:// 协议，
 * 官方的 JavaScript API GL 在这种协议下直接拒绝运行，而且那套 SDK 会把
 * Key 带到页面上。取图放在主进程里，渲染层只拿到一张 data URL。
 *
 * 取不到图（没配 Key、Key 无效、断网）时由调用方退回本地散点图，
 * 这里只负责把原因报上去，不留空白。
 */

const PI = Math.PI;
const AXIS = 6378245.0;
const EE = 0.00669342162296594323;

function outOfChina(lat: number, lon: number): boolean {
  return lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x: number, y: number): number {
  let ret =
    -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * PI) + 320 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLon(x: number, y: number): number {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0;
  return ret;
}

/**
 * EXIF 里的 GPS 是 WGS-84，腾讯地图用 GCJ-02，不转换会偏几百米。
 * 境外坐标原样返回（国内图源在境外的偏移规则不一样）。
 */
export function wgs84ToGcj02(lat: number, lon: number): { lat: number; lon: number } {
  if (outOfChina(lat, lon)) return { lat, lon };
  let dLat = transformLat(lon - 105.0, lat - 35.0);
  let dLon = transformLon(lon - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * PI;
  const magic = 1 - EE * Math.sin(radLat) * Math.sin(radLat);
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((AXIS * (1 - EE)) / (magic * sqrtMagic)) * PI);
  dLon = (dLon * 180.0) / ((AXIS / sqrtMagic) * Math.cos(radLat) * PI);
  return { lat: lat + dLat, lon: lon + dLon };
}

interface Props {
  clusters: LocationCluster[];
  selectedKey: string | null;
  onStatus: (error: string | null) => void;
}

export default function MapView({ clusters, selectedKey, onStatus }: Props) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [zoomDelta, setZoomDelta] = useState(0);
  const [img, setImg] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** 主进程算出的实际级别，用来把到顶的按钮禁掉（视野已经贴到最大时点 + 也不动） */
  const [level, setLevel] = useState(0);

  const points = useMemo(
    () =>
      clusters.map((c) => {
        const p = wgs84ToGcj02(c.lat, c.lon);
        return { key: c.key, lat: p.lat, lon: p.lon };
      }),
    [clusters]
  );
  // points 每次渲染都是新数组，直接进依赖会让请求无限循环；
  // 点位集合没变（key 串相同）就不该重取
  const sig = points.map((p) => `${p.key}`).join('|');

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const read = (): void => {
      const r = el.getBoundingClientRect();
      setSize({ w: Math.round(r.width), h: Math.round(r.height) });
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!size.w || !size.h) return;
    let alive = true;
    setLoading(true);
    void (async () => {
      try {
        const r = await unwrap(
          api.map.image({
            points,
            selected: selectedKey,
            width: size.w,
            height: size.h,
            zoomDelta,
          })
        );
        if (!alive) return;
        setImg(r.dataUrl);
        setLevel(r.zoom);
        onStatus(null);
      } catch (e) {
        if (alive) {
          setImg(null);
          onStatus(errorText(e));
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, selectedKey, size.w, size.h, zoomDelta]);

  return (
    <div className="mapview" ref={boxRef}>
      {img && (
        <img
          className="mapview-img"
          src={img}
          alt={`带定位的照片分布，共 ${clusters.length} 个地方`}
          draggable={false}
        />
      )}
      {loading && <span className="mapview-note">{img ? '更新中…' : '正在取底图…'}</span>}
      {img && <span className="mapview-attr">© 腾讯地图</span>}
      <div className="mapview-zoom">
        <button
          type="button"
          title="放大"
          onClick={() => setZoomDelta((z) => Math.min(3, z + 1))}
          disabled={zoomDelta >= 3 || level >= 17}
        >
          ＋
        </button>
        <button
          type="button"
          title="缩小"
          onClick={() => setZoomDelta((z) => Math.max(-3, z - 1))}
          disabled={zoomDelta <= -3 || level <= 3}
        >
          －
        </button>
      </div>
    </div>
  );
}

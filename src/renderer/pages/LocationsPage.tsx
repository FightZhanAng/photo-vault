import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LocationCluster, Photo } from '@shared/ipc';
import { api, errorText, unwrap } from '../api';
import { useApp } from '../store';
import { formatDate } from '../format';
import PhotoGrid from '../components/PhotoGrid';
import PhotoViewer from '../components/PhotoViewer';

const VB_W = 1000;
const VB_H = 400;
/** 网格边长（度）：0.05 ≈ 5.5km，0.01 ≈ 1.1km */
const STEPS: { value: number; label: string }[] = [
  { value: 0.2, label: '城市' },
  { value: 0.05, label: '街区' },
  { value: 0.01, label: '附近' },
];

interface Projected {
  x: number;
  y: number;
}

/**
 * 把经纬度投影到画布。
 *
 * 不用墨卡托也不用地图瓦片 —— 这里只要「哪几张扎堆」这层信息，
 * 等距圆柱投影 + 统一比例尺就够了，而且纬度方向不会被拉变形。
 * 只有一个点时给一个最小跨度，避免除零把点甩到角落。
 */
function makeProjector(clusters: LocationCluster[]): {
  project: (lat: number, lon: number) => Projected;
  g: { latMin: number; latMax: number; lonMin: number; lonMax: number };
} {
  let latMin = 90;
  let latMax = -90;
  let lonMin = 180;
  let lonMax = -180;
  for (const c of clusters) {
    latMin = Math.min(latMin, c.lat);
    latMax = Math.max(latMax, c.lat);
    lonMin = Math.min(lonMin, c.lon);
    lonMax = Math.max(lonMax, c.lon);
  }
  if (!clusters.length) {
    latMin = -10;
    latMax = 10;
    lonMin = -10;
    lonMax = 10;
  }

  const spanLat = Math.max(0.02, latMax - latMin);
  const spanLon = Math.max(0.02, lonMax - lonMin);
  // 同一个比例尺，留 12% 的边
  const k = Math.min((VB_W * 0.76) / spanLon, (VB_H * 0.72) / spanLat);
  const cx = (lonMin + lonMax) / 2;
  const cy = (latMin + latMax) / 2;

  return {
    project: (lat, lon) => ({
      x: VB_W / 2 + (lon - cx) * k,
      y: VB_H / 2 - (lat - cy) * k,
    }),
    g: { latMin, latMax, lonMin, lonMax },
  };
}

function coord(lat: number, lon: number): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(3)}°${ns}, ${Math.abs(lon).toFixed(3)}°${ew}`;
}

export default function LocationsPage() {
  const dataVersion = useApp((s) => s.dataVersion);
  const showToast = useApp((s) => s.showToast);

  const [step, setStep] = useState(0.05);
  const [clusters, setClusters] = useState<LocationCluster[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);

  const loadClusters = useCallback(async () => {
    setLoading(true);
    try {
      const list = await unwrap(api.photo.locations(step));
      setClusters(list);
      setSelectedKey((prev) => (prev && list.some((c) => c.key === prev) ? prev : list[0]?.key ?? null));
    } catch (e) {
      showToast(errorText(e));
      setClusters([]);
    } finally {
      setLoading(false);
    }
  }, [step, showToast]);

  useEffect(() => {
    void loadClusters();
  }, [loadClusters, dataVersion]);

  const selected = useMemo(
    () => clusters.find((c) => c.key === selectedKey) ?? null,
    [clusters, selectedKey]
  );

  useEffect(() => {
    if (!selected) {
      setPhotos([]);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const page = await unwrap(
          api.photo.list({
            status: ['kept', 'inbox'],
            latMin: selected.latMin,
            latMax: selected.latMax,
            lonMin: selected.lonMin,
            lonMax: selected.lonMax,
            sort: 'taken_desc',
            limit: 300,
          })
        );
        if (alive) setPhotos(page.items);
      } catch (e) {
        if (alive) showToast(errorText(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [selected, showToast]);

  const { project, g } = useMemo(() => makeProjector(clusters), [clusters]);
  const totalPhotos = clusters.reduce((n, c) => n + c.count, 0);

  return (
    <>
      <header className="topbar">
        <div className="title-block">
          <span className="kicker">图库</span>
          <h1>地点</h1>
        </div>
        <div className="count-block" title="带定位的照片数">
          <b>{totalPhotos}</b>
          <span>张</span>
        </div>
        <div className="spacer" />
        <div className="topbar-tools">
          <span className="hint">{clusters.length} 个地方</span>
          <div className="seg">
            {STEPS.map((s) => (
              <button
                key={s.value}
                className={step === s.value ? 'on' : ''}
                onClick={() => setStep(s.value)}
                title={`每 ${s.value}° 一格，约 ${(s.value * 111).toFixed(1)}km`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {loading ? (
        <div className="content">
          <div className="empty-state">
            <span className="empty-rule" />
            <h2>正在统计…</h2>
          </div>
        </div>
      ) : clusters.length === 0 ? (
        <div className="content">
          <div className="empty-state">
            <span className="empty-index">00</span>
            <h2>还没有带定位的照片</h2>
            <p>手机拍摄的照片一般带 GPS；导入后这里会按位置聚成一个个地方。</p>
          </div>
        </div>
      ) : (
        <div className="loc-page">
          <div className="loc-map">
            <svg viewBox={`0 0 ${VB_W} ${VB_H}`} preserveAspectRatio="xMidYMid meet" role="img">
              <title>带定位照片的分布</title>
              {/* 经纬网：让散点有比例参照 */}
              {[0.15, 0.38, 0.62, 0.85].map((p) => (
                <line
                  key={`v${p}`}
                  x1={VB_W * p}
                  y1={0}
                  x2={VB_W * p}
                  y2={VB_H}
                  className="loc-graticule"
                />
              ))}
              {[0.2, 0.5, 0.8].map((p) => (
                <line
                  key={`h${p}`}
                  x1={0}
                  y1={VB_H * p}
                  x2={VB_W}
                  y2={VB_H * p}
                  className="loc-graticule"
                />
              ))}

              {clusters.map((c) => {
                const { x, y } = project(c.lat, c.lon);
                const r = 7 + Math.min(15, Math.sqrt(c.count) * 3);
                const on = c.key === selectedKey;
                return (
                  <g
                    key={c.key}
                    className={`loc-dot${on ? ' on' : ''}`}
                    onClick={() => setSelectedKey(c.key)}
                  >
                    <circle cx={x} cy={y} r={r + 9} className="loc-hit" />
                    <circle cx={x} cy={y} r={r} className="loc-point" />
                    {on && <circle cx={x} cy={y} r={r + 5} className="loc-ring" />}
                    <text x={x} y={y + r + 16} className="loc-count">
                      {c.count}
                    </text>
                  </g>
                );
              })}
            </svg>
            <span className="loc-axis nw">
              {g.latMax.toFixed(2)}° / {g.lonMin.toFixed(2)}°
            </span>
            <span className="loc-axis se">
              {g.latMin.toFixed(2)}° / {g.lonMax.toFixed(2)}°
            </span>
            <span className="loc-axis sw">圆点越大，照片越多</span>
          </div>

          <div className="loc-strip">
            {clusters.map((c) => {
              // 同一天的照片只显示一个日期，别写成「2026-11-16 ~ 2026-11-16」
              const dayFrom = formatDate(c.from);
              const dayTo = formatDate(c.to);
              const when = dayFrom === dayTo ? dayFrom : `${dayFrom} ~ ${dayTo}`;
              return (
                <button
                  key={c.key}
                  className={`loc-card${c.key === selectedKey ? ' on' : ''}`}
                  onClick={() => setSelectedKey(c.key)}
                >
                  <img src={c.coverThumbUrl} alt="" loading="lazy" draggable={false} />
                  <div className="loc-card-body">
                    <b>
                      {c.count} 张
                      <em>{when}</em>
                    </b>
                    <span>{coord(c.lat, c.lon)}</span>
                  </div>
                </button>
              );
            })}
          </div>

          <div className="content">
            {photos.length > 0 ? (
              <PhotoGrid
                photos={photos}
                selected={new Set<number>()}
                onOpen={setViewerIndex}
                onToggle={() => undefined}
                onFavorite={() => undefined}
              />
            ) : (
              <div className="empty-state">
                <span className="empty-rule" />
                <h2>这个格子里没有照片</h2>
                <p>换一个地点，或把网格调粗一点。</p>
              </div>
            )}
          </div>
        </div>
      )}

      {viewerIndex !== null && photos[viewerIndex] && (
        <PhotoViewer
          photos={photos}
          index={viewerIndex}
          onClose={() => setViewerIndex(null)}
          onIndexChange={setViewerIndex}
          onToggleFavorite={() => undefined}
        />
      )}
    </>
  );
}

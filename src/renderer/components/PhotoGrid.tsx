import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Photo } from '@shared/ipc';
import { formatDuration, isVideoExt } from '../format';
import { onPosterReady, requestPoster } from '../videoPoster';

const GAP = 8;
const HEADER_H = 62;

type Row =
  | { type: 'header'; key: string; year: string; month: string; sub: string }
  | { type: 'photos'; key: string; items: Photo[]; start: number };

function monthOf(ts: number | null): { key: string; year: string; month: string } {
  const d = new Date(ts ?? Date.now());
  return {
    key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
    year: String(d.getFullYear()),
    month: `${String(d.getMonth() + 1).padStart(2, '0')} 月`,
  };
}

function buildRows(photos: Photo[], cols: number, grouped: boolean): Row[] {
  const counts = new Map<string, number>();
  for (const p of photos) {
    const k = monthOf(p.takenAt).key;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }

  const rows: Row[] = [];
  let buffer: Photo[] = [];
  let currentKey = '';
  let offset = 0;

  const flush = (): void => {
    for (let i = 0; i < buffer.length; i += cols) {
      const items = buffer.slice(i, i + cols);
      rows.push({ type: 'photos', key: `p-${items[0]?.id ?? i}`, items, start: offset + i });
    }
    offset += buffer.length;
    buffer = [];
  };

  for (const photo of photos) {
    if (grouped) {
      const { key, year, month } = monthOf(photo.takenAt);
      if (key !== currentKey) {
        flush();
        rows.push({
          type: 'header',
          key: `h-${key}`,
          year,
          month,
          sub: `${counts.get(key) ?? 0} 张`,
        });
        currentKey = key;
      }
    }
    buffer.push(photo);
  }
  flush();
  return rows;
}

interface CellProps {
  photo: Photo;
  size: number;
  selected: boolean;
  onOpen: () => void;
  onToggle: () => void;
  onFavorite: (next: boolean) => void;
}

function PhotoCell({ photo, size, selected, onOpen, onToggle, onFavorite }: CellProps) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  /** 首帧生成完成后 +1，用来给 img 换个 query 触发重新请求 */
  const [posterVersion, setPosterVersion] = useState(0);
  const [posterFailed, setPosterFailed] = useState(false);
  /** 首帧截取时读到的时长，先顶一阵，等列表重新拉回来就一致了 */
  const [posterDuration, setPosterDuration] = useState<number | null>(null);
  const video = isVideoExt(photo.ext);
  // 视频首帧生成成功时一定会写回 duration_ms，所以这两条一起构成「有缩略图」的判断。
  // 先判断再请求，就不用发一次注定 404 的请求，控制台也不会刷失败日志。
  const hasPoster = posterVersion > 0 || photo.durationMs !== null;
  const durationMs = posterDuration ?? photo.durationMs;

  useEffect(() => {
    if (!video) return;
    return onPosterReady((id, info) => {
      if (id !== photo.id) return;
      if (!info) {
        setPosterFailed(true);
        return;
      }
      setPosterVersion((n) => n + 1);
      setPosterDuration(info.durationMs);
      setFailed(false);
      setLoaded(false);
    });
  }, [video, photo.id]);

  useEffect(() => {
    if (video && !hasPoster) requestPoster(photo);
  }, [video, hasPoster, photo]);

  const showImage = !video || hasPoster;
  const src = posterVersion > 0 ? `${photo.thumbUrl}?v=${posterVersion}` : photo.thumbUrl;

  return (
    <div
      className={`photo-cell${selected ? ' selected' : ''}${loaded || posterFailed ? ' loaded' : ''}`}
      style={{ width: size, height: size }}
      onClick={(e) => {
        if (e.ctrlKey || e.metaKey || e.shiftKey) onToggle();
        else onOpen();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onToggle();
      }}
      title={photo.fileName}
    >
      {showImage && (
        <img
          src={src}
          alt={photo.fileName}
          loading="lazy"
          draggable={false}
          className={loaded && !failed ? 'loaded' : ''}
          onLoad={() => setLoaded(true)}
          onError={() => {
            setLoaded(true);
            setFailed(true);
          }}
        />
      )}
      {(!showImage || failed) && (
        <div className="cell-fallback">
          <span className="cell-fallback-mark">{video ? '▶' : '?'}</span>
          <em>{video ? (posterFailed || hasPoster ? '首帧不可用' : '首帧生成中…') : '无法预览'}</em>
        </div>
      )}
      {video && hasPoster && !failed && (
        <span className="cell-video" title={durationMs ? `视频 ${formatDuration(durationMs)}` : '视频'}>
          <i>▶</i>
          {durationMs ? formatDuration(durationMs) : ''}
        </span>
      )}
      <span className="cell-frame" aria-hidden />
      {selected && <span className="tick">✓</span>}
      {photo.favorite && <span className="fav">★</span>}
      <div className="hover-actions">
        <button
          className={`pick${selected ? ' on' : ''}`}
          title={selected ? '取消选择（也可 Ctrl/⌘ 点击）' : '选择（也可 Ctrl/⌘ 点击）'}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
        >
          {selected ? '✓' : ''}
        </button>
        <button
          title={photo.favorite ? '取消收藏' : '收藏'}
          onClick={(e) => {
            e.stopPropagation();
            onFavorite(!photo.favorite);
          }}
        >
          {photo.favorite ? '★' : '☆'}
        </button>
      </div>
    </div>
  );
}

interface PhotoGridProps {
  photos: Photo[];
  grouped?: boolean;
  /** 目标格子边长，越小一屏越多 */
  cell?: number;
  selected: Set<number>;
  onOpen: (index: number) => void;
  onToggle: (id: number) => void;
  onFavorite: (id: number, next: boolean) => void;
  onEndReached?: () => void;
}

export default function PhotoGrid({
  photos,
  grouped = true,
  cell = 176,
  selected,
  onOpen,
  onToggle,
  onFavorite,
  onEndReached,
}: PhotoGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  const available = Math.max(120, width - 40);
  const cols = Math.max(1, Math.floor((available + GAP) / (cell + GAP)));
  const cellSize = (available - (cols - 1) * GAP) / cols;
  const rowH = cellSize + GAP;

  const rows = useMemo(() => buildRows(photos, cols, grouped), [photos, cols, grouped]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (rows[index]?.type === 'header' ? HEADER_H : rowH),
    overscan: 4,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [rowH, rows.length, virtualizer]);

  if (!photos.length) return null;

  return (
    <div
      className="grid-scroll"
      ref={scrollRef}
      onScroll={(e) => {
        const el = e.currentTarget;
        if (onEndReached && el.scrollHeight - el.scrollTop - el.clientHeight < 700) onEndReached();
      }}
    >
      <div className="grid-inner" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          if (!row) return null;

          if (row.type === 'header') {
            return (
              <div
                key={row.key}
                className="date-head"
                style={{ transform: `translateY(${item.start}px)`, height: HEADER_H }}
              >
                <span className="date-year">{row.year}</span>
                <span className="date-month">{row.month}</span>
                <span className="date-rule" />
                <span className="date-count">{row.sub}</span>
              </div>
            );
          }

          const firstIndex = row.start;
          return (
            <div
              key={row.key}
              className="grid-row"
              style={{ transform: `translateY(${item.start}px)`, height: cellSize }}
            >
              {row.items.map((photo, i) => (
                <PhotoCell
                  key={photo.id}
                  photo={photo}
                  size={cellSize}
                  selected={selected.has(photo.id)}
                  onOpen={() => onOpen(firstIndex + i)}
                  onToggle={() => onToggle(photo.id)}
                  onFavorite={(next) => onFavorite(photo.id, next)}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

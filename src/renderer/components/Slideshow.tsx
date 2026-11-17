import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Photo } from '@shared/ipc';
import { isVideoExt } from '../format';

function formatTime(ts: number | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate()
  ).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

interface SlideshowProps {
  photos: Photo[];
  startIndex?: number;
  onClose: () => void;
}

const INTERVAL = 3600;

export default function Slideshow({ photos: all, startIndex = 0, onClose }: SlideshowProps) {
  // 幻灯片只放图片：视频有自己的时长和声音，自动翻页会和播放打架
  const photos = useMemo(() => all.filter((p) => !isVideoExt(p.ext)), [all]);
  // 传进来的下标是在「全部照片」里的位置，过滤后要换算成图片里的位置
  const [index, setIndex] = useState(() => {
    const before = all.slice(0, startIndex).filter((p) => !isVideoExt(p.ext)).length;
    return Math.min(before, Math.max(0, photos.length - 1));
  });
  const [playing, setPlaying] = useState(true);
  const [loaded, setLoaded] = useState(false);
  // 顶栏平时靠 hover 显示；刚进来先亮 2.6 秒，让人知道 Esc/退出在哪
  const [hint, setHint] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => setHint(false), 2600);
    return () => clearTimeout(t);
  }, []);

  const step = useCallback(
    (delta: number) => {
      setLoaded(false);
      setIndex((i) => (i + delta + photos.length) % photos.length);
    },
    [photos.length]
  );

  useEffect(() => {
    if (!playing || photos.length < 2) return;
    const timer = setTimeout(() => step(1), INTERVAL);
    return () => clearTimeout(timer);
  }, [index, playing, photos.length, step]);

  // 提前解码下一张，切换时不会白一下
  useEffect(() => {
    const next = photos[(index + 1) % photos.length];
    if (next) {
      const img = new Image();
      img.src = next.previewUrl;
    }
  }, [index, photos]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        step(1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        step(-1);
      } else if (e.key === ' ') {
        e.preventDefault();
        setPlaying((p) => !p);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, step]);

  const photo = photos[index];
  if (!photo) return null;

  return (
    <div className={`slideshow${hint ? ' hint' : ''}`} onClick={() => setPlaying((p) => !p)}>
      <img
        key={photo.id}
        src={photo.previewUrl}
        alt={photo.fileName}
        className={loaded ? 'on' : ''}
        draggable={false}
        onLoad={() => setLoaded(true)}
      />

      <div className="slideshow-top" onClick={(e) => e.stopPropagation()}>
        <span className="counter">
          {index + 1} / {photos.length}
        </span>
        <span className="name">{photo.fileName}</span>
        <span className="grow" />
        <button onClick={() => setPlaying((p) => !p)} title="空格暂停/继续">
          {playing ? '暂停' : '继续'}
        </button>
        <button onClick={onClose} title="退出 (Esc)">
          退出
        </button>
      </div>

      <button
        className="slideshow-nav prev"
        onClick={(e) => {
          e.stopPropagation();
          step(-1);
        }}
        title="上一张"
      >
        ‹
      </button>
      <button
        className="slideshow-nav next"
        onClick={(e) => {
          e.stopPropagation();
          step(1);
        }}
        title="下一张"
      >
        ›
      </button>

      <div className="slideshow-meta" onClick={(e) => e.stopPropagation()}>
        <b>{formatTime(photo.takenAt)}</b>
        {photo.cameraModel ? <span> · {photo.cameraModel}</span> : null}
        {photo.width && photo.height ? (
          <span>
            {' '}
            · {photo.width}×{photo.height}
          </span>
        ) : null}
      </div>

      {playing && photos.length > 1 && (
        <div className="slideshow-progress">
          <i key={`${index}-${playing}`} style={{ animationDuration: `${INTERVAL}ms` }} />
        </div>
      )}
    </div>
  );
}

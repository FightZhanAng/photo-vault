import { useCallback, useEffect, useState, type MouseEvent } from 'react';
import type { Photo, SimilarPhoto, Tag } from '@shared/ipc';
import { api, unwrap } from '../api';
import { useApp } from '../store';
import TagMenu from './TagMenu';
import { isVideoExt, formatDuration } from '../format';
import { usePosterDuration } from '../videoPoster';

function formatSize(bytes: number): string {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function formatTime(ts: number | null): string {
  if (!ts) return '未知时间';
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface PhotoViewerProps {
  photos: Photo[];
  index: number;
  onClose: () => void;
  onIndexChange: (index: number) => void;
  onKeep?: (id: number) => void;
  onReject?: (id: number) => void;
  onToggleFavorite?: (id: number, next: boolean) => void;
  onSlideshow?: () => void;
}

export default function PhotoViewer({
  photos,
  index,
  onClose,
  onIndexChange,
  onKeep,
  onReject,
  onToggleFavorite,
  onSlideshow,
}: PhotoViewerProps) {
  const base = photos[index];
  const refreshTags = useApp((s) => s.refreshTags);
  const showToast = useApp((s) => s.showToast);

  /** 从「找相似」点进来时临时显示另一张，不改变当前列表的位置 */
  const [shown, setShown] = useState<Photo | null>(null);
  const [tags, setTags] = useState<Tag[]>([]);
  const [rating, setRating] = useState(0);
  const [tagMenu, setTagMenu] = useState<{ x: number; y: number } | null>(null);
  const [similar, setSimilar] = useState<SimilarPhoto[] | null>(null);
  const [similarBusy, setSimilarBusy] = useState(false);

  const photo = shown ?? base;

  const step = useCallback(
    (delta: number) => {
      const next = index + delta;
      if (next >= 0 && next < photos.length) {
        setShown(null);
        setSimilar(null);
        onIndexChange(next);
      }
    },
    [index, photos.length, onIndexChange]
  );

  const photoId = photo?.id;

  useEffect(() => {
    if (!photoId) return;
    let alive = true;
    void (async () => {
      try {
        const list = await unwrap(api.photo.tags(photoId));
        if (alive) setTags(list);
      } catch {
        if (alive) setTags([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [photoId]);

  useEffect(() => {
    setRating(photo?.rating ?? 0);
  }, [photo?.id, photo?.rating]);

  // 切换底图时把「找相似」结果收掉，避免面板显示的还是上一张的结果
  useEffect(() => {
    setSimilar(null);
  }, [base?.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        step(-1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        step(1);
      } else if ((e.key === 'Enter' || e.key === ' ') && onKeep && photo) {
        e.preventDefault();
        onKeep(photo.id);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && onReject && photo) {
        e.preventDefault();
        onReject(photo.id);
      } else if (/^[0-5]$/.test(e.key) && photo) {
        // 数字键快速打分，0 清除
        e.preventDefault();
        const value = Number(e.key);
        setRating(value);
        void api.photo.patch(photo.id, { rating: value }).catch((err) => {
          showToast(err instanceof Error ? err.message : String(err));
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, step, onKeep, onReject, photo, showToast]);

  if (!photo) return null;

  const setStars = async (value: number): Promise<void> => {
    const next = value === rating ? 0 : value;
    setRating(next);
    try {
      await unwrap(api.photo.patch(photo.id, { rating: next }));
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    }
  };

  const removeTag = async (tag: Tag): Promise<void> => {
    try {
      await unwrap(api.tag.detach([photo.id], tag.id));
      setTags((prev) => prev.filter((t) => t.id !== tag.id));
      await refreshTags();
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    }
  };

  const openTagMenu = (e: MouseEvent<HTMLButtonElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    // 按钮在底栏，浮层向上展开
    setTagMenu({ x: rect.left, y: rect.top });
  };

  const findSimilar = async (): Promise<void> => {
    if (similar) {
      setSimilar(null);
      return;
    }
    setSimilarBusy(true);
    try {
      const list = await unwrap(api.photo.similar(photo.id, 10));
      setSimilar(list);
      if (!list.length) showToast('没有找到相近的照片');
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    } finally {
      setSimilarBusy(false);
    }
  };

  const openSimilar = async (id: number): Promise<void> => {
    try {
      setShown(await unwrap(api.photo.get(id)));
      setSimilar(null);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    }
  };

  const video = isVideoExt(photo.ext);
  const durationMs = usePosterDuration(photo.id, photo.durationMs);

  return (
    <div className="viewer">
      <div className="viewer-stage">
        {video ? (
          <video
            key={photo.id}
            className="viewer-video"
            src={photo.originalUrl}
            controls
            autoPlay
            loop
            playsInline
          />
        ) : (
          <img src={photo.previewUrl} alt={photo.fileName} draggable={false} />
        )}
        <span className="viewer-index">
          {shown ? (
            <em className="viewer-index-tag">相似</em>
          ) : (
            <>
              {String(index + 1).padStart(2, '0')}
              <i>/</i>
              {String(photos.length).padStart(2, '0')}
            </>
          )}
        </span>
        <button className="viewer-close" onClick={onClose} title="关闭 (Esc)">
          ✕
        </button>
        {!shown && index > 0 && (
          <button className="viewer-nav prev" onClick={() => step(-1)} title="上一张 (←)">
            ‹
          </button>
        )}
        {!shown && index < photos.length - 1 && (
          <button className="viewer-nav next" onClick={() => step(1)} title="下一张 (→)">
            ›
          </button>
        )}

        {similar && (
          <div className="similar-panel">
            <div className="similar-head">
              <b>看起来像的</b>
              <em>{similar.length} 张</em>
              <button onClick={() => setSimilar(null)} title="收起">
                ✕
              </button>
            </div>
            {similar.length === 0 ? (
              <p className="hint">这张没有相近的照片。</p>
            ) : (
              <div className="similar-grid">
                {similar.map((s) => (
                  <button
                    key={s.photoId}
                    className="similar-cell"
                    onClick={() => void openSimilar(s.photoId)}
                    title={`${s.fileName} · 差异 ${s.distance}`}
                  >
                    <img src={s.thumbUrl} alt={s.fileName} loading="lazy" />
                    <span className="similar-dist">{s.distance === 0 ? '一致' : s.distance}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="viewer-bar">
        <div className="viewer-meta">
          <div className="viewer-name">{photo.fileName}</div>
          <div>
            <b>{formatTime(photo.takenAt)}</b>
            {' · '}
            <b>
              {video
                ? durationMs
                  ? `视频 ${formatDuration(durationMs)}`
                  : '视频'
                : `${photo.width ?? '?'}×${photo.height ?? '?'}`}
            </b>
            {' · '}
            <b>{formatSize(photo.size)}</b>
            {photo.cameraModel ? ` · ${photo.cameraModel}` : ''}
            {!shown && (
              <>
                {' · '}
                {index + 1} / {photos.length}
              </>
            )}
          </div>
          <div className="viewer-tags">
            {tags.map((tag) => (
              <span className="tag-chip" key={tag.id}>
                {tag.name}
                <button title="移除标签" onClick={() => void removeTag(tag)}>
                  ✕
                </button>
              </span>
            ))}
            <button className="tag-add" onClick={openTagMenu}>
              + 标签
            </button>
          </div>
        </div>

        <div className="rating">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              className={n <= rating ? 'on' : ''}
              title={`${n} 星`}
              onClick={() => void setStars(n)}
            >
              ★
            </button>
          ))}
        </div>

        <div className="viewer-actions">
          <button
            className={`btn ${similar ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => void findSimilar()}
            disabled={similarBusy}
            title="用感知哈希找出看起来像的照片"
          >
            {similarBusy ? '查找中…' : similar ? '收起相似' : '找相似'}
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => {
              void api.app.revealInFolder(photo.id);
            }}
            title="在资源管理器里定位这个文件"
          >
            定位文件
          </button>
          {onSlideshow && (
            <button className="btn" onClick={onSlideshow} title="从这张开始播放">
              幻灯片
            </button>
          )}
          {onToggleFavorite && (
            <button className="btn" onClick={() => onToggleFavorite(photo.id, !photo.favorite)}>
              {photo.favorite ? '★ 已收藏' : '☆ 收藏'}
            </button>
          )}
          {onReject && (
            <button className="btn btn-danger" onClick={() => onReject(photo.id)}>
              淘汰 (Delete)
            </button>
          )}
          {onKeep && (
            <button className="btn btn-primary" onClick={() => onKeep(photo.id)}>
              保留 (Enter)
            </button>
          )}
        </div>
      </div>

      {tagMenu && (
        <TagMenu
          photoIds={[photo.id]}
          x={tagMenu.x}
          y={tagMenu.y}
          placement="above"
          onClose={() => {
            setTagMenu(null);
            void (async () => {
              try {
                setTags(await unwrap(api.photo.tags(photo.id)));
              } catch {
                /* ignore */
              }
            })();
          }}
        />
      )}
    </div>
  );
}

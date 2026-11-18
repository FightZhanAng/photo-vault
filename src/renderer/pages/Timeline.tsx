import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import type { Photo, PhotoQuery, PhotoSort } from '@shared/ipc';
import { api, errorText, unwrap } from '../api';
import { isVideoExt } from '../format';
import { DENSITY_CELL, PREF, useApp } from '../store';
import PhotoGrid from '../components/PhotoGrid';
import PhotoViewer from '../components/PhotoViewer';
import FilterBar, {
  EMPTY_FILTERS,
  rangeBounds,
  type Filters,
} from '../components/FilterBar';
import AlbumMenu from '../components/AlbumMenu';
import TagMenu from '../components/TagMenu';
import Slideshow from '../components/Slideshow';
import TaskStrip from '../components/TaskStrip';
import SelectionBar from '../components/SelectionBar';
import RenameDialog from '../dialogs/RenameDialog';
import ExportDialog from '../dialogs/ExportDialog';
import RemoveDialog from '../dialogs/RemoveDialog';

const PAGE_SIZE = 300;

interface TimelineProps {
  title: string;
  /** 标题上方的小标：图库 / 相册 / 标签 / 任务 */
  kicker?: string;
  albumId?: number;
  tagId?: number;
  taskId?: number;
}

type PopoverState = { kind: 'tag' | 'album'; x: number; y: number; above: boolean } | null;
export default function Timeline({ title, kicker = '图库', albumId, tagId, taskId }: TimelineProps) {
  const dataVersion = useApp((s) => s.dataVersion);
  const density = useApp((s) => s.density);
  const setDensity = useApp((s) => s.setDensity);
  const showToast = useApp((s) => s.showToast);
  const refreshStats = useApp((s) => s.refreshStats);
  const refreshAlbums = useApp((s) => s.refreshAlbums);
  const refreshTags = useApp((s) => s.refreshTags);
  const bumpData = useApp((s) => s.bumpData);
  const albums = useApp((s) => s.albums);

  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [slideshowAt, setSlideshowAt] = useState<number | null>(null);
  const [popover, setPopover] = useState<PopoverState>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const fetchingMore = useRef(false);

  const prefs = useApp((s) => s.prefs);
  const prefSort = prefs[PREF.defaultSort];
  const sortApplied = useRef(false);

  // 偏好里的默认排序只在首次加载后套用一次，之后用户自己选的排序优先
  useEffect(() => {
    if (sortApplied.current || !prefSort) return;
    sortApplied.current = true;
    setFilters((f) => ({ ...f, sort: prefSort as PhotoSort }));
  }, [prefSort]);

  const albumInfo = albumId ? albums.find((a) => a.id === albumId) : null;
  const isSmart = albumInfo?.kind === 'smart';

  const buildQuery = useCallback(
    (withCursor?: string): PhotoQuery => {
      const bounds = rangeBounds(filters.range);
      const query: PhotoQuery = {
        status: ['kept', 'inbox'],
        albumId,
        taskId,
        tagIds: tagId ? [tagId] : undefined,
        // 搜索框里可能带 tag:/ext:/year: 这类语法，交给主进程统一解析
        q: filters.keyword.trim() || undefined,
        favoriteOnly: filters.favoriteOnly || undefined,
        hasGps: filters.hasGps ? true : undefined,
        ext: filters.ext ? [filters.ext] : undefined,
        from: bounds.from,
        to: bounds.to,
        sort: filters.sort,
        limit: PAGE_SIZE,
        cursor: withCursor,
      };
      return query;
    },
    [albumId, tagId, taskId, filters]
  );

  const loadFirst = useCallback(async () => {
    setLoading(true);
    try {
      const page = await unwrap(api.photo.list(buildQuery()));
      setPhotos(page.items);
      setTotal(page.total);
      setCursor(page.nextCursor);
      setSelected(new Set());
      setViewerIndex(null);
    } catch (e) {
      showToast(errorText(e));
      setPhotos([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [buildQuery, showToast]);

  useEffect(() => {
    void loadFirst();
  }, [loadFirst, dataVersion]);

  const loadMore = useCallback(async () => {
    if (!cursor || fetchingMore.current) return;
    fetchingMore.current = true;
    try {
      const page = await unwrap(api.photo.list(buildQuery(cursor)));
      setPhotos((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        return [...prev, ...page.items.filter((p) => !seen.has(p.id))];
      });
      setCursor(page.nextCursor);
    } catch {
      /* 滚动加载失败不打断浏览 */
    } finally {
      fetchingMore.current = false;
    }
  }, [cursor, buildQuery]);

  const toggleSelect = useCallback((id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleFavorite = useCallback(
    async (id: number, next: boolean) => {
      try {
        await unwrap(api.photo.patch(id, { favorite: next }));
        setPhotos((prev) => prev.map((p) => (p.id === id ? { ...p, favorite: next } : p)));
        // 智能相册（比如「收藏」）的张数是按规则现算的，改完收藏要重新取一遍
        bumpData();
      } catch (e) {
        showToast(errorText(e));
      }
    },
    [showToast, bumpData]
  );

  const favoriteSelected = async (next: boolean): Promise<void> => {
    const ids = [...selected];
    try {
      for (const id of ids) await unwrap(api.photo.patch(id, { favorite: next }));
      setPhotos((prev) => prev.map((p) => (selected.has(p.id) ? { ...p, favorite: next } : p)));
      bumpData();
      showToast(`已${next ? '收藏' : '取消收藏'} ${ids.length} 张`);
    } catch (e) {
      showToast(errorText(e));
    }
  };

  /** 移出/剔除之后统一收拾界面状态 */
  const dropFromList = useCallback(
    async (message: string) => {
      const ids = [...selected];
      setPhotos((prev) => prev.filter((p) => !selected.has(p.id)));
      setTotal((t) => Math.max(0, t - ids.length));
      setSelected(new Set());
      await refreshStats();
      bumpData();
      showToast(message);
    },
    [selected, refreshStats, bumpData, showToast]
  );

  const detachFromAlbum = async (): Promise<void> => {
    if (!albumId) return;
    const ids = [...selected];
    try {
      await unwrap(api.album.removePhotos(albumId, ids));
      await refreshAlbums();
      await dropFromList(`已从相册移出 ${ids.length} 张`);
    } catch (e) {
      showToast(errorText(e));
    }
  };

  const detachFromTag = async (): Promise<void> => {
    if (!tagId) return;
    const ids = [...selected];
    try {
      await unwrap(api.tag.detach(ids, tagId));
      await refreshTags();
      await dropFromList(`已去掉 ${ids.length} 张的这个标签`);
    } catch (e) {
      showToast(errorText(e));
    }
  };

  const handleKeep = (id: number): void => {
    void (async () => {
      try {
        await unwrap(api.inbox.review([id], 'keep'));
        await refreshStats();
        bumpData();
        if (viewerIndex !== null && viewerIndex < photos.length - 1) setViewerIndex(viewerIndex + 1);
        else setViewerIndex(null);
      } catch (e) {
        showToast(errorText(e));
      }
    })();
  };

  const openPopover = (kind: 'tag' | 'album') => (e: MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    // 触发按钮在底部浮动条上：浮层贴着整条操作栏向上展开，不会盖住按钮
    const bar = document.querySelector('.selbar')?.getBoundingClientRect();
    setPopover({
      kind,
      x: rect.left,
      y: bar ? bar.top : rect.bottom + 6,
      above: Boolean(bar),
    });
  };

  const allSelected = photos.length > 0 && selected.size === photos.length;
  const viewerPhoto = viewerIndex !== null ? photos[viewerIndex] : null;

  /** 幻灯片只放图片，全是视频的时候没必要进去看黑屏 */
  const startSlideshow = (): void => {
    if (!photos.some((p) => !isVideoExt(p.ext))) {
      showToast('这批里只有视频，没有可放映的照片');
      return;
    }
    setSlideshowAt(0);
  };

  return (
    <>
      <header className="topbar">
        <div className="title-block">
          <span className="kicker">{kicker}</span>
          <h1>
            {title}
            {isSmart && <em className="badge soft">智能</em>}
          </h1>
        </div>

        <div className="count-block" title="当前条件下的照片数">
          <b>{total}</b>
          <span>张</span>
        </div>

        <div className="spacer" />

        <div className="topbar-tools">
          {photos.length > 0 && (
            <>
              <button className="btn btn-ghost" onClick={startSlideshow}>
                幻灯片
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => setSelected(allSelected ? new Set() : new Set(photos.map((p) => p.id)))}
              >
                {allSelected ? '取消全选' : '全选'}
              </button>
            </>
          )}
        </div>
      </header>

      <FilterBar value={filters} onChange={setFilters} density={density} onDensity={setDensity} />

      {taskId && <TaskStrip taskId={taskId} />}

      <div className="content">
        {photos.length > 0 ? (
          <PhotoGrid
            photos={photos}
            cell={DENSITY_CELL[density]}
            selected={selected}
            onOpen={setViewerIndex}
            onToggle={toggleSelect}
            onFavorite={(id, next) => void toggleFavorite(id, next)}
            onEndReached={() => void loadMore()}
          />
        ) : (
          <div className="empty-state">
            {loading ? (
              <>
                <span className="empty-rule" />
                <h2>正在读取…</h2>
              </>
            ) : (
              <>
                <span className="empty-index">00</span>
                <h2>{emptyTitle({ albumId, tagId, taskId, filtered: filters.keyword !== '' || filters.range !== 'all' })}</h2>
                <p>{emptyHint({ albumId, tagId, taskId, search: filters.keyword.trim() })}</p>
              </>
            )}
          </div>
        )}
      </div>

      {selected.size > 0 && (
        <SelectionBar count={selected.size} onClear={() => setSelected(new Set())}>
          <button className="btn" onClick={openPopover('tag')}>
            打标签
          </button>
          <button className="btn" onClick={openPopover('album')}>
            加入相册
          </button>
          <button className="btn" onClick={() => setRenameOpen(true)}>
            重命名
          </button>
          <button className="btn" onClick={() => setExportOpen(true)}>
            导出
          </button>
          <button className="btn" onClick={() => void favoriteSelected(true)}>
            收藏
          </button>
          {albumId && !isSmart && (
            <button className="btn" onClick={() => void detachFromAlbum()}>
              移出相册
            </button>
          )}
          {tagId && (
            <button className="btn" onClick={() => void detachFromTag()}>
              去掉标签
            </button>
          )}
          <button className="btn btn-danger" onClick={() => setRemoveOpen(true)}>
            移出
          </button>
        </SelectionBar>
      )}

      {viewerPhoto && viewerIndex !== null && (
        <PhotoViewer
          photos={photos}
          index={viewerIndex}
          onClose={() => setViewerIndex(null)}
          onIndexChange={setViewerIndex}
          onToggleFavorite={(id, next) => void toggleFavorite(id, next)}
          onKeep={viewerPhoto.status === 'inbox' ? handleKeep : undefined}
          onSlideshow={() => {
            if (!photos.some((p) => !isVideoExt(p.ext))) {
              showToast('这批里只有视频，没有可放映的照片');
              return;
            }
            setSlideshowAt(viewerIndex);
            setViewerIndex(null);
          }}
        />
      )}

      {slideshowAt !== null && photos.some((p) => !isVideoExt(p.ext)) && (
        <Slideshow photos={photos} startIndex={slideshowAt} onClose={() => setSlideshowAt(null)} />
      )}

      {popover?.kind === 'tag' && (
        <TagMenu
          photoIds={[...selected]}
          x={popover.x}
          y={popover.y}
          placement={popover.above ? 'above' : 'below'}
          onClose={() => setPopover(null)}
        />
      )}
      {popover?.kind === 'album' && (
        <AlbumMenu
          photoIds={[...selected]}
          x={popover.x}
          y={popover.y}
          placement={popover.above ? 'above' : 'below'}
          onClose={() => setPopover(null)}
        />
      )}
      {renameOpen && (
        <RenameDialog
          photoIds={[...selected]}
          onClose={() => setRenameOpen(false)}
          onDone={() => {
            setSelected(new Set());
            bumpData();
          }}
        />
      )}
      {exportOpen && (
        <ExportDialog
          photoIds={[...selected]}
          defaultTitle={title}
          onClose={() => setExportOpen(false)}
        />
      )}
      {removeOpen && (
        <RemoveDialog
          photoIds={[...selected]}
          onClose={() => setRemoveOpen(false)}
          onDone={(message) => void dropFromList(message)}
        />
      )}
    </>
  );
}

function emptyTitle(o: { albumId?: number; tagId?: number; taskId?: number; filtered: boolean }): string {
  if (o.taskId) return '这个任务还没有照片';
  if (o.tagId) return '这个标签下还没有照片';
  if (o.albumId) return '这个相册还是空的';
  if (o.filtered) return '没有符合条件的照片';
  return '还没有照片';
}

function emptyHint(o: { albumId?: number; tagId?: number; taskId?: number; search?: string }): string {
  if (o.search) {
    return '换个词试试；用了 tag: / ext: / year: 这类语法的话，确认名字和值写对没有 —— 点搜索框右侧的提示可以看全部写法。';
  }
  if (o.taskId) return '在任务卡片里打开上传入口，或用「导入文件夹」把这次活动的照片收进来。';
  if (o.tagId) return '在时间轴里选中照片，点「打标签」就能把它们归到这里。';
  if (o.albumId) return '在时间轴里选中照片后点「加入相册」，或换一个筛选条件。';
  return '点击左侧「导入照片」选一个文件夹，或者把照片/文件夹直接拖进窗口 —— 照片会按拍摄时间自动归档。';
}

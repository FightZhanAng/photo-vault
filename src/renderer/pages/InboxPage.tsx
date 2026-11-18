import { useCallback, useEffect, useRef, useState } from 'react';
import type { Photo, PhotoStatus } from '@shared/ipc';
import { api, errorText, unwrap } from '../api';
import { useApp } from '../store';
import PhotoGrid from '../components/PhotoGrid';
import PhotoViewer from '../components/PhotoViewer';
import SelectionBar from '../components/SelectionBar';

const PAGE_SIZE = 200;

type Tab = 'inbox' | 'rejected';

const TAB_TEXT: Record<Tab, { kicker: string; title: string; empty: string; hint: string }> = {
  inbox: {
    kicker: '待审',
    title: '收件箱',
    empty: '收件箱是空的',
    hint: '新导入的照片会先落在这里，逐张确认后再进正式库。',
  },
  rejected: {
    kicker: '已淘汰',
    title: '已淘汰',
    empty: '还没有淘汰过照片',
    hint: '在收件箱或时间轴里点「淘汰 / 移出」的照片会落到这里，原文件一直都在，随时能找回来。',
  },
};

export default function InboxPage() {
  const dataVersion = useApp((s) => s.dataVersion);
  const stats = useApp((s) => s.stats);
  const showToast = useApp((s) => s.showToast);
  const refreshStats = useApp((s) => s.refreshStats);
  const bumpData = useApp((s) => s.bumpData);

  const [tab, setTab] = useState<Tab>('inbox');
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const fetchingMore = useRef(false);

  const loadFirst = useCallback(async () => {
    setLoading(true);
    try {
      const page = await unwrap(api.photo.list({ status: [tab], limit: PAGE_SIZE }));
      setPhotos(page.items);
      setTotal(page.total);
      setCursor(page.nextCursor);
      setSelected(new Set());
      setViewerIndex(null);
    } catch (e) {
      showToast(errorText(e));
      setPhotos([]);
    } finally {
      setLoading(false);
    }
  }, [tab, showToast]);

  useEffect(() => {
    void loadFirst();
  }, [loadFirst, dataVersion]);

  const loadMore = useCallback(async () => {
    if (!cursor || fetchingMore.current) return;
    fetchingMore.current = true;
    try {
      const page = await unwrap(api.photo.list({ status: [tab], limit: PAGE_SIZE, cursor }));
      setPhotos((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        return [...prev, ...page.items.filter((p) => !seen.has(p.id))];
      });
      setCursor(page.nextCursor);
    } catch {
      /* ignore */
    } finally {
      fetchingMore.current = false;
    }
  }, [cursor, tab]);

  /** 审核：keep / reject；在已淘汰分区里则是 restore(inbox) */
  const review = useCallback(
    async (ids: number[], action: 'keep' | 'reject' | 'restore') => {
      if (!ids.length) return;
      try {
        await unwrap(api.inbox.review(ids, action === 'reject' ? 'reject' : 'keep'));

        const idSet = new Set(ids);
        const next = photos.filter((p) => !idSet.has(p.id));
        setPhotos(next);
        setTotal((t) => Math.max(0, t - ids.length));
        setSelected(new Set());
        setViewerIndex((v) => (v === null ? null : next.length === 0 ? null : Math.min(v, next.length - 1)));
        await refreshStats();
        bumpData();
        if (action === 'restore') showToast(`已恢复 ${ids.length} 张到正式库`);
      } catch (e) {
        showToast(errorText(e));
      }
    },
    [photos, refreshStats, bumpData, showToast]
  );

  const setStatus = useCallback(
    async (ids: number[], status: PhotoStatus) => {
      if (!ids.length) return;
      try {
        await unwrap(api.photo.setStatus(ids, status));
        const idSet = new Set(ids);
        setPhotos((prev) => prev.filter((p) => !idSet.has(p.id)));
        setTotal((t) => Math.max(0, t - ids.length));
        setSelected(new Set());
        setViewerIndex(null);
        await refreshStats();
        bumpData();
        showToast(`已把 ${ids.length} 张退回待审`);
      } catch (e) {
        showToast(errorText(e));
      }
    },
    [refreshStats, bumpData, showToast]
  );

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
        // 「收藏」这类智能相册的张数按规则现算，改完要重新取一遍
        bumpData();
      } catch (e) {
        showToast(errorText(e));
      }
    },
    [showToast, bumpData]
  );

  const text = TAB_TEXT[tab];
  const rejectedCount = stats?.rejected ?? 0;

  return (
    <>
      <header className="topbar">
        <div className="title-block">
          <span className="kicker">{text.kicker}</span>
          <h1>{text.title}</h1>
        </div>

        <div className="seg" role="tablist" aria-label="收件箱分区">
          <button
            role="tab"
            aria-selected={tab === 'inbox'}
            className={tab === 'inbox' ? 'on' : ''}
            onClick={() => setTab('inbox')}
          >
            待审 <b>{stats?.inbox ?? 0}</b>
          </button>
          <button
            role="tab"
            aria-selected={tab === 'rejected'}
            className={tab === 'rejected' ? 'on' : ''}
            onClick={() => setTab('rejected')}
          >
            已淘汰 <b>{rejectedCount}</b>
          </button>
        </div>

        <div className="count-block" title="当前分区照片数">
          <b>{total}</b>
          <span>张</span>
        </div>

        <div className="spacer" />

        <div className="topbar-tools">
          {tab === 'inbox' ? (
            <span className="hint wide-only">点开大图：← → 切换，Enter 保留，Delete 淘汰</span>
          ) : (
            <span className="hint wide-only">找回后照片进入正式库，不会再回到待审</span>
          )}
          <button
            className="btn btn-ghost"
            disabled={!photos.length}
            onClick={() => setSelected(new Set(photos.map((p) => p.id)))}
          >
            全选
          </button>
          <button
            className="btn btn-primary"
            disabled={!photos.length}
            onClick={() =>
              void review(
                photos.map((p) => p.id),
                tab === 'inbox' ? 'keep' : 'restore'
              )
            }
          >
            {tab === 'inbox' ? '全部保留' : '全部恢复'}
          </button>
        </div>
      </header>

      <div className="content">
        {photos.length > 0 ? (
          <PhotoGrid
            photos={photos}
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
                <span className="empty-index">{tab === 'inbox' ? '00' : '—'}</span>
                <h2>{text.empty}</h2>
                <p>{text.hint}</p>
              </>
            )}
          </div>
        )}
      </div>

      {selected.size > 0 && (
        <SelectionBar count={selected.size} onClear={() => setSelected(new Set())}>
          {tab === 'inbox' ? (
            <>
              <button className="btn btn-danger" onClick={() => void review([...selected], 'reject')}>
                淘汰
              </button>
              <button className="btn btn-primary" onClick={() => void review([...selected], 'keep')}>
                保留入库
              </button>
            </>
          ) : (
            <>
              <button className="btn" onClick={() => void setStatus([...selected], 'inbox')}>
                退回待审
              </button>
              <button className="btn btn-primary" onClick={() => void review([...selected], 'restore')}>
                恢复到正式库
              </button>
            </>
          )}
        </SelectionBar>
      )}

      {viewerIndex !== null && photos[viewerIndex] && (
        <PhotoViewer
          photos={photos}
          index={viewerIndex}
          onClose={() => setViewerIndex(null)}
          onIndexChange={setViewerIndex}
          onToggleFavorite={(id, next) => void toggleFavorite(id, next)}
          onKeep={(id) => void review([id], tab === 'inbox' ? 'keep' : 'restore')}
          onReject={tab === 'inbox' ? (id) => void review([id], 'reject') : undefined}
        />
      )}
    </>
  );
}

import { useCallback, useEffect, useState } from 'react';
import type { DuplicateGroup, DuplicateItem } from '@shared/ipc';
import { api, errorText, unwrap } from '../api';
import { useApp } from '../store';
import { formatBytes, formatDate } from '../format';

const THRESHOLDS = [
  { value: 0, label: '几乎完全一致' },
  { value: 3, label: '很相似（默认偏严）' },
  { value: 6, label: '相似' },
  { value: 7, label: '宽松（连拍会归到一起）' },
];

export default function DuplicatesPage() {
  const dataVersion = useApp((s) => s.dataVersion);
  const showToast = useApp((s) => s.showToast);
  const refreshStats = useApp((s) => s.refreshStats);
  const bumpData = useApp((s) => s.bumpData);

  const [distance, setDistance] = useState(6);
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<DuplicateItem | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setGroups(await unwrap(api.photo.duplicateGroups(distance)));
    } catch (e) {
      showToast(errorText(e));
      setGroups([]);
    } finally {
      setLoading(false);
    }
  }, [distance, showToast]);

  useEffect(() => {
    void load();
  }, [load, dataVersion]);

  const totalPhotos = groups.reduce((n, g) => n + g.items.length, 0);

  const reject = async (ids: number[], message: string): Promise<void> => {
    if (!ids.length || busy) return;
    setBusy(true);
    try {
      await unwrap(api.photo.setStatus(ids, 'rejected'));
      await refreshStats();
      bumpData();
      showToast(message);
      setPreview(null);
    } catch (e) {
      showToast(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const keepOnlyFirst = (group: DuplicateGroup): void => {
    const rest = group.items.slice(1).map((i) => i.photoId);
    void reject(rest, `保留 1 张，淘汰 ${rest.length} 张`);
  };

  return (
    <>
      <div className="topbar">
        <div className="title-block">
          <span className="kicker">查重</span>
          <h1>重复照片</h1>
        </div>
        <span className="sub">
          {loading ? '扫描中…' : `${groups.length} 组 · ${totalPhotos} 张`}
        </span>
        <div className="spacer" />
        <select
          className="select"
          value={String(distance)}
          onChange={(e) => setDistance(Number(e.target.value))}
          title="相似度阈值"
        >
          {THRESHOLDS.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <button className="btn" onClick={() => void load()} disabled={loading}>
          重新扫描
        </button>
      </div>

      <div className="content">
        {loading ? (
          <div className="empty-state">
            <h2>正在比对照片指纹…</h2>
            <p>按感知哈希聚类，只挑出看起来像同一张的，不会自动删任何东西。</p>
          </div>
        ) : groups.length === 0 ? (
          <div className="empty-state">
            <h2>没有发现重复或高度相似的照片</h2>
            <p>
              完全相同的文件在导入时就会被跳过，这里处理的是「同一张图的不同副本」——
              比如微信压缩过一遍、或者连拍产生的近似画面。换个阈值可以放宽或收紧。
            </p>
          </div>
        ) : (
          <div className="dup-scroll">
            <div className="dup-hint">
              每组第一张是建议保留的（分辨率最高 / 体积最大）。淘汰只是移出正式库，原文件不动。
            </div>
            {groups.map((group, index) => (
              <div className="dup-group" key={group.key}>
                <div className="dup-head">
                  <b>第 {index + 1} 组</b>
                  <span>
                    {group.items.length} 张 · 最大差异 {group.distance}
                  </span>
                  <div className="spacer" />
                  <button className="btn btn-ghost" disabled={busy} onClick={() => keepOnlyFirst(group)}>
                    只留推荐这张
                  </button>
                </div>
                <div className="dup-items">
                  {group.items.map((item, i) => (
                    <div className={`dup-item${i === 0 ? ' best' : ''}`} key={item.photoId}>
                      <button className="dup-thumb" onClick={() => setPreview(item)} title="查看大图">
                        <img src={item.thumbUrl} alt={item.fileName} loading="lazy" />
                        {i === 0 && <span className="dup-badge">推荐</span>}
                        {item.status === 'inbox' && <span className="dup-badge inbox">待审</span>}
                      </button>
                      <div className="dup-meta">
                        <div className="name" title={item.fileName}>
                          {item.fileName}
                        </div>
                        <div className="sub">
                          {item.width ?? '?'}×{item.height ?? '?'} · {formatBytes(item.size)} ·{' '}
                          {formatDate(item.takenAt)}
                        </div>
                      </div>
                      <div className="dup-actions">
                        <button className="btn btn-ghost" onClick={() => setPreview(item)}>
                          看看
                        </button>
                        <button
                          className="btn btn-danger"
                          disabled={busy}
                          onClick={() => void reject([item.photoId], '已淘汰这张')}
                        >
                          淘汰
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {preview && (
        <div className="dup-preview" onMouseDown={(e) => e.target === e.currentTarget && setPreview(null)}>
          <div className="dup-preview-inner">
            <img src={preview.previewUrl} alt={preview.fileName} />
            <div className="dup-preview-bar">
              <div>
                <b>{preview.fileName}</b>
                <span>
                  {preview.width ?? '?'}×{preview.height ?? '?'} · {formatBytes(preview.size)} ·{' '}
                  {formatDate(preview.takenAt)}
                </span>
              </div>
              <div className="spacer" />
              <button className="btn" onClick={() => setPreview(null)}>
                关闭
              </button>
              <button
                className="btn btn-danger"
                disabled={busy}
                onClick={() => void reject([preview.photoId], '已淘汰这张')}
              >
                淘汰这张
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

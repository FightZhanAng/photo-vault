import { useCallback, useEffect, useState } from 'react';
import type { LibraryAnalysis } from '@shared/ipc';
import { api, errorText, unwrap } from '../api';
import { useApp } from '../store';
import { formatBytes, formatDate } from '../format';
import Modal from '../components/Modal';

const STATUS_LABEL: Record<string, string> = {
  kept: '正式库',
  inbox: '收件箱',
  rejected: '已淘汰',
  archived: '已归档',
};

export default function StoragePage() {
  const dataVersion = useApp((s) => s.dataVersion);
  const library = useApp((s) => s.library);
  const showToast = useApp((s) => s.showToast);
  const bumpData = useApp((s) => s.bumpData);
  const reloadLibrary = useApp((s) => s.reloadLibrary);

  const [analysis, setAnalysis] = useState<LibraryAnalysis | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmClear, setConfirmClear] = useState(false);
  const [checking, setChecking] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setAnalysis(await unwrap(api.library.analysis()));
    } catch (e) {
      showToast(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void load();
  }, [load, dataVersion]);

  const clearCache = async (): Promise<void> => {
    try {
      const r = await unwrap(api.app.clearThumbCache());
      setConfirmClear(false);
      showToast(`已清掉 ${r.files} 个缩略图（${formatBytes(r.bytes)}），浏览时自动重建`);
      await load();
    } catch (e) {
      showToast(errorText(e));
    }
  };

  const checkMissing = async (): Promise<void> => {
    setChecking(true);
    try {
      const r = await unwrap(api.photo.checkMissing());
      showToast(r.missing ? `发现 ${r.missing} 张原文件不见了` : `检查 ${r.checked} 张，全都在`);
      await load();
      await reloadLibrary();
      bumpData();
    } catch (e) {
      showToast(errorText(e));
    } finally {
      setChecking(false);
    }
  };

  const yearMax = analysis ? Math.max(1, ...analysis.byYear.map((y) => y.bytes)) : 1;

  return (
    <>
      <div className="topbar">
        <div className="title-block">
          <span className="kicker">统计</span>
          <h1>存储分析</h1>
        </div>
        <span className="sub">{library?.name}</span>
        <div className="spacer" />
        <button className="btn" onClick={() => void checkMissing()} disabled={checking}>
          {checking ? '检查中…' : '检查原文件'}
        </button>
        <button className="btn" onClick={() => setConfirmClear(true)}>
          清理缓存
        </button>
        <button className="btn" onClick={() => void load()} disabled={loading}>
          刷新
        </button>
      </div>

      <div className="content">
        <div className="storage-scroll">
          {!analysis ? (
            <div className="empty-state">
              <h2>{loading ? '统计中…' : '没有数据'}</h2>
            </div>
          ) : (
            <>
              <div className="stat-grid">
                <div className="stat-card">
                  <span>照片总数</span>
                  <b>{analysis.totalPhotos}</b>
                  <em>
                    正式库 {analysis.byStatus.find((s) => s.status === 'kept')?.count ?? 0} · 收件箱{' '}
                    {analysis.byStatus.find((s) => s.status === 'inbox')?.count ?? 0}
                  </em>
                </div>
                <div className="stat-card">
                  <span>占用空间</span>
                  <b>{formatBytes(analysis.totalBytes)}</b>
                  <em>平均 {formatBytes(analysis.totalPhotos ? analysis.totalBytes / analysis.totalPhotos : 0)} / 张</em>
                </div>
                <div className="stat-card">
                  <span>拍摄跨度</span>
                  <b className="small">
                    {analysis.takenFrom ? formatDate(analysis.takenFrom) : '—'}
                    <i> → </i>
                    {analysis.takenTo ? formatDate(analysis.takenTo) : '—'}
                  </b>
                  <em>
                    有定位 {analysis.gpsCount} · 收藏 {analysis.favoriteCount}
                  </em>
                </div>
                <div className="stat-card">
                  <span>缩略图缓存</span>
                  <b>{formatBytes(analysis.thumbBytes)}</b>
                  <em>
                    {analysis.thumbCount} 个文件{analysis.missing ? ` · ${analysis.missing} 张原图丢失` : ''}
                  </em>
                </div>
              </div>

              <div className="card">
                <h3>按年份</h3>
                {analysis.byYear.length === 0 && <div className="preview-empty">还没有照片</div>}
                {analysis.byYear.map((y) => (
                  <div className="bar-row" key={y.label}>
                    <span className="bar-label">{y.label}</span>
                    <div className="bar-track">
                      <i style={{ width: `${Math.max(2, (y.bytes / yearMax) * 100)}%` }} />
                    </div>
                    <span className="bar-value">{formatBytes(y.bytes)}</span>
                    <span className="bar-count">{y.count} 张</span>
                  </div>
                ))}
              </div>

              <div className="two-col">
                <div className="card">
                  <h3>按格式</h3>
                  {analysis.byExt.map((e) => (
                    <div className="kv" key={e.label}>
                      <span>{e.label}</span>
                      <b>
                        {e.count} 张 · {formatBytes(e.bytes)}
                      </b>
                    </div>
                  ))}
                </div>
                <div className="card">
                  <h3>明细</h3>
                  {analysis.byStatus.map((s) => (
                    <div className="kv" key={s.status}>
                      <span>{STATUS_LABEL[s.status] ?? s.status}</span>
                      <b>
                        {s.count} 张 · {formatBytes(s.bytes)}
                      </b>
                    </div>
                  ))}
                  <div className="kv">
                    <span>带相机信息</span>
                    <b>{analysis.cameraCount} 张</b>
                  </div>
                  <div className="kv">
                    <span>原文件缺失</span>
                    <b className={analysis.missing ? 'danger-text' : ''}>{analysis.missing} 张</b>
                  </div>
                </div>
              </div>

              <div className="card">
                <h3>最占空间的照片</h3>
                {analysis.largest.length === 0 && <div className="preview-empty">还没有照片</div>}
                <div className="largest-list">
                  {analysis.largest.map((p, i) => (
                    <div className="largest-row" key={p.photoId}>
                      <span className="rank">{i + 1}</span>
                      <img src={p.thumbUrl} alt={p.fileName} loading="lazy" />
                      <div className="meta">
                        <div className="name" title={p.fileName}>
                          {p.fileName}
                        </div>
                        <div className="sub">
                          {p.width ?? '?'}×{p.height ?? '?'}
                        </div>
                      </div>
                      <b>{formatBytes(p.size)}</b>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {confirmClear && (
        <Modal
          title="清理缩略图缓存"
          onClose={() => setConfirmClear(false)}
          width={430}
          footer={
            <>
              <div className="spacer" />
              <button className="btn btn-ghost" onClick={() => setConfirmClear(false)}>
                取消
              </button>
              <button className="btn btn-primary" onClick={() => void clearCache()}>
                清理
              </button>
            </>
          }
        >
          <p className="hint">
            只会删掉 .vault/thumbs 下的缓存文件，原图不动。删掉后第一次浏览会重新生成，
            大约每张 20 毫秒，滚动时可能短暂看到占位。
          </p>
        </Modal>
      )}
    </>
  );
}

import { useCallback, useEffect, useState } from 'react';
import type { ImportBatch } from '@shared/ipc';
import { api, errorText, unwrap } from '../api';
import { useApp } from '../store';
import { formatDateTime } from '../format';
import ConfirmDialog from '../dialogs/ConfirmDialog';

const STATE_TEXT: Record<ImportBatch['state'], string> = {
  running: '进行中',
  done: '已完成',
  cancelled: '已取消',
  failed: '失败',
};

function isRolledBack(b: ImportBatch): boolean {
  return b.state === 'cancelled' && b.error === '已撤销';
}

function folderName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export default function ImportHistoryPage() {
  const dataVersion = useApp((s) => s.dataVersion);
  const showToast = useApp((s) => s.showToast);
  const bumpData = useApp((s) => s.bumpData);
  const refreshStats = useApp((s) => s.refreshStats);
  const refreshAlbums = useApp((s) => s.refreshAlbums);

  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState<ImportBatch | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setBatches(await unwrap(api.import.batches(60)));
    } catch (e) {
      showToast(errorText(e));
      setBatches([]);
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    void load();
  }, [load, dataVersion]);

  const rollback = async (): Promise<void> => {
    if (!target) return;
    const r = await unwrap(api.import.rollback(target.id));
    await load();
    await refreshStats();
    await refreshAlbums();
    bumpData();
    showToast(`已撤销，移除 ${r.removed} 张记录（原文件没动）`);
  };

  return (
    <>
      <header className="topbar">
        <div className="title-block">
          <span className="kicker">记录</span>
          <h1>导入记录</h1>
        </div>
        <div className="count-block" title="最近 60 次导入">
          <b>{batches.length}</b>
          <span>批</span>
        </div>
        <div className="spacer" />
        <div className="topbar-tools">
          <span className="hint wide-only">撤销只删库里的记录和缩略图，磁盘上的原图不动</span>
          <button className="btn btn-ghost" onClick={() => void load()}>
            刷新
          </button>
        </div>
      </header>

      <div className="content">
        {batches.length === 0 ? (
          <div className="empty-state">
            {loading ? (
              <>
                <span className="empty-rule" />
                <h2>正在读取…</h2>
              </>
            ) : (
              <>
                <span className="empty-index">00</span>
                <h2>还没有导入过</h2>
                <p>每次导入文件夹都会在这里留一条记录，导错了可以整批撤销。</p>
              </>
            )}
          </div>
        ) : (
          <div className="page-scroll">
            <div className="batch-list">
              {batches.map((b) => {
                const undone = isRolledBack(b);
                return (
                  <div className={`batch-row${undone ? ' undone' : ''}`} key={b.id}>
                    <div className="batch-main">
                      <div className="batch-title">
                        <b title={b.sourcePath}>{folderName(b.sourcePath)}</b>
                        <span className={`batch-state s-${undone ? 'undone' : b.state}`}>
                          {undone ? '已撤销' : STATE_TEXT[b.state]}
                        </span>
                      </div>
                      <div className="batch-path mono" title={b.sourcePath}>
                        {b.sourcePath}
                      </div>
                      <div className="batch-meta">
                        <span>{formatDateTime(b.startedAt)}</span>
                        {b.finishedAt ? <span>用时 {Math.max(1, Math.round((b.finishedAt - b.startedAt) / 1000))} 秒</span> : null}
                        {b.error && !undone ? <span className="danger-text">{b.error}</span> : null}
                      </div>
                    </div>

                    <div className="batch-stats">
                      <div>
                        <b>{b.added}</b>
                        <span>新增</span>
                      </div>
                      <div>
                        <b>{b.skippedDup}</b>
                        <span>跳过</span>
                      </div>
                      <div>
                        <b className={b.failed > 0 ? 'danger-text' : ''}>{b.failed}</b>
                        <span>失败</span>
                      </div>
                    </div>

                    <div className="batch-actions">
                      {b.state === 'done' && b.added > 0 && !undone ? (
                        <button className="btn btn-ghost" onClick={() => setTarget(b)}>
                          撤销这批
                        </button>
                      ) : (
                        <span className="hint">{undone ? '已还原' : '—'}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {target && (
        <ConfirmDialog
          title="撤销这次导入"
          danger
          confirmLabel={`撤销 ${target.added} 张`}
          onClose={() => setTarget(null)}
          onConfirm={rollback}
        >
          <p>
            会把这次导入入库的 <b>{target.added}</b> 张照片从库里移除，连同缩略图缓存。
          </p>
          <p className="hint">
            来源目录「{folderName(target.sourcePath)}」里的原文件不会被删除或移动，之后还能重新导入。
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}

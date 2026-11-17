import { useState } from 'react';
import { api, unwrap } from '../api';
import { useApp } from '../store';
import Modal from '../components/Modal';

type Mode = 'reject' | 'purge';

/**
 * 「移出」的两种语义在这里分开摆明：
 * - reject：状态改成已淘汰，记录还在，能从收件箱找回来
 * - purge：删掉库里的记录；收纳模式下连原文件一起移进库内回收站
 * 之前界面上只有一个「移出」，用户没法知道原文件到底动没动。
 */
export default function RemoveDialog({
  photoIds,
  onClose,
  onDone,
}: {
  photoIds: number[];
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const library = useApp((s) => s.library);
  const [mode, setMode] = useState<Mode>('reject');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const managed = library?.mode === 'managed';
  const count = photoIds.length;

  const run = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'reject') {
        await unwrap(api.photo.setStatus(photoIds, 'rejected'));
        onDone(`已移出 ${count} 张，可在收件箱「已淘汰」里找回`);
      } else {
        const r = await unwrap(api.photo.remove(photoIds, { deleteFile: managed }));
        onDone(
          managed
            ? `已彻底移出 ${r.removed} 张，原文件已移到库内回收站`
            : `已彻底移出 ${r.removed} 张，磁盘上的原文件没动`
        );
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`移出 ${count} 张`}
      subtitle="选一种：能找回，还是彻底不要了"
      onClose={onClose}
      width={470}
      locked={busy}
      footer={
        <>
          <div className="spacer" />
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            className={`btn ${mode === 'purge' ? 'btn-danger' : 'btn-primary'}`}
            onClick={() => void run()}
            disabled={busy}
          >
            {busy ? '处理中…' : mode === 'purge' ? `彻底移出 ${count} 张` : `移出 ${count} 张`}
          </button>
        </>
      }
    >
      <div className="choice-list">
        <button
          className={`choice${mode === 'reject' ? ' on' : ''}`}
          onClick={() => setMode('reject')}
          aria-pressed={mode === 'reject'}
        >
          <b>移出到「已淘汰」</b>
          <span>记录还在，随时能在收件箱的已淘汰分区里找回来。原文件不动。</span>
        </button>

        <button
          className={`choice${mode === 'purge' ? ' on danger' : ''}`}
          onClick={() => setMode('purge')}
          aria-pressed={mode === 'purge'}
        >
          <b>彻底移出{managed ? '（文件进回收站）' : '（只删索引）'}</b>
          <span>
            {managed
              ? '删除库里的记录，并把原文件移到本库的 .vault/trash 目录，不会直接抹掉。'
              : '删除库里的记录。当前是引用模式，磁盘上的原文件完全不动。'}
          </span>
        </button>
      </div>

      {mode === 'purge' && (
        <p className="hint">这个操作不能从界面撤销 —— 需要的话得重新导入。</p>
      )}
      {error && <p className="danger-text">{error}</p>}
    </Modal>
  );
}

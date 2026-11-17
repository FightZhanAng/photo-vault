import { useEffect, useState } from 'react';
import type { RenamePreview } from '@shared/ipc';
import { api, errorText, unwrap } from '../api';
import { useApp } from '../store';
import Modal from '../components/Modal';

interface RenameDialogProps {
  photoIds: number[];
  onClose: () => void;
  onDone: () => void;
}

const PRESETS = ['{date}_{seq}', '{date}_{time}', '{name}', '旅行_{date}_{seq}'];

export default function RenameDialog({ photoIds, onClose, onDone }: RenameDialogProps) {
  const showToast = useApp((s) => s.showToast);
  const bumpData = useApp((s) => s.bumpData);

  const [template, setTemplate] = useState('{date}_{seq}');
  const [preview, setPreview] = useState<RenamePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const data = await unwrap(api.photo.renamePreview(photoIds, template));
          if (alive) {
            setPreview(data);
            setError(null);
          }
        } catch (e) {
          if (alive) {
            setPreview(null);
            setError(errorText(e));
          }
        }
      })();
    }, 220);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [photoIds, template]);

  const apply = async (): Promise<void> => {
    setRunning(true);
    try {
      const r = await unwrap(api.photo.rename(photoIds, template));
      bumpData();
      showToast(
        r.failed > 0
          ? `改名 ${r.renamed} 张，${r.failed} 张失败`
          : r.unchanged > 0
            ? `已改名 ${r.renamed} 张（${r.unchanged} 张名字本来就一样）`
            : `已改名 ${r.renamed} 张`
      );
      onDone();
      onClose();
    } catch (e) {
      showToast(errorText(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
      title="批量重命名"
      subtitle={`${photoIds.length} 张 · 只改文件名，不改内容、不移动目录`}
      onClose={onClose}
      locked={running}
      width={560}
      footer={
        <>
          <span className="hint">可用占位符：{'{date} {time} {seq} {name} {camera}'}</span>
          <div className="spacer" />
          <button className="btn btn-ghost" onClick={onClose} disabled={running}>
            取消
          </button>
          <button className="btn btn-primary" onClick={() => void apply()} disabled={running || !!error}>
            {running ? '正在改名…' : '开始改名'}
          </button>
        </>
      }
    >
      <label className="field">
        <span>命名模板</span>
        <input
          className="input"
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
          placeholder="{date}_{seq}"
          spellCheck={false}
        />
      </label>

      <div className="preset-row">
        {PRESETS.map((p) => (
          <button key={p} className={`chip-toggle${template === p ? ' on' : ''}`} onClick={() => setTemplate(p)}>
            {p}
          </button>
        ))}
      </div>

      {error && <div className="form-error">{error}</div>}

      <div className="preview-box">
        <div className="preview-head">预览（前 6 条）</div>
        {preview?.rows.slice(0, 6).map((row) => (
          <div className="rename-row" key={row.photoId}>
            <span className="from" title={row.from}>
              {row.from}
            </span>
            <span className="arrow">→</span>
            <span className="to" title={row.to}>
              {row.to}
              {row.conflict && <em>（重名，将加后缀）</em>}
            </span>
          </div>
        ))}
        {!preview && !error && <div className="preview-empty">计算中…</div>}
      </div>
    </Modal>
  );
}

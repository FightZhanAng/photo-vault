import { useEffect, useState } from 'react';
import type { ExportFormat, ExportProgress } from '@shared/ipc';
import { api, errorText, unwrap } from '../api';
import { useApp, PREF } from '../store';
import Modal from '../components/Modal';
import { formatBytes } from '../format';

interface ExportDialogProps {
  photoIds: number[];
  defaultTitle: string;
  onClose: () => void;
}

const MAX_SIZE_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: '原尺寸' },
  { value: 3840, label: '3840（4K）' },
  { value: 2560, label: '2560' },
  { value: 1920, label: '1920（常用）' },
  { value: 1280, label: '1280（发微信）' },
];

export default function ExportDialog({ photoIds, defaultTitle, onClose }: ExportDialogProps) {
  const showToast = useApp((s) => s.showToast);

  const [mode, setMode] = useState<'files' | 'html'>('files');
  const [dest, setDest] = useState('');
  const [format, setFormat] = useState<ExportFormat>(() => {
    const pref = useApp.getState().prefs[PREF.exportFormat];
    return pref === 'original' || pref === 'jpeg' || pref === 'webp' || pref === 'png'
      ? (pref as ExportFormat)
      : 'jpeg';
  });
  const [maxSize, setMaxSize] = useState<number | null>(1920);
  const [quality, setQuality] = useState(88);
  const [strip, setStrip] = useState(false);
  const [title, setTitle] = useState(defaultTitle || '我的相册');

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    const off = api.photo.onExportProgress((p) => setProgress(p));
    return off;
  }, []);

  const pick = async (): Promise<void> => {
    try {
      const folder = await unwrap(api.library.pickFolder());
      if (folder) setDest(folder);
    } catch (e) {
      showToast(errorText(e));
    }
  };

  const run = async (): Promise<void> => {
    if (!dest) {
      showToast('先选一个导出目录');
      return;
    }
    setRunning(true);
    setProgress({ done: 0, total: photoIds.length, currentFile: '', phase: 'running' });
    try {
      if (mode === 'html') {
        const r = await unwrap(
          api.app.exportHtmlAlbum({ photoIds, destDir: dest, title: title.trim() || '我的相册' })
        );
        setDone(`已生成 ${r.count} 张的离线相册（${formatBytes(r.bytes)}）\n${r.indexPath}`);
        showToast('离线相册已生成');
      } else {
        const r = await unwrap(
          api.photo.export({
            photoIds,
            destDir: dest,
            format,
            maxSize,
            quality,
            stripMetadata: strip,
          })
        );
        setDone(
          `已完成 ${r.exported} 张（${formatBytes(r.totalBytes)}）${
            r.failed ? `，${r.failed} 张失败` : ''
          }\n${r.destDir}`
        );
        showToast(r.failed ? `导出 ${r.exported} 张，失败 ${r.failed} 张` : `已导出 ${r.exported} 张`);
      }
    } catch (e) {
      showToast(errorText(e));
      setProgress(null);
    } finally {
      setRunning(false);
    }
  };

  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <Modal
      title="导出照片"
      subtitle={`${photoIds.length} 张`}
      onClose={onClose}
      locked={running}
      width={540}
      footer={
        <>
          <div className="spacer" />
          <button className="btn btn-ghost" onClick={onClose} disabled={running}>
            {done ? '关闭' : '取消'}
          </button>
          <button className="btn btn-primary" onClick={() => void run()} disabled={running || !!done}>
            {running ? '导出中…' : mode === 'html' ? '生成相册页' : '开始导出'}
          </button>
        </>
      }
    >
      <div className="segmented">
        <button className={mode === 'files' ? 'on' : ''} onClick={() => setMode('files')} disabled={running}>
          图片文件
        </button>
        <button className={mode === 'html' ? 'on' : ''} onClick={() => setMode('html')} disabled={running}>
          离线相册页
        </button>
      </div>

      {mode === 'files' ? (
        <>
          <label className="field">
            <span>导出到</span>
            <div className="row">
              <input className="input" value={dest} readOnly placeholder="选择一个空目录" />
              <button className="btn" onClick={() => void pick()} disabled={running}>
                选择…
              </button>
            </div>
          </label>

          <div className="field-row">
            <label className="field">
              <span>格式</span>
              <select
                className="select"
                value={format}
                onChange={(e) => setFormat(e.target.value as ExportFormat)}
                disabled={running || maxSize === null}
              >
                <option value="jpeg">JPEG（通用）</option>
                <option value="webp">WebP（更小）</option>
                <option value="png">PNG（无损）</option>
                <option value="original">原样复制（不转码）</option>
              </select>
            </label>
            <label className="field">
              <span>长边上限</span>
              <select
                className="select"
                value={String(maxSize)}
                onChange={(e) => setMaxSize(e.target.value === 'null' ? null : Number(e.target.value))}
                disabled={running || format === 'original'}
              >
                {MAX_SIZE_OPTIONS.map((o) => (
                  <option key={String(o.value)} value={String(o.value)}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {format !== 'original' && (
            <label className="field">
              <span>质量 {quality}</span>
              <input
                type="range"
                min={40}
                max={100}
                value={quality}
                onChange={(e) => setQuality(Number(e.target.value))}
                disabled={running}
              />
            </label>
          )}

          <label className="check-row">
            <input type="checkbox" checked={strip} onChange={(e) => setStrip(e.target.checked)} disabled={running} />
            <span>去掉 EXIF 等元数据（默认保留拍摄信息）</span>
          </label>

          <div className="hint">
            原样复制不重新编码，速度最快；转码会摆正方向并按长边缩放，体积通常能小一半以上。
          </div>
        </>
      ) : (
        <>
          <label className="field">
            <span>相册标题</span>
            <input
              className="input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={running}
            />
          </label>
          <label className="field">
            <span>导出到</span>
            <div className="row">
              <input className="input" value={dest} readOnly placeholder="选择父目录" />
              <button className="btn" onClick={() => void pick()} disabled={running}>
                选择…
              </button>
            </div>
          </label>
          <div className="hint">
            会新建一个以标题命名的文件夹，里面有 index.html 和 files/ 目录。照片转成 JPEG
            （长边 2000），整份拷走也能双击打开，不依赖这个应用。
          </div>
        </>
      )}

      {(running || (progress && progress.phase === 'running')) && (
        <div className="progress-block">
          <div className="progress-line">
            <span>{progress?.currentFile || '准备中…'}</span>
            <b>
              {progress?.done ?? 0} / {progress?.total ?? photoIds.length}
            </b>
          </div>
          <div className="track">
            <i style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      {done && <div className="success-box">{done}</div>}
    </Modal>
  );
}

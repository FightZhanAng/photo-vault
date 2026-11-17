import { useCallback, useEffect, useState } from 'react';
import type { CollectTask, TaskUploadInfo } from '@shared/ipc';
import { api, errorText, unwrap } from '../api';
import { useApp } from '../store';
import Modal from '../components/Modal';
import { copyText, formatBytes } from '../format';

interface UploadDialogProps {
  task: CollectTask;
  onClose: () => void;
}

export default function UploadDialog({ task, onClose }: UploadDialogProps) {
  const showToast = useApp((s) => s.showToast);
  const refreshUpload = useApp((s) => s.refreshUpload);
  const upload = useApp((s) => s.upload);

  const [info, setInfo] = useState<TaskUploadInfo | null>(null);
  const [port, setPort] = useState('8787');
  const [starting, setStarting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [confirmReset, setConfirmReset] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      setInfo(await unwrap(api.task.uploadInfo(task.id)));
    } catch (e) {
      showToast(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [task.id, showToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const startServer = async (): Promise<void> => {
    setStarting(true);
    try {
      await unwrap(api.upload.start(Number(port) || 8787));
      await refreshUpload();
      await load();
      showToast('上传服务已启动');
    } catch (e) {
      showToast(errorText(e));
    } finally {
      setStarting(false);
    }
  };

  const copy = async (text: string): Promise<void> => {
    const ok = await copyText(text);
    showToast(ok ? '链接已复制' : '复制失败，请手动选中');
  };

  const reset = async (): Promise<void> => {
    try {
      const next = await unwrap(api.task.resetToken(task.id));
      setInfo(next);
      setConfirmReset(false);
      showToast('旧链接已失效，新链接已生成');
    } catch (e) {
      showToast(errorText(e));
    }
  };

  const running = info?.urls.length ? true : false;
  const primary = info?.urls[0] ?? null;

  return (
    <Modal
      title="手机上传入口"
      subtitle={task.name}
      onClose={onClose}
      width={520}
      footer={
        <>
          <button className="btn btn-ghost" onClick={() => void load()} disabled={loading}>
            刷新
          </button>
          <div className="spacer" />
          <button className="btn" onClick={() => void copy(primary ?? '')} disabled={!primary}>
            复制链接
          </button>
          <button className="btn btn-primary" onClick={onClose}>
            完成
          </button>
        </>
      }
    >
      {!running && (
        <div className="upload-offline">
          <div className="upload-offline-title">
            {upload?.running === false || !running ? '上传服务还没启动' : '正在获取地址…'}
          </div>
          <p className="hint">
            启动后，同一 Wi-Fi 下的手机扫码就能上传。服务只在本机运行，照片不经过互联网。
          </p>
          <div className="row">
            <label className="field" style={{ width: 130 }}>
              <span>端口</span>
              <input className="input" value={port} onChange={(e) => setPort(e.target.value)} />
            </label>
            <button className="btn btn-primary" onClick={() => void startServer()} disabled={starting}>
              {starting ? '启动中…' : '启动上传服务'}
            </button>
          </div>
        </div>
      )}

      {running && info && (
        <>
          <div className="qr-wrap">
            {info.qrDataUrl ? (
              <img src={info.qrDataUrl} alt="上传二维码" />
            ) : (
              <div className="qr-placeholder">二维码不可用</div>
            )}
            <div className="qr-side">
              <div className="qr-title">扫一扫上传</div>
              <div className="qr-url mono">{primary}</div>
              <button className="btn" onClick={() => void copy(primary ?? '')}>
                复制链接
              </button>
              <div className="hint" style={{ marginTop: 10 }}>
                手机和电脑要连同一个 Wi-Fi。打不开时检查防火墙是否拦了 {info.urls[0]?.split(':').pop()} 端口。
              </div>
            </div>
          </div>

          {info.urls.length > 1 && (
            <div className="field" style={{ marginTop: 14 }}>
              <span>其它网卡地址</span>
              {info.urls.slice(1).map((url) => (
                <div className="url-row" key={url}>
                  <span className="mono">{url}</span>
                  <button className="link-btn" onClick={() => void copy(url)}>
                    复制
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="uploader-block">
            <div className="preview-head">
              谁传的 · 共 {info.task.photoCount} 张
              <span className="sub">（含本地导入）</span>
            </div>
            {info.uploaders.length === 0 && <div className="preview-empty">还没有人上传</div>}
            {info.uploaders.map((u, i) => (
              <div className="uploader-row" key={`${u.label ?? 'anon'}-${i}`}>
                <span className="who">{u.label || '未署名'}</span>
                <span className="cnt">{u.count} 张</span>
                <span className="sz">{formatBytes(u.bytes)}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {!running && loading && <div className="preview-empty">读取中…</div>}

      <div className="popover-foot" style={{ marginTop: 14 }}>
        {confirmReset ? (
          <div className="row">
            <span className="hint">重置后旧链接和二维码立刻失效，确定？</span>
            <div className="spacer" />
            <button className="btn btn-ghost" onClick={() => setConfirmReset(false)}>
              取消
            </button>
            <button className="btn btn-danger" onClick={() => void reset()}>
              确定重置
            </button>
          </div>
        ) : (
          <button className="link-btn" onClick={() => setConfirmReset(true)}>
            重置上传链接
          </button>
        )}
      </div>
    </Modal>
  );
}

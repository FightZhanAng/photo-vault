import { useState } from 'react';
import type { CollectTask } from '@shared/ipc';
import { api, errorText, unwrap } from '../api';
import { useApp } from '../store';
import Modal from '../components/Modal';
import { fromDatetimeLocal, toDatetimeLocal } from '../format';

interface TaskDialogProps {
  task?: CollectTask | null;
  onClose: () => void;
  onDone?: (task: CollectTask) => void;
}

export default function TaskDialog({ task, onClose, onDone }: TaskDialogProps) {
  const albums = useApp((s) => s.albums);
  const refreshTasks = useApp((s) => s.refreshTasks);
  const showToast = useApp((s) => s.showToast);

  const [name, setName] = useState(task?.name ?? '');
  const [note, setNote] = useState(task?.note ?? '');
  const [target, setTarget] = useState(task?.targetCount ? String(task.targetCount) : '');
  const [deadline, setDeadline] = useState(toDatetimeLocal(task?.deadlineAt ?? null));
  const [albumId, setAlbumId] = useState(task?.defaultAlbumId ? String(task.defaultAlbumId) : '');
  const [busy, setBusy] = useState(false);

  const submit = async (): Promise<void> => {
    if (!name.trim()) {
      showToast('任务名不能为空');
      return;
    }
    setBusy(true);
    try {
      const payload = {
        name: name.trim(),
        note: note.trim(),
        targetCount: target ? Number(target) : null,
        deadlineAt: fromDatetimeLocal(deadline),
        defaultAlbumId: albumId ? Number(albumId) : null,
      };
      const saved = task
        ? await unwrap(api.task.patch(task.id, payload))
        : await unwrap(api.task.create(payload));
      await refreshTasks();
      showToast(task ? '任务已更新' : `任务「${saved.name}」已创建`);
      onDone?.(saved);
      onClose();
    } catch (e) {
      showToast(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={task ? '编辑收集任务' : '新建收集任务'}
      subtitle="一个任务 = 一次活动，照片会带着来源标注进收件箱"
      onClose={onClose}
      locked={busy}
      width={520}
      footer={
        <>
          <div className="spacer" />
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={busy}>
            {busy ? '保存中…' : task ? '保存' : '创建任务'}
          </button>
        </>
      }
    >
      <label className="field">
        <span>任务名称</span>
        <input
          className="input"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例如：小张婚礼 · 亲友照片"
        />
      </label>

      <label className="field">
        <span>给上传者看的说明（可选）</span>
        <textarea
          className="input textarea"
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="例如：欢迎随手拍的照片，原图最好，截止到周日晚。"
        />
      </label>

      <div className="field-row">
        <label className="field">
          <span>目标张数（可选）</span>
          <input
            className="input"
            type="number"
            min={1}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder="500"
          />
        </label>
        <label className="field">
          <span>截止时间（可选）</span>
          <input
            className="input"
            type="datetime-local"
            value={deadline}
            onChange={(e) => setDeadline(e.target.value)}
          />
        </label>
      </div>

      <label className="field">
        <span>收到的照片同时放进相册（可选）</span>
        <select className="select" value={albumId} onChange={(e) => setAlbumId(e.target.value)}>
          <option value="">不自动加入</option>
          {albums
            .filter((a) => a.kind === 'manual')
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
        </select>
      </label>

      <div className="hint">
        创建后可以在任务卡片里拿到上传链接和二维码，手机连同一个 Wi-Fi 就能传，不用装应用。
      </div>
    </Modal>
  );
}

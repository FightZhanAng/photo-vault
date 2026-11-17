import { useEffect, useState } from 'react';
import type { CollectTask, UploaderStat } from '@shared/ipc';
import { api, errorText, unwrap } from '../api';
import { useApp } from '../store';
import { daysLeft, formatDateTime } from '../format';
import UploadDialog from '../dialogs/UploadDialog';

interface TaskStripProps {
  taskId: number;
}

export default function TaskStrip({ taskId }: TaskStripProps) {
  const dataVersion = useApp((s) => s.dataVersion);
  const showToast = useApp((s) => s.showToast);
  const refreshTasks = useApp((s) => s.refreshTasks);
  const bumpData = useApp((s) => s.bumpData);
  const [task, setTask] = useState<CollectTask | null>(null);
  const [uploaders, setUploaders] = useState<UploaderStat[]>([]);
  const [uploadOpen, setUploadOpen] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const list = await unwrap(api.task.list(true));
        setTask(list.find((t) => t.id === taskId) ?? null);
        setUploaders(await unwrap(api.task.uploaders(taskId)));
      } catch {
        /* 忽略 */
      }
    })();
  }, [taskId, dataVersion]);

  const importInto = async (): Promise<void> => {
    try {
      const folder = await unwrap(api.library.pickFolder());
      if (!folder) return;
      await unwrap(
        api.import.start({ sourcePath: folder, recursive: true, taskId, sourceLabel: '本地文件夹' })
      );
      showToast('已开始导入，完成后进收件箱');
      await refreshTasks();
      bumpData();
    } catch (e) {
      showToast(errorText(e));
    }
  };

  if (!task) return null;

  const pct = task.targetCount
    ? Math.min(100, Math.round((task.photoCount / task.targetCount) * 100))
    : 0;

  return (
    <>
      <div className="task-strip">
        <div className="task-main">
          <div className="task-name">
            {task.name}
            {task.state === 'closed' && <span className="badge">已结束</span>}
          </div>
          <div className="task-sub">
            {task.targetCount
              ? `已收 ${task.photoCount} / ${task.targetCount} 张 · ${pct}%`
              : `已收 ${task.photoCount} 张`}
            {' · '}
            待审 {task.inboxCount} · 入库 {task.keptCount}
            {task.deadlineAt ? ` · ${formatDateTime(task.deadlineAt)}（${daysLeft(task.deadlineAt)}）` : ''}
          </div>
          {task.targetCount ? (
            <div className="task-progress">
              <i style={{ width: `${pct}%` }} />
            </div>
          ) : null}
        </div>

        <div className="task-uploaders">
          {uploaders.slice(0, 4).map((u, i) => (
            <span className="uploader-chip" key={`${u.label ?? 'anon'}-${i}`} title={formatBytes(u.bytes)}>
              {u.label || '未署名'} {u.count}
            </span>
          ))}
          {uploaders.length === 0 && <span className="hint">还没有上传记录</span>}
        </div>

        <div className="row">
          <button className="btn" onClick={() => setUploadOpen(true)}>
            上传入口
          </button>
          <button className="btn" onClick={() => void importInto()}>
            导入文件夹
          </button>
        </div>
      </div>

      {uploadOpen && <UploadDialog task={task} onClose={() => setUploadOpen(false)} />}
    </>
  );
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

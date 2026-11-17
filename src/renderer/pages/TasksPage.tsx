import { useState } from 'react';
import type { CollectTask } from '@shared/ipc';
import { api, errorText, unwrap } from '../api';
import { useApp } from '../store';
import { daysLeft, formatDateTime } from '../format';
import TaskDialog from '../dialogs/TaskDialog';
import UploadDialog from '../dialogs/UploadDialog';
import Modal from '../components/Modal';

export default function TasksPage() {
  const tasks = useApp((s) => s.tasks);
  const upload = useApp((s) => s.upload);
  const setView = useApp((s) => s.setView);
  const refreshTasks = useApp((s) => s.refreshTasks);
  const refreshUpload = useApp((s) => s.refreshUpload);
  const showToast = useApp((s) => s.showToast);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<CollectTask | null>(null);
  const [uploadTask, setUploadTask] = useState<CollectTask | null>(null);
  const [pendingDelete, setPendingDelete] = useState<CollectTask | null>(null);
  const [starting, setStarting] = useState(false);
  const [showClosed, setShowClosed] = useState(false);

  const open = tasks.filter((t) => t.state === 'open');
  const closed = tasks.filter((t) => t.state === 'closed');

  const toggleServer = async (): Promise<void> => {
    setStarting(true);
    try {
      if (upload?.running) {
        await unwrap(api.upload.stop());
        showToast('上传服务已停止');
      } else {
        const status = await unwrap(api.upload.start());
        showToast(status.urls[0] ? `上传服务已启动：${status.urls[0]}` : '上传服务已启动');
      }
      await refreshUpload();
    } catch (e) {
      showToast(errorText(e));
    } finally {
      setStarting(false);
    }
  };

  const closeTask = async (task: CollectTask): Promise<void> => {
    try {
      await unwrap(api.task.close(task.id));
      await refreshTasks();
      showToast(`「${task.name}」已结束收集`);
    } catch (e) {
      showToast(errorText(e));
    }
  };

  const removeTask = async (task: CollectTask): Promise<void> => {
    try {
      await unwrap(api.task.remove(task.id));
      await refreshTasks();
      showToast('任务已删除（照片保留）');
      setPendingDelete(null);
    } catch (e) {
      showToast(errorText(e));
    }
  };

  return (
    <>
      <div className="topbar">
        <div className="title-block">
          <span className="kicker">收集</span>
          <h1>收集任务</h1>
        </div>
        <span className="sub">{open.length} 个进行中</span>
        <div className="spacer" />
        <span className={`server-chip${upload?.running ? ' on' : ''}`}>
          <i />
          {upload?.running ? `上传服务运行中 · ${upload.port}` : '上传服务未启动'}
        </span>
        <button className="btn" onClick={() => void toggleServer()} disabled={starting}>
          {upload?.running ? '停止服务' : '启动服务'}
        </button>
        <button
          className="btn btn-primary"
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        >
          新建任务
        </button>
      </div>

      <div className="content">
        <div className="tasks-scroll">
          {!upload?.running && (
            <div className="notice">
              上传服务没启动时，任务链接和二维码打不开。点右上角「启动服务」，手机连同一个
              Wi-Fi 就能往这里传照片。
            </div>
          )}

          {open.length === 0 && (
            <div className="empty-state" style={{ position: 'static', padding: '48px 20px' }}>
              <h2>还没有收集任务</h2>
              <p>
                一次活动建一个任务：设个目标张数，把二维码发到群里，大家扫码上传。
                收到的照片先落收件箱，你逐张确认后再进正式库。
              </p>
              <button
                className="btn btn-primary"
                onClick={() => {
                  setEditing(null);
                  setDialogOpen(true);
                }}
              >
                新建第一个任务
              </button>
            </div>
          )}

          <div className="task-grid">
            {open.map((task) => (
              <div className="task-card" key={task.id}>
                <div className="task-card-head">
                  <b title={task.name}>{task.name}</b>
                  <span className="badge soft">进行中</span>
                </div>
                {task.note && <p className="task-note">{task.note}</p>}
                <div className="task-num">
                  <span className="big">{task.photoCount}</span>
                  <span className="of">{task.targetCount ? `/ ${task.targetCount} 张` : '张'}</span>
                  <div className="spacer" />
                  <span className="sub">待审 {task.inboxCount} · 入库 {task.keptCount}</span>
                </div>
                {task.targetCount ? (
                  <div className="task-progress big">
                    <i
                      style={{
                        width: `${Math.min(100, Math.round((task.photoCount / task.targetCount) * 100))}%`,
                      }}
                    />
                  </div>
                ) : null}
                <div className="task-card-meta">
                  <span className={task.deadlineAt && task.deadlineAt < Date.now() ? 'over' : ''}>
                    {task.deadlineAt
                      ? `${formatDateTime(task.deadlineAt)} · ${daysLeft(task.deadlineAt)}`
                      : '未设截止时间'}
                  </span>
                </div>
                <div className="task-card-actions">
                  <button
                    className="btn btn-primary"
                    onClick={() => setView({ type: 'task', id: task.id, name: task.name })}
                  >
                    查看照片
                  </button>
                  <button className="btn" onClick={() => setUploadTask(task)}>
                    上传入口
                  </button>
                  <button
                    className="btn btn-ghost"
                    onClick={() => {
                      setEditing(task);
                      setDialogOpen(true);
                    }}
                  >
                    编辑
                  </button>
                  <button className="btn btn-ghost" onClick={() => void closeTask(task)}>
                    结束
                  </button>
                </div>
              </div>
            ))}
          </div>

          {closed.length > 0 && (
            <>
              <button className="closed-toggle" onClick={() => setShowClosed((v) => !v)}>
                {showClosed ? '收起' : '展开'}已结束的任务（{closed.length}）
              </button>
              {showClosed && (
                <div className="task-grid">
                  {closed.map((task) => (
                    <div className="task-card closed" key={task.id}>
                      <div className="task-card-head">
                        <b title={task.name}>{task.name}</b>
                        <span className="badge">已结束</span>
                      </div>
                      <div className="task-card-meta">
                        共 {task.photoCount} 张 · 入库 {task.keptCount} 张
                      </div>
                      <div className="task-card-actions">
                        <button
                          className="btn"
                          onClick={() => setView({ type: 'task', id: task.id, name: task.name })}
                        >
                          查看照片
                        </button>
                        <button
                          className="btn btn-ghost"
                          onClick={() => setPendingDelete(task)}
                        >
                          删除任务
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {dialogOpen && (
        <TaskDialog
          task={editing}
          onClose={() => {
            setDialogOpen(false);
            setEditing(null);
          }}
        />
      )}

      {uploadTask && <UploadDialog task={uploadTask} onClose={() => setUploadTask(null)} />}

      {pendingDelete && (
        <Modal
          title="删除任务"
          subtitle={pendingDelete.name}
          onClose={() => setPendingDelete(null)}
          width={420}
          footer={
            <>
              <div className="spacer" />
              <button className="btn btn-ghost" onClick={() => setPendingDelete(null)}>
                取消
              </button>
              <button className="btn btn-danger" onClick={() => void removeTask(pendingDelete)}>
                删除
              </button>
            </>
          }
        >
          <p className="hint">
            只会删掉任务本身和它的来源记录，照片和相册都保留。确定删除吗？
          </p>
        </Modal>
      )}
    </>
  );
}

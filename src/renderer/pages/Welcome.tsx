import { useEffect, useState } from 'react';
import type { RecentLibrary } from '@shared/ipc';
import { api, errorText, unwrap } from '../api';
import { useApp } from '../store';

export default function Welcome() {
  const reloadLibrary = useApp((s) => s.reloadLibrary);
  const setView = useApp((s) => s.setView);
  const showToast = useApp((s) => s.showToast);

  const [recent, setRecent] = useState<RecentLibrary[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        setRecent(await unwrap(api.library.recent()));
      } catch {
        /* 忽略 */
      }
    })();
  }, []);

  const createLibrary = async (): Promise<void> => {
    try {
      const root = await unwrap(api.library.pickFolder());
      if (!root) return;
      setBusy(true);
      const name = root.split(/[\\/]/).filter(Boolean).pop() ?? '我的相册';
      await unwrap(api.library.create({ rootPath: root, name }));
      setView({ type: 'timeline' });
      await reloadLibrary();
    } catch (e) {
      showToast(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const openLibrary = async (dbPath: string): Promise<void> => {
    setBusy(true);
    try {
      await unwrap(api.library.open(dbPath));
      setView({ type: 'timeline' });
      await reloadLibrary();
    } catch (e) {
      showToast(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app-shell">
      <div className="titlebar">
        <span>相册收集站</span>
      </div>
      <div className="welcome">
        <div className="welcome-mark" />
        <h1>相册收集站</h1>
        <p>
          选一个文件夹作为媒体库，照片会按拍摄时间归档到这里。
          <br />
          不复制原图，只建索引和缩略图；批量重命名会改磁盘上的文件名。
        </p>
        <div className="welcome-actions">
          <button className="btn btn-primary" disabled={busy} onClick={() => void createLibrary()}>
            新建媒体库
          </button>
        </div>

        {recent.length > 0 && (
          <div className="recent-list">
            <div className="section-label" style={{ padding: '0 4px 6px' }}>
              最近打开
            </div>
            {recent.map((item) => (
              <button
                key={item.dbPath}
                className="recent-item"
                disabled={!item.exists || busy}
                onClick={() => void openLibrary(item.dbPath)}
              >
                <span className="dot" />
                <span style={{ minWidth: 0 }}>
                  <div className="name">{item.name}</div>
                  <div className="path">{item.rootPath}</div>
                  {!item.exists && <div className="missing">库文件已被移动或删除</div>}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

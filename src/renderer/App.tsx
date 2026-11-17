import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorText, unwrap } from './api';
import { PREF, prefBool, useApp } from './store';
import { applyTheme } from './theme';
import ImportBar from './components/ImportBar';
import Sidebar from './components/Sidebar';
import CommandPalette from './components/CommandPalette';
import ShortcutsSheet from './components/ShortcutsSheet';
import DuplicatesPage from './pages/DuplicatesPage';
import ImportHistoryPage from './pages/ImportHistoryPage';
import InboxPage from './pages/InboxPage';
import LocationsPage from './pages/LocationsPage';
import SettingsPage from './pages/SettingsPage';
import StoragePage from './pages/StoragePage';
import TasksPage from './pages/TasksPage';
import Timeline from './pages/Timeline';
import Welcome from './pages/Welcome';

export default function App() {
  const booting = useApp((s) => s.booting);
  const library = useApp((s) => s.library);
  const view = useApp((s) => s.view);
  const progress = useApp((s) => s.progress);
  const toast = useApp((s) => s.toast);
  const theme = useApp((s) => s.theme);

  const boot = useApp((s) => s.boot);
  const setProgress = useApp((s) => s.setProgress);
  const refreshStats = useApp((s) => s.refreshStats);
  const refreshAlbums = useApp((s) => s.refreshAlbums);
  const refreshTasks = useApp((s) => s.refreshTasks);
  const bumpData = useApp((s) => s.bumpData);
  const showToast = useApp((s) => s.showToast);
  const prefs = useApp((s) => s.prefs);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const albums = useApp((s) => s.albums);

  // 首屏把上次的主题刷上，避免先渲染默认色再跳一下
  useEffect(() => {
    applyTheme(theme);
    // 只在挂载时跑一次：后续切换由 store.setTheme 负责
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void boot();
  }, [boot]);

  useEffect(() => {
    const off = api.import.onProgress((p) => {
      setProgress(p);
      if (p.phase === 'done') {
        void refreshStats();
        void refreshAlbums();
        void refreshTasks();
        bumpData();
        setTimeout(() => setProgress(null), 1600);
      } else if (p.phase === 'cancelled') {
        setTimeout(() => setProgress(null), 1200);
      } else if (p.phase === 'error') {
        showToast(p.message ?? '导入失败');
        setTimeout(() => setProgress(null), 2600);
      }
    });
    return off;
  }, [setProgress, refreshStats, refreshAlbums, refreshTasks, bumpData, showToast]);

  // 手机上传成功后主动推过来，界面立刻能看到新照片
  useEffect(() => {
    const off = api.upload.onReceived((e) => {
      void refreshStats();
      void refreshTasks();
      void refreshAlbums();
      bumpData();
      showToast(
        e.deduped
          ? `${e.uploader || '有人'}传了一张重复的，已跳过`
          : `收到一张照片${e.uploader ? `（${e.uploader}）` : ''}`
      );
    });
    return off;
  }, [refreshStats, refreshTasks, refreshAlbums, bumpData, showToast]);

  /** 拖进来的东西归到哪儿：正在看某个相册/任务就顺手放进去 */
  const dropTarget = useMemo<{ albumId?: number; taskId?: number; label: string }>(() => {
    if (view.type === 'album') {
      const album = albums.find((a) => a.id === view.id);
      if (album && album.kind === 'manual') return { albumId: album.id, label: `相册「${album.name}」` };
    }
    if (view.type === 'task') return { taskId: view.id, label: '这个收集任务' };
    return { label: '图库' };
  }, [view, albums]);

  /** 导入的统一入口：目录导入和拖拽导入都走这里，偏好设置一起套上 */
  const runImport = useCallback(
    async (payload: { sourcePath?: string; paths?: string[] }) => {
      const kb = Number(prefs[PREF.minKb] ?? '1');
      await unwrap(
        api.import.start({
          ...payload,
          recursive: true,
          autoKeep: prefBool(prefs, PREF.autoKeep, false),
          minFileSize: Math.max(1, Number.isFinite(kb) ? kb : 1) * 1024,
          albumId: dropTarget.albumId,
          taskId: dropTarget.taskId,
        })
      );
    },
    [prefs, dropTarget]
  );

  /** 从一个目录开始导入 */
  const startImportFrom = useCallback(
    async (sourcePath: string) => {
      try {
        await runImport({ sourcePath });
        showToast('开始导入…');
      } catch (e) {
        showToast(errorText(e));
      }
    },
    [runImport, showToast]
  );

  const dropPaths = useCallback(
    async (paths: string[]) => {
      try {
        await runImport({ paths });
        showToast(`开始导入 ${paths.length} 个位置，收进${dropTarget.label}…`);
      } catch (e) {
        showToast(errorText(e));
      }
    },
    [runImport, dropTarget.label, showToast]
  );

  // 整窗拖放：任何位置松手都能导入，拖进来的可以是文件也可以是整个文件夹
  useEffect(() => {
    if (!library) return;

    const isFileDrag = (e: DragEvent): boolean =>
      Array.from(e.dataTransfer?.types ?? []).includes('Files');

    const onEnter = (e: DragEvent): void => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    };
    const onOver = (e: DragEvent): void => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onLeave = (e: DragEvent): void => {
      if (!isFileDrag(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent): void => {
      if (!isFileDrag(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);

      const paths: string[] = [];
      for (const file of Array.from(e.dataTransfer?.files ?? [])) {
        try {
          const p = api.app.pathForFile(file);
          if (p) paths.push(p);
        } catch {
          /* 浏览器里拖出来的图片没有磁盘路径，跳过 */
        }
      }
      if (!paths.length) {
        showToast('拖进来的内容没有磁盘路径，试试从资源管理器里拖文件或文件夹');
        return;
      }
      void dropPaths(paths);
    };
    const onBlur = (): void => {
      dragDepth.current = 0;
      setDragging(false);
    };

    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('blur', onBlur);
    };
  }, [library, dropPaths, showToast]);

  const startImport = useCallback(async () => {
    try {
      const folder = await unwrap(api.library.pickFolder());
      if (!folder) return;
      await startImportFrom(folder);
    } catch (e) {
      showToast(errorText(e));
    }
  }, [showToast, startImportFrom]);

  // 全局快捷键：命令面板 / 快捷键表 / 聚焦搜索
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      const typing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable === true;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (typing) return;
      if (e.key === '?') {
        e.preventDefault();
        setShortcutsOpen(true);
      } else if (e.key === '/') {
        const input = document.querySelector<HTMLInputElement>('.search input');
        if (input) {
          e.preventDefault();
          input.focus();
          input.select();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (booting) {
    return (
      <div className="app-shell">
        <div className="titlebar">
          <span className="tb-mark" aria-hidden />
          <span className="tb-name">相册收集站</span>
        </div>
      </div>
    );
  }

  if (!library) return <Welcome />;

  return (
    <div className="app-shell">
      <header className="titlebar">
        <span className="tb-mark" aria-hidden />
        <span className="tb-name">相册收集站</span>
        <span className="tb-slash">/</span>
        <span className="tb-lib" title={library.rootPath}>
          {library.name}
        </span>
        <span className="tb-grow" />
        <button className="tb-cmd" onClick={() => setPaletteOpen(true)} title="命令面板 (Ctrl+K)">
          命令面板
          <kbd>Ctrl K</kbd>
        </button>
      </header>

      <div className="shell-body">
        <Sidebar onImport={() => void startImport()} />
        <div className="main">
          {view.type === 'timeline' && <Timeline key="timeline" title="时间轴" kicker="图库" />}
          {view.type === 'inbox' && <InboxPage key="inbox" />}
          {view.type === 'album' && (
            <Timeline key={`album-${view.id}`} title={view.name} kicker="相册" albumId={view.id} />
          )}
          {view.type === 'tag' && (
            <Timeline key={`tag-${view.id}`} title={view.name} kicker="标签" tagId={view.id} />
          )}
          {view.type === 'task' && (
            <Timeline key={`task-${view.id}`} title="收集任务" kicker="任务" taskId={view.id} />
          )}
          {view.type === 'tasks' && <TasksPage key="tasks" />}
          {view.type === 'locations' && <LocationsPage key="locations" />}
          {view.type === 'imports' && <ImportHistoryPage key="imports" />}
          {view.type === 'duplicates' && <DuplicatesPage key="duplicates" />}
          {view.type === 'storage' && <StoragePage key="storage" />}
          {view.type === 'settings' && <SettingsPage key="settings" />}
        </div>
      </div>

      {progress && (
        <ImportBar
          progress={progress}
          onCancel={() => {
            void api.import.cancel();
          }}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
      {paletteOpen && (
        <CommandPalette onClose={() => setPaletteOpen(false)} onImport={() => void startImport()} />
      )}
      {shortcutsOpen && <ShortcutsSheet onClose={() => setShortcutsOpen(false)} />}
      {dragging && (
        <div className="drop-veil">
          <div className="drop-card">
            <span className="drop-mark" aria-hidden>
              ↓
            </span>
            <b>松手导入</b>
            <em>照片、视频、整个文件夹都行 · 收进{dropTarget.label}</em>
          </div>
        </div>
      )}
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../store';
import { THEMES, type ThemeId } from '../theme';

interface Item {
  id: string;
  group: string;
  label: string;
  hint?: string;
  /** 右侧的等宽小注，比如「视图」「相册」 */
  tag?: string;
  run: () => void;
}

interface Props {
  onClose: () => void;
  onImport: () => void;
}

/**
 * 命令面板：Ctrl/Cmd + K。
 * 跳视图、开相册/标签/任务、切主题、触发导入，一个入口解决。
 */
export default function CommandPalette({ onClose, onImport }: Props) {
  const albums = useApp((s) => s.albums);
  const tags = useApp((s) => s.tags);
  const tasks = useApp((s) => s.tasks);
  const setView = useApp((s) => s.setView);
  const setTheme = useApp((s) => s.setTheme);
  const theme = useApp((s) => s.theme);

  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo<Item[]>(() => {
    const nav: Item[] = [
      { id: 'v-timeline', group: '前往', label: '时间轴', tag: '视图', run: () => setView({ type: 'timeline' }) },
      { id: 'v-inbox', group: '前往', label: '收件箱', tag: '视图', run: () => setView({ type: 'inbox' }) },
      { id: 'v-dupes', group: '前往', label: '重复照片', tag: '视图', run: () => setView({ type: 'duplicates' }) },
      { id: 'v-tasks', group: '前往', label: '收集任务', tag: '视图', run: () => setView({ type: 'tasks' }) },
      { id: 'v-locations', group: '前往', label: '地点', tag: '视图', run: () => setView({ type: 'locations' }) },
      { id: 'v-imports', group: '前往', label: '导入记录', tag: '视图', run: () => setView({ type: 'imports' }) },
      { id: 'v-storage', group: '前往', label: '存储分析', tag: '视图', run: () => setView({ type: 'storage' }) },
      { id: 'v-settings', group: '前往', label: '设置', tag: '视图', run: () => setView({ type: 'settings' }) },
    ];

    const albumItems: Item[] = albums.slice(0, 10).map((a) => ({
      id: `a-${a.id}`,
      group: '相册',
      label: a.name,
      hint: `${a.photoCount} 张${a.kind === 'smart' ? ' · 智能' : ''}`,
      tag: '相册',
      run: () => setView({ type: 'album', id: a.id, name: a.name }),
    }));

    const tagItems: Item[] = tags.slice(0, 8).map((t) => ({
      id: `t-${t.id}`,
      group: '标签',
      label: `# ${t.name}`,
      hint: `${t.photoCount} 张`,
      tag: '标签',
      run: () => setView({ type: 'tag', id: t.id, name: t.name }),
    }));

    const taskItems: Item[] = tasks
      .filter((t) => t.state === 'open')
      .slice(0, 6)
      .map((t) => ({
        id: `k-${t.id}`,
        group: '任务',
        label: t.name,
        hint: `已收 ${t.photoCount} 张`,
        tag: '任务',
        run: () => setView({ type: 'task', id: t.id, name: t.name }),
      }));

    const actions: Item[] = [
      { id: 'do-import', group: '操作', label: '导入照片…', hint: '选文件夹递归扫描', tag: '动作', run: onImport },
      { id: 'do-tasks', group: '操作', label: '新建收集任务…', tag: '动作', run: () => setView({ type: 'tasks' }) },
    ];

    const themeItems: Item[] = THEMES.map((t) => ({
      id: `th-${t.id}`,
      group: '主题',
      label: `主题：${t.name}`,
      hint: t.note,
      tag: t.id === theme ? '当前' : '切换',
      run: () => setTheme(t.id as ThemeId),
    }));

    return [...nav, ...actions, ...albumItems, ...tagItems, ...taskItems, ...themeItems];
  }, [albums, tags, tasks, setView, setTheme, theme, onImport]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    const scored = items
      .map((item) => {
        const label = item.label.toLowerCase();
        if (label.startsWith(q)) return { item, score: 0 };
        if (label.includes(q)) return { item, score: 1 };
        if ((item.hint ?? '').toLowerCase().includes(q)) return { item, score: 2 };
        if (item.group.toLowerCase().includes(q)) return { item, score: 3 };
        return null;
      })
      .filter((x): x is { item: Item; score: number } => x !== null);
    scored.sort((a, b) => a.score - b.score);
    return scored.map((s) => s.item);
  }, [items, query]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  // 焦点可能在列表里（鼠标点过），Esc 也要能关
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('.palette-item.active');
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const fire = (item: Item | undefined): void => {
    if (!item) return;
    item.run();
    onClose();
  };

  // 分组是按 items 顺序聚在一起的，渲染时遇到新组才插标题
  let lastGroup = '';

  return (
    <div
      className="palette-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label="命令面板">
        <div className="palette-search">
          <span className="palette-mark" aria-hidden />
          <input
            autoFocus
            value={query}
            placeholder="跳到相册、标签、任务，或切换主题…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive((i) => Math.min(filtered.length - 1, i + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((i) => Math.max(0, i - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                fire(filtered[active]);
              }
            }}
          />
          <kbd>Esc</kbd>
        </div>

        <div className="palette-list" ref={listRef}>
          {filtered.length === 0 && <div className="palette-empty">没有匹配项</div>}
          {filtered.map((item, index) => {
            const head = item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return (
              <div key={item.id}>
                {head && <div className="palette-group">{head}</div>}
                <button
                  className={`palette-item${index === active ? ' active' : ''}`}
                  onMouseMove={() => setActive(index)}
                  onClick={() => fire(item)}
                >
                  <span className="palette-label">{item.label}</span>
                  {item.hint && <span className="palette-hint">{item.hint}</span>}
                  {item.tag && <span className="palette-tag">{item.tag}</span>}
                </button>
              </div>
            );
          })}
        </div>

        <div className="palette-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> 选择
          </span>
          <span>
            <kbd>↵</kbd> 打开
          </span>
          <span className="spacer" />
          <span className="hint">Ctrl+K 随时唤起</span>
        </div>
      </div>
    </div>
  );
}

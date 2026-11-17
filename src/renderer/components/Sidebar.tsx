import { useState, type MouseEvent, type ReactElement } from 'react';
import type { Album, Tag } from '@shared/ipc';
import { api, errorText, unwrap } from '../api';
import { useApp } from '../store';
import { formatBytes } from '../format';
import SmartAlbumDialog from '../dialogs/SmartAlbumDialog';
import PromptDialog from '../dialogs/PromptDialog';
import ConfirmDialog from '../dialogs/ConfirmDialog';
import ThemeSwitcher from './ThemeSwitcher';
import RowMenu from './RowMenu';
import Popover from './Popover';

/** 标签可选颜色，取自四套主题的强调色系，保证任何主题下都不刺眼 */
const TAG_COLORS = ['#e2a03f', '#e2563f', '#86b6d8', '#7fae6a', '#a88bd4', '#8c8577'];

type RowMenuState = { kind: 'album' | 'tag'; id: number; x: number; y: number } | null;

export default function Sidebar({ onImport }: { onImport: () => void }) {
  const library = useApp((s) => s.library);
  const view = useApp((s) => s.view);
  const stats = useApp((s) => s.stats);
  const albums = useApp((s) => s.albums);
  const tags = useApp((s) => s.tags);
  const tasks = useApp((s) => s.tasks);
  const setView = useApp((s) => s.setView);
  const refreshAlbums = useApp((s) => s.refreshAlbums);
  const refreshTags = useApp((s) => s.refreshTags);
  const showToast = useApp((s) => s.showToast);

  const [creatingAlbum, setCreatingAlbum] = useState(false);
  const [creatingTag, setCreatingTag] = useState(false);
  const [smartOpen, setSmartOpen] = useState(false);
  const [editingSmart, setEditingSmart] = useState<Album | null>(null);
  const [name, setName] = useState('');

  const [rowMenu, setRowMenu] = useState<RowMenuState>(null);
  const [renameAlbum, setRenameAlbum] = useState<Album | null>(null);
  const [descAlbum, setDescAlbum] = useState<Album | null>(null);
  const [deleteAlbum, setDeleteAlbum] = useState<Album | null>(null);
  const [renameTag, setRenameTag] = useState<Tag | null>(null);
  const [deleteTag, setDeleteTag] = useState<Tag | null>(null);
  const [childTagOf, setChildTagOf] = useState<Tag | null>(null);
  const [colorTag, setColorTag] = useState<{ tag: Tag; x: number; y: number } | null>(null);

  if (!library) return null;

  const openMenu =
    (kind: 'album' | 'tag', id: number) =>
    (e: MouseEvent<HTMLButtonElement>): void => {
      e.stopPropagation();
      const rect = e.currentTarget.getBoundingClientRect();
      setRowMenu({ kind, id, x: rect.right - 176, y: rect.bottom + 4 });
    };

  const submitAlbum = async (): Promise<void> => {
    const value = name.trim();
    if (!value) {
      setCreatingAlbum(false);
      return;
    }
    try {
      const album = await unwrap(api.album.create({ name: value }));
      setName('');
      setCreatingAlbum(false);
      await refreshAlbums();
      setView({ type: 'album', id: album.id, name: album.name });
    } catch (e) {
      showToast(errorText(e));
    }
  };

  const submitTag = async (): Promise<void> => {
    const value = name.trim();
    if (!value) {
      setCreatingTag(false);
      return;
    }
    try {
      const tag = await unwrap(api.tag.create({ name: value }));
      setName('');
      setCreatingTag(false);
      await refreshTags();
      showToast(`标签「${tag.name}」已创建`);
    } catch (e) {
      showToast(errorText(e));
    }
  };

  const doRenameAlbum = async (value: string): Promise<void> => {
    if (!renameAlbum) return;
    const next = await unwrap(api.album.patch(renameAlbum.id, { name: value }));
    await refreshAlbums();
    if (view.type === 'album' && view.id === next.id) {
      setView({ type: 'album', id: next.id, name: next.name });
    }
    showToast(`已改名为「${next.name}」`);
  };

  const doRenameTag = async (value: string): Promise<void> => {
    if (!renameTag) return;
    const next = await unwrap(api.tag.patch(renameTag.id, { name: value }));
    await refreshTags();
    if (view.type === 'tag' && view.id === next.id) {
      setView({ type: 'tag', id: next.id, name: next.name });
    }
    showToast(`已改名为「${next.name}」`);
  };

  const doDeleteAlbum = async (): Promise<void> => {
    if (!deleteAlbum) return;
    await unwrap(api.album.remove(deleteAlbum.id));
    await refreshAlbums();
    if (view.type === 'album' && view.id === deleteAlbum.id) setView({ type: 'timeline' });
    showToast('相册已删除，照片还在库里');
  };

  const doDeleteTag = async (): Promise<void> => {
    if (!deleteTag) return;
    await unwrap(api.tag.remove(deleteTag.id));
    await refreshTags();
    if (view.type === 'tag' && view.id === deleteTag.id) setView({ type: 'timeline' });
    showToast('标签已删除，照片本身没动');
  };

  const doCreateChild = async (value: string): Promise<void> => {
    if (!childTagOf) return;
    const tag = await unwrap(api.tag.create({ name: value, parentId: childTagOf.id }));
    await refreshTags();
    showToast(`子标签「${tag.name}」已建在「${childTagOf.name}」下`);
  };

  const doSetColor = async (tag: Tag, color: string | null): Promise<void> => {
    await unwrap(api.tag.patch(tag.id, { color }));
    await refreshTags();
    setColorTag(null);
    showToast(color ? '颜色已更新' : '已恢复默认颜色');
  };

  const openTasks = tasks.filter((t) => t.state === 'open').length;
  const menuAlbum = rowMenu?.kind === 'album' ? albums.find((a) => a.id === rowMenu.id) : undefined;
  const menuTag = rowMenu?.kind === 'tag' ? tags.find((t) => t.id === rowMenu.id) : undefined;

  const roots = tags.filter((t) => t.parentId === null || t.parentId === undefined);
  const childrenOf = (id: number): Tag[] => tags.filter((t) => t.parentId === id);

  const renderTag = (tag: Tag, sub: boolean): ReactElement => (
    <div className={`nav-row${sub ? ' sub' : ''}`} key={tag.id}>
      <button
        className={`nav-item${view.type === 'tag' && view.id === tag.id ? ' active' : ''}`}
        onClick={() => setView({ type: 'tag', id: tag.id, name: tag.name })}
      >
        <span className="dot" style={{ background: tag.color ?? undefined }} />
        <span className="label">{tag.name}</span>
        <span className="count">{tag.photoCount}</span>
      </button>
      <button className="row-more" title="标签操作" onClick={openMenu('tag', tag.id)}>
        ⋯
      </button>
    </div>
  );

  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark" aria-hidden />
        <div className="brand-text">
          <div className="brand-name" title={library.rootPath}>
            {library.name}
          </div>
          <div className="brand-sub">
            {library.photoCount} 张 · {formatBytes(library.totalBytes)}
          </div>
        </div>
      </div>

      <div className="sidebar-scroll">
        <div className="chapter">
          <span className="chapter-no">01</span>
          <span className="chapter-name">书库</span>
        </div>

        <button
          className={`nav-item${view.type === 'timeline' ? ' active' : ''}`}
          onClick={() => setView({ type: 'timeline' })}
        >
          <span className="dot" />
          <span className="label">时间轴</span>
          <span className="count">{library.keptCount}</span>
        </button>

        <button
          className={`nav-item${view.type === 'inbox' ? ' active' : ''}`}
          onClick={() => setView({ type: 'inbox' })}
        >
          <span className="dot" />
          <span className="label">收件箱</span>
          {stats && stats.inbox > 0 ? <span className="count hot">{stats.inbox}</span> : null}
        </button>

        <button
          className={`nav-item${view.type === 'duplicates' ? ' active' : ''}`}
          onClick={() => setView({ type: 'duplicates' })}
        >
          <span className="dot" />
          <span className="label">重复照片</span>
        </button>

        <button
          className={`nav-item${view.type === 'tasks' || view.type === 'task' ? ' active' : ''}`}
          onClick={() => setView({ type: 'tasks' })}
        >
          <span className="dot" />
          <span className="label">收集任务</span>
          {openTasks > 0 ? <span className="count">{openTasks}</span> : null}
        </button>

        <button
          className={`nav-item${view.type === 'locations' ? ' active' : ''}`}
          onClick={() => setView({ type: 'locations' })}
        >
          <span className="dot" />
          <span className="label">地点</span>
        </button>

        <button
          className={`nav-item${view.type === 'imports' ? ' active' : ''}`}
          onClick={() => setView({ type: 'imports' })}
        >
          <span className="dot" />
          <span className="label">导入记录</span>
        </button>

        <div className="chapter">
          <span className="chapter-no">02</span>
          <span className="chapter-name">相册</span>
          <span className="section-actions">
            <button title="新建智能相册" onClick={() => setSmartOpen(true)}>
              ✦
            </button>
            <button title="新建相册" onClick={() => setCreatingAlbum(true)}>
              +
            </button>
          </span>
        </div>

        {creatingAlbum && (
          <input
            className="input inline"
            autoFocus
            placeholder="相册名，回车确认"
            value={name}
            style={{ margin: '0 4px 6px', width: 'calc(100% - 8px)' }}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              setCreatingAlbum(false);
              setName('');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitAlbum();
              if (e.key === 'Escape') {
                setCreatingAlbum(false);
                setName('');
              }
            }}
          />
        )}

        {albums.length === 0 && !creatingAlbum && <div className="sidebar-empty">还没有相册</div>}

        {albums.map((album) => (
          <div className="nav-row" key={album.id}>
            <button
              className={`nav-item${view.type === 'album' && view.id === album.id ? ' active' : ''}`}
              onClick={() => setView({ type: 'album', id: album.id, name: album.name })}
            >
              <span className="dot" />
              <span className="label">
                {album.name}
                {album.kind === 'smart' && (
                  <em className="smart-mark" title="智能相册">
                    ✦
                  </em>
                )}
              </span>
              <span className="count">{album.photoCount}</span>
            </button>
            <button className="row-more" title="相册操作" onClick={openMenu('album', album.id)}>
              ⋯
            </button>
          </div>
        ))}

        <div className="chapter">
          <span className="chapter-no">03</span>
          <span className="chapter-name">标签</span>
          <span className="section-actions">
            <button title="新建标签" onClick={() => setCreatingTag(true)}>
              +
            </button>
          </span>
        </div>

        {creatingTag && (
          <input
            className="input inline"
            autoFocus
            placeholder="标签名，回车确认"
            value={name}
            style={{ margin: '0 4px 6px', width: 'calc(100% - 8px)' }}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => {
              setCreatingTag(false);
              setName('');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitTag();
              if (e.key === 'Escape') {
                setCreatingTag(false);
                setName('');
              }
            }}
          />
        )}

        {tags.length === 0 && !creatingTag && <div className="sidebar-empty">还没有标签</div>}

        {roots.map((tag) => (
          <div key={tag.id}>
            {renderTag(tag, false)}
            {childrenOf(tag.id).map((child) => renderTag(child, true))}
          </div>
        ))}
      </div>

      <div className="sidebar-foot">
        <button className="btn btn-primary import-btn" onClick={onImport}>
          导入照片
        </button>
        <div className="foot-tabs">
          <button
            className={`foot-tab${view.type === 'storage' ? ' active' : ''}`}
            onClick={() => setView({ type: 'storage' })}
          >
            存储分析
          </button>
          <button
            className={`foot-tab${view.type === 'settings' ? ' active' : ''}`}
            onClick={() => setView({ type: 'settings' })}
          >
            设置
          </button>
        </div>
        <ThemeSwitcher />
      </div>

      {smartOpen && <SmartAlbumDialog onClose={() => setSmartOpen(false)} />}
      {editingSmart && <SmartAlbumDialog album={editingSmart} onClose={() => setEditingSmart(null)} />}

      {rowMenu && menuAlbum && (
        <RowMenu
          x={rowMenu.x}
          y={rowMenu.y}
          items={[
            { label: '重命名', onClick: () => setRenameAlbum(menuAlbum) },
            { label: '改描述', onClick: () => setDescAlbum(menuAlbum) },
            ...(menuAlbum.kind === 'smart'
              ? [{ label: '编辑规则', hint: '✦', onClick: () => setEditingSmart(menuAlbum) }]
              : []),
            { label: '删除相册', danger: true, onClick: () => setDeleteAlbum(menuAlbum) },
          ]}
          onClose={() => setRowMenu(null)}
        />
      )}

      {rowMenu && menuTag && (
        <RowMenu
          x={rowMenu.x}
          y={rowMenu.y}
          items={[
            { label: '重命名', onClick: () => setRenameTag(menuTag) },
            {
              label: '改颜色',
              onClick: () => setColorTag({ tag: menuTag, x: rowMenu.x, y: rowMenu.y }),
            },
            ...(menuTag.parentId
              ? []
              : [{ label: '新建子标签', onClick: () => setChildTagOf(menuTag) }]),
            { label: '删除标签', danger: true, onClick: () => setDeleteTag(menuTag) },
          ]}
          onClose={() => setRowMenu(null)}
        />
      )}

      {colorTag && (
        <Popover x={colorTag.x} y={colorTag.y} width={168} onClose={() => setColorTag(null)}>
          <div className="swatch-grid">
            {TAG_COLORS.map((c) => (
              <button
                key={c}
                className="swatch"
                style={{ background: c }}
                title={c}
                onClick={() => void doSetColor(colorTag.tag, c)}
              />
            ))}
            <button className="swatch none" title="默认" onClick={() => void doSetColor(colorTag.tag, null)}>
              ✕
            </button>
          </div>
          <p className="hint" style={{ margin: '8px 2px 0' }}>
            只影响侧栏的圆点
          </p>
        </Popover>
      )}

      {renameAlbum && (
        <PromptDialog
          title="重命名相册"
          label="相册名"
          defaultValue={renameAlbum.name}
          onClose={() => setRenameAlbum(null)}
          onSubmit={doRenameAlbum}
        />
      )}
      {descAlbum && (
        <PromptDialog
          title="修改描述"
          label="描述"
          multiline
          allowEmpty
          defaultValue={descAlbum.description ?? ''}
          placeholder="这个相册收的是什么？留空可以清掉描述"
          onClose={() => setDescAlbum(null)}
          onSubmit={async (value) => {
            await unwrap(api.album.patch(descAlbum.id, { description: value || null }));
            await refreshAlbums();
            showToast(value ? '描述已更新' : '描述已清空');
          }}
        />
      )}
      {deleteAlbum && (
        <ConfirmDialog
          title="删除相册"
          danger
          confirmLabel="删除相册"
          onClose={() => setDeleteAlbum(null)}
          onConfirm={doDeleteAlbum}
        >
          <p>
            相册「<b>{deleteAlbum.name}</b>」会被删除。
          </p>
          <p className="hint">里面的 {deleteAlbum.photoCount} 张照片不会被删除，只是不再属于这个相册。</p>
        </ConfirmDialog>
      )}

      {renameTag && (
        <PromptDialog
          title="重命名标签"
          label="标签名"
          defaultValue={renameTag.name}
          onClose={() => setRenameTag(null)}
          onSubmit={doRenameTag}
        />
      )}
      {childTagOf && (
        <PromptDialog
          title="新建子标签"
          label="标签名"
          confirmLabel="创建"
          hint={`会建在「${childTagOf.name}」下面`}
          onClose={() => setChildTagOf(null)}
          onSubmit={doCreateChild}
        />
      )}
      {deleteTag && (
        <ConfirmDialog
          title="删除标签"
          danger
          confirmLabel="删除标签"
          onClose={() => setDeleteTag(null)}
          onConfirm={doDeleteTag}
        >
          <p>
            标签「<b>{deleteTag.name}</b>」会被删除。
          </p>
          <p className="hint">
            会同时清掉它和 {deleteTag.photoCount} 张照片的关联，照片本身不受影响。
            {childrenOf(deleteTag.id).length > 0 && ' 它下面的子标签会变成一级标签。'}
          </p>
        </ConfirmDialog>
      )}
    </aside>
  );
}

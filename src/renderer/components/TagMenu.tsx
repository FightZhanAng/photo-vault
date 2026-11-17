import { useState } from 'react';
import type { Tag } from '@shared/ipc';
import { api, errorText, unwrap } from '../api';
import { useApp } from '../store';
import Popover from './Popover';

interface TagMenuProps {
  photoIds: number[];
  x: number;
  y: number;
  placement?: 'below' | 'above';
  onClose: () => void;
}

export default function TagMenu({ photoIds, x, y, placement = 'below', onClose }: TagMenuProps) {
  const tags = useApp((s) => s.tags);
  const refreshTags = useApp((s) => s.refreshTags);
  const showToast = useApp((s) => s.showToast);
  const bumpData = useApp((s) => s.bumpData);

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<string>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      showToast(await fn());
      await refreshTags();
      bumpData();
    } catch (e) {
      showToast(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const attach = (tag: Tag): void => {
    void run(async () => {
      const r = await unwrap(api.tag.attach(photoIds, tag.id));
      return r.attached > 0 ? `已给 ${r.attached} 张打上「${tag.name}」` : '这些照片本来就有这个标签';
    });
  };

  const detach = (tag: Tag): void => {
    void run(async () => {
      const r = await unwrap(api.tag.detach(photoIds, tag.id));
      return r.detached > 0 ? `已移除「${tag.name}」` : '这些照片没有这个标签';
    });
  };

  const createAndAttach = (): void => {
    const value = name.trim();
    if (!value) {
      setCreating(false);
      return;
    }
    void run(async () => {
      const tag = await unwrap(api.tag.create({ name: value }));
      await unwrap(api.tag.attach(photoIds, tag.id));
      setName('');
      setCreating(false);
      return `新建标签「${tag.name}」并打上`;
    });
  };

  return (
    <Popover x={x} y={y} width={252} placement={placement} onClose={onClose}>
      <div className="popover-head">
        打标签
        <span className="sub">{photoIds.length} 张</span>
      </div>
      <div className="popover-list">
        {tags.length === 0 && <div className="popover-empty">还没有标签，下面新建一个</div>}
        {tags.map((tag) => (
          <div className="tag-row" key={tag.id}>
            <span className="tag-dot" style={{ background: tag.color ?? 'var(--accent)' }} />
            <span className="tag-name" title={tag.name}>
              {tag.name}
            </span>
            <span className="tag-count" title={`全库共 ${tag.photoCount} 张带这个标签`}>
              {tag.photoCount}
            </span>
            <button title="打上" disabled={busy} onClick={() => attach(tag)}>
              +
            </button>
            <button title="移除" disabled={busy} onClick={() => detach(tag)}>
              −
            </button>
          </div>
        ))}
      </div>
      <div className="popover-foot">
        {creating ? (
          <input
            className="select"
            autoFocus
            placeholder="标签名，回车确认"
            value={name}
            style={{ width: '100%' }}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') createAndAttach();
              if (e.key === 'Escape') {
                e.stopPropagation();
                setCreating(false);
              }
            }}
            onBlur={() => setCreating(false)}
          />
        ) : (
          <button className="link-btn" onClick={() => setCreating(true)}>
            + 新建标签
          </button>
        )}
      </div>
    </Popover>
  );
}

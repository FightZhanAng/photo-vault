import { useState } from 'react';
import type { Album, SmartRule } from '@shared/ipc';
import { api, errorText, unwrap } from '../api';
import { useApp } from '../store';
import Modal from '../components/Modal';
import { rangeBounds, type RangeKey } from '../components/FilterBar';

interface SmartAlbumDialogProps {
  /** 传入则在编辑已有智能相册，否则新建 */
  album?: Album;
  onClose: () => void;
}

const RANGES: { key: RangeKey | 'custom'; label: string }[] = [
  { key: 'all', label: '不限' },
  { key: 'thisYear', label: '今年' },
  { key: 'lastYear', label: '去年' },
  { key: 'thisMonth', label: '本月' },
  { key: '90d', label: '近 90 天' },
  { key: 'custom', label: '自定义' },
];

/** 把已存的 from/to 还原成「预设档位」；对不上就用自定义 */
function rangeOf(rule: SmartRule): RangeKey | 'custom' {
  if (rule.from === undefined && rule.to === undefined) return 'all';
  const r = rule as { from?: number; to?: number };
  for (const item of RANGES) {
    if (item.key === 'custom' || item.key === 'all') continue;
    const b = rangeBounds(item.key);
    const fromOk = b.from ? r.from === b.from : r.from === undefined;
    const toOk = b.to ? r.to === b.to : r.to === undefined;
    if (fromOk && toOk) return item.key;
  }
  return 'custom';
}

function dateInput(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default function SmartAlbumDialog({ album, onClose }: SmartAlbumDialogProps) {
  const tags = useApp((s) => s.tags);
  const refreshAlbums = useApp((s) => s.refreshAlbums);
  const showToast = useApp((s) => s.showToast);
  const setView = useApp((s) => s.setView);

  const saved: SmartRule = album?.ruleJson ? (JSON.parse(album.ruleJson) as SmartRule) : {};

  const [name, setName] = useState(album?.name ?? '');
  const [statuses, setStatuses] = useState<string[]>(saved.status ?? ['kept']);
  const [range, setRange] = useState<RangeKey | 'custom'>(album ? rangeOf(saved) : 'thisYear');
  const [fromDate, setFromDate] = useState(dateInput(saved.from));
  const [toDate, setToDate] = useState(dateInput(saved.to));
  const [tagIds, setTagIds] = useState<number[]>(saved.tagIds ?? []);
  const [favoriteOnly, setFavoriteOnly] = useState(saved.favoriteOnly ?? false);
  const [hasGps, setHasGps] = useState(saved.hasGps ?? false);
  const [minWidth, setMinWidth] = useState(saved.minWidth ? String(saved.minWidth) : '');
  const [ext, setExt] = useState(saved.ext?.[0] ?? '');
  const [keyword, setKeyword] = useState(saved.keyword ?? '');
  const [busy, setBusy] = useState(false);

  const buildRule = (): SmartRule => {
    const rule: SmartRule = {};
    if (statuses.length) rule.status = statuses as SmartRule['status'];
    if (range === 'custom') {
      if (fromDate) rule.from = new Date(`${fromDate}T00:00:00`).getTime();
      if (toDate) rule.to = new Date(`${toDate}T23:59:59`).getTime();
    } else {
      const b = rangeBounds(range);
      if (b.from) rule.from = b.from;
      if (b.to) rule.to = b.to;
    }
    if (tagIds.length) rule.tagIds = tagIds;
    if (favoriteOnly) rule.favoriteOnly = true;
    if (hasGps) rule.hasGps = true;
    if (minWidth) rule.minWidth = Number(minWidth);
    if (ext) rule.ext = [ext];
    if (keyword.trim()) rule.keyword = keyword.trim();
    return rule;
  };

  const rule = buildRule();
  const conditions = Object.keys(rule).length;

  const submit = async (): Promise<void> => {
    if (!name.trim()) {
      showToast('先给相册起个名字');
      return;
    }
    if (conditions === 0) {
      showToast('至少要设一个筛选条件，否则它和「全部照片」没区别');
      return;
    }
    setBusy(true);
    try {
      if (album) {
        const next = await unwrap(
          api.album.patch(album.id, { name: name.trim(), rule: buildRule() })
        );
        await refreshAlbums();
        showToast(`「${next.name}」的规则已更新`);
        // 当前正停在这个相册上时，标题要跟着变
        if (useApp.getState().view.type === 'album') {
          setView({ type: 'album', id: next.id, name: next.name });
        }
      } else {
        const created = await unwrap(api.album.create({ name: name.trim(), kind: 'smart', rule }));
        await refreshAlbums();
        showToast(`智能相册「${created.name}」已创建`);
        setView({ type: 'album', id: created.id, name: created.name });
      }
      onClose();
    } catch (e) {
      showToast(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleTag = (id: number): void => {
    setTagIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  return (
    <Modal
      title={album ? '编辑智能相册' : '新建智能相册'}
      subtitle="照片自动按条件归集，不用手动往里放"
      onClose={onClose}
      locked={busy}
      width={600}
      footer={
        <>
          <span className="hint">{conditions} 个条件</span>
          <div className="spacer" />
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={busy}>
            {busy ? '保存中…' : album ? '保存' : '创建'}
          </button>
        </>
      }
    >
      <label className="field">
        <span>相册名</span>
        <input
          className="input"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例如：今年的横构图"
        />
      </label>

      <div className="field">
        <span>包含状态</span>
        <div className="chip-row">
          {[
            { key: 'kept', label: '正式库' },
            { key: 'inbox', label: '收件箱' },
            { key: 'rejected', label: '已淘汰' },
          ].map((s) => (
            <button
              key={s.key}
              className={`chip-toggle${statuses.includes(s.key) ? ' on' : ''}`}
              onClick={() =>
                setStatuses((prev) =>
                  prev.includes(s.key) ? prev.filter((x) => x !== s.key) : [...prev, s.key]
                )
              }
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <span>拍摄时间</span>
        <div className="chip-row">
          {RANGES.map((r) => (
            <button
              key={r.key}
              className={`chip-toggle${range === r.key ? ' on' : ''}`}
              onClick={() => setRange(r.key)}
            >
              {r.label}
            </button>
          ))}
        </div>
        {range === 'custom' && (
          <div className="row" style={{ marginTop: 8 }}>
            <input
              className="input"
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
            />
            <span className="hint">到</span>
            <input className="input" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
          </div>
        )}
      </div>

      {tags.length > 0 && (
        <div className="field">
          <span>包含标签</span>
          <div className="chip-row">
            {tags.map((tag) => (
              <button
                key={tag.id}
                className={`chip-toggle${tagIds.includes(tag.id) ? ' on' : ''}`}
                onClick={() => toggleTag(tag.id)}
                title={`${tag.photoCount} 张`}
              >
                {tag.name}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="field-row">
        <label className="field">
          <span>画质下限</span>
          <select className="select" value={minWidth} onChange={(e) => setMinWidth(e.target.value)}>
            <option value="">不限</option>
            <option value="1920">宽 ≥ 1920</option>
            <option value="2560">宽 ≥ 2560</option>
            <option value="3840">宽 ≥ 3840</option>
          </select>
        </label>
        <label className="field">
          <span>格式</span>
          <select className="select" value={ext} onChange={(e) => setExt(e.target.value)}>
            <option value="">不限</option>
            {['jpg', 'jpeg', 'png', 'heic', 'webp', 'gif', 'tiff', 'avif'].map((e) => (
              <option key={e} value={e}>
                .{e}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="field">
        <span>关键词</span>
        <input
          className="input"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="文件名 / 备注 / 相机 / 标签名包含…"
        />
      </label>

      <div className="chip-row">
        <button
          className={`chip-toggle${favoriteOnly ? ' on' : ''}`}
          onClick={() => setFavoriteOnly((v) => !v)}
        >
          ★ 只看收藏
        </button>
        <button className={`chip-toggle${hasGps ? ' on' : ''}`} onClick={() => setHasGps((v) => !v)}>
          ◎ 只看有定位
        </button>
      </div>
    </Modal>
  );
}

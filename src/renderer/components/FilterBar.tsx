import { useEffect, useMemo, useRef, useState } from 'react';
import type { PhotoSort } from '@shared/ipc';
import { SEARCH_SYNTAX_HELP, parseSearch, tokenChips } from '@shared/search';
import type { Density } from '../store';
import Popover from './Popover';

export type RangeKey = 'all' | 'thisYear' | 'lastYear' | 'thisMonth' | '90d';

export interface Filters {
  keyword: string;
  range: RangeKey;
  favoriteOnly: boolean;
  hasGps: boolean;
  /** 空字符串 = 不限 */
  ext: string;
  sort: PhotoSort;
}

export const EMPTY_FILTERS: Filters = {
  keyword: '',
  range: 'all',
  favoriteOnly: false,
  hasGps: false,
  ext: '',
  sort: 'taken_desc',
};

const RANGE_LABEL: Record<RangeKey, string> = {
  all: '全部时间',
  thisYear: '今年',
  lastYear: '去年',
  thisMonth: '本月',
  '90d': '近 90 天',
};

const EXT_OPTIONS = ['', 'jpg', 'jpeg', 'png', 'heic', 'webp', 'gif', 'tiff', 'avif'];

export function rangeBounds(range: RangeKey): { from?: number; to?: number } {
  const now = new Date();
  if (range === 'all') return {};
  if (range === '90d') return { from: Date.now() - 90 * 24 * 3600 * 1000 };
  if (range === 'thisMonth') {
    return { from: new Date(now.getFullYear(), now.getMonth(), 1).getTime() };
  }
  if (range === 'thisYear') {
    return { from: new Date(now.getFullYear(), 0, 1).getTime() };
  }
  return {
    from: new Date(now.getFullYear() - 1, 0, 1).getTime(),
    to: new Date(now.getFullYear(), 0, 1).getTime() - 1,
  };
}

export function activeFilterCount(f: Filters): number {
  let n = 0;
  if (f.keyword.trim()) n++;
  if (f.range !== 'all') n++;
  if (f.favoriteOnly) n++;
  if (f.hasGps) n++;
  if (f.ext) n++;
  if (f.sort !== 'taken_desc') n++;
  return n;
}

interface FilterBarProps {
  value: Filters;
  onChange: (next: Filters) => void;
  /** 相册/标签/任务视图里不显示「收藏 / GPS」这些通用条件也无妨，保留统一 */
  compact?: boolean;
  /** 缩略图大小；不传就不显示密度开关 */
  density?: Density;
  onDensity?: (next: Density) => void;
}

const DENSITY_HINT: Record<Density, string> = {
  s: '小图：一屏看更多',
  m: '中图：默认',
  l: '大图：看清细节',
};

export default function FilterBar({ value, onChange, compact = false, density, onDensity }: FilterBarProps) {
  const [keyword, setKeyword] = useState(value.keyword);
  const [helpAt, setHelpAt] = useState<{ x: number; y: number } | null>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 外面显示的是原始输入，识别结果在浮层里逐条列出来，避免「写了语法却不知道有没有生效」
  const parsed = useMemo(() => parseSearch(keyword), [keyword]);
  const chips = tokenChips(parsed);

  // 外部重置（比如点击「清除筛选」）时同步输入框
  useEffect(() => {
    setKeyword(value.keyword);
  }, [value.keyword]);

  const commit = (next: Partial<Filters>): void => {
    onChange({ ...value, ...next });
  };

  const onKeyword = (text: string): void => {
    setKeyword(text);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => commit({ keyword: text }), 280);
  };

  const dirty = activeFilterCount(value) > 0;

  return (
    <div className="filterbar">
      <div className="search" ref={searchRef}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <circle cx="11" cy="11" r="6.5" />
          <path d="m16 16 4 4" strokeLinecap="round" />
        </svg>
        <input
          placeholder="搜照片，支持 tag: ext: year:"
          value={keyword}
          onChange={(e) => onKeyword(e.target.value)}
          title="支持 tag:精选 / ext:jpg / year:2026 / fav:1 / rating>=3 / camera:iPhone / kind:video"
        />
        {keyword && (
          <button className="clear" onClick={() => onKeyword('')} title="清除">
            ✕
          </button>
        )}
        <button
          className={`search-help${chips.length ? ' on' : ''}`}
          title="搜索语法"
          onClick={() => {
            const rect = searchRef.current?.getBoundingClientRect();
            if (rect) setHelpAt({ x: rect.left, y: rect.bottom + 6 });
          }}
        >
          {chips.length ? chips.length : '?'}
        </button>
        {!keyword && <kbd className="search-kbd">/</kbd>}
      </div>

      <select
        className="select"
        value={value.range}
        onChange={(e) => commit({ range: e.target.value as RangeKey })}
        title="拍摄时间"
      >
        {(Object.keys(RANGE_LABEL) as RangeKey[]).map((key) => (
          <option key={key} value={key}>
            {RANGE_LABEL[key]}
          </option>
        ))}
      </select>

      {!compact && (
        <>
          <select
            className="select"
            value={value.ext}
            onChange={(e) => commit({ ext: e.target.value })}
            title="文件格式"
          >
            {EXT_OPTIONS.map((ext) => (
              <option key={ext || 'all'} value={ext}>
                {ext ? `.${ext}` : '全部格式'}
              </option>
            ))}
          </select>

          <button
            className={`chip-toggle${value.favoriteOnly ? ' on' : ''}`}
            onClick={() => commit({ favoriteOnly: !value.favoriteOnly })}
          >
            ★ 收藏
          </button>
          <button
            className={`chip-toggle${value.hasGps ? ' on' : ''}`}
            onClick={() => commit({ hasGps: !value.hasGps })}
          >
            ◎ 有定位
          </button>
        </>
      )}

      <div className="spacer" />

      <select
        className="select"
        value={value.sort}
        onChange={(e) => commit({ sort: e.target.value as PhotoSort })}
        title="排序"
      >
        <option value="taken_desc">拍摄时间 新→旧</option>
        <option value="taken_asc">拍摄时间 旧→新</option>
        <option value="added_desc">导入时间 新→旧</option>
        <option value="name_asc">文件名 A→Z</option>
        <option value="size_desc">文件大小</option>
      </select>

      {dirty && (
        <button
          className="btn btn-ghost"
          onClick={() => {
            setKeyword('');
            onChange({ ...EMPTY_FILTERS });
          }}
          title="清除全部筛选条件"
        >
          清除筛选
        </button>
      )}

      {density && onDensity && (
        <div className="density" role="group" aria-label="缩略图大小">
          {(['s', 'm', 'l'] as const).map((d, i) => (
            <button
              key={d}
              className={density === d ? 'on' : ''}
              onClick={() => onDensity(d)}
              title={DENSITY_HINT[d]}
              aria-pressed={density === d}
            >
              <i style={{ width: 7 + i * 4, height: 7 + i * 4 }} />
            </button>
          ))}
        </div>
      )}

      {helpAt && (
        <Popover x={helpAt.x} y={helpAt.y} width={334} onClose={() => setHelpAt(null)}>
          <div className="popover-head">
            <b>搜索语法</b>
            <em className="sub">{chips.length ? `已识别 ${chips.length} 条` : '还没写语法'}</em>
          </div>
          <div className="syntax-body">
            {chips.length > 0 && (
              <>
                <div className="syntax-label">识别为</div>
                <div className="syntax-chips">
                  {chips.map((c, i) => (
                    <span className="syntax-chip" key={`${c.label}-${i}`}>
                      <em>{c.label}</em>
                      {c.value}
                    </span>
                  ))}
                </div>
              </>
            )}
            {parsed.unknown.length > 0 && (
              <>
                <div className="syntax-label">按文字搜</div>
                <div className="syntax-chips">
                  {parsed.unknown.map((u, i) => (
                    <span className="syntax-chip plain" key={`${u}-${i}`}>
                      {u}
                    </span>
                  ))}
                </div>
              </>
            )}
            <div className="syntax-label">可用写法</div>
            <ul className="syntax-list">
              {SEARCH_SYNTAX_HELP.map((s) => (
                <li key={s.syntax}>
                  <code>{s.syntax}</code>
                  <span>{s.desc}</span>
                </li>
              ))}
            </ul>
          </div>
        </Popover>
      )}
    </div>
  );
}

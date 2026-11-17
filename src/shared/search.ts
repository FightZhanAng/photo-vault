/**
 * 搜索语法解析 —— 主进程拼 SQL、渲染进程显示「识别结果」都用这一份。
 *
 * 为什么不放在渲染层解析再翻译成结构化查询：
 * 那样 `tag:不存在的标签` 会解析成空 tagIds（= 不加条件，等于搜全部），
 * 用户看到的是一堆结果而不是「没有结果」。放到 SQL 里按名字匹配就天然正确。
 *
 * 支持的写法（中英文别名都认）：
 *   tag:精选          标签（可逗号分隔多个，需同时命中）
 *   ext:jpg,png       扩展名
 *   year:2026         拍摄年份，或 2024-2026 区间
 *   after:2026-01-01  拍摄时间下限（含当天）
 *   before:2026-06-30 拍摄时间上限（含当天）
 *   fav:1             收藏
 *   rating>=3         评分（支持 > >= = < <=，也可 rating:3 表示 >=3）
 *   camera:iPhone     相机品牌或型号
 *   gps:1             有定位
 *   kind:video        只看视频（video / image）
 *   "海边 合影"        带引号的整段按文字搜
 * 认不出的片段按自由文本搜，不会被悄悄丢掉。
 */

import type { SmartRule } from './ipc';

export interface SearchToken {
  /** 原始输入片段，如 tag:精选 */
  raw: string;
  /** 归一化后的键，用于分组显示 */
  key: 'tag' | 'ext' | 'year' | 'date' | 'fav' | 'rating' | 'camera' | 'gps' | 'kind';
  /** 展示用的短标签，如「标签」「评分」 */
  label: string;
  /** 展示用的值，如「精选」「≥ 3」 */
  value: string;
}

export interface ParsedSearch {
  /** 自由文本片段（空格分开，用 AND 串起来搜） */
  words: string[];
  tagNames: string[];
  exts: string[];
  /** 拍摄时间闭区间，毫秒 */
  from: number | null;
  to: number | null;
  favorite: boolean | null;
  gps: boolean | null;
  ratingMin: number | null;
  ratingMax: number | null;
  camera: string | null;
  kind: 'image' | 'video' | null;
  tokens: SearchToken[];
  /** 没被识别成语法、按文字搜的片段 */
  unknown: string[];
}

const KEY_ALIAS: Record<string, string> = {
  tag: 'tag',
  标签: 'tag',
  ext: 'ext',
  格式: 'ext',
  后缀: 'ext',
  year: 'year',
  年: 'year',
  年份: 'year',
  fav: 'fav',
  favorite: 'fav',
  收藏: 'fav',
  星标: 'fav',
  rating: 'rating',
  star: 'rating',
  评分: 'rating',
  星级: 'rating',
  camera: 'camera',
  相机: 'camera',
  机身: 'camera',
  gps: 'gps',
  定位: 'gps',
  地点: 'gps',
  kind: 'kind',
  type: 'kind',
  类型: 'kind',
  after: 'after',
  since: 'after',
  之后: 'after',
  before: 'before',
  until: 'before',
  之前: 'before',
};

const TRUE_WORDS = new Set(['1', 'true', 'yes', 'y', '是', '有', '要']);
const FALSE_WORDS = new Set(['0', 'false', 'no', 'n', '否', '无', '不']);

/** 按空白切词，双引号/单引号里的空格不切 */
function tokenize(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote = '';
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = '';
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '“' || ch === '”') {
      quote = ch === '“' || ch === '”' ? '”' : ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function parseBool(v: string): boolean | null {
  const t = v.trim().toLowerCase();
  if (TRUE_WORDS.has(t)) return true;
  if (FALSE_WORDS.has(t)) return false;
  return null;
}

/** 支持 2026 / 2026-11 / 2026-11-16 / 20261116，返回当天 00:00 的毫秒 */
function parseDateStart(v: string): number | null {
  const t = v.trim().replace(/[/.]/g, '-');
  let m = /^(\d{4})$/.exec(t);
  if (m) return new Date(Number(m[1]), 0, 1).getTime();
  m = /^(\d{4})-(\d{1,2})$/.exec(t);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, 1).getTime();
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(t);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  return null;
}

/** 上限要含当天整天，所以取次日 00:00 减 1ms */
function parseDateEnd(v: string): number | null {
  const start = parseDateStart(v);
  if (start === null) return null;
  const d = new Date(start);
  if (/^\d{4}$/.test(v.trim())) return new Date(d.getFullYear() + 1, 0, 1).getTime() - 1;
  if (/^\d{4}-\d{1,2}$/.test(v.trim().replace(/[/.]/g, '-')))
    return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() - 1;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime() - 1;
}

function splitList(v: string): string[] {
  return v
    .split(/[,，|]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 一条 token 的解析结果，写回 ParsedSearch */
function applyToken(
  token: string,
  parsed: ParsedSearch
): boolean {
  const m = /^([\p{L}\p{N}_]+)(>=|<=|>|<|=|:)(.+)$/u.exec(token);
  if (!m) return false;
  const mapped = KEY_ALIAS[m[1].toLowerCase()];
  if (!mapped) return false;
  const op = m[2];
  const value = m[3].trim();
  if (!value) return false;

  const push = (key: SearchToken['key'], label: string, shown: string): void => {
    parsed.tokens.push({ raw: token, key, label, value: shown });
  };

  switch (mapped) {
    case 'tag': {
      const names = splitList(value);
      if (!names.length) return false;
      parsed.tagNames.push(...names);
      push('tag', '标签', names.join(' + '));
      return true;
    }
    case 'ext': {
      const list = splitList(value).map((e) => e.replace(/^\./, '').toLowerCase());
      if (!list.length) return false;
      parsed.exts.push(...list);
      push('ext', '格式', list.map((e) => `.${e}`).join(' / '));
      return true;
    }
    case 'year': {
      const range = /^(\d{4})\s*-\s*(\d{4})$/.exec(value);
      if (range) {
        parsed.from = Math.max(parsed.from ?? 0, Number(range[1]) === 0 ? 0 : new Date(Number(range[1]), 0, 1).getTime());
        parsed.to = Math.min(
          parsed.to ?? Number.MAX_SAFE_INTEGER,
          new Date(Number(range[2]) + 1, 0, 1).getTime() - 1
        );
        push('year', '年份', `${range[1]}–${range[2]}`);
        return true;
      }
      const y = Number(value);
      if (!Number.isInteger(y) || y < 1900 || y > 3000) return false;
      parsed.from = Math.max(parsed.from ?? 0, new Date(y, 0, 1).getTime());
      parsed.to = Math.min(parsed.to ?? Number.MAX_SAFE_INTEGER, new Date(y + 1, 0, 1).getTime() - 1);
      push('year', '年份', String(y));
      return true;
    }
    case 'after': {
      const ts = parseDateStart(value);
      if (ts === null) return false;
      parsed.from = Math.max(parsed.from ?? 0, ts);
      push('date', '起于', value);
      return true;
    }
    case 'before': {
      const ts = parseDateEnd(value);
      if (ts === null) return false;
      parsed.to = Math.min(parsed.to ?? Number.MAX_SAFE_INTEGER, ts);
      push('date', '止于', value);
      return true;
    }
    case 'fav': {
      const b = parseBool(value);
      if (b === null) return false;
      parsed.favorite = b;
      push('fav', '收藏', b ? '是' : '否');
      return true;
    }
    case 'gps': {
      const b = parseBool(value);
      if (b === null) return false;
      parsed.gps = b;
      push('gps', '定位', b ? '有' : '无');
      return true;
    }
    case 'rating': {
      const n = Number(value);
      if (!Number.isFinite(n)) return false;
      const r = Math.max(0, Math.min(5, Math.round(n)));
      if (op === '<=' ) parsed.ratingMax = Math.min(parsed.ratingMax ?? 5, r);
      else if (op === '<') parsed.ratingMax = Math.min(parsed.ratingMax ?? 5, Math.max(0, r - 1));
      else if (op === '>') parsed.ratingMin = Math.max(parsed.ratingMin ?? 0, Math.min(5, r + 1));
      else parsed.ratingMin = Math.max(parsed.ratingMin ?? 0, r);
      const shown =
        op === '<=' ? `≤ ${r}` : op === '<' ? `< ${r}` : op === '>' ? `> ${r}` : op === '=' ? `= ${r}` : `≥ ${r}`;
      push('rating', '评分', shown);
      return true;
    }
    case 'camera': {
      parsed.camera = value;
      push('camera', '相机', value);
      return true;
    }
    case 'kind': {
      const v = value.toLowerCase();
      if (['video', '视频', '影片', 'mov'].includes(v)) parsed.kind = 'video';
      else if (['image', 'photo', '图片', '照片', '图'].includes(v)) parsed.kind = 'image';
      else return false;
      push('kind', '类型', parsed.kind === 'video' ? '视频' : '图片');
      return true;
    }
    default:
      return false;
  }
}

export function parseSearch(input: string): ParsedSearch {
  const parsed: ParsedSearch = {
    words: [],
    tagNames: [],
    exts: [],
    from: null,
    to: null,
    favorite: null,
    gps: null,
    ratingMin: null,
    ratingMax: null,
    camera: null,
    kind: null,
    tokens: [],
    unknown: [],
  };
  if (!input.trim()) return parsed;

  for (const token of tokenize(input)) {
    if (applyToken(token, parsed)) continue;
    parsed.words.push(token);
    parsed.unknown.push(token);
  }

  // 区间被两头夹反了（after 比 before 晚）时给个空结果，而不是悄悄忽略
  if (parsed.from !== null && parsed.to !== null && parsed.from > parsed.to) {
    parsed.to = parsed.from - 1;
  }
  return parsed;
}

/** 语法有变化时给界面的提示，「识别结果」那一排 chip 用它 */
export function tokenChips(p: ParsedSearch): { label: string; value: string }[] {
  return p.tokens.map((t) => ({ label: t.label, value: t.value }));
}

/** 把解析结果折算成结构化规则；主进程直接用它拼 SQL，界面用它做本地预判 */
export function searchToRule(p: ParsedSearch): SmartRule {
  const rule: SmartRule = {};
  if (p.tagNames.length) rule.tagNames = p.tagNames;
  if (p.exts.length) rule.ext = p.exts;
  if (p.from !== null) rule.from = p.from;
  if (p.to !== null) rule.to = p.to;
  if (p.favorite !== null) rule.favoriteOnly = p.favorite;
  if (p.gps !== null) rule.hasGps = p.gps;
  if (p.ratingMin !== null) rule.ratingMin = p.ratingMin;
  if (p.ratingMax !== null) rule.ratingMax = p.ratingMax;
  if (p.camera) rule.camera = p.camera;
  if (p.kind) rule.kind = p.kind;
  if (p.words.length) rule.keyword = p.words.join(' ');
  return rule;
}

/** 语法速查，界面里的提示面板直接用 */
export const SEARCH_SYNTAX_HELP: { syntax: string; desc: string }[] = [
  { syntax: 'tag:精选', desc: '标签，逗号分隔表示同时命中' },
  { syntax: 'ext:jpg,png', desc: '文件格式' },
  { syntax: 'year:2026', desc: '拍摄年份，或 2024-2026' },
  { syntax: 'after:2026-01-01', desc: '拍摄时间下限（含当天）' },
  { syntax: 'before:2026-06-30', desc: '拍摄时间上限（含当天）' },
  { syntax: 'fav:1', desc: '只看收藏' },
  { syntax: 'rating>=3', desc: '评分，支持 > >= = < <=' },
  { syntax: 'camera:iPhone', desc: '相机品牌或型号' },
  { syntax: 'gps:1', desc: '只看有定位的' },
  { syntax: 'kind:video', desc: '只看视频（video / image）' },
  { syntax: '"海边 合影"', desc: '带引号按整段文字搜' },
];

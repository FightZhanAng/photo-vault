/**
 * 主题系统
 *
 * 四套主题共用同一套语义令牌（bg / surface / text / accent …），
 * 只在 CSS 里覆盖变量值，组件代码一行不用改。
 * 命名围绕「暗房」这条主线：同一张照片在不同照明条件下的观感。
 */

import { api } from './api';

export type ThemeId = 'darkroom' | 'silver' | 'safelight' | 'gallery';

export interface ThemeMeta {
  id: ThemeId;
  /** 中文名 */
  name: string;
  /** 英文小标（等宽大写，做编辑感） */
  latin: string;
  /** 一句话说明适用场景 */
  note: string;
  /** 背景 / 面板 / 强调 三色，用来画预览色块 */
  swatch: [string, string, string];
  /** 是否深色底 —— 决定 color-scheme 与窗口按钮颜色 */
  dark: boolean;
  /** Windows 标题栏覆盖层配色 */
  titlebar: { color: string; symbolColor: string };
}

export const THEMES: ThemeMeta[] = [
  {
    id: 'darkroom',
    name: '暗房',
    latin: 'DARKROOM',
    note: '暖近黑 + 钠灯橙，久看不累',
    swatch: ['#100f0d', '#1e1b16', '#e2a03f'],
    dark: true,
    titlebar: { color: '#100f0d', symbolColor: '#cfc6b5' },
  },
  {
    id: 'silver',
    name: '银盐',
    latin: 'SILVER',
    note: '冷灰石墨 + 银蓝，比对细节',
    swatch: ['#0b0d10', '#181c22', '#86b6d8'],
    dark: true,
    titlebar: { color: '#0b0d10', symbolColor: '#c2ccd8' },
  },
  {
    id: 'safelight',
    name: '红灯',
    latin: 'SAFELIGHT',
    note: '安全灯下的深红，夜间整理',
    swatch: ['#120a0b', '#221316', '#e2563f'],
    dark: true,
    titlebar: { color: '#120a0b', symbolColor: '#d8bdb6' },
  },
  {
    id: 'gallery',
    name: '画廊',
    latin: 'GALLERY',
    note: '米白相纸 + 朱砂，白天挑片',
    swatch: ['#efeade', '#f8f4ea', '#a83a20'],
    dark: false,
    titlebar: { color: '#efeade', symbolColor: '#3a342a' },
  },
];

const THEME_KEY = 'vault.theme';

export function isThemeId(value: unknown): value is ThemeId {
  return THEMES.some((t) => t.id === value);
}

/**
 * 读上次选的主题。
 * 默认给「暗房」：图片在暖近黑底上最跳，这也是这套界面的原始设定。
 * （不跟随系统浅色 —— 系统浅色下默认变成相纸主题，会让首屏认不出这是同一个产品）
 */
export function loadTheme(): ThemeId {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (isThemeId(saved)) return saved;
  } catch {
    /* 隐私模式下 localStorage 可能不可用 */
  }
  return 'darkroom';
}

export function themeMeta(id: ThemeId): ThemeMeta {
  return THEMES.find((t) => t.id === id) ?? THEMES[0];
}

/**
 * 把主题写到 <html data-theme>，同步窗口按钮配色。
 * 不使用 React 状态做样式，避免首屏闪一下旧主题。
 */
export function applyTheme(id: ThemeId): void {
  const meta = themeMeta(id);
  const root = document.documentElement;
  root.dataset.theme = meta.id;
  root.style.colorScheme = meta.dark ? 'dark' : 'light';
  try {
    localStorage.setItem(THEME_KEY, meta.id);
  } catch {
    /* 忽略写入失败 */
  }
  // 浅色主题下窗口右上角按钮必须换深色，否则白底白图标
  applyTitlebar(meta.titlebar);
}

/** 同步窗口右上角系统按钮的配色（能力不存在时静默跳过） */
export function applyTitlebar(colors: { color: string; symbolColor: string }): void {
  const pending = api?.app?.setTitlebar?.(colors);
  void pending?.catch(() => undefined);
}

/**
 * 大图 / 幻灯片是全屏暗底，右上角的系统按钮要跟着变暗。
 * 否则浅色主题下那里会浮着一块米白色，和整块黑底割裂。
 */
export function applyViewerTitlebar(): void {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--viewer-bg').trim();
  applyTitlebar({
    color: /^#[0-9a-f]{3,8}$/i.test(raw) ? raw : '#0a0908',
    symbolColor: '#d6cdbf',
  });
}

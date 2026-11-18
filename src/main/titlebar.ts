import { BrowserWindow } from 'electron';

/**
 * 窗口右上角那三个系统按钮（Windows 覆盖层）的配色。
 *
 * 覆盖层是系统画的，跟着主题走要靠 setTitleBarOverlay 手动同步；
 * 而且它在窗口最大化 / 还原 / 重新获得焦点后偶尔会掉回默认色，
 * 所以这里存一份「当前配色」，需要时重新贴一遍。
 */

/** 与 styles.css 里 .titlebar 的高度保持一致 */
export const TITLEBAR_HEIGHT = 40;

export interface TitlebarColors {
  color: string;
  symbolColor: string;
}

const DEFAULT_COLORS: TitlebarColors = { color: '#16171a', symbolColor: '#d8d9dd' };

let current: TitlebarColors = DEFAULT_COLORS;

function paint(win: BrowserWindow, colors: TitlebarColors): void {
  if (win.isDestroyed()) return;
  try {
    win.setTitleBarOverlay({ ...colors, height: TITLEBAR_HEIGHT });
  } catch {
    /* 非 Windows、或窗口还没启用覆盖层时忽略 */
  }
}

/** 记住配色并立刻应用到所有窗口 */
export function applyTitlebar(colors: Partial<TitlebarColors> | null | undefined): TitlebarColors {
  const next: TitlebarColors = {
    color: typeof colors?.color === 'string' ? colors.color : current.color,
    symbolColor: typeof colors?.symbolColor === 'string' ? colors.symbolColor : current.symbolColor,
  };
  current = next;
  for (const win of BrowserWindow.getAllWindows()) paint(win, next);
  return next;
}

/** 新窗口创建后要把当前配色贴上去（构造参数里的只是启动默认值） */
export function repaintTitlebar(): void {
  for (const win of BrowserWindow.getAllWindows()) paint(win, current);
}

export function currentTitlebar(): TitlebarColors {
  return current;
}

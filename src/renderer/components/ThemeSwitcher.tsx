import { useState, type MouseEvent } from 'react';
import { THEMES } from '../theme';
import { useApp } from '../store';
import Popover from './Popover';

/**
 * 主题切换器：侧栏底部一个「照明条件」入口。
 * 显示当前主题的三色块，点开是四套主题的可视化选择。
 */
export default function ThemeSwitcher() {
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);

  const current = THEMES.find((t) => t.id === theme) ?? THEMES[0];

  const open = (e: MouseEvent<HTMLButtonElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    // 按钮贴着窗口底部，浮层向上展开
    setAt({ x: rect.left, y: rect.top });
  };

  return (
    <>
      <button className="theme-btn" onClick={open} title="切换主题（也在 Ctrl+K 里）">
        <span className="swatch" aria-hidden>
          {current.swatch.map((c) => (
            <i key={c} style={{ background: c }} />
          ))}
        </span>
        <span className="theme-btn-text">
          <span className="theme-btn-label">主题</span>
          <b>{current.name}</b>
        </span>
        <span className="theme-btn-caret">⌄</span>
      </button>

      {at && (
        <Popover x={at.x} y={at.y} width={306} placement="above" onClose={() => setAt(null)}>
          <div className="popover-head">
            主题
            <span className="sub">照明条件</span>
          </div>
          <div className="theme-list">
            {THEMES.map((t) => (
              <button
                key={t.id}
                className={`theme-opt${t.id === theme ? ' on' : ''}`}
                onClick={() => {
                  setTheme(t.id);
                  setAt(null);
                }}
              >
                <span className="swatch big" aria-hidden>
                  {t.swatch.map((c) => (
                    <i key={c} style={{ background: c }} />
                  ))}
                </span>
                <span className="theme-opt-text">
                  <span className="theme-opt-name">
                    {t.name}
                    <em>{t.latin}</em>
                  </span>
                  <span className="theme-opt-note">{t.note}</span>
                </span>
                {t.id === theme && <span className="theme-check">✓</span>}
              </button>
            ))}
          </div>
          <div className="popover-foot">
            <span className="hint">Ctrl + K 里也能切；选择会记住。</span>
          </div>
        </Popover>
      )}
    </>
  );
}

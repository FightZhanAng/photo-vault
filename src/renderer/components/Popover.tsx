import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

interface PopoverProps {
  x: number;
  y: number;
  width?: number;
  /** below：y 是浮层顶边；above：y 是锚点顶边，浮层向上展开 */
  placement?: 'below' | 'above';
  onClose: () => void;
  children: ReactNode;
}

/**
 * 轻量浮层：点外部关闭，位置按视口自动收边。
 * 先量真实高度再定位 —— 用固定高度估算时，短浮层（打标签只有两行）
 * 会被顶到屏幕中间，跟触发它的按钮断开。
 */
export default function Popover({
  x,
  y,
  width = 236,
  placement = 'below',
  onClose,
  children,
}: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = (): void => {
      const h = el.offsetHeight;
      const w = el.offsetWidth;
      const top =
        placement === 'above'
          ? Math.max(12, y - h - 8)
          : Math.min(Math.max(12, y), Math.max(12, window.innerHeight - h - 12));
      setPos({
        left: Math.min(Math.max(8, x), Math.max(8, window.innerWidth - w - 12)),
        top,
      });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [x, y, placement]);

  return (
    <>
      <div className="popover-backdrop" onMouseDown={onClose} />
      <div className="popover" ref={ref} style={{ left: pos.left, top: pos.top, width }}>
        {children}
      </div>
    </>
  );
}

import type { ReactNode } from 'react';

interface Props {
  count: number;
  onClear: () => void;
  children: ReactNode;
}

/**
 * 选中照片后的浮动操作条。
 * 不占顶栏空间，选多少张都不会让标题跳位。
 */
export default function SelectionBar({ count, onClear, children }: Props) {
  return (
    <div className="selbar" role="toolbar" aria-label="已选照片操作">
      <span className="selbar-count">
        <b>{count}</b>
        <span>张已选</span>
      </span>
      <span className="selbar-div" />
      <div className="selbar-actions">{children}</div>
      <span className="selbar-div" />
      <button className="selbar-clear" onClick={onClear} title="取消选择">
        清除
      </button>
    </div>
  );
}

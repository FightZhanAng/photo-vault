import Popover from './Popover';

export interface RowMenuItem {
  label: string;
  /** 右侧灰色小字，用来补充说明或显示数量 */
  hint?: string;
  danger?: boolean;
  onClick: () => void;
}

/**
 * 侧栏行上的「⋯」菜单。
 * 相册和标签都需要「改名 / 改色 / 删除」这类低频操作，
 * 挂在行尾比塞进顶栏更省地方，也不用为每种对象各写一套。
 */
export default function RowMenu({
  x,
  y,
  width = 176,
  items,
  onClose,
}: {
  x: number;
  y: number;
  width?: number;
  items: RowMenuItem[];
  onClose: () => void;
}) {
  return (
    <Popover x={x} y={y} width={width} onClose={onClose}>
      <div className="menu">
        {items.map((item) => (
          <button
            key={item.label}
            className={`menu-item${item.danger ? ' danger' : ''}`}
            onClick={() => {
              onClose();
              item.onClick();
            }}
          >
            <span>{item.label}</span>
            {item.hint ? <em>{item.hint}</em> : null}
          </button>
        ))}
      </div>
    </Popover>
  );
}

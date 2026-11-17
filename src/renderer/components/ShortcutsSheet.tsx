import Modal from './Modal';

const GROUPS: { title: string; rows: [string, string][] }[] = [
  {
    title: '全局',
    rows: [
      ['Ctrl / ⌘ + K', '命令面板：跳相册、标签、任务，切主题'],
      ['/', '聚焦筛选栏搜索框'],
      ['?', '打开这份快捷键表'],
      ['Esc', '关闭当前浮层 / 大图 / 幻灯片'],
    ],
  },
  {
    title: '选片',
    rows: [
      ['Ctrl / ⌘ + 点击', '加入或移出选择'],
      ['右键格子', '切换选中（等同勾选按钮）'],
      ['选中后', '底部浮出操作条：打标签、加相册、重命名、导出'],
    ],
  },
  {
    title: '大图与幻灯片',
    rows: [
      ['← / →', '上一张 / 下一张'],
      ['1 – 5', '打分，0 清除'],
      ['Enter / Delete', '收件箱里：保留入库 / 淘汰'],
      ['空格', '幻灯片暂停或继续'],
    ],
  },
];

export default function ShortcutsSheet({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      title="键盘与操作"
      subtitle="不用记全部，记住 Ctrl+K 就够用"
      width={520}
      onClose={onClose}
      footer={
        <>
          <div className="spacer" />
          <button className="btn btn-primary" onClick={onClose}>
            知道了
          </button>
        </>
      }
    >
      <div className="shortcut-groups">
        {GROUPS.map((g) => (
          <section key={g.title}>
            <h4>{g.title}</h4>
            {g.rows.map(([keys, desc]) => (
              <div className="shortcut-row" key={keys}>
                <kbd>{keys}</kbd>
                <span>{desc}</span>
              </div>
            ))}
          </section>
        ))}
      </div>
    </Modal>
  );
}

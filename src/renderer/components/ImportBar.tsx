import type { ImportProgress } from '@shared/ipc';

const PHASE_LABEL: Record<ImportProgress['phase'], string> = {
  scanning: '扫描目录',
  deduping: '查重与读取',
  thumbnailing: '生成缩略图',
  writing: '写入库',
  done: '导入完成',
  cancelled: '已取消',
  error: '导入失败',
};

export default function ImportBar({
  progress,
  onCancel,
}: {
  progress: ImportProgress;
  onCancel: () => void;
}) {
  const percent = progress.total > 0 ? Math.min(100, (progress.processed / progress.total) * 100) : 0;
  const finished = ['done', 'cancelled', 'error'].includes(progress.phase);

  return (
    <div className="import-bar">
      <div className="info">
        <b>{PHASE_LABEL[progress.phase]}</b>
        {progress.total > 0 ? ` ${progress.processed}/${progress.total}` : ''}
        {' · '}新增 {progress.added}
        {progress.skippedDup > 0 ? ` · 跳过 ${progress.skippedDup}` : ''}
        {progress.failed > 0 ? ` · 失败 ${progress.failed}` : ''}
        {progress.currentFile ? ` · ${progress.currentFile}` : ''}
        {progress.message ? ` · ${progress.message}` : ''}
      </div>
      <div className="track">
        <i style={{ width: `${finished ? 100 : percent}%` }} />
      </div>
      {!finished && (
        <button className="btn btn-ghost" onClick={onCancel}>
          取消
        </button>
      )}
    </div>
  );
}

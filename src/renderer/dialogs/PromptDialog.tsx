import { useState } from 'react';
import Modal from '../components/Modal';

interface PromptDialogProps {
  title: string;
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  /** 描述这类内容需要多行 */
  multiline?: boolean;
  confirmLabel?: string;
  hint?: string;
  /** 允许提交空值（用于「清空描述」这类操作） */
  allowEmpty?: boolean;
  onClose: () => void;
  onSubmit: (value: string) => Promise<void> | void;
}

/**
 * 单字段输入弹窗。
 * 相册改名、标签改名、改描述、改颜色都用它 —— 避免为每个字段各写一个 Modal。
 */
export default function PromptDialog({
  title,
  label,
  defaultValue = '',
  placeholder,
  multiline = false,
  confirmLabel = '保存',
  hint,
  allowEmpty = false,
  onClose,
  onSubmit,
}: PromptDialogProps) {
  const [value, setValue] = useState(defaultValue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    const next = value.trim();
    if (!next && !allowEmpty) {
      setError('不能为空');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(next);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={title}
      onClose={onClose}
      width={430}
      locked={busy}
      footer={
        <>
          <div className="spacer" />
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={busy}>
            {busy ? '保存中…' : confirmLabel}
          </button>
        </>
      }
    >
      {label && <label className="field-label">{label}</label>}
      {multiline ? (
        <textarea
          className="input"
          rows={4}
          autoFocus
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit();
          }}
        />
      ) : (
        <input
          className="input"
          autoFocus
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
            if (e.key === 'Escape') onClose();
          }}
        />
      )}
      {hint && <p className="hint">{hint}</p>}
      {error && <p className="danger-text">{error}</p>}
    </Modal>
  );
}

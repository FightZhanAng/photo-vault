import { useState, type ReactNode } from 'react';
import Modal from '../components/Modal';

interface ConfirmDialogProps {
  title: string;
  children: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 破坏性操作：确认按钮变红，并在按钮左侧出现一行不可撤销提示 */
  danger?: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void> | void;
}

/** 通用确认层。所有不可撤销的动作都走它，措辞集中在调用处。 */
export default function ConfirmDialog({
  title,
  children,
  confirmLabel = '确定',
  cancelLabel = '取消',
  danger = false,
  onClose,
  onConfirm,
}: ConfirmDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
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
      width={452}
      locked={busy}
      footer={
        <>
          <div className="spacer" />
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            onClick={() => void run()}
            disabled={busy}
          >
            {busy ? '处理中…' : confirmLabel}
          </button>
        </>
      }
    >
      {children}
      {error && <p className="danger-text">{error}</p>}
    </Modal>
  );
}

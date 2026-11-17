import type { IpcErrorCode } from '@shared/ipc';

/** 业务异常：带错误码，跨 IPC 时会转成 IpcError */
export class AppError extends Error {
  constructor(
    public readonly code: IpcErrorCode,
    message: string,
    public readonly detail?: string
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function toIpcError(err: unknown): { code: IpcErrorCode; message: string; detail?: string } {
  if (err instanceof AppError) {
    return { code: err.code, message: err.message, detail: err.detail };
  }
  const e = err as { code?: string; message?: string; stack?: string };
  // SQLite 的错误码是字符串（SQLITE_CONSTRAINT 等）
  if (typeof e?.code === 'string' && e.code.startsWith('SQLITE')) {
    return { code: 'E_DB', message: e.message ?? '数据库操作失败', detail: e.code };
  }
  if (typeof e?.code === 'string' && e.code.startsWith('EACCES')) {
    return { code: 'E_IO', message: e.message ?? '文件访问被拒绝', detail: e.code };
  }
  return { code: 'E_UNKNOWN', message: e?.message ?? '未知错误', detail: e?.stack?.split('\n')[1]?.trim() };
}

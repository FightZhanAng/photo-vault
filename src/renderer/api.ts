import type { IpcErrorCode, IpcResult } from '@shared/ipc';

export const api = window.vault;

export class ApiError extends Error {
  constructor(
    public readonly code: IpcErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** 把 IpcResult 拆成「值或抛错」，调用处就不用每次判断 ok */
export async function unwrap<T>(promise: Promise<IpcResult<T>>): Promise<T> {
  const result = await promise;
  if (!result.ok) throw new ApiError(result.error.code, result.error.message);
  return result.data;
}

export function errorText(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

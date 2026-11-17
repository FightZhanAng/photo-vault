import { DatabaseSync } from 'node:sqlite';

/**
 * 对 node:sqlite 的薄封装，把 API 对齐到我们需要的形状。
 *
 * 为什么不用 better-sqlite3：
 * 它需要按 Electron ABI 重新编译，本机没有 VS Build Tools，官方也没有
 * Electron 45 的预编译包。Electron 45 内置的 node:sqlite 已验证可用，
 * 免编译、打包体积也更小。
 *
 * 与 better-sqlite3 的两处差异在这一层吸收掉：
 * 1. 没有 .pragma() —— 用 exec('PRAGMA ...')
 * 2. 没有 .transaction() —— 手动 BEGIN / COMMIT / ROLLBACK
 */

export interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

export interface Stmt {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

export interface Db {
  prepare(sql: string): Stmt;
  exec(sql: string): void;
  close(): void;
  transaction<A extends unknown[], T>(fn: (...args: A) => T): (...args: A) => T;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyStatement = {
  run: (...p: any[]) => { changes: number | bigint; lastInsertRowid: number | bigint };
  get: (...p: any[]) => unknown;
  all: (...p: any[]) => unknown[];
};

function wrapStatement(raw: AnyStatement): Stmt {
  return {
    run: (...params) => {
      const r = raw.run(...params);
      return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
    },
    get: (...params) => raw.get(...params) as Record<string, unknown> | undefined,
    all: (...params) => raw.all(...params) as Record<string, unknown>[],
  };
}

export function openSqlite(path: string): Db {
  const raw = new DatabaseSync(path);
  let depth = 0;

  return {
    prepare: (sql) => wrapStatement(raw.prepare(sql) as unknown as AnyStatement),
    exec: (sql) => raw.exec(sql),
    close: () => raw.close(),
    transaction: <A extends unknown[], T>(fn: (...args: A) => T) => {
      return (...args: A) => {
        // 支持嵌套：只在最外层真正开事务
        if (depth > 0) {
          depth++;
          try {
            return fn(...args);
          } finally {
            depth--;
          }
        }
        raw.exec('BEGIN');
        depth = 1;
        try {
          const result = fn(...args);
          raw.exec('COMMIT');
          return result;
        } catch (e) {
          try {
            raw.exec('ROLLBACK');
          } catch {
            /* 回滚失败时保留原始异常 */
          }
          throw e;
        } finally {
          depth = 0;
        }
      };
    },
  };
}

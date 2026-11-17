import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RecentLibrary } from '@shared/ipc';

interface StoredRecent {
  dbPath: string;
  name: string;
  rootPath: string;
  lastOpenedAt: number;
}

function filePath(): string {
  return join(app.getPath('userData'), 'recent-libraries.json');
}

function readStored(): StoredRecent[] {
  try {
    const raw = JSON.parse(readFileSync(filePath(), 'utf8'));
    return Array.isArray(raw) ? (raw as StoredRecent[]) : [];
  } catch {
    return [];
  }
}

function writeStored(list: StoredRecent[]): void {
  const path = filePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(list.slice(0, 10), null, 2), 'utf8');
}

export function readRecent(): RecentLibrary[] {
  return readStored().map((r) => ({ ...r, exists: existsSync(r.dbPath) }));
}

export function rememberLibrary(info: { dbPath: string; name: string; rootPath: string }): void {
  const list = readStored().filter((r) => r.dbPath !== info.dbPath);
  list.unshift({ ...info, lastOpenedAt: Date.now() });
  writeStored(list);
}

export function forgetRecent(dbPath: string): void {
  writeStored(readStored().filter((r) => r.dbPath !== dbPath));
}

export function lastLibraryPath(): string | null {
  const list = readStored();
  return list.find((r) => existsSync(r.dbPath))?.dbPath ?? null;
}

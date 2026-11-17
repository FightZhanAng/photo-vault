import type { VaultApi } from './ipc';

declare global {
  interface Window {
    /** preload 注入，见 src/preload/index.ts */
    vault: VaultApi;
  }
}

export {};

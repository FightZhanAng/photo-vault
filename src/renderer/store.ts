import { create } from 'zustand';
import type {
  Album,
  CollectTask,
  ImportProgress,
  InboxStats,
  LibraryInfo,
  Tag,
  UploadServerStatus,
} from '@shared/ipc';
import { api, unwrap } from './api';
import { applyTheme, loadTheme, type ThemeId } from './theme';

/** 网格密度：小图看得多，大图看得清 */
export type Density = 's' | 'm' | 'l';

export const DENSITY_CELL: Record<Density, number> = { s: 128, m: 176, l: 236 };

const DENSITY_KEY = 'vault.density';

function loadDensity(): Density {
  const saved = localStorage.getItem(DENSITY_KEY);
  return saved === 's' || saved === 'm' || saved === 'l' ? saved : 'm';
}

export type View =
  | { type: 'timeline' }
  | { type: 'inbox' }
  | { type: 'album'; id: number; name: string }
  | { type: 'tag'; id: number; name: string }
  | { type: 'task'; id: number; name: string }
  | { type: 'tasks' }
  | { type: 'duplicates' }
  | { type: 'locations' }
  | { type: 'imports' }
  | { type: 'storage' }
  | { type: 'settings' };

/** 偏好的 key 集中在这里，避免各处手写字符串拼错 */
export const PREF = {
  autoKeep: 'import.autoKeep',
  /** 值以 KB 为单位，导入时换算成字节 */
  minKb: 'import.minKb',
  defaultSort: 'default.sort',
  exportFormat: 'export.format',
  /** 腾讯位置服务的 Key，用于「地点」页的底图；留空就用本地散点图 */
  mapKey: 'map.key',
} as const;

export function prefBool(prefs: Record<string, string>, key: string, fallback = false): boolean {
  const v = prefs[key];
  if (v === undefined) return fallback;
  return v === '1' || v === 'true';
}

interface AppState {
  booting: boolean;
  library: LibraryInfo | null;
  view: View;
  stats: InboxStats | null;
  albums: Album[];
  tags: Tag[];
  tasks: CollectTask[];
  upload: UploadServerStatus | null;
  progress: ImportProgress | null;
  toast: string | null;
  /** 数据变更版本号，页面监听它来重新拉取 */
  dataVersion: number;
  theme: ThemeId;
  density: Density;
  /** 库级偏好（存在 settings 表里，跟着库走） */
  prefs: Record<string, string>;

  bumpData: () => void;
  setTheme: (theme: ThemeId) => void;
  setDensity: (density: Density) => void;
  boot: () => Promise<void>;
  reloadLibrary: () => Promise<void>;
  setView: (view: View) => void;
  refreshStats: () => Promise<void>;
  refreshAlbums: () => Promise<void>;
  refreshTags: () => Promise<void>;
  refreshTasks: () => Promise<void>;
  refreshUpload: () => Promise<void>;
  refreshPrefs: () => Promise<void>;
  setPref: (patch: Record<string, string>) => Promise<void>;
  setProgress: (progress: ImportProgress | null) => void;
  showToast: (message: string) => void;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;

export const useApp = create<AppState>((set, get) => ({
  booting: true,
  library: null,
  view: { type: 'timeline' },
  stats: null,
  albums: [],
  tags: [],
  tasks: [],
  upload: null,
  progress: null,
  toast: null,
  dataVersion: 0,
  theme: loadTheme(),
  density: loadDensity(),
  prefs: {},

  bumpData: () => {
    set((s) => ({ dataVersion: s.dataVersion + 1 }));
    // 相册与标签上的张数是派生数据（智能相册还是按规则现算的），
    // 任何一次改动都可能让它们变，顺手刷一遍，别让侧栏数字停在上一次
    void get().refreshAlbums();
    void get().refreshTags();
  },

  setTheme: (theme) => {
    applyTheme(theme);
    set({ theme });
  },

  setDensity: (density) => {
    try {
      localStorage.setItem(DENSITY_KEY, density);
    } catch {
      /* 忽略 */
    }
    set({ density });
  },

  boot: async () => {
    try {
      const library = await unwrap(api.library.current());
      set({ library, booting: false });
      if (library) {
        set({ view: library.inboxCount > 0 ? { type: 'inbox' } : { type: 'timeline' } });
        await Promise.all([
          get().refreshStats(),
          get().refreshAlbums(),
          get().refreshTags(),
          get().refreshTasks(),
          get().refreshUpload(),
          get().refreshPrefs(),
        ]);
      }
    } catch {
      set({ library: null, booting: false });
    }
  },

  reloadLibrary: async () => {
    const library = await unwrap(api.library.current());
    set({ library });
    if (library) {
      await Promise.all([
        get().refreshStats(),
        get().refreshAlbums(),
        get().refreshTags(),
        get().refreshTasks(),
        get().refreshUpload(),
        get().refreshPrefs(),
      ]);
    }
  },

  setView: (view) => set({ view }),

  refreshStats: async () => {
    try {
      set({ stats: await unwrap(api.inbox.stats()) });
    } catch {
      /* 未打开库时忽略 */
    }
  },

  refreshAlbums: async () => {
    try {
      set({ albums: await unwrap(api.album.list()) });
    } catch {
      /* 未打开库时忽略 */
    }
  },

  refreshTags: async () => {
    try {
      set({ tags: await unwrap(api.tag.list()) });
    } catch {
      /* 未打开库时忽略 */
    }
  },

  refreshTasks: async () => {
    try {
      set({ tasks: await unwrap(api.task.list(true)) });
    } catch {
      /* 未打开库时忽略 */
    }
  },

  refreshUpload: async () => {
    try {
      set({ upload: await unwrap(api.upload.status()) });
    } catch {
      /* 未打开库时忽略 */
    }
  },

  refreshPrefs: async () => {
    try {
      set({ prefs: await unwrap(api.settings.getAll()) });
    } catch {
      /* 未打开库时忽略 */
    }
  },

  setPref: async (patch) => {
    await unwrap(api.settings.set(patch));
    set((s) => ({ prefs: { ...s.prefs, ...patch } }));
  },

  setProgress: (progress) => set({ progress }),

  showToast: (message) => {
    set({ toast: message });
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => set({ toast: null }), 2600);
  },
}));

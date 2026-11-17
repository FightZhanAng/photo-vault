/**
 * IPC 契约 —— 主进程与渲染进程之间唯一的事实来源。
 *
 * 约定：
 * 1. 所有 invoke 结果统一包成 IpcResult，异常不跨进程传播（避免错误栈丢失）。
 * 2. 渲染进程永远拿不到真实文件系统路径以外的能力，也不直接碰 db / fs。
 * 3. 缩略图与大图通过自定义协议 vault:// 提供，不把绝对路径塞进 <img src>。
 * 4. 分页游标是「不透明字符串」，排序规则变化不影响契约。
 */

// ---------------------------------------------------------------------------
// 结果与错误
// ---------------------------------------------------------------------------

export type IpcErrorCode =
  | 'E_NOT_INITIALIZED' // 还没打开任何库
  | 'E_NOT_FOUND'
  | 'E_INVALID_ARG'
  | 'E_DB'
  | 'E_IO'
  | 'E_UNSUPPORTED' // 文件格式不支持 / 平台不支持
  | 'E_CANCELLED' // 用户取消或任务被中断
  | 'E_BUSY' // 已有导入在跑
  | 'E_UNKNOWN';

export interface IpcError {
  code: IpcErrorCode;
  message: string;
  detail?: string;
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError };

// ---------------------------------------------------------------------------
// 领域模型
// ---------------------------------------------------------------------------

export type LibraryMode = 'reference' | 'managed';
export type PhotoStatus = 'inbox' | 'kept' | 'rejected' | 'archived';

export interface LibraryInfo {
  id: number;
  name: string;
  rootPath: string;
  dbPath: string;
  thumbsPath: string;
  mode: LibraryMode;
  createdAt: number;
  /** 以下为聚合统计，主进程每次查询时现算（万级数据可接受） */
  photoCount: number;
  inboxCount: number;
  keptCount: number;
  totalBytes: number;
}

export interface RecentLibrary {
  dbPath: string;
  name: string;
  rootPath: string;
  lastOpenedAt: number;
  exists: boolean;
}

export interface Photo {
  id: number;
  libraryId: number;
  path: string;
  fileName: string;
  ext: string;
  size: number;
  width: number | null;
  height: number | null;
  orientation: number;
  takenAt: number | null;
  cameraMake: string | null;
  cameraModel: string | null;
  gpsLat: number | null;
  gpsLon: number | null;
  durationMs: number | null;
  status: PhotoStatus;
  rating: number;
  favorite: boolean;
  note: string | null;
  missing: boolean;
  createdAt: number;
  updatedAt: number;
  /** vault://thumb/<id>     网格用，长边 320 */
  thumbUrl: string;
  /** vault://preview/<id>  审核/大图用，长边 1600 */
  previewUrl: string;
  /** vault://original/<id> 原图/查看 1:1 */
  originalUrl: string;
}

export interface Album {
  id: number;
  libraryId: number;
  name: string;
  description: string | null;
  kind: 'manual' | 'smart';
  ruleJson: string | null;
  coverPhotoId: number | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  photoCount: number;
  /** 封面用 vault://thumb/<id>，没有则 null */
  coverThumbUrl: string | null;
}

export interface CollectTask {
  id: number;
  libraryId: number;
  name: string;
  note: string | null;
  deadlineAt: number | null;
  targetCount: number | null;
  defaultAlbumId: number | null;
  coverPhotoId: number | null;
  state: 'open' | 'closed';
  createdAt: number;
  closedAt: number | null;
  photoCount: number;
  keptCount: number;
  inboxCount: number;
  /** P2 上传才有值；本地阶段恒为 null */
  uploadEndpoint: string | null;
}

export interface Tag {
  id: number;
  libraryId: number;
  name: string;
  parentId: number | null;
  color: string | null;
  createdAt: number;
  photoCount: number;
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

export type PhotoSort =
  | 'taken_desc'
  | 'taken_asc'
  | 'added_desc'
  | 'name_asc'
  | 'size_desc';

/**
 * 智能相册的筛选规则，也是 PhotoQuery 的公共部分。
 * 空规则 = 匹配全部（UI 侧禁止保存空规则，避免出现"假相册"）。
 */
export interface SmartRule {
  status?: PhotoStatus[];
  /** takenAt 闭区间，毫秒 */
  from?: number;
  to?: number;
  tagIds?: number[];
  tagMode?: 'any' | 'all';
  /** 按标签名匹配（搜索语法用）：名字对不上就自然没有结果，不会退化成「不筛选」 */
  tagNames?: string[];
  favoriteOnly?: boolean;
  hasGps?: boolean;
  minWidth?: number;
  minHeight?: number;
  ext?: string[];
  keyword?: string;
  ratingMin?: number;
  ratingMax?: number;
  /** 相机品牌或型号，模糊匹配 */
  camera?: string;
  /** 媒体类型 */
  kind?: 'image' | 'video';
  /** 经纬度闭区间，地点视图按格子取照片用 */
  latMin?: number;
  latMax?: number;
  lonMin?: number;
  lonMax?: number;
  /**
   * 原始搜索串（含 tag:/ext:/year: 这类语法糖）。
   * 给了它就以解析结果为准，不再单独使用 keyword。
   */
  q?: string;
}

export interface PhotoQuery extends SmartRule {
  albumId?: number;
  taskId?: number;
  sort?: PhotoSort;
  /** 上一页返回的 nextCursor，原样传回 */
  cursor?: string;
  limit?: number;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  /** 满足条件的总数（每页都算一次，万级数据 <10ms） */
  total: number;
}

/**
 * 相似照片分组。用 dHash 汉明距离聚类，距离越小越像。
 * 组内第一张是「建议保留」的那张（分辨率最高 / 体积最大 / 最早入库）。
 */
export interface DuplicateItem {
  photoId: number;
  fileName: string;
  size: number;
  width: number | null;
  height: number | null;
  takenAt: number | null;
  status: PhotoStatus;
  thumbUrl: string;
  previewUrl: string;
}

export interface DuplicateGroup {
  key: string;
  /** 组内与代表图的最大差异（0 = 完全一致） */
  distance: number;
  items: DuplicateItem[];
}

// ---------------------------------------------------------------------------
// 导入
// ---------------------------------------------------------------------------

export interface ImportScanResult {
  sourcePath: string;
  fileCount: number;
  imageCount: number;
  videoCount: number;
  unsupportedCount: number;
  totalBytes: number;
  /** 按文件大小与库内已有照片对撞出的「疑似重复」数量，仅供参考 */
  suspectedDup: number;
  earliestTakenAt: number | null;
  latestTakenAt: number | null;
}

export interface ImportStartInput {
  /** 目录：整目录扫描（与 paths 二选一，都给了就合并） */
  sourcePath?: string;
  /** 显式路径列表（拖拽导入）：文件、目录可以混着拖 */
  paths?: string[];
  recursive: boolean;
  /** 归到某个收集任务下（可选） */
  taskId?: number;
  /** 顺手加入某个相册（可选） */
  albumId?: number;
  /** true = 跳过收件箱直接入选；默认 false，先进 inbox */
  autoKeep?: boolean;
  /** 小于该字节数的文件跳过（默认 1KB，过滤缩略图缓存这类垃圾） */
  minFileSize?: number;
  /** 文件名的来源标注，写进 task_photos.source_label */
  sourceLabel?: string;
}

export type ImportPhase =
  | 'scanning'
  | 'deduping'
  | 'thumbnailing'
  | 'writing'
  | 'done'
  | 'cancelled'
  | 'error';

export interface ImportProgress {
  batchId: number;
  phase: ImportPhase;
  processed: number;
  total: number;
  added: number;
  skippedDup: number;
  failed: number;
  /** 当前处理的文件名，用于底部进度条 */
  currentFile?: string;
  /** 错误或提示信息 */
  message?: string;
}

export interface ImportBatch {
  id: number;
  libraryId: number;
  sourcePath: string;
  taskId: number | null;
  total: number;
  added: number;
  skippedDup: number;
  failed: number;
  state: 'running' | 'done' | 'cancelled' | 'failed';
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

// ---------------------------------------------------------------------------
// 变更入参
// ---------------------------------------------------------------------------

export interface PhotoPatch {
  rating?: number;
  favorite?: boolean;
  note?: string | null;
  takenAt?: number | null;
  gpsLat?: number | null;
  gpsLon?: number | null;
}

/**
 * 视频首帧回写。
 *
 * 视频不像图片能用 sharp 直接解，所以首帧由渲染进程的 <video> 播放器渲染到 canvas，
 * 再把一帧（长边 ≤ 1600 的 webp）交回主进程落盘成缩略图。主进程顺手缩小出 320。
 */
export interface VideoPosterInput {
  photoId: number;
  /** data:image/webp;base64,... 或 data:image/png;base64,... */
  dataUrl: string;
  /** 原始视频像素尺寸，用于网格里保留比例、大图里显示规格 */
  width: number;
  height: number;
  /** 视频时长，毫秒 */
  durationMs: number;
}

export interface AlbumCreateInput {
  name: string;
  description?: string;
  photoIds?: number[];
  kind?: 'manual' | 'smart';
  rule?: SmartRule;
}

export interface AlbumPatch {
  name?: string;
  description?: string | null;
  coverPhotoId?: number | null;
  sortOrder?: number;
  rule?: SmartRule;
}

export interface TaskCreateInput {
  name: string;
  note?: string;
  deadlineAt?: number | null;
  targetCount?: number | null;
  defaultAlbumId?: number | null;
}

export interface TaskPatch {
  name?: string;
  note?: string | null;
  deadlineAt?: number | null;
  targetCount?: number | null;
  defaultAlbumId?: number | null;
}

export interface LibraryCreateInput {
  rootPath: string;
  name: string;
  mode?: LibraryMode;
}

export interface AppInfo {
  appVersion: string;
  electronVersion: string;
  /** 'win32' | 'darwin' | 'linux'；不引 NodeJS 命名空间，渲染进程也要能引用 */
  platform: string;
  /** 用户数据目录，库列表与窗口状态存这里 */
  userDataPath: string;
  /** 主进程检测到的可用解码器（sharp 支持的格式子集） */
  imageFormats: string[];
  /** 视频首帧由渲染进程的播放器直接渲染，不依赖外部解码器 */
  videoThumbSupported: boolean;
}

/**
 * 更新检查结果。默认查 GitHub Releases 的 latest；
 * error 非空表示「这次没查成」（超时 / 限流 / 连不上），此时 latest 等字段保持 null，
 * 不能当作「已是最新」来展示。
 */
export interface UpdateCheck {
  current: string;
  /** 结果来源：github / 本地 json / 没有可用更新源 */
  source: 'github' | 'file' | 'none';
  configured: boolean;
  latest: string | null;
  /** 安装包直链 */
  url: string | null;
  /** 发布页 */
  pageUrl: string | null;
  notes: string | null;
  publishedAt: string | null;
  available: boolean;
  error: string | null;
}

export interface InboxStats {
  inbox: number;
  kept: number;
  rejected: number;
  todayAdded: number;
}

export interface SimilarPhoto {
  photoId: number;
  distance: number; // phash 汉明距离，0 = 完全一致
  thumbUrl: string;
  fileName: string;
  takenAt: number | null;
}

/**
 * 地点视图里的一个「地方」。
 *
 * 不接地图瓦片服务，也不做逆地理编码：把 GPS 按固定网格（默认 0.05°，约 5.5km）
 * 聚合，同一个格子算一个地方，按张数排序。格子边界一并返回，点击时用它取照片。
 */
export interface LocationCluster {
  /** 网格键，形如 "1206:3215"，前端当 React key 用 */
  key: string;
  /** 格子中心经纬度，画点用 */
  lat: number;
  lon: number;
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
  count: number;
  from: number | null;
  to: number | null;
  coverPhotoId: number;
  coverThumbUrl: string;
}

// ---------------------------------------------------------------------------
// 批量改名
// ---------------------------------------------------------------------------

export interface RenamePreviewRow {
  photoId: number;
  from: string;
  to: string;
  /** 目标名与库内其它文件冲突（会被自动加后缀） */
  conflict: boolean;
}

export interface RenamePreview {
  rows: RenamePreviewRow[];
  total: number;
}

export interface RenameResult {
  renamed: number;
  /** 目标名字和原名相同，没动文件 */
  unchanged: number;
  failed: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// 导出 / 压缩
// ---------------------------------------------------------------------------

export type ExportFormat = 'original' | 'jpeg' | 'webp' | 'png';

export interface ExportOptions {
  photoIds: number[];
  destDir: string;
  format: ExportFormat;
  /** 长边像素上限，null = 保持原尺寸 */
  maxSize?: number | null;
  /** 1-100，仅 jpeg/webp 有效 */
  quality?: number;
  /** true = 去掉 EXIF（默认保留） */
  stripMetadata?: boolean;
}

export interface ExportProgress {
  done: number;
  total: number;
  currentFile: string;
  phase: 'running' | 'done' | 'error';
  message?: string;
}

export interface ExportResult {
  exported: number;
  failed: number;
  totalBytes: number;
  destDir: string;
  errors: string[];
}

export interface HtmlAlbumOptions {
  photoIds: number[];
  destDir: string;
  title: string;
}

export interface HtmlAlbumResult {
  folder: string;
  indexPath: string;
  count: number;
  bytes: number;
}

// ---------------------------------------------------------------------------
// 存储分析
// ---------------------------------------------------------------------------

export interface SizeBucket {
  label: string;
  count: number;
  bytes: number;
}

export interface LibraryAnalysis {
  totalPhotos: number;
  totalBytes: number;
  byStatus: { status: PhotoStatus; count: number; bytes: number }[];
  byYear: SizeBucket[];
  byExt: SizeBucket[];
  largest: {
    photoId: number;
    fileName: string;
    size: number;
    width: number | null;
    height: number | null;
    thumbUrl: string;
  }[];
  missing: number;
  gpsCount: number;
  favoriteCount: number;
  cameraCount: number;
  takenFrom: number | null;
  takenTo: number | null;
  thumbCount: number;
  thumbBytes: number;
}

// ---------------------------------------------------------------------------
// 局域网上传
// ---------------------------------------------------------------------------

export interface UploadServerStatus {
  running: boolean;
  port: number | null;
  /** 每个网卡一条，形如 http://192.168.1.8:8787 */
  urls: string[];
  startedAt: number | null;
  lastError: string | null;
  /** 本次启动后累计新入库的张数（重复的不算） */
  received: number;
  /** 本次启动后因重复被跳过的张数 */
  skipped: number;
}

export interface UploaderStat {
  label: string | null;
  count: number;
  kept: number;
  bytes: number;
  lastAt: number;
}

export interface TaskUploadInfo {
  task: CollectTask;
  token: string;
  /** 带 token 的完整上传地址（首选网卡） */
  urls: string[];
  qrDataUrl: string | null;
  uploaders: UploaderStat[];
}

export interface UploadReceivedEvent {
  taskId: number;
  photoId: number | null;
  fileName: string;
  deduped: boolean;
  uploader: string | null;
  at: number;
}

// ---------------------------------------------------------------------------
// Channel 常量
// ---------------------------------------------------------------------------

export const CH = {
  app: {
    info: 'app:info',
    revealInFolder: 'app:revealInFolder',
    openExternal: 'app:openExternal',
    exportHtmlAlbum: 'app:exportHtmlAlbum',
    clearThumbCache: 'app:clearThumbCache',
    /** 主题切换时同步窗口标题栏覆盖层配色（浅色主题下窗口按钮要变深） */
    setTitlebar: 'app:setTitlebar',
    /** 查 GitHub Releases（或 PHOTOVAULT_UPDATE_FEED 指定的本地源）判断有没有新版本 */
    checkUpdate: 'app:checkUpdate',
  },
  library: {
    create: 'library:create',
    open: 'library:open',
    close: 'library:close',
    current: 'library:current',
    recent: 'library:recent',
    forgetRecent: 'library:forgetRecent',
    pickFolder: 'library:pickFolder',
    analysis: 'library:analysis',
  },
  import: {
    scan: 'import:scan',
    start: 'import:start',
    cancel: 'import:cancel',
    batches: 'import:batches',
    rollback: 'import:rollback',
    progress: 'import:progress', // 主 → 渲染 事件
  },
  photo: {
    list: 'photo:list',
    get: 'photo:get',
    patch: 'photo:patch',
    setStatus: 'photo:setStatus',
    remove: 'photo:remove',
    restore: 'photo:restore',
    checkMissing: 'photo:checkMissing',
    similar: 'photo:similar',
    duplicateGroups: 'photo:duplicateGroups',
    tags: 'photo:tags',
    renamePreview: 'photo:renamePreview',
    rename: 'photo:rename',
    export: 'photo:export',
    exportProgress: 'photo:exportProgress', // 主 → 渲染 事件
    savePoster: 'photo:savePoster',
    locations: 'photo:locations',
  },
  inbox: {
    stats: 'inbox:stats',
    review: 'inbox:review',
  },
  album: {
    list: 'album:list',
    create: 'album:create',
    patch: 'album:patch',
    remove: 'album:remove',
    addPhotos: 'album:addPhotos',
    removePhotos: 'album:removePhotos',
  },
  task: {
    list: 'task:list',
    create: 'task:create',
    patch: 'task:patch',
    close: 'task:close',
    remove: 'task:remove',
    uploaders: 'task:uploaders',
    uploadInfo: 'task:uploadInfo',
    resetToken: 'task:resetToken',
  },
  tag: {
    list: 'tag:list',
    create: 'tag:create',
    patch: 'tag:patch',
    remove: 'tag:remove',
    attach: 'tag:attach',
    detach: 'tag:detach',
  },
  settings: {
    getAll: 'settings:getAll',
    set: 'settings:set',
  },
  upload: {
    status: 'upload:status',
    start: 'upload:start',
    stop: 'upload:stop',
    received: 'upload:received', // 主 → 渲染 事件
  },
} as const;

// ---------------------------------------------------------------------------
// preload 暴露给渲染进程的 API 形状
// ---------------------------------------------------------------------------

export interface VaultApi {
  app: {
    info(): Promise<IpcResult<AppInfo>>;
    revealInFolder(photoId: number): Promise<IpcResult<void>>;
    openExternal(url: string): Promise<IpcResult<void>>;
    exportHtmlAlbum(options: HtmlAlbumOptions): Promise<IpcResult<HtmlAlbumResult>>;
    clearThumbCache(): Promise<IpcResult<{ files: number; bytes: number }>>;
    /** 同步 Windows 标题栏覆盖层配色，浅色主题下窗口按钮要变深 */
    setTitlebar(theme: { color: string; symbolColor: string }): Promise<IpcResult<{ ok: boolean }>>;
    checkUpdate(): Promise<IpcResult<UpdateCheck>>;
    /**
     * 从拖进来的 File 取真实磁盘路径。
     * Electron 32 起 File.path 被移除，只能走 webUtils；参数在 shared 里用 unknown，
     * 因为主进程侧 tsconfig 不带 DOM lib。
     */
    pathForFile(file: unknown): string;
  };
  library: {
    pickFolder(): Promise<IpcResult<string | null>>;
    create(input: LibraryCreateInput): Promise<IpcResult<LibraryInfo>>;
    open(dbPath: string): Promise<IpcResult<LibraryInfo>>;
    close(): Promise<IpcResult<void>>;
    current(): Promise<IpcResult<LibraryInfo | null>>;
    recent(): Promise<IpcResult<RecentLibrary[]>>;
    forgetRecent(dbPath: string): Promise<IpcResult<void>>;
    analysis(): Promise<IpcResult<LibraryAnalysis>>;
  };
  import: {
    scan(input: { sourcePath: string; recursive: boolean }): Promise<IpcResult<ImportScanResult>>;
    start(input: ImportStartInput): Promise<IpcResult<{ batchId: number }>>;
    cancel(): Promise<IpcResult<void>>;
    batches(limit?: number): Promise<IpcResult<ImportBatch[]>>;
    rollback(batchId: number): Promise<IpcResult<{ removed: number }>>;
    onProgress(cb: (p: ImportProgress) => void): () => void;
  };
  photo: {
    list(query: PhotoQuery): Promise<IpcResult<Page<Photo>>>;
    get(id: number): Promise<IpcResult<Photo>>;
    patch(id: number, patch: PhotoPatch): Promise<IpcResult<Photo>>;
    setStatus(ids: number[], status: PhotoStatus): Promise<IpcResult<{ updated: number }>>;
    remove(ids: number[], opts?: { deleteFile?: boolean }): Promise<IpcResult<{ removed: number }>>;
    restore(ids: number[]): Promise<IpcResult<{ restored: number }>>;
    checkMissing(ids?: number[]): Promise<IpcResult<{ checked: number; missing: number }>>;
    similar(id: number, maxDistance?: number): Promise<IpcResult<SimilarPhoto[]>>;
    duplicateGroups(maxDistance?: number): Promise<IpcResult<DuplicateGroup[]>>;
    tags(photoId: number): Promise<IpcResult<Tag[]>>;
    renamePreview(ids: number[], template: string): Promise<IpcResult<RenamePreview>>;
    rename(ids: number[], template: string): Promise<IpcResult<RenameResult>>;
    export(options: ExportOptions): Promise<IpcResult<ExportResult>>;
    onExportProgress(cb: (p: ExportProgress) => void): () => void;
    /** 视频首帧回写：渲染层截一帧，主进程落盘成缩略图并补上尺寸/时长 */
    savePoster(input: VideoPosterInput): Promise<IpcResult<{ ok: boolean }>>;
    /** 按 GPS 网格聚合出的地点列表，按照片数从多到少 */
    locations(precision?: number): Promise<IpcResult<LocationCluster[]>>;
  };
  inbox: {
    stats(): Promise<IpcResult<InboxStats>>;
    review(ids: number[], action: 'keep' | 'reject'): Promise<IpcResult<{ updated: number }>>;
  };
  album: {
    list(): Promise<IpcResult<Album[]>>;
    create(input: AlbumCreateInput): Promise<IpcResult<Album>>;
    patch(id: number, patch: AlbumPatch): Promise<IpcResult<Album>>;
    remove(id: number): Promise<IpcResult<void>>;
    addPhotos(albumId: number, photoIds: number[]): Promise<IpcResult<{ added: number }>>;
    removePhotos(albumId: number, photoIds: number[]): Promise<IpcResult<{ removed: number }>>;
  };
  task: {
    list(includeClosed?: boolean): Promise<IpcResult<CollectTask[]>>;
    create(input: TaskCreateInput): Promise<IpcResult<CollectTask>>;
    patch(id: number, patch: TaskPatch): Promise<IpcResult<CollectTask>>;
    close(id: number): Promise<IpcResult<CollectTask>>;
    remove(id: number): Promise<IpcResult<void>>;
    uploaders(taskId: number): Promise<IpcResult<UploaderStat[]>>;
    uploadInfo(taskId: number): Promise<IpcResult<TaskUploadInfo>>;
    resetToken(taskId: number): Promise<IpcResult<TaskUploadInfo>>;
  };
  tag: {
    list(): Promise<IpcResult<Tag[]>>;
    create(input: { name: string; parentId?: number | null; color?: string }): Promise<IpcResult<Tag>>;
    patch(id: number, patch: { name?: string; color?: string | null }): Promise<IpcResult<Tag>>;
    remove(id: number): Promise<IpcResult<void>>;
    attach(photoIds: number[], tagId: number): Promise<IpcResult<{ attached: number }>>;
    detach(photoIds: number[], tagId: number): Promise<IpcResult<{ detached: number }>>;
  };
  settings: {
    getAll(): Promise<IpcResult<Record<string, string>>>;
    set(patch: Record<string, string>): Promise<IpcResult<void>>;
  };
  upload: {
    status(): Promise<IpcResult<UploadServerStatus>>;
    start(port?: number): Promise<IpcResult<UploadServerStatus>>;
    stop(): Promise<IpcResult<UploadServerStatus>>;
    onReceived(cb: (e: UploadReceivedEvent) => void): () => void;
  };
}

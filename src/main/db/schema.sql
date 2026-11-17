-- ============================================================================
-- photo-vault · schema v1
--
-- 设计要点
-- 1. 一个媒体库 = 一个 .db 文件 + 一个缩略图目录，支持多库切换。
-- 2. 所有时间戳为 INTEGER（Unixtime 毫秒），便于跨进程与展示层统一。
-- 3. 照片用 status 一个字段区分生命周期，不建多张表：
--      inbox（收件箱，未审）→ kept（正式库）/ rejected（淘汰）→ archived（归档隐藏）
-- 4. 去重分两级：hash_full（sha1，全文件，判"是不是同一张"）
--                hash_phash（64bit 感知哈希 hex，判"看起来是不是同一张"）
--    hash_full 建唯一索引用不着——同一张图允许出现在不同路径，用普通索引查重。
-- 5. 原图默认不移动（mode='reference'）；mode='managed' 时复制进库并记录 rel_path。
-- ============================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;
PRAGMA temp_store = MEMORY;

-- ---------------------------------------------------------------------------
-- 库
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS libraries (
  id          INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL,
  root_path   TEXT    NOT NULL,              -- 库根目录
  db_path     TEXT    NOT NULL,              -- 本 .db 文件路径（便于"最近打开"）
  thumbs_path TEXT    NOT NULL,              -- 缩略图缓存目录
  mode        TEXT    NOT NULL DEFAULT 'reference'
                      CHECK (mode IN ('reference', 'managed')),
  created_at  INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- 照片 / 视频（视频只取首帧做缩略图，其余按图片同构处理）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS photos (
  id           INTEGER PRIMARY KEY,
  library_id   INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  path         TEXT    NOT NULL,             -- 绝对路径（reference 模式指向原位置）
  rel_path     TEXT,                         -- 相对 root_path，managed 模式用
  file_name    TEXT    NOT NULL,
  ext          TEXT    NOT NULL,             -- 小写、不含点
  size         INTEGER NOT NULL,             -- 字节
  mtime        INTEGER NOT NULL,             -- 文件修改时间（毫秒）
  hash_full    TEXT    NOT NULL,             -- sha1
  hash_phash   TEXT,                         -- 16 位 hex（8x8 DCT）
  width        INTEGER,
  height       INTEGER,
  orientation  INTEGER NOT NULL DEFAULT 1,   -- EXIF Orientation 1-8
  taken_at     INTEGER,                      -- EXIF DateTimeOriginal，缺失回退 mtime
  camera_make  TEXT,
  camera_model TEXT,
  lens_model   TEXT,
  gps_lat      REAL,
  gps_lon      REAL,
  duration_ms  INTEGER,                      -- 视频时长
  status       TEXT    NOT NULL DEFAULT 'inbox'
                       CHECK (status IN ('inbox', 'kept', 'rejected', 'archived')),
  rating       INTEGER NOT NULL DEFAULT 0 CHECK (rating BETWEEN 0 AND 5),
  favorite     INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
  note         TEXT,
  missing      INTEGER NOT NULL DEFAULT 0 CHECK (missing IN (0, 1)),  -- 原文件已不在
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (library_id, path)
);

-- 时间轴主查询：按 status 过滤 + taken_at 倒序 + id 兜底（keyset 分页）
CREATE INDEX IF NOT EXISTS idx_photos_timeline
  ON photos (library_id, status, taken_at DESC, id DESC);
-- 查重：先按 size 粗筛，命中后再比 hash_full
CREATE INDEX IF NOT EXISTS idx_photos_size ON photos (library_id, size);
CREATE INDEX IF NOT EXISTS idx_photos_hash ON photos (library_id, hash_full);
CREATE INDEX IF NOT EXISTS idx_photos_phash ON photos (library_id, hash_phash);
CREATE INDEX IF NOT EXISTS idx_photos_favorite ON photos (library_id, favorite) WHERE favorite = 1;
CREATE INDEX IF NOT EXISTS idx_photos_missing ON photos (library_id, missing) WHERE missing = 1;

-- ---------------------------------------------------------------------------
-- 相册
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS albums (
  id             INTEGER PRIMARY KEY,
  library_id     INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  name           TEXT    NOT NULL,
  description    TEXT,
  kind           TEXT    NOT NULL DEFAULT 'manual' CHECK (kind IN ('manual', 'smart')),
  rule_json      TEXT,                       -- smart 相册的筛选条件（P1）
  cover_photo_id INTEGER REFERENCES photos(id) ON DELETE SET NULL,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_albums_name ON albums (library_id, name);

CREATE TABLE IF NOT EXISTS album_photos (
  album_id INTEGER NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (album_id, photo_id)
);

CREATE INDEX IF NOT EXISTS idx_album_photos_photo ON album_photos (photo_id);

-- ---------------------------------------------------------------------------
-- 标签（多级：parent_id 为 NULL 即根标签）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tags (
  id         INTEGER PRIMARY KEY,
  library_id INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  parent_id  INTEGER REFERENCES tags(id) ON DELETE CASCADE,
  color      TEXT,
  created_at INTEGER NOT NULL
);

-- 同一父节点下不重名；SQLite 视 NULL 互不相等，根标签要单独建部分索引
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_child_name
  ON tags (library_id, parent_id, name) WHERE parent_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_root_name
  ON tags (library_id, name) WHERE parent_id IS NULL;

CREATE TABLE IF NOT EXISTS photo_tags (
  photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  tag_id   INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (photo_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_photo_tags_tag ON photo_tags (tag_id);

-- ---------------------------------------------------------------------------
-- 收集任务
--   本地阶段（P0-P1）：把一次导入/一次活动当成一个任务分组，进库的照片打上来源标签。
--   P2 接入上传后：同一个表继续用，task_photos.source_label 记上传者。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS collect_tasks (
  id               INTEGER PRIMARY KEY,
  library_id       INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  name             TEXT    NOT NULL,
  note             TEXT,                     -- 给上传者/自己看的说明
  deadline_at      INTEGER,
  target_count     INTEGER,
  default_album_id INTEGER REFERENCES albums(id) ON DELETE SET NULL,
  cover_photo_id   INTEGER REFERENCES photos(id) ON DELETE SET NULL,
  state            TEXT    NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
  upload_token     TEXT,                     -- 局域网上传地址里的口令（v2）
  created_at       INTEGER NOT NULL,
  closed_at        INTEGER
);

-- 注意：upload_token 的唯一索引在 migrate.ts 里建。
-- 老库执行到 schema.sql 这一行时还没有这个字段，放在这里会直接建表失败。

CREATE TABLE IF NOT EXISTS task_photos (
  task_id       INTEGER NOT NULL REFERENCES collect_tasks(id) ON DELETE CASCADE,
  photo_id      INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  source_label  TEXT,                        -- "微信-张三" / "本地文件夹" / "扫码上传"
  source_device TEXT,                        -- UA 或设备名（P2）
  added_at      INTEGER NOT NULL,
  PRIMARY KEY (task_id, photo_id)
);

CREATE INDEX IF NOT EXISTS idx_task_photos_photo ON task_photos (photo_id);

-- ---------------------------------------------------------------------------
-- 导入批次（可回滚：按批次删掉本次新增的照片记录）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS import_batches (
  id          INTEGER PRIMARY KEY,
  library_id  INTEGER NOT NULL REFERENCES libraries(id) ON DELETE CASCADE,
  source_path TEXT    NOT NULL,
  task_id     INTEGER REFERENCES collect_tasks(id) ON DELETE SET NULL,
  total       INTEGER NOT NULL DEFAULT 0,
  added       INTEGER NOT NULL DEFAULT 0,
  skipped_dup INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  state       TEXT    NOT NULL DEFAULT 'running'
                      CHECK (state IN ('running', 'done', 'cancelled', 'failed')),
  error       TEXT,
  started_at  INTEGER NOT NULL,
  finished_at INTEGER
);

-- 批次与照片的关联，用于整批回滚
CREATE TABLE IF NOT EXISTS import_batch_photos (
  batch_id INTEGER NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  PRIMARY KEY (batch_id, photo_id)
);

CREATE INDEX IF NOT EXISTS idx_batch_photos_photo ON import_batch_photos (photo_id);

-- ---------------------------------------------------------------------------
-- 键值设置
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- schema 版本（单行）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_meta (
  id      INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL
);

INSERT OR IGNORE INTO schema_meta (id, version) VALUES (1, 1);

import type { Album, CollectTask, ImportBatch, LibraryInfo, Photo, PhotoStatus, Tag } from '@shared/ipc';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

export function rowToPhoto(r: Row): Photo {
  return {
    id: r.id,
    libraryId: r.library_id,
    path: r.path,
    fileName: r.file_name,
    ext: r.ext,
    size: r.size,
    width: r.width ?? null,
    height: r.height ?? null,
    orientation: r.orientation ?? 1,
    takenAt: r.taken_at ?? null,
    cameraMake: r.camera_make ?? null,
    cameraModel: r.camera_model ?? null,
    gpsLat: r.gps_lat ?? null,
    gpsLon: r.gps_lon ?? null,
    durationMs: r.duration_ms ?? null,
    status: r.status as PhotoStatus,
    rating: r.rating ?? 0,
    favorite: r.favorite === 1,
    note: r.note ?? null,
    missing: r.missing === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    thumbUrl: `vault://thumb/${r.id}`,
    previewUrl: `vault://preview/${r.id}`,
    originalUrl: `vault://original/${r.id}`,
  };
}

export function rowToLibrary(r: Row): LibraryInfo {
  return {
    id: r.id,
    name: r.name,
    rootPath: r.root_path,
    dbPath: r.db_path,
    thumbsPath: r.thumbs_path,
    mode: r.mode,
    createdAt: r.created_at,
    photoCount: r.photo_count ?? 0,
    inboxCount: r.inbox_count ?? 0,
    keptCount: r.kept_count ?? 0,
    totalBytes: r.total_bytes ?? 0,
  };
}

export function rowToAlbum(r: Row): Album {
  return {
    id: r.id,
    libraryId: r.library_id,
    name: r.name,
    description: r.description ?? null,
    kind: r.kind,
    ruleJson: r.rule_json ?? null,
    coverPhotoId: r.cover_photo_id ?? null,
    sortOrder: r.sort_order ?? 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    photoCount: r.photo_count ?? 0,
    coverThumbUrl: r.cover_photo_id ? `vault://thumb/${r.cover_photo_id}` : null,
  };
}

export function rowToTag(r: Row): Tag {
  return {
    id: r.id,
    libraryId: r.library_id,
    name: r.name,
    parentId: r.parent_id ?? null,
    color: r.color ?? null,
    createdAt: r.created_at,
    photoCount: r.photo_count ?? 0,
  };
}

export function rowToTask(r: Row): CollectTask {
  return {
    id: r.id,
    libraryId: r.library_id,
    name: r.name,
    note: r.note ?? null,
    deadlineAt: r.deadline_at ?? null,
    targetCount: r.target_count ?? null,
    defaultAlbumId: r.default_album_id ?? null,
    coverPhotoId: r.cover_photo_id ?? null,
    state: r.state,
    createdAt: r.created_at,
    closedAt: r.closed_at ?? null,
    photoCount: r.photo_count ?? 0,
    keptCount: r.kept_count ?? 0,
    inboxCount: r.inbox_count ?? 0,
    uploadEndpoint: null,
  };
}

export function rowToBatch(r: Row): ImportBatch {
  return {
    id: r.id,
    libraryId: r.library_id,
    sourcePath: r.source_path,
    taskId: r.task_id ?? null,
    total: r.total,
    added: r.added,
    skippedDup: r.skipped_dup,
    failed: r.failed,
    state: r.state,
    error: r.error ?? null,
    startedAt: r.started_at,
    finishedAt: r.finished_at ?? null,
  };
}

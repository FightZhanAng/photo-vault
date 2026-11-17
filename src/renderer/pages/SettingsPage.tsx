import { useEffect, useState } from 'react';
import type { AppInfo, LibraryAnalysis, UpdateCheck } from '@shared/ipc';
import { api, errorText, unwrap } from '../api';
import { PREF, prefBool, useApp } from '../store';
import { THEMES } from '../theme';
import Modal from '../components/Modal';

function formatBytes(bytes: number): string {
  if (bytes > 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes > 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

export default function SettingsPage() {
  const library = useApp((s) => s.library);
  const upload = useApp((s) => s.upload);
  const refreshUpload = useApp((s) => s.refreshUpload);
  const showToast = useApp((s) => s.showToast);
  const refreshStats = useApp((s) => s.refreshStats);
  const bumpData = useApp((s) => s.bumpData);
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);
  const prefs = useApp((s) => s.prefs);
  const setPref = useApp((s) => s.setPref);

  const [info, setInfo] = useState<AppInfo | null>(null);
  const [analysis, setAnalysis] = useState<LibraryAnalysis | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [update, setUpdate] = useState<UpdateCheck | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmSwitch, setConfirmSwitch] = useState(false);
  const [showNotes, setShowNotes] = useState(false);

  const autoKeep = prefBool(prefs, PREF.autoKeep, false);
  const minKb = prefs[PREF.minKb] ?? '1';
  const defaultSort = prefs[PREF.defaultSort] ?? 'taken_desc';
  const exportFormat = prefs[PREF.exportFormat] ?? 'original';
  /** 数字输入框先存本地，失焦时再落库，避免边打字边写 DB */
  const [minKbDraft, setMinKbDraft] = useState(minKb);
  useEffect(() => setMinKbDraft(minKb), [minKb]);

  const commitPref = (patch: Record<string, string>): void => {
    setPref(patch).catch((e) => showToast(errorText(e)));
  };

  useEffect(() => {
    void (async () => {
      try {
        setInfo(await unwrap(api.app.info()));
      } catch {
        /* 忽略 */
      }
      try {
        setAnalysis(await unwrap(api.library.analysis()));
      } catch {
        /* 忽略 */
      }
    })();
  }, []);

  const checkMissing = async (): Promise<void> => {
    setChecking(true);
    try {
      const result = await unwrap(api.photo.checkMissing());
      showToast(`检查 ${result.checked} 张，缺失 ${result.missing} 张`);
      bumpData();
      await refreshStats();
    } catch (e) {
      showToast(errorText(e));
    } finally {
      setChecking(false);
    }
  };

  const clearCache = async (): Promise<void> => {
    try {
      const r = await unwrap(api.app.clearThumbCache());
      setConfirmClear(false);
      showToast(`已清掉 ${r.files} 个缓存文件（${formatBytes(r.bytes)}）`);
      setAnalysis(await unwrap(api.library.analysis()));
    } catch (e) {
      showToast(errorText(e));
    }
  };

  const toggleServer = async (): Promise<void> => {
    try {
      if (upload?.running) {
        await unwrap(api.upload.stop());
        showToast('上传服务已停止');
      } else {
        const s = await unwrap(api.upload.start());
        showToast(`上传服务已启动：${s.urls[0] ?? s.port}`);
      }
      await refreshUpload();
    } catch (e) {
      showToast(errorText(e));
    }
  };

  const switchLibrary = async (): Promise<void> => {
    try {
      await unwrap(api.library.close());
      window.location.reload();
    } catch (e) {
      showToast(errorText(e));
    }
  };

  const checkVersion = async (): Promise<void> => {
    setCheckingUpdate(true);
    try {
      setUpdate(await unwrap(api.app.checkUpdate()));
    } catch (e) {
      showToast(errorText(e));
    } finally {
      setCheckingUpdate(false);
    }
  };

  const updateHint = ((): string => {
    if (!update) return '查 GitHub Releases 上的最新正式版本';
    // 没查成和「是最新的」是两回事，不能混着说
    if (update.error) return `没查成：${update.error}`;
    if (!update.configured) return '没有可用的更新源';
    if (!update.latest) return '上游还没有发布过正式版本';
    if (update.available) {
      const when = update.publishedAt ? ` · 发布于 ${update.publishedAt.slice(0, 10)}` : '';
      return `有新版本 ${update.latest}（当前 ${update.current}）${when}`;
    }
    return `已是最新 ${update.current}`;
  })();

  if (!library) return null;

  return (
    <>
      <div className="topbar">
        <div className="title-block">
          <span className="kicker">偏好</span>
          <h1>设置</h1>
        </div>
      </div>
      <div className="content">
        <div className="settings-pad stack">
          <div className="card">
            <h3>外观</h3>
            <p className="hint">同一张照片在不同照明下观感不同，选你现在想工作的一种。选择会记住。</p>
            <div className="theme-cards">
              {THEMES.map((t) => (
                <button
                  key={t.id}
                  className={`theme-card${t.id === theme ? ' on' : ''}`}
                  onClick={() => setTheme(t.id)}
                  aria-pressed={t.id === theme}
                >
                  <span className="theme-card-preview" style={{ background: t.swatch[0] }} aria-hidden>
                    <i style={{ background: t.swatch[1] }} />
                    <i style={{ background: t.swatch[2] }} />
                  </span>
                  <span className="theme-card-name">
                    {t.name}
                    <em>{t.latin}</em>
                  </span>
                  <span className="theme-card-note">{t.note}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="card">
            <h3>偏好</h3>
            <p className="hint">这些设置存在库自己的数据库里，换个机器打开同一个库也照样生效。</p>

            <div className="pref-list">
              <div className="pref-row">
                <div>
                  <b>导入后直接进正式库</b>
                  <span>关掉时先进收件箱逐张审核，适合一次导一大批的场景</span>
                </div>
                <button
                  className={`switch${autoKeep ? ' on' : ''}`}
                  aria-pressed={autoKeep}
                  onClick={() => commitPref({ [PREF.autoKeep]: autoKeep ? '0' : '1' })}
                >
                  <i />
                </button>
              </div>

              <div className="pref-row">
                <div>
                  <b>跳过小于这个大小的文件</b>
                  <span>过滤图标、占位图、已损坏的碎片</span>
                </div>
                <div className="pref-inline">
                  <input
                    className="input narrow"
                    type="number"
                    min={0}
                    max={10240}
                    value={minKbDraft}
                    onChange={(e) => setMinKbDraft(e.target.value)}
                    onBlur={() => {
                      const n = Math.max(0, Math.round(Number(minKbDraft) || 0));
                      setMinKbDraft(String(n));
                      if (String(n) !== minKb) commitPref({ [PREF.minKb]: String(n) });
                    }}
                  />
                  <span className="hint">KB</span>
                </div>
              </div>

              <div className="pref-row">
                <div>
                  <b>默认排序</b>
                  <span>打开时间轴时先用这个顺序，之后可以随时改</span>
                </div>
                <select
                  className="select"
                  value={defaultSort}
                  onChange={(e) => commitPref({ [PREF.defaultSort]: e.target.value })}
                >
                  <option value="taken_desc">拍摄时间 · 新→旧</option>
                  <option value="taken_asc">拍摄时间 · 旧→新</option>
                  <option value="added_desc">入库时间 · 新→旧</option>
                  <option value="name_asc">文件名 A→Z</option>
                  <option value="size_desc">体积 · 大→小</option>
                </select>
              </div>

              <div className="pref-row">
                <div>
                  <b>默认导出格式</b>
                  <span>导出对话框里预选这一项</span>
                </div>
                <select
                  className="select"
                  value={exportFormat}
                  onChange={(e) => commitPref({ [PREF.exportFormat]: e.target.value })}
                >
                  <option value="original">保持原格式</option>
                  <option value="jpeg">JPEG</option>
                  <option value="webp">WebP</option>
                  <option value="png">PNG</option>
                </select>
              </div>
            </div>
          </div>

          <div className="card">
            <h3>媒体库</h3>
            <div className="kv">
              <span>名称</span>
              <b>{library.name}</b>
            </div>
            <div className="kv">
              <span>根目录</span>
              <b className="mono selectable">{library.rootPath}</b>
            </div>
            <div className="kv">
              <span>数据库</span>
              <b className="mono selectable">{library.dbPath}</b>
            </div>
            <div className="kv">
              <span>缩略图缓存</span>
              <b className="mono selectable">{library.thumbsPath}</b>
            </div>
            <div className="kv">
              <span>存储模式</span>
              <b>{library.mode === 'managed' ? '收纳（复制进库）' : '引用（不复制原图）'}</b>
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn" onClick={() => setConfirmSwitch(true)}>
                切换 / 打开其它库
              </button>
              <span className="hint">切换不会删除任何数据，随时可以再打开</span>
            </div>
          </div>

          <div className="card">
            <h3>局域网上传</h3>
            <div className="kv">
              <span>服务状态</span>
              <b className={upload?.running ? '' : 'danger-text'}>
                {upload?.running ? `运行中 · 端口 ${upload.port}` : '未启动'}
              </b>
            </div>
            {upload?.running &&
              upload.urls.map((url) => (
                <div className="kv" key={url}>
                  <span>访问地址</span>
                  <b className="mono selectable">{url}</b>
                </div>
              ))}
            <div className="kv">
              <span>本次已接收</span>
              <b>
                {upload?.received ?? 0} 张
                {upload?.skipped ? `（另有 ${upload.skipped} 张重复已跳过）` : ''}
              </b>
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn" onClick={() => void toggleServer()}>
                {upload?.running ? '停止服务' : '启动服务'}
              </button>
              <span className="hint">每个任务的具体上传链接在「收集任务」里</span>
            </div>
          </div>

          <div className="card">
            <h3>内容统计</h3>
            <div className="kv">
              <span>照片总数</span>
              <b>{library.photoCount}</b>
            </div>
            <div className="kv">
              <span>正式库 / 收件箱</span>
              <b>
                {library.keptCount} / {library.inboxCount}
              </b>
            </div>
            <div className="kv">
              <span>占用</span>
              <b>{formatBytes(library.totalBytes)}</b>
            </div>
            <div className="kv">
              <span>缩略图缓存</span>
              <b>
                {formatBytes(analysis?.thumbBytes ?? 0)} · {analysis?.thumbCount ?? 0} 个文件
              </b>
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn" disabled={checking} onClick={() => void checkMissing()}>
                {checking ? '检查中…' : '检查原文件是否还在'}
              </button>
              <button className="btn" onClick={() => setConfirmClear(true)}>
                清理缩略图缓存
              </button>
            </div>
          </div>

          <div className="card">
            <h3>运行环境</h3>
            <div className="kv">
              <span>应用版本</span>
              <b>{info?.appVersion ?? '—'}</b>
            </div>
            <div className="kv">
              <span>Electron</span>
              <b>{info?.electronVersion ?? '—'}</b>
            </div>
            <div className="kv">
              <span>平台</span>
              <b>{info?.platform ?? '—'}</b>
            </div>
            <div className="kv">
              <span>支持的图片格式</span>
              <b>{info?.imageFormats.join(' / ') ?? '—'}</b>
            </div>
            <div className="kv">
              <span>视频</span>
              <b>
                {info?.videoThumbSupported ? '可入库播放，首帧由播放器截取' : '暂不支持'}
              </b>
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <button className="btn" disabled={checkingUpdate} onClick={() => void checkVersion()}>
                {checkingUpdate ? '检查中…' : '检查更新'}
              </button>
              {update?.available && update.url && (
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    void api.app.openExternal(update.url as string);
                  }}
                >
                  下载新版本
                </button>
              )}
              {update?.available && update.notes && (
                <button className="btn btn-ghost" onClick={() => setShowNotes(true)}>
                  更新说明
                </button>
              )}
              {update?.pageUrl && !update.error && (
                <button
                  className="btn btn-ghost"
                  onClick={() => {
                    void api.app.openExternal(update.pageUrl as string);
                  }}
                >
                  {update.available ? '发布页' : '版本历史'}
                </button>
              )}
              <span className="hint">{updateHint}</span>
            </div>
          </div>
        </div>
      </div>

      {confirmClear && (
        <Modal
          title="清理缩略图缓存"
          onClose={() => setConfirmClear(false)}
          width={430}
          footer={
            <>
              <div className="spacer" />
              <button className="btn btn-ghost" onClick={() => setConfirmClear(false)}>
                取消
              </button>
              <button className="btn btn-primary" onClick={() => void clearCache()}>
                清理
              </button>
            </>
          }
        >
          <p className="hint">只删缓存，不动原图。清完后第一次浏览会重新生成缩略图。</p>
        </Modal>
      )}

      {confirmSwitch && (
        <Modal
          title="切换媒体库"
          onClose={() => setConfirmSwitch(false)}
          width={430}
          footer={
            <>
              <div className="spacer" />
              <button className="btn btn-ghost" onClick={() => setConfirmSwitch(false)}>
                取消
              </button>
              <button className="btn btn-primary" onClick={() => void switchLibrary()}>
                切换
              </button>
            </>
          }
        >
          <p className="hint">
            会关闭当前库并回到欢迎页，照片和数据库都保留在原目录。下次可以从「最近打开」直接回来。
          </p>
        </Modal>
      )}

      {showNotes && update?.notes && (
        <Modal
          title={`更新说明 · ${update.latest}`}
          subtitle={update.publishedAt ? `发布于 ${update.publishedAt.slice(0, 10)}` : undefined}
          onClose={() => setShowNotes(false)}
          width={560}
          footer={
            <>
              <div className="spacer" />
              <button className="btn btn-ghost" onClick={() => setShowNotes(false)}>
                关闭
              </button>
              {update.url && (
                <button
                  className="btn btn-primary"
                  onClick={() => {
                    void api.app.openExternal(update.url as string);
                  }}
                >
                  下载
                </button>
              )}
            </>
          }
        >
          {/* Release 正文是 Markdown，这里按原文展示，不假装渲染 */}
          <p style={{ whiteSpace: 'pre-wrap', lineHeight: 1.65, margin: 0 }}>{update.notes}</p>
        </Modal>
      )}
    </>
  );
}

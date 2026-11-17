import fs from 'node:fs';
import path from 'node:path';
import { openCdp, run, sleep } from './cdp.mjs';

// 从项目根目录运行：node test/e2e.mjs
const ROOT = process.cwd();
const DATA = path.join(ROOT, '_data');
const LIB = path.join(ROOT, '_lib');
const OUT = path.join(ROOT, '_out');
const SHOTS = path.join(ROOT, '_shots');
const PHONE = path.join(ROOT, '_phone', 'photo-from-phone.jpg');

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(LIB, { recursive: true });

const results = [];
function ok(name, detail) {
  results.push({ name, detail });
  console.log(`✓ ${name}${detail ? ' — ' + detail : ''}`);
}
function fail(name, detail) {
  results.push({ name, detail, failed: true });
  console.log(`✗ ${name}${detail ? ' — ' + detail : ''}`);
}
function assert(cond, name, detail) {
  if (cond) ok(name, detail);
  else {
    fail(name, detail);
    throw new Error(`断言失败：${name}`);
  }
}

async function waitFor(fn, timeout = 30000, label = '条件') {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`等待超时：${label}`);
    await sleep(200);
  }
}

const cdp = await openCdp('9411');

// ---------------------------------------------------------------- 基础
const boot = await run(cdp, `return { api: typeof window.vault, text: document.body.innerText.slice(0, 60) };`);
assert(boot.api === 'object', 'preload 注入正常', boot.text.replace(/\n/g, ' '));

await run(
  cdp,
  `const r = await window.vault.library.create({ rootPath: ${JSON.stringify(LIB)}, name: '测试相册' });
   if (!r.ok) throw new Error(r.error.message);
   return r.data.id;`
);
await cdp.reload(1500);
ok('创建媒体库', LIB);

// ---------------------------------------------------------------- 导入
const scan = await run(
  cdp,
  `const r = await window.vault.import.scan({ sourcePath: ${JSON.stringify(DATA)}, recursive: true });
   if (!r.ok) throw new Error(r.error.message);
   return { files: r.data.fileCount, images: r.data.imageCount, bytes: r.data.totalBytes };`
);
ok('扫描目录', `${scan.files} 个文件 / ${scan.images} 张图片`);

const batch = await run(
  cdp,
  `const r = await window.vault.import.start({ sourcePath: ${JSON.stringify(DATA)}, recursive: true });
   if (!r.ok) throw new Error(r.error.message);
   return r.data.batchId;`
);

const finished = await waitFor(
  async () =>
    run(
      cdp,
      `const r = await window.vault.import.batches(5);
       const b = r.data.find(x => x.id === ${batch});
       return b && b.state !== 'running' ? b : null;`
    ),
  90000,
  '导入完成'
);
assert(finished.state === 'done', '导入完成', `新增 ${finished.added}，跳过重复 ${finished.skippedDup}，失败 ${finished.failed}`);
assert(finished.added === 15, 'sha1 全文件去重生效', `16 个文件 → 入库 15 张`);

const page1 = await run(
  cdp,
  `const r = await window.vault.photo.list({ status: ['inbox'], limit: 100 });
   if (!r.ok) throw new Error(r.error.message);
   return { total: r.data.total, items: r.data.items.map(p => ({ id: p.id, name: p.fileName, w: p.width, h: p.height, size: p.size })) };`
);
assert(page1.total === 15, '收件箱收到 15 张');
const base1 = page1.items.find((p) => p.name === 'IMG_0001.jpg');
assert(
  base1 && base1.w >= 1000 && base1.h >= 600,
  '原图尺寸入库正确（不是缩略图尺寸）',
  `${base1?.name} ${base1?.w}×${base1?.h}`
);

// ---------------------------------------------------------------- 审核
const approved = await run(
  cdp,
  `const list = await window.vault.photo.list({ status: ['inbox'], limit: 200 });
   const ids = list.data.items.map(p => p.id);
   const r = await window.vault.inbox.review(ids, 'keep');
   if (!r.ok) throw new Error(r.error.message);
   const stats = await window.vault.inbox.stats();
   return { updated: r.data.updated, stats: stats.data };`
);
assert(approved.updated === 15, '批量审核入库', `更新 ${approved.updated} 张，inbox=${approved.stats.inbox}`);

// ---------------------------------------------------------------- 标签 / 收藏 / 智能相册
const tagged = await run(
  cdp,
  `const list = await window.vault.photo.list({ limit: 5 });
   const tag = await window.vault.tag.create({ name: '精选', color: '#e0a458' });
   if (!tag.ok) throw new Error(tag.error.message);
   const ids = list.data.items.map(p => p.id);
   const a = await window.vault.tag.attach(ids, tag.data.id);
   for (const id of ids.slice(0, 3)) await window.vault.photo.patch(id, { favorite: true });
   return { tagId: tag.data.id, attached: a.data.attached, favIds: ids.slice(0, 3) };`
);
assert(tagged.attached === 5, '标签打上 5 张', `tagId=${tagged.tagId}`);

const smart = await run(
  cdp,
  `const a = await window.vault.album.create({
     name: '收藏夹', kind: 'smart',
     rule: { status: ['kept'], favoriteOnly: true }
   });
   if (!a.ok) throw new Error(a.error.message);
   const list = await window.vault.album.list();
   const found = list.data.find(x => x.name === '收藏夹');
   const q = await window.vault.photo.list({ albumId: found.id, limit: 10 });
   return { id: found.id, count: found.photoCount, queried: q.data.total, kind: found.kind };`
);
assert(smart.count === 3 && smart.queried === 3, '智能相册按规则归集', `3 张收藏都命中了（kind=${smart.kind}）`);

const tagQuery = await run(
  cdp,
  `const r = await window.vault.photo.list({ tagIds: [${tagged.tagId}], limit: 10 });
   if (!r.ok) throw new Error(r.error.message);
   return r.data.total;`
);
assert(tagQuery === 5, '按标签筛选', `${tagQuery} 张`);

const combo = await run(
  cdp,
  `const r = await window.vault.photo.list({ status: ['kept'], favoriteOnly: true, from: Date.parse('2024-01-01'), limit: 10 });
   if (!r.ok) throw new Error(r.error.message);
   return r.data.total;`
);
ok('组合筛选（收藏 + 时间）', `${combo} 张`);

// ---------------------------------------------------------------- 任务 + 上传服务
const taskId = await run(
  cdp,
  `const t = await window.vault.task.create({ name: '周末团建', note: '随手拍的照片都发这里，原图优先', targetCount: 10 });
   if (!t.ok) throw new Error(t.error.message);
   return t.data.id;`
);
ok('创建收集任务', `id=${taskId}`);

const server = await run(
  cdp,
  `const s = await window.vault.upload.start(8787);
   if (!s.ok) throw new Error(s.error.message);
   return s.data;`
);
assert(server.running, '上传服务启动', `${server.urls.join(', ')}`);

const info = await run(
  cdp,
  `const r = await window.vault.task.uploadInfo(${taskId});
   if (!r.ok) throw new Error(r.error.message);
   return { urls: r.data.urls, token: r.data.token, qr: !!r.data.qrDataUrl };`
);
assert(info.urls.length > 0 && info.qr, '生成上传链接与二维码', info.urls[0]);

const base = info.urls[0].split('/u/')[0];
const pageRes = await fetch(`${base}/u/${info.token}`);
const pageHtml = await pageRes.text();
assert(
  pageRes.ok && pageHtml.includes('相册收集') && pageHtml.includes('选择照片'),
  '手机上传页可访问',
  `HTTP ${pageRes.status} / ${pageHtml.length} 字节`
);

const upload = await (async () => {
  const buf = fs.readFileSync(PHONE);
  const name = path.basename(PHONE);
  const initRes = await fetch(`${base}/api/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token: info.token,
      name,
      size: buf.length,
      lastModified: Date.now(),
      uploader: '测试手机',
    }),
  });
  const init = await initRes.json();
  if (!initRes.ok) throw new Error(JSON.stringify(init));
  let offset = init.offset ?? 0;
  while (offset < buf.length) {
    const end = Math.min(offset + 512 * 1024, buf.length);
    const res = await fetch(`${base}/api/chunk?uploadId=${init.uploadId}&offset=${offset}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: buf.subarray(offset, end),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(JSON.stringify(j));
    offset = j.received;
  }
  const doneRes = await fetch(`${base}/api/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uploadId: init.uploadId }),
  });
  const done = await doneRes.json();
  if (!doneRes.ok) throw new Error(JSON.stringify(done));
  return { ...done, uploadId: init.uploadId };
})();
assert(upload.photoId && !upload.deduped, '手机上传入库', `photoId=${upload.photoId}`);

const taskAfter = await run(
  cdp,
  `const list = await window.vault.task.list(true);
   const t = list.data.find(x => x.id === ${taskId});
   const u = await window.vault.task.uploaders(${taskId});
   const q = await window.vault.photo.list({ taskId: ${taskId}, limit: 10 });
   return { photoCount: t.photoCount, inbox: t.inboxCount, uploaders: u.data, photos: q.data.items.map(p => p.fileName) };`
);
assert(taskAfter.photoCount === 1, '任务收到 1 张', taskAfter.photos.join(', '));
assert(
  taskAfter.uploaders[0]?.label === '测试手机',
  '上传者标注正确',
  `label=${taskAfter.uploaders[0]?.label}`
);

// 同一文件再传一次，应命中 sha1 去重
const again = await (async () => {
  const buf = fs.readFileSync(PHONE);
  const initRes = await fetch(`${base}/api/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token: info.token,
      name: path.basename(PHONE),
      size: buf.length,
      lastModified: Date.now(),
      uploader: '测试手机',
    }),
  });
  const init = await initRes.json();
  let offset = init.offset ?? 0;
  while (offset < buf.length) {
    const end = Math.min(offset + 512 * 1024, buf.length);
    const res = await fetch(`${base}/api/chunk?uploadId=${init.uploadId}&offset=${offset}`, {
      method: 'PUT',
      body: buf.subarray(offset, end),
    });
    const j = await res.json();
    offset = j.received;
  }
  const doneRes = await fetch(`${base}/api/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uploadId: init.uploadId }),
  });
  return doneRes.json();
})();
assert(again.deduped === true, '重复上传被识别', `photoId=${again.photoId}`);

const stored = fs.existsSync(path.join(LIB, '收集', '周末团建'));
assert(stored, '上传文件落到 <库>/收集/<任务名>', path.join('收集', '周末团建'));

// ---------------------------------------------------------------- 查重
const dups = await run(
  cdp,
  `const r = await window.vault.photo.duplicateGroups(6);
   if (!r.ok) throw new Error(r.error.message);
   return r.data.map(g => ({ n: g.items.length, d: g.distance, names: g.items.map(i => i.fileName) }));`
);
assert(
  dups.length >= 3,
  '相似照片聚类',
  `${dups.length} 组，样本：${dups[0]?.names.join(' / ')}`
);

const groupIds = await run(
  cdp,
  `const r = await window.vault.photo.duplicateGroups(6);
   const g = r.data[0];
   const rest = g.items.slice(1).map(i => i.photoId);
   const s = await window.vault.photo.setStatus(rest, 'rejected');
   const after = await window.vault.photo.duplicateGroups(6);
   return { rejected: s.data.updated, groupsAfter: after.data.length };`
);
assert(groupIds.rejected >= 1, '组内淘汰多余副本', `淘汰 ${groupIds.rejected} 张，剩 ${groupIds.groupsAfter} 组`);

// 恢复，避免影响后面的截图
await run(
  cdp,
  `const r = await window.vault.photo.list({ status: ['rejected'], limit: 100 });
   await window.vault.photo.restore(r.data.items.map(p => p.id));
   return true;`
);

// ---------------------------------------------------------------- 批量改名
const renamed = await run(
  cdp,
  `const list = await window.vault.photo.list({ limit: 2 });
   const ids = list.data.items.map(p => p.id);
   const before = list.data.items.map(p => ({ id: p.id, name: p.fileName }));
   const pv = await window.vault.photo.renamePreview(ids, '{date}_{seq}');
   const r = await window.vault.photo.rename(ids, '{date}_{seq}');
   if (!r.ok) throw new Error(r.error.message);
   const after = await window.vault.photo.list({ limit: 30 });
   const byId = new Map(after.data.items.map(p => [p.id, p.fileName]));
   return { before, preview: pv.data.rows, result: r.data, after: ids.map(id => byId.get(id) ?? null) };`
);
const touched = renamed.result.renamed + renamed.result.unchanged;
assert(
  touched === 2 && renamed.result.failed === 0,
  '批量重命名',
  `${renamed.before.map((b) => b.name).join(', ')} → ${renamed.after.join(', ')}（改 ${renamed.result.renamed}，未变 ${renamed.result.unchanged}）`
);
assert(
  JSON.stringify(renamed.after) === JSON.stringify(renamed.preview.map((r) => r.to)),
  '重命名结果与预览一致',
  renamed.after.join(', ')
);

// ---------------------------------------------------------------- 导出图片
const exported = await run(
  cdp,
  `const list = await window.vault.photo.list({ limit: 4 });
   const r = await window.vault.photo.export({
     photoIds: list.data.items.map(p => p.id),
     destDir: ${JSON.stringify(path.join(OUT, 'files'))},
     format: 'jpeg', maxSize: 1280, quality: 85
   });
   if (!r.ok) throw new Error(r.error.message);
   return r.data;`
);
const exportedFiles = fs.readdirSync(path.join(OUT, 'files'));
assert(
  exported.exported === 4 && exportedFiles.length === 4,
  '批量导出 / 压缩',
  `${exportedFiles.length} 个文件 / ${(exported.totalBytes / 1024).toFixed(0)} KB`
);

// ---------------------------------------------------------------- 离线相册页
const album = await run(
  cdp,
  `const list = await window.vault.photo.list({ limit: 6 });
   const r = await window.vault.app.exportHtmlAlbum({
     photoIds: list.data.items.map(p => p.id),
     destDir: ${JSON.stringify(OUT)},
     title: '测试相册'
   });
   if (!r.ok) throw new Error(r.error.message);
   return r.data;`
);
const html = fs.readFileSync(album.indexPath, 'utf8');
assert(
  fs.existsSync(album.indexPath) && html.includes('测试相册') && html.includes('files/0001.jpg'),
  '导出离线相册页',
  `${album.count} 张 / ${(album.bytes / 1024 / 1024).toFixed(2)} MB`
);
assert(fs.existsSync(path.join(album.folder, 'files', '0001.jpg')), '相册页包含图片副本');

// ---------------------------------------------------------------- 分析
const analysis = await run(
  cdp,
  `const r = await window.vault.library.analysis();
   if (!r.ok) throw new Error(r.error.message);
   return { total: r.data.totalPhotos, years: r.data.byYear.length, ext: r.data.byExt.length, thumb: r.data.thumbCount, largest: r.data.largest.length };`
);
assert(analysis.total > 0 && analysis.years >= 3, '存储分析', `${analysis.total} 张 / ${analysis.years} 个年份 / 缓存 ${analysis.thumb}`);

// ---------------------------------------------------------------- 截图
async function clickNav(text) {
  await run(
    cdp,
    `const btn = [...document.querySelectorAll('.nav-item, .foot-tab')].find(b => b.innerText.includes(${JSON.stringify(text)}));
     if (!btn) throw new Error('找不到导航：' + ${JSON.stringify(text)});
     btn.click();
     await new Promise(r => setTimeout(r, 900));
     return true;`
  );
}

await cdp.reload(1800);
await clickNav('时间轴');
await cdp.shot(path.join(SHOTS, '01-timeline.png'));

await run(
  cdp,
  `const input = document.querySelector('.search input');
   input.focus();
   const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
   setter.call(input, 'IMG');
   input.dispatchEvent(new Event('input', { bubbles: true }));
   await new Promise(r => setTimeout(r, 700));
   return document.querySelectorAll('.photo-cell').length;`
);
await cdp.shot(path.join(SHOTS, '02-filter.png'));
await run(
  cdp,
  `const btn = [...document.querySelectorAll('.btn')].find(b => b.innerText === '清除筛选');
   if (btn) btn.click();
   await new Promise(r => setTimeout(r, 500));
   return true;`
);

await run(
  cdp,
  `document.querySelector('.photo-cell').click();
   await new Promise(r => setTimeout(r, 1200));
   return document.querySelector('.viewer') ? 'open' : 'no-viewer';`
);
await cdp.shot(path.join(SHOTS, '03-viewer.png'));
await run(cdp, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await new Promise(r => setTimeout(r, 400)); return true;`);

await clickNav('收藏夹');
await cdp.shot(path.join(SHOTS, '04-smart-album.png'));

await clickNav('精选');
await cdp.shot(path.join(SHOTS, '05-tag.png'));

await clickNav('重复照片');
await sleep(1400);
await cdp.shot(path.join(SHOTS, '06-duplicates.png'));

await clickNav('收集任务');
await sleep(600);
await cdp.shot(path.join(SHOTS, '07-tasks.png'));

await run(
  cdp,
  `const btn = [...document.querySelectorAll('.task-card .btn')].find(b => b.innerText === '上传入口');
   if (!btn) throw new Error('没有上传入口按钮');
   btn.click();
   await new Promise(r => setTimeout(r, 1200));
   return document.querySelector('.qr-wrap img') ? 'qr' : 'no-qr';`
);
await cdp.shot(path.join(SHOTS, '08-upload.png'));
await run(cdp, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await new Promise(r => setTimeout(r, 400)); return true;`);

await run(
  cdp,
  `const btn = [...document.querySelectorAll('.task-card .btn')].find(b => b.innerText === '查看照片');
   btn.click();
   await new Promise(r => setTimeout(r, 1200));
   return document.querySelector('.task-strip') ? 'strip' : 'no-strip';`
);
await cdp.shot(path.join(SHOTS, '09-task-view.png'));

await clickNav('存储分析');
await sleep(700);
await cdp.shot(path.join(SHOTS, '10-storage.png'));

await clickNav('设置');
await sleep(500);
await cdp.shot(path.join(SHOTS, '11-settings.png'));

// ---------------------------------------------------------------- 控制台错误
await sleep(600);
if (cdp.errors.length) {
  console.log('\n控制台异常：');
  for (const e of cdp.errors.slice(0, 10)) console.log('  ' + e);
} else {
  ok('控制台无异常');
}

const failed = results.filter((r) => r.failed).length;
console.log(`\n结果：${results.length - failed} 项通过，${failed} 项失败`);
if (failed) process.exitCode = 1;

cdp.close();

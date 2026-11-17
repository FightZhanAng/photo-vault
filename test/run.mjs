/**
 * e2e 启动器：起一个干净实例跑 test/e2e.mjs，跑完收摊。
 *
 *   npm run e2e:full
 *
 * 为什么要单独一个脚本：
 * 1. e2e 会往 _lib 里建库，必须从空目录开始，否则第二次跑直接「库已存在」；
 *    _out 是导出/相册页的落盘目录，同样要清空 —— 否则上次跑的产物会和本次
 *    导出的文件混在一起，断言「导出 4 个文件」就会被旧文件顶成 5 个；
 * 2. 必须清掉 ELECTRON_RUN_AS_NODE（继承自宿主时 Electron 会退化成纯 node）与本机
 *    注入的 NODE_OPTIONS 安全垫（它把 fs.rm 改成「移入回收站」，会让清理失败）；
 * 3. --disable-features=CalculateNativeWinOcclusion 等三个开关不开，窗口被遮挡后
 *    渲染进程会被降频，等断言容易超时；
 * 4. 结束时只杀自己这棵进程树，别误伤机器上别的 electron。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { sleep } from './cdp.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 9411;
const USERDATA = path.join(ROOT, '.workbuddy', 'tmp', 'e2e-userdata');

for (const dir of [path.join(ROOT, '_lib'), path.join(ROOT, '_out'), USERDATA]) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.NODE_OPTIONS = '';

const electron = path.join(
  ROOT,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron'
);

const child = spawn(
  electron,
  [
    '.',
    `--user-data-dir=${USERDATA}`,
    `--remote-debugging-port=${PORT}`,
    '--disable-features=CalculateNativeWinOcclusion',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
  ],
  { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] }
);
child.stderr.on('data', () => {});

let ready = false;
for (let i = 0; i < 120; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json`);
    if (r.ok) {
      ready = true;
      break;
    }
  } catch {
    /* 还没起来 */
  }
  await sleep(250);
}

if (!ready) {
  console.error('应用没起来，先确认 npm run build 过了');
  child.kill('SIGKILL');
  process.exit(1);
}
await sleep(1200);

const run = spawn(process.execPath, [path.join(ROOT, 'test', 'e2e.mjs')], {
  cwd: ROOT,
  env,
  stdio: 'inherit',
});
const code = await new Promise((r) => run.on('exit', r));

if (process.platform === 'win32') {
  const kill = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  await new Promise((r) => kill.on('exit', r));
} else {
  child.kill('SIGKILL');
}
await sleep(400);

process.exit(code ?? 0);

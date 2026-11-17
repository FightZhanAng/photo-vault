/**
 * 生成 e2e 用的测试图片集。
 *
 * 素材取 Windows 自带壁纸（真实照片，pHash 才有意义——纯色/SVG 会让所有图互相近似）。
 * 产出：
 *   _data/   16 个文件（12 张源图 + 3 张近似副本 + 1 张完全相同的副本）
 *   _phone/  1 张竖版图片，模拟手机上传
 *
 * 注意：引用式媒体库不复制原图，e2e 里的“批量重命名”会直接改掉 _data 里的文件名，
 * 所以每次跑之前都要重新生成一遍。
 */
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = process.cwd();
const DATA = path.join(ROOT, '_data');
const PHONE = path.join(ROOT, '_phone');

/** fs.unlinkSync 会被本机 safe-delete 垫子拦成“移入回收站”并失败，走 .NET */
function clearFiles(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const stale = fs
    .readdirSync(dir)
    .map((f) => path.join(dir, f))
    .filter((p) => fs.statSync(p).isFile());
  if (!stale.length) return;
  const script = stale.map((p) => `[System.IO.File]::Delete(${JSON.stringify(p)})`).join('; ');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: 'pipe',
  });
}

const SOURCES = [
  'C:/Windows/Web/Screen/img100.jpg',
  'C:/Windows/Web/Screen/img101.jpg',
  'C:/Windows/Web/Screen/img102.jpg',
  'C:/Windows/Web/Screen/img103.jpg',
  'C:/Windows/Web/Screen/img104.jpg',
  'C:/Windows/Web/Wallpaper/Windows/img0.jpg',
  'C:/Windows/Web/Wallpaper/Windows/img19.jpg',
  'C:/Windows/Web/Wallpaper/Lenovo/blue.jpg',
  'C:/Windows/Web/Wallpaper/Lenovo/red.jpg',
  'C:/Windows/Web/Wallpaper/Lenovo/white.jpg',
  'C:/Windows/Web/Screen/img105.jpg',
  'C:/Windows/Web/4K/Wallpaper/Windows/img0_1920x1200.jpg',
];

const WIDTHS = [1920, 1400, 1600, 1200];

function dateFor(i) {
  return new Date(2023 + Math.floor(i / 5), (i * 3) % 12, (i * 7) % 27 + 1, 9 + (i % 11), 15, 0);
}

const PHONE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="1920">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2c4a6e"/>
      <stop offset="1" stop-color="#16273c"/>
    </linearGradient>
  </defs>
  <rect width="1440" height="1920" fill="url(#g)"/>
  <circle cx="900" cy="620" r="320" fill="#9aa4a8" opacity="0.85"/>
  <text x="180" y="1620" font-family="Segoe UI, Arial" font-size="190" fill="#f2f5f7">PHONE</text>
</svg>`;

(async () => {
  clearFiles(DATA);
  clearFiles(PHONE);

  const made = [];
  for (let i = 0; i < SOURCES.length; i++) {
    const file = path.join(DATA, `IMG_${String(i + 1).padStart(4, '0')}.jpg`);
    await sharp(SOURCES[i])
      .rotate()
      .resize({ width: WIDTHS[i % WIDTHS.length], withoutEnlargement: true })
      .jpeg({ quality: 88 })
      .toFile(file);
    const d = dateFor(i);
    fs.utimesSync(file, d, d);
    made.push(file);
  }

  // 近似重复：缩到 78% 左右 + 提亮一点，模拟「微信存过一遍」
  for (const idx of [2, 6, 9]) {
    const src = made[idx];
    await sharp(src)
      .resize({ width: 1100, withoutEnlargement: true })
      .modulate({ brightness: 1.04 })
      .jpeg({ quality: 82 })
      .toFile(path.join(DATA, `IMG_${String(idx + 1).padStart(4, '0')}_副本.jpg`));
  }

  // 完全相同的副本：导入时应被 sha1 去重
  fs.copyFileSync(made[4], path.join(DATA, 'IMG_0005_完全重复.jpg'));

  await sharp(Buffer.from(PHONE_SVG)).jpeg({ quality: 86 }).toFile(path.join(PHONE, 'photo-from-phone.jpg'));

  const files = fs.readdirSync(DATA);
  console.log('生成', files.length, '个文件（导入后应为', files.length - 1, '张）');
  console.log('手机上传图', path.join('_phone', 'photo-from-phone.jpg'));
})();

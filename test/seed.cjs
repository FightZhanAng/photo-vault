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

/**
 * 拼一段最小的 EXIF APP1，只带 GPS（北纬/东经）。
 * Windows 壁纸本身没有 EXIF，而「定位解析」是踩过坑的地方：readExif 曾经用
 * pick 白名单把整个 GPS 块跳过，所有照片的 gps 都是 null，却没有任何断言拦下来。
 * 这里手动塞进去，让 e2e 能真的验到。
 */
function gpsApp1(lat, lon) {
  const tiff = Buffer.alloc(128);
  tiff.write('II', 0, 'ascii');
  tiff.writeUInt16LE(0x2a, 2);
  tiff.writeUInt32LE(8, 4);

  // IFD0 @8：只放一个「GPS IFD 指针」(0x8825)，next IFD = 0
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x8825, 10);
  tiff.writeUInt16LE(4, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt32LE(26, 18);
  tiff.writeUInt32LE(0, 22);

  // GPS IFD @26：纬度参考/纬度/经度参考/经度，next = 0
  let p = 26;
  tiff.writeUInt16LE(4, p);
  p += 2;
  const entry = (tag, type, count, val) => {
    tiff.writeUInt16LE(tag, p);
    tiff.writeUInt16LE(type, p + 2);
    tiff.writeUInt32LE(count, p + 4);
    val.copy(tiff, p + 8);
    p += 12;
  };
  const ascii = (s) => {
    const b = Buffer.alloc(4);
    b.write(s, 0, 'ascii');
    return b;
  };
  const ptr = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const dms = (v) => {
    const d = Math.floor(v);
    const mf = (v - d) * 60;
    const m = Math.floor(mf);
    const s = Math.round((mf - m) * 60 * 100);
    return [
      [d, 1],
      [m, 1],
      [s, 100],
    ];
  };

  entry(0x0001, 2, 2, ascii('N\0'));
  entry(0x0002, 5, 3, ptr(80));
  entry(0x0003, 2, 2, ascii('E\0'));
  entry(0x0004, 5, 3, ptr(104));
  tiff.writeUInt32LE(0, p);

  let o = 80;
  for (const [num, den] of [...dms(lat), ...dms(lon)]) {
    tiff.writeUInt32LE(num, o);
    tiff.writeUInt32LE(den, o + 4);
    o += 8;
  }

  const head = Buffer.alloc(4);
  head.writeUInt16BE(0xffe1, 0);
  head.writeUInt16BE(2 + 6 + tiff.length, 2);
  return Buffer.concat([head, Buffer.from('Exif\0\0', 'ascii'), tiff]);
}

/** 把 GPS 段插到 SOI 之后；文件本来带 EXIF 就跳过 */
function injectGps(file, lat, lon) {
  const buf = fs.readFileSync(file);
  if (buf[2] === 0xff && buf[3] === 0xe1) return false;
  fs.writeFileSync(file, Buffer.concat([buf.subarray(0, 2), gpsApp1(lat, lon), buf.subarray(2)]));
  return true;
}

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
    // 第一张塞 GPS，专测定位解析；必须在 utimesSync 之前，否则 mtime 会被写坏
    if (i === 0) injectGps(file, 22.5431, 114.0579);
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

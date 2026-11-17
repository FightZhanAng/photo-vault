import sharp from 'sharp';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type ThumbSize = 320 | 1600;

/** 按 id 取模分片，避免单目录几十万文件 */
export function thumbFile(thumbsPath: string, id: number, size: ThumbSize): string {
  const shard = String(id % 256).padStart(3, '0');
  return join(thumbsPath, shard, `${id}-${size}.webp`);
}

/** 从原图生成缩略图；返回落盘路径 */
export async function generateThumb(
  srcPath: string,
  thumbsPath: string,
  id: number,
  size: ThumbSize
): Promise<string> {
  const out = thumbFile(thumbsPath, id, size);
  await mkdir(dirname(out), { recursive: true });
  const quality = size === 320 ? 78 : 86;
  await sharp(srcPath, { failOn: 'none' })
    .rotate() // 按 EXIF Orientation 自动摆正
    .resize(size, size, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality })
    .toFile(out);
  return out;
}

/** 生成 320 缩略图到内存（导入时一次解码，既落盘也算感知哈希） */
export async function renderThumbBuffer(
  srcPath: string,
  size: ThumbSize = 320
): Promise<{ buffer: Buffer; width: number; height: number }> {
  const quality = size === 320 ? 78 : 86;
  const { data, info } = await sharp(srcPath, { failOn: 'none' })
    .rotate()
    .resize(size, size, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality })
    .toBuffer({ resolveWithObject: true });
  return { buffer: data, width: info.width, height: info.height };
}

/** 用缩略图算 64bit dHash（16 位 hex），用于"看起来像同一张" */
export async function computeDHash(image: Buffer | string): Promise<string> {
  const { data } = await sharp(image, { failOn: 'none' })
    .greyscale()
    .resize(9, 8, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  let bits = 0n;
  let idx = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      if (data[y * 9 + x] > data[y * 9 + x + 1]) bits |= 1n << BigInt(idx);
      idx++;
    }
  }
  return bits.toString(16).padStart(16, '0');
}

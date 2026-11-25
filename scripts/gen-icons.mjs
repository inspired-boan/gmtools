// 生成占位应用图标：珊瑚底 (#cc785c) + 白色菱形。
// 零依赖：用 Node 内置 zlib 手工构造 PNG，ICO 直接内嵌 PNG 数据。
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function makePng(size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  // 原始扫描行：每行 1 字节 filter(0) + RGB 像素
  const bg = [0xcc, 0x78, 0x5c]; // #cc785c
  const fg = [0xfa, 0xf9, 0xf5]; // #faf9f5
  const cx = (size - 1) / 2;
  const r = size * 0.32;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      const inside = Math.abs(x - cx) + Math.abs(y - cx) < r;
      const [R, G, B] = inside ? fg : bg;
      row.set([R, G, B], 1 + x * 3);
    }
    rows.push(row);
  }
  const idat = deflateSync(Buffer.concat(rows));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function makeIco(png, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // 1 张图
  const entry = Buffer.alloc(16);
  entry[0] = size;
  entry[1] = size;
  entry[4] = 1; // planes
  entry[6] = 32; // bpp
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12); // 数据偏移
  return Buffer.concat([header, entry, png]);
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "icons");
mkdirSync(outDir, { recursive: true });

const png128 = makePng(128);
const png32 = makePng(32);
writeFileSync(join(outDir, "128x128.png"), png128);
writeFileSync(join(outDir, "32x32.png"), png32);
writeFileSync(join(outDir, "icon.ico"), makeIco(png128, 128));
console.log("icons written to", outDir);

/**
 * Gera os ícones PNG da extensão e do instalador sem dependências externas
 * (PNG escrito à mão: RGBA, sem compressão pesada — poucos KB por ícone).
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** Desenha o ícone: fundo escuro arredondado, "M" azul e ponto verde. */
function pixels(size) {
  const px = Buffer.alloc(size * size * 4);
  const radius = Math.round(size * 0.18);
  const inCorner = (x, y) => {
    const cx = x < radius ? radius : x >= size - radius ? size - radius - 1 : x;
    const cy = y < radius ? radius : y >= size - radius ? size - radius - 1 : y;
    return (x - cx) ** 2 + (y - cy) ** 2 > radius ** 2;
  };
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      if (inCorner(x, y)) {
        px[i + 3] = 0;
        continue;
      }
      px[i] = 0x0d;
      px[i + 1] = 0x11;
      px[i + 2] = 0x17;
      px[i + 3] = 255;
    }
  }
  const set = (x, y, [r, g, b]) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = 255;
  };
  const accent = [0x2f, 0x81, 0xf7];
  const green = [0x3f, 0xb9, 0x50];
  const stroke = Math.max(1, Math.round(size / 12));
  const top = Math.round(size * 0.3);
  const bottom = Math.round(size * 0.72);
  const left = Math.round(size * 0.24);
  const right = Math.round(size * 0.72);
  const mid = Math.round((left + right) / 2);
  for (let t = 0; t < stroke; t += 1) {
    for (let y = top; y < bottom; y += 1) {
      set(left + t, y, accent);
      set(right - t, y, accent);
    }
    for (let k = 0; k < (bottom - top) / 2; k += 1) {
      set(left + t + k, top + k, accent);
      set(right - t - k, top + k, accent);
      set(mid, bottom - 1 - k, accent);
    }
  }
  const dotR = Math.max(1, Math.round(size / 16));
  const cx = Math.round(size * 0.78);
  const cy = Math.round(size * 0.28);
  for (let y = cy - dotR; y <= cy + dotR; y += 1) {
    for (let x = cx - dotR; x <= cx + dotR; x += 1) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= dotR ** 2) set(x, y, green);
    }
  }
  return px;
}

function png(size) {
  const raw = pixels(size);
  const stride = size * 4;
  const withFilter = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    withFilter[y * (stride + 1)] = 0;
    raw.copy(withFilter, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(withFilter, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function makeIcons(dir, sizes = [16, 32, 48, 128, 256]) {
  mkdirSync(dir, { recursive: true });
  for (const size of sizes) writeFileSync(join(dir, `icon${size}.png`), png(size));
  return sizes.map((s) => join(dir, `icon${s}.png`));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  const dir = process.argv[2] ?? 'dist/icons';
  console.log(`OK  ${makeIcons(dir).join(', ')}`);
}

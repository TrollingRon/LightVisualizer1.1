const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = "C:\\Users\\ryryb\\Desktop\\LightingTexturePreviewer\\assets";

function crcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
}

const CRC_TABLE = crcTable();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function writePng(filePath, width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 3 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = rgb(x, y, width, height).map((v) => Math.max(0, Math.min(255, Math.round(v))));
      const i = rowStart + 1 + x * 3;
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
    }
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const compressed = zlib.deflateSync(raw, { level: 9 });
  const out = Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", compressed),
    chunk("IEND", Buffer.alloc(0))
  ]);
  fs.writeFileSync(filePath, out);
}

function heightVal(x, y) {
  return (
    Math.sin(x * 0.12) * 0.5 +
    Math.cos(y * 0.09) * 0.4 +
    Math.sin((x + y) * 0.04) * 0.35
  );
}

function baseTex(x, y, width, height) {
  const gx = x / width;
  const gy = y / height;
  const mortar = Math.floor(x / 32) % 2 === 0 ? 28 : 18;
  const brickLine = y % 32 === 0 || y % 32 === 1;
  const vertJoint = ((x + (Math.floor(y / 32) % 2 === 1 ? 16 : 0)) % 64 === 0) || ((x + (Math.floor(y / 32) % 2 === 1 ? 16 : 0)) % 64 === 1);
  const noise = (Math.sin(x * 0.37) + Math.cos(y * 0.29) + Math.sin((x + y) * 0.11)) * 7;
  const base = 112 + (20 * gx + 12 * gy + noise);
  if (brickLine || vertJoint) return [mortar, mortar, mortar];
  return [base + 28, base + 16, base + 8];
}

function normalTex(x, y, width, height) {
  const sx1 = heightVal(Math.max(x - 1, 0), y);
  const sx2 = heightVal(Math.min(x + 1, width - 1), y);
  const sy1 = heightVal(x, Math.max(y - 1, 0));
  const sy2 = heightVal(x, Math.min(y + 1, height - 1));
  const dx = (sx2 - sx1) * 1.5;
  const dy = (sy2 - sy1) * 1.5;
  let nx = -dx;
  let ny = -dy;
  let nz = 1.0;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
  nx /= len;
  ny /= len;
  nz /= len;
  return [(nx * 0.5 + 0.5) * 255, (ny * 0.5 + 0.5) * 255, (nz * 0.5 + 0.5) * 255];
}

function goboTex(x, y, width, height) {
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const dx = x - cx;
  const dy = y - cy;
  const r = Math.sqrt(dx * dx + dy * dy);
  const a = Math.atan2(dy, dx);
  const spokes = Math.sin(a * 8) > 0.2;
  const ring = r > 55 && r < 230;
  const blob = spokes && ring ? 1 : 0;
  const soft = Math.max(0, Math.min(1, 1 - Math.abs(r - 140) / 140));
  const v = (0.15 + 0.85 * (blob * soft)) * 255;
  return [v, v, v];
}

fs.mkdirSync(ROOT, { recursive: true });
writePng(path.join(ROOT, "sample_base_texture.png"), 1024, 1024, baseTex);
writePng(path.join(ROOT, "sample_normal_map.png"), 1024, 1024, normalTex);
writePng(path.join(ROOT, "sample_gobo.png"), 512, 512, goboTex);
console.log(`Generated assets in ${ROOT}`);

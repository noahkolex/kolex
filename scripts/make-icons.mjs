// Generates the extension icons (a pixel "K" on the Sefra bone tile) as
// valid PNGs with zero image dependencies.
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const GLYPH = [
  "........",
  ".X....X.",
  ".X...X..",
  ".X..X...",
  ".XXX....",
  ".X..X...",
  ".X...X..",
  ".X....X.",
];
// Sefra palette: cool bone tile, cobalt mark.
const BG = [0xf4, 0xf4, 0xf1, 0xff];
const FG = [0x15, 0x47, 0xf5, 0xff];

function crc32(buf) {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4); // filter byte 0 + pixels
    for (let x = 0; x < size; x++) {
      const gx = Math.floor((x * 8) / size);
      const gy = Math.floor((y * 8) / size);
      const px = GLYPH[gy][gx] === "X" ? FG : BG;
      row.set(px, 1 + x * 4);
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync("extension/icons", { recursive: true });
for (const size of [16, 48, 128]) {
  writeFileSync(`extension/icons/icon${size}.png`, png(size));
}
console.log("icons written → extension/icons/");

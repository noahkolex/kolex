// Rasterizes the official Sefra favicon (favicon.svg: white bird mark on a
// cobalt rounded tile) into the extension's PNG icons — pure Node, no image
// dependencies. The bird path is straight-line subpaths only (M/L/Z), so an
// exact supersampled even-odd polygon fill reproduces it faithfully.
import { deflateSync } from "node:zlib";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const SVG_SIZE = 256;
const SS = 4; // supersampling factor per axis

const svg = readFileSync("favicon.svg", "utf8");
const tile = hex(svg.match(/<rect[^>]*fill="(#[0-9a-fA-F]{6})"/)?.[1] ?? "#1B52ED");
const mark = hex(svg.match(/<path[^>]*fill="(#[0-9a-fA-F]{6})"/i)?.[1] ?? "#FFFFFF");
const radius = Number(svg.match(/rx="([\d.]+)"/)?.[1] ?? 56);
const pathData = svg.match(/<path[^>]*d="([^"]+)"/)?.[1];
if (!pathData) throw new Error("favicon.svg: no path data found");

function hex(h) {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

/** Parse M/L/Z-only path data into closed polygons. */
function parsePolygons(d) {
  const polys = [];
  let current = [];
  for (const cmd of d.matchAll(/([MLZ])\s*((?:[\d.]+[\s,]+[\d.]+\s*)*)/gi) ) {
    const op = cmd[1].toUpperCase();
    if (op === "Z") {
      if (current.length >= 3) polys.push(current);
      current = [];
      continue;
    }
    const nums = (cmd[2].match(/[\d.]+/g) ?? []).map(Number);
    for (let i = 0; i + 1 < nums.length; i += 2) current.push([nums[i], nums[i + 1]]);
  }
  if (current.length >= 3) polys.push(current);
  return polys;
}

const polygons = parsePolygons(pathData);

/** Even-odd rule across all subpaths, in SVG user units. */
function insideMark(x, y) {
  let inside = false;
  for (const poly of polygons) {
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

function insideTile(x, y) {
  const r = radius;
  const cx = Math.max(r, Math.min(SVG_SIZE - r, x));
  const cy = Math.max(r, Math.min(SVG_SIZE - r, y));
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

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
  const scale = SVG_SIZE / size;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4); // filter byte 0 + pixels
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const ux = (x + (sx + 0.5) / SS) * scale;
          const uy = (y + (sy + 0.5) / SS) * scale;
          if (!insideTile(ux, uy)) continue;
          const c = insideMark(ux, uy) ? mark : tile;
          r += c[0]; g += c[1]; b += c[2]; a += 255;
        }
      }
      const n = SS * SS;
      const o = 1 + x * 4;
      const cov = a / n / 255;
      // Straight (non-premultiplied) alpha, color averaged over covered samples.
      row[o] = cov > 0 ? Math.round(r / (a / 255)) : 0;
      row[o + 1] = cov > 0 ? Math.round(g / (a / 255)) : 0;
      row[o + 2] = cov > 0 ? Math.round(b / (a / 255)) : 0;
      row[o + 3] = Math.round(a / n);
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
console.log(`icons rasterized from favicon.svg (${polygons.length} subpaths) → extension/icons/`);

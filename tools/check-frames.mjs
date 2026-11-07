#!/usr/bin/env node
// Checks a blink or talk frame against the base frame before the overlay may use it.
// The overlay never swaps whole frames for these: it copies only a box (the eyes, the
// mouth) from the frame into the base, so nothing outside the box can ever move.
//
//   node tools/check-frames.mjs <base.png> <frame.png> --box x0,y0,x1,y1 [--diff out.png] [--record blink|talk]
//
// It passes when the frames are the same size, something changes inside the box, and the
// box's edge doesn't change (a changed edge would show as a seam). --record then writes the
// frame, its box and both files' SHA-256 to assets/frames.json; the overlay ignores a frame
// whose file no longer matches. Also printed, for information: how much of the whole figure
// differs and where. Only 8-bit RGB/RGBA, non-interlaced PNGs. No dependencies.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8, width = 0, height = 0, depth = 0, color = 0, interlace = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); depth = data[8]; color = data[9]; interlace = data[12]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8 || (color !== 2 && color !== 6) || interlace !== 0) throw new Error('unsupported PNG (needs 8-bit RGB/RGBA, not interlaced)');
  const bpp = color === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const rgba = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[i] = v & 255;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4, s = x * bpp;
      rgba[o] = line[s]; rgba[o + 1] = line[s + 1]; rgba[o + 2] = line[s + 2]; rgba[o + 3] = bpp === 4 ? line[s + 3] : 255;
    }
    prev = line;
  }
  return { width, height, rgba };
}

export function encodePng({ width, height, rgba }) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  const chunk = (type, data) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// A pixel belongs to the figure if either frame draws it; it differs if its coverage or
// (where both draw it) its colour changes noticeably. box = [x0, y0, x1, y1], inclusive.
export function compareFrames(a, b, { box = null, alphaMin = 32, alphaStep = 32, colorStep = 40 } = {}) {
  if (a.width !== b.width || a.height !== b.height) return { sameSize: false };
  let figure = 0, differ = 0, inside = 0, edge = 0;
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  const mask = new Uint8Array(a.width * a.height);
  for (let i = 0, p = 0; p < mask.length; p++, i += 4) {
    const aa = a.rgba[i + 3], ba = b.rgba[i + 3];
    if (aa < alphaMin && ba < alphaMin) continue;
    figure++;
    const coverage = Math.abs(aa - ba) >= alphaStep;
    const colour = aa >= alphaMin && ba >= alphaMin && Math.max(Math.abs(a.rgba[i] - b.rgba[i]), Math.abs(a.rgba[i + 1] - b.rgba[i + 1]), Math.abs(a.rgba[i + 2] - b.rgba[i + 2])) >= colorStep;
    if (!coverage && !colour) continue;
    differ++; mask[p] = 1;
    const x = p % a.width, y = (p - x) / a.width;
    if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
    if (box && x >= box[0] && y >= box[1] && x <= box[2] && y <= box[3]) {
      inside++;
      if (x <= box[0] + 1 || y <= box[1] + 1 || x >= box[2] - 1 || y >= box[3] - 1) edge++;
    }
  }
  const percent = figure ? +(100 * differ / figure).toFixed(3) : 0;
  return { sameSize: true, figure, differ, percent, bbox: differ ? [x0, y0, x1, y1] : null, inside: box ? inside : null, edge: box ? edge : null, mask };
}

// Usable as a patch: a real change inside the box, and (almost) none on its edge.
export const patchOk = r => !!r.sameSize && r.inside > 0 && r.edge <= 4;

// Base dimmed to grey, differing pixels in red, the box outlined in green.
export function diffImage(a, mask, box) {
  const out = Buffer.alloc(a.rgba.length);
  for (let i = 0, p = 0; p < mask.length; p++, i += 4) {
    const g = (a.rgba[i] + a.rgba[i + 1] + a.rgba[i + 2]) / 3, al = a.rgba[i + 3] / 255;
    const v = Math.round(20 + g * 0.35 * al);
    if (mask[p]) { out[i] = 255; out[i + 1] = 40; out[i + 2] = 40; } else { out[i] = v; out[i + 1] = v; out[i + 2] = v; }
    out[i + 3] = 255;
  }
  if (box) {
    const put = (x, y) => { if (x < 0 || y < 0 || x >= a.width || y >= a.height) return; const i = (y * a.width + x) * 4; out[i] = 40; out[i + 1] = 230; out[i + 2] = 90; };
    for (let x = box[0]; x <= box[2]; x++) { put(x, box[1]); put(x, box[3]); }
    for (let y = box[1]; y <= box[3]; y++) { put(box[0], y); put(box[2], y); }
  }
  return { width: a.width, height: a.height, rgba: out };
}

export const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const args = process.argv.slice(2);
  const opt = name => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : null; };
  const boxArg = opt('--box'), diffArg = opt('--diff'), record = opt('--record');
  const [baseFile, frameFile] = args;
  if (!baseFile || !frameFile || !boxArg) { console.error('usage: check-frames.mjs <base.png> <frame.png> --box x0,y0,x1,y1 [--diff out.png] [--record blink|talk]'); process.exit(2); }
  const box = boxArg.split(',').map(Number);
  if (box.length !== 4 || box.some(n => !Number.isInteger(n) || n < 0) || box[2] <= box[0] || box[3] <= box[1]) { console.error('--box needs four whole numbers x0,y0,x1,y1'); process.exit(2); }
  const a = decodePng(fs.readFileSync(baseFile)), b = decodePng(fs.readFileSync(frameFile));
  const r = compareFrames(a, b, { box });
  if (diffArg && r.mask) fs.writeFileSync(diffArg, encodePng(diffImage(a, r.mask, box)));
  const pass = patchOk(r);
  const { mask, ...report } = r;
  console.log(JSON.stringify({ ...report, box, pass }));
  if (pass && record) {
    if (!['blink', 'talk'].includes(record)) { console.error('--record takes blink or talk'); process.exit(2); }
    if (path.resolve(path.dirname(baseFile)) !== path.resolve(path.dirname(frameFile))) { console.error('the base and the frame must be in the same folder'); process.exit(2); }
    const manifest = path.join(path.dirname(path.resolve(frameFile)), 'frames.json');
    let doc = {}; try { doc = JSON.parse(fs.readFileSync(manifest, 'utf8')); } catch { /* new file */ }
    doc.note = 'Checked by tools/check-frames.mjs. The overlay copies only each box from these frames into the base, and ignores a frame whose file has changed since.';
    doc[record] = { file: path.basename(frameFile), base: path.basename(baseFile), box, sha256: sha256(frameFile), baseSha256: sha256(baseFile), checked: new Date().toISOString().slice(0, 10), wholeFigureDiffers: r.percent, changedInBox: r.inside };
    fs.writeFileSync(manifest, JSON.stringify(doc, null, 2) + '\n');
    console.log('recorded', record, 'in', manifest);
  }
  process.exit(pass ? 0 : 1);
}

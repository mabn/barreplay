// textures.mjs — measure BAR's effect textures for fx-ceg.js.
//
// BAR's effect bitmaps are all-rights-reserved art, so the viewer cannot
// ship them. What it ships instead is a MEASUREMENT of each one, taken here
// from a local checkout: how bright and how opaque the texture is at each
// distance from its centre (16 rings), what colour it is there, and how
// uneven it is around each ring. fx-ceg.js paints a stand-in from those
// numbers, so a flare that is a white pin with a faint orange halo in BAR
// is one in the viewer too, at the same overall brightness — which is what
// decides whether a hundred overlapping particles read as a fireball or
// wash out to white.
//
// Textures that are not square (the muzzle flames' side streaks) are
// measured along each axis instead. Flipbooks (animParams = "8,8,60": an
// atlas of frames played over the particle's life) are measured at up to
// FRAMES evenly spaced frames, so a fireball still burns out into smoke.
import { readFileSync, readdirSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { dirname, basename, join } from "node:path";

export const BINS = 16;
export const FRAMES = 8;

// The checkout's paths are matched case-insensitively, as BAR's VFS does.
function readCI(root, rel) {
  let dir = root;
  const parts = rel.split("/");
  for (let i = 0; i < parts.length; i++) {
    const want = parts[i].toLowerCase();
    const hit = readdirSync(dir).find((n) => n.toLowerCase() === want);
    if (!hit) return null;
    dir = join(dir, hit);
  }
  return readFileSync(dir);
}

// decodeTGA reads types 2/3 (raw colour/grey) and 10/11 (RLE) at 8, 24 or
// 32 bits into top-down RGBA. Grey becomes opaque grey, as the engine's
// loader converts it.
export function decodeTGA(b) {
  const idLen = b[0], cmapType = b[1], type = b[2];
  if (cmapType !== 0 || ![2, 3, 10, 11].includes(type)) throw new Error(`unsupported TGA type ${type}`);
  const w = b.readUInt16LE(12), h = b.readUInt16LE(14), bpp = b[16], desc = b[17];
  const px = bpp >> 3;
  const grey = type === 3 || type === 11;
  let p = 18 + idLen;
  const raw = Buffer.alloc(w * h * px);
  if (type < 9) b.copy(raw, 0, p, p + raw.length);
  else {
    let o = 0;
    while (o < raw.length) {
      const c = b[p++];
      const n = (c & 0x7f) + 1;
      if (c & 0x80) { for (let i = 0; i < n; i++) { b.copy(raw, o, p, p + px); o += px; } p += px; }
      else { b.copy(raw, o, p, p + n * px); o += n * px; p += n * px; }
    }
  }
  const out = new Uint8Array(w * h * 4);
  const topDown = (desc & 0x20) !== 0;
  for (let y = 0; y < h; y++) {
    const sy = topDown ? y : h - 1 - y;
    for (let x = 0; x < w; x++) {
      const s = (sy * w + x) * px, d = (y * w + x) * 4;
      if (grey) { out[d] = out[d + 1] = out[d + 2] = raw[s]; out[d + 3] = px === 2 ? raw[s + 1] : 255; }
      else { out[d] = raw[s + 2]; out[d + 1] = raw[s + 1]; out[d + 2] = raw[s]; out[d + 3] = px === 4 ? raw[s + 3] : 255; }
    }
  }
  return { w, h, data: out };
}

// decodePNG reads 8-bit grey, grey+alpha, RGB and RGBA, non-interlaced.
export function decodePNG(b) {
  let p = 8, w = 0, h = 0, depth = 0, ct = 0, inter = 0;
  const idat = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p), type = b.toString("latin1", p + 4, p + 8);
    const d = b.subarray(p + 8, p + 8 + len);
    if (type === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; ct = d[9]; inter = d[12]; }
    else if (type === "IDAT") idat.push(d);
    else if (type === "IEND") break;
    p += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  if (depth !== 8 || !ch || inter) throw new Error(`unsupported PNG (depth ${depth}, colour ${ct}, interlace ${inter})`);
  const z = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const img = new Uint8Array(h * stride);
  for (let y = 0; y < h; y++) {
    const f = z[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? img[y * stride + x - ch] : 0;
      const up = y > 0 ? img[(y - 1) * stride + x] : 0;
      const c = x >= ch && y > 0 ? img[(y - 1) * stride + x - ch] : 0;
      let v = z[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) {
        const pp = a + up - c, pa = Math.abs(pp - a), pb = Math.abs(pp - up), pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      }
      img[y * stride + x] = v & 255;
    }
  }
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const s = i * ch, d = i * 4;
    if (ch <= 2) { out[d] = out[d + 1] = out[d + 2] = img[s]; out[d + 3] = ch === 2 ? img[s + 1] : 255; }
    else { out[d] = img[s]; out[d + 1] = img[s + 1]; out[d + 2] = img[s + 2]; out[d + 3] = ch === 4 ? img[s + 3] : 255; }
  }
  return { w, h, data: out };
}

const r3 = (v) => Math.round(v * 1000) / 1000;

// measure one frame (x0, y0, fw, fh of the image).
function measure(img, x0, y0, fw, fh, separable) {
  const { w, data } = img;
  if (separable) {
    // Along u: mean RGBA per column band. Across v: relative alpha+light
    // per row band, peak 1.
    const u = new Float64Array(BINS * 4), un = new Float64Array(BINS);
    const v = new Float64Array(BINS), vn = new Float64Array(BINS);
    for (let y = 0; y < fh; y++) {
      for (let x = 0; x < fw; x++) {
        const d = ((y0 + y) * w + x0 + x) * 4;
        const bu = Math.min(BINS - 1, Math.floor(x / fw * BINS)), bv = Math.min(BINS - 1, Math.floor(y / fh * BINS));
        for (let c = 0; c < 4; c++) u[bu * 4 + c] += data[d + c] / 255;
        un[bu]++;
        v[bv] += (data[d] + data[d + 1] + data[d + 2]) / 765 + data[d + 3] / 255;
        vn[bv]++;
      }
    }
    for (let i = 0; i < BINS; i++) { for (let c = 0; c < 4; c++) u[i * 4 + c] /= un[i] || 1; v[i] /= vn[i] || 1; }
    const peak = Math.max(...v) || 1;
    return { u: [...u].map(r3), v: [...v].map((x) => r3(x / peak)) };
  }
  // Rings: mean RGBA by distance from the centre (0..1 = the inscribed
  // circle; the corners fold into the outermost ring), and how uneven each
  // ring is around its circumference (std/mean of 16 sectors' light+alpha).
  const SECT = 16;
  const acc = new Float64Array(BINS * 4), n = new Float64Array(BINS);
  const sect = new Float64Array(BINS * SECT), sn = new Float64Array(BINS * SECT);
  const cx = fw / 2, cy = fh / 2;
  for (let y = 0; y < fh; y++) {
    for (let x = 0; x < fw; x++) {
      const dx = (x + 0.5 - cx) / cx, dy = (y + 0.5 - cy) / cy;
      const b = Math.min(BINS - 1, Math.floor(Math.hypot(dx, dy) * BINS));
      const d = ((y0 + y) * w + x0 + x) * 4;
      for (let c = 0; c < 4; c++) acc[b * 4 + c] += data[d + c] / 255;
      n[b]++;
      const s = Math.min(SECT - 1, Math.floor((Math.atan2(dy, dx) / (2 * Math.PI) + 0.5) * SECT));
      sect[b * SECT + s] += (data[d] + data[d + 1] + data[d + 2]) / 765 + data[d + 3] / 255;
      sn[b * SECT + s]++;
    }
  }
  let rough = 0, wsum = 0;
  for (let b = 0; b < BINS; b++) {
    for (let c = 0; c < 4; c++) acc[b * 4 + c] /= n[b] || 1;
    let m = 0, m2 = 0, k = 0;
    for (let s = 0; s < SECT; s++) {
      const i = b * SECT + s;
      if (!sn[i]) continue;
      const val = sect[i] / sn[i];
      m += val; m2 += val * val; k++;
    }
    if (!k) continue;
    m /= k;
    const sd = Math.sqrt(Math.max(0, m2 / k - m * m));
    if (m > 0.01) { rough += (sd / m) * m; wsum += m; }
  }
  return { r: [...acc].map(r3), c: r3(wsum ? rough / wsum : 0) };
}

// profile measures one texture file. grid = [nx, ny] for a flipbook.
export function profile(img, grid) {
  let nx = 1, ny = 1;
  if (grid && grid[0] > 1) {
    nx = grid[0];
    const cw = img.w / nx;
    ny = Math.max(1, Math.round(img.h / cw));
  }
  const fw = Math.floor(img.w / nx), fh = Math.floor(img.h / ny);
  const separable = fw !== fh;
  const total = nx * ny;
  const k = Math.min(FRAMES, total);
  const frames = [];
  for (let i = 0; i < k; i++) {
    const f = k === 1 ? 0 : Math.round(i * (total - 1) / (k - 1));
    frames.push(measure(img, (f % nx) * fw, Math.floor(f / nx) * fh, fw, fh, separable));
  }
  const out = { aspect: r3(fw / fh), frames };
  if (total > 1) out.grid = [nx, ny];
  return out;
}

// profiles measures every texture in `names` (name -> grid or null) found
// in the checkout through the name -> path table resources.lua defines.
export function profiles(bar, paths, names) {
  const out = {};
  for (const [name, grid] of [...names].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const rel = paths[name];
    if (!rel) continue;
    const buf = readCI(bar, rel);
    if (!buf) { console.warn(`texture ${name}: ${rel} not in the checkout`); continue; }
    try {
      const img = rel.toLowerCase().endsWith(".png") ? decodePNG(buf) : decodeTGA(buf);
      out[name] = profile(img, grid);
    } catch (e) {
      console.warn(`texture ${name} (${basename(rel)} in ${dirname(rel)}): ${e.message}`);
    }
  }
  return out;
}

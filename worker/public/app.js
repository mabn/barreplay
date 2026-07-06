'use strict';

// barreplay viewer — vanilla JS canvas playback of a recorded capture.
//
// Wire format (see internal/viz/wire.go and snapshot/brp.go):
// /replays/<id>.brw is a small binary "BRW1" container — the JSON head (meta,
// teams, icons, bounds, and the CHUNK INDEX) plus the events section. Frame
// data arrives in two tiers:
//
//   1. /replays/<id>.keys — EVERY chunk's keyframe, one gzip stream, fetched
//      right after the head and decoded PROGRESSIVELY while it downloads
//      (fetch body -> DecompressionStream -> keyframes sliced at the raw
//      boundaries the head's chunk index gives). The first keyframe renders
//      within the first network chunks, and the whole timeline becomes
//      scrubbable in a few seconds, before any full chunk arrives.
//   2. /replays/<id>/c<n> — chunk n's DELTA frames, fetched around the
//      playhead (and sequentially in the background) and decoded seeded with
//      keyframe n. No byte is ever downloaded twice.
//
// Frames unpack into a flat Int32Array `u` of stride 9:
// [id, def, team, x, z, hp, maxHp, dvx, dvz]. We read it by index rather than
// materialising per-unit objects — a replay can hold millions of unit records,
// so avoiding the object churn keeps loading and playback smooth.

const STRIDE = 9;
const F = { ID: 0, DEF: 1, TEAM: 2, X: 3, Z: 4, HP: 5, MAXHP: 6, DVX: 7, DVZ: 8 };

// ---- wire payload decoding --------------------------------------------------
// Mirrors the encoder in snapshot/brp.go exactly; evolve them together.

// gunzip a byte slice via the browser's native DecompressionStream.
async function gunzipU8(u8) {
  const ds = new DecompressionStream('gzip');
  const resp = new Response(new Blob([u8]).stream().pipeThrough(ds));
  return new Uint8Array(await resp.arrayBuffer());
}

// Split a BRW container into its sections: {tag: Uint8Array (still gzipped)}.
function parseContainer(buf) {
  const u8 = new Uint8Array(buf);
  const magic = 'BRW1';
  for (let i = 0; i < magic.length; i++) {
    if (u8[i] !== magic.charCodeAt(i)) throw new Error('not a BRW payload (old server?)');
  }
  if (u8[magic.length] !== 4) throw new Error('unsupported payload version ' + u8[magic.length]);
  const dv = new DataView(buf);
  const secs = {};
  let off = magic.length + 1; // + version byte
  while (off + 5 <= u8.length) {
    const tag = String.fromCharCode(u8[off]);
    const len = dv.getUint32(off + 1, true);
    secs[tag] = u8.subarray(off + 5, off + 5 + len);
    off += 5 + len;
  }
  return secs;
}

// Frame decoding (mirrors snapshot/brp.go decodeFrames): per frame —
// zigzag-varint frame delta, a DEAD id list (units that disappeared), a
// CHANGED id list (new units + units with any column change), then 8 value
// columns for the changed units only, delta-coded against the same unit in
// the previous frame (absolute when the id is new); x/z predict with the
// previous frame's velocity displacement. Every other previously-live unit
// was skipped by the encoder because it matched its prediction exactly, so
// the decoder re-materialises it: position advances by dv, all else keeps.
// The output frame is the FULL live unit set, sorted by id.
//
// seed carries the prediction state INTO the stream: decoding a chunk's delta
// file starts from its keyframe ({f, u} as previously decoded from the .keys
// stream). Without a seed the stream must start with a keyframe (that is how
// the keyframes themselves decode: each is one self-contained frame).
function decodeFrames(b, seed) {
  let p = 0;
  const end = b.length;
  function uv() { // unsigned LEB128; falls back to float math past 28 bits
    let c = b[p++];
    if (c < 0x80) return c;
    let x = c & 0x7f;
    c = b[p++]; if (c < 0x80) return x | (c << 7);
    x |= (c & 0x7f) << 7;
    c = b[p++]; if (c < 0x80) return x | (c << 14);
    x |= (c & 0x7f) << 14;
    c = b[p++]; if (c < 0x80) return x | (c << 21);
    let xf = (x | ((c & 0x7f) << 21)) >>> 0;
    let mul = 268435456; // 2^28
    for (;;) {
      c = b[p++];
      xf += (c & 0x7f) * mul;
      if (c < 0x80) return xf;
      mul *= 128;
    }
  }
  function sv() { // zigzag
    const u = uv();
    return u < 0x80000000 ? ((u >>> 1) ^ -(u & 1)) : (u % 2 === 0 ? u / 2 : -(u + 1) / 2);
  }

  const frames = [];
  let prevU = seed ? seed.u : null; // previous frame's Int32Array (sorted by id)
  let prevMap = new Map();          // unit id -> base offset into prevU
  let frame = seed ? seed.f : 0;
  if (seed) {
    for (let i = 0; i < seed.u.length; i += STRIDE) prevMap.set(seed.u[i], i);
  }
  while (p < end) {
    frame += sv();

    // Dead ids (delta-coded, ascending).
    const nDead = uv();
    const dead = nDead ? new Set() : null;
    let id = 0;
    for (let i = 0; i < nDead; i++) { id += sv(); dead.add(id); }

    // Changed ids + how many of them already existed.
    const nCh = uv();
    const chIds = new Int32Array(nCh);
    const pidx = new Int32Array(nCh); // prev-frame base offset per unit, -1 if new
    let nChExisting = 0;
    id = 0;
    for (let i = 0; i < nCh; i++) {
      id += sv();
      chIds[i] = id;
      const prev = prevMap.get(id);
      if (prev === undefined) { pidx[i] = -1; } else { pidx[i] = prev; nChExisting++; }
    }

    // Decode the changed units' columns against prevU.
    const ch = new Int32Array(nCh * STRIDE);
    for (let i = 0; i < nCh; i++) ch[i * STRIDE] = chIds[i];
    for (let c = 1; c < STRIDE; c++) {
      for (let i = 0, o = c; i < nCh; i++, o += STRIDE) {
        const d = sv();
        const j = pidx[i];
        if (j < 0) { ch[o] = d; continue; }
        let base = prevU[j + c];
        if (c === F.X) base += prevU[j + F.DVX];
        else if (c === F.Z) base += prevU[j + F.DVZ];
        ch[o] = base + d;
      }
    }

    // Merge survivors (advanced by their velocity) with the changed units.
    // Both prevU and chIds are sorted by id, so this is a linear merge.
    const prevN = prevU ? prevU.length / STRIDE : 0;
    const n = prevN - nDead - nChExisting + nCh;
    const u = new Int32Array(n * STRIDE);
    let i = 0, j = 0, k = 0;
    while (i < prevN || j < nCh) {
      const pid = i < prevN ? prevU[i * STRIDE] : Infinity;
      const cid = j < nCh ? chIds[j] : Infinity;
      if (cid <= pid) {
        u.set(ch.subarray(j * STRIDE, (j + 1) * STRIDE), k * STRIDE);
        if (cid === pid) i++;
        j++; k++;
      } else {
        if (dead && dead.has(pid)) { i++; continue; }
        const o = i * STRIDE, t = k * STRIDE;
        u[t] = prevU[o];
        u[t + F.DEF] = prevU[o + F.DEF];
        u[t + F.TEAM] = prevU[o + F.TEAM];
        u[t + F.X] = prevU[o + F.X] + prevU[o + F.DVX];
        u[t + F.Z] = prevU[o + F.Z] + prevU[o + F.DVZ];
        u[t + F.HP] = prevU[o + F.HP];
        u[t + F.MAXHP] = prevU[o + F.MAXHP];
        u[t + F.DVX] = prevU[o + F.DVX];
        u[t + F.DVZ] = prevU[o + F.DVZ];
        i++; k++;
      }
    }

    prevMap = new Map();
    for (let m = 0; m < n; m++) prevMap.set(u[m * STRIDE], m * STRIDE);
    prevU = u;
    frames.push({ f: frame, t: frame / 30, n, u });
  }
  return frames;
}

// Events: count, a kind string table, then one column at a time (frame and
// unit-id delta-coded, def/team absolute).
function decodeEvents(b) {
  let p = 0;
  function uv() {
    let x = 0, mul = 1;
    for (;;) {
      const c = b[p++];
      x += (c & 0x7f) * mul;
      if (c < 0x80) return x;
      mul *= 128;
    }
  }
  function sv() {
    const u = uv();
    return u % 2 === 0 ? u / 2 : -(u + 1) / 2;
  }
  const n = uv();
  const nk = uv();
  const td = new TextDecoder();
  const kinds = [];
  for (let i = 0; i < nk; i++) {
    const l = uv();
    kinds.push(td.decode(b.subarray(p, p + l)));
    p += l;
  }
  const evs = new Array(n);
  for (let i = 0; i < n; i++) evs[i] = { f: 0, k: '', id: 0, def: 0, team: 0 };
  let acc = 0;
  for (let i = 0; i < n; i++) { acc += sv(); evs[i].f = acc; }
  for (let i = 0; i < n; i++) evs[i].k = kinds[uv()];
  acc = 0;
  for (let i = 0; i < n; i++) { acc += sv(); evs[i].id = acc; }
  for (let i = 0; i < n; i++) evs[i].def = sv();
  for (let i = 0; i < n; i++) evs[i].team = sv();
  return evs;
}

// Decode the /api/replay head payload: the head JSON's fields plus events
// [{f,k,id,def,team}]. Frames stream in separately per chunk.
async function decodeHead(buf) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('this browser lacks DecompressionStream (needed to read the capture)');
  }
  const secs = parseContainer(buf);
  if (!secs.J) throw new Error('payload has no head section');
  const head = JSON.parse(new TextDecoder().decode(await gunzipU8(secs.J)));
  head.events = secs.E ? decodeEvents(await gunzipU8(secs.E)) : [];
  return head;
}

// ---- chunk streaming --------------------------------------------------------
// data.chunks (from the head) indexes the fetchable chunks; chunkStartIdx[i] is
// chunk i's first global frame index. The .keys stream delivers every chunk's
// keyframe up front (streamKeys below); delta chunks are fetched by a small
// queue that keeps at most MAX_INFLIGHT requests going, with playhead requests
// jumping ahead of the background sequential download. Chunk states advance
// monotonically:
//   0 none -> 2 keyframe decoded -> 3 deltas requested -> 4 fully loaded
// (a chunk's key can also arrive while its delta fetch is in flight, so 3 can
// precede 2 in time; the number only ever grows).

const MAX_INFLIGHT = 2;
let chunkStartIdx = [];   // chunk i -> global index of its first frame
let chunkState = [];      // per-chunk state (see above)
let keyFrames = [];       // chunk i -> decoded keyframe {f, t, n, u} (from .keys)
let pendingDelta = [];    // chunk i -> gunzipped delta bytes that arrived before the key
let fetchQueue = [];      // pending chunk indices
let inflight = 0;
let loadGen = 0;          // bumped per loadReplay; stale completions are dropped
let currentFile = null;   // replay id for building /replays/ URLs

// chunkOf returns the chunk containing global frame index gi.
function chunkOf(gi) {
  let lo = 0, hi = chunkStartIdx.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (chunkStartIdx[mid] <= gi) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// frameNumAt derives the sim frame number of global index gi from the index
// alone (sampling is uniform), so the time label works for unloaded frames.
function frameNumAt(gi) {
  if (!data || !data.chunks.length) return 0;
  const c = chunkOf(gi);
  return data.chunks[c].frame + (gi - chunkStartIdx[c]) * data.sampleEvery;
}

// streamKeys downloads /replays/<id>.keys — every chunk's keyframe as one
// gzip stream — and decodes keyframes PROGRESSIVELY as bytes arrive: the
// response body is piped through DecompressionStream and sliced at the raw
// boundaries the head's chunk index provides (cumulative kLen), so keyframe 0
// renders within the first network chunks and the whole timeline becomes
// scrubbable while the stream is still downloading. Any delta chunk that
// arrived before its keyframe is finished here.
async function streamKeys(gen) {
  const chunks = data.chunks;
  let total = 0;
  const bounds = chunks.map(c => (total += c.kLen)); // exclusive end of keyframe i
  if (!total) return;
  const buf = new Uint8Array(total);
  let have = 0, ci = 0;
  try {
    const r = await fetch('/replays/' + encodeURIComponent(currentFile) + '.keys');
    if (!r.ok) throw new Error(await r.text());
    const reader = r.body.pipeThrough(new DecompressionStream('gzip')).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (gen !== loadGen) { reader.cancel().catch(() => {}); return; }
      if (value) {
        if (have + value.length > total) throw new Error('keys stream longer than the index says');
        buf.set(value, have);
        have += value.length;
      }
      while (ci < chunks.length && have >= bounds[ci]) {
        const start = ci === 0 ? 0 : bounds[ci - 1];
        const kf = decodeFrames(buf.subarray(start, bounds[ci]))[0];
        keyFrames[ci] = kf;
        data.frames[chunkStartIdx[ci]] = kf;
        // A single-frame chunk is complete once its keyframe is in.
        chunkState[ci] = Math.max(chunkState[ci], chunks[ci].len === 0 ? 4 : 2);
        if (pendingDelta[ci]) {
          const raw = pendingDelta[ci];
          pendingDelta[ci] = null;
          applyDeltas(ci, raw);
        }
        onChunkArrived(ci);
        ci++;
      }
      if (done) break;
    }
    if (ci < chunks.length) throw new Error('keys stream ended early (' + ci + '/' + chunks.length + ')');
  } catch (err) {
    if (gen === loadGen) console.error('keys stream failed:', err);
  }
}

// ensureChunk queues a delta fetch for chunk i unless one is already underway
// (or the chunk has no delta frames). urgent requests jump the queue (playhead
// beats the background downloader).
function ensureChunk(i, opts) {
  if (!data || i < 0 || i >= data.chunks.length) return;
  if (chunkState[i] >= 3) return;
  if (data.chunks[i].len === 0) { // single-frame chunk: the keyframe is everything
    chunkState[i] = Math.max(chunkState[i], 3);
    return;
  }
  chunkState[i] = 3;
  if (opts && opts.urgent) fetchQueue.unshift(i); else fetchQueue.push(i);
  pumpFetches();
}

function pumpFetches() {
  while (inflight < MAX_INFLIGHT && fetchQueue.length) {
    const i = fetchQueue.shift();
    if (chunkState[i] >= 4) continue;
    inflight++;
    fetchChunk(i);
  }
}

// applyDeltas decodes chunk i's gunzipped delta bytes seeded with its
// keyframe and fills the chunk's remaining frames.
function applyDeltas(i, raw) {
  const frames = decodeFrames(raw, keyFrames[i]);
  const base = chunkStartIdx[i];
  for (let k = 0; k < frames.length; k++) data.frames[base + 1 + k] = frames[k];
  chunkState[i] = 4;
}

async function fetchChunk(i) {
  const gen = loadGen;
  try {
    const r = await fetch('/replays/' + encodeURIComponent(currentFile) + '/c' + i);
    if (!r.ok) throw new Error(await r.text());
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (gen !== loadGen) return; // a different replay was loaded meanwhile
    const raw = await gunzipU8(bytes);
    if (gen !== loadGen) return;
    if (keyFrames[i]) {
      applyDeltas(i, raw);
    } else {
      // The keys stream hasn't reached this chunk yet; it will apply these.
      pendingDelta[i] = raw;
    }
  } catch (err) {
    if (gen !== loadGen) return;
    chunkState[i] = keyFrames[i] ? 2 : 0; // allow a retry on the next ensure
    console.error('chunk ' + i + ' failed:', err);
  } finally {
    if (gen === loadGen) {
      inflight--;
      pumpFetches();
      pumpBackground();
    }
  }
  if (gen === loadGen) onChunkArrived(i);
}

// pumpBackground keeps the sequential full download going whenever the fetch
// slots are otherwise idle — this is what makes the whole replay "arrive
// gradually" while the user is already watching.
function pumpBackground() {
  if (!data || fetchQueue.length || inflight >= MAX_INFLIGHT) return;
  for (let i = 0; i < data.chunks.length; i++) {
    if (chunkState[i] < 3) { ensureChunk(i); return; }
  }
}

// onChunkArrived refreshes whatever was waiting on chunk i.
function onChunkArrived(i) {
  if (!data) return;
  updateBuffBar();
  const c = chunkOf(idx);
  if (i === c || i === c + 1) {
    // The playhead's chunk (or its interpolation neighbour) landed: recompute
    // the displayed frame and redraw. setPlayhead also restarts a stalled
    // play loop's frame advance naturally (the RAF keeps ticking).
    setPlayhead(playPos, true);
  }
}

// updateBuffBar shades the loaded ranges under the timeline slider
// (video-player style): solid for full chunks, dim for keyframe-only.
function updateBuffBar() {
  const bar = document.getElementById('buffbar');
  if (!bar || !data || !data.frameCount) return;
  const total = data.frameCount;
  const stops = ['transparent 0%'];
  for (let i = 0; i < data.chunks.length; i++) {
    // Dark = keyframe available (scrubbable), light = fully loaded. A delta
    // request in flight (state 3) with no keyframe yet shows nothing.
    if (chunkState[i] < 4 && !keyFrames[i]) continue;
    const a = (chunkStartIdx[i] / total * 100).toFixed(2) + '%';
    const b = ((chunkStartIdx[i] + data.chunks[i].count) / total * 100).toFixed(2) + '%';
    const col = chunkState[i] >= 4 ? '#5a9fd0' : '#3a5568';
    stops.push(`transparent ${a}`, `${col} ${a}`, `${col} ${b}`, `transparent ${b}`);
  }
  stops.push('transparent 100%');
  bar.style.background = `linear-gradient(to right, ${stops.join(', ')})`;
}

// Per-interval lookup: unit id -> base index of that unit in the NEXT sampled
// frame. Lets movement be animated toward each unit's actual next position
// (direction) at the speed implied by its velocity (magnitude). Rebuilt whenever
// the integer keyframe changes. nextU is that next frame's unit array (frames
// stream in chunk by chunk, so it may simply not be here yet — interpolation
// then falls back to velocity extrapolation).
let nextPosMap = null;
let nextU = null;
function buildNextPosMap() {
  nextPosMap = new Map();
  nextU = null;
  const nf = data && data.frames[dispIdx + 1];
  if (!nf) return;
  nextU = nf.u;
  for (let j = 0; j < nextU.length; j += STRIDE) nextPosMap.set(nextU[j + F.ID], j);
}

// Tangent length cap (as a multiple of the straight-line distance between the two
// samples) for the Hermite curve below — keeps a wildly-inconsistent velocity from
// bending the path into a big loop or bulge.
const TANGENT_CAP = 2;

// Interpolated world [x, z] of unit i in the current frame array u, via a cubic
// Hermite spline between this sample (P0) and the unit's next sample (P1), using
// each end's velocity as the tangent: the unit leaves P0 at its frame-A velocity
// and arrives at P1 at its frame-B velocity, so motion curves naturally and is C1
// continuous across samples (no kink at the boundary). dvx/dvz are the velocity
// displacement over one interval — the exact Hermite tangents for t in [0,1].
// Constant-velocity motion reduces to a straight line. Stationary units (zero
// current velocity) and on-keyframe renders return the sampled position unchanged.
//
// Returns a shared scratch array (valid only until the next call): this runs for
// every unit on every animation frame, and allocating a fresh [x, z] per unit was
// a measurable GC load during playback.
const _pos = [0, 0];
function interpPos(u, i) {
  const bx = u[i + F.X], bz = u[i + F.Z];              // P0
  _pos[0] = bx; _pos[1] = bz;
  if (renderFrac === 0) return _pos;
  const m0x = u[i + F.DVX], m0z = u[i + F.DVZ];        // tangent at A (frame-A velocity)
  if (m0x === 0 && m0z === 0) return _pos;             // zero velocity: stationary, don't animate
  const j = nextPosMap ? nextPosMap.get(u[i + F.ID]) : undefined;
  if (j === undefined || !nextU) {
    // No next sample (unit gone, or that frame not streamed in yet): fall back
    // to velocity extrapolation.
    _pos[0] = bx + m0x * renderFrac; _pos[1] = bz + m0z * renderFrac;
    return _pos;
  }
  const nu = nextU;
  const px = nu[j + F.X], pz = nu[j + F.Z];            // P1
  const chord = Math.hypot(px - bx, pz - bz);
  if (chord === 0) return _pos;                        // same position in both samples
  const cap = TANGENT_CAP * chord;
  let a0x = m0x, a0z = m0z;                            // tangents, length-capped in place
  let m = Math.hypot(a0x, a0z);
  if (m > cap) { const s = cap / m; a0x *= s; a0z *= s; }
  let a1x = nu[j + F.DVX], a1z = nu[j + F.DVZ];        // tangent at B (frame-B velocity)
  m = Math.hypot(a1x, a1z);
  if (m > cap) { const s = cap / m; a1x *= s; a1z *= s; }
  const t = renderFrac, t2 = t * t, t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
  _pos[0] = h00 * bx + h10 * a0x + h01 * px + h11 * a1x;
  _pos[1] = h00 * bz + h10 * a0z + h01 * pz + h11 * a1z;
  return _pos;
}

const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
const tooltip = document.getElementById('tooltip');
const emptyEl = document.getElementById('empty');

let data = null;            // loaded head (+ sparse frames array)
let idx = 0;               // current frame index (may not be loaded yet)
let dispIdx = -1;          // frame actually rendered: idx when loaded, else the
                           // chunk keyframe / last shown frame while buffering
let scrubTimer = null;     // dwell timer upgrading a skimmed chunk to a full fetch
let scale = 1;             // world->screen px per elmo
let center = { x: 0, z: 0 };// world point at viewport centre
let teamColor = {};        // team id -> css colour
let mouse = null;          // {x,y} canvas px (CSS px) or null
let drag = null;           // pan state or null
let playRAF = null;        // requestAnimationFrame handle while playing
let playLastTs = 0;        // timestamp of the previous animation tick
let playPos = 0;           // continuous playhead in keyframe units (idx = floor)
let renderFrac = 0;        // sub-frame fraction [0,1) within the current interval
let secPerFrame = 1;       // game seconds per keyframe interval (sampleEvery/30)
let showIcons = true;      // draw BAR unit icons (vs plain dots)
let showTexture = true;    // draw the map terrain texture behind everything
let showGrid = false;      // draw the build/small/large grid
let showFootprints = false;// draw build-footprint rectangles for buildings
let growIcons = true;      // grow a building's icon toward its footprint when zoomed in
let autoTeamColors = false; // true: distinct auto colours per team; false: the real in-game team colours from the replay
let mapW = 0, mapH = 0;    // map world extent in elmos (0 if unknown)
let mapTex = null;         // HTMLImageElement of the terrain texture, or null
// Viewport in CSS pixels + the device-pixel ratio. The canvas backing store is
// viewW*DPR x viewH*DPR and the context is pre-scaled by DPR, so all drawing is
// done in CSS px while staying crisp on HiDPI displays.
let viewW = 0, viewH = 0, DPR = 1;

// Icons are drawn at a CONSTANT screen size, independent of zoom — exactly like
// BAR's own minimap icons. Per-unit size = iconScale * the icon type's size
// multiplier (from icontypes.lua: ~0.8 for a mex, ~1.8 for a commander), clamped
// to [ICON_MIN_PX, ICON_MAX_PX]. Because the size is fixed in pixels, icons
// naturally spread apart when you zoom in and overlap when you zoom out.
// iconScale is the base px-per-size-unit, adjustable via the UI slider (and the
// ?iconsize= URL param).
let iconScale = 12;
const ICON_SCALE_MIN = 4, ICON_SCALE_MAX = 60;
const ICON_MIN_PX = 3;
const ICON_MAX_PX = 200;

// imageCache: served icon path -> HTMLImageElement (may still be loading) or
// null once it has failed to load (so we don't retry).
const imageCache = {};
function getImage(path) {
  if (path in imageCache) return imageCache[path];
  const img = new Image();
  img.onload = scheduleDraw;      // redraw once the bitmap arrives
  img.onerror = () => { imageCache[path] = null; };
  img.src = '/' + path;
  imageCache[path] = img;
  return img;
}

// tintCache: "path|color" -> offscreen canvas of the icon tinted to a team
// colour. BAR minimap icons are grayscale luminance masks (bright areas take the
// team colour, dark areas stay black) with an alpha-shaped surround, so we
// MULTIPLY the icon into a team-colour field and then clip to the icon's alpha —
// this keeps the black internal detail instead of flattening to a solid blob.
// Built lazily once the bitmap has loaded; there are only a few icon×team combos.
const tintCache = {};
function tintedIcon(path, color) {
  const key = path + '|' + color;
  const cached = tintCache[key];
  if (cached !== undefined) return cached;
  const img = getImage(path);
  if (!img || !img.complete || !img.naturalWidth) return null; // not ready; retry next draw
  const w = img.naturalWidth, h = img.naturalHeight;
  const oc = document.createElement('canvas');
  oc.width = w; oc.height = h;
  const octx = oc.getContext('2d');
  octx.fillStyle = color;                        // solid team-colour field
  octx.fillRect(0, 0, w, h);
  octx.globalCompositeOperation = 'multiply';    // white->team colour, black->black
  octx.drawImage(img, 0, 0);
  octx.globalCompositeOperation = 'destination-in'; // clip to the icon's own alpha
  octx.drawImage(img, 0, 0);
  tintCache[key] = oc;
  return oc;
}

// Coalesce the many onload-triggered redraws into one per animation frame.
let drawQueued = false;
function scheduleDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; draw(); });
}

// ---- colour assignment ----------------------------------------------------
// Group teams by ally; each ally gets a base hue, teams within it vary in
// lightness so allies read as one colour family but stay distinguishable.
const ALLY_HUES = [210, 5, 135, 45, 275, 190, 320, 95, 20, 165];

function assignColors(teams) {
  const byAlly = {};
  teams.forEach(t => { (byAlly[t.ally] ||= []).push(t); });
  const allies = Object.keys(byAlly).map(Number).sort((a, b) => a - b);
  const colors = {};
  allies.forEach((ally, ai) => {
    const hue = ALLY_HUES[ai % ALLY_HUES.length];
    const members = byAlly[ally].sort((a, b) => a.team - b.team);
    members.forEach((t, ti) => {
      const light = members.length > 1 ? 45 + (ti / (members.length - 1)) * 28 : 58;
      colors[t.team] = `hsl(${hue} 62% ${light}%)`;
    });
  });
  return colors;
}

// computeTeamColors returns the team id -> css colour map used everywhere teams
// are drawn (units, footprints, player/team lists). With autoTeamColors on we use
// the distinct auto-assigned palette (allies share a hue); off, we use each
// team's real in-game colour from the replay JSON, falling back to the auto colour
// for any team that carries none.
function computeTeamColors() {
  const auto = assignColors(data.teams || []);
  if (autoTeamColors) return auto;
  const out = {};
  (data.teams || []).forEach(t => { out[t.team] = t.color || auto[t.team]; });
  for (const id in auto) if (!(id in out)) out[id] = auto[id];
  return out;
}

// teamTint: team id -> [r,g,b] 0..1 floats parsed from the css teamColor — the
// GL renderer needs numeric colours. Rebuilt alongside teamColor.
let teamTint = new Map();
const GRAY_TINT = [0.604, 0.651, 0.698]; // #9aa6b2, the unknown-team colour
const _colorCtx = document.createElement('canvas').getContext('2d');
function cssToTint(css) {
  _colorCtx.fillStyle = '#9aa6b2';
  _colorCtx.fillStyle = css; // the 2D canvas normalises any css colour to #rrggbb
  const s = _colorCtx.fillStyle;
  if (!/^#[0-9a-f]{6}$/.test(s)) return GRAY_TINT;
  return [
    parseInt(s.slice(1, 3), 16) / 255,
    parseInt(s.slice(3, 5), 16) / 255,
    parseInt(s.slice(5, 7), 16) / 255,
  ];
}

// applyTeamColors (re)derives everything that hangs off the team palette.
function applyTeamColors() {
  teamColor = computeTeamColors();
  teamTint = new Map();
  for (const id in teamColor) teamTint.set(+id, cssToTint(teamColor[id]));
  colorGen++;
}

function teamLabel(t) {
  if (t.player) return t.player;
  const side = t.side ? ` (${t.side})` : '';
  return `Team ${t.team}${side}`;
}

// ---- coordinate transforms ------------------------------------------------
function w2s(x, z) {
  return [viewW / 2 + (x - center.x) * scale, viewH / 2 + (z - center.z) * scale];
}
function s2w(sx, sy) {
  return [(sx - viewW / 2) / scale + center.x, (sy - viewH / 2) / scale + center.z];
}

function resize() {
  const r = cv.parentElement.getBoundingClientRect();
  DPR = window.devicePixelRatio || 1;
  viewW = r.width;
  viewH = r.height;
  cv.width = Math.round(viewW * DPR);
  cv.height = Math.round(viewH * DPR);
  cv.style.width = viewW + 'px';
  cv.style.height = viewH + 'px';
  if (glcv) {
    glcv.width = Math.round(viewW * DPR);
    glcv.height = Math.round(viewH * DPR);
    glcv.style.width = viewW + 'px';
    glcv.style.height = viewH + 'px';
  }
  draw();
}
window.addEventListener('resize', resize);

// Fit the whole map extent into the viewport with a margin.
function fitView() {
  const b = data.bounds;
  const w = Math.max(1, b.maxX - b.minX);
  const h = Math.max(1, b.maxZ - b.minZ);
  center = { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 };
  scale = Math.min(viewW / (w * 1.12), viewH / (h * 1.12));
  if (!isFinite(scale) || scale <= 0) scale = 0.1;
}

// Show the current zoom (screen px per world elmo) so it can be referred to.
function updateZoomLabel() {
  const el = document.getElementById('zoomlabel');
  if (!el) return;
  const z = scale >= 1 ? scale.toFixed(2) : scale.toPrecision(2);
  el.textContent = `zoom ${z} px/elmo`;
}

// ---- drawing --------------------------------------------------------------
// With the WebGL icon renderer active, the 2D canvas only carries the BASE
// layer (map, grid, footprints, loading-fallback dots) — static between
// keyframes — while the moving icons live on the GL overlay. baseKey captures
// everything the base layer depends on, so a playback tick where only icons
// moved repaints nothing but the (cheap) GL pass instead of the whole
// viewport. Any 2D-dynamic content (dots mode, no GL, fallback dots) simply
// forces a repaint, preserving the original behaviour.
let lastBaseKey = '';
let colorGen = 0; // bumped when team colours change (baseKey ingredient)

function draw() {
  updateZoomLabel();
  const fr = data && dispIdx >= 0 ? data.frames[dispIdx] : null;
  const u = fr ? fr.u : null;

  // GL icon pass first: it reports which units still need the 2D dot fallback
  // (bitmaps not in the atlas yet), which the base layer below must paint.
  const glActive = !!(glr && showIcons && u);
  let glFallback = null;
  if (glActive) glFallback = glBuildInstances(u);
  if (glr) glRender(glActive);

  const dynamic2D = !glActive || glFallback !== null;
  if (!dynamic2D) {
    const b = data.bounds;
    const key = loadGen + ',' + dispIdx + ',' + scale + ',' + center.x + ',' + center.z + ',' +
      viewW + ',' + viewH + ',' + DPR + ',' + showTexture + ',' + showGrid + ',' + showFootprints + ',' +
      (mapTex && mapTex.complete ? 1 : 0) + ',' + mapW + ',' + mapH + ',' + colorGen + ',' +
      b.minX + ',' + b.maxX;
    if (key === lastBaseKey) { updateTooltip(); return; }
    lastBaseKey = key;
  } else {
    lastBaseKey = '';
  }

  // Draw in CSS px; the DPR scale keeps the backing store at full device res.
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, viewW, viewH);
  if (!data) return;

  drawMapFrame();
  if (!fr) return;

  // Footprints sit under the unit markers.
  if (showFootprints) drawFootprints(u);

  if (showIcons) {
    if (!glActive) drawIcons2D(u);
    else if (glFallback) drawGLFallbackDots(u, glFallback);
  } else {
    drawDots(u);
  }

  updateTooltip();
}

// Fast path: one filled dot per unit, batched by team colour. Used only when the
// icon layer is toggled off.
function drawDots(u) {
  const rad = Math.max(1.6, Math.min(5, scale * 8));
  const byColor = {};
  for (let i = 0; i < u.length; i += STRIDE) {
    const c = teamColor[u[i + F.TEAM]] || '#9aa6b2';
    (byColor[c] ||= []).push(i);
  }
  for (const color in byColor) {
    ctx.fillStyle = color;
    ctx.beginPath();
    for (const i of byColor[color]) {
      const p = interpPos(u, i);
      const sx = viewW / 2 + (p[0] - center.x) * scale;
      const sy = viewH / 2 + (p[1] - center.z) * scale;
      if (sx < -8 || sy < -8 || sx > viewW + 8 || sy > viewH + 8) continue;
      ctx.moveTo(sx + rad, sy);
      ctx.arc(sx, sy, rad, 0, 7);
    }
    ctx.fill();
  }
}

// Primary render: every unit as its BAR icon, tinted to the team colour and
// drawn at a constant screen size (see iconScale). When growIcons is on, a
// building's icon additionally grows to 90% of its footprint once zoomed in far
// enough that that exceeds the constant size — so it fills the footprint instead
// of looking tiny inside it (mobile units, having no footprint, stay constant).
// A unit with no icon (or whose bitmap hasn't loaded yet) shows a coloured dot so
// it is never invisible.
//
// Two implementations: the WebGL instanced renderer (see "WebGL icon renderer"
// below — one GPU atlas texture, one draw call per frame) whenever WebGL2 is
// available, else the original per-unit ctx.drawImage loop. Both share the
// per-draw def memo: an icon's glyph and pixel size are constant per def within
// one draw, so resolving them once per def (instead of once per unit, with a
// per-unit "path|color|px" string key) removes most of the lookup cost.
function drawIcons2D(u) {
  const pxMemo = new Map();     // def -> rounded CSS px this draw
  const glyphMemo = new Map();  // def*4096+team -> canvas or null
  for (let i = 0; i < u.length; i += STRIDE) {
    const def = u[i + F.DEF], team = u[i + F.TEAM];
    let px = pxMemo.get(def);
    if (px === undefined) { px = Math.round(iconPxFor(def)); pxMemo.set(def, px); }
    const r = px / 2;
    const p = interpPos(u, i);
    const sx = viewW / 2 + (p[0] - center.x) * scale;
    const sy = viewH / 2 + (p[1] - center.z) * scale;
    if (sx < -px || sy < -px || sx > viewW + px || sy > viewH + px) continue;
    const color = teamColor[team] || '#9aa6b2';
    const gk = def * 4096 + team;
    let glyph = glyphMemo.get(gk);
    if (glyph === undefined) {
      const info = defIcon.get(def);
      glyph = info ? renderIcon(info.p, color, px) : null;
      glyphMemo.set(gk, glyph);
    }
    if (glyph) {
      // Draw the pre-rendered glyph at its CSS size; snapping the top-left to a
      // device-pixel grid keeps the small icon crisp.
      const dx = Math.round((sx - r) * DPR) / DPR;
      const dy = Math.round((sy - r) * DPR) / DPR;
      ctx.drawImage(glyph, dx, dy, px, px);
    } else {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(sx, sy, Math.max(1.5, r * 0.5), 0, 7);
      ctx.fill();
    }
  }
}

// Per-def render info, resolved ONCE per replay load. The draw loops touch this
// for every unit on every animation frame, and the original two-step lookup
// (unitDefs[def] -> name -> unitIcons[name]) cost two string-hash probes per
// unit per frame — a top self-time entry in profiles of unit-heavy replays.
let defIcon = new Map(); // def id -> {p: path, s: size} or null
let defFp = new Map();   // def id -> {w, h} footprint in elmos, or null (mobile)
function buildDefTables() {
  defIcon = new Map();
  defFp = new Map();
  const defs = data.unitDefs || {};
  for (const id in defs) {
    const name = defs[id];
    defIcon.set(+id, (data.unitIcons && data.unitIcons[name]) || null);
    defFp.set(+id, (data.footprints && data.footprints[name]) || null);
  }
}

// footprintFor returns {w, h} (build-footprint size in elmos) for a unit def, or
// null. Only buildings have an entry (the wire payload omits mobile units), so a
// null result means "don't draw a footprint".
function footprintFor(def) {
  return defFp.get(def) || null;
}

// iconPxFor: the on-screen size (CSS px) a def's icon draws at right now —
// constant per def within one draw (depends only on def, zoom and growIcons).
function iconPxFor(def) {
  const info = defIcon.get(def);
  let px = Math.max(ICON_MIN_PX, Math.min(ICON_MAX_PX, iconScale * (info ? info.s : 1)));
  if (growIcons) {
    const fp = defFp.get(def); // buildings only; null for mobile units
    if (fp) {
      const cap = 0.9 * Math.min(fp.w, fp.h) * scale; // 90% of the smaller footprint side, in px
      if (cap > px) px = cap;                          // zoomed in: grow to fit the footprint
    }
  }
  return px;
}

// Draw each building's build footprint as a team-coloured rectangle centred on
// the unit's position (which is the footprint centre). Unlike icons, footprints
// are drawn in world space, so they scale with zoom. Batched by team colour.
function drawFootprints(u) {
  const byColor = {};
  for (let i = 0; i < u.length; i += STRIDE) {
    if (!footprintFor(u[i + F.DEF])) continue;
    const c = teamColor[u[i + F.TEAM]] || '#9aa6b2';
    (byColor[c] ||= []).push(i);
  }
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.7;
  for (const color in byColor) {
    ctx.strokeStyle = color;
    ctx.beginPath();
    for (const i of byColor[color]) {
      const fp = footprintFor(u[i + F.DEF]);
      const p = interpPos(u, i);
      const [cx, cy] = w2s(p[0], p[1]);
      const wpx = fp.w * scale, hpx = fp.h * scale;
      if (cx + wpx / 2 < 0 || cy + hpx / 2 < 0 || cx - wpx / 2 > viewW || cy - hpx / 2 > viewH) continue;
      ctx.rect(cx - wpx / 2, cy - hpx / 2, wpx, hpx);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

// renderCache: "path|color|devPx" -> offscreen canvas of the tinted icon
// downscaled to the exact device-pixel size it will be drawn at. The 128px BAR
// icons downscaled ~10x with the canvas's default (low-quality) bilinear filter
// smear adjacent detail into blobs; instead we halve repeatedly with
// high-quality smoothing (a mipmap-style box filter) down to the target, which
// keeps features like the two feet-dots distinct. Keyed by device px so HiDPI
// gets a full-res glyph; rebuilt only when the icon size (slider) changes.
const renderCache = {};
function renderIcon(path, color, cssPx) {
  const devPx = Math.max(1, Math.round(cssPx * DPR));
  const key = path + '|' + color + '|' + devPx;
  const cached = renderCache[key];
  if (cached !== undefined) return cached;
  const tint = tintedIcon(path, color);
  if (!tint) return null; // bitmap not loaded yet; retry next draw
  let src = tint;
  while (src.width > devPx * 2) {
    const nw = Math.max(devPx, Math.floor(src.width / 2));
    const nh = Math.max(devPx, Math.floor(src.height / 2));
    src = scaleCanvas(src, nw, nh);
  }
  const out = scaleCanvas(src, devPx, devPx);
  renderCache[key] = out;
  return out;
}

function scaleCanvas(src, w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const cx = c.getContext('2d');
  cx.imageSmoothingEnabled = true;
  cx.imageSmoothingQuality = 'high';
  cx.drawImage(src, 0, 0, w, h);
  return c;
}

// ---- WebGL icon renderer ----------------------------------------------------
// The icon layer is the playback hot path (every unit, every animation frame),
// and the 2D-canvas version pays a per-unit ctx.drawImage plus a repaint of the
// whole viewport each tick — the dominant cost on unit-heavy replays. This
// renderer does what a game engine does instead: every icon bitmap lives in ONE
// grayscale atlas texture in GPU memory (uploaded when the bitmaps arrive, then
// never again), and each frame only ships a small per-unit instance buffer
// [center, size, uv rect, tint] and issues a single instanced draw call. Team
// tinting happens in the fragment shader (rgb * tint, icon's own alpha) — the
// same multiply + destination-in composite the 2D path bakes into per-team
// glyph canvases, so no per-team pixels exist at all. Icons render on the
// transparent overlay canvas #glcv above the 2D base layer (map / grid /
// footprints), matching the old single-canvas draw order. If WebGL2 is missing
// or the context is lost, everything falls back to the 2D path unchanged.

const glcv = document.getElementById('glcv');
let glr = null; // GL state, or null -> 2D fallback path

const ATLAS_SIZE = 2048; // px; power of two so the mip chain is clean
const ATLAS_PAD = 16;    // gap between packed icons: keeps mip levels 0-4 from bleeding
const INST_FLOATS = 10;  // per instance: cx cy size u0 v0 u1 v1 r g b

function initGL() {
  if (!glcv || glr) return;
  // ?gl=0 forces the 2D path, ?gl=1 forces WebGL even on a software renderer
  // (by default a software GL like SwiftShader is refused: its frames reach the
  // compositor through a pixel readback, which is slower than the 2D path).
  const pref = new URLSearchParams(location.search).get('gl');
  if (pref === '0') { console.info('WebGL icon renderer disabled by ?gl=0'); return; }
  let gl = null;
  try { gl = glcv.getContext('webgl2', { antialias: false, premultipliedAlpha: true }); } catch (_) { /* fall through */ }
  if (!gl) { console.info('WebGL2 unavailable — icons render via the 2D canvas path'); return; }
  if (pref !== '1') {
    let renderer = '';
    try {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      renderer = String(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
    } catch (_) { /* renderer string stays unknown */ }
    if (/swiftshader|software|llvmpipe/i.test(renderer)) {
      console.info('software WebGL renderer (' + renderer + ') — using the 2D canvas path (?gl=1 overrides)');
      return;
    }
  }

  const vs = `#version 300 es
layout(location=0) in vec2 corner;   // unit quad, -0.5..0.5
layout(location=1) in vec2 center;   // instance: icon centre, device px
layout(location=2) in float size;    // instance: icon size, device px
layout(location=3) in vec4 uvRect;   // instance: atlas u0 v0 u1 v1
layout(location=4) in vec3 tint;     // instance: team colour
uniform vec2 viewSize;               // canvas size, device px
out vec2 uv;
out vec3 vTint;
void main() {
  vec2 p = center + corner * size;
  gl_Position = vec4(p.x / viewSize.x * 2.0 - 1.0, 1.0 - p.y / viewSize.y * 2.0, 0.0, 1.0);
  uv = mix(uvRect.xy, uvRect.zw, corner + 0.5);
  vTint = tint;
}`;
  const fs = `#version 300 es
precision mediump float;
in vec2 uv;
in vec3 vTint;
uniform sampler2D tex;
out vec4 o;
void main() {
  vec4 t = texture(tex, uv);
  o = vec4(t.rgb * vTint, t.a); // atlas is premultiplied: rgb already carries alpha
}`;

  let prog;
  try {
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, vs));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  } catch (err) {
    console.warn('WebGL icon renderer failed to initialise; using the 2D canvas path:', err);
    return;
  }

  // One static unit quad, instanced per icon; the instance buffer is refilled
  // every frame (interleaved, INST_FLOATS floats per icon).
  const quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW);
  const instBuf = gl.createBuffer();
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
  const stride = INST_FLOATS * 4;
  const attr = (loc, n, off) => {
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, n, gl.FLOAT, false, stride, off * 4);
    gl.vertexAttribDivisor(loc, 1);
  };
  attr(1, 2, 0); attr(2, 1, 2); attr(3, 4, 3); attr(4, 3, 7);
  gl.bindVertexArray(null);

  const ac = document.createElement('canvas');
  ac.width = ac.height = ATLAS_SIZE;
  const atlas = {
    canvas: ac,
    ctx: ac.getContext('2d'),
    tex: gl.createTexture(),
    slots: new Map(), // icon path -> {u0,v0,u1,v1}, or null (load failed / atlas full)
    x: ATLAS_PAD, y: ATLAS_PAD, rowH: 0,
    dirty: false,
    full: false,
  };
  gl.bindTexture(gl.TEXTURE_2D, atlas.tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  // Icons rarely draw below ~8 device px, so mips past level 4 (1/16 size) are
  // never sampled; capping the chain also caps cross-icon bleed to the pad.
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 4);

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); // premultiplied-alpha source-over

  glr = {
    gl, prog, vao, instBuf, atlas,
    uView: gl.getUniformLocation(prog, 'viewSize'),
    inst: new Float32Array(4096 * INST_FLOATS),
    n: 0,
  };
  console.info('WebGL icon renderer active');
}

if (glcv) {
  glcv.addEventListener('webglcontextlost', e => {
    e.preventDefault(); // allow restore
    glr = null;         // 2D fallback takes over on the next draw
    scheduleDraw();
  });
  glcv.addEventListener('webglcontextrestored', () => { initGL(); scheduleDraw(); });
}

// atlasSlot returns the atlas uv rect for an icon path: undefined while the
// bitmap is still loading (the caller falls back to a dot, exactly like the 2D
// path), null if it can never be packed (load failed, or the atlas is full).
// Icons pack at their native bitmap size on a simple shelf layout; the atlas
// canvas re-uploads (with fresh mipmaps) on the draw after new icons land —
// a handful of times right after load, then never again.
function atlasSlot(path) {
  const a = glr.atlas;
  let s = a.slots.get(path);
  if (s !== undefined) return s;
  const img = getImage(path);
  if (img === null) { a.slots.set(path, null); return null; }
  if (!img.complete || !img.naturalWidth) return undefined;
  const w = img.naturalWidth, h = img.naturalHeight;
  if (a.x + w + ATLAS_PAD > ATLAS_SIZE) { a.x = ATLAS_PAD; a.y += a.rowH + ATLAS_PAD; a.rowH = 0; }
  if (a.y + h + ATLAS_PAD > ATLAS_SIZE || w + 2 * ATLAS_PAD > ATLAS_SIZE) {
    if (!a.full) { a.full = true; console.warn('icon atlas full; overflow icons draw as dots'); }
    a.slots.set(path, null);
    return null;
  }
  a.ctx.drawImage(img, a.x, a.y);
  s = { u0: a.x / ATLAS_SIZE, v0: a.y / ATLAS_SIZE, u1: (a.x + w) / ATLAS_SIZE, v1: (a.y + h) / ATLAS_SIZE };
  a.x += w + ATLAS_PAD;
  if (h > a.rowH) a.rowH = h;
  a.slots.set(path, s);
  a.dirty = true;
  return s;
}

function uploadAtlas() {
  const gl = glr.gl, a = glr.atlas;
  gl.bindTexture(gl.TEXTURE_2D, a.tex);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, a.canvas);
  gl.generateMipmap(gl.TEXTURE_2D);
  a.dirty = false;
}

// glBuildInstances fills the instance buffer for one frame. Returns the units
// that still need the 2D dot fallback (bitmap not in the atlas yet) as a flat
// [unitBase, sx, sy, px] list, or null when every unit had an atlas glyph.
function glBuildInstances(u) {
  const memo = new Map(); // def -> {px, rect}; both constant per def per draw
  let inst = glr.inst;
  const needed = (u.length / STRIDE) * INST_FLOATS;
  if (inst.length < needed) inst = glr.inst = new Float32Array(needed * 2);
  let n = 0;
  let fb = null;
  for (let i = 0; i < u.length; i += STRIDE) {
    const def = u[i + F.DEF];
    let m = memo.get(def);
    if (m === undefined) {
      const info = defIcon.get(def);
      m = { px: iconPxFor(def), rect: info ? atlasSlot(info.p) : null };
      memo.set(def, m);
    }
    const px = m.px;
    const p = interpPos(u, i);
    const sx = viewW / 2 + (p[0] - center.x) * scale;
    const sy = viewH / 2 + (p[1] - center.z) * scale;
    if (sx < -px || sy < -px || sx > viewW + px || sy > viewH + px) continue;
    const rect = m.rect;
    if (!rect) { (fb ||= []).push(i, sx, sy, px); continue; }
    const tint = teamTint.get(u[i + F.TEAM]) || GRAY_TINT;
    const o = n * INST_FLOATS;
    inst[o] = sx * DPR; inst[o + 1] = sy * DPR; inst[o + 2] = px * DPR;
    inst[o + 3] = rect.u0; inst[o + 4] = rect.v0; inst[o + 5] = rect.u1; inst[o + 6] = rect.v1;
    inst[o + 7] = tint[0]; inst[o + 8] = tint[1]; inst[o + 9] = tint[2];
    n++;
  }
  glr.n = n;
  return fb;
}

// glRender draws the built instances — or just clears the overlay when the GL
// icon pass is off this frame (dots mode, icons hidden, no data yet).
function glRender(active) {
  const gl = glr.gl;
  gl.viewport(0, 0, glcv.width, glcv.height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  if (!active || !glr.n) return;
  if (glr.atlas.dirty) uploadAtlas();
  gl.useProgram(glr.prog);
  gl.uniform2f(glr.uView, glcv.width, glcv.height);
  gl.bindTexture(gl.TEXTURE_2D, glr.atlas.tex);
  gl.bindVertexArray(glr.vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, glr.instBuf);
  gl.bufferData(gl.ARRAY_BUFFER, glr.inst.subarray(0, glr.n * INST_FLOATS), gl.DYNAMIC_DRAW);
  gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, glr.n);
  gl.bindVertexArray(null);
}

// The 2D dot pass for units the GL renderer couldn't draw yet (their icon
// bitmap is still loading). Transient: a second later they're in the atlas.
function drawGLFallbackDots(u, fb) {
  for (let k = 0; k < fb.length; k += 4) {
    const i = fb[k], sx = fb[k + 1], sy = fb[k + 2], r = fb[k + 3] / 2;
    ctx.fillStyle = teamColor[u[i + F.TEAM]] || '#9aa6b2';
    ctx.beginPath();
    ctx.arc(sx, sy, Math.max(1.5, r * 0.5), 0, 7);
    ctx.fill();
  }
}

// The rendered field: the full map extent when its size is known (so the terrain
// texture and grid cover the real map), otherwise just the unit bounds.
function fieldRect() {
  if (mapW > 0 && mapH > 0) return { minX: 0, minZ: 0, maxX: mapW, maxZ: mapH };
  return data.bounds;
}

// Map terrain (or a plain fill) + the build grid so panning/zoom has reference.
function drawMapFrame() {
  const b = fieldRect();
  const [x0, y0] = w2s(b.minX, b.minZ);
  const [x1, y1] = w2s(b.maxX, b.maxZ);
  if (showTexture && mapTex && mapTex.complete && mapTex.naturalWidth) {
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(mapTex, x0, y0, x1 - x0, y1 - y0);
  } else {
    ctx.fillStyle = '#0e1319';
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  }

  // Two-tier reference grid, aligned to the world origin (where BAR buildings
  // snap on the 16-elmo build grid):
  //   small square = 48 elmos  = 3x3 build squares
  //   large square = 192 elmos = 4x4 small squares (= 3x3 metal makers, each 4x4 build)
  // Each tier only draws when its on-screen spacing is legible, and the large tier
  // is bolder, so a zoomed-out view shows just the large grid and the small grid
  // appears on zoom. Semi-transparent white so lines read over both the dark
  // fallback and the terrain texture.
  if (showGrid) {
    const SMALL = 48;
    drawGrid(b, x0, y0, x1, y1, SMALL, 'rgba(255,255,255,0.10)');       // small square (48)
    drawGrid(b, x0, y0, x1, y1, SMALL * 4, 'rgba(255,255,255,0.20)');   // large square (192) = 4x4 small
  }

  ctx.strokeStyle = '#2d3a47';
  ctx.lineWidth = 1;
  ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
}

// drawGrid strokes world-aligned grid lines at `step` elmos within the bounds
// rect, skipping when the on-screen spacing would be too dense to read.
function drawGrid(b, x0, y0, x1, y1, step, color) {
  if (scale * step < 6) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let gx = Math.ceil(b.minX / step) * step; gx <= b.maxX; gx += step) {
    const [sx] = w2s(gx, b.minZ);
    ctx.moveTo(sx, y0); ctx.lineTo(sx, y1);
  }
  for (let gz = Math.ceil(b.minZ / step) * step; gz <= b.maxZ; gz += step) {
    const [, sy] = w2s(b.minX, gz);
    ctx.moveTo(x0, sy); ctx.lineTo(x1, sy);
  }
  ctx.stroke();
}

// ---- hit testing / tooltip ------------------------------------------------
function hitTest() {
  if (!mouse || !data || dispIdx < 0) return null;
  const fr = data.frames[dispIdx];
  if (!fr) return null;
  const u = fr.u;
  let best = -1, bestD = 10 * 10; // 10px pick radius (squared)
  for (let i = 0; i < u.length; i += STRIDE) {
    const p = interpPos(u, i);
    const sx = viewW / 2 + (p[0] - center.x) * scale;
    const sy = viewH / 2 + (p[1] - center.z) * scale;
    const dx = sx - mouse.x, dy = sy - mouse.y;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

function defName(def) {
  return (data.unitDefs && data.unitDefs[def]) || `def ${def}`;
}

function updateTooltip() {
  if (!mouse || drag) { tooltip.style.display = 'none'; return; }
  const i = hitTest();
  if (i === null || i < 0) { tooltip.style.display = 'none'; return; }
  const u = data.frames[dispIdx].u;
  const team = u[i + F.TEAM];
  const hp = u[i + F.HP], maxHp = u[i + F.MAXHP];
  const frac = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 1;
  const col = frac > 0.5 ? '#6fd07f' : (frac > 0.25 ? '#f2cf5b' : '#e2785b');
  tooltip.innerHTML =
    `<h3>${defName(u[i + F.DEF])}</h3>` +
    `<div class="row"><span class="label">Unit</span><span>#${u[i + F.ID]}</span></div>` +
    `<div class="row"><span class="label">Team</span><span style="color:${teamColor[team] || '#fff'}">${teamNameById(team)}</span></div>` +
    `<div class="row"><span class="label">Position</span><span>${u[i + F.X]}, ${u[i + F.Z]}</span></div>` +
    (maxHp > 0
      ? `<div class="row"><span class="label">Health</span><span>${hp} / ${maxHp}</span></div>` +
        `<div class="bar"><div style="width:${(frac * 100).toFixed(0)}%;background:${col}"></div></div>`
      : '');
  tooltip.style.display = 'block';
  const parent = cv.parentElement.getBoundingClientRect();
  let px = mouse.x + 14, py = mouse.y + 14;
  tooltip.style.left = px + 'px';
  tooltip.style.top = py + 'px';
  const tr = tooltip.getBoundingClientRect();
  if (tr.right > parent.right) tooltip.style.left = (mouse.x - tr.width - 14) + 'px';
  if (tr.bottom > parent.bottom) tooltip.style.top = (mouse.y - tr.height - 14) + 'px';
}

function teamNameById(id) {
  const t = (data.teams || []).find(t => t.team === id);
  return t ? teamLabel(t) : `Team ${id}`;
}

// ---- sidebar --------------------------------------------------------------

// Resource stride in the /api/replay/resources records (see wire.go
// resourceStride): [team, metal, energy, metalStore, energyStore, metalIncome,
// energyIncome].
const RSTRIDE = 7;
const R = { TEAM: 0, METAL: 1, ENERGY: 2, MSTORE: 3, ESTORE: 4, MINC: 5, EINC: 6 };

// resByFrame maps a sim frame number -> its flat per-team economy array (stride
// RSTRIDE). Team economy lives in the .brp X stream, which the frame chunk path
// never fetches, so the player list pulls the whole (small) timeline once from
// /api/replay/resources. Null until that fetch lands.
let resByFrame = null;

// loadResources fetches the economy timeline for the current replay and keys it
// by sim frame, then refreshes the sidebar so the bars fill in. Best-effort: a
// failure (or a capture with no resources) just leaves the bars off.
async function loadResources(file, gen) {
  resByFrame = null;
  try {
    const r = await fetch('/replays/' + encodeURIComponent(file) + '.resources');
    if (!r.ok) return;
    const arr = await r.json(); // [{f, r:[...]}]
    if (gen !== loadGen) return; // a newer replay load superseded this one
    const m = new Map();
    for (const e of arr) m.set(e.f, e.r);
    resByFrame = m;
    if (data) updateSidebar();
  } catch (_) { /* offline / no resources: bars simply stay empty */ }
}

// resourcesByTeam builds team id -> economy object for one sim frame, from the
// fetched timeline. Returns {} until the timeline has loaded or when the frame
// carries no economy.
function resourcesByTeam(simFrame) {
  const out = {};
  const r = resByFrame && resByFrame.get(simFrame);
  if (!r) return out;
  for (let i = 0; i < r.length; i += RSTRIDE) {
    out[r[i + R.TEAM]] = {
      metal: r[i + R.METAL], energy: r[i + R.ENERGY],
      mStore: r[i + R.MSTORE], eStore: r[i + R.ESTORE],
      mInc: r[i + R.MINC], eInc: r[i + R.EINC],
    };
  }
  return out;
}

// Two-letter ISO country code -> flag emoji (regional-indicator pair). Returns ''
// for a missing/malformed code so the row simply has no flag.
function flagEmoji(cc) {
  if (!/^[a-zA-Z]{2}$/.test(cc || '')) return '';
  const base = 0x1F1E6, A = 65;
  const u = cc.toUpperCase();
  return String.fromCodePoint(base + u.charCodeAt(0) - A, base + u.charCodeAt(1) - A);
}

// Rank badge: BAR's chevron/star icon for a player's rank. Rank levels 0..7 map
// to /ranks/1.png../ranks/8.png (BAR's own numbering). Spectators and out-of-range
// values get an empty placeholder span so the column still aligns.
function rankBadge(p) {
  const r = p.rank || 0;
  if (p.spec || r < 0 || r > 7) return '<span class="rank"></span>';
  return `<img class="rank" src="/ranks/${r + 1}.png" alt="rank ${r}" title="Rank ${r}">`;
}

// Compact resource number in BAR's HUD style: 314, 1.06k, 85k, 1.2M.
function fmtNum(n) {
  n = Math.round(n);
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (a >= 1e4) return Math.round(n / 1e3) + 'k';
  if (a >= 1e3) return (n / 1e3).toFixed(2).replace(/\.?0+$/, '') + 'k';
  return String(n);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Player list: rank, flag, OS (skill), name — then per-resource storage bars and
// income/s — grouped by ally team. Economy comes from the current frame's per-team
// resources (a player controls one team). Spectators have no economy and are
// listed dimmed at the end. Player-leaving isn't tracked yet, so everyone shows
// for the whole replay.
function renderPlayers() {
  const root = document.getElementById('players');
  root.innerHTML = '';
  const players = data.players || [];
  if (!players.length) {
    root.innerHTML = '<div class="hint">no player roster in this capture</div>';
    return;
  }
  const fr = dispIdx >= 0 ? data.frames[dispIdx] : null;
  const res = resourcesByTeam(fr ? fr.f : -1);
  const allyOf = {};
  (data.teams || []).forEach(t => { allyOf[t.team] = t.ally; });

  const playing = players.filter(p => !p.spec);
  const specs = players.filter(p => p.spec);

  // Group by ally; within an ally sort by skill (desc), then team.
  playing.sort((a, b) =>
    (allyOf[a.team] ?? 999) - (allyOf[b.team] ?? 999) ||
    (b.skill || 0) - (a.skill || 0) ||
    a.team - b.team);

  let lastAlly, group = null;
  playing.forEach(p => {
    const ally = allyOf[p.team];
    if (ally !== lastAlly) {
      group = document.createElement('div');
      group.className = 'pgroup';
      root.appendChild(group);
      lastAlly = ally;
    }
    group.appendChild(playerRow(p, res[p.team]));
  });

  if (specs.length) {
    const g = document.createElement('div');
    g.className = 'pgroup';
    g.innerHTML = `<div class="hint">Spectators ${specs.length}: ` +
      specs.map(s => escapeHtml(s.name)).join(', ') + '</div>';
    root.appendChild(g);
  }
}

function playerRow(p, r) {
  const row = document.createElement('div');
  row.className = 'prow';
  const color = teamColor[p.team] || '#c7d0d9';
  const rank = rankBadge(p);
  const flag = `<span class="flag">${flagEmoji(p.country)}</span>`;
  const os = `<span class="os">${p.skill ? p.skill.toFixed(1) : ''}</span>`;
  let html =
    `<div class="phead">${rank}${flag}${os}` +
    `<span class="pname" style="color:${color}">${escapeHtml(p.name)}</span></div>`;
  if (r) {
    html += '<div class="pres">' +
      resBar('metal', r.metal, r.mStore, r.mInc) +
      resBar('energy', r.energy, r.eStore, r.eInc) +
      '</div>';
  }
  row.innerHTML = html;
  return row;
}

// One resource line: a storage-fill bar (current / storage), the current amount,
// and the per-second income.
function resBar(kind, cur, store, inc) {
  const frac = store > 0 ? Math.max(0, Math.min(1, cur / store)) : 0;
  const incStr = (inc >= 0 ? '+' : '') + fmtNum(inc);
  return `<div class="resrow ${kind}">` +
    `<div class="rbar"><div style="width:${(frac * 100).toFixed(0)}%"></div></div>` +
    `<span class="rval">${fmtNum(cur)}</span>` +
    `<span class="rinc">${incStr}/s</span>` +
    '</div>';
}

function renderTeams() {
  const root = document.getElementById('teams');
  root.innerHTML = '';
  const counts = {};
  const fr = dispIdx >= 0 ? data.frames[dispIdx] : null;
  if (fr) for (let i = 0; i < fr.u.length; i += STRIDE) {
    const t = fr.u[i + F.TEAM];
    counts[t] = (counts[t] || 0) + 1;
  }
  const teams = (data.teams || []).slice().sort((a, b) => a.ally - b.ally || a.team - b.team);
  teams.forEach(t => {
    const row = document.createElement('div');
    row.className = 'teamrow';
    row.innerHTML =
      `<span class="sw" style="background:${teamColor[t.team]}"></span>` +
      `<span class="nm">${teamLabel(t)}</span>` +
      `<span class="ct">${counts[t.team] || 0}</span>`;
    root.appendChild(row);
  });
}

// Show the most recent lifecycle events up to the current sim frame.
function renderEvents() {
  const ul = document.getElementById('events');
  ul.innerHTML = '';
  const evs = data.events || [];
  const simFrame = frameNumAt(idx); // derived from the index: works while buffering
  const recent = [];
  for (let i = evs.length - 1; i >= 0 && recent.length < 40; i--) {
    if (evs[i].f <= simFrame) recent.push(evs[i]);
  }
  recent.forEach(e => {
    const li = document.createElement('li');
    li.className = e.k;
    const t = fmtTime(e.f / 30);
    const verb = { created: '+', finished: '✓', destroyed: '×' }[e.k] || '·';
    li.textContent = `${t}  ${verb} ${defName(e.def)} #${e.id}`;
    ul.appendChild(li);
  });
  if (!recent.length) ul.innerHTML = '<li style="color:#5a6875">none yet</li>';
}

// ---- playback -------------------------------------------------------------
function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// The heavy sidebar (per-team counts + event feed) only depends on the integer
// keyframe, so it refreshes when idx changes, not every animation tick.
function updateSidebar() {
  const fr = dispIdx >= 0 ? data.frames[dispIdx] : null;
  document.getElementById('s_time').textContent = fr ? fmtTime(fr.t) : '—';
  document.getElementById('s_frame').textContent = fr ? fr.f : '—';
  document.getElementById('s_units').textContent = fr ? fr.n : '—';
  renderPlayers();
  renderTeams();
  renderEvents();
}

let lastTimeText = null; // skip the DOM writes below when nothing changed:
let lastSliderIdx = -1;  // they run every animation tick and cost style/layout
function updateTimeLabel() {
  const last = data.frameCount - 1;
  // Time derives from the index (uniform sampling), so the label tracks the
  // slider even before the frame has streamed in.
  const t = frameNumAt(idx) / 30 + renderFrac * secPerFrame;
  const text = data.frameCount ? `${fmtTime(t)}   frame ${idx} / ${last}` : '—';
  if (text !== lastTimeText) {
    lastTimeText = text;
    document.getElementById('timelabel').textContent = text;
  }
  if (idx !== lastSliderIdx) {
    lastSliderIdx = idx;
    document.getElementById('slider').value = idx;
  }
}

// resolveDisplay picks the frame to render for the current idx: the exact
// frame when its chunk has streamed in, else the chunk's keyframe (fetched
// cheaply while skimming), else whatever was shown last. Interpolation only
// runs on the exact frame.
function resolveDisplay() {
  if (!data || !data.frameCount) { dispIdx = -1; return; }
  const prev = dispIdx;
  if (data.frames[idx]) {
    dispIdx = idx;
  } else {
    const ks = chunkStartIdx[chunkOf(idx)];
    if (data.frames[ks]) dispIdx = ks;
    else if (!(prev >= 0 && data.frames[prev])) dispIdx = -1;
    renderFrac = 0; // no interpolation on a stand-in frame
  }
  const buffering = dispIdx !== idx;
  const el = document.getElementById('buffering');
  if (el) el.style.display = buffering ? '' : 'none';
}

// Move the continuous playhead (in keyframe units). idx = floor(playPos) is the
// current sampled frame; renderFrac is the fraction into the interval to the next
// one, which the draw helpers (ux/uz) use to interpolate unit movement.
// Deciding WHAT to fetch is the caller's job: the play loop streams full
// chunks ahead, scrubbing skims keyframes — setPlayhead itself must stay
// fetch-free because it runs on every animation tick and slider move.
// The sidebar rebuild (innerHTML for players/teams/events) is throttled while
// playing: at 16x+ speed the keyframe changes many times a second, and
// rebuilding that DOM each time caused parse/style/layout work that competed
// with the draw for the frame budget. Paused/scrubbing updates stay immediate.
const SIDEBAR_MIN_MS = 200;
let sidebarAt = 0;        // performance.now() of the last rebuild
let sidebarStale = false; // a throttled-away update is pending
function maybeUpdateSidebar(force) {
  const now = performance.now();
  if (!force && playRAF && now - sidebarAt < SIDEBAR_MIN_MS) { sidebarStale = true; return; }
  sidebarAt = now;
  sidebarStale = false;
  updateSidebar();
}

function setPlayhead(pos, forceSidebar) {
  const last = data.frameCount - 1;
  playPos = Math.max(0, Math.min(last, pos));
  const newIdx = Math.floor(playPos + 1e-6);
  renderFrac = Math.max(0, playPos - newIdx);
  const changed = newIdx !== idx || forceSidebar;
  idx = newIdx;
  resolveDisplay();
  if (changed) { maybeUpdateSidebar(forceSidebar); buildNextPosMap(); }
  updateTimeLabel();
  draw();
}

function show() { setPlayhead(idx, true); } // full refresh at the current keyframe

// Jump to a whole keyframe (stepping / scrubbing): no interpolation. The
// chunk's keyframe is (almost always) already decoded from the .keys stream,
// so the map keeps up with the slider; the chunk's delta fetch starts once
// the user dwells.
function go(i) {
  const target = Math.round(i);
  if (data && !data.frames[target]) {
    clearTimeout(scrubTimer);
    scrubTimer = setTimeout(() => {
      const c = chunkOf(idx);
      ensureChunk(c, { urgent: true });
      ensureChunk(c + 1);
    }, 250);
  }
  setPlayhead(target, true);
}

function stopPlay() {
  if (playRAF) { cancelAnimationFrame(playRAF); playRAF = null; }
  document.getElementById('play').textContent = '▶ Play';
  // Flush a sidebar update the playback throttle skipped, so the panel matches
  // the frame the playhead stopped on.
  if (sidebarStale && data) maybeUpdateSidebar(true);
}
function startPlay() {
  if (!data || data.frameCount < 2) return;
  const last = data.frameCount - 1;
  if (playPos >= last) setPlayhead(0, true); // restart from the beginning at the end
  playLastTs = 0;
  document.getElementById('play').textContent = '⏸ Pause';
  const tick = (ts) => {
    if (!playLastTs) playLastTs = ts;
    // Clamp large gaps (e.g. the tab was backgrounded) so we don't jump.
    const dtReal = Math.min(0.1, (ts - playLastTs) / 1000);
    playLastTs = ts;
    const speed = +document.getElementById('speed').value || 1;
    // 1x = real time: 1 game-second per second. Advance in keyframe units.
    const next = playPos + (dtReal * speed) / secPerFrame;
    if (next >= last) { setPlayhead(last, false); stopPlay(); return; }
    // Keep the pipeline primed: the playhead's chunk plus the next one (the
    // higher the speed, the sooner the boundary arrives — c+1 covers both
    // interpolation and continued playback).
    const c = chunkOf(Math.floor(next));
    ensureChunk(c, { urgent: true });
    ensureChunk(c + 1);
    if (!data.frames[Math.floor(next)]) {
      // The next frame hasn't streamed in yet: hold position (buffering) and
      // keep ticking — playback resumes the moment the chunk decodes.
      playLastTs = ts;
      setPlayhead(playPos, false);
    } else {
      setPlayhead(next, false);
    }
    playRAF = requestAnimationFrame(tick);
  };
  playRAF = requestAnimationFrame(tick);
}
function togglePlay() { playRAF ? stopPlay() : startPlay(); }

// ---- input ----------------------------------------------------------------
cv.addEventListener('mousemove', e => {
  const r = cv.getBoundingClientRect();
  mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
  if (drag) {
    center.x = drag.wx - (e.clientX - drag.cx) / scale;
    center.z = drag.wz - (e.clientY - drag.cy) / scale;
    draw();
  } else {
    updateTooltip();
  }
});
cv.addEventListener('mouseleave', () => { mouse = null; updateTooltip(); });
cv.addEventListener('mousedown', e => {
  if (e.button !== 1) return; // middle button pans
  e.preventDefault();         // suppress the browser's middle-click autoscroll
  drag = { cx: e.clientX, cy: e.clientY, wx: center.x, wz: center.z };
  cv.style.cursor = 'grabbing';
});
// Middle-click also fires auxclick; swallow it so nothing else reacts.
cv.addEventListener('auxclick', e => { if (e.button === 1) e.preventDefault(); });
window.addEventListener('mouseup', () => {
  if (!drag) return;
  drag = null;
  cv.style.cursor = '';
  updateTooltip();
});
cv.addEventListener('wheel', e => {
  e.preventDefault();
  const r = cv.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const [wx, wz] = s2w(mx, my);
  scale = Math.max(0.01, Math.min(40, scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
  center.x = wx - (mx - viewW / 2) / scale;
  center.z = wz - (my - viewH / 2) / scale;
  draw();
}, { passive: false });

document.getElementById('first').onclick = () => { stopPlay(); go(0); };
document.getElementById('prev').onclick = () => { stopPlay(); go(idx - 1); };
document.getElementById('next').onclick = () => { stopPlay(); go(idx + 1); };
document.getElementById('last').onclick = () => { stopPlay(); go(data.frameCount - 1); };
document.getElementById('play').onclick = togglePlay;
// Speed is read live inside the play loop, so a change takes effect immediately.
document.getElementById('speed').onchange = () => {};
document.getElementById('icons').onchange = e => { showIcons = e.target.checked; draw(); };
document.getElementById('maptex').onchange = e => { showTexture = e.target.checked; draw(); };
document.getElementById('grid').onchange = e => { showGrid = e.target.checked; draw(); };
document.getElementById('footprints').onchange = e => { showFootprints = e.target.checked; draw(); };
document.getElementById('growicons').onchange = e => { growIcons = e.target.checked; draw(); };
document.getElementById('teamcolors').onchange = e => {
  autoTeamColors = e.target.checked;
  if (!data) return;
  // Icon tint/render caches key on the colour string, so a colour change just
  // produces fresh entries — no need to clear them.
  applyTeamColors();
  renderPlayers(); renderTeams(); draw();
};
document.getElementById('iconsize').oninput = e => {
  iconScale = +e.target.value;
  setParam('iconsize', iconScale);
  draw();
};
document.getElementById('slider').oninput = e => { stopPlay(); go(+e.target.value); };
window.addEventListener('keydown', e => {
  if (e.target.tagName === 'SELECT') return;
  if (e.key === 'ArrowLeft') { stopPlay(); go(idx - 1); }
  else if (e.key === 'ArrowRight') { stopPlay(); go(idx + 1); }
  else if (e.key === ' ') { e.preventDefault(); togglePlay(); }
});

// ---- loading --------------------------------------------------------------
function setEmpty(msg) {
  emptyEl.style.display = msg ? 'flex' : 'none';
  emptyEl.textContent = msg || '';
}

async function loadReplay(file) {
  stopPlay();
  setEmpty('Loading…');
  // Invalidate any in-flight chunk fetches from the previous replay.
  loadGen++;
  fetchQueue = [];
  inflight = 0;
  clearTimeout(scrubTimer);
  currentFile = file;
  try {
    const r = await fetch('/replays/' + encodeURIComponent(file) + '.brw');
    if (!r.ok) throw new Error(await r.text());
    data = await decodeHead(await r.arrayBuffer());
  } catch (err) {
    setEmpty('Failed to load ' + file + ': ' + err.message);
    data = null;
    return;
  }
  data.chunks = data.chunks || [];
  data.frameCount = data.frameCount || 0;
  data.frames = new Array(data.frameCount); // sparse: filled as chunks stream in
  chunkStartIdx = [];
  chunkState = new Array(data.chunks.length).fill(0);
  keyFrames = new Array(data.chunks.length).fill(null);
  pendingDelta = new Array(data.chunks.length).fill(null);
  let acc = 0;
  for (const c of data.chunks) { chunkStartIdx.push(acc); acc += c.count; }
  if (!data.frameCount) {
    setEmpty('No frames in this capture (the widget may never have sampled — see the GPU/headless note in CLAUDE.md).');
    // Still render meta/teams so the sidebar isn't blank.
  } else {
    setEmpty('');
  }
  buildDefTables();
  applyTeamColors();
  lastTimeText = null;
  lastSliderIdx = -1;
  secPerFrame = data.sampleEvery > 0 ? data.sampleEvery / 30 : 1;
  document.getElementById('subtitle').textContent =
    [data.gameId, data.mapName, data.gameVersion].filter(Boolean).join(' · ') || 'replay state viewer';
  document.getElementById('slider').max = Math.max(0, data.frameCount - 1);
  idx = 0;
  playPos = 0;
  dispIdx = -1;
  // Pre-warm the icon set (only a few dozen distinct unit types per replay) so
  // they're ready on the first paint.
  Object.values(data.unitIcons || {}).forEach(info => getImage(info.p));
  loadMap(data.mapName);
  resize();      // sets canvas size
  fitView();     // fit map to viewport
  updateBuffBar();
  // Start streaming: the keys stream first (all keyframes — the whole
  // timeline becomes scrubbable within seconds), the playhead's delta chunk
  // in parallel, then the rest sequentially in the background.
  streamKeys(loadGen);
  ensureChunk(0, { urgent: true });
  ensureChunk(1);
  pumpBackground();
  loadResources(file, loadGen); // economy timeline for the player-list bars (async)
  show();
}

// The BAR maps API. The browser talks to it directly (the API allows
// cross-origin use): /maps/<name> gives the map's extent, and
// /maps/<name>/texture-mq.jpg is the terrain image drawn behind the units.
const MAP_API = 'https://api.bar-rts.com';
// The API reports map width/height in map units; 1 map unit = 512 elmos.
const MAP_ELMOS_PER_UNIT = 512;

// normalizeMapName turns the capture's display map name ("Supreme Isthmus
// v2.1") into the API's file-name form ("supreme_isthmus_v2.1").
function normalizeMapName(display) {
  return (display || '').trim().toLowerCase().replace(/ /g, '_');
}

// Fetch this replay's map extent + terrain texture straight from the BAR maps
// API, using the map name stored in the capture's meta. Best-effort: if the
// map is unknown or the API unreachable, the viewer just keeps the plain
// background (and falls back to unit bounds for the field extent).
async function loadMap(name) {
  const gen = loadGen; // ignore responses if the user switched replays mid-fetch
  mapW = mapH = 0;
  mapTex = null;
  const maptexEl = document.getElementById('maptex');
  maptexEl.disabled = true; // enabled once the texture actually loads
  const norm = normalizeMapName(name);
  if (!norm) return;
  const base = MAP_API + '/maps/' + encodeURIComponent(norm);
  try {
    const info = await (await fetch(base)).json();
    if (gen !== loadGen) return;
    mapW = (info.width || 0) * MAP_ELMOS_PER_UNIT;
    mapH = (info.height || 0) * MAP_ELMOS_PER_UNIT;
  } catch (_) { /* offline/unknown: keep unit-bounds extent, still try the texture */ }
  if (gen !== loadGen) return;
  const img = new Image();
  img.crossOrigin = 'anonymous'; // the API sends CORS headers; keeps the canvas untainted
  img.onload = () => { if (gen !== loadGen) return; mapTex = img; maptexEl.disabled = false; draw(); };
  img.onerror = () => { /* no texture for this map: checkbox stays disabled */ };
  img.src = base + '/texture-mq.jpg';
  draw(); // reflect the (possibly updated) map extent immediately
}

// Render-smoothness FPS monitor. Fully self-contained: when enabled (?debug=true)
// it drops a small overlay in the top-left of the map and runs its own
// requestAnimationFrame loop, counting real browser animation frames (not sim
// frames). It shows frames drawn in the last full second and in the last 5
// seconds, each refreshed on every whole-second boundary. Nothing else in the
// app references it — remove this one call and function to drop the feature.
function startFpsMonitor() {
  const el = document.createElement('div');
  el.id = 'fpsmon';
  el.style.cssText =
    'position:absolute;left:8px;top:8px;z-index:20;pointer-events:none;' +
    'background:rgba(20,26,33,0.82);border:1px solid #2a323c;border-radius:4px;' +
    'padding:3px 7px;font:11px/1.5 monospace;color:#9fb0bf;' +
    'font-variant-numeric:tabular-nums;white-space:pre;';
  (document.getElementById('left') || document.body).appendChild(el);

  let frames = 0;          // frames since the last whole-second boundary
  let secStart = null;     // timestamp of the current second window
  const last5 = [];        // per-second frame counts, most-recent-last (max 5)

  const tick = (ts) => {
    if (secStart === null) secStart = ts;
    frames++;
    if (ts - secStart >= 1000) {
      last5.push(frames);
      if (last5.length > 5) last5.shift();
      const fps5 = last5.reduce((a, b) => a + b, 0);
      el.textContent = `${frames} fps\n${fps5} / 5s`;
      frames = 0;
      secStart = ts;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

async function init() {
  initGL(); // one-time; a null result just means the 2D icon path is used
  // Restore icon size from the URL (?iconsize=) before the first paint.
  const params = new URLSearchParams(location.search);
  const isz = parseInt(params.get('iconsize'), 10);
  if (isz >= ICON_SCALE_MIN && isz <= ICON_SCALE_MAX) iconScale = isz;
  document.getElementById('iconsize').value = iconScale;

  // Optional render-smoothness overlay, gated on ?debug=true.
  if (params.get('debug') === 'true') startFpsMonitor();

  let list = [];
  try {
    const r = await fetch('/index.json');
    list = await r.json();
  } catch (err) {
    setEmpty('Could not list snapshots: ' + err.message);
    return;
  }
  const sel = document.getElementById('file');
  if (!list || !list.length) {
    setEmpty('No .brp files in the snapshots directory. Run a capture (or convert a legacy .jsonl/.brsnap with barreplay-pack), or point -snapshots at the right directory.');
    return;
  }
  list.forEach(info => {
    const o = document.createElement('option');
    o.value = info.file;
    o.textContent = `${info.gameId} (${fmtSize(info.size)})`;
    sel.appendChild(o);
  });
  sel.onchange = () => { setReplayInUrl(sel.value); loadReplay(sel.value); };

  // Restore the replay named in the URL (?replay=<file>) so a refresh keeps it.
  const wanted = new URLSearchParams(location.search).get('replay');
  const initial = list.some(i => i.file === wanted) ? wanted : list[0].file;
  sel.value = initial;
  setReplayInUrl(initial);
  await loadReplay(initial);
}

// Persist a viewer setting in the URL without adding history entries, so a page
// refresh (or a shared link) restores it.
function setParam(key, val) {
  const u = new URL(location.href);
  u.searchParams.set(key, val);
  history.replaceState(null, '', u);
}
function setReplayInUrl(file) { setParam('replay', file); }

// Support browser back/forward and manual URL edits.
window.addEventListener('popstate', () => {
  const wanted = new URLSearchParams(location.search).get('replay');
  const sel = document.getElementById('file');
  if (wanted && wanted !== sel.value && [...sel.options].some(o => o.value === wanted)) {
    sel.value = wanted;
    loadReplay(wanted);
  }
});

function fmtSize(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + ' KB';
  return n + ' B';
}

init();

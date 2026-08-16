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
// Frames unpack into a flat Int32Array `u` of stride 11:
// [id, def, team, x, z, hp, maxHp, dvx, dvz, build, target]. We read it by
// index rather than materialising per-unit objects — a replay can hold
// millions of unit records, so avoiding the object churn keeps loading and
// playback smooth. build is quantized 0..255 (255 = finished); target is the
// unit id this one is constructing/assisting (0 = none). Both columns exist
// only in codec v5 streams — a v4 replay decodes with build=255/target=0
// (see codecVer below), so no bars or lines draw for it.

const STRIDE = 11;
const F = { ID: 0, DEF: 1, TEAM: 2, X: 3, Z: 4, HP: 5, MAXHP: 6, DVX: 7, DVZ: 8, BUILD: 9, TARGET: 10 };
const BUILD_DONE = 255; // quantized "construction finished"

// The .brw container's version byte == the .brp codec version the frame
// streams were encoded with: 4 (8 columns) or 5 (adds build + target).
// Set when the head loads, read by decodeFrames.
let codecVer = 5;

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
  const ver = u8[magic.length];
  if (ver !== 4 && ver !== 5) throw new Error('unsupported payload version ' + ver);
  const dv = new DataView(buf);
  const secs = { _ver: ver };
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
// CHANGED id list (new units + units with any column change), then the value
// columns (10 in codec v5, 8 in v4 — no build/target) for the changed units
// only, delta-coded against the same unit in the previous frame (absolute
// when the id is new); x/z predict with the previous frame's velocity
// displacement. Every other previously-live unit
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

    // Decode the changed units' columns against prevU. Stream column order
    // matches the array layout (def..dvz, then build/target in v5).
    const nCols = codecVer >= 5 ? F.TARGET : F.DVZ;
    const ch = new Int32Array(nCh * STRIDE);
    for (let i = 0; i < nCh; i++) ch[i * STRIDE] = chIds[i];
    for (let c = 1; c <= nCols; c++) {
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
    if (nCols < F.TARGET) {
      // v4 stream: no build/target columns. Carry them for existing units
      // (always BUILD_DONE/0 in practice) and default new units to finished.
      for (let i = 0; i < nCh; i++) {
        const o = i * STRIDE, j = pidx[i];
        ch[o + F.BUILD] = j < 0 ? BUILD_DONE : prevU[j + F.BUILD];
        ch[o + F.TARGET] = j < 0 ? 0 : prevU[j + F.TARGET];
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
        u[t + F.BUILD] = prevU[o + F.BUILD];
        u[t + F.TARGET] = prevU[o + F.TARGET];
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

// Comms (what players wrote and drew): count, a kind string table, a chat
// destination string table, then one column at a time. Positions are whole
// elmos delta-coded against the previous comm — freehand drawing is a run of
// short segments walking across the map, so those deltas are tiny — and a
// line's far end is delta-coded against its own near end.
function decodeComms(b) {
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
  const td = new TextDecoder();
  function str() {
    const l = uv();
    const s = td.decode(b.subarray(p, p + l));
    p += l;
    return s;
  }
  function table() {
    const n = uv(), out = [];
    for (let i = 0; i < n; i++) out.push(str());
    return out;
  }
  const n = uv();
  const kinds = table();
  const dests = table();
  const cs = new Array(n);
  for (let i = 0; i < n; i++) cs[i] = { f: 0, k: '', p: -1, n: '', d: '', t: '', x: 0, z: 0, x2: 0, z2: 0 };
  let acc = 0;
  for (let i = 0; i < n; i++) { acc += sv(); cs[i].f = acc; }
  for (let i = 0; i < n; i++) cs[i].k = kinds[uv()];
  for (let i = 0; i < n; i++) cs[i].d = dests[uv()];
  for (let i = 0; i < n; i++) cs[i].p = sv();
  let px = 0, pz = 0;
  for (let i = 0; i < n; i++) {
    const x = px + sv(), z = pz + sv();
    cs[i].x = x; cs[i].z = z;
    cs[i].x2 = x + sv(); cs[i].z2 = z + sv();
    px = x; pz = z;
  }
  for (let i = 0; i < n; i++) cs[i].t = str();
  for (let i = 0; i < n; i++) cs[i].n = str();
  return cs;
}

// Decode the /api/replay head payload: the head JSON's fields plus events
// [{f,k,id,def,team}] and comms [{f,k,p,n,d,t,x,z,x2,z2}]. Frames stream in
// separately per chunk. Both extra sections are optional — a capture whose
// widget never recorded comms simply has none.
async function decodeHead(buf) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('this browser lacks DecompressionStream (needed to read the capture)');
  }
  const secs = parseContainer(buf);
  if (!secs.J) throw new Error('payload has no head section');
  const head = JSON.parse(new TextDecoder().decode(await gunzipU8(secs.J)));
  head.events = secs.E ? decodeEvents(await gunzipU8(secs.E)) : [];
  head.comms = secs.C ? decodeComms(await gunzipU8(secs.C)) : [];
  head.codecVer = secs._ver;
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
        indexGhostSightings(kf);
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
  if (m0x === 0 && m0z === 0) {
    // Zero velocity at this sample. Usually genuinely stationary — but a
    // radar-only contact reads velocity nil (recorded as 0) while its wobbled
    // position still moves every sample, which made it sit still and JUMP at
    // each frame boundary. When the next sample also has zero velocity but a
    // different position, glide linearly between the two points; a truly
    // stationary unit hits the identity lerp (same position) and stays put.
    const j0 = nextPosMap ? nextPosMap.get(u[i + F.ID]) : undefined;
    if (j0 !== undefined && nextU
      && nextU[j0 + F.DVX] === 0 && nextU[j0 + F.DVZ] === 0) {
      _pos[0] = bx + (nextU[j0 + F.X] - bx) * renderFrac;
      _pos[1] = bz + (nextU[j0 + F.Z] - bz) * renderFrac;
    }
    return _pos;
  }
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

// interpBuild returns a unit's build progress at the sub-sample position,
// lerped toward its value in the NEXT sample, so a bar creeps forward on every
// rendered frame instead of stepping once per sample the way the stored column
// does. Costs one map lookup per under-construction unit per frame — measured
// at 2.7us for 200 of them among 2500 units, 0.016% of a 60fps budget, so it
// is not worth gating on playback speed.
//
// Guarded on the def matching, unlike interpPos: the engine recycles unit ids,
// and a progress bar rewinding to zero because the id now belongs to something
// else is far more noticeable than a position doing the same.
function interpBuild(u, i) {
  const b = u[i + F.BUILD];
  if (renderFrac === 0 || !nextU || !nextPosMap) return b;
  const j = nextPosMap.get(u[i + F.ID]);
  if (j === undefined || nextU[j + F.DEF] !== u[i + F.DEF]) return b;
  return b + (nextU[j + F.BUILD] - b) * renderFrac;
}

const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
// #ovcv sits above both the 2D base layer and the GL icon canvas: the
// build-lines + construction-progress overlay redraws every tick (it follows
// interpolated unit positions), so it lives on its own canvas to keep the
// base layer's repaint-skip optimization intact.
const ovcv = document.getElementById('ovcv');
const octx = ovcv ? ovcv.getContext('2d') : null;
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
// What the renderer draws. These were checkboxes above the canvas; the viewer
// now just draws the settings that were right anyway, so they are fixed here —
// the draw paths still read them, and flipping one is an edit, not a UI state.
const showIcons = true;      // draw BAR unit icons (vs plain dots)
const showTexture = true;    // draw the map terrain texture behind everything
const showGrid = false;      // draw the build/small/large grid
const showFootprints = false;// draw build-footprint rectangles for buildings
const showBuildLines = true; // connect builders to their construction targets
const growIcons = true;      // grow a building's icon toward its footprint when zoomed in
const autoTeamColors = false; // true: distinct auto colours per team; false: the real in-game team colours from the replay
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
// iconScale is the base px-per-size-unit — fixed, like the draw toggles above:
// it used to be a slider persisted as ?iconsize=, and 12 is the default that
// setting always came back to.
const iconScale = 12;
const ICON_MIN_PX = 3;
const ICON_MAX_PX = 200;

// imageCache: served icon path -> HTMLImageElement (may still be loading), or
// null while the path is in a FAILED state — which is not final. A replay
// requests every icon it references in one burst at load (300+ paths in a
// modded game), so a single dropped or throttled response is entirely normal,
// and treating it as permanent left that unit type drawing as a coloured dot
// for the whole session, healed only by reloading the page. A failed path is
// retried up to IMAGE_RETRIES times, spaced by IMAGE_RETRY_MS; callers already
// read null as "no bitmap right now" and ask again on the next draw, so the
// retry rides their polling instead of scheduling timers of its own.
const imageCache = {};
const imageFails = new Map(); // path -> {tries, at} while the path is failed
const IMAGE_RETRIES = 3;
const IMAGE_RETRY_MS = 2000;

function loadImage(path) {
  const img = new Image();
  img.onload = () => { imageFails.delete(path); scheduleDraw(); };
  img.onerror = () => {
    const f = imageFails.get(path) || { tries: 0, at: 0 };
    f.tries++;
    f.at = performance.now();
    imageFails.set(path, f);
    imageCache[path] = null;
  };
  img.src = '/' + path;
  imageCache[path] = img;
  return img;
}

function getImage(path) {
  const cached = imageCache[path];
  if (cached === undefined) return loadImage(path);
  if (cached !== null) return cached;
  const f = imageFails.get(path);
  if (!f || f.tries >= IMAGE_RETRIES || performance.now() - f.at < IMAGE_RETRY_MS) return null;
  return loadImage(path); // retry with a fresh element; the failed one is dropped
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

// ---- damage flash ----------------------------------------------------------
// A unit whose hp dropped since the previous sampled frame briefly flashes:
// its icon blends toward the flash colour and fades back (GL: per-instance
// tint; 2D: a flash-coloured glyph drawn over). Detection (noteDamage) runs
// only during PLAYBACK, and only when the displayed frame advances by exactly
// one sample — stepping and scrubbing never flash. The hp drop happened
// somewhere inside the sampled interval, not at its boundary, so each unit's
// flash is scheduled at a RANDOM real-time offset within the interval:
// simultaneous hits stagger organically instead of pulsing in lockstep at
// every frame start. The flash then fades over FLASH_MS of REAL time
// (independent of playback speed). This block must precede applyTeamColors,
// which assigns flashTargetOf at load time.
const FLASH_MS = 180;
const FLASH_STRENGTH = 0.8;           // peak blend toward the flash target (1 = fully there)
// Flash targets, [r,g,b] for the GL tint blend + the matching css for the 2D
// glyph. Red is the default, but on a red/pink/orange team colour a red flash
// is invisible — those teams flash toward white instead, and LIGHT red-ish
// colours (pink), where white is also weak, flash toward dark. Which target a
// team uses is decided once per palette (applyTeamColors), not per frame.
const FLASH_TARGETS = [
  { tint: [1.0, 0.16, 0.12], css: '#ff291f' }, // red (default)
  { tint: [1.0, 1.0, 1.0], css: '#ffffff' },   // white (red-ish team colours)
  { tint: [0.08, 0.08, 0.08], css: '#141414' },// dark (light red-ish, e.g. pink)
];
let flashTargetOf = new Map(); // team id -> index into FLASH_TARGETS
// flashTargetFor picks the target for one team tint: red unless the colour
// itself is red-dominant (red/orange/pink), where the branch on luminance
// sends dark-to-mid colours to white and light ones to dark.
function flashTargetFor(tint) {
  const r = tint[0], g = tint[1], b = tint[2];
  const reddish = r > 0.5 && r - g >= 0.15 && r - b >= 0.12;
  if (!reddish) return 0;
  const luma = 0.3 * r + 0.59 * g + 0.11 * b;
  return luma > 0.72 ? 2 : 1;
}
let damageFlash = new Map(); // unit id -> performance.now() the flash STARTS (may be in the future)
let flashSeenIdx = -1;       // dispIdx the detector last processed

// flashK: the flash intensity for a unit right now — 1 at the (possibly
// staggered) start, fading linearly to 0 over FLASH_MS; 0 when absent or not
// yet started. Callers skip the lookup entirely while the map is empty.
function flashK(id, now) {
  const t = damageFlash.get(id);
  if (t === undefined) return 0;
  const dt = now - t;
  if (dt < 0 || dt >= FLASH_MS) return 0;
  return 1 - dt / FLASH_MS;
}
function pruneFlashes(now) {
  for (const [id, t] of damageFlash) {
    if (now - t >= FLASH_MS) damageFlash.delete(id);
  }
}
// ---- ghost buildings -------------------------------------------------------
// An enemy STRUCTURE that drops out of the capture (widget >= 1.5.0 drops
// unlisted units) is not gone — buildings don't move, so its last-known state
// keeps being true until someone actually sees it die. The viewer keeps such
// buildings on the map as semi-transparent ghosts, and the ghost set is a
// pure FUNCTION OF THE PLAYHEAD (like normal units — scrub anywhere and it is
// correct, no watching-history required): a structure is a ghost at frame N
// when it was sighted in some KEYFRAME at or before N, is absent from the
// displayed frame, and has no destroyed event between that last sighting and
// N (a witnessed death rides the stream as an event even when the unit
// vanishes the same sample). Keyframes all stream in up front (.keys), so
// sightings are indexed as they decode (indexGhostSightings) and the set is
// recomputed on every display-frame change. Keyframe resolution (one per 64
// samples) is the deliberate trade: a structure only ever seen BETWEEN two
// keyframes leaves no sighting and casts no ghost. Mobile units never ghost:
// they'd be somewhere else already.
const GHOST_ALPHA = 0.45;
let ghostBuildings = new Map(); // id -> {f, def, team, x, z, hp, maxHp} (current ghost set)
let ghostIndex = new Map();     // id -> [{f, def, team, x, z, hp, maxHp}] per keyframe sighting, f ascending
let destroyedAt = new Map();    // id -> frames of its destroyed events (per load)
function buildDestroyedIndex() {
  destroyedAt = new Map();
  for (const e of data.events || []) {
    if (e.k !== 'destroyed') continue;
    let a = destroyedAt.get(e.id);
    if (a === undefined) destroyedAt.set(e.id, a = []);
    a.push(e.f);
  }
}
// diedBetween: a destroyed event for id in sim-frame range (f0, f1].
function diedBetween(id, f0, f1) {
  const a = destroyedAt.get(id);
  if (a === undefined) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] > f0 && a[i] <= f1) return true;
  }
  return false;
}

// indexGhostSightings records every structure in one decoded keyframe.
// streamKeys decodes keyframes strictly in chunk order, so each id's sighting
// list stays sorted by frame. ~dozens of structures x dozens of chunks: tiny.
function indexGhostSightings(kf) {
  const u = kf.u;
  for (let i = 0; i < u.length; i += STRIDE) {
    const def = u[i + F.DEF];
    if (!defFp.get(def)) continue; // structures only (footprint = structure)
    const id = u[i + F.ID];
    let a = ghostIndex.get(id);
    if (a === undefined) ghostIndex.set(id, a = []);
    a.push({
      f: kf.f, def, team: u[i + F.TEAM], x: u[i + F.X], z: u[i + F.Z],
      hp: u[i + F.HP], maxHp: u[i + F.MAXHP],
    });
  }
  recomputeGhosts(); // sightings near the playhead may have just arrived
}

const _curIds = new Set(); // scratch: ids in the displayed frame
// recomputeGhosts rebuilds the ghost set for the currently displayed frame
// from the sighting index — valid after any playhead move, forward or back.
function recomputeGhosts() {
  ghostBuildings.clear();
  if (!data || dispIdx < 0) return;
  const fr = data.frames[dispIdx];
  if (!fr) return;
  const curF = frameNumAt(dispIdx);
  const cu = fr.u;
  _curIds.clear();
  for (let i = 0; i < cu.length; i += STRIDE) _curIds.add(cu[i + F.ID]);
  for (const [id, sightings] of ghostIndex) {
    if (_curIds.has(id)) continue;
    let e = null; // latest sighting at or before the displayed frame
    for (let k = sightings.length - 1; k >= 0; k--) {
      if (sightings[k].f <= curF) { e = sightings[k]; break; }
    }
    if (e === null) continue;        // not seen yet at this point of the game
    if (diedBetween(id, e.f, curF)) continue; // its death was witnessed
    ghostBuildings.set(id, e);
  }
}

const _flashPrevHp = new Map(); // scratch: id -> hp in the previous frame
// noteFrameAdvance runs whenever the DISPLAYED frame changes: the ghost set
// is recomputed for the new frame, damage flashes only on a single-sample
// advance while playing.
function noteFrameAdvance() {
  if (dispIdx === flashSeenIdx) return;
  const prevIdx = flashSeenIdx;
  flashSeenIdx = dispIdx;
  recomputeGhosts();
  if (!playRAF) return;                // flash only while actually playing
  if (dispIdx !== prevIdx + 1) return; // jump/scrub/first frame: no comparison
  const pf = data.frames[prevIdx], cf = data.frames[dispIdx];
  if (!pf || !cf) return;
  const pu = pf.u, cu = cf.u;
  _flashPrevHp.clear();
  for (let i = 0; i < pu.length; i += STRIDE) _flashPrevHp.set(pu[i + F.ID], pu[i + F.HP]);
  const now = performance.now();
  const speed = +document.getElementById('speed').value || 1;
  const intervalMs = (secPerFrame / speed) * 1000; // real duration of one sample interval
  for (let i = 0; i < cu.length; i += STRIDE) {
    const ph = _flashPrevHp.get(cu[i + F.ID]);
    if (ph !== undefined && cu[i + F.HP] < ph) {
      damageFlash.set(cu[i + F.ID], now + Math.random() * intervalMs);
    }
  }
}

// applyTeamColors (re)derives everything that hangs off the team palette.
function applyTeamColors() {
  teamColor = computeTeamColors();
  teamTint = new Map();
  flashTargetOf = new Map();
  for (const id in teamColor) {
    const tint = cssToTint(teamColor[id]);
    teamTint.set(+id, tint);
    flashTargetOf.set(+id, flashTargetFor(tint));
  }
  colorGen++;
}

function teamLabel(t) {
  if (t.player) return t.player;
  const side = t.side ? ` (${t.side})` : '';
  return `Team ${t.team}${side}`;
}

// ---- player comms: chat + map drawings -------------------------------------
// data.comms is everything the capture's players wrote or drew, in frame order
// (see decodeComms). It splits into two consumers: the map marks (points,
// lines, erases) drawn in world space on the overlay canvas, and the chat log
// in the sidebar.
//
// LIFETIME: a mark stays on the map for MARK_LIFETIME game-seconds, matching
// BAR's own "Auto mapmark eraser" widget — the marks a replay shows are then
// the ones the players actually had in front of them. The engine itself never
// expires a mark; only an explicit erase removes it, which is why erasedAt
// below is precomputed rather than the lifetime being the whole story.

const MARK_LIFETIME = 60;   // game-seconds a drawing stays on the map
const MARK_FADE = 8;        // game-seconds of fade-out at the end of that
const MARK_ERASE_RADIUS = 100; // elmos; the engine's CInMapDrawModel constant

let marks = [];             // point/line comms in frame order, with erasedAt
let chatLines = [];         // chat comms in frame order
let commTeamOf = new Map(); // playerID -> team id (-1 for spectators)

// buildCommIndex splits data.comms into the two views and resolves, for every
// mark, the frame an erase removed it at (Infinity when none did).
//
// An erase clears every mark ANCHORED within MARK_ERASE_RADIUS of it (a
// point's position, a line's first end) — the engine's own rule. Resolving it
// once here rather than per animation tick keeps drawing O(marks on screen):
// the backwards scan stops at the lifetime horizon, since a mark older than
// that is already gone and cannot be erased again.
function buildCommIndex() {
  marks = [];
  chatLines = [];
  commTeamOf = new Map();
  for (const p of data.players || []) commTeamOf.set(p.id, p.spec ? -1 : p.team);
  const comms = data.comms || [];
  const lifetime = MARK_LIFETIME * 30;
  for (const c of comms) {
    if (c.k === 'chat') { chatLines.push(c); continue; }
    if (c.k === 'point' || c.k === 'line') { marks.push({ c, erasedAt: Infinity }); continue; }
    if (c.k !== 'erase') continue;
    const r2 = MARK_ERASE_RADIUS * MARK_ERASE_RADIUS;
    for (let i = marks.length - 1; i >= 0; i--) {
      const m = marks[i];
      if (c.f - m.c.f > lifetime) break; // older than the horizon: already gone
      if (m.erasedAt !== Infinity) continue;
      const dx = m.c.x - c.x, dz = m.c.z - c.z;
      if (dx * dx + dz * dz < r2) m.erasedAt = c.f;
    }
  }
}

// firstMarkAt returns the index of the first mark whose frame is >= f.
function firstMarkAt(f) {
  let lo = 0, hi = marks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (marks[mid].c.f < f) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// commColor is the author's team colour; spectators and unresolved authors get
// the neutral unknown-team grey, so a mark is never invisible.
function commColor(playerID) {
  const team = commTeamOf.get(playerID);
  return (team !== undefined && team >= 0 && teamColor[team]) || '#9aa6b2';
}

function commName(c) {
  if (c.n) return c.n;
  for (const p of data.players || []) if (p.id === c.p) return p.name;
  return c.p >= 0 ? 'player ' + c.p : '?';
}

// drawMarks paints the map drawings visible at sim frame f onto the overlay
// canvas, in world space (they scale and pan with the map, unlike the icons).
// Points are a diamond plus their label; lines are the segment they were drawn
// as, so a freehand scribble comes back as the shape its author traced.
function drawMarks(f) {
  const lifetime = MARK_LIFETIME * 30, fade = MARK_FADE * 30;
  let i = firstMarkAt(f - lifetime);
  let labels = null;
  for (; i < marks.length; i++) {
    const m = marks[i];
    if (m.c.f > f) break;
    const end = Math.min(m.c.f + lifetime, m.erasedAt);
    if (f >= end) continue;
    const left = end - f;
    octx.globalAlpha = left < fade ? left / fade : 1;
    octx.strokeStyle = commColor(m.c.p);
    const sx = viewW / 2 + (m.c.x - center.x) * scale;
    const sy = viewH / 2 + (m.c.z - center.z) * scale;
    if (m.c.k === 'line') {
      const ex = viewW / 2 + (m.c.x2 - center.x) * scale;
      const ey = viewH / 2 + (m.c.z2 - center.z) * scale;
      if ((sx < 0 && ex < 0) || (sy < 0 && ey < 0) ||
        (sx > viewW && ex > viewW) || (sy > viewH && ey > viewH)) continue;
      octx.lineWidth = 2;
      octx.beginPath();
      octx.moveTo(sx, sy);
      octx.lineTo(ex, ey);
      octx.stroke();
      continue;
    }
    if (sx < -20 || sy < -20 || sx > viewW + 20 || sy > viewH + 20) continue;
    // A marker: a diamond, drawn at constant screen size like the unit icons.
    const r = 7;
    octx.lineWidth = 2;
    octx.beginPath();
    octx.moveTo(sx, sy - r);
    octx.lineTo(sx + r, sy);
    octx.lineTo(sx, sy + r);
    octx.lineTo(sx - r, sy);
    octx.closePath();
    octx.stroke();
    if (m.c.t) (labels || (labels = [])).push([sx, sy, m.c.t, octx.strokeStyle, octx.globalAlpha]);
  }
  // Labels last, so no later mark's stroke crosses one.
  if (labels) {
    octx.textAlign = 'center';
    octx.textBaseline = 'bottom';
    octx.font = '12px system-ui, sans-serif';
    octx.lineWidth = 3;
    octx.strokeStyle = 'rgba(8, 12, 16, 0.85)';
    for (const [x, y, text, color, alpha] of labels) {
      octx.globalAlpha = alpha;
      octx.strokeText(text, x, y - 10);
      octx.fillStyle = color;
      octx.fillText(text, x, y - 10);
    }
  }
  octx.globalAlpha = 1;
}

// ---- chat log ---------------------------------------------------------------
// The conversation SO FAR, in the sidebar: only what has been said by the
// playhead is shown, and the box stays parked at the bottom so the newest line
// is the one you are looking at. Nothing is spoiled by a message that has not
// happened yet, and a row's click seeks back to when it was said.
//
// Parking is the usual stick-to-bottom rule: scroll away and the box stops
// following, scroll back down to the bottom and it resumes. Our own scrolling
// fires the same event and simply re-confirms the stick, so no suppress flag is
// needed.

const CHAT_DEST_TAG = { ally: 'ally', spec: 'spec', private: 'pm', lobby: 'lobby' };
const CHAT_STICK_SLACK = 4; // px from the bottom still counted as "parked"
let chatBuilt = false;      // rows exist for the current replay
let chatCursor = -1;        // index of the newest row at or before the playhead
let chatStick = true;       // follow the playhead (false once scrolled away)

// ---- chat bubbles -----------------------------------------------------------
// A message also pops up over its speaker on the map, the way it would have in
// the game, so you can see WHERE the person calling the play is. The anchor is
// the speaker's COMMANDER — a player's avatar, and the one unit that is theirs
// alone. When it is dead (chat outlives commanders in a long game) the bubble
// falls back to the centroid of whatever that team still owns, which keeps it
// on their side of the map; a speaker with no units left, a spectator, or a
// battleroom relay gets no bubble at all and lives only in the sidebar.
//
// A bubble does NOT follow its anchor once it is up. The position is resolved
// when a speaker's first live message appears and then held for as long as any
// of their messages is showing (bubbleAnchor), so a burst reads as one stable
// stack and a commander wandering off — or a centroid drifting as the team
// builds and dies — cannot drag the words across the map. The next thing that
// player says, once the stack has cleared, is placed wherever they are then.

const BUBBLE_LIFETIME = 9;  // game-seconds a bubble hovers, at 1x playback
const BUBBLE_FADE = 2;      // game-seconds of fade-out at the end of that
const BUBBLE_STACK = 3;     // most recent messages shown per speaker
const BUBBLE_MAX_PX = 240;  // bubble width cap; longer text is ellipsized
const BUBBLE_PAD = 5;
const BUBBLE_LINE = 16;     // px between stacked bubbles

// Lifetime is measured in GAME time but read in WALL time, so playback speed
// has to stretch it: at 16x a 9-game-second bubble is on screen for half a
// second, far too short to read. Scaling by the speed factor keeps the
// wall-clock duration constant instead — capped at BUBBLE_SPEED_CAP, because
// past that the bubbles linger long enough to bury the battle they are about.
// Only while PLAYING: paused, the playhead does not move and a bubble never
// expires anyway, and scrubbing is at the reader's own pace.
//
// The factor is applied ONCE, when a bubble appears, and its expiry frozen in
// bubbleExpiry. Re-deriving the window from the current speed every frame
// measures it backwards from NOW, so changing speed mid-playback resurrects
// old messages (window widens) or kills live ones (window narrows) — bubbles
// visibly popping in and out for no reason but the speed control.
const BUBBLE_SPEED_CAP = 16;

function bubbleSpeedFactor() {
  if (!playRAF) return 1;
  return Math.min(+document.getElementById('speed').value || 1, BUBBLE_SPEED_CAP);
}

// A commander's internal def name in BAR: <faction>com, plus the level variants
// (armcomlvl3) and Legion's upgrade paths (legcomoff, legcomt2def). The prefix
// match deliberately excludes DECOY commanders (armdecom/cordecom/legdecom),
// which are fakes and can exist several at a time, and everything that merely
// contains "com" (comeffigylvl2, dummycom, mission_command_tower); the boss
// test drops the scavenger/AI commanders, which belong to no player.
const COMMANDER_RE = /^(arm|cor|leg)com/;
let defIsCom = new Map();     // def id -> is it a player's commander
let bubbleAnchor = new Map(); // playerID -> [x, z, team] held while they are on screen
let bubbleExpiry = new Map(); // chat index -> [expireFrame, fadeFrames], frozen when it appears

function buildCommanderDefs() {
  defIsCom = new Map();
  const defs = data.unitDefs || {};
  for (const id in defs) {
    const name = defs[id];
    defIsCom.set(+id, COMMANDER_RE.test(name) && !name.includes('boss'));
  }
}

// firstChatAt returns the index of the first chat line at or after frame f.
function firstChatAt(f) {
  let lo = 0, hi = chatLines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (chatLines[mid].f < f) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// textColorOn picks black or white for text drawn on a team colour, so a bubble
// stays readable whichever end of the palette the team sits at.
function textColorOn(css) {
  const [r, g, b] = cssToTint(css);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 0.55 ? '#0b0e12' : '#ffffff';
}

function roundRectPath(c, x, y, w, h, r) {
  if (c.roundRect) { c.beginPath(); c.roundRect(x, y, w, h, r); return; }
  c.beginPath();
  c.rect(x, y, w, h);
}

// drawChatBubbles paints the messages spoken within the (speed-scaled) bubble
// lifetime over their speakers. u is the displayed frame's unit array.
function drawChatBubbles(f, u) {
  if (!chatLines.length || !u) return;
  const scaleT = bubbleSpeedFactor();
  // Scan against the WIDEST window any bubble could have been given, then let
  // each one's own frozen expiry decide — the speed in force now must not
  // reach back and re-time bubbles that are already up.
  const start = firstChatAt(f - BUBBLE_LIFETIME * 30 * BUBBLE_SPEED_CAP);
  for (const i of bubbleExpiry.keys()) {
    // Forget anything past the widest window, or that the playhead has scrubbed
    // back before, so a rewatch is timed at whatever speed it is rewatched.
    if (i < start || chatLines[i].f > f) bubbleExpiry.delete(i);
  }

  // Live messages, grouped by speaker and oldest first.
  const byPlayer = new Map(); // playerID -> [{c, alpha}]
  for (let i = start; i < chatLines.length; i++) {
    const c = chatLines[i];
    if (c.f > f) break;
    let t = bubbleExpiry.get(i);
    if (t === undefined) {
      // Freeze the timing the moment the bubble appears, at the speed then in
      // force. Reaching for the speed on every frame instead is what made a
      // mid-playback speed change pop bubbles in and out: the window it
      // multiplies is measured backwards from NOW, so widening it resurrects
      // old messages and narrowing it kills live ones.
      t = [c.f + BUBBLE_LIFETIME * 30 * scaleT, BUBBLE_FADE * 30 * scaleT];
      bubbleExpiry.set(i, t);
    }
    const left = t[0] - f;
    if (left <= 0) continue; // fully faded: don't let it hold a stack slot
    const list = byPlayer.get(c.p) || [];
    list.push({ c, alpha: left < t[1] ? left / t[1] : 1 });
    byPlayer.set(c.p, list);
  }
  // A speaker whose stack has cleared releases their anchor, so their next
  // message is placed wherever they are by then.
  for (const p of bubbleAnchor.keys()) {
    if (!byPlayer.has(p)) bubbleAnchor.delete(p);
  }
  if (!byPlayer.size) return;

  // Anchor whoever has just started speaking. Everyone already on screen keeps
  // the position they were given, so this pass over the frame only happens on
  // the frames where a new speaker appears — most ticks do no work at all.
  const fresh = new Map(); // team -> [playerID]
  for (const p of byPlayer.keys()) {
    if (bubbleAnchor.has(p)) continue;
    const team = commTeamOf.get(p);
    if (team === undefined || team < 0) { // spectator / lobby relay: never anchored
      bubbleAnchor.set(p, null);
      continue;
    }
    fresh.set(team, (fresh.get(team) || []).concat(p));
  }
  if (fresh.size) {
    const com = new Map(), sum = new Map();
    for (let i = 0; i < u.length; i += STRIDE) {
      const t = u[i + F.TEAM];
      if (!fresh.has(t)) continue;
      const acc = sum.get(t);
      if (acc) { acc[0] += u[i + F.X]; acc[1] += u[i + F.Z]; acc[2]++; }
      else sum.set(t, [u[i + F.X], u[i + F.Z], 1]);
      if (defIsCom.get(u[i + F.DEF]) && !com.has(t)) com.set(t, i);
    }
    for (const [team, players] of fresh) {
      let at = null;
      const ci = com.get(team);
      if (ci !== undefined) {
        const q = interpPos(u, ci);
        at = [q[0], q[1], team];
      } else {
        const acc = sum.get(team);
        if (acc) at = [acc[0] / acc[2], acc[1] / acc[2], team];
      }
      for (const p of players) bubbleAnchor.set(p, at);
    }
  }

  octx.textAlign = 'center';
  octx.textBaseline = 'middle';
  octx.font = '12px system-ui, sans-serif';
  for (const [p, list] of byPlayer) {
    const at = bubbleAnchor.get(p);
    if (!at) continue; // nothing of theirs was on the map when they spoke
    const sx = viewW / 2 + (at[0] - center.x) * scale;
    const sy = viewH / 2 + (at[1] - center.z) * scale;
    if (sx < -BUBBLE_MAX_PX || sy < -80 || sx > viewW + BUBBLE_MAX_PX || sy > viewH + 40) continue;

    const fill = teamColor[at[2]] || '#9aa6b2';
    const ink = textColorOn(fill);
    const shown = list.slice(-BUBBLE_STACK);
    // Newest sits closest to the unit; older ones stack upward.
    shown.forEach((b, k) => {
      const y = sy - 22 - (shown.length - 1 - k) * BUBBLE_LINE;
      let text = b.c.t;
      let w = octx.measureText(text).width;
      if (w > BUBBLE_MAX_PX) {
        while (text.length > 1 && octx.measureText(text + '\u2026').width > BUBBLE_MAX_PX) {
          text = text.slice(0, -1);
        }
        text += '\u2026';
        w = octx.measureText(text).width;
      }
      octx.globalAlpha = b.alpha;
      octx.fillStyle = fill;
      roundRectPath(octx, sx - w / 2 - BUBBLE_PAD, y - 8, w + BUBBLE_PAD * 2, 16, 4);
      octx.fill();
      octx.strokeStyle = 'rgba(8, 12, 16, 0.55)';
      octx.lineWidth = 1;
      octx.stroke();
      octx.fillStyle = ink;
      octx.fillText(text, sx, y);
    });
  }
  octx.globalAlpha = 1;
}

function renderChat() {
  const box = document.getElementById('chat');
  const wrap = document.getElementById('chatwrap');
  if (!box || !wrap) return;
  wrap.style.display = chatLines.length ? '' : 'none';
  box.innerHTML = '';
  chatBuilt = chatLines.length > 0;
  chatCursor = -1;
  chatStick = true;
  if (!chatBuilt) return;
  chatLines.forEach(c => {
    const row = document.createElement('div');
    // Every row starts UNSENT, which the stylesheet hides; updateChat reveals
    // them as the playhead reaches them. That is why chatCursor starts at -1.
    row.className = 'chatrow future';
    const tag = CHAT_DEST_TAG[c.d];
    row.innerHTML =
      `<span class="chattime">${escapeHtml(fmtTime(c.f / 30))}</span>` +
      (tag ? `<span class="chattag">${escapeHtml(tag)}</span>` : '') +
      `<b style="color:${escapeHtml(commColor(c.p))}">${escapeHtml(commName(c))}</b> ` +
      `<span>${escapeHtml(c.t)}</span>`;
    row.title = 'Jump to ' + fmtTime(c.f / 30);
    row.addEventListener('click', () => {
      if (data.sampleEvery > 0) go(Math.round(c.f / data.sampleEvery));
    });
    box.appendChild(row);
  });
  // Assignment rather than addEventListener: #chat outlives every replay load,
  // and stacking a handler per load would be a slow leak.
  box.onscroll = () => {
    chatStick = box.scrollHeight - box.scrollTop - box.clientHeight <= CHAT_STICK_SLACK;
  };
}

// updateChat reveals the rows the playhead has now reached and keeps the box
// parked at the bottom. It runs on every playback tick, so it exits immediately
// unless the boundary actually moved.
function updateChat(f) {
  if (!chatBuilt) return;
  let cursor = -1;
  for (let i = 0; i < chatLines.length && chatLines[i].f <= f; i++) cursor = i;
  if (cursor === chatCursor) return;
  const box = document.getElementById('chat');
  const rows = box.children;
  // Only the rows that changed side of the boundary need touching — scrubbing
  // backwards hides them again just as cheaply.
  const lo = Math.min(chatCursor, cursor) + 1, hi = Math.max(chatCursor, cursor);
  for (let i = lo; i <= hi && i < rows.length; i++) {
    rows[i].classList.toggle('future', i > cursor);
  }
  chatCursor = cursor;
  if (chatStick) box.scrollTop = box.scrollHeight;
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
  if (ovcv) {
    ovcv.width = Math.round(viewW * DPR);
    ovcv.height = Math.round(viewH * DPR);
    ovcv.style.width = viewW + 'px';
    ovcv.style.height = viewH + 'px';
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

  // Damage flashes tint the icons themselves (GL: per-instance tint; 2D: a
  // red glyph blended over). Prune expired ones first, and keep redraws
  // coming while any are pending/fading — staggered starts fire and fades
  // animate even if playback pauses mid-interval. Free when the map is empty.
  if (damageFlash.size > 0) {
    pruneFlashes(performance.now());
    if (damageFlash.size > 0) scheduleDraw();
  }

  // GL icon pass first: it reports which units still need the 2D dot fallback
  // (bitmaps not in the atlas yet), which the base layer below must paint.
  const glActive = !!(glr && showIcons && u);
  let glFallback = null;
  if (glActive) glFallback = glBuildInstances(u);
  if (glr) glRender(glActive);

  // Build lines + construction bars: every tick, before the base layer's
  // repaint-skip below (they animate even when the base layer doesn't).
  drawOverlay(u);

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
  if (ghostBuildings.size > 0) {
    ctx.globalAlpha = GHOST_ALPHA;
    for (const g of ghostBuildings.values()) {
      const sx = viewW / 2 + (g.x - center.x) * scale;
      const sy = viewH / 2 + (g.z - center.z) * scale;
      if (sx < -8 || sy < -8 || sx > viewW + 8 || sy > viewH + 8) continue;
      ctx.fillStyle = teamColor[g.team] || '#9aa6b2';
      ctx.beginPath();
      ctx.arc(sx, sy, rad, 0, 7);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
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
// Ghost buildings for the 2D path: the normal team-tinted glyph at
// GHOST_ALPHA, drawn before the live units so they sit underneath.
function drawGhosts2D() {
  if (ghostBuildings.size === 0) return;
  ctx.globalAlpha = GHOST_ALPHA;
  for (const g of ghostBuildings.values()) {
    const info = defIcon.get(g.def);
    if (!info) continue;
    const px = Math.round(iconPxFor(g.def));
    const r = px / 2;
    const sx = viewW / 2 + (g.x - center.x) * scale;
    const sy = viewH / 2 + (g.z - center.z) * scale;
    if (sx < -px || sy < -px || sx > viewW + px || sy > viewH + px) continue;
    const glyph = renderIcon(info.p, teamColor[g.team] || '#9aa6b2', px);
    if (!glyph) continue;
    const dx = Math.round((sx - r) * DPR) / DPR;
    const dy = Math.round((sy - r) * DPR) / DPR;
    ctx.drawImage(glyph, dx, dy, px, px);
  }
  ctx.globalAlpha = 1;
}

function drawIcons2D(u) {
  drawGhosts2D();
  const pxMemo = new Map();     // def -> rounded CSS px this draw
  const glyphMemo = new Map();  // def*4096+team -> canvas or null
  // Damage flash: a flash-coloured copy of the glyph (renderIcon caches it
  // like any team glyph) blended over the icon at the flash intensity. Team
  // ids are u8, so pseudo-teams 4095/4094/4093 are free memo slots for the
  // red/white/dark variants (indexed by the team's FLASH_TARGETS entry).
  const fNow = damageFlash.size > 0 ? performance.now() : 0;
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
      if (fNow) {
        const k = flashK(u[i + F.ID], fNow);
        if (k > 0) {
          const target = flashTargetOf.get(team) || 0;
          const fk = def * 4096 + (4095 - target);
          let fg = glyphMemo.get(fk);
          if (fg === undefined) {
            const info = defIcon.get(def);
            fg = info ? renderIcon(info.p, FLASH_TARGETS[target].css, px) : null;
            glyphMemo.set(fk, fg);
          }
          if (fg) {
            ctx.globalAlpha = FLASH_STRENGTH * k;
            ctx.drawImage(fg, dx, dy, px, px);
            ctx.globalAlpha = 1;
          }
        }
      }
    } else {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(sx, sy, Math.max(1.5, r * 0.5), 0, 7);
      ctx.fill();
    }
  }
}

// ---- build-lines + construction-progress overlay ---------------------------
// Yellow lines from each construction unit (cons, commander, nano turret,
// factory, ...) to the unit it is currently building or assisting (the frame
// array's TARGET column), plus a small progress bar under every unit whose
// BUILD column is below finished. Both endpoints interpolate with the units,
// so this redraws on every animation tick — on #ovcv, above the icon layers.
// Empty for codec v4 replays (their columns decode to finished/none).
function drawOverlay(u) {
  if (!octx) return;
  octx.setTransform(DPR, 0, 0, DPR, 0, 0);
  octx.clearRect(0, 0, viewW, viewH);
  // Map drawings live here too: they are world-space and time-dependent (marks
  // fade out and get erased), so they repaint with the build lines rather than
  // with the cached base layer. They exist independently of the frame data, so
  // they draw even while a chunk is still streaming in.
  // Fractional: renderFrac is the sub-sample position the units are already
  // interpolated to. Passing the integer sample frame made every fade step
  // once per SECOND of game time (the sampling rate) instead of per rendered
  // frame, which at 1x is a visible stutter rather than a fade.
  const simFrame = frameNumAt(idx) + renderFrac * (data.sampleEvery || 30);
  if (marks.length) drawMarks(simFrame);
  if (!u) return;

  // Cheap scan first: most frames have far fewer builders/under-construction
  // units than units, and many replays (v4) have none at all.
  let anyLine = false, anyBar = false;
  for (let i = 0; i < u.length; i += STRIDE) {
    if (u[i + F.TARGET] !== 0) anyLine = true;
    if (u[i + F.BUILD] < BUILD_DONE) anyBar = true;
    if (anyLine && anyBar) break;
  }

  if (showBuildLines && anyLine) {
    // id -> base offset in u, to look the target's position up.
    const off = new Map();
    for (let i = 0; i < u.length; i += STRIDE) off.set(u[i + F.ID], i);
    octx.strokeStyle = 'rgba(255, 214, 0, 0.8)';
    octx.lineWidth = 1.2;
    octx.beginPath();
    for (let i = 0; i < u.length; i += STRIDE) {
      const tid = u[i + F.TARGET];
      if (tid === 0) continue;
      const j = off.get(tid);
      if (j === undefined) continue; // target not in this frame (died/unseen)
      let p = interpPos(u, i); // shared scratch: copy before the second call
      const ax = viewW / 2 + (p[0] - center.x) * scale;
      const ay = viewH / 2 + (p[1] - center.z) * scale;
      p = interpPos(u, j);
      const bx = viewW / 2 + (p[0] - center.x) * scale;
      const by = viewH / 2 + (p[1] - center.z) * scale;
      if ((ax < 0 && bx < 0) || (ay < 0 && by < 0) ||
        (ax > viewW && bx > viewW) || (ay > viewH && by > viewH)) continue;
      octx.moveTo(ax, ay);
      octx.lineTo(bx, by);
    }
    octx.stroke();
  }

  if (anyBar) {
    for (let i = 0; i < u.length; i += STRIDE) {
      const b = u[i + F.BUILD];
      if (b >= BUILD_DONE) continue;
      const bv = interpBuild(u, i);
      const p = interpPos(u, i);
      const sx = viewW / 2 + (p[0] - center.x) * scale;
      const sy = viewH / 2 + (p[1] - center.z) * scale;
      const px = iconPxFor(u[i + F.DEF]); // bar tracks the icon's screen size
      const w = Math.max(10, px * 0.9), h = 3;
      const x = sx - w / 2, y = sy + px / 2 + 2;
      if (x + w < 0 || y + h < 0 || x > viewW || y > viewH) continue;
      octx.fillStyle = 'rgba(8, 12, 16, 0.7)';
      octx.fillRect(x, y, w, h);
      octx.fillStyle = '#5ad35a';
      octx.fillRect(x, y, w * Math.min(1, bv / BUILD_DONE), h);
    }
  }

  // Speech last: nothing should paint over a message.
  drawChatBubbles(simFrame, u);
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
// Growth ceiling. BAR's icons are 128px, so a 2048 atlas holds ~181 of them
// (144px cells) — plenty for a stock game, far short of a modded one, where the
// scavenger/extra-unit def tables push a replay to 300-650 distinct bitmaps.
// Doubling to 4096 holds ~784 and covers every replay measured, at 4x the VRAM
// (~67 MB plus the capped mip chain), which is why the atlas starts small and
// only grows when a replay actually runs out of slots. 8192 is not offered: a
// quarter-gigabyte texture is a worse answer than a few dots.
const ATLAS_MAX = 4096;
// Largest cell an icon may occupy: oversized bitmaps pack DOWNSCALED. Four of
// BAR's icons are 256px where the other 820 are 128; packed native they turn a
// whole shelf row 256 tall and cost ~150 slots, which buys detail nothing can
// see — an icon draws at ICON_MAX_PX (200) at the very largest, and every other
// icon in the game is already a 128px source at that size. Capping also keeps
// the shelf a uniform grid, so capacity no longer depends on packing order.
const ATLAS_CELL = 128;
const ATLAS_PAD = 16;    // gap between packed icons: keeps mip levels 0-4 from bleeding
const INST_FLOATS = 11;  // per instance: cx cy size u0 v0 u1 v1 r g b alpha

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
layout(location=5) in float alpha;   // instance: opacity (ghost buildings < 1)
uniform vec2 viewSize;               // canvas size, device px
out vec2 uv;
out vec3 vTint;
out float vAlpha;
void main() {
  vec2 p = center + corner * size;
  gl_Position = vec4(p.x / viewSize.x * 2.0 - 1.0, 1.0 - p.y / viewSize.y * 2.0, 0.0, 1.0);
  uv = mix(uvRect.xy, uvRect.zw, corner + 0.5);
  vTint = tint;
  vAlpha = alpha;
}`;
  const fs = `#version 300 es
precision mediump float;
in vec2 uv;
in vec3 vTint;
in float vAlpha;
uniform sampler2D tex;
out vec4 o;
void main() {
  vec4 t = texture(tex, uv);
  // atlas is premultiplied: rgb already carries alpha, so the instance
  // opacity scales rgb and a together.
  o = vec4(t.rgb * vTint, t.a) * vAlpha;
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
  attr(1, 2, 0); attr(2, 1, 2); attr(3, 4, 3); attr(4, 3, 7); attr(5, 1, 10);
  gl.bindVertexArray(null);

  const ac = document.createElement('canvas');
  ac.width = ac.height = ATLAS_SIZE;
  const atlas = {
    canvas: ac,
    ctx: ac.getContext('2d'),
    tex: gl.createTexture(),
    size: ATLAS_SIZE,
    // Never grow past what this GPU accepts; WebGL2 only guarantees 2048, in
    // which case the atlas simply cannot grow.
    max: Math.min(ATLAS_MAX, gl.getParameter(gl.MAX_TEXTURE_SIZE)),
    slots: new Map(), // icon path -> {u0,v0,u1,v1}, or null (atlas full at max size)
    x: ATLAS_PAD, y: ATLAS_PAD, rowH: 0,
    dirty: false,
    full: false,
    gen: 0, // bumped by growAtlas; every uv rect handed out before it is stale
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

// atlasPlace packs one loaded bitmap onto the current shelf, returning its uv
// rect — or null when the atlas has no room left at its present size. Rects are
// normalized by that size, so every one of them is invalidated by a resize (see
// growAtlas).
function atlasPlace(a, img) {
  const k = Math.min(1, ATLAS_CELL / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k);
  if (a.x + w + ATLAS_PAD > a.size) { a.x = ATLAS_PAD; a.y += a.rowH + ATLAS_PAD; a.rowH = 0; }
  if (a.y + h + ATLAS_PAD > a.size || w + 2 * ATLAS_PAD > a.size) return null;
  a.ctx.drawImage(img, a.x, a.y, w, h);
  const s = { u0: a.x / a.size, v0: a.y / a.size, u1: (a.x + w) / a.size, v1: (a.y + h) / a.size };
  a.x += w + ATLAS_PAD;
  if (h > a.rowH) a.rowH = h;
  a.dirty = true;
  return s;
}

// growAtlas doubles the atlas and re-packs everything already in it, returning
// false once the ceiling (ATLAS_MAX, or this GPU's limit) is reached. Every
// existing uv rect is normalized by the old size, so growing MUST recompute all
// of them — hence the full re-pack rather than a copy of the old canvas.
// Previously-overflowed paths are re-packed too: their slots hold null, and
// clearing the map gives them the room that was missing. Costs one canvas
// resize plus ~200 drawImages, once, on the first replay that needs it.
function growAtlas(a) {
  if (a.size >= a.max) return false;
  a.size *= 2;
  a.canvas.width = a.canvas.height = a.size; // resizing also clears the canvas
  a.x = ATLAS_PAD; a.y = ATLAS_PAD; a.rowH = 0;
  a.full = false;
  const paths = [...a.slots.keys()];
  a.slots.clear();
  for (const p of paths) {
    const img = getImage(p);
    // A path whose bitmap is gone (still loading, or failed and awaiting a
    // retry) is simply left out; it packs itself when it next draws.
    if (img === null || !img.complete || !img.naturalWidth) continue;
    const s = atlasPlace(a, img);
    if (s) a.slots.set(p, s);
  }
  a.dirty = true;
  a.gen++;
  console.info(`icon atlas grown to ${a.size}px (${a.slots.size} icons re-packed)`);
  return true;
}

// atlasSlot returns the atlas uv rect for an icon path: undefined while the
// bitmap is unavailable (still loading, or failed and awaiting a retry — the
// caller falls back to a dot for those frames, exactly like the 2D path), null
// once it is known it can never be packed (the atlas is full at its maximum
// size). Icons pack on a simple shelf layout at up to ATLAS_CELL; the atlas
// canvas re-uploads (with fresh mipmaps) on the draw after new icons land — a
// handful of times right after load, then never again.
//
// Slots are NOT cleared between replays: it is one BAR icon set, so switching
// replays mostly re-uses what is already packed. The ceiling is therefore the
// union of every icon seen this session (784 slots against 828 icons in the
// whole game) — reachable only by browsing many replays with disjoint unit
// sets, and it announces itself in the console if it ever happens.
function atlasSlot(path) {
  const a = glr.atlas;
  const s = a.slots.get(path);
  if (s !== undefined) return s;
  const img = getImage(path);
  if (img === null || !img.complete || !img.naturalWidth) return undefined;
  let rect = atlasPlace(a, img);
  if (!rect && growAtlas(a)) rect = atlasPlace(a, img);
  if (!rect && !a.full) {
    a.full = true;
    console.warn(`icon atlas full at ${a.size}px; overflow icons draw as dots`);
  }
  a.slots.set(path, rect || null);
  return rect || null;
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
//
// Packing happens lazily inside the build, so the atlas can GROW halfway
// through one — which renormalizes every uv rect and invalidates the ones
// already written into the buffer (and memoized) above the growth point. The
// generation counter catches that and rebuilds the frame from scratch; growth
// is a once-per-session event, so the repeat costs nothing in practice.
function glBuildInstances(u) {
  const gen = glr.atlas.gen;
  const fb = buildInstances(u);
  return glr.atlas.gen === gen ? fb : buildInstances(u);
}

function buildInstances(u) {
  const memo = new Map(); // def -> {px, rect}; both constant per def per draw
  let inst = glr.inst;
  const needed = (u.length / STRIDE + ghostBuildings.size) * INST_FLOATS;
  if (inst.length < needed) inst = glr.inst = new Float32Array(needed * 2);
  // Damage flash rides the per-instance tint (free — the floats are written
  // every frame anyway): a flashing unit's tint blends toward FLASH_TINT.
  const fNow = damageFlash.size > 0 ? performance.now() : 0;
  let n = 0;
  let fb = null;
  // Ghost buildings first, so live icons draw over them. No dot fallback for
  // a ghost whose bitmap isn't in the atlas yet — it appears a beat later.
  for (const g of ghostBuildings.values()) {
    const info = defIcon.get(g.def);
    const rect = info ? atlasSlot(info.p) : null;
    if (!rect) continue;
    const px = iconPxFor(g.def);
    const sx = viewW / 2 + (g.x - center.x) * scale;
    const sy = viewH / 2 + (g.z - center.z) * scale;
    if (sx < -px || sy < -px || sx > viewW + px || sy > viewH + px) continue;
    const tint = teamTint.get(g.team) || GRAY_TINT;
    const o = n * INST_FLOATS;
    inst[o] = sx * DPR; inst[o + 1] = sy * DPR; inst[o + 2] = px * DPR;
    inst[o + 3] = rect.u0; inst[o + 4] = rect.v0; inst[o + 5] = rect.u1; inst[o + 6] = rect.v1;
    inst[o + 7] = tint[0]; inst[o + 8] = tint[1]; inst[o + 9] = tint[2];
    inst[o + 10] = GHOST_ALPHA;
    n++;
  }
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
    let tr = tint[0], tg = tint[1], tb = tint[2];
    if (fNow) {
      const k = flashK(u[i + F.ID], fNow) * FLASH_STRENGTH;
      if (k > 0) {
        const ft = FLASH_TARGETS[flashTargetOf.get(u[i + F.TEAM]) || 0].tint;
        tr += (ft[0] - tr) * k;
        tg += (ft[1] - tg) * k;
        tb += (ft[2] - tb) * k;
      }
    }
    const o = n * INST_FLOATS;
    inst[o] = sx * DPR; inst[o + 1] = sy * DPR; inst[o + 2] = px * DPR;
    inst[o + 3] = rect.u0; inst[o + 4] = rect.v0; inst[o + 5] = rect.u1; inst[o + 6] = rect.v1;
    inst[o + 7] = tr; inst[o + 8] = tg; inst[o + 9] = tb;
    inst[o + 10] = 1;
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
// Returns the base index of the closest live unit within the pick radius, a
// {id, g} pair when the closest pick is a ghost building, or null. Ghosts
// compete on the same distance, so whichever marker is actually nearer wins.
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
  let bestGhost = null;
  for (const [id, g] of ghostBuildings) {
    const sx = viewW / 2 + (g.x - center.x) * scale;
    const sy = viewH / 2 + (g.z - center.z) * scale;
    const dx = sx - mouse.x, dy = sy - mouse.y;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; bestGhost = { id, g }; }
  }
  if (bestGhost) return bestGhost;
  return best >= 0 ? best : null;
}

// A unit's display label: the human-readable name ("Construction Bot") when the
// capture recorded one, else the internal name ("armck"). Older bundles carry no
// unitNames map at all, so the fallback chain is the whole compatibility story.
function defName(def) {
  return (data.unitNames && data.unitNames[def]) || defCode(def);
}

// The internal def name — the icon/footprint lookup key, and the tooltip's
// secondary line for anyone who thinks in unit codes.
function defCode(def) {
  return (data.unitDefs && data.unitDefs[def]) || `def ${def}`;
}

function updateTooltip() {
  if (!mouse || drag) { tooltip.style.display = 'none'; return; }
  const hit = hitTest();
  if (hit === null) { tooltip.style.display = 'none'; return; }
  let def, id, team, x, z, hp, maxHp, ghost = false;
  if (typeof hit === 'object') {
    // A ghost building: last-known state from when it slipped out of view.
    const g = hit.g;
    id = hit.id;
    ({ def, team, x, z, hp, maxHp } = g);
    ghost = true;
  } else {
    const u = data.frames[dispIdx].u;
    def = u[hit + F.DEF]; id = u[hit + F.ID]; team = u[hit + F.TEAM];
    x = u[hit + F.X]; z = u[hit + F.Z];
    hp = u[hit + F.HP]; maxHp = u[hit + F.MAXHP];
  }
  const frac = maxHp > 0 ? Math.max(0, Math.min(1, hp / maxHp)) : 1;
  const col = frac > 0.5 ? '#6fd07f' : (frac > 0.25 ? '#f2cf5b' : '#e2785b');
  // The heading names the unit, keeping the internal code beside it (dimmed) —
  // it is what BAR's own wiki/balance talk uses, and it is dropped when it is
  // the name (an old bundle with no human names at all).
  const name = defName(def), code = defCode(def);
  tooltip.innerHTML =
    `<h3>${name}${code !== name ? `<span class="code">${code}</span>` : ''}</h3>` +
    (ghost ? `<div class="row"><span class="label">Status</span><span style="color:#8a98a6">ghost — last seen state</span></div>` : '') +
    `<div class="row"><span class="label">Unit</span><span>#${id}</span></div>` +
    `<div class="row"><span class="label">Team</span><span style="color:${teamColor[team] || '#fff'}">${teamNameById(team)}</span></div>` +
    `<div class="row"><span class="label">Position</span><span>${x}, ${z}</span></div>` +
    (maxHp > 0
      ? `<div class="row"><span class="label">Health</span><span>${hp} / ${maxHp}</span></div>` +
        `<div class="bar"><div style="width:${(frac * 100).toFixed(0)}%;background:${col};opacity:${ghost ? 0.55 : 1}"></div></div>`
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

// INCOME_WINDOW_SEC: the income meters scale against the largest income ANY team
// reached in this many game-seconds up to the playhead, rather than against the
// current frame's largest. A frame-local maximum re-scales every bar whenever the
// leader stalls for a sample, which is exactly the flicker that makes a list of
// bars unreadable; a trailing window still tracks the game's growth from a few
// metal/s in the opening to hundreds late on.
const INCOME_WINDOW_SEC = 60;
// Samples in the per-team sliding MINIMUM that despikes the peak. A one-sample
// burst is not an economy: reclaiming a fusion pays out ~3500 metal/s for a
// single frame against a 195/s income, and as a raw maximum that one frame
// became the scale for every player's bar for the next minute, squashing the
// whole column to slivers. A sliding minimum cannot be lifted by any burst
// shorter than its own length, so 3 samples (~3 s at 1 Hz) discards the reclaim
// pop while a real economy — which holds its rate across samples — passes
// through untouched.
const DESPIKE_SAMPLES = 3;

// incomePeaks returns {m, e} — the largest metal and energy income any team in
// `teams` SUSTAINED over the window ending at simFrame. Metal and energy scale
// SEPARATELY: they differ by an order of magnitude, so one shared maximum would
// flatten every metal bar to nothing. Only the SCALE is despiked; the number on
// each row stays the raw current income, so a burst still shows itself (with its
// bar clamped to full) instead of being hidden.
//
// `teams` is the set of teams that actually get a row, and passing it is not
// defensive tidiness: the economy records also carry BAR's Gaia/scavenger team,
// which runs a hardcoded 1,000,000 metal AND energy per second (its stock reads
// 1000000/1000000 all game). Scaling against every team in the record therefore
// measured real 8v8 economies against an infinite one and drew every player a
// bar ~0.02% wide, in exactly those games that have such a team — which is why
// it looked intermittent. The scale must come from the same set of players the
// bars are drawn for, so the leader among them always reads full.
//
// Walks the window oldest -> newest, keeping each team's last DESPIKE_SAMPLES
// incomes so the minimum slides with it — and PRIMING that slide with the
// DESPIKE_SAMPLES-1 samples immediately before the window. The priming is not a
// detail: without it the window's first samples take the minimum of a partial
// history, so a spike survives while it sits at the leading edge — the same
// squashed column as before, appearing a minute after the burst as it ages into
// that position. Only samples inside the window contribute to the peak. At the
// very start of a replay there is nothing to prime with, and a partial minimum
// is then right anyway: nothing yet distinguishes a spike from an economy.
function incomePeaks(simFrame, teams) {
  const peak = { m: 0, e: 0 };
  if (!resByFrame || simFrame < 0 || !teams || !teams.size) return peak;
  const step = data.sampleEvery > 0 ? data.sampleEvery : 30;
  const samples = Math.max(1, Math.round(INCOME_WINDOW_SEC * 30 / step));
  const hist = new Map(); // team -> {m: [...], e: [...]}, oldest first
  for (let k = samples - 1 + (DESPIKE_SAMPLES - 1); k >= 0; k--) {
    const f = simFrame - k * step;
    if (f < 0) continue;
    const r = resByFrame.get(f);
    if (!r) continue;
    const priming = k > samples - 1;
    for (let i = 0; i < r.length; i += RSTRIDE) {
      const team = r[i + R.TEAM];
      if (!teams.has(team)) continue;
      let h = hist.get(team);
      if (h === undefined) hist.set(team, h = { m: [], e: [] });
      h.m.push(r[i + R.MINC]);
      h.e.push(r[i + R.EINC]);
      if (h.m.length > DESPIKE_SAMPLES) { h.m.shift(); h.e.shift(); }
      if (priming) continue;
      const m = Math.min(...h.m), e = Math.min(...h.e);
      if (m > peak.m) peak.m = m;
      if (e > peak.e) peak.e = e;
    }
  }
  return peak;
}

// Player list: rank, flag, OS (skill), name — then the metal and energy meters
// side by side, one line per player — grouped by ally team. Economy comes from
// the current frame's per-team
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

  // The meters scale among the rows that exist, so the peak is taken over
  // exactly the teams below and no others (see incomePeaks: the records also
  // carry Gaia/scavengers, on an infinite economy).
  const peaks = incomePeaks(fr ? fr.f : -1, new Set(playing.map(p => p.team)));

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
    group.appendChild(playerRow(p, res[p.team], peaks));
  });

  if (specs.length) {
    const g = document.createElement('div');
    g.className = 'pgroup';
    g.innerHTML = `<div class="hint">Spectators ${specs.length}: ` +
      specs.map(s => escapeHtml(s.name)).join(', ') + '</div>';
    root.appendChild(g);
  }
}

function playerRow(p, r, peaks) {
  const row = document.createElement('div');
  row.className = 'prow';
  const color = teamColor[p.team] || '#c7d0d9';
  const rank = rankBadge(p);
  const flag = `<span class="flag">${flagEmoji(p.country)}</span>`;
  const os = `<span class="os">${p.skill ? p.skill.toFixed(1) : ''}</span>`;
  let html =
    `<div class="phead">${rank}${flag}${os}` +
    // Two meters on one line leave the name ~70px, so it ellipsizes often —
    // the title keeps the full name reachable.
    `<span class="pname" title="${escapeHtml(p.name)}" style="color:${color}">${escapeHtml(p.name)}</span></div>`;
  if (r) {
    html += '<div class="pres">' +
      resRow('metal', r.metal, r.mStore, r.mInc, peaks.m) +
      resRow('energy', r.energy, r.eStore, r.eInc, peaks.e) +
      '</div>';
  }
  row.innerHTML = html;
  return row;
}

// One resource line, holding BOTH readings of a resource in one slot: by default
// the per-second income over a bar as wide as that income is against `peak` (the
// largest any team sustained recently — see incomePeaks), so reading down the
// list ranks the economies without reading a single number; while the row is
// hovered, this player's current stock over their own storage cap, bar and
// number alike (`.prow:hover` in style.css swaps both halves together, so the
// bar never describes something the number doesn't). Banking-or-stalling is a
// real question, just not the one a player list is usually scanned for, which is
// why it costs a hover rather than the row's whole width.
function resRow(kind, cur, store, inc, peak) {
  const incFrac = peak > 0 ? Math.max(0, Math.min(1, inc / peak)) : 0;
  const storeFrac = store > 0 ? Math.max(0, Math.min(1, cur / store)) : 0;
  const incStr = (inc >= 0 ? '+' : '') + fmtNum(inc) + '/s';
  return `<div class="resrow ${kind}">` +
    '<span class="rmeter">' +
    `<i class="binc" style="width:${(incFrac * 100).toFixed(1)}%"></i>` +
    `<i class="bstore" style="width:${(storeFrac * 100).toFixed(1)}%"></i>` +
    `<b class="rinc">${incStr}</b>` +
    `<b class="rstore">${fmtNum(cur)}/${fmtNum(store)}</b>` +
    '</span></div>';
}

// ---- playback -------------------------------------------------------------
function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// The heavy sidebar (the player list and its economy bars) only depends on the
// integer keyframe, so it refreshes when idx changes, not every animation tick.
function updateSidebar() {
  const fr = dispIdx >= 0 ? data.frames[dispIdx] : null;
  document.getElementById('s_time').textContent = fr ? fmtTime(fr.t) : '—';
  document.getElementById('s_frame').textContent = fr ? fr.f : '—';
  document.getElementById('s_units').textContent = fr ? fr.n : '—';
  renderPlayers();
}

let lastTimeText = null; // skip the label write when nothing changed: it runs
let lastSliderPos = -1;  // every animation tick and costs style/layout
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
  // The thumb tracks the CONTINUOUS playhead, not the sample index. Writing the
  // index moved it once per SAMPLE — one wall-second apart at 1x, so the thumb
  // ticked along like a clock hand however smoothly everything else animated.
  // This does mean a DOM write per tick while playing, which the label above
  // still avoids; that is the price of the motion, on one small element.
  // Dragging is unaffected: the input handler rounds through go(), and this
  // writes the rounded position straight back, so a drag still lands on a whole
  // sample despite the slider's step="any".
  if (playPos !== lastSliderPos) {
    lastSliderPos = playPos;
    document.getElementById('slider').value = playPos;
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
  noteFrameAdvance();
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
  if (changed) { maybeUpdateSidebar(forceSidebar); buildNextPosMap(); updateChat(frameNumAt(idx)); }
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
document.getElementById('slider').oninput = e => { stopPlay(); go(+e.target.value); };
window.addEventListener('keydown', e => {
  if (e.target.tagName === 'SELECT') return;
  // A FOCUSED slider would step natively on top of this, and since it carries
  // step="any" (so the thumb can glide between samples during playback) the
  // browser's own arrow step is a hundredth of the whole timeline rather than
  // one frame. Suppressing it there leaves one frame per press, from here.
  const onSlider = e.target.id === 'slider';
  if (e.key === 'ArrowLeft') { stopPlay(); go(idx - 1); if (onSlider) e.preventDefault(); }
  else if (e.key === 'ArrowRight') { stopPlay(); go(idx + 1); if (onSlider) e.preventDefault(); }
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
  damageFlash.clear();
  ghostBuildings.clear();
  ghostIndex = new Map();
  marks = [];
  chatLines = [];
  chatBuilt = false;
  bubbleAnchor = new Map();
  bubbleExpiry = new Map();
  flashSeenIdx = -1;
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
  codecVer = data.codecVer || 4; // published v4 bundles keep playing
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
  buildCommanderDefs();
  buildDestroyedIndex();
  applyTeamColors();
  buildCommIndex();
  renderChat();      // after applyTeamColors: rows are coloured by the author's team
  lastTimeText = null;
  lastSliderPos = -1;
  secPerFrame = data.sampleEvery > 0 ? data.sampleEvery / 30 : 1;
  document.getElementById('subtitle').textContent =
    [data.gameId, data.mapName, data.gameVersion].filter(Boolean).join(' · ') || 'replay state viewer';
  initViewMark(data.gameId);   // best-effort, never blocks playback
  document.getElementById('slider').max = Math.max(0, data.frameCount - 1);
  idx = 0;
  playPos = 0;
  dispIdx = -1;
  // Pre-warm the icon set (only a few dozen distinct unit types per replay) so
  // they're ready on the first paint.
  Object.values(data.unitIcons || {}).forEach(info => getImage(info.p));
  loadMap(data.mapName, data.gameId);
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
// cross-origin use): /maps/<file> gives the map's extent, and
// /maps/<file>/texture-mq.jpg is the terrain image drawn behind the units.
const MAP_API = 'https://api.bar-rts.com';
// The API reports map width/height in map units; 1 map unit = 512 elmos.
const MAP_ELMOS_PER_UNIT = 512;

// mapFileGuess turns the capture's map name ("Supreme Isthmus v2.1") into the
// API's file-name form ("supreme_isthmus_v2.1").
//
// It is only a guess: the API keys maps on the *archive file name* the map's
// author uploaded, and that is not a function of the name in the startscript.
// It usually is the lowercased, underscored name (~85% of BAR's map list), but
// "Frozen_Ford_V2" keeps its capitals (`frozen_ford_v2` 404s), "Eye Of Horus
// 1.6" is stored as "Eye Of Horus_1.6" (spaces and all), and "Desolation v1" is
// just "desolation". resolveMapFile covers everything this can't spell.
function mapFileGuess(display) {
  return (display || '').trim().toLowerCase().replace(/ /g, '_');
}

// resolveMapFile returns the API's map record ({fileName,width,height,…}) for
// this replay, or null. It tries the cheap name guess first, and falls back to
// the map record embedded in the replay's own metadata (…/replays/<gameId>
// carries `Map`), which is authoritative — and also covers a capture with no
// map name at all (a `.brp` packed with `pack -no-demo`).
async function resolveMapFile(name, gameId) {
  const guess = mapFileGuess(name);
  if (guess) {
    const res = await fetch(MAP_API + '/maps/' + encodeURIComponent(guess));
    if (res.ok) return await res.json();
  }
  if (!gameId) return null;
  const res = await fetch(MAP_API + '/replays/' + encodeURIComponent(gameId));
  if (!res.ok) return null;
  return (await res.json()).Map || null;
}

// Fetch this replay's map extent + terrain texture straight from the BAR maps
// API, using the map name stored in the capture's meta. Best-effort: if the
// map is unknown or the API unreachable, the viewer just keeps the plain
// background (and falls back to unit bounds for the field extent).
async function loadMap(name, gameId) {
  const gen = loadGen; // ignore responses if the user switched replays mid-fetch
  mapW = mapH = 0;
  mapTex = null;
  let file = mapFileGuess(name);
  try {
    const info = await resolveMapFile(name, gameId);
    if (gen !== loadGen) return;
    if (info) {
      file = info.fileName || file;
      mapW = (info.width || 0) * MAP_ELMOS_PER_UNIT;
      mapH = (info.height || 0) * MAP_ELMOS_PER_UNIT;
    }
  } catch (_) { /* offline/unknown: keep unit-bounds extent, still try the texture */ }
  if (gen !== loadGen || !file) return;
  const img = new Image();
  img.crossOrigin = 'anonymous'; // the API sends CORS headers; keeps the canvas untainted
  img.onload = () => { if (gen !== loadGen) return; mapTex = img; draw(); };
  img.onerror = () => { /* no texture for this map: keep the plain background */ };
  img.src = MAP_API + '/maps/' + encodeURIComponent(file) + '/texture-mq.jpg';
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

// ---- replay list / home view ----------------------------------------------
// The catalog: [{id, rid, startUnix, durationSec, map, gameSize, sizeBytes}].
// Served by GET /api/replays (the worker's Durable Object table, or the Go viz
// server computing the same shape from the .brp files). /index.json (the live
// bucket / directory listing) is merged in so a replay whose files exist but
// which was never PUT into the catalog still shows up — and it is the whole
// fallback when /api/replays doesn't exist (old deployment, plain static host).
async function fetchReplayList() {
  const query = filterQuery();
  let catalog = [];
  let haveCatalog = false;
  try {
    const r = await fetch('/api/replays' + (query ? '?' + query : ''));
    if (r.ok) { catalog = await r.json(); haveCatalog = true; }
  } catch (_) { /* fall through to /index.json */ }

  // /index.json is NOT a file — the worker builds it per request by paging the
  // bucket's whole replays/ prefix (~3.4k objects: every head, keys, resources
  // and 64-sample chunk of every published revision, 1000 per round trip). It
  // costs ~1.5 s against the catalog's ~90 ms, and all it adds is replays whose
  // FILES exist but which were never registered in the catalog. So fetch it
  // only when it can change what is shown:
  //   - no catalog: it is the whole listing (old deployment / plain static host)
  //   - ?orphans=true: the admin bar's "Unregistered" button, an explicit ask
  // and never under a filter — a stub has no map, size, roster or settings, so
  // no filter can be true of it, and answering "8v8 on Supreme Isthmus" with
  // rows that are neither would be a lie.
  const wantFiles = !haveCatalog || (orphanMode() && query === '');
  let files = [];
  if (wantFiles) {
    try {
      const r = await fetch('/index.json');
      if (r.ok) files = await r.json();
    } catch (err) {
      if (!catalog.length) throw err;
    }
  }
  // Revisioned publishes are append-only, so the bucket accumulates every
  // <gameId>-<8 hex> revision ever uploaded; the catalog's rid names the
  // current one. Hide the listing's other revisions of a cataloged game —
  // an uncataloged upload (no row at all) still shows as a stub.
  const seen = new Set();
  const ids = new Set();
  for (const e of catalog) {
    seen.add(e.id);
    ids.add(e.id);
    if (e.rid) seen.add(e.rid);
  }
  for (const f of files) {
    if (seen.has(f.file)) continue;
    const m = /^(.+)-[0-9a-f]{8}$/.exec(f.file);
    if (m && ids.has(m[1])) continue; // a superseded revision, not its own replay
    catalog.push({ id: f.file, rid: null, startUnix: null, durationSec: null, map: null, gameSize: null, sizeBytes: f.size ?? null });
  }
  return catalog;
}

// ---- catalog filters -------------------------------------------------------
// The filter bar narrows GET /api/replays server-side (the Worker's catalog is
// SQLite, indexed on each of these), so the list stays honest as the archive
// grows past what a page can hold. The controls' state lives in the PAGE URL —
// a filtered list is then shareable and survives a refresh, and openReplay's
// replayHref carries it into a replay so the back button returns to the same
// filtered list.
//
// The bar is shown only once /api/replays/facets answers: the Go viz server
// serves the same catalog shape from local files with no filtering behind it,
// and a filter bar that silently does nothing is worse than none.
const FILTER_KEYS = ['from', 'to', 'map', 'minPlayers', 'maxPlayers', 'player', 'settings'];
let facets = null;

// filterQuery renders the active filters as a query string (empty when none
// are set). Read from the URL, so it is the same source the controls restore
// from and there is no second copy of the state to drift.
function filterQuery() {
  const cur = new URLSearchParams(location.search);
  const out = new URLSearchParams();
  for (const k of FILTER_KEYS) {
    const v = (cur.get(k) ?? '').trim();
    if (v) out.set(k, v);
  }
  return out.toString();
}

// setFilter writes one control's value into the URL without a history entry
// (filtering is not navigation — the back button should leave the list, not
// step through every keystroke) and reloads the list.
function setFilter(key, value) {
  const u = new URL(location.href);
  if (value === '' || value === null || value === undefined) u.searchParams.delete(key);
  else u.searchParams.set(key, value);
  history.replaceState(null, '', u);
  reloadList();
}

let reloadSeq = 0;
async function reloadList() {
  const seq = ++reloadSeq;
  try {
    const list = await fetchReplayList();
    if (seq !== reloadSeq) return; // a newer filter change already went out
    replayList = list;
    renderHome();
  } catch (err) {
    if (seq !== reloadSeq) return;
    renderHome('Could not list replays: ' + err.message);
  }
}

// initFilters builds the bar from the catalog's facets (so every option offered
// matches at least one replay) and restores the controls from the URL. A
// backend without the endpoint leaves the bar hidden.
async function initFilters() {
  try {
    const r = await fetch('/api/replays/facets');
    if (!r.ok) return;
    facets = await r.json();
  } catch (_) { return; }

  const box = document.getElementById('filters');
  const cur = new URLSearchParams(location.search);
  const el = (id) => document.getElementById(id);

  const opt = (sel, value, text) => {
    const o = document.createElement('option');
    o.value = value; o.textContent = text;
    sel.appendChild(o);
  };
  const mapSel = el('f_map');
  mapSel.innerHTML = '';
  opt(mapSel, '', 'any');
  (facets.maps || []).forEach(m => opt(mapSel, m, m));
  mapSel.value = cur.get('map') ?? '';
  mapSel.onchange = () => setFilter('map', mapSel.value);

  // Size is one exact player count rather than a range: the sizes present are
  // few and far apart (8, 12, 16, 32, 50), so a range would mostly be a
  // clumsier way to pick one of them. The API keeps min/max, so a range stays
  // available to anyone who edits the URL.
  const sizeSel = el('f_size');
  sizeSel.innerHTML = '';
  opt(sizeSel, '', 'any');
  (facets.sizes || []).forEach(n => opt(sizeSel, String(n), `${n} players`));
  sizeSel.value = cur.get('minPlayers') ?? '';
  sizeSel.onchange = () => {
    const v = sizeSel.value;
    // Both bounds together: exactly this many players.
    const u = new URL(location.href);
    if (v === '') { u.searchParams.delete('minPlayers'); u.searchParams.delete('maxPlayers'); }
    else { u.searchParams.set('minPlayers', v); u.searchParams.set('maxPlayers', v); }
    history.replaceState(null, '', u);
    reloadList();
  };

  const from = el('f_from'), to = el('f_to');
  from.value = ymd(cur.get('from'), facets.from);
  to.value = ymd(cur.get('to'), facets.to);
  from.onchange = () => setFilter('from', from.value);
  to.onchange = () => setFilter('to', to.value);

  const player = el('f_player');
  player.value = cur.get('player') ?? '';
  const names = document.getElementById('f_players');
  names.innerHTML = '';
  (facets.players || []).forEach(n => {
    const o = document.createElement('option');
    o.value = n;
    names.appendChild(o);
  });
  // Typing filters on every keystroke, so debounce: each change is a query.
  let typing = null;
  player.oninput = () => {
    clearTimeout(typing);
    typing = setTimeout(() => setFilter('player', player.value.trim()), 300);
  };

  const chips = el('f_settings');
  chips.innerHTML = '';
  const active = new Set((cur.get('settings') ?? '').split(',').filter(Boolean));
  for (const flag of facets.settings || []) {
    // Hidden badges stay hidden here too: filtering by a flag the list never
    // shows would be filtering by something invisible.
    if (HIDDEN_SETTINGS.has(flag)) continue;
    const chip = document.createElement('span');
    chip.className = 'chip' + (active.has(flag) ? ' on' : '');
    chip.textContent = settingsLabel(flag);
    chip.onclick = () => {
      if (active.has(flag)) active.delete(flag); else active.add(flag);
      chip.classList.toggle('on');
      setFilter('settings', [...active].join(','));
    };
    chips.appendChild(chip);
  }

  el('f_clear').onclick = () => {
    const u = new URL(location.href);
    FILTER_KEYS.forEach(k => u.searchParams.delete(k));
    history.replaceState(null, '', u);
    initFilters();   // rebuild the controls from the now-empty URL
    reloadList();
  };

  // "Unregistered" toggles ?orphans=true, which is what makes the list pay for
  // the bucket scan (see fetchReplayList). It is NOT a filter param — the
  // server never sees it — so it stays out of FILTER_KEYS and out of the query.
  el('f_orphans').onclick = () => setFilter('orphans', orphanMode() ? '' : 'true');
  syncOrphanButton();

  box.style.display = '';
}

// orphanMode: ?orphans=true asks the list to include uploads that never made it
// into the catalog, at the cost of a full bucket listing.
function orphanMode() {
  return new URLSearchParams(location.search).get('orphans') === 'true';
}

// syncOrphanButton reflects the toggle's state, and disables it while a filter
// is active: an unregistered upload carries no metadata, so it could not match
// a filter anyway and the button would silently do nothing.
function syncOrphanButton() {
  const b = document.getElementById('f_orphans');
  if (!b) return;
  const filtered = filterQuery() !== '';
  b.classList.toggle('on', orphanMode());
  b.disabled = filtered;
  b.title = filtered
    ? 'Clear the filters first — an unregistered upload has no map, size or settings to match'
    : 'Scan the bucket for uploads that were never registered in the catalog (slow: reads every object)';
}

// ymd renders a filter date for an <input type=date>: the URL value when it is
// already YYYY-MM-DD, else nothing. `fallback` (a facet bound, in unix
// seconds) is deliberately NOT used as a value — prefilling the inputs with
// the catalog's own span would make every visit look filtered.
function ymd(urlValue, fallback) {
  const v = (urlValue ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  if (/^\d+$/.test(v)) return new Date(Number(v) * 1000).toISOString().slice(0, 10);
  return '';
}

// settingsLabel is the badge text for a settings flag, so a chip and the row
// badge it matches read the same.
function settingsLabel(flag) {
  const known = SETTINGS_BADGES.find(b => b[0] === flag);
  return known ? known[1] : flag;
}

// urlId is the id a replay's pieces are actually served under: the catalog
// row's current revision when it has one, the bare id otherwise.
function urlId(e) {
  return e.rid || e.id;
}

// knownReplayURL says whether a ?replay= value is worth loading: a listed
// replay, or any <gameId>-<8 hex> revision of a cataloged game — superseded
// revisions are hidden from the list but never deleted, so an old shared
// link keeps playing.
//
// replayList is no longer the whole catalog — it is what the current FILTERS
// matched, and it omits the uncataloged stubs unless something asked for them —
// so a miss here is not evidence that the replay does not exist. A well-formed
// id is therefore worth trying on its own: loadReplay fetches one head and
// reports a real failure if the bytes are not there, which beats silently
// dropping the visitor on the list with no explanation.
function knownReplayURL(wanted) {
  if (replayList.some(e => e.id === wanted || e.rid === wanted)) return true;
  const m = /^(.+)-[0-9a-f]{8}$/.exec(wanted);
  if (m && replayList.some(e => e.id === m[1])) return true;
  return /^[A-Za-z0-9_-]{1,128}$/.test(wanted);
}

let replayList = [];

function showHome() {
  stopPlay();
  document.body.classList.add('home');
  document.getElementById('home').style.display = '';
  document.getElementById('subtitle').textContent = 'replay state viewer';
  document.getElementById('viewmark').style.display = 'none';
  renderHome();
}

// ---- point-of-view marking -------------------------------------------------
// A capture is either a spectator's (every team visible) or one player's (their
// side plus whatever it scouted). The .brp records this only for captures made
// by widget versions that write the recorder fields; for everything else it is
// unknowable after the fact, so the header offers an explicit marking. The
// control writes POST /api/replays/<id>/view, which only the Worker backend
// implements — the Go dev server serves the same catalog read-only, so a
// missing route disables the control rather than looking broken.

function viewLabel(view, ally) {
  if (view === 'full') return 'sees all teams';
  if (view === 'ally') return 'ally ' + ally;
  if (view === 'unknown') return 'unknown';
  return 'not marked';
}

// initViewMark fills the select from the replay's own ally teams and shows the
// current marking. gameId is the BARE catalog id (rows are keyed by it, not by
// the revisioned id the pieces are served under). Admin-only (?admin=true),
// like the list's settings-refresh button: it rewrites a row every viewer
// shares, so it is maintenance, not a per-visitor viewing preference.
async function initViewMark(gameId) {
  const box = document.getElementById('viewmark');
  const sel = document.getElementById('viewsel');
  const status = document.getElementById('viewstatus');
  if (!adminMode()) { box.style.display = 'none'; return; }
  box.style.display = '';
  status.className = '';
  status.textContent = '';

  const allies = [...new Set((data.teams || []).map(t => t.ally))].sort((a, b) => a - b);
  sel.innerHTML = '';
  const opt = (value, text) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = text;
    sel.appendChild(o);
  };
  opt('', '— not marked —');
  opt('full', 'Spectator — sees all teams');
  allies.forEach(a => opt('ally:' + a, 'One side — ally ' + a));
  opt('unknown', 'Unknown');

  let row = null;
  try {
    const r = await fetch('/api/replays');
    if (r.ok) row = (await r.json()).find(e => e.id === gameId) || null;
  } catch { /* offline or no catalog: leave the control at "not marked" */ }

  if (!row) {
    // No catalog row means nothing to write to (an uploaded-but-unregistered
    // replay), so offer nothing rather than a control that always 404s.
    box.style.display = 'none';
    return;
  }
  sel.value = row.view === 'ally' ? 'ally:' + row.uploaderAlly : (row.view || '');
  status.textContent = sel.value === '' ? '' : '✓';

  sel.onchange = async () => {
    const v = sel.value;
    if (v === '') return;                       // the placeholder is not a marking
    const body = v.startsWith('ally:')
      ? { view: 'ally', ally: Number(v.slice(5)) }
      : { view: v };
    status.className = '';
    status.textContent = 'saving…';
    sel.disabled = true;
    try {
      const r = await fetch(`/api/replays/${encodeURIComponent(gameId)}/view`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (r.ok) {
        status.className = 'ok';
        status.textContent = '✓ ' + viewLabel(body.view, body.ally);
      } else {
        const e = await r.json().catch(() => ({}));
        status.className = 'err';
        status.textContent = r.status === 404 ? 'not supported here' : (e.error || `HTTP ${r.status}`);
      }
    } catch (err) {
      status.className = 'err';
      status.textContent = String(err);
    } finally {
      sel.disabled = false;
    }
  };
}

function hideHome() {
  document.body.classList.remove('home');
  document.getElementById('home').style.display = 'none';
}

function renderHome(errMsg) {
  const tbody = document.querySelector('#hometable tbody');
  const msg = document.getElementById('homemsg');
  tbody.textContent = '';
  for (const e of replayList) {
    const tr = document.createElement('tr');
    // Every cell holds a real link to the replay's URL, so the row behaves
    // like an <a>: middle/ctrl/cmd-click opens a new tab, right-click offers
    // "open in new tab", and a plain click is intercepted below for SPA
    // navigation (pushState, so the back button returns to this list).
    const href = replayHref(urlId(e));
    const cell = (text, cls) => {
      const td = document.createElement('td');
      if (cls) td.className = cls;
      if (text == null) td.classList.add('dim');
      const a = document.createElement('a');
      a.href = href;
      a.textContent = text ?? '—';
      td.appendChild(a);
      tr.appendChild(td);
    };
    cell(e.startUnix ? fmtDate(e.startUnix) : null);
    cell(e.durationSec != null ? fmtDuration(e.durationSec) : null);
    cell(e.map, 'map');
    cell(e.gameSize);
    // Players: each side's top names by OS — three per side for a two-team
    // game, one when there are more sides. The side whose client recorded
    // the current upload is marked; the full known roster (with OS) rides
    // each side's tooltip.
    {
      const td = document.createElement('td');
      td.className = 'players';
      const a = document.createElement('a');
      a.href = href;
      const groups = Array.isArray(e.players) ? e.players : [];
      if (!groups.length) {
        td.classList.add('dim');
        a.textContent = '—';
      } else {
        const per = groups.length === 2 ? 3 : 1;
        groups.forEach((g, i) => {
          if (i) {
            const sep = document.createElement('span');
            sep.className = 'vs';
            sep.textContent = 'v';
            a.appendChild(sep);
          }
          const s = document.createElement('span');
          s.className = 'side';
          // Same per-ally colour family the viewer assigns (assignColors):
          // side i gets ALLY_HUES[i], groups being ally-ascending like there.
          s.style.color = `hsl(${ALLY_HUES[i % ALLY_HUES.length]} 62% 62%)`;
          const shown = (g.players || []).slice(0, per);
          let text = shown.map(p => p.name).join(', ');
          if (g.count > shown.length) text += ` +${g.count - shown.length}`;
          s.textContent = text;
          let tip = (g.players || [])
            .map(p => (p.os != null ? `${p.name} (${p.os.toFixed(1)})` : p.name))
            .join('\n');
          if (g.count > (g.players || []).length) tip += `\n+${g.count - g.players.length} more`;
          if (e.uploaderAlly != null && e.uploaderAlly === g.ally) {
            s.classList.add('uploader');
            tip += '\n◉ this side recorded the replay';
          }
          s.title = tip;
          a.appendChild(s);
        });
      }
      td.appendChild(a);
      tr.appendChild(td);
    }
    // External links for this game (class "ext" exempts them from the row's
    // SPA click handling — the browser follows them natively, in a new tab).
    {
      const td = document.createElement('td');
      td.className = 'links';
      const ext = [
        ['gex', 'https://gex.honu.pw/match/' + encodeURIComponent(e.id)],
        ['BAR', 'https://bar-rts.com/replays/' + encodeURIComponent(e.id)],
      ];
      for (const [label, url] of ext) {
        const a = document.createElement('a');
        a.className = 'ext';
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = label;
        td.appendChild(a);
      }
      // Other uploads of this game: every published revision except the
      // current one keeps playing at its own ?replay= (nothing is ever
      // deleted), labelled by the side that recorded it. Internal links —
      // the row click handler routes them through the SPA.
      const cur = urlId(e);
      for (const u of (e.uploads || [])) {
        if (!u.rid || u.rid === cur) continue;
        const a = document.createElement('a');
        a.className = 'alt';
        a.href = replayHref(u.rid);
        a.textContent = u.ally != null ? `alt·T${u.ally + 1}` : 'alt';
        a.title = 'another upload of this game' + (u.ally != null ? ` (recorded by team ${u.ally + 1})` : '');
        td.appendChild(a);
      }
      tr.appendChild(td);
    }
    // Settings badges (empty cell — not a dash — when the entry has none).
    {
      const td = document.createElement('td');
      td.className = 'settings';
      const a = document.createElement('a');
      a.href = href;
      for (const b of settingsBadges(e.settings)) {
        const s = document.createElement('span');
        s.className = 'badge badge-' + b.key.replace(/[^\w-]/g, '');
        s.textContent = b.label;
        a.appendChild(s);
      }
      td.appendChild(a);
      tr.appendChild(td);
    }
    cell(e.sizeBytes != null ? fmtSize(e.sizeBytes) : null, 'num data');
    // Admin column (?admin=true only): re-derive the row's settings badges
    // from the BAR API's stored modoptions, no repack/re-upload needed.
    {
      const td = document.createElement('td');
      td.className = 'admin';
      if (adminMode()) {
        const btn = document.createElement('button');
        btn.className = 'refresh';
        btn.textContent = '⟳';
        btn.title = 're-fetch game settings & players from the BAR API';
        btn.addEventListener('click', async (ev) => {
          ev.stopPropagation();
          btn.disabled = true;
          btn.textContent = '…';
          try {
            const r = await fetch(`/api/replays/${encodeURIComponent(e.id)}/refresh-settings`, { method: 'POST' });
            const body = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
            e.settings = body.settings;
            // players stays untouched when the API named nobody (the server
            // keeps the stored roster too).
            if (body.players) e.players = body.players;
            renderHome();
          } catch (err) {
            btn.disabled = false;
            btn.textContent = '⟳';
            renderHome(`settings refresh for ${e.id} failed: ${err.message || err}`);
          }
        });
        td.appendChild(btn);
      }
      tr.appendChild(td);
    }
    tr.addEventListener('click', (ev) => {
      // External links keep their native behaviour entirely; so does the
      // admin refresh button (its own handler stops propagation, this is
      // just belt and braces).
      if (ev.target.closest && ev.target.closest('a.ext, button.refresh')) return;
      // Only hijack a plain left-click; modified clicks keep the browser's
      // native link behaviour (new tab / new window).
      if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      ev.preventDefault();
      // An alternate-upload link opens ITS revision instead of the row's.
      const alt = ev.target.closest && ev.target.closest('a.alt');
      if (alt) {
        openReplay(new URL(alt.href, location.href).searchParams.get('replay'));
        return;
      }
      openReplay(urlId(e));
    });
    tbody.appendChild(tr);
  }
  document.body.classList.toggle('admin-mode', adminMode());
  syncOrphanButton();
  const filtered = filterQuery() !== '';
  const count = document.getElementById('f_count');
  if (count) count.textContent = `${replayList.length} ${filtered ? 'matching' : 'replays'}`;
  const text = errMsg || (replayList.length ? '' : (filtered
    ? 'No replays match these filters.'
    : 'No replays yet. Drop a .brepstream above, or upload one with: go run ./cmd/pack -upload r2 <capture>.'));
  msg.style.display = text ? '' : 'none';
  msg.textContent = text;
}

// adminMode: ?admin=true unlocks the maintenance controls — the list's
// settings-refresh button and the viewer header's POV marking, both of which
// edit a catalog row everyone else reads. Purely a UI gate — the endpoints
// behind it are their own authority.
function adminMode() {
  return new URLSearchParams(location.search).get('admin') === 'true';
}

// replayHref is the shareable URL for one replay: the current URL (so params
// like ?admin= and ?gl= carry over) with ?replay= set.
function replayHref(id) {
  const u = new URL(location.href);
  u.searchParams.set('replay', id);
  return u.pathname + u.search;
}

// The known settings flags (from the uploader's modoptions distillation) in
// display order, with their badge labels. A `true` third element renders the
// label alone even for a string-valued flag (the value is a lobby detail the
// list doesn't need); unknown keys fall back to "key: value" so a future flag
// is never silently dropped. The key also becomes a badge-<key> CSS class for
// per-flag colours (lava, mods).
const SETTINGS_BADGES = [
  ['ranked', 'ranked'],
  ['unranked', 'unranked'],
  ['lava', 'lava'],
  ['mods', 'mods'],
  ['zombies', 'zombies'],
  ['ruins', 'ruins'],
  ['quickStart', 'quick start', true],
  ['comBuilders', 'base builder', true],
  ['noNukes', 'no nukes'],
  ['noLrpc', 'no lrpc'],
  ['noEndgameLrpc', 'no endgame lrpc'],
];

// Flags the catalog records but the list deliberately doesn't badge (too
// common to be news). Kept in the data so this stays a display choice.
const HIDDEN_SETTINGS = new Set(['scavUnits', 'extraUnits', 'noAir']);

// settingsBadges turns a catalog entry's settings object into badges:
// [{key, label}]. Suppressions: the HIDDEN_SETTINGS flags never show,
// `mods` is implied noise next to lava/zombies (those game modes ship as
// tweak blobs, which is exactly what `mods` detects), and akumu zombies
// imply the lava — its badge already says it all.
function settingsBadges(settings) {
  if (!settings || typeof settings !== 'object') return [];
  const out = [];
  const seen = new Set(HIDDEN_SETTINGS);
  for (const [key, label, valueless] of SETTINGS_BADGES) {
    const v = settings[key];
    if (v === undefined || v === false) continue;
    const suppressed =
      (key === 'mods' && (settings.lava || settings.zombies)) ||
      (key === 'lava' && settings.zombies === 'akumu');
    if (suppressed) {
      seen.add(key); // suppressed, not unknown — keep it out of the fallback
      continue;
    }
    seen.add(key);
    out.push({ key, label: v === true || valueless ? label : `${label}: ${v}` });
  }
  for (const [key, v] of Object.entries(settings)) {
    if (seen.has(key) || v === false || v === undefined) continue;
    out.push({ key, label: v === true ? key : `${key}: ${v}` });
  }
  return out;
}

// ---- drag&drop publishing --------------------------------------------------
// A dropped .brepstream POSTs to /api/upload; the worker archives it and
// records an ingest job, the Go daemon publishes it, and we poll the job
// until the replay is ready to open. The same front-end also runs against
// backends without the upload API (the Go viz server, a plain static host) —
// there the attempt fails with a clear message.
const MAX_UPLOAD_BYTES = 64 << 20; // mirrors the worker's /api/upload cap

function initUpload() {
  const zone = document.getElementById('dropzone');
  const input = document.getElementById('dropfile');
  if (!zone || !input) return;

  // Neutralize the browser's default file-drop navigation everywhere, and
  // light the dropzone up while a drag is anywhere over the window.
  let depth = 0;
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (++depth === 1 && document.body.classList.contains('home')) zone.classList.add('drag');
  });
  window.addEventListener('dragleave', () => {
    if (--depth <= 0) { depth = 0; zone.classList.remove('drag'); }
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    zone.classList.remove('drag');
    if (!document.body.classList.contains('home')) return;
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) uploadStream(file);
  });
  input.addEventListener('change', () => {
    if (input.files[0]) uploadStream(input.files[0]);
    input.value = '';
  });
}

function uploadStatus(text, cls) {
  const el = document.getElementById('dropstatus');
  el.style.display = text ? '' : 'none';
  el.className = cls || '';
  el.textContent = text || '';
}

function uploadStream(file) {
  if (file.size > MAX_UPLOAD_BYTES) {
    uploadStatus(`${file.name} is too large (${fmtSize(file.size)}; the limit is ${fmtSize(MAX_UPLOAD_BYTES)})`, 'error');
    return;
  }
  // Wrong extensions still go through — the server sniffs the actual header.
  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/upload');
  xhr.responseType = 'json';
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) uploadStatus(`uploading ${file.name}… ${Math.round(100 * e.loaded / e.total)}%`);
  };
  xhr.onerror = () => uploadStatus('upload failed: network error', 'error');
  xhr.onload = () => {
    if (xhr.status === 404 || xhr.status === 405) {
      uploadStatus('this server does not accept uploads — publish with: go run ./cmd/pack -upload r2 <capture>', 'error');
      return;
    }
    const resp = xhr.response || {};
    if (xhr.status !== 200) {
      uploadStatus('upload rejected: ' + (resp.error || `HTTP ${xhr.status}`), 'error');
      return;
    }
    uploadStatus('uploaded — queued for processing…');
    pollUploadJob(resp.job, resp.gameId);
  };
  uploadStatus(`uploading ${file.name}…`);
  xhr.send(file);
}

// pollUploadJob follows the ingest job until the daemon reports done/error,
// then refreshes the list and opens the freshly published replay.
async function pollUploadJob(job, gameId) {
  const started = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    let j;
    try {
      const r = await fetch('/api/jobs/' + encodeURIComponent(job));
      if (!r.ok) continue;
      j = await r.json();
    } catch (_) {
      continue;
    }
    if (j.state === 'error') {
      uploadStatus('processing failed: ' + (j.error || 'unknown error'), 'error');
      return;
    }
    if (j.state === 'done') {
      uploadStatus('published', 'ok');
      try {
        replayList = await fetchReplayList();
        renderHome();
      } catch (_) { /* the replay still published; the list just didn't refresh */ }
      const e = replayList.find((x) => x.id === gameId) ||
        replayList.find((x) => x.id.startsWith(gameId + '-'));
      if (e) openReplay(urlId(e));
      return;
    }
    if (j.state === 'processing') {
      uploadStatus('processing…');
    } else if (Date.now() - started > 60_000) {
      uploadStatus('queued — waiting for the ingest daemon (the upload is safe and will be processed when it runs)…');
    }
  }
}

// openReplay leaves the home view and starts playback of one replay,
// PUSHING a history entry (navigation, not a tweak: back must return to
// where the user was — the list, or the previously watched replay).
function openReplay(id) {
  hideHome();
  if (new URLSearchParams(location.search).get('replay') !== id) {
    history.pushState(null, '', replayHref(id));
  }
  loadReplay(id);
}

async function init() {
  initGL(); // one-time; a null result just means the 2D icon path is used
  initUpload(); // wired before the list fetch so the dropzone works regardless
  initFilters(); // best-effort and independent: the list below reads the URL
  const params = new URLSearchParams(location.search);

  // Optional render-smoothness overlay, gated on ?debug=true.
  if (params.get('debug') === 'true') startFpsMonitor();

  // The header title returns to the replay list without a page reload.
  document.getElementById('homelink').onclick = (e) => {
    e.preventDefault();
    const u = new URL(location.href);
    u.searchParams.delete('replay');
    history.pushState(null, '', u);
    showHome();
  };

  try {
    replayList = await fetchReplayList();
  } catch (err) {
    showHome();
    renderHome('Could not list replays: ' + err.message);
    return;
  }
  // ?replay=<id> opens that replay directly (refresh / shared link); without
  // it the page is the replay list (the table IS the picker).
  const wanted = params.get('replay');
  if (wanted && knownReplayURL(wanted)) {
    hideHome();
    await loadReplay(wanted);
  } else {
    showHome();
  }
}

// Support browser back/forward and manual URL edits: no ?replay= means the
// replay list, anything else re-opens that replay.
window.addEventListener('popstate', () => {
  const wanted = new URLSearchParams(location.search).get('replay');
  if (!wanted) {
    showHome();
    return;
  }
  if (knownReplayURL(wanted)) {
    hideHome();
    if (wanted !== currentFile || !data) {
      loadReplay(wanted);
    }
  }
});

function fmtSize(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + ' MB';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + ' KB';
  return n + ' B';
}

// fmtDate renders a game's start moment in the viewer's locale/timezone.
function fmtDate(unix) {
  return new Date(unix * 1000).toLocaleString(undefined,
    { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// fmtDuration renders a game length as m:ss / h:mm:ss.
function fmtDuration(sec) {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
}

init();

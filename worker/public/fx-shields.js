// fx-shields.js — shields (Keeper/Overseer plasma deflectors, the T3 gates,
// Legion's deflector, the shielded evolving commanders) drawn on the replay
// map. A plain script loaded before app.js, sharing its globals (data,
// viewW, viewH, center, scale, F, STRIDE, interpPos, BUILD_DONE, varints,
// brpSections, loadGen, scheduleDraw); drawOverlay calls
// drawShields(c, simFrame, u) once per overlay paint, and loadReplay calls
// loadShields(file, gen).
//
// THE LOOK (Marcin's pick, "C"): the EDGE only, never a filled dome — the
// outline of the area a side's shields cover (overlapping shields of one ally
// team merge into one outline), coloured by charge, plus a small charge
// gauge round every generator, so a shield inside a cluster still shows its
// own. A shield that is down (drained, or switched off) protects nothing: it
// leaves the outline and is drawn as a dashed ring.
//
// CHEAP BY CONSTRUCTION: no per-pixel work. Shields are bucketed into
// SHIELD_STEPS colours and every arc of a bucket goes into ONE path, so 60
// shields are ~25 stroke() calls; the outline maths is O(n²) circle tests
// (60 shields: ~3600 cheap checks, well under a millisecond). What costs is
// the stroked length, so when the viewer's frame rate falls (SHIELD_SLOW_MS)
// the layer DROPS TO A SIMPLER LOOK on its own: the outline alone, one
// colour, one stroke — no halo, no gauges. It goes back after a stretch of
// fast frames, at most SHIELD_MAX_DROPS times per page, so a machine that is
// slow for other reasons settles on the simple look instead of flickering
// between the two. ?shields=full or ?shields=simple pins one, ?shields=off
// hides them.
//
// SOURCE: where a shield is comes from the frames; its reach and full charge
// from the capture's unit defs (shieldRadius/shieldPower, widget 1.10.0),
// else from SHIELD_DEFS below (static per BAR version); its CHARGE from the
// Q section — the widget's Spring.GetUnitShieldState readings, written when
// they move, held until the unit's next one. A capture without them (every
// replay before widget 1.10.0, and an uploader's enemies it could not read)
// shows the outline in a neutral colour and no gauge: unknown is not full.

// SHIELD_DEFS: unit name (a scavenger copy's "_scav" stripped) -> radius
// (elmos) and full charge, from beyond-all-reason/Beyond-All-Reason units/
// (2026-10-11): the units carrying customParams.shield_radius, which is what
// BAR's own shield drawing reads.
const SHIELD_DEFS = {
  armgate: { r: 550, p: 6175 },       // Keeper
  corgate: { r: 550, p: 6175 },       // Overseer
  legdeflector: { r: 550, p: 6175 },  // Legion deflector
  armfgate: { r: 600, p: 9500 },      // floating
  corfgate: { r: 600, p: 9500 },
  armgatet3: { r: 710, p: 24700 },
  leggatet3: { r: 710, p: 49400 },
  corgatet3: { r: 825, p: 66500 },
  legcomt2def: { r: 150, p: 1900 },
  corcomlvl2: { r: 100, p: 1900 },
  corcomlvl3: { r: 100, p: 6270 },
  corcomlvl4: { r: 100, p: 10450 },
  corcomlvl5: { r: 100, p: 13300 },
  corcomlvl6: { r: 100, p: 19000 },
  corcomlvl7: { r: 100, p: 24700 },
  corcomlvl8: { r: 100, p: 32300 },
  corcomlvl9: { r: 100, p: 43700 },
  corcomlvl10: { r: 100, p: 57000 },
};

const SHIELD_STEPS = 10;             // charge colour buckets
const SHIELD_UNKNOWN = SHIELD_STEPS; // the bucket of a shield with no reading
const SHIELD_LINE_PX = 1.5;          // outline width on screen
const SHIELD_DOWN_FRAC = 0.02;       // at or under this a shield is down
const SHIELD_PIP_PX = 9;             // charge gauge radius round a generator

// Frame-rate fallback. Intervals between paints longer than SHIELD_GAP_MS
// are a paused or idle viewer, not a slow one, and are not counted.
const SHIELD_SLOW_MS = 33;      // averaged paint interval that drops the look (~30 fps)
const SHIELD_FAST_MS = 20;      // ... and that may bring it back (~50 fps)
const SHIELD_SLOW_PAINTS = 45;  // paints the average must have seen first
const SHIELD_FAST_PAINTS = 300;
const SHIELD_MAX_DROPS = 2;     // after this many drops the simple look stays
const SHIELD_GAP_MS = 250;

const shieldPin = new URLSearchParams(location.search).get('shields'); // full | simple | off

// shieldRGB: BAR's ramp, brightened for a dark map — full is a pale
// blue-white, half amber, empty red.
function shieldRGB(frac) {
  const stops = [[255, 60, 40], [255, 190, 70], [225, 240, 255]];
  const t = frac * 2, i = Math.min(1, Math.floor(t)), k = t - i;
  const a = stops[i], b = stops[i + 1];
  return [a[0] + (b[0] - a[0]) * k | 0, a[1] + (b[1] - a[1]) * k | 0, a[2] + (b[2] - a[2]) * k | 0];
}
const SHIELD_COLORS = Array.from({ length: SHIELD_STEPS }, (_, b) => shieldRGB(b / (SHIELD_STEPS - 1)))
  .concat([[170, 200, 230]]); // SHIELD_UNKNOWN: a neutral steel blue
const shieldBucket = (frac) => Math.round(frac * (SHIELD_STEPS - 1));

// shieldDefTable maps def id -> {r, p} for the loaded replay (null = none).
let shieldDefFor = null, shieldDefData = null;
function shieldDefTable() {
  if (shieldDefData === data) return shieldDefFor;
  shieldDefData = data;
  shieldDefFor = null;
  const own = (data && data.shieldDefs) || {};
  const names = (data && data.unitDefs) || {};
  for (const k of Object.keys(names)) {
    const s = own[k] || SHIELD_DEFS[String(names[k]).replace(/_scav$/, '')];
    if (s) (shieldDefFor ||= {})[k] = s;
  }
  return shieldDefFor;
}

let shieldAllyData = null, shieldAllyMap = {};
function shieldAllyOf() {
  if (shieldAllyData !== data) {
    shieldAllyData = data;
    shieldAllyMap = {};
    for (const t of (data && data.teams) || []) shieldAllyMap[t.team] = t.ally;
  }
  return shieldAllyMap;
}

// ---------------------------------------------------------------------------
// Charge readings (Q). decodeShields is the twin of snapshot/shields.go's
// decodeShields: count, then frame (delta), unit+1, power (zigzag), flags.

function decodeShields(b) {
  const { uv, sv } = varints(b);
  const n = uv();
  if (n > b.length) throw new Error('shield count ' + n + ' exceeds section');
  const f = new Int32Array(n), unit = new Int32Array(n), power = new Int32Array(n), on = new Uint8Array(n);
  let prev = 0;
  for (let i = 0; i < n; i++) { prev += sv(); f[i] = prev; }
  for (let i = 0; i < n; i++) unit[i] = uv() - 1;
  for (let i = 0; i < n; i++) power[i] = sv();
  for (let i = 0; i < n; i++) on[i] = uv() & 1;
  return { f, unit, power, on };
}

// shieldSeries files the readings per unit (frame-ordered, as the section
// is): unit id -> {f, p, on, k}; k is scratch for shieldReading.
function shieldSeries(q) {
  const by = new Map();
  for (let i = 0; i < q.f.length; i++) {
    let s = by.get(q.unit[i]);
    if (!s) by.set(q.unit[i], (s = { f: [], p: [], on: [], k: 0 }));
    s.f.push(q.f[i]); s.p.push(q.power[i]); s.on.push(q.on[i]);
  }
  return by;
}

// loadShields reads the current replay's Q section, once. Best-effort like
// the effects: a failure leaves every shield at "unknown".
async function loadShields(file, gen) {
  const d = data;
  if (!d || !d.shieldAt || d.shieldState) return;
  d.shieldState = 'loading';
  try {
    const sec = await brpSections(file, { Q: d.shieldAt }, ['Q']);
    if (gen !== loadGen || d !== data) return;
    d.shieldCharge = shieldSeries(decodeShields(sec.Q));
    d.shieldState = 'ready';
    scheduleDraw();
  } catch (err) {
    console.error('shields:', err);
    d.shieldState = 'failed';
  }
}

// shieldReading: the unit's series with k at its last reading at or before
// simFrame, or null (no reading yet, or none recorded).
function shieldReading(id, simFrame) {
  const by = data && data.shieldCharge;
  const s = by && by.get(id);
  if (!s || s.f[0] > simFrame) return null;
  let lo = 0, hi = s.f.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s.f[mid] <= simFrame) lo = mid; else hi = mid - 1;
  }
  s.k = lo;
  return s;
}

// ---------------------------------------------------------------------------
// Frame-rate watch: a running average of the intervals between paints that
// drew shields; level 1 is the simple look.

const shieldPerf = { level: 0, avg: 0, count: 0, last: 0, drops: 0 };
function shieldWatch(now) {
  const p = shieldPerf;
  const dt = now - p.last;
  p.last = now;
  if (!(dt > 0) || dt > SHIELD_GAP_MS) return;
  p.avg = p.count ? p.avg + (dt - p.avg) * 0.05 : dt;
  p.count++;
  if (p.level === 0 && p.count >= SHIELD_SLOW_PAINTS && p.avg > SHIELD_SLOW_MS) {
    p.level = 1; p.drops++; p.count = 0;
    console.info(`shields: ${Math.round(1000 / p.avg)} fps, switching to the simple outline`);
  } else if (p.level === 1 && p.drops < SHIELD_MAX_DROPS && p.count >= SHIELD_FAST_PAINTS && p.avg < SHIELD_FAST_MS) {
    p.level = 0; p.count = 0;
  }
}

// ---------------------------------------------------------------------------
// Drawing.

// Per-paint scratch, reused: x, y (screen), r (screen px), b (bucket), ally,
// frac (charge 0..1; -1 unknown), down (drained or switched off), off.
const shieldScratch = [];

function drawShields(c, simFrame, u) {
  if (shieldPin === 'off' || !u) return;
  const defs = shieldDefTable();
  if (!defs) return;
  const t0 = performance.now();
  const S = shieldScratch;
  let n = 0;
  const allyOf = shieldAllyOf();
  for (let i = 0; i < u.length; i += STRIDE) {
    const d = defs[u[i + F.DEF]];
    if (!d || u[i + F.BUILD] < BUILD_DONE || u[i + F.HP] <= 0) continue;
    const p = interpPos(u, i);
    const r = d.r * scale;
    const x = viewW / 2 + (p[0] - center.x) * scale;
    const y = viewH / 2 + (p[1] - center.z) * scale;
    if (x + r < 0 || y + r < 0 || x - r > viewW || y - r > viewH || r < 2) continue;
    const s = S[n] || (S[n] = {});
    n++;
    s.x = x; s.y = y; s.r = r; s.ally = allyOf[u[i + F.TEAM]] ?? -1;
    const rd = shieldReading(u[i + F.ID], simFrame);
    if (rd) {
      s.frac = Math.max(0, Math.min(1, rd.p[rd.k] / d.p));
      s.off = !rd.on[rd.k];
      s.down = s.off || s.frac <= SHIELD_DOWN_FRAC;
      s.b = shieldBucket(s.frac);
    } else {
      s.frac = -1; s.off = false; s.down = false; s.b = SHIELD_UNKNOWN;
    }
  }
  if (n) {
    const simple = shieldPin === 'simple' || (shieldPin !== 'full' && shieldPerf.level === 1);
    c.save();
    drawShieldOutline(c, S, n, simple);
    if (!simple) drawShieldPips(c, S, n);
    c.restore();
    shieldWatch(t0);
  }
  const st = (window.__shieldStats ||= { calls: 0, ms: 0, max: 0, n: 0 });
  const ms = performance.now() - t0;
  st.calls++; st.ms += ms; st.n = n; st.level = shieldPerf.level; st.avgPaintMs = shieldPerf.avg;
  if (ms > st.max) st.max = ms;
}

// drawShieldOutline: per shield, the arcs NOT inside another live shield of
// its ally team, so overlapping shields read as one outline round the
// protected area. Simple: those arcs in one colour, one stroke. Otherwise a
// dark halo under them (one path), one path per charge bucket, and the down
// shields dashed.
function drawShieldOutline(c, S, n, simple) {
  const TAU = Math.PI * 2;
  const arcs = []; // [k, a0, a1]
  for (let i = 0; i < n; i++) {
    const a = S[i];
    if (a.down) continue; // a collapsed shield protects nothing
    const cover = [];
    let hidden = false;
    for (let j = 0; j < n && !hidden; j++) {
      if (j === i) continue;
      const b = S[j];
      if (b.ally !== a.ally || b.down) continue;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
      if (d >= a.r + b.r) continue;
      if (d + a.r <= b.r + 0.5) {
        // a lies inside b (an exact twin: keep the lower index)
        if (a.r < b.r - 0.5 || d > 0.5 || j < i) hidden = true;
        continue;
      }
      if (d + b.r <= a.r) continue; // b inside a: covers none of a's edge
      const th = Math.atan2(dy, dx);
      const h = Math.acos(Math.max(-1, Math.min(1, (a.r * a.r + d * d - b.r * b.r) / (2 * a.r * d))));
      const lo = (((th - h) % TAU) + TAU) % TAU, hi = lo + 2 * h;
      if (hi > TAU) cover.push([lo, TAU], [0, hi - TAU]); else cover.push([lo, hi]);
    }
    if (hidden) continue;
    if (!cover.length) { arcs.push([i, 0, TAU]); continue; }
    cover.sort((p, q) => p[0] - q[0]);
    let at = 0;
    for (const [lo, hi] of cover) {
      if (lo > at) arcs.push([i, at, lo]);
      if (hi > at) at = hi;
    }
    if (at < TAU) arcs.push([i, at, TAU]);
  }
  // path builds one path of the arcs in bucket b (-1: all of them).
  const path = (b) => {
    let any = false;
    c.beginPath();
    for (const [k, a0, a1] of arcs) {
      const s = S[k];
      if (b >= 0 && s.b !== b) continue;
      c.moveTo(s.x + s.r * Math.cos(a0), s.y + s.r * Math.sin(a0));
      c.arc(s.x, s.y, s.r, a0, a1);
      any = true;
    }
    return any;
  };
  if (simple) {
    c.lineWidth = SHIELD_LINE_PX;
    c.strokeStyle = 'rgba(190,215,240,0.8)';
    if (path(-1)) c.stroke();
    return;
  }
  // dark halo under every arc so the line reads on any terrain
  c.lineWidth = SHIELD_LINE_PX + 2;
  c.strokeStyle = 'rgba(0,0,0,0.45)';
  if (path(-1)) c.stroke();
  c.lineWidth = SHIELD_LINE_PX;
  for (let b = 0; b <= SHIELD_UNKNOWN; b++) {
    if (!path(b)) continue;
    const [r, g, bl] = SHIELD_COLORS[b];
    c.strokeStyle = `rgba(${r},${g},${bl},0.9)`;
    c.stroke();
  }
  // Down shields, dashed: red when drained, grey when switched off.
  c.setLineDash([6, 6]);
  for (const off of [false, true]) {
    let any = false;
    c.beginPath();
    for (let k = 0; k < n; k++) {
      const s = S[k];
      if (!s.down || s.off !== off) continue;
      c.moveTo(s.x + s.r, s.y);
      c.arc(s.x, s.y, s.r, 0, TAU);
      any = true;
    }
    if (!any) continue;
    c.strokeStyle = off ? 'rgba(170,180,190,0.5)' : 'rgba(255,60,40,0.55)';
    c.stroke();
  }
  c.setLineDash([]);
}

// drawShieldPips: a small gauge round each generator with a reading — a dark
// track and a charge arc from 12 o'clock, clockwise.
function drawShieldPips(c, S, n) {
  const R = SHIELD_PIP_PX, top = -Math.PI / 2;
  let any = false;
  c.lineWidth = 3;
  c.strokeStyle = 'rgba(0,0,0,0.55)';
  c.beginPath();
  for (let k = 0; k < n; k++) {
    const s = S[k];
    if (s.frac < 0) continue;
    c.moveTo(s.x + R, s.y);
    c.arc(s.x, s.y, R, 0, Math.PI * 2);
    any = true;
  }
  if (!any) return;
  c.stroke();
  c.lineWidth = 2;
  for (let b = 0; b < SHIELD_STEPS; b++) {
    any = false;
    c.beginPath();
    for (let k = 0; k < n; k++) {
      const s = S[k];
      if (s.b !== b || s.frac <= 0) continue;
      c.moveTo(s.x, s.y - R);
      c.arc(s.x, s.y, R, top, top + s.frac * Math.PI * 2);
      any = true;
    }
    if (!any) continue;
    const [r, g, bl] = SHIELD_COLORS[b];
    c.strokeStyle = `rgb(${r},${g},${bl})`;
    c.stroke();
  }
}

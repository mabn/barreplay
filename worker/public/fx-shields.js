// fx-shields.js — shield domes (Keeper/Overseer plasma deflectors, the T3
// gates, Legion's deflector, the shielded evolving commanders) drawn on the
// replay map. A plain script loaded before app.js, sharing its globals (data,
// viewW, viewH, center, scale, teamTint, F, STRIDE, interpPos, BUILD_DONE);
// drawOverlay calls drawShields(c, simFrame, u) once per overlay paint.
//
// PROTOTYPE (thread "shields"): four looks behind ?shields=, to compare.
//   edge   the edge only: one thin ring per shield, coloured by charge
//   union  the edge only, but only the OUTER boundary of a group of
//          overlapping shields of one ally team — the shielded AREA's outline
//   gauge  a faint ring plus a bright arc whose length is the charge
//   pips   union, plus a small charge gauge round every generator, so a
//          shield inside a cluster still shows its own charge
//   dome   BAR-like: a cached dome sprite (clear centre, fresnel rim, faint hex
//          lattice) tinted by charge
//   off    (default while this is a prototype) nothing
//
// SOURCE: where the shields are is already in every capture (the units are
// in the frames); how big a shield is comes from SHIELD_DEFS below (static
// per BAR version, read off the unit files' customParams shield_radius /
// shield_power). The CHARGE is not captured yet — no widget records
// Spring.GetUnitShieldState — so until it is, shieldCharge() SIMULATES one
// (deterministic per unit and frame) purely so the looks can be judged.
// ?shieldcharge=full draws every shield at 100%.
//
// COST: no per-pixel work anywhere. edge/gauge/union are a handful of
// stroked paths per paint — shields are bucketed into SHIELD_STEPS colours
// and every shield of a bucket goes into ONE path, so 60 shields are ~10
// stroke() calls. dome is one drawImage per shield from a sprite rendered
// once per colour bucket.

// SHIELD_DEFS: unit name (a scavenger copy's "_scav" stripped) -> radius (elmos)
// and max power. From beyond-all-reason/Beyond-All-Reason units/ (2026-10-11),
// the units carrying customParams.shield_radius (BAR's shield gadget draws
// exactly those; the commanders' invisible 30-elmo shields are left out).
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

const SHIELD_STEPS = 10;           // charge colour buckets (= stroke calls)
const SHIELD_LINE_PX = 1.5;        // ring width on screen
const SHIELD_SPRITE_PX = 256;      // dome sprite size

const shieldParams = new URLSearchParams(location.search);
const shieldStyle = shieldParams.get('shields') || 'off';
const shieldFull = shieldParams.get('shieldcharge') === 'full';

// shieldDefTable maps def id -> {r, p} for the loaded replay (null = none).
let shieldDefFor = null, shieldDefData = null;
function shieldDefTable() {
  if (shieldDefData === data) return shieldDefFor;
  shieldDefData = data;
  shieldDefFor = null;
  const names = (data && data.unitDefs) || {};
  for (const k of Object.keys(names)) {
    const s = SHIELD_DEFS[String(names[k]).replace(/_scav$/, '')];
    if (s) (shieldDefFor ||= {})[k] = s;
  }
  return shieldDefFor;
}

// shieldCharge: 0..1. SIMULATED (see the header) — a slow drain and refill,
// different per unit, with some shields hammered to empty.
function shieldCharge(id, simFrame) {
  if (shieldFull) return 1;
  const v = 0.55 + 0.6 * Math.sin(simFrame / 420 + id * 2.399);
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// shieldRGB: BAR's ramp, brightened for a dark map — full is a pale
// blue-white, half amber, empty red.
function shieldRGB(frac) {
  const stops = [[255, 60, 40], [255, 190, 70], [225, 240, 255]];
  const t = frac * 2, i = Math.min(1, Math.floor(t)), k = t - i;
  const a = stops[i], b = stops[i + 1];
  return [a[0] + (b[0] - a[0]) * k | 0, a[1] + (b[1] - a[1]) * k | 0, a[2] + (b[2] - a[2]) * k | 0];
}
const SHIELD_COLORS = Array.from({ length: SHIELD_STEPS }, (_, b) => shieldRGB(b / (SHIELD_STEPS - 1)));
const shieldBucket = (frac) => Math.round(frac * (SHIELD_STEPS - 1));

// Per-paint scratch, reused: x, y (screen), r (screen px), bucket, ally, frac.
let shieldScratch = [];

function drawShields(c, simFrame, u) {
  if (shieldStyle === 'off' || !u) return;
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
    const frac = shieldCharge(u[i + F.ID], simFrame);
    S[n++] = { x, y, r, b: shieldBucket(frac), ally: allyOf[u[i + F.TEAM]] ?? -1, frac };
  }
  if (n) {
    c.save();
    if (shieldStyle === 'dome') drawShieldDomes(c, S, n);
    else if (shieldStyle === 'gauge') drawShieldGauges(c, S, n);
    else if (shieldStyle === 'union') drawShieldUnion(c, S, n);
    else if (shieldStyle === 'pips') { drawShieldUnion(c, S, n); drawShieldPips(c, S, n); }
    else drawShieldEdges(c, S, n);
    c.restore();
  }
  const ms = performance.now() - t0;
  const st = (window.__shieldStats ||= { calls: 0, ms: 0, max: 0, n: 0 });
  st.calls++; st.ms += ms; st.n = n; if (ms > st.max) st.max = ms;
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

// edge: one ring per shield, one path per colour bucket.
function drawShieldEdges(c, S, n) {
  c.lineWidth = SHIELD_LINE_PX;
  for (let b = 0; b < SHIELD_STEPS; b++) {
    let any = false;
    c.beginPath();
    for (let k = 0; k < n; k++) {
      const s = S[k];
      if (s.b !== b) continue;
      c.moveTo(s.x + s.r, s.y);
      c.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      any = true;
    }
    if (!any) continue;
    const [r, g, bl] = SHIELD_COLORS[b];
    c.strokeStyle = `rgba(${r},${g},${bl},0.85)`;
    c.stroke();
  }
}

// gauge: a faint full ring (one path) + a bright arc from 12 o'clock,
// clockwise, as long as the charge (one path per colour bucket).
function drawShieldGauges(c, S, n) {
  c.lineWidth = SHIELD_LINE_PX;
  c.strokeStyle = 'rgba(200,215,235,0.28)';
  c.beginPath();
  for (let k = 0; k < n; k++) {
    const s = S[k];
    c.moveTo(s.x + s.r, s.y);
    c.arc(s.x, s.y, s.r, 0, Math.PI * 2);
  }
  c.stroke();
  c.lineWidth = SHIELD_LINE_PX + 1;
  c.lineCap = 'round';
  const top = -Math.PI / 2;
  for (let b = 0; b < SHIELD_STEPS; b++) {
    let any = false;
    c.beginPath();
    for (let k = 0; k < n; k++) {
      const s = S[k];
      if (s.b !== b || s.frac <= 0) continue;
      const a1 = top + s.frac * Math.PI * 2;
      c.moveTo(s.x + s.r * Math.cos(top), s.y + s.r * Math.sin(top));
      c.arc(s.x, s.y, s.r, top, a1);
      any = true;
    }
    if (!any) continue;
    const [r, g, bl] = SHIELD_COLORS[b];
    c.strokeStyle = `rgb(${r},${g},${bl})`;
    c.stroke();
  }
}

// union: per shield, the arcs NOT inside another shield of its ally team,
// so overlapping shields read as one outline around the protected area.
// O(n²) circle tests — 60 shields is ~3600 cheap checks per paint.
function drawShieldUnion(c, S, n) {
  const TAU = Math.PI * 2;
  const arcs = []; // [k, a0, a1]
  const down = [];
  for (let i = 0; i < n; i++) {
    const a = S[i];
    if (a.frac <= 0.02) { down.push(a); continue; } // a collapsed shield protects nothing
    const cover = [];
    let hidden = false;
    for (let j = 0; j < n && !hidden; j++) {
      if (j === i) continue;
      const b = S[j];
      if (b.ally !== a.ally || b.frac <= 0.02) continue;
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
      let lo = th - h, hi = th + h;
      lo = ((lo % TAU) + TAU) % TAU; hi = lo + 2 * h;
      if (hi > TAU) { cover.push([lo, TAU], [0, hi - TAU]); } else cover.push([lo, hi]);
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
  // dark halo under every arc (one path) so the line reads on any terrain
  c.lineWidth = SHIELD_LINE_PX + 2;
  c.strokeStyle = 'rgba(0,0,0,0.45)';
  c.beginPath();
  for (const [k, a0, a1] of arcs) {
    const s = S[k];
    c.moveTo(s.x + s.r * Math.cos(a0), s.y + s.r * Math.sin(a0));
    c.arc(s.x, s.y, s.r, a0, a1);
  }
  c.stroke();
  c.lineWidth = SHIELD_LINE_PX;
  for (let b = 0; b < SHIELD_STEPS; b++) {
    let any = false;
    c.beginPath();
    for (const [k, a0, a1] of arcs) {
      const s = S[k];
      if (s.b !== b) continue;
      c.moveTo(s.x + s.r * Math.cos(a0), s.y + s.r * Math.sin(a0));
      c.arc(s.x, s.y, s.r, a0, a1);
      any = true;
    }
    if (!any) continue;
    const [r, g, bl] = SHIELD_COLORS[b];
    c.strokeStyle = `rgba(${r},${g},${bl},0.9)`;
    c.stroke();
  }
  if (down.length) {
    c.setLineDash([6, 6]);
    c.strokeStyle = 'rgba(255,60,40,0.55)';
    c.beginPath();
    for (const s of down) { c.moveTo(s.x + s.r, s.y); c.arc(s.x, s.y, s.r, 0, Math.PI * 2); }
    c.stroke();
    c.setLineDash([]);
  }
}

// pips: a 9 px gauge round each generator — dark track + charge arc.
function drawShieldPips(c, S, n) {
  const R = 9, top = -Math.PI / 2;
  c.lineWidth = 3;
  c.strokeStyle = 'rgba(0,0,0,0.55)';
  c.beginPath();
  for (let k = 0; k < n; k++) { const s = S[k]; c.moveTo(s.x + R, s.y); c.arc(s.x, s.y, R, 0, Math.PI * 2); }
  c.stroke();
  c.lineWidth = 2;
  for (let b = 0; b < SHIELD_STEPS; b++) {
    let any = false;
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

// dome: BAR's look reduced to what a top-down map shows of a sphere — clear
// in the middle, brightening toward the rim (fresnel), a faint hex lattice,
// a crisp edge. Rendered ONCE per colour bucket into a sprite.
const shieldSprites = [];
function shieldSprite(b) {
  if (shieldSprites[b]) return shieldSprites[b];
  const N = SHIELD_SPRITE_PX, R = N / 2;
  const cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const g = cv.getContext('2d');
  const [r, gr, bl] = SHIELD_COLORS[b];
  const rgba = (a) => `rgba(${r},${gr},${bl},${a})`;
  const grad = g.createRadialGradient(R, R, 0, R, R, R);
  grad.addColorStop(0, rgba(0.0));
  grad.addColorStop(0.55, rgba(0.03));
  grad.addColorStop(0.85, rgba(0.10));
  grad.addColorStop(0.97, rgba(0.30));
  grad.addColorStop(1, rgba(0));
  g.fillStyle = grad;
  g.beginPath(); g.arc(R, R, R, 0, Math.PI * 2); g.fill();
  // hex lattice, masked by a rim-heavy radial alpha
  const lat = document.createElement('canvas');
  lat.width = lat.height = N;
  const h = lat.getContext('2d');
  h.strokeStyle = rgba(1); h.lineWidth = 1;
  const s = 9, w = s * Math.sqrt(3);
  h.beginPath();
  for (let row = -1; row * s * 1.5 < N + s; row++) {
    for (let col = -1; col * w < N + w; col++) {
      const cx = col * w + (row & 1 ? w / 2 : 0), cy = row * s * 1.5;
      for (let k = 0; k < 6; k++) {
        const a0 = Math.PI / 6 + k * Math.PI / 3, a1 = a0 + Math.PI / 3;
        h.moveTo(cx + s * Math.cos(a0), cy + s * Math.sin(a0));
        h.lineTo(cx + s * Math.cos(a1), cy + s * Math.sin(a1));
      }
    }
  }
  h.stroke();
  h.globalCompositeOperation = 'destination-in';
  const m = h.createRadialGradient(R, R, 0, R, R, R);
  m.addColorStop(0, 'rgba(0,0,0,0.02)');
  m.addColorStop(0.7, 'rgba(0,0,0,0.06)');
  m.addColorStop(0.97, 'rgba(0,0,0,0.22)');
  m.addColorStop(1, 'rgba(0,0,0,0)');
  h.fillStyle = m; h.fillRect(0, 0, N, N);
  g.drawImage(lat, 0, 0);
  g.strokeStyle = rgba(0.75); g.lineWidth = 2;
  g.beginPath(); g.arc(R, R, R - 1.5, 0, Math.PI * 2); g.stroke();
  return (shieldSprites[b] = cv);
}

function drawShieldDomes(c, S, n) {
  for (let k = 0; k < n; k++) {
    const s = S[k];
    c.drawImage(shieldSprite(s.b), s.x - s.r, s.y - s.r, s.r * 2, s.r * 2);
  }
}

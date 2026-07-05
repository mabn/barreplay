'use strict';

// barreplay viewer — vanilla JS canvas playback of a recorded capture.
//
// Wire format (see internal/viz/wire.go): each frame packs its units into a
// flat Int32 array `u` of stride 7: [id, def, team, x, z, hp, maxHp]. We read it
// by index rather than materialising per-unit objects — a replay can hold ~600
// units across thousands of frames, so avoiding the object churn keeps playback
// smooth.

const STRIDE = 9;
const F = { ID: 0, DEF: 1, TEAM: 2, X: 3, Z: 4, HP: 5, MAXHP: 6, DVX: 7, DVZ: 8 };

// Per-interval lookup: unit id -> base index of that unit in the NEXT sampled
// frame. Lets movement be animated toward each unit's actual next position
// (direction) at the speed implied by its velocity (magnitude). Rebuilt whenever
// the integer keyframe changes.
let nextPosMap = null;
function buildNextPosMap() {
  nextPosMap = new Map();
  const nf = data && data.frames[idx + 1];
  if (!nf) return;
  const nu = nf.u;
  for (let j = 0; j < nu.length; j += STRIDE) nextPosMap.set(nu[j + F.ID], j);
}

// Tangent length cap (as a multiple of the straight-line distance between the two
// samples) for the Hermite curve below — keeps a wildly-inconsistent velocity from
// bending the path into a big loop or bulge.
const TANGENT_CAP = 2;
function clampVec(x, z, max) {
  const m = Math.hypot(x, z);
  if (m <= max || m === 0) return [x, z];
  const s = max / m;
  return [x * s, z * s];
}

// Interpolated world [x, z] of unit i in the current frame array u, via a cubic
// Hermite spline between this sample (P0) and the unit's next sample (P1), using
// each end's velocity as the tangent: the unit leaves P0 at its frame-A velocity
// and arrives at P1 at its frame-B velocity, so motion curves naturally and is C1
// continuous across samples (no kink at the boundary). dvx/dvz are the velocity
// displacement over one interval — the exact Hermite tangents for t in [0,1].
// Constant-velocity motion reduces to a straight line. Stationary units (zero
// current velocity) and on-keyframe renders return the sampled position unchanged.
function interpPos(u, i) {
  const bx = u[i + F.X], bz = u[i + F.Z];              // P0
  if (renderFrac === 0) return [bx, bz];
  const m0x = u[i + F.DVX], m0z = u[i + F.DVZ];        // tangent at A (frame-A velocity)
  if (m0x === 0 && m0z === 0) return [bx, bz];         // zero velocity: stationary, don't animate
  const j = nextPosMap ? nextPosMap.get(u[i + F.ID]) : undefined;
  if (j === undefined) {
    // No next sample (unit is gone by then): fall back to velocity extrapolation.
    return [bx + m0x * renderFrac, bz + m0z * renderFrac];
  }
  const nu = data.frames[idx + 1].u;
  const px = nu[j + F.X], pz = nu[j + F.Z];            // P1
  const chord = Math.hypot(px - bx, pz - bz);
  if (chord === 0) return [bx, bz];                    // same position in both samples
  const cap = TANGENT_CAP * chord;
  const [a0x, a0z] = clampVec(m0x, m0z, cap);
  const [a1x, a1z] = clampVec(nu[j + F.DVX], nu[j + F.DVZ], cap); // tangent at B (frame-B velocity)
  const t = renderFrac, t2 = t * t, t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
  return [
    h00 * bx + h10 * a0x + h01 * px + h11 * a1x,
    h00 * bz + h10 * a0z + h01 * pz + h11 * a1z,
  ];
}

const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
const tooltip = document.getElementById('tooltip');
const emptyEl = document.getElementById('empty');

let data = null;            // loaded wire payload
let idx = 0;               // current frame index
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
let showGrid = true;       // draw the build/small/large grid
let showFootprints = true; // draw build-footprint rectangles for buildings
let growIcons = true;      // grow a building's icon toward its footprint when zoomed in
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
function draw() {
  // Draw in CSS px; the DPR scale keeps the backing store at full device res.
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, viewW, viewH);
  updateZoomLabel();
  if (!data) return;

  drawMapFrame();

  const fr = data.frames[idx];
  if (!fr) return;
  const u = fr.u;

  // Footprints sit under the unit markers.
  if (showFootprints) drawFootprints(u);

  if (showIcons) {
    drawIcons(u);
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
      const [sx, sy] = w2s(p[0], p[1]);
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
function drawIcons(u) {
  for (let i = 0; i < u.length; i += STRIDE) {
    const p = interpPos(u, i);
    const [sx, sy] = w2s(p[0], p[1]);
    const info = iconInfoFor(u[i + F.DEF]);
    let px = Math.max(ICON_MIN_PX, Math.min(ICON_MAX_PX, iconScale * (info ? info.s : 1)));
    if (growIcons) {
      const fp = footprintFor(u[i + F.DEF]); // buildings only; null for mobile units
      if (fp) {
        const cap = 0.9 * Math.min(fp.w, fp.h) * scale; // 90% of the smaller footprint side, in px
        if (cap > px) px = cap;                          // zoomed in: grow to fit the footprint
      }
    }
    px = Math.round(px);
    const r = px / 2;
    if (sx < -px || sy < -px || sx > viewW + px || sy > viewH + px) continue;
    const color = teamColor[u[i + F.TEAM]] || '#9aa6b2';
    const glyph = info ? renderIcon(info.p, color, px) : null;
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

// iconInfoFor returns {p: path, s: size} for a unit def, or null.
function iconInfoFor(def) {
  if (!data.unitIcons) return null;
  const name = data.unitDefs && data.unitDefs[def];
  return name ? (data.unitIcons[name] || null) : null;
}

// footprintFor returns {w, h} (build-footprint size in elmos) for a unit def, or
// null. Only buildings have an entry (the wire payload omits mobile units), so a
// null result means "don't draw a footprint".
function footprintFor(def) {
  if (!data.footprints) return null;
  const name = data.unitDefs && data.unitDefs[def];
  return name ? (data.footprints[name] || null) : null;
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
  if (!mouse || !data) return null;
  const fr = data.frames[idx];
  if (!fr) return null;
  const u = fr.u;
  let best = -1, bestD = 10 * 10; // 10px pick radius (squared)
  for (let i = 0; i < u.length; i += STRIDE) {
    const p = interpPos(u, i);
    const [sx, sy] = w2s(p[0], p[1]);
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
  if (i < 0) { tooltip.style.display = 'none'; return; }
  const u = data.frames[idx].u;
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
function renderTeams() {
  const root = document.getElementById('teams');
  root.innerHTML = '';
  const counts = {};
  const fr = data.frames[idx];
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
  const simFrame = data.frames[idx] ? data.frames[idx].f : 0;
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
  const fr = data.frames[idx];
  document.getElementById('s_time').textContent = fr ? fmtTime(fr.t) : '—';
  document.getElementById('s_frame').textContent = fr ? fr.f : '—';
  document.getElementById('s_units').textContent = fr ? fr.n : '—';
  renderTeams();
  renderEvents();
}

function updateTimeLabel() {
  const fr = data.frames[idx];
  const last = data.frames.length - 1;
  const t = fr ? fr.t + renderFrac * secPerFrame : 0; // interpolate the shown game time
  document.getElementById('timelabel').textContent =
    fr ? `${fmtTime(t)}   frame ${idx} / ${last}` : '—';
  document.getElementById('slider').value = idx;
}

// Move the continuous playhead (in keyframe units). idx = floor(playPos) is the
// current sampled frame; renderFrac is the fraction into the interval to the next
// one, which the draw helpers (ux/uz) use to interpolate unit movement.
function setPlayhead(pos, forceSidebar) {
  const last = data.frames.length - 1;
  playPos = Math.max(0, Math.min(last, pos));
  const newIdx = Math.floor(playPos + 1e-6);
  renderFrac = Math.max(0, playPos - newIdx);
  const changed = newIdx !== idx || forceSidebar;
  idx = newIdx;
  if (changed) { updateSidebar(); buildNextPosMap(); }
  updateTimeLabel();
  draw();
}

function show() { setPlayhead(idx, true); } // full refresh at the current keyframe

// Jump to a whole keyframe (stepping / scrubbing): no interpolation.
function go(i) {
  setPlayhead(Math.round(i), true);
}

function stopPlay() {
  if (playRAF) { cancelAnimationFrame(playRAF); playRAF = null; }
  document.getElementById('play').textContent = '▶ Play';
}
function startPlay() {
  if (!data || data.frames.length < 2) return;
  const last = data.frames.length - 1;
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
    setPlayhead(next, false);
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
document.getElementById('last').onclick = () => { stopPlay(); go(data.frames.length - 1); };
document.getElementById('play').onclick = togglePlay;
// Speed is read live inside the play loop, so a change takes effect immediately.
document.getElementById('speed').onchange = () => {};
document.getElementById('icons').onchange = e => { showIcons = e.target.checked; draw(); };
document.getElementById('maptex').onchange = e => { showTexture = e.target.checked; draw(); };
document.getElementById('grid').onchange = e => { showGrid = e.target.checked; draw(); };
document.getElementById('footprints').onchange = e => { showFootprints = e.target.checked; draw(); };
document.getElementById('growicons').onchange = e => { growIcons = e.target.checked; draw(); };
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
  try {
    const r = await fetch('/api/replay?file=' + encodeURIComponent(file));
    if (!r.ok) throw new Error(await r.text());
    data = await r.json();
  } catch (err) {
    setEmpty('Failed to load ' + file + ': ' + err.message);
    data = null;
    return;
  }
  if (!data.frames || !data.frames.length) {
    setEmpty('No frames in this capture (the widget may never have sampled — see the GPU/headless note in CLAUDE.md).');
    // Still render meta/teams so the sidebar isn't blank.
  } else {
    setEmpty('');
  }
  teamColor = assignColors(data.teams || []);
  secPerFrame = data.sampleEvery > 0 ? data.sampleEvery / 30 : 1;
  document.getElementById('subtitle').textContent =
    [data.gameId, data.mapName, data.gameVersion].filter(Boolean).join(' · ') || 'replay state viewer';
  document.getElementById('slider').max = Math.max(0, data.frames.length - 1);
  idx = 0;
  // Pre-warm the icon set (only a few dozen distinct unit types per replay) so
  // they're ready on the first paint.
  Object.values(data.unitIcons || {}).forEach(info => getImage(info.p));
  loadMap(data.mapName);
  resize();      // sets canvas size
  fitView();     // fit map to viewport
  show();
}

// Fetch this replay's map extent + terrain texture from the server (which
// proxies the BAR maps API). Best-effort: if the map is unknown or offline, the
// viewer just keeps the plain background.
async function loadMap(name) {
  mapW = mapH = 0;
  mapTex = null;
  const maptexEl = document.getElementById('maptex');
  if (!name) { maptexEl.disabled = true; return; }
  let info = {};
  try {
    info = await (await fetch('/api/mapinfo?map=' + encodeURIComponent(name))).json();
  } catch (_) { /* offline: leave plain background */ }
  mapW = info.width || 0;
  mapH = info.height || 0;
  maptexEl.disabled = !info.texture;
  if (info.texture) {
    const img = new Image();
    img.onload = () => { mapTex = img; draw(); };
    img.src = '/api/maptex?map=' + encodeURIComponent(name);
  }
  draw(); // reflect the (possibly updated) map extent immediately
}

async function init() {
  // Restore icon size from the URL (?iconsize=) before the first paint.
  const params = new URLSearchParams(location.search);
  const isz = parseInt(params.get('iconsize'), 10);
  if (isz >= ICON_SCALE_MIN && isz <= ICON_SCALE_MAX) iconScale = isz;
  document.getElementById('iconsize').value = iconScale;

  let list = [];
  try {
    const r = await fetch('/api/replays');
    list = await r.json();
  } catch (err) {
    setEmpty('Could not list snapshots: ' + err.message);
    return;
  }
  const sel = document.getElementById('file');
  if (!list || !list.length) {
    setEmpty('No .jsonl or .brsnap files in the snapshots directory. Run a capture first, or point -snapshots at the right directory.');
    return;
  }
  list.forEach(info => {
    const o = document.createElement('option');
    o.value = info.file;
    o.textContent = `${info.gameId} (${info.format}, ${fmtSize(info.size)})`;
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

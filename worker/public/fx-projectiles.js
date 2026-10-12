// fx-projectiles.js: the replay viewer's projectile layer. Long-range shells
// and missiles: the R rows that are not beams (data.projectiles,
// data.fxIndex.projectiles).
//
// A plain script loaded before app.js, sharing its globals (data, viewW,
// viewH, center, scale, teamTint, FX_CLASS, ...). drawEffects in app.js calls
// drawProjectiles once per overlay paint, only while effects are shown and
// the replay's effect records have loaded; see "effects" in app.js for what
// is on `data`.
//
// This layer draws the FLIGHT only: a head and a fading trail from launch to
// the track's end. What happens where it ends (the explosion, an
// interception's flash) is fx-blasts.js's.
//
// Where a projectile is between the records comes from how it flies
// (docs/brepstream-format.md, "Reading a track"):
//   - a row with a PATH (nukes, anti-nukes, EMP, tactical, Junos) is steered:
//     its sampled points, every 10 frames, are joined by a Catmull-Rom
//     curve from the launch to the end position;
//   - a row with no path and a horizontal launch velocity is BALLISTIC
//     (artillery: LRPCs, plasma): x and z move at the launch velocity, and
//     the height follows y0 + vy t + g t(t+1)/2, exactly as the engine
//     advances it;
//   - a row with neither (a starburst rocket leaves the silo straight up and
//     is then steered, with no path stored) flies a gentle curve from the
//     launch to the end, accelerating as it goes.
// The view is top-down, so height only shows as size: a shell at the top of
// its arc draws larger than one near the ground.

// How each class looks. r: head radius in screen px; trail: its length in
// sim frames; width: the trail's in px; head: the head's colour (the trail
// is always the team's, which is what says whose it is); glow: a soft halo
// of this colour round the head (plasma shells); ring: a strategic
// missile's head also gets a halo of this many radii in the team colour.
// Keyed by the class CODE (FX_CLASS in app.js: 1 nuke, 2 anti-nuke, 3 EMP,
// 4 tactical, 5 Juno, 6 artillery, 7 rocket, 9 long-range AA): this file
// runs before app.js declares FX_CLASS.
const PROJ_STYLE = {
  1: { r: 4.5, trail: 75, width: 3, head: [255, 244, 200], ring: 2.4 }, // nuke
  2: { r: 3.5, trail: 45, width: 2.2, head: [170, 240, 255], ring: 2 }, // anti-nuke
  3: { r: 4, trail: 60, width: 2.5, head: [175, 200, 255], ring: 2.2 }, // EMP
  4: { r: 3.5, trail: 45, width: 2.2, head: [255, 170, 90], ring: 2 }, // tactical
  5: { r: 3.5, trail: 45, width: 2.2, head: [150, 255, 150], ring: 2 }, // Juno
  6: { r: 2.4, trail: 14, width: 1.6, head: [255, 255, 255], ring: 0, glow: [225, 240, 255] }, // artillery: white plasma
  7: { r: 2.2, trail: 18, width: 1.4, head: [255, 255, 255], ring: 0 }, // rocket
  9: { r: 2, trail: 12, width: 1.4, head: [200, 235, 255], ring: 0 }, // long-range AA missile / railgun
};
const PROJ_DEFAULT_STYLE = { r: 2.2, trail: 14, width: 1.4, head: [255, 255, 255], ring: 0 };

// A trail keeps fading out this many frames after its track ended, so a
// shell does not blink out the frame it lands.
const PROJ_TAIL_FADE = 8;
// Points per trail: enough for a curved nuke track to read as a curve.
const PROJ_TRAIL_STEPS = 10;
// Height at which a head has grown by PROJ_HEIGHT_MAX (an LRPC peaks around
// 1000-2000 elmos, a nuke cruises near 3000).
const PROJ_HEIGHT_GROW = 2000;
const PROJ_HEIGHT_MAX = 0.6;
// How far a starburst rocket's track bows sideways, as a share of its length.
const PROJ_ROCKET_BOW = 0.08;
// A shell's head and trail scale with its weapon's blast radius against a
// full-size LRPC's (~70 elmos), so a Mini Starfall's 63-shell salvo (27.5)
// reads as a spray of small shells rather than 63 Basilica rounds. Square
// root, floored, so the smallest shell stays visible. Strategic missiles keep
// their class size: their ring already says what they are.
const PROJ_AOE_REF = 70;
const PROJ_AOE_MIN_SCALE = 0.45;

// projScale is row p's size factor from its weapon's blast radius (1 when
// the weapon table does not say).
function projScale(p, st) {
  if (st.ring) return 1;
  if (p._scale !== undefined) return p._scale;
  const w = data && data.weapons && data.weapons.get(p.weapon);
  const aoe = w && w.aoe;
  p._scale = aoe > 0 ? Math.max(PROJ_AOE_MIN_SCALE, Math.min(1, Math.sqrt(aoe / PROJ_AOE_REF))) : 1;
  return p._scale;
}

// projKnots is a steered row's flight as [df, x, y, z] knots: the launch,
// its path, and the end position when the path stops short of it. Built once
// per row.
function projKnots(p) {
  if (p._knots) return p._knots;
  const k = [[0, p.x0, p.y0, p.z0]];
  for (const pt of p.path) {
    if (pt.df <= k[k.length - 1][0]) continue; // a sample in the launch frame
    k.push([pt.df, pt.x, pt.y, pt.z]);
  }
  const last = Math.max(p.end - p.birth, k[k.length - 1][0] + 1);
  if (k[k.length - 1][0] < p.end - p.birth || k.length === 1) k.push([last, p.x1, p.y1, p.z1]);
  p._knots = k;
  return k;
}

// projBallistic says whether a pathless row flies an arc from its launch
// velocity (a shell) rather than being steered (a rocket).
function projBallistic(p) { return p.vx !== 0 || p.vz !== 0; }

// projPos writes where row p is t frames after its birth into out
// ([x, z, y]) and returns it. t is clamped to the flight.
function projPos(p, t, out) {
  const dur = Math.max(1, p.end - p.birth);
  if (t < 0) t = 0;
  if (t > dur) t = dur;
  if (p.path) {
    const k = projKnots(p);
    // The knot interval holding t (few knots: a nuke has ~30).
    let i = 0;
    while (i < k.length - 2 && k[i + 1][0] < t) i++;
    const a = k[i], b = k[i + 1];
    const s = (t - a[0]) / Math.max(1e-6, b[0] - a[0]);
    // Catmull-Rom through the neighbours, so the curve has no corners.
    const pa = k[Math.max(0, i - 1)], pb = k[Math.min(k.length - 1, i + 2)];
    const cr = (j) => {
      const p0 = pa[j], p1 = a[j], p2 = b[j], p3 = pb[j];
      return 0.5 * ((2 * p1) + (-p0 + p2) * s + (2 * p0 - 5 * p1 + 4 * p2 - p3) * s * s +
        (-p0 + 3 * p1 - 3 * p2 + p3) * s * s * s);
    };
    out[0] = cr(1); out[1] = cr(3); out[2] = cr(2);
    return out;
  }
  if (projBallistic(p)) {
    out[0] = p.x0 + p.vx * t;
    out[1] = p.z0 + p.vz * t;
    out[2] = p.y0 + p.vy * t + p.gravity * t * (t + 1) / 2;
    // The quantized velocity drifts a little over a long flight: ease the
    // last stretch onto the recorded end so the shell lands where it did.
    if (p.endKind === FX_END.EXPLODED) {
      const w = t / dur;
      const ex = p.x0 + p.vx * dur, ez = p.z0 + p.vz * dur;
      out[0] += (p.x1 - ex) * w * w;
      out[1] += (p.z1 - ez) * w * w;
    }
    return out;
  }
  // A starburst rocket: from launch to end, picking up speed, bowed a little
  // to one side (which side is fixed by the row so it never flips).
  const s = t / dur;
  const e = s * s * (2 - s) * 0.4 + s * s * 0.6; // slow off the rail, fast in
  const dx = p.x1 - p.x0, dz = p.z1 - p.z0;
  const bow = PROJ_ROCKET_BOW * Math.sin(Math.PI * e) * ((p.id & 1) ? 1 : -1);
  out[0] = p.x0 + dx * e - dz * bow;
  out[1] = p.z0 + dz * e + dx * bow;
  out[2] = p.y0 + (p.y1 - p.y0) * e + Math.sin(Math.PI * e) * Math.hypot(dx, dz) * 0.15;
  return out;
}

// projTeamRGB is row p's team colour as 0..255 numbers, lifted toward white
// so the darkest team colours still read on the map.
function projTeamRGB(p) {
  const t = (typeof teamTint !== 'undefined' && teamTint.get(p.team)) || [0.75, 0.75, 0.75];
  return t.map(v => Math.round(255 * (0.35 + 0.65 * v)));
}

const _projA = [0, 0, 0];
const _projB = [0, 0, 0];

function drawProjectiles(c, simFrame, u) {
  const idx = data && data.fxIndex && data.fxIndex.projectiles;
  if (!idx || !idx.rows.length) return;
  // Longest trail of any class: rows still showing a tail end within it.
  const rows = idx.between(simFrame - PROJ_TAIL_FADE, simFrame);
  if (!rows.length) return;
  const sx = (x) => viewW / 2 + (x - center.x) * scale;
  const sy = (z) => viewH / 2 + (z - center.z) * scale;
  c.save();
  c.lineCap = 'round';
  c.lineJoin = 'round';
  for (const p of rows) {
    if (p.birth > simFrame) continue;
    const st = PROJ_STYLE[p.class] || PROJ_DEFAULT_STYLE;
    const t = simFrame - p.birth;
    const dur = Math.max(1, p.end - p.birth);
    const after = t - dur; // > 0: landed, the tail fading out
    if (after > PROJ_TAIL_FADE) continue;
    const fade = after > 0 ? 1 - after / PROJ_TAIL_FADE : 1;
    const head = projPos(p, t, _projA);
    const hx = sx(head[0]), hy = sy(head[1]);
    // Skip what is nowhere near the screen (a trail is short next to it).
    const reach = st.trail * 40 * scale + 60;
    if (hx < -reach || hx > viewW + reach || hy < -reach || hy > viewH + reach) continue;
    const [r, g, b] = projTeamRGB(p);
    const size = projScale(p, st);

    // Trail: from max(birth, now - trail) to min(now, end), ONE stroke whose
    // gradient fades from nothing at the old end to the team colour at the
    // head (age is measured against the full trail length, so a young or a
    // landed trail is as faint at its old end as a long one).
    const t0 = Math.max(0, t - st.trail), t1 = Math.min(t, dur);
    if (t1 > t0) {
      const tail = projPos(p, t0, _projB);
      const tx = sx(tail[0]), ty = sy(tail[1]);
      const grad = c.createLinearGradient(tx, ty, hx, hy);
      const a0 = 1 - (t - t0) / st.trail, a1 = 1 - (t - t1) / st.trail;
      grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${(0.85 * a0 * a0 * fade).toFixed(3)})`);
      grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, ${(0.85 * a1 * fade).toFixed(3)})`);
      c.strokeStyle = grad;
      c.lineWidth = Math.max(1, st.width * size);
      c.beginPath();
      c.moveTo(tx, ty);
      for (let k = 1; k <= PROJ_TRAIL_STEPS; k++) {
        const pt = projPos(p, t0 + (t1 - t0) * k / PROJ_TRAIL_STEPS, _projB);
        c.lineTo(sx(pt[0]), sy(pt[1]));
      }
      c.stroke();
    }
    if (after > 0) continue; // landed: only the tail is left

    // The head, grown with height so an arc reads as an arc.
    const rad = st.r * size * (1 + PROJ_HEIGHT_MAX * Math.min(1, Math.max(0, head[2]) / PROJ_HEIGHT_GROW));
    if (st.ring) {
      c.fillStyle = `rgba(${r}, ${g}, ${b}, 0.35)`;
      c.beginPath();
      c.arc(hx, hy, rad * st.ring, 0, Math.PI * 2);
      c.fill();
    }
    if (st.glow) {
      // Plasma: a soft white-blue glow round a white core.
      const [gr, gg, gb] = st.glow;
      const halo = c.createRadialGradient(hx, hy, 0, hx, hy, rad * 2.2);
      halo.addColorStop(0, `rgba(${gr}, ${gg}, ${gb}, 0.7)`);
      halo.addColorStop(1, `rgba(${gr}, ${gg}, ${gb}, 0)`);
      c.fillStyle = halo;
      c.beginPath();
      c.arc(hx, hy, rad * 2.2, 0, Math.PI * 2);
      c.fill();
    }
    const [hr, hg, hb] = st.head;
    c.fillStyle = `rgb(${hr}, ${hg}, ${hb})`;
    c.beginPath();
    c.arc(hx, hy, rad, 0, Math.PI * 2);
    c.fill();
  }
  c.restore();
}

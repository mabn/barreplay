// fx-beams.js — heavy beam weapons (Pulsar, Bulwark, Titan, Juggernaut, …)
// drawn on the replay map. A plain script loaded before app.js, sharing its
// globals (data, viewW, viewH, center, scale, ...); drawEffects in app.js
// calls drawBeams(c, simFrame, u) once per overlay paint, with the
// fractional sim frame the units are interpolated to, only once the replay's
// effect records have loaded (data.fxState 'ready' — see "effects" in
// app.js). So the main view and the summary's clips both get the beams.
//
// SOURCE: the re-sim's R section (snapshot/projectiles.go). A beam record is
// ONE FIRING, class 8: the muzzle (x0, z0) as it fired, the frames birth..end
// it was seen hitting, and path — the points it hit, df frames after birth,
// thinned by the widget to the first, the last, every 5th and any jump past
// 64 elmos. Frames in which the beam ended in empty air produce no point, so
// the hit point between two recorded ones is interpolated and before the
// first one it is held. A record that never hit anything (endKind 2) has no
// path at all: it is drawn toward its target at launch, cut at the weapon's
// range, for the weapon's beam time, fainter, with no impact.
//
// LOOK: each weapon in BAR's own colours (BEAM_LOOKS, read off the unit
// files' weapondefs: rgbcolor = the glow, rgbcolor2 = the core, thickness),
// because that is what a player recognizes — a blue Pulsar, the Juggernaut's
// orange heat ray. Who fired is said by where the beam starts, on the
// firing unit. The weapon table is static per BAR version, so it lives here
// rather than in every replay (the wdefs fact carries no colours); a weapon
// not in it (a mod, a newer build) falls back to a neutral white-blue.
//
// Everything animates off the SIM FRAME, never the wall clock: a paused
// replay shows the same picture every repaint, and a clip scrubbed back and
// forth flickers the same way each time.

// BEAM_LOOKS: weapon name (unitname_weaponkey, lower case, as the wdefs fact
// names it; a scavenger copy's "_scav" is stripped first) -> look.
//   rgb   the beam's colour (BAR rgbcolor)
//   core  the core's colour (BAR rgbcolor2), absent = a white-hot core
//   thick BAR's thickness, in elmos — sets the width when zoomed in
// Generated from beyond-all-reason/Beyond-All-Reason units/ (2026-10-10):
// every BeamLaser the re-sim widget watches (damage >= 2000, range >= 600).
const BEAM_LOOKS = {
  armanni_ata: { rgb: [0, 0, 1], thick: 4.5 },                         // Pulsar
  armannit3_ata: { rgb: [0, 0, 1], thick: 10 },                        // Epic Pulsar
  armmanni_atam: { rgb: [0, 0, 1], thick: 4.5 },                       // Starlight
  armanavaldefturret_armada_tachyon_emitter: { rgb: [0, 0, 1], thick: 4.5 }, // Liquifier
  armbanth_tehlazerofdewm: { rgb: [0.2, 0.2, 1], thick: 4.7 },         // Titan
  armcomlvl8_longgun: { rgb: [0.7, 0.7, 1], thick: 3 },                // Commander EMP beam
  armcomlvl9_longgun: { rgb: [0.7, 0.7, 1], thick: 3 },
  armcomlvl10_longgun: { rgb: [0.7, 0.7, 1], thick: 3 },
  cordoom_atadr: { rgb: [0, 0, 1], thick: 5.5 },                       // Bulwark
  cordoomt3_armageddon_blue_laser: { rgb: [0, 0, 1], thick: 5.5 },     // Epic Bulwark
  cordoomt3_armagmheat: { rgb: [1, 0.8, 0], core: [0.8, 0, 0], thick: 7 },
  corkorg_corkorg_laser: { rgb: [1, 0.55, 0], core: [0.95, 1, 0.7], thick: 6 }, // Juggernaut
  coresuppt3_laser: { rgb: [1, 0.8, 0], core: [0.8, 0, 0], thick: 6 },  // Adjudicator
  corthermite_thermite_laser: { rgb: [1, 0.8, 0], core: [0.8, 0, 0], thick: 6 }, // Thermite
  // BAR gives it thickness 0 (its look is all texture); 4 reads like it.
  corsiegebreaker_dreadovercharge: { rgb: [0, 1, 0.8], core: [0.3, 1, 0.9], thick: 4 }, // Siegebreaker
  corcrwt4_krowbosslaser: { rgb: [0, 1, 0], thick: 4 },
  corcrwt4_krowbosslaser2: { rgb: [1, 0.8, 0], core: [0.8, 0, 0], thick: 6.7 },
  scavbeacon_t3_weapon: { rgb: [1, 0.8, 0], core: [0.8, 0, 0], thick: 6 },
  scavbeacon_t4_weapon: { rgb: [1, 0.8, 0], core: [0.8, 0, 0], thick: 8 },
  critter_penguinking_eyelaser: { rgb: [1, 0, 0], thick: 5.5 },
};
// armscavengerbossv2_<difficulty>_corkorg_laser: the scavenger boss's
// Juggernaut ray, one weapon per difficulty.
const BEAM_LOOK_SCAV_BOSS = { rgb: [1, 0.8, 0], core: [0.8, 0, 0], thick: 6 };
const BEAM_LOOK_DEFAULT = { rgb: [0.7, 0.75, 1], thick: 4 };

const BEAM_RISE_FRAMES = 2;    // fade in over the first two frames
const BEAM_FADE_FRAMES = 6;    // and out over six after the last hit (0.2 s)
const BEAM_MISS_ALPHA = 0.55;  // a firing that hit nothing, drawn fainter
// Screen widths: the world width (thickness x BEAM_GLOW_WORLD elmos) once
// zoomed in far enough, never under a floor that grows with the thickness
// so a Pulsar stays visibly heavier than a Starlight on the whole-map view.
const BEAM_GLOW_WORLD = 3;
const BEAM_MIN_PX = 1.5;
const BEAM_MIN_PX_PER_THICK = 0.35;
const BEAM_MAX_PX = 48;

// beamLook resolves a weapon name to its look.
function beamLook(name) {
  if (!name) return BEAM_LOOK_DEFAULT;
  const n = String(name).toLowerCase().replace('_scav', '');
  if (BEAM_LOOKS[n]) return BEAM_LOOKS[n];
  if (/^armscavengerbossv2_.*_corkorg_laser$/.test(n)) return BEAM_LOOK_SCAV_BOSS;
  return BEAM_LOOK_DEFAULT;
}

// beamWeapon reads one weapon's wdefs entry from data.weapons (a Map).
function beamWeapon(weapons, id) {
  if (!weapons) return null;
  if (typeof weapons.get === 'function') return weapons.get(id) || null;
  return weapons[id] || null;
}

// beamIndex: data.beams flattened for drawing (beamRecord), built once per
// replay. byRow maps a data.beams row to its record, so the frame lookup can
// go through the shared data.fxIndex.beams; reach is how far before a frame
// a firing can start and still be drawn at it — past its last hit by the
// fade, and a miss (end == birth) by the weapon's beam time.
let beamIndexOf = null;
let beamIndex = { beams: [], byRow: new Map(), reach: 0 };

function buildBeamIndex(rows, weapons) {
  const beams = [], byRow = new Map();
  let reach = 0;
  for (const p of rows) {
    const b = beamRecord(p, beamWeapon(weapons, p.weapon));
    if (!b) continue;
    beams.push(b);
    byRow.set(p, b);
    reach = Math.max(reach, b.end - p.end);
  }
  beams.sort((x, y) => x.birth - y.birth);
  return { beams, byRow, reach: reach + BEAM_FADE_FRAMES + 1 };
}

// beamRecord flattens one firing into what the draw loop reads: start and
// end frame, muzzle, and the hit points as parallel arrays of absolute sim
// frames and positions. A firing with no hit points runs toward its target
// for the weapon's beam time (miss = true).
function beamRecord(p, w) {
  const look = beamLook(w && w.name);
  const path = p.path || [];
  const f = [], x = [], z = [];
  for (const pt of path) {
    f.push(p.birth + pt.df);
    x.push(pt.x);
    z.push(pt.z);
  }
  let end = p.end, miss = false;
  if (!f.length) {
    // Nothing hit: aim at where the target was at launch, no further than
    // the weapon reaches.
    miss = true;
    let tx = p.tx, tz = p.tz;
    const dx = tx - p.x0, dz = tz - p.z0;
    const d = Math.hypot(dx, dz);
    const range = w && w.range > 0 ? w.range : 0;
    if (!(d > 0)) return null; // no direction to draw in
    if (range > 0 && d > range) {
      tx = p.x0 + dx * range / d;
      tz = p.z0 + dz * range / d;
    }
    f.push(p.birth);
    x.push(tx);
    z.push(tz);
    const bt = w && w.beamtime > 0 ? Math.round(w.beamtime * 30) : 1;
    end = p.birth + Math.max(1, bt) - 1;
  }
  return {
    birth: p.birth, end: Math.max(end, p.birth), miss,
    x0: p.x0, z0: p.z0, f, x, z, look,
    // The impact flare scales with the explosion's area, and never vanishes.
    aoe: w && w.aoe > 0 ? w.aoe : 8,
  };
}

// beamHitAt is where the beam ended at simFrame (fractional): interpolated
// between the recorded hit points around it, held before the first and after
// the last. Returns [x, z].
function beamHitAt(b, simFrame) {
  const f = b.f;
  const n = f.length;
  if (simFrame <= f[0] || n === 1) return [b.x[0], b.z[0]];
  if (simFrame >= f[n - 1]) return [b.x[n - 1], b.z[n - 1]];
  let lo = 0, hi = n - 1; // f[lo] <= simFrame < f[hi]
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (f[mid] <= simFrame) lo = mid; else hi = mid;
  }
  const t = (simFrame - f[lo]) / (f[hi] - f[lo]);
  return [b.x[lo] + (b.x[hi] - b.x[lo]) * t, b.z[lo] + (b.z[hi] - b.z[lo]) * t];
}

// beamAlpha is the firing's intensity at simFrame, 0 when it is not on.
// A beam is lit through the whole frame of its last hit, i.e. until end + 1.
function beamAlpha(b, simFrame) {
  if (simFrame < b.birth) return 0;
  const on = b.end + 1;
  let a;
  if (simFrame <= on) a = Math.min(1, (simFrame - b.birth) / BEAM_RISE_FRAMES + 0.35);
  else a = 1 - (simFrame - on) / BEAM_FADE_FRAMES;
  if (!(a > 0)) return 0;
  return b.miss ? a * BEAM_MISS_ALPHA : a;
}

// beamsAt lists the firings visible at simFrame, in row order: the rows
// the shared index has alive in [simFrame - reach, simFrame], kept when lit.
function beamsAt(idx, between, simFrame) {
  const out = [];
  for (const row of between(simFrame - idx.reach, simFrame)) {
    const b = idx.byRow.get(row);
    if (b && beamAlpha(b, simFrame) > 0) out.push(b);
  }
  return out;
}

function beamRGBA(c, a) {
  return `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a})`;
}

// The halo is drawn NORMALLY blended in the weapon's own hue, lifted a
// little off pure (BAR's Pulsar is 0 0 1, which is near black on dark
// ground); the core and the flares are ADDED, the way the engine draws
// beams. Added light alone washes out over pale terrain — a blue halo over
// grey rock came out barely bluer than the rock — and a normal blend alone
// has no white-hot centre.
function beamGlowColor(c) {
  return [0.15 + c[0] * 0.85, 0.15 + c[1] * 0.85, 0.15 + c[2] * 0.85];
}

// drawBeams paints every beam firing on at simFrame onto c, the overlay's
// 2D context in CSS pixels. u (the frame's units) is not needed: a beam is
// drawn from the muzzle as it fired.
function drawBeams(c, simFrame, u) {
  const rows = data && data.beams;
  const fx = data && data.fxIndex && data.fxIndex.beams;
  if (!rows || !rows.length || !fx || !c) return;
  if (beamIndexOf !== rows) {
    beamIndex = buildBeamIndex(rows, data.weapons);
    beamIndexOf = rows;
  }
  if (!beamIndex.beams.length) return;
  const on = beamsAt(beamIndex, fx.between, simFrame);
  if (!on.length) return;

  c.save();
  c.lineCap = 'round';
  for (const b of on) {
    const a = beamAlpha(b, simFrame);
    const hit = beamHitAt(b, simFrame);
    const ax = viewW / 2 + (b.x0 - center.x) * scale;
    const ay = viewH / 2 + (b.z0 - center.z) * scale;
    const bx = viewW / 2 + (hit[0] - center.x) * scale;
    const by = viewH / 2 + (hit[1] - center.z) * scale;
    const pad = 40;
    if ((ax < -pad && bx < -pad) || (ay < -pad && by < -pad) ||
      (ax > viewW + pad && bx > viewW + pad) || (ay > viewH + pad && by > viewH + pad)) continue;

    const look = b.look;
    const glow = beamGlowColor(look.rgb);
    // The core is white-hot (or BAR's rgbcolor2) with a quarter of the glow
    // in it, so a zoomed-in Pulsar reads blue rather than white.
    const c0 = look.core || [1, 1, 1];
    const core = [c0[0] * 0.75 + glow[0] * 0.25, c0[1] * 0.75 + glow[1] * 0.25, c0[2] * 0.75 + glow[2] * 0.25];
    // A slow shimmer keyed to the sim frame and the firing, so neighbouring
    // beams do not pulse in step and a paused frame stays put.
    const shimmer = 0.85 + 0.15 * Math.sin(simFrame * 1.3 + b.birth * 0.7);
    const w = Math.min(BEAM_MAX_PX, Math.max(
      BEAM_MIN_PX + look.thick * BEAM_MIN_PX_PER_THICK,
      look.thick * BEAM_GLOW_WORLD * scale)) * shimmer;
    // Impact: a flare the size of the explosion's area (aoe is a radius in
    // elmos), never smaller than the beam is wide, flickering per frame.
    const flick = 0.75 + 0.25 * Math.sin(simFrame * 2.9 + b.birth);
    const r = Math.max(w * 2.5, 8, Math.min(80, b.aoe * 2 * scale)) * flick;

    // Halo, normally blended.
    c.globalCompositeOperation = 'source-over';
    c.beginPath();
    c.moveTo(ax, ay);
    c.lineTo(bx, by);
    c.strokeStyle = beamRGBA(glow, 0.3 * a);
    c.lineWidth = w * 2.2;
    c.stroke();
    c.strokeStyle = beamRGBA(glow, 0.65 * a);
    c.lineWidth = w;
    c.stroke();
    if (!b.miss) {
      const g = c.createRadialGradient(bx, by, 0, bx, by, r);
      g.addColorStop(0, beamRGBA(glow, 0.8 * a));
      g.addColorStop(1, beamRGBA(glow, 0));
      c.fillStyle = g;
      c.beginPath();
      c.arc(bx, by, r, 0, Math.PI * 2);
      c.fill();
    }

    // Core and flares, added.
    c.globalCompositeOperation = 'lighter';
    c.beginPath();
    c.moveTo(ax, ay);
    c.lineTo(bx, by);
    c.strokeStyle = beamRGBA(core, 0.9 * a);
    c.lineWidth = Math.max(1, w * 0.35);
    c.stroke();
    // Muzzle: a small bright point where the beam leaves the unit.
    c.fillStyle = beamRGBA(core, 0.6 * a);
    c.beginPath();
    c.arc(ax, ay, Math.max(2, w * 0.6), 0, Math.PI * 2);
    c.fill();
    if (!b.miss) {
      const g = c.createRadialGradient(bx, by, 0, bx, by, r * 0.5);
      g.addColorStop(0, beamRGBA(core, a));
      g.addColorStop(1, beamRGBA(core, 0));
      c.fillStyle = g;
      c.beginPath();
      c.arc(bx, by, r * 0.5, 0, Math.PI * 2);
      c.fill();
    }
  }
  c.restore();
}

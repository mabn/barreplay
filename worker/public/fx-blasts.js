// fx-blasts.js — explosions in the replay view.
//
// What a v6 re-simulation recorded about explosions (protocol 5, widget
// 1.9.0; snapshot/projectiles.go): the W section's BLASTS — a unit's own
// death or self-destruct blast (kind 1) and a watched weapon's explosion that
// ended no track, like a cluster sub-munition (kind 2) — and the END of every
// R track that exploded (a nuke landing, an LRPC shell, a rocket). Both are
// drawn here, as the same thing: a fireball sized by the weapon's own blast
// radius (the wdefs fact's `aoe`, already halved from the unit file's
// diameter), with a shock ring on the big ones. The projectile layer draws a
// track's FLIGHT and stops at its end; beams and their hit points belong to
// the beam layer.
//
// Everything is a pure function of the (fractional) sim frame, like the map
// marks: scrubbing back replays an explosion, pausing freezes it, and the
// clip window draws exactly what the main view does. Older replays have no W
// or R section and draw nothing.
//
// A plain script with no module system (like app.js); the browser reads the
// FxBlasts global, node tests read module.exports.
(function (root) {
  'use strict';

  // Track classes and end kinds (snapshot/projectiles.go).
  const CLASS_NUKE = 1, CLASS_ANTINUKE = 2, CLASS_EMP = 3, CLASS_JUNO = 5, CLASS_BEAM = 8;
  const END_EXPLODED = 1;
  const FLAG_INTERCEPTED = 2;

  // Radius, in elmos, for a weapon the table does not price (no wdefs fact,
  // or a weapon missing from it): a middling shell.
  const DEFAULT_AOE = 48;
  // On-screen floor, so a blast stays visible zoomed all the way out. A
  // whole-map view of an 8v8 is ~0.06 px per elmo, where a 48-elmo shell is
  // three pixels: that is a spark, which is what it is at that distance.
  const MIN_RADIUS_PX = 2.5;
  // How long a blast stays on screen, in game frames: a base plus a share
  // of its size, so a fusion's blast lingers and a rocket's pops. Clamped so
  // a modded million-damage warhead does not hang over the map for a minute.
  const LIFE_BASE = 12, LIFE_PER_ELMO = 0.06, LIFE_MIN = 14, LIFE_MAX = 90;
  // Playback speed stretches a blast's life, or at 16x a fusion going up is
  // three animation frames: gone before the eye finds it. Half the speed,
  // never below 1 (1x and 2x are real time) and at most STRETCH_MAX, so at
  // 16x a blast stays up ~0.6 s of wall time. It follows the speed SETTING,
  // not whether the replay is playing, so pausing does not make what was
  // just on screen vanish.
  const STRETCH_MAX = 6;
  function stretchFor(speed) { return Math.min(STRETCH_MAX, Math.max(1, (speed || 1) / 2)); }
  // Blasts at least this big (radius, elmos) also throw a shock ring.
  const RING_MIN_AOE = 120;

  // Palettes: [core, body, rim] as r,g,b. Fire for an ordinary blast; EMP is
  // blue-white and does no fire at all; a Juno pulse is BAR's green; a nuke
  // burns whiter and longer than anything else on the map.
  const FIRE = [[255, 248, 220], [255, 170, 60], [200, 50, 20]];
  const NUKE = [[255, 255, 255], [255, 220, 150], [255, 90, 30]];
  const EMP = [[235, 248, 255], [120, 190, 255], [60, 90, 255]];
  const JUNO = [[230, 255, 240], [100, 255, 170], [20, 160, 100]];
  const PUFF = [[255, 255, 255], [220, 230, 240], [140, 150, 170]];

  // look decides how one explosion is drawn from what is known about it.
  // w is the weapon's wdefs entry (or undefined), cls the track class when it
  // ended a track (0 for a W blast), intercepted whether an anti-nuke got it.
  function look(w, cls, intercepted) {
    let aoe = (w && w.aoe > 0) ? w.aoe : DEFAULT_AOE;
    let pal = FIRE, lifeMul = 1;
    const wcls = cls || classCode(w && w.class);
    if (intercepted) {
      // Destroyed in the air: the warhead never went off over the target, so
      // a 960-elmo fireball over the defended base would tell a lie.
      return { aoe: Math.min(aoe, 60), pal: PUFF, life: LIFE_MIN, ring: false };
    }
    if (wcls === CLASS_JUNO || (w && w.cp && w.cp.junotype)) pal = JUNO;
    else if (wcls === CLASS_EMP || (w && w.paralyzer)) pal = EMP;
    else if (wcls === CLASS_NUKE || (w && w.cp && w.cp.nuclear)) { pal = NUKE; lifeMul = 1.5; }
    else if (wcls === CLASS_ANTINUKE) pal = PUFF;
    const life = Math.min(LIFE_MAX, Math.max(LIFE_MIN, (LIFE_BASE + aoe * LIFE_PER_ELMO) * lifeMul));
    // How long the fireball takes to reach full size: the engine's own blast
    // wave (explosionSpeed, elmos per frame), bounded to stay readable.
    const grow = w && w.expSpeed > 0 ? Math.min(life * 0.5, Math.max(2, aoe / w.expSpeed)) : Math.min(4, life * 0.3);
    return { aoe, pal, life, grow, ring: aoe >= RING_MIN_AOE };
  }

  function classCode(name) {
    switch (name) {
      case 'nuke': return CLASS_NUKE;
      case 'antinuke': return CLASS_ANTINUKE;
      case 'emp': return CLASS_EMP;
      case 'juno': return CLASS_JUNO;
      case 'beam': return CLASS_BEAM;
      default: return 0;
    }
  }

  // collect turns the decoded sections into one list of explosions sorted by
  // frame: every W blast plus every R track that EXPLODED (not a beam, not
  // one still flying or that vanished). weapons maps a weapon id to its
  // wdefs entry. Each entry: {f, x, z, life, ...look}.
  function collect(blasts, projectiles, weapons) {
    const wOf = (id) => weapons ? (weapons.get ? weapons.get(id) : weapons[id]) : undefined;
    const out = [];
    for (const b of blasts || []) {
      const L = look(wOf(b.weapon), 0, false);
      out.push({ f: b.f, x: b.x, z: b.z, team: b.team, kind: b.kind, weapon: b.weapon, ...L });
    }
    for (const p of projectiles || []) {
      if (p.endKind !== END_EXPLODED || p.class === CLASS_BEAM) continue;
      const L = look(wOf(p.weapon), p.class, (p.flags & FLAG_INTERCEPTED) !== 0);
      out.push({ f: p.end, x: p.x1, z: p.z1, team: p.team, kind: 0, weapon: p.weapon, ...L });
    }
    out.sort((a, b) => a.f - b.f);
    let maxLife = 0;
    for (const e of out) if (e.life > maxLife) maxLife = e.life;
    return { list: out, maxLife };
  }

  // stage is one explosion's state at age frames after it went off, or null
  // when it is not on screen (not yet, or over). Pure, so it is what the
  // tests pin: r is the fireball's radius in elmos, a its opacity; ringR and
  // ringA the shock ring's.
  function stage(e, age) {
    if (age < 0 || age >= e.life) return null;
    const t = age / e.life;
    const g = Math.min(1, age / e.grow);
    const r = e.aoe * (0.3 + 0.7 * (1 - (1 - g) * (1 - g))); // ease out
    // Bright for the first instant, then a smooth fade.
    const a = Math.pow(1 - t, 1.6);
    const s = { r, a, ringR: 0, ringA: 0 };
    if (e.ring) {
      s.ringR = e.aoe * (0.9 + 0.8 * t);
      s.ringA = 0.55 * (1 - t);
    }
    return s;
  }

  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a.toFixed(3)})`;

  // first returns the index of the first explosion at or after frame f.
  function first(list, f) {
    let lo = 0, hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].f < f) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  // draw paints every explosion live at simFrame (fractional) onto ctx.
  // view = {cx, cz, scale, w, h, stretch}: the world point at the screen's
  // centre, px per elmo, the viewport in CSS px, and the life multiplier
  // (stretchFor). Returns how many it drew, so
  // the caller knows to keep animating while paused.
  function draw(ctx, fx, simFrame, view) {
    if (!fx || !fx.list.length) return 0;
    const list = fx.list;
    const k = view.stretch || 1;
    let i = first(list, simFrame - fx.maxLife * k);
    if (i >= list.length || list[i].f > simFrame) return 0;
    let n = 0;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (; i < list.length; i++) {
      const e = list[i];
      if (e.f > simFrame) break;
      const s = stage(e, (simFrame - e.f) / k);
      if (!s) continue;
      const sx = view.w / 2 + (e.x - view.cx) * view.scale;
      const sy = view.h / 2 + (e.z - view.cz) * view.scale;
      const r = Math.max(MIN_RADIUS_PX, s.r * view.scale);
      const reach = Math.max(r, s.ringR * view.scale) + 2;
      if (sx + reach < 0 || sy + reach < 0 || sx - reach > view.w || sy - reach > view.h) continue;
      n++;
      const [core, body, rim] = e.pal;
      const grad = ctx.createRadialGradient(sx, sy, 0, sx, sy, r);
      grad.addColorStop(0, rgba(core, s.a));
      grad.addColorStop(0.35, rgba(body, s.a * 0.85));
      grad.addColorStop(0.75, rgba(rim, s.a * 0.45));
      grad.addColorStop(1, rgba(rim, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, Math.PI * 2);
      ctx.fill();
      if (s.ringA > 0) {
        ctx.strokeStyle = rgba(body, s.ringA);
        ctx.lineWidth = Math.max(1, Math.min(3, r * 0.04));
        ctx.beginPath();
        ctx.arc(sx, sy, Math.max(r, s.ringR * view.scale), 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
    return n;
  }

  const api = { look, collect, stage, draw, first, stretchFor, DEFAULT_AOE, MIN_RADIUS_PX, LIFE_MIN, LIFE_MAX };
  root.FxBlasts = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

// drawBlasts is drawEffects' hook (app.js): every explosion live at simFrame,
// on the overlay canvas c. The explosion list is built on first use and
// cached on the identity of the replay's blast rows, so a new replay (or the
// effect records arriving) rebuilds it.
// blastSpeed is the playback speed in force: the clip window's own control
// while a clip plays, the main one otherwise (as the play loop reads them).
function blastSpeed() {
  const el = document.getElementById(clip ? 'clipspeed' : 'speed');
  return el ? +el.value || 1 : 1;
}

let fxBlastsCache = null; // {blasts, projectiles, fx}
function drawBlasts(c, simFrame, u) {
  if (!data) return;
  const blasts = data.blasts, projectiles = data.projectiles;
  if (!fxBlastsCache || fxBlastsCache.blasts !== blasts || fxBlastsCache.projectiles !== projectiles) {
    fxBlastsCache = { blasts, projectiles, fx: FxBlasts.collect(blasts, projectiles, data.weapons) };
  }
  const n = FxBlasts.draw(c, fxBlastsCache.fx, simFrame,
    { cx: center.x, cz: center.z, scale, w: viewW, h: viewH, stretch: FxBlasts.stretchFor(blastSpeed()) });
  // Paused or scrubbed onto a blast the picture is already final (it is a
  // pure function of the frame and the speed setting); only playback moves
  // it on, and playback already redraws every tick. Nothing to schedule.
  return n;
}

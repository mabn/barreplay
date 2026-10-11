// fx-blasts.js — explosions in the replay view.
//
// What a v6 re-simulation recorded about explosions (protocol 5, widget
// 1.9.0; snapshot/projectiles.go): the W section's BLASTS — a unit's own
// death or self-destruct blast (kind 1) and a watched weapon's explosion that
// ended no track, like a cluster sub-munition (kind 2) — and the END of every
// R track that exploded (a nuke landing, an LRPC shell, a rocket). Both are
// drawn here, as the same thing: a fireball sized by the weapon's own blast
// radius (the wdefs fact's `aoe`, already halved from the unit file's
// diameter), and a shock ring that is the engine's own DAMAGE FRONT: it
// leaves the centre at the weapon's explosionSpeed (elmos per frame, the
// wdefs fact's `expSpeed`) and stops at the blast radius, exactly where and
// when the engine applies the damage (GameHelper: a unit d elmos out is hit
// d / explosionSpeed frames late, nothing past the radius is hit at all). The projectile layer draws a
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
  // Blasts at least this big (radius, elmos) also draw their damage front:
  // the widget's own floor for a W blast, so every recorded blast has one
  // and only the small shell impacts at track ends go without.
  const RING_MIN_AOE = 64;
  // The ring holds at the radius for at least this many frames once the
  // front gets there, so a fast front still reads as a circle.
  const RING_HOLD = 8;
  // The ring is drawn at this share of the front's true radius (Marcin's call).
  const RING_SCALE = 0.85;

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
    // Frames the damage front takes to reach the radius: 0 when the weapon
    // states no speed (the engine then damages the whole radius at once).
    const front = w && w.expSpeed > 0 ? w.expSpeed : 0;
    const travel = front ? aoe / front : 0;
    const life = Math.max(travel + RING_HOLD,
      Math.min(LIFE_MAX, Math.max(LIFE_MIN, (LIFE_BASE + aoe * LIFE_PER_ELMO) * lifeMul)));
    // How long the fireball takes to reach full size: the engine's own blast
    // wave (explosionSpeed, elmos per frame), bounded to stay readable.
    const grow = front ? Math.min(life * 0.5, Math.max(2, travel)) : Math.min(4, life * 0.3);
    return { aoe, pal, life, grow, front, travel, ring: aoe >= RING_MIN_AOE };
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

  // stage is one explosion's state at age GAME frames after it went off,
  // or null when it is not on screen (not yet, or over). k is the playback
  // stretch (stretchFor): it slows the fireball's fade so it stays visible at
  // speed, but never the damage front, which runs on game time because it
  // is a fact about the game. Pure, so it is what the tests pin: r is the
  // fireball's radius in elmos, a its opacity; ringR and ringA the ring's.
  function stage(e, age, k) {
    k = k || 1;
    const span = Math.max(e.life * k, e.ring ? (e.travel || 0) + RING_HOLD * k : 0);
    if (age < 0 || age >= span) return null;
    const fage = age / k;
    if (fage >= e.life && !e.ring) return null;
    const t = Math.min(1, fage / e.life);
    const g = Math.min(1, age / e.grow);
    const r = e.aoe * (0.3 + 0.7 * (1 - (1 - g) * (1 - g))); // ease out
    // Bright for the first instant, then a smooth fade.
    const a = Math.pow(1 - t, 1.6);
    const s = { r, a: fage < e.life ? a : 0, ringR: 0, ringA: 0 };
    if (e.ring) {
      const travel = e.travel || 0;
      if (age < travel) {
        s.ringR = e.front * age * RING_SCALE;
        s.ringA = RING_ALPHA;
      } else {
        s.ringR = e.aoe * RING_SCALE;
        s.ringA = RING_ALPHA * (1 - (age - travel) / (span - travel));
      }
    }
    return s;
  }

  const RING_ALPHA = 0.7;
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

  // A chain of reactors going up is a hundred blasts on screen at once, and
  // in Firefox building a radial gradient per blast per animation frame was
  // what made that stutter. The fireball is the same picture for every
  // blast of one palette, only scaled and faded, so it is painted ONCE per
  // palette into a sprite and stamped with drawImage + globalAlpha — the
  // same pixels, since every gradient stop's alpha was s.a times a constant.
  // Past MAX_FIREBALLS (or MAX_RINGS for the shock rings) the OLDEST live
  // blasts are dropped: by then the screen is solid fire and more additive
  // layers only cost time, and the newest are the ones still growing.
  const MAX_FIREBALLS = 120, MAX_RINGS = 40;
  const SPRITE_PX = 128;
  const sprites = new Map(); // palette -> canvas, or null where none can be made
  function makeCanvas(px) {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(px, px);
    if (typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      c.width = c.height = px;
      return c;
    }
    return null;
  }
  function spriteFor(pal) {
    if (sprites.has(pal)) return sprites.get(pal);
    let c = makeCanvas(SPRITE_PX);
    const g = c && c.getContext('2d');
    if (g) {
      const h = SPRITE_PX / 2;
      g.fillStyle = gradient(g, h, h, h, pal, 1);
      g.fillRect(0, 0, SPRITE_PX, SPRITE_PX);
    } else c = null;
    sprites.set(pal, c);
    return c;
  }
  function gradient(ctx, x, y, r, pal, a) {
    const [core, body, rim] = pal;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, rgba(core, a));
    grad.addColorStop(0.35, rgba(body, a * 0.85));
    grad.addColorStop(0.75, rgba(rim, a * 0.45));
    grad.addColorStop(1, rgba(rim, 0));
    return grad;
  }

  // Fill rate is what is left once the gradients are cached: a reactor
  // chain is dozens of fireballs hundreds of px across, every pixel of each
  // blended additively. A fireball is a soft gradient with no edge, so the
  // BIG ones (LOWRES_MIN_PX and up) are stamped into a layer at 1/LOWRES of
  // the viewport and that layer is stretched over it once — LOWRES^2 = 16
  // times fewer pixels blended, invisible on a blur. Small ones stay sharp
  // on the main canvas, where they would shrink to a pixel in the layer.
  const LOWRES = 4, LOWRES_MIN_PX = 16;
  let layer = null, layerCtx = null, layerOff = false;
  function lowresLayer(w, h) {
    if (layerOff) return null;
    const lw = Math.max(1, Math.ceil(w / LOWRES)), lh = Math.max(1, Math.ceil(h / LOWRES));
    if (!layer) {
      layer = makeCanvas(1);
      layerCtx = layer && layer.getContext('2d');
      if (!layerCtx) { layerOff = true; return null; }
    }
    if (layer.width !== lw || layer.height !== lh) { layer.width = lw; layer.height = lh; }
    else layerCtx.clearRect(0, 0, lw, lh);
    layerCtx.globalCompositeOperation = 'lighter';
    return layerCtx;
  }

  // Rings are batched into one stroke per palette and opacity step, so a
  // chain's forty rings are a handful of draw calls rather than forty.
  const RING_STEPS = 8;

  // draw paints every explosion live at simFrame (fractional) onto ctx.
  // view = {cx, cz, scale, w, h, stretch, ringsOnly}: the world point at the
  // screen's centre, px per elmo, the viewport in CSS px, the life multiplier
  // (stretchFor), and whether to leave the fireballs out because fx-ceg.js
  // is drawing BAR's effects instead. Returns how many it drew, so
  // the caller knows to keep animating while paused.
  function draw(ctx, fx, simFrame, view) {
    if (!fx || !fx.list.length) return 0;
    const list = fx.list;
    const k = view.stretch || 1;
    const lo = first(list, simFrame - fx.maxLife * k);
    if (lo >= list.length || list[lo].f > simFrame) return 0;
    let n = 0, rings = 0, lc = null;
    const ringBatches = new Map(); // pal -> [steps] of [x, y, r] triples
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    // Newest first, so the cap drops the oldest.
    for (let i = first(list, simFrame + 1e-9) - 1; i >= lo && n < MAX_FIREBALLS; i--) {
      const e = list[i];
      const s = stage(e, simFrame - e.f, k);
      if (!s) continue;
      const sx = view.w / 2 + (e.x - view.cx) * view.scale;
      const sy = view.h / 2 + (e.z - view.cz) * view.scale;
      const r = Math.max(MIN_RADIUS_PX, s.r * view.scale);
      const ringPx = s.ringR * view.scale;
      const reach = Math.max(r, ringPx) + 2;
      if (sx + reach < 0 || sy + reach < 0 || sx - reach > view.w || sy - reach > view.h) continue;
      n++;
      const sprite = spriteFor(e.pal);
      if (s.a <= 0 || view.ringsOnly) {
        // fireball over (the ring is still holding at the radius), or drawn
        // by fx-ceg.js as BAR's own effect
      } else if (sprite) {
        let g = ctx, q = 1;
        if (r >= LOWRES_MIN_PX) {
          if (!lc) lc = lowresLayer(view.w, view.h);
          if (lc) { g = lc; q = 1 / LOWRES; }
        }
        g.globalAlpha = s.a;
        g.drawImage(sprite, (sx - r) * q, (sy - r) * q, 2 * r * q, 2 * r * q);
        g.globalAlpha = 1;
      } else {
        ctx.fillStyle = gradient(ctx, sx, sy, r, e.pal, s.a);
        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.fill();
      }
      if (s.ringA > 0 && rings < MAX_RINGS) {
        rings++;
        let b = ringBatches.get(e.pal);
        if (!b) ringBatches.set(e.pal, b = []);
        const step = Math.min(RING_STEPS, Math.max(1, Math.round(s.ringA / RING_ALPHA * RING_STEPS)));
        (b[step] || (b[step] = [])).push(sx, sy, Math.max(1, ringPx));
      }
    }
    if (lc) ctx.drawImage(layer, 0, 0, layer.width, layer.height, 0, 0, layer.width * LOWRES, layer.height * LOWRES);
    ctx.lineWidth = 1.5;
    for (const [pal, steps] of ringBatches) {
      for (let st = 1; st <= RING_STEPS; st++) {
        const c = steps[st];
        if (!c) continue;
        ctx.strokeStyle = rgba(pal[1], RING_ALPHA * st / RING_STEPS);
        ctx.beginPath();
        for (let j = 0; j < c.length; j += 3) {
          ctx.moveTo(c[j] + c[j + 2], c[j + 1]);
          ctx.arc(c[j], c[j + 1], c[j + 2], 0, Math.PI * 2);
        }
        ctx.stroke();
      }
    }
    ctx.restore();
    return n;
  }

  const api = { look, collect, stage, draw, first, stretchFor, DEFAULT_AOE, MIN_RADIUS_PX, LIFE_MIN, LIFE_MAX, MAX_FIREBALLS, RING_SCALE };
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

// BAR's own explosion effects (fx-ceg.js) replace the fireballs wherever they
// can: WebGL2 on #fxcv + #fxlight and the effect table (fx-cegdata.js, ~70 KB gzipped,
// loaded on the first replay that has explosions). Until both are there, and
// on a browser without WebGL2, the fireballs above are drawn instead. The
// damage-front rings stay either way: they are the engine's damage, which
// BAR's effects do not show.
let cegLoad = null; // null | 'loading' | 'ready' | 'failed'
let cegCache = null; // {blasts, projectiles}: the rows the scene was built from
let cegLib = null;
function loadCegData() {
  if (cegLoad) return;
  if (globalThis.BAR_CEGS) { cegLoad = 'ready'; return; }
  const src = window.__FX_CEGDATA_JS__;
  if (!src || /__ASSET_REV__/.test(src)) { cegLoad = 'failed'; return; }
  cegLoad = 'loading';
  const s = document.createElement('script');
  s.src = src;
  s.onload = () => { cegLoad = globalThis.BAR_CEGS ? 'ready' : 'failed'; scheduleDraw(); };
  s.onerror = () => { cegLoad = 'failed'; };
  document.head.appendChild(s);
}
function cegReady() {
  if (typeof FxCeg === 'undefined' || !FxCeg.init) return false;
  const cv = document.getElementById('fxcv'), lv = document.getElementById('fxlight');
  if (!cv || !lv) return false;
  loadCegData();
  if (cegLoad !== 'ready' || !FxCeg.init(cv, lv, globalThis.BAR_CEGS.textures)) return false;
  if (!cegCache || cegCache.blasts !== data.blasts || cegCache.projectiles !== data.projectiles) {
    cegCache = { blasts: data.blasts, projectiles: data.projectiles };
    if (!cegLib) cegLib = FxCeg.Library(globalThis.BAR_CEGS);
    FxCeg.setScene(cegLib, FxCeg.events(data.blasts, data.projectiles, data.weapons));
  }
  return true;
}
// clearCeg empties the effect layer, for frames that draw no effects.
function clearCeg() {
  if (typeof FxCeg !== 'undefined' && FxCeg.clear) FxCeg.clear();
}

function drawBlasts(c, simFrame, u) {
  if (!data) return;
  const blasts = data.blasts, projectiles = data.projectiles;
  if (!fxBlastsCache || fxBlastsCache.blasts !== blasts || fxBlastsCache.projectiles !== projectiles) {
    fxBlastsCache = { blasts, projectiles, fx: FxBlasts.collect(blasts, projectiles, data.weapons) };
  }
  const stretch = FxBlasts.stretchFor(blastSpeed());
  const ceg = cegReady();
  if (ceg) {
    // BAR's flashes are short and bright: stretched as far as the rings, a
    // fusion chain at 16x would white the map out for seconds.
    FxCeg.render(simFrame, { cx: center.x, cz: center.z, scale, dpr: DPR, w: viewW, h: viewH, stretch: Math.sqrt(stretch) });
  }
  const n = FxBlasts.draw(c, fxBlastsCache.fx, simFrame,
    { cx: center.x, cz: center.z, scale, w: viewW, h: viewH, stretch, ringsOnly: ceg });
  // Paused or scrubbed onto a blast the picture is already final (it is a
  // pure function of the frame and the speed setting); only playback moves
  // it on, and playback already redraws every tick. Nothing to schedule.
  return n;
}

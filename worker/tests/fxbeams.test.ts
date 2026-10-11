import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

// worker/public/fx-beams.js is a classic script sharing app.js's globals. Its
// pure half (resolving a weapon's look, flattening a firing, where the beam
// hits at a fractional frame, how bright it is) runs here in a sandbox with
// just the globals drawBeams reads stubbed.

// Values built inside the sandbox have its realm's prototypes; compare them as
// plain data.
const eq = (a: unknown, b: unknown) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b);

const SRC = readFileSync(fileURLToPath(new URL('../public/fx-beams.js', import.meta.url)), 'utf8');

function load(globals: Record<string, unknown> = {}) {
  const ctx = vm.createContext({ Math, String, Map, Number, ...globals });
  vm.runInContext(SRC + '\n;globalThis.__fx = { beamLook, beamRecord, beamHitAt, beamAlpha, beamsAt, buildBeamIndex, drawBeams, BEAM_LOOK_DEFAULT, BEAM_FADE_FRAMES, BEAM_MISS_ALPHA };', ctx);
  return (ctx as any).__fx;
}

const PULSAR = { id: 7, name: 'armanni_ata', range: 1400, aoe: 8, beamtime: 1.5, class: 'beam' };

function firing(over: Record<string, unknown> = {}) {
  return {
    birth: 1000, end: 1044, id: 5, weapon: 7, owner: 1, team: 0, class: 8, endKind: 1,
    x0: 100, y0: 50, z0: 100, tx: 900, ty: 0, tz: 100, x1: 900, y1: 0, z1: 100,
    path: [{ df: 0, x: 800, y: 0, z: 100 }, { df: 10, x: 900, y: 0, z: 100 }, { df: 44, x: 900, y: 0, z: 200 }],
    ...over,
  };
}

test('beamLook: BAR colours by weapon name, scavenger copies included', () => {
  const fx = load();
  eq(fx.beamLook('armanni_ata').rgb, [0, 0, 1]);
  eq(fx.beamLook('ARMANNI_SCAV_ATA').rgb, [0, 0, 1]);
  eq(fx.beamLook('corkorg_corkorg_laser').core, [0.95, 1, 0.7]);
  eq(fx.beamLook('armscavengerbossv2_hard_corkorg_laser').rgb, [1, 0.8, 0]);
  assert.equal(fx.beamLook('somemod_beam'), fx.BEAM_LOOK_DEFAULT);
  assert.equal(fx.beamLook(undefined), fx.BEAM_LOOK_DEFAULT);
});

test('beamHitAt interpolates between recorded hits and holds at the ends', () => {
  const fx = load();
  const b = fx.beamRecord(firing(), PULSAR);
  eq(b.f, [1000, 1010, 1044]);
  eq(fx.beamHitAt(b, 995), [800, 100]);
  eq(fx.beamHitAt(b, 1005), [850, 100]);   // halfway between df 0 and 10
  eq(fx.beamHitAt(b, 1027), [900, 150]);   // halfway between df 10 and 44
  eq(fx.beamHitAt(b, 1050), [900, 200]);
});

test('beamAlpha: lit from birth through the last hit frame, then fades', () => {
  const fx = load();
  const b = fx.beamRecord(firing(), PULSAR);
  assert.equal(fx.beamAlpha(b, 999.9), 0);
  assert.ok(fx.beamAlpha(b, 1000) > 0);
  assert.equal(fx.beamAlpha(b, 1020), 1);
  assert.equal(fx.beamAlpha(b, 1045), 1);                 // end + 1: still the last frame
  assert.ok(fx.beamAlpha(b, 1047) < 1 && fx.beamAlpha(b, 1047) > 0);
  assert.equal(fx.beamAlpha(b, 1045 + fx.BEAM_FADE_FRAMES), 0);
});

test('a firing that hit nothing runs toward its target, cut at the range, for the beam time', () => {
  const fx = load();
  const b = fx.beamRecord(firing({ endKind: 2, end: 1000, path: [], tx: 100 + 3000, tz: 100 }), PULSAR);
  assert.equal(b.miss, true);
  eq([b.x[0], b.z[0]], [1500, 100]);         // 1400 elmos out
  assert.equal(b.end, 1000 + 45 - 1);                     // 1.5 s
  assert.equal(fx.beamAlpha(b, 1020), fx.BEAM_MISS_ALPHA);
  // No direction at all: nothing to draw.
  assert.equal(fx.beamRecord(firing({ endKind: 2, path: [], tx: 100, tz: 100 }), PULSAR), null);
});

// between: data.fxIndex.beams.between's contract — the rows alive at any
// frame of [f0, f1], in row order.
const between = (rows: any[]) => (f0: number, f1: number) => rows.filter(r => r.birth <= f1 && r.end >= f0);

test('beamsAt finds the firings on at a frame, fading ones and misses included', () => {
  const fx = load();
  const rows: any[] = [];
  for (let i = 0; i < 200; i++) rows.push(firing({ birth: i * 100, end: i * 100 + 44 }));
  // A miss: no hit, end == birth, drawn for the Pulsar's 45 frames.
  rows.push(firing({ birth: 20050, end: 20050, endKind: 2, path: null }));
  const idx = fx.buildBeamIndex(rows, new Map([[7, PULSAR]]));
  assert.equal(idx.beams.length, 201);
  const at = (f: number) => fx.beamsAt(idx, between(rows), f).map((b: any) => b.birth);
  eq(at(5020), [5000]);
  eq(at(5047), [5000]); // fading
  eq(at(5080), []);
  eq(at(20090), [20050]); // past its end frame, inside its beam time
});

// A 2D context that accepts every call drawBeams makes and counts strokes.
function fakeContext() {
  const calls: string[] = [];
  const gradient = { addColorStop() {} };
  return {
    calls,
    ctx: new Proxy({}, {
      get: (_t, k) => k === 'createRadialGradient' ? () => gradient : (...a: unknown[]) => { calls.push(String(k)); },
      set: () => true,
    }),
  };
}

test('drawBeams draws the firings on screen and nothing for an old replay', () => {
  const rows = [firing()];
  const view = { viewW: 1000, viewH: 1000, center: { x: 500, z: 500 }, scale: 1 };
  const data = { beams: rows, weapons: new Map([[7, PULSAR]]), fxIndex: { beams: { between: between(rows) } } };
  const on = fakeContext();
  load({ data, ...view }).drawBeams(on.ctx, 1020, null);
  assert.ok(on.calls.filter(k => k === 'stroke').length >= 3);
  const off = fakeContext();
  load({ data, ...view }).drawBeams(off.ctx, 2000, null);
  eq(off.calls, []);
  for (const old of [null, {}, { beams: [] }]) {
    const none = fakeContext();
    load({ data: old, ...view }).drawBeams(none.ctx, 10, null);
    eq(none.calls, []);
  }
});

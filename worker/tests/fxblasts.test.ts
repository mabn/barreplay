import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../public/fx-blasts.js';

// fx-blasts.js is a plain browser script that publishes the FxBlasts global.
const Fx = (globalThis as any).FxBlasts;

const weapons = new Map<number, any>([
  [1, { id: 1, name: 'fusion_death', aoe: 480, expSpeed: 20 }],
  [2, { id: 2, name: 'nuclear_missile', aoe: 640, class: 'nuke', expSpeed: 49, cp: { nuclear: 1 } }],
  [3, { id: 3, name: 'lrpc', aoe: 67.5, class: 'artillery' }],
  [4, { id: 4, name: 'ata', aoe: 8, class: 'beam' }],
  [5, { id: 5, name: 'armemp_weapon', aoe: 156, class: 'emp', paralyzer: true }],
]);

test('collect merges W blasts with exploded track ends, sorted by frame', () => {
  const fx = Fx.collect(
    [{ f: 300, weapon: 1, x: 100, y: 0, z: 200, unit: 7, team: 0, kind: 1 }],
    [
      { end: 120, weapon: 3, class: 6, endKind: 1, flags: 0, x1: 10, z1: 20, team: 1 },
      { end: 50, weapon: 4, class: 8, endKind: 1, flags: 0, x1: 0, z1: 0, team: 1 }, // beam: not ours
      { end: 60, weapon: 3, class: 6, endKind: 0, flags: 0, x1: 0, z1: 0, team: 1 }, // still flying
      { end: 70, weapon: 3, class: 6, endKind: 2, flags: 0, x1: 0, z1: 0, team: 1 }, // vanished
    ],
    weapons,
  );
  assert.deepEqual(fx.list.map((e: any) => [e.f, e.x, e.z]), [[120, 10, 20], [300, 100, 200]]);
  assert.equal(fx.list[1].aoe, 480);
  assert.ok(fx.maxLife >= fx.list[1].life);
});

test('old replays (no sections) collect nothing and draw nothing', () => {
  const fx = Fx.collect(undefined, undefined, undefined);
  assert.equal(fx.list.length, 0);
  assert.equal(Fx.draw(null, fx, 100, { cx: 0, cz: 0, scale: 1, w: 100, h: 100 }), 0);
});

test('size and lifetime follow the weapon', () => {
  const small = Fx.look(weapons.get(3), 6, false);
  const fusion = Fx.look(weapons.get(1), 0, false);
  const nuke = Fx.look(weapons.get(2), 1, false);
  assert.ok(small.life < fusion.life && fusion.life < nuke.life);
  assert.equal(small.ring, false);
  assert.equal(fusion.ring, true);
  assert.ok(nuke.life <= Fx.LIFE_MAX);
  assert.equal(Fx.look(undefined, 0, false).aoe, Fx.DEFAULT_AOE);
});

test('an intercepted nuke is a small puff, not a nuclear fireball', () => {
  const L = Fx.look(weapons.get(2), 1, true);
  assert.ok(L.aoe <= 60);
  assert.equal(L.ring, false);
});

test('stage grows, fades and ends; it is a pure function of the frame', () => {
  const e = { ...Fx.look(weapons.get(1), 0, false), f: 0 };
  assert.equal(Fx.stage(e, -0.5), null);
  const s0 = Fx.stage(e, 0), s1 = Fx.stage(e, 3.5), s2 = Fx.stage(e, e.life - 1);
  assert.ok(s0.r < s1.r, 'grows');
  assert.ok(s0.a > s1.a && s1.a > s2.a, 'fades');
  assert.equal(Fx.stage(e, e.life), null);
  assert.deepEqual(Fx.stage(e, 3.5), s1);
});

test('draw culls off-screen blasts and draws live ones at fractional frames', () => {
  const calls: string[] = [];
  const ctx: any = new Proxy({}, {
    get(_t, k) {
      if (k === 'createRadialGradient') return () => ({ addColorStop() {} });
      return (...a: any[]) => { calls.push(String(k)); };
    },
    set() { return true; },
  });
  const fx = Fx.collect([
    { f: 100, weapon: 1, x: 0, z: 0, team: 0, kind: 1 },
    { f: 100, weapon: 1, x: 100000, z: 0, team: 0, kind: 1 }, // far off screen
  ], [], weapons);
  const view = { cx: 0, cz: 0, scale: 0.1, w: 800, h: 600 };
  assert.equal(Fx.draw(ctx, fx, 99.5, view), 0);
  assert.equal(Fx.draw(ctx, fx, 100.25, view), 1);
  assert.equal(Fx.draw(ctx, fx, 100 + fx.maxLife + 1, view), 0);
  assert.ok(calls.includes('fill'));
});

test('fast playback stretches a blast so it stays visible', () => {
  assert.equal(Fx.stretchFor(1), 1);
  assert.equal(Fx.stretchFor(2), 1);
  assert.equal(Fx.stretchFor(8), 4);
  assert.equal(Fx.stretchFor(64), 6);
  const ctx: any = new Proxy({}, {
    get(_t, k) { return k === 'createRadialGradient' ? () => ({ addColorStop() {} }) : () => {}; },
    set() { return true; },
  });
  const fx = Fx.collect([{ f: 100, weapon: 3, x: 0, z: 0, team: 0, kind: 1 }], [], weapons);
  const late = 100 + fx.list[0].life + 5;
  const view = { cx: 0, cz: 0, scale: 0.1, w: 800, h: 600 };
  assert.equal(Fx.draw(ctx, fx, late, view), 0);
  assert.equal(Fx.draw(ctx, fx, late, { ...view, stretch: 4 }), 1);
});

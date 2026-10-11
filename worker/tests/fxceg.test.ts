import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../public/fx-ceg.js';
import '../public/fx-cegdata.js';

// fx-ceg.js and fx-cegdata.js are plain browser scripts that publish the
// FxCeg and BAR_CEGS globals.
const C = (globalThis as any).FxCeg;
const DATA = (globalThis as any).BAR_CEGS;

const ctx = (rnd = () => 0.5, damage = 0, index = 0) => ({ rnd, damage, index, buf: new Float64Array(16) });
const val = (v: any, c = ctx()) => C.compileValue(v).map((ops: number[]) => C.run(ops, c));

test('the CEG expression language follows ExecuteExplosionCode', () => {
  assert.deepEqual(val('1 2'), [3]);
  assert.deepEqual(val('r4'), [2]); // rnd 0.5
  assert.deepEqual(val('i3', ctx(() => 0, 0, 2)), [6]);
  assert.deepEqual(val('d0.5', ctx(() => 0, 100)), [50]);
  assert.deepEqual(val('7 m3'), [1]);
  assert.deepEqual(val('7 k3'), [6]);
  assert.deepEqual(val('2 p3'), [8]);
  // y stores and clears, x multiplies by the register, a adds it.
  assert.deepEqual(val('3 y0 2 x0'), [6]);
  assert.deepEqual(val('3 y1 2 a1'), [5]);
  assert.deepEqual(val('1, -2, r2'), [1, -2, 1]);
  assert.equal(C.compileValue('dir'), 'dir');
  assert.deepEqual(val(5), [5]);
});

test('colour maps interpolate linearly and clamp', () => {
  const m = C.colorMap('0 0 0 0   1 1 1 1   1 0 0 2');
  const out = new Float32Array(4);
  assert.deepEqual([...C.colorAt(m, 0.25, out)], [0.5, 0.5, 0.5, 0.5]);
  assert.deepEqual([...C.colorAt(m, 1, out)], [1, 0, 0, 1]); // alpha 2 clamped
  assert.deepEqual([...C.colorAt(m, -1, out)], [0, 0, 0, 0]);
});

test('closed-form motion matches stepping the engine update', () => {
  for (const [v, g, d] of [[3, -0.2, 0.9], [1, 0.1, 1], [-2, 0, 0.5]]) {
    let x = 0, vel = v;
    for (let n = 1; n <= 40; n++) {
      x += vel; vel += g; vel *= d;
      const [tx, tv] = C.travel(v, g, d, n);
      assert.ok(Math.abs(tx - x) < 1e-6, `travel ${v},${g},${d} @${n}: ${tx} vs ${x}`);
      assert.ok(Math.abs(tv - vel) < 1e-6);
    }
  }
  let s = 10;
  for (let n = 1; n <= 30; n++) {
    s = s * 0.95 + 2;
    assert.ok(Math.abs(C.grown(10, 2, 0.95, n) - s) < 1e-6);
  }
});

test('flipbooks loop, or play forwards and back when the period is negative', () => {
  assert.equal(C.animAt(0, 50), 0);
  assert.equal(C.animAt(40, 10), 0.25);
  assert.equal(C.animAt(40, 50), 0.25);
  assert.equal(C.animAt(-40, 60), 0.5);
  assert.equal(C.animAt(-40, 70), 0.25);
});

test('cegFor finds a weapon by name, scavenger copies included, else by blast size', () => {
  const data = { weapons: { armfus_fusionexplosion: 'fusexpl' }, cegs: { fusexpl: {} } };
  assert.equal(C.cegFor(data, { name: 'armfus_fusionexplosion' }), 'fusexpl');
  assert.equal(C.cegFor(data, { name: 'armfus_scav_fusionexplosion' }), 'fusexpl');
  assert.equal(C.cegFor(data, { name: 'x', cp: { nuclear: 1 } }), 'newnuke');
  assert.equal(C.cegFor(data, { name: 'x', aoe: 300 }), 'genericshellexplosion-huge');
  assert.equal(C.cegFor(data, { name: 'x', aoe: 10 }), 'genericshellexplosion-tiny');
});

test('an explosion spawns the same particles every time', () => {
  const lib = C.Library(DATA);
  const e = { f: 100, x: 500, y: 0, z: 700, w: { name: 'x', aoe: 300 }, icp: false };
  const a = C.particlesOf(lib, e, 3), b = C.particlesOf(lib, e, 3);
  assert.ok(a.ps.length > 0);
  assert.deepEqual(JSON.stringify(a.ps), JSON.stringify(b.ps));
  assert.ok(a.life > 0);
});

test('nothing below the ground under a ground explosion is drawn', () => {
  const lib = { data: {}, get: (n: string) => n === 't' ? C.compileCeg({
    sunk: { class: 'heatcloudprojectile', count: 1, flags: ['ground'],
      props: { heat: 10, maxheat: 10, heatfalloff: 1, size: 5, pos: '0, -100, 0', texture: 'glow2' } },
    up: { class: 'heatcloudprojectile', count: 1, flags: ['ground'],
      props: { heat: 10, maxheat: 10, heatfalloff: 1, size: 5, pos: '0, 20, 0', texture: 'glow2' } },
  }) : null };
  const ps = C.spawn(lib, 't', { x: 0, y: 50, z: 0, damage: 0, flags: C.F.ground }, C.rng(1));
  let drawn = 0;
  for (const p of ps) C.quads(p, 2, () => { drawn++; });
  assert.equal(drawn, 1);
});

test('the shipped effect table covers BAR and measures every texture it uses', () => {
  assert.ok(Object.keys(DATA.weapons).length > 500);
  assert.ok(DATA.cegs.fusexpl && DATA.cegs.newnuke && DATA.cegs['genericshellexplosion-medium']);
  const used = new Set<string>();
  for (const def of Object.values<any>(DATA.cegs)) {
    for (const sp of Object.values<any>(def)) {
      for (const k of ['texture', 'fronttexture', 'sidetexture']) {
        const t = sp.props && sp.props[k];
        if (t && t !== 'none') used.add(t);
      }
    }
  }
  const missing = [...used].filter(t => !DATA.textures[t]);
  // A texture BAR names but does not ship (bloodblast) falls back to a glow.
  assert.ok(missing.length <= 2, `unmeasured: ${missing.join(' ')}`);
});

test('the atlas paints one cell per measured frame plus the fallback glow', () => {
  const at = C.buildAtlas(DATA.textures, 16, 16);
  let frames = 1;
  for (const t of Object.values<any>(DATA.textures)) frames += t.frames.length;
  const cells = [...at.cells.values()];
  assert.equal(cells.reduce((s: number, c: any) => s + c.n, 0), frames);
  assert.equal(at.px.length, at.w * at.h * 4);
  // The centre of a bright flare is bright, its corner dark.
  const c = at.cells.get('exploflare').base;
  const x0 = (c % at.cols) * 16, y0 = Math.floor(c / at.cols) * 16;
  const px = (x: number, y: number) => at.px[((y0 + y) * at.w + x0 + x) * 4];
  assert.ok(px(8, 8) > 150 && px(0, 0) < 40, `${px(8, 8)} ${px(0, 0)}`);
  // An unknown texture draws as the fallback; a flipbook picks its frame.
  assert.equal(C.cellIn(at.cells, 'no such texture', 0), at.cells.get('').base);
  const fb = at.cells.get('fireball02-anim');
  assert.equal(C.cellIn(at.cells, 'fireball02-anim', 1), fb.base + fb.n - 1);
});

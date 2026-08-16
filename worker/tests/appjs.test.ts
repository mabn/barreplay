import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// worker/public/app.js is the whole front-end and has no build step, no module
// system and no type checker — it is loaded as one plain script. Nothing
// therefore notices when a function is called but not defined: `node --check`
// only parses, and the failure surfaces in a browser as a ReferenceError that
// takes the entire replay view down with it.
//
// This is not hypothetical. An edit that spliced one region of the file
// silently swallowed renderChat and updateChat; the syntax stayed valid, every
// other test passed, and loadReplay would have thrown on the first replay
// opened. This test is that mistake's tripwire.

const APP = readFileSync(fileURLToPath(new URL('../public/app.js', import.meta.url)), 'utf8');

// Globals the browser provides that node does not, so `in globalThis` cannot
// vouch for them. Listed explicitly rather than pattern-matched: a genuinely
// new undefined call must fail, not be waved through.
const BROWSER_GLOBALS = new Set(['Image', 'requestAnimationFrame', 'cancelAnimationFrame', 'XMLHttpRequest']);

const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'await',
  'new', 'do', 'else', 'in', 'of', 'case', 'delete', 'void', 'yield', 'instanceof',
  'super', 'import', 'export', 'class', 'throw', 'try', 'async',
]);

// stripLiterals blanks out comments and string/template literals so prose and
// GLSL shader source are not mistaken for code.
function stripLiterals(src: string): string {
  let out = '', i = 0;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
      i++; out += '""'; continue;
    }
    out += c; i++;
  }
  return out;
}

function declaredNames(code: string): Set<string> {
  const names = new Set<string>();
  const add = (n: string) => { if (/^[A-Za-z_$][\w$]*$/.test(n)) names.add(n); };
  for (const m of code.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)) add(m[1]);
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of code.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=/g))
    for (const n of m[1].split(',')) add(n.trim().split(':').pop()!.trim());
  // Parameters, which are call targets when a callback is passed in.
  for (const m of code.matchAll(/\(([^()]*)\)\s*=>/g))
    for (const n of m[1].split(',')) add(n.trim().replace(/=.*/, '').trim());
  for (const m of code.matchAll(/\bfunction\s*[A-Za-z_$\w]*\s*\(([^()]*)\)/g))
    for (const n of m[1].split(',')) add(n.trim().replace(/=.*/, '').trim());
  return names;
}

test('every function app.js calls is defined somewhere', () => {
  const code = stripLiterals(APP);
  const declared = declaredNames(code);
  const missing = new Set<string>();
  // Bare `name(` calls only — a leading '.' means it is a method on something
  // else, which this cannot and need not resolve.
  for (const m of code.matchAll(/(^|[^\w$.])([a-zA-Z_$][\w$]*)\s*\(/gm)) {
    const n = m[2];
    if (declared.has(n) || KEYWORDS.has(n) || BROWSER_GLOBALS.has(n) || n in globalThis) continue;
    missing.add(n);
  }
  assert.deepEqual([...missing], [], 'called but never defined in app.js');
});

// The pieces the viewer cannot start without. Named explicitly so deleting one
// fails loudly here rather than quietly in a browser.
test('app.js still defines its load-path entry points', () => {
  for (const fn of [
    'decodeHead', 'decodeFrames', 'decodeEvents', 'decodeComms',
    'loadReplay', 'renderChat', 'updateChat', 'drawChatBubbles', 'drawMarks',
    'buildCommIndex', 'buildCommanderDefs', 'draw', 'drawOverlay',
  ]) {
    assert.ok(new RegExp(`function ${fn}\\s*\\(`).test(APP), `app.js must define ${fn}()`);
  }
});

// The sidebar chat panel's scroll rule, pinned because it is subtle and easy to
// get wrong: show only what has been said, stay parked at the bottom, stop
// following once the reader scrolls away, resume when they scroll back down.
// app.js has no module system, so the two functions are lifted out and run
// against a DOM stub.
test('chat log shows only sent lines and sticks to the bottom', () => {
  const extract = (n: string) => {
    const start = APP.indexOf(`function ${n}(`);
    let depth = 0;
    for (let j = APP.indexOf('{', start); j < APP.length; j++) {
      if (APP[j] === '{') depth++;
      else if (APP[j] === '}' && --depth === 0) return APP.slice(start, j + 1);
    }
    throw new Error('not found: ' + n);
  };
  const CHAT_STICK_SLACK = Number(APP.match(/const CHAT_STICK_SLACK = (\d+);/)![1]);
  const CHAT_DEST_TAG = { all: '', ally: 'ally' };

  const ROW_H = 20, BOX_H = 100;
  // className and classList are ONE store in a real DOM; the stub must be too.
  const mkRow = () => {
    const cls = new Set<string>();
    return {
      set className(v: string) { cls.clear(); for (const c of String(v).split(/\s+/)) if (c) cls.add(c); },
      get className() { return [...cls].join(' '); },
      title: '', innerHTML: '',
      classList: { toggle: (c: string, on: boolean) => on ? cls.add(c) : cls.delete(c) },
      addEventListener() {},
      get hidden() { return cls.has('future'); },
    };
  };
  let scrollTop = 0;
  const box: any = {
    children: [] as any[],
    clientHeight: BOX_H,
    onscroll: null as null | (() => void),
    set innerHTML(_v: string) { this.children = []; },
    get scrollHeight() { return this.children.filter((r: any) => !r.hidden).length * ROW_H; },
    appendChild(r: any) { this.children.push(r); },
  };
  // Assigning scrollTop fires a scroll event in a browser; mirror that, since
  // the stick rule depends on our own scrolls re-confirming it.
  Object.defineProperty(box, 'scrollTop', {
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = Math.max(0, Math.min(v, box.scrollHeight - box.clientHeight));
      box.onscroll?.();
    },
  });
  const document = { getElementById: (id: string) => id === 'chat' ? box : { style: {} }, createElement: mkRow };

  let chatLines: any[] = [], chatBuilt = false, chatCursor = -1, chatStick = true;
  const data = { sampleEvery: 30 };
  const escapeHtml = (s: any) => String(s), fmtTime = (s: number) => String(s | 0);
  const commColor = () => '#fff', commName = () => 'p', go = () => {};

  const api = eval(`(function(){
    ${extract('renderChat')}
    ${extract('updateChat')}
    return { renderChat, updateChat, setChat: c => { chatLines = c; },
      stick: () => chatStick,
      shown: () => box.children.filter(r => !r.hidden).length,
      max: () => Math.max(0, box.scrollHeight - box.clientHeight) };
  })()`);

  api.setChat(Array.from({ length: 20 }, (_, i) => ({ f: i * 30, p: 1, t: 'm' + i, d: 'all' })));
  api.renderChat();
  assert.equal(api.shown(), 0, 'nothing is shown before the playhead reaches it');

  api.updateChat(300);
  assert.equal(api.shown(), 11, 'exactly the lines said by frame 300');
  assert.equal(box.scrollTop, api.max(), 'parked at the bottom');

  // Reader scrolls up: following must stop, and stay stopped as lines arrive.
  box.scrollTop = 0;
  assert.equal(api.stick(), false, 'scrolling away unsticks');
  api.updateChat(600);
  assert.equal(box.scrollTop, 0, 'an unstuck box must not be yanked to the bottom');

  // Scrolling back to the bottom resumes following.
  box.scrollTop = box.scrollHeight;
  assert.equal(api.stick(), true, 'returning to the bottom re-sticks');
  api.updateChat(660);
  assert.equal(box.scrollTop, api.max(), 'and it follows again');

  // Scrubbing backwards hides the lines that have un-happened.
  api.updateChat(90);
  assert.equal(api.shown(), 4, 'scrubbing back re-hides later lines');
  assert.ok(CHAT_STICK_SLACK >= 0);
});

// Chat bubbles: the timing rules, which took three passes to get right and are
// invisible to every other check. Lifted out and run against a recording
// context stub, since app.js has no module system.
test('chat bubbles fade smoothly and are not re-timed by a speed change', () => {
  const extract = (n: string) => {
    const start = APP.indexOf(`function ${n}(`);
    let depth = 0;
    for (let j = APP.indexOf('{', start); j < APP.length; j++) {
      if (APP[j] === '{') depth++;
      else if (APP[j] === '}' && --depth === 0) return APP.slice(start, j + 1);
    }
    throw new Error('not found: ' + n);
  };
  const consts = APP.match(/^const BUBBLE_[A-Z_]+ = .*$/gm)!.join('\n');

  const calls: any[] = [];
  const octx: any = new Proxy({}, {
    get: (_t, k) => k === 'measureText' ? ((s: string) => ({ width: s.length * 6 })) : ((...a: any[]) => calls.push([k, ...a])),
    set: (_t, k, v) => { calls.push(['set:' + String(k), v]); return true; },
  });
  const STRIDE = 11, F = { ID: 0, DEF: 1, TEAM: 2, X: 3, Z: 4, HP: 5, MAXHP: 6, DVX: 7, DVZ: 8, BUILD: 9, TARGET: 10 };
  const viewW = 800, viewH = 600, scale = 0.1, center = { x: 0, z: 0 };
  const teamColor: any = { 0: '#ff2020' };
  const commTeamOf = new Map([[1, 0]]);
  const defIsCom = new Map([[58, true]]);
  const interpPos = (u: any, i: number) => [u[i + F.X], u[i + F.Z]];
  const cssToTint = () => [1, 0.125, 0.125];
  let chatLines: any[] = [], bubbleAnchor = new Map(), bubbleExpiry = new Map();
  const bubbleText = new Map();
  let playRAF: any = 1, speedValue = 1;
  const document = { getElementById: () => ({ value: String(speedValue) }) };

  const api = eval(`(function(){
    ${consts}
    ${extract('bubbleSpeedFactor')}
    ${extract('firstChatAt')}
    ${extract('textColorOn')}
    ${extract('roundRectPath')}
    ${extract('fitBubbleText')}
    ${extract('drawChatBubbles')}
    return { draw: drawChatBubbles, setChat: c => { chatLines = c; }, setSpeed: v => { speedValue = v; } };
  })()`);

  const u = new Int32Array([100, 58, 0, 1000, 2000, 9, 9, 0, 0, 255, 0]);
  const alphasAt = (f: number) => {
    calls.length = 0;
    api.draw(f, u);
    const texts = calls.filter(c => c[0] === 'fillText').length;
    const a = calls.filter(c => c[0] === 'set:globalAlpha').map(c => c[1]);
    return { texts, alpha: a.length ? a[0] : null };
  };

  // FRACTIONAL frames must move the alpha. Passing whole sample frames is what
  // made the fade step once per game-second instead of animating.
  api.setChat([{ f: 0, p: 1, t: 'x', d: 'all' }]);
  bubbleExpiry.clear(); bubbleAnchor.clear();
  const lifetime = Number(APP.match(/const BUBBLE_LIFETIME = (\d+);/)![1]) * 30;
  const fade = Number(APP.match(/const BUBBLE_FADE = (\d+);/)![1]) * 30;
  const mid = lifetime - fade / 2;                 // halfway through the fade
  const a1 = alphasAt(mid).alpha, a2 = alphasAt(mid + 7.5).alpha;
  assert.ok(a1! > a2!, 'alpha must decrease within a single sample interval');
  assert.ok(a1! < 1 && a2! > 0, `mid-fade alphas should be strictly between 0 and 1, got ${a1} and ${a2}`);
  assert.equal(alphasAt(lifetime - 0.001).texts, 1, 'still up just before expiry');
  assert.equal(alphasAt(lifetime).texts, 0, 'gone at expiry');

  // A SPEED CHANGE must not re-time a bubble already on screen.
  bubbleExpiry.clear(); bubbleAnchor.clear();
  api.setSpeed(1);
  assert.equal(alphasAt(10).texts, 1, 'bubble is up at 1x');
  api.setSpeed(16);                                  // user hits 16x mid-playback
  assert.equal(alphasAt(lifetime + 60).texts, 0, 'speeding up must not resurrect it');
  // ...and the reverse: a bubble born at 16x keeps its long life when slowed.
  bubbleExpiry.clear(); bubbleAnchor.clear();
  api.setChat([{ f: 1000, p: 1, t: 'x', d: 'all' }]);
  assert.equal(alphasAt(1010).texts, 1, 'born at 16x');
  api.setSpeed(1);
  assert.equal(alphasAt(1000 + lifetime + 60).texts, 1, 'slowing down must not cut it short');
});

// Build progress bars advance between samples rather than stepping once per
// sample, and do not rewind when the engine recycles a unit id.
test('build progress interpolates toward the next sample', () => {
  const extract = (n: string) => {
    const start = APP.indexOf(`function ${n}(`);
    let depth = 0;
    for (let j = APP.indexOf('{', start); j < APP.length; j++) {
      if (APP[j] === '{') depth++;
      else if (APP[j] === '}' && --depth === 0) return APP.slice(start, j + 1);
    }
    throw new Error('not found: ' + n);
  };
  const STRIDE = 11;
  const F = { ID: 0, DEF: 1, TEAM: 2, X: 3, Z: 4, HP: 5, MAXHP: 6, DVX: 7, DVZ: 8, BUILD: 9, TARGET: 10 };
  let renderFrac = 0, nextU: Int32Array | null = null, nextPosMap: Map<number, number> | null = null;

  const api = eval(`(function(){
    ${extract('interpBuild')}
    return { interpBuild,
      set: (frac, nu, map) => { renderFrac = frac; nextU = nu; nextPosMap = map; } };
  })()`);

  //                id   def team  x  z  hp max dvx dvz build target
  const u = new Int32Array([7, 3, 0, 0, 0, 9, 9, 0, 0, 100, 0]);
  const next = new Int32Array([7, 3, 0, 0, 0, 9, 9, 0, 0, 200, 0]);
  const map = new Map([[7, 0]]);

  api.set(0, next, map);
  assert.equal(api.interpBuild(u, 0), 100, 'no sub-sample offset: the stored value');
  api.set(0.5, next, map);
  assert.equal(api.interpBuild(u, 0), 150, 'halfway between the two samples');
  api.set(0.25, next, map);
  assert.equal(api.interpBuild(u, 0), 125, 'and it is a plain lerp, not a step');

  // Next sample not streamed in yet, or the unit is gone from it.
  api.set(0.5, null, null);
  assert.equal(api.interpBuild(u, 0), 100, 'no next sample: hold the stored value');
  api.set(0.5, next, new Map());
  assert.equal(api.interpBuild(u, 0), 100, 'unit absent from the next sample: hold');

  // Recycled id: same id, different def. Must NOT animate toward a stranger's
  // progress, which would show as a bar rewinding.
  const recycled = new Int32Array([7, 99, 0, 0, 0, 9, 9, 0, 0, 5, 0]);
  api.set(0.5, recycled, map);
  assert.equal(api.interpBuild(u, 0), 100, 'a recycled id must not rewind the bar');
});

// The timeline thumb tracks the continuous playhead, so it glides during
// playback instead of ticking once per sample (one wall-second apart at 1x).
test('the slider follows the continuous playhead, not the sample index', () => {
  const extract = (n: string) => {
    const start = APP.indexOf(`function ${n}(`);
    let depth = 0;
    for (let j = APP.indexOf('{', start); j < APP.length; j++) {
      if (APP[j] === '{') depth++;
      else if (APP[j] === '}' && --depth === 0) return APP.slice(start, j + 1);
    }
    throw new Error('not found: ' + n);
  };
  const slider: any = { value: null };
  const label: any = { textContent: null };
  const document = { getElementById: (id: string) => id === 'slider' ? slider : label };
  let idx = 0, playPos = 0, renderFrac = 0, secPerFrame = 1;
  let lastTimeText: string | null = null, lastSliderPos = -1;
  const data = { frameCount: 100, sampleEvery: 30, chunks: [{ frame: 0, count: 100 }] };
  const frameNumAt = (i: number) => i * 30;
  const fmtTime = (t: number) => String(Math.floor(t));

  const api = eval(`(function(){
    ${extract('updateTimeLabel')}
    return { update: (i, p, f) => { idx = i; playPos = p; renderFrac = f; updateTimeLabel(); } };
  })()`);

  api.update(4, 4, 0);
  assert.equal(slider.value, 4, 'on a whole sample the thumb is on it');
  api.update(4, 4.25, 0.25);
  assert.equal(slider.value, 4.25, 'a quarter into the interval the thumb is a quarter along');
  api.update(4, 4.5, 0.5);
  assert.equal(slider.value, 4.5, 'and it keeps moving without the index changing');

  // The markup must permit it: a stepped range snaps a fractional assignment.
  const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
  assert.match(html, /id="slider"[^>]*step="any"/, 'the slider needs step="any" to sit between samples');
});

// Bubble text is trimmed to a width cap with an ellipsis, and the answer is
// memoized — the trim drops one character at a time, so without the cache it
// re-measured the whole tail of every long message on every rendered frame.
test('bubble text is fitted to the cap once and reused', () => {
  const extract = (n: string) => {
    const start = APP.indexOf(`function ${n}(`);
    let depth = 0;
    for (let j = APP.indexOf('{', start); j < APP.length; j++) {
      if (APP[j] === '{') depth++;
      else if (APP[j] === '}' && --depth === 0) return APP.slice(start, j + 1);
    }
    throw new Error('not found: ' + n);
  };
  const BUBBLE_MAX_PX = Number(APP.match(/const BUBBLE_MAX_PX = (\d+);/)![1]);
  const PX_PER_CHAR = 6;
  let measures = 0;
  const octx = { measureText: (s: string) => { measures++; return { width: s.length * PX_PER_CHAR }; } };
  const bubbleText = new Map();
  const fit = eval(`(function(){ ${extract('fitBubbleText')} return fitBubbleText; })()`);

  const fits = 'x'.repeat(Math.floor(BUBBLE_MAX_PX / PX_PER_CHAR));
  assert.deepEqual(fit(fits), [fits, BUBBLE_MAX_PX], 'text at exactly the cap is untouched');

  const long = 'y'.repeat(Math.floor(BUBBLE_MAX_PX / PX_PER_CHAR) * 3);
  const [text, w] = fit(long);
  assert.ok(text.endsWith('…'), 'overlong text gets an ellipsis');
  assert.ok(w <= BUBBLE_MAX_PX, `fitted width ${w} must not exceed the cap ${BUBBLE_MAX_PX}`);
  assert.ok(text.length < long.length, 'and is actually shorter');

  measures = 0;
  const again = fit(long);
  assert.equal(measures, 0, 'a repeat fit must not measure again');
  assert.equal(again[0], text, 'and returns the same result');
});

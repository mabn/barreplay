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
  const commTeamOf = new Map([[1, 0], [5, -1], [6, -1]]); // 5 and 6 are spectators
  const defIsCom = new Map([[58, true]]);
  const interpPos = (u: any, i: number) => [u[i + F.X], u[i + F.Z]];
  const cssToTint = () => [1, 0.125, 0.125];
  const SPEC_KEY = 'spec';
  const SPEC_BG = '#0b0e12', SPEC_NAME_INK = '#ffd24a', SPEC_ALL_INK = '#ffffff';
  const BUBBLE_MIN_TEXT_PX = 60;
  const quietSpot = () => [7000, 7000];
  const commName = (c: any) => 'huk' + c.p;
  let chatLines: any[] = [], bubbleAnchor = new Map(), bubbleExpiry = new Map();
  const bubbleText = new Map();
  let playRAF: any = 1, speedValue = 1, showBubbles = true;
  const document = { getElementById: () => ({ value: String(speedValue) }) };

  const api = eval(`(function(){
    ${consts}
    ${extract('bubbleSpeedFactor')}
    ${extract('firstChatAt')}
    ${extract('textColorOn')}
    ${extract('roundRectPath')}
    ${extract('fitBubbleText')}
    ${extract('chatBody')}
    ${extract('bubbleRuns')}
    ${extract('drawChatBubbles')}
    return { draw: drawChatBubbles, setChat: c => { chatLines = c; }, setSpeed: v => { speedValue = v; },
      setShow: v => { showBubbles = v; } };
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
  const fit0 = eval(`(function(){ ${extract('fitBubbleText')} return fitBubbleText; })()`);
  const fit = (raw: string) => fit0(raw, BUBBLE_MAX_PX);

  // The widest string that still fits. Its width is its own, not the cap —
  // the cap need not be a whole number of characters wide.
  const fits = 'x'.repeat(Math.floor(BUBBLE_MAX_PX / PX_PER_CHAR));
  assert.deepEqual(fit(fits), [fits, fits.length * PX_PER_CHAR], 'text within the cap is untouched');
  assert.ok(fits.length * PX_PER_CHAR <= BUBBLE_MAX_PX, 'and it really does fit');

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

// Spectator bubbles: black, two-tone, sharing one stack on borrowed ground —
// and the whole layer switchable from the sidebar.
test('spectator bubbles are formatted and coloured apart from players', () => {
  const extract = (n: string) => {
    const start = APP.indexOf(`function ${n}(`);
    let depth = 0;
    for (let j = APP.indexOf('{', start); j < APP.length; j++) {
      if (APP[j] === '{') depth++;
      else if (APP[j] === '}' && --depth === 0) return APP.slice(start, j + 1);
    }
    throw new Error('not found: ' + n);
  };
  const consts = APP.match(/^const (?:BUBBLE|SPEC|QUIET)_[A-Z_]+ = .*$/gm)!.join('\n');

  const calls: any[] = [];
  const octx: any = new Proxy({}, {
    get: (_t, k) => k === 'measureText' ? ((s: string) => ({ width: s.length * 6 })) : ((...a: any[]) => calls.push([k, ...a])),
    set: (_t, k, v) => { calls.push(['set:' + String(k), v]); return true; },
  });
  const STRIDE = 11;
  const F = { ID: 0, DEF: 1, TEAM: 2, X: 3, Z: 4, HP: 5, MAXHP: 6, DVX: 7, DVZ: 8, BUILD: 9, TARGET: 10 };
  const viewW = 800, viewH = 600, scale = 0.1, center = { x: 7000, z: 7000 };
  const teamColor: any = { 0: '#ff2020' };
  const commTeamOf = new Map([[1, 0], [5, -1], [6, -1]]);
  const defIsCom = new Map([[58, true]]);
  const interpPos = (u: any, i: number) => [u[i + F.X], u[i + F.Z]];
  const cssToTint = () => [1, 1, 1];
  const quietSpot = () => [7000, 7000];
  const commName = (c: any) => 'huk' + c.p;
  let chatLines: any[] = [], bubbleAnchor = new Map(), bubbleExpiry = new Map();
  const bubbleText = new Map();
  let playRAF: any = null, speedValue = 1, showBubbles = true;
  const document = { getElementById: () => ({ value: String(speedValue) }) };

  const api = eval(`(function(){
    ${consts}
    ${extract('bubbleSpeedFactor')}
    ${extract('firstChatAt')}
    ${extract('textColorOn')}
    ${extract('roundRectPath')}
    ${extract('fitBubbleText')}
    ${extract('chatBody')}
    ${extract('bubbleRuns')}
    ${extract('drawChatBubbles')}
    return { draw: drawChatBubbles, setChat: c => { chatLines = c; }, setShow: v => { showBubbles = v; } };
  })()`);

  // Commander parked at the same place the stubbed quiet spot returns, so
  // player and spectator bubbles are both on screen for one viewport.
  const u = new Int32Array([100, 58, 0, 7000, 7000, 9, 9, 0, 0, 255, 0]);
  const drawn = (frame: number) => {
    calls.length = 0;
    bubbleAnchor.clear(); bubbleExpiry.clear();
    api.draw(frame, u);
    const runs: [string, string][] = [];
    let ink = '';
    for (const c of calls) {
      if (c[0] === 'set:fillStyle') ink = c[1];
      else if (c[0] === 'fillText') runs.push([c[1], ink]);
    }
    return { runs, bg: calls.filter(c => c[0] === 'set:fillStyle').map(c => c[1]) };
  };

  // Talking to the spectator channel: name and message both yellow, no [ALL].
  api.setChat([{ f: 0, p: 5, t: 'asd', d: 'spec' }]);
  let r = drawn(10);
  assert.deepEqual(r.runs, [['(s) huk5: ', '#ffd24a'], ['asd', '#ffd24a']]);
  assert.ok(r.bg.includes('#0b0e12'), 'spectator bubbles are black');

  // Talking to everyone: yellow name, white message, carrying [ALL].
  api.setChat([{ f: 0, p: 5, t: 'hello', d: 'all' }]);
  r = drawn(10);
  assert.deepEqual(r.runs, [['(s) huk5: ', '#ffd24a'], ['[ALL] hello', '#ffffff']]);

  // Two spectators share one stack rather than drawing over each other, and
  // each line still names its own author.
  api.setChat([
    { f: 0, p: 5, t: 'one', d: 'spec' },
    { f: 1, p: 6, t: 'two', d: 'spec' },
  ]);
  r = drawn(10);
  assert.deepEqual(r.runs.map(x => x[0]), ['(s) huk5: ', 'one', '(s) huk6: ', 'two']);

  // A player's bubble stays one run and keeps its team colour. Team chat is the
  // norm, so it is unmarked...
  api.setChat([{ f: 0, p: 1, t: 'push', d: 'ally' }]);
  r = drawn(10);
  assert.deepEqual(r.runs.map(x => x[0]), ['push']);
  assert.ok(r.bg.includes('#ff2020'), 'player bubbles use the team colour');

  // ...while talking to everyone is marked, for players as much as spectators.
  api.setChat([{ f: 0, p: 1, t: 'gg', d: 'all' }]);
  r = drawn(10);
  assert.deepEqual(r.runs.map(x => x[0]), ['[ALL] gg'], 'public chat is marked [ALL]');

  // The sidebar toggle switches the whole layer off.
  api.setShow(false);
  assert.deepEqual(drawn(10).runs, [], 'hidden means nothing is drawn');
  api.setShow(true);
  assert.equal(drawn(10).runs.length, 1, 'and back on again');
});

// The spectators' spot: quiet ground as close to the middle as quiet ground
// gets. Both halves have to hold — the rim is too far from the action, and a
// one-cell gap between two armies is empty without being calm.
test('spectator chat anchors to a calm pocket near the middle', () => {
  const extract = (n: string) => {
    const start = APP.indexOf(`function ${n}(`);
    let depth = 0;
    for (let j = APP.indexOf('{', start); j < APP.length; j++) {
      if (APP[j] === '{') depth++;
      else if (APP[j] === '}' && --depth === 0) return APP.slice(start, j + 1);
    }
    throw new Error('not found: ' + n);
  };
  const QUIET_GRID = Number(APP.match(/const QUIET_GRID = (\d+);/)![1]);
  const QUIET_CENTRE_PULL = Number(APP.match(/const QUIET_CENTRE_PULL = ([\d.]+);/)![1]);
  const STRIDE = 11;
  const F = { ID: 0, DEF: 1, TEAM: 2, X: 3, Z: 4, HP: 5, MAXHP: 6, DVX: 7, DVZ: 8, BUILD: 9, TARGET: 10 };
  const SIZE = 8000, CELL = SIZE / QUIET_GRID, MID = (QUIET_GRID - 1) / 2;
  const data = { bounds: { minX: 0, maxX: SIZE, minZ: 0, maxZ: SIZE } };
  let keyFrames: any[] = [], quietAnchor: any = null;

  const api = eval(`(function(){
    ${extract('quietSpot')}
    return { spot: quietSpot, setKeys: k => { keyFrames = k; quietAnchor = null; } };
  })()`);

  assert.equal(api.spot(), null, 'no keyframe decoded yet: retry later, do not guess');

  // A busy map with three candidates: a calm 3x3 pocket off to one side of the
  // middle, an equally calm pocket out at the rim, and a single empty cell dead
  // centre ringed by the heaviest fighting on the map.
  const POCKET = [10, 9], RIM = [1, 1], LONE_GAP = [8, 8];
  const near = (c: number[], x: number, z: number) => Math.abs(x - c[0]) <= 1 && Math.abs(z - c[1]) <= 1;
  const units: number[] = [];
  for (let cz = 0; cz < QUIET_GRID; cz++) {
    for (let cx = 0; cx < QUIET_GRID; cx++) {
      let n = 20;                                     // ordinary traffic
      if (near(POCKET, cx, cz) || near(RIM, cx, cz)) n = 0;
      else if (near(LONE_GAP, cx, cz)) n = 200;       // the ring around the gap
      if (cx === LONE_GAP[0] && cz === LONE_GAP[1]) n = 0;
      const x = (cx + 0.5) * CELL, z = (cz + 0.5) * CELL;
      for (let k = 0; k < n; k++) units.push(0, 0, 0, x, z, 0, 0, 0, 0, 0, 0);
    }
  }
  const frame = { u: new Int32Array(units) };
  api.setKeys([frame]);
  const spot = api.spot()!;
  const cx = Math.floor(spot[0] / CELL), cz = Math.floor(spot[1] / CELL);

  // Count what is actually in and around the cell it chose.
  const at = (x: number, z: number) => units.filter((_, i) =>
    i % STRIDE === 0 && Math.floor(frame.u[i + F.X] / CELL) === x && Math.floor(frame.u[i + F.Z] / CELL) === z).length;
  assert.equal(at(cx, cz), 0, 'the chosen cell holds no units');
  assert.ok(near(POCKET, cx, cz), `expected the calm pocket near the middle, got cell ${cx},${cz}`);

  const dist = (c: number[]) => Math.hypot(c[0] - MID, c[1] - MID);
  assert.ok(dist([cx, cz]) < dist(RIM), 'closer to the middle than the rim pocket');
  assert.ok(!(cx === LONE_GAP[0] && cz === LONE_GAP[1]),
    'a one-cell gap ringed by fighting is empty but not calm, and must lose');
  assert.ok(QUIET_CENTRE_PULL > 0, 'the middle has to be preferred at all');

  // Resolved once: a later keyframe must not move it.
  const again = api.spot();
  assert.deepEqual(again, spot, 'the spot is stable for the replay');
});

// A player who has lost everything still gets a bubble: at the last place their
// team was seen on the map, which is exactly when people have something to say.
test('a wiped-out team speaks from where it was last seen', () => {
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
  const defIsCom = new Map([[58, true], [77, false]]);
  const unit = (id: number, def: number, team: number, x: number, z: number) =>
    [id, def, team, x, z, 9, 9, 0, 0, 255, 0];

  // Team 3 holds ground early, is down to one commander later, and is gone by
  // the newest keyframe. Team 4 never existed.
  // Team 5 only ever appears in the first keyframe, with no commander.
  const keyFrames = [
    { u: new Int32Array([...unit(1, 77, 3, 100, 100), ...unit(2, 77, 3, 300, 300),
                         ...unit(4, 77, 5, 200, 600), ...unit(5, 77, 5, 400, 800)]) },
    { u: new Int32Array([...unit(1, 77, 3, 500, 500), ...unit(3, 58, 3, 900, 900)]) },
    { u: new Int32Array([...unit(9, 77, 0, 5000, 5000)]) },
  ];
  let idx = 2, teamLastSeen = new Map();
  const chunkOf = () => 2;
  const api = eval(`(function(){
    ${extract('lastSeenOf')}
    return { at: lastSeenOf, cache: () => teamLastSeen, seek: i => { idx = i; } };
  })()`);

  // Newest keyframe with any of team 3 is the middle one, where it had a
  // COMMANDER — that wins over the centre of mass.
  assert.deepEqual(api.at(3), [900, 900], 'the commander it died with, not the centroid');
  assert.deepEqual(api.cache().get(3), [900, 900], 'and it is remembered');

  // With no commander in that last sighting, the centre of mass stands in.
  assert.deepEqual(api.at(5), [300, 700], 'centroid of what it still had');

  // A team that was never on the map has nowhere to speak from.
  assert.equal(api.at(4), null, 'no history: no bubble rather than a wrong one');
});

// Opening ?replay=<id> directly must not fetch the replay TABLE's data. The
// catalog listing and the filter facets feed a table that visit never renders,
// and paying for them first delayed the replay every shared link is actually
// for. They now load when the list view is first shown, and only then.
test('the catalog is fetched for the list view, not for a direct replay link', async () => {
  const extract = (n: string) => {
    const start = APP.indexOf(`function ${n}(`);
    if (start < 0) throw new Error('not found: ' + n);
    // `async` sits before the match; keep it or an awaiting body will not parse.
    const async = APP.slice(Math.max(0, start - 6), start).trim() === 'async' ? 'async ' : '';
    let depth = 0;
    for (let j = APP.indexOf('{', start); j < APP.length; j++) {
      if (APP[j] === '{') depth++;
      else if (APP[j] === '}' && --depth === 0) return async + APP.slice(start, j + 1);
    }
    throw new Error('unbalanced: ' + n);
  };

  const boot = (search: string) => eval(`(function(){
    let homeDataPending = null, homeDataLoaded = false;
    let filters = 0, lists = 0, opened = null, renders = 0;
    const el = () => ({ style: {}, textContent: '', onclick: null, classList: { add(){}, remove(){}, toggle(){} } });
    const document = { getElementById: el, body: { classList: { add(){}, remove(){}, toggle(){} } } };
    const location = { href: 'https://x/' + ${JSON.stringify(search)}, search: ${JSON.stringify(search)} };
    const history = { pushState(){}, replaceState(){} };
    const initGL = () => {}, initUpload = () => {}, startFpsMonitor = () => {}, stopPlay = () => {};
    // The left menu: wiring the nav and the queue's pager, and picking the
    // section to show. None of it touches the catalog, which is what this
    // test counts.
    const initHomeNav = () => {}, initQueue = () => {}, initResim = () => {}, applyHomeTab = () => {};
    const hideHome = () => {};
    const knownReplayURL = () => true;
    const initFilters = async () => { filters++; };
    const reloadList = async () => { lists++; };
    const renderHome = () => { renders++; };
    const loadReplay = async (id) => { opened = id; };
    ${extract('showHome')}
    ${extract('ensureHomeData')}
    ${extract('init')}
    return { init, ensureHomeData, stats: () => ({ filters, lists, opened, renders }) };
  })()`);

  // A direct replay link: the replay loads, and nothing the table needs is
  // requested. This is the assertion that matters.
  const direct = boot('?replay=f8e5816a04505f9c2b5b69a6a458b696-9942e3d8');
  await direct.init();
  let s = direct.stats();
  assert.equal(s.opened, 'f8e5816a04505f9c2b5b69a6a458b696-9942e3d8', 'the replay is opened');
  assert.equal(s.lists, 0, 'no catalog listing fetched for a direct link');
  assert.equal(s.filters, 0, 'no facets fetched for a direct link');

  // The list view still loads both, exactly once however often it is shown
  // (returning from a replay re-renders but must not re-fetch).
  const home = boot('');
  await home.init();
  await home.ensureHomeData();
  await home.ensureHomeData();
  s = home.stats();
  assert.equal(s.lists, 1, 'catalog fetched once for the list view');
  assert.equal(s.filters, 1, 'facets fetched once for the list view');
  assert.ok(s.renders >= 1, 'the table is rendered');
});

// A DOM small enough to render one table into and read back: renderHome only
// creates elements, sets text/class, and appends. Kept out of the eval string
// (which a direct eval lets it reach) so the harness below stays readable.
function fakeDom() {
  const node = (tag: string): any => {
    const n: any = {
      tag, children: [] as any[], style: {}, title: '', href: undefined as string | undefined,
      className: '', _text: '',
      classList: {
        add(c: string) { n.className = (n.className + ' ' + c).trim(); },
        remove() {}, toggle() {},
        contains: (c: string) => n.className.split(/\s+/).includes(c),
      },
      appendChild(c: any) { n.children.push(c); return c; },
      addEventListener() {},
    };
    Object.defineProperty(n, 'textContent', {
      get: () => n._text,
      set: (v: string) => { n._text = v; if (v === '') n.children = []; },
    });
    return n;
  };
  const tbody = node('tbody');
  const byId: Record<string, any> = {};
  const document = {
    createElement: node,
    querySelector: () => tbody,
    getElementById: (id: string) => (byId[id] ??= node('div')),
    body: { classList: { add() {}, remove() {}, toggle() {} } },
  };
  return { document, tbody };
}

/** Every element in the subtree, so a cell's contents can be asked about
 * without knowing which nesting produced them. */
function walk(n: any, out: any[] = []): any[] {
  for (const c of n.children ?? []) { out.push(c); walk(c, out); }
  return out;
}

test('a game being processed is listed, badged first, and cannot be opened', () => {
  const extract = (n: string) => {
    const start = APP.indexOf(`function ${n}(`);
    if (start < 0) throw new Error('not found: ' + n);
    let depth = 0;
    for (let j = APP.indexOf('{', start); j < APP.length; j++) {
      if (APP[j] === '{') depth++;
      else if (APP[j] === '}' && --depth === 0) return APP.slice(start, j + 1);
    }
    throw new Error('unbalanced: ' + n);
  };

  const dom = fakeDom();
  const rows = [
    // Published and idle: an ordinary row.
    { id: 'plain', rid: 'plain-1', startUnix: 1787349909, durationSec: 217, map: 'Isidis crack 1.1',
      gameSize: '1v1', sizeBytes: 100, players: [], settings: { lava: true }, uploads: [] },
    // Published AND being re-simulated: badged, but still openable — an older
    // revision is there to play.
    { id: 'again', rid: 'again-1', startUnix: 1787349000, durationSec: 300, map: 'X', gameSize: '8v8',
      sizeBytes: 200, players: [], settings: { lava: true }, uploads: [], processing: true },
    // Nothing published yet: badged and not openable.
    { id: 'fresh', rid: null, startUnix: 1787348000, durationSec: null, map: 'Y', gameSize: '1v1',
      sizeBytes: null, players: [], settings: null, uploads: [], processing: true, placeholder: true },
  ];

  const render = eval(`(function(){
    const document = dom.document;
    const replayList = rows;
    const homeDataLoaded = true;
    const ALLY_HUES = [0, 120];
    const urlId = (e) => e.rid || e.id;
    const replayHref = (id) => '/?replay=' + id;
    const fmtDate = () => 'date', fmtDuration = () => 'dur', fmtSize = () => 'size';
    // The real one is exercised by its own tests; here it only has to produce
    // a badge for the pill to be ahead of.
    const settingsBadges = (s) => (s ? [{ key: 'lava', label: 'lava' }] : []);
    const adminMode = () => false, syncOrphanButton = () => {}, filterQuery = () => '';
    ${extract('renderHome')}
    return renderHome;
  })()`);

  render();

  const trs = dom.tbody.children;
  assert.equal(trs.length, 3, 'every row is listed, including the one with nothing to play');

  const pillOf = (tr: any) => walk(tr).find((n) => n.className.includes('badge-processing'));
  assert.equal(pillOf(trs[0]), undefined, 'an idle row carries no processing pill');
  assert.ok(pillOf(trs[1]), 'a game being worked on is badged');
  assert.ok(pillOf(trs[2]), 'so is one with nothing published yet');
  assert.equal(pillOf(trs[1]).textContent, 'processing');

  // The pill LEADS the settings cell: it is why the row is there, not one
  // more game setting, so it must not be hunted for among them.
  const settingsCell = (tr: any) => tr.children.find((td: any) => td.className === 'settings');
  const badges = settingsCell(trs[1]).children[0].children;
  assert.equal(badges[0].className, 'badge badge-processing');
  assert.equal(badges[1].textContent, 'lava', 'the game settings follow it');

  // Openability: an internal link exists on the two published rows and on
  // neither cell of the third. Only the external links (class "ext") remain,
  // and those point at other sites, not at a replay this worker cannot serve.
  const internalLinks = (tr: any) =>
    walk(tr).filter((n) => n.tag === 'a' && !n.className.includes('ext')).length;
  assert.ok(internalLinks(trs[0]) > 0, 'a published row is a link');
  assert.ok(internalLinks(trs[1]) > 0, 'so is one being re-simulated');
  assert.equal(internalLinks(trs[2]), 0, 'a row with nothing to play links nowhere');
  assert.ok(trs[2].className.includes('unopenable'), 'and says so to the stylesheet');
  assert.ok(!trs[1].className.includes('unopenable'));
});

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
// catalog listing and the filter bar's map list feed a table that visit never renders,
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

  const boot = (path: string, search: string) => eval(`(function(){
    let homeDataPending = null, homeDataLoaded = false;
    let filters = 0, lists = 0, opened = null, renders = 0;
    const el = () => ({ style: {}, textContent: '', onclick: null, classList: { add(){}, remove(){}, toggle(){} } });
    const document = { getElementById: el, body: { classList: { add(){}, remove(){}, toggle(){} } } };
    // A mutable URL stand-in: replaceState lands here, like the browser's.
    const state = { url: new URL('https://x' + ${JSON.stringify(path)} + ${JSON.stringify(search)}) };
    const location = {
      get href() { return state.url.href; },
      get search() { return state.url.search; },
      get pathname() { return state.url.pathname; },
    };
    const history = { pushState(){}, replaceState: (_a, _b, u) => { state.url = new URL(u, state.url); } };
    const initGL = () => {}, initUpload = () => {}, startFpsMonitor = () => {}, stopPlay = () => {};
    // The left menu: wiring the nav and the queue's pager, and picking the
    // section to show. None of it touches the catalog, which is what this
    // test counts.
    const initHomeNav = () => {}, initQueue = () => {}, initResim = () => {}, applyHomeTab = () => {};
    const initLavabalanceDialog = () => {};
    // The admin probe (GET /api/admin/me) runs only under ?admin=true and
    // is a fetch of its own; stubbed here because this test counts only
    // what the TABLE needs.
    const probeAdmin = async () => {};
    const hideHome = () => {};
    const knownReplayURL = () => true;
    const initFilters = async () => { filters++; };
    const reloadList = async () => { lists++; };
    const renderHome = () => { renders++; };
    const loadReplay = async (id) => { opened = id; };
    ${APP.slice(APP.indexOf('const HOME_TABS'), APP.indexOf(';', APP.indexOf('const ADMIN_TABS')) + 1)}
    ${extract('replayFromURL')}
    ${extract('showHome')}
    ${extract('ensureHomeData')}
    ${extract('init')}
    return { init, ensureHomeData, url: () => state.url.pathname + state.url.search,
      stats: () => ({ filters, lists, opened, renders }) };
  })()`);

  // A direct replay link — the canonical PATH form: the replay loads, and
  // nothing the table needs is requested. This is the assertion that matters.
  const direct = boot('/replays/f8e5816a04505f9c2b5b69a6a458b696-9942e3d8', '');
  await direct.init();
  let s = direct.stats();
  assert.equal(s.opened, 'f8e5816a04505f9c2b5b69a6a458b696-9942e3d8', 'the replay is opened');
  assert.equal(s.lists, 0, 'no catalog listing fetched for a direct link');
  assert.equal(s.filters, 0, 'no filter data fetched for a direct link');

  // The legacy query form still opens, and the address bar is normalized to
  // the path form (replaceState — the visitor arrived at one page).
  const legacy = boot('/', '?replay=f8e5816a04505f9c2b5b69a6a458b696&admin=true');
  await legacy.init();
  s = legacy.stats();
  assert.equal(s.opened, 'f8e5816a04505f9c2b5b69a6a458b696', 'a legacy ?replay= link still opens');
  assert.equal(legacy.url(), '/replays/f8e5816a04505f9c2b5b69a6a458b696?admin=true',
    'normalized to the path form, keeping the other params');
  assert.equal(s.lists, 0, 'and it stays as cheap as the canonical form');

  // A legacy ?tab= link normalizes to its path too.
  const tab = boot('/', '?tab=games');
  await tab.init();
  assert.equal(tab.url(), '/games', 'a legacy ?tab= link becomes its path');
  assert.equal(tab.stats().opened, null, 'and opens the landing page, not a replay');

  // The list view still loads both, exactly once however often it is shown
  // (returning from a replay re-renders but must not re-fetch).
  const home = boot('/', '');
  await home.init();
  await home.ensureHomeData();
  await home.ensureHomeData();
  s = home.stats();
  assert.equal(s.lists, 1, 'catalog fetched once for the list view');
  assert.equal(s.filters, 1, 'filter data fetched once for the list view');
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
        add(c: string) { if (!n.classList.contains(c)) n.className = (n.className + ' ' + c).trim(); },
        remove(c: string) { n.className = n.className.split(/\s+/).filter((x: string) => x !== c).join(' '); },
        contains: (c: string) => n.className.split(/\s+/).includes(c),
        toggle(c: string, on?: boolean) {
          const want = on === undefined ? !n.classList.contains(c) : on;
          if (want) n.classList.add(c); else n.classList.remove(c);
        },
      },
      appendChild(c: any) { n.children.push(c); return c; },
      append(...cs: any[]) { n.children.push(...cs); },
      attrs: {} as Record<string, string>,
      setAttribute(k: string, v: unknown) { n.attrs[k] = String(v); },
      getAttribute(k: string) { return n.attrs[k]; },
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
    // The job charts are SVG, which only createElementNS can make.
    createElementNS: (_ns: string, tag: string) => node(tag),
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

// The Games section: a page of the mirror, each row saying what this site has
// of the game, with a pager that states a RANGE and never a count.
test('the games section lists the mirror with what this site has of each game', () => {
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
  const base = {
    startUnix: 1787349000, durationSec: 1500, map: 'Supreme Isthmus v2', mapFile: 'supreme_isthmus_v2',
    gameSize: '8v8', preset: 'team', playerCount: 16, engineVersion: '2026.07.04', gameVersion: 'BAR test-1',
    players: [
      { ally: 0, count: 8, players: [{ name: 'a', os: 30 }, { name: 'b', os: 20 }, { name: 'c', os: 10 }, { name: 'd', os: 5 }] },
      { ally: 1, count: 8, players: [{ name: 'e', os: 30 }] },
    ],
    settings: { ranked: true, lava: true }, syncedUnix: 1787349900, lobbyName: null,
  };
  const games = [
    { ...base, id: 'pub', published: true, jobState: 'done', lobbyName: 'Isthmus 8v8 noobs' },
    { ...base, id: 'run', published: false, jobState: 'processing' },
    { ...base, id: 'bad', published: false, jobState: 'error' },
    { ...base, id: 'new', published: false, jobState: null, players: null, settings: null },
  ];

  const render = eval(`(function(){
    const document = dom.document;
    const window = { scrollTo() {} };
    const gamesRows = games, gamesNext = '1787350500:pub', gamesBefore = 20, gamesTrail = [{ after: null, before: 0 }];
    const fmtDate = () => 'date', fmtDateShort = () => 'short';
    const replayHref = (id) => '/?replay=' + id, openReplay = () => {};
    const mapFileGuess = (m) => m;
    const ALLY_HUES = [210, 5];
    // ?admin=true is what reveals the LOS (lavabalance preview) button.
    let admin = false;
    const adminMode = () => admin, previewLavabalance = async () => {};
    ${extract('fmtDur')} ${extract('fmtDuration')} ${extract('fmtGameDuration')}
    ${APP.slice(APP.indexOf('const HIDDEN_SETTINGS'), APP.indexOf('// ---- drag&drop publishing'))}
    ${APP.slice(APP.indexOf('const SETTINGS_BADGES'), APP.indexOf(';', APP.indexOf('const SETTINGS_BADGES')) + 1)}
    ${extract('gameHaveLabel')}
    ${extract('renderGames')}
    renderGames.setAdmin = (on) => { admin = on; };
    return renderGames;
  })()`);

  render();

  const trs = dom.tbody.children;
  assert.equal(trs.length, 4);
  const haveOf = (tr: any) => walk(tr).find((n) => String(n.className).startsWith('have'));
  assert.equal(haveOf(trs[0]).className, 'have have-published');
  assert.equal(haveOf(trs[1]).className, 'have have-processing');
  assert.equal(haveOf(trs[1]).textContent, 'processing');
  assert.equal(haveOf(trs[2]).className, 'have have-error');
  assert.equal(haveOf(trs[2]).textContent, 'failed');
  assert.equal(haveOf(trs[3]), undefined, 'a game nothing touched gets a dash, not a pill');

  // Only the published game links into the viewer; every row links out.
  const linksOf = (tr: any) => walk(tr).filter((n) => n.tag === 'a').map((n: any) => n.textContent);
  assert.deepEqual(linksOf(trs[0]).filter((t) => ['gex', 'BAR', 'replay'].includes(t)), ['gex', 'BAR', 'replay']);
  assert.deepEqual(linksOf(trs[1]).filter((t) => ['gex', 'BAR', 'replay'].includes(t)), ['gex', 'BAR']);
  assert.equal(walk(trs[0]).find((n) => n.className === 'here').href, '/?replay=pub');

  // Players: top three a side by OS for a two-sided game, the rest counted.
  const sides = walk(trs[0]).filter((n) => n.tag === 'span' && /hsl/.test(n.style.color));
  assert.deepEqual(sides.map((n) => n.textContent), ['a, b, c +5', 'e +7']);
  // The lobby name lands in its column; a game without one gets the dash.
  assert.ok(trs[0].children.some((td: any) => td.className === 'lobby' && td.textContent === 'Isthmus 8v8 noobs'));
  assert.ok(trs[1].children.some((td: any) => td.className === 'lobby dim' && td.textContent === '—'));
  // Settings badges, through the same rules as the replay list (mods hidden
  // beside lava, hidden flags dropped).
  const badges = walk(trs[0]).filter((n) => String(n.className).startsWith('badge')).map((n) => n.textContent);
  assert.ok(badges.includes('lava') && badges.includes('ranked'), JSON.stringify(badges));

  // The pager: a range, never a total or a page count.
  assert.equal(dom.document.getElementById('g_range').textContent, '21–24');
  assert.equal(dom.document.getElementById('g_prev').disabled, false);
  assert.equal(dom.document.getElementById('g_next').disabled, false);
  assert.equal(dom.document.getElementById('gamespager').style.display, 'flex');

  // The lavabalance preview button lives in the admin column and exists only
  // under ?admin=true: the column itself is CSS-hidden otherwise, but the
  // button must not even be built — it is one per row, and it is nobody's
  // business but the operator's.
  const losButtons = () => walk(dom.tbody).filter((n) => n.tag === 'button' && n.className === 'lavabalance');
  assert.equal(losButtons().length, 0, 'no LOS button outside admin mode');
  render.setAdmin(true);
  render();
  assert.equal(losButtons().length, 4, 'one LOS button per row in admin mode');
  assert.ok(dom.tbody.children[0].children.at(-1).className === 'admin', 'the admin cell is the last column');
});

// The paste-ready upload command shown by the preview: the BAR API detail
// piped into lavabalance's POST as a one-element array, nothing inlined.
test('the lavabalance curl pipes the BAR API detail into the upload endpoint', () => {
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
  const consts = APP.slice(APP.indexOf('const LAVABALANCE_UPLOAD_URL'), APP.indexOf('\n', APP.indexOf('const BAR_API_REPLAY_URL')));
  const curl = eval(`(function(){ ${consts}\n${extract('lavabalanceCurl')}\nreturn lavabalanceCurl; })()`);
  const cmd = curl('f8e5816a04505f9c2b5b69a6a458b696');
  const lines = cmd.split('\n');
  assert.equal(lines[0], "curl -sS 'https://api.bar-rts.com/replays/f8e5816a04505f9c2b5b69a6a458b696' \\");
  assert.ok(/printf '\['; cat; printf '\]'/.test(lines[1]), 'wraps the detail in a one-element array');
  assert.ok(lines[2].includes("-X POST 'https://lavabalance.fogofwar.dev/api/games'"), lines[2]);
  assert.ok(lines[3].includes("content-type: application/json") && lines[3].includes('--data-binary @-'), lines[3]);
  // The id is URL-encoded, never spliced raw into the quoted URL.
  assert.ok(curl("a'b c").includes("/replays/a'\\''b%20c'"), curl("a'b c"));
});

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
      sizeBytes: null, players: [], settings: null, uploads: [], processing: true, placeholder: true,
      processingPercent: 52 },
  ];

  const render = eval(`(function(){
    const document = dom.document;
    const replayList = rows;
    const homeDataLoaded = true;
    const ALLY_HUES = [0, 120];
    const urlId = (e) => e.rid || e.id;
    const replayHref = (id) => '/?replay=' + id;
    const fmtDate = () => 'date', fmtDateShort = () => 'date', fmtDuration = () => 'dur', fmtGameDuration = () => 'dur', fmtSize = () => 'size';
    // The real one is exercised by its own tests; here it only has to produce
    // a badge for the pill to be ahead of.
    const settingsBadges = (s) => (s ? [{ key: 'lava', label: 'lava' }] : []);
    const adminMode = () => false, syncOrphanButton = () => {}, filterQuery = () => '';
    // Paging state: this test is about the rows, so one page holds them all.
    const PAGE_SIZE = 50; let homePage = 0, homeHasNext = false;
    const goPage = () => {};
    // The Players column shows rosters here; its lobby-name face has its own test.
    const playersColumn = () => 'players';
    ${extract('mapFileGuess')}
    ${extract('renderPager')}
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
  // A job that reports a percentage shows it on the pill.
  assert.equal(pillOf(trs[2]).textContent, 'processing: 52%');

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

test('the Players header swaps the column to lobby names and back', () => {
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
  // The column choice lives in the URL (?col=lobby, replaceState) — this pair
  // stands in for the browser's, so the test drives the REAL playersColumn.
  const state = { href: 'https://x/' };
  const rows = [
    // Named by the teiserver poll's match.
    { id: 'named', rid: 'named-1', startUnix: 1, durationSec: 1, map: 'M', gameSize: '8v8', sizeBytes: 1,
      players: [{ ally: 0, count: 1, players: [{ name: 'Rouben' }] }], settings: null, uploads: [],
      lobbyName: 'Chillmus most welcome | 8v8' },
    // Worker backend but nothing matched (yet, or ever): key present, null.
    { id: 'unnamed', rid: 'unnamed-1', startUnix: 2, durationSec: 1, map: 'M', gameSize: '1v1', sizeBytes: 1,
      players: [{ ally: 0, count: 1, players: [{ name: 'Adzek' }] }], settings: null, uploads: [],
      lobbyName: null },
  ];
  const render = eval(`(function(){
    const document = dom.document;
    const replayList = rows;
    const location = { get href() { return state.href; }, get search() { return new URL(state.href).search; } };
    const history = { replaceState: (_a, _b, u) => { state.href = String(u); } };
    const ALLY_HUES = [0, 120];
    const urlId = (e) => e.rid || e.id;
    const replayHref = (id) => '/?replay=' + id;
    const fmtDate = () => 'date', fmtDateShort = () => 'date', fmtDuration = () => 'dur', fmtGameDuration = () => 'dur', fmtSize = () => 'size';
    const settingsBadges = () => [];
    const adminMode = () => false, syncOrphanButton = () => {}, filterQuery = () => '';
    const PAGE_SIZE = 50; let homePage = 0, homeHasNext = false;
    const goPage = () => {};
    ${extract('playersColumn')}
    ${extract('mapFileGuess')}
    ${extract('renderPager')}
    ${extract('renderHome')}
    return renderHome;
  })()`);

  render();
  const th = dom.document.getElementById('h_players');
  assert.ok(th.className.includes('swappable'), 'a list carrying the field offers the swap');
  assert.ok(th.textContent.startsWith('Players'));
  const playerCell = (i: number) => dom.tbody.children[i].children.find((td: any) => td.className.includes('players'));
  assert.ok(walk(playerCell(0)).some((n) => n.textContent === 'Rouben'), 'rosters first');

  // Click the header: the same column now shows the lobby name; a game the
  // poll never named shows a dash, not a blank. The choice lands in the URL
  // (?col=lobby via replaceState) so it is shareable and survives a refresh.
  th.onclick();
  assert.equal(new URL(state.href).searchParams.get('col'), 'lobby');
  assert.ok(dom.document.getElementById('h_players').textContent.startsWith('Lobby'));
  assert.ok(walk(playerCell(0)).some((n) => n.textContent === 'Chillmus most welcome | 8v8'));
  assert.ok(walk(playerCell(1)).some((n) => n.textContent === '—'));
  assert.ok(playerCell(1).className.includes('dim'));

  // And back — the default writes NO param, keeping the URL clean.
  th.onclick();
  assert.equal(new URL(state.href).searchParams.get('col'), null);
  assert.ok(walk(playerCell(0)).some((n) => n.textContent === 'Rouben'));

  // Against the Go server (no lobbyName key anywhere) the header is inert.
  rows.forEach((r: any) => delete r.lobbyName);
  render();
  const plain = dom.document.getElementById('h_players');
  assert.ok(!plain.className.includes('swappable'));
  assert.equal(plain.textContent, 'Players');
  assert.equal(plain.onclick, null);
});

test('the players filter is a two-ended range over a fixed domain', () => {
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
  // Taken from the source rather than restated, so the test cannot claim a
  // domain the page does not offer. Hardcoded (it used to be a facet computed
  // from the catalog per page load), so it must cover every game BAR runs.
  const loLine = /const PLAYERS_MIN = (\d+);/.exec(APP);
  const hiLine = /const PLAYERS_MAX = (\d+);/.exec(APP);
  assert.ok(loLine && hiLine, 'PLAYERS_MIN/PLAYERS_MAX are declared');
  const LO = Number(loLine![1]);
  const HI = Number(hiLine![1]);
  assert.equal(LO, 2, 'the range starts at a duel');
  assert.equal(HI, 32, 'the range tops out past the biggest real games');

  const boot = (query: string) => {
    const dom = fakeDom();
    const state = { href: 'https://x/' + query, reloads: 0 };
    const run = eval(`(function(){
      const document = dom.document;
      const location = { get href() { return state.href; } };
      const history = { replaceState: (_a, _b, u) => { state.href = String(u); } };
      const reloadList = () => { state.reloads++; };
      const PLAYERS_MIN = ${LO}, PLAYERS_MAX = ${HI};
      ${extract('initDualRange')}
      ${extract('initSizeRange')}
      return initSizeRange;
    })()`);
    run(new URLSearchParams(query));
    const id = (x: string) => dom.document.getElementById(x);
    return { dom, state, id, params: () => new URL(state.href).searchParams };
  };

  // Restored from the URL, over the fixed domain.
  {
    const b = boot('?minPlayers=4&maxPlayers=8');
    assert.equal(b.id('f_smin').min, String(LO));
    assert.equal(b.id('f_smax').max, String(HI));
    assert.equal(b.id('f_smin').value, '4');
    assert.equal(b.id('f_smax').value, '8');
    assert.equal(b.id('f_sizeout').textContent, '4–8');
    assert.ok(b.id('f_sizerange').classList.contains('narrowed'));
  }

  // No params: both thumbs at their ends, the control shown, and the label
  // saying so rather than showing a range that happens to match everything.
  {
    const b = boot('');
    assert.equal(b.id('f_sizefilter').style.display, '');
    assert.equal(b.id('f_smin').value, String(LO));
    assert.equal(b.id('f_smax').value, String(HI));
    assert.equal(b.id('f_sizeout').textContent, 'any');
    assert.ok(!b.id('f_sizerange').classList.contains('narrowed'));
  }

  // Dragging the left thumb writes only the bound it changed: a thumb parked
  // at its end is not a filter, so the other param stays absent — which is
  // also what gives the top end its "and bigger" reading.
  {
    const b = boot('');
    b.id('f_smin').value = '8';
    b.id('f_smin').oninput();
    b.id('f_smin').onchange();
    assert.equal(b.params().get('minPlayers'), '8');
    assert.equal(b.params().get('maxPlayers'), null, 'the untouched end is not a filter');
    assert.equal(b.id('f_sizeout').textContent, '8+', 'the open top end reads as a floor');

    // ...and sliding it back clears it again, so the URL returns to unfiltered.
    b.id('f_smin').value = String(LO);
    b.id('f_smin').oninput();
    b.id('f_smin').onchange();
    assert.equal(b.params().get('minPlayers'), null);
    assert.equal(b.id('f_sizeout').textContent, 'any');
  }

  // The thumbs push rather than cross: the max cannot be dragged below the
  // min, which would be a range matching nothing.
  {
    const b = boot('?minPlayers=8');
    b.id('f_smax').value = '4';
    b.id('f_smax').oninput();
    b.id('f_smax').onchange();
    assert.equal(b.id('f_smax').value, '8');
    assert.equal(b.id('f_sizeout').textContent, '8', 'both ends on one size reads as that size');
    assert.equal(b.params().get('maxPlayers'), '8');
  }

  // A hand-edited URL with the bounds crossed is straightened out rather than
  // shown as thumbs that have swapped places.
  {
    const b = boot('?minPlayers=12&maxPlayers=4');
    assert.equal(b.id('f_smin').value, '4');
    assert.equal(b.id('f_smax').value, '4');
  }

  // Values outside the domain are clamped into it.
  {
    const b = boot('?minPlayers=1&maxPlayers=99');
    assert.equal(b.id('f_smin').value, String(LO));
    assert.equal(b.id('f_smax').value, String(HI));
  }

  // Overlapping thumbs stay separable: the side of them the pointer is on
  // decides which one a press will grab.
  {
    const b = boot('?minPlayers=8&maxPlayers=8');
    const rail = b.id('f_sizerange');
    rail.getBoundingClientRect = () => ({ left: 0, width: 160 });
    rail.onpointerdown({ clientX: 16, buttons: 0 });   // left of the pair (≈5 players)
    assert.ok(+b.id('f_smin').style.zIndex > +b.id('f_smax').style.zIndex);
    rail.onpointerdown({ clientX: 120, buttons: 0 });  // right of it (≈24 players)
    assert.ok(+b.id('f_smax').style.zIndex > +b.id('f_smin').style.zIndex);
  }
});

test('the duration filter ends at an hour, and that end means "and longer"', () => {
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
  // Taken from the source rather than restated, so the test cannot claim an
  // hour while the page offers something else.
  const capLine = /const DURATION_MAX_SEC = (\d+);/.exec(APP);
  assert.ok(capLine, 'DURATION_MAX_SEC is declared');
  const CAP = Number(capLine![1]);
  assert.equal(CAP, 3600, 'the range tops out at one hour');

  const boot = (query: string) => {
    const dom = fakeDom();
    const state = { href: 'https://x/' + query, reloads: 0 };
    const run = eval(`(function(){
      const document = dom.document;
      const location = { get href() { return state.href; } };
      const history = { replaceState: (_a, _b, u) => { state.href = String(u); } };
      const reloadList = () => { state.reloads++; };
      const DURATION_MAX_SEC = ${CAP};
      ${extract('initDualRange')}
      ${extract('initDurationRange')}
      return initDurationRange;
    })()`);
    run(new URLSearchParams(query));
    const id = (x: string) => dom.document.getElementById(x);
    return { state, id, params: () => new URL(state.href).searchParams };
  };

  // Untouched: the whole span, in seconds, and no params.
  {
    const b = boot('');
    assert.equal(b.id('f_dmin').min, '0');
    assert.equal(b.id('f_dmax').max, String(CAP));
    assert.equal(b.id('f_dmin').step, '60', 'a minute at a time');
    assert.equal(b.id('f_durout').textContent, 'any');
  }

  // The top thumb left where it is: the filter is a floor, and the label says
  // so rather than pretending there is a ceiling at an hour.
  {
    const b = boot('');
    b.id('f_dmin').value = '1200';
    b.id('f_dmin').oninput();
    b.id('f_dmin').onchange();
    assert.equal(b.id('f_durout').textContent, '20m+');
    assert.equal(b.params().get('minDuration'), '1200');
    assert.equal(b.params().get('maxDuration'), null, 'an hour means "and longer", so no upper bound is sent');
  }

  // Bringing the top thumb down is what actually caps the length.
  {
    const b = boot('');
    b.id('f_dmax').value = '1800';
    b.id('f_dmax').oninput();
    b.id('f_dmax').onchange();
    assert.equal(b.id('f_durout').textContent, '≤30m');
    assert.equal(b.params().get('maxDuration'), '1800');

    // ...and pushing it back to the top removes the cap again.
    b.id('f_dmax').value = String(CAP);
    b.id('f_dmax').oninput();
    b.id('f_dmax').onchange();
    assert.equal(b.params().get('maxDuration'), null);
    assert.equal(b.id('f_durout').textContent, 'any');
  }

  // Both ends moved: a closed range, labelled as one.
  {
    const b = boot('?minDuration=600&maxDuration=2400');
    assert.equal(b.id('f_dmin').value, '600');
    assert.equal(b.id('f_dmax').value, '2400');
    assert.equal(b.id('f_durout').textContent, '10m–40m');
  }

  // A URL asking for longer than the slider can show is clamped to its top —
  // which filters for the same games, since that end is open.
  {
    const b = boot('?minDuration=7200');
    assert.equal(b.id('f_dmin').value, String(CAP));
    assert.equal(b.id('f_durout').textContent, '1h+');
  }
});

test('the pager offers Prev/Next and a range, never a page count', () => {
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
  const sizeLine = /const PAGE_SIZE = (\d+);/.exec(APP);
  assert.ok(sizeLine, 'PAGE_SIZE is declared');
  assert.equal(Number(sizeLine![1]), 50, 'a page is 50 rows');

  const boot = (page: number, rows: number, hasNext: boolean) => {
    const dom = fakeDom();
    const steps: number[] = [];
    const run = eval(`(function(){
      const document = dom.document;
      const PAGE_SIZE = ${Number(sizeLine![1])};
      const homePage = ${page};
      const homeHasNext = ${hasNext};
      const replayList = new Array(${rows}).fill(0);
      const goPage = (d) => { steps.push(d); };
      ${extract('renderPager')}
      return renderPager;
    })()`);
    run();
    const id = (x: string) => dom.document.getElementById(x);
    return { id, steps };
  };

  // One page holds everything: no pager at all, so a small catalog looks
  // exactly as it did before paging existed.
  assert.equal(boot(0, 12, false).id('homepager').style.display, 'none');

  // First page of more: Prev is dead, Next is live, and the label says where
  // you are — not how many pages there are, which nothing counts.
  {
    const b = boot(0, 50, true);
    assert.equal(b.id('homepager').style.display, '');
    assert.equal(b.id('p_prev').disabled, true);
    assert.equal(b.id('p_next').disabled, false);
    assert.equal(b.id('p_range').textContent, '1–50');
    b.id('p_next').onclick();
    assert.deepEqual(b.steps, [1]);
  }

  // A middle page: both live, and the range is offset by the pages before it.
  {
    const b = boot(2, 50, true);
    assert.equal(b.id('p_prev').disabled, false);
    assert.equal(b.id('p_range').textContent, '101–150');
    b.id('p_prev').onclick();
    assert.deepEqual(b.steps, [-1]);
  }

  // The last page: Next is dead, and a short page is labelled by what it
  // actually holds.
  {
    const b = boot(3, 7, false);
    assert.equal(b.id('p_next').disabled, true);
    assert.equal(b.id('p_prev').disabled, false);
    assert.equal(b.id('p_range').textContent, '151–157');
  }
});

// The queue row of a job that is still RUNNING. It has no stats — those are
// written when the work ends — so everything a person can learn about it comes
// from the live progress the daemon healthchecks in with, and the row has to
// actually show it: the phase, how far along, and what the engine is costing
// the machine doing the work.
test('a running job shows its live progress instead of an empty row', () => {
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
  const jobs = [
    // Mid-simulation: every number the daemon can report.
    {
      id: 'running', gameId: 'aaa', kind: 'resim', state: 'processing', error: null, stats: null,
      createdUnix: 1787349000, updatedUnix: 1787349900, disabled: false, errorKind: null,
      game: { durationSec: 2417, gameSize: '8v8' },
      progress: {
        state: 'simulating', frame: 43000, totalFrames: 100170, percent: 42.9,
        etaSec: 840, simFps: 68.2, rssBytes: 3221225472, swapBytes: 0, cpuPct: 612.5,
      },
    },
    // Still loading: a phase with nothing to measure. It must still say what
    // it is doing, and must NOT draw a bar pinned at zero, which reads as a
    // job that is stuck rather than one that is working.
    {
      id: 'loading', gameId: 'bbb', kind: 'resim', state: 'processing', error: null, stats: null,
      createdUnix: 1787349000, updatedUnix: 1787349900, disabled: false, errorKind: null,
      // Neither the catalog nor the mirror knows this one.
      game: null,
      progress: { state: 'starting engine', rssBytes: 1048576, swapBytes: 268435456 },
    },
    // Finished badly: the worker cleared the progress when the job ended, so
    // the same cell carries the failure.
    {
      id: 'failed', gameId: 'ccc', kind: 'resim', state: 'error',
      error: 'host ran out of memory', errorKind: 'oom',
      stats: null, progress: null, disabled: false,
      game: { durationSec: 217, gameSize: '1v1' },
      createdUnix: 1787349000, updatedUnix: 1787349900,
    },
  ];

  const render = eval(`(function(){
    const document = dom.document;
    const replayList = [];
    const queuePage = { jobs, total: jobs.length, active: 2 };
    const queueOffset = 0, queueReadAt = 0;
    const queueOpen = new Set();
    const fmtDate = () => 'date', fmtAgo = () => 'ago';
    const replayHref = (id) => '/?replay=' + id, urlId = (e) => e.id, openReplay = () => {};
    ${extract('fmtDur')}
    ${extract('fmtSize')}
    ${extract('statsLines')}
    ${extract('progressLines')}
    ${extract('progressText')}
    ${extract('statsTooltip')}
    ${extract('fillProgressCell')}
    ${extract('disableCell')}
    ${extract('fmtDuration')} ${extract('fmtGameDuration')}
    ${APP.slice(APP.indexOf('const ERROR_KIND_LABELS'), APP.indexOf('const QUEUE_PAGE'))}
    ${extract('renderQueue')}
    return renderQueue;
  })()`);

  render();

  const trs = dom.tbody.children;
  assert.equal(trs.length, 3);
  const detailOf = (tr: any) => tr.children.find((td: any) => td.className.includes('detail'));

  const running = detailOf(trs[0]);
  const bar = walk(running).find((n) => n.className === 'jobprog');
  assert.ok(bar, 'a measurable phase draws a bar');
  assert.equal(bar.children[0].style.width, '42.9%');
  const text = walk(running).find((n) => n.className === 'jobprogtext').textContent;
  // No swap in the one-liner when there is none: the line is already five
  // readings long and "0 B swap" is the least interesting of them.
  assert.match(text, /^simulating · 43% · 14m 00s left · 3\.2 GB · 613% CPU$/);

  const loading = detailOf(trs[1]);
  assert.equal(walk(loading).find((n) => n.className === 'jobprog'), undefined,
    'nothing to measure yet: words, but no bar pinned at zero');
  // ...but it leads with it when the engine IS swapping, which is the whole
  // reason to look at this row.
  assert.equal(walk(loading).find((n) => n.className === 'jobprogtext').textContent,
    'starting engine · 1.0 MB · 268.4 MB swap');

  // The failure keeps the cell it always had; the two never collide because
  // the worker clears progress at exactly the moment an error appears.
  assert.equal(detailOf(trs[2]).textContent, 'host ran out of memory');
  assert.ok(detailOf(trs[2]).className.includes('error'));

  // The Took column has no cost to report on a running job, so it answers the
  // question that row actually raises: how much longer.
  const tookOf = (tr: any) => tr.children.find((td: any) => td.className.includes('took'));
  assert.equal(tookOf(trs[0]).textContent, '▸ ~14m 00s left');
  assert.match(tookOf(trs[0]).title, /Now: simulating/);
  assert.ok(trs[0].className.includes('hasstats'), 'and the row expands for the rest');

  // The hold-back control, offered only where it can change anything: a
  // finished job is already never handed out, so a switch on it would be a
  // control that does nothing.
  const btnOf = (tr: any) => walk(tr).find((n: any) => n.tag === 'button');
  assert.equal(btnOf(trs[0]).textContent, 'Disable', 'a running job can be held back');
  assert.equal(btnOf(trs[1]).textContent, 'Disable');
  assert.equal(btnOf(trs[2]), undefined, 'a failed job has nothing to hold back');

  // The game's own facts, joined on by the worker: a queue of bare ids cannot
  // say whether an hour of engine time is buying an 8v8 or a duel.
  const cellOf = (tr: any, cls: string) => tr.children.find((td: any) => td.className.includes(cls));
  assert.equal(cellOf(trs[0], 'size').textContent, '8v8');
  assert.equal(cellOf(trs[0], 'dur').textContent, '40m');
  assert.equal(cellOf(trs[2], 'size').textContent, '1v1');
  // A game neither table knows still lists; it just has nothing to say.
  assert.equal(cellOf(trs[1], 'size').textContent, '—');
  assert.ok(cellOf(trs[1], 'size').className.includes('dim'));

  // gex is always reachable, unlike the Game cell's bar-rts link, which is
  // only there while the game is unpublished here.
  // WHY it failed, beside the state that says it did — the one failure worth
  // spotting down a column of red rows is the one that is about the machine
  // rather than the replay.
  const kindOf = (tr: any) => walk(tr).find((n: any) => n.className === 'errkind');
  assert.equal(kindOf(trs[2]).textContent, 'out of memory');
  assert.match(kindOf(trs[2]).title, /MACHINE, not the replay/);
  assert.equal(kindOf(trs[0]), undefined, 'a running job carries no failure marking');

  const gex = (tr: any) => walk(tr).find((n: any) => n.tag === 'a' && String(n.href).includes('gex.honu.pw'));
  assert.equal(gex(trs[0]).href, 'https://gex.honu.pw/match/aaa');
  assert.equal(gex(trs[0]).className, 'ext', 'external, so the SPA click handler leaves it alone');
  assert.ok(gex(trs[2]), 'including on a job that failed');
});

// A held-back row says so where the eye goes — the state column — rather than
// showing "pending" on something nothing will ever pick up.
test('a disabled job reads as disabled and offers the way back', () => {
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
  const jobs = [{
    id: 'held', gameId: 'aaa', kind: 'resim', state: 'pending', error: null, stats: null,
    progress: null, disabled: true, game: null, errorKind: null,
    createdUnix: 1787349000, updatedUnix: 1787349900,
  }];
  eval(`(function(){
    const document = dom.document;
    const replayList = [];
    const queuePage = { jobs, total: 1, active: 0 };
    const queueOffset = 0, queueReadAt = 0;
    const queueOpen = new Set();
    const fmtDate = () => 'date', fmtAgo = () => 'ago';
    const replayHref = (id) => '/?replay=' + id, urlId = (e) => e.id, openReplay = () => {};
    ${extract('fmtDur')} ${extract('statsLines')} ${extract('progressLines')}
    ${extract('progressText')} ${extract('statsTooltip')} ${extract('fillProgressCell')}
    ${extract('fmtSize')} ${extract('disableCell')} ${extract('fmtDuration')} ${extract('fmtGameDuration')}
    ${APP.slice(APP.indexOf('const ERROR_KIND_LABELS'), APP.indexOf('const QUEUE_PAGE'))}
    ${extract('renderQueue')}
    return renderQueue;
  })()`)();

  const tr = dom.tbody.children[0];
  const state = walk(tr).find((n: any) => n.className.startsWith('state '));
  assert.equal(state.textContent, 'disabled', 'not "pending" on a row nothing will pick up');
  assert.ok(state.className.includes('state-disabled'));
  assert.match(state.title, /Underlying state: pending/, 'the real state stays available');

  const btn = walk(tr).find((n: any) => n.tag === 'button');
  assert.equal(btn.textContent, 'Enable');
  assert.ok(btn.className.includes('on'), 'and it stays lit rather than waiting for a hover');
});

// The healthcheck history, drawn. Three separate plots, never one with three
// scales: bytes, percent-of-a-core and percent-of-a-game share no axis, and
// overlaying them would invent a correlation the data does not contain.
test('a job\'s healthcheck history is drawn as one chart per measure', () => {
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
  const consts = APP.slice(APP.indexOf('const SVGNS ='), APP.indexOf('// Fetched per expanded row'));

  const dom = fakeDom();
  // A load phase that reports memory but no simulation, then a run.
  const rows = [
    { atUnix: 1000, state: 'loading', frame: null, percent: null, etaSec: null, rssBytes: 1e9, swapBytes: 0, cpuPct: 120 },
    { atUnix: 1010, state: 'simulating', frame: 300, percent: 10, etaSec: 900, rssBytes: 2e9, swapBytes: 0, cpuPct: 500 },
    { atUnix: 1020, state: 'simulating', frame: 600, percent: 20, etaSec: 800, rssBytes: 4e9, swapBytes: 0, cpuPct: 610 },
    { atUnix: 1030, state: 'simulating', frame: 900, percent: 30, etaSec: 700, rssBytes: 3e9, swapBytes: 0, cpuPct: 400 },
  ];

  const api = eval(`(function(){
    const document = dom.document;
    ${consts}
    ${extract('svgEl')} ${extract('lastIndexWithValue')} ${extract('nearestSample')}
    ${extract('buildChart')} ${extract('showTip')} ${extract('jobCharts')}
    ${extract('fmtSize')} ${extract('fmtDuration')} ${extract('fmtDur')}
    return { jobCharts, nearestSample, JOB_CHARTS, CH_W, CH_L, CH_R };
  })()`);

  const fig = api.jobCharts(rows);
  const svgs = walk(fig).filter((n: any) => n.tag === 'svg');
  // Four, not five: this run never swapped, and swap draws nothing when every
  // reading is zero — a flat line along the baseline of an axis reading "1 B"
  // is worse than no chart. Its APPEARING is the signal.
  assert.equal(svgs.length, 4, 'one chart per measure, never one plot with several scales');

  const texts = (svg: any) => walk(svg).filter((n: any) => n.tag === 'text');
  const cls = (svg: any, c: string) => walk(svg).filter((n: any) => n.attrs.class === c);

  // Autoscaled charts: the top tick IS the peak, so the peak carries a dot and
  // no text — a label repeating a tick is noise.
  const mem = svgs[0];
  assert.equal(texts(mem).find((t: any) => t.attrs.class === 'chtick')._text, '4.0 GB');
  assert.equal(cls(mem, 'chlabel').length, 0, 'no label duplicating the top tick');
  assert.equal(cls(mem, 'chpeak').length, 1, 'but a dot saying WHEN it peaked');

  // Fixed domain: the axis says nothing about this run, so the END value is
  // labelled — the number the reader came for.
  const sim = svgs[2];
  assert.equal(texts(sim).find((t: any) => t.attrs.class === 'chtick')._text, '100%');
  assert.equal(cls(sim, 'chlabel')[0]._text, '30.0%');

  // Every label must FIT: a tick too long for its 46px gutter runs off the
  // figure, which an anchor-only check cannot see.
  for (const svg of svgs) {
    for (const t of texts(svg)) {
      const w = t._text.length * 5.6;
      const x = Number(t.attrs.x);
      const anchor = t.attrs['text-anchor'] || 'end';
      assert.ok(x - (anchor === 'end' ? w : 0) >= 0, `"${t._text}" runs off the left edge`);
      assert.ok(x + (anchor === 'end' ? 0 : w) <= api.CH_W, `"${t._text}" runs off the right edge`);
    }
    // The line breaks over a gap rather than drawing through zero: an engine
    // that had not started is missing, not idle.
    for (const p of walk(svg).filter((n: any) => n.tag === 'path')) {
      assert.doesNotMatch(p.attrs.d, /NaN|undefined|Infinity/, 'the path is real coordinates');
    }
  }
  // Simulation has one null at the head, so its line starts at the second beat.
  const simLine = cls(sim, 'chline');
  assert.equal(simLine.length, 1, 'one unbroken run after the gap');
  assert.ok(Number(simLine[0].attrs.d.match(/^M([\d.]+)/)[1]) > api.CH_L, 'and it starts after the gap, not at the axis');

  // The ETA is the one series that should be going DOWN, and its axis says
  // nothing about this run, so it labels where it ended up — "how much was
  // left when it stopped reporting", which for a run that died is the story.
  const eta = svgs[3];
  assert.equal(texts(eta).find((t: any) => t.attrs.class === 'chtick')._text, '15:00', 'the axis tops at the first estimate');
  assert.equal(cls(eta, 'chlabel')[0]._text, '11m 40s left', 'the last estimate, not the biggest');

  // ...and it DOES draw once the engine actually swapped.
  const swapped = rows.map((r, i) => ({ ...r, swapBytes: i === 2 ? 512e6 : 0 }));
  const swapSvgs = walk(api.jobCharts(swapped)).filter((n: any) => n.tag === 'svg');
  assert.equal(swapSvgs.length, 5);
  // The tick is the COMPACT form: "512.0 MB" is nine characters and runs off
  // the left of the figure, which is a bug the geometry check below catches.
  assert.equal(texts(swapSvgs[4]).find((t: any) => t.attrs.class === 'chtick')._text, '512 MB');

  // A measure the run never reported gets no plot at all: an empty axis would
  // claim a reading of zero, which is a different statement.
  const noEngine = rows.map((r) => ({ ...r, rssBytes: null, cpuPct: null }));
  assert.equal(walk(api.jobCharts(noEngine)).filter((n: any) => n.tag === 'svg').length, 2);

  // The crosshair finds the X: the reader aims at a moment, not at a 2px line.
  assert.equal(api.nearestSample(api.CH_L, 4), 0);
  assert.equal(api.nearestSample(api.CH_W - api.CH_R, 4), 3);
  assert.equal(api.nearestSample(-999, 4), 0, 'and is clamped, never out of range');
  assert.equal(api.nearestSample(9999, 4), 3);
});

// Swap is stated even at zero in the expanded grid, and that is deliberate:
// "none" is the reassurance and it is the usual answer, so a line that only
// appeared in the bad case would leave every healthy run silent about the one
// thing being watched for. Absent entirely is a different claim — a daemon too
// old to measure it.
test('the swap reading distinguishes "none" from "not measured"', () => {
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
  const api = eval(`(function(){
    ${extract('fmtDur')} ${extract('fmtSize')} ${extract('progressLines')}
    return { progressLines };
  })()`);
  const lines = (p: unknown) => Object.fromEntries(api.progressLines(p));

  assert.equal(lines({ state: 'simulating', swapBytes: 0 })['Engine swap'], 'none');
  assert.equal(lines({ state: 'simulating', swapBytes: 268435456 })['Engine swap'], '268.4 MB');
  assert.equal('Engine swap' in lines({ state: 'simulating' }), false, 'an older daemon says nothing');
});

test('game durations render minutes-precision, started dates drop the year', () => {
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
  const fns = eval(`(function(){
    ${extract('fmtGameDuration')}
    ${extract('fmtDateShort')}
    return { fmtGameDuration, fmtDateShort };
  })()`);
  assert.equal(fns.fmtGameDuration(20 * 60), '20m');
  assert.equal(fns.fmtGameDuration(80 * 60), '1h 20m');
  assert.equal(fns.fmtGameDuration(3600), '1h 0m');
  // Seconds round to the nearest minute; a sub-minute game still says something.
  assert.equal(fns.fmtGameDuration(19 * 60 + 40), '20m');
  assert.equal(fns.fmtGameDuration(20), '<1m');
  // Locale decides the exact rendering, so pin only what the change is about:
  // the year digits are gone (1787349909 is a 2026 timestamp).
  assert.ok(!fns.fmtDateShort(1787349909).includes('2026'));
});

// The id filter's input is a paste target, and what people paste is as often a
// link as a bare id. gameIdIn is the bit with a decision in it, so it is worth
// pinning against the real shapes: a gex link, a bar-rts link, the id on its
// own, a half-typed prefix.
test('the id filter lifts a game id out of whatever was pasted', () => {
  const start = APP.indexOf('function gameIdIn(');
  assert.ok(start >= 0, 'app.js must define gameIdIn()');
  let depth = 0, end = start;
  for (let j = APP.indexOf('{', start); j < APP.length; j++) {
    if (APP[j] === '{') depth++;
    else if (APP[j] === '}' && --depth === 0) { end = j + 1; break; }
  }
  const gameIdIn = new Function(`${APP.slice(start, end)}; return gameIdIn;`)() as (s: string) => string;

  const id = '92488a6a2807186a199996b9a0712fa5';
  assert.equal(gameIdIn(id), id);
  assert.equal(gameIdIn(`  ${id.toUpperCase()} `), id);
  assert.equal(gameIdIn(`https://gex.honu.pw/match/${id}`), id);
  assert.equal(gameIdIn(`https://www.beyondallreason.info/replays?gameId=${id}`), id);
  assert.equal(gameIdIn(`https://replay.fogofwar.dev/?replay=${id}&tab=replays`), id);
  // A prefix is a valid filter, so a half-finished paste narrows rather than
  // resolving to nothing.
  assert.equal(gameIdIn('92488a6a'), '92488a6a');
  assert.equal(gameIdIn(''), '');
  // Nothing id-shaped in there: hand it over as typed and let the server say
  // so, rather than silently filtering by something else.
  assert.equal(gameIdIn('Great Divide'), 'great divide');
});

// Shareable links carry the BARE game id, but a revisioned publish serves its
// pieces under <gameId>-<8 hex>. resolveReplayFile is the map between the two:
// the loaded listing answers for free, a direct link asks the catalog for the
// one row, and everything that is not a bare cataloged game id passes through
// untouched so the head fetch stays the arbiter.
test('a bare game id resolves to the served revision before anything is fetched', async () => {
  const extract = (n: string) => {
    const start = APP.indexOf(`function ${n}(`);
    if (start < 0) throw new Error('not found: ' + n);
    const async = APP.slice(Math.max(0, start - 6), start).trim() === 'async' ? 'async ' : '';
    let depth = 0;
    for (let j = APP.indexOf('{', start); j < APP.length; j++) {
      if (APP[j] === '{') depth++;
      else if (APP[j] === '}' && --depth === 0) return async + APP.slice(start, j + 1);
    }
    throw new Error('unbalanced: ' + n);
  };

  const id = 'f8e5816a04505f9c2b5b69a6a458b696';
  const fetches: string[] = [];
  let catalogRows: unknown = [];
  let catalogOk = true;
  const boot = (list: unknown[]) => eval(`(function(){
    const replayList = list;
    const fetch = async (url) => {
      fetches.push(String(url));
      if (!catalogOk) throw new Error('no catalog');
      return { ok: true, json: async () => catalogRows };
    };
    ${extract('urlId')}
    ${extract('resolveReplayFile')}
    return resolveReplayFile;
  })()`);

  // A list click: the loaded listing already names the revision — no request.
  let resolve = boot([{ id, rid: `${id}-9942e3d8` }]);
  assert.equal(await resolve(id), `${id}-9942e3d8`);
  assert.equal(fetches.length, 0, 'the loaded listing answers without a fetch');

  // A listed row with no revision (pre-revisioning publish): the bare id IS
  // the file.
  resolve = boot([{ id, rid: null }]);
  assert.equal(await resolve(id), id);
  assert.equal(fetches.length, 0);

  // A direct link (empty listing): one catalog lookup for the one row, and
  // only the EXACT id answers — ?id= matches by prefix, so a longer id that
  // happens to share this prefix must not.
  resolve = boot([]);
  catalogRows = [{ id: id + 'ff', rid: 'wrong' }, { id, rid: `${id}-9942e3d8` }];
  assert.equal(await resolve(id), `${id}-9942e3d8`);
  assert.equal(fetches.length, 1);
  assert.ok(fetches[0].includes('id=' + id) && fetches[0].includes('limit=2'), fetches[0]);

  // An explicit revision id (alt-upload link, old shared URL) names its file
  // directly — no lookup, no rewrite.
  fetches.length = 0;
  assert.equal(await resolve(`${id}-9942e3d8`), `${id}-9942e3d8`);
  assert.equal(fetches.length, 0, 'a revision id is never resolved');

  // No catalog (a plain static host, the Go server's local files): the direct
  // fetch decides, exactly as before.
  catalogOk = false;
  assert.equal(await resolve(id), id);
});

// The GUI's own links carry the bare id everywhere EXCEPT an explicit
// alternative upload, whose entire point is a specific revision.
test('list rows link the bare game id; alt-upload links keep their revision', () => {
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
    { id: 'aaaa', rid: 'aaaa-11111111', startUnix: 1, durationSec: 60, map: 'M', gameSize: '8v8',
      sizeBytes: 1, players: [], settings: null,
      uploads: [{ rid: 'aaaa-11111111', ally: 0 }, { rid: 'aaaa-22222222', ally: 1 }] },
  ];
  const render = eval(`(function(){
    const document = dom.document;
    const replayList = rows;
    const homeDataLoaded = true;
    const ALLY_HUES = [0, 120];
    ${extract('urlId')}
    const replayHref = (id) => '/?replay=' + id;
    const fmtDate = () => 'date', fmtDateShort = () => 'date', fmtDuration = () => 'dur', fmtGameDuration = () => 'dur', fmtSize = () => 'size';
    const settingsBadges = () => [];
    const adminMode = () => false, syncOrphanButton = () => {}, filterQuery = () => '';
    const PAGE_SIZE = 50; let homePage = 0, homeHasNext = false;
    const goPage = () => {};
    const playersColumn = () => 'players';
    ${extract('mapFileGuess')}
    ${extract('renderPager')}
    ${extract('renderHome')}
    return renderHome;
  })()`);

  render();
  const tr = dom.tbody.children[0];
  const links = walk(tr).filter((n) => n.tag === 'a' && n.href);
  const internal = links.filter((n) => !n.className.includes('ext'));
  // Every row cell links the shareable form — the bare id, no -<rev> suffix.
  assert.ok(internal.length > 1, 'the row cells are links');
  for (const a of internal.filter((n) => n.className !== 'alt')) {
    assert.equal(a.href, '/?replay=aaaa', a.className);
  }
  // The one exception: an alternative upload names its revision outright, and
  // only the non-current revision is offered.
  const alts = internal.filter((n) => n.className === 'alt');
  assert.deepEqual(alts.map((a) => a.href), ['/?replay=aaaa-22222222']);
});


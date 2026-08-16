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

// FogOfWar's window. Plain JS, no framework, no build step: the Go side
// (app.go) is the whole backend, reached through Wails' bindings
// (window.go.main.App) and its "state" / "log" events.
//
// Opened in an ordinary browser (no Wails) it runs against a MOCK backend, so
// the page can be developed and screenshotted anywhere: ?mock=setup|ready|
// running|done|fail picks the starting scene.
'use strict';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

// ---------- formatting ----------
const fmtBytes = (n) => {
  if (!n || n < 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(1)) + ' ' + u[i];
};
const fmtClock = (sec) => {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0'), ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};
const fmtDur = (sec) => {
  sec = Math.max(0, Math.round(sec || 0));
  if (sec < 60) return `${sec}s`;
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(s).padStart(2, '0')}s`;
};
const fmtDate = (iso) => {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};
const fmtAgo = (iso) => {
  const d = new Date(iso), s = (Date.now() - d) / 1000;
  if (isNaN(d)) return '';
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return fmtDate(iso);
};
const gb = (n) => (n / 2 ** 30).toFixed(1) + ' GB';
const thumbURL = (file) => file ? `https://api.bar-rts.com/maps/${encodeURIComponent(file)}/texture-thumb.jpg` : '';
const shortId = (id) => id ? id.slice(0, 8) : '';
const ID_RE = /[0-9a-f]{32}/i;

// ---------- backend ----------
let api = null;          // the bound App, or the mock
let onEvent = null;      // (name, cb) => void

function waitForWails(ms) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    (function poll() {
      if (window.go && window.go.main && window.go.main.App && window.runtime) return resolve(true);
      if (Date.now() - t0 > ms) return resolve(false);
      setTimeout(poll, 30);
    })();
  });
}

const win = {
  min: () => api.HideToTray(),
  max: () => window.runtime ? window.runtime.WindowToggleMaximise() : null,
  quit: () => api.Quit(),
};

// ---------- state ----------
let S = null;            // last State from Go
let preview = null;      // the preview card's game
let previewFor = '';     // the id it was resolved for
let resolving = '';
let logLines = [];
const series = { speed: [], mem: [], cpu: [] };
let lastJobId = '';

function setState(st) {
  const prevMode = S && S.mode;
  S = st;
  document.body.dataset.mode = st.mode;
  const setup = st.mode === 'setup' || (st.mode === 'setupFailed' && !st.setup.doneAt);
  showView(setup ? 'viewSetup' : st.mode === 'running' ? 'viewRun' : 'viewReady');
  if (setup) renderSetup(st);
  else if (st.mode === 'running') renderRun(st);
  else renderReady(st, prevMode);
  renderSettings(st);
}

let currentView = '';
function showView(id) {
  if (currentView === id) return;
  currentView = id;
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== id;
  $('main').scrollTop = 0;
}

// ---------- setup ----------
const ICONS = {
  done: '<svg viewBox="0 0 20 20"><path d="M5 10.5l3.2 3L15 6.5"/></svg>',
  failed: '<svg viewBox="0 0 20 20"><path d="M6 6l8 8M14 6l-8 8"/></svg>',
  skipped: '<svg viewBox="0 0 20 20"><path d="M5 10h10"/></svg>',
  pending: '',
  active: '',
};

function renderSetup(st) {
  const failed = st.mode === 'setupFailed';
  const allDone = st.steps.every((s) => s.status === 'done' || s.status === 'skipped');
  $('setupTitle').textContent = failed ? 'Download interrupted' : allDone ? 'All set' : 'Getting ready';
  document.querySelector('.orb').classList.toggle('fail', failed);
  document.querySelector('.orb').classList.toggle('done', allDone);
  const ol = $('steps');
  if (ol.children.length !== st.steps.length) {
    ol.textContent = '';
    for (const s of st.steps) {
      const li = el('li', 'step');
      li.innerHTML = '<span class="ico"></span><span class="name"></span><span class="amount"></span><span class="detail"></span><div class="bar"><i></i></div>';
      ol.append(li);
    }
  }
  st.steps.forEach((s, i) => {
    const li = ol.children[i];
    if (li.dataset.status !== s.status) {
      li.className = 'step ' + s.status;
      li.querySelector('.ico').innerHTML = ICONS[s.status] || '';
      li.dataset.status = s.status;
    }
    li.querySelector('.name').textContent = s.label;
    li.querySelector('.detail').textContent = s.detail || '';
    const bar = li.querySelector('.bar');
    bar.hidden = s.status !== 'active';
    const known = s.percent > 0;
    bar.classList.toggle('indet', !known);
    bar.querySelector('i').style.width = (known ? Math.min(100, s.percent) : 0) + '%';
    li.querySelector('.amount').textContent = s.status === 'active' && s.total > 0
      ? `${fmtBytes(s.done)} of ${fmtBytes(s.total)}`
      : s.status === 'active' && known ? `${Math.round(s.percent)}%` : '';
  });
  $('setupFail').hidden = !failed;
  $('setupErr').textContent = st.setupError || '';
  $('setupFoot').hidden = failed;
}

// ---------- ready: paste, preview, result, history ----------
let resolveTimer = 0;

function inputChanged() {
  const v = $('gameInput').value.trim();
  const m = v.match(ID_RE);
  $('btnGo').disabled = !m || (S && S.mode === 'setup');
  $('field').classList.remove('bad');
  setHint();
  clearTimeout(resolveTimer);
  if (!m) {
    if (!v) { preview = null; previewFor = ''; renderSlot(); }
    return;
  }
  const id = m[0].toLowerCase();
  if (id === previewFor || id === resolving) return;
  resolveTimer = setTimeout(() => resolveGame(id, v), 180);
}

async function resolveGame(id, input) {
  resolving = id;
  preview = null; previewFor = id;
  renderSlot(true);
  try {
    const p = await api.ResolveGame(input);
    if (resolving !== id) return;
    preview = p;
  } catch (e) {
    if (resolving !== id) return;
    preview = null;
    setHint(String(e && e.message || e), true);
  } finally {
    if (resolving === id) resolving = '';
    renderSlot();
  }
}

function setHint(text, err) {
  const h = $('hint');
  h.textContent = text || 'A bar-rts.com or gex link, or the 32-character game ID.';
  h.classList.toggle('err', !!err);
}

function renderReady(st, prevMode) {
  if (prevMode === 'running' && st.last) { preview = null; previewFor = ''; $('gameInput').value = ''; inputChanged(); }
  $('btnGo').disabled = !$('gameInput').value.trim().match(ID_RE) || st.mode === 'setup';
  if (st.mode === 'setupFailed') setHint('The first-run download did not finish. Open Settings to try again; a game can still be re-simulated.', true);
  renderSlot();
  renderAuto(st);
  renderHistory(st.history);
}

const AUTO_ABOUT = 'Re-simulate the newest unmodded games that have no replay yet, one after another, and upload each one.';
function renderAuto(st) {
  const on = !!st.autoReplay;
  $('autoSwitch').setAttribute('aria-checked', on ? 'true' : 'false');
  $('autoBar').classList.toggle('on', on);
  $('autoSwitch').disabled = st.mode === 'setup';
  $('autoNote').textContent = on ? (st.autoNote || 'Looking for a game…') : AUTO_ABOUT;
}

async function setAuto(on) {
  try { setState(await api.SetAutoReplay(on)); } catch (e) { toastErr(e); }
}

function openReplay(id) { api.OpenReplay(id).catch(toastErr); }

// What became of a replay's upload, in words and as a chip.
function uploadWords(h) {
  if (h.upload === 'published') return 'On replay.fogofwar.dev';
  if (h.upload === 'queued') return 'Uploaded; the site is publishing it';
  if (h.upload === 'failed') return 'Not uploaded: ' + (h.uploadError || 'unknown error');
  return '';
}
function uploadChip(h) {
  if (h.upload === 'published') return el('span', 'st', 'online');
  if (h.upload === 'queued') return el('span', 'st busy', 'publishing');
  if (h.upload === 'failed') return el('span', 'st warn', 'not uploaded');
  return el('span', 'st', '.brp');
}

function renderSlot(loading) {
  const slot = $('slot');
  slot.textContent = '';
  if (S && S.last && !preview && !loading) return slot.append(resultCard(S.last));
  if (loading) return slot.append(el('div', 'card loading'));
  if (preview) slot.append(previewCard(preview));
}

function previewCard(p) {
  const c = el('div', 'card');
  const grid = el('div', 'preview');
  const th = el('div', 'thumb');
  if (p.thumb) th.style.backgroundImage = `url("${p.thumb}")`;
  grid.append(th);

  const body = el('div', 'pv-body');
  const top = el('div', 'pv-top');
  top.append(el('h3', '', p.map || 'Unknown map'));
  body.append(top);
  const lb = lobbyLine(p.lobbyName);
  if (lb) body.append(lb);
  const chips = el('div', 'chips');
  if (p.size) chips.append(el('span', 'chip size', p.size));
  tagChips(p.tags, chips);
  chips.append(el('span', 'chip', fmtClock(p.durationSec)));
  if (p.startTime) chips.append(el('span', 'chip', fmtDate(p.startTime)));
  if (p.spectators) chips.append(el('span', 'chip', `${p.spectators} spectating`));
  chips.append(el('span', 'chip', p.gameVersion || ''));
  body.append(chips);
  body.append(teamsBlock(p.sides));
  grid.append(body);
  c.append(grid);

  if (p.ramWarning) c.append(el('div', 'notice warn', '⚠ ' + p.ramWarning));
  if (p.needsEngine) c.append(el('div', 'notice info', `This game was played on engine ${p.engineVersion}, which will be downloaded first.`));
  if (p.done) {
    const n = el('div', 'notice info');
    n.append('You already made this replay. ');
    const b = el('button', 'link', 'Open it');
    b.onclick = () => openReplay(p.id);
    n.append(b);
    c.append(n);
  }

  const foot = el('div', 'pv-foot');
  const est = el('div', 'est');
  est.innerHTML = '';
  est.append('About ', el('b', '', fmtDur(p.estimateSec)), ' on this PC · needs ~', el('b', '', gb(p.estRam)), ' memory');
  foot.append(est);
  const eng = el('span', p.patchedReady ? 'chip ok' : 'chip', p.patchedReady ? 'Faster engine' : `Engine ${p.engineVersion}`);
  foot.append(eng);
  c.append(foot);
  return c;
}

// The lobby's title as the battle room showed it, when the site saw it.
function lobbyLine(name, cls) {
  if (!name) return null;
  const d = el('div', 'lobby' + (cls ? ' ' + cls : ''), name);
  d.title = 'Lobby: ' + name;
  return d;
}

// The game's settings as badges (ranked, lava, mods, ...), coloured per key.
function tagChips(tags, into, small) {
  (tags || []).forEach((t) => into.append(el('span', `chip gtag tag-${t.key}${small ? ' sm' : ''}`, t.label)));
}

function teamsBlock(sides) {
  const wrap = el('div', 'teams');
  if (!sides || !sides.length) return wrap;
  const many = sides.length > 2;
  if (many) wrap.classList.add('many');
  const cap = many ? 4 : 8;
  sides.forEach((s, i) => {
    if (i === 1 && !many) wrap.append(el('div', 'vs', 'VS'));
    const t = el('div', 'team');
    const h = el('div', 'team-h', many ? `Side ${i + 1}` : i === 0 ? 'Team 1' : 'Team 2');
    if (s.won) h.append(el('span', 'won', '★ won'));
    t.append(h);
    s.players.slice(0, cap).forEach((pl) => {
      const r = el('div', 'pl');
      const d = el('span', 'dot');
      d.style.background = pl.color; d.style.color = pl.color;
      r.append(d, el('span', 'n', pl.name + (pl.ai ? ' (AI)' : '')));
      if (pl.skill) r.append(el('span', 'os', pl.skill));
      t.append(r);
    });
    if (s.players.length > cap) t.append(el('div', 'more', `+${s.players.length - cap} more`));
    wrap.append(t);
  });
  return wrap;
}

function resultCard(h) {
  const c = el('div', 'card');
  const ok = !h.error;
  const stopped = h.error === 'Stopped';
  const r = el('div', 'result' + (ok ? '' : ' fail'));
  const ico = el('div', 'big-ico');
  ico.innerHTML = ok ? '<svg viewBox="0 0 30 30"><path d="M7 15.5l5.5 5.5L23 9.5"/></svg>'
    : '<svg viewBox="0 0 30 30"><path d="M9 9l12 12M21 9L9 21"/></svg>';
  r.append(ico);
  const mid = el('div');
  mid.append(el('h3', '', ok ? 'Replay saved' : stopped ? 'Stopped' : 'Re-simulation failed'));
  const lb = lobbyLine(h.lobbyName);
  if (lb) mid.append(lb);
  const msg = el('p', '', ok ? (h.path || '').split(/[\\/]/).pop() : stopped ? 'Nothing was saved.' : h.error);
  if (ok) msg.title = h.path || '';
  mid.append(msg);
  if (ok) {
    const st = el('div', 'stats');
    const add = (label, v) => { const s = el('span'); s.append(label + ' ', el('b', '', v)); st.append(s); };
    if (h.map) add('', `${h.map}${h.size ? ' · ' + h.size : ''}`);
    add('Size', fmtBytes(h.bytes));
    add('Took', fmtDur(h.tookSec));
    if (h.speedUp) add('Speed', h.speedUp.toFixed(1) + '×');
    mid.append(st);
    if (h.tags && h.tags.length) { const tc = el('div', 'chips'); tagChips(h.tags, tc); mid.append(tc); }
    if (h.upload) mid.append(el('p', 'up ' + h.upload, uploadWords(h)));
  }
  r.append(mid);
  const acts = el('div', 'acts');
  if (ok) {
    const b = el('button', 'btn primary', 'Open replay');
    b.onclick = () => openReplay(h.gameId);
    acts.append(b);
  } else {
    const b = el('button', 'btn primary', 'Try again');
    b.onclick = () => startResim(h.gameId);
    acts.append(b);
  }
  const d = el('button', 'btn ghost', 'Close');
  d.onclick = () => api.DismissResult().then(() => { S.last = null; renderSlot(); });
  acts.append(d);
  r.append(acts);
  c.append(r);
  if (ok && h.finishedAt && Date.now() - new Date(h.finishedAt) < 8000) c.append(confetti());
  return c;
}

function confetti() {
  const box = el('div', 'confetti');
  const colors = ['#4fdcc4', '#86eadb', '#ff8a4c', '#ffc35c', '#c3a9dc', '#f6ebe9'];
  for (let i = 0; i < 36; i++) {
    const p = el('i');
    const a = Math.random() * Math.PI * 2, d = 60 + Math.random() * 220;
    p.style.background = colors[i % colors.length];
    p.style.setProperty('--x', Math.cos(a) * d + 'px');
    p.style.setProperty('--y', Math.sin(a) * d * .6 + 'px');
    p.style.setProperty('--r', (Math.random() * 720 - 360) + 'deg');
    p.style.animationDelay = (Math.random() * .15) + 's';
    box.append(p);
  }
  return box;
}

function renderHistory(hist) {
  const list = $('rows');
  $('recent').hidden = !hist || !hist.length;
  list.textContent = '';
  (hist || []).slice(0, 12).forEach((h) => {
    const li = el('li', 'row');
    const mini = el('div', 'mini');
    if (h.mapFile) mini.style.backgroundImage = `url("${thumbURL(h.mapFile)}")`;
    const mid = el('div');
    mid.style.minWidth = '0';
    mid.append(el('div', 't', h.map || shortId(h.gameId)));
    const lb = lobbyLine(h.lobbyName, 'sm');
    if (lb) mid.append(lb);
    const sub = el('div', 's', `${h.size ? h.size + ' · ' : ''}${h.gameSec ? fmtClock(h.gameSec) + ' · ' : ''}${shortId(h.gameId)}`);
    tagChips(h.tags, sub, true);
    mid.append(sub);
    const right = el('div', 'r', h.error ? fmtAgo(h.finishedAt) : `${fmtBytes(h.bytes)} · ${fmtAgo(h.finishedAt)}`);
    const st = h.error === 'Stopped' ? el('span', 'st stop', 'stopped') : h.error ? el('span', 'st err', 'failed') : uploadChip(h);
    li.append(mini, mid, right, st);
    li.title = h.error ? h.error : ['Open the replay in the browser', uploadWords(h)].filter(Boolean).join('\n');
    li.onclick = () => h.error ? fillGame(h.gameId) : openReplay(h.gameId);
    list.append(li);
  });
}

function fillGame(id) {
  $('gameInput').value = id;
  inputChanged();
  $('gameInput').focus();
}

async function startResim(input) {
  try {
    await api.StartResim(input);
  } catch (e) {
    $('field').classList.add('bad');
    setHint(String(e && e.message || e), true);
  }
}

// ---------- running ----------
const PHASE_STEP = {
  'freeing disk space': 0, 'fetching demo': 0, 'provisioning content': 1, 'starting engine': 2, 'loading': 2,
  'simulating': 3, 'reading capture': 4, 'saving': 4, 'uploading': 5,
};
const PHASE_WORDS = {
  'freeing disk space': 'Freeing disk space',
  'fetching demo': 'Downloading the demo',
  'provisioning content': 'Checking engine and game files',
  'starting engine': 'Starting the engine',
  'loading': 'Loading the map',
  'simulating': 'Simulating',
  'reading capture': 'Writing the replay',
  'saving': 'Saving',
  'uploading': 'Uploading to replay.fogofwar.dev',
};

function renderRun(st) {
  const j = st.job;
  if (!j) return;
  if (j.gameId !== lastJobId) {
    lastJobId = j.gameId;
    series.speed = []; series.mem = []; series.cpu = [];
  }
  const p = j.preview;
  $('runMap').textContent = p ? (p.map || 'Unknown map') : 'Game ' + shortId(j.gameId);
  const meta = $('runMeta');
  meta.textContent = '';
  const lb = p && lobbyLine(p.lobbyName);
  if (lb) meta.append(lb);
  const chips = el('div', 'chips');
  if (p) {
    if (p.size) chips.append(el('span', 'chip size', p.size));
    tagChips(p.tags, chips);
    chips.append(el('span', 'chip', fmtClock(p.durationSec)));
    if (p.startTime) chips.append(el('span', 'chip', fmtDate(p.startTime)));
  }
  chips.append(el('span', 'chip', shortId(j.gameId)));
  meta.append(chips);
  const bg = $('runBg');
  const want = p && p.thumb ? `url("${p.thumb}")` : '';
  if (bg.dataset.img !== want) { bg.style.backgroundImage = want; bg.dataset.img = want; }

  const teams = $('runTeams');
  teams.textContent = '';
  if (p && p.sides) {
    p.sides.slice(0, 4).forEach((s, i) => {
      const col = el('div', 'col');
      const sw = el('div', 'sw');
      s.players.slice(0, 8).forEach((pl) => { const d = el('i'); d.style.background = pl.color; d.style.color = pl.color; d.title = pl.name; sw.append(d); });
      col.append(sw, el('span', 'lbl', `${s.players[0] ? s.players[0].name : ''}${s.players.length > 1 ? ' +' + (s.players.length - 1) : ''}${s.won ? ' ★' : ''}`));
      teams.append(col);
    });
  }

  const step = PHASE_STEP[j.phase] ?? 0;
  for (const li of $('phases').children) {
    const i = +li.dataset.i;
    li.className = i < step ? 'done' : i === step ? 'now' : '';
  }

  const sim = j.phase === 'simulating' || j.percent > 0;
  const pct = j.phase === 'reading capture' || j.phase === 'saving' || j.phase === 'uploading' ? 100 : j.percent || 0;
  $('pctNum').textContent = sim || pct ? Math.floor(pct) : '0';
  $('mainFill').style.width = pct + '%';
  $('mainBar').classList.toggle('indet', !sim && !pct);
  let words = PHASE_WORDS[j.phase] || j.phase;
  if (j.download && j.phase === 'provisioning content') words = 'Downloading game files';
  $('phaseWords').textContent = words + '…';
  $('eta').textContent = j.etaSec > 0 ? `${fmtDur(j.etaSec)} left` : '';

  const d = j.download;
  $('dlRow').hidden = !d;
  if (d) {
    $('dlLabel').textContent = d.label;
    $('dlFill').style.width = (d.percent || 0) + '%';
    $('dlBytes').textContent = d.total > 0 ? `${fmtBytes(d.done)} / ${fmtBytes(d.total)}` : `${Math.round(d.percent || 0)}%`;
  }

  const gameSec = j.frame / 30, totalSec = j.totalFrames / 30;
  $('tGame').textContent = j.frame > 0 ? fmtClock(gameSec) : '–';
  $('tGameOf').textContent = j.totalFrames > 0 ? 'of ' + fmtClock(totalSec) : '';
  $('tSpeed').textContent = j.simFps > 0 ? (j.simFps / 30).toFixed(1) + '×' : '–';
  $('tMem').textContent = j.rssBytes > 0 ? fmtBytes(j.rssBytes) : '–';
  $('tMemOf').textContent = st.hostRam > 0 ? 'of ' + gb(st.hostRam) : '';
  $('tCpu').textContent = j.cpuPercent > 0 ? Math.round(j.cpuPercent / 100 * 10) / 10 + ' cores' : '–';
  $('tCpuOf').textContent = st.cores ? `of ${st.cores}` : '';
  pushSample(j);
  spark($('spSpeed'), series.speed); spark($('spMem'), series.mem); spark($('spCpu'), series.cpu, (st.cores || 1) * 100);

  $('runElapsed').textContent = 'Running for ' + fmtDur(j.elapsedSec);
  const be = $('runEngine');
  be.hidden = !j.engine;
  be.textContent = j.engine === 'patched' ? 'Faster engine' : 'Stock engine';
  be.classList.toggle('stock', j.engine === 'stock');
  be.title = j.engine === 'patched'
    ? 'Running the patched engine build: same replay, faster, less memory'
    : 'No patched build for this engine version (or Faster engine is off in Settings)';
  $('runEyebrow').textContent = (j.auto ? 'Auto-replay · ' : '') + (j.phase === 'simulating' ? 'Simulating' : j.phase === 'uploading' ? 'Uploading' : 'Re-simulating');
  $('runAuto').hidden = !st.autoReplay;
}

// One point a second for all three charts, so they share a time axis.
let lastPush = 0;
function pushSample(j) {
  const now = Date.now();
  if (now - lastPush < 900 || j.phase !== 'simulating') return;
  lastPush = now;
  for (const [arr, v] of [[series.speed, j.simFps / 30], [series.mem, j.rssBytes], [series.cpu, j.cpuPercent]]) {
    arr.push(v > 0 ? v : NaN);
    if (arr.length > 240) arr.shift();
  }
}

function spark(svg, arr, top) {
  const pts = arr.filter((v) => isFinite(v));
  if (pts.length < 2) { svg.innerHTML = ''; return; }
  const hi = top || Math.max(...pts) * 1.15, lo = 0;
  const n = pts.length;
  const xy = pts.map((v, i) => [(i / (n - 1)) * 100, 28 - ((v - lo) / (hi - lo || 1)) * 26]);
  const line = 'M' + xy.map((p) => p[0].toFixed(2) + ' ' + p[1].toFixed(2)).join(' L');
  svg.innerHTML = `<path class="a" d="${line} L100 28 L0 28 Z"/><path class="l" d="${line}"/>`;
}

// ---------- settings + log ----------
function renderSettings(st) {
  const s = st.settings;
  $('sOut').textContent = s.outputDir; $('sOut').title = s.outputDir;
  $('sData').textContent = s.dataDir; $('sData').title = s.dataDir;
  $('sPatched').setAttribute('aria-checked', String(!!s.patchedEngine));
  renderPatchedBuild(s.patchedEngine, st.patchedBuilds || []);
  if (document.activeElement !== $('sMin')) $('sMin').value = s.minFreeMB;
  $('sMinVal').textContent = s.minFreeMB >= 1024 ? (s.minFreeMB / 1024).toFixed(1) + ' GB' : s.minFreeMB + ' MB';
  if (document.activeElement !== $('sDisk')) $('sDisk').value = s.diskLimitGB;
  $('sDiskVal').textContent = s.diskLimitGB + ' GB';
  $('sSetup').textContent = st.setup && st.setup.engineVersion
    ? `Engine ${st.setup.engineVersion} · ${(st.setup.gameVersion || '').replace('Beyond All Reason ', '')}`
    : 'Not downloaded yet';
  $('sVersion').textContent = 'FogOfWar ' + st.version;
  // The install id is on every job this PC reports; showing it lets a user
  // name their machine when they ask about one.
  $('sVersion').title = st.installId ? 'Install ID ' + st.installId : '';
  if (st.installId) $('sVersion').textContent += ' · install ' + st.installId.slice(-12);
}

// Which faster engine build runs: one line per engine version it is
// downloaded for, since a game runs on whichever its own version needs.
function renderPatchedBuild(on, builds) {
  const el = $('sPatchedBuild');
  const names = builds.map((b) => !b.build ? `a local build for engine ${b.engine}`
    : b.stale ? `an older build for engine ${b.engine} (updates to ${b.build} on the next game)`
    : `${b.build} (engine ${b.engine})`);
  let text;
  if (!on) text = 'Off: games run on the standard engine' + (names.length ? `. Downloaded: ${names.join(', ')}` : '');
  else if (!names.length) text = 'No faster build downloaded yet';
  else text = 'Using ' + names.join(', ');
  el.textContent = text;
  el.classList.toggle('off', !on || !names.length);
}

async function saveSettings(patch) {
  const s = Object.assign({}, S.settings, patch);
  try { setState(await api.SaveSettings(s)); }
  catch (e) { toastErr(e); }
}

function openPanel(id) {
  for (const p of ['settings', 'logpanel']) $(p).classList.toggle('on', p === id);
  $('scrim').classList.toggle('on', !!id);
  $('btnSettings').classList.toggle('on', id === 'settings');
  $('btnLog').classList.toggle('on', id === 'logpanel');
  if (id === 'logpanel') { const pre = $('logText'); pre.scrollTop = pre.scrollHeight; }
}
const panelOpen = (id) => $(id).classList.contains('on');

function addLog(lines) {
  logLines = logLines.concat(lines).slice(-600);
  const pre = $('logText');
  const stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
  pre.textContent = logLines.join('\n');
  if (stick) pre.scrollTop = pre.scrollHeight;
}

// ---------- modal + toast ----------
function confirmBox(title, text, yes, no) {
  return new Promise((resolve) => {
    $('modalTitle').textContent = title; $('modalText').textContent = text;
    $('modalYes').textContent = yes; $('modalNo').textContent = no;
    $('modal').hidden = false;
    const done = (v) => { $('modal').hidden = true; resolve(v); };
    $('modalYes').onclick = () => done(true);
    $('modalNo').onclick = () => done(false);
    $('modalNo').focus();
  });
}
let toastTimer = 0;
function toast(text) {
  const t = $('toast');
  t.textContent = text; t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 2800);
}
const toastErr = (e) => toast(String(e && e.message || e));

// askQuit is the close button and the tray menu's Quit. The words are
// tray.go quitQuestion's, which the native Alt+F4 dialog shows.
async function askQuit() {
  const running = S && S.mode === 'running';
  const ok = running
    ? await confirmBox('Stop the re-simulation?', 'Closing FogOfWar stops the game being re-simulated, and its replay will not be saved. Minimise it instead to keep it running in the tray.', 'Close', 'Cancel')
    : await confirmBox('Close FogOfWar?', 'FogOfWar stops re-simulating games while it is closed. Minimise it instead to keep it running in the tray.', 'Close', 'Cancel');
  if (ok) win.quit();
}

// ---------- wiring ----------
function wire() {
  $('btnMin').onclick = win.min;
  $('btnMax').onclick = win.max;
  $('btnClose').onclick = askQuit;
  document.querySelector('.titlebar').addEventListener('dblclick', (e) => { if (!e.target.closest('button')) win.max(); });
  $('btnSettings').onclick = () => openPanel(panelOpen('settings') ? null : 'settings');
  $('btnLog').onclick = () => openPanel(panelOpen('logpanel') ? null : 'logpanel');
  $('scrim').onclick = () => openPanel(null);
  for (const b of document.querySelectorAll('[data-close]')) b.onclick = () => openPanel(null);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (!$('modal').hidden) $('modalNo').click(); else openPanel(null); }
  });

  $('gameInput').addEventListener('input', inputChanged);
  $('pasteForm').onsubmit = (e) => {
    e.preventDefault();
    const v = $('gameInput').value.trim();
    if (v.match(ID_RE)) startResim(v);
  };
  $('btnPaste').onclick = async () => {
    let t = '';
    try { t = await api.PasteText(); } catch (_) {}
    if (!t && navigator.clipboard) { try { t = await navigator.clipboard.readText(); } catch (_) {} }
    if (!t) return toast('The clipboard has no text');
    $('gameInput').value = t.trim();
    inputChanged();
    $('gameInput').focus();
  };
  // A paste anywhere in the window lands in the field.
  document.addEventListener('paste', (e) => {
    if (currentView !== 'viewReady' || document.activeElement === $('gameInput')) return;
    const t = (e.clipboardData && e.clipboardData.getData('text')) || '';
    if (!t) return;
    e.preventDefault();
    $('gameInput').value = t.trim();
    inputChanged();
  });
  $('btnOpenOut').onclick = () => api.OpenFolder('output').catch(toastErr);
  $('autoSwitch').onclick = () => setAuto($('autoSwitch').getAttribute('aria-checked') !== 'true');
  $('runAuto').onclick = () => setAuto(false);

  $('btnStop').onclick = async () => {
    if (await confirmBox('Stop this re-simulation?', 'The progress so far is thrown away; nothing is saved.', 'Stop', 'Keep running')) api.Cancel();
  };
  $('btnSetupStop').onclick = () => api.Cancel();
  $('btnRetry').onclick = () => api.RetrySetup();

  $('sPatched').onclick = () => saveSettings({ patchedEngine: $('sPatched').getAttribute('aria-checked') !== 'true' });
  $('sMin').oninput = () => { const v = +$('sMin').value; $('sMinVal').textContent = v >= 1024 ? (v / 1024).toFixed(1) + ' GB' : v + ' MB'; };
  $('sMin').onchange = () => saveSettings({ minFreeMB: +$('sMin').value });
  $('sDisk').oninput = () => { $('sDiskVal').textContent = $('sDisk').value + ' GB'; };
  $('sDisk').onchange = () => saveSettings({ diskLimitGB: +$('sDisk').value });
  for (const b of document.querySelectorAll('[data-open]')) b.onclick = () => api.OpenFolder(b.dataset.open).catch(toastErr);
  for (const b of document.querySelectorAll('[data-pick]')) b.onclick = async () => {
    const out = b.dataset.pick === 'out';
    const cur = out ? S.settings.outputDir : S.settings.dataDir;
    const dir = await api.ChooseFolder(out ? 'Where should replays go?' : 'Where should the engine and game live?', cur);
    if (!dir) return;
    if (!out && !(await confirmBox('Move the data folder?', 'The engine and game (several GB) will be downloaded again into the new folder.', 'Move', 'Cancel'))) return;
    saveSettings(out ? { outputDir: dir } : { dataDir: dir });
  };
  $('sRecheck').onclick = () => { api.RetrySetup(); openPanel(null); };
  $('sOpenLog').onclick = () => api.OpenLog().catch(toastErr);
}

async function boot() {
  wire();
  const real = await waitForWails(location.search.includes('mock') ? 0 : 2500);
  if (real) {
    api = window.go.main.App;
    onEvent = (name, cb) => window.runtime.EventsOn(name, cb);
  } else {
    const m = makeMock((new URLSearchParams(location.search).get('mock')) || 'ready');
    api = m.api; onEvent = m.on;
  }
  onEvent('state', setState);
  onEvent('log', addLog);
  onEvent('askQuit', askQuit);
  addLog(await api.GetLog());
  setState(await api.GetState());
  if (currentView === 'viewReady') $('gameInput').focus();
}

// ---------- mock backend (browser preview only) ----------
function makeMock(scene) {
  const subs = {};
  const emit = (n, v) => (subs[n] || []).forEach((cb) => cb(v));
  const GB = 2 ** 30;
  const now = Date.now();
  const side = (names, colors, won, skills) => ({ won, players: names.map((n, i) => ({ name: n, color: colors[i % colors.length], skill: String(skills[i % skills.length]) })) });
  const P = {
    id: '6a37d06acbb455b1d19179d8ec965f10', map: 'Supreme Isthmus v2.1', mapFile: 'supreme_isthmus_v2.1',
    thumb: 'https://api.bar-rts.com/maps/supreme_isthmus_v2.1/texture-thumb.jpg',
    startTime: '2026-10-15T02:16:10.000Z', durationSec: 3030, engineVersion: '2026.07.04', gameVersion: 'test-31620-b0a3bbf',
    preset: 'team', size: '8v8', players: 16, spectators: 5,
    lobbyName: 'Low Tier Supreme | 8v8 | Min chev: 4 | Rating: 10-32', tags: [{ key: 'ranked', label: 'ranked' }],
    sides: [
      side(['Zekain', 'haaven', 'rilaxin', 'XuunnY', 'GazzGrim', '[APM]Akile', 'DRM', 'Vaticineur'], ['#1b702f', '#2e9b48', '#5bc96a', '#96d36b', '#0f9d8a', '#3dbfa6', '#74d9c2', '#b6efe2'], false, [8.9, 31.2, 24.7, 19.3, 28.4, 22.1, 15.6, 26.8]),
      side(['DouglasBacon', 'Tregan', 'Uncle_Cane', 'XakHarbinger', 'Crimsco', 'Zippo9', 'krtf', 'RTS_MaJoR'], ['#c4302b', '#e2572e', '#f28a3c', '#f7b84b', '#b02a63', '#d9488c', '#ef7fb2', '#a8323c'], true, [33.5, 21.4, 18.8, 27.1, 24.9, 16.2, 29.7, 20.3]),
    ],
    estimateSec: 1330, estRam: 4.6 * GB, needsEngine: false, patchedReady: true,
  };
  const steps = () => [
    { key: 'version', label: 'Find the current BAR version', status: 'done', detail: 'Engine 2026.07.04 · test-31620-b0a3bbf', percent: 100 },
    { key: 'engine', label: 'Download the Recoil engine', status: 'done', detail: 'Recoil 2026.07.04', percent: 100 },
    { key: 'patched', label: 'Download the faster engine build', status: 'done', detail: 'About 25% faster, 1.5 GB less memory', percent: 100 },
    { key: 'game', label: 'Download Beyond All Reason', status: 'active', detail: 'test-31620-b0a3bbf', percent: 37, done: 0, total: 0 },
  ];
  const hist = [
    { gameId: 'c1f0e7a2b8d94f3a9e1c2b3a4d5e6f70', map: 'Glitters 1.2', mapFile: 'glitters_1.2', size: '4v4', lobbyName: '[teh] Glitters 4v4 | all welcome', tags: [{ key: 'ranked', label: 'ranked' }, { key: 'quickStart', label: 'quick start' }], gameSec: 1520, path: 'C:\\Users\\marcin\\AppData\\Local\\FogOfWar\\replays\\c1f0e7a2b8d94f3a9e1c2b3a4d5e6f70.brp', bytes: 6.2e6, tookSec: 402, speedUp: 3.8, upload: 'published', auto: true, finishedAt: new Date(now - 3600e3 * 3).toISOString() },
    { gameId: '9b2d4e6f8a0c1e3f5a7b9c1d3e5f7a9b', map: 'All That Glitters v2.2', mapFile: 'all_that_glitters_v2.2', size: '8v8', lobbyName: 'LAVA SUPREME | 8v8 | OS 20+', tags: [{ key: 'unranked', label: 'unranked' }, { key: 'lava', label: 'lava' }], gameSec: 2410, error: 'This computer ran out of memory for this game. Close other programs, or try a smaller game.', finishedAt: new Date(now - 3600e3 * 26).toISOString() },
    { gameId: '4936896a8e1c2b3a4d5e6f7081928374', map: 'Red Comet Remake 1.8', mapFile: 'red_comet_remake_1.8', size: '1v1', lobbyName: 'practice 1v1s', tags: [{ key: 'ranked', label: 'ranked' }], gameSec: 812, path: 'C:\\Users\\marcin\\AppData\\Local\\FogOfWar\\replays\\4936896a8e1c2b3a4d5e6f7081928374.brp', bytes: 1.9e6, tookSec: 96, speedUp: 8.5, finishedAt: new Date(now - 3600e3 * 50).toISOString() },
  ];
  const st = {
    mode: 'ready', steps: steps(), setup: { engineVersion: '2026.07.04', gameVersion: 'Beyond All Reason test-31620-b0a3bbf', doneAt: new Date().toISOString() },
    history: hist, settings: { dataDir: 'C:\\Users\\marcin\\AppData\\Local\\FogOfWar\\data', outputDir: 'C:\\Users\\marcin\\AppData\\Local\\FogOfWar\\replays', patchedEngine: true, minFreeMB: 512, diskLimitGB: 10 }, patchedBuilds: [{ engine: '2026.07.04', build: '2026.7.4-barreplay.5', stale: true }],
    hostRam: 16 * GB, cores: 8, version: '0.1.0', installId: '0192f3a1-7c2e-7d41-9b0e-5a3c8e21f4d7',
  };
  let timer = 0;
  const run = (from) => {
    clearInterval(timer);
    st.mode = 'running';
    const j = st.job = { gameId: P.id, preview: P, phase: 'fetching demo', frame: 0, totalFrames: 90921, percent: 0, etaSec: 1330, simFps: 0, rssBytes: 0, cpuPercent: 0, elapsedSec: 0, engine: '' };
    let t = from || 0;
    timer = setInterval(() => {
      t += 1;
      j.elapsedSec = t;
      if (t >= 6) j.engine = 'patched';
      if (t < 3) j.phase = 'fetching demo';
      else if (t < 6) { j.phase = 'provisioning content'; j.download = { label: 'BAR content', percent: (t - 3) * 33, done: 0, total: 0 }; }
      else if (t < 8) { j.phase = 'loading'; j.download = null; j.rssBytes = 2.1 * GB; j.cpuPercent = 100; }
      else if (j.percent < 100) {
        j.phase = 'simulating';
        j.percent = Math.min(100, j.percent + 0.6 + Math.random() * 0.5);
        j.frame = Math.floor(j.totalFrames * j.percent / 100);
        j.simFps = 240 + Math.sin(t / 5) * 30 - j.percent * 1.2;
        j.rssBytes = (2.6 + j.percent * 0.014 + Math.random() * 0.05) * GB;
        j.cpuPercent = 380 + Math.random() * 90;
        j.etaSec = Math.max(0, 1330 * (1 - j.percent / 100) * 1.1);
      } else if (t < 380) { j.phase = 'saving'; } else {
        j.phase = 'uploading';
        j.download = { label: 'Uploading ' + P.id + '.brp', done: (t - 380) * 0.5e6, total: 8.4e6, percent: (t - 380) * 0.5e6 / 8.4e6 * 100 };
      }
      emit('state', JSON.parse(JSON.stringify(st)));
      if (j.phase === 'uploading' && t > 400) finish();
    }, scene === 'running' ? 50 : 300);
  };
  const finish = (err) => {
    clearInterval(timer);
    st.mode = 'ready'; st.job = null;
    const h = { gameId: P.id, map: P.map, mapFile: P.mapFile, size: P.size, lobbyName: P.lobbyName, tags: P.tags, gameSec: P.durationSec, path: 'C:\\Users\\marcin\\AppData\\Local\\FogOfWar\\replays\\' + P.id + '.brp', bytes: 8.4e6, tookSec: 1187, speedUp: 2.55, patched: true, finishedAt: new Date().toISOString(), upload: 'queued', uploadJob: 'j1' };
    if (err) { delete h.upload; delete h.uploadJob; }
    if (err) { delete h.path; h.error = err; }
    st.last = h; st.history = [h, ...st.history];
    emit('state', JSON.parse(JSON.stringify(st)));
  };
  if (scene === 'setup') {
    st.mode = 'setup'; st.setup = {}; st.history = [];
    let pct = 37, bytes = 0;
    timer = setInterval(() => {
      pct = Math.min(100, pct + 0.7); st.steps[3].percent = pct;
      emit('state', JSON.parse(JSON.stringify(st)));
      if (pct >= 100) { clearInterval(timer); st.steps[3].status = 'done'; st.mode = 'ready'; st.setup = { engineVersion: '2026.07.04', gameVersion: 'Beyond All Reason test-31620-b0a3bbf', doneAt: new Date().toISOString() }; emit('state', JSON.parse(JSON.stringify(st))); }
    }, 200);
    void bytes;
  }
  if (scene === 'running') setTimeout(() => run(9), 50);
  if (scene === 'auto') { st.autoReplay = true; st.autoNote = 'All of the 10 newest games are modded, have a replay or are being worked on; looking again at 14:32'; }
  if (scene === 'done') { st.history = hist; finish(); }
  if (scene === 'fail') finish('This computer ran out of memory for this game. Close other programs, or try a smaller game.');
  const later = (v, ms) => new Promise((r) => setTimeout(() => r(v), ms || 0));
  return {
    on: (n, cb) => (subs[n] = subs[n] || []).push(cb),
    api: {
      GetState: () => later(JSON.parse(JSON.stringify(st))),
      GetLog: () => later(['FogOfWar 0.1.0, folder C:\\Users\\marcin\\AppData\\Local\\FogOfWar', 'engine: Recoil 2026.07.04 already installed', 'pr-downloader: game test-31620-b0a3bbf ok']),
      ResolveGame: (input) => {
        const m = String(input).match(ID_RE);
        if (!m) return Promise.reject('That doesn\'t look like a game link or ID.');
        return later(Object.assign({}, P, { id: m[0].toLowerCase() }), 450);
      },
      StartResim: () => { st.last = null; run(); return later(null); },
      Cancel: () => finish('Stopped'),
      RetrySetup: () => later(null),
      DismissResult: () => { st.last = null; return later(null); },
      SaveSettings: (s) => { st.settings = s; return later(JSON.parse(JSON.stringify(st))); },
      ChooseFolder: () => later(''),
      OpenFolder: () => later(null),
      OpenReplay: (id) => { toast('Would open replay.fogofwar.dev/replays/' + shortId(id)); return later(null); },
      SetAutoReplay: (on) => { st.autoReplay = on; st.autoNote = on ? 'All of the 10 newest games have a replay or are being worked on; looking again at 14:32' : ''; return later(JSON.parse(JSON.stringify(st))); },
      OpenLog: () => later(null),
      PasteText: () => later('https://www.bar-rts.com/replays/6a37d06acbb455b1d19179d8ec965f10'),
      Quit: () => toast('Would quit'),
      HideToTray: () => toast('Would hide to the tray'),
    },
  };
}

boot();

// The summary's stylesheet, injected once per document and scoped under
// .brs-root so it neither leaks into nor depends on the host page. Colours
// are custom properties, so a host can retheme by overriding them on the
// mount element.
export const CSS = `
.brs-root {
  --brs-bg: #11151a; --brs-panel: #161c22; --brs-line: #2a323c; --brs-grid: #1f262e;
  --brs-text: #d7dee6; --brs-muted: #8a9bab; --brs-accent: #8fd3ff;
  color: var(--brs-text); background: var(--brs-bg);
  font: 13px/1.45 system-ui, -apple-system, sans-serif;
  max-width: 1100px; margin: 0 auto; padding: 18px 24px 40px;
}
.brs-root * { box-sizing: border-box; }
.brs-root h2 { font-size: 18px; margin: 0 0 4px; font-weight: 600; }
.brs-root h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .05em;
  color: var(--brs-muted); margin: 0 0 10px; font-weight: 600; }
.brs-root .brs-meta { color: var(--brs-muted); margin-bottom: 14px; }
.brs-root .brs-winner { font-weight: 600; }
.brs-root .brs-notices { margin: 0 0 16px; padding: 0; list-style: none; }
.brs-root .brs-notices li { border-left: 3px solid #c9a23a; background: var(--brs-panel);
  padding: 7px 10px; margin-bottom: 6px; color: var(--brs-text); }
.brs-root .brs-section { background: var(--brs-panel); border: 1px solid var(--brs-line);
  border-radius: 6px; padding: 14px 16px; margin-bottom: 14px; }
.brs-root .brs-sides { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
.brs-root .brs-side { border-left: 4px solid var(--brs-side); padding: 4px 10px; }
.brs-root .brs-side .brs-players { color: var(--brs-muted); }
.brs-root .brs-stat { display: flex; justify-content: space-between; gap: 10px;
  font-variant-numeric: tabular-nums; }
.brs-root .brs-stat span { color: var(--brs-muted); }
.brs-root .brs-losscols { display: grid; grid-template-columns: 1fr auto 1fr; gap: 6px 8px; margin: 6px 0 8px; align-items: start; }
.brs-root .brs-losscols > .brs-fnames { padding: 0 9px; }
.brs-root .brs-vs { align-self: center; }
.brs-root .brs-losscol { border: 1px solid transparent; border-radius: 6px; padding: 5px 8px; }
.brs-root .brs-losscol.brs-won { border-color: var(--brs-side);
  background: color-mix(in srgb, var(--brs-side) 9%, transparent); }
.brs-root .brs-losshead { display: flex; align-items: center; gap: 6px; font-weight: 600; }
.brs-root .brs-ahead { font-size: 10px; font-weight: 700; border-radius: 8px; padding: 0 6px; line-height: 15px; }
.brs-root .brs-units { display: flex; flex-wrap: wrap; gap: 4px 10px; margin-top: 4px; }
.brs-root .brs-unit { display: inline-flex; align-items: center; gap: 3px; font-variant-numeric: tabular-nums; color: var(--brs-muted); }
.brs-root .brs-uicon { width: 22px; height: 22px; object-fit: contain; }
.brs-root .brs-unitref { white-space: nowrap; }
.brs-root .brs-uicon-inline { width: 1.25em; height: 1.25em; object-fit: contain; vertical-align: -0.3em; margin-right: 3px; }
.brs-root .brs-uname { color: var(--brs-text); }
.brs-root .brs-strong { font-weight: 600; }
.brs-root .brs-more { font: inherit; font-size: 12px; color: var(--brs-muted); background: none; border: 1px solid var(--brs-grid); border-radius: 10px; padding: 1px 8px; cursor: pointer; }
.brs-root .brs-more:hover { color: var(--brs-text); }
.brs-root .brs-hint { color: var(--brs-muted); font-size: 12px; }
.brs-root svg { display: block; width: 100%; height: auto; overflow: visible; }
.brs-root svg text { fill: var(--brs-muted); font-size: 11px; font-family: inherit; }
.brs-root .brs-seek { cursor: pointer; }
.brs-root .brs-seek:hover { text-decoration: underline; }
.brs-root .brs-clickable { cursor: crosshair; }
.brs-root .brs-legend { display: flex; flex-wrap: wrap; gap: 14px; margin-bottom: 8px; color: var(--brs-muted); font-size: 12px; }
.brs-root .brs-legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
.brs-root .brs-mapwrap { max-width: 640px; margin: 0 auto; }
.brs-root .brs-map { border-radius: 4px; }
.brs-root .brs-map circle.brs-clickable:hover { stroke: #fff; stroke-width: 2px; vector-effect: non-scaling-stroke; }
.brs-root .brs-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 10px; margin-top: 12px; }
.brs-root .brs-card { border: 1px solid var(--brs-line); border-radius: 5px; padding: 8px 10px; background: var(--brs-bg); }
.brs-root .brs-seekable { cursor: pointer; }
.brs-root .brs-seekable:hover { border-color: var(--brs-accent); }
.brs-root .brs-award-title { font-weight: 600; margin-bottom: 3px; }
.brs-root .brs-award-body { display: flex; gap: 10px; align-items: flex-start; }
.brs-root .brs-awardmap { width: 64px; height: 64px; flex: none; }
.brs-root .brs-chat { max-height: 320px; overflow-y: auto; margin-top: 10px; border-top: 1px solid var(--brs-line); padding-top: 8px; }
.brs-root .brs-line { padding: 1px 0; overflow-wrap: anywhere; }
.brs-root .brs-moment { display: flex; gap: 10px; align-items: flex-start; padding: 6px 0; border-top: 1px solid var(--brs-grid); }
.brs-root .brs-moment:first-child { border-top: 0; }
.brs-root .brs-rowplay { cursor: pointer; border-radius: 4px; padding-left: 4px; padding-right: 4px; }
.brs-root .brs-rowplay:hover, .brs-root .brs-rowplay:focus-visible { background: var(--brs-bg); }
.brs-root .brs-rowplay:hover .brs-play { border-color: var(--brs-accent); color: var(--brs-accent); }
.brs-root .brs-swcols { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 4px; align-items: start; }
.brs-root .brs-swcols .brs-losscol { padding: 3px 8px; min-width: 0; }
.brs-root .brs-swloss { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 10px; margin-top: 2px; }
.brs-root .brs-swloss .brs-units { margin-top: 0; }
.brs-root .brs-swingdot { cursor: pointer; }
.brs-root .brs-swingdot circle { transition: r .1s; }
.brs-root .brs-swingdot:hover circle, .brs-root .brs-swingdot:focus-visible circle { r: 13px; stroke: #fff; }
.brs-root .brs-num { flex: 0 0 auto; width: 20px; height: 20px; border-radius: 50%; color: #000; font-weight: 600; font-size: 12px; text-align: center; line-height: 20px; margin-top: 1px; }
.brs-root .brs-muted { color: var(--brs-muted); }
.brs-root .brs-when { color: var(--brs-muted); font-variant-numeric: tabular-nums; }
.brs-root .brs-dest { color: var(--brs-muted); }
.brs-root .brs-fighters { font-size: 13px; margin: 1px 0; }
.brs-root .brs-playerbtn { all: unset; cursor: pointer; color: var(--brs-team, var(--brs-text)); border-bottom: 1px dotted var(--brs-team, var(--brs-muted)); }
.brs-root .brs-playerbtn:hover, .brs-root .brs-playerbtn:focus-visible { border-bottom-style: solid; }
.brs-root .brs-reportgrid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 18px; margin-top: 12px; }
@media (max-width: 720px) { .brs-root .brs-reportgrid { grid-template-columns: minmax(0, 1fr); } }
.brs-root .brs-small { max-width: 420px; margin: 0; }
.brs-root .brs-tabs { display: flex; flex-wrap: wrap; gap: 6px 16px; margin: 4px 0 12px; }
.brs-root .brs-tabgroup { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.brs-root .brs-tabside { font-size: 12px; margin-right: 2px; }
.brs-root .brs-tab { font: inherit; font-size: 12px; color: var(--brs-team); background: var(--brs-bg); cursor: pointer;
  border: 1px solid var(--brs-line); border-bottom: 3px solid var(--brs-team); border-radius: 4px 4px 2px 2px; padding: 3px 9px; }
.brs-root .brs-tab:hover { border-color: var(--brs-muted); border-bottom-color: var(--brs-team); }
.brs-root .brs-tab.brs-on { color: #0b0f13; background: var(--brs-team); border-color: var(--brs-team); font-weight: 600; }
.brs-root .brs-pdetail h2 { margin-bottom: 0; }
.brs-root .brs-axis { display: grid; grid-template-columns: 96px minmax(0, 1fr) auto; align-items: center; gap: 8px; padding: 2px 0; }
.brs-root .brs-axis > span:first-child { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.brs-root .brs-bar { display: block; height: 8px; background: var(--brs-grid); border-radius: 2px; overflow: hidden; }
.brs-root .brs-bar i { display: block; height: 100%; }
.brs-root .brs-panel-label { color: var(--brs-muted); font-size: 11px; text-transform: uppercase; letter-spacing: .05em; margin: 10px 0 2px; }
.brs-root details.brs-more { margin-top: 8px; }
.brs-root details.brs-more > summary { cursor: pointer; color: var(--brs-muted); font-size: 12px; padding: 4px 0; user-select: none; }
.brs-root details.brs-more > summary:hover, .brs-root details.brs-more > summary:focus-visible { color: var(--brs-text); outline: none; }
.brs-root svg text.brs-ko { font-size: 15px; font-weight: 700; }
.brs-root .brs-grow { flex: 1; min-width: 0; }
.brs-root .brs-play { font: inherit; font-size: 11px; line-height: 1; flex: 0 0 auto; cursor: pointer; color: var(--brs-text);
  background: var(--brs-bg); border: 1px solid var(--brs-line); border-radius: 50%; width: 24px; height: 24px; padding: 0 0 0 2px; }
.brs-root .brs-play:hover, .brs-root .brs-play:focus-visible { border-color: var(--brs-accent); color: var(--brs-accent); }
.brs-root .brs-watch { color: var(--brs-accent); font-size: 12px; margin-top: 4px; visibility: hidden; }
.brs-root .brs-seekable:hover .brs-watch { visibility: visible; }
.brs-root .brs-watchbtn { font: inherit; margin-top: 8px; cursor: pointer; color: var(--brs-text); background: var(--brs-bg);
  border: 1px solid var(--brs-line); border-radius: 4px; padding: 4px 10px; }
.brs-root .brs-watchbtn:hover { border-color: var(--brs-accent); color: var(--brs-accent); }
.brs-root .brs-storygrid { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: 18px; align-items: start; }
@media (max-width: 820px) { .brs-root .brs-storygrid { grid-template-columns: minmax(0, 1fr); } }
.brs-root .brs-storygrid .brs-mapwrap { max-width: none; margin: 0; }
.brs-root .brs-bhead { display: flex; justify-content: space-between; font-size: 12px; padding: 0 30px 4px 116px; }
.brs-root .brs-brow { display: grid; grid-template-columns: 22px 40px 50px minmax(0, 1fr) 24px; align-items: center; gap: 6px;
  padding: 3px 4px; border-radius: 4px; cursor: pointer; outline: none; }
.brs-root .brs-brow:hover, .brs-root .brs-brow.brs-hover, .brs-root .brs-brow:focus-visible { background: var(--brs-bg); }
.brs-root .brs-brow.brs-on { background: var(--brs-bg); box-shadow: inset 2px 0 0 var(--brs-accent); }
.brs-root .brs-numlight { background: var(--brs-text); }
.brs-root .brs-brow.brs-on .brs-numlight { background: var(--brs-accent); }
.brs-root .brs-num.brs-inline { display: inline-block; width: 18px; height: 18px; line-height: 18px; font-size: 11px; margin: 0; vertical-align: 1px; }
.brs-root .brs-where { color: var(--brs-muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.brs-root .brs-lossbar { display: grid; grid-template-columns: 1fr 1fr; gap: 2px; height: 10px; }
.brs-root .brs-half { display: flex; background: var(--brs-grid); border-radius: 2px; overflow: hidden; }
.brs-root .brs-half.brs-left { justify-content: flex-end; }
.brs-root .brs-half i { display: block; height: 100%; min-width: 1px; }
.brs-root .brs-battledetail { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--brs-line); }
.brs-root .brs-battle .brs-ring { fill: #fff; fill-opacity: .03; stroke: #fff; stroke-opacity: .25; pointer-events: none; }
.brs-root .brs-battle .brs-badge { fill: var(--brs-text); stroke: #0b0f13; stroke-width: 0; }
.brs-root svg text.brs-badgenum { fill: #0b0f13; font-weight: 700; pointer-events: none; }
.brs-root .brs-battle.brs-hover .brs-ring { stroke-opacity: 1; fill-opacity: .14; }
.brs-root .brs-battle.brs-on .brs-ring { stroke: var(--brs-accent); stroke-opacity: 1; fill: var(--brs-accent); fill-opacity: .16; }
.brs-root .brs-battle.brs-on .brs-badge { fill: var(--brs-accent); }
.brs-root .brs-tip { position: fixed; z-index: 1000; display: none; pointer-events: none; max-width: calc(100vw - 16px);
  background: #0b0f13; color: var(--brs-text); border: 1px solid var(--brs-line); border-radius: 6px;
  padding: 7px 10px; font-size: 12px; line-height: 1.4; box-shadow: 0 6px 18px rgba(0, 0, 0, .45); }
.brs-root .brs-tip-title { font-weight: 600; margin-bottom: 3px; max-width: 440px; }
.brs-root .brs-tip-row { display: flex; align-items: center; gap: 7px; white-space: nowrap; }
.brs-root .brs-tip-row i { flex: 0 0 10px; height: 10px; border-radius: 2px; }
.brs-root .brs-tip-row b { font-weight: 600; font-variant-numeric: tabular-nums; margin-left: auto; padding-left: 14px; white-space: nowrap; }
.brs-root .brs-scale { display: inline-flex; margin-left: 10px; vertical-align: 1px; border: 1px solid var(--brs-line); border-radius: 4px; overflow: hidden; }
.brs-root .brs-scale button { font: inherit; font-size: 10px; letter-spacing: .04em; text-transform: none; padding: 1px 7px; border: 0;
  background: transparent; color: var(--brs-muted); cursor: pointer; }
.brs-root .brs-scale[hidden] { display: none; }
.brs-root .brs-scale button + button { border-left: 1px solid var(--brs-line); }
.brs-root .brs-scale button[aria-pressed="true"] { background: var(--brs-line); color: var(--brs-text); }
.brs-root .brs-section > h3 .brs-scale { font-weight: 400; }
.brs-root .brs-info { display: inline-flex; align-items: center; justify-content: center; width: 13px; height: 13px; border-radius: 50%;
  border: 1px solid var(--brs-muted); color: var(--brs-muted); font: italic 600 9px/1 Georgia, serif; cursor: help; vertical-align: 1px; }
.brs-root .brs-info:hover, .brs-root .brs-info:focus { color: var(--brs-text); border-color: var(--brs-text); outline: none; }
.brs-root .brs-tip-table { display: grid; column-gap: 14px; row-gap: 2px; align-items: center; }
.brs-root .brs-tip-table b { font-weight: 600; font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
.brs-root .brs-tip-head { display: flex; align-items: center; justify-content: flex-end; gap: 6px; font-weight: 600; white-space: nowrap; }
.brs-root .brs-tip-head i { flex: 0 0 10px; height: 10px; border-radius: 2px; }
.brs-root .brs-tip-metric { color: var(--brs-muted); white-space: nowrap; }
/* A swing dot's tooltip is the swing's list row (sections/swing.ts). */
.brs-root .brs-tip-title:has(> .brs-moment) { max-width: none; font-weight: normal; margin: 0; }
.brs-root .brs-tip .brs-moment { width: min(680px, calc(100vw - 40px)); padding: 2px 0; border-top: 0; }
.brs-root .brs-tip-note { color: var(--brs-muted); margin-top: 4px; max-width: 440px; }
.brs-root .brs-val { font-variant-numeric: tabular-nums; color: var(--brs-muted); white-space: nowrap; }
/* The on-demand wait (loading.ts): monkeys hammering a bar chart together. */
.brs-root.brs-loading { display: flex; flex-direction: column; align-items: center; padding: 48px 16px; text-align: center; }
.brs-root .brs-load-scene { position: relative; width: 220px; height: 120px; }
.brs-root .brs-load-chart { position: absolute; left: 30px; right: 30px; bottom: 34px; height: 70px;
  display: flex; align-items: flex-end; gap: 8px; border-bottom: 2px solid var(--brs-line); }
.brs-root .brs-load-chart i { flex: 1; height: 100%; border-radius: 3px 3px 0 0; background: var(--brs-accent); opacity: .85;
  transform-origin: bottom; animation: brs-build 2.4s ease-in-out infinite; animation-delay: calc(var(--i) * -0.45s); }
.brs-root .brs-load-chart i:nth-child(even) { background: #e0675f; }
.brs-root .brs-load-crew { position: absolute; left: 0; right: 0; bottom: 0; display: flex; justify-content: space-around; }
.brs-root .brs-load-monkey { position: relative; font-size: 28px; line-height: 1;
  animation: brs-hop .9s ease-in-out infinite; animation-delay: calc(var(--i) * -0.3s); }
.brs-root .brs-load-monkey b { font-weight: normal; }
.brs-root .brs-load-monkey em { position: absolute; right: -14px; top: -6px; font-size: 18px; font-style: normal;
  transform-origin: 20% 90%; animation: brs-hammer .45s ease-in-out infinite alternate; animation-delay: calc(var(--i) * -0.15s); }
.brs-root .brs-load-caption { margin: 18px 0 10px; font-size: 15px; font-weight: 600; color: var(--brs-text); min-height: 1.4em; }
.brs-root .brs-load-track { width: 220px; height: 3px; border-radius: 2px; background: var(--brs-grid); overflow: hidden; margin-bottom: 10px; }
.brs-root .brs-load-track i { display: block; width: 35%; height: 100%; background: var(--brs-accent); animation: brs-slide 1.4s ease-in-out infinite; }
@keyframes brs-build { 0%, 100% { transform: scaleY(.15); } 50% { transform: scaleY(1); } }
@keyframes brs-hop { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-7px); } }
@keyframes brs-hammer { from { transform: rotate(-35deg); } to { transform: rotate(25deg); } }
@keyframes brs-slide { from { transform: translateX(-100%); } to { transform: translateX(290%); } }
@media (prefers-reduced-motion: reduce) {
  .brs-root .brs-load-chart i, .brs-root .brs-load-monkey, .brs-root .brs-load-monkey em, .brs-root .brs-load-track i { animation: none; }
  .brs-root .brs-load-chart i { transform: scaleY(calc(.35 + var(--i) * .15)); }
}
`;

const STYLE_ID = "brs-summary-style";

/** ensureStyles adds the stylesheet to the element's document once. */
export function ensureStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const st = doc.createElement("style");
  st.id = STYLE_ID;
  st.textContent = CSS;
  doc.head.append(st);
}

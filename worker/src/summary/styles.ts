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
.brs-root .brs-hint { color: var(--brs-muted); font-size: 12px; }
.brs-root svg { display: block; width: 100%; height: auto; overflow: visible; }
.brs-root svg text { fill: var(--brs-muted); font-size: 11px; font-family: inherit; }
.brs-root .brs-seek { cursor: pointer; }
.brs-root .brs-seek:hover { text-decoration: underline; }
.brs-root .brs-clickable { cursor: crosshair; }
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

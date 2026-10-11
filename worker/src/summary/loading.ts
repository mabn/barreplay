// The wait while a summary is computed on demand (POST /api/insights): a few
// seconds in which the page has nothing to draw. Rather than a bare "Loading…",
// a small scene says what is happening — monkeys hammering a chart together —
// with a caption that changes every couple of seconds, so a wait of ten reads
// as work in progress rather than a page that hung. Pure CSS animation, scoped
// under .brs-root like everything else in the library, and still under
// prefers-reduced-motion (the captions keep changing; nothing bounces).
import { h } from "./dom";
import { ensureStyles } from "./styles";
import type { SummaryHandle } from "./types";

const CAPTIONS = [
  "Dispatching the monkeys…",
  "Counting every fallen Juggernaut…",
  "Interviewing the surviving commanders…",
  "Sweeping up the wreckage…",
  "Asking the win model who was winning…",
  "Arguing about who lost the most metal…",
  "Rebuilding the battles from scratch…",
  "Bribing the fusion reactors to stay calm…",
  "Teaching the monkeys to read a replay…",
  "Drawing the charts with crayons…",
];

const CAPTION_MS = 2200;

const MONKEYS = ["🐒", "🐵", "🐒"];
const BARS = 5;

/** mountLoading draws the "summary is being built" scene into el until
 * destroyed. The first caption is always the same (the monkeys being sent);
 * the rest come in a shuffled order, so a reader waiting twice sees a
 * different run. */
export function mountLoading(el: HTMLElement): SummaryHandle {
  const doc = el.ownerDocument;
  ensureStyles(doc);
  const caption = h("p", { class: "brs-load-caption", "aria-live": "polite" }, CAPTIONS[0]);
  const bars = h("div", { class: "brs-load-chart" });
  for (let i = 0; i < BARS; i++) {
    const b = h("i");
    b.style.setProperty("--i", String(i));
    bars.append(b);
  }
  const crew = h("div", { class: "brs-load-crew" });
  MONKEYS.forEach((m, i) => {
    const s = h("span", { class: "brs-load-monkey" }, h("b", undefined, m), h("em", undefined, "🔨"));
    s.style.setProperty("--i", String(i));
    crew.append(s);
  });
  const root = h(
    "div",
    { class: "brs-root brs-loading", role: "status" },
    h("div", { class: "brs-load-scene" }, bars, crew),
    caption,
    h("div", { class: "brs-load-track" }, h("i")),
    h("p", { class: "brs-hint" }, "Building the summary for this replay. It takes a few seconds."),
  );
  el.append(root);

  const rest = CAPTIONS.slice(1).sort(() => Math.random() - 0.5);
  let k = 0;
  const timer = setInterval(() => {
    caption.textContent = rest[k++ % rest.length];
  }, CAPTION_MS);
  return {
    destroy() {
      clearInterval(timer);
      root.remove();
    },
  };
}

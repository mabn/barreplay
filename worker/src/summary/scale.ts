// The Linear / Log switch a chart offers when its values span orders of
// magnitude: two small buttons side by side, the current scale pressed.
// Picking one calls back with the choice; the chart redraws itself.
import { h } from "./dom";

/** scaleToggle builds the switch, starting on log when `log` is true. */
export function scaleToggle(log: boolean, onChange: (log: boolean) => void): HTMLElement {
  const el = h("span", { class: "brs-scale", role: "group", "aria-label": "Scale" });
  const btn = (label: string, isLog: boolean) => {
    const b = h("button", { type: "button", "aria-pressed": String(isLog === log) }, label);
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (isLog === log) return;
      log = isLog;
      for (const x of el.querySelectorAll("button")) x.setAttribute("aria-pressed", String(x === b));
      onChange(log);
    });
    return b;
  };
  el.append(btn("Linear", false), btn("Log", true));
  return el;
}

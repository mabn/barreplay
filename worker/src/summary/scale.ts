// The small two-way switches a chart offers above its plot: Linear / Log when
// its values span orders of magnitude, Ratio / Value when it compares two
// sides. Two buttons side by side, the current choice pressed. Picking one
// calls back with the choice; the chart redraws itself.
import { h } from "./dom";

/** pairToggle builds a two-button switch; `on` says the SECOND is chosen. */
export function pairToggle(labels: [string, string], on: boolean, onChange: (on: boolean) => void, aria: string): HTMLElement {
  const el = h("span", { class: "brs-scale", role: "group", "aria-label": aria });
  const btn = (label: string, isOn: boolean) => {
    const b = h("button", { type: "button", "aria-pressed": String(isOn === on) }, label);
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (isOn === on) return;
      on = isOn;
      for (const x of el.querySelectorAll("button")) x.setAttribute("aria-pressed", String(x === b));
      onChange(on);
    });
    return b;
  };
  el.append(btn(labels[0], false), btn(labels[1], true));
  return el;
}

/** scaleToggle is the Linear/Log switch, starting on log when `log` is true. */
export function scaleToggle(log: boolean, onChange: (log: boolean) => void): HTMLElement {
  return pairToggle(["Linear", "Log"], log, onChange, "Scale");
}

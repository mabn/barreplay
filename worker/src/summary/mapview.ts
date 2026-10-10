// A map view for the summary: an SVG in world coordinates (elmos, x right,
// z down) with the map's terrain behind it, fetched from BAR's maps API the
// same way the viewer does — straight from the browser, best-effort, and a
// plain background when the map is unknown.
import { s } from "./dom";
import type { Insights } from "./types";

export const DEFAULT_MAP_API = "https://api.bar-rts.com";

/** The API reports map width/height in map units; one is 512 elmos. */
const ELMOS_PER_UNIT = 512;

export interface MapView {
  svg: SVGSVGElement;
  /** Marks go here, above the terrain. */
  layer: SVGGElement;
  /** World size the view currently spans. */
  width: number;
  height: number;
}

interface MapRecord {
  fileName?: string;
  width?: number;
  height?: number;
}

/** mapFileGuess is the API's usual file-name form of a map name (right for
 * most maps; resolveMap falls back to the replay's own map record). */
export function mapFileGuess(name: string): string {
  return name.trim().toLowerCase().replace(/ /g, "_");
}

async function resolveMap(api: string, ins: Insights): Promise<{ file: string; rec: MapRecord } | null> {
  const guess = mapFileGuess(ins.mapName || "");
  if (guess) {
    const r = await fetch(`${api}/maps/${encodeURIComponent(guess)}`);
    if (r.ok) return { file: guess, rec: await r.json() };
  }
  if (!ins.gameId) return null;
  const r = await fetch(`${api}/replays/${encodeURIComponent(ins.gameId)}`);
  if (!r.ok) return null;
  const rec: MapRecord | undefined = (await r.json()).Map;
  return rec?.fileName ? { file: rec.fileName, rec } : null;
}

let clipSeq = 0;

/** mapView builds the view sized to the capture's bounds, then swaps in the
 * real map extent and terrain when the API answers. */
export function mapView(ins: Insights, mapApi: string | null | undefined, onExtent?: (v: MapView) => void): MapView {
  const b = ins.bounds;
  // Bounds are where units were; pad them so edge marks are not clipped.
  const w0 = Math.max(512, Math.ceil((b.maxX + 256) / 512) * 512);
  const h0 = Math.max(512, Math.ceil((b.maxZ + 256) / 512) * 512);
  const svg = s("svg", { viewBox: `0 0 ${w0} ${h0}`, preserveAspectRatio: "xMidYMid meet", class: "brs-map" });
  const bg = s("rect", { x: 0, y: 0, width: w0, height: h0, fill: "#1b2229" });
  const terrain = s("g");
  // Marks stop at the map's edge: aircraft die off it, and with the svg
  // letterboxed into its box they would otherwise spill into the margins.
  const clipId = `brs-mapclip-${++clipSeq}`;
  const clipRect = s("rect", { x: 0, y: 0, width: w0, height: h0 });
  const layer = s("g", { "clip-path": `url(#${clipId})` });
  svg.append(s("defs", undefined, s("clipPath", { id: clipId }, clipRect)), bg, terrain, layer);
  const view: MapView = { svg, layer, width: w0, height: h0 };
  const api = mapApi === undefined ? DEFAULT_MAP_API : mapApi;
  if (api) {
    resolveMap(api, ins).then((m) => {
      if (!m || !m.rec.width || !m.rec.height) return;
      const w = m.rec.width * ELMOS_PER_UNIT;
      const h = m.rec.height * ELMOS_PER_UNIT;
      svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
      for (const r of [bg, clipRect]) {
        r.setAttribute("width", String(w));
        r.setAttribute("height", String(h));
      }
      terrain.append(s("image", {
        href: `${api}/maps/${encodeURIComponent(m.file)}/texture-mq.jpg`,
        x: 0, y: 0, width: w, height: h, preserveAspectRatio: "none", opacity: 0.55,
      }));
      view.width = w;
      view.height = h;
      onExtent?.(view);
    }).catch(() => { /* no network, unknown map: keep the plain background */ });
  }
  return view;
}

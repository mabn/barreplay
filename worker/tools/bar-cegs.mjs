// bar-cegs.mjs — regenerate public/fx-cegdata.js, the explosion effects
// (CEGs) BAR draws for each weapon, from a checkout of BAR's game repo.
//
//   git clone --depth 1 https://github.com/beyond-all-reason/Beyond-All-Reason bar
//   node tools/bar-cegs.mjs ../bar        (needs lua5.4 on $PATH)
//
// BAR defines its effects in Lua (effects/*.lua, with table.copy/merge
// arithmetic on top of plain tables), and each weapon names its effect in its
// unit file (explosiongenerator = "custom:<name>"). dump.lua evaluates both
// with the game's own table helpers; this script keeps only what the viewer
// draws: the effects some weapon reaches (directly or through a spawner), the
// five particle classes fx-ceg.js implements, and their properties. Like the
// icon table, this is static per BAR version, so it ships with the viewer and
// never rides in a replay. Only NUMBERS are taken: BAR's effect textures
// are all-rights-reserved art, so they are MEASURED (textures.mjs: brightness,
// opacity and colour by distance from the centre) and fx-ceg.js paints
// stand-ins from the measurements.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { profiles } from "./bar-cegs/textures.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const bar = process.argv[2];
if (!bar) {
  console.error("usage: node tools/bar-cegs.mjs <BAR checkout>");
  process.exit(2);
}

const raw = JSON.parse(execFileSync("lua5.4", [join(here, "bar-cegs/dump.lua"), bar], {
  maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"],
}).toString());
let sha = "";
try { sha = execFileSync("git", ["-C", bar, "rev-parse", "HEAD"]).toString().trim(); } catch { /* not a git checkout */ }

const COMMON = ["pos", "speed", "dir", "rotparams", "animparams"];
const PROPS = {
  csimpleparticlesystem: ["emitvector", "emitmul", "gravity", "colormap", "texture", "airdrag",
    "particlelife", "particlelifespread", "numparticles", "particlespeed", "particlespeedspread",
    "particlesize", "particlesizespread", "emitrot", "emitrotspread", "directional", "sizegrowth", "sizemod"],
  cheatcloudprojectile: ["heat", "maxheat", "heatfalloff", "size", "sizegrowth", "sizemod", "sizemodmod", "texture"],
  cbitmapmuzzleflame: ["sidetexture", "fronttexture", "colormap", "size", "length", "sizegrowth",
    "frontoffset", "particlespeed", "particlespeedspread", "airdrag", "gravity", "ttl"],
  csimplegroundflash: ["size", "sizegrowth", "ttl", "colormap", "texture"],
  cexpgenspawner: ["delay", "damage", "explosiongenerator"],
};
const FLAGS = ["ground", "water", "air", "underwater", "unit", "nounit", "intercepted", "voidground", "voidwater", "shield"];
const lc = (v) => (typeof v === "string" ? v.toLowerCase() : v);

function prune(def) {
  const out = {};
  for (const [name, sp] of Object.entries(def)) {
    if (!sp || typeof sp !== "object") continue;
    if (name === "groundflash") {
      const g = {};
      for (const k of ["flashsize", "flashalpha", "circlegrowth", "circlealpha", "color", "ttl"]) if (sp[k] !== undefined) g[k] = sp[k];
      for (const k of FLAGS) if (sp[k]) g[k] = true;
      if ((g.ttl || 0) > 0 && (g.flashsize || 0) > 1) out.groundflash = g;
      continue;
    }
    const cls = lc(sp.class || "");
    const keep = PROPS[cls];
    if (!keep) continue;
    const count = sp.count === undefined ? 1 : Number(sp.count) || 0;
    if (count <= 0) continue;
    const props = {};
    for (const [k, v] of Object.entries(sp.properties || {})) {
      if (keep.includes(k) || COMMON.includes(k)) props[k] = k.endsWith("texture") || k === "explosiongenerator" ? lc(String(v)) : v;
    }
    const s = { class: cls.slice(1), count, props };
    for (const k of FLAGS) if (sp[k] === true || sp[k] === 1) (s.flags ||= []).push(k);
    out[name] = s;
  }
  return out;
}

const cegs = {};
const want = [...new Set(Object.values(raw.weapons))];
while (want.length) {
  const n = want.pop();
  if (cegs[n] || !raw.cegs[n]) continue;
  cegs[n] = prune(raw.cegs[n]);
  for (const sp of Object.values(cegs[n])) {
    const g = sp.props && sp.props.explosiongenerator;
    if (g) want.push(g.replace(/^custom:/, ""));
  }
}
const weapons = {};
for (const [w, c] of Object.entries(raw.weapons).sort()) if (cegs[c]) weapons[w] = c;
const sorted = Object.fromEntries(Object.entries(cegs).sort());

// Every texture the kept effects draw, with its flipbook grid if any.
const used = new Map([["groundflash", null], ["groundring", null]]);
for (const def of Object.values(sorted)) {
  for (const sp of Object.values(def)) {
    const p = sp.props || {};
    const ap = typeof p.animparams === "string" ? p.animparams.split(",").map((x) => parseInt(x, 10)) : null;
    const grid = ap && ap[0] > 1 ? [ap[0], ap[1]] : null;
    for (const k of ["texture", "fronttexture", "sidetexture"]) {
      const t = p[k];
      if (t && t !== "none" && (!used.has(t) || (grid && !used.get(t)))) used.set(t, grid);
    }
  }
}
const textures = profiles(bar, raw.textures, used);

const body = JSON.stringify({ bar: sha, weapons, cegs: sorted, textures });
writeFileSync(join(here, "../public/fx-cegdata.js"),
  "// GENERATED by tools/bar-cegs.mjs from BAR's effects/, units/ and weapons/" +
  (sha ? ` (commit ${sha})` : "") + ". Do not edit.\n" +
  "globalThis.BAR_CEGS = " + body + ";\n");
console.log(`${Object.keys(weapons).length} weapons, ${Object.keys(sorted).length} effects, ${Object.keys(textures).length} textures measured, ${body.length} bytes`);

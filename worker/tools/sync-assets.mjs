// Copies the vendored BAR unit + rank icons from internal/viz/bardata into this
// Worker's public/ dir so Vite bundles them as static assets (served at /icons/*
// and /ranks/*). They're a fixed set that versions with the app, so they ship as
// assets rather than living in R2. Run automatically before dev/build; the copies
// are gitignored (source of truth is internal/viz/bardata).
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The placeholder assets/lua/replay_uploader.lua carries for its git SHA. */
const TOKEN = "__WIDGET_SHA__";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const bardata = join(repo, "internal", "viz", "bardata");
const publicDir = join(here, "..", "public");

for (const name of ["icons", "ranks"]) {
  const src = join(bardata, name);
  const dst = join(publicDir, name);
  await mkdir(dst, { recursive: true });
  await cp(src, dst, { recursive: true });
  console.log(`synced ${name} -> public/${name}`);
}

// The Replay uploader widget, offered for download by /setup. Copied from
// assets/lua for the same reason as the icons: the repo keeps ONE copy, so a
// widget edit cannot leave a stale file here for players to install. Not
// fingerprinted (its URL is printed in a guide and must stay stable), so
// public/_headers keeps it revalidating.
//
// The copy is STAMPED on the way through: __WIDGET_SHA__ becomes the SHA of
// the last commit that touched the widget, so every capture a player uploads
// records the exact bytes that produced it (the widget writes the SHA into its
// stream's GAME line, and the catalog stores it per replay). The widget's own
// version+date constants say which release it is; the SHA says which build of
// that release, which is what actually identifies a file that was served for
// weeks while the version stood still.
//
// A dirty widget in the working tree is left UNSTAMPED rather than labelled
// with the commit it no longer matches: the widget only reports a 40-hex
// value, so the field simply drops out of the capture. Same for a checkout
// with no git available.
const widget = "replay_uploader.lua";
const widgetSrc = join(repo, "assets", "lua", widget);
const widgetOut = join(publicDir, widget);

function widgetSha() {
  const git = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  try {
    if (git(["status", "--porcelain", "--", widgetSrc]) !== "") {
      console.warn(`WARNING: ${widget} has uncommitted changes — publishing it unstamped (no widget SHA in captures)`);
      return null;
    }
    const sha = git(["log", "-1", "--format=%H", "--", widgetSrc]);
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch (e) {
    console.warn(`WARNING: cannot read the widget's git SHA (${e.message.split("\n")[0]}) — publishing it unstamped`);
    return null;
  }
}

const sha = widgetSha();
const source = await readFile(widgetSrc, "utf8");
if (sha && !source.includes(TOKEN)) {
  throw new Error(`${widget} no longer contains ${TOKEN} — the stamp would be silently dropped`);
}
await writeFile(widgetOut, sha ? source.replaceAll(TOKEN, sha) : source);
console.log(`synced ${widget} -> public/${widget}${sha ? ` (stamped ${sha.slice(0, 8)})` : " (unstamped)"}`);

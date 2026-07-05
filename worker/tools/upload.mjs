// Upload a static bundle (produced by `barreplay-static`) to the R2 bucket, one
// object per file. Walks ONLY the replays/ tree, so nothing else in the directory
// (e.g. .wrangler/) is ever swept in. No index.json is uploaded — the Worker builds
// the listing live from the bucket, so a single replay's files are self-sufficient.
//
//   node tools/upload.mjs <bundleDir> [replayId] [--preview] [--local]
//
//   <bundleDir>   the -out dir you passed to barreplay-static (default ../static)
//   [replayId]    upload just this one replay (replays/<id>.brw, .resources, /c*).
//                 Omit to upload every replay in the dir.
//   --preview     target barreplay-replays-preview (what `wrangler dev` binds)
//   --local       target the local (miniflare) R2, for `npm run dev`
//
// Requires `wrangler login` (or CLOUDFLARE_API_TOKEN) for a real upload.
import { spawnSync } from "node:child_process";
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const raw = process.argv.slice(2);
const flags = raw.filter((a) => a.startsWith("--"));
const positional = raw.filter((a) => !a.startsWith("--"));
const dir = positional[0] ?? "../static";
const replayId = positional[1]; // optional: a single replay to upload
const preview = flags.includes("--preview") || flags.includes("--local");
const local = flags.includes("--local");
const bucket = preview ? "barreplay-replays-preview" : "barreplay-replays";

// Collect the object files for either one replay or every replay under replays/.
function replayFiles(root, id) {
  const out = [];
  const replays = join(root, "replays");
  if (id) {
    for (const f of [join(replays, `${id}.brw`), join(replays, `${id}.resources`)]) {
      if (existsSync(f)) out.push(f);
    }
    walk(join(replays, id), out); // chunk files
    if (out.length === 0) {
      console.error(`no files for replay "${id}" under ${replays} (did you pack it?)`);
      process.exit(1);
    }
  } else {
    walk(replays, out);
  }
  return out;
}

function walk(p, out) {
  if (!existsSync(p)) return;
  for (const name of readdirSync(p)) {
    const full = join(p, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
}

const files = replayFiles(dir, replayId);
if (files.length === 0) {
  console.error(`no replay files under ${dir}/replays (run barreplay-static first)`);
  process.exit(1);
}

const what = replayId ? `replay "${replayId}" (${files.length} objects)` : `${files.length} objects`;
console.log(`uploading ${what} to ${bucket}${local ? " (local)" : ""}`);
for (const file of files) {
  const key = relative(dir, file).split("\\").join("/"); // POSIX keys on Windows too
  const cmd = ["wrangler", "r2", "object", "put", `${bucket}/${key}`, "--file", file];
  if (local) cmd.push("--local");
  const r = spawnSync("npx", cmd, { stdio: ["ignore", "ignore", "inherit"] });
  if (r.status !== 0) {
    console.error(`failed: ${key}`);
    process.exit(r.status ?? 1);
  }
  console.log(`  put ${key}`);
}
console.log("done");

// Upload a static bundle (produced by `barreplay-static`) to the R2 bucket, one
// object per file. Walks ONLY index.json + the replays/ tree, so nothing else in
// the directory (e.g. .wrangler/) is ever swept in.
//
//   node tools/upload.mjs <bundleDir> [--preview] [--local]
//
//   <bundleDir>   the -out dir you passed to barreplay-static (default ../static)
//   --preview     upload to barreplay-replays-preview (what `wrangler dev` binds)
//   --local       target the local (miniflare) R2, for `npm run dev`
//
// Requires `wrangler login` (or CLOUDFLARE_API_TOKEN) for a real upload.
import { spawnSync } from "node:child_process";
import { readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const args = process.argv.slice(2);
const preview = args.includes("--preview") || args.includes("--local");
const local = args.includes("--local");
const dir = args.find((a) => !a.startsWith("--")) ?? "../static";
const bucket = preview ? "barreplay-replays-preview" : "barreplay-replays";

// The exact set of bundle files: index.json plus everything under replays/.
function bundleFiles(root) {
  const out = [];
  const index = join(root, "index.json");
  if (existsSync(index)) out.push(index);
  const replays = join(root, "replays");
  const walk = (p) => {
    if (!existsSync(p)) return;
    for (const name of readdirSync(p)) {
      const full = join(p, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(replays);
  return out;
}

const files = bundleFiles(dir);
if (files.length === 0) {
  console.error(`no bundle files under ${dir} (expected index.json + replays/**). Run barreplay-static first.`);
  process.exit(1);
}

console.log(`uploading ${files.length} objects to ${bucket}${local ? " (local)" : ""}`);
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

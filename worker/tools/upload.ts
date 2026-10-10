// Upload a static bundle (produced by `barreplay-static`, or `pack -upload`'s
// temp bundle) to the R2 bucket, one object per file. Walks ONLY the replays/
// tree, so nothing else in the directory (e.g. .wrangler/) is ever swept in.
// No index.json is uploaded — the Worker builds the listing live from the
// bucket, so a single replay's files are self-sufficient.
//
//   npx tsx tools/upload.ts <bundleDir> [replayId] [--local] [--preview]
//
//   <bundleDir>   the -out dir you passed to barreplay-static (default ../static)
//   [replayId]    upload just this one replay (replays/<id>.* — the .brp and any
//                 pieces beside it — plus an older bundle's /c*). Omit to
//                 upload every replay in the dir.
//   --local       target the local (miniflare) R2 used by `npm run dev`
//                 (default is REAL R2)
//   --preview     with --local, use the preview bucket wrangler dev binds
//
// Transport is picked by tools/r2put.ts: parallel S3 PUTs when
// R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY are set (fast), else parallel
// `wrangler r2 object put` (needs `wrangler login` or CLOUDFLARE_API_TOKEN).
// A replay published today is one .brp, which is its own listing marker. An
// older bundle's .brw head is uploaded last: it was the marker the live
// listing keyed on, so a half-uploaded replay never appeared in the picker.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

import { uploadObjects, type R2Object } from "./r2put";

const raw = process.argv.slice(2);
const flags = raw.filter((a) => a.startsWith("--"));
const positional = raw.filter((a) => !a.startsWith("--"));
const dir = positional[0] ?? "../static";
const replayId = positional[1]; // optional: a single replay to upload

const local = flags.includes("--local");
const bucket = local && flags.includes("--preview") ? "barreplay-replays-preview" : "barreplay-replays";

/** collectReplayFiles gathers the bundle's object files (key -> path) for one
 * replay or for every replay under <root>/replays, ordered with each .brw
 * head after all of its replay's other files. Exported for the tests. */
export function collectReplayFiles(root: string, id?: string): R2Object[] {
  const files: string[] = [];
  const replays = join(root, "replays");
  if (id) {
    // Every <id>.<ext> beside the head: .brw/.keys/.resources, and pieces
    // added to a published replay later (<id>.insights<N>.json). A rid may
    // sit in a month folder ("2026-10/<gameId>"): its files are that
    // folder's <name>.*.
    const slash = id.lastIndexOf("/");
    const folder = slash >= 0 ? join(replays, id.slice(0, slash)) : replays;
    const base = id.slice(slash + 1);
    if (existsSync(folder)) {
      for (const name of readdirSync(folder)) {
        const f = join(folder, name);
        if (name.startsWith(`${base}.`) && statSync(f).isFile()) files.push(f);
      }
    }
    walk(join(replays, id), files); // chunk files of an older split bundle
  } else {
    walk(replays, files);
  }
  const objects = files.map((f) => ({ key: relative(root, f).split("\\").join("/"), file: f }));
  // Heads (.brw, the listing markers) last, stable order otherwise.
  return objects.sort((a, b) => Number(a.key.endsWith(".brw")) - Number(b.key.endsWith(".brw")) || (a.key < b.key ? -1 : 1));
}

function walk(p: string, out: string[]): void {
  if (!existsSync(p)) return;
  for (const name of readdirSync(p)) {
    const full = join(p, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
}

// Only run the CLI when invoked directly (the tests import collectReplayFiles).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const objects = collectReplayFiles(dir, replayId);
  if (objects.length === 0) {
    console.error(
      replayId
        ? `no files for replay "${replayId}" under ${join(dir, "replays")} (did you pack it?)`
        : `no replay files under ${dir}/replays (run barreplay-static first)`,
    );
    process.exit(1);
  }
  const target = local ? `${bucket} (LOCAL dev simulator)` : `${bucket} (real R2)`;
  const what = replayId ? `replay "${replayId}" (${objects.length} objects)` : `${objects.length} objects`;
  console.error(`uploading ${what} to ${target}`);
  const started = Date.now();
  const via = await uploadObjects(objects, { bucket, local });
  console.error(`done (${objects.length} objects via ${via} in ${((Date.now() - started) / 1000).toFixed(1)}s)`);
}

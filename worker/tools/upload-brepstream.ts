// Split a raw .brepstream capture into its static R2 pieces (src/breps/
// split.ts) and upload them to the worker's bucket, one `wrangler r2 object
// put` per piece — the brepstream twin of tools/upload.ts. `pack -upload`
// shells out to this for .brepstream inputs.
//
//   npx tsx tools/upload-brepstream.ts <file.brepstream> [--local] [--out <dir>]
//
//   --local      target the local (miniflare) R2 used by `npm run dev`
//                (default is REAL R2 — `wrangler r2 object put --remote`)
//   --out <dir>  write the pieces into <dir> instead of uploading (debugging)
//
// The head (.brw) is uploaded LAST: it is the marker object the live listing
// keys on, so a half-uploaded replay never appears in the picker. No
// index.json exists — the Worker lists the bucket. Transport is picked by
// tools/r2put.ts: parallel S3 PUTs when R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY
// are set (fast), else parallel `wrangler r2 object put` (needs `wrangler
// login` or CLOUDFLARE_API_TOKEN).
//
// NOTE: the pieces are the "breps1" wire format (BRW version byte 5). The
// deployed viewer decodes only version 4 (.brp bundles) so far; until its
// breps decoder lands, these replays list but fail to load with
// "unsupported payload version 5".
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { splitBrepstream } from "../src/breps/split";
import { uploadObjects } from "./r2put";

const BUCKET = "barreplay-replays";

const raw = process.argv.slice(2);
const local = raw.includes("--local");
const outIdx = raw.indexOf("--out");
const outDir = outIdx >= 0 ? raw[outIdx + 1] : undefined;
const positional = raw.filter((a, i) => !a.startsWith("--") && (outIdx < 0 || i !== outIdx + 1));
const input = positional[0];
if (!input || (outIdx >= 0 && !outDir)) {
  console.error("usage: tsx tools/upload-brepstream.ts <file.brepstream> [--local] [--out <dir>]");
  process.exit(2);
}

const { gameId, head, files, warnings } = await splitBrepstream(new Uint8Array(readFileSync(input)));
for (const w of warnings) console.error(`warning: ${w}`);
console.error(
  `${gameId}: ${head.frameCount} frames in ${head.chunks.length} chunks, ` +
    `${head.events.length} events, map ${JSON.stringify(head.map)} -> ${files.size} objects`,
);

// Stable order, head last (it is the listing's marker object).
const keys = [...files.keys()].sort((a, b) => Number(a.endsWith(".brw")) - Number(b.endsWith(".brw")) || (a < b ? -1 : 1));

if (outDir) {
  for (const key of keys) {
    const path = join(outDir, key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, files.get(key)!);
    console.error(`  wrote ${path}`);
  }
  process.exit(0);
}

const target = local ? `${BUCKET} (LOCAL dev simulator)` : `${BUCKET} (real R2)`;
console.error(`uploading ${keys.length} objects to ${target}`);
const started = Date.now();
const via = await uploadObjects(
  keys.map((key) => ({ key, bytes: files.get(key)! })),
  { bucket: BUCKET, local },
);
console.error(`done (${keys.length} objects via ${via} in ${((Date.now() - started) / 1000).toFixed(1)}s)`);

// Copies the vendored BAR unit + rank icons from the Go viz package into this
// Worker's public/ dir so Vite bundles them as static assets (served at /icons/*
// and /ranks/*). They're a fixed set that versions with the app, so they ship as
// assets rather than living in R2. Run automatically before dev/build; the copies
// are gitignored (source of truth is internal/viz/bardata).
import { spawnSync } from "node:child_process";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const bardata = join(repoRoot, "internal", "viz", "bardata");
const publicDir = join(here, "..", "public");

for (const name of ["icons", "ranks"]) {
  const src = join(bardata, name);
  const dst = join(publicDir, name);
  await mkdir(dst, { recursive: true });
  await cp(src, dst, { recursive: true });
  console.log(`synced ${name} -> public/${name}`);
}

// Regenerate the icon table the browser uses to resolve unit icons. Best-effort:
// if Go isn't on this machine, keep the committed public/icontypes.json.
const out = join(publicDir, "icontypes.json");
const r = spawnSync("go", ["run", "./cmd/barreplay-icons"], { cwd: repoRoot, encoding: "utf8", maxBuffer: 8 << 20 });
if (r.status === 0 && r.stdout) {
  await writeFile(out, r.stdout);
  console.log("generated public/icontypes.json");
} else if (existsSync(out)) {
  console.log("kept committed public/icontypes.json (go not available or failed)");
} else {
  console.error("WARNING: could not generate public/icontypes.json and none is committed:", r.stderr || r.error);
}

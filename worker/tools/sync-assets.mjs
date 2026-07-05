// Copies the vendored BAR unit + rank icons from the Go viz package into this
// Worker's public/ dir so Vite bundles them as static assets (served at /icons/*
// and /ranks/*). They're a fixed set that versions with the app, so they ship as
// assets rather than living in R2. Run automatically before dev/build; the copies
// are gitignored (source of truth is internal/viz/bardata).
import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bardata = join(here, "..", "..", "internal", "viz", "bardata");
const publicDir = join(here, "..", "public");

for (const name of ["icons", "ranks"]) {
  const src = join(bardata, name);
  const dst = join(publicDir, name);
  await mkdir(dst, { recursive: true });
  await cp(src, dst, { recursive: true });
  console.log(`synced ${name} -> public/${name}`);
}

// Shared R2 upload backend for the tools/ CLIs (upload.ts, upload-brepstream.ts)
// and, through them, `pack -upload`. Two transports, picked automatically:
//
//   - S3 API (fast path): when R2 API credentials are in the environment
//     (R2_ACCESS_KEY_ID + R2_SECRET_ACCESS_KEY — create one under Cloudflare
//     dash -> R2 -> Manage R2 API Tokens) and the target is real R2, objects
//     are PUT straight against the bucket's S3 endpoint
//     (https://<account>.r2.cloudflarestorage.com) with aws4fetch signing,
//     many in flight. One process, no per-object startup cost: a whole replay
//     uploads in a couple of seconds.
//   - wrangler (fallback, and always for --local): `wrangler r2 object put`
//     per object, parallelized. Each spawn pays ~2s of node+wrangler startup,
//     which is why serial uploads felt slow; concurrency hides most of it.
//     The local dev simulator keeps low concurrency — concurrent wrangler
//     processes contend on the same miniflare sqlite state.
//
// The account id comes from CLOUDFLARE_ACCOUNT_ID or wrangler.jsonc. Callers
// pass objects as bytes or file paths; file paths are only read when needed.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AwsClient } from "aws4fetch";

export interface R2Object {
  key: string;
  /** Object body; exactly one of bytes/file must be set. */
  bytes?: Uint8Array;
  file?: string;
}

export interface UploadOptions {
  bucket: string;
  /** Target the local wrangler dev simulator instead of real R2. */
  local: boolean;
  /** Max uploads in flight; defaults per transport (16 S3, 8 wrangler, 2 local). */
  concurrency?: number;
  /** Progress line per object (defaults to stderr). */
  log?: (line: string) => void;
}

/** uploadObjects uploads in two waves: everything else first, then every
 * .brw head — a real completion barrier, not just start order. The head is
 * the object the Worker's live listing keys on, so a replay can never appear
 * in the picker before the rest of its files exist. Within a wave, order is
 * start order subject to concurrency. Returns the transport used. */
export async function uploadObjects(objects: R2Object[], opts: UploadOptions): Promise<"s3" | "wrangler"> {
  const log = opts.log ?? ((line: string) => console.error(line));
  const heads = objects.filter((o) => o.key.endsWith(".brw"));
  const bodies = objects.filter((o) => !o.key.endsWith(".brw"));

  const s3 = opts.local ? null : s3Client();
  if (s3) {
    const put = async (o: R2Object) => {
      await s3Put(s3, opts.bucket, o);
      log(`  put ${o.key}`);
    };
    await pool(bodies, opts.concurrency ?? 16, put);
    await pool(heads, opts.concurrency ?? 16, put);
    return "s3";
  }

  // wrangler path: bodies must be files on disk.
  const tmp = mkdtempSync(join(tmpdir(), "r2put-"));
  try {
    const put = async (o: R2Object) => {
      let file = o.file;
      if (file === undefined) {
        file = join(tmp, o.key.split("/").join("_"));
        writeFileSync(file, o.bytes!);
      }
      // Explicit --remote/--local: wrangler's own default for `r2 object put`
      // is LOCAL, so a bare put would silently write to disk, not R2.
      await run("npx", ["wrangler", "r2", "object", "put", `${opts.bucket}/${o.key}`, "--file", file, opts.local ? "--local" : "--remote"]);
      log(`  put ${o.key}`);
    };
    const limit = opts.concurrency ?? (opts.local ? 2 : 8);
    await pool(bodies, limit, put);
    await pool(heads, limit, put);
    return "wrangler";
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// s3Client returns a signing client when R2 API credentials and an account id
// are available, else null (callers fall back to wrangler).
function s3Client(): { aws: AwsClient; endpoint: string } | null {
  const id = process.env.R2_ACCESS_KEY_ID;
  const secret = process.env.R2_SECRET_ACCESS_KEY;
  if (!id || !secret) return null;
  const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? accountFromWranglerConfig();
  if (!account) {
    console.error("warning: R2 credentials set but no account id (CLOUDFLARE_ACCOUNT_ID or wrangler.jsonc); using wrangler");
    return null;
  }
  return {
    aws: new AwsClient({ accessKeyId: id, secretAccessKey: secret, service: "s3", region: "auto" }),
    endpoint: `https://${account}.r2.cloudflarestorage.com`,
  };
}

function accountFromWranglerConfig(): string | null {
  try {
    const jsonc = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    return /"account_id"\s*:\s*"([0-9a-f]+)"/.exec(jsonc)?.[1] ?? null;
  } catch {
    return null;
  }
}

async function s3Put(s3: { aws: AwsClient; endpoint: string }, bucket: string, o: R2Object): Promise<void> {
  const body = o.bytes ?? new Uint8Array(readFileSync(o.file!));
  const url = `${s3.endpoint}/${bucket}/${o.key.split("/").map(encodeURIComponent).join("/")}`;
  // One retry for transient 5xx/network hiccups; anything else is a real error.
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await s3.aws.fetch(url, { method: "PUT", body: body as BodyInit });
      if (res.ok) return;
      const text = (await res.text()).slice(0, 300);
      if (res.status >= 500 && attempt === 0) continue;
      throw new Error(`PUT ${o.key}: ${res.status} ${text}`);
    } catch (e) {
      if (attempt === 0) continue;
      throw e instanceof Error ? e : new Error(String(e));
    }
  }
}

/** pool runs fn over items with at most `limit` in flight, preserving start
 * order. The first failure aborts scheduling and rejects after in-flight
 * calls settle. */
export async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed: unknown = null;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length && failed === null) {
      const item = items[next++];
      try {
        await fn(item);
      } catch (e) {
        failed = e ?? new Error("upload failed");
      }
    }
  });
  await Promise.all(workers);
  if (failed !== null) throw failed;
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "inherit"] });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${args.slice(0, 4).join(" ")} exited ${code}`))));
  });
}

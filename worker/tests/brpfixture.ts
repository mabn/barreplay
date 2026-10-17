// Builds the head of a .brp container for tests: magic, version, M section.
import { gzipSync } from "node:zlib";

/** brp builds a container head: magic, version, and an M section. */
export function brp(meta: unknown, version = 6, gz = true): Uint8Array {
  const json = Buffer.from(JSON.stringify(meta));
  const payload = gz ? gzipSync(json) : json;
  const head = Buffer.alloc(10);
  head.write("BRP1", 0, "latin1");
  head[4] = version;
  head[5] = 0x4d;
  head.writeUInt32LE(payload.length, 6);
  return new Uint8Array(Buffer.concat([head, payload]));
}

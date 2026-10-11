// The SummaryHub Durable Object inside workerd: a daemon's WebSocket is
// accepted (Hibernation API), a compute request reaches it as a message, its
// answer resolves the request, and the keepalive is answered by the runtime.
// The dispatching rules themselves are node-tested in tests/summaryhub.test.ts.
import { env } from "cloudflare:test";
import { assert, test } from "vitest";

function hub(name: string) {
  return env.SUMMARY_HUB.get(env.SUMMARY_HUB.idFromName(name));
}

async function connect(stub: ReturnType<typeof hub>, version = 7): Promise<WebSocket> {
  const res = await stub.fetch(`https://hub/connect?version=${version}&slots=1`, { headers: { upgrade: "websocket" } });
  assert.equal(res.status, 101);
  const ws = res.webSocket!;
  ws.accept();
  return ws;
}

const nextMessage = (ws: WebSocket): Promise<string> =>
  new Promise((ok) => ws.addEventListener("message", (e) => ok(String(e.data)), { once: true }));

test("a compute request reaches the connected daemon and resolves with its answer", async () => {
  const stub = hub("compute");
  const ws = await connect(stub);
  assert.deepEqual(await stub.connected(), { daemons: 1, versions: [7] });

  const got = nextMessage(ws);
  const pending = stub.compute("2026-10/0123456789abcdef0123456789abcdef", 7);
  const msg = JSON.parse(await got);
  assert.equal(msg.type, "compute");
  assert.equal(msg.rid, "2026-10/0123456789abcdef0123456789abcdef");
  assert.equal(msg.version, 7);
  ws.send(JSON.stringify({ type: "result", id: msg.id, ok: true }));
  assert.deepEqual(await pending, { status: "done" });

  // A version nobody computes is refused without bothering the daemon.
  assert.equal((await stub.compute("x", 8)).status, "unavailable");
  ws.close(1000, "done");
});

test("the keepalive is answered and a non-upgrade is refused", async () => {
  const stub = hub("ping");
  const ws = await connect(stub);
  const got = nextMessage(ws);
  ws.send("ping");
  assert.equal(await got, "pong");
  ws.close(1000, "done");
  assert.equal((await stub.fetch("https://hub/connect?version=7")).status, 426);
  assert.equal((await stub.fetch("https://hub/connect", { headers: { upgrade: "websocket" } })).status, 400);
});

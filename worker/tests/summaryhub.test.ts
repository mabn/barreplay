// The on-demand summary hub's dispatching rules (src/worker/summaryhub.ts),
// with fake daemon sockets and a fake clock: who gets a request, what waits,
// what is refused, and what a daemon's answer or disappearance does.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type HubResult, type HubSocket, SummaryDispatcher } from "../src/worker/summaryhub.ts";

interface FakeDaemon extends HubSocket {
  sent: { id: string; rid: string; version: number }[];
}

function setup(opts: { maxQueued?: number; failTtlMs?: number } = {}) {
  let now = 1000;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let tid = 0;
  const daemons: FakeDaemon[] = [];
  const hub = new SummaryDispatcher(() => daemons, {
    maxQueued: opts.maxQueued ?? 2,
    timeoutMs: 60_000,
    failTtlMs: opts.failTtlMs ?? 600_000,
    now: () => now,
    setTimer: (fn, ms) => {
      timers.set(++tid, { at: now + ms, fn });
      return tid;
    },
    clearTimer: (t) => timers.delete(t as number),
  });
  const connect = (id: string, version = 7, slots = 1): FakeDaemon => {
    const d: FakeDaemon = {
      id,
      version,
      slots,
      sent: [],
      send(m) {
        this.sent.push(JSON.parse(m));
      },
    };
    daemons.push(d);
    return d;
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [k, t] of [...timers]) {
      if (t.at <= now) {
        timers.delete(k);
        t.fn();
      }
    }
  };
  const answer = (d: FakeDaemon, i: number, ok: boolean, error?: string) =>
    hub.onMessage(d.id, JSON.stringify({ type: "result", id: d.sent[i].id, ok, error }));
  return { hub, daemons, connect, advance, answer };
}

// A settled-or-not probe: the promise's value if it has resolved by now.
async function peek(p: Promise<HubResult>): Promise<HubResult | "pending"> {
  return Promise.race([p, new Promise<"pending">((ok) => setImmediate(() => ok("pending")))]);
}

test("no daemon, or none computing the version asked for, is unavailable at once", async () => {
  const { hub, connect } = setup();
  assert.deepEqual(await hub.request("r1", 7), { status: "unavailable", reason: "no summary daemon is connected" });
  connect("a", 6);
  const r = await hub.request("r1", 7);
  assert.equal(r.status, "unavailable");
  assert.match((r as { reason: string }).reason, /v6, not v7/);
});

test("a request goes to a free daemon and resolves with its answer", async () => {
  const { hub, connect, answer } = setup();
  const d = connect("a");
  const p = hub.request("r1", 7);
  assert.deepEqual(d.sent.map((m) => [m.rid, m.version]), [["r1", 7]]);
  // Readers of the same replay share the one computation.
  const again = hub.request("r1", 7);
  assert.equal(d.sent.length, 1);
  answer(d, 0, true);
  assert.deepEqual(await p, { status: "done" });
  assert.deepEqual(await again, { status: "done" });
  assert.deepEqual(hub.stats(), { inFlight: 0, queued: 0 });
});

test("past the free slots requests queue; past the queue they are busy", async () => {
  const { hub, connect, answer } = setup({ maxQueued: 1 });
  const a = connect("a", 7, 1);
  const b = connect("b", 7, 1);
  const p1 = hub.request("r1", 7);
  const p2 = hub.request("r2", 7);
  assert.equal(a.sent.length + b.sent.length, 2, "one each");
  const p3 = hub.request("r3", 7);
  assert.deepEqual(hub.stats(), { inFlight: 2, queued: 1 });
  assert.deepEqual(await hub.request("r4", 7), { status: "busy" });
  // A slot frees: the queued one goes out on it.
  answer(a, 0, true);
  assert.deepEqual(await p1, { status: "done" });
  assert.equal(a.sent.at(-1)!.rid, "r3");
  answer(a, 1, true);
  answer(b, 0, true);
  assert.deepEqual(await p2, { status: "done" });
  assert.deepEqual(await p3, { status: "done" });
});

test("a request runs out of time, but its daemon stays busy until it answers", async () => {
  const { hub, connect, advance, answer } = setup({ maxQueued: 4 });
  const d = connect("a");
  const p1 = hub.request("r1", 7);
  const p2 = hub.request("r2", 7); // queued behind it
  advance(60_000);
  assert.deepEqual(await p1, { status: "timeout" });
  assert.deepEqual(await p2, { status: "timeout" });
  assert.deepEqual(hub.stats(), { inFlight: 1, queued: 0 });
  // The late answer frees the slot; nobody is waiting on it any more.
  answer(d, 0, true);
  assert.deepEqual(hub.stats(), { inFlight: 0, queued: 0 });
  // And a later reader asks afresh.
  const p3 = hub.request("r1", 7);
  assert.equal(d.sent.length, 2);
  answer(d, 1, true);
  assert.deepEqual(await p3, { status: "done" });
});

test("a reader asking again after a timeout joins the computation still running", async () => {
  const { hub, connect, advance, answer } = setup();
  const d = connect("a");
  const p1 = hub.request("r1", 7);
  advance(60_000);
  assert.deepEqual(await p1, { status: "timeout" });
  // The page asks again: no second computation, a fresh deadline.
  const p2 = hub.request("r1", 7);
  assert.equal(d.sent.length, 1);
  advance(30_000);
  answer(d, 0, true);
  assert.deepEqual(await p2, { status: "done" });
  assert.deepEqual(hub.stats(), { inFlight: 0, queued: 0 });
});

test("a failure is remembered, so a broken replay costs a daemon once", async () => {
  const { hub, connect, advance, answer } = setup({ failTtlMs: 1000 });
  const d = connect("a");
  const p = hub.request("r1", 7);
  answer(d, 0, false, "no .brp");
  assert.deepEqual(await p, { status: "failed", error: "no .brp" });
  assert.deepEqual(await hub.request("r1", 7), { status: "failed", error: "no .brp" });
  assert.equal(d.sent.length, 1);
  advance(1001);
  void hub.request("r1", 7);
  assert.equal(d.sent.length, 2);
});

test("a daemon that disconnects fails its work and leaves the queue to the others", async () => {
  const { hub, daemons, connect, answer } = setup({ maxQueued: 4 });
  const a = connect("a");
  const p1 = hub.request("r1", 7);
  const p2 = hub.request("r2", 7);
  daemons.splice(0, 1);
  hub.onClose("a");
  assert.deepEqual(await p1, { status: "failed", error: "the summary daemon disconnected" });
  // With nobody left, the queued one is told so rather than left to time out.
  assert.equal((await p2).status, "unavailable");
  assert.equal(a.sent.length, 1);
  // Not remembered as the replay's failure: the next reader gets a daemon.
  const b = connect("b");
  const p3 = hub.request("r1", 7);
  assert.equal(await peek(p3), "pending");
  answer(b, 0, true);
  assert.deepEqual(await p3, { status: "done" });
});

test("answers that are not for this hub's requests are ignored", async () => {
  const { hub, connect } = setup();
  const a = connect("a");
  const b = connect("b");
  const p = hub.request("r1", 7);
  const to = a.sent.length ? a : b;
  const other = to === a ? b : a;
  hub.onMessage(other.id, JSON.stringify({ type: "result", id: to.sent[0].id, ok: true }));
  hub.onMessage(to.id, "not json");
  hub.onMessage(to.id, JSON.stringify({ type: "result", id: "999", ok: true }));
  assert.equal(await peek(p), "pending");
});

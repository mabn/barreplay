// ON-DEMAND SUMMARIES, the dispatching half (pure: no workerd imports, so the
// node tests drive it with fake sockets; summaryhubdo.ts is the Durable
// Object around it).
//
// A page that opens a replay whose summary is older than the version it reads
// (or has none) asks for the current one and WAITS for it: POST /api/insights
// -> the SummaryHub Durable Object -> one of the ingest daemons (plain
// `bringest`, never the re-sim worker) holding a WebSocket open to it -> the
// daemon computes the summary with internal/insightsrun, publishes it, and
// answers on the same socket -> the route reads the new file from the bucket
// and hands it to the page. Nothing is stored: no job row, no queue table.
// The daemon dials OUT, so it still needs no inbound connectivity.
//
// Capacity is the hub's, held in memory: each daemon says on connect how many
// summaries it computes at once (its slots); requests past the free slots
// wait in a short queue (maxQueued), and past THAT they are refused at once
// ("busy") — the page then simply keeps the summary it already shows. Every
// request has a deadline (timeoutMs), queue wait included. Two readers of the
// same replay share one computation. A summary that FAILED is not retried for
// failTtlMs, so a replay that cannot be summarised costs a daemon once, not
// once per page view. All of this is lost if the instance is evicted, which
// is harmless: eviction only happens with nothing in flight.

/** One connected daemon, as the hub sees it. */
export interface HubSocket {
  /** Stable for the connection's life (kept in the socket's attachment, so
   * it survives hibernation). */
  id: string;
  /** The insights version the daemon computes. A request is only ever sent
   * to a daemon that computes the version it asks for. */
  version: number;
  /** How many summaries it computes at once. */
  slots: number;
  send(message: string): void;
}

export type HubResult =
  | { status: "done" }
  | { status: "failed"; error: string }
  | { status: "busy" }
  | { status: "unavailable"; reason: string }
  | { status: "timeout" };

/** What the hub sends a daemon, and what the daemon answers. The Go half is
 * cmd/bringest/summaries.go; the two must agree. */
export interface ComputeMessage {
  type: "compute";
  id: string;
  rid: string;
  version: number;
}
export interface ResultMessage {
  type: "result";
  id: string;
  ok: boolean;
  error?: string;
}

export interface HubOptions {
  maxQueued: number;
  timeoutMs: number;
  failTtlMs: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export const HUB_DEFAULTS: HubOptions = {
  // A page waits on this. Long enough for a big game's .brp download and
  // compute (seconds), short enough that a stuck daemon costs a reader no
  // more than a minute of "Updating…" over the summary it already sees.
  timeoutMs: 60_000,
  // Readers waiting beyond the busy slots. A version bump makes every
  // replay stale at once, so a burst is normal; past this the page keeps
  // its older summary, and the next visit asks again.
  maxQueued: 16,
  failTtlMs: 10 * 60_000,
};

interface Pending {
  key: string;
  rid: string;
  version: number;
  promise: Promise<HubResult>;
  resolve: (r: HubResult) => void;
  timer: unknown;
  /** The daemon working on it and the id it was sent under, once dispatched. */
  socket?: string;
  msgId?: string;
  settled: boolean;
}

export class SummaryDispatcher {
  private o: Required<HubOptions>;
  /** By summary key (rid@version): what readers wait on. */
  private byKey = new Map<string, Pending>();
  /** By message id: what daemons are working on. Outlives a reader's
   * timeout, because the daemon is still busy until it answers. */
  private byMsg = new Map<string, Pending>();
  private busy = new Map<string, number>();
  private queue: Pending[] = [];
  private failed = new Map<string, { error: string; until: number }>();
  private seq = 0;

  constructor(
    private sockets: () => HubSocket[],
    opts: Partial<HubOptions> = {},
  ) {
    const o = { ...HUB_DEFAULTS, ...opts };
    this.o = {
      ...o,
      now: o.now ?? (() => Date.now()),
      setTimer: o.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: o.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)),
    };
  }

  /** request asks for rid's summary at version and resolves when it is
   * published, refused or out of time. */
  request(rid: string, version: number): Promise<HubResult> {
    const key = `${rid}@${version}`;
    const same = this.byKey.get(key);
    if (same) return same.promise;
    const f = this.failed.get(key);
    if (f && f.until > this.o.now()) return Promise.resolve({ status: "failed", error: f.error });
    this.failed.delete(key);

    const able = this.sockets().filter((s) => s.version === version);
    if (able.length === 0) {
      const versions = [...new Set(this.sockets().map((s) => s.version))];
      return Promise.resolve({
        status: "unavailable",
        reason:
          versions.length === 0
            ? "no summary daemon is connected"
            : `the connected daemons compute insights v${versions.join(", v")}, not v${version}`,
      });
    }
    const target = this.free(able);
    if (!target && this.queue.length >= this.o.maxQueued) return Promise.resolve({ status: "busy" });

    let resolve!: (r: HubResult) => void;
    const promise = new Promise<HubResult>((ok) => (resolve = ok));
    const p: Pending = { key, rid, version, promise, resolve, timer: null, settled: false };
    p.timer = this.o.setTimer(() => this.settle(p, { status: "timeout" }), this.o.timeoutMs);
    this.byKey.set(key, p);
    if (target) this.dispatch(p, target);
    else this.queue.push(p);
    return promise;
  }

  /** onMessage takes a daemon's answer. Anything that is not a result for a
   * request this hub sent is ignored. */
  onMessage(socketId: string, raw: string): void {
    let m: Partial<ResultMessage>;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m?.type !== "result" || typeof m.id !== "string") return;
    const p = this.byMsg.get(m.id);
    if (!p || p.socket !== socketId) return;
    this.release(p);
    if (m.ok === true) {
      this.settle(p, { status: "done" });
    } else {
      const error = typeof m.error === "string" && m.error ? m.error.slice(0, 500) : "the summary could not be computed";
      this.failed.set(p.key, { error, until: this.o.now() + this.o.failTtlMs });
      this.settle(p, { status: "failed", error });
    }
    this.drain();
  }

  /** onClose fails what a vanished daemon was working on (not remembered as
   * a failure: the replay is not at fault) and hands the queue to whoever is
   * left. */
  onClose(socketId: string): void {
    for (const p of [...this.byMsg.values()]) {
      if (p.socket !== socketId) continue;
      this.release(p);
      this.settle(p, { status: "failed", error: "the summary daemon disconnected" });
    }
    this.busy.delete(socketId);
    this.drain();
  }

  /** For the tests and the log: what is in flight right now. */
  stats(): { inFlight: number; queued: number } {
    return { inFlight: this.byMsg.size, queued: this.queue.length };
  }

  private free(able: HubSocket[]): HubSocket | undefined {
    let best: HubSocket | undefined;
    let bestLoad = Infinity;
    for (const s of able) {
      const load = (this.busy.get(s.id) ?? 0) / Math.max(1, s.slots);
      if ((this.busy.get(s.id) ?? 0) < Math.max(1, s.slots) && load < bestLoad) {
        best = s;
        bestLoad = load;
      }
    }
    return best;
  }

  private dispatch(p: Pending, s: HubSocket): void {
    const id = `${++this.seq}`;
    p.socket = s.id;
    p.msgId = id;
    this.busy.set(s.id, (this.busy.get(s.id) ?? 0) + 1);
    this.byMsg.set(id, p);
    const msg: ComputeMessage = { type: "compute", id, rid: p.rid, version: p.version };
    try {
      s.send(JSON.stringify(msg));
    } catch {
      // A socket closing under us: its close event fails the request.
    }
  }

  private release(p: Pending): void {
    if (p.msgId === undefined || !this.byMsg.has(p.msgId)) return;
    this.byMsg.delete(p.msgId);
    const n = (this.busy.get(p.socket!) ?? 1) - 1;
    if (n > 0) this.busy.set(p.socket!, n);
    else this.busy.delete(p.socket!);
  }

  private settle(p: Pending, r: HubResult): void {
    if (p.settled) return;
    p.settled = true;
    this.o.clearTimer(p.timer);
    if (this.byKey.get(p.key) === p) this.byKey.delete(p.key);
    const qi = this.queue.indexOf(p);
    if (qi >= 0) this.queue.splice(qi, 1);
    p.resolve(r);
  }

  private drain(): void {
    while (this.queue.length > 0) {
      const p = this.queue[0];
      const able = this.sockets().filter((s) => s.version === p.version);
      if (able.length === 0) {
        this.settle(p, { status: "unavailable", reason: "no summary daemon is connected" });
        continue;
      }
      const s = this.free(able);
      if (!s) return;
      this.queue.shift();
      this.dispatch(p, s);
    }
  }
}

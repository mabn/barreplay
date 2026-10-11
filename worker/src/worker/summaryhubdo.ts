// The SummaryHub Durable Object: one instance, holding the WebSocket of every
// connected summary daemon and the SummaryDispatcher (summaryhub.ts) that
// shares requests out among them. Its own class rather than a method set on
// ReplayIndex so socket traffic never wakes the catalog — no SQL here at all,
// so none of the ROW BUDGET applies.
//
// Sockets are accepted through the Hibernation API: an idle hub costs nothing
// while daemons stay connected, and the daemons' keepalive ("ping", answered
// "pong" by the runtime itself via setWebSocketAutoResponse) never wakes it.
// What a socket must remember across hibernation (its id, version and slots)
// rides its attachment; everything in flight lives in memory, which is sound
// because an instance with a request in progress is never hibernated.
import { DurableObject } from "cloudflare:workers";
import { HUB_DEFAULTS, type HubResult, type HubSocket, SummaryDispatcher } from "./summaryhub";

interface Attachment {
  id: string;
  version: number;
  slots: number;
}

const MAX_SLOTS = 8;

export class SummaryHub extends DurableObject<Env> {
  private hub: SummaryDispatcher;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    this.hub = new SummaryDispatcher(() => this.sockets(), HUB_DEFAULTS);
  }

  /** The daemon's connection: GET with Upgrade: websocket and
   * ?version=<insights version>&slots=<n>. The route has checked the bearer
   * token already. */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }
    const q = new URL(request.url).searchParams;
    const version = Number(q.get("version"));
    const slots = Number(q.get("slots") ?? "1");
    if (!Number.isInteger(version) || version < 1) return new Response("version must be an insights version", { status: 400 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    const a: Attachment = {
      id: crypto.randomUUID(),
      version,
      slots: Number.isInteger(slots) ? Math.min(Math.max(slots, 1), MAX_SLOTS) : 1,
    };
    server.serializeAttachment(a);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** compute is what POST /api/insights awaits. */
  async compute(rid: string, version: number): Promise<HubResult> {
    return this.hub.request(rid, version);
  }

  /** How many daemons are connected, by version — for the route's answer
   * when none can serve, and for anyone curious. */
  async connected(): Promise<{ daemons: number; versions: number[] }> {
    const s = this.sockets();
    return { daemons: s.length, versions: [...new Set(s.map((x) => x.version))].sort() };
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const a = ws.deserializeAttachment() as Attachment | null;
    if (!a || typeof message !== "string") return;
    this.hub.onMessage(a.id, message);
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    const a = ws.deserializeAttachment() as Attachment | null;
    if (a) this.hub.onClose(a.id);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "closing");
    } catch {
      // already closed
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    const a = ws.deserializeAttachment() as Attachment | null;
    if (a) this.hub.onClose(a.id);
  }

  private sockets(): HubSocket[] {
    const out: HubSocket[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const a = ws.deserializeAttachment() as Attachment | null;
      if (!a) continue;
      out.push({ id: a.id, version: a.version, slots: a.slots, send: (m) => ws.send(m) });
    }
    return out;
  }
}

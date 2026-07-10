import { invoke } from "@/hooks/use-tauri-ipc";
import type { AgentCompletePayload } from "./agent-complete";

/** Writes one raw frame to the socket (Tauri: `ws_send` command; browser: `ws.send`). */
export type SendFrame = (frame: string) => void | Promise<void>;

export type WsTransportKind = "tauri" | "browser";

export type WsTransportHandlers = {
  /**
   * Fired on every (re)connect. `kind` lets the caller apply per-path policy —
   * the Tauri path starts the device heartbeat and awaits room subscription /
   * runner registration; the browser fallback registers as desktop +
   * subscribes its device room and fires the rest without awaiting.
   */
  onConnected: (sendFrame: SendFrame, kind: WsTransportKind) => void | Promise<void>;
  onDisconnected: (kind: WsTransportKind) => void;
  /** One raw server frame (string or already-parsed object). */
  onMessage: (data: unknown) => void;
  /** Tauri only: local agent stream chunk (Rust `agent:message` event). */
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous stream payloads
  onAgentMessage: (payload: { sessionId: string; data: any }) => void;
  /** Tauri only: local agent finished (Rust `agent:complete` event). */
  onAgentComplete: (payload: AgentCompletePayload) => void | Promise<void>;
  /**
   * Tauri only (ISS-84): drain pending incremental PATCHes before the renderer
   * tears down on a cooperative window close. Best-effort: fire-and-forget
   * since `beforeunload` does not await async work.
   */
  onBeforeUnload: () => void;
};

export type WsTransportOptions = {
  wsUrl: string;
  /** User JWT (browser subprotocol / Tauri bearer fallback). */
  token: string | null;
  deviceId: string | null;
  /** Effect-cancellation probe, checked after the async Tauri import resolves. */
  isCancelled: () => boolean;
  /** Browser fallback only: surfaces the raw socket (kept on a ref by the hook). */
  onBrowserSocket?: (ws: WebSocket) => void;
};

export type WsTransportConnection = {
  kind: WsTransportKind;
  /**
   * Remove the Tauri-path beforeunload hook (no-op on browser). Called
   * synchronously at cleanup start, BEFORE any awaited teardown work —
   * mirrors the pre-refactor cleanup order.
   */
  detach: () => void;
  /** Tear down: Tauri = unlisten all bridge events; browser = ws.close(). */
  close: () => void;
};

/**
 * One interface over the transport duality. Tries the Tauri event bridge
 * first (Rust owns the WebSocket; frames arrive as `ws:*` Tauri events and
 * local agent traffic as `agent:message` / `agent:complete`). ANY throw in
 * that setup — dynamic import, `listen()` registration, or `connect_ws` —
 * falls back to a plain browser WebSocket that re-implements
 * connect/subscribe/register, matching the pre-refactor try/catch.
 *
 * Returns `undefined` when the effect was cancelled during the async import.
 */
export async function startWsTransport(
  opts: WsTransportOptions,
  handlers: WsTransportHandlers,
): Promise<WsTransportConnection | undefined> {
  const { wsUrl, token, deviceId } = opts;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    if (opts.isCancelled()) return undefined;

    console.warn("[ws-debug] tauri listen() registered — Rust WS path active");
    const unlisten1 = await listen("ws:connected", async () => {
      console.warn("[ws-debug] ws:connected event fired");
      // ISS-173: routes through the Tauri `ws_send` command added in ISS-173 §2.
      const sendFrame: SendFrame = async (frame: string) => {
        await invoke("ws_send", { payload: frame });
      };
      await handlers.onConnected(sendFrame, "tauri");
    });
    const unlisten2 = await listen("ws:disconnected", async () => {
      handlers.onDisconnected("tauri");
    });
    const unlisten3 = await listen<unknown>("ws:message", (event) => {
      handlers.onMessage(event.payload);
    });
    // ws:error fires per failed reconnect attempt during a retry loop —
    // it is noise, not an authoritative disconnect signal. Only
    // ws:disconnected (inner read loop exited) should flip UI state.
    const unlisten4 = await listen("ws:error", () => {
      /* no-op */
    });

    const onBeforeUnload = () => handlers.onBeforeUnload();
    window.addEventListener("beforeunload", onBeforeUnload);

    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous stream payloads
    const unlisten5 = await listen<{ sessionId: string; data: any }>(
      "agent:message",
      (event) => {
        handlers.onAgentMessage(event.payload);
      },
    );

    const unlisten6 = await listen<{ sessionId: string; claudeSessionId?: string | null; error?: string }>(
      "agent:complete",
      async (event) => {
        await handlers.onAgentComplete(event.payload);
      },
    );

    // Load the bearer for WS upgrade. Sent as `Authorization: Bearer <…>`.
    // Server `resolveBearer` accepts a user JWT or a device token (in that
    // order). Prefer device token if the runner has been paired against a
    // project (ISS-214 §5); fall back to the user JWT issued at sign-in
    // (ADR 0019) so a freshly-paired desktop without a per-project device
    // still authenticates the socket. Anonymous upgrade is rejected 401
    // — the stale comment about Phase 2.2 enforcement was wrong here.
    let bearer: string | undefined;
    try {
      const tok = await invoke<string | null>("load_device_token");
      if (tok) bearer = tok;
    } catch { /* keychain unavailable */ }
    if (!bearer && token) bearer = token;

    // ISS-286: token never goes in the URL — it leaks via nginx access logs,
    // browser history, and Referer. The Rust path attaches the device token
    // via Authorization header (see websocket/mod.rs).
    await invoke("connect_ws", {
      url: wsUrl,
      deviceToken: bearer,
      deviceId: deviceId || undefined,
    });

    return {
      kind: "tauri",
      detach: () => window.removeEventListener("beforeunload", onBeforeUnload),
      close: () => {
        unlisten1();
        unlisten2();
        unlisten3();
        unlisten4();
        unlisten5();
        unlisten6();
      },
    };
  } catch (err) {
    // Not in Tauri — use native WebSocket as fallback. Pass the user JWT
    // via Sec-WebSocket-Protocol subprotocol (ISS-286) so the token
    // never appears in the URL / access logs / Referer.
    console.warn("[ws-debug] tauri listen() failed → browser fallback", err);
    const protocols = token ? [`forge.bearer.${token}`] : undefined;
    const ws = protocols ? new WebSocket(wsUrl, protocols) : new WebSocket(wsUrl);
    opts.onBrowserSocket?.(ws);
    const sendFrame: SendFrame = (frame) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(frame);
    };
    ws.onopen = () => {
      console.warn("[ws-debug] browser WS open — sending subscribe device:", deviceId);
      void handlers.onConnected(sendFrame, "browser");
    };
    ws.onclose = () => {
      handlers.onDisconnected("browser");
    };
    ws.onmessage = (e) => handlers.onMessage(e.data);
    return {
      kind: "browser",
      detach: () => {},
      close: () => ws.close(),
    };
  }
}

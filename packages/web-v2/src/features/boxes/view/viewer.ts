// A box's view socket (`/ws/boxes/view`, ISS-1276): core sends a `hello` first, a `holder` whenever
// the hold moves and `closed` before it ends (`@forge/contracts/box-wire:BoxViewerMessage`), and
// between them the codec's own messages: text `frame` JSON for `jpeg-frames`, binary chunks for
// `scrcpy-h264` and `rfb`. This splits the two, so each codec's sink sees only its bytes.

import type { BoxViewerMessage } from "@forge/contracts/box-wire";

type Hello = Extract<BoxViewerMessage, { type: "hello" }>;
type Holder = Extract<BoxViewerMessage, { type: "holder" }>;

export interface ViewerHandlers {
  hello: (m: Hello) => void;
  holder: (m: Holder) => void;
  /** The view ended: core's `closed` reason, or the socket's own close. */
  ended: (why: string) => void;
  /** A codec text message (`jpeg-frames`). */
  text: (data: string) => void;
  binary: (data: ArrayBuffer) => void;
}

export interface Viewer {
  /** Bytes the codec's client sends back (noVNC's RFB handshake); a jpeg or h264 view sends none. */
  send: (data: ArrayBuffer | Uint8Array<ArrayBuffer>) => void;
  close: () => void;
}

export function openViewer(url: string, h: ViewerHandlers): Viewer {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  let ended = false;
  const end = (why: string) => {
    if (ended) return;
    ended = true;
    h.ended(why);
  };
  ws.onmessage = (e: MessageEvent<string | ArrayBuffer>) => {
    if (typeof e.data !== "string") {
      h.binary(e.data);
      return;
    }
    if (e.data.startsWith('{"type":"frame"')) {
      h.text(e.data);
      return;
    }
    let m: BoxViewerMessage | null = null;
    try {
      m = JSON.parse(e.data) as BoxViewerMessage;
    } catch {
      return;
    }
    if (m.type === "hello") h.hello(m);
    else if (m.type === "holder") h.holder(m);
    else if (m.type === "closed") end(m.why);
  };
  ws.onclose = (e) => end(e.reason || `socket closed (${e.code})`);
  return {
    send: (data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    },
    close: () => {
      ended = true;
      ws.close(1000);
    },
  };
}

/**
 * What noVNC takes in place of a WebSocket it opens itself: the view socket's binary messages only,
 * and its writes sent back on it. Its required properties are own properties, which noVNC checks.
 */
export function rfbChannel(viewer: Viewer) {
  const channel = {
    binaryType: "arraybuffer",
    protocol: "",
    readyState: "open",
    onopen: null as null | (() => void),
    onmessage: null as null | ((e: { data: ArrayBuffer }) => void),
    onerror: null as null | ((e: unknown) => void),
    onclose: null as null | ((e: { code: number; reason: string; wasClean: boolean }) => void),
    send: (data: ArrayBuffer | Uint8Array<ArrayBuffer>) => viewer.send(data),
    close: () => {
      channel.readyState = "closed";
      viewer.close();
    },
    deliver: (data: ArrayBuffer) => channel.onmessage?.({ data }),
    end: (reason: string) => {
      channel.readyState = "closed";
      channel.onclose?.({ code: 1000, reason, wasClean: true });
    },
  };
  return channel;
}

/** A `jpeg-frames` message's picture as an address an `<img>` draws, or null for anything else. */
export function jpegOf(text: string): string | null {
  try {
    const m = JSON.parse(text) as { type?: string; data?: unknown };
    return m.type === "frame" && typeof m.data === "string" ? `data:image/jpeg;base64,${m.data}` : null;
  } catch {
    return null;
  }
}

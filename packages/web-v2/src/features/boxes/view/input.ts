// A holder's input (ISS-1276): pointer, wheel and keys over the view, turned into `BoxInput` lines in
// the box's own coordinates normalised to 0..1 of what the view shows, and sent one per message on
// the input socket (`/ws/boxes/input`), which core validates, records as the person's act and
// forwards. Core closes the socket the moment the hold ends.

import type { BoxInput } from "@forge/contracts/box-wire";

const clamp = (n: number) => Math.min(1, Math.max(0, n));

/** Where on the view a point falls, 0..1 each way. */
export function pointOn(rect: { left: number; top: number; width: number; height: number }, clientX: number, clientY: number) {
  return {
    x: rect.width > 0 ? clamp((clientX - rect.left) / rect.width) : 0,
    y: rect.height > 0 ? clamp((clientY - rect.top) / rect.height) : 0,
  };
}

/** Keys that are a key, not text: the rest of a one-character key is typed as text. */
const NAMED_KEYS = new Set(["Enter", "Backspace", "Tab", "Escape", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);

/** A key pressed while the view holds focus, as the box takes it; null for a key it does not take. */
export function keyInput(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): BoxInput | null {
  if (NAMED_KEYS.has(e.key)) return { t: "key", key: e.key, action: "press" };
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) return { t: "text", text: e.key };
  return null;
}

export interface InputSocket {
  send: (input: BoxInput) => void;
  close: () => void;
}

/** The holder's input socket; `refused` hears core's refusal of a line or the socket's end. */
export function openInput(url: string, refused: (why: string) => void): InputSocket {
  const ws = new WebSocket(url);
  const queued: string[] = [];
  ws.onopen = () => {
    for (const line of queued.splice(0)) ws.send(line);
  };
  ws.onmessage = (e: MessageEvent<string>) => {
    try {
      const m = JSON.parse(e.data) as { type?: string; detail?: string };
      if (m.type === "refused") refused(m.detail ?? "refused");
    } catch {
      // core sends only JSON on this socket
    }
  };
  ws.onclose = (e) => {
    if (e.code !== 1000) refused(e.reason || `socket closed (${e.code})`);
  };
  return {
    send: (input) => {
      const line = JSON.stringify(input);
      if (ws.readyState === WebSocket.OPEN) ws.send(line);
      else if (ws.readyState === WebSocket.CONNECTING) queued.push(line);
    },
    close: () => ws.close(1000),
  };
}

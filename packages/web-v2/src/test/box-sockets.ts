// The sockets and core a box's view is entered through, stood in for (ISS-1325): the view and input
// sockets record what they are sent and are told what core says by the test; core answers the
// project's boxes, one box, its feed and spans, the issues they name and a ticket per channel.

import { BOX_ROUTES, type BoxRecord, type BoxSpanRecord } from "@forge/contracts/boxes";
import { act } from "@testing-library/react";
import { BOX, heldActs, ISSUE_LABELS, PROJECT_ID } from "./boxes";
import { type Call, fakeCore } from "./render";

export const routeOf = (route: string, id: string) => route.replace(":id", id).replace(/^\/api/, "");

export class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static opened: FakeSocket[] = [];
  readyState = 0;
  binaryType = "blob";
  sent: string[] = [];
  onmessage: null | ((e: { data: string }) => void) = null;
  onclose: unknown = null;
  onopen: null | (() => void) = null;
  constructor(readonly url: string) {
    FakeSocket.opened.push(this);
  }
  send(line: string) {
    this.sent.push(line);
  }
  close() {}
}

/** The view socket says hello, so the screen is live and the holder's input layer lies over it. */
export function sayHello(boxId: string, width = 1440, height = 900) {
  const view = FakeSocket.opened.filter((s) => s.url.includes("/ws/boxes/view")).at(-1);
  if (!view) throw new Error("no view socket was opened");
  const hello = { type: "hello", boxId, codec: "jpeg-frames", width, height, fps: 10, holder: "agent:run-qa", watchOnly: true };
  act(() => view.onmessage?.({ data: JSON.stringify(hello) }));
}

/** The input socket, once open: what the holder's input sent on it. */
export function inputSent(): unknown[] {
  const input = FakeSocket.opened.find((s) => s.url.includes("/ws/boxes/input"));
  if (!input) return [];
  act(() => {
    input.readyState = 1;
    input.onopen?.();
  });
  return input.sent.map((l) => JSON.parse(l) as unknown);
}

type Reply = { status?: number; body: unknown } | { status?: number; file: string; headers: Record<string, string> } | undefined;

/** Core for a box's tests: `boxes` the project lists and reads one by one, `spans` each box's, and `extra` first. */
export function boxCore(boxes: BoxRecord[], extra: (c: Call) => Reply = () => undefined, spans: (boxId: string) => BoxSpanRecord[] = () => []) {
  return fakeCore((c) => {
    const hit = extra(c);
    if (hit) return hit;
    if (c.method === "GET" && c.path === routeOf(BOX_ROUTES.ofProject, PROJECT_ID)) return { body: { boxes } };
    const one = boxes.find((b) => c.path === routeOf(BOX_ROUTES.get, b.id));
    if (c.method === "GET" && one) return { body: { box: one } };
    const issue = /^\/issues\/([^/?]+)$/.exec(c.path)?.[1];
    if (issue && ISSUE_LABELS[issue]) return { body: ISSUE_LABELS[issue] };
    if (c.path === routeOf(BOX_ROUTES.acts, BOX.held)) return { body: { acts: heldActs() } };
    if (c.path.endsWith("/acts")) return { body: { acts: [] } };
    const spanned = /^\/boxes\/([^/]+)\/spans$/.exec(c.path)?.[1];
    if (spanned) return { body: { spans: spans(spanned) } };
    if (c.method === "POST" && c.path.endsWith("/ticket")) {
      const channel = (c.body as { channel: "view" | "input" }).channel;
      return { body: { ticket: channel, expiresAt: new Date(Date.now() + 60_000).toISOString(), url: `/ws/boxes/${channel}?ticket=${channel}` } };
    }
    return undefined;
  });
}

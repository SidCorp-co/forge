// Asking an idea preview's page for its one snapshot (REQ-41 BC-16). The page, served by core with
// rrweb's recorder script, answers a `postMessage` from this window and no other: this side checks the
// frame, its origin and the ask's id before it believes an answer, and gives up by name when the page
// is silent (a page that does not carry the script, or one still loading).

import { type PageSnapshot, pageSnapshotSchema, SNAPSHOT_ANSWER, SNAPSHOT_ASK } from "@forge/contracts/preview";

export const SNAPSHOT_WAIT_MS = 6_000;

/** Why no snapshot came: the page said it could not take one, or said nothing. */
export class SnapshotUnavailable extends Error {
  constructor(readonly why: "silent" | "refused" | "malformed", detail: string) {
    super(detail);
    this.name = "SnapshotUnavailable";
  }
}

export function askPageSnapshot(
  frame: Pick<HTMLIFrameElement, "contentWindow">,
  pageOrigin: string,
  listen: Pick<Window, "addEventListener" | "removeEventListener"> = window,
  waitMs = SNAPSHOT_WAIT_MS,
): Promise<PageSnapshot> {
  const target = frame.contentWindow;
  if (!target) return Promise.reject(new SnapshotUnavailable("silent", "the preview frame holds no page yet"));
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      listen.removeEventListener("message", onMessage as EventListener);
    };
    const onMessage = (ev: MessageEvent) => {
      const data = ev.data as { type?: unknown; id?: unknown; events?: unknown } | null;
      if (ev.source !== target || ev.origin !== pageOrigin || data?.type !== SNAPSHOT_ANSWER || data.id !== id) return;
      done();
      if (data.events === null) return reject(new SnapshotUnavailable("refused", "the page could not take a snapshot of itself"));
      const parsed = pageSnapshotSchema.safeParse(data.events);
      if (!parsed.success) return reject(new SnapshotUnavailable("malformed", parsed.error.issues.map((i) => i.message).join("; ")));
      resolve(parsed.data);
    };
    const timer = setTimeout(() => {
      listen.removeEventListener("message", onMessage as EventListener);
      reject(new SnapshotUnavailable("silent", "the preview page did not answer: reload it and try again"));
    }, waitMs);
    listen.addEventListener("message", onMessage as EventListener);
    target.postMessage({ type: SNAPSHOT_ASK, id }, pageOrigin);
  });
}

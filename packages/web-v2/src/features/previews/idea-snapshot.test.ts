// REQ-41 BC-16: the page's snapshot is asked of the frame and believed only from that frame, at the
// preview's origin, answering this ask. A silent or wrong answer is refused by name, never drawn from.

import { SNAPSHOT_ANSWER, SNAPSHOT_ASK } from "@forge/contracts/preview";
import { describe, expect, it, vi } from "vitest";
import { askPageSnapshot, SnapshotUnavailable } from "./idea-snapshot";

const ORIGIN = "https://p-abc.preview.example.test";
const PAIR = [
  { type: 4, timestamp: 1, data: { href: `${ORIGIN}/`, width: 800, height: 600 } },
  { type: 2, timestamp: 2, data: { node: { type: 0, childNodes: [] } } },
];

/** A frame whose page answers by posting to the listening window, as the page's script does. */
function world(answer: (ask: { type: string; id: string }, post: (ev: Partial<MessageEvent>) => void) => void) {
  const handlers = new Set<EventListener>();
  const listen = {
    addEventListener: (_t: string, h: EventListener) => handlers.add(h),
    removeEventListener: (_t: string, h: EventListener) => handlers.delete(h),
  };
  const page = {
    postMessage: vi.fn((ask: { type: string; id: string }, origin: string) => {
      expect(origin).toBe(ORIGIN);
      answer(ask, (ev) => {
        for (const h of [...handlers]) h({ source: page, origin: ORIGIN, ...ev } as unknown as Event);
      });
    }),
  };
  return { frame: { contentWindow: page as unknown as Window }, listen: listen as unknown as Window, page, handlers };
}

describe("asking the preview page for its snapshot", () => {
  it("asks the frame's window at the preview's origin and resolves with the pair the page answers", async () => {
    const w = world((ask, post) => post({ data: { type: SNAPSHOT_ANSWER, id: ask.id, events: PAIR } }));
    await expect(askPageSnapshot(w.frame, ORIGIN, w.listen, 500)).resolves.toEqual(PAIR);
    expect(w.page.postMessage.mock.calls[0]?.[0]).toMatchObject({ type: SNAPSHOT_ASK });
    expect(w.handlers.size).toBe(0);
  });

  it("does not believe another window, another origin or another ask's answer", async () => {
    const w = world((ask, post) => {
      post({ source: {} as Window, data: { type: SNAPSHOT_ANSWER, id: ask.id, events: PAIR } });
      post({ origin: "https://evil.example.test", data: { type: SNAPSHOT_ANSWER, id: ask.id, events: PAIR } });
      post({ data: { type: SNAPSHOT_ANSWER, id: "another-ask", events: PAIR } });
    });
    await expect(askPageSnapshot(w.frame, ORIGIN, w.listen, 60)).rejects.toMatchObject({ name: "SnapshotUnavailable", why: "silent" });
    expect(w.handlers.size).toBe(0);
  });

  it("says by name that a page that cannot snapshot itself, or sends another shape, gave none", async () => {
    const refused = world((ask, post) => post({ data: { type: SNAPSHOT_ANSWER, id: ask.id, events: null } }));
    await expect(askPageSnapshot(refused.frame, ORIGIN, refused.listen, 500)).rejects.toMatchObject({ why: "refused" });
    const wrong = world((ask, post) => post({ data: { type: SNAPSHOT_ANSWER, id: ask.id, events: [...PAIR].reverse() } }));
    const err = await askPageSnapshot(wrong.frame, ORIGIN, wrong.listen, 500).catch((e) => e);
    expect(err).toBeInstanceOf(SnapshotUnavailable);
    expect(err.why).toBe("malformed");
  });

  it("refuses a frame that holds no page", async () => {
    await expect(askPageSnapshot({ contentWindow: null }, ORIGIN)).rejects.toMatchObject({ why: "silent" });
  });
});

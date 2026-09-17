// @vitest-environment jsdom
//
// ISS-1078, consult F6 — following a turn that grows without the thread growing.
//
// Every earlier caller of this hook added ITEMS: a new turn, a new message, a
// new row. A streaming conversation turn does not. It is one entry that gets
// longer, so `itemCount` stays put and `live` is a boolean that was already
// true — and a reader pinned to the bottom followed the first frame and then
// watched the text run off the end of the viewport.
//
// The near-bottom guard is the other half and is asserted here too: somebody
// reading history is never dragged down, which is the property that made this
// hook conditional in the first place (ISS-728 AC3).

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useStickToBottom } from "./use-stick-to-bottom";

afterEach(cleanup);

const scrolls: Array<ScrollIntoViewOptions | undefined> = [];

beforeEach(() => {
  scrolls.length = 0;
  Element.prototype.scrollIntoView = vi.fn(function (this: Element, opts?: unknown) {
    scrolls.push(opts as ScrollIntoViewOptions | undefined);
  });
});

function Harness(props: {
  itemCount: number;
  live: boolean;
  streaming?: boolean;
  streamedChars: number;
}) {
  const { scrollRef, bottomRef, onScroll } = useStickToBottom({
    conversationKey: "c1",
    ready: true,
    ...props,
  });
  return (
    <div ref={scrollRef} onScroll={onScroll} data-testid="scroller">
      <div ref={bottomRef} />
    </div>
  );
}

/** Put the container where a reader scrolled back into history would leave it. */
function scrollIntoHistory(el: HTMLElement, onScroll: () => void) {
  Object.defineProperty(el, "scrollHeight", { value: 2000, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: 500, configurable: true });
  el.scrollTop = 0;
  onScroll();
}

describe("a thread following a turn that is still being written", () => {
  it("follows the text as it grows, with no new item to show for it", () => {
    const { rerender } = render(<Harness itemCount={3} live streaming streamedChars={10} />);
    const before = scrolls.length;

    act(() => {
      rerender(<Harness itemCount={3} live streaming streamedChars={48} />);
    });

    expect(scrolls.length).toBeGreaterThan(before);
    expect(scrolls.at(-1)).toEqual({ block: "end" });
  });

  // cm:guard a stream step asks for NO animation, and this assertion is the whole of what jsdom can
  // hold of the reason. A smooth scroll animates through every position on the way down and each
  // one fires `onScroll`; one reading more than 80px short sets `atBottomRef` false with nobody
  // having touched the page, and a turn that keeps growing moves the animation's target out from
  // under it, so the recovery never comes and the reader is dropped mid-turn. The feedback itself
  // is not reproducible here — `scrollIntoView` is a mock and jsdom animates nothing — so what goes
  // red is the request: this line fails the moment the stream path asks for `behavior: "smooth"`
  // again. The property it stands in for needs a real browser: start pinned, append a card taller
  // than the threshold, then append text every 120ms during the scroll, and assert the viewport is
  // still at the latest content once it settles (ISS-1078 review F6, whole-set consult).
  it("asks for no animation while a turn is arriving, and keeps one outside a turn", () => {
    const { rerender } = render(<Harness itemCount={3} live streaming streamedChars={10} />);

    act(() => {
      rerender(<Harness itemCount={3} live streaming streamedChars={48} />);
    });
    expect(scrolls.at(-1)).toEqual({ block: "end" });

    act(() => {
      rerender(<Harness itemCount={4} live={false} streamedChars={48} />);
    });
    expect(scrolls.at(-1)).toEqual({ behavior: "smooth", block: "end" });
  });

  // cm:guard the ROW a reader queues mid-turn, which is the sequence the first version of this fix
  // still animated: the composer takes a follow-up while the reply streams (`queueWhileBusy`), and
  // that moves `itemCount` with the stream content untouched. Branching on which dependency moved
  // put a smooth animation in the middle of a stream — one is enough, because its own scroll events
  // set the guard false and every frame after it returns at the guard instead of re-affirming it,
  // so following never comes back for the rest of the turn. This is red the moment the branch goes
  // back to reading the changed dependency rather than whether a turn is arriving.
  it("does not animate a row queued while the reply is still streaming", () => {
    const { rerender } = render(<Harness itemCount={3} live streaming streamedChars={48} />);

    act(() => {
      rerender(<Harness itemCount={4} live streaming streamedChars={48} />);
    });

    expect(scrolls.at(-1)).toEqual({ block: "end" });
  });

  // cm:guard the watcher, who has no send of their own in flight: `live` is false for them for the
  // whole turn, so a hook reading `live` as "a turn is arriving" would animate every row and every
  // frame they see. `streaming` is what a second browser in the room has (criterion 6).
  it("does not animate for a second person watching, whose own send is not in flight", () => {
    const { rerender } = render(
      <Harness itemCount={3} live={false} streaming streamedChars={10} />,
    );

    act(() => {
      rerender(<Harness itemCount={3} live={false} streaming streamedChars={48} />);
    });

    expect(scrolls.at(-1)).toEqual({ block: "end" });
  });

  // cm:guard the growth dependency must not defeat the near-bottom guard: a reader who scrolled up
  // to read what was said earlier is the one person a streaming turn must not move, and this hook's
  // whole reason for being conditional is that turning it unconditional makes history unreadable.
  it("does not drag a reader who scrolled back into history", () => {
    const view = render(<Harness itemCount={3} live streaming streamedChars={10} />);
    const el = view.getByTestId("scroller");
    scrollIntoHistory(el, () => el.dispatchEvent(new Event("scroll", { bubbles: true })));
    const before = scrolls.length;

    act(() => {
      view.rerender(<Harness itemCount={3} live streaming streamedChars={48} />);
    });

    expect(scrolls.length).toBe(before);
  });

  it("still follows a new item, which is what it always did", () => {
    const { rerender } = render(<Harness itemCount={3} live={false} streamedChars={0} />);
    const before = scrolls.length;

    act(() => {
      rerender(<Harness itemCount={4} live={false} streamedChars={0} />);
    });

    expect(scrolls.length).toBeGreaterThan(before);
  });
});
